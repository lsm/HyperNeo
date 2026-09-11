import { describe, expect, test } from 'bun:test';
import { runMigration225 } from '../../../../../src/storage/schema/m225-space-agent-templates.ts';
import { runMigration226 } from '../../../../../src/storage/schema/m226-space-agent-templates-version.ts';
import { runMigration227 } from '../../../../../src/storage/schema/m227-space-agent-template-version-seq.ts';
import { runMigration238 } from '../../../../../src/storage/schema/m238-space-agent-template-labels.ts';
import { runMigration243 } from '../../../../../src/storage/schema/m243-space-agent-template-space-key.ts';
import { runMigration246 } from '../../../../../src/storage/schema/m246-template-version-seq-space-key.ts';
import { Database as BunDatabase } from '../../../../../src/storage/sqlite-compat.ts';

function migratedDb(): BunDatabase {
  const db = new BunDatabase(':memory:');
  runMigration225(db);
  runMigration226(db);
  runMigration227(db);
  runMigration238(db);
  return db;
}

function seedTemplate(db: BunDatabase, spaceId: string, key: string, version: number): void {
  const now = Date.now();
  db.prepare(
    `INSERT INTO space_agent_templates
       (space_id, key, handle, display_name, description, instructions,
        suggested_autonomy_level, created_at, updated_at, version)
     VALUES (?, ?, 'h', 'H', '', '', 3, ?, ?, ?)`
  ).run(spaceId, key, now, now, version);
}

function seq(db: BunDatabase, spaceId: string, key: string): number | undefined {
  const row = db
    .prepare(
      `SELECT next_version FROM space_agent_template_version_seq WHERE space_id = ? AND key = ?`
    )
    .get(spaceId, key) as { next_version: number } | undefined;
  return row?.next_version;
}

describe('migration 246: the template version counter gains a Space key', () => {
  test('rekeys the counter on (space_id, key)', () => {
    const db = migratedDb();
    runMigration246(db);

    const pk = db.prepare(`PRAGMA table_info("space_agent_template_version_seq")`).all() as Array<{
      name: string;
      pk: number;
    }>;
    expect(
      pk
        .filter((row) => row.pk > 0)
        .map((row) => row.name)
        .sort()
    ).toEqual(['key', 'space_id']);
    db.close();
  });

  test('carries existing counters onto the sentinel Space', () => {
    const db = migratedDb();
    db.prepare(
      `INSERT INTO space_agent_template_version_seq (key, next_version) VALUES ('legacy.custom', 9)`
    ).run();
    runMigration246(db);

    expect(seq(db, '', 'legacy.custom')).toBe(9);
    db.close();
  });

  test('gives each owning Space its own counter, never below that row version', () => {
    const db = migratedDb();
    db.prepare(
      `INSERT INTO space_agent_template_version_seq (key, next_version) VALUES ('shared.custom', 4)`
    ).run();
    runMigration243(db);
    seedTemplate(db, 'space-a', 'shared.custom', 2);
    seedTemplate(db, 'space-b', 'shared.custom', 11);
    runMigration246(db);

    expect(seq(db, 'space-a', 'shared.custom')).toBe(4);
    expect(seq(db, 'space-b', 'shared.custom')).toBe(11);
    expect(seq(db, '', 'shared.custom')).toBe(4);
    db.close();
  });

  test('is a no-op when it has already run', () => {
    const db = migratedDb();
    runMigration246(db);
    db.prepare(
      `INSERT INTO space_agent_template_version_seq (space_id, key, next_version)
       VALUES ('space-a', 'kept.custom', 5)`
    ).run();
    runMigration246(db);

    expect(seq(db, 'space-a', 'kept.custom')).toBe(5);
    db.close();
  });
});
