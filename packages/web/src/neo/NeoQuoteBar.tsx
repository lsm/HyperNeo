import type { ComponentChildren } from 'preact';
import { t } from '../lib/i18n/index.ts';
import { NeoQuoteExcerpt } from './NeoQuoteExcerpt.tsx';

export function NeoQuoteBar({
  author,
  excerpt,
  labelId,
  onOpen,
  children,
}: {
  author?: 'You' | 'Neo';
  excerpt?: string;
  labelId?: string;
  onOpen?: () => void;
  children?: ComponentChildren;
}) {
  const name = author === 'You' ? t('chat.you') : author;
  const tappable = !!onOpen && excerpt !== undefined;
  const excerptBody =
    excerpt === undefined ? (
      <span class="line-clamp-2 block break-words text-sm italic text-fg-muted">
        {t('chat.originalUnavailable')}
      </span>
    ) : (
      <NeoQuoteExcerpt excerpt={excerpt} demoteLinks={tappable} />
    );
  const body = (
    <>
      <span
        aria-hidden="true"
        class={`w-[3px] self-stretch rounded-full ${
          excerpt === undefined
            ? 'bg-line-strong'
            : author === 'You'
              ? 'bg-[var(--neo-user-accent)]'
              : 'bg-accent'
        }`}
      />
      <span class="block min-w-0 flex-1">
        {name && (
          <span
            id={labelId}
            role={labelId ? 'status' : undefined}
            class="block text-xs font-medium text-fg-muted"
          >
            {name}
          </span>
        )}
        {excerptBody}
      </span>
    </>
  );
  const frame = 'mb-2 flex items-start gap-2.5 rounded-xl bg-surface py-1.5 pl-2.5';
  return tappable ? (
    <button
      type="button"
      data-quote-bar
      class={`${frame} w-full pr-2.5 text-left hover:bg-fill-soft focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent`}
      onClick={onOpen}
    >
      {body}
    </button>
  ) : (
    <div data-quote-bar class={`${frame} ${children ? '' : 'pr-2.5'}`}>
      {body}
      {children}
    </div>
  );
}
