/**
 * InlineStatusBanner — shared thin-banner primitive for task-pane status lines.
 *
 * Prior to this primitive, `PendingTaskCompletionBanner` and (in this PR)
 * `PendingPostApprovalBanner` each rolled their own one-line banner markup.
 * Extracting the shape lets new banners stay consistent and lets tests assert
 * structure instead of class strings.
 *
 * Tone palette matches existing banners:
 *   - `amber`  — awaiting approval / blocked on human
 *   - `blue`   — informational, in-progress
 *   - `green`  — success / positive
 *   - `purple` — gate / policy
 *   - `red`    — failure / error
 *   - `gray`   — inert
 *
 * Keep this primitive narrow: icon + label + optional meta + up to 3 actions.
 * Multi-line bodies, modals, and expandable sections belong in the caller.
 */

import type { ComponentChildren, JSX } from 'preact';

export type InlineStatusBannerTone = 'amber' | 'blue' | 'green' | 'purple' | 'red' | 'gray';

export interface InlineStatusBannerAction {
  /** Visible label. */
  label: string;
  /** Click handler. */
  onClick: () => void;
  /** Optional button variant. Defaults to `'secondary'`. */
  variant?: 'primary' | 'secondary' | 'danger';
  /** Optional test id. */
  testId?: string;
  /** Disabled state — e.g. while a request is in flight. */
  disabled?: boolean;
}

export interface InlineStatusBannerProps {
  /** Colour accent. */
  tone: InlineStatusBannerTone;
  /** Small leading icon — plain text/emoji (kept as ComponentChildren so
   *  consumers can pass JSX if needed). */
  icon?: ComponentChildren;
  /** Primary label. */
  label: ComponentChildren;
  /** Optional right-of-label meta (e.g. `"· 3m ago"`). */
  meta?: ComponentChildren;
  /** Up to 3 actions. Callers are responsible for truncating. */
  actions?: InlineStatusBannerAction[];
  /** Test id applied to the root. */
  testId?: string;
  /** Optional data-* attribute for test introspection. */
  dataAttrs?: Record<string, string>;
}

interface ToneClasses {
  text: string;
  meta: string;
}

const TONE_CLASSES: Record<InlineStatusBannerTone, ToneClasses> = {
  amber: { text: 'text-amber-400/90', meta: 'text-amber-400/60' },
  blue: { text: 'text-sky-300', meta: 'text-sky-300/60' },
  green: { text: 'text-green-300', meta: 'text-green-400/60' },
  purple: { text: 'text-purple-300', meta: 'text-purple-400/60' },
  red: { text: 'text-red-300', meta: 'text-red-400/60' },
  gray: { text: 'text-gray-300', meta: 'text-gray-400/60' },
};

const ACTION_VARIANT_CLASSES: Record<
  NonNullable<InlineStatusBannerAction['variant']>,
  Record<InlineStatusBannerTone, string>
> = {
  primary: {
    amber: 'bg-amber-900/40 text-amber-200 border border-amber-700/50 hover:bg-amber-800/50',
    blue: 'bg-sky-900/40 text-sky-200 border border-sky-700/50 hover:bg-sky-800/50',
    green: 'bg-green-900/40 text-green-200 border border-green-700/50 hover:bg-green-800/50',
    purple: 'bg-purple-900/40 text-purple-200 border border-purple-700/50 hover:bg-purple-800/50',
    red: 'bg-red-900/40 text-red-200 border border-red-700/50 hover:bg-red-800/50',
    gray: 'bg-gray-800/60 text-gray-200 border border-gray-700/50 hover:bg-gray-800/80',
  },
  secondary: {
    amber: 'bg-dark-700 text-amber-300 hover:bg-dark-600',
    blue: 'bg-dark-700 text-sky-300 hover:bg-dark-600',
    green: 'bg-dark-700 text-green-300 hover:bg-dark-600',
    purple: 'bg-dark-700 text-purple-300 hover:bg-dark-600',
    red: 'bg-dark-700 text-red-300 hover:bg-dark-600',
    gray: 'bg-dark-700 text-gray-300 hover:bg-dark-600',
  },
  danger: {
    amber: 'bg-red-900/40 text-red-300 border border-red-700/50 hover:bg-red-800/50',
    blue: 'bg-red-900/40 text-red-300 border border-red-700/50 hover:bg-red-800/50',
    green: 'bg-red-900/40 text-red-300 border border-red-700/50 hover:bg-red-800/50',
    purple: 'bg-red-900/40 text-red-300 border border-red-700/50 hover:bg-red-800/50',
    red: 'bg-red-900/40 text-red-300 border border-red-700/50 hover:bg-red-800/50',
    gray: 'bg-red-900/40 text-red-300 border border-red-700/50 hover:bg-red-800/50',
  },
};

/**
 * Render the one-line banner. Callers should cap `actions.length` at 3; this
 * component does not truncate silently.
 */
export function InlineStatusBanner({
  tone,
  icon,
  label,
  meta,
  actions,
  testId,
  dataAttrs,
}: InlineStatusBannerProps): JSX.Element {
  const tc = TONE_CLASSES[tone];
  const actionList = actions ?? [];
  return (
    <div
      class={`mx-4 mt-2 mb-2 flex items-center gap-2 px-2 py-1 rounded text-xs ${tc.text}`}
      data-testid={testId}
      data-tone={tone}
      {...(dataAttrs ?? {})}
    >
      {icon !== undefined && icon !== null ? (
        <span class="shrink-0" data-testid={testId ? `${testId}-icon` : undefined}>
          {icon}
        </span>
      ) : null}
      <span class="flex-1 min-w-0 truncate" data-testid={testId ? `${testId}-label` : undefined}>
        {label}
        {meta !== undefined && meta !== null ? (
          <span class={`${tc.meta} ml-1`} data-testid={testId ? `${testId}-meta` : undefined}>
            {meta}
          </span>
        ) : null}
      </span>
      {actionList.length > 0 ? (
        <div class="flex items-center gap-1 flex-shrink-0">
          {actionList.map((action, idx) => {
            const variant = action.variant ?? 'secondary';
            const variantClasses = ACTION_VARIANT_CLASSES[variant][tone];
            return (
              <button
                key={action.testId ?? `${action.label}-${idx}`}
                type="button"
                onClick={action.onClick}
                disabled={action.disabled}
                data-testid={action.testId}
                class={`px-2 py-0.5 text-xs font-medium rounded transition-colors disabled:opacity-50 disabled:cursor-not-allowed ${variantClasses}`}
              >
                {action.label}
              </button>
            );
          })}
        </div>
      ) : null}
    </div>
  );
}
