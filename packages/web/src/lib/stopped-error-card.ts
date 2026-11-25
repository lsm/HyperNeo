import { type ContentBlock, isTextBlock } from '@hyperneo/shared/sdk/type-guards';
import type { ChatMessage, Session } from '@hyperneo/shared';

export type StoppedEpisode = NonNullable<Session['metadata']['queryFailureEpisode']>;
type Message = { type: string; uuid?: string; error?: unknown };

export function matchingSessionErrorCard(
  messages: readonly ChatMessage[],
  ...errors: (string | undefined)[]
): string | undefined {
  const last = messages.findLast((message) => {
    if (message.type !== 'assistant' && message.type !== 'user') return false;
    if (message.parent_tool_use_id) return false;
    return (
      message.type === 'assistant' ||
      !(
        Array.isArray(message.message.content) &&
        message.message.content.some((block: ContentBlock) => block.type === 'tool_result')
      )
    );
  });
  if (last?.type !== 'assistant' || !last.error) return undefined;
  const text = (last.message.content as ContentBlock[])
    .filter(isTextBlock)
    .map((block) => block.text)
    .join('\n')
    .trim();
  return text && errors.some((error) => error?.trim() === text) ? last.uuid : undefined;
}

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
