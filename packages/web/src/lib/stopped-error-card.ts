import type { Session } from '@hyperneo/shared';

export type StoppedEpisode = NonNullable<Session['metadata']['queryFailureEpisode']>;

export function stoppedErrorCardUuid(
  messages: readonly { type: string; uuid?: string; error?: unknown }[],
  episode: StoppedEpisode | undefined
): string | undefined {
  if (!episode?.failed) return undefined;
  const last = messages.findLast(
    (message) => message.type === 'assistant' || message.type === 'user'
  );
  return last?.type === 'assistant' && last.error !== undefined ? last.uuid : undefined;
}
