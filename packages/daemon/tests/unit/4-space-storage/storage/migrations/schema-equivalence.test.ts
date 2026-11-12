import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { Database } from '../../../../../src/storage/sqlite-compat.ts';
import {
  configureMessageSearchFts,
  createTables,
  runMigrations,
} from '../../../../../src/storage/schema/index.ts';
import { runMigration472 } from '../../../../../src/storage/schema/m472-drop-room-era-tables.ts';
import { runMigration473 } from '../../../../../src/storage/schema/m473-drop-inbox-items.ts';
import { createSpaceGitHubTables } from '../../../../../src/storage/schema/space-github.ts';
import { humanSessionColumnsPredicate } from '../../../../../src/storage/schema/session-counters.ts';
import spaceBaselineSchema from '../../../../../src/storage/schema/baseline-space-v041.json' with {
  type: 'json',
};
import baselineSchema from '../../../../../src/storage/schema/baseline-v041.json' with {
  type: 'json',
};

interface SchemaObject {
  type: string;
  name: string;
  tbl_name: string;
  sql: string | null;
}

function sqlTokens(sql: string): string[] {
  return (
    sql.match(
      /'(?:''|[^'])*'|"(?:""|[^"])*"|--[^\r\n]*|\/\*[\s\S]*?\*\/|[A-Za-z_][A-Za-z_0-9]*|[^\s]/g
    ) ?? []
  )
    .filter((token) => !token.startsWith('--') && !token.startsWith('/*'))
    .map((token) => (/^"[A-Za-z_][A-Za-z_0-9]*"$/.test(token) ? token.slice(1, -1) : token));
}

function fullSchema(db: Database): unknown {
  const objects = db
    .prepare(
      `SELECT type, name, tbl_name, sql FROM sqlite_schema WHERE name NOT LIKE 'sqlite_%' ORDER BY type, name`
    )
    .all() as SchemaObject[];
  return objects.map((object) => ({
    ...object,
    sql: object.sql === null ? null : sqlTokens(object.sql),
    columns:
      object.type === 'table'
        ? db.prepare('SELECT * FROM pragma_table_xinfo(?) ORDER BY cid').all(object.name)
        : [],
    foreignKeys:
      object.type === 'table'
        ? db.prepare('SELECT * FROM pragma_foreign_key_list(?) ORDER BY id, seq').all(object.name)
        : [],
    indexes:
      object.type === 'table'
        ? (
            db
              .prepare(
                'SELECT name, "unique", origin, partial FROM pragma_index_list(?) ORDER BY name'
              )
              .all(object.name) as { name: string }[]
          ).map((index) => ({
            ...index,
            columns: db
              .prepare('SELECT * FROM pragma_index_xinfo(?) ORDER BY seqno')
              .all(index.name),
          }))
        : [],
  }));
}

function migrate(db: Database): void {
  runMigrations(db, () => {});
  createTables(db);
  configureMessageSearchFts(db);
}

function insertSession(db: Database, id: string, type: string): void {
  db.prepare(
    `INSERT INTO sessions (id, title, created_at, last_active_at, status, config, metadata, type) VALUES (?, '', '', '', 'active', '{}', '{}', ?)`
  ).run(id, type);
}

describe('database schema equivalence', () => {
  test('the direct baseline is the frozen v0.41.0 schema, less migrations 472 and 473, before migration 239', () => {
    const fresh = new Database(':memory:');
    const baseline = new Database(':memory:');
    try {
      baseline.exec(
        readFileSync(new URL('./fixtures/schema-baseline/v0.41.0.sql', import.meta.url), 'utf8')
      );
      runMigration472(baseline);
      runMigration473(baseline);
      const shadows = new Set(
        (baseline.prepare('PRAGMA table_list').all() as { name: string; type: string }[])
          .filter(({ type }) => type === 'shadow')
          .map(({ name }) => name)
      );
      const statements = (
        baseline
          .prepare(
            `SELECT tbl_name, sql FROM sqlite_schema
             WHERE sql IS NOT NULL AND name NOT LIKE 'sqlite_%' AND name != 'migration_markers'
             ORDER BY type = 'trigger', type = 'index', rowid`
          )
          .all() as { tbl_name: string; sql: string }[]
      )
        .filter(({ tbl_name }) => !shadows.has(tbl_name))
        .filter(({ tbl_name }) => !tbl_name.startsWith('space_github'))
        .map(({ sql }) => sql);
      expect([...baselineSchema, ...spaceBaselineSchema].sort()).toEqual([...statements].sort());
      fresh.exec('PRAGMA foreign_keys = ON');
      let backups = 0;
      runMigrations(fresh, () => {
        backups++;
        expect(fullSchema(fresh)).toEqual(fullSchema(baseline));
        expect(
          fresh.prepare("SELECT key FROM migration_markers WHERE key = 'migration_238'").get()
        ).toEqual({ key: 'migration_238' });
        expect(
          fresh.prepare("SELECT key FROM migration_markers WHERE key = 'migration_239'").get()
        ).toBeNull();
        expect(
          fresh
            .prepare(
              'SELECT source, globally_enabled, capabilities_json FROM external_event_extension_configs'
            )
            .get()
        ).toEqual({
          source: 'github',
          globally_enabled: 1,
          capabilities_json: '{"webhooks":true,"polling":false,"rpcConfig":true}',
        });
      });
      expect(backups).toBe(1);
      runMigrations(fresh, () => {
        throw new Error('An initialized database must not create another backup');
      });
    } finally {
      fresh.close();
      baseline.close();
    }
  });

  test('fresh, legacy dev and upgraded v0.41.0 databases have identical full schemas', () => {
    const fresh = new Database(':memory:');
    const upgraded = new Database(':memory:');
    const legacyDev = new Database(':memory:');
    try {
      legacyDev.exec(
        readFileSync(new URL('./fixtures/schema-baseline/dev-383.sql', import.meta.url), 'utf8')
      );
      migrate(legacyDev);
      const legacySchema = fullSchema(legacyDev);
      fresh.exec('PRAGMA foreign_keys = ON');
      upgraded.exec('PRAGMA foreign_keys = ON');
      upgraded.exec(
        readFileSync(new URL('./fixtures/schema-baseline/v0.41.0.sql', import.meta.url), 'utf8')
      );
      migrate(fresh);
      migrate(upgraded);
      expect(fullSchema(fresh)).toEqual(legacySchema);
      expect(fullSchema(upgraded)).toEqual(legacySchema);
      migrate(fresh);
      migrate(upgraded);
      expect(fullSchema(fresh)).toEqual(legacySchema);
      expect(fullSchema(upgraded)).toEqual(legacySchema);
    } finally {
      fresh.close();
      upgraded.close();
      legacyDev.close();
    }
  });

  test('full schema comparison detects constraint, column, index and trigger differences', () => {
    const db = new Database(':memory:');
    try {
      migrate(db);
      db.exec(
        "CREATE TABLE parity_probe (id INTEGER PRIMARY KEY, value TEXT CHECK (value != 'forbidden'))"
      );
      let before = fullSchema(db);
      db.exec(
        "DROP TABLE parity_probe; CREATE TABLE parity_probe (id INTEGER PRIMARY KEY, value TEXT CHECK (value != 'different'))"
      );
      expect(fullSchema(db)).not.toEqual(before);
      before = fullSchema(db);
      db.exec(
        'ALTER TABLE parity_probe ADD COLUMN hidden TEXT GENERATED ALWAYS AS (value) VIRTUAL'
      );
      expect(fullSchema(db)).not.toEqual(before);
      before = fullSchema(db);
      db.exec('CREATE INDEX parity_probe_index ON parity_probe(value) WHERE value IS NOT NULL');
      expect(fullSchema(db)).not.toEqual(before);
      before = fullSchema(db);
      db.exec(
        "CREATE TRIGGER parity_probe_trigger AFTER INSERT ON parity_probe BEGIN UPDATE parity_probe SET value = 'changed' WHERE id = new.id; END"
      );
      expect(fullSchema(db)).not.toEqual(before);
      before = fullSchema(db);
      db.exec(
        "DROP TRIGGER parity_probe_trigger; CREATE TRIGGER parity_probe_trigger AFTER INSERT ON parity_probe BEGIN UPDATE parity_probe SET value = 'different' WHERE id = new.id; END"
      );
      expect(fullSchema(db)).not.toEqual(before);
    } finally {
      db.close();
    }
  });

  test('fresh space github creation keeps the column order stored on existing databases', () => {
    const fresh = new Database(':memory:');
    const stored = new Database(':memory:');
    try {
      stored.exec(
        readFileSync(new URL('./fixtures/schema-baseline/v0.41.0.sql', import.meta.url), 'utf8')
      );
      createSpaceGitHubTables(fresh);
      const columns = (db: Database, table: string) =>
        (db.prepare('SELECT name FROM pragma_table_info(?)').all(table) as { name: string }[]).map(
          (row) => row.name
        );
      expect(columns(fresh, 'space_github_watched_repos')).toEqual(
        columns(stored, 'space_github_watched_repos')
      );
      expect(columns(fresh, 'space_github_events')).toEqual(columns(stored, 'space_github_events'));
    } finally {
      fresh.close();
      stored.close();
    }
  });

  test('schema init promotes a stored zero polling intent for spaces with polling watches', () => {
    const db = new Database(':memory:');
    try {
      db.exec(`CREATE TABLE spaces (id TEXT PRIMARY KEY)`);
      db.exec(`INSERT INTO spaces (id) VALUES ('space-a')`);
      createSpaceGitHubTables(db);
      db.prepare(
        `INSERT INTO space_github_watched_repos
           (id, space_id, owner, repo, enabled, webhook_enabled, polling_enabled, created_at, updated_at)
         VALUES ('w1', 'space-a', 'O', 'R', 1, 0, 1, 1, 1)`
      ).run();
      db.prepare(
        `INSERT INTO space_github_source_settings
           (space_id, enabled, polling_intent, created_at, updated_at)
         VALUES ('space-a', 1, 0, 5, 5)`
      ).run();
      createSpaceGitHubTables(db);
      expect(
        db
          .prepare(
            `SELECT polling_intent FROM space_github_source_settings WHERE space_id = 'space-a'`
          )
          .get()
      ).toEqual({ polling_intent: 1 });
    } finally {
      db.close();
    }
  });

  test('fresh session counters preserve the legacy task-agent exclusion through mutations', () => {
    const db = new Database(':memory:');
    try {
      migrate(db);
      insertSession(db, 'human', 'worker');
      insertSession(db, 'agent', 'space_task_agent');
      const counters = () =>
        db.prepare('SELECT total_count, archived_count FROM session_counters WHERE id = 1').get();
      expect(counters()).toEqual({ total_count: 1, archived_count: 0 });
      expect(
        db
          .prepare(`SELECT id FROM sessions WHERE ${humanSessionColumnsPredicate('')} ORDER BY id`)
          .all()
      ).toEqual([{ id: 'human' }]);
      db.exec("UPDATE sessions SET status = 'archived' WHERE id = 'agent'");
      expect(counters()).toEqual({ total_count: 1, archived_count: 0 });
      db.exec("UPDATE sessions SET type = 'worker' WHERE id = 'agent'");
      expect(counters()).toEqual({ total_count: 2, archived_count: 1 });
      db.exec("UPDATE sessions SET type = 'space_task_agent' WHERE id = 'agent'");
      expect(counters()).toEqual({ total_count: 1, archived_count: 0 });
      db.exec("DELETE FROM sessions WHERE id = 'agent'");
      expect(counters()).toEqual({ total_count: 1, archived_count: 0 });
    } finally {
      db.close();
    }
  });
});
