import type { SDKUserMessage } from '@hyperneo/shared/sdk';
import superpipe, { type PipelineAPI } from 'superpipe';
import { Logger } from '../../logger.ts';
import {
  MESSAGE_DELIVERY_PARK_MS,
  signalDeliveryConsumed,
  waitForDeliveryConsumption,
  withSessionLock,
  type MessageDeliveryOrigin,
} from '../../agent/message-delivery.ts';
import {
  PromptContentConflictError,
  verifyPromptContent,
} from '../../agent/message-delivery-outbox.ts';
import { createMailboxEntry, type MailboxEntry } from '../../mailbox/entry.ts';
import { enqueueMailboxEntry, MAILBOX_LANE } from '../../mailbox/enqueue.ts';
import type { MailboxHandoffOutcome } from '../../mailbox/handoff.ts';
import type { JobQueueRepository } from '../../../storage/repositories/job-queue-repository.ts';
import type { SDKMessageRepository } from '../../../storage/repositories/sdk-message-repository.ts';
import type { Database as BunDatabase } from '../../../storage/sqlite-compat.ts';

const log = new Logger('space-agent-delivery');

export interface LateSettlementRequest {
  sessionId: string;
  messageId: string;
  onConsumed: (settledSessionId: string) => void;
  onFailed?: () => void;
  getSendStatus?: () => string | null | undefined;
}

export interface SpaceAgentLateSettlementHandle {
  cancel(): void;
}

export interface SpaceAgentLateSettlementOwner {
  arm(request: LateSettlementRequest): SpaceAgentLateSettlementHandle;
}

export const LATE_SETTLE_HORIZON_MS = 12 * 60_000;

export class SpaceAgentLateSettlements implements SpaceAgentLateSettlementOwner {
  private readonly timers = new Set<ReturnType<typeof setTimeout>>();
  private readonly waiters = new Map<
    string,
    { handle: SpaceAgentLateSettlementHandle; release: () => void }
  >();
  private disposed = false;

  arm({
    sessionId,
    messageId,
    onConsumed,
    onFailed,
    getSendStatus,
  }: LateSettlementRequest): SpaceAgentLateSettlementHandle {
    const key = `${sessionId}\u0000${messageId}`;
    this.waiters.get(key)?.release();
    if (this.disposed) return { cancel: () => {} };
    const late = waitForDeliveryConsumption(sessionId, messageId);
    let fired = false;
    let expiry: ReturnType<typeof setTimeout> | undefined;
    let statusPoll: ReturnType<typeof setInterval> | undefined;

    const release = (): void => {
      if (statusPoll) {
        clearInterval(statusPoll);
        statusPoll = undefined;
      }
      clearTimeout(expiry);
      this.timers.delete(expiry!);
      if (this.waiters.get(key)?.handle === handle) this.waiters.delete(key);
      late.cancel();
    };

    const settle = (outcome: 'consumed' | 'failed'): void => {
      if (fired) return;
      fired = true;
      release();
      try {
        if (outcome === 'consumed') {
          onConsumed(sessionId);
        } else {
          onFailed?.();
        }
      } catch (error) {
        log.warn(
          `late settlement ${outcome} failed for ${sessionId}/${messageId}: ` +
            `${error instanceof Error ? error.message : String(error)}`
        );
      }
    };

    const handle: SpaceAgentLateSettlementHandle = {
      cancel: () => {
        if (fired) return;
        fired = true;
        release();
      },
    };

    this.timers.add(
      (expiry = setTimeout(() => {
        settle('failed');
      }, LATE_SETTLE_HORIZON_MS))
    );
    this.waiters.set(key, { handle, release });

    void late.promise.then(() => settle('consumed'));

    if (getSendStatus) {
      const check = () => {
        try {
          const status = getSendStatus();
          if (status === 'consumed') {
            signalDeliveryConsumed(sessionId, messageId);
          } else if (status === 'failed') {
            settle('failed');
          }
        } catch {
          settle('failed');
        }
      };
      statusPoll = setInterval(check, MESSAGE_DELIVERY_PARK_MS);
      check();
    }

    return handle;
  }
  dispose(): void {
    this.disposed = true;
    for (const timer of this.timers) clearTimeout(timer);
    this.timers.clear();
    for (const [, watcher] of this.waiters) {
      watcher.handle.cancel();
    }
    this.waiters.clear();
  }
}

export type SpaceAgentInjectionOutcome =
  | { state: 'accepted'; messageId: string; sessionId: string }
  | { state: 'failed'; messageId: string; sessionId: string; error: string };

export interface SpaceAgentDeliveryDeps {
  db: BunDatabase;
  sdkMessageRepo: SDKMessageRepository;
  jobQueue: JobQueueRepository;
  publishStatusChanged(sessionId: string, dbId: string, status: 'failed'): Promise<void>;
  stateManager?: { setQueuedIfIdle(messageId: string): Promise<boolean> };
  onConsumed?: (settledSessionId: string) => void;
  onLateFailure?: () => void;
  lateSettlement?: SpaceAgentLateSettlementOwner;
}

export interface SpaceAgentDeliveryInput {
  sessionId: string;
  messageId: string;
  sdkUserMessage: SDKUserMessage;
  origin?: MessageDeliveryOrigin;
}

interface SpaceAgentDeliveryCtx extends SpaceAgentDeliveryInput {
  deps: SpaceAgentDeliveryDeps;
  existing?: { sendStatus: string } | null;
  handoff?: SpaceAgentMailboxAdmission;
  outcome?: SpaceAgentInjectionOutcome;
}

function loadExistingRow(ctx: SpaceAgentDeliveryCtx): SpaceAgentDeliveryCtx {
  return {
    ...ctx,
    existing: ctx.deps.sdkMessageRepo.getDeliveryContent(ctx.sessionId, ctx.messageId),
  };
}

function notifyConsumed(ctx: SpaceAgentDeliveryCtx): void {
  if (!ctx.deps.onConsumed) return;
  try {
    ctx.deps.onConsumed(ctx.sessionId);
  } catch (error) {
    log.warn(
      `consumed notification failed for ${ctx.sessionId}/${ctx.messageId}: ` +
        `${error instanceof Error ? error.message : String(error)}`
    );
  }
}

function hasSettledDeliveryRow(
  sdkMessageRepo: SDKMessageRepository,
  sessionId: string,
  messageId: string
): boolean {
  if (sdkMessageRepo.hasConsumptionEvidence(sessionId, messageId)) return true;
  return sdkMessageRepo.getSettledDeliveryMessageId(sessionId, messageId) !== null;
}

function shortCircuitConsumed(ctx: SpaceAgentDeliveryCtx): SpaceAgentDeliveryCtx {
  if (!hasSettledDeliveryRow(ctx.deps.sdkMessageRepo, ctx.sessionId, ctx.messageId)) return ctx;
  verifyPromptContent({
    db: ctx.deps.db,
    sessionId: ctx.sessionId,
    messageUuid: ctx.messageId,
    message: ctx.sdkUserMessage,
  });
  notifyConsumed(ctx);
  return {
    ...ctx,
    outcome: { state: 'accepted', messageId: ctx.messageId, sessionId: ctx.sessionId },
  };
}

function projectMailboxPrompt(ctx: SpaceAgentDeliveryCtx) {
  return {
    type: 'user' as const,
    parent_tool_use_id: null,
    message: { role: 'user' as const, content: ctx.sdkUserMessage.message.content },
    ...(ctx.sdkUserMessage.priority !== undefined ? { priority: ctx.sdkUserMessage.priority } : {}),
  };
}

type PendingAdmissionMessage = {
  message?: { role?: unknown; content?: unknown };
  priority?: unknown;
  inputKind?: unknown;
  referenceMetadata?: unknown;
};

function admissionIdentity(value: PendingAdmissionMessage | undefined): string {
  return JSON.stringify([
    value?.message?.role ?? null,
    value?.message?.content ?? null,
    value?.priority ?? null,
    value?.inputKind ?? null,
    value?.referenceMetadata ?? null,
  ]);
}

function listSessionMailboxAdmissions(
  jobQueue: JobQueueRepository,
  sessionId: string,
  messageUuid: string
) {
  return jobQueue.listActiveByPayload(MAILBOX_LANE, { messageUuid }).filter((job) => {
    const to = (job.payload as { to?: { kind?: string; sessionId?: string } })?.to;
    return to?.kind === 'session' && to?.sessionId === sessionId;
  });
}

function assertNoConflictingPendingAdmission(ctx: SpaceAgentDeliveryCtx): void {
  const ours = admissionIdentity(projectMailboxPrompt(ctx));
  for (const job of listSessionMailboxAdmissions(ctx.deps.jobQueue, ctx.sessionId, ctx.messageId)) {
    const entry = job.payload as { message?: PendingAdmissionMessage };
    if (admissionIdentity(entry.message) !== ours) {
      throw new PromptContentConflictError(
        `prompt handoff: message ${ctx.messageId} in session ${ctx.sessionId} ` +
          'is already pending in the mailbox with a different prompt'
      );
    }
  }
}

type SpaceAgentMailboxAdmission = MailboxHandoffOutcome | { kind: 'settled' };

function admitMailboxPrompt(ctx: SpaceAgentDeliveryCtx): SpaceAgentMailboxAdmission {
  let entry: MailboxEntry;
  try {
    entry = createMailboxEntry({
      to: { kind: 'session', sessionId: ctx.sessionId },
      message: projectMailboxPrompt(ctx),
      origin: ctx.origin ?? 'space_agent',
      messageUuid: ctx.messageId,
    });
  } catch (error) {
    if (!(error instanceof TypeError)) throw error;
    return { kind: 'rejected', reason: error.message };
  }
  const admit = ctx.deps.db.transaction(() => {
    verifyPromptContent({
      db: ctx.deps.db,
      sessionId: ctx.sessionId,
      messageUuid: ctx.messageId,
      message: ctx.sdkUserMessage,
    });
    if (hasSettledDeliveryRow(ctx.deps.sdkMessageRepo, ctx.sessionId, ctx.messageId)) {
      return { kind: 'settled' } as const;
    }
    assertNoConflictingPendingAdmission(ctx);
    return enqueueMailboxEntry(ctx.deps.jobQueue, entry);
  }, 'immediate');
  return admit();
}

async function enqueuePrompt(ctx: SpaceAgentDeliveryCtx): Promise<SpaceAgentDeliveryCtx> {
  const handoff = await withSessionLock(ctx.sessionId, async () => admitMailboxPrompt(ctx));
  return { ...ctx, handoff };
}

async function markQueuedIfIdle(ctx: SpaceAgentDeliveryCtx): Promise<void> {
  const stateManager = ctx.deps.stateManager;
  if (!stateManager) return;
  if (hasSettledDeliveryRow(ctx.deps.sdkMessageRepo, ctx.sessionId, ctx.messageId)) return;
  const pending =
    ctx.deps.jobQueue.activeMailboxMessageUuids(ctx.sessionId).has(ctx.messageId) ||
    ctx.deps.jobQueue.activeDeliveryMessageUuids(ctx.sessionId).has(ctx.messageId);
  if (!pending) return;
  try {
    await stateManager.setQueuedIfIdle(ctx.messageId);
  } catch {}
}

async function acceptOutcome(ctx: SpaceAgentDeliveryCtx): Promise<SpaceAgentDeliveryCtx> {
  const { sessionId, messageId } = ctx;
  const handoff = ctx.handoff ?? null;
  if (handoff === null || handoff.kind === 'rejected') {
    return {
      ...ctx,
      outcome: {
        state: 'failed',
        messageId,
        sessionId,
        error: handoff === null ? 'mailbox handoff ended without an outcome' : handoff.reason,
      },
    };
  }
  if (handoff.kind === 'settled') {
    notifyConsumed(ctx);
    return { ...ctx, outcome: { state: 'accepted', messageId, sessionId } };
  }
  await markQueuedIfIdle(ctx);
  if (ctx.deps.onConsumed && ctx.deps.lateSettlement) {
    const retryingFailedRow = ctx.existing?.sendStatus === 'failed';
    ctx.deps.lateSettlement.arm({
      sessionId,
      messageId,
      onConsumed: ctx.deps.onConsumed,
      onFailed: ctx.deps.onLateFailure,
      getSendStatus: () => {
        const status = ctx.deps.sdkMessageRepo.getDeliveryContent(sessionId, messageId)?.sendStatus;
        if (status !== 'failed' || !retryingFailedRow) return status;
        const inFlight =
          listSessionMailboxAdmissions(ctx.deps.jobQueue, sessionId, messageId).length > 0 ||
          ctx.deps.jobQueue.activeDeliveryMessageUuids(sessionId).has(messageId);
        return inFlight ? undefined : status;
      },
    });
  }
  return { ...ctx, outcome: { state: 'accepted', messageId, sessionId } };
}

async function failDelivery(ctx: SpaceAgentDeliveryCtx, error: unknown): Promise<void> {
  if (error instanceof PromptContentConflictError) return;
  const failedDbId = ctx.deps.sdkMessageRepo.markDeliveryFailedByUuid(ctx.sessionId, ctx.messageId);
  if (failedDbId) {
    await ctx.deps.publishStatusChanged(ctx.sessionId, failedDbId, 'failed').catch(() => {});
  }
}

function hasOutcome(ctx: SpaceAgentDeliveryCtx): boolean {
  return ctx.outcome !== undefined;
}

const run = (
  superpipe<{ hasOutcome: (ctx: SpaceAgentDeliveryCtx) => boolean }>({
    hasOutcome,
  })('space-agent-delivery') as PipelineAPI
)
  .input(['ctx'])
  .pipe(loadExistingRow, 'ctx', 'ctx')
  .pipe(shortCircuitConsumed, 'ctx', 'ctx')
  .pipe('!hasOutcome', 'ctx')
  .pipe(enqueuePrompt, 'ctx', 'ctx')
  .pipe(acceptOutcome, 'ctx', 'ctx')
  .error(failDelivery, ['ctx', 'error'])
  .endAsync('ctx') as (input: SpaceAgentDeliveryCtx) => Promise<SpaceAgentDeliveryCtx>;

export async function deliverSpaceAgentMessage(
  deps: SpaceAgentDeliveryDeps,
  args: SpaceAgentDeliveryInput
): Promise<SpaceAgentInjectionOutcome> {
  const ctx = await run({ ...args, deps });
  return (
    ctx.outcome ?? {
      state: 'failed',
      messageId: args.messageId,
      sessionId: args.sessionId,
      error: 'space-agent delivery ended without an outcome',
    }
  );
}
