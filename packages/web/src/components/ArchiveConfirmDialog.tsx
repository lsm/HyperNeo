import type { ArchiveSessionResponse } from '@hyperneo/shared';
import { borderColors } from '../lib/design-tokens';
import { Button } from './ui/Button';

export interface ArchiveConfirmDialogProps {
  commitStatus: ArchiveSessionResponse['commitStatus'];
  archiving: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}

export function ArchiveConfirmDialog({
  commitStatus,
  archiving,
  onConfirm,
  onCancel,
}: ArchiveConfirmDialogProps) {
  if (!commitStatus) {
    return <></>;
  }

  return (
    <div class="fixed inset-0 bg-black/50 flex items-center justify-center z-50">
      <div class={`bg-dark-800 border rounded-xl p-6 max-w-md mx-4 ${borderColors.ui.default}`}>
        <h3 class="text-lg font-semibold text-gray-100 mb-3">Confirm Archive</h3>
        <p class="text-sm text-gray-300 mb-4">
          This worktree has {commitStatus.commits.length} uncommitted changes:
        </p>
        <div
          class={`bg-dark-900 rounded-lg p-3 mb-4 max-h-48 overflow-y-auto border ${borderColors.ui.secondary}`}
        >
          {commitStatus.commits.map((commit) => (
            <div
              key={commit.hash}
              class="mb-2 text-xs pb-2 border-b border-dark-700 last:border-0 last:pb-0"
            >
              <div class="font-mono text-blue-400">{commit.hash}</div>
              <div class="text-gray-300">{commit.message}</div>
              <div class="text-gray-500">
                {commit.author} • {commit.date}
              </div>
            </div>
          ))}
        </div>
        <p class="text-sm text-orange-400 mb-4">
          These commits will be lost when the worktree is removed. Continue?
        </p>
        <div class="flex gap-3">
          <Button onClick={onCancel} variant="secondary" class="flex-1">
            Cancel
          </Button>
          <Button
            onClick={onConfirm}
            disabled={archiving}
            class="flex-1 bg-orange-500 hover:bg-orange-600 text-white"
          >
            {archiving ? 'Archiving...' : 'Archive Anyway'}
          </Button>
        </div>
      </div>
    </div>
  );
}
