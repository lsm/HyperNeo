/**
 * Session Title Generation Job Queue Online Tests
 *
 * These tests verify that session title generation works end-to-end through
 * the persistent job queue, including job status transitions and retry-on-failure.
 *
 * MODES:
 * - Real API (default): Requires CLAUDE_CODE_OAUTH_TOKEN or ANTHROPIC_API_KEY
 * - Dev Proxy: Set HYPERNEO_USE_DEV_PROXY=1 for offline testing with mocked responses
 *
 * Run with Dev Proxy:
 *   cd packages/daemon && HYPERNEO_USE_DEV_PROXY=1 bun test ./tests/online/lifecycle/session-title-job.test.ts
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import type { DaemonServerContext } from '../../helpers/daemon-server';
import { createDaemonServer } from '../../helpers/daemon-server';
import { sendMessage, waitForIdle } from '../../helpers/daemon-actions';
import type { DaemonAppContext } from '../../../src/app';
import type { Job } from '../../../src/storage/repositories/job-queue-repository';
import { SESSION_TITLE_GENERATION } from '../../../src/lib/job-queue-constants';

// Detect mock mode for faster timeouts (Dev Proxy)
const IS_MOCK = !!process.env.HYPERNEO_USE_DEV_PROXY;
const MODEL = IS_MOCK ? 'haiku' : 'haiku-4.5';
const IDLE_TIMEOUT = IS_MOCK ? 5000 : 45000;
const SETUP_TIMEOUT = IS_MOCK ? 15000 : 30000;
const TEST_TIMEOUT = IS_MOCK ? 30000 : 90000;
const JOB_POLL_TIMEOUT = IS_MOCK ? 20000 : 30000;

// Exponential backoff for retry (2^0 * 1000 = 1000ms for first retry)
const RETRY_DELAY_MS = 1100;

type DaemonWithContext = DaemonServerContext & { daemonContext: DaemonAppContext };

/**
 * Poll job queue until a matching job reaches the expected status.
 */
async function waitForJobStatus(
  daemon: DaemonWithContext,
  queue: string,
  expectedStatus: string | string[],
  timeoutMs = JOB_POLL_TIMEOUT
): Promise<Job> {
  const statuses = Array.isArray(expectedStatus) ? expectedStatus : [expectedStatus];
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    const jobs = daemon.daemonContext.jobQueue.listJobs({ queue, limit: 10 });
    const match = jobs.find((j) => statuses.includes(j.status));
    if (match) {
      return match;
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }

  // Final snapshot for diagnostics
  const jobs = daemon.daemonContext.jobQueue.listJobs({ queue, limit: 10 });
  throw new Error(
    `Timeout waiting for job in queue "${queue}" to reach status [${statuses.join(',')}] after ${timeoutMs}ms. ` +
      `Current jobs: ${JSON.stringify(jobs.map((j) => ({ id: j.id, status: j.status, retryCount: j.retryCount })))}`
  );
}

/**
 * Poll session until title is generated (titleGenerated flag is true).
 */
async function waitForTitleGenerated(
  daemon: DaemonWithContext,
  sessionId: string,
  timeoutMs = JOB_POLL_TIMEOUT
): Promise<void> {
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    const session = await daemon.messageHub.request('session.get', { sessionId });
    const meta = (session as { session?: { metadata?: { titleGenerated?: boolean } } })?.session
      ?.metadata;
    if (meta?.titleGenerated) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }

  const session = await daemon.messageHub.request('session.get', { sessionId });
  throw new Error(
    `Timeout waiting for titleGenerated after ${timeoutMs}ms. Session: ${JSON.stringify(session)}`
  );
}

describe('Session Title Generation via Job Queue', () => {
  let daemon: DaemonWithContext;

  beforeEach(async () => {
    daemon = (await createDaemonServer()) as DaemonWithContext;
    if (!daemon.daemonContext) {
      throw new Error(
        'session-title-job tests require in-process daemon mode. ' +
          'Unset DAEMON_TEST_SPAWN to run these tests.'
      );
    }
  }, SETUP_TIMEOUT);

  afterEach(async () => {
    if (daemon) {
      daemon.kill('SIGTERM');
      await daemon.waitForExit();
    }
  }, SETUP_TIMEOUT);

  test(
    'should enqueue and complete a session.title_generation job on first message',
    async () => {
      // Create session
      const { sessionId } = (await daemon.messageHub.request('session.create', {
        workspacePath: process.cwd(),
        config: { model: MODEL },
      })) as { sessionId: string };
      daemon.trackSession(sessionId);

      // Verify no title job exists yet
      const initialJobs = daemon.daemonContext.jobQueue.listJobs({
        queue: SESSION_TITLE_GENERATION,
      });
      expect(initialJobs.length).toBe(0);

      // Send first message — this triggers title generation job enqueue
      await sendMessage(daemon, sessionId, 'What is 2+2? Reply with the number.');

      // Verify job was enqueued (may already be processing or completed in fast modes)
      const enqueuedJob = await waitForJobStatus(daemon, SESSION_TITLE_GENERATION, [
        'pending',
        'processing',
        'completed',
      ]);
      expect(enqueuedJob.payload.sessionId).toBe(sessionId);
      expect(typeof enqueuedJob.payload.userMessageText).toBe('string');
      expect((enqueuedJob.payload.userMessageText as string).length).toBeGreaterThan(0);
      expect(enqueuedJob.maxRetries).toBe(2);

      // Wait for job to complete
      const completedJob = await waitForJobStatus(daemon, SESSION_TITLE_GENERATION, 'completed');
      expect(completedJob.id).toBe(enqueuedJob.id);
      expect(completedJob.status).toBe('completed');
      expect(completedJob.result).toMatchObject({ generated: true });
      expect(completedJob.completedAt).toBeNumber();
      expect(completedJob.retryCount).toBe(0);

      // Verify title was updated on the session
      await waitForTitleGenerated(daemon, sessionId);

      const { session } = (await daemon.messageHub.request('session.get', { sessionId })) as {
        session: { title: string; metadata: { titleGenerated: boolean } };
      };
      expect(session.metadata.titleGenerated).toBe(true);
      expect(session.title).not.toBe('New Session');
      expect(session.title.length).toBeGreaterThan(0);
    },
    TEST_TIMEOUT
  );

  test(
    'should not enqueue title job for subsequent messages',
    async () => {
      // Create session
      const { sessionId } = (await daemon.messageHub.request('session.create', {
        workspacePath: process.cwd(),
        config: { model: MODEL },
      })) as { sessionId: string };
      daemon.trackSession(sessionId);

      // Send first message
      await sendMessage(daemon, sessionId, 'What is 1+1? Reply with the number.');

      // Wait for title job to complete
      await waitForJobStatus(daemon, SESSION_TITLE_GENERATION, 'completed');

      // Wait for agent idle
      await waitForIdle(daemon, sessionId, IDLE_TIMEOUT);

      const jobsAfterFirst = daemon.daemonContext.jobQueue.listJobs({
        queue: SESSION_TITLE_GENERATION,
      });
      expect(jobsAfterFirst.length).toBe(1);

      // Send second message — should NOT enqueue another title job
      await sendMessage(daemon, sessionId, 'What is 2+2? Reply with the number.');
      await waitForIdle(daemon, sessionId, IDLE_TIMEOUT);

      // Allow brief settle time
      await new Promise((resolve) => setTimeout(resolve, 500));

      const jobsAfterSecond = daemon.daemonContext.jobQueue.listJobs({
        queue: SESSION_TITLE_GENERATION,
      });
      expect(jobsAfterSecond.length).toBe(1); // Still exactly one job
    },
    TEST_TIMEOUT
  );

  test(
    'should retry title generation on first failure and succeed on second attempt',
    async () => {
      // Create session
      const { sessionId } = (await daemon.messageHub.request('session.create', {
        workspacePath: process.cwd(),
        config: { model: MODEL },
      })) as { sessionId: string };
      daemon.trackSession(sessionId);

      // Install failing-then-succeeding mock on SessionLifecycle
      const sessionLifecycle = daemon.daemonContext.sessionManager.getSessionLifecycle();
      const originalFn = sessionLifecycle.generateTitleAndRenameBranch.bind(sessionLifecycle);
      let callCount = 0;
      sessionLifecycle.generateTitleAndRenameBranch = async (sid: string, text: string) => {
        callCount++;
        if (callCount === 1) {
          throw new Error('Simulated title generation failure on attempt 1');
        }
        return originalFn(sid, text);
      };

      try {
        // Send first message — triggers job enqueue
        await sendMessage(daemon, sessionId, 'What is 3+3? Reply with the number.');

        // Wait for job to appear
        const initialJob = await waitForJobStatus(daemon, SESSION_TITLE_GENERATION, [
          'pending',
          'processing',
          'completed',
        ]);
        expect(initialJob.payload.sessionId).toBe(sessionId);

        // The job fails on attempt 1, then retries after ~1s backoff (2^0 * 1000ms).
        // Wait for completion on the second attempt.
        const completedJob = await waitForJobStatus(daemon, SESSION_TITLE_GENERATION, 'completed');
        expect(completedJob.id).toBe(initialJob.id);
        expect(completedJob.retryCount).toBe(1);
        expect(completedJob.result).toMatchObject({ generated: true });

        // Verify the mock was called at least twice (failed once, succeeded once)
        expect(callCount).toBeGreaterThanOrEqual(2);

        // Verify title was updated
        await waitForTitleGenerated(daemon, sessionId);

        const { session } = (await daemon.messageHub.request('session.get', { sessionId })) as {
          session: { title: string; metadata: { titleGenerated: boolean } };
        };
        expect(session.metadata.titleGenerated).toBe(true);
        expect(session.title).not.toBe('New Session');
      } finally {
        // Restore original function
        sessionLifecycle.generateTitleAndRenameBranch = originalFn;
      }
    },
    TEST_TIMEOUT + RETRY_DELAY_MS * 2
  );

  test(
    'should mark job as dead after exhausting all retries',
    async () => {
      // Create session
      const { sessionId } = (await daemon.messageHub.request('session.create', {
        workspacePath: process.cwd(),
        config: { model: MODEL },
      })) as { sessionId: string };
      daemon.trackSession(sessionId);

      // Install permanently failing mock on SessionLifecycle
      const sessionLifecycle = daemon.daemonContext.sessionManager.getSessionLifecycle();
      const originalFn = sessionLifecycle.generateTitleAndRenameBranch.bind(sessionLifecycle);
      let callCount = 0;
      sessionLifecycle.generateTitleAndRenameBranch = async () => {
        callCount++;
        throw new Error(`Simulated persistent failure on attempt ${callCount}`);
      };

      try {
        // Send first message — triggers job enqueue with maxRetries=2
        await sendMessage(daemon, sessionId, 'What is 4+4? Reply with the number.');

        // Wait for job to become dead (maxRetries=2, so 3 total attempts: 0, 1, 2)
        const deadJob = await waitForJobStatus(
          daemon,
          SESSION_TITLE_GENERATION,
          'dead',
          // Dead state takes: attempt1 + 1s delay + attempt2 + 2s delay + attempt3
          JOB_POLL_TIMEOUT + 3500
        );
        expect(deadJob.retryCount).toBe(2); // maxRetries exhausted
        expect(deadJob.error).toContain('Simulated persistent failure');
        expect(deadJob.completedAt).toBeNumber();

        // Verify callCount matches retryCount+1 (3 total attempts)
        expect(callCount).toBe(3);

        // Session title should remain 'New Session' since generation failed
        const { session } = (await daemon.messageHub.request('session.get', { sessionId })) as {
          session: { title: string; metadata: { titleGenerated: boolean } };
        };
        expect(session.title).toBe('New Session');
        expect(session.metadata.titleGenerated).toBe(false);
      } finally {
        // Restore original function
        sessionLifecycle.generateTitleAndRenameBranch = originalFn;
      }
    },
    TEST_TIMEOUT + 4000
  );
});
