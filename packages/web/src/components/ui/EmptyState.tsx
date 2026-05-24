/**
 * EmptyState — Unified empty state for lists, sections, and panels.
 *
 * Usage:
 *   <EmptyState icon={ClipboardIcon} title="No tasks yet" description="Create a mission to get started" />
 *   <EmptyState title="Nothing here" action={{ label: "Create", onClick: handleCreate }} />
 */

import type { ComponentChildren, JSX } from 'preact';
import { cn } from '../../lib/utils';

export interface EmptyStateProps {
  /** SVG icon rendered at 40×40 in muted gray */
  icon?: (props: { class?: string }) => JSX.Element;
  /** Primary message */
  title: string;
  /** Optional secondary text */
  description?: string;
  /** Optional call-to-action button */
  action?: { label: string; onClick: () => void };
  /** Extra classes on the wrapper */
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
      <p class="text-sm text-gray-400 font-medium">{title}</p>
      {description && <p class="text-xs text-gray-600 mt-1 max-w-xs">{description}</p>}
      {action && (
        <button
          type="button"
          onClick={action.onClick}
          class="mt-4 px-4 py-2 text-sm font-medium text-blue-400 bg-blue-900/20 hover:bg-blue-900/30 border border-blue-700/40 rounded-lg transition-colors"
        >
          {action.label}
        </button>
      )}
      {children}
    </div>
  );
}
