import { defineRepositoryOp } from '../db-gateway/db-op.ts';
import { JobQueueRepository } from './job-queue-repository.ts';

class GitHubPollRefreshRepository extends JobQueueRepository {
  refresh(input: { enabled: boolean; reschedulePending: boolean; runAt: number }) {
    const queue = 'github.poll';
    if (!input.enabled || input.reschedulePending) {
      for (const job of this.listJobs({ queue, status: 'pending' })) this.deleteJob(job.id);
    }
    if (
      !input.enabled ||
      this.listJobs({ queue, status: ['pending', 'processing'], limit: 1 }).length
    ) {
      return null;
    }
    return this.enqueue({ queue, payload: {}, runAt: input.runAt });
  }
}

export const githubPollRefreshWrites = defineRepositoryOp(
  'jobs.refreshGitHubPolling',
  'write',
  GitHubPollRefreshRepository,
  ['refresh']
);
