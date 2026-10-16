import { describe, expect, it, beforeEach } from 'bun:test';
import { InboxManager } from '../../../../src/lib/github/inbox-manager';
import type { Database } from '../../../../src/storage/database';
import type { GitHubEvent, InboxItem, SecurityCheckResult } from '@hyperneo/shared';
import { mock } from 'bun:test';

function createGitHubEvent(overrides: Partial<GitHubEvent> = {}): GitHubEvent {
  return {
    id: 'event-123',
    source: 'webhook',
    eventType: 'issues',
    action: 'opened',
    repository: {
      owner: 'testowner',
      repo: 'test-repo',
      fullName: 'testowner/test-repo',
    },
    issue: {
      number: 42,
      title: 'Test Issue',
      body: 'Test body',
      labels: ['bug'],
    },
    sender: {
      login: 'testuser',
      type: 'User',
    },
    rawPayload: { test: true },
    receivedAt: Date.now(),
    ...overrides,
  };
}

function createSecurityCheck(overrides: Partial<SecurityCheckResult> = {}): SecurityCheckResult {
  return {
    passed: true,
    injectionRisk: 'none',
    ...overrides,
  };
}

function createInboxItem(overrides: Partial<InboxItem> = {}): InboxItem {
  return {
    id: 'inbox-123',
    source: 'github_issue',
    repository: 'testowner/test-repo',
    issueNumber: 42,
    title: 'Test Issue',
    body: 'Test body',
    author: 'testuser',
    labels: ['bug'],
    status: 'pending',
    securityCheck: createSecurityCheck(),
    rawEvent: { test: true },
    receivedAt: Date.now(),
    updatedAt: Date.now(),
    ...overrides,
  };
}

function createMockDatabase(): Database {
  return {
    createInboxItem: mock(() => createInboxItem()),
    countInboxItemsByStatus: mock(() => 1),
  } as unknown as Database;
}

describe('InboxManager', () => {
  let mockDb: Database;
  let manager: InboxManager;

  beforeEach(() => {
    mockDb = createMockDatabase();
    manager = new InboxManager(mockDb);
  });

  describe('addToInbox', () => {
    it('should add issue event to inbox', () => {
      const event = createGitHubEvent({ eventType: 'issues' });
      const securityResult = createSecurityCheck();

      manager.addToInbox(event, securityResult, 'Test reason');

      expect(mockDb.createInboxItem).toHaveBeenCalledWith(
        expect.objectContaining({
          source: 'github_issue',
          repository: 'testowner/test-repo',
          issueNumber: 42,
          title: 'Test Issue',
          body: 'Test body',
          author: 'testuser',
          labels: ['bug'],
        })
      );
    });

    it('should add comment event to inbox', () => {
      const event = createGitHubEvent({
        eventType: 'issue_comment',
        comment: { id: 'comment-1', body: 'Comment body' },
      });

      manager.addToInbox(event, createSecurityCheck(), 'Test reason');

      expect(mockDb.createInboxItem).toHaveBeenCalledWith(
        expect.objectContaining({
          source: 'github_comment',
          commentId: 'comment-1',
          body: 'Comment body',
        })
      );
    });

    it('should add PR event to inbox', () => {
      const event = createGitHubEvent({
        eventType: 'pull_request',
        issue: { number: 10, title: 'PR Title', body: 'PR body', labels: [] },
      });

      manager.addToInbox(event, createSecurityCheck(), 'Test reason');

      expect(mockDb.createInboxItem).toHaveBeenCalledWith(
        expect.objectContaining({
          source: 'github_pr',
          issueNumber: 10,
          title: 'PR Title',
        })
      );
    });

    it('should use issue body when no comment', () => {
      const event = createGitHubEvent({
        eventType: 'issues',
        issue: { number: 1, title: 'Title', body: 'Issue body', labels: [] },
      });

      manager.addToInbox(event, createSecurityCheck(), 'reason');

      expect(mockDb.createInboxItem).toHaveBeenCalledWith(
        expect.objectContaining({
          body: 'Issue body',
        })
      );
    });

    it('should include security check result', () => {
      const event = createGitHubEvent();
      const securityResult = createSecurityCheck({
        passed: false,
        injectionRisk: 'high',
        reason: 'Suspicious content',
      });

      manager.addToInbox(event, securityResult, 'reason');

      expect(mockDb.createInboxItem).toHaveBeenCalledWith(
        expect.objectContaining({
          securityCheck: {
            passed: false,
            injectionRisk: 'high',
            reason: 'Suspicious content',
          },
        })
      );
    });

    it('should include raw event payload', () => {
      const event = createGitHubEvent({
        rawPayload: { custom: 'payload', data: 123 },
      });

      manager.addToInbox(event, createSecurityCheck(), 'reason');

      expect(mockDb.createInboxItem).toHaveBeenCalledWith(
        expect.objectContaining({
          rawEvent: { custom: 'payload', data: 123 },
        })
      );
    });
  });

  describe('countByStatus', () => {
    it('should count all statuses', () => {
      const counts = manager.countByStatus();

      expect(mockDb.countInboxItemsByStatus).toHaveBeenCalledWith('pending');
      expect(mockDb.countInboxItemsByStatus).toHaveBeenCalledWith('routed');
      expect(mockDb.countInboxItemsByStatus).toHaveBeenCalledWith('dismissed');
      expect(mockDb.countInboxItemsByStatus).toHaveBeenCalledWith('blocked');
    });

    it('should return counts record', () => {
      const counts = manager.countByStatus();

      expect(counts).toHaveProperty('pending');
      expect(counts).toHaveProperty('routed');
      expect(counts).toHaveProperty('dismissed');
      expect(counts).toHaveProperty('blocked');
    });
  });
});
