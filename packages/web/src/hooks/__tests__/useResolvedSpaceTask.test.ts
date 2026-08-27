import type { SpaceTask } from '@hyperneo/shared';
import { signal } from '@preact/signals';
import { act, renderHook } from '@testing-library/preact';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  ensureTaskDetail: vi.fn(),
}));

const taskDetailsSignal = signal<ReadonlyMap<string, SpaceTask>>(new Map());

vi.mock('../../lib/space-store', () => ({
  spaceStore: {
    get taskDetails() {
      return taskDetailsSignal;
    },
    ensureTaskDetail: mocks.ensureTaskDetail,
  },
}));

import { useResolvedSpaceTask } from '../useResolvedSpaceTask';
import type { SummarySpaceTask } from '../../lib/space-store';

function makeSummaryTask(overrides: Partial<SummarySpaceTask> = {}): SummarySpaceTask {
  return {
    id: 't1',
    spaceId: 'space-1',
    taskNumber: 1,
    title: 'Task t1',
    description: 'truncated',
    status: 'open',
    priority: 'normal',
    labels: [],
    dependsOn: [],
    result: null,
    startedAt: null,
    completedAt: null,
    archivedAt: null,
    blockReason: null,
    approvalSource: null,
    approvalReason: null,
    approvedAt: null,
    pendingCheckpointType: null,
    reportedStatus: null,
    reportedSummary: null,
    createdAt: 1,
    updatedAt: 10,
    terminalGeneration: 0,
    descriptionTruncated: true,
    ...overrides,
  };
}

describe('useResolvedSpaceTask', () => {
  beforeEach(() => {
    taskDetailsSignal.value = new Map();
    mocks.ensureTaskDetail.mockReset();
    mocks.ensureTaskDetail.mockResolvedValue(null);
  });

  it('returns the task unchanged and does not fetch when nothing is truncated', () => {
    const task = makeSummaryTask({ descriptionTruncated: false, resultTruncated: false });

    const { result } = renderHook(() => useResolvedSpaceTask(task));

    expect(result.current).toBe(task);
    expect(mocks.ensureTaskDetail).not.toHaveBeenCalled();
  });

  it('fetches full detail for truncated tasks and returns the cached copy once loaded', async () => {
    const task = makeSummaryTask();
    const full = { ...task, description: 'full description', descriptionTruncated: undefined };

    const { result } = renderHook(() => useResolvedSpaceTask(task));

    expect(result.current).toBe(task);
    await act(async () => {
      taskDetailsSignal.value = new Map([[task.id, full]]);
    });

    expect(mocks.ensureTaskDetail).toHaveBeenCalledWith(task.id);
    expect(result.current).toBe(full);
  });

  it('prefers the store task when the cached detail is staler', async () => {
    const task = makeSummaryTask({ updatedAt: 20 });
    const stale = { ...task, description: 'stale full', updatedAt: 10 };

    const { result } = renderHook(() => useResolvedSpaceTask(task));
    await act(async () => {
      taskDetailsSignal.value = new Map([[task.id, stale]]);
    });

    expect(result.current).toBe(task);
  });

  it('returns null for a null task without fetching', () => {
    const { result } = renderHook(() => useResolvedSpaceTask(null));

    expect(result.current).toBeNull();
    expect(mocks.ensureTaskDetail).not.toHaveBeenCalled();
  });
});
