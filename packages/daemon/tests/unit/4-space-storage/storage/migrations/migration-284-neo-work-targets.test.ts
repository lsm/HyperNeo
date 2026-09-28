import { describe, expect, mock, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Database } from '../../../../../src/storage/sqlite-compat.ts';
import { createNeoTables } from '../../../../../src/storage/schema/neo.ts';
import { runMigration283 } from '../../../../../src/storage/schema/m283-neo-work-origins.ts';
import { runMigration284 } from '../../../../../src/storage/schema/m284-neo-work-targets.ts';
import { NeoRepository } from '../../../../../src/storage/repositories/neo-repository.ts';
import { Database as DaemonDatabase } from '../../../../../src/storage/database.ts';
import { createReactiveDatabase } from '../../../../../src/storage/reactive-database.ts';

const proposal = {
  id: 'work-A',
  requestKey: 'request-A',
  concernId: null,
  originSessionId: 'root',
  originMessageId: 'ask-A',
  title: 'Project readiness',
  instruction: 'Inspect readiness, do not change files',
};
function oldDatabase() {
  const db = new Database(':memory:');
  db.exec(`CREATE TABLE neo_work (
    id TEXT PRIMARY KEY, request_key TEXT NOT NULL UNIQUE, concern_id TEXT,
    origin_session_id TEXT NOT NULL, origin_message_id TEXT, title TEXT NOT NULL,
    instruction TEXT NOT NULL, session_id TEXT, status TEXT NOT NULL
      CHECK (status IN ('proposed', 'queued', 'reported', 'failed', 'cancelled')),
    report TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
  )`);
  db.prepare(`INSERT INTO neo_work
    (id, request_key, origin_session_id, origin_message_id, title, instruction, session_id,
      status, report, created_at, updated_at)
    VALUES ('old', 'old-key', 'old-root', 'old-ask', 'Old work', 'Old brief', 'old-worker',
      'reported', 'Old report', 1, 2)`).run();
  return db;
}

describe('migration 284 and work-target storage', () => {
  test('the actual migration runner upgrades an existing daemon database', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'neo-work-target-upgrade-'));
    const path = join(directory, 'daemon.db');
    const first = new DaemonDatabase(path, { messageSearchIndexFlushIntervalMs: 0 });
    try {
      await first.initialize(createReactiveDatabase(first));
      new NeoRepository(first.getDatabase()).proposeWork(proposal);
      first.getDatabase().exec('ALTER TABLE neo_work DROP COLUMN target_session_id');
      first
        .getDatabase()
        .prepare('DELETE FROM migration_markers WHERE key = ?')
        .run('migration_284');
    } finally {
      first.close();
    }
    const reopened = new DaemonDatabase(path, { messageSearchIndexFlushIntervalMs: 0 });
    try {
      await reopened.initialize(createReactiveDatabase(reopened));
      const repo = new NeoRepository(reopened.getDatabase());
      expect(repo.getWorkTarget(proposal.id)).toEqual({ id: proposal.id, targetSessionId: null });
      expect(repo.getWork(proposal.id)).toMatchObject({
        ...proposal,
        status: 'proposed',
        sessionId: null,
      });
      expect(
        reopened
          .getDatabase()
          .prepare('SELECT key FROM migration_markers WHERE key = ?')
          .get('migration_284')
      ).toEqual({ key: 'migration_284' });
      repo.proposeWork({
        ...proposal,
        id: 'next',
        requestKey: 'next',
        targetSessionId: 'existing-manager',
      });
      expect(repo.getWorkTarget('next')).toEqual({
        id: 'next',
        targetSessionId: 'existing-manager',
      });
    } finally {
      reopened.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });
  test('adds nullable target metadata without changing any legacy work field', () => {
    const db = oldDatabase();
    try {
      const before = db.prepare('SELECT * FROM neo_work').get() as Record<string, unknown>;
      runMigration284(db);
      runMigration284(db);
      const after = db.prepare('SELECT * FROM neo_work').get() as Record<string, unknown>;
      const { target_session_id: target, ...remaining } = after;
      expect(target).toBeNull();
      expect(remaining).toEqual(before);
      const columns = db.prepare('PRAGMA table_info(neo_work)').all() as {
        name: string;
        notnull: number;
      }[];
      expect(columns.filter((column) => column.name === 'target_session_id')).toEqual([
        expect.objectContaining({ name: 'target_session_id', notnull: 0 }),
      ]);
      const repo = new NeoRepository(db);
      expect(repo.getWorkTarget('old')).toEqual({ id: 'old', targetSessionId: null });
      expect(repo.getWorkTarget('missing')).toBeNull();
      expect(repo.getWork('old')).toMatchObject({
        originMessageId: 'old-ask',
        status: 'reported',
        report: 'Old report',
        createdAt: 1,
        updatedAt: 2,
      });
    } finally {
      db.close();
    }
  });
  test('does not create a missing Neo subsystem', () => {
    const db = new Database(':memory:');
    try {
      runMigration284(db);
      expect(db.prepare("SELECT name FROM sqlite_master WHERE name = 'neo_work'").get()).toBeNull();
    } finally {
      db.close();
    }
  });
  test.each(['fresh', 'upgraded'] as const)(
    'records an immutable exact target on %s databases',
    (kind) => {
      const db = kind === 'fresh' ? new Database(':memory:') : oldDatabase();
      try {
        if (kind === 'fresh') {
          createNeoTables(db);
          runMigration283(db);
        }
        runMigration284(db);
        const notify = mock(() => {});
        const repo = new NeoRepository(db, notify);
        const targetSessionId = "existing:manager/α|?x=1';SELECT 1";
        const original = repo.proposeWork({ ...proposal, targetSessionId });
        expect(original).toMatchObject({ ...proposal, status: 'proposed', sessionId: null });
        expect(original).not.toHaveProperty('targetSessionId');
        expect(repo.getWorkTarget(proposal.id)).toEqual({ id: proposal.id, targetSessionId });
        expect(
          repo.proposeWork({
            ...proposal,
            id: 'retry',
            originMessageId: 'ask-B',
            targetSessionId: 'different-session',
          })
        ).toEqual(original);
        expect(repo.getWorkTarget(proposal.id)?.targetSessionId).toBe(targetSessionId);
        expect(repo.getWorkTarget('retry')).toBeNull();
        expect(notify).toHaveBeenCalledTimes(1);
        const queued = repo.transitionWork(original.id, original, {
          status: 'queued',
          sessionId: 'executor',
        })!;
        expect(repo.transitionWork(original.id, original, { status: 'cancelled' })).toBeNull();
        const reported = repo.transitionWork(original.id, queued, {
          status: 'reported',
          report: 'Reported evidence',
        })!;
        expect(repo.findWorkBySession('executor')).toEqual(reported);
        expect(repo.getWorkTarget(reported.id)).toEqual({ id: proposal.id, targetSessionId });
        expect(reported.originMessageId).toBe('ask-A');
        expect(repo.listWork(null)).toEqual(expect.arrayContaining([reported]));
        expect(notify).toHaveBeenCalledTimes(3);
      } finally {
        db.close();
      }
    }
  );
  test.each([undefined, null])(
    'retains the default for absent/null targets: %j',
    (targetSessionId) => {
      const db = new Database(':memory:');
      try {
        createNeoTables(db);
        runMigration283(db);
        runMigration284(db);
        const repo = new NeoRepository(db);
        repo.proposeWork({ ...proposal, targetSessionId });
        expect(repo.getWorkTarget(proposal.id)).toEqual({ id: proposal.id, targetSessionId: null });
        expect(
          repo.proposeWork({ ...proposal, targetSessionId: 'later-target' })
        ).not.toHaveProperty('targetSessionId');
        expect(repo.getWorkTarget(proposal.id)?.targetSessionId).toBeNull();
      } finally {
        db.close();
      }
    }
  );
  test('target deletion does not erase provenance or block ordinary session deletion', () => {
    const db = new Database(':memory:');
    try {
      db.exec('PRAGMA foreign_keys = ON');
      createNeoTables(db);
      runMigration283(db);
      runMigration284(db);
      db.exec(
        "CREATE TABLE sessions(id TEXT PRIMARY KEY); INSERT INTO sessions VALUES ('existing')"
      );
      const repo = new NeoRepository(db);
      repo.proposeWork({ ...proposal, targetSessionId: 'existing' });
      expect(db.prepare("DELETE FROM sessions WHERE id = 'existing'").run().changes).toBe(1);
      expect(repo.getWorkTarget(proposal.id)).toEqual({
        id: proposal.id,
        targetSessionId: 'existing',
      });
      expect(repo.getWork(proposal.id)).toMatchObject({
        ...proposal,
        status: 'proposed',
        sessionId: null,
      });
      expect(db.prepare('PRAGMA foreign_key_list(neo_work)').all()).not.toEqual(
        expect.arrayContaining([expect.objectContaining({ from: 'target_session_id' })])
      );
    } finally {
      db.close();
    }
  });
  test('reopening and repeated migration retain the recorded target without changing the old DTO', () => {
    const directory = mkdtempSync(join(tmpdir(), 'neo-work-target-'));
    const path = join(directory, 'target.db');
    const first = new Database(path);
    try {
      createNeoTables(first);
      runMigration283(first);
      runMigration284(first);
      new NeoRepository(first).proposeWork({ ...proposal, targetSessionId: 'persisted-manager' });
    } finally {
      first.close();
    }
    const reopened = new Database(path);
    try {
      createNeoTables(reopened);
      runMigration283(reopened);
      runMigration284(reopened);
      const repo = new NeoRepository(reopened);
      expect(repo.getWorkTarget(proposal.id)).toEqual({
        id: proposal.id,
        targetSessionId: 'persisted-manager',
      });
      expect(repo.getWork(proposal.id)).toMatchObject({
        ...proposal,
        sessionId: null,
        status: 'proposed',
      });
      expect(repo.getWork(proposal.id)).not.toHaveProperty('targetSessionId');
    } finally {
      reopened.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
