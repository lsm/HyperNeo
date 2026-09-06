import type { MessageOrigin } from '@hyperneo/shared';
import type { SDKUserMessage } from '@hyperneo/shared/sdk';
import superpipe, { type PipelineAPI } from 'superpipe';
import { withBusyRetry } from '../../storage/busy-retry.ts';
import type { Job } from '../../storage/repositories/job-queue-repository.ts';
import type { SDKMessageRepository } from '../../storage/repositories/sdk-message-repository.ts';
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

export function sessionFailureTarget(entry: MailboxEntry | null): SessionFailureTarget | null {
  if (entry?.to.kind !== 'session' || entry.messageUuid === undefined) return null;
  return { sessionId: entry.to.sessionId, messageUuid: entry.messageUuid };
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

export function persistFailedRowStage(ctx: MailboxFailureCtx): MailboxFailureCtx {
  const target = ctx.target;
  const message = ctx.message;
  if (target === undefined || message === undefined) return ctx;
  const synthetic = ctx.entry?.origin !== 'chat';
  try {
    const failedId = withBusyRetry(
      () =>
        ctx.deps.sdkMessageRepo.markDeliveryFailedByUuid(target.sessionId, target.messageUuid) ??
        ctx.deps.sdkMessageRepo.findMessageIdByUuid?.(target.sessionId, target.messageUuid) ??
        ctx.deps.saveFailed(target.sessionId, message, synthetic ? 'system' : undefined)
    );
    return { ...ctx, failedId };
  } catch (error) {
    emitMaterializeFailure(target, ctx.entry?.id ?? 'unknown', error);
    return ctx;
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
  if (target === undefined || failedId === undefined) return ctx;
  detachFailureCallback(() => ctx.deps.publishFailed?.(target.sessionId, failedId));
  detachFailureCallback(() => ctx.deps.settleSkipped?.(target.sessionId, target.messageUuid));
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
