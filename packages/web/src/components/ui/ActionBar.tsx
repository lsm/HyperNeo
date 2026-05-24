import type { ComponentChildren } from 'preact';
import { cn } from '../../lib/utils.ts';
import { Button } from './Button';

type ActionBarType = 'review' | 'needs_attention' | 'confirm';

interface PrimaryAction {
  label: string;
  onClick: () => void | Promise<void>;
  loading?: boolean;
  variant?: 'approve' | 'primary' | 'danger';
}

interface SecondaryAction {
  label: string;
  onClick: () => void;
  disabled?: boolean;
}

export interface ActionBarProps {
  type: ActionBarType;
  title: ComponentChildren;
  description?: string;
  primaryAction: PrimaryAction;
  secondaryAction?: SecondaryAction;
  meta?: ComponentChildren;
}

const TYPE_STYLES: Record<ActionBarType, { border: string; bg: string; text: string }> = {
  review: {
    border: 'border-l-amber-500',
    bg: 'bg-amber-950/30',
    text: 'text-amber-400',
  },
  needs_attention: {
    border: 'border-l-red-500',
    bg: 'bg-red-950/30',
    text: 'text-red-400',
  },
  confirm: {
    border: 'border-l-blue-500',
    bg: 'bg-blue-950/30',
    text: 'text-blue-400',
  },
};

export function ActionBar({
  type,
  title,
  description,
  primaryAction,
  secondaryAction,
  meta,
}: ActionBarProps) {
  const styles = TYPE_STYLES[type];

  return (
    <div
      class={cn(
        'border-b border-dark-700 border-l-4 px-4 py-3 flex items-center justify-between flex-shrink-0',
        styles.border,
        styles.bg
      )}
      data-testid="action-bar"
    >
      <div class="flex-1 flex items-center gap-2 min-w-0">
        <span class={cn('text-sm font-medium', styles.text)}>{title}</span>
        {description && <span class="text-xs text-gray-400">{description}</span>}
        {meta}
      </div>
      <div class="flex items-center gap-2 ml-3 flex-shrink-0">
        {secondaryAction && (
          <Button
            variant="secondary"
            size="sm"
            onClick={secondaryAction.onClick}
            disabled={secondaryAction.disabled}
            data-testid="action-bar-secondary"
          >
            {secondaryAction.label}
          </Button>
        )}
        <Button
          variant={primaryAction.variant ?? 'primary'}
          size="sm"
          onClick={() => void primaryAction.onClick()}
          loading={primaryAction.loading}
          data-testid="action-bar-primary"
        >
          {primaryAction.label}
        </Button>
      </div>
    </div>
  );
}
