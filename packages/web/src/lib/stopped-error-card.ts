import type { Session } from '@hyperneo/shared';

export type StoppedEpisode = NonNullable<Session['metadata']['queryFailureEpisode']>;

export function stoppedErrorCardUuid(
  messages: readonly { type: string; uuid?: string; error?: unknown }[],
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
