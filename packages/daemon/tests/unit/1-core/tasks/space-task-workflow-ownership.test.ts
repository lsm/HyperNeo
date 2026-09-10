import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { Database } from '../../../../src/storage/sqlite-compat';
import { SpaceTaskRepository } from '../../../../src/storage/repositories/space-task-repository';

describe('Space workflow writes with owner-independent task storage', () => {
  let db: Database;
  let tasks: SpaceTaskRepository;

  beforeEach(() => {
    db = new Database(':memory:');
    db.exec(`CREATE TABLE space_tasks (
      id TEXT PRIMARY KEY, space_id TEXT, status TEXT DEFAULT 'draft',
      workflow_run_id TEXT DEFAULT 'run', created_by_task_id TEXT DEFAULT 'creator',
      updated_at INTEGER DEFAULT 1, reconcile_checked_at INTEGER,
      approved_at INTEGER, post_approval_session_id TEXT, post_approval_started_at INTEGER,
      post_approval_blocked_reason TEXT, pending_checkpoint_type TEXT,
      pending_completion_submitted_by_node_id TEXT, pending_completion_submitted_at INTEGER,
      pending_completion_reason TEXT
    );
    CREATE TABLE space_workflow_runs (id TEXT PRIMARY KEY, status TEXT);
    INSERT INTO space_workflow_runs VALUES ('run', 'done')`);
    const insert = db.prepare('INSERT INTO space_tasks (id, space_id) VALUES (?, ?)');
    insert.run('standalone', null);
    insert.run('owned-a', 'space-a');
    insert.run('owned-b', 'space-b');
    tasks = new SpaceTaskRepository(db);
  });

  afterEach(() => db.close());

  function row(id: string) {
    return db.prepare('SELECT * FROM space_tasks WHERE id = ?').get(id);
  }

  test('draft promotion changes and counts only matching Space tasks', () => {
    const before = row('standalone');
    expect(tasks.promoteDraftTasksByCreator('creator')).toBe(2);
    expect(row('standalone')).toEqual(before);
    expect(row('owned-a')).toMatchObject({ status: 'open', updated_at: expect.any(Number) });
    expect(row('owned-b')).toMatchObject({ status: 'open' });
    expect(tasks.promoteDraftTasksByCreator('creator')).toBe(0);
  });

  test('reconciliation stamps only non-archived Space tasks in the run', () => {
    db.prepare("UPDATE space_tasks SET status = 'archived' WHERE id = ?").run('owned-b');
    tasks.markReconcileCheckedAt('run', 123);
    expect(row('standalone')).toMatchObject({ reconcile_checked_at: null });
    expect(row('owned-a')).toMatchObject({ reconcile_checked_at: 123 });
    expect(row('owned-b')).toMatchObject({ reconcile_checked_at: null });
    tasks.markReconcileCheckedAt('absent', 456);
    expect(row('owned-a')).toMatchObject({ reconcile_checked_at: 123 });
  });

  test('routing excludes standalone tasks and preserves their pointers during Space cleanup', () => {
    db.exec("UPDATE space_tasks SET status = 'approved', pending_checkpoint_type = 'approval'");
    const expected = { workflowRunId: 'run', approvedAt: null, priorPostApprovalSessionId: null };
    const routing = { postApprovalSessionId: 'session', postApprovalStartedAt: 123 };
    const before = row('standalone');
    expect(tasks.casPostApprovalRouting('standalone', expected, routing)).toBe('superseded');
    expect(row('standalone')).toEqual(before);
    db.prepare('UPDATE space_tasks SET post_approval_session_id = ? WHERE id != ?').run(
      'session',
      'owned-a'
    );
    const standalone = row('standalone');
    expect(
      tasks.casPostApprovalRouting('owned-a', expected, routing, { requireSucceededRun: true })
    ).toBe('won');
    expect(row('owned-a')).toMatchObject({
      post_approval_session_id: 'session',
      post_approval_started_at: 123,
      pending_checkpoint_type: null,
    });
    expect(row('owned-b')).toMatchObject({ post_approval_session_id: null });
    expect(row('standalone')).toEqual(standalone);
    expect(tasks.casPostApprovalRouting('owned-a', expected, routing)).toBe('superseded');
  });
});
