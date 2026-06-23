/**
 * Job handler for github.poll queue.
 *
 * Triggers a poll of all GitHub repositories and self-schedules the next poll
 * job, with deduplication to prevent multiple concurrent poll chains.
 */

import { GITHUB_POLL } from '../job-queue-constants';
import { Logger } from '../logger';
import type { GitHubPollingService } from '../github/polling-service';
import type { JobQueueRepository } from '../../storage/repositories/job-queue-repository';

const log = new Logger('github-poll-handler');

export interface GitHubPollHandlerDeps {
  pollingService: GitHubPollingService | undefined;
  jobQueue: JobQueueRepository;
  intervalMs: number | (() => number);
}

// Extends Record<string, unknown> so the result satisfies JobHandler's return type.
export interface GitHubPollResult extends Record<string, unknown> {
  polled: boolean;
  nextRunAt: number;
}

export async function handleGitHubPoll(deps: GitHubPollHandlerDeps): Promise<GitHubPollResult> {
  const { pollingService, jobQueue } = deps;

  let polled = false;

  try {
    if (!pollingService) {
      log.warn('github.poll handler called but no polling service is configured');
    } else if (!pollingService.isRunning()) {
      // Polling service was stopped (e.g. GitHubService.stop() was called at runtime).
      // Skip triggerPoll for this cycle; the self-schedule below keeps the chain alive
      // so that polling resumes automatically if the service is restarted.
      log.debug('github.poll handler skipping triggerPoll — polling service is stopped');
    } else {
      await pollingService.triggerPoll();
      polled = true;
    }
  } catch (error) {
    log.error('triggerPoll failed', {
      error: error instanceof Error ? error.message : error,
    });
  }

  // Compute nextRunAt after the poll so the interval is measured from
  // completion, not from when the job was dequeued.
  const intervalMs = typeof deps.intervalMs === 'function' ? deps.intervalMs() : deps.intervalMs;
  const nextRunAt = intervalMs > 0 ? Date.now() + intervalMs : 0;

  // Only enqueue the next job if no pending job is already waiting.
  // We check 'pending' only (not 'processing') because the current job is
  // itself in 'processing' state while this handler runs — including
  // 'processing' would always find itself and prevent self-scheduling.
  // A stale/duplicate 'processing' job is handled by the processor's eager
  // stale-reclamation on startup, which moves it back to 'pending'.
  // limit: 1 is sufficient — we only need to know if any job exists.
  const existingJobs = jobQueue.listJobs({
    queue: GITHUB_POLL,
    status: 'pending',
    limit: 1,
  });

  if (intervalMs > 0 && existingJobs.length === 0) {
    jobQueue.enqueue({
      queue: GITHUB_POLL,
      payload: {},
      runAt: nextRunAt,
    });
  }

  return { polled, nextRunAt };
}
