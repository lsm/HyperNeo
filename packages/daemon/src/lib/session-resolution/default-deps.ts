import type { PostApprovalRoute, Space, SpaceTask, SpaceWorkflow } from '@hyperneo/shared';
import superpipe, { type PipelineAPI } from 'superpipe';
import type { NodeExecutionRepository } from '../../storage/repositories/node-execution-repository.ts';
import type { SpaceLongHorizonAgentRepository } from '../../storage/repositories/space-long-horizon-agent-repository.ts';
import type { SpaceTaskRepository } from '../../storage/repositories/space-task-repository.ts';
import type { SpaceWorkflowRunRepository } from '../../storage/repositories/space-workflow-run-repository.ts';
import type { DaemonInternalEventMap, InternalEventBus } from '../internal-event-bus.ts';
import {
  hasRuntimeNodeAgentServer,
  isWorkflowSubSessionIdentity,
} from '../session/sub-session-identity.ts';
import type { SessionManager } from '../session-manager.ts';
import type { SpaceManager } from '../space/managers/space-manager.ts';
import type { SpaceWorkflowManager } from '../space/managers/space-workflow-manager.ts';
import type { WorkflowArtifactProfile } from '../space/runtime/artifact-profile.ts';
import {
  appendPostApprovalCompletionInstructions,
  collectDispatchablePostApprovalRoutes,
} from '../space/runtime/post-approval-router.ts';
import type { SpaceRuntimeService } from '../space/runtime/space-runtime-service.ts';
import { resolveTaskWorkspace } from '../space/runtime/spawn-slot-resolution.ts';
import type { TaskAgentManager } from '../space/runtime/task-agent-manager.ts';
import {
  interpolatePostApprovalTemplate,
  type PostApprovalTemplateContext,
} from '../space/workflows/post-approval-template.ts';
import { type SessionResolutionDeps, workerTaskPhaseOf } from './deps.ts';

const spawnHalted = (halt?: string): boolean => halt !== undefined;

const sessionUnavailable = (status: string): boolean => status === 'ended' || status === 'archived';

export function createDefaultSessionResolutionDeps(services: {
  sessionManager: SessionManager;
  taskAgentManager: TaskAgentManager;
  spaceRuntimeService: SpaceRuntimeService;
  nodeExecutionRepo: NodeExecutionRepository;
  taskRepo: SpaceTaskRepository;
  longHorizonAgentRepo: SpaceLongHorizonAgentRepository;
  workflowRunRepo: SpaceWorkflowRunRepository;
  spaceWorkflowManager: SpaceWorkflowManager;
  spaceManager?: Pick<SpaceManager, 'getSpace'>;
  artifactProfile?: Pick<WorkflowArtifactProfile, 'resolveInitialPrimaryLinkUrl'>;
  internalEventBus?: InternalEventBus<DaemonInternalEventMap>;
}): SessionResolutionDeps {
  const {
    sessionManager,
    taskAgentManager,
    spaceRuntimeService,
    nodeExecutionRepo,
    taskRepo,
    longHorizonAgentRepo,
    workflowRunRepo,
    spaceWorkflowManager,
    spaceManager,
    artifactProfile,
    internalEventBus,
  } = services;

  const spawnInFlight = new Map<string, Promise<string | null>>();

  const resolveLiveSession = async (
    sessionId: string
  ): Promise<ReturnType<SessionManager['getCachedSession']>> => {
    const indexed = taskAgentManager.getSubSession(sessionId);
    if (indexed !== undefined && sessionManager.getCachedSession(sessionId) === indexed) {
      const data = indexed.getSessionData();
      if (sessionUnavailable(data.status)) return null;
      if (isWorkflowSubSessionIdentity(sessionId) && !hasRuntimeNodeAgentServer(data.config)) {
        return null;
      }
      return indexed;
    }
    const session = await sessionManager.getSessionAsync(sessionId);
    if (session === null) return null;
    if (sessionUnavailable(session.getSessionData().status)) return null;
    if (
      isWorkflowSubSessionIdentity(sessionId) &&
      !hasRuntimeNodeAgentServer(session.getSessionData().config)
    ) {
      return null;
    }
    return session;
  };

  const runSpawnPostApprovalWorker = (
    superpipe({
      spawnHalted,
      taskRepo,
      workflowRunRepo,
      spaceWorkflowManager,
      taskAgentManager,
      spaceManager,
      artifactProfile,
      internalEventBus,
    })('spawn-post-approval-worker') as PipelineAPI
  )
    .input(['taskId', 'agentName', 'workflowNodeId'])
    .pipe(
      resolveSpawnRouteStage,
      ['taskId', 'agentName', 'taskRepo', 'workflowRunRepo', 'spaceWorkflowManager'],
      ['spawnRoute', 'routeHalt']
    )
    .pipe('!spawnHalted', 'routeHalt')
    .pipe(
      buildKickoffStage,
      ['spawnRoute', 'spaceManager', 'artifactProfile'],
      ['kickoffMessage', 'kickoffHalt']
    )
    .pipe('!spawnHalted', 'kickoffHalt')
    .pipe(
      spawnWorkerStage,
      [
        'spawnRoute',
        'kickoffMessage',
        'agentName',
        'workflowNodeId',
        'taskAgentManager',
        'taskId',
        'taskRepo',
      ],
      ['sessionId', 'spawnHalt']
    )
    .pipe('!spawnHalted', 'spawnHalt')
    .pipe(
      recordRoutedSessionStage,
      ['taskId', 'sessionId', 'taskRepo', 'spawnRoute', 'internalEventBus'],
      'recordedSessionId'
    )
    .error(() => undefined, ['error'])
    .endAsync('recordedSessionId') as (
    taskId: string,
    agentName: string,
    workflowNodeId?: string
  ) => Promise<string | undefined>;

  return {
    getSession: (sessionId) => resolveLiveSession(sessionId),

    async rehydrateSubSession(sessionId) {
      const restored = await taskAgentManager.rehydrateSubSessionById(sessionId);
      if (restored === null || sessionUnavailable(restored.getSessionData().status)) return null;
      return restored;
    },

    async getCoordinator(spaceId) {
      return longHorizonAgentRepo.getCoordinator(spaceId);
    },

    ensureLongTermAgent(spaceId, agentId) {
      return spaceRuntimeService.ensureAgentSession(spaceId, agentId);
    },

    listWorkerExecutions(target) {
      const workflowRunId = taskRepo.getTask(target.taskId)?.workflowRunId;
      if (workflowRunId == null) return [];
      return nodeExecutionRepo
        .listByWorkflowRun(workflowRunId)
        .filter((execution) => execution.agentName === target.agentName)
        .filter(
          (execution) =>
            target.workflowNodeId === undefined ||
            execution.workflowNodeId === target.workflowNodeId
        )
        .map((execution) => ({
          sessionId: execution.agentSessionId,
          status: execution.status,
        }));
    },

    readWorkerTaskPhase(taskId) {
      const task = taskRepo.getTask(taskId);
      if (task === null) return 'terminal';
      const postApprovalSessionId = task.postApprovalSessionId ?? null;
      const hasDurablePostApprovalWorker =
        task.status === 'done' && postApprovalSessionId === null
          ? taskAgentManager.getPostApprovalWorkerSession(taskId) !== null
          : false;
      return workerTaskPhaseOf(
        task.status,
        postApprovalSessionId,
        hasDurablePostApprovalWorker,
        task.postApprovalBlockedReason ?? null
      );
    },

    async getTaskSpaceId(taskId) {
      return taskRepo.getTask(taskId)?.spaceId ?? null;
    },

    activateTaskAgent(target) {
      return taskAgentManager.ensureWorkflowNodeActivationForAgent(
        target.taskId,
        target.agentName,
        {
          workflowNodeId: target.workflowNodeId,
        }
      );
    },

    async spawnPostApprovalWorker(taskId, agentName, workflowNodeId) {
      const runSerialized = async (): Promise<string | null> => {
        const routed = taskAgentManager.getPostApprovalWorkerSession(taskId);
        if (
          routed !== null &&
          routed.agentName === agentName &&
          (workflowNodeId === undefined || routed.nodeId === workflowNodeId)
        ) {
          if ((await resolveLiveSession(routed.sessionId)) !== null) return routed.sessionId;
        }
        return (
          (await runSpawnPostApprovalWorker(taskId, agentName, workflowNodeId).catch(
            () => undefined
          )) ?? null
        );
      };
      const previous = spawnInFlight.get(taskId) ?? Promise.resolve(null);
      const chained = previous.then(runSerialized, runSerialized);
      spawnInFlight.set(taskId, chained);
      try {
        return await chained;
      } finally {
        if (spawnInFlight.get(taskId) === chained) spawnInFlight.delete(taskId);
      }
    },

    getPostApprovalWorkerSession(taskId) {
      return taskAgentManager.getPostApprovalWorkerSession(taskId);
    },
  };
}

interface SpawnRoute {
  task: SpaceTask;
  workflow: SpaceWorkflow;
  route: PostApprovalRoute;
}

async function resolveSpawnRouteStage(
  taskId: string,
  agentName: string,
  taskRepo: Pick<SpaceTaskRepository, 'getTask'>,
  workflowRunRepo: SpaceWorkflowRunRepository,
  spaceWorkflowManager: SpaceWorkflowManager
): Promise<{ spawnRoute: SpawnRoute | undefined; routeHalt: string | undefined }> {
  const task = taskRepo.getTask(taskId);
  if (task === null || task.workflowRunId == null) {
    return { spawnRoute: undefined, routeHalt: 'task_not_routable' };
  }
  const run = workflowRunRepo.getRun(task.workflowRunId);
  if (run === null) return { spawnRoute: undefined, routeHalt: 'run_not_found' };
  const workflow = spaceWorkflowManager.getWorkflowForRun(run);
  if (workflow === null) return { spawnRoute: undefined, routeHalt: 'workflow_not_found' };
  const route = canonicalPostApprovalRouteForAgent(workflow, agentName);
  if (route === null) return { spawnRoute: undefined, routeHalt: 'route_mismatch' };
  return { spawnRoute: { task, workflow, route }, routeHalt: undefined };
}

async function buildKickoffStage(
  spawnRoute: SpawnRoute | undefined,
  spaceManager: Pick<SpaceManager, 'getSpace'> | undefined,
  artifactProfile: Pick<WorkflowArtifactProfile, 'resolveInitialPrimaryLinkUrl'> | undefined
): Promise<{ kickoffMessage: string | undefined; kickoffHalt: string | undefined }> {
  if (spawnRoute === undefined) return { kickoffMessage: undefined, kickoffHalt: undefined };
  const space =
    spaceManager === undefined
      ? null
      : ((await spaceManager.getSpace(spawnRoute.task.spaceId).catch(() => null)) as Space | null);
  const authorityNodeId =
    spawnRoute.task.postApprovalSourceNodeId ?? spawnRoute.workflow.endNodeId ?? null;
  const approvalAuthority =
    authorityNodeId !== null
      ? spawnRoute.workflow.nodes.find((node) => node.id === authorityNodeId)?.name
      : undefined;
  const { text } = interpolatePostApprovalTemplate(
    spawnRoute.route.instructions,
    postApprovalTemplateContextOf(spawnRoute.task, space, artifactProfile, approvalAuthority)
  );
  if (!text.trim()) return { kickoffMessage: undefined, kickoffHalt: 'empty_kickoff' };
  return {
    kickoffMessage: appendPostApprovalCompletionInstructions(text),
    kickoffHalt: undefined,
  };
}

async function spawnWorkerStage(
  spawnRoute: SpawnRoute | undefined,
  kickoffMessage: string | undefined,
  agentName: string,
  workflowNodeId: string | undefined,
  taskAgentManager: Pick<TaskAgentManager, 'spawnPostApprovalSubSession'>,
  taskId: string,
  taskRepo: Pick<SpaceTaskRepository, 'getTask'>
): Promise<{ sessionId: string | undefined; spawnHalt: string | undefined }> {
  if (spawnRoute === undefined || kickoffMessage === undefined) {
    return { sessionId: undefined, spawnHalt: undefined };
  }
  const current = taskRepo.getTask(taskId);
  if (
    current === null ||
    current.status !== 'approved' ||
    current.workflowRunId !== spawnRoute.task.workflowRunId
  ) {
    return { sessionId: undefined, spawnHalt: 'task_changed' };
  }
  try {
    const { sessionId } = await taskAgentManager.spawnPostApprovalSubSession({
      task: spawnRoute.task,
      workflow: spawnRoute.workflow,
      targetAgent: agentName,
      kickoffMessage,
      nodeId: workflowNodeId,
    });
    return { sessionId, spawnHalt: undefined };
  } catch {
    return { sessionId: undefined, spawnHalt: 'spawn_failed' };
  }
}

async function recordRoutedSessionStage(
  taskId: string,
  sessionId: string | undefined,
  taskRepo: Pick<SpaceTaskRepository, 'getTask' | 'updateTask'>,
  spawnRoute: SpawnRoute | undefined,
  internalEventBus: InternalEventBus<DaemonInternalEventMap> | undefined
): Promise<string | undefined> {
  if (sessionId === undefined || spawnRoute === undefined) return undefined;
  const current = taskRepo.getTask(taskId);
  if (
    current === null ||
    current.status !== 'approved' ||
    current.workflowRunId !== spawnRoute.task.workflowRunId
  ) {
    return undefined;
  }
  const updated =
    taskRepo.updateTask(taskId, {
      postApprovalSessionId: sessionId,
      postApprovalStartedAt: Date.now(),
      postApprovalBlockedReason: null,
    }) ?? current;
  try {
    await internalEventBus?.publish('space.task.updated', {
      sessionId: 'global',
      spaceId: updated.spaceId,
      taskId: updated.id,
      task: updated,
    });
  } catch {
    return sessionId;
  }
  return sessionId;
}

function canonicalPostApprovalRouteForAgent(
  workflow: SpaceWorkflow,
  agentName: string
): PostApprovalRoute | null {
  const route = collectDispatchablePostApprovalRoutes(workflow)[0] ?? null;
  return route !== null && route.targetAgent === agentName ? route : null;
}

function postApprovalTemplateContextOf(
  task: SpaceTask,
  space: Pick<Space, 'autonomyLevel' | 'workspacePath'> | null,
  artifactProfile: Pick<WorkflowArtifactProfile, 'resolveInitialPrimaryLinkUrl'> | undefined,
  approvalAuthority?: string
): PostApprovalTemplateContext {
  const context: Record<string, unknown> = {
    task_id: task.id,
    task_title: task.title,
    space_id: task.spaceId,
  };
  if (task.approvalSource != null) context.approval_source = task.approvalSource;
  const workspacePath = space !== null ? resolveTaskWorkspace(space, task) : task.workspacePath;
  if (workspacePath != null && workspacePath !== '') context.workspace_path = workspacePath;
  if (space?.autonomyLevel != null) context.autonomy_level = space.autonomyLevel;
  if (approvalAuthority !== undefined) context.approval_authority = approvalAuthority;
  const prUrl = task.workflowRunId
    ? artifactProfile?.resolveInitialPrimaryLinkUrl?.(task.workflowRunId)
    : undefined;
  if (prUrl) context.pr_url = prUrl;
  return context;
}
