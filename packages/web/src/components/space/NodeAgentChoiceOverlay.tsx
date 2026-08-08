/**
 * NodeAgentChoiceOverlay — identity-safe picker for a clicked workflow node.
 *
 * Shown when a canvas node click is ambiguous (a multi-agent node with several
 * live sessions, or several declared slots none of which have started) or has
 * no agents at all. Each live choice opens that exact session; each pending
 * choice opens the node's own pending-agent overlay (activating just that slot
 * on first send). The overlay never silently selects an unrelated session or an
 * arbitrary slot — the user picks.
 *
 * Mirrors the Modal pattern used by the other task-level overlays
 * (SubmitForReviewModal, EditTaskModal) rather than the history-backed session
 * slide-over: it is transient, and selecting a choice transitions into the
 * proper history-backed overlay.
 */

import type { NodeChoice } from '../../lib/node-click-resolver';
import { Modal } from '../ui/Modal';

export interface NodeAgentChoiceOverlayProps {
  isOpen: boolean;
  /** Node name, shown in the modal title. */
  nodeName: string;
  /** Empty array → zero-agent empty state. */
  choices: NodeChoice[];
  /** Called with the chosen live/pending target. */
  onSelect: (choice: NodeChoice) => void;
  onClose: () => void;
}

export function NodeAgentChoiceOverlay({
  isOpen,
  nodeName,
  choices,
  onSelect,
  onClose,
}: NodeAgentChoiceOverlayProps) {
  const isEmpty = choices.length === 0;
  return (
    <Modal isOpen={isOpen} onClose={onClose} title={nodeName} size="sm" showCloseButton>
      <div class="p-4" data-testid="node-agent-choice-overlay">
        {isEmpty ? (
          <p class="text-sm text-gray-300" data-testid="node-agent-empty-state">
            This node has no agents to open.
          </p>
        ) : (
          <ul class="flex flex-col gap-1">
            {choices.map((choice) => (
              <li
                key={
                  choice.kind === 'live'
                    ? `live:${choice.sessionId}`
                    : `pending:${choice.agentName}:${choice.nodeId ?? ''}`
                }
              >
                <button
                  type="button"
                  data-testid={`node-agent-choice-${choice.kind}-${choice.agentName}`}
                  class="flex w-full items-center justify-between rounded-lg px-3 py-2 text-left text-sm text-gray-200 transition-colors hover:bg-dark-800"
                  onClick={() => onSelect(choice)}
                >
                  <span class="truncate">{choice.label}</span>
                  <span class="ml-2 shrink-0 text-[11px] font-medium uppercase tracking-wide text-gray-500">
                    {choice.kind === 'live' ? 'Active' : 'Not started'}
                  </span>
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
    </Modal>
  );
}
