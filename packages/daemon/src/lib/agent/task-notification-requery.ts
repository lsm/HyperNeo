import { getSdkResultOriginKind, type SDKMessage } from '@hyperneo/shared/sdk';
import type { SpaceWorkflowRunNeedsAttentionEvent } from '../internal-event-bus';
import { isHollowTaskNotificationResult } from '../space/runtime/last-message-classifier';

export const TASK_NOTIFICATION_REQUERY_MAX_ATTEMPTS = 5;

const DEFAULT_TASK_NOTIFICATION_REQUERY_BASE_DELAY_MS = 500;
const TASK_NOTIFICATION_REQUERY_DELAY_CAP_MS = 8000;

export function taskNotificationRequeryDelayMs(attempt: number): number {
  if (attempt <= 0) return 0;
  const raw = Number.parseInt(
    process.env.HYPERNEO_TASK_NOTIFICATION_REQUERY_BASE_DELAY_MS ?? '',
    10
  );
  const base =
    Number.isFinite(raw) && raw >= 0 ? raw : DEFAULT_TASK_NOTIFICATION_REQUERY_BASE_DELAY_MS;
  if (base === 0) return 0;
  return Math.min(base * 2 ** (attempt - 1), TASK_NOTIFICATION_REQUERY_DELAY_CAP_MS);
}

export const TASK_NOTIFICATION_REQUERY_CONTINUE_MESSAGE =
  '[Runtime continue] A completed background task notification is pending consumption by the ' +
  'model. Continue your current work.';

export type TaskNotificationRequeryDecision =
  | { action: 'requery'; delayMs: number }
  | { action: 'escalate' }
  | { action: 'hold' }
  | { action: 'reset' };

export function isTopLevelHollowTaskNotificationResult(message: SDKMessage): boolean {
  if (message.type !== 'result') return false;
  const parentToolUseId = (message as SDKMessage & { parent_tool_use_id?: string | null })
    .parent_tool_use_id;
  if (parentToolUseId !== null && parentToolUseId !== undefined) return false;
  if (getSdkResultOriginKind(message) !== 'task-notification') return false;
  return isHollowTaskNotificationResult(message);
}

export function resolveTaskNotificationRequery(args: {
  message: SDKMessage;
  attempts: number;
  exhausted: boolean;
  followUpQueued: boolean;
}): TaskNotificationRequeryDecision {
  if (args.message.type !== 'result') return { action: 'hold' };
  const parentToolUseId = (args.message as SDKMessage & { parent_tool_use_id?: string | null })
    .parent_tool_use_id;
  if (parentToolUseId !== null && parentToolUseId !== undefined) return { action: 'hold' };
  if (!isTopLevelHollowTaskNotificationResult(args.message)) return { action: 'reset' };
  if (args.followUpQueued) return { action: 'hold' };
  if (args.exhausted) return { action: 'hold' };
  if (args.attempts >= TASK_NOTIFICATION_REQUERY_MAX_ATTEMPTS) return { action: 'escalate' };
  return { action: 'requery', delayMs: taskNotificationRequeryDelayMs(args.attempts) };
}

export function buildTaskNotificationRequeryEscalationEvent(args: {
  sessionId: string;
  spaceId?: string | undefined;
  taskId?: string | undefined;
  workflowRunId?: string | undefined;
  attempts: number;
  timestamp: string;
}): SpaceWorkflowRunNeedsAttentionEvent | null {
  if (!args.spaceId || !args.taskId || !args.workflowRunId) return null;
  return {
    sessionId: args.sessionId,
    spaceId: args.spaceId,
    runId: args.workflowRunId,
    taskId: args.taskId,
    reason:
      `Session ended on ${args.attempts} consecutive hollow ` +
      'task-notification results without a consumed follow-up turn; immediate re-query budget ' +
      'exhausted; the runtime idle-watch backstop now owns recovery',
    retriesExhausted: args.attempts,
    timestamp: args.timestamp,
  };
}
