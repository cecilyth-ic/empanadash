import { ipcMain } from 'electron';
import { worktreeService } from './WorktreeService';
import { worktreePoolService } from './WorktreePoolService';
import { databaseService, type Project } from './DatabaseService';
import { getDrizzleClient } from '../db/drizzleClient';
import { projects as projectsTable } from '../db/schema';
import { eq } from 'drizzle-orm';
import crypto from 'crypto';
import { RemoteGitService } from './RemoteGitService';
import { sshService } from './ssh/SshService';
import { log } from '../lib/logger';
import {
  isRemoteProject,
  resolveRemoteProjectForWorktreePath,
} from '../utils/remoteProjectResolver';

const remoteGitService = new RemoteGitService(sshService);

function stableIdFromRemotePath(worktreePath: string): string {
  const h = crypto.createHash('sha1').update(worktreePath).digest('hex').slice(0, 12);
  return `wt-${h}`;
}

async function resolveProjectByIdOrPath(args: {
  projectId?: string;
  projectPath?: string;
}): Promise<Project | null> {
  if (args.projectId) {
    return databaseService.getProjectById(args.projectId);
  }
  if (args.projectPath) {
    const { db } = await getDrizzleClient();
    const rows = await db
      .select({ id: projectsTable.id })
      .from(projectsTable)
      .where(eq(projectsTable.path, args.projectPath))
      .limit(1);
    if (rows.length > 0) {
      return databaseService.getProjectById(rows[0].id);
    }
  }
  return null;
}

// isRemoteProject and resolveRemoteProjectForWorktreePath imported from ../utils/remoteProjectResolver

export function registerWorktreeIpc(): void {
  // Create a new worktree
  ipcMain.handle(
    'worktree:create',
    async (
      event,
      args: {
        projectPath: string;
        taskName: string;
        projectId: string;
        baseRef?: string;
      }
    ) => {
      const ipcStart = Date.now();
      log.info('[worktreeIpc] worktree:create called', {
        taskName: args.taskName,
        projectId: args.projectId,
      });
      try {
        const project = await resolveProjectByIdOrPath({
          projectId: args.projectId,
          projectPath: args.projectPath,
        });
        log.info(
          `[worktreeIpc] worktree:create resolveProject took ${Date.now() - ipcStart}ms, isRemote=${isRemoteProject(project)}`
        );

        if (isRemoteProject(project)) {
          const baseRef = args.baseRef ?? project.gitInfo.baseRef;
          log.info('[worktreeIpc] worktree:create (remote) starting createWorktree', {
            projectId: project.id,
            remotePath: project.remotePath,
            baseRef,
          });
          const createStart = Date.now();
          const remote = await remoteGitService.createWorktree(
            project.sshConnectionId,
            project.remotePath,
            args.taskName,
            baseRef
          );
          log.info(
            `[worktreeIpc] worktree:create (remote) createWorktree completed in ${Date.now() - createStart}ms`
          );
          const worktree = {
            id: stableIdFromRemotePath(remote.path),
            name: args.taskName,
            branch: remote.branch,
            path: remote.path,
            projectId: project.id,
            status: 'active' as const,
            createdAt: new Date().toISOString(),
          };
          log.info(`[worktreeIpc] worktree:create total: ${Date.now() - ipcStart}ms`);
          return { success: true, worktree };
        }

        const worktree = await worktreeService.createWorktree(
          args.projectPath,
          args.taskName,
          args.projectId,
          args.baseRef
        );
        log.info(`[worktreeIpc] worktree:create (local) total: ${Date.now() - ipcStart}ms`);
        return { success: true, worktree };
      } catch (error) {
        log.error(
          `[worktreeIpc] worktree:create FAILED after ${Date.now() - ipcStart}ms:`,
          error as Error
        );
        return { success: false, error: (error as Error).message };
      }
    }
  );

  // List worktrees for a project
  ipcMain.handle('worktree:list', async (event, args: { projectPath: string }) => {
    const listStart = Date.now();
    log.info('[worktreeIpc] worktree:list called', { projectPath: args.projectPath });
    try {
      const project = await resolveProjectByIdOrPath({ projectPath: args.projectPath });
      if (isRemoteProject(project)) {
        const remoteWorktrees = await remoteGitService.listWorktrees(
          project.sshConnectionId,
          project.remotePath
        );
        const worktrees = remoteWorktrees.map((wt) => {
          const name = wt.path.split('/').filter(Boolean).pop() || wt.path;
          return {
            id: stableIdFromRemotePath(wt.path),
            name,
            branch: wt.branch,
            path: wt.path,
            projectId: project.id,
            status: 'active' as const,
            createdAt: new Date().toISOString(),
          };
        });
        log.info(
          `[worktreeIpc] worktree:list (remote) completed in ${Date.now() - listStart}ms, count=${worktrees.length}`
        );
        return { success: true, worktrees };
      }

      const worktrees = await worktreeService.listWorktrees(args.projectPath);
      log.info(`[worktreeIpc] worktree:list (local) completed in ${Date.now() - listStart}ms`);
      return { success: true, worktrees };
    } catch (error) {
      log.error(
        `[worktreeIpc] worktree:list FAILED after ${Date.now() - listStart}ms:`,
        error as Error
      );
      return { success: false, error: (error as Error).message };
    }
  });

  // Remove a worktree
  ipcMain.handle(
    'worktree:remove',
    async (
      event,
      args: {
        projectPath: string;
        worktreeId: string;
        worktreePath?: string;
        branch?: string;
      }
    ) => {
      try {
        const project = await resolveProjectByIdOrPath({ projectPath: args.projectPath });
        if (isRemoteProject(project)) {
          const pathToRemove = args.worktreePath;
          if (!pathToRemove) {
            throw new Error('worktreePath is required for remote worktree removal');
          }
          log.info('worktree:remove (remote)', {
            projectId: project.id,
            remotePath: project.remotePath,
            worktreePath: pathToRemove,
          });
          // Single batched call: remove + prune + branch delete
          await remoteGitService.removeWorktree(
            project.sshConnectionId,
            project.remotePath,
            pathToRemove,
            args.branch
          );
          return { success: true };
        }

        await worktreeService.removeWorktree(
          args.projectPath,
          args.worktreeId,
          args.worktreePath,
          args.branch
        );
        return { success: true };
      } catch (error) {
        console.error('Failed to remove worktree:', error);
        return { success: false, error: (error as Error).message };
      }
    }
  );

  // Get worktree status
  ipcMain.handle('worktree:status', async (event, args: { worktreePath: string }) => {
    const statusStart = Date.now();
    log.info('[worktreeIpc] worktree:status called', { worktreePath: args.worktreePath });
    try {
      const remoteProject = await resolveRemoteProjectForWorktreePath(args.worktreePath);
      if (remoteProject) {
        const status = await remoteGitService.getWorktreeStatus(
          remoteProject.sshConnectionId,
          args.worktreePath
        );
        log.info(
          `[worktreeIpc] worktree:status (remote) completed in ${Date.now() - statusStart}ms`
        );
        return { success: true, status };
      }

      const status = await worktreeService.getWorktreeStatus(args.worktreePath);
      log.info(`[worktreeIpc] worktree:status (local) completed in ${Date.now() - statusStart}ms`);
      return { success: true, status };
    } catch (error) {
      log.error(
        `[worktreeIpc] worktree:status FAILED after ${Date.now() - statusStart}ms:`,
        error as Error
      );
      return { success: false, error: (error as Error).message };
    }
  });

  // Merge worktree changes
  ipcMain.handle(
    'worktree:merge',
    async (
      event,
      args: {
        projectPath: string;
        worktreeId: string;
      }
    ) => {
      try {
        const project = await resolveProjectByIdOrPath({ projectPath: args.projectPath });
        if (isRemoteProject(project)) {
          return { success: false, error: 'Remote worktree merge is not supported yet' };
        }
        await worktreeService.mergeWorktreeChanges(args.projectPath, args.worktreeId);
        return { success: true };
      } catch (error) {
        console.error('Failed to merge worktree changes:', error);
        return { success: false, error: (error as Error).message };
      }
    }
  );

  // Get worktree by ID
  ipcMain.handle('worktree:get', async (event, args: { worktreeId: string }) => {
    try {
      const worktree = worktreeService.getWorktree(args.worktreeId);
      return { success: true, worktree };
    } catch (error) {
      console.error('Failed to get worktree:', error);
      return { success: false, error: (error as Error).message };
    }
  });

  // Get all worktrees
  ipcMain.handle('worktree:getAll', async () => {
    try {
      const worktrees = worktreeService.getAllWorktrees();
      return { success: true, worktrees };
    } catch (error) {
      console.error('Failed to get all worktrees:', error);
      return { success: false, error: (error as Error).message };
    }
  });

  // Ensure a reserve worktree exists for a project (background operation)
  ipcMain.handle(
    'worktree:ensureReserve',
    async (
      event,
      args: {
        projectId: string;
        projectPath: string;
        baseRef?: string;
      }
    ) => {
      try {
        const project = await resolveProjectByIdOrPath({
          projectId: args.projectId,
          projectPath: args.projectPath,
        });
        if (isRemoteProject(project)) {
          // Remote worktree pooling is not supported (avoid local mkdir on remote paths).
          return { success: true };
        }
        // Fire and forget - don't await, just start the process
        worktreePoolService.ensureReserve(args.projectId, args.projectPath, args.baseRef);
        return { success: true };
      } catch (error) {
        console.error('Failed to ensure reserve:', error);
        return { success: false, error: (error as Error).message };
      }
    }
  );

  // Check if a reserve is available for a project
  ipcMain.handle('worktree:hasReserve', async (event, args: { projectId: string }) => {
    try {
      const project = await resolveProjectByIdOrPath({ projectId: args.projectId });
      if (isRemoteProject(project)) {
        return { success: true, hasReserve: false };
      }
      const hasReserve = worktreePoolService.hasReserve(args.projectId);
      return { success: true, hasReserve };
    } catch (error) {
      console.error('Failed to check reserve:', error);
      return { success: false, error: (error as Error).message };
    }
  });

  // Claim a reserve worktree for a new task (instant operation)
  ipcMain.handle(
    'worktree:claimReserve',
    async (
      event,
      args: {
        projectId: string;
        projectPath: string;
        taskName: string;
        baseRef?: string;
      }
    ) => {
      try {
        const project = await resolveProjectByIdOrPath({
          projectId: args.projectId,
          projectPath: args.projectPath,
        });
        if (isRemoteProject(project)) {
          return { success: false, error: 'Remote worktree pooling is not supported yet' };
        }
        const result = await worktreePoolService.claimReserve(
          args.projectId,
          args.projectPath,
          args.taskName,
          args.baseRef
        );
        if (result) {
          return {
            success: true,
            worktree: result.worktree,
            needsBaseRefSwitch: result.needsBaseRefSwitch,
          };
        }
        return { success: false, error: 'No reserve available' };
      } catch (error) {
        console.error('Failed to claim reserve:', error);
        return { success: false, error: (error as Error).message };
      }
    }
  );

  // Claim a reserve and persist the task in one IPC round-trip.
  ipcMain.handle(
    'worktree:claimReserveAndSaveTask',
    async (
      event,
      args: {
        projectId: string;
        projectPath: string;
        taskName: string;
        baseRef?: string;
        task: {
          projectId: string;
          name: string;
          status: 'active' | 'idle' | 'running';
          agentId?: string | null;
          metadata?: any;
          useWorktree?: boolean;
        };
      }
    ) => {
      try {
        const project = await resolveProjectByIdOrPath({
          projectId: args.projectId,
          projectPath: args.projectPath,
        });
        if (isRemoteProject(project)) {
          return { success: false, error: 'Remote worktree pooling is not supported yet' };
        }

        const claim = await worktreePoolService.claimReserve(
          args.projectId,
          args.projectPath,
          args.taskName,
          args.baseRef
        );
        if (!claim) {
          return { success: false, error: 'No reserve available' };
        }

        const persistedTask = {
          id: claim.worktree.id,
          projectId: args.projectId,
          name: args.taskName,
          branch: claim.worktree.branch,
          path: claim.worktree.path,
          status: args.task.status,
          agentId: args.task.agentId ?? null,
          metadata: args.task.metadata ?? null,
          useWorktree: args.task.useWorktree !== false,
        };

        await databaseService.saveTask(persistedTask);

        return {
          success: true,
          worktree: claim.worktree,
          task: persistedTask,
          needsBaseRefSwitch: claim.needsBaseRefSwitch,
        };
      } catch (error) {
        console.error('Failed to claim reserve and save task:', error);
        return { success: false, error: (error as Error).message };
      }
    }
  );

  // Remove reserve for a project (cleanup)
  ipcMain.handle(
    'worktree:removeReserve',
    async (event, args: { projectId: string; projectPath?: string; isRemote?: boolean }) => {
      try {
        if (args.isRemote) {
          return { success: true };
        }

        let projectPath = args.projectPath;
        if (!projectPath) {
          const project = await resolveProjectByIdOrPath({ projectId: args.projectId });
          if (!project) {
            await worktreePoolService.removeReserve(args.projectId);
            return { success: true };
          }
          if (isRemoteProject(project)) {
            return { success: true };
          }
          projectPath = project.path;
        }

        await worktreePoolService.removeReserve(args.projectId, projectPath);
        return { success: true };
      } catch (error) {
        console.error('Failed to remove reserve:', error);
        return { success: false, error: (error as Error).message };
      }
    }
  );
}
