/**
 * Online test: GitHub polling via job queue
 *
 * Verifies end-to-end GitHub polling job queue mechanics without making real
 * GitHub API calls:
 * - Initial github.poll job is enqueued on startup
 * - Job transitions through pending -> processing -> completed
 * - Self-scheduling: next poll job is automatically enqueued after completion
 * - Dedup: no duplicate pending poll jobs exist simultaneously (including
 *   during the processing window)
 * - Recovery: a stale processing job left by a simulated crash is reclaimed
 *   by reclaimStale() and eventually completes
 *
 * GitHubPollingService.triggerPoll() is stubbed immediately after daemon
 * startup to prevent any real GitHub API calls. Even without the stub the
 * handler is safe (errors are caught internally), but the stub makes intent
 * explicit and avoids spurious network noise.
 *
 * NOTE: dev proxy intercepts Anthropic API calls only. This test does not
 * send any Claude messages, so no Anthropic calls are made either.
 *
 * Run:
 *   cd packages/daemon && HYPERNEO_USE_DEV_PROXY=1 bun test ./tests/online/features/github-poll-job.test.ts
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import type { DaemonServerContext } from '../../helpers/daemon-server';
import { createDaemonServer } from '../../helpers/daemon-server';
import type { DaemonAppContext } from '../../../src/app';
import { GITHUB_POLL } from '../../../src/lib/job-queue-constants';
import type { Job, JobStatus } from '../../../src/storage/repositories/job-queue-repository';

// ---------------------------------------------------------------------------
// Test configuration
// ---------------------------------------------------------------------------

/**
 * Environment variables injected into the in-process daemon to enable GitHub
 * polling without touching real credentials.
 *
 * The persisted global GitHub polling interval defaults to 120 seconds, which
 * keeps self-scheduled jobs far enough in the future for stable assertions.
 *
 * GITHUB_TOKEN is a fake value that satisfies the token-presence guard inside
 * GitHubService. No repositories are added to the polling service, so
 * triggerPoll() is a no-op even before the stub is applied.
 */
const GITHUB_TEST_ENV: Record<string, string> = {
  GITHUB_TOKEN: 'ghp_fake_token_for_job_queue_test',
};

/** Maximum time (ms) to wait for a job to reach a desired status. */
const JOB_WAIT_TIMEOUT_MS = 8000;

/** Polling cadence for job-status checks. */
const POLL_INTERVAL_MS = 100;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

type InProcessDaemon = DaemonServerContext & { daemonContext?: DaemonAppContext };

/** Extract the DaemonAppContext from an in-process daemon. */
function getDaemonCtx(daemon: DaemonServerContext): DaemonAppContext {
  const ctx = daemon as InProcessDaemon;
  if (!ctx.daemonContext) {
    throw new Error(
      'daemonContext not available — did you run in spawned mode (DAEMON_TEST_SPAWN=true)?'
    );
  }
  return ctx.daemonContext;
}

/**
 * Poll the job queue until at least one github.poll job exists with one of
 * the given statuses, or until the timeout expires.
 *
 * Returns the first matching job, or undefined on timeout.
 */
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

/**
 * Poll the job queue until a specific job (by id) reaches one of the given
 * statuses, or until the timeout expires.
 */
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

/**
 * Stub triggerPoll() on the polling service so no real GitHub HTTP requests
 * are made during the test. Returns true if the stub was applied.
 */
function stubTriggerPoll(daemonCtx: DaemonAppContext): boolean {
  const pollingService = daemonCtx.gitHubService?.getPollingService();
  if (!pollingService) {
    return false;
  }
  pollingService.triggerPoll = async () => {};
  return true;
}

// ---------------------------------------------------------------------------
// Test suite
// ---------------------------------------------------------------------------

describe('GitHub polling via job queue (online)', () => {
  let daemon: DaemonServerContext;

  beforeEach(async () => {
    daemon = await createDaemonServer({ env: GITHUB_TEST_ENV });

    // Stub triggerPoll as early as possible.  The job processor polls every
    // 1 s, so this window is reliable.  Even if the first job fires before
    // the stub is applied it still completes safely because:
    //   a) no repositories are registered → pollAllRepositories() is a no-op
    //   b) any error from triggerPoll() is caught inside handleGitHubPoll()
    const daemonCtx = getDaemonCtx(daemon);
    stubTriggerPoll(daemonCtx);
  }, 30_000);

  afterEach(async () => {
    if (daemon) {
      daemon.kill('SIGTERM');
      await daemon.waitForExit();
    }
  }, 15_000);

  // -------------------------------------------------------------------------

  test('github.poll job is enqueued on daemon startup', () => {
    const daemonCtx = getDaemonCtx(daemon);

    // gitHubService.start() enqueues the initial job synchronously before
    // the daemon returns from createDaemonServer(), so it is visible
    // immediately — no polling loop needed.
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

    // Wait for the initial job to complete.
    const firstCompleted = await waitForGitHubPollJob(daemonCtx, ['completed']);
    expect(firstCompleted).toBeDefined();

    // The handler must have enqueued a new pending job for the next cycle.
    const next = await waitForGitHubPollJob(daemonCtx, ['pending']);
    expect(next).toBeDefined();
    expect(next!.queue).toBe(GITHUB_POLL);

    // The next job should be scheduled ~120 s from now (default global settings).
    // We verify it is at least 100 s in the future to allow for minor clock skew.
    const minExpectedRunAt = Date.now() + 100_000;
    expect(next!.runAt).toBeGreaterThan(minExpectedRunAt);
  }, 15_000);

  test('dedup: at most one pending github.poll job exists at any time', async () => {
    const daemonCtx = getDaemonCtx(daemon);

    // Assert immediately after startup: exactly 1 job exists (the initial
    // pending job) and 0 duplicates.  The processor has not picked it up yet
    // because it polls every 1 s and we are measuring right after startup.
    const atStartup = daemonCtx.jobQueue.listJobs({
      queue: GITHUB_POLL,
      status: ['pending', 'processing'],
    });
    expect(atStartup.length).toBe(1);

    // Let the initial job run and the next job be enqueued.
    await waitForGitHubPollJob(daemonCtx, ['completed']);
    await waitForGitHubPollJob(daemonCtx, ['pending']);

    // After self-scheduling: still exactly 1 pending job, never more.
    const pendingJobs = daemonCtx.jobQueue.listJobs({
      queue: GITHUB_POLL,
      status: ['pending'],
    });
    expect(pendingJobs.length).toBeLessThanOrEqual(1);
  }, 15_000);

  test('github service polling is active (isPolling returns true)', () => {
    const daemonCtx = getDaemonCtx(daemon);

    // gitHubService should be initialized because the default polling interval is > 0
    // and a GITHUB_TOKEN was provided.
    expect(daemonCtx.gitHubService).not.toBeNull();
    expect(daemonCtx.gitHubService!.isPolling()).toBe(true);
  });

  test('recovery: stale processing job from a simulated crash is reclaimed and completes', async () => {
    const daemonCtx = getDaemonCtx(daemon);
    stubTriggerPoll(daemonCtx);

    // Wait for the initial job to finish so no real processing jobs exist.
    await waitForGitHubPollJob(daemonCtx, ['completed']);

    // Simulate a daemon crash: insert a github.poll job directly into the
    // database with status='processing' and a started_at that is 6 minutes
    // old (exceeding the processor's 5-minute stale threshold).
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

    // Verify the stale job is visible as 'processing' before reclamation.
    const beforeReclaim = daemonCtx.jobQueue.listJobs({
      queue: GITHUB_POLL,
      status: ['processing'],
    });
    expect(beforeReclaim.some((j) => j.id === staleJobId)).toBe(true);

    // Trigger stale reclamation with a 5-minute cutoff — exactly what
    // JobQueueProcessor.start() does eagerly on daemon restart.
    const reclaimed = daemonCtx.jobQueue.reclaimStale(Date.now() - 5 * 60 * 1000);
    expect(reclaimed.some((claim) => claim.jobId === staleJobId)).toBe(true);

    // The reclaimed job is now 'pending' and ready to be picked up.
    const afterReclaim = daemonCtx.jobQueue.listJobs({
      queue: GITHUB_POLL,
      status: ['pending'],
    });
    expect(afterReclaim.some((j) => j.id === staleJobId)).toBe(true);

    // The running job processor picks it up and completes it.
    const completed = await waitForJobById(daemonCtx, staleJobId, ['completed']);
    expect(completed).toBeDefined();
    expect(completed!.status).toBe('completed');
  }, 15_000);
});
