import { beforeEach, describe, expect, test, vi } from 'vitest';

const SPACE_TABLES = [
  'spaces',
  'space_tasks',
  'space_goals',
  'space_workflows',
  'node_executions',
  'evolution_scopes',
  'direct_task_execution_attempts',
  'space_agent_memory',
  'space_agent_template_hides',
  'space_session_event_subscriptions',
];

async function freshSchema() {
  vi.resetModules();
  const { createTables, runMigrations } = await import('../../../../src/storage/schema/index.ts');
  const { Database } = await import('../../../../src/storage/sqlite-compat.ts');
  const { registerSchemaExtension } = await import('../../../../src/storage/schema/extensions.ts');
  const { SPACE_SCHEMA } = await import('../../../../src/storage/schema/space-schema.ts');
  const db = new Database(':memory:');
  return {
    db,
    migrate: () => {
      runMigrations(db, () => {});
      createTables(db);
    },
    turnSpaceOn: () => registerSchemaExtension(SPACE_SCHEMA),
    tables: () =>
      (
        db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as {
          name: string;
        }[]
      ).map((row) => row.name),
    marker: (key: string) => !!db.prepare('SELECT 1 FROM migration_markers WHERE key = ?').get(key),
    schema: () =>
      db
        .prepare(
          'SELECT type, name, sql FROM sqlite_master WHERE sql IS NOT NULL ORDER BY type, name'
        )
        .all(),
  };
}

describe('Space schema extension', () => {
  beforeEach(() => vi.resetModules());

  test('a fresh install with Space off creates no Space tables and writes no Space markers', async () => {
    const off = await freshSchema();
    off.migrate();
    expect(off.tables()).toContain('sessions');
    expect(off.tables().filter((table) => SPACE_TABLES.includes(table))).toEqual([]);
    for (const key of ['migration_239', 'migration_406', 'space_migration_420'])
      expect(off.marker(key)).toBe(false);
    expect(off.marker('schema_baseline_space')).toBe(false);
    expect(off.marker('migration_420')).toBe(true);
  });

  test('turning Space on later gives the same schema as a fresh install with Space on', async () => {
    const on = await freshSchema();
    on.turnSpaceOn();
    on.migrate();
    const expected = on.schema();

    const later = await freshSchema();
    later.migrate();
    later.turnSpaceOn();
    later.migrate();
    expect(later.schema()).toEqual(expected);
    expect(later.marker('migration_239')).toBe(true);
    expect(later.marker('schema_baseline_space')).toBe(true);
  });

  test('a database that already has Space keeps its tables and only records the baseline', async () => {
    const existing = await freshSchema();
    existing.turnSpaceOn();
    existing.migrate();
    existing.db.exec("DELETE FROM migration_markers WHERE key = 'schema_baseline_space'");
    existing.db.exec(
      `INSERT INTO spaces (id, slug, workspace_path, name, created_at, updated_at)
       VALUES ('kept', 'kept', '/tmp/kept', 'Kept', 1, 1)`
    );
    const before = existing.schema();
    existing.migrate();
    expect(existing.schema()).toEqual(before);
    expect(existing.marker('schema_baseline_space')).toBe(true);
    expect(existing.db.prepare("SELECT id FROM spaces WHERE id = 'kept'").get()).toEqual({
      id: 'kept',
    });
  });
});
