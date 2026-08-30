export type MessageOwnership = 'job_queue' | 'unowned';

export function resolveMessageOwnership(args: { activeInJobQueue: boolean }): MessageOwnership {
  if (args.activeInJobQueue) return 'job_queue';
  return 'unowned';
}

export interface FlushMessage {
  uuid: string;
  dbId: string;
  isUserMessage: boolean;
  isTaskInput: boolean;
  flattenedText: string | null;
}

export function isTaskFlushInput(message: { isSynthetic?: boolean; inputKind?: string }): boolean {
  if (message.inputKind !== undefined) return message.inputKind === 'task';
  return message.isSynthetic === true;
}

export type FlushSkipOwnership = 'job_queue' | 'not_user_message';

export interface FlushSkipEntry {
  uuid: string;
  ownership: FlushSkipOwnership;
}

export type FlushDeliveryPlan =
  | { action: 'noop' }
  | { action: 'each'; deliver: string[]; skip: FlushSkipEntry[] };

export function planFlushDelivery(args: {
  messages: FlushMessage[];
  activeInJobQueue: ReadonlySet<string>;
}): FlushDeliveryPlan {
  const deliver: string[] = [];
  const skip: FlushSkipEntry[] = [];
  for (const message of args.messages) {
    const ownership = resolveMessageOwnership({
      activeInJobQueue: args.activeInJobQueue.has(message.uuid),
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
  }
  if (deliver.length === 0) return { action: 'noop' };
  return { action: 'each', deliver, skip };
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
