import { describe, expect, test } from 'bun:test';
import type { SpaceWorkflow } from '@hyperneo/shared';
import {
  computeDefinitionVersion,
  verifyDefinitionVersion,
} from '../../../../../src/lib/space/workflows/definition-version.ts';
import { runMigration239 } from '../../../../../src/storage/schema/m239-rename-worker-coder-template-key.ts';
import { Database as BunDatabase } from '../../../../../src/storage/sqlite-compat.ts';
import {
  createSpaceAgentSchema,
  insertSpace,
  insertWorkflow,
} from '../../../helpers/space-agent-schema.ts';

function insertNodeWithSlots(
  db: BunDatabase,
  nodeId: string,
  workflowId: string,
  slots: unknown[]
): void {
  const now = Date.now();
  db.prepare(
    `INSERT INTO space_workflow_nodes (id, workflow_id, name, description, config, created_at, updated_at)
     VALUES (?, ?, ?, '', ?, ?, ?)`
  ).run(nodeId, workflowId, nodeId, JSON.stringify({ agents: slots }), now, now);
}

function readSlots(db: BunDatabase, nodeId: string): unknown[] {
  const row = db.prepare(`SELECT config FROM space_workflow_nodes WHERE id = ?`).get(nodeId) as {
    config: string;
  };
  return (JSON.parse(row.config) as { agents: unknown[] }).agents;
}

function insertAgentRow(
  db: BunDatabase,
  seed: { id: string; spaceId: string; templateKey: string }
): void {
  const now = Date.now();
  db.prepare(
    `INSERT INTO space_long_horizon_agents (
       id, space_id, handle, display_name, template_key, status, instructions,
       tool_permissions_json, created_at, updated_at
     ) VALUES (?, ?, ?, ?, ?, 'active', '', '{}', ?, ?)`
  ).run(seed.id, seed.spaceId, seed.id, seed.id, seed.templateKey, now, now);
}

function readAgentTemplateKey(db: BunDatabase, agentId: string): string | null {
  const row = db
    .prepare(`SELECT template_key FROM space_long_horizon_agents WHERE id = ?`)
    .get(agentId) as { template_key: string | null };
  return row.template_key;
}

function insertPinnedRun(
  db: BunDatabase,
  params: {
    runId: string;
    workflowId: string;
    spaceId: string;
    workflow: Record<string, unknown>;
  }
): string {
  const { versionHash, payload } = computeDefinitionVersion(
    params.workflow as unknown as SpaceWorkflow
  );
  db.prepare(
    `INSERT INTO space_workflow_definition_versions (workflow_id, version_hash, space_id, payload, source, created_at)
     VALUES (?, ?, ?, ?, 'backfill', 1)`
  ).run(params.workflowId, versionHash, params.spaceId, payload);
  db.prepare(
    `INSERT INTO space_workflow_runs (id, space_id, workflow_id, definition_version, title, description, status, created_at, updated_at)
     VALUES (?, ?, ?, ?, 'Run', '', 'in_progress', 1, 1)`
  ).run(params.runId, params.spaceId, params.workflowId, versionHash);
  return versionHash;
}

function readRunVersion(db: BunDatabase, runId: string): string | null {
  const row = db
    .prepare(`SELECT definition_version FROM space_workflow_runs WHERE id = ?`)
    .get(runId) as { definition_version: string | null };
  return row.definition_version;
}

function readVersionPayload(
  db: BunDatabase,
  workflowId: string,
  versionHash: string
): Record<string, unknown> {
  const row = db
    .prepare(
      `SELECT payload FROM space_workflow_definition_versions
       WHERE workflow_id = ? AND version_hash = ?`
    )
    .get(workflowId, versionHash) as { payload: string };
  return JSON.parse(row.payload) as Record<string, unknown>;
}

function pinnedWorkflow(slots: unknown[]): Record<string, unknown> {
  return {
    id: 'wf-pin',
    spaceId: 'space-1',
    name: 'Pinned Flow',
    nodes: [{ id: 'node-pin', name: 'Pin', agents: slots }],
    channels: [],
    startNodeId: 'node-pin',
    endNodeId: 'node-pin',
  };
}

function createMigrationDb(): BunDatabase {
  const db = new BunDatabase(':memory:');
  createSpaceAgentSchema(db);
  insertSpace(db);
  db.exec(`
    CREATE TABLE space_workflow_definition_versions (
      workflow_id TEXT NOT NULL,
      version_hash TEXT NOT NULL,
      space_id TEXT NOT NULL,
      payload TEXT NOT NULL,
      source TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      PRIMARY KEY (workflow_id, version_hash)
    )
  `);
  db.exec(`
    CREATE TABLE space_workflow_runs (
      id TEXT PRIMARY KEY,
      space_id TEXT NOT NULL,
      workflow_id TEXT NOT NULL,
      definition_version TEXT,
      title TEXT NOT NULL DEFAULT '',
      description TEXT NOT NULL DEFAULT '',
      status TEXT NOT NULL DEFAULT 'pending',
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    )
  `);
  return db;
}

describe('migration 239 — rename worker.coder slot templateKey to worker.swe', () => {
  test('renames the key on live workflow node slots and leaves other keys alone', () => {
    const db = createMigrationDb();
    insertWorkflow(db, 'wf-1', 'space-1', 'Flow');
    insertNodeWithSlots(db, 'node-1', 'wf-1', [
      { agentId: '', templateKey: 'worker.coder', name: 'coder' },
      { agentId: '', templateKey: 'worker.reviewer', name: 'reviewer' },
      { agentId: 'agent-1', name: 'legacy' },
    ]);

    runMigration239(db);

    expect(readSlots(db, 'node-1')).toEqual([
      { agentId: '', templateKey: 'worker.swe', name: 'coder' },
      { agentId: '', templateKey: 'worker.reviewer', name: 'reviewer' },
      { agentId: 'agent-1', name: 'legacy' },
    ]);
    db.close();
  });

  test('normalizes surrounding whitespace when renaming the key', () => {
    const db = createMigrationDb();
    insertWorkflow(db, 'wf-1', 'space-1', 'Flow');
    insertNodeWithSlots(db, 'node-1', 'wf-1', [
      { agentId: '', templateKey: '  worker.coder  ', name: 'coder' },
    ]);

    runMigration239(db);

    expect(readSlots(db, 'node-1')).toEqual([
      { agentId: '', templateKey: 'worker.swe', name: 'coder' },
    ]);
    db.close();
  });

  test('renames the templateKey metadata on agent rows only', () => {
    const db = createMigrationDb();
    insertAgentRow(db, { id: 'agent-swe', spaceId: 'space-1', templateKey: 'worker.coder' });
    insertAgentRow(db, { id: 'agent-qa', spaceId: 'space-1', templateKey: 'worker.qa' });
    insertAgentRow(db, {
      id: 'agent-none',
      spaceId: 'space-1',
      templateKey: 'coordinator.default',
    });

    runMigration239(db);

    expect(readAgentTemplateKey(db, 'agent-swe')).toBe('worker.swe');
    expect(readAgentTemplateKey(db, 'agent-qa')).toBe('worker.qa');
    expect(readAgentTemplateKey(db, 'agent-none')).toBe('coordinator.default');
    db.close();
  });

  test('rewrites pinned run definitions into a new version and repoints the run', () => {
    const db = createMigrationDb();
    insertWorkflow(db, 'wf-pin', 'space-1', 'Pinned Flow');
    const oldHash = insertPinnedRun(db, {
      runId: 'run-1',
      workflowId: 'wf-pin',
      spaceId: 'space-1',
      workflow: pinnedWorkflow([{ agentId: '', templateKey: 'worker.coder', name: 'coder' }]),
    });

    runMigration239(db);

    const newHash = readRunVersion(db, 'run-1');
    expect(newHash).not.toBe(oldHash);
    const row = db
      .prepare(
        `SELECT payload FROM space_workflow_definition_versions
         WHERE workflow_id = 'wf-pin' AND version_hash = ?`
      )
      .get(newHash ?? '') as { payload: string };
    expect(verifyDefinitionVersion(row.payload, newHash ?? '')).toBe(true);
    const payload = readVersionPayload(db, 'wf-pin', newHash ?? '') as {
      nodes: Array<{ agents: Array<Record<string, unknown>> }>;
    };
    expect(payload.nodes[0].agents[0]).toEqual({
      agentId: '',
      templateKey: 'worker.swe',
      name: 'coder',
    });
    expect(
      db
        .prepare(`SELECT payload FROM space_workflow_definition_versions WHERE version_hash = ?`)
        .get(oldHash)
    ).toBeDefined();
    db.close();
  });

  test('leaves runs without a pinned definition version and tampered payloads untouched', () => {
    const db = createMigrationDb();
    insertWorkflow(db, 'wf-pin', 'space-1', 'Pinned Flow');
    db.prepare(
      `INSERT INTO space_workflow_runs (id, space_id, workflow_id, definition_version, title, description, status, created_at, updated_at)
       VALUES ('run-bare', 'space-1', 'wf-pin', NULL, 'Run', '', 'in_progress', 1, 1)`
    ).run();
    db.prepare(
      `INSERT INTO space_workflow_definition_versions (workflow_id, version_hash, space_id, payload, source, created_at)
       VALUES ('wf-pin', 'tampered-hash', 'space-1', '{"nodes":[]}', 'backfill', 1)`
    ).run();
    db.prepare(
      `INSERT INTO space_workflow_runs (id, space_id, workflow_id, definition_version, title, description, status, created_at, updated_at)
       VALUES ('run-tampered', 'space-1', 'wf-pin', 'tampered-hash', 'Run', '', 'in_progress', 1, 1)`
    ).run();

    runMigration239(db);

    expect(readRunVersion(db, 'run-bare')).toBeNull();
    expect(readRunVersion(db, 'run-tampered')).toBe('tampered-hash');
    expect(
      (
        db.prepare(`SELECT COUNT(*) AS count FROM space_workflow_definition_versions`).get() as {
          count: number;
        }
      ).count
    ).toBe(1);
    db.close();
  });

  test('is idempotent — a second run appends no new versions', () => {
    const db = createMigrationDb();
    insertWorkflow(db, 'wf-pin', 'space-1', 'Pinned Flow');
    insertPinnedRun(db, {
      runId: 'run-1',
      workflowId: 'wf-pin',
      spaceId: 'space-1',
      workflow: pinnedWorkflow([{ agentId: '', templateKey: 'worker.coder', name: 'coder' }]),
    });

    runMigration239(db);
    const afterFirst = readRunVersion(db, 'run-1');
    runMigration239(db);

    expect(readRunVersion(db, 'run-1')).toBe(afterFirst);
    expect(
      (
        db.prepare(`SELECT COUNT(*) AS count FROM space_workflow_definition_versions`).get() as {
          count: number;
        }
      ).count
    ).toBe(2);
    db.close();
  });
});
