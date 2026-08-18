import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { Database } from '../../../../src/storage/sqlite-compat';
import { SpaceWorkflowRepository } from '../../../../src/storage/repositories/space-workflow-repository.ts';
import { SpaceWorkflowDefinitionVersionRepository } from '../../../../src/storage/repositories/space-workflow-definition-version-repository.ts';
import {
  computeDefinitionVersion,
  stableStringify,
} from '../../../../src/lib/space/workflows/definition-version.ts';
import { createSpaceTables } from '../../helpers/space-test-db.ts';
import type { SpaceWorkflow } from '@hyperneo/shared';

const spaceId = 'sp-1';

function seedSpace(db: Database, id: string): void {
  const now = Date.now();
  db.prepare(
    `INSERT INTO spaces (id, slug, workspace_path, name, created_at, updated_at)
		 VALUES (?, ?, ?, ?, ?, ?)`
  ).run(id, id, '/ws/x', 'Test Space', now, now);
}

function versionCount(db: Database, workflowId: string): number {
  return (
    db
      .prepare(`SELECT COUNT(*) AS n FROM space_workflow_definition_versions WHERE workflow_id = ?`)
      .get(workflowId) as { n: number }
  ).n;
}

function wf(overrides: Partial<SpaceWorkflow> & Pick<SpaceWorkflow, 'id'>): SpaceWorkflow {
  return {
    spaceId,
    name: 'WF',
    nodes: [],
    startNodeId: '',
    tags: [],
    completionAutonomyLevel: 3,
    createdAt: 0,
    updatedAt: 0,
    ...overrides,
  };
}

describe('computeDefinitionVersion — content-hash identity', () => {
  test('stableStringify sorts object keys recursively (deterministic regardless of insertion order)', () => {
    const a = stableStringify({ b: 2, a: 1, nested: { z: 1, y: 2 } });
    const b = stableStringify({ nested: { y: 2, z: 1 }, a: 1, b: 2 });
    expect(a).toBe(b);
    expect(a).toBe('{"a":1,"b":2,"nested":{"y":2,"z":1}}');
  });

  test('stableStringify omits undefined object keys (mirrors JSON.stringify)', () => {
    expect(stableStringify({ a: 1, b: undefined, c: 3 })).toBe('{"a":1,"c":3}');
  });

  test('stableStringify preserves array order (does not sort arrays)', () => {
    expect(stableStringify([3, 1, 2])).toBe('[3,1,2]');
  });

  test('stableStringify renders undefined array elements as null (mirrors JSON.stringify)', () => {
    expect(stableStringify([1, undefined, 3])).toBe('[1,null,3]');
  });

  test('same behavioral content → same version hash, regardless of property order', () => {
    const a = wf({ id: 'x', nodes: [{ id: 'n', name: 'X', agents: [] }] });
    const b = wf({ id: 'x', nodes: [{ id: 'n', name: 'X', agents: [] }] });
    const reordered = JSON.parse(stableStringify(a)) as SpaceWorkflow;
    expect(computeDefinitionVersion(reordered).versionHash).toBe(
      computeDefinitionVersion(b).versionHash
    );
  });

  test('different content → different version hash', () => {
    const base = wf({ id: 'x', nodes: [{ id: 'n', name: 'X', agents: [] }] });
    const changed = wf({ id: 'x', nodes: [{ id: 'n', name: 'Y', agents: [] }] });
    expect(computeDefinitionVersion(base).versionHash).not.toBe(
      computeDefinitionVersion(changed).versionHash
    );
  });

  test('volatile timestamps are excluded — a no-op re-stamp is the same version', () => {
    const a = wf({ id: 'x', name: 'n', createdAt: 1, updatedAt: 1 });
    const b = wf({ id: 'x', name: 'n', createdAt: 999, updatedAt: 999 });
    expect(computeDefinitionVersion(a).versionHash).toBe(computeDefinitionVersion(b).versionHash);
  });

  test('resolved agent IDs affect the hash (row-level identity, not template-portable)', () => {
    const withAgentA = wf({
      id: 'x',
      nodes: [{ id: 'n', name: 'X', agents: [{ name: 'Coder', agentId: 'a-1' }] }],
    });
    const withAgentB = wf({
      id: 'x',
      nodes: [{ id: 'n', name: 'X', agents: [{ name: 'Coder', agentId: 'a-2' }] }],
    });
    expect(computeDefinitionVersion(withAgentA).versionHash).not.toBe(
      computeDefinitionVersion(withAgentB).versionHash
    );
  });

  test('versionHash is derived from payload — re-hashing the stored payload reproduces it', () => {
    const original = wf({
      id: 'x',
      nodes: [{ id: 'n', name: 'X', agents: [] }],
      gates: [{ id: 'g1', requiredLevel: 2, fields: [], resetOnCycle: false }],
    });
    const { versionHash, payload } = computeDefinitionVersion(original);
    const rehashed = computeDefinitionVersion(JSON.parse(payload) as SpaceWorkflow).versionHash;
    expect(rehashed).toBe(versionHash);
  });
});

describe('SpaceWorkflowDefinitionVersionRepository — append-only history', () => {
  let db: Database;
  let repo: SpaceWorkflowDefinitionVersionRepository;

  beforeEach(() => {
    db = new Database(':memory:');
    createSpaceTables(db);
    seedSpace(db, spaceId);
    repo = new SpaceWorkflowDefinitionVersionRepository(db);
  });

  afterEach(() => {
    db.close();
  });

  test('appendVersion stores a version retrievable by (workflow_id, version_hash)', () => {
    repo.appendVersion({
      workflowId: 'wf-1',
      spaceId,
      versionHash: 'h1',
      payload: '{"id":"wf-1"}',
      source: 'create',
      createdAt: 100,
    });
    const v = repo.getVersion('wf-1', 'h1');
    expect(v).not.toBeNull();
    expect(v?.source).toBe('create');
    expect(v?.payload).toBe('{"id":"wf-1"}');
    expect(v?.spaceId).toBe(spaceId);
  });

  test('appendVersion is idempotent on (workflow_id, version_hash) — first write wins', () => {
    repo.appendVersion({
      workflowId: 'wf-1',
      spaceId,
      versionHash: 'h1',
      payload: 'p',
      source: 'create',
      createdAt: 100,
    });
    repo.appendVersion({
      workflowId: 'wf-1',
      spaceId,
      versionHash: 'h1',
      payload: 'p2',
      source: 'update',
      createdAt: 200,
    });
    expect(versionCount(db, 'wf-1')).toBe(1);
    const v = repo.getVersion('wf-1', 'h1');
    expect(v?.payload).toBe('p');
    expect(v?.source).toBe('create');
    expect(v?.createdAt).toBe(100);
  });

  test('distinct version hashes for the same workflow are separate rows', () => {
    repo.appendVersion({
      workflowId: 'wf-1',
      spaceId,
      versionHash: 'h1',
      payload: 'p1',
      source: 'create',
      createdAt: 100,
    });
    repo.appendVersion({
      workflowId: 'wf-1',
      spaceId,
      versionHash: 'h2',
      payload: 'p2',
      source: 'update',
      createdAt: 200,
    });
    expect(versionCount(db, 'wf-1')).toBe(2);
    expect(repo.getVersion('wf-1', 'h1')).not.toBeNull();
    expect(repo.getVersion('wf-1', 'h2')).not.toBeNull();
  });

  test('getVersion returns null for an unknown version', () => {
    expect(repo.getVersion('missing', 'missing')).toBeNull();
  });
});

describe('SpaceWorkflowRepository — shadow definition-version recording', () => {
  let db: Database;
  let wfRepo: SpaceWorkflowRepository;
  let versionRepo: SpaceWorkflowDefinitionVersionRepository;

  beforeEach(() => {
    db = new Database(':memory:');
    createSpaceTables(db);
    seedSpace(db, spaceId);
    wfRepo = new SpaceWorkflowRepository(db);
    versionRepo = new SpaceWorkflowDefinitionVersionRepository(db);
  });

  afterEach(() => {
    db.close();
  });

  test('createWorkflow records one "create" version matching the persisted definition', () => {
    const created = wfRepo.createWorkflow({
      spaceId,
      name: 'WF',
      nodes: [{ name: 'Only', agentId: 'agent-1' }],
    });
    expect(versionCount(db, created.id)).toBe(1);

    const fetched = wfRepo.getWorkflow(created.id)!;
    const hash = computeDefinitionVersion(fetched).versionHash;
    const v = versionRepo.getVersion(created.id, hash);
    expect(v).not.toBeNull();
    expect(v?.source).toBe('create');

    const fromPayload = JSON.parse(v!.payload);
    expect(fromPayload.id).toBe(created.id);
    expect(fromPayload.name).toBe('WF');
  });

  test('updateWorkflow with a behavioral change records a second version', () => {
    const created = wfRepo.createWorkflow({
      spaceId,
      name: 'WF',
      nodes: [{ name: 'Only', agentId: 'agent-1' }],
    });
    const createHash = computeDefinitionVersion(created).versionHash;

    wfRepo.updateWorkflow(created.id, { name: 'Renamed' });
    expect(versionCount(db, created.id)).toBe(2);

    const updateHash = computeDefinitionVersion(wfRepo.getWorkflow(created.id)!).versionHash;
    expect(versionRepo.getVersion(created.id, createHash)?.source).toBe('create');
    expect(versionRepo.getVersion(created.id, updateHash)?.source).toBe('update');
    expect(createHash).not.toBe(updateHash);
  });

  test('updateWorkflow that changes no behavioral content records no new version (idempotent)', () => {
    const created = wfRepo.createWorkflow({
      spaceId,
      name: 'WF',
      nodes: [{ name: 'Only', agentId: 'agent-1' }],
    });
    wfRepo.updateWorkflow(created.id, {});
    expect(versionCount(db, created.id)).toBe(1);
  });

  test('a layout-only updateWorkflow (node drag) records no new version (layout is non-behavioral)', () => {
    const created = wfRepo.createWorkflow({
      spaceId,
      name: 'WF',
      nodes: [{ name: 'Only', agentId: 'agent-1' }],
    });
    const nodeId = created.nodes[0].id;
    wfRepo.updateWorkflow(created.id, { layout: { [nodeId]: { x: 99, y: 99 } } });
    expect(versionCount(db, created.id)).toBe(1);
  });

  test('a recorded payload re-hashes to its stored versionHash (round-trip from the stored bytes)', () => {
    const created = wfRepo.createWorkflow({
      spaceId,
      name: 'WF',
      nodes: [{ name: 'Only', agentId: 'agent-1' }],
    });
    const fetched = wfRepo.getWorkflow(created.id)!;
    const v = versionRepo.getVersion(created.id, computeDefinitionVersion(fetched).versionHash)!;
    expect(computeDefinitionVersion(JSON.parse(v.payload) as SpaceWorkflow).versionHash).toBe(
      v.versionHash
    );
  });

  test('updateWorkflowNodeToolGuards records a version when a tool guard changes', () => {
    const created = wfRepo.createWorkflow({
      spaceId,
      name: 'WF',
      nodes: [{ name: 'Only', agentId: 'agent-1' }],
    });
    const node = created.nodes[0];
    const beforeHash = computeDefinitionVersion(wfRepo.getWorkflow(created.id)!).versionHash;

    wfRepo.updateWorkflowNodeToolGuards(created.id, [
      {
        ...node,
        agents: [
          {
            ...node.agents[0],
            toolGuards: [
              { matcher: 'Bash', pattern: '^rm -rf', decision: 'deny', reason: 'no force-delete' },
            ],
          },
        ],
      },
    ]);

    const afterHash = computeDefinitionVersion(wfRepo.getWorkflow(created.id)!).versionHash;
    expect(afterHash).not.toBe(beforeHash);
    expect(versionCount(db, created.id)).toBe(2);
    expect(versionRepo.getVersion(created.id, afterHash)).not.toBeNull();
  });

  test('two workflows in the same space get independent version histories', () => {
    const a = wfRepo.createWorkflow({
      spaceId,
      name: 'A',
      nodes: [{ name: 'Only', agentId: 'agent-1' }],
    });
    const b = wfRepo.createWorkflow({
      spaceId,
      name: 'B',
      nodes: [{ name: 'Only', agentId: 'agent-1' }],
    });
    expect(versionCount(db, a.id)).toBe(1);
    expect(versionCount(db, b.id)).toBe(1);
    const aHash = computeDefinitionVersion(wfRepo.getWorkflow(a.id)!).versionHash;
    const bHash = computeDefinitionVersion(wfRepo.getWorkflow(b.id)!).versionHash;
    expect(aHash).not.toBe(bHash);
  });

  test('deleteWorkflow leaves version history intact (orphan-safe; no FK to head)', () => {
    const created = wfRepo.createWorkflow({
      spaceId,
      name: 'WF',
      nodes: [{ name: 'Only', agentId: 'agent-1' }],
    });
    const hash = computeDefinitionVersion(wfRepo.getWorkflow(created.id)!).versionHash;

    expect(wfRepo.deleteWorkflow(created.id)).toBe(true);
    expect(wfRepo.getWorkflow(created.id)).toBeNull();

    expect(versionRepo.getVersion(created.id, hash)).not.toBeNull();
  });

  test('deleting a whole Space cascades to remove its version rows (cleanup on space delete)', () => {
    const created = wfRepo.createWorkflow({
      spaceId,
      name: 'WF',
      nodes: [{ name: 'Only', agentId: 'agent-1' }],
    });
    expect(versionCount(db, created.id)).toBe(1);

    db.prepare(`DELETE FROM spaces WHERE id = ?`).run(spaceId);
    expect(versionCount(db, created.id)).toBe(0);
  });

  test('backfillExistingDefinitionVersions captures workflows with no version (pre-rollout rows)', () => {
    const created = wfRepo.createWorkflow({
      spaceId,
      name: 'Pre-existing',
      nodes: [{ name: 'Only', agentId: 'agent-1' }],
    });
    db.prepare(`DELETE FROM space_workflow_definition_versions WHERE workflow_id = ?`).run(
      created.id
    );
    expect(versionCount(db, created.id)).toBe(0);

    const captured = wfRepo.backfillExistingDefinitionVersions();
    expect(captured).toBe(1);
    expect(versionCount(db, created.id)).toBe(1);

    const fetched = wfRepo.getWorkflow(created.id)!;
    const v = versionRepo.getVersion(created.id, computeDefinitionVersion(fetched).versionHash);
    expect(v).not.toBeNull();
    expect(v?.source).toBe('backfill');
  });

  test('backfillExistingDefinitionVersions repairs a missing CURRENT head even when an older version exists (partial write)', () => {
    const created = wfRepo.createWorkflow({
      spaceId,
      name: 'WF',
      nodes: [{ name: 'Only', agentId: 'agent-1' }],
    });
    wfRepo.updateWorkflow(created.id, { name: 'Edited' });
    const editHash = computeDefinitionVersion(wfRepo.getWorkflow(created.id)!).versionHash;
    db.prepare(`DELETE FROM space_workflow_definition_versions WHERE version_hash = ?`).run(
      editHash
    );
    expect(versionCount(db, created.id)).toBe(1);

    const captured = wfRepo.backfillExistingDefinitionVersions();
    expect(captured).toBe(1);
    expect(versionRepo.getVersion(created.id, editHash)).not.toBeNull();
    expect(versionCount(db, created.id)).toBe(2);
  });

  test('backfillExistingDefinitionVersions is idempotent — a no-op once heads are captured', () => {
    const created = wfRepo.createWorkflow({
      spaceId,
      name: 'WF',
      nodes: [{ name: 'Only', agentId: 'agent-1' }],
    });
    expect(wfRepo.backfillExistingDefinitionVersions()).toBe(0);
    expect(versionCount(db, created.id)).toBe(1);
    expect(wfRepo.backfillExistingDefinitionVersions()).toBe(0);
  });

  test('backfillExistingDefinitionVersions skips a malformed workflow row without throwing (non-fatal at boot)', () => {
    const good = wfRepo.createWorkflow({
      spaceId,
      name: 'Good',
      nodes: [{ name: 'Only', agentId: 'agent-1' }],
    });
    const now = Date.now();
    db.prepare(
      `INSERT INTO space_workflows
         (id, space_id, name, description, start_node_id, end_node_id, tags, disabled,
          completion_autonomy_level, created_at, updated_at)
       VALUES (?, ?, 'Bad', '', NULL, NULL, '[]', 0, 3, ?, ?)`
    ).run('wf-bad', spaceId, now, now);
    db.prepare(
      `INSERT INTO space_workflow_nodes
         (id, workflow_id, name, description, config, created_at, updated_at)
       VALUES (?, 'wf-bad', 'Bad', '', '{"agents":"not-an-array"}', ?, ?)`
    ).run('n-bad', now, now);

    expect(() => wfRepo.backfillExistingDefinitionVersions()).not.toThrow();
    expect(versionCount(db, good.id)).toBe(1);
    expect(versionCount(db, 'wf-bad')).toBe(0);
  });
});
