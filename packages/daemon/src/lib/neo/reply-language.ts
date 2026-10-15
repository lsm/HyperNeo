import type { SDKMessage } from '@hyperneo/shared/sdk';

export function neoPromptText(messages: readonly SDKMessage[]): string {
  return messages
    .flatMap((message) => {
      const content = (message as { message?: { content?: unknown } }).message?.content;
      if (typeof content === 'string') return [content];
      return Array.isArray(content)
        ? content.flatMap((block: { type?: unknown; text?: unknown }) =>
            block?.type === 'text' && typeof block.text === 'string' ? [block.text] : []
          )
        : [];
    })
    .join('\n');
}
