import { GITHUB_POLL } from '../job-queue-constants.ts';
import { Logger } from '../logger.ts';
import type { GitHubPollingService } from '../github/polling-service.ts';
import type { JobQueueRepository } from '../../storage/repositories/job-queue-repository.ts';

const log = new Logger('github-poll-handler');

export interface GitHubPollHandlerDeps {
  pollingService: GitHubPollingService | undefined;
  jobQueue: JobQueueRepository;
  intervalMs: number | (() => number);
}

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

  const intervalMs = typeof deps.intervalMs === 'function' ? deps.intervalMs() : deps.intervalMs;
  const nextRunAt = intervalMs > 0 ? Date.now() + intervalMs : 0;

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
