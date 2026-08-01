import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { Database as BunDatabase } from 'bun:sqlite';
import { runMigration164 } from '../../../../../src/storage/schema/migrations';
import { AgentMemoryRepository } from '../../../../../src/storage/repositories/agent-memory-repository';

/**
 * Recreate the pre-163 shape of the agent-memory tables: a single shared pool
 * keyed by UNIQUE(space_id, key) with no owner/scope columns, plus the FTS
 * surface and the FK-referencing core-memory and vectors tables.
 */
function seedLegacySchema(db: BunDatabase): void {
  db.exec(`
    CREATE TABLE spaces (
      id TEXT PRIMARY KEY,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    )
  `);
  db.exec(`
    CREATE TABLE space_agent_memory (
      id INTEGER PRIMARY KEY,
      key TEXT NOT NULL,
      space_id TEXT NOT NULL,
      content TEXT NOT NULL,
      tags TEXT NOT NULL DEFAULT '',
      created_by_session TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      access_count INTEGER NOT NULL DEFAULT 0,
      last_accessed_at INTEGER,
      embedding_status TEXT NOT NULL DEFAULT 'pending'
        CHECK(embedding_status IN ('pending', 'ready', 'failed')),
      embedding_model TEXT,
      embedding_updated_at INTEGER,
      embedding_error TEXT,
      embedding_revision INTEGER NOT NULL DEFAULT 0,
      embedding_token TEXT NOT NULL DEFAULT '',
      UNIQUE(space_id, key),
      FOREIGN KEY (space_id) REFERENCES spaces(id) ON DELETE CASCADE
    )
  `);
  db.exec(`
    CREATE VIRTUAL TABLE space_agent_memory_fts USING fts5(
      key, content, tags,
      content='space_agent_memory', content_rowid='id', tokenize='trigram'
    )
  `);
  db.exec(`
    CREATE TRIGGER space_agent_memory_ai AFTER INSERT ON space_agent_memory BEGIN
      INSERT INTO space_agent_memory_fts(rowid, key, content, tags)
      VALUES (new.id, new.key, new.content, new.tags);
    END
  `);
  db.exec(`
    CREATE TABLE memory_vectors (
      memory_id INTEGER PRIMARY KEY,
      embedding BLOB NOT NULL,
      dimensions INTEGER NOT NULL,
      model TEXT NOT NULL,
      updated_at INTEGER NOT NULL,
      FOREIGN KEY (memory_id) REFERENCES space_agent_memory(id) ON DELETE CASCADE
    )
  `);
  db.exec(`
    CREATE TABLE space_agent_core_memory (
      space_id TEXT NOT NULL,
      memory_id INTEGER NOT NULL,
      score REAL NOT NULL,
      rank INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      PRIMARY KEY (space_id, memory_id),
      FOREIGN KEY (memory_id) REFERENCES space_agent_memory(id) ON DELETE CASCADE
    )
  `);
}

describe('Migration 164: per-agent memory namespacing', () => {
  let db: BunDatabase;

  beforeEach(() => {
    db = new BunDatabase(':memory:');
    db.exec('PRAGMA foreign_keys = ON');
    seedLegacySchema(db);
    db.prepare(`INSERT INTO spaces (id, created_at, updated_at) VALUES ('space-1', 1, 1)`).run();
  });

  afterEach(() => {
    db.close();
  });

  function seedMemoryRow(id: number, key: string, content: string): void {
    db.prepare(
      `INSERT INTO space_agent_memory
        (id, key, space_id, content, tags, created_by_session, created_at, updated_at,
         access_count, last_accessed_at, embedding_status, embedding_revision, embedding_token)
       VALUES (?, ?, 'space-1', ?, '[]', NULL, 1, 1, 0, NULL, 'pending', 1, ?)`
    ).run(id, key, content, `token-${id}`);
  }

  test('adds owner_agent_id and scope columns and preserves every existing key', () => {
    seedMemoryRow(1, 'conventions.forms', 'Use zod schemas.');
    seedMemoryRow(2, 'release.process', 'Tag from dev.');

    runMigration164(db);

    // Both columns exist.
    const cols = db
      .prepare(`SELECT name FROM pragma_table_info('space_agent_memory')`)
      .all()
      .map((r) => (r as { name: string }).name);
    expect(cols).toContain('owner_agent_id');
    expect(cols).toContain('scope');

    // Every key is preserved and backfilled to space-scoped (shared, unowned).
    const rows = db
      .prepare(`SELECT key, owner_agent_id, scope FROM space_agent_memory ORDER BY key`)
      .all() as Array<{ key: string; owner_agent_id: string; scope: string }>;
    expect(rows).toEqual([
      { key: 'conventions.forms', owner_agent_id: '', scope: 'space' },
      { key: 'release.process', owner_agent_id: '', scope: 'space' },
    ]);
  });

  test('widens the unique key so two agents can hold the same key', () => {
    seedMemoryRow(1, 'shared', 'Original shared.');

    runMigration164(db);

    const repo = new AgentMemoryRepository(db);
    repo.write({ spaceId: 'space-1', key: 'shared', content: 'Agent A.', ownerAgentId: 'agent-a' });
    repo.write({ spaceId: 'space-1', key: 'shared', content: 'Agent B.', ownerAgentId: 'agent-b' });

    const owners = db
      .prepare(
        `SELECT owner_agent_id FROM space_agent_memory WHERE key = 'shared' ORDER BY owner_agent_id`
      )
      .all() as Array<{ owner_agent_id: string }>;
    // Backfilled '' row + agent-a + agent-b all coexist under one key.
    expect(owners.map((r) => r.owner_agent_id)).toEqual(['', 'agent-a', 'agent-b']);
  });

  test('keeps space_agent_core_memory FK valid after the rebuild', () => {
    seedMemoryRow(1, 'core.fact', 'Important shared fact.');
    runMigration164(db);

    // The referencing table still resolves its FK to the rebuilt table — insert
    // and delete must succeed without "no such table" errors.
    db.prepare(
      `INSERT INTO space_agent_core_memory (space_id, memory_id, score, rank, updated_at)
       VALUES ('space-1', 1, 1.0, 1, 1)`
    ).run();
    expect(
      db.prepare(`SELECT memory_id FROM space_agent_core_memory`).get() as { memory_id: number }
    ).toEqual({ memory_id: 1 });
    // Cascade-on-delete path: dropping the memory row removes the core row.
    db.prepare(`DELETE FROM space_agent_memory WHERE id = 1`).run();
    expect(
      db.prepare(`SELECT count(*) AS c FROM space_agent_core_memory`).get() as { c: number }
    ).toEqual({ c: 0 });
  });

  test('keeps memory_vectors FK valid after the rebuild', () => {
    seedMemoryRow(1, 'vec.fact', 'Embedded fact.');
    runMigration164(db);

    db.prepare(
      `INSERT INTO memory_vectors (memory_id, embedding, dimensions, model, updated_at)
       VALUES (1, x'00', 1, 'm', 1)`
    ).run();
    // FK cascade still wired to the rebuilt parent.
    db.prepare(`DELETE FROM space_agent_memory WHERE id = 1`).run();
    expect(db.prepare(`SELECT count(*) AS c FROM memory_vectors`).get() as { c: number }).toEqual({
      c: 0,
    });
  });

  test('rebuilds the FTS index so legacy memories stay searchable', async () => {
    seedMemoryRow(1, 'searchable.fact', 'Trigram searchable content.');
    runMigration164(db);

    const repo = new AgentMemoryRepository(db);
    const results = await repo.search('space-1', 'searchable content', 5);
    expect(results.map((r) => r.memory.key)).toEqual(['searchable.fact']);
  });

  test('is idempotent — running twice is a no-op', () => {
    seedMemoryRow(1, 'once', 'Survives a second pass.');
    runMigration164(db);
    // Second run must not error or duplicate rows.
    runMigration164(db);

    const rows = db
      .prepare(`SELECT key, scope, owner_agent_id FROM space_agent_memory`)
      .all() as Array<{ key: string; scope: string; owner_agent_id: string }>;
    expect(rows).toHaveLength(1);
    expect(rows[0]).toEqual({ key: 'once', scope: 'space', owner_agent_id: '' });
  });
});
