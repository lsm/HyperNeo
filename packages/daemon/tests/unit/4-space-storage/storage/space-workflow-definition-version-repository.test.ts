/**
 * SpaceWorkflowDefinitionVersionRepository + shadow recording integration.
 *
 * Covers (a) the content-hash identity function, (b) the append-only history repository,
 * and (c) that SpaceWorkflowRepository.createWorkflow/updateWorkflow/updateWorkflowNodeToolGuards/deleteWorkflow
 * populate it in shadow mode — without changing any run read path.
 */

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

/** Raw count of recorded versions for a workflow (the repo deliberately exposes no count reader). */
function versionCount(db: Database, workflowId: string): number {
  return (
    db
      .prepare(`SELECT COUNT(*) AS n FROM space_workflow_definition_versions WHERE workflow_id = ?`)
      .get(workflowId) as { n: number }
  ).n;
}

/** Minimal valid SpaceWorkflow for hash-determinism assertions. */
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

  test('same behavioral content → same version hash, regardless of property order', () => {
    const a = wf({ id: 'x', nodes: [{ id: 'n', name: 'X', agents: [] }] });
    const b = wf({ id: 'x', nodes: [{ id: 'n', name: 'X', agents: [] }] });
    // Same content inserted in a different key order still hashes identically.
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
    // A SEPARATE repository instance over the same DB — proves the recorded versions
    // are persisted (survive a "restart") and readable by an independent reader, not
    // just an in-memory side-effect of the workflow repo.
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

    // The recorded hash matches a freshly-computed hash of the persisted workflow.
    const fetched = wfRepo.getWorkflow(created.id)!;
    const hash = computeDefinitionVersion(fetched).versionHash;
    const v = versionRepo.getVersion(created.id, hash);
    expect(v).not.toBeNull();
    expect(v?.source).toBe('create');

    // The recorded payload round-trips to the persisted definition.
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
    // Both versions are present, with the right sources and distinct hashes.
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
    // No fields, no nodes → getWorkflow returns identical content → same hash → no-op.
    wfRepo.updateWorkflow(created.id, {});
    expect(versionCount(db, created.id)).toBe(1);
  });

  test('updateWorkflowNodeToolGuards records a version when a tool guard changes', () => {
    const created = wfRepo.createWorkflow({
      spaceId,
      name: 'WF',
      nodes: [{ name: 'Only', agentId: 'agent-1' }],
    });
    const node = created.nodes[0];
    const beforeHash = computeDefinitionVersion(wfRepo.getWorkflow(created.id)!).versionHash;

    // A tool-guard-only change (no full updateWorkflow) still mutates behavioral content
    // (node config), so it must be recorded as a new version.
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

    // The head is gone, but the immutable version snapshot survives (RFC §4
    // orphan/tombstone policy: deleting a definition must not erase a pinned version).
    expect(versionRepo.getVersion(created.id, hash)).not.toBeNull();
  });

  test('deleting a whole Space cascades to remove its version rows (cleanup on space delete)', () => {
    const created = wfRepo.createWorkflow({
      spaceId,
      name: 'WF',
      nodes: [{ name: 'Only', agentId: 'agent-1' }],
    });
    expect(versionCount(db, created.id)).toBe(1);

    // Whole-Space deletion cascades via the space_id FK (matches space_workflow_runs),
    // so version payloads (prompts/instructions) do not outlive the Space.
    db.prepare(`DELETE FROM spaces WHERE id = ?`).run(spaceId);
    expect(versionCount(db, created.id)).toBe(0);
  });

  test('backfillExistingDefinitionVersions captures workflows with no version (pre-rollout rows)', () => {
    const created = wfRepo.createWorkflow({
      spaceId,
      name: 'Pre-existing',
      nodes: [{ name: 'Only', agentId: 'agent-1' }],
    });
    // Simulate a workflow that predates the version-history feature: wipe its record.
    db.prepare(`DELETE FROM space_workflow_definition_versions WHERE workflow_id = ?`).run(
      created.id
    );
    expect(versionCount(db, created.id)).toBe(0);

    const captured = wfRepo.backfillExistingDefinitionVersions();
    expect(captured).toBe(1);
    expect(versionCount(db, created.id)).toBe(1);

    // The backfilled hash is byte-consistent with what live writes produce.
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
    // Edit the head (records the edit version), then wipe ONLY that edit version —
    // simulating a head committed whose version append was swallowed. An older version
    // (the create version) remains, so a naive "has any version" predicate would skip it.
    wfRepo.updateWorkflow(created.id, { name: 'Edited' });
    const editHash = computeDefinitionVersion(wfRepo.getWorkflow(created.id)!).versionHash;
    db.prepare(`DELETE FROM space_workflow_definition_versions WHERE version_hash = ?`).run(
      editHash
    );
    expect(versionCount(db, created.id)).toBe(1); // only the create version remains

    // Backfill keys on the current head's hash and captures the missing edit version.
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
    // createWorkflow already recorded a version → backfill finds nothing to do.
    expect(wfRepo.backfillExistingDefinitionVersions()).toBe(0);
    expect(versionCount(db, created.id)).toBe(1);
    // A second run is also a no-op.
    expect(wfRepo.backfillExistingDefinitionVersions()).toBe(0);
  });
});
