import type { WorkflowChannel } from '@hyperneo/shared';
import { ChannelEdgeConfigPanel } from './ChannelEdgeConfigPanel';

export interface ChannelRelationConfigPanelProps {
  title: string;
  description: string;
  forwardLinks: Array<{
    index: number;
    channel: WorkflowChannel;
    shouldBeCyclic?: boolean;
  }>;
  reverseLinks?: Array<{
    index: number;
    channel: WorkflowChannel;
    shouldBeCyclic?: boolean;
  }>;
  canConvertToBidirectional?: boolean;
  onConvertToBidirectional?: () => void;
  onChange: (index: number, channel: WorkflowChannel) => void;
  onDelete: (index: number) => void;
  onBack?: () => void;
  onClose: () => void;
  width?: number;
  embedded?: boolean;
}

export function ChannelRelationConfigPanel({
  title,
  description,
  forwardLinks,
  reverseLinks = [],
  canConvertToBidirectional = false,
  onConvertToBidirectional,
  onChange,
  onDelete,
  onBack,
  onClose,
  width = 360,
  embedded = false,
}: ChannelRelationConfigPanelProps) {
  const content = (
    <div
      data-testid="channel-relation-config-panel"
      class={
        embedded
          ? 'flex-1 overflow-y-auto px-4 py-4 space-y-3'
          : 'flex-1 overflow-y-auto px-4 py-4 space-y-3'
      }
    >
      <p class="text-xs text-fg-muted">{description}</p>
      {canConvertToBidirectional && (
        <button
          type="button"
          data-testid="convert-channel-relation-button"
          onClick={onConvertToBidirectional}
          class="w-full rounded border border-accent-hover bg-accent-hover/10 px-3 py-2 text-xs font-medium text-accent-soft hover:bg-accent-hover/20 transition-colors"
        >
          Convert to bidirectional
        </button>
      )}

      {forwardLinks.length > 0 ? (
        <div class="space-y-3">
          {reverseLinks.length > 0 && (
            <p class="text-[11px] font-semibold uppercase tracking-[0.16em] text-fg-muted">
              Forward links
            </p>
          )}
          {forwardLinks.map(({ index, channel, shouldBeCyclic }) => (
            <ChannelEdgeConfigPanel
              key={`${index}-${channel.from}-${Array.isArray(channel.to) ? channel.to.join(',') : channel.to}`}
              index={index}
              channel={channel}
              shouldBeCyclic={shouldBeCyclic}
              onChange={onChange}
              onDelete={onDelete}
              showHeader={false}
            />
          ))}
        </div>
      ) : null}

      {reverseLinks.length > 0 && (
        <div class="space-y-3">
          <p class="text-[11px] font-semibold uppercase tracking-[0.16em] text-fg-muted">
            Reverse links
          </p>
          {reverseLinks.map(({ index, channel, shouldBeCyclic }) => (
            <ChannelEdgeConfigPanel
              key={`${index}-${channel.from}-${Array.isArray(channel.to) ? channel.to.join(',') : channel.to}`}
              index={index}
              channel={channel}
              shouldBeCyclic={shouldBeCyclic}
              onChange={onChange}
              onDelete={onDelete}
              showHeader={false}
            />
          ))}
        </div>
      )}

      {forwardLinks.length === 0 && reverseLinks.length === 0 && (
        <p class="text-xs text-fg-muted">No editable channel links found for this relation.</p>
      )}
    </div>
  );

  if (embedded) {
    return content;
  }

  return (
    <div
      style={{
        position: 'absolute',
        top: 0,
        right: 0,
        bottom: 0,
        width,
        display: 'flex',
        flexDirection: 'column',
        zIndex: 20,
      }}
      class="bg-surface border-l border-line shadow-xl animate-slideInRight"
    >
      <div class="flex items-start justify-between gap-3 px-4 py-3 border-b border-line flex-shrink-0">
        <div class="min-w-0 flex items-start gap-2">
          {onBack && (
            <button
              type="button"
              data-testid="channel-relation-back-button"
              onClick={onBack}
              class="mt-0.5 p-1 rounded text-fg-muted hover:text-fg-soft hover:bg-fill-strong transition-colors flex-shrink-0"
              title="Back"
            >
              <svg class="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path
                  stroke-linecap="round"
                  stroke-linejoin="round"
                  stroke-width={2}
                  d="M15 19l-7-7 7-7"
                />
              </svg>
            </button>
          )}
          <div class="min-w-0">
            <h3 class="text-sm font-semibold text-fg truncate">{title}</h3>
            <p class="mt-1 text-xs text-fg-muted">{description}</p>
          </div>
        </div>
        <button
          data-testid="channel-relation-close-button"
          onClick={onClose}
          class="p-1 rounded text-fg-muted hover:text-fg-soft hover:bg-fill-strong transition-colors flex-shrink-0"
          title="Close panel"
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

      {content}
    </div>
  );
}
