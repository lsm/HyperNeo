import { readFileSync, readdirSync } from 'node:fs';
import { expect, test } from 'bun:test';
import { createTables, runMigrations } from '../../../../../src/storage/schema/index.ts';
import { runMigration537 } from '../../../../../src/storage/schema/m537-neo-todo-plan.ts';
import { Database } from '../../../../../src/storage/sqlite-compat.ts';

const schema = new URL('../../../../../src/storage/schema/', import.meta.url);

test('numbered migration files and registrations are unique', () => {
  const files = readdirSync(schema).flatMap((file) => /^m(\d+)-.*\.ts$/.exec(file)?.[1] ?? []);
  expect(files.filter((number, index) => files.indexOf(number) !== index)).toEqual([]);

  const source = readFileSync(new URL('migrations.ts', schema), 'utf8');
  const registrations = [
    ...Array.from(source.matchAll(/\b(?:run|rewrite)\(migrationMarkerKey\((\d+)\)/g), (m) => m[1]),
    ...Array.from(source.matchAll(/\bspace\((?:run|rewrite), (\d+)\)/g), (m) => m[1]),
  ];
  expect(registrations.filter((number, index) => registrations.indexOf(number) !== index)).toEqual(
    []
  );
});

function initialize(db: Database) {
  runMigrations(db, () => {});
  createTables(db);
}

function columns(db: Database, table: string) {
  return (db.prepare('SELECT name FROM pragma_table_info(?)').all(table) as { name: string }[]).map(
    ({ name }) => name
  );
}

function markers(db: Database) {
  return db
    .prepare(
      "SELECT key, applied_at FROM migration_markers WHERE key IN ('migration_537', 'migration_538') ORDER BY key"
    )
    .all() as { key: string; applied_at: number }[];
}

test('fresh database has both schemas and migration markers', () => {
  const db = new Database(':memory:');
  try {
    initialize(db);
    expect(columns(db, 'neo_todos')).toEqual(expect.arrayContaining(['plan', 'plan_check_json']));
    expect(columns(db, 'app_mcp_servers')).toContain('auth');
    expect(markers(db).map(({ key }) => key)).toEqual(['migration_537', 'migration_538']);
  } finally {
    db.close();
  }
});

for (const previous of ['pre-537', 'todo plan only', 'OAuth only'] as const) {
  test(`upgrades a ${previous} database and keeps existing data on repeat startup`, () => {
    const db = new Database(':memory:');
    try {
      initialize(db);
      db.exec("DELETE FROM migration_markers WHERE key IN ('migration_537', 'migration_538')");
      for (const column of ['plan', 'plan_check_json']) {
        if (columns(db, 'neo_todos').includes(column))
          db.exec(`ALTER TABLE neo_todos DROP COLUMN ${column}`);
      }
      db.exec(`INSERT INTO neo_asks (id, session_id, title, request, created_at, updated_at)
        VALUES ('ask', 'session', 'Ask', 'Request', 1, 1);
        INSERT INTO neo_todos (id, ask_id, position, title, done_when, created_at, updated_at)
        VALUES ('todo', 'ask', 0, 'Todo', 'Complete', 1, 1);
        INSERT INTO app_mcp_servers (id, name, source_type) VALUES ('mcp', 'Registry', 'http');`);
      if (previous === 'OAuth only') {
        db.exec(`UPDATE app_mcp_servers SET auth = '{"kind":"oauth"}' WHERE id = 'mcp'`);
      } else {
        db.exec('ALTER TABLE app_mcp_servers DROP COLUMN auth');
      }
      if (previous === 'todo plan only') {
        runMigration537(db);
        db.exec(
          `UPDATE neo_todos SET plan = 1, plan_check_json = '{"saved":true}' WHERE id = 'todo'`
        );
      }
      if (previous !== 'pre-537')
        db.exec("INSERT INTO migration_markers VALUES ('migration_537', 1)");

      initialize(db);
      const applied = markers(db);
      expect(applied.map(({ key }) => key)).toEqual(['migration_537', 'migration_538']);
      initialize(db);
      expect(markers(db)).toEqual(applied);
      expect(
        db.prepare("SELECT plan, plan_check_json FROM neo_todos WHERE id = 'todo'").get()
      ).toEqual(
        previous === 'todo plan only'
          ? { plan: 1, plan_check_json: '{"saved":true}' }
          : { plan: 0, plan_check_json: '{"legacy":true}' }
      );
      expect(db.prepare("SELECT name, auth FROM app_mcp_servers WHERE id = 'mcp'").get()).toEqual({
        name: 'Registry',
        auth: previous === 'OAuth only' ? '{"kind":"oauth"}' : null,
      });
    } finally {
      db.close();
    }
  });
}
