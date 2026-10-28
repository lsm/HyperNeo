import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { InboxManager } from '../../../../src/lib/github/inbox-manager';
import type { Database } from '../../../../src/storage/database';
import { Database as SqliteDatabase } from '../../../../src/storage/sqlite-compat';
import { DbGateway } from '../../../../src/storage/db-gateway/db-gateway';
import { InboxItemRepository } from '../../../../src/storage/repositories/inbox-item-repository';
import { createTables, runMigrations } from '../../../../src/storage/schema';
import type { GitHubEvent, SecurityCheckResult, InboxItemStatus } from '@hyperneo/shared';

function createGitHubEvent(overrides: Partial<GitHubEvent> = {}): GitHubEvent {
  return {
    id: 'event-123',
    source: 'webhook',
    eventType: 'issues',
    action: 'opened',
    repository: { owner: 'testowner', repo: 'test-repo', fullName: 'testowner/test-repo' },
    issue: { number: 42, title: 'Test Issue', body: 'Test body', labels: ['bug'] },
    sender: { login: 'testuser', type: 'User' },
    rawPayload: { test: true },
    receivedAt: Date.now(),
    ...overrides,
  };
}
const security: SecurityCheckResult = { passed: true, injectionRisk: 'none' };
describe('InboxManager', () => {
  let raw: SqliteDatabase;
  let gateway: DbGateway;
  let repository: InboxItemRepository;
  let manager: InboxManager;
  beforeEach(() => {
    raw = new SqliteDatabase(':memory:');
    runMigrations(raw, () => {});
    createTables(raw);
    gateway = new DbGateway(':memory:', raw);
    repository = new InboxItemRepository(raw);
    const db = {
      gateway,
      createInboxItem: (params: Parameters<InboxItemRepository['createItem']>[0]) =>
        repository.createItem(params),
      countInboxItemsByStatus: (status: InboxItemStatus) => repository.countByStatus(status),
    } as unknown as Database;
    manager = new InboxManager(db);
  });
  afterEach(async () => {
    await gateway.close();
    raw.close();
  });
  const cases: {
    name: string;
    overrides: Partial<GitHubEvent>;
    expected: Record<string, unknown>;
    security?: SecurityCheckResult;
  }[] = [
    {
      name: 'issue fields',
      overrides: {},
      expected: {
        source: 'github_issue',
        repository: 'testowner/test-repo',
        issueNumber: 42,
        title: 'Test Issue',
        body: 'Test body',
        author: 'testuser',
        labels: ['bug'],
      },
    },
    {
      name: 'comment body and identity',
      overrides: { eventType: 'issue_comment', comment: { id: 'comment-1', body: 'Comment body' } },
      expected: { source: 'github_comment', commentId: 'comment-1', body: 'Comment body' },
    },
    {
      name: 'PR fields',
      overrides: {
        eventType: 'pull_request',
        issue: { number: 10, title: 'PR Title', body: 'PR body', labels: [] },
      },
      expected: { source: 'github_pr', issueNumber: 10, title: 'PR Title' },
    },
    {
      name: 'issue body without a comment',
      overrides: { issue: { number: 1, title: 'Title', body: 'Issue body', labels: [] } },
      expected: { body: 'Issue body' },
    },
    {
      name: 'security rejection metadata',
      overrides: {},
      security: { passed: false, injectionRisk: 'high', reason: 'Suspicious content' },
      expected: {
        securityCheck: { passed: false, injectionRisk: 'high', reason: 'Suspicious content' },
      },
    },
    {
      name: 'raw event payload',
      overrides: { rawPayload: { custom: 'payload', data: 123 } },
      expected: { rawEvent: { custom: 'payload', data: 123 } },
    },
  ];
  for (const scenario of cases)
    it('persists ' + scenario.name, async () => {
      const item = await manager.addToInbox(
        createGitHubEvent(scenario.overrides),
        scenario.security ?? security,
        'synthetic reason'
      );
      expect(item).toMatchObject({ ...scenario.expected, status: 'pending' });
      expect(repository.getItem(item.id)).toEqual(item);
    });
  it('counts each persisted status', async () => {
    const statuses: InboxItemStatus[] = ['pending', 'routed', 'dismissed', 'blocked'];
    for (const status of statuses) {
      const item = await manager.addToInbox(createGitHubEvent(), security, 'synthetic');
      repository.updateItemStatus(item.id, status);
    }
    expect(manager.countByStatus()).toEqual({ pending: 1, routed: 1, dismissed: 1, blocked: 1 });
  });
  it('returns zero counts for an empty inbox', () => {
    expect(manager.countByStatus()).toEqual({ pending: 0, routed: 0, dismissed: 0, blocked: 0 });
  });
});
