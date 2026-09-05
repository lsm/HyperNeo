import { describe, expect, test } from 'bun:test';
import type { SpaceWorkerAgent } from '@hyperneo/shared';
import {
  resolveNodeAgentConfig,
  storedTemplateToNodeAgentSource,
} from '../../../../../src/lib/space/runtime/spawn-slot-resolution';
import { SpaceAgentTemplateRepository } from '../../../../../src/storage/repositories/space-agent-template-repository';
import { runMigration228 } from '../../../../../src/storage/schema/m228-migrate-workflow-agent-refs-to-templates.ts';
import { runMigrations } from '../../../../../src/storage/schema/migrations.ts';
import { Database as BunDatabase } from '../../../../../src/storage/sqlite-compat';

interface NodeRow {
  id: string;
  config: string | null;
}

function makeDb(): BunDatabase {
  const db = new BunDatabase(':memory:');
  runMigrations(db, () => {});
  return db;
}

function insertSpace(db: BunDatabase, id: string): void {
  db.prepare(
    `INSERT INTO spaces (id, slug, workspace_path, name, created_at, updated_at)
     VALUES (?, ?, ?, ?, 1000, 1000)`
  ).run(id, id, `/tmp/${id}`, id);
}

function insertAgent(
  db: BunDatabase,
  row: {
    id: string;
    spaceId: string;
    handle: string;
    displayName: string;
    instructions?: string;
    model?: string | null;
    provider?: string | null;
    thinkingLevel?: string | null;
    settingSources?: string | null;
    toolPermissionsJson?: string;
    modelPool?: string | null;
    description?: string | null;
    autonomyLevel?: number | null;
    status?: string;
    templateKey?: string | null;
  }
): void {
  db.prepare(
    `INSERT INTO space_long_horizon_agents (
       id, space_id, handle, display_name, template_key, status, session_id,
       instructions, autonomy_level, model, thinking_level, provider, setting_sources,
       tool_permissions_json, description, model_pool, created_at, updated_at
     ) VALUES (?, ?, ?, ?, ?, ?, NULL, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1000, 1000)`
  ).run(
    row.id,
    row.spaceId,
    row.handle,
    row.displayName,
    row.templateKey ?? null,
    row.status ?? 'active',
    row.instructions ?? '',
    row.autonomyLevel ?? null,
    row.model ?? null,
    row.thinkingLevel ?? null,
    row.provider ?? null,
    row.settingSources ?? null,
    row.toolPermissionsJson ?? '{}',
    row.description ?? null,
    row.modelPool ?? null
  );
}

function insertWorker(db: BunDatabase, id: string, spaceId: string): void {
  db.prepare(
    `INSERT INTO space_agents (id, space_id, name, handle, status, created_at, updated_at)
     VALUES (?, ?, ?, ?, 'active', 1000, 1000)`
  ).run(id, spaceId, id, id);
}

function insertWorkflowWithNode(
  db: BunDatabase,
  spaceId: string,
  nodeId: string,
  config: unknown
): void {
  db.prepare(
    `INSERT INTO space_workflows (id, space_id, name, start_node_id, end_node_id, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, 1000, 1000)`
  ).run(`wf-${nodeId}`, spaceId, `Workflow ${nodeId}`, nodeId, nodeId);
  db.prepare(
    `INSERT INTO space_workflow_nodes (id, workflow_id, name, config, created_at, updated_at)
     VALUES (?, ?, ?, ?, 1000, 1000)`
  ).run(nodeId, `wf-${nodeId}`, nodeId, JSON.stringify(config));
}

function nodeConfig(db: BunDatabase, nodeId: string): Record<string, unknown> {
  const row = db
    .prepare(`SELECT config FROM space_workflow_nodes WHERE id = ?`)
    .get(nodeId) as NodeRow;
  return JSON.parse((row.config ?? '{}') as string) as Record<string, unknown>;
}

function nodeExecutionAgentId(db: BunDatabase, nodeId: string, agentName: string): string | null {
  const row = db
    .prepare(`SELECT agent_id FROM node_executions WHERE workflow_node_id = ? AND agent_name = ?`)
    .get(nodeId, agentName) as { agent_id: string | null } | undefined;
  return row?.agent_id ?? null;
}

function insertWorkflowRun(
  db: BunDatabase,
  runId: string,
  spaceId: string,
  workflowId: string
): void {
  db.prepare(
    `INSERT INTO space_workflow_runs (id, space_id, workflow_id, title, status, created_at, updated_at)
     VALUES (?, ?, ?, 'Run', 'pending', 1000, 1000)`
  ).run(runId, spaceId, workflowId);
}

function insertNodeExecution(
  db: BunDatabase,
  nodeId: string,
  agentName: string,
  agentId: string | null
): void {
  db.prepare(
    `INSERT INTO node_executions (
       id, workflow_run_id, workflow_node_id, agent_name, agent_id, status,
       created_at, updated_at
     ) VALUES (?, 'run-1', ?, ?, ?, 'pending', 1000, 1000)`
  ).run(`exec-${nodeId}-${agentName}`, nodeId, agentName, agentId);
}

describe('migration 228: workflow agent refs to template keys', () => {
  test('synthesizes a template per referenced agent and rewrites the slot binding', () => {
    const db = makeDb();
    insertSpace(db, 'space-1');
    insertAgent(db, {
      id: 'agent-coder',
      spaceId: 'space-1',
      handle: 'coder',
      displayName: 'Coder',
      instructions: 'Write the code',
      model: 'claude-x',
      provider: 'anthropic',
      thinkingLevel: 'think8k',
      settingSources: JSON.stringify(['user']),
      toolPermissionsJson: JSON.stringify({ tools: ['Read', 'Bash'] }),
      modelPool: JSON.stringify([{ model: 'claude-x', maxConcurrent: 2, weight: 1 }]),
      description: 'Implementation worker',
      autonomyLevel: 3,
    });
    insertWorkflowWithNode(db, 'space-1', 'node-1', {
      agents: [{ agentId: 'agent-coder', name: 'coder', model: 'node-model' }],
    });

    runMigration228(db);

    const repo = new SpaceAgentTemplateRepository(db);
    const template = repo.getByKey('migrated.coder');
    expect(template).toEqual({
      key: 'migrated.coder',
      handle: 'coder',
      displayName: 'Coder',
      description: 'Implementation worker',
      instructions: 'Write the code',
      suggestedAutonomyLevel: 3,
      model: 'claude-x',
      provider: 'anthropic',
      modelPool: [{ model: 'claude-x', maxConcurrent: 2, weight: 1 }],
      thinkingLevel: 'think8k',
      settingSources: ['user'],
      tools: ['Read', 'Bash'],
      createdAt: expect.any(Number),
      updatedAt: expect.any(Number),
    });

    const slots = nodeConfig(db, 'node-1').agents as Array<Record<string, unknown>>;
    expect(slots[0].templateKey).toBe('migrated.coder');
    expect(slots[0].agentId).toBe('agent-coder');
    expect(slots[0].model).toBe('node-model');
    db.close();
  });

  test('generates a template for an orphaned agent ref', () => {
    const db = makeDb();
    insertSpace(db, 'space-1');
    insertWorkflowWithNode(db, 'space-1', 'node-1', {
      agents: [{ agentId: 'agent-gone', name: 'ghost' }],
    });

    runMigration228(db);

    const repo = new SpaceAgentTemplateRepository(db);
    const template = repo.getByKey('migrated.ghost');
    expect(template?.displayName).toBe('ghost');
    expect(template?.instructions).toBe('');
    expect(template?.model).toBeNull();
    expect(template?.tools).toBeNull();

    const slots = nodeConfig(db, 'node-1').agents as Array<Record<string, unknown>>;
    expect(slots[0].templateKey).toBe('migrated.ghost');
    expect(slots[0].agentId).toBe('agent-gone');
    db.close();
  });

  test('leaves slots bound to non-runnable agents on the agentId binding', () => {
    const db = makeDb();
    insertSpace(db, 'space-1');
    insertAgent(db, {
      id: 'agent-paused',
      spaceId: 'space-1',
      handle: 'sleeper',
      displayName: 'Sleeper',
      instructions: 'Rest',
      status: 'paused',
    });
    insertWorkflowWithNode(db, 'space-1', 'node-1', {
      agents: [{ agentId: 'agent-paused', name: 'sleeper' }],
    });
    insertWorkflowRun(db, 'run-1', 'space-1', 'wf-node-1');
    insertNodeExecution(db, 'node-1', 'sleeper', 'agent-paused');

    runMigration228(db);

    const repo = new SpaceAgentTemplateRepository(db);
    expect(repo.list().filter((t) => t.key.startsWith('migrated.'))).toEqual([]);
    const slots = nodeConfig(db, 'node-1').agents as Array<Record<string, unknown>>;
    expect(slots[0].templateKey).toBeUndefined();
    expect(slots[0].agentId).toBe('agent-paused');
    expect(nodeExecutionAgentId(db, 'node-1', 'sleeper')).toBe('agent-paused');
    db.close();
  });

  test('still migrates paused migrated-worker mirrors', () => {
    const db = makeDb();
    insertSpace(db, 'space-1');
    insertAgent(db, {
      id: 'agent-worker',
      spaceId: 'space-1',
      handle: 'worker',
      displayName: 'Worker',
      instructions: 'Labor',
      status: 'paused',
      templateKey: 'migration.legacy_space_agent',
    });
    insertWorker(db, 'agent-worker', 'space-1');
    insertWorkflowWithNode(db, 'space-1', 'node-1', {
      agents: [{ agentId: 'agent-worker', name: 'worker' }],
    });

    runMigration228(db);

    const repo = new SpaceAgentTemplateRepository(db);
    expect(repo.getByKey('migrated.worker')).not.toBeNull();
    const slots = nodeConfig(db, 'node-1').agents as Array<Record<string, unknown>>;
    expect(slots[0].templateKey).toBe('migrated.worker');
    db.close();
  });

  test('leaves orphaned migrated-worker mirrors on the agentId binding', () => {
    const db = makeDb();
    insertSpace(db, 'space-1');
    insertAgent(db, {
      id: 'agent-orphan-mirror',
      spaceId: 'space-1',
      handle: 'ghost-worker',
      displayName: 'Ghost Worker',
      instructions: 'Haunted',
      status: 'active',
      templateKey: 'migration.legacy_space_agent',
    });
    insertWorkflowWithNode(db, 'space-1', 'node-1', {
      agents: [{ agentId: 'agent-orphan-mirror', name: 'ghost' }],
    });

    runMigration228(db);

    const repo = new SpaceAgentTemplateRepository(db);
    expect(repo.list().filter((t) => t.key.startsWith('migrated.'))).toEqual([]);
    const slots = nodeConfig(db, 'node-1').agents as Array<Record<string, unknown>>;
    expect(slots[0].templateKey).toBeUndefined();
    expect(slots[0].agentId).toBe('agent-orphan-mirror');
    db.close();
  });

  test('reuses one template per agent across nodes and disambiguates handle collisions', () => {
    const db = makeDb();
    insertSpace(db, 'space-1');
    insertSpace(db, 'space-2');
    insertAgent(db, {
      id: 'agent-a',
      spaceId: 'space-1',
      handle: 'coder',
      displayName: 'Coder A',
      instructions: 'A',
    });
    insertAgent(db, {
      id: 'agent-b',
      spaceId: 'space-2',
      handle: 'coder',
      displayName: 'Coder B',
      instructions: 'B',
    });
    insertWorkflowWithNode(db, 'space-1', 'node-1', {
      agents: [{ agentId: 'agent-a', name: 'coder' }],
    });
    insertWorkflowWithNode(db, 'space-2', 'node-2', {
      agents: [
        { agentId: 'agent-b', name: 'coder' },
        { agentId: 'agent-a', name: 'peer' },
      ],
    });

    runMigration228(db);

    const repo = new SpaceAgentTemplateRepository(db);
    expect(repo.getByKey('migrated.coder')?.instructions).toBe('A');
    expect(repo.getByKey('migrated.coder.agentb')?.instructions).toBe('B');
    expect(repo.list().filter((t) => t.key.startsWith('migrated.')).length).toBe(2);

    const slots2 = nodeConfig(db, 'node-2').agents as Array<Record<string, unknown>>;
    expect(slots2[0].templateKey).toBe('migrated.coder.agentb');
    expect(slots2[1].templateKey).toBe('migrated.coder');
    db.close();
  });

  test('leaves template-bound and agentless slots untouched', () => {
    const db = makeDb();
    insertSpace(db, 'space-1');
    insertWorkflowWithNode(db, 'space-1', 'node-1', {
      agents: [
        { agentId: '', templateKey: 'coder.default', name: 'tpl' },
        { agentId: '', name: 'blank' },
      ],
    });
    const before = JSON.stringify(nodeConfig(db, 'node-1'));

    runMigration228(db);

    expect(JSON.stringify(nodeConfig(db, 'node-1'))).toBe(before);
    const repo = new SpaceAgentTemplateRepository(db);
    expect(repo.list().filter((t) => t.key.startsWith('migrated.'))).toEqual([]);
    db.close();
  });

  test('clears the recorded agent id on executions of migrated slots', () => {
    const db = makeDb();
    insertSpace(db, 'space-1');
    insertAgent(db, {
      id: 'agent-coder',
      spaceId: 'space-1',
      handle: 'coder',
      displayName: 'Coder',
      instructions: 'Write the code',
    });
    insertWorkflowWithNode(db, 'space-1', 'node-1', {
      agents: [
        { agentId: 'agent-coder', name: 'coder' },
        { agentId: 'agent-gone', name: 'ghost' },
      ],
    });
    insertAgent(db, {
      id: 'agent-other',
      spaceId: 'space-1',
      handle: 'other',
      displayName: 'Other',
      instructions: 'Unrelated',
    });
    insertWorkflowRun(db, 'run-1', 'space-1', 'wf-node-1');
    insertNodeExecution(db, 'node-1', 'coder', 'agent-coder');
    insertNodeExecution(db, 'node-1', 'ghost', null);
    insertNodeExecution(db, 'node-1', 'stranger', 'agent-other');

    runMigration228(db);

    expect(nodeExecutionAgentId(db, 'node-1', 'coder')).toBeNull();
    expect(nodeExecutionAgentId(db, 'node-1', 'ghost')).toBeNull();
    expect(nodeExecutionAgentId(db, 'node-1', 'stranger')).toBe('agent-other');
    db.close();
  });

  test('rolls back template creations and node rewrites when the migration fails mid-run', () => {
    const db = makeDb();
    insertSpace(db, 'space-1');
    insertAgent(db, {
      id: 'agent-coder',
      spaceId: 'space-1',
      handle: 'coder',
      displayName: 'Coder',
      instructions: 'Write the code',
    });
    insertWorkflowWithNode(db, 'space-1', 'node-1', {
      agents: [{ agentId: 'agent-coder', name: 'coder' }],
    });
    db.exec('DROP TABLE space_agent_template_version_seq');

    expect(() => runMigration228(db)).toThrow();

    const repo = new SpaceAgentTemplateRepository(db);
    expect(repo.list().filter((t) => t.key.startsWith('migrated.'))).toEqual([]);
    const slots = nodeConfig(db, 'node-1').agents as Array<Record<string, unknown>>;
    expect(slots[0].templateKey).toBeUndefined();
    expect(slots[0].agentId).toBe('agent-coder');
    db.close();
  });

  test('clears executions recorded under the agentId-normalized name of blank-named slots', () => {
    const db = makeDb();
    insertSpace(db, 'space-1');
    insertAgent(db, {
      id: 'agent-coder',
      spaceId: 'space-1',
      handle: 'coder',
      displayName: 'Coder',
      instructions: 'Write the code',
    });
    insertWorkflowWithNode(db, 'space-1', 'node-1', {
      agents: [{ agentId: 'agent-coder', name: '' }],
    });
    insertWorkflowRun(db, 'run-1', 'space-1', 'wf-node-1');
    insertNodeExecution(db, 'node-1', 'agent-coder', 'agent-coder');

    runMigration228(db);

    expect(nodeExecutionAgentId(db, 'node-1', 'agent-coder')).toBeNull();
    const slots = nodeConfig(db, 'node-1').agents as Array<Record<string, unknown>>;
    expect(slots[0].templateKey).toBe('migrated.coder');
    db.close();
  });

  test('is idempotent when run twice', () => {
    const db = makeDb();
    insertSpace(db, 'space-1');
    insertAgent(db, {
      id: 'agent-coder',
      spaceId: 'space-1',
      handle: 'coder',
      displayName: 'Coder',
      instructions: 'Write the code',
    });
    insertWorkflowWithNode(db, 'space-1', 'node-1', {
      agents: [{ agentId: 'agent-coder', name: 'coder' }],
    });

    runMigration228(db);
    const afterFirst = JSON.stringify(nodeConfig(db, 'node-1'));
    runMigration228(db);

    const repo = new SpaceAgentTemplateRepository(db);
    expect(repo.list().filter((t) => t.key.startsWith('migrated.'))).toHaveLength(1);
    expect(JSON.stringify(nodeConfig(db, 'node-1'))).toBe(afterFirst);
    db.close();
  });

  test('a migrated slot resolves the same spawn fields as the legacy agent binding', () => {
    const db = makeDb();
    insertSpace(db, 'space-1');
    insertAgent(db, {
      id: 'agent-coder',
      spaceId: 'space-1',
      handle: 'coder',
      displayName: 'Coder',
      instructions: 'Write the code',
      model: 'claude-x',
      thinkingLevel: 'think8k',
      settingSources: JSON.stringify(['user']),
      toolPermissionsJson: JSON.stringify({ tools: ['Read'] }),
      modelPool: JSON.stringify([{ model: 'claude-x', maxConcurrent: 2, weight: 1 }]),
    });
    insertWorkflowWithNode(db, 'space-1', 'node-1', {
      agents: [{ agentId: 'agent-coder', name: 'coder' }],
    });

    runMigration228(db);

    const stored = new SpaceAgentTemplateRepository(db).getByKey('migrated.coder');
    expect(stored).not.toBeNull();
    const viaTemplate = stored
      ? resolveNodeAgentConfig(storedTemplateToNodeAgentSource(stored), { name: 'coder' }, [])
      : null;

    const legacyAgent: SpaceWorkerAgent = {
      id: 'agent-coder',
      spaceId: 'space-1',
      name: 'Coder',
      handle: 'coder',
      customPrompt: 'Write the code',
      model: 'claude-x',
      thinkingLevel: 'think8k',
      settingSources: ['user'],
      tools: ['Read'],
      modelPool: [{ model: 'claude-x', maxConcurrent: 2, weight: 1 }],
      createdAt: 1000,
      updatedAt: 1000,
    };
    const viaAgent = resolveNodeAgentConfig(null, { agentId: 'agent-coder', name: 'coder' }, [
      legacyAgent,
    ]);

    expect(viaTemplate?.agent.customPrompt).toBe(viaAgent?.agent.customPrompt);
    expect(viaTemplate?.agent.model).toBe(viaAgent?.agent.model);
    expect(viaTemplate?.agent.thinkingLevel).toBe(viaAgent?.agent.thinkingLevel);
    expect(viaTemplate?.agent.settingSources).toEqual(viaAgent?.agent.settingSources);
    expect(viaTemplate?.agent.tools).toEqual(viaAgent?.agent.tools);
    expect(viaTemplate?.agent.modelPool).toEqual(viaAgent?.agent.modelPool);
    expect(viaTemplate?.source).toBe('template');
    expect(viaAgent?.source).toBe('agent');
    db.close();
  });
});
