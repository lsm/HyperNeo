import { GITHUB_POLL } from '../job-queue-constants.ts';
import { Logger } from '../logger.ts';
import type { GitHubPollingService } from '../github/polling-service.ts';
import type { JobQueueRepository } from '../../storage/repositories/job-queue-repository.ts';
import { gatewayFor } from '../../storage/db-gateway/db-gateway.ts';
import { githubPollSuccessorWrites } from '../../storage/repositories/github-poll-successor-write.ts';

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

  if (intervalMs > 0) {
    await gatewayFor(jobQueue.db).call(githubPollSuccessorWrites, 'enqueueUniquePending', {
      queue: GITHUB_POLL,
      payload: {},
      runAt: nextRunAt,
      matchPayload: {},
      activeStatuses: ['pending'],
    });
  }

  return { polled, nextRunAt };
}
