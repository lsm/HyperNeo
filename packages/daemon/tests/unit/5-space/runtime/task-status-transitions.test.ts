/**
 * Unit tests for SpaceTask status-transition rules added in PR 2/5:
 *   - `in_progress → approved`  (end-node `approve_task` path)
 *   - `review → approved`       (human approves via approvePendingCompletion)
 *   - `approved → done`         (mark_complete)
 *   - `approved → in_progress`  (revive for revision)
 *   - `approved → blocked` is intentionally NOT a valid transition
 *
 * The tests drive `SpaceTaskManager.setTaskStatus` so the centralised
 * transition validator runs, and assert both the edge-level behaviour
 * (accept/reject) and the stamping side-effects (approvalSource, approvedAt).
 */

import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { Database as BunDatabase } from '../../../../src/storage/sqlite-compat';
import { runMigrations } from '../../../../src/storage/schema/index.ts';
import { SpaceTaskRepository } from '../../../../src/storage/repositories/space-task-repository.ts';
import {
  SpaceTaskManager,
  VALID_SPACE_TASK_TRANSITIONS,
  isValidSpaceTaskTransition,
} from '../../../../src/lib/space/managers/space-task-manager.ts';

const SPACE_ID = 'space-trans-test';

function makeDb(): BunDatabase {
  const db = new BunDatabase(':memory:');
  db.exec('PRAGMA foreign_keys = ON');
  runMigrations(db, () => {});
  db.prepare(
    `INSERT INTO spaces (id, workspace_path, name, description, background_context, instructions,
     allowed_models, session_ids, slug, status, created_at, updated_at)
     VALUES (?, '/tmp/ws', ?, '', '', '', '[]', '[]', ?, 'active', ?, ?)`
  ).run(SPACE_ID, `Space ${SPACE_ID}`, SPACE_ID, Date.now(), Date.now());
  return db;
}

describe('VALID_SPACE_TASK_TRANSITIONS (PR 2/5 rules)', () => {
  test('in_progress can go to approved', () => {
    expect(VALID_SPACE_TASK_TRANSITIONS.in_progress).toContain('approved');
  });

  test('review can go to approved', () => {
    expect(VALID_SPACE_TASK_TRANSITIONS.review).toContain('approved');
  });

  test('approved can go to done', () => {
    expect(VALID_SPACE_TASK_TRANSITIONS.approved).toContain('done');
  });

  test('approved can go to in_progress (revive)', () => {
    expect(VALID_SPACE_TASK_TRANSITIONS.approved).toContain('in_progress');
  });

  test('approved CANNOT go to blocked (Stage 2 rule)', () => {
    expect(VALID_SPACE_TASK_TRANSITIONS.approved).not.toContain('blocked');
    expect(isValidSpaceTaskTransition('approved', 'blocked')).toBe(false);
  });
});

describe('SpaceTaskManager.setTaskStatus — approval-path transitions', () => {
  let db: BunDatabase;
  let taskRepo: SpaceTaskRepository;
  let taskManager: SpaceTaskManager;

  beforeEach(() => {
    db = makeDb();
    taskRepo = new SpaceTaskRepository(db);
    taskManager = new SpaceTaskManager(db, SPACE_ID);
  });
  afterEach(() => {
    db.close();
  });

  test('in_progress → approved stamps approvalSource + approvedAt', async () => {
    const task = taskRepo.createTask({
      spaceId: SPACE_ID,
      title: 'T',
      description: '',
      status: 'in_progress',
    });
    const before = Date.now();
    const updated = await taskManager.setTaskStatus(task.id, 'approved', {
      approvalSource: 'agent',
    });
    expect(updated.status).toBe('approved');
    expect(updated.approvalSource).toBe('agent');
    expect(updated.approvedAt).toBeGreaterThanOrEqual(before);
  });

  test('review → approved stamps approvalSource=human + approvedAt and preserves submitting node', async () => {
    const task = taskRepo.createTask({
      spaceId: SPACE_ID,
      title: 'T',
      description: '',
      status: 'in_progress',
    });
    // in_progress → review
    await taskManager.setTaskStatus(task.id, 'review');
    taskRepo.updateTask(task.id, {
      pendingCheckpointType: 'task_completion',
      pendingCompletionSubmittedByNodeId: 'validation-node',
      pendingCompletionSubmittedAt: Date.now(),
      pendingCompletionReason: 'needs human approval',
    });
    // review → approved
    const updated = await taskManager.setTaskStatus(task.id, 'approved', {
      approvalSource: 'human',
      approvalReason: 'LGTM',
    });
    expect(updated.status).toBe('approved');
    expect(updated.approvalSource).toBe('human');
    expect(updated.approvalReason).toBe('LGTM');
    expect(updated.pendingCompletionSubmittedByNodeId).toBe('validation-node');
  });

  test('approved → done via mark_complete carries approvalSource through', async () => {
    const task = taskRepo.createTask({
      spaceId: SPACE_ID,
      title: 'T',
      description: '',
      status: 'in_progress',
    });
    await taskManager.setTaskStatus(task.id, 'approved', {
      approvalSource: 'human',
      approvalReason: 'approved by alice',
    });
    // Now transition approved → done, passing approvalSource explicitly (as mark_complete does).
    const done = await taskManager.setTaskStatus(task.id, 'done', {
      approvalSource: 'human',
    });
    expect(done.status).toBe('done');
    // approvalReason preserved (setTaskStatus does not clear it on approved→done).
    expect(done.approvalSource).toBe('human');
    expect(done.approvalReason).toBe('approved by alice');
  });

  test('approved → blocked is rejected by the transition validator', async () => {
    const task = taskRepo.createTask({
      spaceId: SPACE_ID,
      title: 'T',
      description: '',
      status: 'in_progress',
    });
    await taskManager.setTaskStatus(task.id, 'approved', { approvalSource: 'agent' });
    await expect(taskManager.setTaskStatus(task.id, 'blocked')).rejects.toThrow(
      /Invalid status transition from 'approved' to 'blocked'/
    );
  });

  test('approved → in_progress (revive) clears approval stamps', async () => {
    const task = taskRepo.createTask({
      spaceId: SPACE_ID,
      title: 'T',
      description: '',
      status: 'in_progress',
    });
    // in_progress → review → approved
    await taskManager.setTaskStatus(task.id, 'review');
    await taskManager.setTaskStatus(task.id, 'approved', {
      approvalSource: 'human',
      approvalReason: 'ok',
    });
    // approved → in_progress — revive path
    const back = await taskManager.setTaskStatus(task.id, 'in_progress');
    expect(back.status).toBe('in_progress');
  });
});
