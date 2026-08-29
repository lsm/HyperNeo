import type { ComponentChildren } from 'preact';
import { cn } from '../../lib/utils';

type InspectBadgeTone =
  | 'neutral'
  | 'info'
  | 'progress'
  | 'success'
  | 'warning'
  | 'danger'
  | 'special';

const toneSoftClasses: Record<InspectBadgeTone, string> = {
  neutral: 'border-fg-faint/30 bg-fg-faint/10 text-fg-muted',
  info: 'border-accent/30 bg-accent/10 text-accent-soft',
  progress: 'border-warning/30 bg-warning/10 text-warning-soft',
  success: 'border-success/30 bg-success/10 text-success-soft',
  warning: 'border-warning/30 bg-warning/10 text-warning-soft',
  danger: 'border-danger/30 bg-danger/10 text-danger-soft',
  special: 'border-cat-purple/30 bg-cat-purple/10 text-cat-purple',
};

export function InspectPanel({
  header,
  children,
  emptyState,
}: {
  header?: ComponentChildren;
  children?: ComponentChildren;
  emptyState?: ComponentChildren;
}) {
  return (
    <div class="flex h-full min-w-0 flex-col overflow-hidden">
      {emptyState ? (
        emptyState
      ) : (
        <>
          {header}
          {children}
        </>
      )}
    </div>
  );
}

export function InspectPanelHeader({
  title,
  actions,
  badges,
}: {
  title?: ComponentChildren;
  actions?: ComponentChildren;
  badges?: ComponentChildren;
}) {
  return (
    <div class="relative flex h-[88px] flex-col justify-center bg-surface/30 px-5">
      <div class="pr-12">
        <div class="flex items-start justify-between gap-3">
          {title !== undefined && (
            <h2 class="min-w-0 flex-1 truncate text-base font-semibold leading-6 text-fg">
              {title}
            </h2>
          )}
          {actions}
        </div>
        {badges ? <div class="mt-2 flex flex-wrap items-center gap-2">{badges}</div> : null}
      </div>
      <div class="pointer-events-none absolute inset-x-0 bottom-0 h-px bg-fill-strong" />
    </div>
  );
}

export function InspectBadge({
  tone,
  children,
  class: className,
}: {
  tone?: InspectBadgeTone;
  children: ComponentChildren;
  class?: string;
}) {
  return (
    <span
      class={cn(
        'inline-flex h-6 max-w-[11rem] items-center rounded-md border px-2 text-[11px] font-medium leading-none whitespace-nowrap',
        tone ? toneSoftClasses[tone] : undefined,
        className
      )}
    >
      <span class="truncate">{children}</span>
    </span>
  );
}
