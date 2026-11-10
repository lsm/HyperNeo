import type { GitHubWatchedRepo } from './github-repository.ts';

export function projectGitHubWatchedRepo(repo: GitHubWatchedRepo): Omit<
  GitHubWatchedRepo,
  'spaceId' | 'pollCursor' | 'webhookSecret'
> & {
  webhookSecret: 'configured' | null;
} {
  return {
    id: repo.id,
    owner: repo.owner,
    repo: repo.repo,
    enabled: repo.enabled,
    webhookEnabled: repo.webhookEnabled,
    pollingEnabled: repo.pollingEnabled,
    webhookSecret: repo.webhookSecret ? 'configured' : null,
    webhookRemoteId: repo.webhookRemoteId,
    webhookUrl: repo.webhookUrl,
    webhookAutoRegistered: repo.webhookAutoRegistered,
    webhookActive: repo.webhookActive,
    webhookLastCheckedAt: repo.webhookLastCheckedAt,
    webhookLastError: repo.webhookLastError,
    webhookConfiguredAt: repo.webhookConfiguredAt,
    lastWebhookAt: repo.lastWebhookAt,
    lastPollAt: repo.lastPollAt,
    createdAt: repo.createdAt,
    updatedAt: repo.updatedAt,
  };
}
