import { describe, expect, test } from 'bun:test';
import { runMigration271 } from '../../../../../src/storage/schema/m271-relocate-built-in-key-templates.ts';
import { runMigrations } from '../../../../../src/storage/schema/migrations.ts';
import { Database as BunDatabase } from '../../../../../src/storage/sqlite-compat';

function makeDb(): BunDatabase {
  const db = new BunDatabase(':memory:');
  db.exec(`CREATE TABLE space_agent_templates (
    space_id TEXT NOT NULL DEFAULT '',
    key TEXT NOT NULL,
    handle TEXT NOT NULL,
    display_name TEXT NOT NULL,
    instructions TEXT NOT NULL DEFAULT '',
    labels TEXT DEFAULT NULL,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    PRIMARY KEY (space_id, key)
  )`);
  db.exec(`CREATE TABLE space_agent_template_version_seq (
    space_id TEXT NOT NULL DEFAULT '',
    key TEXT NOT NULL,
    next_version INTEGER NOT NULL DEFAULT 1,
    PRIMARY KEY (space_id, key)
  )`);
  return db;
}

function insertTemplate(
  db: BunDatabase,
  spaceId: string,
  key: string,
  labels: string[] | null = null
): void {
  db.prepare(
    `INSERT INTO space_agent_templates
       (space_id, key, handle, display_name, instructions, labels, created_at, updated_at)
     VALUES (?, ?, 'custom', 'Custom', 'custom instructions', ?, 1, 1)`
  ).run(spaceId, key, labels ? JSON.stringify(labels) : null);
  db.prepare(
    `INSERT INTO space_agent_template_version_seq (space_id, key, next_version) VALUES (?, ?, 3)`
  ).run(spaceId, key);
}

function templateKeys(db: BunDatabase, spaceId: string): string[] {
  return (
    db
      .prepare(`SELECT key FROM space_agent_templates WHERE space_id = ? ORDER BY key`)
      .all(spaceId) as Array<{ key: string }>
  ).map((row) => row.key);
}

function versionSeqKeys(db: BunDatabase, spaceId: string): string[] {
  return (
    db
      .prepare(`SELECT key FROM space_agent_template_version_seq WHERE space_id = ? ORDER BY key`)
      .all(spaceId) as Array<{ key: string }>
  ).map((row) => row.key);
}

function templateRow(
  db: BunDatabase,
  spaceId: string,
  key: string
): { labels: string[]; instructions: string } {
  const row = db
    .prepare(
      `SELECT labels, instructions FROM space_agent_templates WHERE space_id = ? AND key = ?`
    )
    .get(spaceId, key) as { labels: string | null; instructions: string };
  return { labels: JSON.parse(row.labels ?? '[]') as string[], instructions: row.instructions };
}

describe('runMigration271', () => {
  test('relocates a stored template shadowed by the task-manager.default built-in', () => {
    const db = makeDb();
    insertTemplate(db, 'space-1', 'task-manager.default', ['ops']);
    insertTemplate(db, 'space-1', 'custom.helper');

    runMigration271(db);

    expect(templateKeys(db, 'space-1')).toEqual(['custom.helper', 'task-manager.default.migrated']);
    expect(templateRow(db, 'space-1', 'task-manager.default.migrated')).toEqual({
      labels: ['ops', 'relocated-from:task-manager.default'],
      instructions: 'custom instructions',
    });
    expect(versionSeqKeys(db, 'space-1')).toEqual([
      'custom.helper',
      'task-manager.default.migrated',
    ]);
  });

  test('takes the next free suffix within each space independently', () => {
    const db = makeDb();
    insertTemplate(db, 'space-1', 'task-manager.default');
    insertTemplate(db, 'space-1', 'task-manager.default.migrated');
    insertTemplate(db, 'space-2', 'task-manager.default');

    runMigration271(db);

    expect(templateKeys(db, 'space-1')).toEqual([
      'task-manager.default.migrated',
      'task-manager.default.migrated-2',
    ]);
    expect(templateKeys(db, 'space-2')).toEqual(['task-manager.default.migrated']);
  });

  test('leaves a relocated database unchanged when it runs again', () => {
    const db = makeDb();
    insertTemplate(db, 'space-1', 'task-manager.default');

    runMigration271(db);
    runMigration271(db);

    expect(templateKeys(db, 'space-1')).toEqual(['task-manager.default.migrated']);
    expect(templateRow(db, 'space-1', 'task-manager.default.migrated').labels).toEqual([
      'relocated-from:task-manager.default',
    ]);
  });
});

describe('upgrading a database that already ran migration 271', () => {
  test('preserves a custom space-manager.default template and its version sequence', () => {
    const db = new BunDatabase(':memory:');
    runMigrations(db, () => {});
    db.prepare(`DELETE FROM migration_markers WHERE key = 'migration_276'`).run();
    db.prepare(
      `INSERT INTO spaces (id, slug, workspace_path, name, created_at, updated_at)
       VALUES ('space-1', 'space-1', '/tmp/space-1', 'Space', 1, 1)`
    ).run();
    insertTemplate(db, 'space-1', 'space-manager.default', ['custom']);

    runMigrations(db, () => {});

    expect(templateKeys(db, 'space-1')).toEqual(['space-manager.default.migrated']);
    expect(templateRow(db, 'space-1', 'space-manager.default.migrated')).toEqual({
      labels: ['custom', 'relocated-from:space-manager.default'],
      instructions: 'custom instructions',
    });
    expect(versionSeqKeys(db, 'space-1')).toEqual(['space-manager.default.migrated']);
    db.close();
  });
});
