import type { NeoWork } from '@hyperneo/shared/types/neo-context';
import type { NeoAsk } from '@hyperneo/shared/types/neo-snapshot';

export const NEO_TURN_LIMIT_PREFIX = 'neo-turn-limit:';
export const NEO_HUMAN_TURN_LIMIT_PREFIX = `${NEO_TURN_LIMIT_PREFIX}human:`;

export type NeoTurnResult = { uuid: string | null; subtype: string | null; timestamp: string };

export function planNeoTurnLimitNote(
  results: readonly NeoTurnResult[],
  notedSince: (since: string) => boolean
): { resultUuid: string; since: number; until: number; sinceAt: string; untilAt: string } | null {
  const [latest, previous] = results;
  if (latest?.subtype !== 'error_max_turns' || !latest.uuid) return null;
  if (!previous || notedSince(previous.timestamp)) return null;
  return {
    resultUuid: latest.uuid,
    since: Date.parse(previous.timestamp),
    until: Date.parse(latest.timestamp),
    sinceAt: previous.timestamp,
    untilAt: latest.timestamp,
  };
}

export function neoTurnLimitNote(
  asks: readonly Pick<NeoAsk, 'id' | 'title' | 'status'>[],
  works: readonly Pick<NeoWork, 'id' | 'title' | 'status'>[]
): string {
  const done = [
    ...asks.map((ask) => `- ask ${ask.id} "${ask.title}" (${ask.status})`),
    ...works.map((work) => `- card ${work.id} "${work.title}" (${work.status})`),
  ];
  return [
    'Your last turn hit its turn limit before it finished.',
    done.length
      ? `It already created these, and they stay as they are:\n${done.join('\n')}`
      : 'It created no asks or cards.',
    'What the human has read since then follows as its own note when there is any.',
  ].join('\n');
}
