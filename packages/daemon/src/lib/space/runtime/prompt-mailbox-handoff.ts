import type { MessageOrigin } from '@hyperneo/shared';
import type { SDKUserMessage } from '@hyperneo/shared/sdk';
import { activatePrompts, ensurePrompt, retryPrompt } from '../../agent/message-delivery-outbox.ts';
import type { MessageDeliveryOrigin } from '../../agent/message-delivery.ts';
import type { JobQueueRepository } from '../../../storage/repositories/job-queue-repository.ts';
import type { SDKMessageRepository } from '../../../storage/repositories/sdk-message-repository.ts';
import type { Database as BunDatabase } from '../../../storage/sqlite-compat.ts';

export type PromptHandoffMechanism = 'retry' | 'activate' | 'ensure';

export interface PromptHandoffRow {
  sendStatus: string;
}

export interface PromptHandoffDeps {
  db: BunDatabase;
  sdkMessageRepo: SDKMessageRepository;
  jobQueue: JobQueueRepository;
}

export interface PromptHandoffTarget {
  sessionId: string;
  messageId: string;
  message: SDKUserMessage;
  origin: MessageDeliveryOrigin;
  messageOrigin?: MessageOrigin;
}

export interface PromptHandoffStageOutcome {
  dbId: string;
  changed: boolean;
}

export interface EnsureHandoffStageOutcome extends PromptHandoffStageOutcome {
  advanced: boolean;
}

export function planHandoffMechanism(
  existing: PromptHandoffRow | null | undefined
): PromptHandoffMechanism {
  if (existing?.sendStatus === 'failed') return 'retry';
  if (existing?.sendStatus === 'deferred') return 'activate';
  return 'ensure';
}

export function resolveDeliverableHandoff(
  deps: PromptHandoffDeps,
  target: PromptHandoffTarget
): PromptHandoffStageOutcome {
  const settledDbId = deps.sdkMessageRepo.getSettledDeliveryMessageId(
    target.sessionId,
    target.messageId
  );
  if (settledDbId !== null) {
    return { dbId: settledDbId, changed: false };
  }
  const dbIds = deps.sdkMessageRepo.getDeliveryMessageIdsByUuids(target.sessionId, [
    target.messageId,
  ]);
  return { dbId: dbIds[0] ?? target.messageId, changed: false };
}

export function hasSettledHandoffRow(
  deps: PromptHandoffDeps,
  target: Pick<PromptHandoffTarget, 'sessionId' | 'messageId'>
): boolean {
  if (deps.sdkMessageRepo.hasConsumptionEvidence(target.sessionId, target.messageId)) return true;
  const current = deps.sdkMessageRepo.getDeliveryContent(target.sessionId, target.messageId);
  return current?.sendStatus === 'consumed';
}

export async function retryFailedPromptIntoMailbox(
  deps: PromptHandoffDeps,
  target: PromptHandoffTarget
): Promise<PromptHandoffStageOutcome | null> {
  if (hasSettledHandoffRow(deps, target)) {
    return resolveDeliverableHandoff(deps, target);
  }
  const retried = await retryPrompt({
    db: deps.db,
    jobQueue: deps.jobQueue,
    sdkMessageRepo: deps.sdkMessageRepo,
    sessionId: target.sessionId,
    messageUuid: target.messageId,
    origin: target.origin,
  });
  if (retried === null) {
    if (hasSettledHandoffRow(deps, target)) {
      return resolveDeliverableHandoff(deps, target);
    }
    return null;
  }
  return { dbId: retried.dbId, changed: true };
}

export async function activateDeferredPromptIntoMailbox(
  deps: PromptHandoffDeps,
  target: PromptHandoffTarget
): Promise<PromptHandoffStageOutcome | null> {
  const { activated } = await activatePrompts({
    db: deps.db,
    jobQueue: deps.jobQueue,
    sessionId: target.sessionId,
    messageUuids: [target.messageId],
    origin: target.origin,
  });
  const entry = activated[0];
  if (!entry) return null;
  return { dbId: entry.dbId, changed: true };
}

export function ensurePromptIntoMailbox(
  deps: PromptHandoffDeps,
  target: PromptHandoffTarget
): EnsureHandoffStageOutcome {
  const ensured = ensurePrompt({
    db: deps.db,
    sdkMessageRepo: deps.sdkMessageRepo,
    jobQueue: deps.jobQueue,
    sessionId: target.sessionId,
    message: target.message,
    origin: target.messageOrigin,
    delivery: { origin: target.origin },
  });
  return {
    dbId: ensured.dbMessageId,
    changed: ensured.created,
    advanced: ensured.created || ensured.activated,
  };
}
