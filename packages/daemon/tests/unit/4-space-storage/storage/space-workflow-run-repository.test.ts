import { describe, expect, it, beforeEach, afterEach } from 'bun:test';
import { Database } from '../../../../src/storage/sqlite-compat';
import { SpaceRepository } from '../../../../src/storage/repositories/space-repository';
import { SpaceWorkflowRunRepository } from '../../../../src/storage/repositories/space-workflow-run-repository';
import { SpaceWorkflowRepository } from '../../../../src/storage/repositories/space-workflow-repository';
import { createSpaceTables } from '../../helpers/space-test-db';
import { computeDefinitionVersion } from '../../../../src/lib/space/workflows/definition-version';
import type { SpaceWorkflow } from '@hyperneo/shared';

describe('SpaceWorkflowRunRepository', () => {
  let db: Database;
  let spaceRepo: SpaceRepository;
  let repo: SpaceWorkflowRunRepository;
  let spaceId: string;
  const WORKFLOW_ID = 'workflow-1';

  beforeEach(() => {
    db = new Database(':memory:');
    createSpaceTables(db);
    spaceRepo = new SpaceRepository(db as any);
    repo = new SpaceWorkflowRunRepository(db as any);

    const space = spaceRepo.createSpace({
      workspacePath: '/workspace/test',
      slug: 'test',
      name: 'Test',
    });
    spaceId = space.id;

    const now = Date.now();
    (db as any)
      .prepare(
        `INSERT INTO space_workflows (id, space_id, name, created_at, updated_at) VALUES (?, ?, ?, ?, ?)`
      )
      .run(WORKFLOW_ID, spaceId, 'My Workflow', now, now);
  });

  afterEach(() => {
    db.close();
  });

  function rawWorkflow(overrides: Partial<SpaceWorkflow> = {}): SpaceWorkflow {
    return {
      id: WORKFLOW_ID,
      spaceId,
      name: 'My Workflow',
      nodes: [],
      startNodeId: '',
      tags: [],
      completionAutonomyLevel: 3,
      createdAt: 1,
      updatedAt: 1,
      ...overrides,
    };
  }

  function seedTaskForRun(runId: string, sId: string, opts: { archived?: boolean } = {}): void {
    const now = Date.now();
    db.prepare(
      `INSERT INTO space_tasks
         (id, space_id, task_number, title, status, workflow_run_id, archived_at, created_at, updated_at)
       VALUES (?, ?, ?, 'Task', 'open', ?, ?, ?, ?)`
    ).run(`task-${runId}`, sId, runId, runId, opts.archived ? now : null, now, now);
  }

  describe('createRun', () => {
    it('creates a run with required fields', () => {
      const run = repo.createRun({ spaceId, workflowId: WORKFLOW_ID, title: 'Run #1' });

      expect(run.id).toBeDefined();
      expect(run.spaceId).toBe(spaceId);
      expect(run.workflowId).toBe(WORKFLOW_ID);
      expect(run.definitionVersion).toBeNull();
      expect(run.title).toBe('Run #1');
      expect(run.status).toBe('pending');
      expect(run.completedAt).toBeNull();
      expect(run.startedAt).toBeNull();
    });

    it('creates a run with description', () => {
      const run = repo.createRun({
        spaceId,
        workflowId: WORKFLOW_ID,
        title: 'Run #2',
        description: 'Deploy v2.0',
      });
      expect(run.description).toBe('Deploy v2.0');
    });
  });

  describe('createPinnedRun', () => {
    it('atomically records and pins the raw workflow definition', () => {
      const workflow = rawWorkflow({ name: 'Pinned' });
      const expected = computeDefinitionVersion(workflow);

      const run = repo.createPinnedRun({
        spaceId,
        workflowId: WORKFLOW_ID,
        title: 'Pinned run',
        rawWorkflow: workflow,
      });

      expect(run.definitionVersion).toBe(expected.versionHash);
      const version = db
        .prepare(
          `SELECT payload, source FROM space_workflow_definition_versions
           WHERE workflow_id = ? AND version_hash = ?`
        )
        .get(WORKFLOW_ID, expected.versionHash) as { payload: string; source: string };
      expect(version.payload).toBe(expected.payload);
      expect(version.source).toBe('run_create');
    });

    it('reuses one immutable version for identical definitions', () => {
      const workflow = rawWorkflow();
      const first = repo.createPinnedRun({
        spaceId,
        workflowId: WORKFLOW_ID,
        title: 'First',
        rawWorkflow: workflow,
      });
      const second = repo.createPinnedRun({
        spaceId,
        workflowId: WORKFLOW_ID,
        title: 'Second',
        rawWorkflow: workflow,
      });

      expect(second.definitionVersion).toBe(first.definitionVersion);
      const count = db
        .prepare(
          `SELECT COUNT(*) AS count FROM space_workflow_definition_versions
           WHERE workflow_id = ?`
        )
        .get(WORKFLOW_ID) as { count: number };
      expect(count.count).toBe(1);
    });

    it('rolls back a newly appended version when run insertion fails', () => {
      db.exec(`
        CREATE TRIGGER reject_pinned_run BEFORE INSERT ON space_workflow_runs
        BEGIN SELECT RAISE(ABORT, 'reject run'); END
      `);

      expect(() =>
        repo.createPinnedRun({
          spaceId,
          workflowId: WORKFLOW_ID,
          title: 'Rejected',
          rawWorkflow: rawWorkflow(),
        })
      ).toThrow('reject run');
      const count = db
        .prepare(`SELECT COUNT(*) AS count FROM space_workflow_definition_versions`)
        .get() as { count: number };
      expect(count.count).toBe(0);
    });

    it('creates no run when the version append fails', () => {
      db.exec(`
        CREATE TRIGGER reject_version BEFORE INSERT ON space_workflow_definition_versions
        BEGIN SELECT RAISE(ABORT, 'reject version'); END
      `);

      expect(() =>
        repo.createPinnedRun({
          spaceId,
          workflowId: WORKFLOW_ID,
          title: 'Rejected',
          rawWorkflow: rawWorkflow(),
        })
      ).toThrow('reject version');
      const count = db.prepare(`SELECT COUNT(*) AS count FROM space_workflow_runs`).get() as {
        count: number;
      };
      expect(count.count).toBe(0);
    });
  });

  describe('getRun', () => {
    it('returns run by ID', () => {
      const created = repo.createRun({ spaceId, workflowId: WORKFLOW_ID, title: 'R' });
      expect(repo.getRun(created.id)).not.toBeNull();
    });

    it('returns null for unknown ID', () => {
      expect(repo.getRun('nonexistent')).toBeNull();
    });
  });

  describe('getRunsByIds', () => {
    it('returns matching runs in one round-trip and omits unknown ids', () => {
      const r1 = repo.createRun({ spaceId, workflowId: WORKFLOW_ID, title: 'R1' });
      const r2 = repo.createRun({ spaceId, workflowId: WORKFLOW_ID, title: 'R2' });
      const result = repo.getRunsByIds([r1.id, 'unknown', r2.id]);
      expect(result.map((run) => run.id).sort()).toEqual([r1.id, r2.id].sort());
    });

    it('returns empty for an empty id list without querying', () => {
      expect(repo.getRunsByIds([])).toEqual([]);
    });
  });

  describe('listBySpace', () => {
    it('returns runs for a space in descending order', () => {
      repo.createRun({ spaceId, workflowId: WORKFLOW_ID, title: 'R1' });
      repo.createRun({ spaceId, workflowId: WORKFLOW_ID, title: 'R2' });

      const runs = repo.listBySpace(spaceId);
      expect(runs).toHaveLength(2);
    });

    it('returns empty for unknown space', () => {
      expect(repo.listBySpace('unknown')).toHaveLength(0);
    });
  });

  describe('getActiveRuns', () => {
    it('returns only in_progress runs (excludes pending and done)', () => {
      repo.createRun({ spaceId, workflowId: WORKFLOW_ID, title: 'Pending' });

      const r2 = repo.createRun({ spaceId, workflowId: WORKFLOW_ID, title: 'Active' });
      repo.transitionStatus(r2.id, 'in_progress');

      const r3 = repo.createRun({ spaceId, workflowId: WORKFLOW_ID, title: 'Done' });
      repo.updateStatusUnchecked(r3.id, 'done');

      const active = repo.getActiveRuns(spaceId);
      expect(active).toHaveLength(1);
      expect(active[0].title).toBe('Active');
    });
  });

  describe('getRehydratableRuns', () => {
    it('returns in_progress and blocked runs; excludes pending, done, cancelled', () => {
      repo.createRun({ spaceId, workflowId: WORKFLOW_ID, title: 'Pending' });

      const r2 = repo.createRun({ spaceId, workflowId: WORKFLOW_ID, title: 'InProgress' });
      repo.transitionStatus(r2.id, 'in_progress');

      const r3 = repo.createRun({ spaceId, workflowId: WORKFLOW_ID, title: 'Blocked' });
      repo.updateStatusUnchecked(r3.id, 'blocked');

      const r4 = repo.createRun({ spaceId, workflowId: WORKFLOW_ID, title: 'Done' });
      repo.updateStatusUnchecked(r4.id, 'done');

      const r5 = repo.createRun({ spaceId, workflowId: WORKFLOW_ID, title: 'Cancelled' });
      repo.transitionStatus(r5.id, 'cancelled');

      const rehydratable = repo.getRehydratableRuns(spaceId);
      expect(rehydratable).toHaveLength(2);
      const titles = rehydratable.map((r) => r.title).sort();
      expect(titles).toEqual(['Blocked', 'InProgress']);
    });
  });

  describe('updateRun', () => {
    it('updates title and description', () => {
      const run = repo.createRun({ spaceId, workflowId: WORKFLOW_ID, title: 'R' });
      const updated = repo.updateRun(run.id, { title: 'Updated', description: 'New desc' });
      expect(updated!.title).toBe('Updated');
      expect(updated!.description).toBe('New desc');
    });

    it('sets completedAt when status is done', () => {
      const run = repo.createRun({ spaceId, workflowId: WORKFLOW_ID, title: 'R' });
      const updated = repo.updateRun(run.id, { status: 'done' });
      expect(updated!.completedAt).toBeDefined();
    });

    it('sets completedAt when status is cancelled', () => {
      const run = repo.createRun({ spaceId, workflowId: WORKFLOW_ID, title: 'R' });
      const updated = repo.updateRun(run.id, { status: 'cancelled' });
      expect(updated!.completedAt).toBeDefined();
    });

    it('sets startedAt when status is in_progress', () => {
      const run = repo.createRun({ spaceId, workflowId: WORKFLOW_ID, title: 'R' });
      const updated = repo.updateRun(run.id, { status: 'in_progress' });
      expect(updated!.startedAt).toBeDefined();
    });
  });

  describe('updateStatusUnchecked', () => {
    it('updates only the status, bypassing transition guards', () => {
      const run = repo.createRun({ spaceId, workflowId: WORKFLOW_ID, title: 'R' });
      const updated = repo.updateStatusUnchecked(run.id, 'in_progress');
      expect(updated!.status).toBe('in_progress');
    });
  });

  describe('deleteRun', () => {
    it('deletes a run', () => {
      const run = repo.createRun({ spaceId, workflowId: WORKFLOW_ID, title: 'R' });
      expect(repo.deleteRun(run.id)).toBe(true);
      expect(repo.getRun(run.id)).toBeNull();
    });

    it('returns false for unknown ID', () => {
      expect(repo.deleteRun('nonexistent')).toBe(false);
    });
  });

  describe('startedAt field', () => {
    it('starts as null', () => {
      const run = repo.createRun({
        spaceId,
        workflowId: WORKFLOW_ID,
        title: 'R',
      });
      expect(run.startedAt).toBeNull();
    });

    it('is set when transitioning to in_progress', () => {
      const run = repo.createRun({
        spaceId,
        workflowId: WORKFLOW_ID,
        title: 'Round-trip',
      });
      repo.transitionStatus(run.id, 'in_progress');
      const fetched = repo.getRun(run.id)!;
      expect(fetched.startedAt).not.toBeNull();
    });
  });

  describe('pinExistingRun + backfillDefinitionPins (Phase 1 read-cutover backfill)', () => {
    it('listPinnableRuns returns only runs without a definition pin', () => {
      const legacy = repo.createRun({ spaceId, workflowId: WORKFLOW_ID, title: 'Legacy' });
      seedTaskForRun(legacy.id, spaceId);
      const pinned = repo.createPinnedRun({
        spaceId,
        workflowId: WORKFLOW_ID,
        title: 'Pinned',
        rawWorkflow: rawWorkflow(),
      });
      const ids = repo.listPinnableRuns().map((r) => r.id);
      expect(ids).toContain(legacy.id);
      expect(ids).not.toContain(pinned.id);
    });

    it('listPinnableRuns excludes runs whose canonical task is archived (tombstoned)', () => {
      const live = repo.createRun({ spaceId, workflowId: WORKFLOW_ID, title: 'Live' });
      seedTaskForRun(live.id, spaceId);
      const archived = repo.createRun({ spaceId, workflowId: WORKFLOW_ID, title: 'Archived' });
      seedTaskForRun(archived.id, spaceId, { archived: true });

      const ids = repo.listPinnableRuns().map((r) => r.id);
      expect(ids).toContain(live.id);
      expect(ids).not.toContain(archived.id);
    });

    it('pinExistingRun stamps a pin and appends the version row atomically', () => {
      const run = repo.createRun({ spaceId, workflowId: WORKFLOW_ID, title: 'Legacy' });
      expect(run.definitionVersion).toBeNull();

      const wf = rawWorkflow({ name: 'Backfilled' });
      const ok = repo.pinExistingRun(run.id, wf);

      expect(ok).toBe(true);
      const stamped = repo.getRun(run.id)!;
      expect(stamped.definitionVersion).toBe(computeDefinitionVersion(wf).versionHash);
      const row = db
        .prepare(
          `SELECT source FROM space_workflow_definition_versions
           WHERE workflow_id = ? AND version_hash = ?`
        )
        .get(WORKFLOW_ID, stamped.definitionVersion) as { source: string };
      expect(row.source).toBe('backfill');
    });

    it('pinExistingRun is idempotent and never overwrites an existing pin', () => {
      const run = repo.createRun({ spaceId, workflowId: WORKFLOW_ID, title: 'Legacy' });
      const first = rawWorkflow({ name: 'First' });
      repo.pinExistingRun(run.id, first);
      const firstPin = repo.getRun(run.id)!.definitionVersion;

      const ok = repo.pinExistingRun(run.id, rawWorkflow({ name: 'Second' }));

      expect(ok).toBe(false);
      expect(repo.getRun(run.id)!.definitionVersion).toBe(firstPin);
    });

    it('backfillDefinitionPins pins every unpinned run with an existing head', () => {
      const a = repo.createRun({ spaceId, workflowId: WORKFLOW_ID, title: 'A' });
      const b = repo.createRun({ spaceId, workflowId: WORKFLOW_ID, title: 'B' });
      seedTaskForRun(a.id, spaceId);
      seedTaskForRun(b.id, spaceId);
      const wf = rawWorkflow();
      const expectedHash = computeDefinitionVersion(wf).versionHash;

      const count = repo.backfillDefinitionPins(() => wf);

      expect(count).toBe(2);
      expect(repo.getRun(a.id)!.definitionVersion).toBe(expectedHash);
      expect(repo.getRun(b.id)!.definitionVersion).toBe(expectedHash);
    });

    it('backfillDefinitionPins leaves runs unpinned when the head is deleted and is idempotent', () => {
      const live = repo.createRun({ spaceId, workflowId: WORKFLOW_ID, title: 'Live' });
      const orphan = repo.createRun({ spaceId, workflowId: 'deleted-wf', title: 'Orphan' });
      seedTaskForRun(live.id, spaceId);
      seedTaskForRun(orphan.id, spaceId);
      const wf = rawWorkflow();

      let calls = 0;
      const count = repo.backfillDefinitionPins((id) => {
        calls += 1;
        return id === WORKFLOW_ID ? wf : null;
      });

      expect(count).toBe(1);
      expect(repo.getRun(live.id)!.definitionVersion).not.toBeNull();
      expect(repo.getRun(orphan.id)!.definitionVersion).toBeNull();

      const second = repo.backfillDefinitionPins((id) => (id === WORKFLOW_ID ? wf : null));
      expect(second).toBe(0);
      expect(calls).toBeGreaterThan(0);
    });

    it('backfillDefinitionPins isolates failures: one bad run does not block the others', () => {
      const good = repo.createRun({ spaceId, workflowId: WORKFLOW_ID, title: 'Good' });
      const bad = repo.createRun({ spaceId, workflowId: 'broken-wf', title: 'Bad' });
      seedTaskForRun(good.id, spaceId);
      seedTaskForRun(bad.id, spaceId);
      const wf = rawWorkflow();
      const expectedHash = computeDefinitionVersion(wf).versionHash;

      const count = repo.backfillDefinitionPins((id) => {
        if (id === 'broken-wf') throw new Error('boom');
        return wf;
      });

      expect(count).toBe(1);
      expect(repo.getRun(good.id)!.definitionVersion).toBe(expectedHash);
      expect(repo.getRun(bad.id)!.definitionVersion).toBeNull();
    });
  });

  describe('deletion-safety (RFC §4 #3)', () => {
    let workflowRepo: SpaceWorkflowRepository;

    beforeEach(() => {
      workflowRepo = new SpaceWorkflowRepository(db as any);
    });

    it('hasExecutableRuns is false when there are no runs', () => {
      expect(workflowRepo.hasExecutableRuns(WORKFLOW_ID)).toBe(false);
    });

    it('hasExecutableRuns is false for a terminal run whose task is archived (tombstone)', () => {
      const run = repo.createRun({ spaceId, workflowId: WORKFLOW_ID, title: 'R' });
      repo.updateStatusUnchecked(run.id, 'cancelled');
      seedTaskForRun(run.id, spaceId, { archived: true });
      expect(workflowRepo.hasExecutableRuns(WORKFLOW_ID)).toBe(false);
    });

    it('hasExecutableRuns is true when the run task is not archived', () => {
      const run = repo.createRun({ spaceId, workflowId: WORKFLOW_ID, title: 'R' });
      seedTaskForRun(run.id, spaceId);
      expect(workflowRepo.hasExecutableRuns(WORKFLOW_ID)).toBe(true);
    });

    it('hasExecutableRuns protects a reopenable done/cancelled run (task not archived)', () => {
      const run = repo.createRun({ spaceId, workflowId: WORKFLOW_ID, title: 'R' });
      repo.updateStatusUnchecked(run.id, 'done');
      seedTaskForRun(run.id, spaceId);
      expect(workflowRepo.hasExecutableRuns(WORKFLOW_ID)).toBe(true);
    });

    it('hasExecutableRuns protects a non-terminal run with NO task yet (startup window)', () => {
      const run = repo.createRun({ spaceId, workflowId: WORKFLOW_ID, title: 'R' });
      expect(workflowRepo.hasExecutableRuns(WORKFLOW_ID)).toBe(true);
    });

    it('hasExecutableRuns protects a TERMINAL run with no task (failure-cleanup case)', () => {
      const run = repo.createRun({ spaceId, workflowId: WORKFLOW_ID, title: 'R' });
      repo.updateStatusUnchecked(run.id, 'cancelled');
      expect(workflowRepo.hasExecutableRuns(WORKFLOW_ID)).toBe(true);
    });

    it('hasExecutableRuns treats a non-terminal run with ALL tasks archived as a tombstone', () => {
      const run = repo.createRun({ spaceId, workflowId: WORKFLOW_ID, title: 'stale' });
      seedTaskForRun(run.id, spaceId, { archived: true });
      expect(workflowRepo.hasExecutableRuns(WORKFLOW_ID)).toBe(false);
    });

    it('deleteByWorkflowId removes only tombstoned runs and protects executable ones', () => {
      const tombstoned = repo.createRun({ spaceId, workflowId: WORKFLOW_ID, title: 'tomb' });
      repo.updateStatusUnchecked(tombstoned.id, 'cancelled');
      seedTaskForRun(tombstoned.id, spaceId, { archived: true });

      const liveRun = repo.createRun({ spaceId, workflowId: WORKFLOW_ID, title: 'live' });
      seedTaskForRun(liveRun.id, spaceId);

      repo.deleteByWorkflowId(WORKFLOW_ID);
      expect(repo.getRun(tombstoned.id)).toBeNull();
      expect(repo.getRun(liveRun.id)).not.toBeNull();
    });

    it('deleteByWorkflowId cleans up a non-terminal run whose tasks are all archived', () => {
      const stale = repo.createRun({ spaceId, workflowId: WORKFLOW_ID, title: 'stale' });
      seedTaskForRun(stale.id, spaceId, { archived: true });
      repo.deleteByWorkflowId(WORKFLOW_ID);
      expect(repo.getRun(stale.id)).toBeNull();
    });

    it('deleteByWorkflowId protects a non-terminal run that has no task yet (startup window)', () => {
      const run = repo.createRun({ spaceId, workflowId: WORKFLOW_ID, title: 'starting' });
      repo.deleteByWorkflowId(WORKFLOW_ID);
      expect(repo.getRun(run.id)).not.toBeNull();
    });

    it('deleteByWorkflowId protects a terminal run with no task (failure-cleanup case)', () => {
      const run = repo.createRun({ spaceId, workflowId: WORKFLOW_ID, title: 'cancelled-notask' });
      repo.updateStatusUnchecked(run.id, 'cancelled');
      repo.deleteByWorkflowId(WORKFLOW_ID);
      expect(repo.getRun(run.id)).not.toBeNull();
    });

    it('deleteByWorkflowId is a no-op when every run is still executable', () => {
      const run = repo.createRun({ spaceId, workflowId: WORKFLOW_ID, title: 'live' });
      seedTaskForRun(run.id, spaceId);
      expect(repo.deleteByWorkflowId(WORKFLOW_ID)).toBe(0);
      expect(repo.getRun(run.id)).not.toBeNull();
    });
  });
});
