import { AGENT_TASK_NOTIFICATION_CONTINUE } from '@hyperneo/prompts';
import { getSdkResultOriginKind, type SDKMessage } from '@hyperneo/shared/sdk';
import type { SpaceWorkflowRunNeedsAttentionEvent } from '../internal-event-bus.ts';
import { isHollowTaskNotificationResult } from '../session/last-message-classifier.ts';

export const TASK_NOTIFICATION_REQUERY_MAX_ATTEMPTS = 5;

const DEFAULT_TASK_NOTIFICATION_REQUERY_BASE_DELAY_MS = 500;
const TASK_NOTIFICATION_REQUERY_DELAY_CAP_MS = 8000;

export function taskNotificationRequeryDelayMs(attempt: number): number {
  const raw = Number.parseInt(
    process.env.HYPERNEO_TASK_NOTIFICATION_REQUERY_BASE_DELAY_MS ?? '',
    10
  );
  const base =
    Number.isFinite(raw) && raw >= 0 ? raw : DEFAULT_TASK_NOTIFICATION_REQUERY_BASE_DELAY_MS;
  if (base === 0) return 0;
  return Math.min(base * 2 ** (Math.max(1, attempt) - 1), TASK_NOTIFICATION_REQUERY_DELAY_CAP_MS);
}

export const TASK_NOTIFICATION_REQUERY_CONTINUE_MESSAGE = AGENT_TASK_NOTIFICATION_CONTINUE;

export type TaskNotificationRequeryDecision =
  | { action: 'requery'; delayMs: number }
  | { action: 'escalate' }
  | { action: 'hold' }
  | { action: 'reset' }
  | { action: 'issue' };

export type TaskNotificationRequeryEpisode = NonNullable<
  import('@hyperneo/shared').Session['metadata']['taskNotificationRequeryEpisode']
>;

export type TaskNotificationRequerySignal =
  | { kind: 'result'; message: SDKMessage }
  | { kind: 'attempt-issued' }
  | { kind: 'attempt-failed' }
  | { kind: 'delivery-failed' }
  | { kind: 'close' };

function startTaskNotificationRequeryEpisode(
  prior: TaskNotificationRequeryEpisode | null | undefined
): TaskNotificationRequeryEpisode {
  return { episode: (prior?.episode ?? 0) + 1, attempts: 0, escalation: 'none', closed: false };
}

function openTaskNotificationRequeryEpisode(
  prior: TaskNotificationRequeryEpisode | null | undefined
): TaskNotificationRequeryEpisode {
  if (prior && !prior.closed) return prior;
  return startTaskNotificationRequeryEpisode(prior);
}

export function advanceTaskNotificationRequeryEpisode(
  prior: TaskNotificationRequeryEpisode | null | undefined,
  signal: TaskNotificationRequerySignal,
  opts: { followUpQueued?: boolean } = {}
): { episode: TaskNotificationRequeryEpisode; decision: TaskNotificationRequeryDecision } {
  const episode = openTaskNotificationRequeryEpisode(prior);
  if (signal.kind === 'close') {
    return {
      episode: prior?.closed ? prior : { ...episode, closed: true },
      decision: { action: 'reset' },
    };
  }
  if (
    prior?.closed &&
    (signal.kind === 'attempt-issued' ||
      signal.kind === 'attempt-failed' ||
      signal.kind === 'delivery-failed')
  ) {
    return { episode: prior, decision: { action: 'hold' } };
  }
  if (signal.kind === 'delivery-failed') {
    if (episode.escalation !== 'none') return { episode, decision: { action: 'hold' } };
    if (episode.attempts >= TASK_NOTIFICATION_REQUERY_MAX_ATTEMPTS) {
      return {
        episode: { ...episode, escalation: 'pending' },
        decision: { action: 'escalate' },
      };
    }
    return {
      episode,
      decision: { action: 'requery', delayMs: taskNotificationRequeryDelayMs(episode.attempts) },
    };
  }
  if (signal.kind === 'attempt-failed') {
    const attempts = episode.attempts + 1;
    const next = { ...episode, attempts };
    if (episode.escalation !== 'none') return { episode: next, decision: { action: 'hold' } };
    if (attempts >= TASK_NOTIFICATION_REQUERY_MAX_ATTEMPTS) {
      return {
        episode: { ...next, escalation: 'pending' },
        decision: { action: 'escalate' },
      };
    }
    return {
      episode: next,
      decision: { action: 'requery', delayMs: taskNotificationRequeryDelayMs(attempts) },
    };
  }
  if (signal.kind === 'attempt-issued') {
    if (episode.escalation !== 'none') return { episode, decision: { action: 'hold' } };
    if (episode.attempts >= TASK_NOTIFICATION_REQUERY_MAX_ATTEMPTS) {
      return {
        episode: { ...episode, escalation: 'pending' },
        decision: { action: 'escalate' },
      };
    }
    const attempts = episode.attempts + 1;
    return { episode: { ...episode, attempts }, decision: { action: 'issue' } };
  }
  const { message } = signal;
  if (message.type !== 'result') return { episode, decision: { action: 'hold' } };
  const parentToolUseId = (message as SDKMessage & { parent_tool_use_id?: string | null })
    .parent_tool_use_id;
  if (parentToolUseId !== null && parentToolUseId !== undefined) {
    return { episode, decision: { action: 'hold' } };
  }
  if (!isTopLevelHollowTaskNotificationResult(message)) {
    const isError = (message as SDKMessage & { is_error?: unknown }).is_error === true;
    if (!isError || prior == null || prior.closed || prior.attempts <= 0) {
      return { episode: { ...episode, closed: true }, decision: { action: 'reset' } };
    }
  }
  if (opts.followUpQueued || episode.escalation !== 'none') {
    return { episode, decision: { action: 'hold' } };
  }
  if (episode.attempts >= TASK_NOTIFICATION_REQUERY_MAX_ATTEMPTS) {
    return {
      episode: { ...episode, escalation: 'pending' },
      decision: { action: 'escalate' },
    };
  }
  return {
    episode,
    decision: { action: 'requery', delayMs: taskNotificationRequeryDelayMs(episode.attempts) },
  };
}

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
  const prior: TaskNotificationRequeryEpisode = {
    episode: 1,
    attempts: args.attempts,
    escalation: args.exhausted ? 'done' : 'none',
    closed: false,
  };
  const { decision } = advanceTaskNotificationRequeryEpisode(
    args.attempts <= 0 && !args.exhausted ? null : prior,
    { kind: 'result', message: args.message },
    { followUpQueued: args.followUpQueued }
  );
  if (decision.action === 'issue') return { action: 'requery', delayMs: 0 };
  return decision;
}

export function buildTaskNotificationRequeryEscalationEvent(args: {
  sessionId: string;
  spaceId?: string | undefined;
  taskId?: string | undefined;
  workflowRunId?: string | undefined;
  attempts: number;
  episode?: number;
  timestamp: string;
}): SpaceWorkflowRunNeedsAttentionEvent | null {
  if (!args.spaceId || !args.taskId || !args.workflowRunId) return null;
  return {
    sessionId: args.sessionId,
    spaceId: args.spaceId,
    runId: args.workflowRunId,
    taskId: args.taskId,
    ...(args.episode !== undefined ? { episode: args.episode } : {}),
    reason:
      `Session ended on ${args.attempts} consecutive hollow ` +
      'task-notification results without a consumed follow-up turn; immediate re-query budget ' +
      'exhausted; the runtime idle-watch backstop now owns recovery',
    retriesExhausted: args.attempts,
    timestamp: args.timestamp,
  };
}
