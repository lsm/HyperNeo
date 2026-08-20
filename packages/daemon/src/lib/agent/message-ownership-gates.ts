import {
  BATCH_DELIVERY_MAX_CHARS,
  buildBatchedDeliveryContent,
  type MessageDeliveryRole,
} from './message-delivery';

export type MessageOwnership = 'job_queue' | 'memory_queue' | 'unowned';

export function resolveMessageOwnership(args: {
  activeInJobQueue: boolean;
  pendingInMemory: boolean;
}): MessageOwnership {
  if (args.activeInJobQueue) return 'job_queue';
  if (args.pendingInMemory) return 'memory_queue';
  return 'unowned';
}

export interface FlushMessage {
  uuid: string;
  isUserMessage: boolean;
  flattenedText: string | null;
}

export type FlushSkipOwnership = 'job_queue' | 'memory_queue' | 'not_user_message';

export interface FlushSkipEntry {
  uuid: string;
  ownership: FlushSkipOwnership;
}

export type FlushDeliveryPlan =
  | { action: 'noop' }
  | { action: 'batch'; uuids: string[] }
  | { action: 'each'; deliver: string[]; skip: FlushSkipEntry[] };

export function planFlushDelivery(args: {
  messages: FlushMessage[];
  activeInJobQueue: ReadonlySet<string>;
  pendingInMemoryUuids: ReadonlySet<string>;
  activeTurnInJobQueue: boolean;
}): FlushDeliveryPlan {
  const deliver: string[] = [];
  const deliverableTexts: string[] = [];
  const skip: FlushSkipEntry[] = [];
  for (const message of args.messages) {
    const ownership = resolveMessageOwnership({
      activeInJobQueue: args.activeInJobQueue.has(message.uuid),
      pendingInMemory: args.pendingInMemoryUuids.has(message.uuid),
    });
    if (ownership !== 'unowned') {
      skip.push({ uuid: message.uuid, ownership });
      continue;
    }
    if (!message.isUserMessage) {
      skip.push({ uuid: message.uuid, ownership: 'not_user_message' });
      continue;
    }
    deliver.push(message.uuid);
    if (message.flattenedText !== null) deliverableTexts.push(message.flattenedText);
  }
  if (deliver.length === 0) return { action: 'noop' };

  const allBatchable = args.messages
    .filter(
      (message) =>
        message.isUserMessage &&
        (!args.pendingInMemoryUuids.has(message.uuid) || args.activeInJobQueue.has(message.uuid))
    )
    .every(
      (message) =>
        message.flattenedText !== null &&
        !message.flattenedText.startsWith('/') &&
        !args.activeInJobQueue.has(message.uuid)
    );
  const wrapperChars = buildBatchedDeliveryContent(deliverableTexts.map(() => '')).length;
  const combinedChars = deliverableTexts.reduce((sum, text) => sum + text.length, 0) + wrapperChars;
  if (
    deliver.length >= 2 &&
    allBatchable &&
    !args.activeTurnInJobQueue &&
    combinedChars <= BATCH_DELIVERY_MAX_CHARS
  ) {
    return { action: 'batch', uuids: deliver };
  }
  return { action: 'each', deliver, skip };
}

export type DeliveryRoleResolution = MessageDeliveryRole | 'explicit_role_rejected';

export function resolveDeliveryRole(args: {
  existingActiveRole: MessageDeliveryRole | null;
  requestedRole?: MessageDeliveryRole;
  uniqueConstraintHit: boolean;
}): DeliveryRoleResolution {
  if (args.existingActiveRole) return args.existingActiveRole;
  if (args.requestedRole === 'turn' && args.uniqueConstraintHit) {
    return 'explicit_role_rejected';
  }
  if (args.requestedRole) return args.requestedRole;
  if (args.uniqueConstraintHit) return 'steer';
  return 'turn';
}

export type DeferAdmissionDecision = { action: 'defer' } | { action: 'deliver' };

export function decideDeferAdmission(args: {
  deliveryMode: 'immediate' | 'defer';
  isBusy: boolean;
  inRateLimitCooldown: boolean;
  parentTaskLimited: boolean;
}): DeferAdmissionDecision {
  if (
    (args.deliveryMode === 'defer' && args.isBusy) ||
    args.inRateLimitCooldown ||
    args.parentTaskLimited
  ) {
    return { action: 'defer' };
  }
  return { action: 'deliver' };
}
