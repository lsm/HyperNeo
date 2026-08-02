/**
 * SectionCard — the rounded, bordered section wrapper with an uppercase label
 * header shared by the third-column inspect panels (task / goal / scope).
 *
 * Replaces the per-panel `PanelSection` / loose `<section>` re-implementations.
 */
import type { ComponentChildren } from 'preact';
import { cn } from '../../lib/utils';

export interface SectionCardProps {
  /** Uppercase section label. */
  title: ComponentChildren;
  /** Section body. */
  children?: ComponentChildren;
  /** Extra classes on the card wrapper. */
  class?: string;
}

export function SectionCard({ title, children, class: className }: SectionCardProps) {
  return (
    <section class={cn('rounded-xl border border-white/10 bg-dark-900/50 p-4', className)}>
      <h3 class="text-xs font-semibold uppercase tracking-wide text-gray-400">{title}</h3>
      {children !== undefined && children !== null && <div class="mt-3 space-y-3">{children}</div>}
    </section>
  );
}
