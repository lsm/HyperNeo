import type { Session } from '@hyperneo/shared';

export type StoppedEpisode = NonNullable<Session['metadata']['queryFailureEpisode']>;
type Message = { type: string; uuid?: string; error?: unknown };

export function stoppedErrorCardUuid(
  messages: readonly Message[],
  episode: StoppedEpisode | undefined
): string | undefined {
  if (!episode?.failed) return undefined;
  const result = messages.findLastIndex((message) => message.type === 'result');
  const turn = messages.findLastIndex(
    (message) => message.type === 'assistant' || message.type === 'user'
  );
  const last = messages[turn];
  return result > turn &&
    messages[result].uuid === stoppedResultUuid(episode.error) &&
    last?.type === 'assistant' &&
    last.error !== undefined
    ? last.uuid
    : undefined;
}

function stoppedResultUuid(error: string): unknown {
  try {
    return (JSON.parse(error) as { uuid?: unknown }).uuid;
  } catch {
    return undefined;
  }
}

export function stopBannerHidden(
  episode: StoppedEpisode | undefined,
  cardUuid: string | undefined,
  load: { loaded: boolean; tooLarge: boolean; stored: number; shown: number }
): boolean {
  if (cardUuid) return true;
  if (!episode?.failed) return false;
  return load.loaded ? load.stored > 0 && load.shown === 0 : !load.tooLarge;
}
