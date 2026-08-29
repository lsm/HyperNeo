import type { ComponentChildren } from 'preact';
import { cn } from '../../lib/utils';

export interface SectionCardProps {
  title: ComponentChildren;
  children?: ComponentChildren;
  class?: string;
}

export function SectionCard({ title, children, class: className }: SectionCardProps) {
  return (
    <section class={cn('rounded-xl border border-line bg-surface/50 p-4', className)}>
      <h3 class="text-xs font-semibold uppercase tracking-wide text-fg-muted">{title}</h3>
      {children !== undefined && children !== null && <div class="mt-3 space-y-3">{children}</div>}
    </section>
  );
}
