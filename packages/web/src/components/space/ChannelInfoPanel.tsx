/**
 * ChannelInfoPanel
 *
 * Read-only info panel shown when a channel edge is selected in the runtime canvas.
 * Displays: source node → target node, direction, gate type, runtime status.
 */

import type { JSX } from 'preact';
import type { ResolvedWorkflowChannel } from './visual-editor/EdgeRenderer';
import { cn } from '../../lib/utils';

interface ChannelInfoPanelProps {
  channel: ResolvedWorkflowChannel;
  fromNodeName: string;
  toNodeName: string;
  onClose: () => void;
  /** Called when the user approves or rejects the channel's gate from this panel. */
  onGateDecision?: (gateId: string, approved: boolean) => void | Promise<void>;
  /**
   * Called when the user clicks "View Artifacts" for the channel's gate.
   * The click event is forwarded so the parent can capture `event.currentTarget`
   * for focus restoration on overlay close — `document.activeElement` is
   * unreliable for button clicks in Safari/Firefox, which don't move focus
   * to a button on click.
   */
  onViewArtifacts?: (gateId: string, event: Event) => void;
  /** Disables approve/reject buttons while an RPC is in flight. */
  decisionPending?: boolean;
  /** Error message from last decision attempt; shown below the action buttons. */
  decisionError?: string | null;
  class?: string;
}

const GATE_TYPE_LABELS: Record<string, string> = {
  human: 'Human Approval',
  condition: 'Shell Condition',
  task_result: 'Task Result',
  check: 'Check',
  count: 'Vote Count',
};

const RUNTIME_STATUS_CONFIG = {
  open: { label: 'Open', dotClass: 'bg-green-400', textClass: 'text-green-400' },
  waiting_human: {
    label: 'Waiting for Approval',
    dotClass: 'bg-amber-400 animate-pulse',
    textClass: 'text-amber-400',
  },
  blocked: { label: 'Blocked', dotClass: 'bg-red-400', textClass: 'text-red-400' },
};

export function ChannelInfoPanel({
  channel,
  fromNodeName,
  toNodeName,
  onClose,
  onGateDecision,
  onViewArtifacts,
  decisionPending = false,
  decisionError = null,
  class: className,
}: ChannelInfoPanelProps): JSX.Element {
  const status = channel.runtimeStatus;
  const statusConfig = status ? RUNTIME_STATUS_CONFIG[status] : null;
  const gateLabel =
    channel.gateLabel ?? (channel.gateType ? GATE_TYPE_LABELS[channel.gateType] : null);
  const isBidirectional = channel.direction === 'bidirectional';
  const showApprovalActions = status === 'waiting_human' && !!channel.gateId;
  // View Artifacts is useful for any gate with a run (e.g. reviewing a
  // rejected gate's evidence), not just ones still awaiting approval.
  const showViewArtifacts = !!channel.gateId && !!onViewArtifacts;

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
          {/* Connection */}
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

          <div class="flex flex-wrap items-center gap-3">
            {/* Gate type badge */}
            {gateLabel && (
              <span
                class="inline-flex items-center px-2 py-0.5 rounded text-xs font-medium border"
                style={{
                  borderColor: channel.gateColor ?? '#374151',
                  color: channel.gateColor ?? '#9ca3af',
                  backgroundColor: `${channel.gateColor ?? '#374151'}18`,
                }}
              >
                {channel.hasScript && <span class="mr-1 opacity-70">{'</>'}</span>}
                {gateLabel}
              </span>
            )}

            {/* Runtime status */}
            {statusConfig && (
              <div class="flex items-center gap-1.5">
                <span
                  class={cn(
                    'inline-block w-2 h-2 rounded-full flex-shrink-0',
                    statusConfig.dotClass
                  )}
                />
                <span class={cn('text-xs', statusConfig.textClass)}>{statusConfig.label}</span>
              </div>
            )}

            {!gateLabel && !statusConfig && <span class="text-xs text-gray-400">No gate</span>}
          </div>

          {(showApprovalActions || showViewArtifacts) && channel.gateId && (
            <>
              <div class="flex items-center gap-2 pt-1" data-testid="channel-gate-actions">
                {showApprovalActions && (
                  <>
                    <button
                      type="button"
                      onClick={() => void onGateDecision?.(channel.gateId!, true)}
                      disabled={decisionPending || !onGateDecision}
                      data-testid="channel-approve-btn"
                      class="px-3 py-1 text-xs font-medium rounded bg-green-900/40 text-green-300 border border-green-700/50 hover:bg-green-800/50 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
                    >
                      Approve
                    </button>
                    <button
                      type="button"
                      onClick={() => void onGateDecision?.(channel.gateId!, false)}
                      disabled={decisionPending || !onGateDecision}
                      data-testid="channel-reject-btn"
                      class="px-3 py-1 text-xs font-medium rounded bg-red-900/40 text-red-300 border border-red-700/50 hover:bg-red-800/50 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
                    >
                      Reject
                    </button>
                  </>
                )}
                {showViewArtifacts && (
                  <button
                    type="button"
                    onClick={(e) => onViewArtifacts?.(channel.gateId!, e)}
                    data-testid="channel-view-artifacts-btn"
                    class="px-3 py-1 text-xs font-medium rounded bg-dark-700 text-gray-200 border border-dark-600 hover:bg-dark-600 transition-colors"
                  >
                    View Artifacts
                  </button>
                )}
              </div>
              {decisionError && (
                <p class="text-xs text-red-400" data-testid="channel-gate-error">
                  {decisionError}
                </p>
              )}
            </>
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
