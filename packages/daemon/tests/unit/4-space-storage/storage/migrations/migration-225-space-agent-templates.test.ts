import { describe, expect, test } from 'bun:test';
import { runMigration225 } from '../../../../../src/storage/schema/m225-space-agent-templates.ts';
import { Database as BunDatabase } from '../../../../../src/storage/sqlite-compat.ts';

interface ColumnRow {
  name: string;
}

const TEMPLATE_COLUMNS = [
  'key',
  'handle',
  'display_name',
  'description',
  'instructions',
  'suggested_autonomy_level',
  'model',
  'provider',
  'model_pool',
  'thinking_level',
  'setting_sources',
  'tools',
  'created_at',
  'updated_at',
];

function tableExists(db: BunDatabase, tableName: string): boolean {
  return !!db
    .prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name=?`)
    .get(tableName);
}

function columnNames(db: BunDatabase, tableName: string): string[] {
  return db
    .prepare(`PRAGMA table_info(${JSON.stringify(tableName)})`)
    .all()
    .map((row) => (row as ColumnRow).name);
}

describe('migration 225: space_agent_templates', () => {
  test('creates the table with the full column set on a fresh database', () => {
    const db = new BunDatabase(':memory:');
    expect(tableExists(db, 'space_agent_templates')).toBe(false);

    runMigration225(db);

    expect(tableExists(db, 'space_agent_templates')).toBe(true);
    expect(columnNames(db, 'space_agent_templates')).toEqual(TEMPLATE_COLUMNS);
    db.close();
  });

  test('is idempotent when run twice', () => {
    const db = new BunDatabase(':memory:');
    runMigration225(db);
    runMigration225(db);

    expect(columnNames(db, 'space_agent_templates')).toEqual(TEMPLATE_COLUMNS);
    db.close();
  });

  test('does not disturb an existing table', () => {
    const db = new BunDatabase(':memory:');
    runMigration225(db);
    const now = Date.now();
    db.prepare(
      `INSERT INTO space_agent_templates (key, handle, display_name, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?)`
    ).run('kept.custom', 'kept', 'Kept', now, now);

    runMigration225(db);

    const row = db
      .prepare(`SELECT key, handle FROM space_agent_templates WHERE key = ?`)
      .get('kept.custom');
    expect(row).toEqual({ key: 'kept.custom', handle: 'kept' });
    db.close();
  });
});
