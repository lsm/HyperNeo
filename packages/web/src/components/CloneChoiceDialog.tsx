import type { CloneChildrenChoice, CloneSummary } from '@hyperneo/shared';
import { conversationTitle } from '../lib/session-sidebar-status.ts';
import { CloneIcon } from './icons/CloneIcon.tsx';
import { ConfirmModal } from './ui/ConfirmModal.tsx';

export interface CloneChoiceDialogProps {
  clones: CloneSummary[];
  action: 'archive' | 'delete';
  subject: 'session' | 'agent';
  busy: boolean;
  onChoose: (choice: CloneChildrenChoice) => void;
  onCancel: () => void;
}

export function CloneChoiceDialog({
  clones,
  action,
  subject,
  busy,
  onChoose,
  onCancel,
}: CloneChoiceDialogProps) {
  const verb = action === 'delete' ? 'Delete' : 'Archive';
  const keepAs = subject === 'agent' ? 'their own agents' : 'their own chats';
  return (
    <ConfirmModal
      isOpen
      onClose={onCancel}
      onConfirm={() => onChoose('cascade')}
      title={`This ${subject === 'agent' ? 'agent' : 'conversation'} has ${clones.length} ${clones.length === 1 ? 'clone' : 'clones'}`}
      message={`${verb} them too, or keep them as ${keepAs}?`}
      confirmText={`${verb} them too`}
      confirmButtonVariant={action === 'delete' ? 'danger' : 'warning'}
      isLoading={busy}
      confirmTestId="clone-choice-cascade"
    >
      <div class="space-y-3" data-testid="clone-choice-dialog">
        <ul class="max-h-40 overflow-y-auto text-sm text-fg-soft">
          {clones.map((clone) => (
            <li key={clone.id} class="flex items-center gap-2 py-0.5">
              <CloneIcon className="h-4 w-4 flex-shrink-0 text-fg-muted" />
              <span class="truncate">{conversationTitle(clone.title, true)}</span>
            </li>
          ))}
        </ul>
        <button
          type="button"
          onClick={() => onChoose('flatten')}
          disabled={busy}
          data-testid="clone-choice-flatten"
          class="w-full rounded-lg border border-line-strong bg-surface-raised px-4 py-2 text-sm font-medium text-fg transition-colors hover:bg-fill-strong disabled:cursor-not-allowed disabled:opacity-50"
        >
          Keep them as {keepAs}
        </button>
      </div>
    </ConfirmModal>
  );
}
