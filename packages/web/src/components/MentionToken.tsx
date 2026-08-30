import { useId, useState } from 'preact/hooks';
import { cn } from '../lib/utils.ts';
import type { ReferenceMention, ReferenceMetadata, ReferenceType } from '@hyperneo/shared';
import ReferenceTypeIcon from './ReferenceTypeIcon.tsx';

export interface MentionTokenProps {
  mention: ReferenceMention;
  metadata?: ReferenceMetadata;
  onClick?: () => void;
}

const TYPE_STYLES: Record<ReferenceType, { container: string; icon: string; label: string }> = {
  task: {
    container: 'bg-accent/15 text-accent-soft hover:bg-accent/25',
    icon: 'w-3 h-3 text-accent',
    label: 'task',
  },
  goal: {
    container: 'bg-cat-purple/15 text-cat-purple hover:bg-cat-purple/25',
    icon: 'w-3 h-3 text-cat-purple',
    label: 'goal',
  },
  file: {
    container: 'bg-success/15 text-success-soft hover:bg-success/25',
    icon: 'w-3 h-3 text-success',
    label: 'file',
  },
  folder: {
    container: 'bg-warning/15 text-warning-soft hover:bg-warning/25',
    icon: 'w-3 h-3 text-warning',
    label: 'folder',
  },
};

export default function MentionToken({ mention, metadata, onClick }: MentionTokenProps) {
  const [showTooltip, setShowTooltip] = useState(false);
  const tooltipId = useId();

  const tokenKey = `@ref{${mention.type}:${mention.id}}`;
  const metaEntry = metadata?.[tokenKey];
  const displayText = metaEntry?.displayText || mention.displayText || mention.id;
  const status = metaEntry?.status;

  const styles = TYPE_STYLES[mention.type];
  const ariaLabel = `${styles.label} reference: ${displayText}`;

  const handleKeyDown = (e: KeyboardEvent) => {
    if ((e.key === 'Enter' || e.key === ' ') && onClick) {
      e.preventDefault();
      onClick();
    }
  };

  return (
    <span class="relative inline-flex">
      <span
        role={onClick ? 'button' : undefined}
        tabIndex={onClick ? 0 : undefined}
        aria-label={ariaLabel}
        aria-describedby={showTooltip ? tooltipId : undefined}
        onClick={onClick}
        onKeyDown={handleKeyDown}
        onMouseEnter={() => setShowTooltip(true)}
        onMouseLeave={() => setShowTooltip(false)}
        onFocus={() => setShowTooltip(true)}
        onBlur={() => setShowTooltip(false)}
        class={cn(
          'rounded-full px-2 py-0.5 text-xs font-medium inline-flex items-center gap-1',
          'transition-colors duration-100',
          onClick ? 'cursor-pointer' : 'cursor-default',
          styles.container
        )}
      >
        <ReferenceTypeIcon type={mention.type} className={styles.icon} />
        <span class="max-w-[160px] truncate">{displayText}</span>
      </span>

      {showTooltip && (
        <span
          id={tooltipId}
          role="tooltip"
          class={cn(
            'absolute z-50 bottom-full left-0 mb-1.5',
            'bg-surface-raised border border-line rounded-lg shadow-xl',
            'px-3 py-2 text-xs text-fg-soft whitespace-nowrap',
            'pointer-events-none'
          )}
        >
          <span class="flex flex-col gap-0.5 min-w-0">
            <span class="font-medium text-fg">{displayText}</span>
            {status && <span class="text-fg-muted">{status}</span>}
            <span class="text-fg-faint">
              {mention.type}: {mention.id}
            </span>
          </span>
        </span>
      )}
    </span>
  );
}
