import { describe, expect, test } from 'bun:test';
import { runMigrations } from '../../../../../src/storage/schema/migrations.ts';
import { runMigration225 } from '../../../../../src/storage/schema/m225-space-agent-templates.ts';
import { runMigration226 } from '../../../../../src/storage/schema/m226-space-agent-templates-version.ts';
import { runMigration227 } from '../../../../../src/storage/schema/m227-space-agent-template-version-seq.ts';
import { SpaceAgentTemplateRepository } from '../../../../../src/storage/repositories/space-agent-template-repository';
import { Database as BunDatabase } from '../../../../../src/storage/sqlite-compat';

interface ColumnRow {
  name: string;
}

function columnNames(db: BunDatabase, tableName: string): string[] {
  return db
    .prepare(`PRAGMA table_info(${JSON.stringify(tableName)})`)
    .all()
    .map((row) => (row as ColumnRow).name);
}

describe('migration 226: space_agent_templates version column', () => {
  test('adds the version column to a pre-existing table and backfills default 1', () => {
    const db = new BunDatabase(':memory:');
    runMigration225(db);

    const before = columnNames(db, 'space_agent_templates');
    expect(before).not.toContain('version');

    db.prepare(
      `INSERT INTO space_agent_templates (key, handle, display_name, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?)`
    ).run('pre.custom', 'pre', 'Pre', 1000, 1000);

    runMigration226(db);
    runMigration227(db);

    const after = columnNames(db, 'space_agent_templates');
    expect(after).toContain('version');

    const repo = new SpaceAgentTemplateRepository(db);
    const created = repo.create({ key: 'post.custom', handle: 'post' });
    const existing = repo.getByKeyWithVersion('pre.custom');
    expect(created.key).toBe('post.custom');
    expect(existing?.version).toBe(1);
    expect(repo.getByKeyWithVersion('post.custom')?.version).toBe(1);

    const updated = repo.casUpdate('pre.custom', { displayName: 'Updated' }, existing!.version);
    expect(updated).not.toBeNull();
    expect(repo.getByKeyWithVersion('pre.custom')?.version).toBe(2);
  });

  test('is idempotent when run twice', () => {
    const db = new BunDatabase(':memory:');
    runMigration225(db);
    runMigration226(db);
    runMigration227(db);
    runMigration226(db);
    runMigration227(db);

    const repo = new SpaceAgentTemplateRepository(db);
    repo.create({ key: 'idempotent.custom', handle: 'idempotent' });

    expect(repo.getByKey('idempotent.custom')).toEqual(
      expect.objectContaining({
        key: 'idempotent.custom',
        handle: 'idempotent',
      })
    );
  });

  test('runs as part of the registered migration sequence', () => {
    const db = new BunDatabase(':memory:');
    runMigrations(db, () => {});

    const repo = new SpaceAgentTemplateRepository(db);
    const created = repo.create({ key: 'registered.custom', handle: 'registered' });

    expect(created.key).toBe('registered.custom');
    expect(repo.getByKeyWithVersion('registered.custom')?.version).toBe(1);
    expect(repo.casUpdate('registered.custom', { displayName: 'Updated' }, 1)).not.toBeNull();
    db.close();
  });
});
