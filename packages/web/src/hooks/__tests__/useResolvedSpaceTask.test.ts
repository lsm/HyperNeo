import type { SpaceTask } from '@hyperneo/shared';
import { signal } from '@preact/signals';
import { act, renderHook } from '@testing-library/preact';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  ensureTaskDetail: vi.fn(),
}));

const taskDetailsSignal = signal<ReadonlyMap<string, SpaceTask>>(new Map());
const connectionStateSignal = signal<'connected' | 'disconnected'>('connected');

vi.mock('../../lib/space-store', () => ({
  spaceStore: {
    get taskDetails() {
      return taskDetailsSignal;
    },
    ensureTaskDetail: mocks.ensureTaskDetail,
  },
}));

vi.mock('../../lib/state', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return {
    ...actual,
    get connectionState() {
      return connectionStateSignal;
    },
  };
});

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
    connectionStateSignal.value = 'connected';
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

    expect(mocks.ensureTaskDetail).toHaveBeenCalledWith(task.id, task.updatedAt);
    expect(result.current).toBe(full);
  });

  it('prefers the store task when the cached detail is staler and refetches at its freshness', async () => {
    const task = makeSummaryTask({ updatedAt: 20 });
    const stale = { ...task, description: 'stale full', updatedAt: 10 };

    const { result } = renderHook(() => useResolvedSpaceTask(task));
    await act(async () => {
      taskDetailsSignal.value = new Map([[task.id, stale]]);
    });

    expect(result.current).toBe(task);
    expect(mocks.ensureTaskDetail).toHaveBeenCalledWith(task.id, task.updatedAt);
  });

  it('returns null for a null task without fetching', () => {
    const { result } = renderHook(() => useResolvedSpaceTask(null));

    expect(result.current).toBeNull();
    expect(mocks.ensureTaskDetail).not.toHaveBeenCalled();
  });

  it('retries a failed detail fetch with backoff and recovers', async () => {
    vi.useFakeTimers();
    const task = makeSummaryTask();
    mocks.ensureTaskDetail.mockResolvedValue(null);

    const { result } = renderHook(() => useResolvedSpaceTask(task));
    expect(mocks.ensureTaskDetail).toHaveBeenCalledTimes(1);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(3000);
    });
    expect(mocks.ensureTaskDetail).toHaveBeenCalledTimes(2);

    const full = { ...task, description: 'full description' };
    mocks.ensureTaskDetail.mockImplementation(async () => {
      taskDetailsSignal.value = new Map([[task.id, full]]);
      return full;
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(6000);
    });

    expect(mocks.ensureTaskDetail).toHaveBeenCalledTimes(3);
    expect(result.current).toBe(full);

    vi.useRealTimers();
  });

  it('stops retrying after the bounded number of attempts', async () => {
    vi.useFakeTimers();
    const task = makeSummaryTask();
    mocks.ensureTaskDetail.mockResolvedValue(null);

    renderHook(() => useResolvedSpaceTask(task));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(3000);
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(6000);
    });
    expect(mocks.ensureTaskDetail).toHaveBeenCalledTimes(3);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(60000);
    });
    expect(mocks.ensureTaskDetail).toHaveBeenCalledTimes(3);

    vi.useRealTimers();
  });

  it('resumes detail loading when connectivity returns after exhaustion', async () => {
    vi.useFakeTimers();
    const task = makeSummaryTask();
    mocks.ensureTaskDetail.mockResolvedValue(null);

    renderHook(() => useResolvedSpaceTask(task));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(3000);
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(6000);
    });
    expect(mocks.ensureTaskDetail).toHaveBeenCalledTimes(3);

    await act(async () => {
      connectionStateSignal.value = 'disconnected';
    });
    await act(async () => {
      connectionStateSignal.value = 'connected';
    });

    expect(mocks.ensureTaskDetail).toHaveBeenCalledTimes(4);

    vi.useRealTimers();
  });
});
