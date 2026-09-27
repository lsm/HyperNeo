import { useState } from 'preact/hooks';
import type { ComponentChildren } from 'preact';

export interface CollapsibleSectionProps {
  title: string;
  count?: number;
  defaultExpanded?: boolean;
  headerRight?: ComponentChildren;
  children: ComponentChildren;
}

export function CollapsibleSection({
  title,
  count,
  defaultExpanded = true,
  headerRight,
  children,
}: CollapsibleSectionProps) {
  const [expanded, setExpanded] = useState(defaultExpanded);

  return (
    <div class="collapsible-section mb-4 last:mb-0">
      <div class="flex min-h-[30px] items-center justify-between gap-1 px-2.5 pb-[7px] pt-2.5">
        <button
          type="button"
          class="flex min-w-0 flex-1 items-center gap-1.5 rounded-md text-[11px] font-bold uppercase tracking-[0.08em] text-[var(--sidebar-row-muted)] transition-colors hover:text-[var(--sidebar-row-fg)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/60"
          aria-expanded={expanded}
          aria-label={`${title} section`}
          onClick={() => setExpanded(!expanded)}
        >
          <svg
            class={`h-3 w-3 shrink-0 transition-transform ${expanded ? 'rotate-90' : ''}`}
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            aria-hidden="true"
          >
            <path
              d="m9 5 7 7-7 7"
              stroke-width={2}
              stroke-linecap="round"
              stroke-linejoin="round"
            />
          </svg>
          <span class="truncate">{title}</span>
          {count != null && (
            <span class="ml-auto text-[11px] font-normal tracking-normal tabular-nums text-[var(--sidebar-row-faint)]">
              {count}
            </span>
          )}
        </button>
        {headerRight && (
          <div class="flex items-center" onClick={() => setExpanded(true)}>
            {headerRight}
          </div>
        )}
      </div>
      {expanded && <div class="collapsible-section-body px-2">{children}</div>}
    </div>
  );
}
