import type { NodeExecution, SpaceTask } from '@hyperneo/shared';
import superpipe, { type PipelineAPI } from 'superpipe';
import type { AgentSession } from '../../agent/agent-session.ts';
import { explicitTaskWorkspace, resolveSpawnWorkspace } from '../../tasks/spawn-slot-resolution.ts';

export interface SelfHealWorkspaceMcpContext {
  taskId: string;
  subSessionId: string;
  agentName: string;
  spaceId: string;
  workflowRunId: string;
  workspacePath: string;
  workflowNodeId: string;
}

export interface SelfHealWorkspaceRequest {
  ownerTask: SpaceTask;
  agentSession: AgentSession;
  execution: NodeExecution;
  sessionId: string;
  spaceWorkspacePath: string;
}

export interface SelfHealWorkspaceFlowDeps {
  getTask(taskId: string): SpaceTask | null;
  getCachedTaskWorktreePath(taskId: string): string | undefined;
  reinjectNodeAgentMcpServer(
    session: AgentSession,
    ctx: SelfHealWorkspaceMcpContext
  ): Promise<void>;
  ensureRequiredMcpServersAttached(
    session: AgentSession,
    ctx: SelfHealWorkspaceMcpContext & { phase: 'rehydrate' | 'spawn' }
  ): Promise<void>;
}

export interface SelfHealWorkspacePlan {
  task: SpaceTask;
  workspacePath: string | null;
  previousWorkspacePath: string | null | undefined;
  mcpContext: SelfHealWorkspaceMcpContext;
}

export function resolveSelfHealWorkspaceTarget(
  getTask: SelfHealWorkspaceFlowDeps['getTask'],
  getCachedTaskWorktreePath: SelfHealWorkspaceFlowDeps['getCachedTaskWorktreePath'],
  request: SelfHealWorkspaceRequest
): SelfHealWorkspacePlan {
  const task = getTask(request.ownerTask.id) ?? request.ownerTask;
  if (task.workflowRunId !== request.execution.workflowRunId) {
    throw new Error(
      `Task ${task.id} no longer belongs to workflow run ${request.execution.workflowRunId} (now ${task.workflowRunId ?? 'detached'}); refusing to self-heal session ${request.sessionId}`
    );
  }
  const workspacePath = resolveSpawnWorkspace({
    cachedTaskWorktreePath:
      getCachedTaskWorktreePath(task.id) ??
      explicitTaskWorkspace(task) ??
      request.agentSession.getSessionData().workspacePath ??
      undefined,
    hasWorktreeManager: false,
    spaceWorkspacePath: request.spaceWorkspacePath,
  }).workspacePath;
  return {
    task,
    workspacePath,
    previousWorkspacePath: request.agentSession.getSessionData().workspacePath,
    mcpContext: {
      taskId: task.id,
      subSessionId: request.sessionId,
      agentName: request.execution.agentName,
      spaceId: task.spaceId,
      workflowRunId: request.execution.workflowRunId,
      workspacePath: workspacePath ?? '',
      workflowNodeId: request.execution.workflowNodeId,
    },
  };
}

export async function healWorkspaceSession(
  reinjectNodeAgentMcpServer: SelfHealWorkspaceFlowDeps['reinjectNodeAgentMcpServer'],
  ensureRequiredMcpServersAttached: SelfHealWorkspaceFlowDeps['ensureRequiredMcpServersAttached'],
  request: SelfHealWorkspaceRequest,
  plan: SelfHealWorkspacePlan
): Promise<SelfHealWorkspacePlan> {
  const session = request.agentSession;
  if (plan.workspacePath && session.getSessionData().workspacePath !== plan.workspacePath) {
    session.updateMetadata({ workspacePath: plan.workspacePath });
    try {
      await reinjectNodeAgentMcpServer(session, plan.mcpContext);
    } catch (error) {
      if (plan.previousWorkspacePath !== undefined) {
        session.updateMetadata({ workspacePath: plan.previousWorkspacePath });
      }
      throw error;
    }
  }
  await ensureRequiredMcpServersAttached(session, {
    ...plan.mcpContext,
    phase: 'rehydrate',
  });
  return plan;
}

export function runSelfHealWorkspaceFlow(
  deps: SelfHealWorkspaceFlowDeps,
  request: SelfHealWorkspaceRequest
): Promise<SelfHealWorkspacePlan> {
  const run = (
    superpipe({
      tasks: deps.getTask,
      cachedWorktrees: deps.getCachedTaskWorktreePath,
      reinjectMcp: deps.reinjectNodeAgentMcpServer,
      ensureMcp: deps.ensureRequiredMcpServersAttached,
    })('self-heal-workspace') as PipelineAPI
  )
    .input('request')
    .pipe(resolveSelfHealWorkspaceTarget, ['tasks', 'cachedWorktrees', 'request'], 'heal')
    .pipe(healWorkspaceSession, ['reinjectMcp', 'ensureMcp', 'request', 'heal'], 'heal')
    .endAsync('heal') as (request: SelfHealWorkspaceRequest) => Promise<SelfHealWorkspacePlan>;
  return run(request);
}
