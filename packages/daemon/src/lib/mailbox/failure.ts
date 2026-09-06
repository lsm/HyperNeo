import type { MessageOrigin } from '@hyperneo/shared';
import type { SDKUserMessage } from '@hyperneo/shared/sdk';
import { withBusyRetry } from '../../storage/busy-retry.ts';
import type { Job } from '../../storage/repositories/job-queue-repository.ts';
import type { SDKMessageRepository } from '../../storage/repositories/sdk-message-repository.ts';
import { emitStructuredLogEvent } from '../logger.ts';
import { parseMailboxEntry } from './entry.ts';

export interface MailboxFailureDeps {
  sdkMessageRepo: SDKMessageRepository;
  publishFailed?(sessionId: string, dbMessageId: string): Promise<void>;
  saveFailed(sessionId: string, message: SDKUserMessage, origin?: MessageOrigin): string;
  settleSkipped?(sessionId: string, messageUuid: string): Promise<void>;
}

function emitMaterializeFailure(
  entryId: string,
  sessionId: string,
  messageUuid: string,
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
        sessionId,
        messageUuid,
        error: error instanceof Error ? error.message : String(error),
      },
    });
  } catch {}
}

export function materializeMailboxFailure(job: Job, deps: MailboxFailureDeps): void {
  const entry = parseMailboxEntry(job.payload);
  if (entry?.to.kind !== 'session' || entry.messageUuid === undefined) return;
  const sessionId = entry.to.sessionId;
  const messageUuid = entry.messageUuid;
  const synthetic = entry.origin !== 'chat';
  const message: SDKUserMessage = {
    ...entry.message,
    uuid: messageUuid as NonNullable<SDKUserMessage['uuid']>,
    session_id: sessionId,
    ...(synthetic ? { isSynthetic: true } : {}),
  };
  let failedId: string | null;
  try {
    failedId = withBusyRetry(
      () =>
        deps.sdkMessageRepo.markDeliveryFailedByUuid(sessionId, messageUuid) ??
        deps.sdkMessageRepo.findMessageIdByUuid?.(sessionId, messageUuid) ??
        deps.saveFailed(sessionId, message, synthetic ? 'system' : undefined)
    );
  } catch (error) {
    emitMaterializeFailure(entry.id, sessionId, messageUuid, error);
    return;
  }
  void Promise.resolve(deps.publishFailed?.(sessionId, failedId)).catch(() => {});
  void Promise.resolve(deps.settleSkipped?.(sessionId, messageUuid)).catch(() => {});
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
