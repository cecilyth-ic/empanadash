import { databaseService, type Project } from '../services/DatabaseService';

export type RemoteProject = Project & { sshConnectionId: string; remotePath: string };

export function isRemoteProject(project: Project | null): project is RemoteProject {
  return !!(
    project &&
    project.isRemote &&
    typeof project.sshConnectionId === 'string' &&
    project.sshConnectionId.length > 0 &&
    typeof project.remotePath === 'string' &&
    project.remotePath.length > 0
  );
}

export async function resolveRemoteProjectForWorktreePath(
  worktreePath: string
): Promise<RemoteProject | null> {
  const all = await databaseService.getProjects();
  // Pick the longest matching remotePath prefix.
  // Also match graft-style paths (e.g. ~/grafts/repo/<name>/subdir)
  // where the worktree is outside the project's remotePath tree.
  const candidates = all
    .filter((p) => isRemoteProject(p))
    .filter((p) => {
      const normalized = p.remotePath.replace(/\/+$/g, '');
      // Direct prefix match (standard .emdash/worktrees paths)
      if (worktreePath === normalized || worktreePath.startsWith(normalized + '/')) {
        return true;
      }
      // Graft-style match: path like ~/grafts/carrot/<name>/customers
      // where remotePath is e.g. /home/bento/carrot/customers
      const subdir = normalized.split('/').pop();
      if (subdir && worktreePath.endsWith('/' + subdir) && worktreePath.includes('/grafts/')) {
        return true;
      }
      return false;
    })
    .sort((a, b) => b.remotePath.length - a.remotePath.length);
  return candidates[0] ?? null;
}
