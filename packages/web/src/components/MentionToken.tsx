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
    container: 'bg-blue-500/15 text-blue-300 hover:bg-blue-500/25',
    icon: 'w-3 h-3 text-blue-400',
    label: 'task',
  },
  goal: {
    container: 'bg-purple-500/15 text-purple-300 hover:bg-purple-500/25',
    icon: 'w-3 h-3 text-purple-400',
    label: 'goal',
  },
  file: {
    container: 'bg-green-500/15 text-green-300 hover:bg-green-500/25',
    icon: 'w-3 h-3 text-green-400',
    label: 'file',
  },
  folder: {
    container: 'bg-yellow-500/15 text-yellow-300 hover:bg-yellow-500/25',
    icon: 'w-3 h-3 text-yellow-400',
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
            'bg-dark-800 border border-gray-700 rounded-lg shadow-xl',
            'px-3 py-2 text-xs text-gray-200 whitespace-nowrap',
            'pointer-events-none'
          )}
        >
          <span class="flex flex-col gap-0.5 min-w-0">
            <span class="font-medium text-gray-100">{displayText}</span>
            {status && <span class="text-gray-400">{status}</span>}
            <span class="text-gray-500">
              {mention.type}: {mention.id}
            </span>
          </span>
        </span>
      )}
    </span>
  );
}
