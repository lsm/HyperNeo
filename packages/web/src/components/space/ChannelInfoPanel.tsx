import type { JSX } from 'preact';
import type { ResolvedWorkflowChannel } from './visual-editor/EdgeRenderer';
import { cn } from '../../lib/utils';

interface ChannelInfoPanelProps {
  channel: ResolvedWorkflowChannel;
  fromNodeName: string;
  toNodeName: string;
  onClose: () => void;
  class?: string;
}

export function ChannelInfoPanel({
  channel,
  fromNodeName,
  toNodeName,
  onClose,
  class: className,
}: ChannelInfoPanelProps): JSX.Element {
  const isBidirectional = channel.direction === 'bidirectional';

  return (
    <div
      class={cn(
        'absolute bottom-0 left-0 right-0 z-20',
        'bg-dark-900/95 border-t border-dark-700',
        'px-4 py-3',
        className
      )}
      data-testid="channel-info-panel"
    >
      <div class="flex items-start justify-between gap-3">
        <div class="flex-1 min-w-0 space-y-2">
          <div class="flex items-center gap-2 text-sm">
            <span class="font-medium text-gray-100 truncate max-w-[120px]" title={fromNodeName}>
              {fromNodeName}
            </span>
            <span class="text-gray-400 flex-shrink-0">{isBidirectional ? '⇄' : '→'}</span>
            <span class="font-medium text-gray-100 truncate max-w-[120px]" title={toNodeName}>
              {toNodeName}
            </span>
            {channel.isCyclic && <span class="text-xs text-amber-500 flex-shrink-0">↩ loop</span>}
          </div>

          {channel.label && (
            <div class="text-xs text-gray-400 truncate" title={channel.label}>
              {channel.label}
            </div>
          )}
        </div>

        <button
          type="button"
          onClick={onClose}
          class="flex-shrink-0 text-gray-400 hover:text-gray-300 transition-colors"
          aria-label="Close channel info"
        >
          <svg class="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path
              stroke-linecap="round"
              stroke-linejoin="round"
              stroke-width={2}
              d="M6 18L18 6M6 6l12 12"
            />
          </svg>
        </button>
      </div>
    </div>
  );
}
