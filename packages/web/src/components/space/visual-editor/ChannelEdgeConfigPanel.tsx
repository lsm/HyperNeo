import { generateUUID } from '@neokai/shared';
import type { Gate, GateField, WorkflowChannel } from '@neokai/shared';

export interface ChannelEdgeConfigPanelProps {
  index: number;
  channel: WorkflowChannel;
  gates: Gate[];
  shouldBeCyclic?: boolean;
  onChange: (index: number, channel: WorkflowChannel) => void;
  onDelete: (index: number) => void;
  onGatesChange: (gates: Gate[]) => void;
  onEditGate?: (gateId: string) => void;
  onClose?: () => void;
  showHeader?: boolean;
}

function formatTo(to: string | string[]): string {
  return Array.isArray(to) ? to.join(', ') : to;
}

/** Compute a short label for a field's check. */
function fieldCheckLabel(field: GateField): string {
  if (field.check.op === 'count') {
    return `count(${JSON.stringify(field.check.match)}) >= ${field.check.min}`;
  }
  if (field.check.op === 'exists') return 'exists';
  return `${field.check.op} ${JSON.stringify(field.check.value)}`;
}

/** Type icon character for a field type. */
function fieldTypeIcon(type: GateField['type']): string {
  switch (type) {
    case 'boolean':
      return 'B';
    case 'string':
      return 'S';
    case 'number':
      return '#';
    case 'map':
      return 'M';
    default:
      return '?';
  }
}

export function ChannelEdgeConfigPanel({
  index,
  channel,
  gates,
  shouldBeCyclic = false,
  onChange,
  onDelete,
  onGatesChange,
  onEditGate,
  onClose,
  showHeader = true,
}: ChannelEdgeConfigPanelProps) {
  const currentGate = channel.gateId ? gates.find((gate) => gate.id === channel.gateId) : undefined;

  function updateChannel(nextChannel: WorkflowChannel) {
    onChange(index, nextChannel);
  }

  function handleAddGate() {
    const gateId = `gate-${generateUUID()}`;
    const newGate: Gate = {
      id: gateId,
      description: channel.label ?? `${channel.from} \u2192 ${formatTo(channel.to)}`,
      fields: [],
      resetOnCycle: shouldBeCyclic,
    };
    onGatesChange([...gates, newGate]);
    updateChannel({ ...channel, gateId });
    if (onEditGate) {
      onEditGate(gateId);
    }
  }

  function handleRemoveGate() {
    updateChannel({ ...channel, gateId: undefined });
  }

  return (
    <div
      data-testid="channel-edge-config-panel"
      class="flex flex-col gap-3 p-4 bg-dark-850 border border-dark-700 rounded-lg text-sm text-white"
    >
      {showHeader && (
        <div class="flex items-center justify-between">
          <span class="font-semibold text-white text-sm">Channel</span>
          <button
            data-testid="channel-close-button"
            class="text-gray-400 hover:text-white transition-colors"
            onClick={onClose}
            aria-label="Close"
          >
            &times;
          </button>
        </div>
      )}

      <div class="flex flex-col gap-1">
        <div class="flex items-center gap-2 text-xs">
          <span class="text-gray-400 w-10 shrink-0">From</span>
          <span class="font-mono bg-dark-700 rounded px-2 py-0.5 text-gray-200 truncate">
            {channel.from}
          </span>
        </div>
        <div class="flex items-center gap-2 text-xs">
          <span class="text-gray-400 w-10 shrink-0">To</span>
          <span class="font-mono bg-dark-700 rounded px-2 py-0.5 text-gray-200 truncate">
            {formatTo(channel.to)}
          </span>
        </div>
      </div>

      {/* Gate summary */}
      <div class="space-y-1.5">
        <label class="text-xs font-medium text-gray-400">Gate</label>
        {!currentGate ? (
          <div class="space-y-2">
            <p class="text-xs text-gray-600">No gate — always open</p>
            <button
              type="button"
              data-testid={`channel-edge-add-gate-${index}`}
              onClick={handleAddGate}
              class="w-full rounded border border-blue-600 bg-blue-600/10 px-2 py-1.5 text-xs font-medium text-blue-200 hover:bg-blue-600/20 transition-colors"
            >
              Add Gate
            </button>
          </div>
        ) : (
          <div class="space-y-2">
            {/* Gate header with label, color dot, and script indicator */}
            <div class="flex items-center gap-2 text-xs">
              {currentGate.color && (
                <span
                  data-testid="gate-color-dot"
                  class="w-2.5 h-2.5 rounded-full shrink-0"
                  style={{ backgroundColor: currentGate.color }}
                  title={`Color: ${currentGate.color}`}
                />
              )}
              <span class="font-mono text-gray-300 truncate">{currentGate.id}</span>
              {currentGate.label && (
                <span
                  data-testid="gate-label-badge"
                  class="rounded-full bg-dark-600 px-2 py-0.5 text-[10px] font-semibold truncate"
                  style={{ color: currentGate.color ?? undefined }}
                  title={currentGate.label}
                >
                  {currentGate.label}
                </span>
              )}
              {currentGate.script && (
                <span
                  data-testid="gate-script-indicator"
                  class="ml-auto text-gray-500 shrink-0"
                  title={`Script: ${currentGate.script.interpreter}`}
                >
                  {'\u26A1'}
                </span>
              )}
            </div>

            {/* Field summary rows */}
            {(currentGate.fields ?? []).length === 0 && !currentGate.script ? (
              <p class="text-xs text-gray-600 italic">No fields defined yet</p>
            ) : (
              <div class="space-y-1">
                {(currentGate.fields ?? []).map((field) => (
                  <div
                    key={field.name}
                    class="flex items-center gap-2 text-xs bg-dark-800 rounded px-2 py-1.5 border border-dark-700"
                  >
                    <span
                      class="w-5 h-5 flex items-center justify-center rounded text-[10px] font-bold bg-dark-600 text-gray-300"
                      title={field.type}
                    >
                      {fieldTypeIcon(field.type)}
                    </span>
                    <span class="font-mono text-gray-200 truncate">{field.name}</span>
                    <span class="text-gray-500 ml-auto text-[11px] truncate">
                      {fieldCheckLabel(field)}
                    </span>
                  </div>
                ))}
              </div>
            )}

            <div class="flex gap-2">
              {onEditGate && (
                <button
                  type="button"
                  data-testid={`channel-edge-edit-gate-${index}`}
                  onClick={() => onEditGate(currentGate.id)}
                  class="flex-1 rounded border border-blue-600 bg-blue-600/10 px-2 py-1.5 text-xs font-medium text-blue-200 hover:bg-blue-600/20 transition-colors"
                >
                  Edit Gate
                </button>
              )}
              <button
                type="button"
                data-testid={`channel-edge-remove-gate-${index}`}
                onClick={handleRemoveGate}
                class="flex-1 rounded border border-red-800 px-2 py-1.5 text-xs font-medium text-red-400 hover:bg-red-900/30 transition-colors"
              >
                Remove Gate
              </button>
            </div>
          </div>
        )}
      </div>

      {shouldBeCyclic && (
        <div
          data-testid="channel-cyclic-info"
          class="rounded border border-blue-700/60 bg-blue-950/30 px-3 py-2 text-[11px] text-blue-200"
        >
          <div class="mb-1.5">This link closes a workflow loop.</div>
          <label class="flex items-center gap-2">
            <span class="text-blue-300">Max cycles</span>
            <input
              data-testid="channel-max-cycles-input"
              type="number"
              min={1}
              max={100}
              value={channel.maxCycles ?? 5}
              class="w-16 rounded bg-dark-800 border border-blue-700/40 px-2 py-0.5 text-[11px] text-blue-100"
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
        class="mt-1 w-full rounded px-2 py-1.5 text-xs font-medium text-red-400 border border-red-800 hover:bg-red-900/30 transition-colors"
        onClick={() => onDelete(index)}
      >
        Delete channel
      </button>
    </div>
  );
}
