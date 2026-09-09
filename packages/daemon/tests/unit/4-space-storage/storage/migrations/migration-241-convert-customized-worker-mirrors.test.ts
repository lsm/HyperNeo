import { describe, expect, test } from 'bun:test';
import type { SpaceWorkflow } from '@hyperneo/shared';
import {
  synthesizeWorkerCustomTemplate,
  workerCustomTemplateKey,
} from '../../../../../src/lib/space/agents/agent-template-synthesis.ts';
import { getPresetAgentTemplates } from '../../../../../src/lib/space/agents/seed-agents.ts';
import { MIGRATED_WORKER_TEMPLATE_KEY } from '../../../../../src/lib/space/agents/worker-long-horizon-mapper.ts';
import {
  computeDefinitionVersion,
  verifyDefinitionVersion,
} from '../../../../../src/lib/space/workflows/definition-version.ts';
import { SpaceAgentTemplateRepository } from '../../../../../src/storage/repositories/space-agent-template-repository.ts';
import { SpaceLongHorizonAgentRepository } from '../../../../../src/storage/repositories/space-long-horizon-agent-repository.ts';
import { runMigration213 } from '../../../../../src/storage/schema/m213-inactivity-watchdog.ts';
import { runMigration225 } from '../../../../../src/storage/schema/m225-space-agent-templates.ts';
import { runMigration226 } from '../../../../../src/storage/schema/m226-space-agent-templates-version.ts';
import { runMigration227 } from '../../../../../src/storage/schema/m227-space-agent-template-version-seq.ts';
import { runMigration238 } from '../../../../../src/storage/schema/m238-space-agent-template-labels.ts';
import { runMigration241 } from '../../../../../src/storage/schema/m241-convert-customized-worker-mirrors.ts';
import { Database } from '../../../../../src/storage/sqlite-compat.ts';
import { insertSpace } from '../../../helpers/space-agent-schema.ts';
import { createSpaceTables } from '../../../helpers/space-test-db.ts';

const SWE_ID = 'agent-swe';

function createDb() {
  const db = new Database(':memory:');
  createSpaceTables(db);
  runMigration225(db);
  runMigration226(db);
  runMigration227(db);
  runMigration238(db);
  insertSpace(db);
  const agentRepo = new SpaceLongHorizonAgentRepository(db);
  const templateRepo = new SpaceAgentTemplateRepository(db);
  const presets = getPresetAgentTemplates();
  const insertMirror = db.prepare(
    `INSERT INTO space_long_horizon_agents (
       id, space_id, handle, display_name, template_key, instructions,
       description, tool_permissions_json, created_at, updated_at
     ) VALUES (?, 'space-1', ?, ?, 'migration.legacy_space_agent', ?, ?, ?, 1, 1)`
  );
  for (const preset of presets) {
    insertMirror.run(
      `agent-${preset.handle}`,
      preset.handle,
      preset.name,
      preset.customPrompt,
      preset.description,
      preset.tools.length > 0 ? JSON.stringify({ tools: [...preset.tools] }) : '{}'
    );
  }
  return { db, agentRepo, templateRepo, presets };
}

function insertWorkflow(
  db: Database,
  workflowId: string,
  spaceId: string,
  postApproval: string | null
): void {
  db.prepare(
    `INSERT INTO space_workflows (id, space_id, name, post_approval, created_at, updated_at)
     VALUES (?, ?, ?, ?, 1, 1)`
  ).run(workflowId, spaceId, `Workflow ${workflowId}`, postApproval);
}

function insertNode(db: Database, nodeId: string, workflowId: string, config: string): void {
  db.prepare(
    `INSERT INTO space_workflow_nodes (id, workflow_id, name, config, created_at, updated_at)
     VALUES (?, ?, 'Node', ?, 1, 1)`
  ).run(nodeId, workflowId, config);
}

function insertNodeWithAgents(
  db: Database,
  nodeId: string,
  config: string,
  spaceId = 'space-1'
): void {
  insertWorkflow(db, `workflow-${nodeId}`, spaceId, null);
  insertNode(db, nodeId, `workflow-${nodeId}`, config);
}

function insertPinnedRun(
  db: Database,
  runId: string,
  agents: unknown[],
  options?: { tamperHash?: boolean }
): { definitionVersion: string } {
  insertWorkflow(db, `workflow-${runId}`, 'space-1', null);
  const { versionHash, payload } = computeDefinitionVersion({
    nodes: [{ name: 'Node', agents }],
  } as unknown as SpaceWorkflow);
  const storedHash = options?.tamperHash ? `tampered-${runId}` : versionHash;
  db.prepare(
    `INSERT INTO space_workflow_definition_versions (
       workflow_id, version_hash, space_id, payload, source, created_at
     ) VALUES (?, ?, 'space-1', ?, 'backfill', 1)`
  ).run(`workflow-${runId}`, storedHash, payload);
  db.prepare(
    `INSERT INTO space_workflow_runs (
       id, space_id, workflow_id, definition_version, title, status, created_at, updated_at
     ) VALUES (?, 'space-1', ?, ?, 'Run', 'in_progress', 1, 1)`
  ).run(runId, `workflow-${runId}`, storedHash);
  return { definitionVersion: storedHash };
}

function nodeAgents(db: Database, nodeId: string): Array<Record<string, unknown>> {
  const row = db.prepare(`SELECT config FROM space_workflow_nodes WHERE id = ?`).get(nodeId) as {
    config: string;
  };
  return (JSON.parse(row.config) as { agents: Array<Record<string, unknown>> }).agents;
}

function runDefinitionVersion(db: Database, runId: string): string {
  const row = db
    .prepare(`SELECT definition_version FROM space_workflow_runs WHERE id = ?`)
    .get(runId) as { definition_version: string };
  return row.definition_version;
}

function versionPayloadAgents(
  db: Database,
  workflowId: string,
  versionHash: string
): Array<Record<string, unknown>> {
  const row = db
    .prepare(
      `SELECT payload FROM space_workflow_definition_versions WHERE workflow_id = ? AND version_hash = ?`
    )
    .get(workflowId, versionHash) as { payload: string };
  const parsed = JSON.parse(row.payload) as {
    nodes: Array<{ agents: Array<Record<string, unknown>> }>;
  };
  return parsed.nodes[0].agents;
}

function payloadOf(db: Database, workflowId: string, versionHash: string): string {
  const row = db
    .prepare(
      `SELECT payload FROM space_workflow_definition_versions WHERE workflow_id = ? AND version_hash = ?`
    )
    .get(workflowId, versionHash) as { payload: string };
  return row.payload;
}

function remainingMirrorIds(repo: SpaceLongHorizonAgentRepository): string[] {
  return repo
    .listBySpaceId('space-1')
    .filter((agent) => agent.templateKey === MIGRATED_WORKER_TEMPLATE_KEY)
    .map((agent) => agent.id)
    .sort();
}

function unconvertedPresetIds(exceptIds: readonly string[]): string[] {
  return getPresetAgentTemplates()
    .map((preset) => `agent-${preset.handle}`)
    .filter((id) => !exceptIds.includes(id))
    .sort();
}

describe('migration 241: convert customized worker mirrors to user templates', () => {
  test('converts a customized mirror into a worker-custom template and re-stamps the row', () => {
    const { db, agentRepo, templateRepo, presets } = createDb();
    const coderPreset = presets.find((preset) => preset.name === 'SWE')!;
    agentRepo.update(SWE_ID, { model: 'claude-sonnet-5' });

    runMigration241(db);

    const template = templateRepo.getByKey(workerCustomTemplateKey(SWE_ID));
    expect(template).not.toBeNull();
    expect(template?.model).toBe('claude-sonnet-5');
    expect(template?.displayName).toBe('SWE');
    expect(template?.handle).toBe('swe');
    expect(template?.instructions).toBe(coderPreset.customPrompt);
    expect(template?.suggestedAutonomyLevel).toBe(2);
    expect(template?.tools).toBeNull();
    expect(template?.labels).toEqual(['workflow-worker']);

    const coder = agentRepo.listBySpaceId('space-1').find((agent) => agent.id === SWE_ID);
    expect(coder?.templateKey).toBe(workerCustomTemplateKey(SWE_ID));
    expect(coder?.model).toBe('claude-sonnet-5');
    expect(remainingMirrorIds(agentRepo)).toEqual(unconvertedPresetIds([SWE_ID]));
    expect(templateRepo.list().map((entry) => entry.key)).toEqual([
      workerCustomTemplateKey(SWE_ID),
    ]);
    db.close();
  });

  test('converts only the renamed swe mirror on a fresh fixture, leaving snapshot-pristine ones', () => {
    const { db, agentRepo, templateRepo } = createDb();

    runMigration241(db);

    expect(templateRepo.list().map((entry) => entry.key)).toEqual([
      workerCustomTemplateKey('agent-swe'),
    ]);
    expect(remainingMirrorIds(agentRepo)).toEqual(unconvertedPresetIds(['agent-swe']).sort());
    db.close();
  });

  test('converts a pristine mirror referenced by a live workflow slot and rewrites the binding', () => {
    const { db, agentRepo, templateRepo } = createDb();
    insertNodeWithAgents(db, 'node-ref', JSON.stringify({ agents: [{ agentId: SWE_ID }] }));

    runMigration241(db);

    expect(nodeAgents(db, 'node-ref')).toEqual([
      { agentId: '', name: SWE_ID, templateKey: workerCustomTemplateKey(SWE_ID) },
    ]);
    expect(templateRepo.getByKey(workerCustomTemplateKey(SWE_ID))).not.toBeNull();
    expect(remainingMirrorIds(agentRepo)).toEqual(unconvertedPresetIds([SWE_ID]));
    db.close();
  });

  test('converts a mirror bound by an in-flight pinned run and repoints the run', () => {
    const { db, agentRepo } = createDb();
    const { definitionVersion } = insertPinnedRun(db, 'run-live', [{ agentId: SWE_ID }]);

    runMigration241(db);

    const newVersion = runDefinitionVersion(db, 'run-live');
    expect(newVersion).not.toBe(definitionVersion);
    expect(
      verifyDefinitionVersion(payloadOf(db, 'workflow-run-live', newVersion), newVersion)
    ).toBe(true);
    expect(versionPayloadAgents(db, 'workflow-run-live', newVersion)).toEqual([
      { agentId: '', name: SWE_ID, templateKey: workerCustomTemplateKey(SWE_ID) },
    ]);
    expect(
      agentRepo.listBySpaceId('space-1').find((agent) => agent.id === SWE_ID)?.templateKey
    ).toBe(workerCustomTemplateKey(SWE_ID));
    db.close();
  });

  test('rewrites post-approval routes that targeted a converted mirror', () => {
    const { db } = createDb();
    insertWorkflow(db, 'workflow-route', 'space-1', JSON.stringify({ targetAgent: SWE_ID }));
    insertNode(
      db,
      'node-route',
      'workflow-route',
      JSON.stringify({ agents: [{ agentId: SWE_ID, name: 'builder' }] })
    );

    runMigration241(db);

    expect(nodeAgents(db, 'node-route')).toEqual([
      { agentId: '', name: 'builder', templateKey: workerCustomTemplateKey(SWE_ID) },
    ]);
    const postApproval = db
      .prepare(`SELECT post_approval FROM space_workflows WHERE id = 'workflow-route'`)
      .get() as { post_approval: string };
    expect(JSON.parse(postApproval.post_approval)).toEqual({ targetAgent: 'builder' });
    db.close();
  });

  test('preserves an already-resolvable slot templateKey and only clears the stale agentId', () => {
    const { db, agentRepo } = createDb();
    agentRepo.update(SWE_ID, { model: 'claude-sonnet-5' });
    insertNodeWithAgents(
      db,
      'node-keyed',
      JSON.stringify({ agents: [{ agentId: SWE_ID, templateKey: 'worker.qa', name: 'builder' }] })
    );

    runMigration241(db);

    expect(nodeAgents(db, 'node-keyed')).toEqual([
      { agentId: '', templateKey: 'worker.qa', name: 'builder' },
    ]);
    expect(
      agentRepo.listBySpaceId('space-1').find((agent) => agent.id === SWE_ID)?.templateKey
    ).toBe(workerCustomTemplateKey(SWE_ID));
    db.close();
  });

  test('keeps the UUID binding when a colliding route targets the mirror but stamps the templateKey', () => {
    const { db, agentRepo, templateRepo } = createDb();
    insertWorkflow(db, 'workflow-guard', 'space-1', JSON.stringify({ targetAgent: SWE_ID }));
    insertNode(
      db,
      'node-guard-a',
      'workflow-guard',
      JSON.stringify({ agents: [{ agentId: '', templateKey: 'worker.qa', name: 'builder' }] })
    );
    insertNode(
      db,
      'node-guard-b',
      'workflow-guard',
      JSON.stringify({ agents: [{ agentId: SWE_ID, name: 'builder' }] })
    );

    runMigration241(db);

    expect(nodeAgents(db, 'node-guard-a')).toEqual([
      { agentId: '', templateKey: 'worker.qa', name: 'builder' },
    ]);
    expect(nodeAgents(db, 'node-guard-b')).toEqual([
      { agentId: SWE_ID, name: 'builder', templateKey: workerCustomTemplateKey(SWE_ID) },
    ]);
    const postApproval = db
      .prepare(`SELECT post_approval FROM space_workflows WHERE id = 'workflow-guard'`)
      .get() as { post_approval: string };
    expect(JSON.parse(postApproval.post_approval)).toEqual({ targetAgent: SWE_ID });
    expect(templateRepo.getByKey(workerCustomTemplateKey(SWE_ID))).not.toBeNull();
    expect(remainingMirrorIds(agentRepo)).toEqual(unconvertedPresetIds([SWE_ID]));
    db.close();
  });

  test('rewrites the legacy node-level single-agent binding', () => {
    const { db, agentRepo } = createDb();
    agentRepo.update(SWE_ID, { model: 'claude-sonnet-5' });
    agentRepo.update(SWE_ID, { status: 'paused' });
    insertWorkflow(db, 'workflow-legacy-shape', 'space-1', null);
    insertNode(db, 'node-legacy', 'workflow-legacy-shape', JSON.stringify({ agentId: SWE_ID }));

    runMigration241(db);

    expect(nodeAgents(db, 'node-legacy')).toEqual([
      { agentId: '', name: 'Node', templateKey: workerCustomTemplateKey(SWE_ID) },
    ]);
    const coder = agentRepo.listBySpaceId('space-1').find((agent) => agent.id === SWE_ID);
    expect(coder?.templateKey).toBe(workerCustomTemplateKey(SWE_ID));
    db.close();
  });

  test('rewrites a node-level single-agent binding inside a pinned run definition', () => {
    const { db, agentRepo } = createDb();
    agentRepo.update(SWE_ID, { model: 'claude-sonnet-5' });
    insertWorkflow(db, 'workflow-pinned-legacy', 'space-1', null);
    const { versionHash, payload } = computeDefinitionVersion({
      nodes: [{ agentId: SWE_ID, name: 'Legacy Node' }],
    } as unknown as SpaceWorkflow);
    db.prepare(
      `INSERT INTO space_workflow_definition_versions (
         workflow_id, version_hash, space_id, payload, source, created_at
       ) VALUES ('workflow-pinned-legacy', ?, 'space-1', ?, 'backfill', 1)`
    ).run(versionHash, payload);
    db.prepare(
      `INSERT INTO space_workflow_runs (
         id, space_id, workflow_id, definition_version, title, status, created_at, updated_at
       ) VALUES ('run-legacy', 'space-1', 'workflow-pinned-legacy', ?, 'Run', 'in_progress', 1, 1)`
    ).run(versionHash);

    runMigration241(db);

    const newVersion = runDefinitionVersion(db, 'run-legacy');
    expect(newVersion).not.toBe(versionHash);
    const agents = versionPayloadAgents(db, 'workflow-pinned-legacy', newVersion);
    expect(agents).toEqual([
      { agentId: '', name: 'Legacy Node', templateKey: workerCustomTemplateKey(SWE_ID) },
    ]);
    db.close();
  });

  test('keeps the first post-approval role when one mirror fills multiple slots', () => {
    const { db } = createDb();
    insertWorkflow(db, 'workflow-multi', 'space-1', JSON.stringify({ targetAgent: SWE_ID }));
    insertNode(
      db,
      'node-multi-a',
      'workflow-multi',
      JSON.stringify({ agents: [{ agentId: SWE_ID, name: 'alpha' }] })
    );
    insertNode(
      db,
      'node-multi-b',
      'workflow-multi',
      JSON.stringify({ agents: [{ agentId: SWE_ID, name: 'beta' }] })
    );

    runMigration241(db);

    const postApproval = db
      .prepare(`SELECT post_approval FROM space_workflows WHERE id = 'workflow-multi'`)
      .get() as { post_approval: string };
    expect(JSON.parse(postApproval.post_approval)).toEqual({ targetAgent: 'alpha' });
    expect(nodeAgents(db, 'node-multi-a')).toEqual([
      { agentId: '', name: 'alpha', templateKey: workerCustomTemplateKey(SWE_ID) },
    ]);
    expect(nodeAgents(db, 'node-multi-b')).toEqual([
      { agentId: '', name: 'beta', templateKey: workerCustomTemplateKey(SWE_ID) },
    ]);
    db.close();
  });

  test('suffixes the key when an existing match differs only in labels', () => {
    const { db, agentRepo, templateRepo } = createDb();
    agentRepo.update(SWE_ID, { model: 'claude-sonnet-5' });
    templateRepo.create({
      ...synthesizeWorkerCustomTemplate(
        agentRepo.listBySpaceId('space-1').find((agent) => agent.id === SWE_ID)!
      ),
      labels: [],
      key: workerCustomTemplateKey(SWE_ID),
    });

    runMigration241(db);

    const suffixedKey = `${workerCustomTemplateKey(SWE_ID)}.m241`;
    expect(
      templateRepo
        .list()
        .map((entry) => entry.key)
        .sort()
    ).toEqual([workerCustomTemplateKey(SWE_ID), suffixedKey]);
    expect(templateRepo.getByKey(suffixedKey)?.labels).toEqual(['workflow-worker']);
    expect(
      agentRepo.listBySpaceId('space-1').find((agent) => agent.id === SWE_ID)?.templateKey
    ).toBe(suffixedKey);
    db.close();
  });

  test('materializes the stamped slot when the route guard holds a node-level binding', () => {
    const { db, agentRepo } = createDb();
    agentRepo.update(SWE_ID, { model: 'claude-sonnet-5' });
    insertWorkflow(db, 'workflow-guard-node', 'space-1', JSON.stringify({ targetAgent: SWE_ID }));
    insertNode(
      db,
      'node-guard-node-a',
      'workflow-guard-node',
      JSON.stringify({ agents: [{ agentId: '', templateKey: 'worker.qa', name: 'builder' }] })
    );
    insertNode(
      db,
      'node-guard-node-b',
      'workflow-guard-node',
      JSON.stringify({ agentId: SWE_ID, name: 'builder' })
    );

    runMigration241(db);

    expect(nodeAgents(db, 'node-guard-node-b')).toEqual([
      { agentId: SWE_ID, name: 'builder', templateKey: workerCustomTemplateKey(SWE_ID) },
    ]);
    expect(
      agentRepo.listBySpaceId('space-1').find((agent) => agent.id === SWE_ID)?.templateKey
    ).toBe(workerCustomTemplateKey(SWE_ID));
    db.close();
  });

  test('converts a session-bound mirror that is otherwise content-pristine', () => {
    const { db, agentRepo, templateRepo } = createDb();
    agentRepo.update(SWE_ID, { sessionId: 'session-1' });

    runMigration241(db);

    expect(templateRepo.getByKey(workerCustomTemplateKey(SWE_ID))).not.toBeNull();
    expect(
      agentRepo.listBySpaceId('space-1').find((agent) => agent.id === SWE_ID)?.templateKey
    ).toBe(workerCustomTemplateKey(SWE_ID));
    expect(remainingMirrorIds(agentRepo)).toEqual(unconvertedPresetIds([SWE_ID]));
    db.close();
  });

  test('retargets post-approval routes that used the replaced template key', () => {
    const { db, agentRepo } = createDb();
    agentRepo.update(SWE_ID, { model: 'claude-sonnet-5' });
    insertWorkflow(
      db,
      'workflow-key-route',
      'space-1',
      JSON.stringify({ targetAgent: 'legacy-key-x' })
    );
    insertNode(
      db,
      'node-key-route',
      'workflow-key-route',
      JSON.stringify({
        agents: [{ agentId: SWE_ID, templateKey: 'legacy-key-x', name: 'builder' }],
      })
    );

    runMigration241(db);

    expect(nodeAgents(db, 'node-key-route')).toEqual([
      { agentId: SWE_ID, name: 'builder', templateKey: workerCustomTemplateKey(SWE_ID) },
    ]);
    const postApproval = db
      .prepare(`SELECT post_approval FROM space_workflows WHERE id = 'workflow-key-route'`)
      .get() as { post_approval: string };
    expect(JSON.parse(postApproval.post_approval)).toEqual({ targetAgent: 'builder' });
    db.close();
  });

  test('holds a key-targeted route on the UUID when the replacement name collides', () => {
    const { db, agentRepo } = createDb();
    agentRepo.update(SWE_ID, { model: 'claude-sonnet-5' });
    insertWorkflow(
      db,
      'workflow-key-guard',
      'space-1',
      JSON.stringify({ targetAgent: 'legacy-key-x' })
    );
    insertNode(
      db,
      'node-key-guard-a',
      'workflow-key-guard',
      JSON.stringify({ agents: [{ agentId: '', templateKey: 'worker.qa', name: 'builder' }] })
    );
    insertNode(
      db,
      'node-key-guard-b',
      'workflow-key-guard',
      JSON.stringify({
        agents: [{ agentId: SWE_ID, templateKey: 'legacy-key-x', name: 'builder' }],
      })
    );

    runMigration241(db);

    expect(nodeAgents(db, 'node-key-guard-b')).toEqual([
      { agentId: SWE_ID, name: 'builder', templateKey: 'legacy-key-x' },
    ]);
    const postApproval = db
      .prepare(`SELECT post_approval FROM space_workflows WHERE id = 'workflow-key-guard'`)
      .get() as { post_approval: string };
    expect(JSON.parse(postApproval.post_approval)).toEqual({
      targetAgent: 'legacy-key-x',
    });
    db.close();
  });

  test('keeps a contested key-targeted mirror UUID-bound when its fallback name is owned', () => {
    const { db, agentRepo } = createDb();
    agentRepo.update(SWE_ID, { model: 'claude-sonnet-5' });
    insertWorkflow(
      db,
      'workflow-key-follow',
      'space-1',
      JSON.stringify({ targetAgent: 'legacy-key-x' })
    );
    insertNode(
      db,
      'node-key-follow-a',
      'workflow-key-follow',
      JSON.stringify({ agents: [{ agentId: '', templateKey: 'worker.qa', name: SWE_ID }] })
    );
    insertNode(
      db,
      'node-key-follow-b',
      'workflow-key-follow',
      JSON.stringify({ agents: [{ agentId: SWE_ID, templateKey: 'legacy-key-x' }] })
    );

    runMigration241(db);

    expect(nodeAgents(db, 'node-key-follow-b')).toEqual([
      { agentId: SWE_ID, templateKey: 'legacy-key-x' },
    ]);
    const postApproval = db
      .prepare(`SELECT post_approval FROM space_workflows WHERE id = 'workflow-key-follow'`)
      .get() as { post_approval: string };
    expect(JSON.parse(postApproval.post_approval)).toEqual({ targetAgent: 'legacy-key-x' });
    db.close();
  });

  test('keeps a key-targeted route owned by an earlier slot on that slot', () => {
    const { db } = createDb();
    insertWorkflow(db, 'workflow-key-owner', 'space-1', JSON.stringify({ targetAgent: SWE_ID }));
    insertNode(
      db,
      'node-owner-a',
      'workflow-key-owner',
      JSON.stringify({ agents: [{ agentId: '', templateKey: SWE_ID, name: 'alpha' }] })
    );
    insertNode(
      db,
      'node-owner-b',
      'workflow-key-owner',
      JSON.stringify({ agents: [{ agentId: SWE_ID, name: 'beta' }] })
    );

    runMigration241(db);

    expect(nodeAgents(db, 'node-owner-a')).toEqual([
      { agentId: '', templateKey: SWE_ID, name: 'alpha' },
    ]);
    expect(nodeAgents(db, 'node-owner-b')).toEqual([
      { agentId: '', name: 'beta', templateKey: workerCustomTemplateKey(SWE_ID) },
    ]);
    const postApproval = db
      .prepare(`SELECT post_approval FROM space_workflows WHERE id = 'workflow-key-owner'`)
      .get() as { post_approval: string };
    expect(JSON.parse(postApproval.post_approval)).toEqual({ targetAgent: SWE_ID });
    db.close();
  });

  test('retargets a contested key route to the mirror slot name when the binding key is owned', () => {
    const { db, agentRepo } = createDb();
    agentRepo.update(SWE_ID, { model: 'claude-sonnet-5' });
    const bindingKey = workerCustomTemplateKey(SWE_ID);
    insertWorkflow(
      db,
      'workflow-key-contested',
      'space-1',
      JSON.stringify({ targetAgent: 'legacy-key-x' })
    );
    insertNode(
      db,
      'node-key-contested-a',
      'workflow-key-contested',
      JSON.stringify({ agents: [{ agentId: '', templateKey: 'worker.qa', name: bindingKey }] })
    );
    insertNode(
      db,
      'node-key-contested-b',
      'workflow-key-contested',
      JSON.stringify({ agents: [{ agentId: SWE_ID, templateKey: 'legacy-key-x', name: 'beta' }] })
    );

    runMigration241(db);

    expect(nodeAgents(db, 'node-key-contested-b')).toEqual([
      { agentId: SWE_ID, name: 'beta', templateKey: bindingKey },
    ]);
    const postApproval = db
      .prepare(`SELECT post_approval FROM space_workflows WHERE id = 'workflow-key-contested'`)
      .get() as { post_approval: string };
    expect(JSON.parse(postApproval.post_approval)).toEqual({ targetAgent: 'beta' });
    db.close();
  });

  test('aliases a repeated-mirror key route to the later slot name when both prior aliases are owned', () => {
    const { db, agentRepo } = createDb();
    agentRepo.update(SWE_ID, { model: 'claude-sonnet-5' });
    insertWorkflow(
      db,
      'workflow-repeat',
      'space-1',
      JSON.stringify({ targetAgent: 'legacy-key-2' })
    );
    insertNode(
      db,
      'node-repeat-a',
      'workflow-repeat',
      JSON.stringify({
        agents: [{ agentId: SWE_ID, templateKey: 'legacy-key-1', name: 'first' }],
      })
    );
    insertNode(
      db,
      'node-repeat-b',
      'workflow-repeat',
      JSON.stringify({
        agents: [{ agentId: SWE_ID, templateKey: 'legacy-key-2', name: 'second' }],
      })
    );

    runMigration241(db);

    expect(nodeAgents(db, 'node-repeat-b')).toEqual([
      { agentId: SWE_ID, name: 'second', templateKey: workerCustomTemplateKey(SWE_ID) },
    ]);
    const postApproval = db
      .prepare(`SELECT post_approval FROM space_workflows WHERE id = 'workflow-repeat'`)
      .get() as { post_approval: string };
    expect(JSON.parse(postApproval.post_approval)).toEqual({ targetAgent: 'second' });
    db.close();
  });

  test('rebinds slots already processed by m228/m231 to the worker-custom key', () => {
    const { db, agentRepo } = createDb();
    agentRepo.update(SWE_ID, { model: 'claude-sonnet-5' });
    insertNodeWithAgents(
      db,
      'node-m228',
      JSON.stringify({
        agents: [{ agentId: '', templateKey: `migrated.agent.${SWE_ID}`, name: 'builder' }],
      })
    );

    runMigration241(db);

    expect(nodeAgents(db, 'node-m228')).toEqual([
      { agentId: '', name: 'builder', templateKey: workerCustomTemplateKey(SWE_ID) },
    ]);
    expect(
      agentRepo.listBySpaceId('space-1').find((agent) => agent.id === SWE_ID)?.templateKey
    ).toBe(workerCustomTemplateKey(SWE_ID));
    db.close();
  });

  test('retargets routes off a neutralized stale key onto the owning slot name', () => {
    const { db, agentRepo } = createDb();
    agentRepo.update(SWE_ID, { model: 'claude-sonnet-5' });
    agentRepo.create({
      spaceId: 'space-1',
      handle: 'ops-user',
      displayName: 'Ops',
      instructions: 'Ops agent',
    });
    const shadowKey = workerCustomTemplateKey(SWE_ID);
    insertWorkflow(db, 'workflow-neutral', 'space-1', JSON.stringify({ targetAgent: shadowKey }));
    insertNode(
      db,
      'node-neutral',
      'workflow-neutral',
      JSON.stringify({
        agents: [{ agentId: 'user-1', templateKey: shadowKey, name: 'ops' }],
      })
    );

    runMigration241(db);

    expect(nodeAgents(db, 'node-neutral')).toEqual([{ agentId: 'user-1', name: 'ops' }]);
    const postApproval = db
      .prepare(`SELECT post_approval FROM space_workflows WHERE id = 'workflow-neutral'`)
      .get() as { post_approval: string };
    expect(JSON.parse(postApproval.post_approval)).toEqual({ targetAgent: 'ops' });
    db.close();
  });

  test('retargets a self-owned binding-key route to the slot name', () => {
    const { db, agentRepo, templateRepo } = createDb();
    agentRepo.update(SWE_ID, { model: 'claude-sonnet-5' });
    const key = workerCustomTemplateKey(SWE_ID);
    templateRepo.create({
      ...synthesizeWorkerCustomTemplate(
        agentRepo.listBySpaceId('space-1').find((agent) => agent.id === SWE_ID)!
      ),
      key,
    });
    insertWorkflow(db, 'workflow-self-key', 'space-1', JSON.stringify({ targetAgent: key }));
    insertNode(
      db,
      'node-self-key',
      'workflow-self-key',
      JSON.stringify({ agents: [{ agentId: SWE_ID, templateKey: key, name: 'builder' }] })
    );

    runMigration241(db);

    expect(nodeAgents(db, 'node-self-key')).toEqual([
      { agentId: SWE_ID, name: 'builder', templateKey: key },
    ]);
    const postApproval = db
      .prepare(`SELECT post_approval FROM space_workflows WHERE id = 'workflow-self-key'`)
      .get() as { post_approval: string };
    expect(JSON.parse(postApproval.post_approval)).toEqual({ targetAgent: 'builder' });
    db.close();
  });

  test('preserves a resolvable binding to a template key the migration reuses', () => {
    const { db, agentRepo, templateRepo } = createDb();
    agentRepo.update(SWE_ID, { model: 'claude-sonnet-5' });
    const key = workerCustomTemplateKey(SWE_ID);
    templateRepo.create({
      ...synthesizeWorkerCustomTemplate(
        agentRepo.listBySpaceId('space-1').find((agent) => agent.id === SWE_ID)!
      ),
      key,
    });
    insertNodeWithAgents(
      db,
      'node-reuse-keep',
      JSON.stringify({ agents: [{ agentId: 'user-1', templateKey: key, name: 'ops' }] })
    );

    runMigration241(db);

    expect(nodeAgents(db, 'node-reuse-keep')).toEqual([
      { agentId: 'user-1', templateKey: key, name: 'ops' },
    ]);
    db.close();
  });

  test('clears a targeted newly-minted key when the slot name is owned by an earlier slot', () => {
    const { db, agentRepo } = createDb();
    agentRepo.update(SWE_ID, { model: 'claude-sonnet-5' });
    const key = workerCustomTemplateKey(SWE_ID);
    insertWorkflow(
      db,
      'workflow-contested-neutral',
      'space-1',
      JSON.stringify({ targetAgent: key })
    );
    insertNode(
      db,
      'node-contested-a',
      'workflow-contested-neutral',
      JSON.stringify({ agents: [{ agentId: 'user-1', name: 'ops' }] })
    );
    insertNode(
      db,
      'node-contested-b',
      'workflow-contested-neutral',
      JSON.stringify({ agents: [{ agentId: 'user-2', templateKey: key, name: 'ops' }] })
    );

    runMigration241(db);

    expect(nodeAgents(db, 'node-contested-b')).toEqual([{ agentId: 'user-2', name: 'ops' }]);
    const postApproval = db
      .prepare(`SELECT post_approval FROM space_workflows WHERE id = 'workflow-contested-neutral'`)
      .get() as { post_approval: string };
    expect(JSON.parse(postApproval.post_approval)).toEqual({ targetAgent: key });
    db.close();
  });

  test('clears an untargeted stale key that a newly minted template makes resolvable', () => {
    const { db, agentRepo } = createDb();
    agentRepo.update(SWE_ID, { model: 'claude-sonnet-5' });
    const key = workerCustomTemplateKey(SWE_ID);
    insertNodeWithAgents(
      db,
      'node-stale-clear',
      JSON.stringify({ agents: [{ agentId: 'user-1', templateKey: key, name: 'ops' }] })
    );

    runMigration241(db);

    expect(nodeAgents(db, 'node-stale-clear')).toEqual([{ agentId: 'user-1', name: 'ops' }]);
    db.close();
  });

  test('rebinds a mirror slot named after its own generated key', () => {
    const { db, agentRepo } = createDb();
    agentRepo.update(SWE_ID, { model: 'claude-sonnet-5' });
    const key = workerCustomTemplateKey(SWE_ID);
    insertWorkflow(db, 'workflow-self-name', 'space-1', JSON.stringify({ targetAgent: key }));
    insertNode(
      db,
      'node-self-name',
      'workflow-self-name',
      JSON.stringify({ agents: [{ agentId: SWE_ID, name: key }] })
    );

    runMigration241(db);

    expect(nodeAgents(db, 'node-self-name')).toEqual([
      { agentId: '', name: key, templateKey: key },
    ]);
    const postApproval = db
      .prepare(`SELECT post_approval FROM space_workflows WHERE id = 'workflow-self-name'`)
      .get() as { post_approval: string };
    expect(JSON.parse(postApproval.post_approval)).toEqual({ targetAgent: key });
    db.close();
  });

  test('keeps a replaced-key route on an earlier slot that owns the key as its name', () => {
    const { db, agentRepo } = createDb();
    agentRepo.update(SWE_ID, { model: 'claude-sonnet-5' });
    insertWorkflow(
      db,
      'workflow-name-owner',
      'space-1',
      JSON.stringify({ targetAgent: 'legacy-key-x' })
    );
    insertNode(
      db,
      'node-name-owner-a',
      'workflow-name-owner',
      JSON.stringify({ agents: [{ agentId: '', templateKey: 'worker.qa', name: 'legacy-key-x' }] })
    );
    insertNode(
      db,
      'node-name-owner-b',
      'workflow-name-owner',
      JSON.stringify({
        agents: [{ agentId: SWE_ID, templateKey: 'legacy-key-x', name: 'beta' }],
      })
    );

    runMigration241(db);

    expect(nodeAgents(db, 'node-name-owner-b')).toEqual([
      { agentId: SWE_ID, name: 'beta', templateKey: workerCustomTemplateKey(SWE_ID) },
    ]);
    const postApproval = db
      .prepare(`SELECT post_approval FROM space_workflows WHERE id = 'workflow-name-owner'`)
      .get() as { post_approval: string };
    expect(JSON.parse(postApproval.post_approval)).toEqual({ targetAgent: 'legacy-key-x' });
    db.close();
  });

  test('does not preserve a key created earlier in this same migration', () => {
    const { db, agentRepo } = createDb();
    agentRepo.update(SWE_ID, { model: 'claude-sonnet-5' });
    agentRepo.update('agent-qa', { model: 'claude-opus-5' });
    insertNodeWithAgents(
      db,
      'node-snap',
      JSON.stringify({
        agents: [
          {
            agentId: SWE_ID,
            templateKey: workerCustomTemplateKey('agent-qa'),
            name: 'builder',
          },
        ],
      })
    );

    runMigration241(db);

    expect(nodeAgents(db, 'node-snap')).toEqual([
      {
        agentId: '',
        name: 'builder',
        templateKey: workerCustomTemplateKey(SWE_ID),
      },
    ]);
    db.close();
  });

  test('keeps a mirror UUID-bound when its new key would shadow a later route target', () => {
    const { db, agentRepo } = createDb();
    agentRepo.update(SWE_ID, { model: 'claude-sonnet-5' });
    const shadowName = workerCustomTemplateKey(SWE_ID);
    insertWorkflow(db, 'workflow-shadow', 'space-1', JSON.stringify({ targetAgent: shadowName }));
    insertNode(
      db,
      'node-shadow-a',
      'workflow-shadow',
      JSON.stringify({ agents: [{ agentId: SWE_ID }] })
    );
    insertNode(
      db,
      'node-shadow-b',
      'workflow-shadow',
      JSON.stringify({
        agents: [{ agentId: '', templateKey: 'worker.qa', name: shadowName }],
      })
    );

    runMigration241(db);

    expect(nodeAgents(db, 'node-shadow-a')).toEqual([{ agentId: SWE_ID }]);
    const postApproval = db
      .prepare(`SELECT post_approval FROM space_workflows WHERE id = 'workflow-shadow'`)
      .get() as { post_approval: string };
    expect(JSON.parse(postApproval.post_approval)).toEqual({ targetAgent: shadowName });
    expect(
      agentRepo.listBySpaceId('space-1').find((agent) => agent.id === SWE_ID)?.templateKey
    ).toBe(shadowName);
    db.close();
  });

  test('converts mirrors carrying durable resources or watchdog state', () => {
    const { db, agentRepo, templateRepo } = createDb();
    runMigration213(db);
    db.prepare(
      `INSERT INTO space_goals (
         id, space_id, title, description, status, type, priority, labels, metrics,
         summary, progress, next_steps, auto_trigger_next, pending_next_run, created_at, updated_at
       ) VALUES ('goal-1', 'space-1', 'Goal', '', 'active', 'one_shot', 'normal', '[]', '{}', '', 0, '[]', 0, 0, 1, 1)`
    ).run();
    agentRepo.assignGoal(SWE_ID, 'goal-1');
    agentRepo.createReminder({
      spaceId: 'space-1',
      agentId: 'agent-qa',
      title: 'Reminder',
      triggerType: 'at',
      runAt: 1,
    });
    db.prepare(
      `INSERT INTO space_agent_inactivity_config (
         id, space_id, agent_id, enabled, config_revision, created_at, updated_at
       ) VALUES ('watchdog-1', 'space-1', 'agent-research', 1, 1, 1, 1)`
    ).run();

    runMigration241(db);

    expect(
      templateRepo
        .list()
        .map((entry) => entry.key)
        .sort()
    ).toEqual([
      workerCustomTemplateKey('agent-qa'),
      workerCustomTemplateKey('agent-research'),
      workerCustomTemplateKey('agent-swe'),
    ]);
    expect(remainingMirrorIds(agentRepo)).toEqual(
      unconvertedPresetIds([SWE_ID, 'agent-qa', 'agent-research'])
    );
    db.close();
  });

  test('reuses a matching existing template and suffixes the key on mismatch', () => {
    const { db, agentRepo, templateRepo } = createDb();
    agentRepo.update(SWE_ID, { model: 'claude-sonnet-5' });
    templateRepo.create({
      ...synthesizeWorkerCustomTemplate(
        agentRepo.listBySpaceId('space-1').find((agent) => agent.id === SWE_ID)!
      ),
      key: workerCustomTemplateKey(SWE_ID),
    });
    agentRepo.update('agent-qa', { model: 'claude-opus-5' });
    templateRepo.create({
      key: workerCustomTemplateKey('agent-qa'),
      handle: 'occupied',
      displayName: 'Occupied',
      instructions: 'different',
    });

    runMigration241(db);

    expect(
      templateRepo
        .list()
        .map((entry) => entry.key)
        .sort()
    ).toEqual([
      workerCustomTemplateKey('agent-qa'),
      `${workerCustomTemplateKey('agent-qa')}.m241`,
      workerCustomTemplateKey(SWE_ID),
    ]);
    expect(templateRepo.getByKey(workerCustomTemplateKey('agent-qa'))?.instructions).toBe(
      'different'
    );
    expect(templateRepo.getByKey(`${workerCustomTemplateKey('agent-qa')}.m241`)?.model).toBe(
      'claude-opus-5'
    );
    expect(
      agentRepo.listBySpaceId('space-1').find((agent) => agent.id === 'agent-qa')?.templateKey
    ).toBe(`${workerCustomTemplateKey('agent-qa')}.m241`);
    db.close();
  });

  test('keeps bindings that reference a mirror from another space', () => {
    const { db, agentRepo } = createDb();
    insertSpace(db, 'space-2');
    agentRepo.update(SWE_ID, { model: 'claude-sonnet-5' });
    insertNodeWithAgents(
      db,
      'node-cross',
      JSON.stringify({ agents: [{ agentId: SWE_ID, name: 'builder' }] }),
      'space-2'
    );

    runMigration241(db);

    expect(nodeAgents(db, 'node-cross')).toEqual([{ agentId: SWE_ID, name: 'builder' }]);
    expect(
      agentRepo.listBySpaceId('space-1').find((agent) => agent.id === SWE_ID)?.templateKey
    ).toBe(workerCustomTemplateKey(SWE_ID));
    db.close();
  });

  test('ignores junk agent entries, malformed configs, and unverifiable pinned payloads', () => {
    const { db, agentRepo } = createDb();
    agentRepo.update(SWE_ID, { model: 'claude-sonnet-5' });
    insertNodeWithAgents(db, 'node-junk', JSON.stringify({ agents: [null, 'garbage', 42] }));
    insertNodeWithAgents(db, 'node-bad-json', 'not-json-at-all');
    const { definitionVersion } = insertPinnedRun(db, 'run-corrupt', [{ agentId: 'agent-qa' }], {
      tamperHash: true,
    });

    expect(() => runMigration241(db)).not.toThrow();

    expect(nodeAgents(db, 'node-junk')).toEqual([null, 'garbage', 42]);
    expect(runDefinitionVersion(db, 'run-corrupt')).toBe(definitionVersion);
    expect(
      agentRepo.listBySpaceId('space-1').find((agent) => agent.id === SWE_ID)?.templateKey
    ).toBe(workerCustomTemplateKey(SWE_ID));
    db.close();
  });

  test('second run is a no-op once mirrors are converted', () => {
    const { db, agentRepo, templateRepo } = createDb();
    agentRepo.update(SWE_ID, { model: 'claude-sonnet-5' });

    runMigration241(db);
    runMigration241(db);

    expect(templateRepo.list().map((entry) => entry.key)).toEqual([
      workerCustomTemplateKey(SWE_ID),
    ]);
    expect(remainingMirrorIds(agentRepo).length).toBe(getPresetAgentTemplates().length - 1);
    db.close();
  });
});
