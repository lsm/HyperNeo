import type { SessionTargetWorker } from './target.ts';

export interface WorkerExecutionSession {
  sessionId: string | null;
  status: string;
}

export interface SessionResolutionDeps {
  getSession(sessionId: string): Promise<unknown | null>;
  rehydrateSubSession(sessionId: string): Promise<unknown | null>;
  getCoordinator(spaceId: string): Promise<{ id: string } | null>;
  ensureLongTermAgent(spaceId: string, agentId: string): Promise<unknown | null>;
  listWorkerExecutions(target: SessionTargetWorker): WorkerExecutionSession[];
  isTaskDoneOrApproved(taskId: string): boolean;
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
