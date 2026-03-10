import { SshService } from './ssh/SshService';
import type { ExecResult } from '../../shared/ssh/types';
import { quoteShellArg } from '../utils/shellEscape';
import type { GitChange } from './GitService';
import { parseDiffLines, stripTrailingNewline, MAX_DIFF_CONTENT_BYTES } from '../utils/diffParser';
import type { DiffLine, DiffResult } from '../utils/diffParser';
import { log } from '../lib/logger';
import { getDrizzleClient } from '../db/drizzleClient';
import { sshConnections as sshConnectionsTable } from '../db/schema';
import { eq } from 'drizzle-orm';

// ---------------------------------------------------------------------------
// Per-connection concurrency limiter — caps concurrent SSH channels to avoid
// MaxSessions exhaustion while still allowing parallel execution.
// ---------------------------------------------------------------------------
const MAX_CONCURRENT_PER_CONNECTION = 8;

type QueueEntry = { run: () => void };

class ConnectionLimiter {
  private running = 0;
  private queue: QueueEntry[] = [];

  limit<T>(fn: () => Promise<T>): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const run = () => {
        this.running++;
        fn()
          .then(resolve, reject)
          .finally(() => {
            this.running--;
            this.next();
          });
      };
      if (this.running < MAX_CONCURRENT_PER_CONNECTION) {
        run();
      } else {
        this.queue.push({ run });
      }
    });
  }

  private next(): void {
    const entry = this.queue.shift();
    if (entry) entry.run();
  }
}

const limiters = new Map<string, ConnectionLimiter>();

function getLimiter(connectionId: string): ConnectionLimiter {
  let limiter = limiters.get(connectionId);
  if (!limiter) {
    limiter = new ConnectionLimiter();
    limiters.set(connectionId, limiter);
  }
  return limiter;
}

export interface WorktreeInfo {
  path: string;
  branch: string;
  isMain: boolean;
}

export interface GitStatusFile {
  status: string;
  path: string;
}

export interface GitStatus {
  branch: string;
  isClean: boolean;
  files: GitStatusFile[];
}

function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`SSH operation timed out after ${ms}ms: ${label}`));
    }, ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (err: unknown) => {
        clearTimeout(timer);
        reject(err);
      }
    );
  });
}

export class RemoteGitService {
  /** Coalesces in-flight getStatusDetailed calls for the same connection+path. */
  private _statusDetailedInFlight: Map<string, Promise<GitChange[]>> = new Map();

  constructor(private sshService: SshService) {}

  /**
   * Try to reconnect an SSH connection by loading its config from the DB.
   * Returns true if reconnected successfully.
   */
  private async tryReconnect(connectionId: string): Promise<boolean> {
    try {
      const { db } = await getDrizzleClient();
      const rows = await db
        .select()
        .from(sshConnectionsTable)
        .where(eq(sshConnectionsTable.id, connectionId))
        .limit(1);
      const row = rows[0];
      if (!row) return false;

      log.info(`[RemoteGitService] attempting auto-reconnect for ${connectionId}`);
      await this.sshService.connect({
        id: row.id,
        name: row.name,
        host: row.host,
        port: row.port,
        username: row.username,
        authType: row.authType as 'password' | 'key' | 'agent',
        privateKeyPath: row.privateKeyPath ?? undefined,
        useAgent: row.useAgent === 1,
      });
      log.info(`[RemoteGitService] auto-reconnect succeeded for ${connectionId}`);
      return true;
    } catch (err) {
      log.warn(
        `[RemoteGitService] auto-reconnect failed for ${connectionId}: ${err instanceof Error ? err.message : err}`
      );
      return false;
    }
  }

  /**
   * Execute a command through sshService with per-connection concurrency limiting.
   * At most MAX_CONCURRENT_PER_CONNECTION channels are open simultaneously per connection,
   * preventing MaxSessions exhaustion while still allowing parallel execution.
   * Auto-reconnects once if the connection is not found.
   */
  private async exec(connectionId: string, command: string, cwd?: string): Promise<ExecResult> {
    const cmdPreview = command.slice(0, 100).replace(/\n/g, '\\n');
    log.info(`[RemoteGitService] exec: "${cmdPreview}..."`);
    const start = Date.now();
    const limiter = getLimiter(connectionId);

    try {
      const result = await limiter.limit(() =>
        this.sshService.executeCommand(connectionId, command, cwd)
      );
      log.info(
        `[RemoteGitService] exec completed in ${Date.now() - start}ms: "${cmdPreview}..." exitCode=${result.exitCode}`
      );
      return result;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);

      // Auto-reconnect once if connection is not found
      if (msg.includes('not found')) {
        const reconnected = await this.tryReconnect(connectionId);
        if (reconnected) {
          try {
            const result = await limiter.limit(() =>
              this.sshService.executeCommand(connectionId, command, cwd)
            );
            log.info(
              `[RemoteGitService] exec completed (after reconnect) in ${Date.now() - start}ms: "${cmdPreview}..." exitCode=${result.exitCode}`
            );
            return result;
          } catch (retryErr) {
            log.warn(
              `[RemoteGitService] exec FAILED (after reconnect) in ${Date.now() - start}ms: "${cmdPreview}..." error=${retryErr instanceof Error ? retryErr.message : retryErr}`
            );
            throw retryErr;
          }
        }
      }

      log.warn(
        `[RemoteGitService] exec FAILED in ${Date.now() - start}ms: "${cmdPreview}..." error=${msg}`
      );
      throw err;
    }
  }

  private normalizeRemotePath(p: string): string {
    // Remote paths should use forward slashes.
    return p.replace(/\\/g, '/').replace(/\/+$/g, '');
  }

  async getStatus(connectionId: string, worktreePath: string): Promise<GitStatus> {
    const result = await this.exec(
      connectionId,
      'GIT_OPTIONAL_LOCKS=0 git status --porcelain -b --no-renames',
      worktreePath
    );

    if (result.exitCode !== 0) {
      throw new Error(`Git status failed: ${result.stderr}`);
    }

    const lines = result.stdout.split('\n');
    const branchLine = lines[0];
    const files = lines.slice(1).filter((l) => l.trim());

    const branchMatch = branchLine.match(/^## (.+?)(?:\...|$)/);
    const branch = branchMatch ? branchMatch[1] : 'unknown';

    return {
      branch,
      isClean: files.length === 0,
      files: files.map((line) => ({
        status: line.substring(0, 2).trim(),
        path: line.substring(3),
      })),
    };
  }

  async getDefaultBranch(connectionId: string, projectPath: string): Promise<string> {
    const cwd = this.normalizeRemotePath(projectPath);

    // Single script: try origin's symbolic HEAD, then common remote-tracking refs, then local
    const script = [
      'db=$(git symbolic-ref --short refs/remotes/origin/HEAD 2>/dev/null)',
      'if [ -n "$db" ]; then echo "$db"; exit 0; fi',
      'for name in origin/main origin/master main master; do',
      '  if git rev-parse --verify "$name" >/dev/null 2>&1; then echo "$name"; exit 0; fi',
      'done',
      'echo HEAD',
    ].join('\n');

    const result = await this.exec(connectionId, script, cwd);
    return (result.stdout || 'HEAD').trim();
  }

  async createWorktree(
    connectionId: string,
    projectPath: string,
    taskName: string,
    baseRef?: string,
    onProgress?: (step: string) => void
  ): Promise<WorktreeInfo> {
    return withTimeout(
      this._createWorktreeImpl(connectionId, projectPath, taskName, baseRef, onProgress),
      120_000,
      'createWorktree'
    );
  }

  private async _createWorktreeImpl(
    connectionId: string,
    projectPath: string,
    taskName: string,
    baseRef?: string,
    onProgress?: (step: string) => void
  ): Promise<WorktreeInfo> {
    const implStart = Date.now();
    log.info(`[RemoteGitService] _createWorktreeImpl start: task=${taskName}, baseRef=${baseRef}`);
    const normalizedProjectPath = this.normalizeRemotePath(projectPath);
    const slug = taskName
      .toLowerCase()
      .replace(/[^a-z0-9-]/g, '-')
      .replace(/-+/g, '-')
      .replace(/^-|-$/g, '');
    const worktreeName = `${slug || 'task'}-${Date.now()}`;
    const relWorktreePath = `.emdash/worktrees/${worktreeName}`;
    const worktreePath = `${normalizedProjectPath}/${relWorktreePath}`.replace(/\/+/g, '/');

    // Determine base ref with one round trip (or zero if provided and valid)
    let base = (baseRef || '').trim();
    log.info(`[RemoteGitService] _createWorktreeImpl: verifying base ref "${base}"`);
    onProgress?.('Resolving branch…');
    if (base) {
      const verifyResult = await this.exec(
        connectionId,
        `git rev-parse --verify ${quoteShellArg(base)} 2>/dev/null`,
        normalizedProjectPath
      );
      if (verifyResult.exitCode !== 0) {
        base = '';
      }
    }
    if (!base) {
      log.info('[RemoteGitService] _createWorktreeImpl: fetching default branch');
      base = await this.getDefaultBranch(connectionId, normalizedProjectPath);
    }
    if (!base) {
      base = 'HEAD';
    }
    log.info(
      `[RemoteGitService] _createWorktreeImpl: using base="${base}" (elapsed ${Date.now() - implStart}ms)`
    );

    // Detect git root and relative project subdir for graft support
    onProgress?.('Detecting repository structure…');
    const gitRootResult = await this.exec(
      connectionId,
      'git rev-parse --show-toplevel',
      normalizedProjectPath
    );
    const gitRoot =
      gitRootResult.exitCode === 0 ? gitRootResult.stdout.trim() : normalizedProjectPath;
    // Compute relative subdir (e.g., "customers/customers-backend") for graft
    const projectSubdir = normalizedProjectPath.startsWith(gitRoot)
      ? normalizedProjectPath.slice(gitRoot.length).replace(/^\//, '')
      : '';

    log.info(
      `[RemoteGitService] _createWorktreeImpl: gitRoot=${gitRoot}, projectSubdir=${projectSubdir}`
    );

    // Single batched script: try graft first, fall back to plain git worktree.
    // The script echoes "WORKTREE_PATH=<path>" on the last line so we can parse
    // the actual worktree location (graft creates worktrees in its own directory).
    const script = [
      // Clean up stale branch from prior failed attempt (if any)
      `if git rev-parse --verify refs/heads/${quoteShellArg(worktreeName)} >/dev/null 2>&1; then`,
      `  rm -rf ${quoteShellArg(relWorktreePath)} 2>/dev/null`,
      '  git worktree prune 2>/dev/null',
      `  git branch -D ${quoteShellArg(worktreeName)} 2>/dev/null`,
      'fi',
      // Detect graft — check common install paths since non-interactive SSH may not have full PATH.
      'GRAFT_BIN=$(command -v graft 2>/dev/null || true)',
      'if [ -z "$GRAFT_BIN" ]; then for p in "$HOME/.config/gohan/bin/graft" "$HOME/.local/bin/graft" "$HOME/bin/graft" "$HOME/go/bin/graft" "/usr/local/bin/graft"; do [ -x "$p" ] && GRAFT_BIN="$p" && break; done; fi',
      // Use graft for monorepos (handles sparse checkout automatically), fall back to plain git worktree.
      `if [ -n "$GRAFT_BIN" ] && [ -n ${quoteShellArg(projectSubdir)} ]; then`,
      '  echo "EMDASH_USING_GRAFT=true"',
      `  cd ${quoteShellArg(gitRoot)}`,
      // Graft prefixes branch names (e.g. with $GITHUB_USERNAME/) and places
      // worktrees at ~/grafts/<repo>/<name>, so we parse its --verbose output for the path.
      `  GRAFT_OUTPUT=$("$GRAFT_BIN" new ${quoteShellArg(worktreeName)} ${quoteShellArg(projectSubdir)} --sparse --from ${quoteShellArg(base)} --no-setup --verbose --quiet 2>&1)`,
      // Parse worktree root from graft verbose output: "Worktree path: /home/bento/grafts/carrot/<name>"
      '  GRAFT_WTROOT=$(echo "$GRAFT_OUTPUT" | grep -o "Worktree path: .*" | sed "s/Worktree path: //" | head -1)',
      // Fallback: search git worktree list for any entry containing our branch name
      `  if [ -z "$GRAFT_WTROOT" ]; then`,
      `    GRAFT_WTROOT=$(git worktree list | grep '${worktreeName}' | awk '{print $1}')`,
      '  fi',
      `  if [ -n "$GRAFT_WTROOT" ]; then`,
      `    WPATH="$GRAFT_WTROOT"/${quoteShellArg(projectSubdir)}`,
      '  else',
      `    WPATH=${quoteShellArg(worktreePath)}`,
      '  fi',
      'else',
      '  mkdir -p .emdash/worktrees',
      `  git worktree add ${quoteShellArg(relWorktreePath)} -b ${quoteShellArg(worktreeName)} ${quoteShellArg(base)}`,
      `  WPATH=${quoteShellArg(worktreePath)}`,
      'fi',
      // Enable git optimizations for faster status queries
      'cd "$WPATH" && git config core.fsmonitor true && git config core.untrackedCache true 2>/dev/null || true',
      'echo "WORKTREE_PATH=$WPATH"',
    ].join('\n');

    log.info(
      `[RemoteGitService] _createWorktreeImpl: running batched create script (elapsed ${Date.now() - implStart}ms)`
    );
    onProgress?.(projectSubdir ? 'Creating worktree with sparse checkout…' : 'Creating worktree…');

    const result = await this.exec(connectionId, script, normalizedProjectPath);

    const scriptOutput = (result.stdout || '').trim();
    const usingGraft = scriptOutput.includes('EMDASH_USING_GRAFT=true');
    log.info(
      `[RemoteGitService] _createWorktreeImpl: usingGraft=${usingGraft} (elapsed ${Date.now() - implStart}ms)`
    );

    if (result.exitCode !== 0) {
      log.error(
        `[RemoteGitService] _createWorktreeImpl: FAILED after ${Date.now() - implStart}ms: ${scriptOutput}`
      );
      throw new Error(`Failed to create worktree: ${scriptOutput}`);
    }

    // Parse the actual worktree path from script output
    const pathMatch = scriptOutput.match(/WORKTREE_PATH=(.+)/);
    const actualWorktreePath = pathMatch ? pathMatch[1].trim() : worktreePath;
    onProgress?.('Finalizing…');

    log.info(
      `[RemoteGitService] _createWorktreeImpl: SUCCESS in ${Date.now() - implStart}ms, path=${actualWorktreePath}`
    );
    return {
      path: actualWorktreePath,
      branch: worktreeName,
      isMain: false,
    };
  }

  async removeWorktree(
    connectionId: string,
    projectPath: string,
    worktreePath: string,
    branch?: string
  ): Promise<void> {
    const normalizedProjectPath = this.normalizeRemotePath(projectPath);
    const normalizedWorktreePath = this.normalizeRemotePath(worktreePath);

    // Single batched script: remove worktree + prune + delete branch
    const parts = [
      `git worktree remove ${quoteShellArg(normalizedWorktreePath)} --force`,
      'git worktree prune',
    ];
    if (branch) {
      parts.push(`git branch -D ${quoteShellArg(branch)} 2>/dev/null || true`);
    }

    const result = await this.exec(connectionId, parts.join(' && '), normalizedProjectPath);

    if (result.exitCode !== 0) {
      throw new Error(`Failed to remove worktree: ${result.stdout}`);
    }
  }

  async listWorktrees(connectionId: string, projectPath: string): Promise<WorktreeInfo[]> {
    const normalizedProjectPath = this.normalizeRemotePath(projectPath);
    const result = await this.exec(
      connectionId,
      'git worktree list --porcelain',
      normalizedProjectPath
    );

    if (result.exitCode !== 0) {
      throw new Error(`Failed to list worktrees: ${result.stderr}`);
    }

    // Porcelain output is blocks separated by blank lines.
    // Each block begins with: worktree <path>
    // Optional: branch <ref>
    // Optional: detached
    const blocks = result.stdout
      .split(/\n\s*\n/g)
      .map((b) => b.trim())
      .filter(Boolean);

    const out: WorktreeInfo[] = [];
    for (const block of blocks) {
      const lines = block.split('\n').map((l) => l.trim());
      const wtLine = lines.find((l) => l.startsWith('worktree '));
      if (!wtLine) continue;
      const wtPath = wtLine.slice('worktree '.length).trim();
      const branchLine = lines.find((l) => l.startsWith('branch '));
      const branchRef = branchLine ? branchLine.slice('branch '.length).trim() : '';
      const branch = branchRef.replace(/^refs\/heads\//, '') || 'HEAD';
      const isMain = this.normalizeRemotePath(wtPath) === normalizedProjectPath;
      out.push({ path: wtPath, branch, isMain });
    }
    return out;
  }

  async getWorktreeStatus(
    connectionId: string,
    worktreePath: string
  ): Promise<{
    hasChanges: boolean;
    stagedFiles: string[];
    unstagedFiles: string[];
    untrackedFiles: string[];
  }> {
    const normalizedWorktreePath = this.normalizeRemotePath(worktreePath);
    const result = await this.exec(
      connectionId,
      'GIT_OPTIONAL_LOCKS=0 git status --porcelain --untracked-files=normal --no-renames',
      normalizedWorktreePath
    );

    if (result.exitCode !== 0) {
      throw new Error(`Git status failed: ${result.stderr}`);
    }

    const stagedFiles: string[] = [];
    const unstagedFiles: string[] = [];
    const untrackedFiles: string[] = [];
    const lines = (result.stdout || '')
      .trim()
      .split('\n')
      .filter((l) => l.length > 0);

    for (const line of lines) {
      const status = line.substring(0, 2);
      const file = line.substring(3);
      if (status.includes('A') || status.includes('M') || status.includes('D')) {
        stagedFiles.push(file);
      }
      if (status[1] === 'M' || status[1] === 'D') {
        unstagedFiles.push(file);
      }
      if (status.includes('??')) {
        untrackedFiles.push(file);
      }
    }

    return {
      hasChanges: stagedFiles.length > 0 || unstagedFiles.length > 0 || untrackedFiles.length > 0,
      stagedFiles,
      unstagedFiles,
      untrackedFiles,
    };
  }

  async getBranchList(connectionId: string, projectPath: string): Promise<string[]> {
    const result = await this.exec(
      connectionId,
      'git branch -a --format="%(refname:short)"',
      this.normalizeRemotePath(projectPath)
    );

    if (result.exitCode !== 0) {
      return [];
    }

    return result.stdout.split('\n').filter((b) => b.trim());
  }

  async commit(
    connectionId: string,
    worktreePath: string,
    message: string,
    files?: string[]
  ): Promise<ExecResult> {
    let command = 'git commit';

    if (files && files.length > 0) {
      const fileList = files.map((f) => quoteShellArg(f)).join(' ');
      command = `git add ${fileList} && ${command}`;
    }

    command += ` -m ${quoteShellArg(message)}`;

    return this.exec(connectionId, command, this.normalizeRemotePath(worktreePath));
  }

  // ---------------------------------------------------------------------------
  // Git operations for IPC parity with local GitService
  // ---------------------------------------------------------------------------

  /**
   * Detailed git status matching the shape returned by local GitService.getStatus().
   * Parses porcelain output, numstat diffs, and untracked file line counts.
   */
  async getStatusDetailed(connectionId: string, worktreePath: string): Promise<GitChange[]> {
    const key = `${connectionId}:${worktreePath}`;
    const inflight = this._statusDetailedInFlight.get(key);
    if (inflight) {
      log.info(`[RemoteGitService] getStatusDetailed: coalesced (in-flight already for ${key})`);
      return inflight;
    }
    log.info(`[RemoteGitService] getStatusDetailed: starting for ${key}`);

    const promise = withTimeout(
      this._getStatusDetailedImpl(connectionId, worktreePath),
      20_000,
      'getStatusDetailed'
    ).finally(() => {
      this._statusDetailedInFlight.delete(key);
    });

    this._statusDetailedInFlight.set(key, promise);
    return promise;
  }

  private async _getStatusDetailedImpl(
    connectionId: string,
    worktreePath: string
  ): Promise<GitChange[]> {
    const cwd = this.normalizeRemotePath(worktreePath);

    // Single script: verify repo + porcelain status + both numstats
    // Sections separated by a unique delimiter so we can split the output
    const SEP = '<<__EMDASH_SEP__>>';
    const script = [
      'export GIT_OPTIONAL_LOCKS=0',
      'git rev-parse --is-inside-work-tree >/dev/null 2>&1 || { echo "__NOT_GIT__"; exit 0; }',
      'git status --porcelain --untracked-files=normal --no-renames',
      `echo '${SEP}'`,
      'git diff --numstat --cached --no-renames',
      `echo '${SEP}'`,
      'git diff --numstat --no-renames',
    ].join('; ');

    const batchResult = await this.exec(connectionId, script, cwd);
    const batchOutput = batchResult.stdout || '';

    if (batchOutput.startsWith('__NOT_GIT__')) {
      return [];
    }

    const sections = batchOutput.split(SEP);
    const statusOutput = (sections[0] || '').replace(/^\n+/, '').replace(/\n+$/, '');
    if (!statusOutput) return [];

    const statusLines = statusOutput
      .split('\n')
      .map((l) => l.replace(/\r$/, ''))
      .filter((l) => l.length > 0);

    const stagedNumstatOutput = sections[1] || '';
    const unstagedNumstatOutput = sections[2] || '';

    const parseNumstat = (stdout: string): Map<string, { add: number; del: number }> => {
      const map = new Map<string, { add: number; del: number }>();
      for (const line of stdout.split('\n').filter((l) => l.trim())) {
        const parts = line.split('\t');
        if (parts.length >= 3) {
          const add = parts[0] === '-' ? 0 : parseInt(parts[0], 10) || 0;
          const del = parts[1] === '-' ? 0 : parseInt(parts[1], 10) || 0;
          map.set(parts[2], { add, del });
        }
      }
      return map;
    };

    const stagedStats = parseNumstat(stagedNumstatOutput);
    const unstagedStats = parseNumstat(unstagedNumstatOutput);

    // Collect untracked file paths so we can batch their line counts
    const untrackedPaths: string[] = [];

    const changes: GitChange[] = [];
    for (const line of statusLines) {
      const statusCode = line.substring(0, 2);
      let filePath = line.substring(3);
      if (statusCode.includes('R') && filePath.includes('->')) {
        const parts = filePath.split('->');
        filePath = parts[parts.length - 1].trim();
      }

      let status = 'modified';
      if (statusCode.includes('A') || statusCode.includes('?')) status = 'added';
      else if (statusCode.includes('D')) status = 'deleted';
      else if (statusCode.includes('R')) status = 'renamed';
      else if (statusCode.includes('M')) status = 'modified';

      const isStaged = statusCode[0] !== ' ' && statusCode[0] !== '?';

      const staged = stagedStats.get(filePath);
      const unstaged = unstagedStats.get(filePath);
      const additions = (staged?.add ?? 0) + (unstaged?.add ?? 0);
      const deletions = (staged?.del ?? 0) + (unstaged?.del ?? 0);

      if (additions === 0 && deletions === 0 && statusCode.includes('?')) {
        untrackedPaths.push(filePath);
      }

      changes.push({ path: filePath, status, additions, deletions, isStaged });
    }

    // Batch line-count for untracked files (skip files > 512KB)
    if (untrackedPaths.length > 0) {
      const escaped = untrackedPaths.map((f) => quoteShellArg(f)).join(' ');
      // For each file: if <= 512KB, count newlines; otherwise print -1
      const script =
        `for f in ${escaped}; do ` +
        `s=$(stat -c%s "$f" 2>/dev/null || stat -f%z "$f" 2>/dev/null); ` +
        `if [ "$s" -le ${MAX_DIFF_CONTENT_BYTES} ] 2>/dev/null; then ` +
        `wc -l < "$f" 2>/dev/null || echo -1; ` +
        `else echo -1; fi; done`;
      const countResult = await this.exec(connectionId, script, cwd);
      if (countResult.exitCode === 0) {
        const counts = countResult.stdout
          .split('\n')
          .map((l) => l.trim())
          .filter((l) => l.length > 0);
        for (let i = 0; i < untrackedPaths.length && i < counts.length; i++) {
          const count = parseInt(counts[i], 10);
          if (count >= 0) {
            const change = changes.find((c) => c.path === untrackedPaths[i]);
            if (change) change.additions = count;
          }
        }
      }
    }

    return changes;
  }

  /**
   * Per-file diff matching the shape returned by local GitService.getFileDiff().
   * Uses a diff-first pattern: run git diff, check for binary, then fetch content only if non-binary.
   */
  async getFileDiff(
    connectionId: string,
    worktreePath: string,
    filePath: string
  ): Promise<DiffResult> {
    return withTimeout(
      this._getFileDiffImpl(connectionId, worktreePath, filePath),
      20_000,
      'getFileDiff'
    );
  }

  private async _getFileDiffImpl(
    connectionId: string,
    worktreePath: string,
    filePath: string
  ): Promise<DiffResult> {
    const cwd = this.normalizeRemotePath(worktreePath);

    // Step 1: Run git diff
    const diffResult = await this.exec(
      connectionId,
      `git diff --no-color --unified=2000 HEAD -- ${quoteShellArg(filePath)}`,
      cwd
    );

    // Step 2: Parse and check binary
    let diffLines: DiffLine[] = [];
    if (diffResult.exitCode === 0 && diffResult.stdout.trim()) {
      const { lines, isBinary } = parseDiffLines(diffResult.stdout);
      if (isBinary) {
        return { lines: [], isBinary: true };
      }
      diffLines = lines;
    }

    // Step 3: Fetch content ONCE (non-binary only, covers both diff-success and fallback paths)
    const [showResult, catResult] = await Promise.all([
      this.exec(
        connectionId,
        `s=$(git cat-file -s HEAD:${quoteShellArg(filePath)} 2>/dev/null); ` +
          `if [ "$s" -le ${MAX_DIFF_CONTENT_BYTES} ] 2>/dev/null; then git show HEAD:${quoteShellArg(filePath)}; ` +
          `else echo "__EMDASH_TOO_LARGE__"; fi`,
        cwd
      ),
      this.exec(
        connectionId,
        `s=$(stat -c%s ${quoteShellArg(filePath)} 2>/dev/null || stat -f%z ${quoteShellArg(filePath)} 2>/dev/null); ` +
          `if [ "$s" -le ${MAX_DIFF_CONTENT_BYTES} ] 2>/dev/null; then cat ${quoteShellArg(filePath)}; else echo "__EMDASH_TOO_LARGE__"; fi`,
        cwd
      ),
    ]);

    const rawOriginal =
      showResult.exitCode === 0 ? stripTrailingNewline(showResult.stdout) : undefined;
    const originalContent = rawOriginal === '__EMDASH_TOO_LARGE__' ? undefined : rawOriginal;

    const rawModified =
      catResult.exitCode === 0 ? stripTrailingNewline(catResult.stdout) : undefined;
    const modifiedContent = rawModified === '__EMDASH_TOO_LARGE__' ? undefined : rawModified;

    // Step 4: Return based on what we have
    if (diffLines.length > 0) return { lines: diffLines, originalContent, modifiedContent };

    // Fallback: empty diff or diff failed — determine untracked/deleted from content
    if (modifiedContent !== undefined) {
      return {
        lines: modifiedContent.split('\n').map((l) => ({ right: l, type: 'add' as const })),
        modifiedContent,
      };
    }
    if (originalContent !== undefined) {
      return {
        lines: originalContent.split('\n').map((l) => ({ left: l, type: 'del' as const })),
        originalContent,
      };
    }
    return { lines: [] };
  }

  async stageFile(connectionId: string, worktreePath: string, filePath: string): Promise<void> {
    const cwd = this.normalizeRemotePath(worktreePath);
    const result = await this.exec(connectionId, `git add -- ${quoteShellArg(filePath)}`, cwd);
    if (result.exitCode !== 0) {
      throw new Error(`Failed to stage file: ${result.stderr}`);
    }
  }

  async stageAllFiles(connectionId: string, worktreePath: string): Promise<void> {
    const cwd = this.normalizeRemotePath(worktreePath);
    const result = await this.exec(connectionId, 'git add -A', cwd);
    if (result.exitCode !== 0) {
      throw new Error(`Failed to stage all files: ${result.stderr}`);
    }
  }

  async unstageFile(connectionId: string, worktreePath: string, filePath: string): Promise<void> {
    const cwd = this.normalizeRemotePath(worktreePath);
    const result = await this.exec(
      connectionId,
      `git reset HEAD -- ${quoteShellArg(filePath)}`,
      cwd
    );
    if (result.exitCode !== 0) {
      throw new Error(`Failed to unstage file: ${result.stderr}`);
    }
  }

  async revertFile(
    connectionId: string,
    worktreePath: string,
    filePath: string
  ): Promise<{ action: 'reverted' }> {
    const cwd = this.normalizeRemotePath(worktreePath);

    // Check if file exists in HEAD
    const catFileResult = await this.exec(
      connectionId,
      `git cat-file -e HEAD:${quoteShellArg(filePath)}`,
      cwd
    );

    if (catFileResult.exitCode !== 0) {
      // File doesn't exist in HEAD — it's untracked. Delete it.
      await this.exec(connectionId, `rm -f -- ${quoteShellArg(filePath)}`, cwd);
      return { action: 'reverted' };
    }

    // File exists in HEAD — revert it
    const checkoutResult = await this.exec(
      connectionId,
      `git checkout HEAD -- ${quoteShellArg(filePath)}`,
      cwd
    );
    if (checkoutResult.exitCode !== 0) {
      throw new Error(`Failed to revert file: ${checkoutResult.stderr}`);
    }
    return { action: 'reverted' };
  }

  // ---------------------------------------------------------------------------
  // Commit, push, and branch operations
  // ---------------------------------------------------------------------------

  async getCurrentBranch(connectionId: string, worktreePath: string): Promise<string> {
    const cwd = this.normalizeRemotePath(worktreePath);
    const result = await this.exec(connectionId, 'git branch --show-current', cwd);
    return (result.stdout || '').trim();
  }

  /**
   * Detect the default branch name using the remote HEAD or common conventions.
   * Unlike getDefaultBranch(), this specifically queries origin's default (not current branch).
   */
  async getDefaultBranchName(connectionId: string, worktreePath: string): Promise<string> {
    return withTimeout(
      this._getDefaultBranchNameImpl(connectionId, worktreePath),
      30_000,
      'getDefaultBranchName'
    );
  }

  private async _getDefaultBranchNameImpl(
    connectionId: string,
    worktreePath: string
  ): Promise<string> {
    const cwd = this.normalizeRemotePath(worktreePath);

    // Single script: try symbolic-ref (cached, fast), then remote show, fallback main
    const script = [
      'db=$(git symbolic-ref --short refs/remotes/origin/HEAD 2>/dev/null)',
      'if [ -n "$db" ]; then echo "${db##*/}"; exit 0; fi',
      'db=$(git remote show origin 2>/dev/null | sed -n "/HEAD branch/s/.*: //p")',
      'if [ -n "$db" ]; then echo "$db"; exit 0; fi',
      'echo main',
    ].join('; ');

    const result = await this.exec(connectionId, script, cwd);
    return (result.stdout || 'main').trim();
  }

  async createBranch(connectionId: string, worktreePath: string, name: string): Promise<void> {
    const cwd = this.normalizeRemotePath(worktreePath);
    const result = await this.exec(connectionId, `git checkout -b ${quoteShellArg(name)}`, cwd);
    if (result.exitCode !== 0) {
      throw new Error(`Failed to create branch: ${result.stderr}`);
    }
  }

  async push(
    connectionId: string,
    worktreePath: string,
    branch?: string,
    setUpstream?: boolean
  ): Promise<ExecResult> {
    const cwd = this.normalizeRemotePath(worktreePath);
    let cmd = 'git push';
    if (setUpstream && branch) {
      cmd = `git push --set-upstream origin ${quoteShellArg(branch)}`;
    }
    return this.exec(connectionId, cmd, cwd);
  }

  async getBranchStatus(
    connectionId: string,
    worktreePath: string
  ): Promise<{ branch: string; defaultBranch: string; ahead: number; behind: number }> {
    return withTimeout(
      this._getBranchStatusImpl(connectionId, worktreePath),
      30_000,
      'getBranchStatus'
    );
  }

  private async _getBranchStatusImpl(
    connectionId: string,
    worktreePath: string
  ): Promise<{ branch: string; defaultBranch: string; ahead: number; behind: number }> {
    const cwd = this.normalizeRemotePath(worktreePath);

    // Single script: get current branch, detect default branch, compute ahead/behind
    // Output format: branch\ndefaultBranch\nahead behind
    const script = [
      'export GIT_OPTIONAL_LOCKS=0',
      // Line 1: current branch
      'git branch --show-current',
      // Line 2: default branch (try symbolic-ref first (cached, fast), then remote show, fallback main)
      'db=$(git symbolic-ref --short refs/remotes/origin/HEAD 2>/dev/null | sed "s|.*/||")',
      'if [ -z "$db" ]; then db=$(git remote show origin 2>/dev/null | sed -n "/HEAD branch/s/.*: //p"); fi',
      'if [ -z "$db" ]; then db=main; fi',
      'echo "$db"',
      // Line 3: ahead/behind counts
      'git rev-list --left-right --count "origin/$db...HEAD" 2>/dev/null || echo "0 0"',
    ].join('; ');

    const result = await this.exec(connectionId, script, cwd);
    const lines = (result.stdout || '').split('\n').map((l) => l.trim());

    const branch = lines[0] || '';
    const defaultBranch = lines[1] || 'main';

    let ahead = 0;
    let behind = 0;
    const counts = (lines[2] || '').split(/\s+/);
    if (counts.length >= 2) {
      behind = parseInt(counts[0] || '0', 10) || 0;
      ahead = parseInt(counts[1] || '0', 10) || 0;
    }

    return { branch, defaultBranch, ahead, behind };
  }

  async listBranches(
    connectionId: string,
    projectPath: string,
    remote = 'origin'
  ): Promise<Array<{ ref: string; remote: string; branch: string; label: string }>> {
    return withTimeout(
      this._listBranchesImpl(connectionId, projectPath, remote),
      30_000,
      'listBranches'
    );
  }

  private async _listBranchesImpl(
    connectionId: string,
    projectPath: string,
    remote = 'origin'
  ): Promise<Array<{ ref: string; remote: string; branch: string; label: string }>> {
    const cwd = this.normalizeRemotePath(projectPath);

    // Check if remote exists
    let hasRemote = false;
    const remoteCheck = await this.exec(
      connectionId,
      `git remote get-url ${quoteShellArg(remote)} 2>/dev/null`,
      cwd
    );
    if (remoteCheck.exitCode === 0) {
      hasRemote = true;
      // Try to fetch (non-fatal)
      await this.exec(connectionId, `git fetch --prune ${quoteShellArg(remote)} 2>/dev/null`, cwd);
    }

    let branches: Array<{ ref: string; remote: string; branch: string; label: string }> = [];

    if (hasRemote) {
      const { stdout } = await this.exec(
        connectionId,
        `git for-each-ref --format="%(refname:short)" refs/remotes/${quoteShellArg(remote)}`,
        cwd
      );
      branches = (stdout || '')
        .split('\n')
        .map((l) => l.trim())
        .filter((l) => l.length > 0 && !l.endsWith('/HEAD'))
        .map((ref) => {
          const [remoteAlias, ...rest] = ref.split('/');
          const branch = rest.join('/') || ref;
          return {
            ref,
            remote: remoteAlias || remote,
            branch,
            label: `${remoteAlias || remote}/${branch}`,
          };
        });

      // Include local-only branches
      const localResult = await this.exec(
        connectionId,
        'git for-each-ref --format="%(refname:short)" refs/heads/',
        cwd
      );
      const remoteBranchNames = new Set(branches.map((b) => b.branch));
      const localOnly = (localResult.stdout || '')
        .split('\n')
        .map((l) => l.trim())
        .filter((l) => l.length > 0 && !remoteBranchNames.has(l))
        .map((branch) => ({ ref: branch, remote: '', branch, label: branch }));
      branches = [...branches, ...localOnly];
    } else {
      const localResult = await this.exec(
        connectionId,
        'git for-each-ref --format="%(refname:short)" refs/heads/',
        cwd
      );
      branches = (localResult.stdout || '')
        .split('\n')
        .map((l) => l.trim())
        .filter((l) => l.length > 0)
        .map((branch) => ({ ref: branch, remote: '', branch, label: branch }));
    }

    return branches;
  }

  async renameBranch(
    connectionId: string,
    repoPath: string,
    oldBranch: string,
    newBranch: string
  ): Promise<{ remotePushed: boolean }> {
    const cwd = this.normalizeRemotePath(repoPath);

    // Check remote tracking before rename
    let remotePushed = false;
    let remoteName = 'origin';
    const configResult = await this.exec(
      connectionId,
      `git config --get branch.${quoteShellArg(oldBranch)}.remote 2>/dev/null`,
      cwd
    );
    if (configResult.exitCode === 0 && configResult.stdout.trim()) {
      remoteName = configResult.stdout.trim();
      remotePushed = true;
    } else {
      const lsResult = await this.exec(
        connectionId,
        `git ls-remote --heads origin ${quoteShellArg(oldBranch)} 2>/dev/null`,
        cwd
      );
      if (lsResult.exitCode === 0 && lsResult.stdout.trim()) {
        remotePushed = true;
      }
    }

    // Rename local branch
    const renameResult = await this.exec(
      connectionId,
      `git branch -m ${quoteShellArg(oldBranch)} ${quoteShellArg(newBranch)}`,
      cwd
    );
    if (renameResult.exitCode !== 0) {
      throw new Error(`Failed to rename branch: ${renameResult.stderr}`);
    }

    // Update remote if needed
    if (remotePushed) {
      // Delete old remote branch (non-fatal)
      await this.exec(
        connectionId,
        `git push ${quoteShellArg(remoteName)} --delete ${quoteShellArg(oldBranch)} 2>/dev/null`,
        cwd
      );
      // Push new branch
      const pushResult = await this.exec(
        connectionId,
        `git push -u ${quoteShellArg(remoteName)} ${quoteShellArg(newBranch)}`,
        cwd
      );
      if (pushResult.exitCode !== 0) {
        throw new Error(`Failed to push renamed branch: ${pushResult.stderr}`);
      }
    }

    return { remotePushed };
  }

  // ---------------------------------------------------------------------------
  // GitHub CLI operations (run gh commands over SSH)
  // ---------------------------------------------------------------------------

  /** Tracks whether `gh` CLI is available per connection. */
  private _ghAvailable = new Map<string, boolean>();
  /** Coalesces the initial `gh` probe so concurrent calls don't all hit SSH. */
  private _ghProbe = new Map<string, Promise<boolean>>();

  async execGh(connectionId: string, worktreePath: string, ghArgs: string): Promise<ExecResult> {
    // Fast path: if we already know gh isn't installed, don't waste an SSH channel
    if (this._ghAvailable.get(connectionId) === false) {
      return { stdout: '', stderr: 'gh: command not found (cached)', exitCode: 127 };
    }

    // First call: probe gh availability (coalesced across concurrent callers)
    if (!this._ghAvailable.has(connectionId)) {
      let probe = this._ghProbe.get(connectionId);
      if (!probe) {
        probe = this.exec(
          connectionId,
          'command -v gh >/dev/null 2>&1 && echo yes || echo no',
          this.normalizeRemotePath(worktreePath)
        )
          .then((r) => r.stdout.trim() === 'yes')
          .catch(() => false)
          .finally(() => this._ghProbe.delete(connectionId));
        this._ghProbe.set(connectionId, probe);
      }
      const available = await probe;
      this._ghAvailable.set(connectionId, available);
      if (!available) {
        return { stdout: '', stderr: 'gh: command not found', exitCode: 127 };
      }
    }

    const cwd = this.normalizeRemotePath(worktreePath);
    return this.exec(connectionId, `gh ${ghArgs}`, cwd);
  }

  async execGit(connectionId: string, worktreePath: string, gitArgs: string): Promise<ExecResult> {
    const cwd = this.normalizeRemotePath(worktreePath);
    return this.exec(connectionId, `git ${gitArgs}`, cwd);
  }
}
