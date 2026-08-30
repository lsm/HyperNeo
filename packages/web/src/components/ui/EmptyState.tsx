import type { ComponentChildren, JSX } from 'preact';
import { cn } from '../../lib/utils';

export interface EmptyStateProps {
  icon?: (props: { class?: string }) => JSX.Element;
  title: string;
  description?: string;
  action?: { label: string; onClick: () => void };
  class?: string;
  children?: ComponentChildren;
}

export function EmptyState({
  icon: Icon,
  title,
  description,
  action,
  class: className,
  children,
}: EmptyStateProps) {
  return (
    <div class={cn('flex flex-col items-center justify-center py-12 text-center', className)}>
      {Icon && <Icon class="w-10 h-10 text-gray-700 mb-3" />}
      <p class="text-sm text-fg-muted font-medium">{title}</p>
      {description && <p class="text-xs text-fg-faint mt-1 max-w-xs">{description}</p>}
      {action && (
        <button
          type="button"
          onClick={action.onClick}
          class="mt-4 px-4 py-2 text-sm font-medium text-accent bg-accent/20 hover:bg-accent/30 border border-accent/40 rounded-lg transition-colors"
        >
          {action.label}
        </button>
      )}
      {children}
    </div>
  );
}
