import type { WorkflowChannel } from '@hyperneo/shared';

export interface ChannelEdgeConfigPanelProps {
  index: number;
  channel: WorkflowChannel;
  shouldBeCyclic?: boolean;
  onChange: (index: number, channel: WorkflowChannel) => void;
  onDelete: (index: number) => void;
  onClose?: () => void;
  showHeader?: boolean;
}

function formatTo(to: string | string[]): string {
  return Array.isArray(to) ? to.join(', ') : to;
}

export function ChannelEdgeConfigPanel({
  index,
  channel,
  shouldBeCyclic = false,
  onChange,
  onDelete,
  onClose,
  showHeader = true,
}: ChannelEdgeConfigPanelProps) {
  return (
    <div
      data-testid="channel-edge-config-panel"
      class="flex flex-col gap-3 p-4 bg-surface-overlay border border-line rounded-lg text-sm text-fg"
    >
      {showHeader && (
        <div class="flex items-center justify-between">
          <span class="font-semibold text-fg text-sm">Channel</span>
          <button
            data-testid="channel-close-button"
            class="text-fg-muted hover:text-fg transition-colors"
            onClick={onClose}
            aria-label="Close"
          >
            &times;
          </button>
        </div>
      )}

      <div class="flex flex-col gap-1">
        <div class="flex items-center gap-2 text-xs">
          <span class="text-fg-muted w-10 shrink-0">From</span>
          <span class="font-mono bg-fill-strong rounded px-2 py-0.5 text-fg-soft truncate">
            {channel.from}
          </span>
        </div>
        <div class="flex items-center gap-2 text-xs">
          <span class="text-fg-muted w-10 shrink-0">To</span>
          <span class="font-mono bg-fill-strong rounded px-2 py-0.5 text-fg-soft truncate">
            {formatTo(channel.to)}
          </span>
        </div>
      </div>

      {shouldBeCyclic && (
        <div
          data-testid="channel-cyclic-info"
          class="rounded border border-accent/60 bg-accent/30 px-3 py-2 text-[11px] text-accent-soft"
        >
          <div class="mb-1.5">This link closes a workflow loop.</div>
          <label class="flex items-center gap-2">
            <span class="text-accent-soft">Max cycles</span>
            <input
              data-testid="channel-max-cycles-input"
              type="number"
              min={1}
              max={100}
              value={channel.maxCycles ?? 5}
              class="w-16 rounded bg-surface-raised border border-accent/40 px-2 py-0.5 text-[11px] text-accent-soft"
              onChange={(e) => {
                const val = parseInt((e.target as HTMLInputElement).value, 10);
                if (!isNaN(val) && val >= 1) {
                  onChange(index, { ...channel, maxCycles: val });
                }
              }}
            />
          </label>
        </div>
      )}

      <button
        data-testid="delete-channel-button"
        class="mt-1 w-full rounded px-2 py-1.5 text-xs font-medium text-danger border border-danger hover:bg-danger/30 transition-colors"
        onClick={() => onDelete(index)}
      >
        Delete channel
      </button>
    </div>
  );
}
