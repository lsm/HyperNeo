import type { MessageAdmissionRecord } from './sdk-message-admission';

export type BadgeUpdateInstruction =
  | { kind: 'none' }
  | { kind: 'delta'; delta: number }
  | { kind: 'recompute' };

export function planAdmissionBadgeUpdate(
  admission: Pick<MessageAdmissionRecord, 'countsTowardsBadge'>
): BadgeUpdateInstruction {
  return admission.countsTowardsBadge ? { kind: 'delta', delta: 1 } : { kind: 'none' };
}

export function planBadgeRecompute(): BadgeUpdateInstruction {
  return { kind: 'recompute' };
}
