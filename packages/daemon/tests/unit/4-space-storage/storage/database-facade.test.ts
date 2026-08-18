import { describe, expect, it, beforeEach, afterEach } from 'bun:test';
import { Database } from '../../../../src/storage';
import { createReactiveDatabase } from '../../../../src/storage/reactive-database';
import type { Session } from '@hyperneo/shared';

function createTestSession(overrides: Partial<Session> = {}): Session {
  return {
    id: 'test-session-id',
    title: 'Test Session',
    workspacePath: '/test/workspace',
    createdAt: new Date().toISOString(),
    lastActiveAt: new Date().toISOString(),
    status: 'active',
    config: {
      model: 'default',
      maxTokens: 8192,
      temperature: 1.0,
    },
    metadata: {
      messageCount: 0,
      totalTokens: 0,
      inputTokens: 0,
      outputTokens: 0,
      totalCost: 0,
      toolCallCount: 0,
    },
    ...overrides,
  };
}

describe('Database Facade', () => {
  let db: Database;
  let dbPath: string;

  beforeEach(async () => {
    const tmpBase = (process.env.TMPDIR || '/tmp').replace(/\/$/, '');
    dbPath = `${tmpBase}/test-db-${Date.now()}-${Math.random().toString(36).slice(2)}.sqlite`;
    db = new Database(dbPath);
    const reactiveDb = createReactiveDatabase(db);
    await db.initialize(reactiveDb);
  });

  afterEach(() => {
    if (db) {
      db.close();
    }
    try {
      require('fs').unlinkSync(dbPath);
    } catch {
      // Ignore cleanup errors
    }
  });

  describe('constructor and initialize', () => {
    it('creates a Database instance', () => {
      expect(db).toBeDefined();
    });

    it('initializes repositories', async () => {
      expect(db).toBeDefined();
    });
  });

  describe('getDatabase', () => {
    it('returns the underlying BunDatabase instance', () => {
      const rawDb = db.getDatabase();
      expect(rawDb).toBeDefined();
      expect(typeof rawDb.query).toBe('function');
    });
  });

  describe('Session operations', () => {
    it('creates and retrieves a session', async () => {
      const session = createTestSession();
      db.createSession(session);

      const retrieved = db.getSession(session.id);
      expect(retrieved).toBeDefined();
      expect(retrieved!.id).toBe(session.id);
    });

    it('updates a session', async () => {
      const session = createTestSession();
      db.createSession(session);

      db.updateSession(session.id, { title: 'Updated Title' });

      const retrieved = db.getSession(session.id);
      expect(retrieved!.title).toBe('Updated Title');
    });

    it('deletes a session', async () => {
      const session = createTestSession();
      db.createSession(session);

      db.deleteSession(session.id);

      const retrieved = db.getSession(session.id);
      expect(retrieved).toBeNull();
    });

    it('lists all sessions', async () => {
      const session1 = createTestSession({ id: 'session-1' });
      const session2 = createTestSession({ id: 'session-2' });
      db.createSession(session1);
      db.createSession(session2);

      const sessions = db.listSessions();
      expect(sessions).toHaveLength(2);
    });
  });

  describe('Settings operations', () => {
    it('saves and retrieves global settings', async () => {
      const settings = {
        model: 'opus',
        theme: 'dark' as const,
      };

      db.saveGlobalSettings(settings);

      const retrieved = db.getGlobalSettings();
      expect(retrieved).toBeDefined();
      expect(retrieved!.model).toBe('opus');
    });
  });

  describe('Inbox item operations', () => {
    it('creates and lists inbox items', async () => {
      const item = {
        source: 'github_issue' as const,
        repository: 'owner/repo',
        issueNumber: 42,
        title: 'Test Issue',
        body: 'Test body',
        author: 'testuser',
        labels: [],
        securityCheck: { injectionRisk: 'none' as const },
        rawEvent: { test: true },
      };

      const created = db.createInboxItem(item);

      expect(created).toBeDefined();
      expect(created.repository).toBe('owner/repo');
      expect(created.title).toBe('Test Issue');
    });
  });
});
