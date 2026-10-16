import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { Database } from '../../../../../src/storage/sqlite-compat.ts';
import {
  configureMessageSearchFts,
  createTables,
  runMigrations,
} from '../../../../../src/storage/schema/index.ts';
import { humanSessionColumnsPredicate } from '../../../../../src/storage/schema/session-counters.ts';

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
  test('fresh and upgraded v0.41.0 databases have identical full schemas', () => {
    const fresh = new Database(':memory:');
    const upgraded = new Database(':memory:');
    try {
      fresh.exec('PRAGMA foreign_keys = ON');
      upgraded.exec('PRAGMA foreign_keys = ON');
      upgraded.exec(
        readFileSync(new URL('./fixtures/schema-baseline/v0.41.0.sql', import.meta.url), 'utf8')
      );
      migrate(fresh);
      migrate(upgraded);
      expect(fullSchema(fresh)).toEqual(fullSchema(upgraded));
      migrate(fresh);
      migrate(upgraded);
      expect(fullSchema(fresh)).toEqual(fullSchema(upgraded));
    } finally {
      fresh.close();
      upgraded.close();
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
