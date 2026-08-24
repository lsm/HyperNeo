import { describe, expect, test } from 'bun:test';
import { Database as BunDatabase } from '../../../../src/storage/sqlite-compat';
import { runMigration213 } from '../../../../src/storage/schema/m213-inactivity-watchdog';
import { createTables } from '../../../../src/storage/schema';

function createMinimalDb(): BunDatabase {
  const db = new BunDatabase(':memory:');
  db.exec(`
    CREATE TABLE spaces (
      id TEXT PRIMARY KEY,
      slug TEXT NOT NULL,
      workspace_path TEXT NOT NULL,
      name TEXT NOT NULL,
      description TEXT NOT NULL DEFAULT '',
      background_context TEXT NOT NULL DEFAULT '',
      instructions TEXT NOT NULL DEFAULT '',
      status TEXT NOT NULL DEFAULT 'active',
      autonomy_level INTEGER NOT NULL DEFAULT 1,
      max_concurrent_tasks INTEGER NOT NULL DEFAULT 1,
      paused INTEGER NOT NULL DEFAULT 0,
      stopped INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    )
  `);
  db.exec(`INSERT INTO spaces (id, slug, workspace_path, name, created_at, updated_at)
           VALUES ('space-1', 's', '/w', 'S', 1, 1)`);
  return db;
}

describe('migration 213 — inactivity watchdog tables', () => {
  test('creates config and claim tables with constraints', () => {
    const db = createMinimalDb();
    runMigration213(db);

    db.exec(`INSERT INTO space_agent_inactivity_config
             (id, space_id, agent_id, enabled, threshold_ms, prompt, config_revision, created_at, updated_at)
             VALUES ('c1', 'space-1', 'agent-1', 1, 5000, NULL, 1, 1, 1)`);
    expect(() =>
      db.exec(`INSERT INTO space_agent_inactivity_config
               (id, space_id, agent_id, enabled, config_revision, created_at, updated_at)
               VALUES ('c2', 'space-1', 'agent-1', 0, 1, 1, 1)`)
    ).toThrow();

    db.exec(`INSERT INTO space_agent_inactivity_claims
             (id, space_id, agent_id, claim_key, state, window_anchored_at, attempt_generation,
              owner_token, config_revision, degraded, created_at, updated_at)
             VALUES ('k1', 'space-1', 'agent-1', 'key', 'accepted', 100, 0, 't', 1, 0, 1, 1)`);
    expect(() =>
      db.exec(`UPDATE space_agent_inactivity_claims SET state = 'bogus' WHERE id = 'k1'`)
    ).toThrow();
    expect(() =>
      db.exec(`INSERT INTO space_agent_inactivity_claims
               (id, space_id, agent_id, claim_key, state, window_anchored_at, attempt_generation,
                owner_token, config_revision, degraded, created_at, updated_at)
               VALUES ('k2', 'space-1', 'agent-1', 'key2', 'accepted', 100, 0, 't', 1, 0, 1, 1)`)
    ).toThrow();

    db.close();
  });

  test('is idempotent', () => {
    const db = createMinimalDb();
    runMigration213(db);
    runMigration213(db);
    const row = db
      .prepare(
        `SELECT COUNT(*) AS n FROM sqlite_master WHERE type = 'table' AND name LIKE 'space_agent_inactivity%'`
      )
      .get() as { n: number };
    expect(row.n).toBe(2);
    db.close();
  });

  test('tables already exist in the canonical schema', () => {
    const db = new BunDatabase(':memory:');
    createTables(db);
    const row = db
      .prepare(
        `SELECT COUNT(*) AS n FROM sqlite_master WHERE type = 'table' AND name LIKE 'space_agent_inactivity%'`
      )
      .get() as { n: number };
    expect(row.n).toBe(2);
    db.close();
  });
});
