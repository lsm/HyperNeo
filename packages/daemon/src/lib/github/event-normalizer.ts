/**
 * GitHub Event Normalizer
 *
 * Normalizes events from different sources (webhooks and polling) into a
 * consistent GitHubEvent structure for unified processing.
 */

import type { GitHubEvent, GitHubEventSource } from '@neokai/shared';
import type {
  GitHubApiComment,
  GitHubApiIssue,
  GitHubWebhookIssueCommentPayload,
  GitHubWebhookIssuesPayload,
  GitHubWebhookPullRequestPayload,
} from './types';

/**
 * Generate a unique event ID
 */
function generateEventId(): string {
  return crypto.randomUUID();
}

/**
 * Extract owner and repo from full_name (owner/repo format)
 */
function parseRepoFullName(fullName: string): { owner: string; repo: string } {
  const parts = fullName.split('/');
  return {
    owner: parts[0] ?? '',
    repo: parts[1] ?? '',
  };
}

/**
 * Normalize a webhook event into a GitHubEvent
 *
 * @param eventType - GitHub event type (e.g., 'issues', 'issue_comment', 'pull_request')
 * @param payload - Raw webhook payload
 * @returns Normalized GitHubEvent or null if unsupported
 */
export function normalizeWebhookEvent(eventType: string, payload: unknown): GitHubEvent | null {
  const source: GitHubEventSource = 'webhook';

  // Handle issues events
  if (eventType === 'issues') {
    return normalizeIssuesWebhook(payload as GitHubWebhookIssuesPayload, source);
  }

  // Handle issue_comment events
  if (eventType === 'issue_comment') {
    return normalizeIssueCommentWebhook(payload as GitHubWebhookIssueCommentPayload, source);
  }

  // Handle pull_request events
  if (eventType === 'pull_request') {
    return normalizePullRequestWebhook(payload as GitHubWebhookPullRequestPayload, source);
  }

  // Unsupported event type
  return null;
}

/**
 * Normalize issues webhook payload
 */
function normalizeIssuesWebhook(
  payload: GitHubWebhookIssuesPayload,
  source: GitHubEventSource
): GitHubEvent | null {
  const { action, issue, repository, sender } = payload;

  // Only handle supported actions
  if (!['opened', 'reopened', 'closed', 'edited'].includes(action)) {
    return null;
  }

  const { owner, repo } = parseRepoFullName(repository.full_name);

  return {
    id: generateEventId(),
    source,
    eventType: 'issues',
    action,
    repository: {
      owner,
      repo,
      fullName: repository.full_name,
    },
    issue: {
      number: issue.number,
      title: issue.title,
      body: issue.body ?? '',
      labels: issue.labels.map((l) => l.name),
    },
    sender: {
      login: sender.login,
      type: sender.type,
    },
    rawPayload: payload,
    receivedAt: Date.now(),
  };
}

/**
 * Normalize issue_comment webhook payload
 */
function normalizeIssueCommentWebhook(
  payload: GitHubWebhookIssueCommentPayload,
  source: GitHubEventSource
): GitHubEvent | null {
  const { action, issue, comment, repository, sender } = payload;

  // Only handle created and edited actions
  if (!['created', 'edited'].includes(action)) {
    return null;
  }

  // Skip if this is a PR comment (will be handled by pull_request events)
  if (issue.pull_request) {
    return null;
  }

  const { owner, repo } = parseRepoFullName(repository.full_name);

  return {
    id: generateEventId(),
    source,
    eventType: 'issue_comment',
    action,
    repository: {
      owner,
      repo,
      fullName: repository.full_name,
    },
    issue: {
      number: issue.number,
      title: issue.title,
      body: '',
      labels: [],
    },
    comment: {
      id: String(comment.id),
      body: comment.body ?? '',
    },
    sender: {
      login: sender.login,
      type: sender.type,
    },
    rawPayload: payload,
    receivedAt: Date.now(),
  };
}

/**
 * Normalize pull_request webhook payload
 */
function normalizePullRequestWebhook(
  payload: GitHubWebhookPullRequestPayload,
  source: GitHubEventSource
): GitHubEvent | null {
  const { action, pull_request, repository, sender } = payload;

  // Only handle supported actions
  if (!['opened', 'synchronize', 'closed'].includes(action)) {
    return null;
  }

  const { owner, repo } = parseRepoFullName(repository.full_name);

  return {
    id: generateEventId(),
    source,
    eventType: 'pull_request',
    action,
    repository: {
      owner,
      repo,
      fullName: repository.full_name,
    },
    issue: {
      number: pull_request.number,
      title: pull_request.title,
      body: pull_request.body ?? '',
      labels: pull_request.labels.map((l) => l.name),
    },
    sender: {
      login: sender.login,
      type: sender.type,
    },
    rawPayload: payload,
    receivedAt: Date.now(),
  };
}

/**
 * Normalize a polling event into a GitHubEvent
 *
 * @param type - Type of polled data
 * @param data - Raw data from GitHub API
 * @param fullName - Repository full name (owner/repo)
 * @returns Normalized GitHubEvent or null if unsupported
 */
export function normalizePollingEvent(
  type: 'issue' | 'comment' | 'pull_request',
  data: unknown,
  fullName: string
): GitHubEvent | null {
  const source: GitHubEventSource = 'polling';
  const { owner, repo } = parseRepoFullName(fullName);

  if (type === 'issue') {
    return normalizeIssuePolling(data as GitHubApiIssue, source, owner, repo, fullName);
  }

  if (type === 'comment') {
    return normalizeCommentPolling(data as GitHubApiComment, source, owner, repo, fullName);
  }

  if (type === 'pull_request') {
    return normalizePullRequestPolling(data as GitHubApiIssue, source, owner, repo, fullName);
  }

  return null;
}

/**
 * Normalize issue from polling
 */
function normalizeIssuePolling(
  issue: GitHubApiIssue,
  source: GitHubEventSource,
  owner: string,
  repo: string,
  fullName: string
): GitHubEvent {
  // For polling, we don't know the exact action, use 'updated' as default
  const action = 'updated';

  return {
    id: generateEventId(),
    source,
    eventType: 'issues',
    action,
    repository: {
      owner,
      repo,
      fullName,
    },
    issue: {
      number: issue.number,
      title: issue.title,
      body: issue.body ?? '',
      labels: issue.labels.map((l) => l.name),
    },
    sender: {
      login: issue.user.login,
      type: issue.user.type,
    },
    rawPayload: issue,
    receivedAt: Date.now(),
  };
}

/**
 * Normalize comment from polling
 */
function normalizeCommentPolling(
  comment: GitHubApiComment,
  source: GitHubEventSource,
  owner: string,
  repo: string,
  fullName: string
): GitHubEvent {
  // For polling, we don't know the exact action, use 'created' as default
  const action = 'created';

  // Extract issue number from issue_url
  // Format: https://api.github.com/repos/owner/repo/issues/123
  const issueNumber = extractIssueNumberFromUrl(comment.issue_url);

  return {
    id: generateEventId(),
    source,
    eventType: 'issue_comment',
    action,
    repository: {
      owner,
      repo,
      fullName,
    },
    issue: {
      number: issueNumber,
      title: '',
      body: '',
      labels: [],
    },
    comment: {
      id: String(comment.id),
      body: comment.body ?? '',
    },
    sender: {
      login: comment.user.login,
      type: comment.user.type,
    },
    rawPayload: comment,
    receivedAt: Date.now(),
  };
}

/**
 * Normalize pull request from polling
 * Note: GitHub API returns PRs in the issues endpoint with a pull_request field
 */
function normalizePullRequestPolling(
  pr: GitHubApiIssue,
  source: GitHubEventSource,
  owner: string,
  repo: string,
  fullName: string
): GitHubEvent {
  // For polling, we don't know the exact action, use 'updated' as default
  const action = 'updated';

  return {
    id: generateEventId(),
    source,
    eventType: 'pull_request',
    action,
    repository: {
      owner,
      repo,
      fullName,
    },
    issue: {
      number: pr.number,
      title: pr.title,
      body: pr.body ?? '',
      labels: pr.labels.map((l) => l.name),
    },
    sender: {
      login: pr.user.login,
      type: pr.user.type,
    },
    rawPayload: pr,
    receivedAt: Date.now(),
  };
}

/**
 * Extract issue number from GitHub API issue URL
 */
function extractIssueNumberFromUrl(url: string): number {
  const match = url.match(/\/issues\/(\d+)$/);
  return match ? parseInt(match[1] ?? '0', 10) : 0;
}
