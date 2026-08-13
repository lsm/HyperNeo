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

  test('uses compare-and-swap version updates and stamps lastFlow/lastReason', () => {
    const initial = repo.ensure('run-1', 'hook-1', { approvals: { coder: 'pending' } });
    expect(initial.version).toBe(0);

    const updated = repo.update('run-1', 'hook-1', {
      expectedVersion: 0,
      localState: { approvals: { reviewer: 'approved' } },
      lastFlow: 'continue',
      lastReason: 'pr is ready',
    });
    expect(updated?.version).toBe(1);
    expect(updated?.localState).toEqual({
      approvals: { coder: 'pending', reviewer: 'approved' },
    });
    expect(updated?.lastFlow).toBe('continue');
    expect(updated?.lastReason).toBe('pr is ready');

    // A stale expectedVersion does NOT clobber the row.
    const stale = repo.update('run-1', 'hook-1', {
      expectedVersion: 0,
      localState: { approvals: { qa: 'approved' } },
    });
    expect(stale).toBeNull();
  });

  test('does not create missing state rows for stale expected versions', () => {
    const stale = repo.update('run-1', 'hook-1', {
      expectedVersion: 1,
      localState: { approvals: { coder: 'approved' } },
    });

    expect(stale).toBeNull();
    expect(repo.get('run-1', 'hook-1')).toBeNull();
  });

  test('deep-merges localState within one transaction', () => {
    repo.ensure('run-1', 'hook-1');
    const first = repo.update('run-1', 'hook-1', {
      expectedVersion: 0,
      localState: { approvals: { coder: 'yes' } },
    });
    const second = repo.update('run-1', 'hook-1', {
      expectedVersion: first!.version,
      localState: { approvals: { reviewer: 'yes' } },
    });

    // Deep-merge: nested approval keys are unioned, not replaced.
    expect(second?.localState).toEqual({
      approvals: { coder: 'yes', reviewer: 'yes' },
    });
  });

  test('ensure tolerates concurrent insert races', () => {
    const first = repo.ensure('run-1', 'hook-1', { first: true });
    const second = repo.ensure('run-1', 'hook-1', { second: true });

    expect(second).toEqual(first);
    expect(second.localState).toEqual({ first: true });
  });

  test('update advances retryCount and nextRetryAt on a retry flow', () => {
    repo.ensure('run-1', 'hook-1');
    const retried = repo.update('run-1', 'hook-1', {
      expectedVersion: 0,
      lastFlow: 'retry',
      lastReason: 'transient',
      retryCount: 1,
      nextRetryAt: 12345,
    });
    expect(retried?.lastFlow).toBe('retry');
    expect(retried?.lastReason).toBe('transient');
    expect(retried?.retryCount).toBe(1);
    expect(retried?.nextRetryAt).toBe(12345);
  });
});

describe('lastReason clear semantics', () => {
  let repo: WorkflowHookStateRepository;
  let db: InstanceType<typeof Database>;

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

  test('an explicit null clears the reason; an absent field keeps it', () => {
    repo.updateWithRetry('run-1', 'hook-1', {
      lastFlow: 'stop',
      lastReason: 'first block reason',
    });
    expect(repo.get('run-1', 'hook-1')?.lastReason).toBe('first block reason');

    // A decision with no reason must not leave the previous decision's
    // remediation on the banner.
    repo.updateWithRetry('run-1', 'hook-1', { lastFlow: 'stop', lastReason: null });
    expect(repo.get('run-1', 'hook-1')?.lastReason).toBeUndefined();

    repo.updateWithRetry('run-1', 'hook-1', { lastFlow: 'retry', lastReason: 'waiting' });
    // A partial patch without lastReason keeps the current value.
    repo.updateWithRetry('run-1', 'hook-1', { retryCount: 3 });
    expect(repo.get('run-1', 'hook-1')?.lastReason).toBe('waiting');
  });
});
