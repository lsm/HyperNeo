import {
  MAX_SPACE_CONCURRENT_TASKS,
  MIN_SPACE_CONCURRENT_TASKS,
  type MessageHub,
} from '@hyperneo/shared';
import type {
  Space,
  SpaceCreateResult,
  SpaceAutonomyLevel,
  CreateSpaceParams,
  UpdateSpaceParams,
  SpaceTask,
  SpaceWorkflowRun,
  SpaceWorkspace,
  SpaceWorkspaceAddParams,
  SpaceWorkspaceRemoveParams,
} from '@hyperneo/shared';
import type { DaemonInternalEventMap, InternalEventBus } from '../internal-event-bus.ts';
import type { SpaceManager } from '../space/managers/space-manager.ts';
import type { SpaceAgentManager } from '../space/managers/space-agent-manager.ts';
import type { SpaceWorkflowManager } from '../space/managers/space-workflow-manager.ts';
import type { SpaceTaskRepository } from '../../storage/repositories/space-task-repository.ts';
import type { SpaceWorkflowRunRepository } from '../../storage/repositories/space-workflow-run-repository.ts';
import type { SessionManager } from '../session-manager.ts';
import type { SpaceRuntimeService } from '../space/runtime/space-runtime-service.ts';
import { seedPresetAgents } from '../space/agents/seed-agents.ts';
import type { SpaceLongHorizonAgentRepository } from '../../storage/repositories/space-long-horizon-agent-repository.ts';
import { seedBuiltInWorkflows } from '../space/workflows/built-in-workflows.ts';
import { Logger } from '../logger.ts';

const log = new Logger('space-handlers');
const VALID_AUTONOMY_LEVELS: SpaceAutonomyLevel[] = [1, 2, 3, 4, 5];

export interface SpaceOverviewResult {
  space: Space;
  tasks: SpaceTask[];
  workflowRuns: SpaceWorkflowRun[];
  sessions: string[];
}

function validateConcurrentLimit(limit: unknown): number {
  if (typeof limit !== 'number' || !Number.isInteger(limit)) {
    throw new Error(
      `Invalid concurrent task limit: ${String(limit)}. Must be an integer between ${MIN_SPACE_CONCURRENT_TASKS} and ${MAX_SPACE_CONCURRENT_TASKS}`
    );
  }
  if (limit < MIN_SPACE_CONCURRENT_TASKS || limit > MAX_SPACE_CONCURRENT_TASKS) {
    throw new Error(
      `Invalid concurrent task limit: ${String(limit)}. Must be an integer between ${MIN_SPACE_CONCURRENT_TASKS} and ${MAX_SPACE_CONCURRENT_TASKS}`
    );
  }
  return limit;
}

function pickCanonicalTaskForRun(tasks: SpaceTask[], runTitle?: string): SpaceTask {
  const normalizedRunTitle = runTitle?.trim().toLowerCase();
  if (normalizedRunTitle) {
    const exactTitleMatch = tasks.find(
      (task) => task.title.trim().toLowerCase() === normalizedRunTitle
    );
    if (exactTitleMatch) return exactTitleMatch;
  }

  return [...tasks].sort((a, b) => {
    if (a.createdAt !== b.createdAt) return a.createdAt - b.createdAt;
    return a.taskNumber - b.taskNumber;
  })[0];
}

function collapseToCanonicalTasks(
  tasks: SpaceTask[],
  workflowRuns: SpaceWorkflowRun[]
): SpaceTask[] {
  if (tasks.length === 0) return [];

  const runsById = new Map(workflowRuns.map((run) => [run.id, run]));
  const groupedByRun = new Map<string, SpaceTask[]>();
  const canonical: SpaceTask[] = [];

  for (const task of tasks) {
    if (!task.workflowRunId) {
      canonical.push(task);
      continue;
    }
    const existing = groupedByRun.get(task.workflowRunId) ?? [];
    existing.push(task);
    groupedByRun.set(task.workflowRunId, existing);
  }

  for (const [runId, runTasks] of groupedByRun) {
    const runTitle = runsById.get(runId)?.title;
    canonical.push(pickCanonicalTaskForRun(runTasks, runTitle));
  }

  return canonical.sort((a, b) => b.updatedAt - a.updatedAt);
}

type SetupSpaceHandlersOptions = {
  longHorizonAgentRepo?: SpaceLongHorizonAgentRepository;
};

export function setupSpaceHandlers(
  messageHub: MessageHub,
  spaceManager: SpaceManager,
  taskRepo: SpaceTaskRepository,
  workflowRunRepo: SpaceWorkflowRunRepository,
  internalEventBus: InternalEventBus<DaemonInternalEventMap>,
  spaceAgentManager: SpaceAgentManager,
  spaceWorkflowManager: SpaceWorkflowManager,
  sessionManager?: SessionManager,
  spaceRuntimeService?: SpaceRuntimeService,
  options: SetupSpaceHandlersOptions = {}
): void {
  messageHub.onRequest('space.create', async (data) => {
    const params = data as CreateSpaceParams;

    if (!params.workspacePath) {
      throw new Error('workspacePath is required');
    }
    if (!params.name || params.name.trim() === '') {
      throw new Error('name is required');
    }
    if (
      params.autonomyLevel !== undefined &&
      !VALID_AUTONOMY_LEVELS.includes(params.autonomyLevel)
    ) {
      throw new Error(
        `Invalid autonomyLevel: ${params.autonomyLevel}. Must be one of: ${VALID_AUTONOMY_LEVELS.join(', ')}`
      );
    }
    if (params.maxConcurrentTasks !== undefined) {
      params.maxConcurrentTasks = validateConcurrentLimit(params.maxConcurrentTasks);
    }
    if (params.config?.maxConcurrentTasks !== undefined) {
      params.config.maxConcurrentTasks = validateConcurrentLimit(params.config.maxConcurrentTasks);
    }
    if (params.additionalWorkspaces) {
      for (const [index, workspace] of params.additionalWorkspaces.entries()) {
        if (typeof workspace?.path !== 'string' || workspace.path.trim() === '') {
          throw new Error(`additionalWorkspaces[${index}].path is required`);
        }
      }
    }

    const space = await spaceManager.createSpace(params);
    const seedWarnings: string[] = [];
    options.longHorizonAgentRepo?.ensureCoordinator(space.id);

    try {
      const agentSeedResult = await seedPresetAgents(space.id, spaceAgentManager);
      if (agentSeedResult.errors.length > 0) {
        const failedNames = agentSeedResult.errors.map((e) => e.name).join(', ');
        log.warn(
          `Partial agent seed failure for space ${space.id}: ${failedNames}`,
          agentSeedResult.errors
        );
        seedWarnings.push(`Failed to seed agents: ${failedNames}`);
      }
    } catch (err) {
      log.warn('Failed to seed preset agents for space', space.id, err);
      seedWarnings.push('Failed to seed preset agents');
    }

    try {
      const agents = spaceAgentManager.listBySpaceId(space.id);
      const workflowSeedResult = seedBuiltInWorkflows(
        space.id,
        spaceWorkflowManager,
        (name) => agents.find((a) => a.name.toLowerCase() === name.toLowerCase())?.id
      );
      if (workflowSeedResult.errors.length > 0) {
        const failedNames = workflowSeedResult.errors.map((e) => e.name).join(', ');
        log.warn(
          `Partial workflow seed failure for space ${space.id}: ${failedNames}`,
          workflowSeedResult.errors
        );
        seedWarnings.push(`Failed to seed workflows: ${failedNames}`);
      }
    } catch (err) {
      log.warn('Failed to seed built-in workflows for space', space.id, err);
      seedWarnings.push('Failed to seed built-in workflows');
    }

    if (sessionManager) {
      const spaceChatSessionId = `space:chat:${space.id}`;
      try {
        await sessionManager.createSession({
          sessionId: spaceChatSessionId,
          title: space.name,
          workspacePath: space.workspacePath,
          config: {
            model: space.defaultModel,
          },
          sessionType: 'space_chat',
          spaceId: space.id,
        });
        await spaceManager.addSession(space.id, spaceChatSessionId);
        if (spaceRuntimeService) {
          await spaceRuntimeService.setupSpaceAgentSession(space).catch((err) => {
            log.warn(`Failed to provision space chat session for space ${space.id}:`, err);
          });
        }
      } catch (error) {
        log.warn(`Failed to create space chat session for space ${space.id}:`, error);
      }
    }

    internalEventBus
      .publish('space.created', { sessionId: 'global', spaceId: space.id, space })
      .catch((err) => {
        log.warn('Failed to emit space.created:', err);
      });

    if (seedWarnings.length > 0) {
      return { ...space, seedWarnings } satisfies SpaceCreateResult;
    }
    return space;
  });

  messageHub.onRequest('space.list', async (data) => {
    const params = (data ?? {}) as { includeArchived?: boolean };
    return spaceManager.listSpaces(params.includeArchived ?? false);
  });

  messageHub.onRequest('space.get', async (data) => {
    const params = data as { id?: string; slug?: string };

    if (!params.id && !params.slug) {
      throw new Error('id or slug is required');
    }

    let space;
    if (params.id) {
      space = await spaceManager.getSpace(params.id);
    } else {
      space = await spaceManager.getSpaceBySlug(params.slug!);
    }

    if (!space) {
      throw new Error(`Space not found: ${params.id ?? params.slug}`);
    }

    return space;
  });

  messageHub.onRequest('space.updateSlug', async (data) => {
    const params = data as { id: string; slug: string };

    if (!params.id) {
      throw new Error('id is required');
    }
    if (!params.slug) {
      throw new Error('slug is required');
    }

    const space = await spaceManager.updateSlug(params.id, params.slug);

    internalEventBus
      .publish('space.updated', { sessionId: 'global', spaceId: params.id, space })
      .catch((err) => {
        log.warn('Failed to emit space.updated:', err);
      });

    return space;
  });

  messageHub.onRequest('space.update', async (data) => {
    const params = data as { id: string } & UpdateSpaceParams;

    if (!params.id) {
      throw new Error('id is required');
    }
    if (
      params.autonomyLevel !== undefined &&
      !VALID_AUTONOMY_LEVELS.includes(params.autonomyLevel)
    ) {
      throw new Error(
        `Invalid autonomyLevel: ${params.autonomyLevel}. Must be one of: ${VALID_AUTONOMY_LEVELS.join(', ')}`
      );
    }
    if (params.maxConcurrentTasks !== undefined) {
      params.maxConcurrentTasks = validateConcurrentLimit(params.maxConcurrentTasks);
    }
    if (params.config?.maxConcurrentTasks !== undefined) {
      params.config.maxConcurrentTasks = validateConcurrentLimit(params.config.maxConcurrentTasks);
    }

    const { id, ...updateParams } = params;
    const space = await spaceManager.updateSpace(id, updateParams);

    internalEventBus
      .publish('space.updated', { sessionId: 'global', spaceId: id, space })
      .catch((err) => {
        log.warn('Failed to emit space.updated:', err);
      });

    return space;
  });

  messageHub.onRequest('space.setConcurrentLimit', async (data) => {
    const params = data as { spaceId?: string; id?: string; limit: unknown };
    const spaceId = params.spaceId ?? params.id;

    if (!spaceId) {
      throw new Error('spaceId is required');
    }

    const limit = validateConcurrentLimit(params.limit);
    const space = await spaceManager.updateSpace(spaceId, { maxConcurrentTasks: limit });

    internalEventBus
      .publish('space.updated', { sessionId: 'global', spaceId, space })
      .catch((err) => {
        log.warn('Failed to emit space.updated:', err);
      });

    return space;
  });

  messageHub.onRequest('space.archive', async (data) => {
    const params = data as { id: string };

    if (!params.id) {
      throw new Error('id is required');
    }

    const space = await spaceManager.archiveSpace(params.id);

    internalEventBus
      .publish('space.archived', { sessionId: 'global', spaceId: params.id, space })
      .catch((err) => {
        log.warn('Failed to emit space.archived:', err);
      });

    return space;
  });

  messageHub.onRequest('space.stop', async (data) => {
    const params = data as { id: string };

    if (!params.id) {
      throw new Error('id is required');
    }

    const space = await spaceManager.stopSpace(params.id);

    if (spaceRuntimeService) {
      await spaceRuntimeService.stopActiveWork(params.id);
    }

    internalEventBus
      .publish('space.updated', { sessionId: 'global', spaceId: params.id, space })
      .catch((err) => {
        log.warn('Failed to emit space.updated:', err);
      });

    return space;
  });

  messageHub.onRequest('space.start', async (data) => {
    const params = data as { id: string };

    if (!params.id) {
      throw new Error('id is required');
    }

    const space = await spaceManager.startSpace(params.id);

    internalEventBus
      .publish('space.updated', { sessionId: 'global', spaceId: params.id, space })
      .catch((err) => {
        log.warn('Failed to emit space.updated:', err);
      });

    return space;
  });

  messageHub.onRequest('space.pause', async (data) => {
    const params = data as { id: string };

    if (!params.id) {
      throw new Error('id is required');
    }

    const space = await spaceManager.pauseSpace(params.id);

    internalEventBus
      .publish('space.updated', { sessionId: 'global', spaceId: params.id, space })
      .catch((err) => {
        log.warn('Failed to emit space.updated:', err);
      });

    return space;
  });

  messageHub.onRequest('space.resume', async (data) => {
    const params = data as { id: string };

    if (!params.id) {
      throw new Error('id is required');
    }

    const space = await spaceManager.resumeSpace(params.id);

    internalEventBus
      .publish('space.updated', { sessionId: 'global', spaceId: params.id, space })
      .catch((err) => {
        log.warn('Failed to emit space.updated:', err);
      });

    return space;
  });

  messageHub.onRequest('space.delete', async (data) => {
    const params = data as { id: string };

    if (!params.id) {
      throw new Error('id is required');
    }

    const deleted = await spaceManager.deleteSpace(params.id);
    if (!deleted) {
      throw new Error(`Space not found: ${params.id}`);
    }

    internalEventBus
      .publish('space.deleted', { sessionId: 'global', spaceId: params.id })
      .catch((err) => {
        log.warn('Failed to emit space.deleted:', err);
      });

    return { success: true };
  });

  messageHub.onRequest('space.listWithTasks', async (data) => {
    const params = (data ?? {}) as { includeArchived?: boolean };
    const spaces = await spaceManager.listSpaces(params.includeArchived ?? false);

    const allSessions = sessionManager?.listSessions({ includeArchived: false }) ?? [];
    const sessionById = new Map(allSessions.map((s) => [s.id, s]));

    return spaces.map((space) => {
      const spaceSessions = space.sessionIds
        .map((id) => sessionById.get(id))
        .filter(
          (s) =>
            s !== undefined &&
            s.status !== 'archived' &&
            s.status !== 'ended' &&
            s.type !== 'space_chat'
        )
        .sort((a, b) => {
          const aTime = a!.lastActiveAt ? new Date(a!.lastActiveAt).getTime() : 0;
          const bTime = b!.lastActiveAt ? new Date(b!.lastActiveAt).getTime() : 0;
          return bTime - aTime;
        })
        .slice(0, 3)
        .map((s) => ({
          id: s!.id,
          title: s!.title,
          status: s!.status,
          type: s!.type ?? 'worker',
          lastActiveAt: s!.lastActiveAt ? new Date(s!.lastActiveAt).getTime() : 0,
        }));

      return {
        ...space,
        tasks: collapseToCanonicalTasks(
          taskRepo.listBySpace(space.id),
          workflowRunRepo.listBySpace(space.id)
        ).filter((t) => t.status !== 'done' && t.status !== 'cancelled'),
        sessions: spaceSessions,
      };
    });
  });

  messageHub.onRequest('space.overview', async (data) => {
    const params = data as { id?: string; slug?: string };

    if (!params.id && !params.slug) {
      throw new Error('id or slug is required');
    }

    let space;
    if (params.id) {
      space = await spaceManager.getSpace(params.id);
    } else {
      space = await spaceManager.getSpaceBySlug(params.slug!);
    }

    if (!space) {
      throw new Error(`Space not found: ${params.id ?? params.slug}`);
    }

    const workflowRuns = workflowRunRepo.listBySpace(space.id);
    const tasks = collapseToCanonicalTasks(taskRepo.listBySpace(space.id), workflowRuns);

    const result: SpaceOverviewResult = {
      space,
      tasks,
      workflowRuns,
      sessions: space.sessionIds,
    };

    return result;
  });

  messageHub.onRequest('space.workspace.list', async (data) => {
    const params = (data ?? {}) as { spaceId: string };
    return spaceManager.listWorkspaces(params.spaceId) satisfies SpaceWorkspace[];
  });

  messageHub.onRequest('space.workspace.add', async (data) => {
    const params = (data ?? {}) as SpaceWorkspaceAddParams;
    const workspace = await spaceManager.registerWorkspace(
      params.spaceId,
      params.path,
      params.label
    );
    return workspace satisfies SpaceWorkspace;
  });

  messageHub.onRequest('space.workspace.remove', async (data) => {
    const params = (data ?? {}) as SpaceWorkspaceRemoveParams;
    const removed = spaceManager.removeWorkspace(params.spaceId, params.workspaceId);
    if (!removed) {
      throw new Error(`Workspace not found: ${params.workspaceId}`);
    }
    return { success: true };
  });
}
