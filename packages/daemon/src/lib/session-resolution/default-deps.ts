import type { PostApprovalRoute, SpaceTask, SpaceWorkflow } from '@hyperneo/shared';
import type { NodeExecutionRepository } from '../../storage/repositories/node-execution-repository.ts';
import type { SpaceLongHorizonAgentRepository } from '../../storage/repositories/space-long-horizon-agent-repository.ts';
import type { SpaceTaskRepository } from '../../storage/repositories/space-task-repository.ts';
import type { SpaceWorkflowRunRepository } from '../../storage/repositories/space-workflow-run-repository.ts';
import {
  hasRuntimeNodeAgentServer,
  isWorkflowSubSessionIdentity,
} from '../session/sub-session-identity.ts';
import type { SessionManager } from '../session-manager.ts';
import type { SpaceWorkflowManager } from '../space/managers/space-workflow-manager.ts';
import { appendPostApprovalCompletionInstructions } from '../space/runtime/post-approval-router.ts';
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
  } = services;

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

    rehydrateSubSession(sessionId) {
      return taskAgentManager.rehydrateSubSessionById(sessionId);
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
      try {
        const task = taskRepo.getTask(taskId);
        if (task === null || task.workflowRunId == null) return null;
        const run = workflowRunRepo.getRun(task.workflowRunId);
        if (run === null) return null;
        const workflow = spaceWorkflowManager.getWorkflowForRun(run);
        if (workflow === null) return null;
        const route = findPostApprovalRouteForAgent(workflow, agentName, workflowNodeId);
        if (route === null) return null;
        const { text } = interpolatePostApprovalTemplate(
          route.instructions,
          postApprovalTemplateContextOf(task)
        );
        if (!text.trim()) return null;
        const { sessionId } = await taskAgentManager.spawnPostApprovalSubSession({
          task,
          workflow,
          targetAgent: agentName,
          kickoffMessage: appendPostApprovalCompletionInstructions(text),
          nodeId: workflowNodeId,
        });
        taskRepo.updateTask(taskId, {
          postApprovalSessionId: sessionId,
          postApprovalStartedAt: Date.now(),
          postApprovalBlockedReason: null,
        });
        return sessionId;
      } catch {
        return null;
      }
    },

    getPostApprovalWorkerSession(taskId) {
      return taskAgentManager.getPostApprovalWorkerSession(taskId);
    },
  };
}

function findPostApprovalRouteForAgent(
  workflow: SpaceWorkflow,
  agentName: string,
  workflowNodeId?: string
): PostApprovalRoute | null {
  for (const node of workflow.nodes) {
    if (workflowNodeId !== undefined && node.id !== workflowNodeId) continue;
    if (node.postApproval?.targetAgent === agentName) return node.postApproval;
  }
  return workflow.postApproval?.targetAgent === agentName ? workflow.postApproval : null;
}

function postApprovalTemplateContextOf(task: SpaceTask): PostApprovalTemplateContext {
  const context: Record<string, unknown> = {
    task_id: task.id,
    task_title: task.title,
    space_id: task.spaceId,
  };
  if (task.approvalSource != null) context.approval_source = task.approvalSource;
  if (task.workspacePath != null) context.workspace_path = task.workspacePath;
  return context;
}
