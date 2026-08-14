/**
 * WorkflowRunArtifactRepository Tests
 */

import { describe, expect, it, beforeEach, afterEach } from 'bun:test';
import { Database } from '../../../../src/storage/sqlite-compat';
import { WorkflowRunArtifactRepository } from '../../../../src/storage/repositories/workflow-run-artifact-repository';
import { createSpaceTables } from '../../helpers/space-test-db';

describe('WorkflowRunArtifactRepository', () => {
  let db: Database;
  let repo: WorkflowRunArtifactRepository;
  const spaceId = 'space-1';
  const workflowId = 'wf-1';
  const runId = 'run-1';
  const nodeId = 'node-1';

  beforeEach(() => {
    db = new Database(':memory:');
    createSpaceTables(db);
    repo = new WorkflowRunArtifactRepository(db as any);

    const now = Date.now();
    (db as any)
      .prepare(
        'INSERT INTO spaces (id, slug, workspace_path, name, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)'
      )
      .run(spaceId, 'test', '/tmp/test', 'Test', now, now);
    (db as any)
      .prepare(
        'INSERT INTO space_workflows (id, space_id, name, created_at, updated_at) VALUES (?, ?, ?, ?, ?)'
      )
      .run(workflowId, spaceId, 'Workflow', now, now);
    (db as any)
      .prepare(
        'INSERT INTO space_workflow_runs (id, space_id, workflow_id, title, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)'
      )
      .run(runId, spaceId, workflowId, 'Run 1', now, now);
  });

  afterEach(() => {
    db.close();
  });

  describe('upsert', () => {
    it('inserts a new artifact and returns it', () => {
      const result = repo.upsert({
        id: 'art-1',
        runId,
        nodeId,
        artifactType: 'pr',
        artifactKey: 'main',
        data: { url: 'https://github.com/test/pr/1', number: 1 },
      });

      expect(result.id).toBe('art-1');
      expect(result.runId).toBe(runId);
      expect(result.nodeId).toBe(nodeId);
      expect(result.artifactType).toBe('pr');
      expect(result.artifactKey).toBe('main');
      expect(result.data).toEqual({ url: 'https://github.com/test/pr/1', number: 1 });
      expect(result.createdAt).toBeGreaterThan(0);
      expect(result.updatedAt).toBe(result.createdAt);
    });

    it('upsert on conflict preserves original id and createdAt, updates data', () => {
      const first = repo.upsert({
        id: 'art-1',
        runId,
        nodeId,
        artifactType: 'pr',
        artifactKey: 'main',
        data: { number: 1 },
      });

      const second = repo.upsert({
        id: 'art-DIFFERENT',
        runId,
        nodeId,
        artifactType: 'pr',
        artifactKey: 'main',
        data: { number: 1, state: 'merged' },
      });

      // Must return the original row's id, not the new UUID
      expect(second.id).toBe('art-1');
      expect(second.createdAt).toBe(first.createdAt);
      expect(second.updatedAt).toBeGreaterThanOrEqual(first.updatedAt);
      expect(second.data).toEqual({ number: 1, state: 'merged' });
    });
  });

  describe('listByRun', () => {
    it('returns all artifacts for a run', () => {
      repo.upsert({
        id: 'art-1',
        runId,
        nodeId,
        artifactType: 'pr',
        artifactKey: '',
        data: { number: 1 },
      });
      repo.upsert({
        id: 'art-2',
        runId,
        nodeId: 'node-2',
        artifactType: 'commit_set',
        artifactKey: '',
        data: { commits: [] },
      });

      const all = repo.listByRun(runId);
      expect(all).toHaveLength(2);
    });

    it('filters by nodeId', () => {
      repo.upsert({
        id: 'art-1',
        runId,
        nodeId,
        artifactType: 'pr',
        artifactKey: '',
        data: {},
      });
      repo.upsert({
        id: 'art-2',
        runId,
        nodeId: 'node-2',
        artifactType: 'pr',
        artifactKey: '',
        data: {},
      });

      const filtered = repo.listByRun(runId, { nodeId });
      expect(filtered).toHaveLength(1);
      expect(filtered[0].nodeId).toBe(nodeId);
    });

    it('filters by artifactType', () => {
      repo.upsert({
        id: 'art-1',
        runId,
        nodeId,
        artifactType: 'pr',
        artifactKey: '',
        data: {},
      });
      repo.upsert({
        id: 'art-2',
        runId,
        nodeId,
        artifactType: 'test_result',
        artifactKey: '',
        data: {},
      });

      const filtered = repo.listByRun(runId, { artifactType: 'test_result' });
      expect(filtered).toHaveLength(1);
      expect(filtered[0].artifactType).toBe('test_result');
    });

    it('returns empty for non-existent run', () => {
      expect(repo.listByRun('no-such-run')).toHaveLength(0);
    });
  });

  describe('listByRuns', () => {
    it('returns artifacts across many runs in one round-trip, grouped by runId', () => {
      const now = Date.now();
      (db as any)
        .prepare(
          `INSERT INTO space_workflow_runs (id, space_id, workflow_id, title, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)`
        )
        .run('run-2', spaceId, workflowId, 'Run 2', now, now);

      repo.upsert({ id: 'art-1', runId, nodeId, artifactType: 'pr', artifactKey: 'a', data: {} });
      repo.upsert({
        id: 'art-2',
        runId,
        nodeId,
        artifactType: 'pr',
        artifactKey: 'b',
        data: {},
      });
      repo.upsert({
        id: 'art-3',
        runId: 'run-2',
        nodeId,
        artifactType: 'pr',
        artifactKey: '',
        data: {},
      });

      const all = repo.listByRuns([runId, 'run-2']);
      expect(all).toHaveLength(3);
      expect(all.filter((artifact) => artifact.runId === runId)).toHaveLength(2);
      expect(all.filter((artifact) => artifact.runId === 'run-2')).toHaveLength(1);
    });

    it('returns empty for an empty run-id list without querying', () => {
      expect(repo.listByRuns([])).toEqual([]);
    });
  });

  describe('deleteByRun', () => {
    it('deletes all artifacts for a run and returns count', () => {
      repo.upsert({ id: 'a1', runId, nodeId, artifactType: 'pr', artifactKey: '', data: {} });
      repo.upsert({
        id: 'a2',
        runId,
        nodeId,
        artifactType: 'commit_set',
        artifactKey: '',
        data: {},
      });

      const deleted = repo.deleteByRun(runId);
      expect(deleted).toBe(2);
      expect(repo.listByRun(runId)).toHaveLength(0);
    });

    it('returns 0 when no artifacts exist', () => {
      expect(repo.deleteByRun('no-such-run')).toBe(0);
    });
  });

  describe('corrupted JSON handling', () => {
    it('skips rows with invalid JSON data', () => {
      // Insert a row with corrupted JSON directly via SQL
      (db as any)
        .prepare(
          `INSERT INTO workflow_run_artifacts (id, run_id, node_id, artifact_type, artifact_key, data, created_at, updated_at)
					 VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
        )
        .run('bad-1', runId, nodeId, 'pr', '', '{invalid json', Date.now(), Date.now());

      const results = repo.listByRun(runId);
      expect(results).toHaveLength(0);
    });
  });
});

// ---------------------------------------------------------------------------
// claimIdentityStamp — first-writer-wins identity stamp (round 54)
// ---------------------------------------------------------------------------

describe('WorkflowRunArtifactRepository.claimIdentityStamp', () => {
  let repo: WorkflowRunArtifactRepository;
  let db: Database;
  beforeEach(() => {
    db = new Database(':memory:');
    createSpaceTables(db);
    db.prepare(
      'INSERT INTO spaces (id, slug, workspace_path, name, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)'
    ).run('sp-1', 'sp-1', '/tmp', 'S', 1, 1);
    db.prepare(
      'INSERT INTO space_workflows (id, space_id, name, created_at, updated_at) VALUES (?, ?, ?, ?, ?)'
    ).run('wf-1', 'sp-1', 'W', 1, 1);
    db.prepare(
      'INSERT INTO space_workflow_runs (id, space_id, workflow_id, title, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)'
    ).run('run-1', 'sp-1', 'wf-1', 'R', 1, 1);
    repo = new WorkflowRunArtifactRepository(db);
  });
  afterEach(() => db.close());

  it('first claim inserts; a second with a DIFFERENT link is rejected', () => {
    const first = repo.claimIdentityStamp({
      id: 'a1',
      runId: 'run-1',
      nodeId: 'n-coding',
      artifactType: 'link',
      artifactKey: '__pr_validated__',
      data: { link: 'https://gb/pull/1', kind: 'pr' },
    });
    expect(first.inserted).toBe(true);

    // A second node's stamp for the same run/key (cross-node race) does NOT
    // overwrite — the first stamp is authoritative.
    const second = repo.claimIdentityStamp({
      id: 'a2',
      runId: 'run-1',
      nodeId: 'n-review',
      artifactType: 'link',
      artifactKey: '__pr_validated__',
      data: { link: 'https://gb/pull/2', kind: 'pr' },
    });
    expect(second.inserted).toBe(false);
    expect(second.existing?.data.link).toBe('https://gb/pull/1');
  });
});

// replaceIdentityStamp CAS — concurrent verified replacements (round 72)
describe('WorkflowRunArtifactRepository.replaceIdentityStamp CAS', () => {
  let db: Database;
  let repo: WorkflowRunArtifactRepository;

  beforeEach(() => {
    db = new Database(':memory:');
    createSpaceTables(db);
    db.prepare(
      `INSERT INTO spaces (id, slug, name, workspace_path, created_at, updated_at)
       VALUES ('sp-1', 'sp-1', 'S', '/tmp', 1, 1)`
    ).run();
    db.prepare(
      `INSERT INTO space_workflows (id, space_id, name, created_at, updated_at)
       VALUES ('wf-1', 'sp-1', 'W', 1, 1)`
    ).run();
    db.prepare(
      `INSERT INTO space_workflow_runs (id, space_id, workflow_id, title, status, created_at, updated_at)
       VALUES ('run-1', 'sp-1', 'wf-1', 'R', 'in_progress', 1, 1)`
    ).run();
    repo = new WorkflowRunArtifactRepository(db);
  });
  afterEach(() => db.close());

  it('refuses the LOSER of two concurrent verified replacements', () => {
    const prior = repo.claimIdentityStamp({
      id: 'p1',
      runId: 'run-1',
      nodeId: 'n-a',
      artifactType: 'link',
      artifactKey: '__pr_validated__',
      data: { link: 'https://gb/pull/1', kind: 'pr' },
    });
    expect(prior.inserted).toBe(true);

    // Both replacements verified the SAME prior stamp (row p1) before either
    // committed. The winner installs first...
    const winner = repo.replaceIdentityStamp({
      id: 'w1',
      runId: 'run-1',
      nodeId: 'n-a',
      artifactType: 'link',
      artifactKey: '__pr_validated__',
      data: { link: 'https://gb/pull/2', kind: 'pr' },
      expectedPriorId: 'p1',
    });
    expect(winner).toBe(true);

    // ...then the loser's CAS observes the authoritative row has changed and
    // REFUSES — it must not clobber the winner's stamp.
    const loser = repo.replaceIdentityStamp({
      id: 'l1',
      runId: 'run-1',
      nodeId: 'n-b',
      artifactType: 'link',
      artifactKey: '__pr_validated__',
      data: { link: 'https://gb/pull/3', kind: 'pr' },
      expectedPriorId: 'p1',
    });
    expect(loser).toBe(false);
    const current = repo
      .listByRun('run-1', { artifactKeyPrefix: '__pr_validated__' })
      .find(() => true);
    expect(current?.data.link).toBe('https://gb/pull/2');
  });

  it('proceeds when the observed prior stamp is still authoritative', () => {
    repo.claimIdentityStamp({
      id: 'p1',
      runId: 'run-1',
      nodeId: 'n-a',
      artifactType: 'link',
      artifactKey: '__pr_validated__',
      data: { link: 'https://gb/pull/1', kind: 'pr' },
    });
    const ok = repo.replaceIdentityStamp({
      id: 'w1',
      runId: 'run-1',
      nodeId: 'n-a',
      artifactType: 'link',
      artifactKey: '__pr_validated__',
      data: { link: 'https://gb/pull/9', kind: 'pr' },
      expectedPriorId: 'p1',
    });
    expect(ok).toBe(true);
    const current = repo
      .listByRun('run-1', { artifactKeyPrefix: '__pr_validated__' })
      .find(() => true);
    expect(current?.data.link).toBe('https://gb/pull/9');
  });
});
