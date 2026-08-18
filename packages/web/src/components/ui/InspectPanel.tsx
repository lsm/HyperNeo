import type { ComponentChildren } from 'preact';
import { INDICATOR_TONES, type IndicatorTone } from '../../lib/indicator-tokens';
import { cn } from '../../lib/utils';

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
    <div class="relative flex h-[88px] flex-col justify-center bg-dark-900/30 px-5">
      <div class="pr-12">
        <div class="flex items-start justify-between gap-3">
          {title !== undefined && (
            <h2 class="min-w-0 flex-1 truncate text-base font-semibold leading-6 text-gray-100">
              {title}
            </h2>
          )}
          {actions}
        </div>
        {badges ? <div class="mt-2 flex flex-wrap items-center gap-2">{badges}</div> : null}
      </div>
      <div class="pointer-events-none absolute inset-x-0 bottom-0 h-px bg-dark-700" />
    </div>
  );
}

export function InspectBadge({
  tone,
  children,
  class: className,
}: {
  tone?: IndicatorTone;
  children: ComponentChildren;
  class?: string;
}) {
  return (
    <span
      class={cn(
        'inline-flex h-6 max-w-[11rem] items-center rounded-md border px-2 text-[11px] font-medium leading-none whitespace-nowrap',
        tone ? INDICATOR_TONES[tone].soft : undefined,
        className
      )}
    >
      <span class="truncate">{children}</span>
    </span>
  );
}
