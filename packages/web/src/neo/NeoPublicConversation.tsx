import { useState } from 'preact/hooks';
import type { NeoConversationAsk } from '@hyperneo/shared/types/neo-conversation-ask';
import type { NeoPublicationLink } from '@hyperneo/shared/types/neo-publication';
import MarkdownRenderer from '../components/chat/MarkdownRenderer.tsx';
import { CopyButton } from '../components/ui/CopyButton.tsx';
import { NeoIcon } from './NeoIcon.tsx';
import { messageTime } from './NeoMessage.tsx';
import { projectNeoMessageImageSources } from './neo-message-images.ts';
import { neoMessageAnchor } from './reply-context.ts';
import type { NeoPendingAsk } from './neo-intake.ts';
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
  topics,
}: {
  entry: NeoPublicEntry;
  topics?: ReadonlyMap<string, string>;
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
  const topic = publication ? topics?.get(publication.producerInput.sessionId) : undefined;
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
        {topic && (
          <span class="neo-message-topic max-w-[16rem] truncate text-fg-faint" title={topic}>
            {topic}
          </span>
        )}
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

export function PendingAsk({
  ask,
  onRetry,
  onEdit,
}: {
  ask: NeoPendingAsk;
  onRetry?: (requestId: string) => void;
  onEdit?: (requestId: string) => void;
}) {
  const failed = ask.state === 'failed';
  const [showReason, setShowReason] = useState(false);
  const time = messageTime(ask.createdAt);
  const notSent = `Not sent${ask.reason ? `: ${ask.reason}` : ''}`;
  return (
    <article
      data-pending-ask={ask.requestId}
      class="neo-arrive neo-message neo-message-user ml-auto w-fit max-w-[78%] break-words"
    >
      <div class="mb-2 flex flex-wrap items-baseline justify-end gap-x-2 px-1 text-xs">
        <span class="neo-message-name font-medium">You</span>
        {time && (
          <time dateTime={time.iso} title={time.full} class="neo-message-time text-[11px]">
            {time.label}
          </time>
        )}
        {ask.state === 'sending' && (
          <span
            role="img"
            aria-label="Sending"
            title="Sending"
            class="inline-block h-3 w-3 animate-spin self-center rounded-full border-[1.5px] border-current border-t-transparent text-fg-faint"
          />
        )}
        {ask.state === 'accepted' && (
          <span
            role="img"
            aria-label="Message accepted"
            title="Accepted by Neo. This does not mean work is complete."
            class="inline-flex self-center text-fg-faint"
          >
            <NeoIcon name="received" class="!h-3.5 !w-3.5" />
          </span>
        )}
        {failed && (
          <button
            type="button"
            aria-label={notSent}
            title={notSent}
            aria-expanded={showReason}
            onClick={() => setShowReason((shown) => !shown)}
            class="inline-flex self-center text-danger"
          >
            <NeoIcon name="alert" class="!h-3.5 !w-3.5" />
          </button>
        )}
      </div>
      <div
        class={`neo-message-bubble rounded-2xl rounded-tr-sm border px-4 py-3 ${failed ? '!border-danger' : ''}`}
      >
        {ask.images.length > 0 && (
          <div class="mb-3 flex flex-wrap gap-2">
            {ask.images.map((image, index) => (
              <img
                key={index}
                src={`data:${image.media_type};base64,${image.data}`}
                alt={`Attached photo ${index + 1}`}
                class="max-h-64 max-w-full rounded-xl object-contain"
              />
            ))}
          </div>
        )}
        <p class="whitespace-pre-wrap text-base leading-relaxed">{ask.text}</p>
      </div>
      {failed && showReason && <p class="mt-1 px-1 text-right text-xs text-danger">{notSent}</p>}
      {failed && (
        <div class="mt-1 flex items-center justify-end gap-1">
          <button
            type="button"
            aria-label="Retry"
            title="Retry"
            onClick={() => onRetry?.(ask.requestId)}
            class="rounded-full p-1.5 text-fg-muted hover:bg-fill-soft hover:text-fg"
          >
            <NeoIcon name="retry" class="!h-4 !w-4" />
          </button>
          <button
            type="button"
            aria-label="Edit"
            title="Edit"
            onClick={() => onEdit?.(ask.requestId)}
            class="rounded-full p-1.5 text-fg-muted hover:bg-fill-soft hover:text-fg"
          >
            <NeoIcon name="edit" class="!h-4 !w-4" />
          </button>
        </div>
      )}
    </article>
  );
}

export function NeoPublicConversation({
  conversation,
  onOpenScene,
  canOpenScene,
  onRetry,
  onLoadEarlier,
  topics,
}: {
  conversation: Conversation;
  topics?: ReadonlyMap<string, string>;
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
          topics={topics}
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
