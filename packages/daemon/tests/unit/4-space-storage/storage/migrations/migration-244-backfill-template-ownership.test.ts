import { describe, expect, test } from 'bun:test';
import { Database as BunDatabase } from '../../../../../src/storage/sqlite-compat.ts';
import { runMigration225 } from '../../../../../src/storage/schema/m225-space-agent-templates.ts';
import { runMigration226 } from '../../../../../src/storage/schema/m226-space-agent-templates-version.ts';
import { runMigration227 } from '../../../../../src/storage/schema/m227-space-agent-template-version-seq.ts';
import { runMigration238 } from '../../../../../src/storage/schema/m238-space-agent-template-labels.ts';
import { runMigration243 } from '../../../../../src/storage/schema/m243-space-agent-template-space-key.ts';
import { runMigration244 } from '../../../../../src/storage/schema/m244-backfill-template-ownership.ts';

function db(): BunDatabase {
  const database = new BunDatabase(':memory:');
  runMigration225(database);
  runMigration226(database);
  runMigration227(database);
  runMigration238(database);
  database.exec(`CREATE TABLE spaces (id TEXT PRIMARY KEY)`);
  database.exec(
    `CREATE TABLE space_long_horizon_agents (id TEXT PRIMARY KEY, space_id TEXT, created_at INTEGER)`
  );
  database.exec(`CREATE TABLE space_workflows (id TEXT PRIMARY KEY, space_id TEXT)`);
  database.exec(
    `CREATE TABLE space_workflow_nodes (id TEXT PRIMARY KEY, workflow_id TEXT, config TEXT)`
  );
  runMigration243(database);
  return database;
}

function addSpace(d: BunDatabase, id: string): void {
  d.prepare(`INSERT INTO spaces (id) VALUES (?)`).run(id);
}

function addTemplate(d: BunDatabase, key: string, createdAt = 5_000): void {
  d.prepare(
    `INSERT INTO space_agent_templates
       (space_id, key, handle, display_name, description, instructions,
        suggested_autonomy_level, created_at, updated_at, version)
     VALUES ('', ?, 'h', 'H', 'd', 'i', 2, ?, ?, 3)`
  ).run(key, createdAt, createdAt);
}

function addAgent(d: BunDatabase, id: string, spaceId: string, createdAt = 1_000): void {
  d.prepare(
    `INSERT INTO space_long_horizon_agents (id, space_id, created_at) VALUES (?, ?, ?)`
  ).run(id, spaceId, createdAt);
}

function addSlot(d: BunDatabase, workflowId: string, spaceId: string, templateKey: string): void {
  d.prepare(`INSERT OR IGNORE INTO space_workflows (id, space_id) VALUES (?, ?)`).run(
    workflowId,
    spaceId
  );
  d.prepare(`INSERT INTO space_workflow_nodes (id, workflow_id, config) VALUES (?, ?, ?)`).run(
    `${workflowId}-node-${templateKey}`,
    workflowId,
    JSON.stringify({ agents: [{ templateKey }] })
  );
}

function owners(d: BunDatabase, key: string): string[] {
  return (
    d
      .prepare(`SELECT space_id FROM space_agent_templates WHERE key = ? ORDER BY space_id`)
      .all(key) as Array<{ space_id: string }>
  ).map((row) => row.space_id);
}

describe('migration 244: backfill template ownership', () => {
  test('claims a synthesized template for its source agent Space', () => {
    const d = db();
    addSpace(d, 'sp1');
    addSpace(d, 'sp2');
    addAgent(d, 'a1', 'sp1');
    addTemplate(d, 'migrated.agent.a1');
    runMigration244(d);
    expect(owners(d, 'migrated.agent.a1')).toEqual(['sp1']);
    d.close();
  });

  test('copies a template into every Space whose workflow references it', () => {
    const d = db();
    addSpace(d, 'sp1');
    addSpace(d, 'sp2');
    addTemplate(d, 'shared.one');
    addSlot(d, 'wf1', 'sp1', 'shared.one');
    addSlot(d, 'wf2', 'sp2', 'shared.one');
    runMigration244(d);
    expect(owners(d, 'shared.one')).toEqual(['sp1', 'sp2']);
    d.close();
  });

  test('a copy carries the original column values', () => {
    const d = db();
    addSpace(d, 'sp1');
    addSpace(d, 'sp2');
    addTemplate(d, 'shared.one');
    addSlot(d, 'wf1', 'sp1', 'shared.one');
    addSlot(d, 'wf2', 'sp2', 'shared.one');
    runMigration244(d);
    const rows = d
      .prepare(`SELECT handle, description, version, created_at FROM space_agent_templates`)
      .all() as Array<Record<string, unknown>>;
    expect(rows).toHaveLength(2);
    expect(rows[0]).toEqual(rows[1]);
    d.close();
  });

  test('assigns an unreferenced template to the only Space', () => {
    const d = db();
    addSpace(d, 'only');
    addTemplate(d, 'orphan.one');
    runMigration244(d);
    expect(owners(d, 'orphan.one')).toEqual(['only']);
    d.close();
  });

  test('deletes an unreferenced template when several Spaces exist', () => {
    const d = db();
    addSpace(d, 'sp1');
    addSpace(d, 'sp2');
    addTemplate(d, 'orphan.one');
    runMigration244(d);
    expect(owners(d, 'orphan.one')).toEqual([]);
    d.close();
  });

  test('leaves already-owned rows untouched and is idempotent', () => {
    const d = db();
    addSpace(d, 'only');
    addTemplate(d, 'orphan.one');
    runMigration244(d);
    runMigration244(d);
    expect(owners(d, 'orphan.one')).toEqual(['only']);
    d.close();
  });

  test('is a no-op before the column exists', () => {
    const bare = new BunDatabase(':memory:');
    runMigration225(bare);
    expect(() => runMigration244(bare)).not.toThrow();
    bare.close();
  });

  test('survives malformed node config', () => {
    const d = db();
    addSpace(d, 'only');
    addTemplate(d, 'orphan.one');
    d.prepare(`INSERT INTO space_workflows (id, space_id) VALUES ('wf1','only')`).run();
    d.prepare(
      `INSERT INTO space_workflow_nodes (id, workflow_id, config) VALUES ('n1','wf1','{')`
    ).run();
    expect(() => runMigration244(d)).not.toThrow();
    expect(owners(d, 'orphan.one')).toEqual(['only']);
    d.close();
  });
});
