import type { SDKUserMessage } from '@hyperneo/shared/sdk';
import type { ExternalEventEssenceEntry } from '../external-events/deferred-event-digest.ts';
import type { ExternalEventDeliveryRecord, ExternalEventRecord } from '../external-events/types.ts';

export interface RenderPendingDigestTarget {
  workflowRunId: string;
  taskId: string;
  nodeId: string;
  agentName: string;
}

export interface RenderPendingDigestScope {
  workflowRunId: string;
  taskId?: string;
  nodeId: string;
  agentName: string;
}

export interface TurnEndExecutionRef {
  workflowRunId: string;
  workflowNodeId: string;
  agentName: string;
}

export type TurnEndDeliveryTerminalReason =
  | 'ttl_expired'
  | 'subscription_no_longer_active'
  | 'task_terminal';

export interface RenderPendingDigestLedgerMark {
  eventId: string;
  deliveryKey: string;
}

export interface RenderPendingDigestSavedDigest {
  dbId: string;
  replayed: boolean;
}

export interface RenderPendingDigestDeps {
  getExecutionByAgentSessionId(sessionId: string): TurnEndExecutionRef | null;
  listPendingDeliveries(scope: RenderPendingDigestScope): ExternalEventDeliveryRecord[];
  ownsCurrentExecution(target: RenderPendingDigestTarget, sessionId: string): boolean;
  isSessionInterruptInProgress(sessionId: string): boolean;
  isTaskAdmissible(taskId: string): boolean;
  isTaskTerminal(taskId: string): boolean;
  isSpacePaused(workflowRunId: string): boolean;
  listUserMessagesByUuidPrefix(
    sessionId: string,
    prefix: string
  ): Array<SDKUserMessage & { sendStatus?: string | null }>;
  getDeliveryContent(sessionId: string, uuid: string): unknown;
  isDeliveryInFlight(deliveryKey: string): boolean;
  acquireDeliveryClaims(deliveryKeys: string[]): void;
  releaseDeliveryClaims(deliveryKeys: string[]): void;
  now(): number;
  queueTtlMs: number;
  isTargetStillSubscribed(target: RenderPendingDigestTarget, topic: string): boolean;
  failDeliveryTerminal(
    target: RenderPendingDigestTarget,
    eventId: string,
    deliveryKey: string,
    reason: TurnEndDeliveryTerminalReason
  ): void;
  getEventById(eventId: string): ExternalEventRecord | null;
  saveDigestMessageIfAbsent(
    sessionId: string,
    message: SDKUserMessage
  ): Promise<RenderPendingDigestSavedDigest>;
  reopenFailedDigest(sessionId: string, uuid: string): void;
  deleteDigestMessage(sessionId: string, dbId: string): void;
  appendDigest(sessionId: string, message: SDKUserMessage): Promise<boolean>;
  markDeliveriesDelivered(
    target: RenderPendingDigestTarget,
    marks: RenderPendingDigestLedgerMark[]
  ): void;
  digestMessageByteCap?: number;
}

export interface RenderPendingDigestInput {
  sessionId: string;
  taskId?: string;
}

export type RenderPendingDigestSkipReason =
  | 'no_execution'
  | 'no_pending_events'
  | 'session_not_current'
  | 'session_interrupted'
  | 'task_not_admissible'
  | 'space_paused'
  | 'no_claimable_events'
  | 'no_renderable_events';

export interface RenderPendingDigestSkip {
  action: 'skip';
  reason: RenderPendingDigestSkipReason;
  heldDigestInFlight?: boolean;
}

export interface RenderPendingDigestHeld {
  action: 'held';
  reason: 'mailbox_rejected' | 'append_error';
  uuid: string;
  dbId: string;
  error?: unknown;
}

export interface RenderPendingDigestFailed {
  action: 'failed';
  stage: string;
  error: unknown;
}

export interface RenderPendingDigestDelivered {
  action: 'delivered';
  uuid: string;
  dbId: string;
  text: string;
  eventIds: string[];
  deliveryKeys: string[];
  replayed: boolean;
  taskId: string;
}

export type RenderPendingDigestOutcome =
  | RenderPendingDigestSkip
  | RenderPendingDigestHeld
  | RenderPendingDigestFailed
  | RenderPendingDigestDelivered;

export interface RenderPendingDigestCtx extends RenderPendingDigestInput {
  deps: RenderPendingDigestDeps;
  execution?: TurnEndExecutionRef;
  scopedRows?: ExternalEventDeliveryRecord[];
  target?: RenderPendingDigestTarget;
  consumedDurableEventIds?: Set<string>;
  replayDigestMessage?: SDKUserMessage;
  replayEventIds?: Set<string>;
  digestMembershipEventIds?: Set<string>;
  replayable?: boolean;
  pendingRows?: ExternalEventDeliveryRecord[];
  essences?: ExternalEventEssenceEntry[];
  digestText?: string;
  digestMessage?: SDKUserMessage;
  digestUuid?: string;
  digestDbId?: string;
  outcome?: RenderPendingDigestOutcome;
}

export const TURN_END_DIGEST_PENDING_ROW_CAP = 200;

export const TURN_END_DIGEST_SCAN_ROW_CAP = TURN_END_DIGEST_PENDING_ROW_CAP * 4;

const PROVIDER_REQUEST_BODY_LIMIT_BYTES = 10 * 1024 * 1024;

const DIGEST_ENVELOPE_ALLOWANCE_BYTES = 1024 * 1024;

export const TURN_END_DIGEST_MESSAGE_BYTE_CAP =
  PROVIDER_REQUEST_BODY_LIMIT_BYTES - DIGEST_ENVELOPE_ALLOWANCE_BYTES;
