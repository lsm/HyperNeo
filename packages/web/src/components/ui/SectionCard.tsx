/**
 * SectionCard — the rounded, bordered section wrapper with an uppercase label
 * header shared by the third-column inspect panels (task / goal / scope).
 *
 * Replaces the per-panel `PanelSection` / loose `<section>` re-implementations.
 * The label renders as an uppercase tracked heading; an optional `action` sits
 * flush-right on the same row (e.g. a count or inline control).
 */
import type { ComponentChildren } from 'preact';
import { cn } from '../../lib/utils';

export interface SectionCardProps {
  /** Uppercase section label. */
  title: ComponentChildren;
  /** Optional right-aligned content on the label row. */
  action?: ComponentChildren;
  /** Section body. */
  children?: ComponentChildren;
  /** Extra classes on the card wrapper. */
  class?: string;
  /** Extra classes on the body wrapper (defaults to `mt-3 space-y-3`). */
  bodyClass?: string;
}

export function SectionCard({
  title,
  action,
  children,
  class: className,
  bodyClass,
}: SectionCardProps) {
  return (
    <section class={cn('rounded-xl border border-white/10 bg-dark-900/50 p-4', className)}>
      <div class="flex items-center justify-between gap-3">
        <h3 class="text-xs font-semibold uppercase tracking-wide text-gray-400">{title}</h3>
        {action}
      </div>
      {children !== undefined && children !== null && (
        <div class={cn('mt-3 space-y-3', bodyClass)}>{children}</div>
      )}
    </section>
  );
}
