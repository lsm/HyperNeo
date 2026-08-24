import type { MessageOrigin } from '@hyperneo/shared';
import type { SDKMessage } from '@hyperneo/shared/sdk';
import type { Database as BunDatabase } from '../../storage/sqlite-compat.ts';
import type { JobQueueRepository } from '../../storage/repositories/job-queue-repository.ts';
import type {
  SDKMessageRepository,
  SendStatus,
} from '../../storage/repositories/sdk-message-repository.ts';
import { extractSdkUuid } from '../../storage/repositories/sdk-message-repository.ts';
import { MESSAGE_DELIVERY } from '../job-queue-constants.ts';
import {
  isUniqueConstraintError,
  MESSAGE_DELIVERY_MAX_RETRIES,
  type MessageDeliveryOrigin,
  type MessageDeliveryRole,
} from './message-delivery.ts';

export interface PersistAndEnqueueDeliveryArgs {
  db: BunDatabase;
  sdkMessageRepo: SDKMessageRepository;
  jobQueue: JobQueueRepository;
  sessionId: string;
  message: SDKMessage;
  sendStatus: SendStatus;
  origin?: MessageOrigin;
  delivery: { origin: MessageDeliveryOrigin; parentToolUseId?: string | null };
}

export interface PersistAndEnqueueDeliveryResult {
  dbMessageId: string;
  role: MessageDeliveryRole;
}

const DELIVERY_MAX_RETRIES = MESSAGE_DELIVERY_MAX_RETRIES;

export function persistAndEnqueueDelivery(
  args: PersistAndEnqueueDeliveryArgs
): PersistAndEnqueueDeliveryResult {
  const messageUuid = extractSdkUuid(args.message);
  if (!messageUuid) {
    throw new Error('persistAndEnqueueDelivery: message has no uuid; cannot enqueue delivery');
  }
  const { db, sdkMessageRepo, jobQueue, sessionId, message, sendStatus, origin } = args;
  const basePayload = {
    sessionId,
    messageUuid,
    role: 'turn' as const,
    origin: args.delivery.origin,
    parentToolUseId: args.delivery.parentToolUseId ?? null,
  };

  const result = db.transaction(() => {
    const core = sdkMessageRepo.saveUserMessageCore(sessionId, message, sendStatus, origin);
    let role: MessageDeliveryRole;
    try {
      jobQueue.enqueue({
        queue: MESSAGE_DELIVERY,
        payload: basePayload,
        maxRetries: DELIVERY_MAX_RETRIES,
      });
      role = 'turn';
    } catch (err) {
      if (!isUniqueConstraintError(err)) throw err;
      jobQueue.enqueue({
        queue: MESSAGE_DELIVERY,
        payload: { ...basePayload, role: 'steer' },
        maxRetries: DELIVERY_MAX_RETRIES,
      });
      role = 'steer';
    }
    return { core, role };
  })();

  try {
    sdkMessageRepo.runPostSaveSideEffects(
      sessionId,
      result.core.id,
      result.core.countsTowardsBadge
    );
  } catch {}
  return { dbMessageId: result.core.id, role: result.role };
}
