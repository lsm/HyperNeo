import type { PostApprovalRoute, Space, SpaceTask, SpaceWorkflow } from '@hyperneo/shared';
import superpipe, { type PipelineAPI } from 'superpipe';
import type { NodeExecutionRepository } from '../../storage/repositories/node-execution-repository.ts';
import type { SpaceLongHorizonAgentRepository } from '../../storage/repositories/space-long-horizon-agent-repository.ts';
import type { SpaceTaskRepository } from '../../storage/repositories/space-task-repository.ts';
import type { SpaceWorkflowRunRepository } from '../../storage/repositories/space-workflow-run-repository.ts';
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
import type { TaskAgentManager } from '../space/runtime/task-agent-manager.ts';
import {
  interpolatePostApprovalTemplate,
  type PostApprovalTemplateContext,
} from '../space/workflows/post-approval-template.ts';
import { type SessionResolutionDeps, workerTaskPhaseOf } from './deps.ts';

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
  } = services;

  const runSpawnPostApprovalWorker = (
    superpipe({
      taskRepo,
      workflowRunRepo,
      spaceWorkflowManager,
      taskAgentManager,
      spaceManager,
      artifactProfile,
    })('spawn-post-approval-worker') as PipelineAPI
  )
    .input(['taskId', 'agentName', 'workflowNodeId'])
    .pipe(
      resolveSpawnRouteStage,
      ['taskId', 'agentName', 'taskRepo', 'workflowRunRepo', 'spaceWorkflowManager'],
      'result:spawnRoute'
    )
    .pipe(
      buildKickoffStage,
      ['spawnRoute', 'spaceManager', 'artifactProfile'],
      'result:kickoffMessage'
    )
    .pipe(
      spawnWorkerStage,
      ['spawnRoute', 'kickoffMessage', 'agentName', 'workflowNodeId', 'taskAgentManager'],
      'result:sessionId'
    )
    .pipe(recordRoutedSessionStage, ['taskId', 'sessionId', 'taskRepo'])
    .error(() => undefined, ['error'])
    .endAsync('sessionId') as (
    taskId: string,
    agentName: string,
    workflowNodeId?: string
  ) => Promise<string | undefined>;

  return {
    async getSession(sessionId) {
      const indexed = taskAgentManager.getSubSession(sessionId);
      if (indexed !== undefined && sessionManager.getCachedSession(sessionId) === indexed) {
        const data = indexed.getSessionData();
        if (data.status === 'ended') return null;
        if (isWorkflowSubSessionIdentity(sessionId) && !hasRuntimeNodeAgentServer(data.config)) {
          return null;
        }
        return indexed;
      }
      const session = await sessionManager.getSessionAsync(sessionId);
      if (session === null) return null;
      if (session.getSessionData().status === 'ended') return null;
      if (
        isWorkflowSubSessionIdentity(sessionId) &&
        !hasRuntimeNodeAgentServer(session.getSessionData().config)
      ) {
        return null;
      }
      return session;
    },

    async rehydrateSubSession(sessionId) {
      const restored = await taskAgentManager.rehydrateSubSessionById(sessionId);
      if (restored === null || restored.getSessionData().status === 'ended') return null;
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
      return (
        (await runSpawnPostApprovalWorker(taskId, agentName, workflowNodeId).catch(
          () => undefined
        )) ?? null
      );
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
): Promise<{ value: SpawnRoute } | { reason: string }> {
  const task = taskRepo.getTask(taskId);
  if (task === null || task.workflowRunId == null) return { reason: 'task_not_routable' };
  const run = workflowRunRepo.getRun(task.workflowRunId);
  if (run === null) return { reason: 'run_not_found' };
  const workflow = spaceWorkflowManager.getWorkflowForRun(run);
  if (workflow === null) return { reason: 'workflow_not_found' };
  const route = canonicalPostApprovalRouteForAgent(workflow, agentName);
  if (route === null) return { reason: 'route_mismatch' };
  return { value: { task, workflow, route } };
}

async function buildKickoffStage(
  spawnRoute: SpawnRoute,
  spaceManager: Pick<SpaceManager, 'getSpace'> | undefined,
  artifactProfile: Pick<WorkflowArtifactProfile, 'resolveInitialPrimaryLinkUrl'> | undefined
): Promise<{ value: string } | { reason: string }> {
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
  if (!text.trim()) return { reason: 'empty_kickoff' };
  return { value: appendPostApprovalCompletionInstructions(text) };
}

async function spawnWorkerStage(
  spawnRoute: SpawnRoute,
  kickoffMessage: string,
  agentName: string,
  workflowNodeId: string | undefined,
  taskAgentManager: Pick<TaskAgentManager, 'spawnPostApprovalSubSession'>
): Promise<{ value: string } | { reason: string }> {
  try {
    const { sessionId } = await taskAgentManager.spawnPostApprovalSubSession({
      task: spawnRoute.task,
      workflow: spawnRoute.workflow,
      targetAgent: agentName,
      kickoffMessage,
      nodeId: workflowNodeId,
    });
    return { value: sessionId };
  } catch {
    return { reason: 'spawn_failed' };
  }
}

function recordRoutedSessionStage(
  taskId: string,
  sessionId: string,
  taskRepo: Pick<SpaceTaskRepository, 'updateTask'>
): void {
  taskRepo.updateTask(taskId, {
    postApprovalSessionId: sessionId,
    postApprovalStartedAt: Date.now(),
    postApprovalBlockedReason: null,
  });
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
  const workspacePath = space?.workspacePath ?? task.workspacePath;
  if (workspacePath != null && workspacePath !== '') context.workspace_path = workspacePath;
  if (space?.autonomyLevel != null) context.autonomy_level = space.autonomyLevel;
  if (approvalAuthority !== undefined) context.approval_authority = approvalAuthority;
  const prUrl = task.workflowRunId
    ? artifactProfile?.resolveInitialPrimaryLinkUrl?.(task.workflowRunId)
    : undefined;
  if (prUrl) context.pr_url = prUrl;
  return context;
}
