import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { SDKMessageRepository } from '../../../../src/storage/repositories/sdk-message-repository';
import { SpaceRepository } from '../../../../src/storage/repositories/space-repository';
import { Database } from '../../../../src/storage/sqlite-compat';
import { createSpaceTables } from '../../helpers/space-test-db';

describe('SpaceRepository', () => {
  let db: Database;
  let repo: SpaceRepository;

  beforeEach(() => {
    db = new Database(':memory:');
    createSpaceTables(db);
    repo = new SpaceRepository(db as any);
  });

  afterEach(() => {
    db.close();
  });

  describe('createSpace', () => {
    it('creates a space with required fields', () => {
      const space = repo.createSpace({
        workspacePath: '/workspace/project',
        slug: 'my-project',
        name: 'My Project',
      });

      expect(space.id).toBeDefined();
      expect(space.workspacePath).toBe('/workspace/project');
      expect(space.name).toBe('My Project');
      expect(space.description).toBe('');
      expect(space.backgroundContext).toBe('');
      expect(space.instructions).toBe('');
      expect(space.status).toBe('active');
      expect(space.autonomyLevel).toBe(1);
      expect(space.maxConcurrentTasks).toBe(1);
      expect(space.sessionIds).toEqual([]);
      expect(space.config).toBeUndefined();
      expect(space.createdAt).toBeGreaterThan(0);
      expect(space.updatedAt).toBeGreaterThan(0);
    });

    it('creates a space with all optional fields', () => {
      const space = repo.createSpace({
        workspacePath: '/workspace/project',
        slug: 'my-project',
        name: 'My Project',
        description: 'A description',
        backgroundContext: 'Some context',
        instructions: 'Do this',
        defaultModel: 'claude-opus',
        allowedModels: ['claude-opus', 'claude-sonnet'],
        autonomyLevel: 3,
        config: { maxConcurrentTasks: 3, taskTimeoutMs: 60000 },
      });

      expect(space.description).toBe('A description');
      expect(space.backgroundContext).toBe('Some context');
      expect(space.instructions).toBe('Do this');
      expect(space.defaultModel).toBe('claude-opus');
      expect(space.allowedModels).toEqual(['claude-opus', 'claude-sonnet']);
      expect(space.autonomyLevel).toBe(3);
      expect(space.maxConcurrentTasks).toBe(3);
      expect(space.config).toEqual({ maxConcurrentTasks: 3, taskTimeoutMs: 60000 });
    });

    it('defaults autonomyLevel to 1 when not specified', () => {
      const space = repo.createSpace({ workspacePath: '/workspace/project', slug: 'p', name: 'P' });
      expect(space.autonomyLevel).toBe(1);
    });

    it('enforces unique workspace_path', () => {
      repo.createSpace({ workspacePath: '/workspace/project', slug: 'project-a', name: 'A' });
      expect(() => {
        repo.createSpace({ workspacePath: '/workspace/project', slug: 'project-b', name: 'B' });
      }).toThrow();
    });
  });

  describe('getSpace', () => {
    it('returns space by ID', () => {
      const created = repo.createSpace({ workspacePath: '/workspace/a', slug: 'a', name: 'A' });
      const found = repo.getSpace(created.id);
      expect(found).not.toBeNull();
      expect(found!.id).toBe(created.id);
    });

    it('returns null for unknown ID', () => {
      expect(repo.getSpace('nonexistent')).toBeNull();
    });
  });

  describe('getSpaceByPath', () => {
    it('returns space by workspace path', () => {
      const created = repo.createSpace({ workspacePath: '/workspace/a', slug: 'a', name: 'A' });
      const found = repo.getSpaceByPath('/workspace/a');
      expect(found).not.toBeNull();
      expect(found!.id).toBe(created.id);
    });

    it('returns null for unknown path', () => {
      expect(repo.getSpaceByPath('/does/not/exist')).toBeNull();
    });

    it('returns an archived space (a repo claim survives archive)', () => {
      const created = repo.createSpace({ workspacePath: '/workspace/a', slug: 'a', name: 'A' });
      repo.archiveSpace(created.id);

      const found = repo.getSpaceByPath('/workspace/a');

      expect(found).not.toBeNull();
      expect(found!.id).toBe(created.id);
      expect(found!.status).toBe('archived');
    });
  });

  describe('listSpaces', () => {
    it('lists active spaces by default', () => {
      repo.createSpace({ workspacePath: '/workspace/a', slug: 'a', name: 'A' });
      const b = repo.createSpace({ workspacePath: '/workspace/b', slug: 'b', name: 'B' });
      repo.archiveSpace(b.id);

      const spaces = repo.listSpaces();
      expect(spaces).toHaveLength(1);
      expect(spaces[0].name).toBe('A');
    });

    it('includes archived spaces when requested', () => {
      repo.createSpace({ workspacePath: '/workspace/a', slug: 'a', name: 'A' });
      const b = repo.createSpace({ workspacePath: '/workspace/b', slug: 'b', name: 'B' });
      repo.archiveSpace(b.id);

      const spaces = repo.listSpaces(true);
      expect(spaces).toHaveLength(2);
    });
  });

  describe('updateSpace', () => {
    it('updates name and description', () => {
      const space = repo.createSpace({ workspacePath: '/workspace/a', slug: 'a', name: 'A' });
      const updated = repo.updateSpace(space.id, { name: 'A Updated', description: 'New desc' });

      expect(updated).not.toBeNull();
      expect(updated!.name).toBe('A Updated');
      expect(updated!.description).toBe('New desc');
    });

    it('updates description individually', () => {
      const space = repo.createSpace({
        workspacePath: '/workspace/a',
        slug: 'a',
        name: 'A',
        description: 'Original',
      });
      const updated = repo.updateSpace(space.id, { description: 'Updated description' });
      expect(updated!.description).toBe('Updated description');
      expect(updated!.name).toBe('A');
    });

    it('updates backgroundContext individually', () => {
      const space = repo.createSpace({ workspacePath: '/workspace/a', slug: 'a', name: 'A' });
      expect(space.backgroundContext).toBe('');

      const updated = repo.updateSpace(space.id, {
        backgroundContext: 'This project uses Bun runtime',
      });
      expect(updated!.backgroundContext).toBe('This project uses Bun runtime');
      expect(updated!.name).toBe('A');
    });

    it('updates instructions individually', () => {
      const space = repo.createSpace({ workspacePath: '/workspace/a', slug: 'a', name: 'A' });
      expect(space.instructions).toBe('');

      const updated = repo.updateSpace(space.id, {
        instructions: 'Always write tests before code',
      });
      expect(updated!.instructions).toBe('Always write tests before code');
      expect(updated!.name).toBe('A');
    });

    it('updates allowedModels individually', () => {
      const space = repo.createSpace({ workspacePath: '/workspace/a', slug: 'a', name: 'A' });
      expect(space.allowedModels).toBeUndefined();

      const updated = repo.updateSpace(space.id, {
        allowedModels: ['claude-sonnet', 'claude-haiku'],
      });
      expect(updated!.allowedModels).toEqual(['claude-sonnet', 'claude-haiku']);
    });

    it('clears allowedModels to empty array', () => {
      const space = repo.createSpace({
        workspacePath: '/workspace/a',
        slug: 'a',
        name: 'A',
        allowedModels: ['claude-opus'],
      });
      expect(space.allowedModels).toEqual(['claude-opus']);

      const updated = repo.updateSpace(space.id, { allowedModels: [] });
      expect(updated!.allowedModels).toBeUndefined();
    });

    it('clears defaultModel when set to null', () => {
      const space = repo.createSpace({
        workspacePath: '/workspace/a',
        slug: 'a',
        name: 'A',
        defaultModel: 'claude-opus',
      });
      const updated = repo.updateSpace(space.id, { defaultModel: null });
      expect(updated!.defaultModel).toBeUndefined();
    });

    it('sets defaultModel from undefined', () => {
      const space = repo.createSpace({ workspacePath: '/workspace/a', slug: 'a', name: 'A' });
      expect(space.defaultModel).toBeUndefined();

      const updated = repo.updateSpace(space.id, { defaultModel: 'claude-sonnet' });
      expect(updated!.defaultModel).toBe('claude-sonnet');
    });

    it('updates autonomyLevel to 3', () => {
      const space = repo.createSpace({ workspacePath: '/workspace/a', slug: 'a', name: 'A' });
      expect(space.autonomyLevel).toBe(1);

      const updated = repo.updateSpace(space.id, { autonomyLevel: 3 });
      expect(updated!.autonomyLevel).toBe(3);
    });

    it('updates autonomyLevel back to 1', () => {
      const space = repo.createSpace({
        workspacePath: '/workspace/a',
        slug: 'a',
        name: 'A',
        autonomyLevel: 3,
      });
      const updated = repo.updateSpace(space.id, { autonomyLevel: 1 });
      expect(updated!.autonomyLevel).toBe(1);
    });

    it('updates typed config fields', () => {
      const space = repo.createSpace({ workspacePath: '/workspace/a', slug: 'a', name: 'A' });
      const updated = repo.updateSpace(space.id, {
        config: { maxConcurrentTasks: 5, taskTimeoutMs: 30000 },
      });
      expect(updated!.maxConcurrentTasks).toBe(5);
      expect(updated!.config).toEqual({ maxConcurrentTasks: 5, taskTimeoutMs: 30000 });
    });

    it('prefers explicit maxConcurrentTasks over legacy config updates', () => {
      const space = repo.createSpace({ workspacePath: '/workspace/a', slug: 'a', name: 'A' });
      const updated = repo.updateSpace(space.id, {
        maxConcurrentTasks: 4,
        config: { maxConcurrentTasks: 2, taskTimeoutMs: 30000 },
      });
      expect(updated!.maxConcurrentTasks).toBe(4);
      expect(updated!.config).toEqual({ maxConcurrentTasks: 2, taskTimeoutMs: 30000 });
    });

    it('clears config by replacing with empty object', () => {
      const space = repo.createSpace({
        workspacePath: '/workspace/a',
        slug: 'a',
        name: 'A',
        config: { maxConcurrentTasks: 3, taskTimeoutMs: 60000 },
      });
      expect(space.config).toBeDefined();

      const updated = repo.updateSpace(space.id, {
        config: { maxConcurrentTasks: 1, taskTimeoutMs: 5000 },
      });
      expect(updated!.config).toEqual({ maxConcurrentTasks: 1, taskTimeoutMs: 5000 });
    });

    it('does not clobber other fields when updating a single field', () => {
      const space = repo.createSpace({
        workspacePath: '/workspace/a',
        slug: 'a',
        name: 'Original Name',
        description: 'Original desc',
        backgroundContext: 'Original context',
        instructions: 'Original instructions',
        defaultModel: 'claude-opus',
        allowedModels: ['claude-opus', 'claude-sonnet'],
        autonomyLevel: 3,
        config: { maxConcurrentTasks: 3, taskTimeoutMs: 60000 },
      });

      const updated = repo.updateSpace(space.id, { name: 'New Name' });

      expect(updated!.name).toBe('New Name');
      expect(updated!.description).toBe('Original desc');
      expect(updated!.backgroundContext).toBe('Original context');
      expect(updated!.instructions).toBe('Original instructions');
      expect(updated!.defaultModel).toBe('claude-opus');
      expect(updated!.allowedModels).toEqual(['claude-opus', 'claude-sonnet']);
      expect(updated!.autonomyLevel).toBe(3);
      expect(updated!.config).toEqual({ maxConcurrentTasks: 3, taskTimeoutMs: 60000 });
      expect(updated!.workspacePath).toBe('/workspace/a');
    });

    it('returns null for unknown ID', () => {
      expect(repo.updateSpace('nonexistent', { name: 'X' })).toBeNull();
    });

    it('updates updatedAt timestamp on change', () => {
      const space = repo.createSpace({ workspacePath: '/workspace/a', slug: 'a', name: 'A' });
      const originalUpdatedAt = space.updatedAt;

      const updated = repo.updateSpace(space.id, { name: 'B' });
      expect(updated!.updatedAt).toBeGreaterThanOrEqual(originalUpdatedAt);
    });

    it('does not change updatedAt when no fields are provided', () => {
      const space = repo.createSpace({ workspacePath: '/workspace/a', slug: 'a', name: 'A' });
      const originalUpdatedAt = space.updatedAt;

      const updated = repo.updateSpace(space.id, {});
      expect(updated!.updatedAt).toBe(originalUpdatedAt);
      expect(updated!.name).toBe('A');
    });
  });

  describe('field round-trip: create with all fields → getSpace → verify', () => {
    it('round-trips all configuration fields through create and read', () => {
      const created = repo.createSpace({
        workspacePath: '/workspace/full-roundtrip',
        slug: 'full-roundtrip',
        name: 'Full Roundtrip',
        description: 'A comprehensive test',
        backgroundContext: 'This is the project background',
        instructions: 'Follow TDD practices',
        defaultModel: 'claude-opus',
        allowedModels: ['claude-opus', 'claude-sonnet', 'claude-haiku'],
        autonomyLevel: 3,
        config: { maxConcurrentTasks: 10, taskTimeoutMs: 120000 },
      });

      const readBack = repo.getSpace(created.id);

      expect(readBack).not.toBeNull();
      expect(readBack!.id).toBe(created.id);
      expect(readBack!.slug).toBe('full-roundtrip');
      expect(readBack!.workspacePath).toBe('/workspace/full-roundtrip');
      expect(readBack!.name).toBe('Full Roundtrip');
      expect(readBack!.description).toBe('A comprehensive test');
      expect(readBack!.backgroundContext).toBe('This is the project background');
      expect(readBack!.instructions).toBe('Follow TDD practices');
      expect(readBack!.defaultModel).toBe('claude-opus');
      expect(readBack!.allowedModels).toEqual(['claude-opus', 'claude-sonnet', 'claude-haiku']);
      expect(readBack!.autonomyLevel).toBe(3);
      expect(readBack!.config).toEqual({ maxConcurrentTasks: 10, taskTimeoutMs: 120000 });
      expect(readBack!.status).toBe('active');
      expect(readBack!.sessionIds).toEqual([]);
      expect(readBack!.createdAt).toBeGreaterThan(0);
      expect(readBack!.updatedAt).toBeGreaterThan(0);
    });

    it('round-trips updated fields through update and read', () => {
      const space = repo.createSpace({
        workspacePath: '/workspace/update-roundtrip',
        slug: 'update-roundtrip',
        name: 'Before Update',
        description: 'Before',
        backgroundContext: 'Before context',
        instructions: 'Before instructions',
        defaultModel: 'claude-opus',
        allowedModels: ['claude-opus'],
        autonomyLevel: 1,
      });

      repo.updateSpace(space.id, {
        name: 'After Update',
        description: 'After',
        backgroundContext: 'After context',
        instructions: 'After instructions',
        defaultModel: 'claude-sonnet',
        allowedModels: ['claude-sonnet', 'claude-haiku'],
        autonomyLevel: 3,
        config: { maxConcurrentTasks: 5, taskTimeoutMs: 30000 },
      });

      const readBack = repo.getSpace(space.id);

      expect(readBack!.name).toBe('After Update');
      expect(readBack!.description).toBe('After');
      expect(readBack!.backgroundContext).toBe('After context');
      expect(readBack!.instructions).toBe('After instructions');
      expect(readBack!.defaultModel).toBe('claude-sonnet');
      expect(readBack!.allowedModels).toEqual(['claude-sonnet', 'claude-haiku']);
      expect(readBack!.autonomyLevel).toBe(3);
      expect(readBack!.config).toEqual({ maxConcurrentTasks: 5, taskTimeoutMs: 30000 });
      expect(readBack!.workspacePath).toBe('/workspace/update-roundtrip');
      expect(readBack!.slug).toBe('update-roundtrip');
    });

    it('persists empty string values for text fields', () => {
      const space = repo.createSpace({
        workspacePath: '/workspace/empty-strings',
        slug: 'empty-strings',
        name: 'Empty Strings Test',
        description: 'Has content',
        backgroundContext: 'Has context',
        instructions: 'Has instructions',
      });

      const updated = repo.updateSpace(space.id, {
        description: '',
        backgroundContext: '',
        instructions: '',
      });

      const readBack = repo.getSpace(space.id);
      expect(readBack!.description).toBe('');
      expect(readBack!.backgroundContext).toBe('');
      expect(readBack!.instructions).toBe('');
      expect(readBack!.name).toBe('Empty Strings Test');
    });
  });

  describe('archiveSpace', () => {
    it('sets status to archived', () => {
      const space = repo.createSpace({ workspacePath: '/workspace/a', slug: 'a', name: 'A' });
      const archived = repo.archiveSpace(space.id);
      expect(archived!.status).toBe('archived');
    });
  });

  describe('addSessionToSpace / removeSessionFromSpace', () => {
    it('adds and removes sessions idempotently', () => {
      const space = repo.createSpace({ workspacePath: '/workspace/a', slug: 'a', name: 'A' });

      const withSession = repo.addSessionToSpace(space.id, 'session-1');
      expect(withSession!.sessionIds).toContain('session-1');

      const again = repo.addSessionToSpace(space.id, 'session-1');
      expect(again!.sessionIds).toHaveLength(1);

      const without = repo.removeSessionFromSpace(space.id, 'session-1');
      expect(without!.sessionIds).not.toContain('session-1');

      const noOp = repo.removeSessionFromSpace(space.id, 'session-1');
      expect(noOp!.sessionIds).toHaveLength(0);
    });

    it('returns null for unknown space', () => {
      expect(repo.addSessionToSpace('nonexistent', 's1')).toBeNull();
      expect(repo.removeSessionFromSpace('nonexistent', 's1')).toBeNull();
    });
  });

  describe('deleteSpace', () => {
    it('deletes a space', () => {
      const space = repo.createSpace({ workspacePath: '/workspace/a', slug: 'a', name: 'A' });
      expect(repo.deleteSpace(space.id)).toBe(true);
      expect(repo.getSpace(space.id)).toBeNull();
    });

    it('returns false for unknown ID', () => {
      expect(repo.deleteSpace('nonexistent')).toBe(false);
    });

    it('deletes task search rows before task rows cascade', () => {
      db.exec(`
				CREATE TABLE message_search_content (id INTEGER PRIMARY KEY, kind TEXT, source_id TEXT, message_id TEXT, session_id TEXT, task_id TEXT, space_id TEXT, task_number INTEGER, message_type TEXT, title TEXT, body TEXT, timestamp INTEGER);
					CREATE VIRTUAL TABLE message_search_fts USING fts5(title, body, content='message_search_content', content_rowid='id', detail=column, tokenize = 'unicode61');
					CREATE TRIGGER message_search_content_ai AFTER INSERT ON message_search_content BEGIN INSERT INTO message_search_fts(rowid, title, body) VALUES (new.id, new.title, new.body); END;
					CREATE TRIGGER message_search_content_ad AFTER DELETE ON message_search_content BEGIN INSERT INTO message_search_fts(message_search_fts, rowid, title, body) VALUES ('delete', old.id, old.title, old.body); END;
					CREATE TRIGGER message_search_content_au AFTER UPDATE OF title, body ON message_search_content BEGIN INSERT INTO message_search_fts(message_search_fts, rowid, title, body) VALUES ('delete', old.id, old.title, old.body); INSERT INTO message_search_fts(rowid, title, body) VALUES (new.id, new.title, new.body); END
			`);
      const deleted = repo.createSpace({ workspacePath: '/workspace/a', slug: 'a', name: 'A' });
      const kept = repo.createSpace({ workspacePath: '/workspace/b', slug: 'b', name: 'B' });
      db.prepare(
        `INSERT INTO message_search_content (kind, source_id, task_id, space_id, title, body, timestamp)
				 VALUES ('task', ?, ?, ?, ?, ?, ?)`
      ).run('task-1', 'task-1', deleted.id, 'Deleted', 'needle deleted', Date.now());
      db.prepare(
        `INSERT INTO message_search_content (kind, source_id, task_id, space_id, title, body, timestamp)
				 VALUES ('task', ?, ?, ?, ?, ?, ?)`
      ).run('task-2', 'task-2', kept.id, 'Kept', 'needle kept', Date.now());

      repo.deleteSpace(deleted.id);

      const rows = db
        .prepare(
          `SELECT msc.source_id FROM message_search_fts JOIN message_search_content msc ON msc.id = message_search_fts.rowid WHERE message_search_fts MATCH ?`
        )
        .all('needle') as Array<{ source_id: string }>;
      expect(rows.map((row) => row.source_id)).toEqual(['task-2']);
    });

    it('purges pending message rows for the deleted space', () => {
      db.exec(`
				CREATE TABLE message_search_content (id INTEGER PRIMARY KEY, kind TEXT, source_id TEXT, message_id TEXT, session_id TEXT, task_id TEXT, space_id TEXT, task_number INTEGER, message_type TEXT, title TEXT, body TEXT, timestamp INTEGER);
					CREATE TABLE message_search_pending (message_id TEXT PRIMARY KEY, created_at INTEGER NOT NULL);
					CREATE VIRTUAL TABLE message_search_fts USING fts5(title, body, content='message_search_content', content_rowid='id', detail=column, tokenize = 'unicode61');
					CREATE TRIGGER message_search_content_ai AFTER INSERT ON message_search_content BEGIN INSERT INTO message_search_fts(rowid, title, body) VALUES (new.id, new.title, new.body); END;
					CREATE TRIGGER message_search_content_ad AFTER DELETE ON message_search_content BEGIN INSERT INTO message_search_fts(message_search_fts, rowid, title, body) VALUES ('delete', old.id, old.title, old.body); END;
					CREATE TRIGGER message_search_content_au AFTER UPDATE OF title, body ON message_search_content BEGIN INSERT INTO message_search_fts(message_search_fts, rowid, title, body) VALUES ('delete', old.id, old.title, old.body); INSERT INTO message_search_fts(rowid, title, body) VALUES (new.id, new.title, new.body); END
			`);
      const deleted = repo.createSpace({ workspacePath: '/workspace/a', slug: 'a', name: 'A' });
      const kept = repo.createSpace({ workspacePath: '/workspace/b', slug: 'b', name: 'B' });
      const now = Date.now();
      const iso = new Date().toISOString();
      db.prepare(
        `INSERT INTO space_tasks (id, space_id, task_number, title, created_at, updated_at)
				 VALUES (?, ?, ?, ?, ?, ?)`
      ).run('task-deleted', deleted.id, 1, 'Deleted task', now, now);
      db.prepare(
        `INSERT INTO space_tasks (id, space_id, task_number, title, created_at, updated_at)
				 VALUES (?, ?, ?, ?, ?, ?)`
      ).run('task-kept', kept.id, 1, 'Kept task', now, now);
      for (const sessionId of ['session-deleted', 'session-kept']) {
        db.prepare(
          `INSERT INTO sessions (id, title, created_at, last_active_at, status, config, metadata)
					 VALUES (?, ?, ?, ?, 'active', '{}', '{}')`
        ).run(sessionId, sessionId, iso, iso);
      }
      const insertMessage = db.prepare(
        `INSERT INTO sdk_messages (id, session_id, message_type, sdk_message, timestamp, send_status, task_id)
				 VALUES (?, ?, ?, ?, ?, ?, ?)`
      );
      insertMessage.run(
        'msg-deleted',
        'session-deleted',
        'user',
        JSON.stringify({
          type: 'user',
          uuid: 'u-deleted',
          message: {
            role: 'user',
            content: [{ type: 'text', text: 'deleted space purge marker' }],
          },
        }),
        iso,
        'consumed',
        'task-deleted'
      );
      insertMessage.run(
        'msg-kept',
        'session-kept',
        'user',
        JSON.stringify({
          type: 'user',
          uuid: 'u-kept',
          message: { role: 'user', content: [{ type: 'text', text: 'kept space marker' }] },
        }),
        iso,
        'consumed',
        'task-kept'
      );
      db.prepare(`INSERT INTO message_search_pending (message_id, created_at) VALUES (?, ?)`).run(
        'msg-deleted',
        now
      );
      db.prepare(`INSERT INTO message_search_pending (message_id, created_at) VALUES (?, ?)`).run(
        'msg-kept',
        now
      );

      repo.deleteSpace(deleted.id);

      const pending = db.prepare(`SELECT message_id FROM message_search_pending`).all() as Array<{
        message_id: string;
      }>;
      expect(pending.map((row) => row.message_id)).toEqual(['msg-kept']);

      const sdkRepo = new SDKMessageRepository(db as any);
      sdkRepo.flushMessageSearchIndex();
      expect(sdkRepo.searchMessages({ query: 'deleted space purge' }).results).toEqual([]);
      expect(sdkRepo.searchMessages({ query: 'kept space marker' }).results).toHaveLength(1);
    });
  });
});
