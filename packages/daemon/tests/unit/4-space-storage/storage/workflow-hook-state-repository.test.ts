import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { Database } from '../../../../src/storage/sqlite-compat';
import * as workflowHookStateRepository from '../../../../src/storage/repositories/workflow-hook-state-repository.ts';

const { WorkflowHookStateRepository } =
  workflowHookStateRepository as typeof workflowHookStateRepository & {
    WorkflowHookStateRepository: typeof import('../../../../src/storage/repositories/workflow-hook-state-repository.ts').WorkflowHookStateRepository;
  };
import { createSpaceTables } from '../../helpers/space-test-db.ts';

describe('WorkflowHookStateRepository', () => {
  let db: Database;
  let repo: WorkflowHookStateRepository;

  beforeEach(() => {
    db = new Database(':memory:');
    createSpaceTables(db);
    const now = Date.now();
    db.prepare(
      `INSERT INTO spaces (id, slug, workspace_path, name, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?)`
    ).run('sp-1', 'sp-1', '/tmp/sp-1', 'Space', now, now);
    db.prepare(
      `INSERT INTO space_workflow_runs (id, space_id, workflow_id, title, status, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    ).run('run-1', 'sp-1', 'wf-1', 'Run', 'in_progress', now, now);
    repo = new WorkflowHookStateRepository(db);
  });

  afterEach(() => db.close());

  test('uses compare-and-swap version updates and appends result artifacts', () => {
    const initial = repo.ensure('run-1', 'hook-1', { approvals: { coder: 'pending' } });
    expect(initial.version).toBe(0);

    const updated = repo.update('run-1', 'hook-1', {
      expectedVersion: 0,
      localState: { approvals: { reviewer: 'approved' } },
      lastResult: { type: 'allow', data: { ok: true } },
    });
    expect(updated?.version).toBe(1);
    expect(updated?.localState).toEqual({
      approvals: { coder: 'pending', reviewer: 'approved' },
    });

    const stale = repo.update('run-1', 'hook-1', {
      expectedVersion: 0,
      localState: { approvals: { qa: 'approved' } },
    });
    expect(stale).toBeNull();

    const artifacts = db
      .prepare(`SELECT hook_id, version, result FROM workflow_hook_result_artifacts`)
      .all() as Array<{ hook_id: string; version: number; result: string }>;
    expect(artifacts).toHaveLength(1);
    expect(artifacts[0].hook_id).toBe('hook-1');
    expect(artifacts[0].version).toBe(1);
    expect(JSON.parse(artifacts[0].result)).toEqual({ type: 'allow', data: { ok: true } });
  });

  test('does not create missing state rows for stale expected versions', () => {
    const stale = repo.update('run-1', 'hook-1', {
      expectedVersion: 1,
      localState: { approvals: { coder: 'approved' } },
    });

    expect(stale).toBeNull();
    expect(repo.get('run-1', 'hook-1')).toBeNull();
  });

  test('deep-merges vote maps within one transaction', () => {
    repo.ensure('run-1', 'hook-1');
    const first = repo.update('run-1', 'hook-1', {
      expectedVersion: 0,
      voteMaps: { approvals: { coder: 'yes' } },
    });
    const second = repo.update('run-1', 'hook-1', {
      expectedVersion: first!.version,
      voteMaps: { approvals: { reviewer: 'yes' } },
    });

    expect(second?.voteMaps).toEqual({ approvals: { coder: 'yes', reviewer: 'yes' } });
  });

  test('ensure tolerates concurrent insert races', () => {
    const first = repo.ensure('run-1', 'hook-1', { first: true });
    const second = repo.ensure('run-1', 'hook-1', { second: true });

    expect(second).toEqual(first);
    expect(second.localState).toEqual({ first: true });
  });
});
