import type { NodeExecutionRepository } from '../../storage/repositories/node-execution-repository.ts';
import type { SpaceLongHorizonAgentRepository } from '../../storage/repositories/space-long-horizon-agent-repository.ts';
import type { SpaceTaskRepository } from '../../storage/repositories/space-task-repository.ts';
import {
  hasRuntimeNodeAgentServer,
  isWorkflowSubSessionIdentity,
} from '../session/sub-session-identity.ts';
import type { SessionManager } from '../session-manager.ts';
import type { SpaceRuntimeService } from '../space/runtime/space-runtime-service.ts';
import type { TaskAgentManager } from '../space/runtime/task-agent-manager.ts';
import { type SessionResolutionDeps, workerTaskPhaseOf } from './deps.ts';
import { resolveLiveSession, sessionUnavailable } from './session-lookup.ts';

export interface DefaultSessionResolutionServices {
  sessionManager: SessionManager;
  taskAgentManager?: TaskAgentManager;
  spaceRuntimeService: SpaceRuntimeService;
  nodeExecutionRepo: NodeExecutionRepository;
  taskRepo: SpaceTaskRepository;
  longHorizonAgentRepo: SpaceLongHorizonAgentRepository;
}

export function createDefaultSessionResolutionDeps(
  services: DefaultSessionResolutionServices
): SessionResolutionDeps {
  const { sessionManager, taskAgentManager, spaceRuntimeService, nodeExecutionRepo, taskRepo } =
    services;

  const requireTaskAgentManager = (): TaskAgentManager => {
    if (!taskAgentManager)
      throw new Error('TaskAgentManager unavailable for worker session resolution');
    return taskAgentManager;
  };

  return {
    getSession: (sessionId) => resolveLiveSession(sessionId, sessionManager, taskAgentManager),

    async rehydrateSubSession(sessionId) {
      const restored = await requireTaskAgentManager().rehydrateSubSessionById(sessionId);
      if (restored === null) return null;
      const data = restored.getSessionData();
      if (sessionUnavailable(data.status)) return null;
      if (isWorkflowSubSessionIdentity(sessionId) && !hasRuntimeNodeAgentServer(data.config)) {
        return null;
      }
      return restored;
    },

    async getCoordinator(spaceId) {
      return services.longHorizonAgentRepo.getCoordinator(spaceId);
    },

    ensureLongTermAgent(spaceId, agentId) {
      return spaceRuntimeService.ensureAgentSession(spaceId, agentId);
    },

    isAgentTargetLifecycleEligible(spaceId, agentId) {
      return spaceRuntimeService.isAgentTargetLifecycleEligible(spaceId, agentId);
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
          ? requireTaskAgentManager().getPostApprovalWorkerSession(taskId) !== null
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
      return requireTaskAgentManager().ensureWorkflowNodeActivationForAgent(
        target.taskId,
        target.agentName,
        {
          workflowNodeId: target.workflowNodeId,
          reopenReason: target.reopenReason,
          reopenBy: target.reopenBy,
        }
      );
    },

    async spawnPostApprovalWorker(taskId, agentName, workflowNodeId) {
      const spaceId = taskRepo.getTask(taskId)?.spaceId;
      if (spaceId === undefined) return null;
      const result = await spaceRuntimeService
        .retryPostApprovalDispatch(spaceId, taskId)
        .catch(() => null);
      if (result === null || !('postApprovalSessionId' in result)) return null;
      const recorded = requireTaskAgentManager().getPostApprovalWorkerSession(taskId);
      if (
        recorded === null ||
        recorded.sessionId !== result.postApprovalSessionId ||
        recorded.agentName !== agentName ||
        (workflowNodeId !== undefined && recorded.nodeId !== workflowNodeId)
      ) {
        return null;
      }
      return result.postApprovalSessionId;
    },

    getPostApprovalWorkerSession(taskId) {
      return requireTaskAgentManager().getPostApprovalWorkerSession(taskId);
    },
  };
}
