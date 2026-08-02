/**
 * Tests for useGitSessionStatus — the single shared git-status source.
 *
 * Covers: fetch on mount, interval polling while visible, pausing when the tab
 * is hidden, and manual refresh. Fake timers drive the polling interval.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render } from '@testing-library/preact';
import type { GitSessionStatusResponse } from '@hyperneo/shared';

vi.mock('../../lib/api-helpers', () => ({
  getGitSessionStatus: vi.fn(),
}));

import { getGitSessionStatus } from '../../lib/api-helpers.ts';
import { useGitSessionStatus, type UseGitSessionStatusResult } from '../useGitSessionStatus.ts';

const mockGetStatus = vi.mocked(getGitSessionStatus);

const STATUS: GitSessionStatusResponse = {
  sessionId: 's1',
  mode: 'direct',
  isGitRepo: true,
  workspacePath: '/repo',
  worktreePath: null,
  mainRepoPath: '/repo',
  gitRoot: '/repo',
  branch: 'main',
  baseBranch: 'main',
  defaultBranch: 'main',
  isDirty: false,
  files: [],
  commitsAhead: [],
  aheadCount: 0,
  behindCount: 0,
  review: { files: [], totalAdditions: 0, totalDeletions: 0, pullRequest: null, checks: [] },
};

// Hook harness: Preact's testing-library may not export renderHook reliably
// across versions, so capture the latest return into a module-level variable.
let last: UseGitSessionStatusResult | null = null;
function Harness({ sessionId }: { sessionId: string | null }) {
  last = useGitSessionStatus(sessionId);
  return null;
}

function setHidden(value: boolean) {
  Object.defineProperty(document, 'hidden', { value, configurable: true });
}

describe('useGitSessionStatus', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    mockGetStatus.mockReset();
    mockGetStatus.mockResolvedValue(STATUS);
    last = null;
    setHidden(false);
  });

  afterEach(() => {
    vi.useRealTimers();
    cleanup();
    last = null;
  });

  it('fetches git status on mount and sets loading', () => {
    render(<Harness sessionId="s1" />);
    expect(mockGetStatus).toHaveBeenCalledWith('s1');
    expect(mockGetStatus).toHaveBeenCalledTimes(1);
    expect(last?.loading).toBe(true);
  });

  it('does not fetch when there is no session', () => {
    render(<Harness sessionId={null} />);
    expect(mockGetStatus).not.toHaveBeenCalled();
    expect(last?.loading).toBe(false);
  });

  it('polls on the interval while the tab is visible', async () => {
    render(<Harness sessionId="s1" />);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(mockGetStatus).toHaveBeenCalledTimes(2); // mount + 1 poll
    await vi.advanceTimersByTimeAsync(10_000);
    expect(mockGetStatus).toHaveBeenCalledTimes(3);
  });

  it('pauses polling while the tab is hidden', async () => {
    setHidden(true);
    render(<Harness sessionId="s1" />);
    await vi.advanceTimersByTimeAsync(30_000);
    expect(mockGetStatus).toHaveBeenCalledTimes(1); // mount only
  });

  it('manual refresh triggers an additional fetch', async () => {
    render(<Harness sessionId="s1" />);
    await vi.advanceTimersByTimeAsync(0); // flush mount microtask
    const before = mockGetStatus.mock.calls.length;
    last?.refresh();
    await vi.advanceTimersByTimeAsync(0);
    expect(mockGetStatus.mock.calls.length).toBe(before + 1);
  });

  it('refetches when the session changes', async () => {
    const { rerender } = render(<Harness sessionId="s1" />);
    await vi.advanceTimersByTimeAsync(0);
    expect(mockGetStatus).toHaveBeenLastCalledWith('s1');

    rerender(<Harness sessionId="s2" />);
    await vi.advanceTimersByTimeAsync(0);
    expect(mockGetStatus).toHaveBeenLastCalledWith('s2');
  });

  it('queues a manual refresh behind an in-flight poll and runs it on settle', async () => {
    let resolvePoll!: (value: GitSessionStatusResponse) => void;
    mockGetStatus.mockReset();
    mockGetStatus.mockResolvedValueOnce(STATUS); // mount resolves immediately
    mockGetStatus.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolvePoll = resolve;
        })
    ); // poll stays pending
    mockGetStatus.mockResolvedValue(STATUS); // deferred refresh resolves

    render(<Harness sessionId="s1" />);
    await vi.advanceTimersByTimeAsync(0); // flush mount
    expect(mockGetStatus).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(10_000); // poll fires, stays pending
    expect(mockGetStatus).toHaveBeenCalledTimes(2);

    // Refresh clicked while the poll is in flight — must not be dropped.
    last?.refresh();
    await vi.advanceTimersByTimeAsync(0);
    expect(mockGetStatus).toHaveBeenCalledTimes(2); // queued, not started yet

    // Poll settles → queued refresh runs.
    resolvePoll(STATUS);
    await vi.advanceTimersByTimeAsync(0);
    expect(mockGetStatus).toHaveBeenCalledTimes(3);
    expect(last?.loading).toBe(false);
  });

  it('runs the new session load immediately when switching mid-flight', async () => {
    // Session A's fetch stays pending; switching to B must not strand B on the
    // loading skeleton waiting for the 10s poll, and loading must settle.
    let resolveA!: (value: GitSessionStatusResponse) => void;
    mockGetStatus.mockReset();
    mockGetStatus.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveA = resolve;
        })
    );
    mockGetStatus.mockImplementation((id: string) => Promise.resolve({ ...STATUS, sessionId: id }));

    const { rerender } = render(<Harness sessionId="a" />);
    await vi.advanceTimersByTimeAsync(0);
    expect(mockGetStatus).toHaveBeenCalledWith('a');

    // Switch before A resolves.
    rerender(<Harness sessionId="b" />);
    await vi.advanceTimersByTimeAsync(0);

    // B's initial load fired immediately (not deferred to the next poll).
    expect(mockGetStatus).toHaveBeenCalledWith('b');
    // B resolved → loading cleared, not stuck on the placeholder.
    expect(last?.loading).toBe(false);
    expect(last?.status?.sessionId).toBe('b');

    // A resolves later — stale, must not clobber B's status.
    resolveA({ ...STATUS, sessionId: 'a' });
    await vi.advanceTimersByTimeAsync(0);
    expect(last?.status?.sessionId).toBe('b');
  });
});
