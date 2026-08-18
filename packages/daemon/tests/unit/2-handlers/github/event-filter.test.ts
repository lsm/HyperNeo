import { describe, test, expect, beforeEach } from 'bun:test';
import { GitHubEventFilter } from '../../../../src/lib/github/event-filter';
import type { GitHubEvent, GitHubFilterConfig } from '@hyperneo/shared';

function createTestEvent(overrides: Partial<GitHubEvent> = {}): GitHubEvent {
  return {
    id: 'test-event-id',
    source: 'webhook',
    eventType: 'issues',
    action: 'opened',
    repository: {
      owner: 'testowner',
      repo: 'testrepo',
      fullName: 'testowner/testrepo',
    },
    issue: {
      number: 1,
      title: 'Test Issue',
      body: 'Test body',
      labels: ['bug'],
    },
    sender: {
      login: 'testuser',
      type: 'User',
    },
    rawPayload: {},
    receivedAt: Date.now(),
    ...overrides,
  };
}

function createFilterConfig(overrides: Partial<GitHubFilterConfig> = {}): GitHubFilterConfig {
  return {
    repositories: ['testowner/testrepo'],
    authors: {
      mode: 'all',
    },
    labels: {
      mode: 'any',
    },
    events: {},
    ...overrides,
  };
}

describe('GitHubEventFilter', () => {
  describe('Repository Matching', () => {
    test('should pass events for exact repository match', async () => {
      const config = createFilterConfig({
        repositories: ['testowner/testrepo'],
      });
      const filter = new GitHubEventFilter(config);
      const event = createTestEvent();

      const result = await filter.filter(event);

      expect(result.passed).toBe(true);
    });

    test('should reject events for non-matching repository', async () => {
      const config = createFilterConfig({
        repositories: ['otherowner/otherrepo'],
      });
      const filter = new GitHubEventFilter(config);
      const event = createTestEvent();

      const result = await filter.filter(event);

      expect(result.passed).toBe(false);
      expect(result.reason).toContain('not in allowlist');
    });

    test('should pass events for wildcard owner match (owner/*)', async () => {
      const config = createFilterConfig({
        repositories: ['testowner/*'],
      });
      const filter = new GitHubEventFilter(config);
      const event = createTestEvent({
        repository: {
          owner: 'testowner',
          repo: 'any-repo',
          fullName: 'testowner/any-repo',
        },
      });

      const result = await filter.filter(event);

      expect(result.passed).toBe(true);
    });

    test('should reject events for non-matching wildcard', async () => {
      const config = createFilterConfig({
        repositories: ['otherowner/*'],
      });
      const filter = new GitHubEventFilter(config);
      const event = createTestEvent();

      const result = await filter.filter(event);

      expect(result.passed).toBe(false);
    });

    test('should match one of multiple repositories', async () => {
      const config = createFilterConfig({
        repositories: ['owner1/repo1', 'testowner/testrepo', 'owner2/repo2'],
      });
      const filter = new GitHubEventFilter(config);
      const event = createTestEvent();

      const result = await filter.filter(event);

      expect(result.passed).toBe(true);
    });
  });

  describe('Author Filtering - All Mode', () => {
    test('should pass all users in "all" mode', async () => {
      const config = createFilterConfig({
        authors: { mode: 'all' },
      });
      const filter = new GitHubEventFilter(config);
      const event = createTestEvent({
        sender: { login: 'anyuser', type: 'User' },
      });

      const result = await filter.filter(event);

      expect(result.passed).toBe(true);
    });

    test('should pass bots in "all" mode', async () => {
      const config = createFilterConfig({
        authors: { mode: 'all' },
      });
      const filter = new GitHubEventFilter(config);
      const event = createTestEvent({
        sender: { login: 'dependabot', type: 'Bot' },
      });

      const result = await filter.filter(event);

      expect(result.passed).toBe(true);
    });
  });

  describe('Author Filtering - Allowlist Mode', () => {
    test('should pass users in allowlist', async () => {
      const config = createFilterConfig({
        authors: {
          mode: 'allowlist',
          users: ['alloweduser', 'testuser', 'anotheruser'],
        },
      });
      const filter = new GitHubEventFilter(config);
      const event = createTestEvent({
        sender: { login: 'testuser', type: 'User' },
      });

      const result = await filter.filter(event);

      expect(result.passed).toBe(true);
    });

    test('should reject users not in allowlist', async () => {
      const config = createFilterConfig({
        authors: {
          mode: 'allowlist',
          users: ['alloweduser', 'anotheruser'],
        },
      });
      const filter = new GitHubEventFilter(config);
      const event = createTestEvent({
        sender: { login: 'notallowed', type: 'User' },
      });

      const result = await filter.filter(event);

      expect(result.passed).toBe(false);
      expect(result.reason).toContain('not in allowlist');
    });

    test('should always pass bots in allowlist mode (unless blocked)', async () => {
      const config = createFilterConfig({
        authors: {
          mode: 'allowlist',
          users: ['humanuser'],
        },
      });
      const filter = new GitHubEventFilter(config);
      const event = createTestEvent({
        sender: { login: 'renovate-bot', type: 'Bot' },
      });

      const result = await filter.filter(event);

      expect(result.passed).toBe(true);
    });
  });

  describe('Author Filtering - Blocklist Mode', () => {
    test('should pass users not in blocklist', async () => {
      const config = createFilterConfig({
        authors: {
          mode: 'blocklist',
          users: ['blockeduser', 'spammer'],
        },
      });
      const filter = new GitHubEventFilter(config);
      const event = createTestEvent({
        sender: { login: 'gooduser', type: 'User' },
      });

      const result = await filter.filter(event);

      expect(result.passed).toBe(true);
    });

    test('should reject users in blocklist', async () => {
      const config = createFilterConfig({
        authors: {
          mode: 'blocklist',
          users: ['blockeduser', 'spammer'],
        },
      });
      const filter = new GitHubEventFilter(config);
      const event = createTestEvent({
        sender: { login: 'spammer', type: 'User' },
      });

      const result = await filter.filter(event);

      expect(result.passed).toBe(false);
      expect(result.reason).toContain('blocklist');
    });

    test('should reject bots in blocklist', async () => {
      const config = createFilterConfig({
        authors: {
          mode: 'blocklist',
          users: ['annoying-bot'],
        },
      });
      const filter = new GitHubEventFilter(config);
      const event = createTestEvent({
        sender: { login: 'annoying-bot', type: 'Bot' },
      });

      const result = await filter.filter(event);

      expect(result.passed).toBe(false);
      expect(result.reason).toContain('blocklist');
    });
  });

  describe('Label Filtering - Any Mode', () => {
    test('should pass any labels in "any" mode', async () => {
      const config = createFilterConfig({
        labels: { mode: 'any' },
      });
      const filter = new GitHubEventFilter(config);
      const event = createTestEvent({
        issue: {
          number: 1,
          title: 'Test',
          body: 'Body',
          labels: ['anything'],
        },
      });

      const result = await filter.filter(event);

      expect(result.passed).toBe(true);
    });

    test('should pass events with no labels in "any" mode', async () => {
      const config = createFilterConfig({
        labels: { mode: 'any' },
      });
      const filter = new GitHubEventFilter(config);
      const event = createTestEvent({
        issue: {
          number: 1,
          title: 'Test',
          body: 'Body',
          labels: [],
        },
      });

      const result = await filter.filter(event);

      expect(result.passed).toBe(true);
    });
  });

  describe('Label Filtering - Require Any Mode', () => {
    test('should pass when event has at least one required label', async () => {
      const config = createFilterConfig({
        labels: {
          mode: 'require_any',
          labels: ['bug', 'feature', 'enhancement'],
        },
      });
      const filter = new GitHubEventFilter(config);
      const event = createTestEvent({
        issue: {
          number: 1,
          title: 'Test',
          body: 'Body',
          labels: ['feature', 'ui'],
        },
      });

      const result = await filter.filter(event);

      expect(result.passed).toBe(true);
    });

    test('should reject when event has none of required labels', async () => {
      const config = createFilterConfig({
        labels: {
          mode: 'require_any',
          labels: ['bug', 'feature', 'enhancement'],
        },
      });
      const filter = new GitHubEventFilter(config);
      const event = createTestEvent({
        issue: {
          number: 1,
          title: 'Test',
          body: 'Body',
          labels: ['documentation', 'help-wanted'],
        },
      });

      const result = await filter.filter(event);

      expect(result.passed).toBe(false);
      expect(result.reason).toContain('labels');
    });

    test('should pass when require_any has no labels specified', async () => {
      const config = createFilterConfig({
        labels: {
          mode: 'require_any',
          labels: [],
        },
      });
      const filter = new GitHubEventFilter(config);
      const event = createTestEvent();

      const result = await filter.filter(event);

      expect(result.passed).toBe(true);
    });
  });

  describe('Label Filtering - Require All Mode', () => {
    test('should pass when event has all required labels', async () => {
      const config = createFilterConfig({
        labels: {
          mode: 'require_all',
          labels: ['bug', 'priority-high'],
        },
      });
      const filter = new GitHubEventFilter(config);
      const event = createTestEvent({
        issue: {
          number: 1,
          title: 'Test',
          body: 'Body',
          labels: ['bug', 'priority-high', 'ui'],
        },
      });

      const result = await filter.filter(event);

      expect(result.passed).toBe(true);
    });

    test('should reject when event is missing one required label', async () => {
      const config = createFilterConfig({
        labels: {
          mode: 'require_all',
          labels: ['bug', 'priority-high'],
        },
      });
      const filter = new GitHubEventFilter(config);
      const event = createTestEvent({
        issue: {
          number: 1,
          title: 'Test',
          body: 'Body',
          labels: ['bug', 'priority-low'],
        },
      });

      const result = await filter.filter(event);

      expect(result.passed).toBe(false);
    });

    test('should reject when event has no labels', async () => {
      const config = createFilterConfig({
        labels: {
          mode: 'require_all',
          labels: ['bug'],
        },
      });
      const filter = new GitHubEventFilter(config);
      const event = createTestEvent({
        issue: {
          number: 1,
          title: 'Test',
          body: 'Body',
          labels: [],
        },
      });

      const result = await filter.filter(event);

      expect(result.passed).toBe(false);
    });
  });

  describe('Label Filtering - Exclude Mode', () => {
    test('should pass when event has no excluded labels', async () => {
      const config = createFilterConfig({
        labels: {
          mode: 'exclude',
          labels: ['wontfix', 'duplicate'],
        },
      });
      const filter = new GitHubEventFilter(config);
      const event = createTestEvent({
        issue: {
          number: 1,
          title: 'Test',
          body: 'Body',
          labels: ['bug', 'enhancement'],
        },
      });

      const result = await filter.filter(event);

      expect(result.passed).toBe(true);
    });

    test('should reject when event has an excluded label', async () => {
      const config = createFilterConfig({
        labels: {
          mode: 'exclude',
          labels: ['wontfix', 'duplicate'],
        },
      });
      const filter = new GitHubEventFilter(config);
      const event = createTestEvent({
        issue: {
          number: 1,
          title: 'Test',
          body: 'Body',
          labels: ['bug', 'wontfix'],
        },
      });

      const result = await filter.filter(event);

      expect(result.passed).toBe(false);
    });
  });

  describe('Event Type Filtering', () => {
    test('should pass allowed issue actions', async () => {
      const config = createFilterConfig({
        events: {
          issues: ['opened', 'reopened'],
        },
      });
      const filter = new GitHubEventFilter(config);
      const event = createTestEvent({
        eventType: 'issues',
        action: 'opened',
      });

      const result = await filter.filter(event);

      expect(result.passed).toBe(true);
    });

    test('should reject non-allowed issue actions', async () => {
      const config = createFilterConfig({
        events: {
          issues: ['opened', 'reopened'],
        },
      });
      const filter = new GitHubEventFilter(config);
      const event = createTestEvent({
        eventType: 'issues',
        action: 'closed',
      });

      const result = await filter.filter(event);

      expect(result.passed).toBe(false);
      expect(result.reason).toContain('not in allowed actions');
    });

    test('should pass allowed comment actions', async () => {
      const config = createFilterConfig({
        events: {
          issue_comment: ['created'],
        },
      });
      const filter = new GitHubEventFilter(config);
      const event = createTestEvent({
        eventType: 'issue_comment',
        action: 'created',
        comment: {
          id: 'comment-1',
          body: 'Test comment',
        },
      });

      const result = await filter.filter(event);

      expect(result.passed).toBe(true);
    });

    test('should reject non-allowed comment actions', async () => {
      const config = createFilterConfig({
        events: {
          issue_comment: ['created'],
        },
      });
      const filter = new GitHubEventFilter(config);
      const event = createTestEvent({
        eventType: 'issue_comment',
        action: 'deleted',
        comment: {
          id: 'comment-1',
          body: 'Test comment',
        },
      });

      const result = await filter.filter(event);

      expect(result.passed).toBe(false);
    });

    test('should pass allowed PR actions', async () => {
      const config = createFilterConfig({
        events: {
          pull_request: ['opened', 'synchronize'],
        },
      });
      const filter = new GitHubEventFilter(config);
      const event = createTestEvent({
        eventType: 'pull_request',
        action: 'opened',
      });

      const result = await filter.filter(event);

      expect(result.passed).toBe(true);
    });

    test('should allow all actions when event type filter not specified', async () => {
      const config = createFilterConfig({
        events: {
          issues: ['opened'],
        },
      });
      const filter = new GitHubEventFilter(config);
      const event = createTestEvent({
        eventType: 'pull_request',
        action: 'closed',
      });

      const result = await filter.filter(event);

      expect(result.passed).toBe(true);
    });
  });

  describe('Combined Filters', () => {
    test('should pass when all filters match', async () => {
      const config = createFilterConfig({
        repositories: ['testowner/testrepo'],
        authors: {
          mode: 'allowlist',
          users: ['gooduser'],
        },
        labels: {
          mode: 'require_any',
          labels: ['bug', 'feature'],
        },
        events: {
          issues: ['opened'],
        },
      });
      const filter = new GitHubEventFilter(config);
      const event = createTestEvent({
        sender: { login: 'gooduser', type: 'User' },
        issue: {
          number: 1,
          title: 'Test',
          body: 'Body',
          labels: ['bug'],
        },
        eventType: 'issues',
        action: 'opened',
      });

      const result = await filter.filter(event);

      expect(result.passed).toBe(true);
    });

    test('should reject when any filter fails', async () => {
      const config = createFilterConfig({
        repositories: ['testowner/testrepo'],
        authors: {
          mode: 'allowlist',
          users: ['gooduser'],
        },
        labels: {
          mode: 'require_any',
          labels: ['bug', 'feature'],
        },
      });
      const filter = new GitHubEventFilter(config);
      const event = createTestEvent({
        sender: { login: 'gooduser', type: 'User' },
        issue: {
          number: 1,
          title: 'Test',
          body: 'Body',
          labels: ['documentation'],
        },
      });

      const result = await filter.filter(event);

      expect(result.passed).toBe(false);
      expect(result.reason).toContain('labels');
    });

    test('should stop at first failed filter (repository)', async () => {
      const config = createFilterConfig({
        repositories: ['other/repo'],
        authors: {
          mode: 'allowlist',
          users: ['testuser'],
        },
      });
      const filter = new GitHubEventFilter(config);
      const event = createTestEvent();

      const result = await filter.filter(event);

      expect(result.passed).toBe(false);
      expect(result.reason).toContain('Repository');
    });
  });

  describe('Config Update', () => {
    test('should use updated config after setConfig', async () => {
      const initialConfig = createFilterConfig({
        repositories: ['owner/initial'],
      });
      const filter = new GitHubEventFilter(initialConfig);
      const event = createTestEvent();

      let result = await filter.filter(event);
      expect(result.passed).toBe(false);

      const newConfig = createFilterConfig({
        repositories: ['testowner/testrepo'],
      });
      filter.setConfig(newConfig);

      result = await filter.filter(event);
      expect(result.passed).toBe(true);
    });
  });

  describe('Cache Management', () => {
    test('should clear permission cache', () => {
      const config = createFilterConfig();
      const filter = new GitHubEventFilter(config);

      expect(() => filter.clearCache()).not.toThrow();
    });
  });

  describe('Events without Issue Data', () => {
    test('should handle events without issue data (comment events)', async () => {
      const config = createFilterConfig({
        labels: {
          mode: 'require_any',
          labels: ['bug'],
        },
      });
      const filter = new GitHubEventFilter(config);
      const event = createTestEvent({
        eventType: 'issue_comment',
        action: 'created',
        issue: undefined,
        comment: {
          id: 'comment-1',
          body: 'Test comment',
        },
      });

      const result = await filter.filter(event);

      expect(result.passed).toBe(false);
    });
  });
});
