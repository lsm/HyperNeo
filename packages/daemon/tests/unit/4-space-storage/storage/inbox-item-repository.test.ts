import { describe, expect, it, beforeEach, afterEach } from 'bun:test';
import { Database } from '../../../../src/storage/sqlite-compat';
import {
  InboxItemRepository,
  type CreateInboxItemParams,
} from '../../../../src/storage/repositories/inbox-item-repository';
import type { SecurityCheckResult, InboxItem } from '@hyperneo/shared';

function createSecurityCheck(overrides: Partial<SecurityCheckResult> = {}): SecurityCheckResult {
  return {
    passed: true,
    injectionRisk: 'none',
    ...overrides,
  };
}

function createInboxItemParams(
  overrides: Partial<CreateInboxItemParams> = {}
): CreateInboxItemParams {
  return {
    source: 'github_issue',
    repository: 'owner/repo',
    issueNumber: 42,
    title: 'Test Issue',
    body: 'Test body',
    author: 'testuser',
    labels: ['bug'],
    securityCheck: createSecurityCheck(),
    rawEvent: { type: 'test' },
    ...overrides,
  };
}

function createInboxTable(db: Database): void {
  db.exec(`
    CREATE TABLE inbox_items (
      id TEXT PRIMARY KEY,
      source TEXT NOT NULL,
      repository TEXT NOT NULL,
      issue_number INTEGER NOT NULL,
      comment_id TEXT,
      title TEXT NOT NULL,
      body TEXT NOT NULL,
      author TEXT NOT NULL,
      author_permission TEXT,
      labels TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending',
      routed_to_room_id TEXT,
      routed_at INTEGER,
      security_check TEXT NOT NULL,
      raw_event TEXT NOT NULL,
      received_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    )
  `);
}

describe('InboxItemRepository', () => {
  let db: Database;
  let repository: InboxItemRepository;

  beforeEach(() => {
    db = new Database(':memory:');
    createInboxTable(db);
    repository = new InboxItemRepository(db);
  });

  afterEach(() => {
    db.close();
  });

  describe('createItem', () => {
    it('should create an item with required fields', () => {
      const params = createInboxItemParams();
      const item = repository.createItem(params);

      expect(item.id).toMatch(/^[\da-f-]{36}$/);
      expect(item.source).toBe('github_issue');
      expect(item.repository).toBe('owner/repo');
      expect(item.issueNumber).toBe(42);
      expect(item.title).toBe('Test Issue');
      expect(item.body).toBe('Test body');
      expect(item.author).toBe('testuser');
      expect(item.labels).toEqual(['bug']);
      expect(item.status).toBe('pending');
      expect(item.securityCheck.passed).toBe(true);
      expect(item.receivedAt).toBeGreaterThan(0);
      expect(item.updatedAt).toBeGreaterThan(0);
    });

    it('should create an item with optional commentId', () => {
      const params = createInboxItemParams({
        source: 'github_comment',
        commentId: 'comment-123',
      });
      const item = repository.createItem(params);

      expect(item.commentId).toBe('comment-123');
      expect(item.source).toBe('github_comment');
    });

    it('should create an item with optional authorPermission', () => {
      const params = createInboxItemParams({
        authorPermission: 'write',
      });
      const item = repository.createItem(params);

      expect(item.authorPermission).toBe('write');
    });

    it('should serialize labels as JSON', () => {
      const params = createInboxItemParams({
        labels: ['bug', 'priority', 'help wanted'],
      });
      const item = repository.createItem(params);

      expect(item.labels).toEqual(['bug', 'priority', 'help wanted']);
    });

    it('should serialize securityCheck as JSON', () => {
      const params = createInboxItemParams({
        securityCheck: createSecurityCheck({
          passed: false,
          reason: 'Suspicious content',
          injectionRisk: 'high',
        }),
      });
      const item = repository.createItem(params);

      expect(item.securityCheck.passed).toBe(false);
      expect(item.securityCheck.reason).toBe('Suspicious content');
      expect(item.securityCheck.injectionRisk).toBe('high');
    });

    it('should serialize rawEvent as JSON', () => {
      const params = createInboxItemParams({
        rawEvent: {
          action: 'opened',
          issue: { number: 42, title: 'Test' },
        },
      });
      const item = repository.createItem(params);

      expect(item.rawEvent).toEqual({
        action: 'opened',
        issue: { number: 42, title: 'Test' },
      });
    });

    it('should create PR item', () => {
      const params = createInboxItemParams({
        source: 'github_pr',
        issueNumber: 100,
      });
      const item = repository.createItem(params);

      expect(item.source).toBe('github_pr');
      expect(item.issueNumber).toBe(100);
    });
  });

  describe('getItem', () => {
    it('should retrieve an item by ID', () => {
      const created = repository.createItem(createInboxItemParams());
      const retrieved = repository.getItem(created.id);

      expect(retrieved).not.toBeNull();
      expect(retrieved?.id).toBe(created.id);
      expect(retrieved?.title).toBe('Test Issue');
    });

    it('should return null for non-existent ID', () => {
      const retrieved = repository.getItem('non-existent-id');
      expect(retrieved).toBeNull();
    });
  });

  describe('listItems', () => {
    it('should list all items when no filter', () => {
      repository.createItem(createInboxItemParams({ issueNumber: 1 }));
      repository.createItem(createInboxItemParams({ issueNumber: 2 }));

      const items = repository.listItems();

      expect(items).toHaveLength(2);
    });

    it('should filter by status', () => {
      repository.createItem(createInboxItemParams({ issueNumber: 1 }));
      const item2 = repository.createItem(createInboxItemParams({ issueNumber: 2 }));
      repository.dismissItem(item2.id);

      const pending = repository.listItems({ status: 'pending' });
      const dismissed = repository.listItems({ status: 'dismissed' });

      expect(pending).toHaveLength(1);
      expect(pending[0]?.issueNumber).toBe(1);
      expect(dismissed).toHaveLength(1);
      expect(dismissed[0]?.issueNumber).toBe(2);
    });

    it('should filter by repository', () => {
      repository.createItem(createInboxItemParams({ repository: 'owner/repo1', issueNumber: 1 }));
      repository.createItem(createInboxItemParams({ repository: 'owner/repo2', issueNumber: 2 }));

      const items = repository.listItems({ repository: 'owner/repo1' });

      expect(items).toHaveLength(1);
      expect(items[0]?.issueNumber).toBe(1);
    });

    it('should filter by issueNumber', () => {
      repository.createItem(createInboxItemParams({ issueNumber: 42 }));
      repository.createItem(createInboxItemParams({ issueNumber: 43 }));

      const items = repository.listItems({ issueNumber: 42 });

      expect(items).toHaveLength(1);
      expect(items[0]?.issueNumber).toBe(42);
    });

    it('should respect limit', () => {
      for (let i = 0; i < 10; i++) {
        repository.createItem(createInboxItemParams({ issueNumber: i }));
      }

      const items = repository.listItems({ limit: 5 });

      expect(items).toHaveLength(5);
    });

    it('should respect offset with limit', () => {
      for (let i = 0; i < 5; i++) {
        repository.createItem(createInboxItemParams({ issueNumber: i }));
      }

      const items = repository.listItems({ limit: 3, offset: 2 });

      expect(items).toHaveLength(3);
    });

    it('should order by received_at DESC', async () => {
      repository.createItem(createInboxItemParams({ issueNumber: 1 }));
      await new Promise((r) => setTimeout(r, 10));
      repository.createItem(createInboxItemParams({ issueNumber: 2 }));
      await new Promise((r) => setTimeout(r, 10));
      repository.createItem(createInboxItemParams({ issueNumber: 3 }));

      const items = repository.listItems();

      expect(items[0]?.issueNumber).toBe(3);
      expect(items[1]?.issueNumber).toBe(2);
      expect(items[2]?.issueNumber).toBe(1);
    });

    it('should combine multiple filters', () => {
      repository.createItem(createInboxItemParams({ repository: 'owner/repo1', issueNumber: 1 }));
      repository.createItem(createInboxItemParams({ repository: 'owner/repo1', issueNumber: 2 }));
      repository.createItem(createInboxItemParams({ repository: 'owner/repo2', issueNumber: 1 }));

      const items = repository.listItems({
        repository: 'owner/repo1',
        status: 'pending',
      });

      expect(items).toHaveLength(2);
    });
  });

  describe('listPendingItems', () => {
    it('should list only pending items', () => {
      repository.createItem(createInboxItemParams({ issueNumber: 1 }));
      const item2 = repository.createItem(createInboxItemParams({ issueNumber: 2 }));
      repository.dismissItem(item2.id);

      const pending = repository.listPendingItems();

      expect(pending).toHaveLength(1);
      expect(pending[0]?.status).toBe('pending');
    });

    it('should respect default limit of 50', () => {
      for (let i = 0; i < 60; i++) {
        repository.createItem(createInboxItemParams({ issueNumber: i }));
      }

      const pending = repository.listPendingItems();

      expect(pending).toHaveLength(50);
    });

    it('should respect custom limit', () => {
      for (let i = 0; i < 10; i++) {
        repository.createItem(createInboxItemParams({ issueNumber: i }));
      }

      const pending = repository.listPendingItems(3);

      expect(pending).toHaveLength(3);
    });
  });

  describe('updateItemStatus', () => {
    it('should update status', () => {
      const item = repository.createItem(createInboxItemParams());
      const updated = repository.updateItemStatus(item.id, 'dismissed');

      expect(updated?.status).toBe('dismissed');
    });

    it('should set routedToRoomId and routedAt when routing', () => {
      const item = repository.createItem(createInboxItemParams());
      const updated = repository.updateItemStatus(item.id, 'routed', 'room-123');

      expect(updated?.status).toBe('routed');
      expect(updated?.routedToRoomId).toBe('room-123');
      expect(updated?.routedAt).toBeGreaterThan(0);
    });

    it('should update updatedAt timestamp', async () => {
      const item = repository.createItem(createInboxItemParams());
      const originalUpdatedAt = item.updatedAt;

      await new Promise((r) => setTimeout(r, 10));
      const updated = repository.updateItemStatus(item.id, 'dismissed');

      expect(updated?.updatedAt).toBeGreaterThan(originalUpdatedAt);
    });

    it('should return null for non-existent ID', () => {
      const result = repository.updateItemStatus('non-existent', 'dismissed');
      expect(result).toBeNull();
    });
  });

  describe('dismissItem', () => {
    it('should set status to dismissed', () => {
      const item = repository.createItem(createInboxItemParams());
      const updated = repository.dismissItem(item.id);

      expect(updated?.status).toBe('dismissed');
    });
  });

  describe('routeItem', () => {
    it('should set status to routed with room ID', () => {
      const item = repository.createItem(createInboxItemParams());
      const updated = repository.routeItem(item.id, 'room-456');

      expect(updated?.status).toBe('routed');
      expect(updated?.routedToRoomId).toBe('room-456');
      expect(updated?.routedAt).toBeGreaterThan(0);
    });
  });

  describe('blockItem', () => {
    it('should set status to blocked', () => {
      const item = repository.createItem(createInboxItemParams());
      const updated = repository.blockItem(item.id);

      expect(updated?.status).toBe('blocked');
    });
  });

  describe('deleteItem', () => {
    it('should delete an item', () => {
      const item = repository.createItem(createInboxItemParams());

      repository.deleteItem(item.id);

      const retrieved = repository.getItem(item.id);
      expect(retrieved).toBeNull();
    });

    it('should not throw for non-existent ID', () => {
      expect(() => repository.deleteItem('non-existent')).not.toThrow();
    });
  });

  describe('deleteItemsForRepository', () => {
    it('should delete all items for a repository', () => {
      repository.createItem(createInboxItemParams({ repository: 'owner/repo1', issueNumber: 1 }));
      repository.createItem(createInboxItemParams({ repository: 'owner/repo1', issueNumber: 2 }));
      repository.createItem(createInboxItemParams({ repository: 'owner/repo2', issueNumber: 1 }));

      const count = repository.deleteItemsForRepository('owner/repo1');

      expect(count).toBe(2);
      expect(repository.listItems({ repository: 'owner/repo1' })).toHaveLength(0);
      expect(repository.listItems({ repository: 'owner/repo2' })).toHaveLength(1);
    });

    it('should return 0 for non-existent repository', () => {
      const count = repository.deleteItemsForRepository('non/existent');
      expect(count).toBe(0);
    });
  });

  describe('countByStatus', () => {
    it('should count items by status', () => {
      repository.createItem(createInboxItemParams({ issueNumber: 1 }));
      repository.createItem(createInboxItemParams({ issueNumber: 2 }));
      const item3 = repository.createItem(createInboxItemParams({ issueNumber: 3 }));
      repository.dismissItem(item3.id);

      expect(repository.countByStatus('pending')).toBe(2);
      expect(repository.countByStatus('dismissed')).toBe(1);
      expect(repository.countByStatus('routed')).toBe(0);
      expect(repository.countByStatus('blocked')).toBe(0);
    });

    it('should return 0 for non-matching status', () => {
      repository.createItem(createInboxItemParams());
      expect(repository.countByStatus('routed')).toBe(0);
    });
  });
});
