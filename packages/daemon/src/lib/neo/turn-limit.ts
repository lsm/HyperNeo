import type { NeoWork } from '@hyperneo/shared/types/neo-context';
import type { NeoAsk } from '@hyperneo/shared/types/neo-snapshot';

export const NEO_TURN_LIMIT_PREFIX = 'neo-turn-limit:';

export type NeoTurnResult = { uuid: string | null; subtype: string | null; timestamp: string };

export function planNeoTurnLimitNote(
  results: readonly NeoTurnResult[],
  notedSince: (since: string) => boolean
): { resultUuid: string; since: number; until: number } | null {
  const [latest, previous] = results;
  if (latest?.subtype !== 'error_max_turns' || !latest.uuid) return null;
  if (!previous || notedSince(previous.timestamp)) return null;
  return {
    resultUuid: latest.uuid,
    since: Date.parse(previous.timestamp),
    until: Date.parse(latest.timestamp),
  };
}

export function neoTurnLimitNote(
  asks: readonly Pick<NeoAsk, 'id' | 'title' | 'requestKey' | 'status'>[],
  works: readonly Pick<NeoWork, 'id' | 'title' | 'requestKey' | 'status'>[]
): string {
  const done = [
    ...asks.map(
      (ask) => `- ask ${ask.id} "${ask.title}" (${ask.status}, requestKey ${ask.requestKey})`
    ),
    ...works.map(
      (work) => `- card ${work.id} "${work.title}" (${work.status}, requestKey ${work.requestKey})`
    ),
  ];
  return [
    'Your last turn hit its turn limit before it finished.',
    done.length
      ? `It already created these, and they stay as they are:\n${done.join('\n')}\nContinue them: edit or start them, and never open or propose them again under a new requestKey.`
      : 'It created no asks or cards.',
    'Read neo.snapshot and finish only what is left of that turn.',
  ].join('\n');
}
