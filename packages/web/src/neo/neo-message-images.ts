import type { ChatMessage } from '@hyperneo/shared';
import superpipe, { type PipelineAPI } from 'superpipe';

export function selectNeoMessageImageBlocks(message: ChatMessage): unknown[] {
  if (message.type !== 'user' && message.type !== 'assistant') return [];
  const content = message.message?.content;
  return Array.isArray(content) ? content : [];
}

export function projectNeoMessageImageSources(blocks: unknown[]): string[] {
  return blocks.flatMap((block) => {
    if (!block || typeof block !== 'object') return [];
    const item = block as { type?: unknown; source?: unknown };
    if (item.type !== 'image' || !item.source || typeof item.source !== 'object') return [];
    const source = item.source as {
      type?: unknown;
      media_type?: unknown;
      data?: unknown;
    };
    if (
      source.type !== 'base64' ||
      typeof source.media_type !== 'string' ||
      !/^image\/(png|jpeg|gif|webp)$/.test(source.media_type) ||
      typeof source.data !== 'string' ||
      !source.data.trim()
    )
      return [];
    return [`data:${source.media_type};base64,${source.data}`];
  });
}

export function messageImageFullUrl(block: unknown): string | undefined {
  const full = (block as { full?: { url?: unknown } } | null)?.full;
  return typeof full?.url === 'string' ? full.url : undefined;
}

function projectNeoMessagePhotos(blocks: unknown[]) {
  return blocks.flatMap((block) =>
    projectNeoMessageImageSources([block]).map((src) => ({
      src,
      fullSrc: messageImageFullUrl(block),
    }))
  );
}

export const neoMessagePhotos = (superpipe({})('neo-message-images') as PipelineAPI)
  .input(['message'])
  .pipe(selectNeoMessageImageBlocks, 'message', 'blocks')
  .pipe(projectNeoMessagePhotos, 'blocks', 'photos')
  .end('photos') as (message: ChatMessage) => { src: string; fullSrc?: string }[];
