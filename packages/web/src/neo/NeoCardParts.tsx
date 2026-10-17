export const neoCardClass = 'neo-arrive rounded-2xl border border-line bg-surface p-4 shadow-sm';

export const neoFooterClass = 'mt-3 flex flex-wrap items-center gap-2 border-t border-line pt-3';

export const neoSecondaryClass =
  'inline-flex shrink-0 items-center gap-1.5 rounded-lg border border-line px-2.5 py-1.5 text-xs font-semibold text-fg hover:border-accent/40 hover:text-accent focus-visible:outline-accent';

export const neoPrimaryClass =
  'inline-flex shrink-0 items-center gap-1.5 rounded-lg bg-accent-hover px-3 py-1.5 text-xs font-semibold text-accent-fg shadow-sm hover:shadow focus-visible:outline-accent disabled:cursor-not-allowed disabled:opacity-50';

export const neoPlainClass =
  'inline-flex shrink-0 items-center gap-1 rounded-lg px-2 py-1.5 text-xs font-medium text-fg-muted hover:bg-fill-soft hover:text-fg disabled:cursor-not-allowed disabled:opacity-50';

export function NeoMoreIcon() {
  return (
    <svg class="h-4 w-4" fill="currentColor" viewBox="0 0 24 24" aria-hidden="true">
      <circle cx="5" cy="12" r="1.75" />
      <circle cx="12" cy="12" r="1.75" />
      <circle cx="19" cy="12" r="1.75" />
    </svg>
  );
}
