import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DirectTaskExecutionRepository } from '../../../../src/storage/repositories/direct-task-execution-repository';
import { SpaceTaskRepository } from '../../../../src/storage/repositories/space-task-repository';
import { describe, expect, it, beforeEach, afterEach } from 'bun:test';
import { Database } from '../../../../src/storage/sqlite-compat';
import { SpaceRepository } from '../../../../src/storage/repositories/space-repository';
import { SpaceWorkflowRunRepository } from '../../../../src/storage/repositories/space-workflow-run-repository';
import { SpaceWorkflowRepository } from '../../../../src/storage/repositories/space-workflow-repository';
import { createSpaceTables } from '../../helpers/space-test-db';
import { computeDefinitionVersion } from '../../../../src/lib/space/workflows/definition-version';
import type { SpaceAgentTemplate, SpaceWorkflow } from '@hyperneo/shared';

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

  function pinnedPayload(versionHash: string): string {
    return (
      db
        .prepare(
          `SELECT payload FROM space_workflow_definition_versions
           WHERE workflow_id = ? AND version_hash = ?`
        )
        .get(WORKFLOW_ID, versionHash) as { payload: string }
    ).payload;
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
    it('a restart immediately after pinning can rehydrate the attached run', () => {
      const task = new SpaceTaskRepository(db).createTask({
        spaceId,
        title: 'Task',
        description: '',
      });
      const run = repo.createPinnedRun({
        spaceId,
        workflowId: WORKFLOW_ID,
        title: 'Run',
        rawWorkflow: rawWorkflow(),
        parentTaskId: task.id,
      });
      const directory = mkdtempSync(join(tmpdir(), 'pinned-restart-'));
      let restarted: Database | undefined;
      try {
        const file = join(directory, 'persisted.db');
        db.prepare('VACUUM INTO ?').run(file);
        restarted = new Database(file);
        expect(new SpaceWorkflowRunRepository(restarted).getRehydratableRuns(spaceId)).toEqual([
          expect.objectContaining({ id: run.id, status: 'in_progress' }),
        ]);
        expect(new SpaceTaskRepository(restarted).getTask(task.id)?.workflowRunId).toBe(run.id);
        expect(new SpaceTaskRepository(restarted).listStandaloneBySpace(spaceId)).toHaveLength(0);
      } finally {
        restarted?.close();
        rmSync(directory, { recursive: true, force: true });
      }
    });

    it('attaches the task atomically and prevents direct selection afterward', () => {
      const tasks = new SpaceTaskRepository(db);
      const direct = new DirectTaskExecutionRepository(db);
      const task = tasks.createTask({ spaceId, title: 'Task', description: '' });
      const params = {
        spaceId,
        workflowId: WORKFLOW_ID,
        title: 'Run',
        rawWorkflow: rawWorkflow(),
        parentTaskId: task.id,
      };
      const run = repo.createPinnedRun(params);
      expect(tasks.getTask(task.id)?.workflowRunId).toBe(run.id);
      expect(direct.select(task.id)).toBe(false);
      expect(direct.claim(task.id, 'attempt', 'session')).toBeNull();
      expect(() => repo.createPinnedRun(params)).toThrow('not available');
      expect(repo.listBySpace(spaceId)).toHaveLength(1);
    });

    it('direct selection wins without leaving a run or definition snapshot', () => {
      const tasks = new SpaceTaskRepository(db);
      const direct = new DirectTaskExecutionRepository(db);
      const task = tasks.createTask({ spaceId, title: 'Task', description: '' });
      direct.select(task.id);
      const attempt = direct.claim(task.id, 'attempt', 'session');
      const before = db
        .prepare('SELECT COUNT(*) AS count FROM space_workflow_definition_versions')
        .get();
      expect(() =>
        repo.createPinnedRun({
          spaceId,
          workflowId: WORKFLOW_ID,
          title: 'Run',
          rawWorkflow: rawWorkflow(),
          parentTaskId: task.id,
        })
      ).toThrow('not available');
      expect(repo.listBySpace(spaceId)).toHaveLength(0);
      expect(
        db.prepare('SELECT COUNT(*) AS count FROM space_workflow_definition_versions').get()
      ).toEqual(before);
      expect(direct.getActive(task.id)).toEqual(attempt);
      expect(tasks.getTask(task.id)?.workflowRunId).toBeUndefined();
    });

    it('attachment rejects ineligible task state and missing tasks atomically', () => {
      const task = new SpaceTaskRepository(db).createTask({
        spaceId,
        title: 'Task',
        description: '',
        status: 'done',
      });
      for (const parentTaskId of [task.id, 'missing']) {
        expect(() =>
          repo.createPinnedRun({
            spaceId,
            workflowId: WORKFLOW_ID,
            title: 'Run',
            rawWorkflow: rawWorkflow(),
            parentTaskId,
          })
        ).toThrow('not available');
      }
      expect(repo.listBySpace(spaceId)).toHaveLength(0);
    });

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

    it('embeds resolved template snapshots into the pinned definition payload', () => {
      const workflow = rawWorkflow({
        nodes: [
          {
            id: 'n1',
            name: 'Build',
            agents: [{ agentId: '', templateKey: 'worker.custom', name: 'Worker' }],
          },
        ],
      });

      const run = repo.createPinnedRun(
        {
          spaceId,
          workflowId: WORKFLOW_ID,
          title: 'Snapshot run',
          rawWorkflow: workflow,
        },
        (key) =>
          key === 'worker.custom'
            ? {
                key: 'worker.custom',
                handle: 'custom-worker',
                displayName: 'Custom Worker',
                description: 'A custom worker template.',
                instructions: 'Frozen instructions.',
                suggestedAutonomyLevel: 2,
                model: 'claude-sonnet-5',
                provider: 'anthropic',
                modelPool: null,
                thinkingLevel: null,
                settingSources: null,
                tools: ['Read'],
                labels: ['workflow-worker'],
                createdAt: 111,
                updatedAt: 222,
              }
            : null
      );

      const version = db
        .prepare(
          `SELECT version_hash, payload FROM space_workflow_definition_versions
           WHERE workflow_id = ? AND version_hash = ?`
        )
        .get(WORKFLOW_ID, run.definitionVersion) as { version_hash: string; payload: string };
      const pinned = JSON.parse(version.payload) as SpaceWorkflow;
      expect(pinned.templateSnapshots?.['worker.custom']).toEqual({
        key: 'worker.custom',
        handle: 'custom-worker',
        displayName: 'Custom Worker',
        description: 'A custom worker template.',
        instructions: 'Frozen instructions.',
        suggestedAutonomyLevel: 2,
        model: 'claude-sonnet-5',
        provider: 'anthropic',
        modelPool: null,
        thinkingLevel: null,
        settingSources: null,
        tools: ['Read'],
        labels: ['workflow-worker'],
      });
      expect(computeDefinitionVersion(workflow).versionHash).not.toBe(run.definitionVersion);
    });

    it('pins an empty snapshot record when the resolver returns nothing', () => {
      const workflow = rawWorkflow({
        nodes: [
          {
            id: 'n1',
            name: 'Build',
            agents: [{ agentId: '', templateKey: 'worker.gone', name: 'Worker' }],
          },
        ],
      });
      const expected = computeDefinitionVersion({ ...workflow, templateSnapshots: {} });

      const run = repo.createPinnedRun(
        {
          spaceId,
          workflowId: WORKFLOW_ID,
          title: 'Snapshot run',
          rawWorkflow: workflow,
        },
        () => null
      );

      expect(run.definitionVersion).toBe(expected.versionHash);
      const version = db
        .prepare(
          `SELECT payload FROM space_workflow_definition_versions
           WHERE workflow_id = ? AND version_hash = ?`
        )
        .get(WORKFLOW_ID, run.definitionVersion) as { payload: string };
      expect(version.payload).toBe(expected.payload);
      expect(JSON.parse(version.payload).templateSnapshots).toEqual({});
    });

    it('leaves the pinned payload unchanged for a workflow with no template slots', () => {
      const workflow = rawWorkflow({
        nodes: [{ id: 'n1', name: 'Build', agents: [{ agentId: 'agent-1', name: 'Worker' }] }],
      });
      const expected = computeDefinitionVersion(workflow);

      const run = repo.createPinnedRun(
        {
          spaceId,
          workflowId: WORKFLOW_ID,
          title: 'Snapshot run',
          rawWorkflow: workflow,
        },
        () => null
      );

      expect(run.definitionVersion).toBe(expected.versionHash);
      const version = db
        .prepare(
          `SELECT payload FROM space_workflow_definition_versions
           WHERE workflow_id = ? AND version_hash = ?`
        )
        .get(WORKFLOW_ID, run.definitionVersion) as { payload: string };
      expect(version.payload).toBe(expected.payload);
      expect(JSON.parse(version.payload).templateSnapshots).toBeUndefined();
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

  describe('casRunStatus', () => {
    it("returns 'won' and flips the status on an exact match", () => {
      const run = repo.createRun({ spaceId, workflowId: WORKFLOW_ID, title: 'R' });
      expect(repo.casRunStatus(run.id, 'pending', 'blocked')).toBe('won');
      expect(repo.getRun(run.id)!.status).toBe('blocked');
    });

    it("returns 'won' when the current status is in the expected set", () => {
      const run = repo.createRun({ spaceId, workflowId: WORKFLOW_ID, title: 'R' });
      repo.updateStatusUnchecked(run.id, 'in_progress');
      expect(repo.casRunStatus(run.id, ['pending', 'in_progress'], 'blocked')).toBe('won');
      expect(repo.getRun(run.id)!.status).toBe('blocked');
    });

    it("returns 'superseded' and leaves the row unchanged when the status moved first", () => {
      const run = repo.createRun({ spaceId, workflowId: WORKFLOW_ID, title: 'R' });
      repo.updateStatusUnchecked(run.id, 'done');
      expect(repo.casRunStatus(run.id, 'pending', 'blocked')).toBe('superseded');
      expect(repo.getRun(run.id)!.status).toBe('done');
    });

    it("returns 'superseded' for an unknown run id", () => {
      expect(repo.casRunStatus('nonexistent', 'pending', 'blocked')).toBe('superseded');
    });

    it("returns 'superseded' for an empty expected set without writing", () => {
      const run = repo.createRun({ spaceId, workflowId: WORKFLOW_ID, title: 'R' });
      expect(repo.casRunStatus(run.id, [], 'blocked')).toBe('superseded');
      expect(repo.getRun(run.id)!.status).toBe('pending');
    });

    it('touches no other rows', () => {
      const target = repo.createRun({ spaceId, workflowId: WORKFLOW_ID, title: 'Target' });
      const other = repo.createRun({ spaceId, workflowId: WORKFLOW_ID, title: 'Other' });
      const otherBefore = repo.getRun(other.id);
      expect(repo.casRunStatus(target.id, 'pending', 'blocked')).toBe('won');
      expect(repo.getRun(other.id)).toEqual(otherBefore);
    });

    it('applies in_progress transition side effects when the CAS wins', () => {
      const run = repo.createRun({ spaceId, workflowId: WORKFLOW_ID, title: 'R' });
      repo.transitionStatus(run.id, 'in_progress');
      repo.transitionStatus(run.id, 'blocked');
      repo.updateRun(run.id, { startedAt: 1234, completedAt: 1234 });
      expect(repo.casRunStatus(run.id, ['blocked'], 'in_progress')).toBe('won');
      const updated = repo.getRun(run.id)!;
      expect(updated.status).toBe('in_progress');
      expect(updated.startedAt).not.toBe(1234);
      expect(updated.completedAt).toBeNull();
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

    it('listPinnableRuns includes a taskless run, which is still executable', () => {
      const taskless = repo.createRun({ spaceId, workflowId: WORKFLOW_ID, title: 'No task yet' });

      expect(repo.listPinnableRuns().map((r) => r.id)).toContain(taskless.id);
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

    it('pinExistingRun embeds template snapshots so backfilled runs are not snapshot-less', () => {
      const run = repo.createRun({ spaceId, workflowId: WORKFLOW_ID, title: 'Legacy' });
      const wf = rawWorkflow({
        nodes: [
          {
            id: 'n1',
            name: 'Build',
            agents: [{ agentId: '', templateKey: 'worker.custom', name: 'Worker' }],
          },
        ],
      });

      expect(
        repo.pinExistingRun(run.id, wf, (key) =>
          key === 'worker.custom'
            ? ({
                key: 'worker.custom',
                handle: 'custom-worker',
                displayName: 'Custom Worker',
                description: null,
                instructions: 'Frozen at backfill.',
                suggestedAutonomyLevel: 2,
                model: null,
                provider: null,
                modelPool: null,
                thinkingLevel: null,
                settingSources: null,
                tools: null,
                labels: [],
                createdAt: 1,
                updatedAt: 1,
              } as unknown as SpaceAgentTemplate)
            : null
        )
      ).toBe(true);

      const stamped = repo.getRun(run.id)!;
      const version = db
        .prepare(
          `SELECT payload FROM space_workflow_definition_versions
           WHERE workflow_id = ? AND version_hash = ?`
        )
        .get(WORKFLOW_ID, stamped.definitionVersion) as { payload: string };
      const pinned = JSON.parse(version.payload) as SpaceWorkflow;
      expect(pinned.templateSnapshots?.['worker.custom']?.instructions).toBe('Frozen at backfill.');
    });

    it('backfillDefinitionPins passes the resolver through so pinned runs carry snapshots', () => {
      const run = repo.createRun({ spaceId, workflowId: WORKFLOW_ID, title: 'Legacy' });
      seedTaskForRun(run.id, spaceId);
      const wf = rawWorkflow({
        nodes: [
          {
            id: 'n1',
            name: 'Build',
            agents: [{ agentId: '', templateKey: 'worker.gone', name: 'Worker' }],
          },
        ],
      });

      expect(
        repo.backfillDefinitionPins(
          () => wf,
          () => () => null
        )
      ).toBe(1);

      const stamped = repo.getRun(run.id)!;
      const version = db
        .prepare(
          `SELECT payload FROM space_workflow_definition_versions
           WHERE workflow_id = ? AND version_hash = ?`
        )
        .get(WORKFLOW_ID, stamped.definitionVersion) as { payload: string };
      expect(JSON.parse(version.payload).templateSnapshots).toEqual({});
    });

    it('migrateSnapshotlessPins upgrades a run pinned before snapshots existed', () => {
      const wf = rawWorkflow({
        nodes: [
          {
            id: 'n1',
            name: 'Build',
            agents: [{ agentId: '', templateKey: 'worker.custom', name: 'Worker' }],
          },
        ],
      });
      const run = repo.createPinnedRun({
        spaceId,
        workflowId: WORKFLOW_ID,
        title: 'Legacy pinned',
        rawWorkflow: wf,
      });
      seedTaskForRun(run.id, spaceId);
      const before = repo.getRun(run.id)!.definitionVersion;
      expect(JSON.parse(pinnedPayload(before!)).templateSnapshots).toBeUndefined();

      expect(
        repo.migrateSnapshotlessPins(
          () => (key) =>
            key === 'worker.custom'
              ? ({
                  key: 'worker.custom',
                  handle: 'custom-worker',
                  displayName: 'Custom Worker',
                  description: null,
                  instructions: 'Frozen at migration.',
                  suggestedAutonomyLevel: 2,
                  model: null,
                  provider: null,
                  modelPool: null,
                  thinkingLevel: null,
                  settingSources: null,
                  tools: null,
                  labels: [],
                  createdAt: 1,
                  updatedAt: 1,
                } as unknown as SpaceAgentTemplate)
              : null,
          () => wf
        )
      ).toBe(1);

      const after = repo.getRun(run.id)!.definitionVersion;
      expect(after).not.toBe(before);
      const migrated = JSON.parse(pinnedPayload(after!)) as SpaceWorkflow;
      expect(migrated.templateSnapshots?.['worker.custom']?.instructions).toBe(
        'Frozen at migration.'
      );
    });

    it('migrateSnapshotlessPins leaves runs that already carry a snapshot record alone', () => {
      const wf = rawWorkflow({
        nodes: [
          {
            id: 'n1',
            name: 'Build',
            agents: [{ agentId: '', templateKey: 'worker.gone', name: 'Worker' }],
          },
        ],
      });
      const run = repo.createPinnedRun(
        { spaceId, workflowId: WORKFLOW_ID, title: 'Already snapshotted', rawWorkflow: wf },
        () => null
      );
      seedTaskForRun(run.id, spaceId);
      const before = repo.getRun(run.id)!.definitionVersion;

      expect(
        repo.migrateSnapshotlessPins(
          () => () => null,
          () => wf
        )
      ).toBe(0);
      expect(repo.getRun(run.id)!.definitionVersion).toBe(before);
    });

    it('migrateSnapshotlessPins includes a taskless run, which is still executable', () => {
      const wf = rawWorkflow({
        nodes: [
          {
            id: 'n1',
            name: 'Build',
            agents: [{ agentId: '', templateKey: 'worker.gone', name: 'Worker' }],
          },
        ],
      });
      const run = repo.createPinnedRun({
        spaceId,
        workflowId: WORKFLOW_ID,
        title: 'Crashed before task creation',
        rawWorkflow: wf,
      });
      const before = repo.getRun(run.id)!.definitionVersion;

      expect(
        repo.migrateSnapshotlessPins(
          () => () => null,
          () => wf
        )
      ).toBe(1);

      const after = repo.getRun(run.id)!.definitionVersion;
      expect(after).not.toBe(before);
      expect(JSON.parse(pinnedPayload(after!)).templateSnapshots).toEqual({});
    });

    it('migrateSnapshotlessPins refuses to rehash a pinned payload whose hash does not verify', () => {
      const wf = rawWorkflow({
        nodes: [
          {
            id: 'n1',
            name: 'Build',
            agents: [{ agentId: '', templateKey: 'worker.gone', name: 'Worker' }],
          },
        ],
      });
      const run = repo.createPinnedRun({
        spaceId,
        workflowId: WORKFLOW_ID,
        title: 'Tampered pin',
        rawWorkflow: wf,
      });
      seedTaskForRun(run.id, spaceId);
      const before = repo.getRun(run.id)!.definitionVersion;
      const tampered = JSON.stringify({ ...wf, name: 'Altered after pinning' });
      db.prepare(
        `UPDATE space_workflow_definition_versions SET payload = ?
         WHERE workflow_id = ? AND version_hash = ?`
      ).run(tampered, WORKFLOW_ID, before);

      expect(
        repo.migrateSnapshotlessPins(
          () => () => null,
          () => wf
        )
      ).toBe(1);
      const after = repo.getRun(run.id)!.definitionVersion;
      expect(after).not.toBe(before);
      expect(JSON.parse(pinnedPayload(after!)).name).toBe('My Workflow');
    });

    it('migrateSnapshotlessPins leaves an unverifiable pin alone when the workflow is gone', () => {
      const wf = rawWorkflow({
        nodes: [
          {
            id: 'n1',
            name: 'Build',
            agents: [{ agentId: '', templateKey: 'worker.custom', name: 'Worker' }],
          },
        ],
      });
      const run = repo.createPinnedRun({
        spaceId,
        workflowId: WORKFLOW_ID,
        title: 'Tampered, workflow deleted',
        rawWorkflow: wf,
      });
      seedTaskForRun(run.id, spaceId);
      const before = repo.getRun(run.id)!.definitionVersion;
      db.prepare(
        `UPDATE space_workflow_definition_versions SET payload = ?
         WHERE workflow_id = ? AND version_hash = ?`
      ).run(JSON.stringify({ ...wf, name: 'Altered' }), WORKFLOW_ID, before);

      expect(
        repo.migrateSnapshotlessPins(
          () => () => null,
          () => null
        )
      ).toBe(0);
      expect(repo.getRun(run.id)!.definitionVersion).toBe(before);
    });

    it('migrateSnapshotlessPins migrates a pin whose payload is malformed JSON', () => {
      const wf = rawWorkflow({
        nodes: [
          {
            id: 'n1',
            name: 'Build',
            agents: [{ agentId: '', templateKey: 'worker.custom', name: 'Worker' }],
          },
        ],
      });
      const run = repo.createPinnedRun({
        spaceId,
        workflowId: WORKFLOW_ID,
        title: 'Corrupt payload',
        rawWorkflow: wf,
      });
      seedTaskForRun(run.id, spaceId);
      const before = repo.getRun(run.id)!.definitionVersion;
      db.prepare(
        `UPDATE space_workflow_definition_versions SET payload = ?
         WHERE workflow_id = ? AND version_hash = ?`
      ).run('{not json', WORKFLOW_ID, before);

      expect(repo.listSnapshotlessPinnedRuns().map((r) => r.id)).toContain(run.id);
      expect(
        repo.migrateSnapshotlessPins(
          () => () => null,
          () => wf
        )
      ).toBe(1);

      const after = repo.getRun(run.id)!.definitionVersion;
      expect(after).not.toBe(before);
      expect(JSON.parse(pinnedPayload(after!)).templateSnapshots).toEqual({});
    });

    it('migrateSnapshotlessPins skips runs whose task is archived', () => {
      const wf = rawWorkflow({
        nodes: [
          {
            id: 'n1',
            name: 'Build',
            agents: [{ agentId: '', templateKey: 'worker.custom', name: 'Worker' }],
          },
        ],
      });
      const run = repo.createPinnedRun({
        spaceId,
        workflowId: WORKFLOW_ID,
        title: 'Archived',
        rawWorkflow: wf,
      });
      seedTaskForRun(run.id, spaceId, { archived: true });

      expect(
        repo.migrateSnapshotlessPins(
          () => () => null,
          () => wf
        )
      ).toBe(0);
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

    it('backfillDefinitionPins resolves templates in the run Space, not the workflow Space', () => {
      const run = repo.createRun({ spaceId, workflowId: WORKFLOW_ID, title: 'Legacy' });
      seedTaskForRun(run.id, spaceId);
      const wf = rawWorkflow({ spaceId: 'other-space' });
      const asked: string[] = [];

      repo.backfillDefinitionPins(
        () => wf,
        (resolverSpaceId) => {
          asked.push(resolverSpaceId);
          return () => null;
        }
      );

      expect(asked).toEqual([spaceId]);
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

describe('SpaceWorkflowRunRepository.listTerminalRunsNeedingTaskReconciliation', () => {
  let db: Database;
  let spaceRepo: SpaceRepository;
  let repo: SpaceWorkflowRunRepository;
  let spaceId: string;
  const WORKFLOW_ID = 'workflow-reconcile';
  let taskNumber = 1;

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
    taskNumber = 1;
  });

  afterEach(() => {
    db.close();
  });

  function seedRun(status: 'done' | 'cancelled' | 'in_progress'): string {
    const run = repo.createRun({ spaceId, workflowId: WORKFLOW_ID, title: 'Run' });
    repo.updateStatusUnchecked(run.id, status);
    return run.id;
  }

  function seedTask(
    runId: string,
    opts: {
      status?: string;
      result?: string | null;
      reportedSummary?: string | null;
      updatedAt?: number;
      reconcileCheckedAt?: number;
    } = {}
  ): string {
    const id = `task-${runId.slice(0, 8)}-${taskNumber}`;
    taskNumber += 1;
    const now = Date.now();
    db.prepare(
      `INSERT INTO space_tasks
         (id, space_id, task_number, title, status, workflow_run_id, result, reported_summary, created_at, updated_at, reconcile_checked_at)
       VALUES (?, ?, ?, 'Task', ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      id,
      spaceId,
      taskNumber,
      opts.status ?? 'done',
      runId,
      opts.result ?? null,
      opts.reportedSummary ?? null,
      now,
      opts.updatedAt ?? now,
      opts.reconcileCheckedAt ?? null
    );
    return id;
  }

  function markReconciled(runId: string, checkedAt: number): void {
    db.prepare(`UPDATE space_tasks SET reconcile_checked_at = ? WHERE workflow_run_id = ?`).run(
      checkedAt,
      runId
    );
  }

  function seedArtifact(
    runId: string,
    opts: { artifactType?: string; updatedAt?: number; data?: string } = {}
  ): void {
    const now = Date.now();
    db.prepare(
      `INSERT INTO workflow_run_artifacts
         (id, run_id, node_id, artifact_type, artifact_key, data, created_at, updated_at)
       VALUES (?, ?, 'node-1', ?, ?, ?, ?, ?)`
    ).run(
      `artifact-${runId.slice(0, 8)}-${opts.artifactType ?? 'decision'}`,
      runId,
      opts.artifactType ?? 'decision',
      `key-${opts.artifactType ?? 'decision'}`,
      opts.data ?? '{"summary": "artifact summary"}',
      now,
      opts.updatedAt ?? now
    );
  }

  function seedExecution(
    runId: string,
    opts: { status?: string; result?: string | null; updatedAt?: number } = {}
  ): void {
    const now = Date.now();
    db.prepare(
      `INSERT INTO node_executions
         (id, workflow_run_id, workflow_node_id, agent_name, status, result, created_at, updated_at)
       VALUES (?, ?, 'node-1', 'coder', ?, ?, ?, ?)`
    ).run(
      `exec-${runId.slice(0, 8)}-${opts.updatedAt ?? now}`,
      runId,
      opts.status ?? 'idle',
      opts.result ?? 'execution outcome',
      now,
      opts.updatedAt ?? now
    );
  }

  function selectedRunIds(): string[] {
    return repo.listTerminalRunsNeedingTaskReconciliation(spaceId).map((run) => run.id);
  }

  it('excludes a settled done run with a filled single task', () => {
    const runId = seedRun('done');
    seedTask(runId, { result: 'outcome', reportedSummary: 'summary' });

    expect(selectedRunIds()).toEqual([]);
  });

  it('excludes a done run with no tasks', () => {
    seedRun('done');

    expect(selectedRunIds()).toEqual([]);
  });

  it('excludes non-terminal runs even with unsettled tasks', () => {
    const runId = seedRun('in_progress');
    seedTask(runId, { status: 'in_progress' });

    expect(selectedRunIds()).toEqual([]);
  });

  it('includes a done run with an in_progress task the reconciler can dispatch', () => {
    const runId = seedRun('done');
    seedTask(runId, { status: 'in_progress' });

    expect(selectedRunIds()).toEqual([runId]);
  });

  it('excludes a done run whose unsettled task status cannot reach approved after a clean pass', () => {
    const runId = seedRun('done');
    seedTask(runId, { status: 'open', updatedAt: 1_000, reconcileCheckedAt: 2_000 });

    expect(selectedRunIds()).toEqual([]);
  });

  it('excludes a done run with a filled rate_limited task the reconciler cannot settle', () => {
    const runId = seedRun('done');
    seedTask(runId, { status: 'rate_limited', result: 'outcome', reportedSummary: 'summary' });

    expect(selectedRunIds()).toEqual([]);
  });

  it('includes a done run with duplicate non-archived tasks', () => {
    const runId = seedRun('done');
    seedTask(runId, { result: 'outcome', reportedSummary: 'summary' });
    seedTask(runId, { result: 'outcome', reportedSummary: 'summary' });

    expect(selectedRunIds()).toEqual([runId]);
  });

  it('selects a done run with a missing outcome once, then drops it after a clean reconcile pass', () => {
    const runId = seedRun('done');
    seedTask(runId, { result: null, reportedSummary: null, updatedAt: 1_000 });

    expect(selectedRunIds()).toEqual([runId]);

    markReconciled(runId, 2_000);

    expect(selectedRunIds()).toEqual([]);
  });

  it('excludes a done run whose only task is archived', () => {
    const runId = seedRun('done');
    const now = Date.now();
    db.prepare(
      `INSERT INTO space_tasks
         (id, space_id, task_number, title, status, workflow_run_id, result, reported_summary, created_at, updated_at, archived_at)
       VALUES (?, ?, ?, 'Task', 'archived', ?, null, null, ?, ?, ?)`
    ).run(`task-archived-${runId.slice(0, 8)}`, spaceId, taskNumber++, runId, now, now, now);

    expect(selectedRunIds()).toEqual([]);
  });

  it('selects a done run whose missing result can fill from its reported summary until the pass runs', () => {
    const runId = seedRun('done');
    seedTask(runId, { result: null, reportedSummary: 'summary', updatedAt: 1_000 });

    expect(selectedRunIds()).toEqual([runId]);

    markReconciled(runId, 2_000);

    expect(selectedRunIds()).toEqual([]);
  });

  it('selects a never-reconciled done run with an old decision artifact, then drops it after the pass', () => {
    const runId = seedRun('done');
    seedTask(runId, { result: null, reportedSummary: null, updatedAt: 2_000 });
    seedArtifact(runId, { updatedAt: 1_000 });

    expect(selectedRunIds()).toEqual([runId]);

    markReconciled(runId, 3_000);

    expect(selectedRunIds()).toEqual([]);
  });

  it('excludes a done run whose decision artifact predates the last reconcile pass', () => {
    const runId = seedRun('done');
    seedTask(runId, {
      result: null,
      reportedSummary: null,
      updatedAt: 1_500,
      reconcileCheckedAt: 2_000,
    });
    seedArtifact(runId, { updatedAt: 1_000 });

    expect(selectedRunIds()).toEqual([]);
  });

  it('excludes a taskless done run with a retained decision artifact', () => {
    const runId = seedRun('done');
    seedArtifact(runId, { updatedAt: 2_000 });

    expect(selectedRunIds()).toEqual([]);
  });

  it('selects a done run while a decision artifact is newer than the last reconcile pass', () => {
    const runId = seedRun('done');
    seedTask(runId, {
      result: null,
      reportedSummary: null,
      updatedAt: 500,
      reconcileCheckedAt: 1_000,
    });
    seedArtifact(runId, { updatedAt: 2_000 });

    expect(selectedRunIds()).toEqual([runId]);

    markReconciled(runId, 3_000);

    expect(selectedRunIds()).toEqual([]);
  });

  it('selects a done run once when a decision artifact is re-saved unchanged after the pass', () => {
    const runId = seedRun('done');
    seedTask(runId, { result: 'outcome', reportedSummary: 'summary', reconcileCheckedAt: 1_000 });
    seedArtifact(runId, { updatedAt: 2_000, data: '{"summary": "same"}' });

    expect(selectedRunIds()).toEqual([runId]);

    markReconciled(runId, 3_000);

    expect(selectedRunIds()).toEqual([]);
  });

  it('selects a done run whose missing outcome can fill from an idle execution result newer than the pass', () => {
    const runId = seedRun('done');
    seedTask(runId, {
      result: null,
      reportedSummary: null,
      updatedAt: 500,
      reconcileCheckedAt: 1_000,
    });
    seedExecution(runId, { status: 'idle', result: 'execution outcome', updatedAt: 2_000 });

    expect(selectedRunIds()).toEqual([runId]);

    markReconciled(runId, 3_000);

    expect(selectedRunIds()).toEqual([]);
  });

  it('excludes a done run whose idle execution result predates the last reconcile pass', () => {
    const runId = seedRun('done');
    seedTask(runId, {
      result: null,
      reportedSummary: null,
      updatedAt: 1_500,
      reconcileCheckedAt: 2_000,
    });
    seedExecution(runId, { status: 'idle', result: 'execution outcome', updatedAt: 1_000 });

    expect(selectedRunIds()).toEqual([]);
  });

  it('selects a done run whose source landed in the same millisecond as the watermark', () => {
    const runId = seedRun('done');
    seedTask(runId, {
      result: null,
      reportedSummary: null,
      updatedAt: 1_500,
      reconcileCheckedAt: 2_000,
    });
    seedExecution(runId, { status: 'idle', result: 'execution outcome', updatedAt: 2_000 });

    expect(selectedRunIds()).toEqual([runId]);

    markReconciled(runId, 3_000);

    expect(selectedRunIds()).toEqual([]);
  });

  it('selects a done run whose missing outcome can fill from a sibling result newer than the pass', () => {
    const runId = seedRun('done');
    seedTask(runId, {
      result: null,
      reportedSummary: null,
      updatedAt: 1_500,
      reconcileCheckedAt: 2_000,
    });
    seedTask(runId, { result: 'sibling outcome', reportedSummary: null, updatedAt: 3_000 });

    expect(selectedRunIds()).toEqual([runId]);
  });

  it('includes a cancelled run with a task that can transition to cancelled', () => {
    const runId = seedRun('cancelled');
    seedTask(runId, { status: 'open' });

    expect(selectedRunIds()).toEqual([runId]);
  });

  it('excludes a cancelled run whose task status cannot transition to cancelled', () => {
    const runId = seedRun('cancelled');
    seedTask(runId, { status: 'draft' });

    expect(selectedRunIds()).toEqual([]);
  });

  it('excludes a cancelled run whose task is already done', () => {
    const runId = seedRun('cancelled');
    seedTask(runId, { status: 'done' });

    expect(selectedRunIds()).toEqual([]);
  });

  it('excludes a cancelled run whose task is cancelled', () => {
    const runId = seedRun('cancelled');
    seedTask(runId, { status: 'cancelled' });

    expect(selectedRunIds()).toEqual([]);
  });
});
