import { describe, expect, test } from 'bun:test';
import { Database as BunDatabase } from '../../../../../src/storage/sqlite-compat.ts';
import { runMigration225 } from '../../../../../src/storage/schema/m225-space-agent-templates.ts';
import { runMigration226 } from '../../../../../src/storage/schema/m226-space-agent-templates-version.ts';
import { runMigration227 } from '../../../../../src/storage/schema/m227-space-agent-template-version-seq.ts';
import { runMigration231 } from '../../../../../src/storage/schema/m231-clear-resolved-workflow-slot-agent-ids.ts';
import { SpaceAgentTemplateRepository } from '../../../../../src/storage/repositories/space-agent-template-repository.ts';
import {
  createSpaceAgentSchema,
  insertSpace,
  insertWorkflow,
} from '../../../helpers/space-agent-schema.ts';

interface SlotFixture {
  agentId?: unknown;
  templateKey?: unknown;
  name?: string;
}

function insertNodeWithSlots(
  db: BunDatabase,
  nodeId: string,
  workflowId: string,
  slots: unknown[],
  postApproval?: { targetAgent: string; instructions: string }
): void {
  const now = Date.now();
  db.prepare(
    `INSERT INTO space_workflow_nodes (id, workflow_id, name, description, config, created_at, updated_at)
     VALUES (?, ?, ?, '', ?, ?, ?)`
  ).run(nodeId, workflowId, nodeId, JSON.stringify({ agents: slots, postApproval }), now, now);
}

function readNodeConfig(
  db: BunDatabase,
  nodeId: string
): { agents: unknown[]; postApproval?: { targetAgent: string } } {
  const row = db.prepare(`SELECT config FROM space_workflow_nodes WHERE id = ?`).get(nodeId) as {
    config: string;
  };
  return JSON.parse(row.config) as {
    agents: unknown[];
    postApproval?: { targetAgent: string };
  };
}

function readSlots(db: BunDatabase, nodeId: string): unknown[] {
  return readNodeConfig(db, nodeId).agents;
}

function createMigrationDb(): BunDatabase {
  const db = new BunDatabase(':memory:');
  createSpaceAgentSchema(db);
  insertSpace(db);
  runMigration225(db);
  runMigration226(db);
  runMigration227(db);
  return db;
}

describe('migration 231 — clear slot.agentId where templateKey resolves', () => {
  test('clears agentId on slots bound to a stored library template or a code built-in', () => {
    const db = createMigrationDb();
    new SpaceAgentTemplateRepository(db).create({
      key: 'migrated.agent.agent-1',
      handle: 'coder',
      displayName: 'Coder',
    });
    insertWorkflow(db, 'wf-1', 'space-1', 'Flow');
    insertNodeWithSlots(db, 'node-1', 'wf-1', [
      { agentId: 'agent-1', templateKey: 'migrated.agent.agent-1', name: 'coder' },
      { agentId: 'agent-stale', templateKey: 'coordinator.default', name: 'coordinator' },
    ]);

    runMigration231(db);

    expect(readSlots(db, 'node-1')).toEqual([
      { agentId: '', templateKey: 'migrated.agent.agent-1', name: 'coder' },
      { agentId: '', templateKey: 'coordinator.default', name: 'coordinator' },
    ]);
    db.close();
  });

  test('keeps agentId on slots whose templateKey resolves nowhere', () => {
    const db = createMigrationDb();
    insertWorkflow(db, 'wf-1', 'space-1', 'Flow');
    insertNodeWithSlots(db, 'node-1', 'wf-1', [
      { agentId: 'agent-1', templateKey: 'deleted-template', name: 'coder' },
    ]);

    runMigration231(db);

    expect(readSlots(db, 'node-1')).toEqual([
      { agentId: 'agent-1', templateKey: 'deleted-template', name: 'coder' },
    ]);
    db.close();
  });

  test('keeps agentId on slots bound only by agentId', () => {
    const db = createMigrationDb();
    insertWorkflow(db, 'wf-1', 'space-1', 'Flow');
    insertNodeWithSlots(db, 'node-1', 'wf-1', [{ agentId: 'agent-1', name: 'coder' }]);

    runMigration231(db);

    expect(readSlots(db, 'node-1')).toEqual([{ agentId: 'agent-1', name: 'coder' }]);
    db.close();
  });

  test('skips slots without a usable agentId and tolerates malformed entries', () => {
    const db = createMigrationDb();
    insertWorkflow(db, 'wf-1', 'space-1', 'Flow');
    insertNodeWithSlots(db, 'node-1', 'wf-1', [
      { agentId: '', templateKey: 'coordinator.default', name: 'cleared' },
      { agentId: '   ', templateKey: 'coordinator.default', name: 'blank' },
      { templateKey: 'coordinator.default', name: 'absent' },
      null,
      'not-a-slot',
      { agentId: 42, templateKey: 'coordinator.default', name: 'numeric' },
    ]);

    runMigration231(db);

    const slots = readSlots(db, 'node-1');
    expect(slots[0]).toEqual({
      agentId: '',
      templateKey: 'coordinator.default',
      name: 'cleared',
    } as SlotFixture);
    expect(slots[1]).toEqual({
      agentId: '   ',
      templateKey: 'coordinator.default',
      name: 'blank',
    } as SlotFixture);
    expect(slots[2]).toEqual({ templateKey: 'coordinator.default', name: 'absent' });
    expect(slots[3]).toBeNull();
    expect(slots[4]).toBe('not-a-slot');
    expect(slots[5]).toEqual({ agentId: 42, templateKey: 'coordinator.default', name: 'numeric' });
    db.close();
  });

  test('leaves nodes untouched when no slot needs clearing', () => {
    const db = createMigrationDb();
    insertWorkflow(db, 'wf-1', 'space-1', 'Flow');
    insertNodeWithSlots(db, 'node-1', 'wf-1', [
      { agentId: 'agent-1', name: 'coder' },
      { agentId: '', templateKey: 'coordinator.default', name: 'coordinator' },
    ]);
    const before = db
      .prepare(`SELECT config, updated_at FROM space_workflow_nodes WHERE id = 'node-1'`)
      .get() as { config: string; updated_at: number };

    runMigration231(db);

    const after = db
      .prepare(`SELECT config, updated_at FROM space_workflow_nodes WHERE id = 'node-1'`)
      .get() as { config: string; updated_at: number };
    expect(after).toEqual(before);
    db.close();
  });

  test('resolves templateKeys case-sensitively through the same seams as spawn', () => {
    const db = createMigrationDb();
    new SpaceAgentTemplateRepository(db).create({
      key: 'migrated.agent.agent-1',
      handle: 'coder',
      displayName: 'Coder',
    });
    insertWorkflow(db, 'wf-1', 'space-1', 'Flow');
    insertNodeWithSlots(db, 'node-1', 'wf-1', [
      { agentId: 'agent-1', templateKey: 'MIGRATED.AGENT.AGENT-1', name: 'coder' },
    ]);

    runMigration231(db);

    expect(readSlots(db, 'node-1')).toEqual([
      { agentId: 'agent-1', templateKey: 'MIGRATED.AGENT.AGENT-1', name: 'coder' },
    ]);
    db.close();
  });

  test('rewrites post-approval targetAgent UUIDs to the cleared slot name', () => {
    const db = createMigrationDb();
    new SpaceAgentTemplateRepository(db).create({
      key: 'migrated.agent.agent-1',
      handle: 'coder',
      displayName: 'Coder',
    });
    insertWorkflow(db, 'wf-1', 'space-1', 'Flow');
    db.prepare(`UPDATE space_workflows SET post_approval = ? WHERE id = 'wf-1'`).run(
      JSON.stringify({ targetAgent: 'agent-1', instructions: 'merge the PR' })
    );
    insertNodeWithSlots(
      db,
      'node-1',
      'wf-1',
      [{ agentId: 'agent-1', templateKey: 'migrated.agent.agent-1', name: 'coder' }],
      { targetAgent: 'agent-1', instructions: 'merge the PR' }
    );

    runMigration231(db);

    const config = readNodeConfig(db, 'node-1');
    expect((config.agents[0] as { agentId: string }).agentId).toBe('');
    expect(config.postApproval?.targetAgent).toBe('coder');
    const workflowRoute = db
      .prepare(`SELECT post_approval FROM space_workflows WHERE id = 'wf-1'`)
      .get() as { post_approval: string };
    expect((JSON.parse(workflowRoute.post_approval) as { targetAgent: string }).targetAgent).toBe(
      'coder'
    );
    db.close();
  });

  test('rewrites a post-approval target on a node with no cleared slots', () => {
    const db = createMigrationDb();
    new SpaceAgentTemplateRepository(db).create({
      key: 'migrated.agent.agent-1',
      handle: 'coder',
      displayName: 'Coder',
    });
    insertWorkflow(db, 'wf-1', 'space-1', 'Flow');
    insertNodeWithSlots(
      db,
      'node-1',
      'wf-1',
      [{ agentId: 'agent-1', templateKey: 'migrated.agent.agent-1', name: 'coder' }],
      { targetAgent: 'coder', instructions: 'same node' }
    );
    insertNodeWithSlots(
      db,
      'node-2',
      'wf-1',
      [{ agentId: '', templateKey: 'coordinator.default', name: 'coordinator' }],
      { targetAgent: 'agent-1', instructions: 'cross node' }
    );

    runMigration231(db);

    const node2 = readNodeConfig(db, 'node-2');
    expect(node2.postApproval?.targetAgent).toBe('coder');
    expect((node2.agents[0] as { agentId: string }).agentId).toBe('');
    db.close();
  });

  test('leaves a UUID targetAgent alone when it matches no cleared slot', () => {
    const db = createMigrationDb();
    new SpaceAgentTemplateRepository(db).create({
      key: 'migrated.agent.agent-1',
      handle: 'coder',
      displayName: 'Coder',
    });
    insertWorkflow(db, 'wf-1', 'space-1', 'Flow');
    db.prepare(`UPDATE space_workflows SET post_approval = ? WHERE id = 'wf-1'`).run(
      JSON.stringify({ targetAgent: 'agent-unrelated', instructions: 'merge the PR' })
    );
    insertNodeWithSlots(
      db,
      'node-1',
      'wf-1',
      [{ agentId: 'agent-1', templateKey: 'migrated.agent.agent-1', name: 'coder' }],
      { targetAgent: 'agent-unrelated', instructions: 'merge the PR' }
    );

    runMigration231(db);

    expect(readNodeConfig(db, 'node-1').postApproval?.targetAgent).toBe('agent-unrelated');
    const workflowRoute = db
      .prepare(`SELECT post_approval FROM space_workflows WHERE id = 'wf-1'`)
      .get() as { post_approval: string };
    expect((JSON.parse(workflowRoute.post_approval) as { targetAgent: string }).targetAgent).toBe(
      'agent-unrelated'
    );
    db.close();
  });

  test('rebinds pinned definitions while preserving recorded execution identity', () => {
    const db = createMigrationDb();
    createRunTables(db);
    insertWorkflow(db, 'wf-pin', 'space-1', 'Pinned Flow');
    insertLongHorizonAgent(db, { id: 'agent-pin', spaceId: 'space-1', displayName: 'Pin' });
    const pinnedPayload = JSON.stringify({
      id: 'wf-pin',
      spaceId: 'space-1',
      name: 'Pinned Flow',
      nodes: [
        {
          id: 'node-pin',
          name: 'Pin',
          agents: [{ agentId: 'agent-pin', name: 'pin' }],
          postApproval: { targetAgent: 'agent-pin', instructions: 'merge the PR' },
        },
      ],
      channels: [],
      startNodeId: 'node-pin',
      endNodeId: 'node-pin',
      postApproval: { targetAgent: 'agent-pin', instructions: 'merge the PR' },
    });
    db.prepare(
      `INSERT INTO space_workflow_definition_versions (workflow_id, version_hash, space_id, payload, source, created_at)
       VALUES ('wf-pin', 'hash-old', 'space-1', ?, 'backfill', 1)`
    ).run(pinnedPayload);
    db.prepare(
      `INSERT INTO space_workflow_runs (id, space_id, workflow_id, definition_version, title, description, status, created_at, updated_at)
       VALUES ('run-1', 'space-1', 'wf-pin', 'hash-old', 'Run 1', '', 'in_progress', 1, 1)`
    ).run();
    db.prepare(
      `INSERT INTO node_executions (id, workflow_run_id, workflow_node_id, agent_name, agent_id, status, created_at, updated_at)
       VALUES ('exec-1', 'run-1', 'node-pin', 'pin', 'agent-pin', 'in_progress', 1, 1)`
    ).run();

    runMigration231(db);

    const run = db
      .prepare(`SELECT definition_version FROM space_workflow_runs WHERE id = 'run-1'`)
      .get() as { definition_version: string };
    expect(run.definition_version).not.toBe('hash-old');
    const version = db
      .prepare(
        `SELECT payload FROM space_workflow_definition_versions WHERE workflow_id = 'wf-pin' AND version_hash = ?`
      )
      .get(run.definition_version) as { payload: string };
    const payload = JSON.parse(version.payload) as {
      nodes: Array<{
        agents: Array<Record<string, unknown>>;
        postApproval: { targetAgent: string };
      }>;
      postApproval: { targetAgent: string };
    };
    expect(payload.nodes[0].agents[0]).toEqual({
      agentId: '',
      templateKey: 'migrated.agent.agent-pin',
      name: 'pin',
    });
    expect(payload.nodes[0].postApproval.targetAgent).toBe('pin');
    expect(payload.postApproval.targetAgent).toBe('pin');
    const execution = db
      .prepare(`SELECT agent_id FROM node_executions WHERE id = 'exec-1'`)
      .get() as { agent_id: string | null };
    expect(execution.agent_id).toBe('agent-pin');
    expect(
      new SpaceAgentTemplateRepository(db).getByKey('migrated.agent.agent-pin')
    ).not.toBeNull();
    db.close();
  });

  test('does not reuse an explicit templateKey when synthesizing for a bare agentId slot', () => {
    const db = createMigrationDb();
    createRunTables(db);
    insertWorkflow(db, 'wf-pin', 'space-1', 'Pinned Flow');
    const pinnedPayload = JSON.stringify({
      id: 'wf-pin',
      spaceId: 'space-1',
      name: 'Pinned Flow',
      nodes: [
        {
          id: 'node-a',
          name: 'Coord',
          agents: [{ agentId: 'agent-x', templateKey: 'coordinator.default', name: 'coordinator' }],
        },
        {
          id: 'node-b',
          name: 'Write',
          agents: [{ agentId: 'agent-x', name: 'writer' }],
        },
      ],
      channels: [],
      startNodeId: 'node-a',
      endNodeId: 'node-b',
    });
    db.prepare(
      `INSERT INTO space_workflow_definition_versions (workflow_id, version_hash, space_id, payload, source, created_at)
       VALUES ('wf-pin', 'hash-old', 'space-1', ?, 'backfill', 1)`
    ).run(pinnedPayload);
    db.prepare(
      `INSERT INTO space_workflow_runs (id, space_id, workflow_id, definition_version, title, description, status, created_at, updated_at)
       VALUES ('run-1', 'space-1', 'wf-pin', 'hash-old', 'Run 1', '', 'in_progress', 1, 1)`
    ).run();

    runMigration231(db);

    const run = db
      .prepare(`SELECT definition_version FROM space_workflow_runs WHERE id = 'run-1'`)
      .get() as { definition_version: string };
    const version = db
      .prepare(
        `SELECT payload FROM space_workflow_definition_versions WHERE workflow_id = 'wf-pin' AND version_hash = ?`
      )
      .get(run.definition_version) as { payload: string };
    const payload = JSON.parse(version.payload) as {
      nodes: Array<{ agents: Array<Record<string, unknown>> }>;
    };
    expect(payload.nodes[0].agents[0]).toEqual({
      agentId: '',
      templateKey: 'coordinator.default',
      name: 'coordinator',
    });
    expect(payload.nodes[1].agents[0]).toEqual({
      agentId: '',
      templateKey: 'migrated.agent.agent-x',
      name: 'writer',
    });
    expect(new SpaceAgentTemplateRepository(db).getByKey('migrated.agent.agent-x')).not.toBeNull();
    db.close();
  });

  test('leaves pinned runs untouched when the referenced agent cannot be templated', () => {
    const db = createMigrationDb();
    createRunTables(db);
    insertWorkflow(db, 'wf-pin', 'space-1', 'Pinned Flow');
    insertSpace(db, 'space-other');
    insertLongHorizonAgent(db, {
      id: 'agent-foreign',
      spaceId: 'space-other',
      displayName: 'Foreign',
    });
    const pinnedPayload = JSON.stringify({
      id: 'wf-pin',
      spaceId: 'space-1',
      name: 'Pinned Flow',
      nodes: [{ id: 'node-pin', name: 'Pin', agents: [{ agentId: 'agent-foreign', name: 'pin' }] }],
      channels: [],
      startNodeId: 'node-pin',
      endNodeId: 'node-pin',
    });
    db.prepare(
      `INSERT INTO space_workflow_definition_versions (workflow_id, version_hash, space_id, payload, source, created_at)
       VALUES ('wf-pin', 'hash-old', 'space-1', ?, 'backfill', 1)`
    ).run(pinnedPayload);
    db.prepare(
      `INSERT INTO space_workflow_runs (id, space_id, workflow_id, definition_version, title, description, status, created_at, updated_at)
       VALUES ('run-1', 'space-1', 'wf-pin', 'hash-old', 'Run 1', '', 'in_progress', 1, 1)`
    ).run();
    db.prepare(
      `INSERT INTO node_executions (id, workflow_run_id, workflow_node_id, agent_name, agent_id, status, created_at, updated_at)
       VALUES ('exec-1', 'run-1', 'node-pin', 'pin', 'agent-foreign', 'in_progress', 1, 1)`
    ).run();

    runMigration231(db);

    const run = db
      .prepare(`SELECT definition_version FROM space_workflow_runs WHERE id = 'run-1'`)
      .get() as { definition_version: string };
    expect(run.definition_version).toBe('hash-old');
    const execution = db
      .prepare(`SELECT agent_id FROM node_executions WHERE id = 'exec-1'`)
      .get() as { agent_id: string | null };
    expect(execution.agent_id).toBe('agent-foreign');
    expect(
      new SpaceAgentTemplateRepository(db).getByKey('migrated.agent.agent-foreign')
    ).toBeNull();
    db.close();
  });
});

function createRunTables(db: BunDatabase): void {
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
}

function insertLongHorizonAgent(
  db: BunDatabase,
  seed: { id: string; spaceId: string; displayName: string }
): void {
  const now = Date.now();
  db.prepare(
    `INSERT INTO space_long_horizon_agents (
       id, space_id, handle, display_name, template_key, status, session_id, instructions,
       autonomy_level, model, thinking_level, provider, setting_sources,
       tool_permissions_json, description, model_pool, created_at, updated_at
     ) VALUES (?, ?, ?, ?, NULL, 'active', NULL, '', NULL, NULL, NULL, NULL, NULL, '{}', NULL, NULL, ?, ?)`
  ).run(seed.id, seed.spaceId, seed.displayName.toLowerCase(), seed.displayName, now, now);
}
