import type {
  NodeExecution,
  Space,
  SpaceTask,
  SpaceWorkflow,
  SpaceWorkflowRun,
  WorkflowNode,
  WorkflowNodeAgent,
} from '@hyperneo/shared';
import type { WorkflowNodeSlotResolution } from './spawn-slot-resolution.ts';

export interface IndexedSessionInspection {
  sessionId: string | null;
  alive: boolean;
}

export interface SpawnSessionRequest {
  task: SpaceTask;
  space: Space;
  workflow: SpaceWorkflow;
  workflowRun: SpaceWorkflowRun;
  execution: NodeExecution;
  node: WorkflowNode;
  slot: WorkflowNodeAgent;
  sessionId: string;
  workspacePath: string;
  kickoff: boolean;
}

export interface AttachNodeAgentRequest {
  task: SpaceTask;
  space: Space;
  workflowRun: SpaceWorkflowRun;
  execution: NodeExecution;
  sessionId: string;
  workspacePath: string;
}

export interface KickoffMessageRequest {
  task: SpaceTask;
  space: Space;
  workflow: SpaceWorkflow;
  workflowRun: SpaceWorkflowRun;
  execution: NodeExecution;
  node: WorkflowNode;
  slot: WorkflowNodeAgent;
  sessionId: string;
  workspacePath: string;
}

export interface SpawnExecutionFlowDeps {
  getFreshTask(taskId: string): SpaceTask | null;
  getNodeExecution(executionId: string): NodeExecution | null;
  isSpawningExecution(executionId: string): boolean;
  inspectIndexedSession(agentSessionId: string | null): IndexedSessionInspection;
  resolveSlot(
    space: Space,
    workflow: SpaceWorkflow,
    execution: NodeExecution,
    task: SpaceTask
  ): WorkflowNodeSlotResolution | null;
  reserveExecution(executionId: string): void;
  releaseExecution(executionId: string): void;
  reserveTaskSpawn(taskId: string): 'won' | 'superseded';
  releaseTaskSpawn(taskId: string): void;
  cancelSpawnedSession(sessionId: string): void;
  rebindLiveExecution(execution: NodeExecution, sessionId: string): 'won' | 'superseded';
  syncReuseLiveWorkspace?(
    task: SpaceTask,
    space: Space,
    execution: NodeExecution,
    sessionId: string
  ): void | Promise<void>;
  revertLiveExecutionRebind?(execution: NodeExecution, sessionId: string): void;
  raiseSpawnRejection(
    freshTask: SpaceTask,
    execution: NodeExecution,
    workflow: SpaceWorkflow
  ): never;
  resolveSpawnSessionId(space: Space, task: SpaceTask, execution: NodeExecution): string;
  resolveWorkspacePath(task: SpaceTask, space: Space): Promise<string>;
  createSpawnedSession(request: SpawnSessionRequest): Promise<string>;
  bindExecutionToSession(execution: NodeExecution, sessionId: string): 'won' | 'superseded';
  attachNodeAgent(request: AttachNodeAgentRequest): Promise<void>;
  registerSpawnCompletionCallback(taskId: string, workflowNodeId: string, sessionId: string): void;
  buildKickoffMessage(request: KickoffMessageRequest): Promise<string>;
  injectKickoffMessage(sessionId: string, message: string, executionId: string): Promise<void>;
  activateSpawnedSessionPoolAssignment(executionId: string, sessionId: string): void;
}

export interface SpawnExecutionFlowInput {
  task: SpaceTask;
  space: Space;
  workflow: SpaceWorkflow;
  workflowRun: SpaceWorkflowRun;
  execution: NodeExecution;
  kickoff: boolean;
}
