import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import type { DaemonServerContext } from '../../helpers/daemon-server';
import { createDaemonServer } from '../../helpers/daemon-server';
import type { DaemonAppContext } from '../../../src/app';
import { GITHUB_POLL } from '../../../src/lib/job-queue-constants';
import type { Job, JobStatus } from '../../../src/storage/repositories/job-queue-repository';

const GITHUB_TEST_ENV: Record<string, string> = {
  GITHUB_TOKEN: 'ghp_fake_token_for_job_queue_test',
};

const JOB_WAIT_TIMEOUT_MS = 8000;

const POLL_INTERVAL_MS = 100;

type InProcessDaemon = DaemonServerContext & { daemonContext?: DaemonAppContext };

function getDaemonCtx(daemon: DaemonServerContext): DaemonAppContext {
  const ctx = daemon as InProcessDaemon;
  if (!ctx.daemonContext) {
    throw new Error(
      'daemonContext not available — did you run in spawned mode (DAEMON_TEST_SPAWN=true)?'
    );
  }
  return ctx.daemonContext;
}

async function waitForGitHubPollJob(
  daemonCtx: DaemonAppContext,
  statuses: JobStatus[],
  timeoutMs: number = JOB_WAIT_TIMEOUT_MS
): Promise<Job | undefined> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const jobs = daemonCtx.jobQueue.listJobs({ queue: GITHUB_POLL, status: statuses });
    if (jobs.length > 0) {
      return jobs[0];
    }
    await new Promise<void>((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
  }
  return undefined;
}

async function waitForJobById(
  daemonCtx: DaemonAppContext,
  jobId: string,
  statuses: JobStatus[],
  timeoutMs: number = JOB_WAIT_TIMEOUT_MS
): Promise<Job | undefined> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const jobs = daemonCtx.jobQueue.listJobs({ queue: GITHUB_POLL, status: statuses });
    const match = jobs.find((j) => j.id === jobId);
    if (match) {
      return match;
    }
    await new Promise<void>((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
  }
  return undefined;
}

function stubTriggerPoll(daemonCtx: DaemonAppContext): boolean {
  const pollingService = daemonCtx.gitHubService?.getPollingService();
  if (!pollingService) {
    return false;
  }
  pollingService.triggerPoll = async () => {};
  return true;
}

describe('GitHub polling via job queue (online)', () => {
  let daemon: DaemonServerContext;

  beforeEach(async () => {
    daemon = await createDaemonServer({ env: GITHUB_TEST_ENV });

    const daemonCtx = getDaemonCtx(daemon);
    stubTriggerPoll(daemonCtx);
  }, 30_000);

  afterEach(async () => {
    if (daemon) {
      daemon.kill('SIGTERM');
      await daemon.waitForExit();
    }
  }, 15_000);

  test('github.poll job is enqueued on daemon startup', () => {
    const daemonCtx = getDaemonCtx(daemon);

    expect(daemonCtx.gitHubService).not.toBeNull();

    const jobs = daemonCtx.jobQueue.listJobs({
      queue: GITHUB_POLL,
      status: ['pending', 'processing', 'completed'],
    });
    expect(jobs.length).toBeGreaterThanOrEqual(1);
    expect(jobs[0].queue).toBe(GITHUB_POLL);
  });

  test('job transitions through processing and reaches completed', async () => {
    const daemonCtx = getDaemonCtx(daemon);

    const completed = await waitForGitHubPollJob(daemonCtx, ['completed']);

    expect(completed).toBeDefined();
    expect(completed!.queue).toBe(GITHUB_POLL);
    expect(completed!.status).toBe('completed');
    expect(completed!.completedAt).not.toBeNull();
  }, 15_000);

  test('self-scheduling: next poll job is enqueued after the initial job completes', async () => {
    const daemonCtx = getDaemonCtx(daemon);

    const firstCompleted = await waitForGitHubPollJob(daemonCtx, ['completed']);
    expect(firstCompleted).toBeDefined();

    const next = await waitForGitHubPollJob(daemonCtx, ['pending']);
    expect(next).toBeDefined();
    expect(next!.queue).toBe(GITHUB_POLL);

    const minExpectedRunAt = Date.now() + 100_000;
    expect(next!.runAt).toBeGreaterThan(minExpectedRunAt);
  }, 15_000);

  test('dedup: at most one pending github.poll job exists at any time', async () => {
    const daemonCtx = getDaemonCtx(daemon);

    const atStartup = daemonCtx.jobQueue.listJobs({
      queue: GITHUB_POLL,
      status: ['pending', 'processing'],
    });
    expect(atStartup.length).toBe(1);

    await waitForGitHubPollJob(daemonCtx, ['completed']);
    await waitForGitHubPollJob(daemonCtx, ['pending']);

    const pendingJobs = daemonCtx.jobQueue.listJobs({
      queue: GITHUB_POLL,
      status: ['pending'],
    });
    expect(pendingJobs.length).toBeLessThanOrEqual(1);
  }, 15_000);

  test('github service polling is active (isPolling returns true)', () => {
    const daemonCtx = getDaemonCtx(daemon);

    expect(daemonCtx.gitHubService).not.toBeNull();
    expect(daemonCtx.gitHubService!.isPolling()).toBe(true);
  });

  test('recovery: stale processing job from a simulated crash is reclaimed and completes', async () => {
    const daemonCtx = getDaemonCtx(daemon);
    stubTriggerPoll(daemonCtx);

    await waitForGitHubPollJob(daemonCtx, ['completed']);

    const crashedStartedAt = Date.now() - 6 * 60 * 1000;
    const rawDb = daemonCtx.db.getDatabase();
    const staleJobId = crypto.randomUUID();
    rawDb
      .prepare(
        `INSERT INTO job_queue
				(id, queue, status, payload, result, error, priority, max_retries, retry_count, run_at, created_at, started_at, completed_at)
				VALUES (?, ?, 'processing', '{}', NULL, NULL, 0, 3, 0, ?, ?, ?, NULL)`
      )
      .run(staleJobId, GITHUB_POLL, crashedStartedAt, crashedStartedAt, crashedStartedAt);

    const beforeReclaim = daemonCtx.jobQueue.listJobs({
      queue: GITHUB_POLL,
      status: ['processing'],
    });
    expect(beforeReclaim.some((j) => j.id === staleJobId)).toBe(true);

    const reclaimed = daemonCtx.jobQueue.reclaimStale(Date.now() - 5 * 60 * 1000);
    expect(reclaimed.some((claim) => claim.jobId === staleJobId)).toBe(true);

    const afterReclaim = daemonCtx.jobQueue.listJobs({
      queue: GITHUB_POLL,
      status: ['pending'],
    });
    expect(afterReclaim.some((j) => j.id === staleJobId)).toBe(true);

    const completed = await waitForJobById(daemonCtx, staleJobId, ['completed']);
    expect(completed).toBeDefined();
    expect(completed!.status).toBe('completed');
  }, 15_000);
});
