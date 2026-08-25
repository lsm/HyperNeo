export type AckSendStatus = 'enqueued' | 'deferred' | 'submitted';

export type PersistedAckSelection =
  | { action: 'consume'; status: AckSendStatus }
  | { action: 'already_consumed' }
  | { action: 'none' };

export function selectPersistedAckRow(args: {
  enqueued: boolean;
  deferred: boolean;
  submitted: boolean;
  consumed: boolean;
}): PersistedAckSelection {
  if (args.enqueued) return { action: 'consume', status: 'enqueued' };
  if (args.deferred) return { action: 'consume', status: 'deferred' };
  if (args.submitted) return { action: 'consume', status: 'submitted' };
  if (args.consumed) return { action: 'already_consumed' };
  return { action: 'none' };
}

export type YieldedAckSelection = { action: 'consume'; status: AckSendStatus } | { action: 'none' };

export function selectYieldedAckRow(args: {
  enqueued: boolean;
  submitted: boolean;
  deferred: boolean;
}): YieldedAckSelection {
  if (args.enqueued) return { action: 'consume', status: 'enqueued' };
  if (args.submitted) return { action: 'consume', status: 'submitted' };
  if (args.deferred) return { action: 'consume', status: 'deferred' };
  return { action: 'none' };
}

export function isTurnEndAckEligible(args: {
  uuid: string;
  activeMessageId: string | null;
  durableOwned: boolean;
  yielded: boolean;
  pendingOrClaimed: boolean;
}): boolean {
  const activeYielded = args.uuid === args.activeMessageId && args.yielded;
  return (!args.durableOwned || activeYielded) && !args.pendingOrClaimed;
}

export function composeTurnEndDeliveryUuids(args: {
  messageId: string;
  yielded: boolean;
  batchUuids: ReadonlyArray<string> | null;
}): string[] {
  if (!args.yielded || !args.batchUuids?.includes(args.messageId)) {
    return [args.messageId];
  }
  return [args.messageId, ...args.batchUuids.filter((uuid) => uuid !== args.messageId)];
}
