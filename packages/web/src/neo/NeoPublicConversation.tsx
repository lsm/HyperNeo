import { useEffect, useRef, useState } from 'preact/hooks';
import type {
  NeoConversationAskPageItem,
  NeoConversationImageRef,
} from '@hyperneo/shared/types/neo-conversation-ask';
import type { NeoPublicationLink } from '@hyperneo/shared/types/neo-publication';
import { neoForwardKey, type NeoSessionNoticeGroup } from '@hyperneo/shared/types/neo-snapshot';
import MarkdownRenderer from '../components/chat/MarkdownRenderer.tsx';
import { CopyButton } from '../components/ui/CopyButton.tsx';
import { connectionManager } from '../lib/connection-manager.ts';
import { type NeoAskItem, readNeoConversationImage } from './conversation-ask-client.ts';
import { NeoIcon } from './NeoIcon.tsx';
import { NeoMessageMenu, neoMessageMenuActions, useNeoMessageMenu } from './NeoMessageMenu.tsx';
import { copyToClipboard } from '../lib/utils.ts';
import { messageTime } from './NeoMessage.tsx';
import { NeoPublicationHistory } from './NeoPublicationHistory.tsx';
import { projectNeoMessageImageSources } from './neo-message-images.ts';
import { neoMessageAnchor } from './reply-context.ts';
import {
  NEO_MESSAGE_STATUS_LABELS,
  NEO_MESSAGE_STATUS_TITLES,
  type NeoMessageStatus,
} from './message-status.ts';
import { neoAppLabel, neoSessionLink } from './work-driver.ts';
import type { NeoPendingAsk, NeoQuote } from './neo-intake.ts';
import type {
  NeoPublicConversation as Conversation,
  NeoPublicEntry,
} from './public-conversation.ts';

export type NeoEditUndelivered = (ask: NeoAskItem) => boolean | void | Promise<boolean | void>;
type AskPhoto = { kind: 'inline'; src: string } | { kind: 'ref'; ref: NeoConversationImageRef };

function publicAskPhotos(content: NeoAskItem['content']): AskPhoto[] {
  if (typeof content === 'string') return [];
  return content.flatMap((block: NeoConversationAskPageItem['content'][number]): AskPhoto[] =>
    block.type === 'image_ref'
      ? [{ kind: 'ref', ref: block }]
      : projectNeoMessageImageSources([block]).map((src) => ({ kind: 'inline', src }))
  );
}

function photoBox(ref: NeoConversationImageRef) {
  if (!ref.width || !ref.height) return { width: '8rem', height: '8rem' };
  return {
    width: `${Math.round(ref.width * Math.min(1, 256 / ref.height))}px`,
    aspectRatio: `${ref.width} / ${ref.height}`,
  };
}

const PHOTO_CACHE_CHARS = 48 * 1024 * 1024;
const loadedPhotos = new Map<string, string>();
let loadedPhotoChars = 0;

function cachedPhoto(key: string): string | undefined {
  const src = loadedPhotos.get(key);
  if (src === undefined) return undefined;
  loadedPhotos.delete(key);
  loadedPhotos.set(key, src);
  return src;
}

function keepPhoto(key: string, src: string) {
  loadedPhotoChars -= loadedPhotos.get(key)?.length ?? 0;
  loadedPhotos.delete(key);
  loadedPhotos.set(key, src);
  loadedPhotoChars += src.length;
  for (const [oldest, value] of loadedPhotos) {
    if (loadedPhotoChars <= PHOTO_CACHE_CHARS || oldest === key) break;
    loadedPhotos.delete(oldest);
    loadedPhotoChars -= value.length;
  }
}

function RefPhoto({
  conversationId,
  photo,
  label,
}: {
  conversationId: string;
  photo: NeoConversationImageRef;
  label: string;
}) {
  const key = `${conversationId}/${photo.imageId}`;
  const cached = cachedPhoto(key);
  const [view, setView] = useState<
    { state: 'idle' | 'loading' | 'failed' } | { state: 'ready'; src: string }
  >(cached ? { state: 'ready', src: cached } : { state: 'idle' });
  const frame = useRef<HTMLButtonElement>(null);
  const load = async () => {
    setView({ state: 'loading' });
    const read = await readNeoConversationImage({ conversationId, imageId: photo.imageId }, () =>
      connectionManager.getHub()
    );
    if (read.state !== 'ready') return setView({ state: 'failed' });
    const src = `data:${read.image.media_type};base64,${read.image.data}`;
    keepPhoto(key, src);
    setView({ state: 'ready', src });
  };
  useEffect(() => {
    const element = frame.current;
    if (view.state !== 'idle' || !element || typeof IntersectionObserver !== 'function') return;
    const observer = new IntersectionObserver((entries) => {
      if (!entries.some((entry) => entry.isIntersecting)) return;
      observer.disconnect();
      void load();
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, [view.state, key]);
  const box = photoBox(photo);
  if (view.state === 'ready')
    return (
      <img src={view.src} alt={label} style={box} class="max-w-full rounded-xl object-contain" />
    );
  const loading = view.state === 'loading';
  return (
    <div class="flex max-w-full flex-col items-start gap-1">
      <button
        type="button"
        aria-label={`Open ${label.toLowerCase()}`}
        aria-busy={loading}
        disabled={loading}
        ref={frame}
        onClick={() => void load()}
        style={box}
        class="relative max-w-full cursor-zoom-in overflow-hidden rounded-xl border bg-fill-soft"
      >
        {photo.thumbnail ? (
          <img
            src={`data:${photo.thumbnail.mediaType};base64,${photo.thumbnail.data}`}
            alt={label}
            class="h-full w-full object-cover"
          />
        ) : (
          <span
            role="img"
            aria-label={label}
            class="flex h-full w-full items-center justify-center text-xs text-fg-faint"
          >
            Photo
          </span>
        )}
        {loading && (
          <span
            role="status"
            aria-label="Loading photo"
            class="absolute inset-0 m-auto h-5 w-5 animate-spin rounded-full border-2 border-current border-t-transparent text-fg-faint"
          />
        )}
      </button>
      {view.state === 'failed' && (
        <button
          type="button"
          class="text-xs text-danger hover:underline"
          onClick={() => void load()}
        >
          Photo could not load. Retry
        </button>
      )}
    </div>
  );
}

export function publicAskText(content: NeoAskItem['content']): string {
  if (typeof content === 'string') return content;
  return (Array.isArray(content) ? content : [])
    .flatMap((block: unknown) => {
      if (!block || typeof block !== 'object') return [];
      const item = block as { type?: unknown; text?: unknown };
      return item.type === 'text' && typeof item.text === 'string' ? [item.text] : [];
    })
    .join('\n\n');
}

const NOT_DELIVERED = 'Not delivered: Neo never got this message.';
const RESTORED_KEY = 'neo:restored-undelivered';

function restoredUndelivered(): string[] {
  try {
    const value: unknown = JSON.parse(localStorage.getItem(RESTORED_KEY) ?? '[]');
    return Array.isArray(value) ? value.filter((id) => typeof id === 'string') : [];
  } catch {
    return [];
  }
}

function markRestored(requestId: string) {
  try {
    const ids = [...restoredUndelivered().filter((id) => id !== requestId), requestId];
    localStorage.setItem(RESTORED_KEY, JSON.stringify(ids.slice(-200)));
  } catch {}
}

const NOTICE_KINDS = {
  needs_you: 'needs you',
  failed: 'failed',
  finished: 'finished',
} as const;
const NOTICES_SHOWN = 5;

export type NeoSessionMute = {
  muted: ReadonlySet<string>;
  onMute: (key: string, muted: boolean) => void;
};

function NoticeRow({
  entryKey,
  group,
  mute,
}: {
  entryKey: string;
  group: NeoSessionNoticeGroup;
  mute?: NeoSessionMute;
}) {
  const [all, setAll] = useState(false);
  const shown = all ? group.notices : group.notices.slice(0, NOTICES_SHOWN);
  const more = group.notices.length - shown.length;
  const time = messageTime(new Date(group.at).toISOString());
  return (
    <div
      role="note"
      data-public-entry={entryKey}
      class="neo-arrive mx-auto max-w-[94%] text-xs text-fg-muted"
    >
      {shown.map((notice, index) => {
        const link = neoSessionLink(notice.link, notice.ref.daemon);
        return (
          <div
            key={notice.key + notice.at}
            data-notice={notice.key}
            class="grid grid-cols-[4.5rem_minmax(0,1fr)_4.5rem] items-center"
          >
            {mute ? (
              <button
                type="button"
                class="min-h-9 justify-self-start rounded-md px-3 text-left text-fg-faint hover:bg-fill-soft hover:text-fg"
                aria-label={`${mute.muted.has(notice.key) ? 'Unmute' : 'Mute'} ${notice.title}`}
                onClick={() => mute.onMute(notice.key, !mute.muted.has(notice.key))}
              >
                {mute.muted.has(notice.key) ? 'Unmute' : 'Mute'}
              </button>
            ) : (
              <span />
            )}
            <span class="min-w-0 break-words px-1 py-1 text-center">
              {index === 0 && time && (
                <time dateTime={time.iso} title={time.full} class="mr-2 text-[11px] text-fg-faint">
                  {time.label}
                </time>
              )}
              {neoAppLabel(notice.ref.adapter)} · {notice.title}{' '}
              <span class={notice.kind === 'needs_you' ? 'font-medium text-fg' : ''}>
                {NOTICE_KINDS[notice.kind]}
              </span>
            </span>
            {link ? (
              <a
                href={link}
                class="flex min-h-9 items-center justify-self-end rounded-md px-3 text-accent hover:bg-fill-soft"
                aria-label={`Open ${notice.title}`}
              >
                Open
              </a>
            ) : (
              <span />
            )}
          </div>
        );
      })}
      {more > 0 && (
        <p class="text-center">
          <button type="button" class="text-accent hover:underline" onClick={() => setAll(true)}>
            {more} more
          </button>
        </p>
      )}
    </div>
  );
}

function PublicEntry({
  entry,
  onOpenScene,
  canOpenScene,
  onEditUndelivered,
  projects,
  forwarders,
  replyLabels,
  onQuote,
  status,
}: {
  entry: NeoPublicEntry;
  status?: NeoMessageStatus;
  projects?: ReadonlyMap<string, string>;
  forwarders?: ReadonlyMap<string, string>;
  replyLabels?: ReadonlyMap<string, string>;
  onQuote?: (quote: NeoQuote) => void;
  onOpenScene?: (ref: Pick<NeoPublicationLink, 'kind' | 'id'>) => void;
  canOpenScene?: (ref: Pick<NeoPublicationLink, 'kind' | 'id'>) => boolean;
  onEditUndelivered?: NeoEditUndelivered;
}) {
  const ask = entry.kind === 'ask' ? entry.ask : null;
  const undelivered = ask?.delivery?.state === 'failed';
  const publication = entry.kind === 'publication' ? entry.publication : null;
  const [expanded, setExpanded] = useState(false);
  const [history, setHistory] = useState(false);
  const [copiedAt, setCopiedAt] = useState(0);
  const bubbleText = useRef<HTMLDivElement>(null);
  const article = useRef<HTMLElement>(null);
  const menu = useNeoMessageMenu();
  const [showReason, setShowReason] = useState(false);
  const [restored, setRestored] = useState(
    () => !!ask && restoredUndelivered().includes(ask.requestId)
  );
  const [restoring, setRestoring] = useState(false);
  const short = publication?.shortText.trim() ?? '';
  const full = publication?.fullText.trim() ?? '';
  const hasDetails = !!short && !!full && full !== short;
  const copyText = ask ? publicAskText(ask.content) : full || short;
  const text = ask ? publicAskText(ask.content) : hasDetails ? short : full || short;
  const photos = ask ? publicAskPhotos(ask.content) : [];
  const time = messageTime((ask ?? publication)!.createdAt);
  const author = publication?.producerInput.sessionId ? 'Neo' : 'You';
  const replier = publication ? projects?.get(publication.producerInput.sessionId) : undefined;
  const forwarder = publication
    ? forwarders?.get(neoForwardKey(publication.askOrigin, publication.producerInput.sessionId))
    : undefined;
  const project = forwarder ? `${replier ?? 'Neo'} (forwarded from ${forwarder})` : replier;
  const links = publication?.links.filter((link) => link.kind === 'work') ?? [];
  const anchor = ask
    ? neoMessageAnchor(ask.askOrigin.sessionId, ask.askOrigin.messageId)
    : publication
      ? neoMessageAnchor(publication.conversationId, `publication-${publication.publicationId}`)
      : '';
  return (
    <article
      ref={article}
      tabIndex={-1}
      id={anchor || undefined}
      data-public-entry={entry.key}
      class={`neo-arrive neo-message w-fit break-words focus:outline-none ${ask ? 'neo-message-user ml-auto max-w-[78%]' : 'neo-message-assistant mr-auto max-w-[94%] max-md:w-full max-md:max-w-full'}`}
      {...(copyText.trim() ? menu.bind : {})}
    >
      <div
        class={`mb-2 flex flex-wrap items-baseline gap-x-2 px-1 text-xs ${ask ? 'justify-end' : ''}`}
      >
        <span class="neo-message-name font-medium">{author}</span>
        {project && (
          <span class="neo-message-project max-w-[16rem] truncate text-fg-faint" title={project}>
            {project}
          </span>
        )}
        {time && (
          <time dateTime={time.iso} title={time.full} class="neo-message-time text-[11px]">
            {time.label}
          </time>
        )}
        {publication && (publication.editedAt || publication.revisions?.length) ? (
          <button
            type="button"
            data-publication-edited
            aria-label="Edited: show revision history"
            aria-expanded={history}
            aria-controls={`${anchor}-history`}
            onClick={() => setHistory(!history)}
            class="text-[11px] text-fg-faint hover:text-fg hover:underline"
          >
            Edited
          </button>
        ) : null}
        {ask && !undelivered && (
          <span
            role="img"
            aria-label="Message accepted"
            title="Accepted by Neo. This does not mean work is complete."
            class="inline-flex self-center text-fg-faint"
          >
            <NeoIcon name="received" class="!h-3.5 !w-3.5" />
          </span>
        )}
        {ask && status && (
          <span
            data-message-status={status}
            title={NEO_MESSAGE_STATUS_TITLES[status]}
            class={`text-[11px] ${
              status === 'failed'
                ? 'text-danger'
                : status === 'disconnected' || status === 'stale'
                  ? 'text-warning'
                  : status === 'working'
                    ? 'text-accent'
                    : 'text-fg-faint'
            }`}
          >
            {NEO_MESSAGE_STATUS_LABELS[status]}
          </span>
        )}
        {undelivered && (
          <button
            type="button"
            aria-label={NOT_DELIVERED}
            title={NOT_DELIVERED}
            aria-expanded={showReason}
            onClick={() => setShowReason((shown) => !shown)}
            class="inline-flex self-center text-danger"
          >
            <NeoIcon name="alert" class="!h-3.5 !w-3.5" />
          </button>
        )}
      </div>
      {ask?.replyTo && (
        <button
          type="button"
          data-reply-to={`${ask.replyTo.kind}:${ask.replyTo.id}`}
          class="mb-1 block max-w-full truncate px-1 text-left text-xs text-fg-muted hover:underline"
          onClick={() =>
            document
              .getElementById(`neo-ref-${ask.replyTo!.kind}-${ask.replyTo!.id}`)
              ?.scrollIntoView({ block: 'center', behavior: 'smooth' })
          }
        >
          回复：{replyLabels?.get(`${ask.replyTo.kind}:${ask.replyTo.id}`) ?? '之前的内容'}
        </button>
      )}
      <div
        class={`neo-message-bubble rounded-2xl border px-4 py-3 ${ask ? 'rounded-tr-sm' : 'rounded-tl-sm'} ${undelivered ? '!border-danger' : ''}`}
      >
        {photos.length > 0 && (
          <div class="mb-3 flex flex-wrap gap-2">
            {photos.map((photo, index) =>
              photo.kind === 'ref' ? (
                <RefPhoto
                  key={photo.ref.imageId}
                  conversationId={ask!.conversationId}
                  photo={photo.ref}
                  label={`Attached photo ${index + 1}`}
                />
              ) : (
                <img
                  key={index}
                  src={photo.src}
                  alt={`Attached photo ${index + 1}`}
                  class="max-h-64 max-w-full rounded-xl object-contain"
                />
              )
            )}
          </div>
        )}
        {(() => {
          const body = /^[\s]*\d+[.)]?[\s]*$/.test(text) ? (
            <p class="whitespace-pre-wrap text-base leading-relaxed">{text}</p>
          ) : (
            <MarkdownRenderer
              content={text}
              class={`neo-markdown neo-markdown-${ask ? 'user' : 'assistant'} text-base leading-relaxed`}
            />
          );
          const chevron = hasDetails && (
            <button
              type="button"
              aria-expanded={expanded}
              aria-label={expanded ? 'Hide details' : 'Show details'}
              title={expanded ? 'Hide details' : 'Show details'}
              onClick={() => setExpanded(!expanded)}
              class="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-fill-soft text-fg-muted hover:text-fg"
            >
              <NeoIcon
                name="chevron"
                class={`!h-3.5 !w-3.5 transition-transform${expanded ? '' : ' rotate-180'}`}
              />
            </button>
          );
          return (
            <>
              {chevron && !links.length ? (
                <div class="flex items-end gap-2">
                  <div ref={bubbleText} class="min-w-0 flex-1">
                    {body}
                  </div>
                  {chevron}
                </div>
              ) : (
                <div ref={bubbleText}>{body}</div>
              )}
              {hasDetails && expanded && (
                <div
                  data-publication-details
                  class="mt-3 rounded-[10px] bg-fill-soft px-3 py-2 text-sm text-fg-muted"
                  style={{ '--prose-fg': 'var(--fg-muted)' }}
                >
                  <MarkdownRenderer
                    content={full}
                    class="neo-markdown neo-markdown-assistant text-sm leading-relaxed"
                  />
                </div>
              )}
              {publication && links.length > 0 && (
                <div class="mt-3 flex items-end gap-3">
                  <ul
                    aria-label="Related Neo scenes"
                    class="flex min-w-0 flex-1 flex-wrap gap-3 text-sm text-accent"
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
                  {chevron}
                </div>
              )}
            </>
          );
        })()}
      </div>
      {publication && history && (
        <NeoPublicationHistory publication={publication} id={`${anchor}-history`} />
      )}
      {undelivered && showReason && (
        <p class="mt-1 px-1 text-right text-xs text-danger">{NOT_DELIVERED}</p>
      )}
      <div class={`mt-1 flex items-center gap-3 ${ask ? 'justify-end' : ''}`}>
        {undelivered && onEditUndelivered && !restored && (
          <button
            type="button"
            aria-label="Edit and send again"
            title="Edit and send again"
            disabled={restoring}
            onClick={() => {
              const settle = (result: boolean | void) => {
                setRestoring(false);
                if (result === false) return;
                markRestored(ask!.requestId);
                setRestored(true);
              };
              const result = onEditUndelivered(ask!);
              if (!(result instanceof Promise)) return settle(result);
              setRestoring(true);
              void result.then(settle, () => settle(false));
            }}
            class="rounded-full p-1.5 text-fg-muted hover:bg-fill-soft hover:text-fg"
          >
            <NeoIcon name="edit" class="!h-4 !w-4" />
          </button>
        )}
        <CopyButton
          text={copyText}
          label={ask ? 'Copy your message' : 'Copy Neo’s message'}
          disabled={!text.trim()}
          copiedAt={copiedAt}
        />
        {onQuote && (ask ? text : full || text).trim() && (
          <button
            type="button"
            aria-label={ask ? 'Reply to your message' : 'Reply to Neo’s message'}
            title="Reply"
            class="rounded p-1.5 text-fg-muted transition-colors hover:bg-fill-strong hover:text-fg-soft focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
            onClick={() =>
              onQuote({ author: ask ? 'You' : 'Neo', text: ask ? text : full || text, anchor })
            }
          >
            <NeoIcon name="reply" class="!h-4 !w-4" />
          </button>
        )}
      </div>
      {menu.at && !!copyText.trim() && (
        <NeoMessageMenu
          at={menu.at}
          actions={neoMessageMenuActions({
            hasText: !!copyText.trim(),
            canShare: typeof navigator !== 'undefined' && typeof navigator.share === 'function',
            canReply: !!onQuote && !!copyText.trim(),
          })}
          onClose={menu.close}
          returnFocus={() => article.current}
          onPick={(action) =>
            ({
              select: () => {
                const target = bubbleText.current;
                if (target) window.getSelection()?.selectAllChildren(target);
              },
              copy: () =>
                void copyToClipboard(copyText).then((ok) => {
                  if (ok) setCopiedAt(Date.now());
                }),
              share: () => void navigator.share?.({ text: copyText }).catch(() => {}),
              reply: () => onQuote?.({ author: ask ? 'You' : 'Neo', text: copyText, anchor }),
            })[action]()
          }
        />
      )}
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
  statuses,
  onOpenScene,
  canOpenScene,
  onRetry,
  onLoadEarlier,
  onEditUndelivered,
  projects,
  forwarders,
  replyLabels,
  mute,
  onQuote,
}: {
  conversation: Conversation;
  replyLabels?: ReadonlyMap<string, string>;
  statuses?: ReadonlyMap<string, NeoMessageStatus>;
  onQuote?: (quote: NeoQuote) => void;
  mute?: NeoSessionMute;
  projects?: ReadonlyMap<string, string>;
  forwarders?: ReadonlyMap<string, string>;
  onOpenScene?: (ref: Pick<NeoPublicationLink, 'kind' | 'id'>) => void;
  canOpenScene?: (ref: Pick<NeoPublicationLink, 'kind' | 'id'>) => boolean;
  onEditUndelivered?: NeoEditUndelivered;
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
      {conversation.entries.map((entry) =>
        entry.kind === 'notices' ? (
          <NoticeRow key={entry.key} entryKey={entry.key} group={entry.group} mute={mute} />
        ) : (
          <PublicEntry
            key={entry.key}
            entry={entry}
            onOpenScene={onOpenScene}
            canOpenScene={canOpenScene}
            onEditUndelivered={onEditUndelivered}
            projects={projects}
            forwarders={forwarders}
            replyLabels={replyLabels}
            onQuote={onQuote}
            status={entry.kind === 'ask' ? statuses?.get(entry.ask.requestId) : undefined}
          />
        )
      )}
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
