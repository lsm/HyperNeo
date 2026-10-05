import type { NeoConversationAsk } from '@hyperneo/shared/types/neo-conversation-ask';
import type { NeoPublicationLink } from '@hyperneo/shared/types/neo-publication';
import MarkdownRenderer from '../components/chat/MarkdownRenderer.tsx';
import { CopyButton } from '../components/ui/CopyButton.tsx';
import { NeoIcon } from './NeoIcon.tsx';
import { messageTime } from './NeoMessage.tsx';
import { projectNeoMessageImageSources } from './neo-message-images.ts';
import { neoMessageAnchor } from './reply-context.ts';
import type {
  NeoPublicConversation as Conversation,
  NeoPublicEntry,
} from './public-conversation.ts';

export function publicAskText(content: NeoConversationAsk['content']): string {
  if (typeof content === 'string') return content;
  return (Array.isArray(content) ? content : [])
    .flatMap((block: unknown) => {
      if (!block || typeof block !== 'object') return [];
      const item = block as { type?: unknown; text?: unknown };
      return item.type === 'text' && typeof item.text === 'string' ? [item.text] : [];
    })
    .join('\n\n');
}

function PublicEntry({
  entry,
  onOpenScene,
  canOpenScene,
}: {
  entry: NeoPublicEntry;
  onOpenScene?: (ref: Pick<NeoPublicationLink, 'kind' | 'id'>) => void;
  canOpenScene?: (ref: Pick<NeoPublicationLink, 'kind' | 'id'>) => boolean;
}) {
  const ask = entry.kind === 'ask' ? entry.ask : null;
  const publication = entry.kind === 'publication' ? entry.publication : null;
  const text = ask ? publicAskText(ask.content) : publication!.fullText;
  const images =
    ask && Array.isArray(ask.content) ? projectNeoMessageImageSources(ask.content) : [];
  const time = messageTime((ask ?? publication)!.createdAt);
  const author = publication?.producerInput.sessionId ? 'Neo' : 'You';
  const links = publication?.links.filter((link) => link.kind === 'work') ?? [];
  return (
    <article
      id={ask ? neoMessageAnchor(ask.askOrigin.sessionId, ask.askOrigin.messageId) : undefined}
      data-public-entry={entry.key}
      class={`neo-arrive neo-message w-fit break-words ${ask ? 'neo-message-user ml-auto max-w-[78%]' : 'neo-message-assistant mr-auto max-w-[94%]'}`}
    >
      <div
        class={`mb-2 flex flex-wrap items-baseline gap-x-2 px-1 text-xs ${ask ? 'justify-end' : ''}`}
      >
        <span class="neo-message-name font-medium">{author}</span>
        {time && (
          <time dateTime={time.iso} title={time.full} class="neo-message-time text-[11px]">
            {time.label}
          </time>
        )}
        {ask && (
          <span
            role="img"
            aria-label="Message accepted"
            title="Accepted by Neo. This does not mean work is complete."
            class="inline-flex self-center text-fg-faint"
          >
            <NeoIcon name="received" class="!h-3.5 !w-3.5" />
          </span>
        )}
      </div>
      <div
        class={`neo-message-bubble rounded-2xl border px-4 py-3 ${ask ? 'rounded-tr-sm' : 'rounded-tl-sm'}`}
      >
        {images.length > 0 && (
          <div class="mb-3 flex flex-wrap gap-2">
            {images.map((src, index) => (
              <img
                key={index}
                src={src}
                alt={`Attached photo ${index + 1}`}
                class="max-h-64 max-w-full rounded-xl object-contain"
              />
            ))}
          </div>
        )}
        {/^[\s]*\d+[.)]?[\s]*$/.test(text) ? (
          <p class="whitespace-pre-wrap text-base leading-relaxed">{text}</p>
        ) : (
          <MarkdownRenderer
            content={text}
            class={`neo-markdown neo-markdown-${ask ? 'user' : 'assistant'} text-base leading-relaxed`}
          />
        )}
        {publication && (
          <>
            {links.length > 0 && (
              <ul
                aria-label="Related Neo scenes"
                class="mt-3 flex flex-wrap gap-3 text-sm text-accent"
              >
                {links.map((link) => (
                  <li key={JSON.stringify([link.kind, link.id])}>
                    {onOpenScene && (canOpenScene?.(link) ?? true) ? (
                      <button
                        type="button"
                        class="text-left hover:underline"
                        onClick={() => onOpenScene({ kind: link.kind, id: link.id })}
                      >
                        {link.label}
                      </button>
                    ) : (
                      <span>{link.label}</span>
                    )}
                  </li>
                ))}
              </ul>
            )}
          </>
        )}
      </div>
      <div class={`mt-1 flex items-center gap-3 ${ask ? 'justify-end' : ''}`}>
        <CopyButton
          text={text}
          label={ask ? 'Copy your message' : 'Copy Neo’s message'}
          disabled={!text.trim()}
        />
      </div>
    </article>
  );
}

export function NeoPublicConversation({
  conversation,
  onOpenScene,
  canOpenScene,
  onRetry,
  onLoadEarlier,
}: {
  conversation: Conversation;
  onOpenScene?: (ref: Pick<NeoPublicationLink, 'kind' | 'id'>) => void;
  canOpenScene?: (ref: Pick<NeoPublicationLink, 'kind' | 'id'>) => boolean;
  onRetry?: () => void;
  onLoadEarlier?: () => void;
}) {
  return (
    <div class="space-y-6" aria-label="Public conversation">
      {conversation.status !== 'ready' && (
        <p role="status" class="text-sm text-fg-muted">
          {conversation.status === 'loading'
            ? 'Loading saved conversation…'
            : conversation.entries.length > 0
              ? 'Saved conversation is unavailable. Showing retained messages.'
              : 'Saved conversation is unavailable.'}
        </p>
      )}
      {conversation.status === 'unavailable' && onRetry && (
        <button type="button" class="text-sm text-accent hover:underline" onClick={onRetry}>
          Retry saved conversation
        </button>
      )}
      {(conversation.hasEarlier || conversation.hasMore) && (
        <p class="text-xs text-fg-muted">Showing part of your saved conversation.</p>
      )}
      {conversation.hasEarlier && onLoadEarlier && (
        <button
          type="button"
          class="text-sm text-accent hover:underline"
          disabled={conversation.status !== 'ready'}
          onClick={onLoadEarlier}
        >
          Load earlier saved conversation
        </button>
      )}
      {conversation.entries.map((entry) => (
        <PublicEntry
          key={entry.key}
          entry={entry}
          onOpenScene={onOpenScene}
          canOpenScene={canOpenScene}
        />
      ))}
      {conversation.hasMore && onRetry && (
        <button
          type="button"
          class="text-sm text-accent hover:underline"
          disabled={conversation.status !== 'ready'}
          onClick={onRetry}
        >
          Load more saved conversation
        </button>
      )}
    </div>
  );
}
