import type { RateLimitHoldReason } from '@hyperneo/shared';
import type { NeoLine, NeoLineRanking } from '../../pack-contract.ts';
import { names } from './rank.ts';

export type HoldRule = {
  reason: RateLimitHoldReason;
  line?: NeoLine;
  action: 'wait' | 'move';
  afterMinutes: number;
};
export type HeldLine = {
  line: NeoLine;
  reason: RateLimitHoldReason;
  since: number;
  retryAt?: number;
};
export type LineHeldDecision = { action: 'wait' } | { action: 'tellNeo'; exhausted: boolean };

export const DEFAULT_ON_HOLD: readonly HoldRule[] = [
  { reason: 'limit', action: 'move', afterMinutes: 30 },
  { reason: 'login', action: 'move', afterMinutes: 30 },
  { reason: 'overloaded', action: 'wait', afterMinutes: 0 },
  { reason: 'network', action: 'wait', afterMinutes: 0 },
];

export function onLineHeld(input: {
  hold: HeldLine;
  rules: readonly HoldRule[];
  ranking: NeoLineRanking;
  now: number;
  told?: number | null;
}): LineHeldDecision {
  const { hold, rules, ranking, now, told } = input;
  if (told === hold.since) return { action: 'wait' };
  if (ranking.exhausted) return { action: 'tellNeo', exhausted: true };
  const forReason = rules.filter((rule) => rule.reason === hold.reason);
  const rule =
    forReason.find((entry) => entry.line && names(entry.line, hold.line)) ??
    forReason.find((entry) => !entry.line);
  if (rule?.action !== 'move') return { action: 'wait' };
  const after = rule.afterMinutes * 60_000;
  return now - hold.since >= after || (hold.retryAt !== undefined && hold.retryAt - now > after)
    ? { action: 'tellNeo', exhausted: false }
    : { action: 'wait' };
}

const lineName = (line: NeoLine) =>
  [line.provider, line.model, line.harness && `via ${line.harness}`, line.effort]
    .filter(Boolean)
    .join(' ');

export function lineHeldText(
  todo: { id: string; title: string },
  hold: HeldLine,
  ranking: NeoLineRanking
): string {
  const usable = ranking.ranked.map((entry) => lineName(entry.line));
  const unusable = ranking.skipped.map((entry) => `${lineName(entry.line)} (${entry.reason})`);
  return [
    `Todo "${todo.title}" (${todo.id}) is held on ${lineName(hold.line)} (${hold.reason}) since ${new Date(hold.since).toISOString()}.`,
    usable.length
      ? `Usable lines, best first: ${usable.join('; ')}.`
      : 'No other line is usable for it.',
    ...(unusable.length ? [`Not usable: ${unusable.join('; ')}.`] : []),
    'Decide whether it waits or moves.',
  ].join(' ');
}
