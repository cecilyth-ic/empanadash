import fs from 'fs';
import path from 'path';
import { log } from '../lib/logger';

export class ClaudeHookService {
  /**
   * Build the curl command used in Claude Code hook entries.
   *
   * The command pipes stdin directly to curl via `-d @-` to avoid any shell
   * expansion of the payload (which can contain $, backticks, etc. in
   * AI-generated text). The ptyId and event type are sent as HTTP headers
   * instead of being embedded in the JSON body.
   */
  static makeHookCommand(type: string): string {
    return (
      'curl -sf -X POST ' +
      '-H "Content-Type: application/json" ' +
      '-H "X-Emdash-Token: $EMDASH_HOOK_TOKEN" ' +
      `-H "X-Emdash-Pty-Id: $EMDASH_PTY_ID" ` +
      `-H "X-Emdash-Event-Type: ${type}" ` +
      '-d @- ' +
      '"http://127.0.0.1:$EMDASH_HOOK_PORT/hook" || true'
    );
  }

  /**
   * Build the inline shell command for the PostToolUse/Agent hook that detects
   * teammate spawns and notifies AgentEventService.
   *
   * Reads the PostToolUse JSON from stdin, extracts the tmux session name and
   * pane ID from the Agent tool response, resolves the actual tmux socket
   * (which includes a PID suffix), and POSTs a teammate_spawn event.
   */
  static makeTeammateSpawnCommand(): string {
    // Inline script that detects teammate spawns from PostToolUse/Agent hook data.
    // Uses jq when available, falls back to grep/sed for environments without jq.
    // Uses printf instead of echo to pipe JSON, because dash (common /bin/sh)
    // interprets escape sequences in echo, corrupting the JSON payload.
    return [
      'D=$(cat)',
      'if command -v jq >/dev/null 2>&1; then',
      '  N=$(printf \'%s\\n\' "$D" | jq -r \'.tool_input.name // "subagent"\' 2>/dev/null)',
      '  S=$(printf \'%s\\n\' "$D" | jq -r \'.tool_response.tmux_session_name // ""\' 2>/dev/null)',
      '  P=$(printf \'%s\\n\' "$D" | jq -r \'.tool_response.tmux_pane_id // ""\' 2>/dev/null)',
      'else',
      '  N=$(printf \'%s\\n\' "$D" | grep -o \'"name" *: *"[^"]*"\' | head -1 | sed \'s/.*: *"//;s/"$//\')',
      '  S=$(printf \'%s\\n\' "$D" | grep -o \'"tmux_session_name" *: *"[^"]*"\' | head -1 | sed \'s/.*: *"//;s/"$//\')',
      '  P=$(printf \'%s\\n\' "$D" | grep -o \'"tmux_pane_id" *: *"[^"]*"\' | head -1 | sed \'s/.*: *"//;s/"$//\')',
      '  [ -z "$N" ] && N=subagent',
      'fi',
      '[ "$S" = "in-process" ] && S=""',
      '[ "$P" = "in-process" ] && P=""',
      'if [ -n "$S" ]; then A=$(ls -t /tmp/tmux-$(id -u)/${S}-* 2>/dev/null | head -1 | xargs -I{} basename {} 2>/dev/null); [ -n "$A" ] && S="$A"; fi',
      '[ -z "$S" ] || [ -z "$P" ] && exit 0',
      'curl -sf -X POST' +
        ' -H "Content-Type: application/json"' +
        ' -H "X-Emdash-Token: $EMDASH_HOOK_TOKEN"' +
        ' -H "X-Emdash-Pty-Id: $EMDASH_PTY_ID"' +
        ' -H "X-Emdash-Event-Type: teammate_spawn"' +
        ' -d "{\\"agentName\\":\\"$N\\",\\"tmuxSocket\\":\\"$S\\",\\"paneId\\":\\"$P\\"}"' +
        ' "http://127.0.0.1:$EMDASH_HOOK_PORT/hook" || true',
    ].join('\n');
  }

  /**
   * Merge emdash hook entries into an existing settings object.
   * Strips old emdash entries (identified by the EMDASH_HOOK_PORT marker),
   * preserves user-defined hooks, and appends fresh Notification + Stop entries.
   * Returns the mutated object.
   */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  static mergeHookEntries(existing: Record<string, any>): Record<string, any> {
    const hooks = existing.hooks || {};

    for (const eventType of ['Notification', 'Stop'] as const) {
      const prev: unknown[] = Array.isArray(hooks[eventType]) ? hooks[eventType] : [];
      const userEntries = prev.filter(
        (entry: any) => !JSON.stringify(entry).includes('EMDASH_HOOK_PORT')
      );
      userEntries.push({
        hooks: [
          { type: 'command', command: ClaudeHookService.makeHookCommand(eventType.toLowerCase()) },
        ],
      });
      hooks[eventType] = userEntries;
    }

    // PostToolUse hook for Agent tool — detects teammate spawns and notifies
    // the UI so it can open a tab for each new teammate.
    {
      const prev: unknown[] = Array.isArray(hooks.PostToolUse) ? hooks.PostToolUse : [];
      const userEntries = prev.filter(
        (entry: any) => !JSON.stringify(entry).includes('EMDASH_HOOK_PORT')
      );
      userEntries.push({
        matcher: 'Agent',
        hooks: [{ type: 'command', command: ClaudeHookService.makeTeammateSpawnCommand() }],
      });
      hooks.PostToolUse = userEntries;
    }

    existing.hooks = hooks;
    return existing;
  }

  static writeHookConfig(worktreePath: string): void {
    const claudeDir = path.join(worktreePath, '.claude');
    const settingsPath = path.join(claudeDir, 'settings.local.json');

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let existing: Record<string, any> = {};
    try {
      const content = fs.readFileSync(settingsPath, 'utf-8');
      existing = JSON.parse(content);
    } catch {
      // File doesn't exist or isn't valid JSON — start fresh
    }

    try {
      fs.mkdirSync(claudeDir, { recursive: true });
    } catch {
      // May already exist
    }

    ClaudeHookService.mergeHookEntries(existing);

    try {
      fs.writeFileSync(settingsPath, JSON.stringify(existing, null, 2) + '\n');
    } catch (err) {
      log.warn('ClaudeHookService: failed to write hook config', {
        path: settingsPath,
        error: String(err),
      });
    }
  }
}
