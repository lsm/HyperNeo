import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Session } from '@hyperneo/shared';
import { Database } from '../../../../src/storage/sqlite-compat.ts';
import { Database as DaemonDatabase } from '../../../../src/storage/database.ts';
import { createTables } from '../../../../src/storage/schema/index.ts';
import { runMigration290 } from '../../../../src/storage/schema/m290-session-incarnations.ts';
import { SessionRepository } from '../../../../src/storage/repositories/session-repository.ts';
import {
  getAccessibleTableNames,
  getExcludedTableNames,
} from '../../../../src/lib/db-query/scope-config.ts';

function session(id = 'fictional-session'): Session {
  return {
    id,
    title: 'Fictional session',
    workspacePath: '/fictional/workspace',
    createdAt: '2026-01-01T00:00:00.000Z',
    lastActiveAt: '2026-01-01T00:00:00.000Z',
    status: 'active',
    config: { model: 'fictional-model', maxTokens: 4096, temperature: 0.7 },
    metadata: {
      messageCount: 0,
      totalTokens: 0,
      inputTokens: 0,
      outputTokens: 0,
      totalCost: 0,
      toolCallCount: 0,
    },
  };
}

describe('SessionRepository session incarnation evidence', () => {
  let db: Database;
  let repo: SessionRepository;
  beforeEach(() => {
    db = new Database(':memory:');
    createTables(db);
    repo = new SessionRepository(db);
  });
  afterEach(() => db.close());

  test('assigns distinct synchronous insertion identities without changing public Session values', () => {
    repo.createSession(session());
    repo.createSession(session('second'));
    const first = repo.getSessionIncarnation('fictional-session');
    expect(Number.isSafeInteger(first)).toBe(true);
    expect(first).toBeGreaterThan(0);
    expect(repo.getSessionIncarnation('second')).toBeGreaterThan(first!);
    expect(first).not.toBeInstanceOf(Promise);
    expect(repo.getSession('fictional-session')).not.toHaveProperty('incarnation');
    expect(repo.getSessionIncarnation('missing')).toBeNull();
  });

  test('retains identity through native settings, metadata, status and timestamp updates', () => {
    repo.createSession(session());
    const first = repo.getSessionIncarnation('fictional-session');
    repo.updateSession('fictional-session', {
      config: { temperature: 0.9 },
      metadata: { messageCount: 4 },
      status: 'paused',
      sdkSessionId: 'fictional-sdk',
    });
    expect(repo.getSessionIncarnation('fictional-session')).toBe(first);
    expect(repo.getSession('fictional-session')).toMatchObject({
      status: 'paused',
      config: { temperature: 0.9 },
      metadata: { messageCount: 4 },
      sdkSessionId: 'fictional-sdk',
    });
    db.prepare('UPDATE sessions SET id = id WHERE id = ?').run('fictional-session');
    expect(repo.getSessionIncarnation('fictional-session')).toBe(first);
  });

  test('distinguishes delete-recreate ABA even when every session row byte and timestamp is identical', () => {
    repo.createSession(session());
    const first = repo.getSessionIncarnation('fictional-session');
    const original = db.prepare('SELECT * FROM sessions WHERE id = ?').get('fictional-session');
    db.prepare('DELETE FROM sessions WHERE id = ?').run('fictional-session');
    expect(repo.getSessionIncarnation('fictional-session')).toBeNull();
    expect(db.prepare('SELECT * FROM session_incarnations').all()).toEqual([]);
    repo.createSession(session());
    expect(db.prepare('SELECT * FROM sessions WHERE id = ?').get('fictional-session')).toEqual(
      original
    );
    expect(repo.getSessionIncarnation('fictional-session')).toBeGreaterThan(first!);
  });

  test('gives replacement and reassigned IDs new identities, including without recursive triggers', () => {
    repo.createSession(session());
    const first = repo.getSessionIncarnation('fictional-session');
    db.exec('PRAGMA recursive_triggers = OFF');
    db.exec(`INSERT OR REPLACE INTO sessions(id, title, created_at, last_active_at, status, config, metadata)
      SELECT id, title, created_at, last_active_at, status, config, metadata FROM sessions`);
    const replaced = repo.getSessionIncarnation('fictional-session');
    expect(replaced).toBeGreaterThan(first!);
    db.prepare('UPDATE sessions SET id = ? WHERE id = ?').run('renamed', 'fictional-session');
    expect(repo.getSessionIncarnation('fictional-session')).toBeNull();
    expect(repo.getSessionIncarnation('renamed')).toBeGreaterThan(replaced!);
    expect(db.prepare('SELECT session_id FROM session_incarnations').all()).toEqual([
      { session_id: 'renamed' },
    ]);
  });

  test('duplicate insertion refusal leaves original identity intact', () => {
    repo.createSession(session());
    const first = repo.getSessionIncarnation('fictional-session');
    expect(() => repo.createSession(session())).toThrow();
    expect(repo.getSessionIncarnation('fictional-session')).toBe(first);
  });

  test('rolls back the insertion identity with the owning session transaction', () => {
    repo.createSession(session());
    const first = repo.getSessionIncarnation('fictional-session');
    expect(() =>
      db.transaction(() => {
        db.prepare('DELETE FROM sessions WHERE id = ?').run('fictional-session');
        repo.createSession(session());
        expect(repo.getSessionIncarnation('fictional-session')).not.toBe(first);
        throw new Error('rollback');
      })()
    ).toThrow('rollback');
    expect(repo.getSessionIncarnation('fictional-session')).toBe(first);
  });

  test('faults on missing infrastructure or corrupt identity rather than returning invented evidence', () => {
    repo.createSession(session());
    db.prepare('DELETE FROM session_incarnations WHERE session_id = ?').run('fictional-session');
    expect(() => repo.getSessionIncarnation('fictional-session')).toThrow(
      'Invalid session incarnation'
    );
    db.prepare('INSERT INTO session_incarnations(incarnation, session_id) VALUES (?, ?)').run(
      -1,
      'fictional-session'
    );
    expect(() => repo.getSessionIncarnation('fictional-session')).toThrow(
      'Invalid session incarnation'
    );
    db.prepare('UPDATE session_incarnations SET incarnation = ? WHERE session_id = ?').run(
      9007199254740992,
      'fictional-session'
    );
    expect(() => repo.getSessionIncarnation('fictional-session')).toThrow(
      'Value is too large to be represented as a JavaScript number'
    );
    db.exec('DROP TABLE session_incarnations');
    expect(() => repo.getSessionIncarnation('fictional-session')).toThrow();
  });

  test('keeps insertion identity private in every generic SQL scope', () => {
    expect(getExcludedTableNames()).toContain('session_incarnations');
    for (const scope of ['global', 'room', 'space'] as const)
      expect(getAccessibleTableNames(scope)).not.toContain('session_incarnations');
  });
});

describe('session incarnation migration and durable storage', () => {
  test('backfills legacy rows once and then covers raw inserts without altering session bytes', () => {
    const db = new Database(':memory:');
    try {
      db.exec(
        "CREATE TABLE sessions(id TEXT PRIMARY KEY, created_at TEXT); INSERT INTO sessions VALUES ('old', 'same')"
      );
      const original = db.prepare('SELECT * FROM sessions').all();
      runMigration290(db);
      const identities = db.prepare('SELECT * FROM session_incarnations').all();
      const sequence = db
        .prepare("SELECT seq FROM sqlite_sequence WHERE name = 'session_incarnations'")
        .get();
      runMigration290(db);
      expect(db.prepare('SELECT * FROM session_incarnations').all()).toEqual(identities);
      expect(
        db.prepare("SELECT seq FROM sqlite_sequence WHERE name = 'session_incarnations'").get()
      ).toEqual(sequence);
      expect(db.prepare('SELECT * FROM sessions').all()).toEqual(original);
      db.exec("INSERT INTO sessions VALUES ('new', 'same')");
      expect(
        db.prepare('SELECT session_id FROM session_incarnations ORDER BY incarnation').all()
      ).toEqual([{ session_id: 'old' }, { session_id: 'new' }]);
    } finally {
      db.close();
    }
  });

  test('ignores a database without sessions instead of creating disconnected evidence', () => {
    const db = new Database(':memory:');
    try {
      runMigration290(db);
      expect(
        db.prepare("SELECT name FROM sqlite_master WHERE name = 'session_incarnations'").get()
      ).toBeNull();
    } finally {
      db.close();
    }
  });

  test('survives actual daemon migration and durable reopen without reusing deleted identities', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'fictional-session-incarnations-'));
    const path = join(directory, 'daemon.db');
    let daemon: DaemonDatabase | undefined;
    try {
      daemon = new DaemonDatabase(path, { messageSearchIndexFlushIntervalMs: 0 });
      await daemon.initialize();
      daemon.createSession(session());
      const first = daemon.getSessionIncarnation('fictional-session');
      expect(first).toBeGreaterThan(0);
      daemon.close();
      daemon = new DaemonDatabase(path, { messageSearchIndexFlushIntervalMs: 0 });
      await daemon.initialize();
      expect(daemon.getSessionIncarnation('fictional-session')).toBe(first);
      daemon.getDatabase().prepare('DELETE FROM sessions WHERE id = ?').run('fictional-session');
      daemon.createSession(session());
      expect(daemon.getSessionIncarnation('fictional-session')).toBeGreaterThan(first!);
    } finally {
      daemon?.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
