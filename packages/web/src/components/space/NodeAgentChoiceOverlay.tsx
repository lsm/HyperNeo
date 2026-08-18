import type { NodeChoice } from '../../lib/node-click-resolver';
import { Modal } from '../ui/Modal';

export interface NodeAgentChoiceOverlayProps {
  isOpen: boolean;
  nodeName: string;
  choices: NodeChoice[];
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
