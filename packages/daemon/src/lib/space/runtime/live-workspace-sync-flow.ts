import type { NodeExecution, Space, SpaceTask } from '@hyperneo/shared';
import superpipe, { type PipelineAPI } from 'superpipe';
import type { AgentSession } from '../../agent/agent-session.ts';
import { resolveSpawnWorkspace, resolveTaskWorkspace } from '../../tasks/spawn-slot-resolution.ts';

export interface LiveWorkspaceSyncRequest {
  task: SpaceTask;
  space: Space;
  execution: NodeExecution;
  sessionId: string;
}

export interface LiveWorkspaceSyncMcpContext {
  taskId: string;
  subSessionId: string;
  agentName: string;
  spaceId: string;
  workflowRunId: string;
  workspacePath: string;
  workflowNodeId: string;
}

export interface LiveWorkspaceSyncFlowDeps {
  getTask(taskId: string): SpaceTask | null;
  getCachedTaskWorktreePath(taskId: string): string | undefined;
  readTerminalInjectionStatus(workflowRunId: string, taskId: string): string | null;
  getSubSession(sessionId: string): AgentSession | undefined;
  reinjectNodeAgentMcpServer(
    session: AgentSession,
    ctx: LiveWorkspaceSyncMcpContext
  ): Promise<void>;
}

export interface LiveWorkspaceSyncMigration extends LiveWorkspaceSyncMcpContext {
  kind: 'migrate';
  previousWorkspacePath: string | null;
}

export type LiveWorkspaceSyncSkip = { kind: 'skip'; message: string };
export type LiveWorkspaceSyncRejection = { kind: 'reject'; message: string };
export type LiveWorkspaceSyncStop = LiveWorkspaceSyncSkip | LiveWorkspaceSyncRejection;
export type LiveWorkspaceSyncOutcome = LiveWorkspaceSyncMigration | LiveWorkspaceSyncStop;

export interface LiveWorkspaceSyncTarget {
  task: SpaceTask;
  workspacePath: string | null;
}

export function resolveLiveWorkspaceSyncTarget(
  getTask: LiveWorkspaceSyncFlowDeps['getTask'],
  getCachedTaskWorktreePath: LiveWorkspaceSyncFlowDeps['getCachedTaskWorktreePath'],
  request: LiveWorkspaceSyncRequest
): LiveWorkspaceSyncTarget {
  const task = getTask(request.task.id) ?? request.task;
  const workspacePath = resolveSpawnWorkspace({
    cachedTaskWorktreePath: getCachedTaskWorktreePath(task.id),
    hasWorktreeManager: false,
    spaceWorkspacePath: resolveTaskWorkspace(request.space, task),
  }).workspacePath;
  return { task, workspacePath };
}

export function decideLiveWorkspaceSync(
  readTerminalInjectionStatus: LiveWorkspaceSyncFlowDeps['readTerminalInjectionStatus'],
  getSubSession: LiveWorkspaceSyncFlowDeps['getSubSession'],
  target: LiveWorkspaceSyncTarget,
  request: LiveWorkspaceSyncRequest
): { value: LiveWorkspaceSyncMigration } | { reason: LiveWorkspaceSyncStop } {
  const task = target.task;
  const terminalStatus = request.execution.workflowRunId
    ? readTerminalInjectionStatus(request.execution.workflowRunId, task.id)
    : null;
  if (terminalStatus) {
    return { reason: { kind: 'skip', message: `task/run is terminal (${terminalStatus})` } };
  }
  const live = getSubSession(request.sessionId);
  if (!live) {
    return { reason: { kind: 'skip', message: 'session is no longer live' } };
  }
  if (task.spaceId !== request.space.id) {
    return {
      reason: {
        kind: 'reject',
        message: `Task ${task.id} moved to space ${task.spaceId}; refusing to sync live session ${request.sessionId} for space ${request.space.id}`,
      },
    };
  }
  if (task.workflowRunId !== request.execution.workflowRunId) {
    return {
      reason: {
        kind: 'reject',
        message: `Task ${task.id} is no longer attached to workflow run ${request.execution.workflowRunId} (now ${task.workflowRunId ?? 'detached'}); refusing to reuse its live session ${request.sessionId}`,
      },
    };
  }
  if (!target.workspacePath) {
    return { reason: { kind: 'skip', message: 'no workspace resolved' } };
  }
  if (live.getSessionData().workspacePath === target.workspacePath) {
    return { reason: { kind: 'skip', message: 'workspace already matches' } };
  }
  return {
    value: {
      kind: 'migrate',
      taskId: task.id,
      subSessionId: request.sessionId,
      agentName: request.execution.agentName,
      spaceId: request.space.id,
      workflowRunId: request.execution.workflowRunId,
      workspacePath: target.workspacePath,
      workflowNodeId: request.execution.workflowNodeId,
      previousWorkspacePath: live.getSessionData().workspacePath ?? null,
    },
  };
}

export async function migrateLiveWorkspaceSession(
  getSubSession: LiveWorkspaceSyncFlowDeps['getSubSession'],
  reinjectNodeAgentMcpServer: LiveWorkspaceSyncFlowDeps['reinjectNodeAgentMcpServer'],
  migration: LiveWorkspaceSyncMigration
): Promise<LiveWorkspaceSyncMigration> {
  const live = getSubSession(migration.subSessionId);
  if (!live) return migration;
  live.updateMetadata({ workspacePath: migration.workspacePath });
  try {
    await reinjectNodeAgentMcpServer(live, migration);
  } catch (error) {
    if (migration.previousWorkspacePath !== null) {
      live.updateMetadata({ workspacePath: migration.previousWorkspacePath });
    }
    throw error;
  }
  return migration;
}

export function runLiveWorkspaceSyncFlow(
  deps: LiveWorkspaceSyncFlowDeps,
  request: LiveWorkspaceSyncRequest
): Promise<LiveWorkspaceSyncOutcome> {
  const run = (
    superpipe({
      tasks: deps.getTask,
      cachedWorktrees: deps.getCachedTaskWorktreePath,
      terminalStatus: deps.readTerminalInjectionStatus,
      subSessions: deps.getSubSession,
      reinjectMcp: deps.reinjectNodeAgentMcpServer,
    })('sync-live-session-workspace') as PipelineAPI
  )
    .input('request')
    .pipe(resolveLiveWorkspaceSyncTarget, ['tasks', 'cachedWorktrees', 'request'], 'target')
    .pipe(
      decideLiveWorkspaceSync,
      ['terminalStatus', 'subSessions', 'target', 'request'],
      'result:sync'
    )
    .pipe(migrateLiveWorkspaceSession, ['subSessions', 'reinjectMcp', 'sync'], 'sync')
    .endAsync('sync') as (request: LiveWorkspaceSyncRequest) => Promise<LiveWorkspaceSyncOutcome>;
  return run(request);
}
