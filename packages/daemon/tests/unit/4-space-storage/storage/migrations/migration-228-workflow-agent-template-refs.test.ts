import { describe, expect, test } from 'bun:test';
import type { SpaceLongHorizonAgent, SpaceWorkerAgent } from '@hyperneo/shared';
import { Database as BunDatabase } from '../../../../../src/storage/sqlite-compat.ts';
import { runMigration225 } from '../../../../../src/storage/schema/m225-space-agent-templates.ts';
import { runMigration226 } from '../../../../../src/storage/schema/m226-space-agent-templates-version.ts';
import { runMigration227 } from '../../../../../src/storage/schema/m227-space-agent-template-version-seq.ts';
import { runMigration228 } from '../../../../../src/storage/schema/m228-migrate-workflow-agent-template-refs.ts';
import { SpaceAgentTemplateRepository } from '../../../../../src/storage/repositories/space-agent-template-repository.ts';
import {
  createSpaceAgentSchema,
  insertSpace,
  insertWorkflow,
} from '../../../helpers/space-agent-schema.ts';
import { migratedAgentTemplateKey } from '../../../../../src/lib/space/agents/agent-template-synthesis.ts';
import { longHorizonAgentToWorkerView } from '../../../../../src/lib/space/agents/worker-long-horizon-mapper.ts';
import {
  resolveNodeAgentConfig,
  spaceAgentTemplateToNodeSource,
} from '../../../../../src/lib/space/runtime/spawn-slot-resolution.ts';

interface LongHorizonAgentSeed {
  id: string;
  spaceId?: string;
  handle: string;
  displayName: string;
  description?: string | null;
  instructions: string;
  autonomyLevel?: number | null;
  model?: string | null;
  thinkingLevel?: string | null;
  provider?: string | null;
  settingSources?: string | null;
  toolPermissionsJson?: string;
  modelPool?: string | null;
  status?: string;
  templateKey?: string | null;
}

function insertLongHorizonAgent(db: BunDatabase, seed: LongHorizonAgentSeed): void {
  const now = Date.now();
  db.prepare(
    `INSERT INTO space_long_horizon_agents (
       id, space_id, handle, display_name, template_key, status, session_id, instructions,
       autonomy_level, model, thinking_level, provider, setting_sources,
       tool_permissions_json, description, model_pool, created_at, updated_at
     ) VALUES (?, ?, ?, ?, ?, ?, NULL, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    seed.id,
    seed.spaceId ?? 'space-1',
    seed.handle,
    seed.displayName,
    seed.templateKey ?? null,
    seed.status ?? 'active',
    seed.instructions,
    seed.autonomyLevel ?? null,
    seed.model ?? null,
    seed.thinkingLevel ?? null,
    seed.provider ?? null,
    seed.settingSources ?? null,
    seed.toolPermissionsJson ?? '{}',
    seed.description ?? null,
    seed.modelPool ?? null,
    now,
    now
  );
}

function insertNodeWithConfig(
  db: BunDatabase,
  nodeId: string,
  workflowId: string,
  config: unknown
): void {
  const now = Date.now();
  db.prepare(
    `INSERT INTO space_workflow_nodes (id, workflow_id, name, description, config, created_at, updated_at)
     VALUES (?, ?, ?, '', ?, ?, ?)`
  ).run(nodeId, workflowId, nodeId, JSON.stringify(config), now, now);
}

function readNodeConfig(db: BunDatabase, nodeId: string): Record<string, unknown> {
  const row = db.prepare(`SELECT config FROM space_workflow_nodes WHERE id = ?`).get(nodeId) as {
    config: string;
  };
  return JSON.parse(row.config) as Record<string, unknown>;
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
  db.exec(`
    CREATE TABLE space_tasks (
      id TEXT PRIMARY KEY,
      workflow_run_id TEXT,
      archived_at INTEGER
    )
  `);
}

describe('migration 228: workflow agentId refs to templateKey', () => {
  test('synthesizes a template from the referenced long-horizon agent and rewrites the binding', () => {
    const db = createMigrationDb();
    insertLongHorizonAgent(db, {
      id: 'agent-live',
      handle: 'researcher',
      displayName: 'Researcher',
      description: 'Does the reading.',
      instructions: 'Research base contract',
      autonomyLevel: 4,
      model: 'claude-opus-5',
      thinkingLevel: 'think8k',
      provider: 'anthropic',
      settingSources: '["project"]',
      toolPermissionsJson: '{"tools":["Read","Grep"]}',
      modelPool: '[{"model":"claude-sonnet-5","maxConcurrent":1,"weight":1}]',
    });
    insertWorkflow(db, 'wf-1', 'space-1', 'Research Flow');
    insertNodeWithConfig(db, 'node-1', 'wf-1', {
      agents: [{ agentId: 'agent-live', name: 'researcher' }],
      postApproval: { targetAgent: 'researcher', instructions: 'Merge it.' },
    });

    runMigration228(db);

    const repo = new SpaceAgentTemplateRepository(db);
    const template = repo.getByKey(migratedAgentTemplateKey('agent-live'));
    expect(template).not.toBeNull();
    expect(template?.handle).toBe('researcher');
    expect(template?.displayName).toBe('Researcher');
    expect(template?.description).toBe('Does the reading.');
    expect(template?.instructions).toBe('Research base contract');
    expect(template?.suggestedAutonomyLevel).toBe(4);
    expect(template?.model).toBe('claude-opus-5');
    expect(template?.provider).toBe('anthropic');
    expect(template?.thinkingLevel).toBe('think8k');
    expect(template?.settingSources).toEqual(['project']);
    expect(template?.tools).toEqual(['Read', 'Grep']);
    expect(template?.modelPool).toEqual([
      { model: 'claude-sonnet-5', maxConcurrent: 1, weight: 1 },
    ]);

    const config = readNodeConfig(db, 'node-1');
    expect(config.agents).toEqual([
      { agentId: 'agent-live', name: 'researcher', templateKey: 'migrated.agent.agent-live' },
    ]);
    expect(config.postApproval).toEqual({ targetAgent: 'researcher', instructions: 'Merge it.' });
    db.close();
  });

  test('resolves slot resolution through the migrated template equivalently to the registry agent', () => {
    const db = createMigrationDb();
    insertLongHorizonAgent(db, {
      id: 'agent-equiv',
      handle: 'equiv-agent',
      displayName: 'Equiv Agent',
      description: 'Equivalence probe.',
      instructions: 'Registry base contract',
      model: 'claude-opus-5',
      thinkingLevel: 'think8k',
      provider: 'anthropic',
      settingSources: '["user"]',
      toolPermissionsJson: '{"tools":["Read"]}',
      modelPool: '[{"model":"claude-sonnet-5","maxConcurrent":1,"weight":2}]',
    });
    insertWorkflow(db, 'wf-equiv', 'space-1', 'Equivalence Flow');
    insertNodeWithConfig(db, 'node-equiv', 'wf-equiv', {
      agents: [{ agentId: 'agent-equiv', name: 'equiv' }],
    });

    runMigration228(db);

    const repo = new SpaceAgentTemplateRepository(db);
    const stored = repo.getByKey(migratedAgentTemplateKey('agent-equiv'));
    expect(stored).not.toBeNull();
    const viaTemplate = resolveNodeAgentConfig(
      spaceAgentTemplateToNodeSource(stored!),
      { agentId: 'agent-equiv', name: 'equiv', model: 'node-model' },
      []
    );
    const unified: SpaceLongHorizonAgent = {
      id: 'agent-equiv',
      spaceId: 'space-1',
      handle: 'equiv-agent',
      displayName: 'Equiv Agent',
      templateKey: null,
      status: 'active',
      sessionId: null,
      instructions: 'Registry base contract',
      autonomyLevel: null,
      model: 'claude-opus-5',
      thinkingLevel: 'think8k',
      provider: 'anthropic',
      settingSources: ['user'],
      toolPermissions: { tools: ['Read'] },
      modelPool: [{ model: 'claude-sonnet-5', maxConcurrent: 1, weight: 2 }],
      description: 'Equivalence probe.',
      createdAt: 1,
      updatedAt: 1,
    };
    const registryAgent: SpaceWorkerAgent = longHorizonAgentToWorkerView(unified);
    const viaRegistry = resolveNodeAgentConfig(
      null,
      { agentId: 'agent-equiv', name: 'equiv', model: 'node-model' },
      [registryAgent]
    );

    expect(viaTemplate?.source).toBe('template');
    expect(viaRegistry?.source).toBe('agent');
    expect(viaTemplate?.agent.name).toBe(viaRegistry?.agent.name);
    expect(viaTemplate?.agent.model).toBe(viaRegistry?.agent.model);
    expect(viaTemplate?.agent.thinkingLevel).toBe(viaRegistry?.agent.thinkingLevel);
    expect(viaTemplate?.agent.provider).toBe(viaRegistry?.agent.provider);
    expect(viaTemplate?.agent.handle).toBe(viaRegistry?.agent.handle);
    expect(viaTemplate?.agent.customPrompt).toBe(viaRegistry?.agent.customPrompt);
    expect(viaTemplate?.agent.tools).toEqual(viaRegistry?.agent.tools);
    expect(viaTemplate?.agent.modelPool).toEqual(viaRegistry?.agent.modelPool);
    expect(viaTemplate?.agent.settingSources ?? null).toEqual(
      viaRegistry?.agent.settingSources ?? null
    );
    expect(viaTemplate?.agent.description ?? '').toBe(viaRegistry?.agent.description ?? '');
    db.close();
  });

  test('generates a template from the slot config for orphaned agent refs', () => {
    const db = createMigrationDb();
    insertWorkflow(db, 'wf-orphan', 'space-1', 'Orphan Flow');
    insertNodeWithConfig(db, 'node-orphan', 'wf-orphan', {
      agents: [
        {
          agentId: 'agent-gone',
          name: 'ghost',
          model: 'claude-haiku-4-5',
          thinkingLevel: 'think8k',
          customPrompt: { value: 'Ghost base contract' },
        },
      ],
    });

    runMigration228(db);

    const repo = new SpaceAgentTemplateRepository(db);
    const template = repo.getByKey(migratedAgentTemplateKey('agent-gone'));
    expect(template).not.toBeNull();
    expect(template?.displayName).toBe('ghost');
    expect(template?.handle).toBe('ghost');
    expect(template?.instructions).toBe('');
    expect(template?.model).toBe('claude-haiku-4-5');
    expect(template?.thinkingLevel).toBe('think8k');

    const config = readNodeConfig(db, 'node-orphan');
    expect(config.agents).toEqual([
      {
        agentId: 'agent-gone',
        name: 'ghost',
        model: 'claude-haiku-4-5',
        thinkingLevel: 'think8k',
        customPrompt: { value: 'Ghost base contract' },
        templateKey: 'migrated.agent.agent-gone',
      },
    ]);
    db.close();
  });

  test('shares one template across nodes referencing the same agent', () => {
    const db = createMigrationDb();
    insertLongHorizonAgent(db, {
      id: 'agent-shared',
      handle: 'shared-agent',
      displayName: 'Shared Agent',
      instructions: 'Shared base contract',
    });
    insertWorkflow(db, 'wf-shared', 'space-1', 'Shared Flow');
    insertWorkflow(db, 'wf-shared-2', 'space-1', 'Shared Flow Two');
    insertNodeWithConfig(db, 'node-a', 'wf-shared', {
      agents: [{ agentId: 'agent-shared', name: 'first' }],
    });
    insertNodeWithConfig(db, 'node-b', 'wf-shared-2', {
      agents: [
        { agentId: 'agent-other', name: 'other' },
        { agentId: 'agent-shared', name: 'second' },
      ],
    });

    runMigration228(db);

    const count = db
      .prepare(`SELECT COUNT(*) AS count FROM space_agent_templates WHERE key = ?`)
      .get(migratedAgentTemplateKey('agent-shared')) as { count: number };
    expect(count.count).toBe(1);
    expect(readNodeConfig(db, 'node-a').agents).toEqual([
      { agentId: 'agent-shared', name: 'first', templateKey: 'migrated.agent.agent-shared' },
    ]);
    expect(readNodeConfig(db, 'node-b').agents).toEqual([
      { agentId: 'agent-other', name: 'other', templateKey: 'migrated.agent.agent-other' },
      { agentId: 'agent-shared', name: 'second', templateKey: 'migrated.agent.agent-shared' },
    ]);
    db.close();
  });

  test('leaves slots that already carry a templateKey or no agentId untouched', () => {
    const db = createMigrationDb();
    insertWorkflow(db, 'wf-skip', 'space-1', 'Skip Flow');
    insertNodeWithConfig(db, 'node-skip', 'wf-skip', {
      agents: [
        { agentId: '', templateKey: 'coordinator.default', name: 'coordinator' },
        { agentId: 'agent-live', templateKey: 'migrated.agent.agent-live', name: 'done' },
        { agentId: '', name: 'blank' },
      ],
    });

    runMigration228(db);

    const config = readNodeConfig(db, 'node-skip');
    expect(config.agents).toEqual([
      { agentId: '', templateKey: 'coordinator.default', name: 'coordinator' },
      { agentId: 'agent-live', templateKey: 'migrated.agent.agent-live', name: 'done' },
      { agentId: '', name: 'blank' },
    ]);
    const templates = db.prepare(`SELECT COUNT(*) AS count FROM space_agent_templates`).get() as {
      count: number;
    };
    expect(templates.count).toBe(0);
    db.close();
  });

  test('leaves slots referencing inactive agents untouched', () => {
    const db = createMigrationDb();
    insertLongHorizonAgent(db, {
      id: 'agent-paused',
      handle: 'paused-agent',
      displayName: 'Paused Agent',
      instructions: 'Paused base contract',
      status: 'paused',
    });
    insertWorkflow(db, 'wf-paused', 'space-1', 'Paused Flow');
    insertNodeWithConfig(db, 'node-paused', 'wf-paused', {
      agents: [{ agentId: 'agent-paused', name: 'paused' }],
    });

    runMigration228(db);

    const repo = new SpaceAgentTemplateRepository(db);
    expect(repo.getByKey(migratedAgentTemplateKey('agent-paused'))).toBeNull();
    expect(readNodeConfig(db, 'node-paused').agents).toEqual([
      { agentId: 'agent-paused', name: 'paused' },
    ]);
    db.close();
  });

  test('still migrates archived legacy workers copied by migration 223', () => {
    const db = createMigrationDb();
    insertLongHorizonAgent(db, {
      id: 'agent-legacy-worker',
      handle: 'legacy-archived',
      displayName: 'Legacy Archived Worker',
      instructions: 'Legacy worker contract',
      status: 'archived',
      templateKey: 'migration.legacy_space_agent',
    });
    insertWorkflow(db, 'wf-legacy', 'space-1', 'Legacy Flow');
    insertNodeWithConfig(db, 'node-legacy', 'wf-legacy', {
      agents: [{ agentId: 'agent-legacy-worker', name: 'legacy' }],
    });

    runMigration228(db);

    const repo = new SpaceAgentTemplateRepository(db);
    const template = repo.getByKey(migratedAgentTemplateKey('agent-legacy-worker'));
    expect(template?.displayName).toBe('Legacy Archived Worker');
    expect(readNodeConfig(db, 'node-legacy').agents).toEqual([
      {
        agentId: 'agent-legacy-worker',
        name: 'legacy',
        templateKey: 'migrated.agent.agent-legacy-worker',
      },
    ]);
    db.close();
  });

  test('leaves cross-space references untouched', () => {
    const db = createMigrationDb();
    insertSpace(db, 'space-2');
    insertLongHorizonAgent(db, {
      id: 'agent-foreign',
      spaceId: 'space-2',
      handle: 'foreign-agent',
      displayName: 'Foreign Agent',
      instructions: 'Foreign base contract',
    });
    insertWorkflow(db, 'wf-foreign', 'space-1', 'Foreign Flow');
    insertNodeWithConfig(db, 'node-foreign', 'wf-foreign', {
      agents: [
        { agentId: 'agent-foreign', name: 'foreign', customPrompt: { value: 'Slot prompt' } },
      ],
    });

    runMigration228(db);

    const repo = new SpaceAgentTemplateRepository(db);
    expect(repo.getByKey(migratedAgentTemplateKey('agent-foreign'))).toBeNull();
    expect(readNodeConfig(db, 'node-foreign').agents).toEqual([
      { agentId: 'agent-foreign', name: 'foreign', customPrompt: { value: 'Slot prompt' } },
    ]);
    db.close();
  });

  test('preserves an empty settingSources array as disable-all', () => {
    const db = createMigrationDb();
    insertLongHorizonAgent(db, {
      id: 'agent-empty-sources',
      handle: 'quiet-agent',
      displayName: 'Quiet Agent',
      instructions: 'Quiet base contract',
      settingSources: '[]',
    });
    insertWorkflow(db, 'wf-quiet', 'space-1', 'Quiet Flow');
    insertNodeWithConfig(db, 'node-quiet', 'wf-quiet', {
      agents: [{ agentId: 'agent-empty-sources', name: 'quiet' }],
    });

    runMigration228(db);

    const repo = new SpaceAgentTemplateRepository(db);
    expect(repo.getByKey(migratedAgentTemplateKey('agent-empty-sources'))?.settingSources).toEqual(
      []
    );
    db.close();
  });

  test('is idempotent when run twice', () => {
    const db = createMigrationDb();
    insertLongHorizonAgent(db, {
      id: 'agent-once',
      handle: 'once-agent',
      displayName: 'Once Agent',
      instructions: 'Once base contract',
    });
    insertWorkflow(db, 'wf-once', 'space-1', 'Once Flow');
    insertNodeWithConfig(db, 'node-once', 'wf-once', {
      agents: [{ agentId: 'agent-once', name: 'once' }],
    });

    runMigration228(db);
    const configAfterFirst = readNodeConfig(db, 'node-once');
    runMigration228(db);

    const count = db.prepare(`SELECT COUNT(*) AS count FROM space_agent_templates`).get() as {
      count: number;
    };
    expect(count.count).toBe(1);
    expect(readNodeConfig(db, 'node-once')).toEqual(configAfterFirst);
    db.close();
  });

  test('skips nodes with malformed config JSON without failing the migration', () => {
    const db = createMigrationDb();
    insertWorkflow(db, 'wf-bad', 'space-1', 'Bad Flow');
    const now = Date.now();
    db.prepare(
      `INSERT INTO space_workflow_nodes (id, workflow_id, name, description, config, created_at, updated_at)
       VALUES ('node-bad', 'wf-bad', 'node-bad', '', '{not json', ?, ?)`
    ).run(now, now);
    insertNodeWithConfig(db, 'node-good', 'wf-bad', {
      agents: [{ agentId: 'agent-good', name: 'good' }],
    });

    runMigration228(db);

    const raw = db
      .prepare(`SELECT config FROM space_workflow_nodes WHERE id = 'node-bad'`)
      .get() as { config: string };
    expect(raw.config).toBe('{not json');
    expect(readNodeConfig(db, 'node-good').agents).toEqual([
      { agentId: 'agent-good', name: 'good', templateKey: 'migrated.agent.agent-good' },
    ]);
    db.close();
  });

  test('is a no-op when workflow tables are absent', () => {
    const db = new BunDatabase(':memory:');
    runMigration225(db);
    runMigration226(db);
    runMigration227(db);

    runMigration228(db);

    const count = db.prepare(`SELECT COUNT(*) AS count FROM space_agent_templates`).get() as {
      count: number;
    };
    expect(count.count).toBe(0);
    db.close();
  });

  test('skips null and non-object entries in the agents array', () => {
    const db = createMigrationDb();
    insertWorkflow(db, 'wf-junk', 'space-1', 'Junk Flow');
    insertNodeWithConfig(db, 'node-junk', 'wf-junk', {
      agents: [null, 'garbage', { agentId: 'agent-junk-ok', name: 'ok' }, 42],
    });

    runMigration228(db);

    const config = readNodeConfig(db, 'node-junk');
    expect(config.agents).toEqual([
      null,
      'garbage',
      { agentId: 'agent-junk-ok', name: 'ok', templateKey: 'migrated.agent.agent-junk-ok' },
      42,
    ]);
    db.close();
  });

  test('does not bind to an unrelated user template colliding with the migrated key', () => {
    const db = createMigrationDb();
    const repo = new SpaceAgentTemplateRepository(db);
    repo.create({
      key: migratedAgentTemplateKey('agent-collide'),
      handle: 'user-made',
      displayName: 'User Made',
      instructions: 'User authored content',
    });
    insertLongHorizonAgent(db, {
      id: 'agent-collide',
      handle: 'collide-agent',
      displayName: 'Real Agent',
      instructions: 'Real agent contract',
    });
    insertWorkflow(db, 'wf-collide', 'space-1', 'Collide Flow');
    insertNodeWithConfig(db, 'node-collide', 'wf-collide', {
      agents: [{ agentId: 'agent-collide', name: 'collide' }],
    });

    runMigration228(db);

    const userTemplate = repo.getByKey(migratedAgentTemplateKey('agent-collide'));
    expect(userTemplate?.instructions).toBe('User authored content');
    const synthesized = repo.getByKey(`${migratedAgentTemplateKey('agent-collide')}.m228`);
    expect(synthesized?.displayName).toBe('Real Agent');
    expect(synthesized?.instructions).toBe('Real agent contract');
    expect(readNodeConfig(db, 'node-collide').agents).toEqual([
      {
        agentId: 'agent-collide',
        name: 'collide',
        templateKey: 'migrated.agent.agent-collide.m228',
      },
    ]);
    db.close();
  });

  test('probes past further key collisions without binding to unrelated templates', () => {
    const db = createMigrationDb();
    const repo = new SpaceAgentTemplateRepository(db);
    repo.create({
      key: migratedAgentTemplateKey('agent-collide'),
      handle: 'user-made',
      displayName: 'User Made',
      instructions: 'User authored content',
    });
    repo.create({
      key: `${migratedAgentTemplateKey('agent-collide')}.m228`,
      handle: 'user-made-2',
      displayName: 'User Made Too',
      instructions: 'More user content',
    });
    insertLongHorizonAgent(db, {
      id: 'agent-collide',
      handle: 'collide-agent',
      displayName: 'Real Agent',
      instructions: 'Real agent contract',
    });
    insertWorkflow(db, 'wf-collide-2', 'space-1', 'Collide Flow Two');
    insertNodeWithConfig(db, 'node-collide-2', 'wf-collide-2', {
      agents: [{ agentId: 'agent-collide', name: 'collide' }],
    });

    runMigration228(db);

    const synthesized = repo.getByKey(`${migratedAgentTemplateKey('agent-collide')}.m228-2`);
    expect(synthesized?.displayName).toBe('Real Agent');
    expect(readNodeConfig(db, 'node-collide-2').agents).toEqual([
      {
        agentId: 'agent-collide',
        name: 'collide',
        templateKey: 'migrated.agent.agent-collide.m228-2',
      },
    ]);
    db.close();
  });

  test('pins unpinned executable runs to the pre-migration definition before rewriting', () => {
    const db = createMigrationDb();
    createRunTables(db);
    insertLongHorizonAgent(db, {
      id: 'agent-pin',
      handle: 'pin-agent',
      displayName: 'Pin Agent',
      instructions: 'Pin base contract',
    });
    insertWorkflow(db, 'wf-pin', 'space-1', 'Pin Flow');
    insertNodeWithConfig(db, 'node-pin', 'wf-pin', {
      agents: [{ agentId: 'agent-pin', name: 'pin' }],
    });
    db.prepare(
      `INSERT INTO space_workflow_runs (id, space_id, workflow_id, definition_version, status, created_at, updated_at)
       VALUES ('run-pin', 'space-1', 'wf-pin', NULL, 'in_progress', 1, 1)`
    ).run();
    db.prepare(
      `INSERT INTO space_tasks (id, workflow_run_id, archived_at) VALUES ('task-pin', 'run-pin', NULL)`
    ).run();
    db.prepare(
      `INSERT INTO space_workflow_runs (id, space_id, workflow_id, definition_version, status, created_at, updated_at)
       VALUES ('run-no-task', 'space-1', 'wf-pin', NULL, 'pending', 1, 1)`
    ).run();

    runMigration228(db);

    const run = db
      .prepare(`SELECT definition_version FROM space_workflow_runs WHERE id = 'run-pin'`)
      .get() as { definition_version: string | null };
    expect(run.definition_version).not.toBeNull();

    const runWithoutTask = db
      .prepare(`SELECT definition_version FROM space_workflow_runs WHERE id = 'run-no-task'`)
      .get() as { definition_version: string | null };
    expect(runWithoutTask.definition_version).toBe(run.definition_version);

    const pinned = db
      .prepare(
        `SELECT payload FROM space_workflow_definition_versions
          WHERE workflow_id = 'wf-pin' AND version_hash = ?`
      )
      .get(run.definition_version) as { payload: string };
    const pinnedNodes = (JSON.parse(pinned.payload) as { nodes: { agents: unknown[] }[] }).nodes;
    expect(pinnedNodes[0].agents[0]).toEqual({ agentId: 'agent-pin', name: 'pin' });

    expect(readNodeConfig(db, 'node-pin').agents).toEqual([
      { agentId: 'agent-pin', name: 'pin', templateKey: 'migrated.agent.agent-pin' },
    ]);
    db.close();
  });

  test('leaves workflows whose active runs cannot be pinned fully unrewritten', () => {
    const db = createMigrationDb();
    createRunTables(db);
    insertWorkflow(db, 'wf-malformed', 'space-1', 'Malformed Flow');
    insertWorkflow(db, 'wf-healthy', 'space-1', 'Healthy Flow');
    insertLongHorizonAgent(db, {
      id: 'agent-healthy',
      handle: 'healthy-agent',
      displayName: 'Healthy Agent',
      instructions: 'Healthy base contract',
    });
    insertNodeWithConfig(db, 'node-malformed', 'wf-malformed', {
      agents: [null, { agentId: 'agent-healthy', name: 'ok' }],
    });
    insertNodeWithConfig(db, 'node-healthy', 'wf-healthy', {
      agents: [{ agentId: 'agent-healthy', name: 'healthy' }],
    });
    db.prepare(
      `INSERT INTO space_workflow_runs (id, space_id, workflow_id, definition_version, status, created_at, updated_at)
       VALUES ('run-malformed', 'space-1', 'wf-malformed', NULL, 'in_progress', 1, 1)`
    ).run();
    db.prepare(
      `INSERT INTO space_tasks (id, workflow_run_id, archived_at) VALUES ('task-malformed', 'run-malformed', NULL)`
    ).run();

    runMigration228(db);

    const run = db
      .prepare(`SELECT definition_version FROM space_workflow_runs WHERE id = 'run-malformed'`)
      .get() as { definition_version: string | null };
    expect(run.definition_version).toBeNull();
    expect(readNodeConfig(db, 'node-malformed').agents).toEqual([
      null,
      { agentId: 'agent-healthy', name: 'ok' },
    ]);
    expect(readNodeConfig(db, 'node-healthy').agents).toEqual([
      { agentId: 'agent-healthy', name: 'healthy', templateKey: 'migrated.agent.agent-healthy' },
    ]);
    db.close();
  });
});
