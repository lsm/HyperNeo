import type { SpaceTask, SpaceTaskStatus } from '@hyperneo/shared';
import { describe, expect, it } from 'vitest';
import { buildMarkDonePayload } from './space-task-helpers.js';

function makeTask(overrides: Partial<SpaceTask> = {}): SpaceTask {
  return {
    id: 'task-1',
    spaceId: 'space-1',
    title: 'T',
    description: '',
    status: 'open',
    dependsOn: [],
    assignedToSessionId: null,
    reportedByAgentName: null,
    result: null,
    createdAt: 0,
    updatedAt: 0,
    ...overrides,
  } as SpaceTask;
}

describe('buildMarkDonePayload', () => {
  it('clears post-approval fields when the task is approved', () => {
    const task = makeTask({
      status: 'approved',
      postApprovalSessionId: 'session-123',
      postApprovalStartedAt: 1000,
      postApprovalBlockedReason: 'sub-session crashed',
    });
    expect(buildMarkDonePayload(task)).toEqual({
      status: 'done',
      postApprovalSessionId: null,
      postApprovalStartedAt: null,
      postApprovalBlockedReason: null,
    });
  });

  it('nulls post-approval fields even when the approved task carries a blocked reason', () => {
    const task = makeTask({
      status: 'approved',
      postApprovalSessionId: 'sess-abc',
      postApprovalStartedAt: 2000,
      postApprovalBlockedReason: 'deploy session crashed',
    });
    const payload = buildMarkDonePayload(task);
    expect(payload.postApprovalSessionId).toBeNull();
    expect(payload.postApprovalStartedAt).toBeNull();
    expect(payload.postApprovalBlockedReason).toBeNull();
  });

  it.each([
    'draft',
    'open',
    'in_progress',
    'review',
    'done',
    'blocked',
    'cancelled',
    'rate_limited',
    'usage_limited',
    'archived',
  ] as SpaceTaskStatus[])('returns a bare status update (no post-approval keys) for %s', (status) => {
    expect(buildMarkDonePayload(makeTask({ status }))).toEqual({ status: 'done' });
  });
});
