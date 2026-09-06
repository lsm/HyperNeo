import { createHash } from 'node:crypto';
import type { MessageOrigin } from '@hyperneo/shared';
import type { SDKMessage, SDKUserMessage } from '@hyperneo/shared/sdk';
import superpipe, { type PipelineAPI } from 'superpipe';
import { withBusyRetry } from '../../storage/busy-retry.ts';
import type { Job } from '../../storage/repositories/job-queue-repository.ts';
import type { SDKMessageRepository } from '../../storage/repositories/sdk-message-repository.ts';
import { canonicalJson, normalizePromptForComparison } from '../agent/prompt-comparison.ts';
import { emitStructuredLogEvent } from '../logger.ts';
import { type MailboxEntry, parseMailboxEntry } from './entry.ts';

export interface MailboxFailureDeps {
  sdkMessageRepo: SDKMessageRepository;
  publishFailed?(sessionId: string, dbMessageId: string): Promise<void>;
  saveFailed(sessionId: string, message: SDKUserMessage, origin?: MessageOrigin): string;
  settleSkipped?(sessionId: string, messageUuid: string): Promise<void>;
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
  if (target === undefined || entry === null) return ctx;
  const synthetic = entry.origin !== 'chat';
  const message: SDKUserMessage = {
    ...entry.message,
    uuid: target.messageUuid as NonNullable<SDKUserMessage['uuid']>,
    session_id: target.sessionId,
    ...(synthetic ? { isSynthetic: true } : {}),
  };
  return { ...ctx, message };
}

function samePromptMessage(stored: SDKMessage, incoming: SDKUserMessage): boolean {
  return (
    canonicalJson(normalizePromptForComparison(stored)) ===
    canonicalJson(normalizePromptForComparison(incoming))
  );
}

export function persistFailedRowStage(ctx: MailboxFailureCtx): MailboxFailureCtx {
  const target = ctx.target;
  const message = ctx.message;
  const entry = ctx.entry;
  if (target === undefined || message === undefined || entry === null) return ctx;
  const synthetic = entry.origin !== 'chat';
  let ownershipKnown = false;
  try {
    const outcome = withBusyRetry((): { failedId?: string; uuidOwned: boolean } => {
      const siblings = ctx.deps.sdkMessageRepo.getStoredPromptsByUuid(
        target.sessionId,
        target.messageUuid
      );
      ownershipKnown = true;
      if (siblings.some((stored) => !samePromptMessage(stored, message))) {
        emitUuidConflictSkip(target, entry.id);
        return { uuidOwned: false };
      }
      const failedRow = ctx.deps.sdkMessageRepo.getMessageByStatusAndUuid?.(
        target.sessionId,
        'failed',
        target.messageUuid
      );
      const failedId =
        ctx.deps.sdkMessageRepo.markDeliveryFailedByUuid(target.sessionId, target.messageUuid) ??
        failedRow?.dbId ??
        (siblings.length === 0
          ? ctx.deps.saveFailed(target.sessionId, message, synthetic ? 'system' : undefined)
          : undefined);
      return { failedId, uuidOwned: true };
    });
    return { ...ctx, failedId: outcome.failedId, uuidOwned: outcome.uuidOwned };
  } catch (error) {
    emitMaterializeFailure(target, entry.id, error);
    return { ...ctx, uuidOwned: ownershipKnown };
  }
}

function detachFailureCallback(invoke: () => Promise<void> | undefined): void {
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
  .end('ctx') as (ctx: MailboxFailureCtx) => MailboxFailureCtx;

export function materializeMailboxFailure(job: Job, deps: MailboxFailureDeps): void {
  runMaterializeMailboxFailure({ job, deps, entry: null });
}

export function createMailboxDeadHandler(
  logError: (message: string) => void,
  deps?: MailboxFailureDeps
) {
  return (job: Job): void => {
    const rawId =
      typeof job.payload?.id === 'string' && job.payload.id.length > 0 ? job.payload.id : 'unknown';
    const entryId = parseMailboxEntry(job.payload)?.id ?? rawId;
    logError(`mailbox: entry ${entryId} dead-lettered: ${job.error ?? 'unknown error'}`);
    if (deps) materializeMailboxFailure(job, deps);
  };
}
