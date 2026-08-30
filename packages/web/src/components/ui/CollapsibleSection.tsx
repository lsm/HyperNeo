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
    <div class="collapsible-section">
      <div class="flex items-center justify-between px-3 py-2 hover:bg-surface-raised transition-colors">
        <button
          type="button"
          class="flex items-center gap-1.5 flex-1 min-w-0"
          aria-expanded={expanded}
          aria-label={`${title} section`}
          onClick={() => setExpanded(!expanded)}
        >
          <span class="text-fg-faint text-[10px] leading-none">{expanded ? '▼' : '▶'}</span>
          <span class="text-xs font-semibold text-fg-faint uppercase tracking-wider">{title}</span>
          {count != null && <span class="text-xs text-fg-faint ml-0.5">({count})</span>}
        </button>
        {headerRight && <div class="flex items-center">{headerRight}</div>}
      </div>
      {expanded && <div class="collapsible-section-body">{children}</div>}
    </div>
  );
}
