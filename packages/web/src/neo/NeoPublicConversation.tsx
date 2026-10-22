import { NativeContentDisclosure } from '../components/ui/NativeContentDisclosure.tsx';
import { ContentDisclosureControl } from '../components/ui/ContentDisclosureControl.tsx';
import { NeoWakeRow } from './NeoWakeRow.tsx';
import type { NeoSessionMessage } from '@hyperneo/shared/types/neo-session-message';
import { useEffect, useMemo, useRef, useState } from 'preact/hooks';
import { previewReferenceCandidates } from '@hyperneo/shared/types/artifact-reference';
import type {
  NeoConversationAskPageItem,
  NeoConversationImageRef,
} from '@hyperneo/shared/types/neo-conversation-ask';
import type { NeoReplyTo } from '@hyperneo/shared/types/neo-ask';
import type { NeoSessionNoticeGroup } from '@hyperneo/shared/types/neo-snapshot';
import MarkdownRenderer from '../components/chat/MarkdownRenderer.tsx';
import { ArtifactCards } from '../components/artifacts/ArtifactCards.tsx';
import { openArtifactPreview } from '../lib/artifact-preview-store.ts';
import { CopyButton } from '../components/ui/CopyButton.tsx';
import { connectionManager } from '../lib/connection-manager.ts';
import { t } from '../lib/i18n/index.ts';
import { type NeoAskItem, readNeoConversationImage } from './conversation-ask-client.ts';
import { NeoIcon } from './NeoIcon.tsx';
import { NeoQuoteBar } from './NeoQuoteBar.tsx';
import { NeoClampedText } from './NeoClampedText.tsx';
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
import { neoAppLabel, neoSessionKind, neoSessionLink } from './work-driver.ts';
import { NeoSessionMark } from './NeoCardParts.tsx';
import {
  type NeoPendingAsk,
  type NeoQuote,
  neoPublicationQuoteExcerpt,
  neoQuoteExcerpt,
} from './neo-intake.ts';
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
        aria-label={t('chat.openNamed', { name: label.toLowerCase() })}
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
            {t('chat.photo')}
          </span>
        )}
        {loading && (
          <span
            role="status"
            aria-label={t('chat.loadingPhoto')}
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
          {t('chat.photoRetry')}
        </button>
      )}
    </div>
  );
}

export function neoMessageReplyLabels(
  entries: Conversation['entries']
): Map<string, { label: string; askId: string }> {
  return new Map(
    entries.flatMap((entry) =>
      entry.kind === 'ask'
        ? [
            [
              `message:${entry.ask.requestId}`,
              { label: neoQuoteExcerpt(publicAskText(entry.ask.content)), askId: '' },
            ] as const,
          ]
        : entry.kind === 'publication'
          ? [
              [
                `message:${entry.publication.publicationId}`,
                { label: neoPublicationQuoteExcerpt(entry.publication), askId: '' },
              ] as const,
            ]
          : []
    )
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

const NOTICES_SHOWN = 5;

export type NeoSessionMute = {
  muted: ReadonlySet<string>;
  onMute: (key: string, muted: boolean) => void;
};

function SessionMessageRow({
  entryKey,
  message,
}: {
  entryKey: string;
  message: NeoSessionMessage;
}) {
  const from = message.fromName ?? message.fromSession;
  const to = message.toName ?? message.toSession;
  const time = messageTime(message.createdAt);
  return (
    <NativeContentDisclosure
      data-public-entry={entryKey}
      label={t('chat.sessionMessageLabel', { from, to })}
      class="neo-arrive mx-auto max-w-[94%] text-xs text-fg-muted"
      summary={
        <span class="inline-flex max-w-full flex-wrap items-center gap-2">
          {time && (
            <time dateTime={time.iso} title={time.full} class="text-[11px] text-fg-faint">
              {time.label}
            </time>
          )}
          <span class="shrink-0 font-medium text-fg">{t('chat.sessionMessage', { from, to })}</span>
          <span class="min-w-0 truncate">{message.text.split('\n')[0]}</span>
        </span>
      }
    >
      {(control) => (
        <p class="flow-root whitespace-pre-wrap break-words px-3 pb-2 pt-1 text-fg">
          {message.text}
          {control}
        </p>
      )}
    </NativeContentDisclosure>
  );
}

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
                aria-label={t(mute.muted.has(notice.key) ? 'chat.unmuteNamed' : 'chat.muteNamed', {
                  name: notice.title,
                })}
                onClick={() => mute.onMute(notice.key, !mute.muted.has(notice.key))}
              >
                {t(mute.muted.has(notice.key) ? 'chat.unmute' : 'chat.mute')}
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
              {notice.worker?.label ?? `${neoAppLabel(notice.ref.adapter)} · ${notice.title}`}{' '}
              <span class={notice.kind === 'needs_you' ? 'font-medium text-fg' : ''}>
                {t(`chat.notice.${notice.kind}`)}
              </span>
            </span>
            {link ? (
              <a
                href={link}
                class="flex min-h-9 items-center gap-1.5 justify-self-end rounded-md px-3 text-accent hover:bg-fill-soft"
                aria-label={t('chat.openNamed', { name: notice.title })}
              >
                <NeoSessionMark kind={neoSessionKind(notice.ref.adapter, link)} />
                {t('todo.open')}
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
            {t('chat.more', { count: String(more) })}
          </button>
        </p>
      )}
    </div>
  );
}

const FLASH_MS = 1500;
const SEEK_PAGES = 9;

function flashMessage(target: Element) {
  const disclosure = target.closest('details');
  if (disclosure) disclosure.open = true;
  target.scrollIntoView({ block: 'center' });
  target.classList.remove('neo-message-flash');
  void (target as HTMLElement).offsetWidth;
  target.classList.add('neo-message-flash');
  setTimeout(() => target.classList.remove('neo-message-flash'), FLASH_MS);
}

function revealMessage(messageId: string): boolean {
  const target = document.querySelector(`[data-message-ref="${messageId}"]`);
  if (target) flashMessage(target);
  return !!target;
}

function ReplyQuote({
  replyTo,
  labels,
  onSeek,
}: {
  replyTo: NeoReplyTo;
  labels?: ReadonlyMap<string, { label: string; askId: string }>;
  onSeek?: (messageId: string) => void;
}) {
  const label = labels?.get(`${replyTo.kind}:${replyTo.id}`);
  if (replyTo.kind !== 'message') {
    const excerpt = label?.label ?? replyTo.excerpt;
    return (
      <NeoQuoteBar
        author={excerpt === undefined ? undefined : 'Neo'}
        excerpt={excerpt}
        onOpen={() =>
          (
            document.getElementById(`neo-ref-${replyTo.kind}-${replyTo.id}`) ??
            document.querySelector(`[data-ask="${label?.askId}"]`)
          )?.scrollIntoView({ block: 'center' })
        }
      />
    );
  }
  return (
    <NeoQuoteBar
      author={replyTo.author && (replyTo.author === 'user' ? 'You' : 'Neo')}
      excerpt={replyTo.excerpt ?? label?.label}
      onOpen={() => (onSeek ? onSeek(replyTo.id) : revealMessage(replyTo.id))}
    />
  );
}

function PublicEntry({
  entry,
  onEditUndelivered,
  replyLabels,
  onQuote,
  onSeek,
  status,
}: {
  entry: NeoPublicEntry;
  status?: NeoMessageStatus;
  onSeek?: (messageId: string) => void;
  replyLabels?: ReadonlyMap<string, { label: string; askId: string }>;
  onQuote?: (quote: NeoQuote) => void;
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
  const quoteText = publication ? neoPublicationQuoteExcerpt(publication) : text;
  const references = useMemo(
    () => ({
      text: publication ? previewReferenceCandidates(text).map((item) => item.reference) : [],
      full: publication ? previewReferenceCandidates(full).map((item) => item.reference) : [],
    }),
    [publication, text, full]
  );
  const openReference = publication
    ? (reference: string) =>
        openArtifactPreview({
          kind: 'reference',
          source: {
            kind: 'publication',
            id: publication.publicationId,
            ...(publication.revisionId ? { revisionId: publication.revisionId } : {}),
          },
          reference,
        })
    : undefined;
  const photos = ask ? publicAskPhotos(ask.content) : [];
  const time = messageTime((ask ?? publication)!.createdAt);
  const author = publication ? 'Neo' : t('chat.you');
  const notDelivered = t('chat.notDelivered');
  const links = publication?.links.filter((link) => link.kind === 'work') ?? [];
  const anchor = ask
    ? neoMessageAnchor(ask.askOrigin.sessionId, ask.askOrigin.messageId)
    : publication
      ? neoMessageAnchor(publication.conversationId, `publication-${publication.publicationId}`)
      : '';
  const messageId = ask?.requestId ?? publication?.publicationId ?? '';
  const replyTo = { kind: 'message' as const, id: messageId };
  return (
    <article
      ref={article}
      tabIndex={-1}
      id={anchor || undefined}
      data-message-ref={messageId || undefined}
      data-public-entry={entry.key}
      class={`neo-arrive neo-message w-fit break-words focus:outline-none ${ask ? 'neo-message-user ml-auto max-w-[88%]' : 'neo-message-assistant mr-auto max-w-[94%] max-md:w-full max-md:max-w-full'}`}
      {...(copyText.trim() ? menu.bind : {})}
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
        {publication && (publication.editedAt || publication.revisions?.length) ? (
          <span data-publication-edited class="text-[11px] text-fg-faint">
            {t('chat.edited')}
          </span>
        ) : null}
        {ask && !undelivered && (
          <span
            role="img"
            aria-label={t('chat.accepted')}
            title={t('chat.acceptedTitle')}
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
          <span
            role="img"
            aria-label={notDelivered}
            title={notDelivered}
            class="inline-flex self-center text-danger"
          >
            <NeoIcon name="alert" class="!h-3.5 !w-3.5" />
          </span>
        )}
      </div>
      <div
        class={`neo-message-bubble rounded-2xl border px-4 py-3 ${ask ? 'rounded-tr-sm' : 'rounded-tl-sm'} ${undelivered ? '!border-danger' : ''}`}
      >
        {ask?.replyTo && (
          <div data-reply-to={`${ask.replyTo.kind}:${ask.replyTo.id}`}>
            <ReplyQuote replyTo={ask.replyTo} labels={replyLabels} onSeek={onSeek} />
          </div>
        )}
        {photos.length > 0 && (
          <div class="mb-3 flex flex-wrap gap-2">
            {photos.map((photo, index) =>
              photo.kind === 'ref' ? (
                <RefPhoto
                  key={photo.ref.imageId}
                  conversationId={ask!.conversationId}
                  photo={photo.ref}
                  label={t('chat.attachedPhoto', { n: String(index + 1) })}
                />
              ) : (
                <img
                  key={index}
                  src={photo.src}
                  alt={t('chat.attachedPhoto', { n: String(index + 1) })}
                  class="max-h-64 max-w-full rounded-xl object-contain"
                />
              )
            )}
          </div>
        )}
        {(() => {
          const fold = (
            <ContentDisclosureControl expanded={expanded} onToggle={() => setExpanded(!expanded)} />
          );
          const more = hasDetails && !expanded ? fold : undefined;
          const body = /^[\s]*\d+[.)]?[\s]*$/.test(text) ? (
            <p class="whitespace-pre-wrap text-base leading-relaxed">
              {text}
              {more}
            </p>
          ) : (
            <MarkdownRenderer
              content={text}
              trailing={more}
              references={references.text}
              onReference={openReference}
              class={`neo-markdown neo-markdown-${ask ? 'user' : 'assistant'} text-base leading-relaxed`}
            />
          );
          return (
            <>
              <div ref={bubbleText}>
                {ask ? <NeoClampedText text={text}>{body}</NeoClampedText> : body}
              </div>
              {hasDetails && expanded && (
                <div
                  data-publication-details
                  class="mt-3 rounded-[10px] bg-fill-soft px-3 pt-1 pb-2 text-sm text-fg-muted"
                  style={{ '--prose-fg': 'var(--fg-muted)' }}
                >
                  <div class="-mr-2 mb-1 flex items-center justify-between">
                    <span class="text-xs text-fg-faint">{t('ask.details')}</span>
                    <CopyButton text={full} label={t('chat.copyDetails')} />
                  </div>
                  <MarkdownRenderer
                    content={full}
                    trailing={fold}
                    references={references.full}
                    onReference={openReference}
                    class="neo-markdown neo-markdown-assistant text-sm leading-relaxed"
                  />
                </div>
              )}
              {publication && <ArtifactCards artifacts={publication.artifacts} />}
              {publication && links.length > 0 && (
                <ul
                  aria-label={t('chat.scenes')}
                  class="mt-3 flex flex-wrap gap-3 text-sm text-accent"
                >
                  {links.map((link) => (
                    <li key={JSON.stringify([link.kind, link.id])}>
                      <span>{link.label}</span>
                    </li>
                  ))}
                </ul>
              )}
            </>
          );
        })()}
      </div>
      {publication && (publication.editedAt || publication.revisions?.length) ? (
        <div class="flow-root mt-1">
          {history && <NeoPublicationHistory publication={publication} id={`${anchor}-history`} />}
          <ContentDisclosureControl
            expanded={history}
            onToggle={() => setHistory(!history)}
            aria-label={t('chat.editedHistory')}
            aria-controls={`${anchor}-history`}
          />
        </div>
      ) : null}
      {undelivered && (
        <div class="flow-root mt-1 px-1 text-xs text-danger">
          {showReason && <span>{notDelivered}</span>}
          <ContentDisclosureControl
            expanded={showReason}
            onToggle={() => setShowReason(!showReason)}
            aria-label={notDelivered}
          />
        </div>
      )}
      <div class={`mt-1 flex items-center gap-3 ${ask ? 'justify-end' : ''}`}>
        {undelivered && onEditUndelivered && !restored && (
          <button
            type="button"
            aria-label={t('chat.editResend')}
            title={t('chat.editResend')}
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
          label={t(ask ? 'chat.copyYours' : 'chat.copyNeo')}
          disabled={!text.trim()}
          copiedAt={copiedAt}
        />
        {onQuote && quoteText.trim() && (
          <button
            type="button"
            aria-label={t(ask ? 'chat.replyYours' : 'chat.replyNeo')}
            title={t('chat.reply')}
            class="rounded p-1.5 text-fg-muted transition-colors hover:bg-fill-strong hover:text-fg-soft focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
            onClick={() =>
              onQuote({
                author: ask ? 'You' : 'Neo',
                text: quoteText,
                anchor,
                replyTo,
              })
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
              reply: () =>
                onQuote?.({ author: ask ? 'You' : 'Neo', text: quoteText, anchor, replyTo }),
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
  const notSent = ask.reason ? t('chat.notSentReason', { reason: ask.reason }) : t('chat.notSent');
  return (
    <article
      data-pending-ask={ask.requestId}
      class="neo-arrive neo-message neo-message-user ml-auto w-fit max-w-[88%] break-words"
    >
      <div class="mb-2 flex flex-wrap items-baseline justify-end gap-x-2 px-1 text-xs">
        <span class="neo-message-name font-medium">{t('chat.you')}</span>
        {time && (
          <time dateTime={time.iso} title={time.full} class="neo-message-time text-[11px]">
            {time.label}
          </time>
        )}
        {ask.state === 'sending' && (
          <span
            role="img"
            aria-label={t('chat.sending')}
            title={t('chat.sending')}
            class="inline-block h-3 w-3 animate-spin self-center rounded-full border-[1.5px] border-current border-t-transparent text-fg-faint"
          />
        )}
        {ask.state === 'accepted' && (
          <span
            role="img"
            aria-label={t('chat.accepted')}
            title={t('chat.acceptedTitle')}
            class="inline-flex self-center text-fg-faint"
          >
            <NeoIcon name="received" class="!h-3.5 !w-3.5" />
          </span>
        )}
        {failed && (
          <span
            role="img"
            aria-label={notSent}
            title={notSent}
            class="inline-flex self-center text-danger"
          >
            <NeoIcon name="alert" class="!h-3.5 !w-3.5" />
          </span>
        )}
      </div>
      <div
        class={`neo-message-bubble rounded-2xl rounded-tr-sm border px-4 py-3 ${failed ? '!border-danger' : ''}`}
      >
        {ask.quote && (
          <NeoQuoteBar
            author={ask.quote.author}
            excerpt={neoQuoteExcerpt(ask.quote.text)}
            onOpen={() => {
              const target = document.getElementById(ask.quote!.anchor);
              if (target) flashMessage(target);
            }}
          />
        )}
        {ask.images.length > 0 && (
          <div class="mb-3 flex flex-wrap gap-2">
            {ask.images.map((image, index) => (
              <img
                key={index}
                src={`data:${image.media_type};base64,${image.data}`}
                alt={t('chat.attachedPhoto', { n: String(index + 1) })}
                class="max-h-64 max-w-full rounded-xl object-contain"
              />
            ))}
          </div>
        )}
        <NeoClampedText text={ask.text}>
          <p class="whitespace-pre-wrap text-base leading-relaxed">{ask.text}</p>
        </NeoClampedText>
      </div>
      {failed && (
        <div class="flow-root mt-1 px-1 text-xs text-danger">
          {showReason && <span>{notSent}</span>}
          <ContentDisclosureControl
            expanded={showReason}
            onToggle={() => setShowReason(!showReason)}
            aria-label={notSent}
          />
        </div>
      )}
      {failed && (
        <div class="mt-1 flex items-center justify-end gap-1">
          <button
            type="button"
            aria-label={t('chat.retry')}
            title={t('chat.retry')}
            onClick={() => onRetry?.(ask.requestId)}
            class="rounded-full p-1.5 text-fg-muted hover:bg-fill-soft hover:text-fg"
          >
            <NeoIcon name="retry" class="!h-4 !w-4" />
          </button>
          <button
            type="button"
            aria-label={t('chat.edit')}
            title={t('chat.edit')}
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
  onRetry,
  onLoadEarlier,
  onOpenWork,
  onEditUndelivered,
  replyLabels,
  mute,
  onQuote,
}: {
  conversation: Conversation;
  replyLabels?: ReadonlyMap<string, { label: string; askId: string }>;
  statuses?: ReadonlyMap<string, NeoMessageStatus>;
  onQuote?: (quote: NeoQuote) => void;
  mute?: NeoSessionMute;
  onEditUndelivered?: NeoEditUndelivered;
  onRetry?: () => void;
  onLoadEarlier?: () => void;
  onOpenWork?: (anchor: string) => void;
}) {
  const wakeFor = (id: string) =>
    conversation.entries.find(
      (entry) =>
        entry.kind === 'wake' &&
        entry.wake.additions.some((item) => item.kind === 'publication' && item.id === id)
    );
  const labels = new Map([...neoMessageReplyLabels(conversation.entries), ...(replyLabels ?? [])]);
  const [seeking, setSeeking] = useState<string | null>(null);
  const seekPages = useRef(0);
  useEffect(() => setSeeking(null), [conversation.conversationId]);
  const canLoadEarlier = conversation.hasEarlier && !!onLoadEarlier;
  useEffect(() => {
    if (!seeking || conversation.status !== 'ready') return;
    const timer = setTimeout(() => {
      if (revealMessage(seeking) || !canLoadEarlier || seekPages.current >= SEEK_PAGES)
        return setSeeking(null);
      seekPages.current += 1;
      onLoadEarlier?.();
    });
    return () => clearTimeout(timer);
  }, [seeking, conversation.entries, conversation.status, canLoadEarlier]);
  const seek = (messageId: string) => {
    if (revealMessage(messageId) || !canLoadEarlier) return setSeeking(null);
    seekPages.current = 0;
    setSeeking(messageId);
  };
  return (
    <div class="space-y-6" aria-label={t('chat.public')}>
      {conversation.status !== 'ready' && (
        <p role="status" class="text-sm text-fg-muted">
          {conversation.status === 'loading'
            ? t('chat.loading')
            : t(conversation.entries.length > 0 ? 'chat.unavailableRetained' : 'chat.unavailable')}
        </p>
      )}
      {conversation.status === 'unavailable' && onRetry && (
        <button type="button" class="text-sm text-accent hover:underline" onClick={onRetry}>
          {t('chat.retryLoad')}
        </button>
      )}
      {(conversation.hasEarlier || conversation.hasMore) && (
        <p class="text-xs text-fg-muted">{t('chat.partial')}</p>
      )}
      {conversation.hasEarlier && onLoadEarlier && (
        <button
          type="button"
          class="text-sm text-accent hover:underline"
          disabled={conversation.status !== 'ready'}
          onClick={onLoadEarlier}
        >
          {t('chat.loadEarlier')}
        </button>
      )}
      {conversation.entries.map((entry) =>
        entry.kind === 'publication' &&
        wakeFor(entry.publication.publicationId) ? null : entry.kind === 'wake' ? (
          <NeoWakeRow
            key={entry.key}
            entryKey={entry.key}
            wake={entry.wake}
            conversationId={conversation.conversationId!}
            onOpenWork={onOpenWork}
          >
            {conversation.entries
              .filter(
                (item) =>
                  item.kind === 'publication' && wakeFor(item.publication.publicationId) === entry
              )
              .map(
                (item) =>
                  item.kind === 'publication' && (
                    <PublicEntry
                      key={item.key}
                      entry={item}
                      replyLabels={labels}
                      onSeek={seek}
                      onQuote={onQuote}
                    />
                  )
              )}
          </NeoWakeRow>
        ) : entry.kind === 'notices' ? (
          <NoticeRow key={entry.key} entryKey={entry.key} group={entry.group} mute={mute} />
        ) : entry.kind === 'session' ? (
          <SessionMessageRow key={entry.key} entryKey={entry.key} message={entry.message} />
        ) : (
          <PublicEntry
            key={entry.key}
            entry={entry}
            onEditUndelivered={onEditUndelivered}
            replyLabels={labels}
            onSeek={seek}
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
          {t('chat.loadMore')}
        </button>
      )}
    </div>
  );
}
