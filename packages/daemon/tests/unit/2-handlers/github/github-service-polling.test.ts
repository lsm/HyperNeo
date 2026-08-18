import { describe, expect, it, mock, beforeEach, afterEach } from 'bun:test';
import { Database as SqliteDatabase } from '../../../../src/storage/sqlite-compat';
import { GitHubService } from '../../../../src/lib/github/github-service';
import { GITHUB_POLL } from '../../../../src/lib/job-queue-constants';
import type { Job } from '../../../../src/storage/repositories/job-queue-repository';
import type { Database } from '../../../../src/storage/database';

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
    githubWebhookSecret: undefined,
    ...overrides,
  } as never;
}

describe('GitHubService — job-queue-driven polling', () => {
  let registerMock: ReturnType<typeof mock>;
  let enqueueMock: ReturnType<typeof mock>;
  let listJobsMock: ReturnType<typeof mock>;
  let deleteJobMock: ReturnType<typeof mock>;

  beforeEach(() => {
    registerMock = mock(() => {});
    enqueueMock = mock(() => makeJob());
    listJobsMock = mock(() => []);
    deleteJobMock = mock(() => true);
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
      deleteJob: deleteJobMock,
    } as never;
  }

  function makeService(
    configOverrides: Record<string, unknown> = {},
    getPollingIntervalSeconds = () => 60
  ) {
    return new GitHubService({
      db: makeDb(),
      internalEventBus: makeDaemonHub(),
      config: makeConfig(configOverrides),
      apiKey: 'test-api-key',
      githubToken: 'test-github-token',
      jobQueue: makeJobQueue(),
      jobProcessor: makeJobProcessor(),
      getPollingIntervalSeconds,
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
    expect(arg.runAt).toBeGreaterThanOrEqual(Date.now() - 100);
    expect(arg.runAt).toBeLessThanOrEqual(Date.now() + 2000);
  });

  it('skips initial enqueue when a pending job already exists (dedup)', () => {
    const listWithExisting = mock(() => [makeJob({ status: 'pending' })]);
    const svc = new GitHubService({
      db: makeDb(),
      internalEventBus: makeDaemonHub(),
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
      internalEventBus: makeDaemonHub(),
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
      internalEventBus: makeDaemonHub(),
      config: makeConfig(),
      apiKey: 'test-api-key',
      githubToken: 'test-github-token',
    });

    svc.start();

    expect(registerMock).not.toHaveBeenCalled();
    expect(enqueueMock).not.toHaveBeenCalled();
  });

  it('does not register handler or enqueue when polling interval is 0', () => {
    const svc = new GitHubService({
      db: makeDb(),
      internalEventBus: makeDaemonHub(),
      config: makeConfig(),
      apiKey: 'test-api-key',
      githubToken: 'test-github-token',
      jobQueue: makeJobQueue(),
      jobProcessor: makeJobProcessor(),
      getPollingIntervalSeconds: () => 0,
    });

    svc.start();

    expect(registerMock).not.toHaveBeenCalled();
    expect(enqueueMock).not.toHaveBeenCalled();
  });

  it('does not register handler or enqueue when githubToken is absent', () => {
    const svc = new GitHubService({
      db: makeDb(),
      internalEventBus: makeDaemonHub(),
      config: makeConfig(),
      apiKey: 'test-api-key',
      jobQueue: makeJobQueue(),
      jobProcessor: makeJobProcessor(),
    });

    svc.start();

    expect(registerMock).not.toHaveBeenCalled();
    expect(enqueueMock).not.toHaveBeenCalled();
  });

  it('registered handler calls triggerPoll and self-schedules next job', async () => {
    let capturedHandler: (() => Promise<unknown>) | undefined;
    const capturingRegister = mock((_queue: string, handler: () => Promise<unknown>) => {
      capturedHandler = handler;
    });

    const svc = new GitHubService({
      db: makeDb(),
      internalEventBus: makeDaemonHub(),
      config: makeConfig(),
      apiKey: 'test-api-key',
      githubToken: 'test-github-token',
      jobQueue: makeJobQueue(),
      jobProcessor: { register: capturingRegister } as never,
      getPollingIntervalSeconds: () => 60,
    });

    svc.start();

    expect(capturedHandler).toBeDefined();

    const pollingService = svc.getPollingService()!;
    expect(pollingService).toBeDefined();

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

    expect(triggerPollMock).toHaveBeenCalledTimes(1);

    expect((result as Record<string, unknown>).polled).toBe(true);
    expect(typeof (result as Record<string, unknown>).nextRunAt).toBe('number');

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
      internalEventBus: makeDaemonHub(),
      config: makeConfig(),
      apiKey: 'test-api-key',
      githubToken: 'test-github-token',
      jobQueue: makeJobQueue(),
      jobProcessor: { register: capturingRegister } as never,
      getPollingIntervalSeconds: () => 60,
    });

    svc.start();

    const pollingService = svc.getPollingService()!;
    expect(pollingService).toBeDefined();

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

    expect(triggerPollMock).not.toHaveBeenCalled();
    expect((result as Record<string, unknown>).polled).toBe(false);

    expect(enqueueMock).toHaveBeenCalledTimes(1);
  });

  it('recomputes interval after an in-flight poll before self-scheduling', async () => {
    let intervalSeconds = 60;
    let capturedHandler: (() => Promise<unknown>) | undefined;
    const capturingRegister = mock((_queue: string, handler: () => Promise<unknown>) => {
      capturedHandler = handler;
    });

    const svc = new GitHubService({
      db: makeDb(),
      internalEventBus: makeDaemonHub(),
      config: makeConfig(),
      apiKey: 'test-api-key',
      githubToken: 'test-github-token',
      jobQueue: makeJobQueue(),
      jobProcessor: { register: capturingRegister } as never,
      getPollingIntervalSeconds: () => intervalSeconds,
    });

    svc.start();
    const pollingService = svc.getPollingService()!;
    pollingService.triggerPoll = mock(async () => {
      intervalSeconds = 30;
    });
    enqueueMock.mockClear();

    await capturedHandler!();

    const [arg] = enqueueMock.mock.calls[0] as [{ runAt: number }];
    expect(arg.runAt).toBeGreaterThanOrEqual(Date.now() + 29_000);
    expect(arg.runAt).toBeLessThanOrEqual(Date.now() + 31_000);
  });

  it('replaces pending github.poll jobs when rescheduling after an interval change', () => {
    const pendingJob = makeJob({
      id: 'pending-job',
      status: 'pending',
      runAt: Date.now() + 120_000,
    });
    const listWithPending = mock((filter?: { status?: string | string[] }) => {
      const status = filter?.status;
      if (status === 'pending') return [pendingJob];
      if (Array.isArray(status) && status.includes('pending')) return [];
      return [];
    });

    const svc = new GitHubService({
      db: makeDb(),
      internalEventBus: makeDaemonHub(),
      config: makeConfig(),
      apiKey: 'test-api-key',
      githubToken: 'test-github-token',
      jobQueue: makeJobQueue(listWithPending),
      jobProcessor: makeJobProcessor(),
      getPollingIntervalSeconds: () => 30,
    });

    svc.start();
    enqueueMock.mockClear();
    deleteJobMock.mockClear();

    svc.refreshPolling({ reschedulePending: true });

    expect(deleteJobMock).toHaveBeenCalledWith('pending-job');
    expect(enqueueMock).toHaveBeenCalledTimes(1);
    const [arg] = enqueueMock.mock.calls[0] as [{ runAt: number }];
    expect(arg.runAt).toBeLessThanOrEqual(Date.now() + 100);
  });

  it('deletes pending github.poll jobs when polling is disabled', () => {
    const pendingJob = makeJob({ id: 'pending-job', status: 'pending' });
    const listWithPending = mock((filter?: { status?: string | string[] }) =>
      filter?.status === 'pending' ? [pendingJob] : []
    );

    const svc = new GitHubService({
      db: makeDb(),
      internalEventBus: makeDaemonHub(),
      config: makeConfig(),
      apiKey: 'test-api-key',
      githubToken: 'test-github-token',
      jobQueue: makeJobQueue(listWithPending),
      jobProcessor: makeJobProcessor(),
      getPollingIntervalSeconds: () => 0,
    });

    svc.start();

    expect(deleteJobMock).toHaveBeenCalledWith('pending-job');
    expect(enqueueMock).not.toHaveBeenCalled();
  });

  it('uses the latest polling interval when self-scheduling jobs', async () => {
    let intervalSeconds = 60;
    let capturedHandler: (() => Promise<unknown>) | undefined;
    const capturingRegister = mock((_queue: string, handler: () => Promise<unknown>) => {
      capturedHandler = handler;
    });

    const svc = new GitHubService({
      db: makeDb(),
      internalEventBus: makeDaemonHub(),
      config: makeConfig(),
      apiKey: 'test-api-key',
      githubToken: 'test-github-token',
      jobQueue: makeJobQueue(),
      jobProcessor: { register: capturingRegister } as never,
      getPollingIntervalSeconds: () => intervalSeconds,
    });

    svc.start();
    intervalSeconds = 30;
    enqueueMock.mockClear();

    await capturedHandler!();

    const delayedJob = enqueueMock.mock.calls.find((call) => {
      const [arg] = call as [{ runAt: number }];
      return arg.runAt > Date.now() + 20_000;
    });
    expect(delayedJob).toBeDefined();
    const [arg] = delayedJob as [{ runAt: number }];
    expect(arg.runAt).toBeGreaterThanOrEqual(Date.now() + 29_000);
    expect(arg.runAt).toBeLessThanOrEqual(Date.now() + 31_000);
  });
});
