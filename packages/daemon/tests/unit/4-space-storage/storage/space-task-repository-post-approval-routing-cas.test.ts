import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { SpaceTaskRepository } from '../../../../src/storage/repositories/space-task-repository.ts';
import { runMigrations } from '../../../../src/storage/schema/index.ts';
import { Database as BunDatabase } from '../../../../src/storage/sqlite-compat';

const SPACE_ID = 'space-par-cas';

function makeDb(): BunDatabase {
  const db = new BunDatabase(':memory:');
  db.exec('PRAGMA foreign_keys = ON');
  runMigrations(db, () => {});
  db.prepare(
    `INSERT INTO spaces (id, workspace_path, name, description, background_context, instructions,
     allowed_models, session_ids, slug, status, created_at, updated_at)
     VALUES (?, '/tmp/ws', ?, '', '', '', '[]', '[]', ?, 'active', ?, ?)`
  ).run(SPACE_ID, `Space ${SPACE_ID}`, SPACE_ID, Date.now(), Date.now());
  db.prepare(
    `INSERT INTO space_workflows (id, space_id, name, created_at, updated_at)
     VALUES ('wf-cas', ?, 'CAS WF', ?, ?)`
  ).run(SPACE_ID, Date.now(), Date.now());
  for (const runId of ['run-1', 'run-2']) {
    db.prepare(
      `INSERT INTO space_workflow_runs (id, space_id, workflow_id, title, status, created_at, updated_at)
       VALUES (?, ?, 'wf-cas', ?, 'done', ?, ?)`
    ).run(runId, SPACE_ID, `Run ${runId}`, Date.now(), Date.now());
  }
  return db;
}

function seedApprovedTask(
  repo: SpaceTaskRepository,
  overrides: {
    workflowRunId?: string | null;
    postApprovalBlockedReason?: string;
    pendingCompletion?: boolean;
  } = {}
) {
  const task = repo.createTask({
    spaceId: SPACE_ID,
    title: 'Ship it',
    description: '',
    status: 'in_progress',
    ...(overrides.workflowRunId ? { workflowRunId: overrides.workflowRunId } : {}),
  });
  const approved = repo.updateTask(task.id, {
    status: 'approved',
    approvalSource: 'agent',
    approvedAt: Date.now(),
    ...(overrides.postApprovalBlockedReason
      ? { postApprovalBlockedReason: overrides.postApprovalBlockedReason }
      : {}),
    ...(overrides.pendingCompletion
      ? {
          pendingCheckpointType: 'task_completion',
          pendingCompletionSubmittedByNodeId: 'validation-node',
          pendingCompletionSubmittedAt: Date.now(),
          pendingCompletionReason: 'needs approval',
        }
      : {}),
  });
  if (!approved) throw new Error('failed to seed approved task');
  return approved;
}

describe('SpaceTaskRepository.casPostApprovalRouting', () => {
  let db: BunDatabase;
  let repo: SpaceTaskRepository;

  beforeEach(() => {
    db = makeDb();
    repo = new SpaceTaskRepository(db);
  });
  afterEach(() => {
    db.close();
  });

  test('wins while approved: records pointer, startedAt, clears blocked reason and pending completion', () => {
    const task = seedApprovedTask(repo, {
      workflowRunId: 'run-1',
      postApprovalBlockedReason: 'deferred',
      pendingCompletion: true,
    });
    const outcome = repo.casPostApprovalRouting(task.id, 'run-1', {
      postApprovalSessionId: 'worker-1',
      postApprovalStartedAt: 1234,
    });
    expect(outcome).toBe('won');
    const final = repo.getTask(task.id);
    expect(final?.postApprovalSessionId).toBe('worker-1');
    expect(final?.postApprovalStartedAt).toBe(1234);
    expect(final?.postApprovalBlockedReason).toBeNull();
    expect(final?.pendingCheckpointType).toBeNull();
    expect(final?.pendingCompletionSubmittedByNodeId).toBeNull();
    expect(final?.status).toBe('approved');
  });

  test('loses when the task left approved (terminal transition cannot be recorded)', () => {
    const task = seedApprovedTask(repo, { workflowRunId: 'run-1' });
    repo.updateTask(task.id, { status: 'done' });
    const outcome = repo.casPostApprovalRouting(task.id, 'run-1', {
      postApprovalSessionId: 'worker-1',
      postApprovalStartedAt: 1234,
    });
    expect(outcome).toBe('superseded');
    expect(repo.getTask(task.id)?.postApprovalSessionId).toBeNull();
  });

  test('loses when the task re-parented to a different workflow run', () => {
    const task = seedApprovedTask(repo, { workflowRunId: 'run-1' });
    const outcome = repo.casPostApprovalRouting(task.id, 'run-2', {
      postApprovalSessionId: 'worker-1',
      postApprovalStartedAt: 1234,
    });
    expect(outcome).toBe('superseded');
    expect(repo.getTask(task.id)?.postApprovalSessionId).toBeNull();
  });

  test('loses when the row gained a run the router did not act on (null expectation)', () => {
    const task = seedApprovedTask(repo, { workflowRunId: 'run-1' });
    const outcome = repo.casPostApprovalRouting(task.id, null, {
      postApprovalSessionId: 'worker-1',
      postApprovalStartedAt: 1234,
    });
    expect(outcome).toBe('superseded');
  });

  test('wins for a standalone task when both expectation and row are run-less', () => {
    const task = seedApprovedTask(repo, {});
    const outcome = repo.casPostApprovalRouting(task.id, null, {
      postApprovalSessionId: 'worker-1',
      postApprovalStartedAt: 1234,
    });
    expect(outcome).toBe('won');
    expect(repo.getTask(task.id)?.postApprovalSessionId).toBe('worker-1');
  });

  test('steals a duplicate pointer from another task row in the same transaction', () => {
    const task = seedApprovedTask(repo, { workflowRunId: 'run-1' });
    const other = seedApprovedTask(repo, { workflowRunId: 'run-2' });
    repo.updateTask(other.id, {
      postApprovalSessionId: 'shared-worker',
      postApprovalStartedAt: 99,
    });
    const outcome = repo.casPostApprovalRouting(task.id, 'run-1', {
      postApprovalSessionId: 'shared-worker',
      postApprovalStartedAt: 1234,
    });
    expect(outcome).toBe('won');
    expect(repo.getTask(other.id)?.postApprovalSessionId).toBeNull();
    expect(repo.getTask(other.id)?.postApprovalStartedAt).toBeNull();
    expect(repo.getTask(task.id)?.postApprovalSessionId).toBe('shared-worker');
  });

  test('a losing CAS does not steal the duplicate pointer either', () => {
    const task = seedApprovedTask(repo, { workflowRunId: 'run-1' });
    const other = seedApprovedTask(repo, { workflowRunId: 'run-2' });
    repo.updateTask(other.id, { postApprovalSessionId: 'shared-worker' });
    repo.updateTask(task.id, { status: 'done' });
    const outcome = repo.casPostApprovalRouting(task.id, 'run-1', {
      postApprovalSessionId: 'shared-worker',
      postApprovalStartedAt: 1234,
    });
    expect(outcome).toBe('superseded');
    expect(repo.getTask(other.id)?.postApprovalSessionId).toBe('shared-worker');
    expect(repo.getTask(task.id)?.postApprovalSessionId).toBeNull();
  });
});
