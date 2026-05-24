export type ActorProjectionKind = 'human' | 'agent' | 'worker' | 'system' | 'github';

export type ActorMessageDeliveryState = 'queued' | 'delivered' | 'failed' | 'expired' | 'skipped';

export type ActorMessageProjectionScope = 'task_timeline' | 'workflow_log';

export type ActorMessageProjectionEventKind =
  | 'message'
  | 'decision'
  | 'question'
  | 'answer'
  | 'artifact'
  | 'status'
  | 'handoff'
  | 'gate'
  | 'retry'
  | 'ci'
  | 'system'
  | 'github';

export interface ActorProjectionRef {
  kind: ActorProjectionKind;
  label: string;
  role?: string | null;
  sessionId?: string | null;
  nodeExecutionId?: string | null;
}

export interface ActorMessageProjectionRow {
  id: string;
  scope: ActorMessageProjectionScope;
  eventKind: ActorMessageProjectionEventKind;
  taskId?: string | null;
  taskTitle?: string | null;
  workflowRunId?: string | null;
  messageId?: string | null;
  eventRef?: string | null;
  from: ActorProjectionRef;
  target?: ActorProjectionRef | null;
  targetResolution?: 'direct' | 'inferred' | 'queued' | 'external' | 'system' | null;
  deliveryState?: ActorMessageDeliveryState | null;
  title: string;
  summary: string;
  details?: string | null;
  severity?: 'info' | 'success' | 'warning' | 'error' | null;
  createdAt: number;
}
