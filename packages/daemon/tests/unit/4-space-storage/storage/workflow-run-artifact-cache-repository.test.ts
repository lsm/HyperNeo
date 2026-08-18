import { describe, expect, it, beforeEach, afterEach } from 'bun:test';
import { Database } from '../../../../src/storage/sqlite-compat';
import { WorkflowRunArtifactCacheRepository } from '../../../../src/storage/repositories/workflow-run-artifact-cache-repository';
import { createSpaceTables } from '../../helpers/space-test-db';

describe('WorkflowRunArtifactCacheRepository', () => {
  let db: Database;
  let repo: WorkflowRunArtifactCacheRepository;
  const spaceId = 'space-1';
  const workflowId = 'wf-1';
  const runId = 'run-1';

  beforeEach(() => {
    db = new Database(':memory:');
    createSpaceTables(db);

    repo = new WorkflowRunArtifactCacheRepository(db);

    const now = Date.now();
    db.prepare(
      'INSERT INTO spaces (id, slug, workspace_path, name, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)'
    ).run(spaceId, 'test', '/tmp/test', 'Test', now, now);
    db.prepare(
      'INSERT INTO space_workflows (id, space_id, name, created_at, updated_at) VALUES (?, ?, ?, ?, ?)'
    ).run(workflowId, spaceId, 'Workflow', now, now);
    db.prepare(
      'INSERT INTO space_workflow_runs (id, space_id, workflow_id, title, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)'
    ).run(runId, spaceId, workflowId, 'Run 1', now, now);
  });

  afterEach(() => {
    db.close();
  });

  describe('upsert', () => {
    it('inserts a new row and returns it with parsed JSON data', () => {
      const rec = repo.upsert({
        runId,
        cacheKey: 'gateArtifacts',
        status: 'ok',
        data: { files: [{ path: 'a.ts', additions: 3, deletions: 1 }] },
      });

      expect(rec.runId).toBe(runId);
      expect(rec.taskId).toBe('');
      expect(rec.cacheKey).toBe('gateArtifacts');
      expect(rec.status).toBe('ok');
      expect(rec.data).toEqual({ files: [{ path: 'a.ts', additions: 3, deletions: 1 }] });
      expect(rec.syncedAt).toBeGreaterThan(0);
    });

    it('overwrites on conflict (same run + task + cacheKey)', () => {
      const first = repo.upsert({
        runId,
        cacheKey: 'gateArtifacts',
        status: 'ok',
        data: { round: 1 },
      });

      const second = repo.upsert({
        runId,
        cacheKey: 'gateArtifacts',
        status: 'error',
        data: { round: 2 },
        error: 'boom',
      });

      expect(second.id).toBe(first.id);
      expect(second.data).toEqual({ round: 2 });
      expect(second.status).toBe('error');
      expect(second.error).toBe('boom');
    });

    it('distinguishes run-level (empty taskId) from task-specific rows', () => {
      const runLevel = repo.upsert({
        runId,
        cacheKey: 'gateArtifacts',
        status: 'ok',
        data: { scope: 'run' },
      });
      const taskLevel = repo.upsert({
        runId,
        taskId: 'task-A',
        cacheKey: 'gateArtifacts',
        status: 'ok',
        data: { scope: 'task' },
      });

      expect(runLevel.id).not.toBe(taskLevel.id);
      expect(runLevel.taskId).toBe('');
      expect(taskLevel.taskId).toBe('task-A');
    });

    it('records an error row with the provided error message', () => {
      const rec = repo.upsert({
        runId,
        cacheKey: 'commits',
        status: 'error',
        data: {},
        error: 'git merge-base failed',
      });

      expect(rec.status).toBe('error');
      expect(rec.error).toBe('git merge-base failed');
    });
  });

  describe('get', () => {
    it('returns null when no matching row exists', () => {
      expect(repo.get(runId, 'gateArtifacts')).toBeNull();
    });

    it('returns the row for the (runId, cacheKey) pair', () => {
      repo.upsert({ runId, cacheKey: 'gateArtifacts', status: 'ok', data: { x: 1 } });
      const fetched = repo.get(runId, 'gateArtifacts');
      expect(fetched?.data).toEqual({ x: 1 });
    });

    it('scopes by taskId', () => {
      repo.upsert({ runId, taskId: '', cacheKey: 'gateArtifacts', status: 'ok', data: { a: 1 } });
      repo.upsert({
        runId,
        taskId: 'task-A',
        cacheKey: 'gateArtifacts',
        status: 'ok',
        data: { a: 2 },
      });

      const runLevel = repo.get(runId, 'gateArtifacts');
      const taskLevel = repo.get(runId, 'gateArtifacts', 'task-A');

      expect(runLevel?.data).toEqual({ a: 1 });
      expect(taskLevel?.data).toEqual({ a: 2 });
    });
  });

  describe('listByRun', () => {
    it('returns every cache row for the run (ordered by created_at)', () => {
      repo.upsert({ runId, cacheKey: 'gateArtifacts', status: 'ok', data: {} });
      repo.upsert({ runId, cacheKey: 'commits', status: 'ok', data: {} });
      repo.upsert({
        runId,
        taskId: 'task-A',
        cacheKey: 'fileDiff:src/foo.ts',
        status: 'ok',
        data: {},
      });

      const rows = repo.listByRun(runId);
      expect(rows).toHaveLength(3);
      const keys = rows.map((r) => r.cacheKey).sort();
      expect(keys).toEqual(['commits', 'fileDiff:src/foo.ts', 'gateArtifacts']);
    });

    it('returns an empty array for unknown runs', () => {
      expect(repo.listByRun('nonexistent')).toEqual([]);
    });
  });

  describe('deleteByRun', () => {
    it('deletes every row for the run', () => {
      repo.upsert({ runId, cacheKey: 'gateArtifacts', status: 'ok', data: {} });
      repo.upsert({
        runId,
        taskId: 'task-A',
        cacheKey: 'commits',
        status: 'ok',
        data: {},
      });

      const deleted = repo.deleteByRun(runId);

      expect(deleted).toBe(2);
      expect(repo.listByRun(runId)).toEqual([]);
    });

    it('returns 0 when no rows exist', () => {
      const deleted = repo.deleteByRun(runId);
      expect(deleted).toBe(0);
    });
  });

  describe('deleteByRunTask', () => {
    it('deletes only the matching task rows', () => {
      repo.upsert({ runId, cacheKey: 'gateArtifacts', status: 'ok', data: {} });
      repo.upsert({
        runId,
        taskId: 'task-A',
        cacheKey: 'gateArtifacts',
        status: 'ok',
        data: {},
      });
      repo.upsert({
        runId,
        taskId: 'task-B',
        cacheKey: 'gateArtifacts',
        status: 'ok',
        data: {},
      });

      const deleted = repo.deleteByRunTask(runId, 'task-A');

      expect(deleted).toBe(1);
      const remaining = repo
        .listByRun(runId)
        .map((r) => r.taskId)
        .sort();
      expect(remaining).toEqual(['', 'task-B']);
    });
  });

  describe('cascade delete', () => {
    it('is removed when the parent workflow run is deleted', () => {
      repo.upsert({ runId, cacheKey: 'gateArtifacts', status: 'ok', data: {} });
      expect(repo.listByRun(runId)).toHaveLength(1);

      db.prepare('DELETE FROM space_workflow_runs WHERE id = ?').run(runId);
      expect(repo.listByRun(runId)).toEqual([]);
    });
  });

  describe('rowToRecord error handling', () => {
    it('skips rows with corrupted JSON data (returns null, logs)', () => {
      const now = Date.now();
      db.prepare(
        `INSERT INTO workflow_run_artifact_cache
					(id, run_id, task_id, cache_key, status, data, synced_at, created_at, updated_at)
				 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
      ).run('corrupt-1', runId, '', 'gateArtifacts', 'ok', 'not json {', now, now, now);

      expect(repo.get(runId, 'gateArtifacts')).toBeNull();
      expect(repo.listByRun(runId)).toEqual([]);
    });
  });
});
