import superpipe, { type PipelineAPI } from 'superpipe';
import type { PendingAgentMessageRecord } from '../../../storage/repositories/pending-agent-message-repository.ts';
import type { MailboxHandoffOutcome } from '../../mailbox/handoff.ts';
import type { EnsureSessionOutcome, SessionTarget } from '../../session-resolution/target.ts';

export interface PendingDrainHandoffDeps {
  ensureTargetSession(target: SessionTarget): Promise<EnsureSessionOutcome>;
  handoffToMailbox(args: {
    to: string;
    message: string;
    origin: string;
    messageUuid: string;
    deliveryMode?: 'immediate' | 'defer';
  }): Promise<MailboxHandoffOutcome>;
  markDelivered(id: string, sessionId: string): void;
  markFailed(id: string, error: string): void;
  markAttemptFailed(id: string, error: string): void;
  onDelivered?(row: PendingAgentMessageRecord, sessionId: string): void;
}

export interface PendingDrainHandoffInput {
  row: PendingAgentMessageRecord;
  target: SessionTarget;
  message: string;
  origin: string;
  deps: PendingDrainHandoffDeps;
}

export type PendingDrainHandoffOutcome =
  | { action: 'delivered'; sessionId: string }
  | { action: 'failed'; reason: string }
  | { action: 'retry'; reason: string }
  | { action: 'skipped'; reason: string };

export const pendingDrainMessageUuid = (row: {
  id: string;
  idempotencyKey: string | null;
}): string => row.idempotencyKey ?? row.id;

interface PendingDrainHandoffCtx extends PendingDrainHandoffInput {
  sessionId?: string;
  handoff?: MailboxHandoffOutcome;
  outcome?: PendingDrainHandoffOutcome;
}

function expiryStage(ctx: PendingDrainHandoffCtx): PendingDrainHandoffCtx {
  if (ctx.row.expiresAt > Date.now()) return ctx;
  return { ...ctx, outcome: { action: 'skipped', reason: 'expired' } };
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

async function handoffStage(ctx: PendingDrainHandoffCtx): Promise<PendingDrainHandoffCtx> {
  const handoff = await ctx.deps.handoffToMailbox({
    to: `session:${ctx.sessionId}`,
    message: ctx.message,
    origin: ctx.origin,
    messageUuid: pendingDrainMessageUuid(ctx.row),
    ...(ctx.row.deliveryMode ? { deliveryMode: ctx.row.deliveryMode } : {}),
  });
  return { ...ctx, handoff };
}

function settleStage(ctx: PendingDrainHandoffCtx): PendingDrainHandoffCtx {
  const handoff = ctx.handoff;
  const sessionId = ctx.sessionId;
  if (handoff && handoff.kind === 'enqueued' && sessionId !== undefined) {
    ctx.deps.markDelivered(ctx.row.id, sessionId);
    ctx.deps.onDelivered?.(ctx.row, sessionId);
    return { ...ctx, outcome: { action: 'delivered', sessionId } };
  }
  const reason =
    handoff?.kind === 'rejected'
      ? `mailbox handoff rejected: ${handoff.reason}`
      : 'mailbox handoff unsettled';
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
  .pipe(handoffStage, 'ctx', 'ctx')
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
