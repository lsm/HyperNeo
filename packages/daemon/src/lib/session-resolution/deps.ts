import type { SpaceTaskStatus } from '@hyperneo/shared';
import type { SessionTargetWorker } from './target.ts';

export interface WorkerExecutionSession {
  sessionId: string | null;
  status: string;
}

export type WorkerTaskPhase =
  | 'run_active'
  | 'done'
  | 'routing'
  | 'post_approval'
  | 'post_approval_done'
  | 'terminal';

export function workerTaskPhaseOf(
  status: SpaceTaskStatus,
  postApprovalSessionId: string | null,
  hasDurablePostApprovalWorker = false,
  postApprovalBlockedReason: string | null = null
): WorkerTaskPhase {
  if (status === 'cancelled' || status === 'archived' || status === 'stopped') {
    return 'terminal';
  }
  if (status === 'approved') {
    return postApprovalSessionId || postApprovalBlockedReason !== null
      ? 'post_approval'
      : 'routing';
  }
  if (status === 'done') {
    return postApprovalSessionId || hasDurablePostApprovalWorker ? 'post_approval_done' : 'done';
  }
  return 'run_active';
}

export interface SessionResolutionDeps {
  getSession(sessionId: string): Promise<unknown | null>;
  rehydrateSubSession(sessionId: string): Promise<unknown | null>;
  getCoordinator(spaceId: string): Promise<{ id: string } | null>;
  ensureLongTermAgent(spaceId: string, agentId: string): Promise<unknown | null>;
  listWorkerExecutions(target: SessionTargetWorker): WorkerExecutionSession[];
  readWorkerTaskPhase(taskId: string): WorkerTaskPhase;
  getTaskSpaceId(taskId: string): Promise<string | null>;
  activateTaskAgent(target: SessionTargetWorker): Promise<boolean>;
  spawnPostApprovalWorker(
    taskId: string,
    agentName: string,
    workflowNodeId?: string
  ): Promise<string | null>;
  getPostApprovalWorkerSession(taskId: string): {
    sessionId: string;
    agentName: string;
    nodeId?: string | null;
  } | null;
}
