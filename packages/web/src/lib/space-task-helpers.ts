import type { SpaceTask, UpdateSpaceTaskParams } from '@hyperneo/shared';

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
