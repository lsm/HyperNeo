import { describe, expect, test } from 'bun:test';
import { runMigrations } from '../../../../../src/storage/schema/migrations.ts';
import { runMigration225 } from '../../../../../src/storage/schema/m225-space-agent-templates.ts';
import { runMigration243 } from '../../../../../src/storage/schema/m243-space-agent-template-space-key';
import { runMigration226 } from '../../../../../src/storage/schema/m226-space-agent-templates-version.ts';
import { runMigration227 } from '../../../../../src/storage/schema/m227-space-agent-template-version-seq.ts';
import { runMigration238 } from '../../../../../src/storage/schema/m238-space-agent-template-labels.ts';
import { SpaceAgentTemplateRepository } from '../../../../../src/storage/repositories/space-agent-template-repository.ts';
import { Database as BunDatabase } from '../../../../../src/storage/sqlite-compat';
import {
  createSpaceAgentSchema,
  insertSpace,
  insertWorkflow,
} from '../../../helpers/space-agent-schema.ts';

interface ColumnRow {
  name: string;
}

function columnNames(db: BunDatabase, tableName: string): string[] {
  return db
    .prepare(`PRAGMA table_info(${JSON.stringify(tableName)})`)
    .all()
    .map((row) => (row as ColumnRow).name);
}

describe('migration 238: space_agent_templates labels column', () => {
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

    runMigration238(db);

    runMigration243(db);

    expect(columnNames(db, 'space_agent_templates')).toContain('labels');

    const repo = new SpaceAgentTemplateRepository(db);
    expect(repo.getByKey('', 'pre.custom')?.labels).toEqual([]);
    const created = repo.create('', { key: 'post.custom', handle: 'post', labels: ['quality'] });
    expect(created.labels).toEqual(['quality']);
    expect(repo.getByKey('', 'post.custom')?.labels).toEqual(['quality']);
    db.close();
  });

  test('is idempotent when run twice', () => {
    const db = new BunDatabase(':memory:');
    runMigration225(db);
    runMigration226(db);
    runMigration227(db);
    runMigration238(db);
    runMigration238(db);

    const repo = new SpaceAgentTemplateRepository(db);
    repo.create('', { key: 'idempotent.custom', handle: 'idempotent' });

    expect(repo.getByKey('', 'idempotent.custom')?.labels).toEqual([]);
    db.close();
  });

  test('runs as part of the registered migration sequence', () => {
    const db = new BunDatabase(':memory:');
    runMigrations(db, () => {});

    const repo = new SpaceAgentTemplateRepository(db);
    const created = repo.create('', { key: 'registered.custom', handle: 'registered' });

    expect(created.labels).toEqual([]);
    const updated = repo.update('', 'registered.custom', { labels: ['release'] });
    expect(updated?.labels).toEqual(['release']);
    db.close();
  });

  test('precedes template-writing migrations on the upgrade path (m228 ordering)', () => {
    const db = new BunDatabase(':memory:');
    createSpaceAgentSchema(db);
    insertSpace(db);
    runMigration225(db);
    runMigration226(db);
    runMigration227(db);
    db.prepare(
      `INSERT INTO space_long_horizon_agents (
         id, space_id, handle, display_name, template_key, status, session_id, instructions,
         autonomy_level, model, thinking_level, provider, setting_sources,
         tool_permissions_json, description, model_pool, created_at, updated_at
       ) VALUES (?, ?, ?, ?, NULL, 'active', NULL, ?, NULL, NULL, NULL, NULL, NULL, '{}', NULL, NULL, 1000, 1000)`
    ).run('agent-upgrade', 'space-1', 'researcher', 'Researcher', 'Upgrade contract');
    insertWorkflow(db, 'wf-upgrade', 'space-1', 'Upgrade Flow');
    db.prepare(
      `INSERT INTO space_workflow_nodes (id, workflow_id, name, description, config, created_at, updated_at)
       VALUES (?, ?, ?, '', ?, 1000, 1000)`
    ).run(
      'node-upgrade',
      'wf-upgrade',
      'node-upgrade',
      JSON.stringify({ agents: [{ agentId: 'agent-upgrade', name: 'researcher' }] })
    );
    db.exec(`
      CREATE TABLE IF NOT EXISTS migration_markers (
        key TEXT PRIMARY KEY,
        applied_at INTEGER NOT NULL
      )
    `);
    db.exec(`
      CREATE TABLE IF NOT EXISTS migration_space_reclaims (
        migration_key TEXT PRIMARY KEY,
        reclaimed_at INTEGER NOT NULL
      )
    `);
    const mark = db.prepare(
      `INSERT OR IGNORE INTO migration_markers (key, applied_at) VALUES (?, 1000)`
    );
    for (let version = 1; version <= 237; version++) {
      if (version === 228) continue;
      mark.run(`migration_${String(version).padStart(3, '0')}`);
    }

    runMigrations(db, () => {});

    const repo = new SpaceAgentTemplateRepository(db);
    const template = repo.getByKey('', 'migrated.agent.agent-upgrade');
    expect(template?.labels).toEqual([]);
    db.close();
  });
});
