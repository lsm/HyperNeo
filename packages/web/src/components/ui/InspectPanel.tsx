/**
 * InspectPanel — shared inner chrome for the third-column inspect panels
 * (git / task / goal / scope).
 *
 * The OUTER shell (container, rounded-l border, resize handle, width
 * persistence, open/close transitions) lives in `RightPanel`. This is the
 * INNER chrome every panel fills: an outer column shell, a sticky 88px detail
 * header, and the rectangular header badge — previously re-implemented per
 * panel.
 */
import type { ComponentChildren } from 'preact';
import { INDICATOR_TONES, type IndicatorTone } from '../../lib/indicator-tokens';
import { cn } from '../../lib/utils';

/**
 * Outer column shell shared by every inspect panel. Renders the `header` slot
 * followed by the `children` (scroll body). When `emptyState` is provided it
 * replaces both — used for the not-found / loading surfaces that fill the panel
 * without a header.
 */
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

/**
 * Sticky 88px detail header: a title row (with optional inline `actions`) over
 * a `badges` row. `pr-12` keeps content clear of the floating right-panel
 * toggle; the bottom hairline separates header from the scroll body.
 *
 * Pass `title` for a plain truncated heading, or `titleNode` when the title
 * needs inline elements of its own.
 */
export function InspectPanelHeader({
  title,
  titleNode,
  actions,
  badges,
}: {
  title?: ComponentChildren;
  titleNode?: ComponentChildren;
  actions?: ComponentChildren;
  badges?: ComponentChildren;
}) {
  return (
    <div class="relative flex h-[88px] flex-col justify-center bg-dark-900/30 px-5">
      <div class="pr-12">
        <div class="flex items-start justify-between gap-3">
          {titleNode ??
            (title !== undefined && (
              <h2 class="min-w-0 flex-1 truncate text-base font-semibold leading-6 text-gray-100">
                {title}
              </h2>
            ))}
          {actions}
        </div>
        {badges ? <div class="mt-2 flex flex-wrap items-center gap-2">{badges}</div> : null}
      </div>
      <div class="pointer-events-none absolute inset-x-0 bottom-0 h-px bg-dark-700" />
    </div>
  );
}

/**
 * Rectangular header badge (rounded-md, h-6) driven by an indicator tone.
 * Drop-in for the per-panel `TaskPanelBadge` / `GoalPanelBadge`. Omit `tone`
 * and pass `class` for a bespoke soft style (e.g. the mono task-number chip).
 */
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
