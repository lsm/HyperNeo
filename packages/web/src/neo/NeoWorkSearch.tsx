import { useEffect, useRef } from 'preact/hooks';
import { t } from '../lib/i18n/index.ts';
import { NeoIcon } from './NeoIcon.tsx';

export const WORK_SEARCH_TRIGGER = 'neo-work-search-trigger';

export function NeoWorkSearchButton({ onOpen }: { onOpen: () => void }) {
  return (
    <button
      id={WORK_SEARCH_TRIGGER}
      type="button"
      class="flex h-9 w-9 items-center justify-center rounded-full text-fg-muted hover:text-fg active:bg-fill-strong"
      aria-label={t('live.searchWork')}
      aria-expanded={false}
      onClick={onOpen}
    >
      <NeoIcon name="search" class="!h-4 !w-4" />
    </button>
  );
}

export function NeoWorkSearch({
  query,
  onQuery,
  onClose,
}: {
  query: string;
  onQuery: (value: string) => void;
  onClose: () => void;
}) {
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => input.current?.focus(), []);
  return (
    <div class="mt-3 flex items-center gap-2 rounded-full bg-fill-soft px-3">
      <NeoIcon name="search" class="!h-4 !w-4 shrink-0 text-fg-muted" />
      <input
        ref={input}
        type="search"
        value={query}
        aria-label={t('live.searchWork')}
        placeholder={t('live.searchWork')}
        onInput={(event) => onQuery(event.currentTarget.value)}
        onKeyDown={(event) => {
          if (event.key === 'Escape') {
            event.preventDefault();
            if (event.isComposing || event.keyCode === 229) return;
            event.stopPropagation();
            onClose();
          }
        }}
        class="min-w-0 flex-1 bg-transparent py-2 text-sm text-fg outline-none [&::-webkit-search-cancel-button]:appearance-none"
      />
      <button
        type="button"
        class="-mr-1 flex h-8 w-8 shrink-0 items-center justify-center rounded-full text-fg-muted hover:text-fg"
        aria-label={t('live.closeSearch')}
        onClick={onClose}
      >
        <NeoIcon name="close" class="!h-4 !w-4" />
      </button>
    </div>
  );
}
