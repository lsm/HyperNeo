/**
 * Tests for github.poll job handler
 */

import { describe, expect, it, mock, beforeEach } from 'bun:test';
import { handleGitHubPoll } from '../../../../src/lib/job-handlers/github-poll.handler';
import { GITHUB_POLL } from '../../../../src/lib/job-queue-constants';
import type { Job } from '../../../../src/storage/repositories/job-queue-repository';

function makeJob(overrides: Partial<Job> = {}): Job {
  return {
    id: 'job-1',
    queue: GITHUB_POLL,
    status: 'pending',
    payload: {},
    result: null,
    error: null,
    priority: 0,
    maxRetries: 3,
    retryCount: 0,
    runAt: Date.now() + 60000,
    createdAt: Date.now(),
    startedAt: null,
    completedAt: null,
    ...overrides,
  };
}

describe('handleGitHubPoll', () => {
  let triggerPollMock: ReturnType<typeof mock>;
  let enqueueMock: ReturnType<typeof mock>;
  let listJobsMock: ReturnType<typeof mock>;

  beforeEach(() => {
    triggerPollMock = mock(async () => {});
    enqueueMock = mock(() => makeJob());
    listJobsMock = mock(() => []);
  });

  function makeDeps(
    overrides: {
      intervalMs?: number;
      pollingService?: ReturnType<typeof mock> | undefined;
      isRunning?: boolean;
    } = {}
  ) {
    const running = overrides.isRunning ?? true;
    return {
      pollingService:
        'pollingService' in overrides
          ? overrides.pollingService
          : ({ triggerPoll: triggerPollMock, isRunning: () => running } as never),
      jobQueue: {
        enqueue: enqueueMock,
        listJobs: listJobsMock,
      } as never,
      intervalMs: overrides.intervalMs ?? 60000,
    };
  }

  it('calls triggerPoll on the polling service', async () => {
    await handleGitHubPoll(makeDeps());
    expect(triggerPollMock).toHaveBeenCalledTimes(1);
  });

  it('returns polled: true when triggerPoll succeeds', async () => {
    const result = await handleGitHubPoll(makeDeps());
    expect(result.polled).toBe(true);
  });

  it('returns a nextRunAt at least intervalMs from now', async () => {
    const before = Date.now();
    const result = await handleGitHubPoll(makeDeps({ intervalMs: 60000 }));
    expect(result.nextRunAt).toBeGreaterThanOrEqual(before + 60000);
  });

  it('enqueues next job when no pending or processing job exists', async () => {
    await handleGitHubPoll(makeDeps());

    expect(enqueueMock).toHaveBeenCalledTimes(1);
    const enqueueArg = (enqueueMock.mock.calls[0] as [{ queue: string; runAt: number }])[0];
    expect(enqueueArg.queue).toBe(GITHUB_POLL);
    expect(enqueueArg.runAt).toBeGreaterThan(Date.now());
  });

  it('skips enqueueing when a pending job already exists (dedup)', async () => {
    listJobsMock = mock(() => [makeJob({ status: 'pending' })]);
    const deps = makeDeps();
    deps.jobQueue.listJobs = listJobsMock as never;
    deps.jobQueue.enqueue = enqueueMock as never;

    await handleGitHubPoll(deps);

    expect(enqueueMock).not.toHaveBeenCalled();
  });

  it('does NOT check processing status in dedup — only pending — so self-scheduling always works', async () => {
    // The handler must NOT include 'processing' in its dedup query, because the
    // current job is itself in 'processing' state while executing. Verifying
    // that listJobs is called with 'pending' (not ['pending','processing']) is
    // the only way to confirm self-scheduling is not blocked by the handler's own
    // processing status.
    await handleGitHubPoll(makeDeps());

    const listArg = (
      listJobsMock.mock.calls[0] as [{ queue: string; status: string; limit: number }]
    )[0];
    // Must be a string (single status), not an array that includes 'processing'.
    expect(typeof listArg.status).toBe('string');
    expect(listArg.status).toBe('pending');
    expect(listArg.status).not.toContain('processing');
  });

  it('still schedules next poll when triggerPoll throws (error is caught internally)', async () => {
    triggerPollMock = mock(async () => {
      throw new Error('poll failed');
    });
    listJobsMock = mock(() => []);

    const deps = makeDeps();
    deps.pollingService = { triggerPoll: triggerPollMock, isRunning: () => true } as never;
    deps.jobQueue.listJobs = listJobsMock as never;
    deps.jobQueue.enqueue = enqueueMock as never;

    // Error is caught internally — handler resolves successfully
    const result = await handleGitHubPoll(deps);
    expect(result.polled).toBe(false);
    expect(enqueueMock).toHaveBeenCalledTimes(1);
  });

  it('queries listJobs with pending status only and GITHUB_POLL queue', async () => {
    await handleGitHubPoll(makeDeps());

    expect(listJobsMock).toHaveBeenCalledTimes(1);
    const listArg = (
      listJobsMock.mock.calls[0] as [{ queue: string; status: string; limit: number }]
    )[0];
    expect(listArg.queue).toBe(GITHUB_POLL);
    // Only 'pending' — not 'processing' — because the current job is itself
    // in 'processing' state while the handler runs; checking 'processing'
    // would always find itself and prevent self-scheduling.
    expect(listArg.status).toBe('pending');
    expect(listArg.limit).toBe(1);
  });

  it('returns polled: false when pollingService is undefined', async () => {
    const deps = makeDeps({ pollingService: undefined });
    const result = await handleGitHubPoll(deps);
    expect(result.polled).toBe(false);
    expect(triggerPollMock).not.toHaveBeenCalled();
    // Still enqueues next job
    expect(enqueueMock).toHaveBeenCalledTimes(1);
  });

  it('skips triggerPoll and returns polled: false when pollingService.isRunning() is false', async () => {
    const deps = makeDeps({ isRunning: false });
    const result = await handleGitHubPoll(deps);

    expect(triggerPollMock).not.toHaveBeenCalled();
    expect(result.polled).toBe(false);
    // Self-schedule still happens so the chain resumes when service is restarted
    expect(enqueueMock).toHaveBeenCalledTimes(1);
  });
});
