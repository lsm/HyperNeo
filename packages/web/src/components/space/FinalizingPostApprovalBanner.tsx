/**
 * FinalizingPostApprovalBanner — informational banner for an `approved` task
 * whose post-approval COMPLETION tail (branch cleanup → worktree/space sync →
 * audit artifact → task → done) is being driven deterministically.
 *
 * Renders when `task.postApprovalCompletionStatus` is set:
 *   - `'finalizing merge'`   — the merger fast-path is finishing the tail.
 *   - `'completion recovery'` — the daemon-side reconciler resumed the tail
 *                               after the merger stalled/died.
 *
 * This is a non-blocking status surface: an `approved` task with a merged PR
 * is deliberately NOT left silently idling. No actions — the daemon completes
 * it idempotently; the banner clears when the task reaches `done`.
 */

import type { SpaceTask } from '@hyperneo/shared';
import { InlineStatusBanner } from './InlineStatusBanner';

export interface FinalizingPostApprovalBannerProps {
  task: SpaceTask;
}

export function FinalizingPostApprovalBanner({ task }: FinalizingPostApprovalBannerProps) {
  const status = task.postApprovalCompletionStatus;
  if (task.status !== 'approved' || !status) return null;
  const label =
    status === 'completion recovery'
      ? 'Completion recovery: finishing post-merge cleanup after a stalled merger'
      : 'Finalizing merge: running post-approval cleanup';
  return (
    <InlineStatusBanner
      tone="blue"
      icon={<span aria-hidden="true">🔄</span>}
      label={label}
      testId="finalizing-post-approval-banner"
      dataAttrs={{ 'data-task-id': task.id }}
    />
  );
}
