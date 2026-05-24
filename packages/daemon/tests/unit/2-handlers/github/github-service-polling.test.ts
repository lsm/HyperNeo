/**
 * Integration-style unit tests for GitHubService job-queue-driven polling.
 *
 * Verifies the full flow:
 *   GitHubService.start()
 *     → registers github.poll handler on jobProcessor
 *     → enqueues initial github.poll job
 *   handler invocation
 *     → calls triggerPoll on the polling service
 *     → self-schedules next job
 */

import { describe, expect, it, mock, beforeEach, afterEach } from 'bun:test';
import { Database as SqliteDatabase } from 'bun:sqlite';
import { GitHubService } from '../../../../src/lib/github/github-service';
import { GITHUB_POLL } from '../../../../src/lib/job-queue-constants';
import type { Job } from '../../../../src/storage/repositories/job-queue-repository';
import type { Database } from '../../../../src/storage/database';

// ─── Helpers ────────────────────────────────────────────────────────────────

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

function makeDb(): Database {
  // FilterConfigManager needs a real SQLite db with .prepare()
  const sqlite = new SqliteDatabase(':memory:');
  return {
    getDatabase: () => sqlite,
    listGitHubMappingsForRepository: mock(() => []),
    listGitHubMappings: mock(() => []),
    getGitHubMappingByRoomId: mock(() => null),
    countInboxItemsByStatus: mock(() => 0),
    listPendingInboxItems: mock(() => []),
    getInboxItem: mock(() => null),
    createInboxItem: mock(() => ({})),
    updateInboxItem: mock(() => null),
  } as unknown as Database;
}

function makeDaemonHub() {
  return { emit: mock(() => {}) } as never;
}

function makeConfig(overrides: Record<string, unknown> = {}) {
  return {
    githubPollingInterval: 60, // seconds
    githubWebhookSecret: undefined,
    ...overrides,
  } as never;
}

// ─── Tests ───────────────────────────────────────────────────────────────────

describe('GitHubService — job-queue-driven polling', () => {
  let registerMock: ReturnType<typeof mock>;
  let enqueueMock: ReturnType<typeof mock>;
  let listJobsMock: ReturnType<typeof mock>;

  beforeEach(() => {
    registerMock = mock(() => {});
    enqueueMock = mock(() => makeJob());
    listJobsMock = mock(() => []); // no existing jobs → enqueue initial
  });

  afterEach(() => {
    mock.restore();
  });

  function makeJobProcessor() {
    return {
      register: registerMock,
    } as never;
  }

  function makeJobQueue(listOverride?: ReturnType<typeof mock>) {
    return {
      enqueue: enqueueMock,
      listJobs: listOverride ?? listJobsMock,
    } as never;
  }

  function makeService(configOverrides: Record<string, unknown> = {}) {
    return new GitHubService({
      db: makeDb(),
      daemonHub: makeDaemonHub(),
      config: makeConfig(configOverrides),
      apiKey: 'test-api-key',
      githubToken: 'test-github-token',
      jobQueue: makeJobQueue(),
      jobProcessor: makeJobProcessor(),
    });
  }

  it('registers github.poll handler on jobProcessor when start() is called', () => {
    const svc = makeService();
    svc.start();

    expect(registerMock).toHaveBeenCalledTimes(1);
    const [queue] = registerMock.mock.calls[0] as [string, unknown];
    expect(queue).toBe(GITHUB_POLL);
  });

  it('enqueues initial github.poll job immediately on start()', () => {
    const svc = makeService();
    svc.start();

    expect(enqueueMock).toHaveBeenCalledTimes(1);
    const [arg] = enqueueMock.mock.calls[0] as [{ queue: string; runAt: number }];
    expect(arg.queue).toBe(GITHUB_POLL);
    // runAt should be approximately now (within 2 seconds)
    expect(arg.runAt).toBeGreaterThanOrEqual(Date.now() - 100);
    expect(arg.runAt).toBeLessThanOrEqual(Date.now() + 2000);
  });

  it('skips initial enqueue when a pending job already exists (dedup)', () => {
    const listWithExisting = mock(() => [makeJob({ status: 'pending' })]);
    const svc = new GitHubService({
      db: makeDb(),
      daemonHub: makeDaemonHub(),
      config: makeConfig(),
      apiKey: 'test-api-key',
      githubToken: 'test-github-token',
      jobQueue: makeJobQueue(listWithExisting),
      jobProcessor: makeJobProcessor(),
    });

    svc.start();

    expect(enqueueMock).not.toHaveBeenCalled();
  });

  it('skips initial enqueue when a processing job already exists (dedup)', () => {
    const listWithExisting = mock(() => [makeJob({ status: 'processing' })]);
    const svc = new GitHubService({
      db: makeDb(),
      daemonHub: makeDaemonHub(),
      config: makeConfig(),
      apiKey: 'test-api-key',
      githubToken: 'test-github-token',
      jobQueue: makeJobQueue(listWithExisting),
      jobProcessor: makeJobProcessor(),
    });

    svc.start();

    expect(enqueueMock).not.toHaveBeenCalled();
  });

  it('does not register handler or enqueue when jobProcessor is absent', () => {
    const svc = new GitHubService({
      db: makeDb(),
      daemonHub: makeDaemonHub(),
      config: makeConfig(),
      apiKey: 'test-api-key',
      githubToken: 'test-github-token',
      // no jobQueue / jobProcessor
    });

    svc.start();

    expect(registerMock).not.toHaveBeenCalled();
    expect(enqueueMock).not.toHaveBeenCalled();
  });

  it('does not register handler or enqueue when polling interval is 0', () => {
    const svc = new GitHubService({
      db: makeDb(),
      daemonHub: makeDaemonHub(),
      config: makeConfig({ githubPollingInterval: 0 }),
      apiKey: 'test-api-key',
      githubToken: 'test-github-token',
      jobQueue: makeJobQueue(),
      jobProcessor: makeJobProcessor(),
    });

    svc.start();

    expect(registerMock).not.toHaveBeenCalled();
    expect(enqueueMock).not.toHaveBeenCalled();
  });

  it('does not register handler or enqueue when githubToken is absent', () => {
    const svc = new GitHubService({
      db: makeDb(),
      daemonHub: makeDaemonHub(),
      config: makeConfig(),
      apiKey: 'test-api-key',
      // no githubToken
      jobQueue: makeJobQueue(),
      jobProcessor: makeJobProcessor(),
    });

    svc.start();

    expect(registerMock).not.toHaveBeenCalled();
    expect(enqueueMock).not.toHaveBeenCalled();
  });

  it('registered handler calls triggerPoll and self-schedules next job', async () => {
    // Capture the registered handler so we can invoke it directly.
    let capturedHandler: (() => Promise<unknown>) | undefined;
    const capturingRegister = mock((_queue: string, handler: () => Promise<unknown>) => {
      capturedHandler = handler;
    });

    const svc = new GitHubService({
      db: makeDb(),
      daemonHub: makeDaemonHub(),
      config: makeConfig(),
      apiKey: 'test-api-key',
      githubToken: 'test-github-token',
      jobQueue: makeJobQueue(),
      jobProcessor: { register: capturingRegister } as never,
    });

    svc.start();

    expect(capturedHandler).toBeDefined();

    // Polling service was created by start(); getPollingService() returns it.
    const pollingService = svc.getPollingService()!;
    expect(pollingService).toBeDefined();

    // Spy on triggerPoll.
    const triggerPollMock = mock(async () => {});
    (pollingService as never as Record<string, unknown>).triggerPoll = triggerPollMock;

    // Reset enqueueMock to count only the self-schedule enqueue from the handler.
    // The initial enqueue happened during start() already.
    enqueueMock.mockClear();

    // Point the captured jobQueue to fresh mocks for the handler's dedup check.
    // (Assigning jobQueueInService.listJobs is what matters — the handler references
    // the jobQueue object stored on svc, not the outer listJobsMock variable.)
    const jobQueueInService = (svc as never as Record<string, unknown>).jobQueue as {
      listJobs: ReturnType<typeof mock>;
      enqueue: ReturnType<typeof mock>;
    };
    jobQueueInService.listJobs = mock(() => []);
    jobQueueInService.enqueue = enqueueMock;

    const result = await capturedHandler!();

    // triggerPoll was called once
    expect(triggerPollMock).toHaveBeenCalledTimes(1);

    // Handler returns { polled: true, nextRunAt }
    expect((result as Record<string, unknown>).polled).toBe(true);
    expect(typeof (result as Record<string, unknown>).nextRunAt).toBe('number');

    // Self-schedule: one new job was enqueued with a future runAt
    expect(enqueueMock).toHaveBeenCalledTimes(1);
    const [enqueueArg] = enqueueMock.mock.calls[0] as [{ queue: string; runAt: number }];
    expect(enqueueArg.queue).toBe(GITHUB_POLL);
    expect(enqueueArg.runAt).toBeGreaterThan(Date.now());
  });

  it('isPolling() returns false after stop(), and isRunning() on pollingService is false', () => {
    const svc = makeService();
    svc.start();

    expect(svc.isPolling()).toBe(true);
    const pollingService = svc.getPollingService()!;
    expect(pollingService.isRunning()).toBe(true);

    svc.stop();

    // After stop() the state flag is cleared; no job-queue chain is drained
    // (that requires stopping the JobQueueProcessor itself, done in app.ts shutdown).
    expect(svc.isPolling()).toBe(false);
    expect(pollingService.isRunning()).toBe(false);
  });

  it('handler skips triggerPoll when pollingService.isRunning() is false', async () => {
    let capturedHandler: (() => Promise<unknown>) | undefined;
    const capturingRegister = mock((_queue: string, handler: () => Promise<unknown>) => {
      capturedHandler = handler;
    });

    const svc = new GitHubService({
      db: makeDb(),
      daemonHub: makeDaemonHub(),
      config: makeConfig(),
      apiKey: 'test-api-key',
      githubToken: 'test-github-token',
      jobQueue: makeJobQueue(),
      jobProcessor: { register: capturingRegister } as never,
    });

    svc.start();

    // Save the pollingService reference before stop() clears it on the service.
    const pollingService = svc.getPollingService()!;
    expect(pollingService).toBeDefined();

    // Stop the service — sets pollingService.running = false
    svc.stop();

    const triggerPollMock = mock(async () => {});
    (pollingService as never as Record<string, unknown>).triggerPoll = triggerPollMock;

    enqueueMock.mockClear();
    const jobQueueInService = (svc as never as Record<string, unknown>).jobQueue as {
      listJobs: ReturnType<typeof mock>;
      enqueue: ReturnType<typeof mock>;
    };
    jobQueueInService.listJobs = mock(() => []);
    jobQueueInService.enqueue = enqueueMock;

    const result = await capturedHandler!();

    // triggerPoll must NOT be called when the service is stopped
    expect(triggerPollMock).not.toHaveBeenCalled();
    expect((result as Record<string, unknown>).polled).toBe(false);

    // But the chain self-schedules so polling resumes automatically when restarted
    expect(enqueueMock).toHaveBeenCalledTimes(1);
  });
});
