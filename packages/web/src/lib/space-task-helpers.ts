import type { SpaceTask, UpdateSpaceTaskParams } from '@hyperneo/shared';

/**
 * Build the `spaceStore.updateTask` payload for a "Mark Done" action.
 *
 * `done` is reachable from several statuses, but only the `approved → done`
 * path carries post-approval tracking fields (`postApprovalSessionId`,
 * `postApprovalStartedAt`, `postApprovalBlockedReason`) that must be cleared
 * so they don't linger on the task row. The daemon's `setTaskStatus` "exit
 * approved" branch clears these atomically regardless of the payload, but the
 * web layer should mirror that intent explicitly: both Mark Done call sites
 * (the `PendingPostApprovalBanner` and the `SpaceTaskPane` status dropdown)
 * build their payload here so they can never diverge — see task #849 (G4).
 */
export function buildMarkDonePayload(task: SpaceTask): UpdateSpaceTaskParams {
  return {
    status: 'done',
    ...(task.status === 'approved'
      ? {
          postApprovalSessionId: null,
          postApprovalStartedAt: null,
          postApprovalBlockedReason: null,
        }
      : {}),
  };
}
