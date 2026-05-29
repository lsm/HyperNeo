import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { Database as BunDatabase } from 'bun:sqlite';
import { runMigration148 } from '../../../../../src/storage/schema/index.ts';

describe('Migration 148: Space agent handles', () => {
  let db: BunDatabase;

  beforeEach(() => {
    db = new BunDatabase(':memory:');
    db.exec(`
      CREATE TABLE space_agents (
        id TEXT PRIMARY KEY,
        space_id TEXT NOT NULL,
        name TEXT NOT NULL,
        created_at INTEGER NOT NULL
      );
    `);
  });

  afterEach(() => {
    db.close();
  });

  test('backfills handles without claiming reserved system actor handles', () => {
    db.prepare(`INSERT INTO space_agents (id, space_id, name, created_at) VALUES (?, ?, ?, ?)`).run(
      'agent-1',
      'space-1',
      'Coordinator',
      1
    );
    db.prepare(`INSERT INTO space_agents (id, space_id, name, created_at) VALUES (?, ?, ?, ?)`).run(
      'agent-2',
      'space-1',
      'System Runtime',
      2
    );

    runMigration148(db);

    const rows = db.prepare(`SELECT id, handle FROM space_agents ORDER BY id`).all() as Array<{
      id: string;
      handle: string;
    }>;

    expect(rows).toEqual([
      { id: 'agent-1', handle: 'coordinator-2' },
      { id: 'agent-2', handle: 'system-runtime-2' },
    ]);
  });
});
