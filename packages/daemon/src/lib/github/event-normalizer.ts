import type { GitHubEvent, GitHubEventSource } from '@hyperneo/shared';
import type {
  GitHubApiComment,
  GitHubApiIssue,
  GitHubWebhookIssueCommentPayload,
  GitHubWebhookIssuesPayload,
  GitHubWebhookPullRequestPayload,
} from './types';

function generateEventId(): string {
  return crypto.randomUUID();
}

function parseRepoFullName(fullName: string): { owner: string; repo: string } {
  const parts = fullName.split('/');
  return {
    owner: parts[0] ?? '',
    repo: parts[1] ?? '',
  };
}

export function normalizeWebhookEvent(eventType: string, payload: unknown): GitHubEvent | null {
  const source: GitHubEventSource = 'webhook';

  if (eventType === 'issues') {
    return normalizeIssuesWebhook(payload as GitHubWebhookIssuesPayload, source);
  }

  if (eventType === 'issue_comment') {
    return normalizeIssueCommentWebhook(payload as GitHubWebhookIssueCommentPayload, source);
  }

  if (eventType === 'pull_request') {
    return normalizePullRequestWebhook(payload as GitHubWebhookPullRequestPayload, source);
  }

  return null;
}

function normalizeIssuesWebhook(
  payload: GitHubWebhookIssuesPayload,
  source: GitHubEventSource
): GitHubEvent | null {
  const { action, issue, repository, sender } = payload;

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

function normalizeIssueCommentWebhook(
  payload: GitHubWebhookIssueCommentPayload,
  source: GitHubEventSource
): GitHubEvent | null {
  const { action, issue, comment, repository, sender } = payload;

  if (!['created', 'edited'].includes(action)) {
    return null;
  }

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

function normalizePullRequestWebhook(
  payload: GitHubWebhookPullRequestPayload,
  source: GitHubEventSource
): GitHubEvent | null {
  const { action, pull_request, repository, sender } = payload;

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

function normalizeIssuePolling(
  issue: GitHubApiIssue,
  source: GitHubEventSource,
  owner: string,
  repo: string,
  fullName: string
): GitHubEvent {
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

function normalizeCommentPolling(
  comment: GitHubApiComment,
  source: GitHubEventSource,
  owner: string,
  repo: string,
  fullName: string
): GitHubEvent {
  const action = 'created';

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

function normalizePullRequestPolling(
  pr: GitHubApiIssue,
  source: GitHubEventSource,
  owner: string,
  repo: string,
  fullName: string
): GitHubEvent {
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

function extractIssueNumberFromUrl(url: string): number {
  const match = url.match(/\/issues\/(\d+)$/);
  return match ? parseInt(match[1] ?? '0', 10) : 0;
}
