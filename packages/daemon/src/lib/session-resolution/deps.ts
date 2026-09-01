import type { SessionTargetWorker } from './target.ts';

export interface WorkerExecutionSession {
  sessionId: string | null;
  status: string;
}

export interface SessionResolutionDeps {
  getSession(sessionId: string): Promise<unknown | null>;
  rehydrateSubSession(sessionId: string): Promise<unknown | null>;
  ensureLongTermAgent(spaceId: string, agentId: string): Promise<unknown | null>;
  listWorkerExecutions(target: SessionTargetWorker): WorkerExecutionSession[];
  activateTaskAgent(target: SessionTargetWorker): Promise<boolean>;
  spawnPostApprovalWorker(taskId: string, agentName: string): Promise<string | null>;
}
