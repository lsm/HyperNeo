import { useEffect, useRef, useState } from 'preact/hooks';
import { t } from '../lib/i18n/index.ts';
import { NeoIcon } from './NeoIcon.tsx';

export function NeoWorkSearch({
  query,
  onQuery,
}: {
  query: string;
  onQuery: (value: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const input = useRef<HTMLInputElement>(null),
    trigger = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (open) input.current?.focus();
  }, [open]);
  const close = () => {
    onQuery('');
    setOpen(false);
    requestAnimationFrame(() => trigger.current?.focus());
  };
  return (
    <div
      class={`mt-4 flex items-center gap-2 overflow-hidden rounded-full bg-fill-soft transition-[width] ${open ? 'w-full px-3' : 'w-11'}`}
    >
      <button
        ref={trigger}
        type="button"
        class="flex h-11 w-11 shrink-0 items-center justify-center rounded-full text-fg-muted active:bg-fill-strong"
        aria-label={t(open ? 'live.closeSearch' : 'live.searchWork')}
        aria-expanded={open}
        onClick={() => (open ? close() : setOpen(true))}
      >
        <NeoIcon name={open ? 'close' : 'search'} class="!h-4 !w-4" />
      </button>
      {open && (
        <input
          ref={input}
          type="search"
          value={query}
          aria-label={t('live.searchWork')}
          placeholder={t('live.searchWork')}
          onInput={(event) => onQuery(event.currentTarget.value)}
          onKeyDown={(event) => {
            if (event.key === 'Escape') {
              event.stopPropagation();
              close();
            }
          }}
          class="min-w-0 flex-1 bg-transparent py-2 text-sm text-fg outline-none"
        />
      )}
    </div>
  );
}
