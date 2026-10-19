import { isNeoAskSettled } from './done-check.ts';
import type { NeoAsk } from '@hyperneo/shared/types/neo-snapshot';
import { isPooledNeoAsk } from '@hyperneo/shared/types/neo-snapshot';

export const isFinal = isNeoAskSettled;

const ACTIVE_ASK_LIMIT = 50;

export function projectNeoSnapshotAsks(
  asks: readonly NeoAsk[],
  settledLimit: number,
  now: number,
  stalled: ReadonlySet<string> = new Set()
): NeoAsk[] {
  const active = asks.filter((ask) => !isFinal(ask)).slice(0, ACTIVE_ASK_LIMIT);
  return [...active, ...asks.filter(isFinal).slice(0, settledLimit)].map((ask) => ({
    ...ask,
    pooled: isPooledNeoAsk(ask),
    approvalSpent: null,
    ...(ask.workIds.some((id) => stalled.has(id))
      ? { stalledWorkIds: ask.workIds.filter((id) => stalled.has(id)) }
      : {}),
  }));
}
