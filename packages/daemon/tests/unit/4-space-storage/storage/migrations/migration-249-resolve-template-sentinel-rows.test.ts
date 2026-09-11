import { describe, expect, test } from 'bun:test';
import { runMigration225 } from '../../../../../src/storage/schema/m225-space-agent-templates.ts';
import { runMigration226 } from '../../../../../src/storage/schema/m226-space-agent-templates-version.ts';
import { runMigration227 } from '../../../../../src/storage/schema/m227-space-agent-template-version-seq.ts';
import { runMigration238 } from '../../../../../src/storage/schema/m238-space-agent-template-labels.ts';
import { runMigration243 } from '../../../../../src/storage/schema/m243-space-agent-template-space-key.ts';
import { runMigration246 } from '../../../../../src/storage/schema/m246-template-version-seq-space-key.ts';
import { runMigration249 } from '../../../../../src/storage/schema/m249-resolve-template-sentinel-rows.ts';
import { SpaceAgentTemplateRepository } from '../../../../../src/storage/repositories/space-agent-template-repository.ts';
import { Database as BunDatabase } from '../../../../../src/storage/sqlite-compat.ts';

function migratedDb(spaceIds: string[]): BunDatabase {
  const db = new BunDatabase(':memory:');
  runMigration225(db);
  runMigration226(db);
  runMigration227(db);
  runMigration238(db);
  runMigration243(db);
  runMigration246(db);
  db.exec(`CREATE TABLE IF NOT EXISTS spaces (id TEXT PRIMARY KEY)`);
  const insert = db.prepare(`INSERT INTO spaces (id) VALUES (?)`);
  for (const id of spaceIds) insert.run(id);
  return db;
}

function seed(db: BunDatabase, spaceId: string, key: string): void {
  db.prepare(
    `INSERT INTO space_agent_templates
       (space_id, key, handle, display_name, description, instructions,
        suggested_autonomy_level, created_at, updated_at, version)
     VALUES (?, ?, 'h', 'H', '', '', 2, 1, 1, 1)`
  ).run(spaceId, key);
  db.prepare(
    `INSERT INTO space_agent_template_version_seq (space_id, key, next_version) VALUES (?, ?, 4)`
  ).run(spaceId, key);
}

function owners(db: BunDatabase, key: string): string[] {
  return (
    db
      .prepare(`SELECT space_id FROM space_agent_templates WHERE key = ? ORDER BY space_id`)
      .all(key) as Array<{ space_id: string }>
  ).map((row) => row.space_id);
}

describe('migration 249: leftover sentinel template rows', () => {
  test('assigns them to the only Space on a single-Space install', () => {
    const db = migratedDb(['space-solo']);
    seed(db, '', 'legacy.custom');

    runMigration249(db);

    expect(owners(db, 'legacy.custom')).toEqual(['space-solo']);
    const counter = db
      .prepare(
        `SELECT next_version FROM space_agent_template_version_seq
          WHERE space_id = 'space-solo' AND key = 'legacy.custom'`
      )
      .get() as { next_version: number } | undefined;
    expect(counter?.next_version).toBe(4);
    db.close();
  });

  test('drops a sentinel row the only Space already owns under the same key', () => {
    const db = migratedDb(['space-solo']);
    seed(db, '', 'legacy.custom');
    seed(db, 'space-solo', 'legacy.custom');

    runMigration249(db);

    expect(owners(db, 'legacy.custom')).toEqual(['space-solo']);
    db.close();
  });

  test('deletes unattributable rows when more than one Space exists', () => {
    const db = migratedDb(['space-a', 'space-b']);
    seed(db, '', 'legacy.custom');
    seed(db, 'space-a', 'kept.custom');

    runMigration249(db);

    expect(owners(db, 'legacy.custom')).toEqual([]);
    expect(owners(db, 'kept.custom')).toEqual(['space-a']);
    db.close();
  });

  test('keeps deleted rows version counters as tombstones', () => {
    const db = migratedDb(['space-a', 'space-b']);
    seed(db, '', 'legacy.custom');

    runMigration249(db);

    const tombstone = db
      .prepare(
        `SELECT next_version FROM space_agent_template_version_seq
          WHERE space_id = '' AND key = 'legacy.custom'`
      )
      .get() as { next_version: number } | undefined;
    expect(tombstone?.next_version).toBe(4);

    const repo = new SpaceAgentTemplateRepository(db);
    const recreated = repo.createOwned('space-a', { key: 'legacy.custom', handle: 'h' });
    expect(repo.getOwnedWithVersion('space-a', recreated.key)!.version).toBeGreaterThan(4);
    db.close();
  });

  test('is a no-op when nothing sits at the sentinel', () => {
    const db = migratedDb(['space-a']);
    seed(db, 'space-a', 'owned.custom');

    runMigration249(db);
    runMigration249(db);

    expect(owners(db, 'owned.custom')).toEqual(['space-a']);
    db.close();
  });
});
