import { describe, expect, test } from 'bun:test';
import { runMigrations } from '../../../../../src/storage/schema/migrations.ts';
import { runMigration225 } from '../../../../../src/storage/schema/m225-space-agent-templates.ts';
import { runMigration226 } from '../../../../../src/storage/schema/m226-space-agent-templates-version.ts';
import { runMigration227 } from '../../../../../src/storage/schema/m227-space-agent-template-version-seq.ts';
import { runMigration236 } from '../../../../../src/storage/schema/m236-space-agent-template-labels.ts';
import { SpaceAgentTemplateRepository } from '../../../../../src/storage/repositories/space-agent-template-repository.ts';
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

describe('migration 236: space_agent_templates labels column', () => {
  test('adds the labels column to a pre-existing table and reads it back as empty', () => {
    const db = new BunDatabase(':memory:');
    runMigration225(db);
    runMigration226(db);
    runMigration227(db);

    expect(columnNames(db, 'space_agent_templates')).not.toContain('labels');

    db.prepare(
      `INSERT INTO space_agent_templates (key, handle, display_name, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?)`
    ).run('pre.custom', 'pre', 'Pre', 1000, 1000);

    runMigration236(db);

    expect(columnNames(db, 'space_agent_templates')).toContain('labels');

    const repo = new SpaceAgentTemplateRepository(db);
    expect(repo.getByKey('pre.custom')?.labels).toEqual([]);
    const created = repo.create({ key: 'post.custom', handle: 'post', labels: ['quality'] });
    expect(created.labels).toEqual(['quality']);
    expect(repo.getByKey('post.custom')?.labels).toEqual(['quality']);
    db.close();
  });

  test('is idempotent when run twice', () => {
    const db = new BunDatabase(':memory:');
    runMigration225(db);
    runMigration226(db);
    runMigration227(db);
    runMigration236(db);
    runMigration236(db);

    const repo = new SpaceAgentTemplateRepository(db);
    repo.create({ key: 'idempotent.custom', handle: 'idempotent' });

    expect(repo.getByKey('idempotent.custom')?.labels).toEqual([]);
    db.close();
  });

  test('runs as part of the registered migration sequence', () => {
    const db = new BunDatabase(':memory:');
    runMigrations(db, () => {});

    const repo = new SpaceAgentTemplateRepository(db);
    const created = repo.create({ key: 'registered.custom', handle: 'registered' });

    expect(created.labels).toEqual([]);
    const updated = repo.update('registered.custom', { labels: ['release'] });
    expect(updated?.labels).toEqual(['release']);
    db.close();
  });
});
