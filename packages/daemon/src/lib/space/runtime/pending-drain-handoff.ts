import superpipe, { type PipelineAPI } from 'superpipe';
import type { PendingAgentMessageRecord } from '../../../storage/repositories/pending-agent-message-repository.ts';
import type { MessageDeliveryOrigin } from '../../agent/message-delivery.ts';
import type { AgentMessageDeliveryOutcome } from './agent-message-router.ts';
import type { EnsureSessionOutcome, SessionTarget } from '../../session-resolution/target.ts';

export interface PendingDrainRoutedDeliveryArgs {
  target: SessionTarget;
  message: string;
  messageId: string;
  inputKind: 'human' | 'task';
  origin: MessageDeliveryOrigin;
  deliveryMode?: 'immediate' | 'defer';
}

export interface PendingDrainHandoffDeps {
  ensureTargetSession(target: SessionTarget): Promise<EnsureSessionOutcome>;
  deliverRoutedMessage(args: PendingDrainRoutedDeliveryArgs): Promise<AgentMessageDeliveryOutcome>;
  markDelivered(id: string, sessionId: string): void;
  markFailed(id: string, error: string): void;
  markAttemptFailed(id: string, error: string): void;
  onDelivered?(row: PendingAgentMessageRecord, sessionId: string): void;
}

export interface PendingDrainHandoffInput {
  row: PendingAgentMessageRecord;
  target: SessionTarget;
  message: string;
  origin: MessageDeliveryOrigin;
  deps: PendingDrainHandoffDeps;
}

export type PendingDrainHandoffOutcome =
  | { action: 'delivered'; sessionId: string }
  | { action: 'failed'; reason: string }
  | { action: 'retry'; reason: string }
  | { action: 'skipped'; reason: string };

export const pendingDrainMessageUuid = (row: { id: string }): string => row.id;

interface PendingDrainHandoffCtx extends PendingDrainHandoffInput {
  sessionId?: string;
  delivery?: AgentMessageDeliveryOutcome;
  outcome?: PendingDrainHandoffOutcome;
}

function expiryStage(ctx: PendingDrainHandoffCtx): PendingDrainHandoffCtx {
  if (ctx.row.expiresAt > Date.now()) return ctx;
  const reason = 'expired before drain admission';
  ctx.deps.markFailed(ctx.row.id, reason);
  return { ...ctx, outcome: { action: 'failed', reason } };
}

function budgetStage(ctx: PendingDrainHandoffCtx): PendingDrainHandoffCtx {
  if (ctx.row.attempts < ctx.row.maxAttempts) return ctx;
  const reason = `delivery attempts exhausted (${ctx.row.maxAttempts})`;
  ctx.deps.markFailed(ctx.row.id, reason);
  return { ...ctx, outcome: { action: 'failed', reason } };
}

async function resolveStage(ctx: PendingDrainHandoffCtx): Promise<PendingDrainHandoffCtx> {
  const resolved = await ctx.deps.ensureTargetSession(ctx.target);
  if (resolved.kind === 'resolved') return { ...ctx, sessionId: resolved.sessionId };
  const reason = `session resolution: ${resolved.reason}`;
  ctx.deps.markAttemptFailed(ctx.row.id, reason);
  return { ...ctx, outcome: { action: 'retry', reason } };
}

function postResolveExpiryStage(ctx: PendingDrainHandoffCtx): PendingDrainHandoffCtx {
  if (ctx.row.expiresAt > Date.now()) return ctx;
  const reason = 'expired during session resolution';
  ctx.deps.markFailed(ctx.row.id, reason);
  return { ...ctx, outcome: { action: 'failed', reason } };
}

async function deliverStage(ctx: PendingDrainHandoffCtx): Promise<PendingDrainHandoffCtx> {
  const delivery = await ctx.deps.deliverRoutedMessage({
    target: ctx.target,
    message: ctx.message,
    messageId: pendingDrainMessageUuid(ctx.row),
    inputKind: ctx.row.sourceAgentName === 'human' ? 'human' : 'task',
    origin: ctx.origin,
    ...(ctx.row.deliveryMode ? { deliveryMode: ctx.row.deliveryMode } : {}),
  });
  return { ...ctx, delivery };
}

function settleStage(ctx: PendingDrainHandoffCtx): PendingDrainHandoffCtx {
  const delivery = ctx.delivery;
  if (delivery && (delivery.state === 'delivered' || delivery.state === 'queued')) {
    if (ctx.row.expiresAt <= Date.now()) {
      const reason = 'expired during routed delivery';
      ctx.deps.markFailed(ctx.row.id, reason);
      return { ...ctx, outcome: { action: 'failed', reason } };
    }
    const sessionId = delivery.state === 'delivered' ? delivery.sessionId : (ctx.sessionId ?? '');
    ctx.deps.markDelivered(ctx.row.id, sessionId);
    ctx.deps.onDelivered?.(ctx.row, sessionId);
    return { ...ctx, outcome: { action: 'delivered', sessionId } };
  }
  const detail = delivery
    ? `${delivery.state}: ${delivery.error ?? 'unavailable'}`
    : 'routed delivery unsettled';
  const reason = `routed delivery ${detail}`;
  ctx.deps.markAttemptFailed(ctx.row.id, reason);
  return { ...ctx, outcome: { action: 'retry', reason } };
}

const settled = (ctx: PendingDrainHandoffCtx): boolean => ctx.outcome !== undefined;

const runDrainPendingRowOntoMailbox = (
  superpipe<{ settled: (ctx: PendingDrainHandoffCtx) => boolean }>({ settled })(
    'drain-pending-row-onto-mailbox'
  ) as PipelineAPI
)
  .input(['ctx'])
  .pipe(expiryStage, 'ctx', 'ctx')
  .pipe('!settled', 'ctx')
  .pipe(budgetStage, 'ctx', 'ctx')
  .pipe('!settled', 'ctx')
  .pipe(resolveStage, 'ctx', 'ctx')
  .pipe('!settled', 'ctx')
  .pipe(postResolveExpiryStage, 'ctx', 'ctx')
  .pipe('!settled', 'ctx')
  .pipe(deliverStage, 'ctx', 'ctx')
  .pipe(settleStage, 'ctx', 'ctx')
  .endAsync('ctx') as (input: PendingDrainHandoffInput) => Promise<PendingDrainHandoffCtx>;

export async function drainPendingRowOntoMailbox(
  input: PendingDrainHandoffInput
): Promise<PendingDrainHandoffOutcome> {
  try {
    const ctx = await runDrainPendingRowOntoMailbox(input);
    return ctx.outcome ?? { action: 'skipped', reason: 'unsettled' };
  } catch (error) {
    const reason = `internal: ${error instanceof Error ? error.message : String(error)}`;
    try {
      input.deps.markAttemptFailed(input.row.id, reason);
    } catch {}
    return { action: 'retry', reason };
  }
}
