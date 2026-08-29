import type { ArchiveSessionResponse } from '@hyperneo/shared';
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
      <div class="bg-surface-raised border rounded-xl p-6 max-w-md mx-4 border-line">
        <h3 class="text-lg font-semibold text-fg mb-3">Confirm Archive</h3>
        <p class="text-sm text-fg-soft mb-4">
          This worktree has {commitStatus.commits.length} uncommitted changes:
        </p>
        <div class="bg-surface rounded-lg p-3 mb-4 max-h-48 overflow-y-auto border border-line-strong">
          {commitStatus.commits.map((commit) => (
            <div
              key={commit.hash}
              class="mb-2 text-xs pb-2 border-b border-line last:border-0 last:pb-0"
            >
              <div class="font-mono text-accent">{commit.hash}</div>
              <div class="text-fg-soft">{commit.message}</div>
              <div class="text-fg-faint">
                {commit.author} • {commit.date}
              </div>
            </div>
          ))}
        </div>
        <p class="text-sm text-warning mb-4">
          These commits will be lost when the worktree is removed. Continue?
        </p>
        <div class="flex gap-3">
          <Button onClick={onCancel} variant="secondary" class="flex-1">
            Cancel
          </Button>
          <Button
            onClick={onConfirm}
            disabled={archiving}
            class="flex-1 bg-warning hover:bg-warning text-accent-fg"
          >
            {archiving ? 'Archiving...' : 'Archive Anyway'}
          </Button>
        </div>
      </div>
    </div>
  );
}
