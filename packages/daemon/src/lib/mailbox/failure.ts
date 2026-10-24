import { fillPrompt, MAILBOX_DELIVERY_FAILED } from '@hyperneo/prompts';
import { createHash } from 'node:crypto';
import type { MessageOrigin } from '@hyperneo/shared';
import type { SDKMessage, SDKUserMessage } from '@hyperneo/shared/sdk';
import superpipe, { type PipelineAPI } from 'superpipe';
import { withBusyRetry } from '../../storage/busy-retry.ts';
import type { Job, JobQueueRepository } from '../../storage/repositories/job-queue-repository.ts';
import type { SDKMessageRepository } from '../../storage/repositories/sdk-message-repository.ts';
import { canonicalJson, normalizePromptForComparison } from '../agent/prompt-comparison.ts';
import { emitStructuredLogEvent } from '../logger.ts';
import { projectAdmissionMessage, type SessionMailboxEntry } from './admission-plan.ts';
import { parseAddress, renderAddress } from './address.ts';
import { handoffPromptToMailbox } from './handoff.ts';
import { mailboxMessageIsSynthetic, type MailboxEntry, parseMailboxEntry } from './entry.ts';

export interface MailboxFailureDeps {
  sdkMessageRepo: SDKMessageRepository;
  publishFailed?(sessionId: string, dbMessageId: string): Promise<void>;
  saveFailed(sessionId: string, message: SDKUserMessage, origin?: MessageOrigin): Promise<string>;
  settleSkipped?(sessionId: string, messageUuid: string): Promise<void>;
  notifySender?(senderSessionId: string, notice: MailboxFailureNotice): Promise<unknown>;
}

export interface MailboxFailureNotice {
  targetSessionId: string;
  messageUuid: string;
  reason: string;
}

export interface SessionFailureTarget {
  sessionId: string;
  messageUuid: string;
}

export interface MailboxFailureCtx {
  job: Job;
  deps: MailboxFailureDeps;
  entry: MailboxEntry | null;
  target?: SessionFailureTarget;
  message?: SDKUserMessage;
  failedId?: string;
  uuidOwned?: boolean;
}

function emitMaterializeFailure(
  target: SessionFailureTarget,
  entryId: string,
  error: unknown
): void {
  try {
    emitStructuredLogEvent({
      level: 'error',
      args: ['mailbox.materialize_failed'],
      source: 'logger',
      module: 'hyperneo:daemon:mailbox:materialize-failure',
      metadata: {
        entryId,
        sessionId: target.sessionId,
        messageUuid: target.messageUuid,
        error: error instanceof Error ? error.message : String(error),
      },
    });
  } catch {}
}

function emitUuidConflictSkip(target: SessionFailureTarget, entryId: string): void {
  try {
    emitStructuredLogEvent({
      level: 'warn',
      args: ['mailbox.materialize_failure_uuid_conflict'],
      source: 'logger',
      module: 'hyperneo:daemon:mailbox:materialize-failure',
      metadata: {
        entryId,
        sessionId: target.sessionId,
        messageUuid: target.messageUuid,
      },
    });
  } catch {}
}

export function deterministicMailboxUuid(entryId: string): string {
  const digest = createHash('sha256').update(entryId).digest('hex');
  return `mbox-${digest.slice(0, 8)}-${digest.slice(8, 12)}-${digest.slice(12, 16)}-${digest.slice(16, 20)}-${digest.slice(20, 32)}`;
}

export function sessionFailureTarget(entry: MailboxEntry | null): SessionFailureTarget | null {
  if (entry?.to.kind !== 'session') return null;
  return {
    sessionId: entry.to.sessionId,
    messageUuid: entry.messageUuid ?? deterministicMailboxUuid(entry.id),
  };
}

export function parseFailureEntryStage(ctx: MailboxFailureCtx): MailboxFailureCtx {
  const entry = parseMailboxEntry(ctx.job.payload);
  return { ...ctx, entry, target: sessionFailureTarget(entry) ?? undefined };
}

function isSkippedMailboxFailure(ctx: MailboxFailureCtx): boolean {
  return ctx.target === undefined;
}

export function buildFailureMessageStage(ctx: MailboxFailureCtx): MailboxFailureCtx {
  const target = ctx.target;
  const entry = ctx.entry;
  if (target === undefined || entry === null || entry.to.kind !== 'session') return ctx;
  const synthetic = mailboxMessageIsSynthetic(entry.origin, entry.message);
  const message = projectAdmissionMessage(entry as SessionMailboxEntry, synthetic);
  return { ...ctx, message };
}

function samePromptMessage(stored: SDKMessage, incoming: SDKUserMessage): boolean {
  return (
    canonicalJson(normalizePromptForComparison(stored)) ===
    canonicalJson(normalizePromptForComparison(incoming))
  );
}

type MailboxFailureRowOutcome = { failedId?: string; uuidOwned: boolean; save?: true };

export function persistExistingMailboxFailure(
  repository: SDKMessageRepository,
  target: SessionFailureTarget,
  message: SDKUserMessage,
  entryId: string,
  onOwnershipKnown?: () => void
): MailboxFailureRowOutcome {
  return withBusyRetry(() => {
    const siblings = repository.getStoredPromptsByUuid(target.sessionId, target.messageUuid);
    onOwnershipKnown?.();
    if (siblings.some((stored) => !samePromptMessage(stored, message))) {
      emitUuidConflictSkip(target, entryId);
      return { uuidOwned: false };
    }
    const failedRow = repository.getMessageByStatusAndUuid?.(
      target.sessionId,
      'failed',
      target.messageUuid
    );
    const failedId =
      repository.markDeliveryFailedByUuid(target.sessionId, target.messageUuid) ?? failedRow?.dbId;
    return failedId === undefined && siblings.length === 0
      ? { uuidOwned: true, save: true }
      : { failedId, uuidOwned: true };
  });
}

export async function persistFailedRowStage(ctx: MailboxFailureCtx): Promise<MailboxFailureCtx> {
  const target = ctx.target;
  const message = ctx.message;
  const entry = ctx.entry;
  if (target === undefined || message === undefined || entry === null) return ctx;
  const synthetic = mailboxMessageIsSynthetic(entry.origin, entry.message);
  let ownershipKnown = false;
  try {
    const outcome = persistExistingMailboxFailure(
      ctx.deps.sdkMessageRepo,
      target,
      message,
      entry.id,
      () => {
        ownershipKnown = true;
      }
    );
    const failedId = outcome.save
      ? await ctx.deps.saveFailed(target.sessionId, message, synthetic ? 'system' : undefined)
      : outcome.failedId;
    return { ...ctx, failedId, uuidOwned: outcome.uuidOwned };
  } catch (error) {
    emitMaterializeFailure(target, entry.id, error);
    return { ...ctx, uuidOwned: ownershipKnown };
  }
}

function detachFailureCallback(invoke: () => Promise<unknown> | undefined): void {
  try {
    void Promise.resolve(invoke()).catch(() => {});
  } catch {}
}

export function notifyFailureObserversStage(ctx: MailboxFailureCtx): MailboxFailureCtx {
  const target = ctx.target;
  const failedId = ctx.failedId;
  if (target === undefined) return ctx;
  if (failedId !== undefined) {
    detachFailureCallback(() => ctx.deps.publishFailed?.(target.sessionId, failedId));
  }
  if (ctx.uuidOwned !== false) {
    detachFailureCallback(() => ctx.deps.settleSkipped?.(target.sessionId, target.messageUuid));
  }
  return ctx;
}

export function renderMailboxFailureNotice(notice: MailboxFailureNotice): string {
  return fillPrompt(MAILBOX_DELIVERY_FAILED, {
    message_uuid: notice.messageUuid,
    target_session_id: notice.targetSessionId,
    reason: notice.reason,
  });
}

export function createMailboxSenderNotifier(
  jobQueue: JobQueueRepository
): NonNullable<MailboxFailureDeps['notifySender']> {
  return (senderSessionId, notice) =>
    handoffPromptToMailbox({
      to: renderAddress({ kind: 'session', sessionId: senderSessionId }),
      message: {
        type: 'user',
        message: { content: renderMailboxFailureNotice(notice) },
        parent_tool_use_id: null,
        inputKind: 'system',
      },
      origin: 'system',
      jobQueue,
    });
}

export function selectFailureSender(entry: MailboxEntry | null): string | null {
  if (!entry || entry.to.kind !== 'session') return null;
  const origin = parseAddress(entry.origin);
  return origin?.kind === 'session' && origin.sessionId !== entry.to.sessionId
    ? origin.sessionId
    : null;
}

export function notifyFailureSenderStage(ctx: MailboxFailureCtx): MailboxFailureCtx {
  const sender = selectFailureSender(ctx.entry);
  const target = ctx.target;
  if (!sender || !target || ctx.uuidOwned === false) return ctx;
  detachFailureCallback(() =>
    ctx.deps.notifySender?.(sender, {
      targetSessionId: target.sessionId,
      messageUuid: target.messageUuid,
      reason: ctx.job.error ?? 'delivery failed',
    })
  );
  return ctx;
}

const runMaterializeMailboxFailure = (
  superpipe<{ isSkippedMailboxFailure: (ctx: MailboxFailureCtx) => boolean }>({
    isSkippedMailboxFailure,
  })('materialize-mailbox-failure') as PipelineAPI
)
  .input(['ctx'])
  .pipe(parseFailureEntryStage, 'ctx', 'ctx')
  .pipe('!isSkippedMailboxFailure', 'ctx')
  .pipe(buildFailureMessageStage, 'ctx', 'ctx')
  .pipe(persistFailedRowStage, 'ctx', 'ctx')
  .pipe(notifyFailureObserversStage, 'ctx', 'ctx')
  .pipe(notifyFailureSenderStage, 'ctx', 'ctx')
  .endAsync('ctx') as (ctx: MailboxFailureCtx) => Promise<MailboxFailureCtx>;

export async function materializeMailboxFailure(job: Job, deps: MailboxFailureDeps): Promise<void> {
  await runMaterializeMailboxFailure({ job, deps, entry: null });
}

export function createMailboxDeadHandler(
  logError: (message: string) => void,
  deps?: MailboxFailureDeps
) {
  return (job: Job): void => {
    const rawId =
      typeof job.payload?.id === 'string' && job.payload.id.length > 0 ? job.payload.id : 'unknown';
    const entry = parseMailboxEntry(job.payload);
    const entryId = entry?.id ?? rawId;
    const target = sessionFailureTarget(entry);
    logError(
      `mailbox: entry ${entryId} session ${target?.sessionId ?? 'unknown'} dead-lettered: ${job.error ?? 'unknown error'}`
    );
    if (deps) void materializeMailboxFailure(job, deps);
  };
}
