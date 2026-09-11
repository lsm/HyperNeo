import { describe, expect, test } from 'bun:test';
import { Database as BunDatabase } from '../../../../../src/storage/sqlite-compat.ts';
import { runMigration225 } from '../../../../../src/storage/schema/m225-space-agent-templates.ts';
import { runMigration226 } from '../../../../../src/storage/schema/m226-space-agent-templates-version.ts';
import { runMigration227 } from '../../../../../src/storage/schema/m227-space-agent-template-version-seq.ts';
import { runMigration238 } from '../../../../../src/storage/schema/m238-space-agent-template-labels.ts';
import { runMigration243 } from '../../../../../src/storage/schema/m243-space-agent-template-space-key.ts';

function migratedDb(): BunDatabase {
  const db = new BunDatabase(':memory:');
  runMigration225(db);
  runMigration226(db);
  runMigration227(db);
  runMigration238(db);
  return db;
}

function seedTemplate(db: BunDatabase, key: string, handle: string): void {
  const now = Date.now();
  db.prepare(
    `INSERT INTO space_agent_templates
       (key, handle, display_name, description, instructions, suggested_autonomy_level,
        created_at, updated_at, version, labels)
     VALUES (?, ?, ?, 'desc', 'contract', 3, ?, ?, 7, ?)`
  ).run(key, handle, handle, now, now, JSON.stringify(['a-label']));
}

function columns(db: BunDatabase, table: string): string[] {
  return (
    db.prepare(`PRAGMA table_info(${JSON.stringify(table)})`).all() as Array<{
      name: string;
    }>
  ).map((row) => row.name);
}

describe('migration 243: template rows gain a Space key', () => {
  test('adds space_id to both tables with a composite primary key', () => {
    const db = migratedDb();
    runMigration243(db);

    expect(columns(db, 'space_agent_templates')).toContain('space_id');

    const pk = db.prepare(`PRAGMA table_info("space_agent_templates")`).all() as Array<{
      name: string;
      pk: number;
    }>;
    const keyed = pk.filter((row) => row.pk > 0).map((row) => row.name);
    expect(keyed.sort()).toEqual(['key', 'space_id']);
    db.close();
  });

  test('carries every existing row across unchanged, defaulting the Space to empty', () => {
    const db = migratedDb();
    seedTemplate(db, 'custom.one', 'one');
    runMigration243(db);

    const row = db.prepare(`SELECT * FROM space_agent_templates WHERE key = 'custom.one'`).get() as
      | Record<string, unknown>
      | undefined;
    expect(row?.space_id).toBe('');
    expect(row?.handle).toBe('one');
    expect(row?.description).toBe('desc');
    expect(row?.instructions).toBe('contract');
    expect(row?.suggested_autonomy_level).toBe(3);
    expect(row?.version).toBe(7);
    expect(row?.labels).toBe(JSON.stringify(['a-label']));
    db.close();
  });

  test('lets one key exist once per Space', () => {
    const db = migratedDb();
    seedTemplate(db, 'shared.one', 'shared');
    runMigration243(db);

    db.prepare(
      `INSERT INTO space_agent_templates
         (space_id, key, handle, display_name, description, instructions,
          suggested_autonomy_level, created_at, updated_at, version)
       VALUES ('sp2', 'shared.one', 'shared', 'shared', '', '', 2, 1, 1, 1)`
    ).run();

    const count = db
      .prepare(`SELECT COUNT(*) AS n FROM space_agent_templates WHERE key = 'shared.one'`)
      .get() as { n: number };
    expect(count.n).toBe(2);
    db.close();
  });

  test('still rejects a duplicate key inside one Space', () => {
    const db = migratedDb();
    seedTemplate(db, 'custom.one', 'one');
    runMigration243(db);

    expect(() => seedTemplate(db, 'custom.one', 'one-again')).toThrow();
    db.close();
  });

  test('is idempotent and a no-op without the table', () => {
    const db = migratedDb();
    seedTemplate(db, 'custom.one', 'one');
    runMigration243(db);
    runMigration243(db);
    const count = db.prepare(`SELECT COUNT(*) AS n FROM space_agent_templates`).get() as {
      n: number;
    };
    expect(count.n).toBe(1);
    db.close();

    const empty = new BunDatabase(':memory:');
    expect(() => runMigration243(empty)).not.toThrow();
    empty.close();
  });

  test('leaves the version-sequence table alone for #4070', () => {
    const db = migratedDb();
    runMigration243(db);
    expect(columns(db, 'space_agent_template_version_seq')).not.toContain('space_id');
    db.close();
  });
});
