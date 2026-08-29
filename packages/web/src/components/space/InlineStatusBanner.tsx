import type { ComponentChildren, JSX } from 'preact';

export type InlineStatusBannerTone = 'amber' | 'blue' | 'green' | 'purple' | 'red' | 'gray';

export interface InlineStatusBannerAction {
  label: string;
  onClick: () => void;
  variant?: 'primary' | 'secondary' | 'danger';
  testId?: string;
  disabled?: boolean;
}

export interface InlineStatusBannerProps {
  tone: InlineStatusBannerTone;
  icon?: ComponentChildren;
  label: ComponentChildren;
  meta?: ComponentChildren;
  actions?: InlineStatusBannerAction[];
  testId?: string;
  dataAttrs?: Record<string, string>;
}

interface ToneClasses {
  text: string;
  meta: string;
}

const TONE_CLASSES: Record<InlineStatusBannerTone, ToneClasses> = {
  amber: { text: 'text-warning/90', meta: 'text-warning/60' },
  blue: { text: 'text-info-soft', meta: 'text-info-soft/60' },
  green: { text: 'text-success-soft', meta: 'text-success/60' },
  purple: { text: 'text-cat-purple', meta: 'text-cat-purple/60' },
  red: { text: 'text-danger-soft', meta: 'text-danger/60' },
  gray: { text: 'text-fg-soft', meta: 'text-fg-muted/60' },
};

const ACTION_VARIANT_CLASSES: Record<
  NonNullable<InlineStatusBannerAction['variant']>,
  Record<InlineStatusBannerTone, string>
> = {
  primary: {
    amber: 'bg-warning/15 text-warning-soft border border-warning/40 hover:bg-warning/25',
    blue: 'bg-info/15 text-info-soft border border-info/40 hover:bg-info/25',
    green: 'bg-success/15 text-success-soft border border-success/40 hover:bg-success/25',
    purple: 'bg-cat-purple/15 text-cat-purple border border-cat-purple/40 hover:bg-cat-purple/25',
    red: 'bg-danger/15 text-danger-soft border border-danger/40 hover:bg-danger/25',
    gray: 'bg-surface-raised/60 text-fg-soft border border-line/50 hover:bg-surface-raised/80',
  },
  secondary: {
    amber: 'bg-fill-strong text-warning hover:bg-line-strong',
    blue: 'bg-fill-strong text-info-soft hover:bg-line-strong',
    green: 'bg-fill-strong text-success-soft hover:bg-line-strong',
    purple: 'bg-fill-strong text-cat-purple hover:bg-line-strong',
    red: 'bg-fill-strong text-danger-soft hover:bg-line-strong',
    gray: 'bg-fill-strong text-fg-soft hover:bg-line-strong',
  },
  danger: {
    amber: 'bg-danger/40 text-danger-soft border border-danger/50 hover:bg-danger/50',
    blue: 'bg-danger/40 text-danger-soft border border-danger/50 hover:bg-danger/50',
    green: 'bg-danger/40 text-danger-soft border border-danger/50 hover:bg-danger/50',
    purple: 'bg-danger/40 text-danger-soft border border-danger/50 hover:bg-danger/50',
    red: 'bg-danger/40 text-danger-soft border border-danger/50 hover:bg-danger/50',
    gray: 'bg-danger/40 text-danger-soft border border-danger/50 hover:bg-danger/50',
  },
};

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
