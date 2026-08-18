import { describe, expect, it } from 'bun:test';
import {
  normalizeWebhookEvent,
  normalizePollingEvent,
} from '../../../../src/lib/github/event-normalizer';
import type {
  GitHubWebhookIssuesPayload,
  GitHubWebhookIssueCommentPayload,
  GitHubWebhookPullRequestPayload,
  GitHubApiIssue,
  GitHubApiComment,
} from '../../../../src/lib/github/types';

function createIssuesWebhookPayload(
  overrides: Partial<GitHubWebhookIssuesPayload> = {}
): GitHubWebhookIssuesPayload {
  return {
    action: 'opened',
    issue: {
      id: 1,
      number: 42,
      title: 'Test Issue',
      body: 'Test body',
      labels: [{ name: 'bug' }],
      state: 'open',
      user: { login: 'testuser', type: 'User' },
    },
    repository: {
      id: 1,
      name: 'test-repo',
      full_name: 'testowner/test-repo',
      owner: { login: 'testowner' },
    },
    sender: { login: 'testuser', type: 'User' },
    ...overrides,
  };
}

function createIssueCommentWebhookPayload(
  overrides: Partial<GitHubWebhookIssueCommentPayload> = {}
): GitHubWebhookIssueCommentPayload {
  return {
    action: 'created',
    issue: {
      id: 1,
      number: 42,
      title: 'Test Issue',
    },
    comment: {
      id: 1,
      body: 'Test comment',
      user: { login: 'testuser', type: 'User' },
    },
    repository: {
      id: 1,
      name: 'test-repo',
      full_name: 'testowner/test-repo',
      owner: { login: 'testowner' },
    },
    sender: { login: 'testuser', type: 'User' },
    ...overrides,
  };
}

function createPullRequestWebhookPayload(
  overrides: Partial<GitHubWebhookPullRequestPayload> = {}
): GitHubWebhookPullRequestPayload {
  return {
    action: 'opened',
    pull_request: {
      id: 1,
      number: 42,
      title: 'Test PR',
      body: 'Test body',
      state: 'open',
      user: { login: 'testuser', type: 'User' },
      labels: [{ name: 'enhancement' }],
    },
    repository: {
      id: 1,
      name: 'test-repo',
      full_name: 'testowner/test-repo',
      owner: { login: 'testowner' },
    },
    sender: { login: 'testuser', type: 'User' },
    ...overrides,
  };
}

function createApiIssue(overrides: Partial<GitHubApiIssue> = {}): GitHubApiIssue {
  return {
    id: 1,
    number: 42,
    title: 'Test Issue',
    body: 'Test body',
    state: 'open',
    labels: [{ name: 'bug' }],
    user: { login: 'testuser', type: 'User' },
    updated_at: '2024-01-01T00:00:00Z',
    created_at: '2024-01-01T00:00:00Z',
    ...overrides,
  };
}

function createApiComment(overrides: Partial<GitHubApiComment> = {}): GitHubApiComment {
  return {
    id: 1,
    body: 'Test comment',
    user: { login: 'testuser', type: 'User' },
    updated_at: '2024-01-01T00:00:00Z',
    created_at: '2024-01-01T00:00:00Z',
    issue_url: 'https://api.github.com/repos/testowner/test-repo/issues/42',
    ...overrides,
  };
}

describe('normalizeWebhookEvent', () => {
  describe('issues events', () => {
    it('should normalize issues.opened event', () => {
      const payload = createIssuesWebhookPayload({ action: 'opened' });
      const result = normalizeWebhookEvent('issues', payload);

      expect(result).not.toBeNull();
      expect(result?.source).toBe('webhook');
      expect(result?.eventType).toBe('issues');
      expect(result?.action).toBe('opened');
      expect(result?.repository.owner).toBe('testowner');
      expect(result?.repository.repo).toBe('test-repo');
      expect(result?.repository.fullName).toBe('testowner/test-repo');
      expect(result?.issue.number).toBe(42);
      expect(result?.issue.title).toBe('Test Issue');
      expect(result?.issue.body).toBe('Test body');
      expect(result?.issue.labels).toEqual(['bug']);
      expect(result?.sender.login).toBe('testuser');
      expect(result?.sender.type).toBe('User');
      expect(result?.id).toMatch(/^[\da-f-]{36}$/);
      expect(result?.receivedAt).toBeGreaterThan(0);
    });

    it('should normalize issues.reopened event', () => {
      const payload = createIssuesWebhookPayload({ action: 'reopened' });
      const result = normalizeWebhookEvent('issues', payload);

      expect(result).not.toBeNull();
      expect(result?.action).toBe('reopened');
    });

    it('should normalize issues.closed event', () => {
      const payload = createIssuesWebhookPayload({ action: 'closed' });
      const result = normalizeWebhookEvent('issues', payload);

      expect(result).not.toBeNull();
      expect(result?.action).toBe('closed');
    });

    it('should normalize issues.edited event', () => {
      const payload = createIssuesWebhookPayload({ action: 'edited' });
      const result = normalizeWebhookEvent('issues', payload);

      expect(result).not.toBeNull();
      expect(result?.action).toBe('edited');
    });

    it('should return null for unsupported issues action', () => {
      const payload = createIssuesWebhookPayload({ action: 'deleted' as any });
      const result = normalizeWebhookEvent('issues', payload);

      expect(result).toBeNull();
    });

    it('should handle null body', () => {
      const payload = createIssuesWebhookPayload({
        issue: {
          ...createIssuesWebhookPayload().issue,
          body: null,
        },
      });
      const result = normalizeWebhookEvent('issues', payload);

      expect(result).not.toBeNull();
      expect(result?.issue.body).toBe('');
    });

    it('should handle multiple labels', () => {
      const payload = createIssuesWebhookPayload({
        issue: {
          ...createIssuesWebhookPayload().issue,
          labels: [{ name: 'bug' }, { name: 'priority' }],
        },
      });
      const result = normalizeWebhookEvent('issues', payload);

      expect(result?.issue.labels).toEqual(['bug', 'priority']);
    });

    it('should handle Bot sender type', () => {
      const payload = createIssuesWebhookPayload({
        sender: { login: 'dependabot', type: 'Bot' },
      });
      const result = normalizeWebhookEvent('issues', payload);

      expect(result?.sender.type).toBe('Bot');
    });
  });

  describe('issue_comment events', () => {
    it('should normalize issue_comment.created event', () => {
      const payload = createIssueCommentWebhookPayload({ action: 'created' });
      const result = normalizeWebhookEvent('issue_comment', payload);

      expect(result).not.toBeNull();
      expect(result?.source).toBe('webhook');
      expect(result?.eventType).toBe('issue_comment');
      expect(result?.action).toBe('created');
      expect(result?.repository.fullName).toBe('testowner/test-repo');
      expect(result?.issue.number).toBe(42);
      expect(result?.comment?.id).toBe('1');
      expect(result?.comment?.body).toBe('Test comment');
      expect(result?.sender.login).toBe('testuser');
    });

    it('should normalize issue_comment.edited event', () => {
      const payload = createIssueCommentWebhookPayload({ action: 'edited' });
      const result = normalizeWebhookEvent('issue_comment', payload);

      expect(result).not.toBeNull();
      expect(result?.action).toBe('edited');
    });

    it('should return null for deleted comment action', () => {
      const payload = createIssueCommentWebhookPayload({ action: 'deleted' });
      const result = normalizeWebhookEvent('issue_comment', payload);

      expect(result).toBeNull();
    });

    it('should return null for PR comments', () => {
      const payload = createIssueCommentWebhookPayload({
        issue: {
          id: 1,
          number: 42,
          title: 'Test PR',
          pull_request: { url: 'https://api.github.com/repos/test/test/pulls/42' },
        },
      });
      const result = normalizeWebhookEvent('issue_comment', payload);

      expect(result).toBeNull();
    });

    it('should handle null comment body', () => {
      const payload = createIssueCommentWebhookPayload({
        comment: {
          id: 1,
          body: null,
          user: { login: 'testuser', type: 'User' },
        },
      });
      const result = normalizeWebhookEvent('issue_comment', payload);

      expect(result).not.toBeNull();
      expect(result?.comment?.body).toBe('');
    });
  });

  describe('pull_request events', () => {
    it('should normalize pull_request.opened event', () => {
      const payload = createPullRequestWebhookPayload({ action: 'opened' });
      const result = normalizeWebhookEvent('pull_request', payload);

      expect(result).not.toBeNull();
      expect(result?.source).toBe('webhook');
      expect(result?.eventType).toBe('pull_request');
      expect(result?.action).toBe('opened');
      expect(result?.repository.fullName).toBe('testowner/test-repo');
      expect(result?.issue.number).toBe(42);
      expect(result?.issue.title).toBe('Test PR');
      expect(result?.issue.body).toBe('Test body');
      expect(result?.issue.labels).toEqual(['enhancement']);
      expect(result?.sender.login).toBe('testuser');
    });

    it('should normalize pull_request.synchronize event', () => {
      const payload = createPullRequestWebhookPayload({ action: 'synchronize' });
      const result = normalizeWebhookEvent('pull_request', payload);

      expect(result).not.toBeNull();
      expect(result?.action).toBe('synchronize');
    });

    it('should normalize pull_request.closed event', () => {
      const payload = createPullRequestWebhookPayload({ action: 'closed' });
      const result = normalizeWebhookEvent('pull_request', payload);

      expect(result).not.toBeNull();
      expect(result?.action).toBe('closed');
    });

    it('should return null for unsupported pull_request actions', () => {
      const payload = createPullRequestWebhookPayload({ action: 'reopened' as any });
      const result = normalizeWebhookEvent('pull_request', payload);

      expect(result).toBeNull();
    });

    it('should handle null body', () => {
      const payload = createPullRequestWebhookPayload({
        pull_request: {
          ...createPullRequestWebhookPayload().pull_request,
          body: null,
        },
      });
      const result = normalizeWebhookEvent('pull_request', payload);

      expect(result).not.toBeNull();
      expect(result?.issue.body).toBe('');
    });
  });

  describe('unsupported event types', () => {
    it('should return null for push event', () => {
      const result = normalizeWebhookEvent('push', {});
      expect(result).toBeNull();
    });

    it('should return null for unknown event type', () => {
      const result = normalizeWebhookEvent('unknown', {});
      expect(result).toBeNull();
    });
  });
});

describe('normalizePollingEvent', () => {
  describe('issue polling', () => {
    it('should normalize issue from polling', () => {
      const issue = createApiIssue();
      const result = normalizePollingEvent('issue', issue, 'testowner/test-repo');

      expect(result).not.toBeNull();
      expect(result?.source).toBe('polling');
      expect(result?.eventType).toBe('issues');
      expect(result?.action).toBe('updated');
      expect(result?.repository.owner).toBe('testowner');
      expect(result?.repository.repo).toBe('test-repo');
      expect(result?.repository.fullName).toBe('testowner/test-repo');
      expect(result?.issue.number).toBe(42);
      expect(result?.issue.title).toBe('Test Issue');
      expect(result?.issue.body).toBe('Test body');
      expect(result?.issue.labels).toEqual(['bug']);
      expect(result?.sender.login).toBe('testuser');
    });

    it('should handle null body', () => {
      const issue = createApiIssue({ body: null });
      const result = normalizePollingEvent('issue', issue, 'owner/repo');

      expect(result?.issue.body).toBe('');
    });

    it('should parse complex repository name', () => {
      const issue = createApiIssue();
      const result = normalizePollingEvent('issue', issue, 'my-org/my-repo-name');

      expect(result?.repository.owner).toBe('my-org');
      expect(result?.repository.repo).toBe('my-repo-name');
    });
  });

  describe('comment polling', () => {
    it('should normalize comment from polling', () => {
      const comment = createApiComment();
      const result = normalizePollingEvent('comment', comment, 'testowner/test-repo');

      expect(result).not.toBeNull();
      expect(result?.source).toBe('polling');
      expect(result?.eventType).toBe('issue_comment');
      expect(result?.action).toBe('created');
      expect(result?.repository.fullName).toBe('testowner/test-repo');
      expect(result?.issue.number).toBe(42);
      expect(result?.comment?.id).toBe('1');
      expect(result?.comment?.body).toBe('Test comment');
      expect(result?.sender.login).toBe('testuser');
    });

    it('should extract issue number from issue_url', () => {
      const comment = createApiComment({
        issue_url: 'https://api.github.com/repos/owner/repo/issues/123',
      });
      const result = normalizePollingEvent('comment', comment, 'owner/repo');

      expect(result?.issue.number).toBe(123);
    });

    it('should handle null body', () => {
      const comment = createApiComment({ body: null });
      const result = normalizePollingEvent('comment', comment, 'owner/repo');

      expect(result?.comment?.body).toBe('');
    });
  });

  describe('pull_request polling', () => {
    it('should normalize pull request from polling', () => {
      const pr = createApiIssue({ pull_request: { url: 'https://api.github.com/pr' } });
      const result = normalizePollingEvent('pull_request', pr, 'testowner/test-repo');

      expect(result).not.toBeNull();
      expect(result?.source).toBe('polling');
      expect(result?.eventType).toBe('pull_request');
      expect(result?.action).toBe('updated');
      expect(result?.repository.fullName).toBe('testowner/test-repo');
      expect(result?.issue.number).toBe(42);
      expect(result?.issue.title).toBe('Test Issue');
    });

    it('should include labels from PR', () => {
      const pr = createApiIssue({
        labels: [{ name: 'bug' }, { name: 'wip' }],
        pull_request: { url: 'https://api.github.com/pr' },
      });
      const result = normalizePollingEvent('pull_request', pr, 'owner/repo');

      expect(result?.issue.labels).toEqual(['bug', 'wip']);
    });
  });

  describe('edge cases', () => {
    it('should handle repository name with hyphens', () => {
      const issue = createApiIssue();
      const result = normalizePollingEvent('issue', issue, 'my-org/my-complex-repo-name');

      expect(result?.repository.owner).toBe('my-org');
      expect(result?.repository.repo).toBe('my-complex-repo-name');
    });

    it('should return null for unknown polling type', () => {
      const result = normalizePollingEvent('unknown' as any, {}, 'owner/repo');
      expect(result).toBeNull();
    });

    it('should handle malformed repository name', () => {
      const issue = createApiIssue();
      const result = normalizePollingEvent('issue', issue, 'invalidname');

      expect(result?.repository.owner).toBe('invalidname');
      expect(result?.repository.repo).toBe('');
    });
  });
});
