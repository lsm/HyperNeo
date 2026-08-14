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
    // Prime the pending-completion fields exactly as the agent `approve_task`
    // path does (end-node-handlers stamps them before dispatch transitions the
    // task), so we can assert the atomic clear fires on this path too.
    taskRepo.updateTask(task.id, {
      pendingCheckpointType: 'task_completion',
      pendingCompletionSubmittedByNodeId: 'end-node',
      pendingCompletionSubmittedAt: Date.now(),
      pendingCompletionReason: 'ready',
      postApprovalSourceNodeId: 'end-node',
    });
    const before = Date.now();
    const updated = await taskManager.setTaskStatus(task.id, 'approved', {
      approvalSource: 'agent',
    });
    expect(updated.status).toBe('approved');
    expect(updated.approvalSource).toBe('agent');
    expect(updated.approvedAt).toBeGreaterThanOrEqual(before);
    // Same atomic clear as review → approved: the four pending fields are
    // nulled in the UPDATE that commits `approved` (task #851).
    expect(updated.pendingCheckpointType).toBeNull();
    expect(updated.pendingCompletionSubmittedByNodeId).toBeNull();
    expect(updated.pendingCompletionSubmittedAt).toBeNull();
    expect(updated.pendingCompletionReason).toBeNull();
    // The durable source survives (the router reads it while the task is approved).
    expect(updated.postApprovalSourceNodeId).toBe('end-node');
  });

  test('review → approved stamps approvalSource=human + approvedAt and clears pending fields atomically (source survives in postApprovalSourceNodeId)', async () => {
    const task = taskRepo.createTask({
      spaceId: SPACE_ID,
      title: 'T',
      description: '',
      status: 'in_progress',
    });
    // in_progress → review
    await taskManager.setTaskStatus(task.id, 'review');
    // Prime the pending-completion fields AND the durable source field exactly
    // as `submitTaskForReview` does (it stamps both in one UPDATE).
    taskRepo.updateTask(task.id, {
      pendingCheckpointType: 'task_completion',
      pendingCompletionSubmittedByNodeId: 'validation-node',
      pendingCompletionSubmittedAt: Date.now(),
      pendingCompletionReason: 'needs human approval',
      postApprovalSourceNodeId: 'validation-node',
    });
    // review → approved
    const updated = await taskManager.setTaskStatus(task.id, 'approved', {
      approvalSource: 'human',
      approvalReason: 'LGTM',
    });
    expect(updated.status).toBe('approved');
    expect(updated.approvalSource).toBe('human');
    expect(updated.approvalReason).toBe('LGTM');
    // The four pending-completion fields are cleared in the SAME UPDATE that
    // commits `approved` — a task can never be observed in `approved` with any
    // of them set (task #851 crash-window fix).
    expect(updated.pendingCheckpointType).toBeNull();
    expect(updated.pendingCompletionSubmittedByNodeId).toBeNull();
    expect(updated.pendingCompletionSubmittedAt).toBeNull();
    expect(updated.pendingCompletionReason).toBeNull();
    // The durable source node survives so the post-approval router/dispatch can
    // still resolve it without depending on the cleared pending fields.
    expect(updated.postApprovalSourceNodeId).toBe('validation-node');
  });

  test('review → approved writes status flip + pending clear in a single UPDATE (no crash window)', async () => {
    const task = taskRepo.createTask({
      spaceId: SPACE_ID,
      title: 'T',
      description: '',
      status: 'in_progress',
    });
    await taskManager.setTaskStatus(task.id, 'review');
    taskRepo.updateTask(task.id, {
      pendingCheckpointType: 'task_completion',
      pendingCompletionSubmittedByNodeId: 'validation-node',
      pendingCompletionSubmittedAt: Date.now(),
      pendingCompletionReason: 'needs human approval',
      postApprovalSourceNodeId: 'validation-node',
    });

    // biome-ignore lint/suspicious/noExplicitAny: spy needs to reach into private repo
    const repo: any = (taskManager as any).taskRepo;
    const originalUpdate = repo.updateTask.bind(repo);
    const calls: Array<{ id: string; params: Record<string, unknown> }> = [];
    repo.updateTask = (id: string, params: Record<string, unknown>) => {
      calls.push({ id, params });
      return originalUpdate(id, params);
    };
    try {
      const updated = await taskManager.setTaskStatus(task.id, 'approved', {
        approvalSource: 'human',
      });
      expect(calls).toHaveLength(1);
      const onlyCall = calls[0];
      expect(onlyCall.params.status).toBe('approved');
      expect(onlyCall.params.pendingCheckpointType).toBeNull();
      expect(onlyCall.params.pendingCompletionSubmittedByNodeId).toBeNull();
      expect(onlyCall.params.pendingCompletionSubmittedAt).toBeNull();
      expect(onlyCall.params.pendingCompletionReason).toBeNull();
      // postApprovalSourceNodeId is NOT cleared on entering approved (it is the
      // router's durable source) — confirm the transition did not null it.
      expect(onlyCall.params.postApprovalSourceNodeId).toBeUndefined();
      expect(updated.postApprovalSourceNodeId).toBe('validation-node');
    } finally {
      repo.updateTask = originalUpdate;
    }
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

  test('in_progress → done without approval options leaves approval fields untouched (UI Mark Done compat)', async () => {
    // The explicit-approvalSource stamping branch on in_progress → done exists
    // solely for complete_validation_task. The UI/RPC path passes no approval
    // options on this transition (space-task-handlers only supplies
    // approvalSource for review → done), so a UI "Mark Done" from in_progress
    // must leave the approval fields null. Locks the `approvalSource !== undefined`
    // gate against accidental tightening (e.g. to approvalReason !== undefined,
    // which stopWorkflowBackedTaskForStatus-style callers could trip).
    const task = taskRepo.createTask({
      spaceId: SPACE_ID,
      title: 'T',
      description: '',
      status: 'in_progress',
    });
    const done = await taskManager.setTaskStatus(task.id, 'done', {
      result: 'closed from UI',
    });
    expect(done.status).toBe('done');
    expect(done.result).toBe('closed from UI');
    expect(done.approvalSource).toBeNull();
    expect(done.approvalReason).toBeNull();
    expect(done.approvedAt).toBeNull();
  });

  test('in_progress → done with explicit approvalSource stamps approval fields atomically (complete_validation_task)', async () => {
    const task = taskRepo.createTask({
      spaceId: SPACE_ID,
      title: 'T',
      description: '',
      status: 'in_progress',
    });
    const done = await taskManager.setTaskStatus(task.id, 'done', {
      result: 'validation passed',
      approvalSource: 'agent',
      approvalReason: 'weekly self_nag',
    });
    expect(done.status).toBe('done');
    expect(done.approvalSource).toBe('agent');
    expect(done.approvalReason).toBe('weekly self_nag');
    expect(done.approvedAt).not.toBeNull();
  });

  test('in_progress → done with approvalReason but NO approvalSource leaves approval fields untouched (gate keys on approvalSource only)', async () => {
    // Locks the gate's condition against the documented tightening risk: a
    // caller that passes approvalReason without approvalSource (the shape
    // stopWorkflowBackedTaskForStatus uses on its transitions) must NOT
    // trigger stamping — approvalSource is the sole key.
    const task = taskRepo.createTask({
      spaceId: SPACE_ID,
      title: 'T',
      description: '',
      status: 'in_progress',
    });
    const done = await taskManager.setTaskStatus(task.id, 'done', {
      result: 'closed with a reason but no source',
      approvalReason: 'should not stamp',
    });
    expect(done.status).toBe('done');
    expect(done.approvalSource).toBeNull();
    expect(done.approvalReason).toBeNull();
    expect(done.approvedAt).toBeNull();
  });

  test('allowedSourceStatuses refuses the write when the task moved concurrently (validation-completion TOCTOU)', async () => {
    // cancelled → done and approved → done are both VALID edges; without the
    // source-status condition a validation completion that passed eligibility
    // against in_progress could overwrite a concurrent user cancellation or
    // prematurely close a task mid-post-approval.
    const task = taskRepo.createTask({
      spaceId: SPACE_ID,
      title: 'T',
      description: '',
      status: 'in_progress',
    });
    // The user cancels between the tool's eligibility check and the write.
    await taskManager.setTaskStatus(task.id, 'cancelled');

    await expect(
      taskManager.setTaskStatus(task.id, 'done', {
        result: 'validated',
        approvalSource: 'agent',
        allowedSourceStatuses: ['review', 'in_progress'],
      })
    ).rejects.toThrow(/concurrently to 'cancelled'/);
    expect(taskRepo.getTask(task.id)?.status).toBe('cancelled');
  });

  test('precondition throw aborts the transition before any write (sync contract)', async () => {
    const task = taskRepo.createTask({
      spaceId: SPACE_ID,
      title: 'T',
      description: '',
      status: 'in_progress',
    });
    await expect(
      taskManager.setTaskStatus(task.id, 'done', {
        result: 'validated',
        precondition: () => {
          throw new Error('PR appeared during completion');
        },
      })
    ).rejects.toThrow('PR appeared during completion');
    expect(taskRepo.getTask(task.id)?.status).toBe('in_progress');
  });

  test('interleaving: a status change landing after the reread is NOT overwritten by the guarded UPDATE', async () => {
    // Exercises the SQL guard's 0-row path specifically. The precondition
    // callback runs AFTER setTaskStatus' reread and BEFORE the UPDATE — inside
    // it, a concurrent writer flips the row to `cancelled`. The in-JS
    // allowedSourceStatuses check already passed against the stale reread, so
    // only the atomic exact-status `WHERE status = ?` predicate catches it:
    // the UPDATE matches 0 rows and the cancellation survives.
    const task = taskRepo.createTask({
      spaceId: SPACE_ID,
      title: 'T',
      description: '',
      status: 'in_progress',
    });

    await expect(
      taskManager.setTaskStatus(task.id, 'done', {
        result: 'validated',
        approvalSource: 'agent',
        allowedSourceStatuses: ['review', 'in_progress'],
        precondition: () => {
          // "Concurrent" writer: lands between the reread and the UPDATE.
          // Direct repo write so no manager validation interferes; the row
          // flips to cancelled exactly as a user cancel would.
          taskRepo.updateTask(task.id, { status: 'cancelled' });
        },
      })
    ).rejects.toThrow(/changed concurrently|Refusing the transition/);
    // The concurrent cancellation was NOT lost.
    expect(taskRepo.getTask(task.id)?.status).toBe('cancelled');
    expect(taskRepo.getTask(task.id)?.result).toBeNull();
    expect(taskRepo.getTask(task.id)?.approvalSource).toBeNull();
  });

  test('interleaving BETWEEN allowed source statuses is also refused (exact-status predicate)', async () => {
    // The guard predicates on the exact reread status, NOT the whole
    // eligibility set: a concurrent submit_for_approval flipping the row
    // in_progress → review mid-call must also miss the UPDATE. A set-keyed
    // predicate would match `review`, commit a done built from the stale
    // in_progress snapshot, and skip the review-exit pending-field cleanup.
    const task = taskRepo.createTask({
      spaceId: SPACE_ID,
      title: 'T',
      description: '',
      status: 'in_progress',
    });

    await expect(
      taskManager.setTaskStatus(task.id, 'done', {
        result: 'validated',
        approvalSource: 'agent',
        allowedSourceStatuses: ['review', 'in_progress'],
        precondition: () => {
          // Concurrent submit_for_approval: flips to review (an allowed
          // source status in the set) and stamps the pending-completion
          // fields exactly as submitTaskForReview does.
          taskRepo.updateTask(task.id, {
            status: 'review',
            pendingCheckpointType: 'task_completion',
            pendingCompletionReason: 'needs human review',
          });
        },
      })
    ).rejects.toThrow(/changed concurrently|Refusing the transition/);
    // The newly requested human review survives with its pending fields.
    const after = taskRepo.getTask(task.id);
    expect(after?.status).toBe('review');
    expect(after?.pendingCheckpointType).toBe('task_completion');
    expect(after?.result).toBeNull();
  });

  test('expectedStatuses is an atomic UPDATE guard: mismatched current status yields a 0-row update (no lost update)', async () => {
    // Repo-level contract: the status check lives IN the UPDATE statement
    // (`WHERE id = ? AND status IN (…)`), so a concurrent transition between
    // the caller's read and this write cannot be overwritten — the statement
    // simply matches 0 rows and returns null.
    const task = taskRepo.createTask({
      spaceId: SPACE_ID,
      title: 'T',
      description: '',
      status: 'in_progress',
    });
    // Guard expecting `review` but the row is `in_progress` → no write.
    const missed = taskRepo.updateTask(task.id, {
      status: 'done',
      result: 'raced',
      expectedStatuses: ['review'],
    });
    expect(missed).toBeNull();
    expect(taskRepo.getTask(task.id)?.status).toBe('in_progress');
    expect(taskRepo.getTask(task.id)?.result).toBeNull();

    // Matching guard → write lands.
    const hit = taskRepo.updateTask(task.id, {
      status: 'done',
      result: 'validated',
      expectedStatuses: ['review', 'in_progress'],
    });
    expect(hit?.status).toBe('done');
    expect(hit?.result).toBe('validated');
  });

  test('approved → done nulls the durable source field (primed)', async () => {
    const task = taskRepo.createTask({
      spaceId: SPACE_ID,
      title: 'T',
      description: '',
      status: 'in_progress',
    });
    await taskManager.setTaskStatus(task.id, 'approved', { approvalSource: 'human' });
    taskRepo.updateTask(task.id, { postApprovalSourceNodeId: 'reviewer-node' });
    expect(taskRepo.getTask(task.id)?.postApprovalSourceNodeId).toBe('reviewer-node');

    const done = await taskManager.setTaskStatus(task.id, 'done', { approvalSource: 'human' });
    expect(done.status).toBe('done');
    expect(done.postApprovalSourceNodeId).toBeNull();
  });

  test('approved → in_progress (Reopen) nulls the durable source field (primed)', async () => {
    const task = taskRepo.createTask({
      spaceId: SPACE_ID,
      title: 'T',
      description: '',
      status: 'in_progress',
    });
    await taskManager.setTaskStatus(task.id, 'approved', { approvalSource: 'human' });
    taskRepo.updateTask(task.id, { postApprovalSourceNodeId: 'reviewer-node' });

    const reopened = await taskManager.setTaskStatus(task.id, 'in_progress');
    expect(reopened.status).toBe('in_progress');
    expect(reopened.postApprovalSourceNodeId).toBeNull();
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

/**
 * Matrix gap closures (task #849):
 *   - G1 `open → archived`     — shelve a queued task without cancel/reopen
 *   - G2 `blocked → done`      — mark a parked-but-complete task done
 *   - G3 `approved → cancelled`— drop an approved-but-unwanted task directly
 *
 * Each gap has both an edge-level matrix assertion and a `setTaskStatus`
 * behaviour test covering the stamping/cleanup side-effects.
 */
describe('VALID_SPACE_TASK_TRANSITIONS — matrix gap closures (task #849)', () => {
  test('G1: open can go to archived', () => {
    expect(VALID_SPACE_TASK_TRANSITIONS.open).toContain('archived');
    expect(isValidSpaceTaskTransition('open', 'archived')).toBe(true);
  });

  test('G2: blocked can go to done', () => {
    expect(VALID_SPACE_TASK_TRANSITIONS.blocked).toContain('done');
    expect(isValidSpaceTaskTransition('blocked', 'done')).toBe(true);
  });

  test('G3: approved can go to cancelled', () => {
    expect(VALID_SPACE_TASK_TRANSITIONS.approved).toContain('cancelled');
    expect(isValidSpaceTaskTransition('approved', 'cancelled')).toBe(true);
  });

  test('G3: approved → blocked remains intentionally absent', () => {
    expect(VALID_SPACE_TASK_TRANSITIONS.approved).not.toContain('blocked');
    expect(isValidSpaceTaskTransition('approved', 'blocked')).toBe(false);
  });

  test('full matrix snapshot — every (from → to) edge matches the documented table', () => {
    // Source of truth: VALID_SPACE_TASK_TRANSITIONS in space-task-manager.ts.
    // Updating any row here without intent will fail this snapshot.
    const EXPECTED = {
      draft: ['open', 'archived'],
      open: ['in_progress', 'blocked', 'review', 'done', 'cancelled', 'archived'],
      in_progress: ['open', 'review', 'approved', 'done', 'blocked', 'cancelled'],
      review: ['done', 'approved', 'in_progress', 'cancelled', 'archived'],
      approved: ['done', 'in_progress', 'archived', 'cancelled'],
      done: ['in_progress', 'archived'],
      blocked: ['open', 'in_progress', 'review', 'done', 'cancelled', 'archived'],
      cancelled: ['open', 'in_progress', 'done', 'archived'],
      rate_limited: ['in_progress', 'open', 'blocked', 'cancelled', 'archived'],
      usage_limited: ['in_progress', 'open', 'blocked', 'cancelled', 'archived'],
      archived: [],
    };
    expect(VALID_SPACE_TASK_TRANSITIONS).toEqual(EXPECTED);
  });
});

describe('SpaceTaskManager.setTaskStatus — matrix gap closures (task #849)', () => {
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

  test('G1: open → archived succeeds and stamps archivedAt', async () => {
    const task = taskRepo.createTask({
      spaceId: SPACE_ID,
      title: 'T',
      description: '',
      status: 'open',
    });
    const before = Date.now();
    const archived = await taskManager.setTaskStatus(task.id, 'archived');
    expect(archived.status).toBe('archived');
    expect(archived.archivedAt).toBeGreaterThanOrEqual(before);
  });

  test('G2: blocked → done succeeds, does NOT stamp approvalSource=human, and clears blockReason', async () => {
    const task = taskRepo.createTask({
      spaceId: SPACE_ID,
      title: 'T',
      description: '',
      status: 'in_progress',
    });
    // in_progress → blocked (stamp a failure classification), then blocked → done
    await taskManager.setTaskStatus(task.id, 'blocked', { blockReason: 'dependency_failed' });
    const done = await taskManager.setTaskStatus(task.id, 'done');
    expect(done.status).toBe('done');
    // Only review → done stamps approvalSource; a blocked task was never
    // approved, so approvalSource stays null (not 'human').
    expect(done.approvalSource).toBeNull();
    // Leaving `blocked` clears the failure classification so a done task never
    // carries stale blocker metadata (task #849, G2).
    expect(done.blockReason).toBeNull();
  });

  test('leaving blocked clears blockReason on every exit edge (task #849)', async () => {
    // blocked → cancelled/archived/open must all clear blockReason via
    // setTaskStatus — pre-existing edges that leaked stale `dependency_failed`
    // before the fix. (blocked → review is covered separately via
    // submitTaskForReview, the production path the RPC rejects a bare
    // setTaskStatus('review').)
    for (const target of ['cancelled', 'archived', 'open'] as const) {
      const task = taskRepo.createTask({
        spaceId: SPACE_ID,
        title: 'T',
        description: '',
        status: 'in_progress',
      });
      await taskManager.setTaskStatus(task.id, 'blocked', { blockReason: 'dependency_failed' });
      const moved = await taskManager.setTaskStatus(task.id, target);
      expect(moved.status).toBe(target);
      expect(moved.blockReason).toBeNull();
    }
  });

  test('submitTaskForReview clears stale blockReason on blocked → review (task #849)', async () => {
    // The canonical review-submission path does its own atomic updateTask and
    // bypasses setTaskStatus, so the exit-from-blocked blockReason clear must
    // be applied there too — otherwise `dependency_failed` leaks into review.
    const task = taskRepo.createTask({
      spaceId: SPACE_ID,
      title: 'T',
      description: '',
      status: 'in_progress',
    });
    await taskManager.setTaskStatus(task.id, 'blocked', { blockReason: 'dependency_failed' });
    const inReview = await taskManager.submitTaskForReview(task.id, {
      submittedByNodeId: null,
      reason: 'ready',
    });
    expect(inReview.status).toBe('review');
    expect(inReview.blockReason).toBeNull();
  });

  test('blocked → done clears a stale failure result (task #849)', async () => {
    // A blocked task carries its failure message in `result` (failTask / runtime
    // execution failures). Marking it done without a fresh completion result
    // must not leave that failure as the done task's result — otherwise it
    // displays as the outcome and captureCompletedTaskEvidence records the error
    // as success.
    const task = taskRepo.createTask({
      spaceId: SPACE_ID,
      title: 'T',
      description: '',
      status: 'in_progress',
    });
    await taskManager.setTaskStatus(task.id, 'blocked', { result: 'execution failed: OOM' });
    const done = await taskManager.setTaskStatus(task.id, 'done');
    expect(done.status).toBe('done');
    expect(done.result).toBeNull();
  });

  test('blocked → done with an explicit completion result keeps it (task #849)', async () => {
    const task = taskRepo.createTask({
      spaceId: SPACE_ID,
      title: 'T',
      description: '',
      status: 'in_progress',
    });
    await taskManager.setTaskStatus(task.id, 'blocked', { result: 'execution failed: OOM' });
    const done = await taskManager.setTaskStatus(task.id, 'done', { result: 'Shipped in v1.2' });
    expect(done.status).toBe('done');
    expect(done.result).toBe('Shipped in v1.2');
  });

  test('blocked → done respects an explicit reportedSummary: null (task #849)', async () => {
    // An explicit `reportedSummary: null` means "no summary" — the stale stored
    // summary must NOT be copied into `result`. Only fall back to the stored
    // summary when the option is undefined.
    const task = taskRepo.createTask({
      spaceId: SPACE_ID,
      title: 'T',
      description: '',
      status: 'in_progress',
    });
    await taskManager.setTaskStatus(task.id, 'blocked', {
      result: 'execution failed: OOM',
      blockReason: 'execution_failed',
    });
    // Stamp a stored reportedSummary (e.g. from a prior agent report).
    taskRepo.updateTask(task.id, { reportedSummary: 'old stored summary' });
    const done = await taskManager.setTaskStatus(task.id, 'done', { reportedSummary: null });
    expect(done.status).toBe('done');
    expect(done.result).toBeNull();
    expect(done.reportedSummary).toBeNull();
  });

  test('G3: approved → cancelled succeeds and clears all post-approval fields', async () => {
    const task = taskRepo.createTask({
      spaceId: SPACE_ID,
      title: 'T',
      description: '',
      status: 'in_progress',
    });
    // in_progress → approved, then stamp post-approval tracking fields as the
    // PostApprovalRouter would.
    await taskManager.setTaskStatus(task.id, 'approved', { approvalSource: 'agent' });
    taskRepo.updateTask(task.id, {
      postApprovalSessionId: 'session-123',
      postApprovalStartedAt: Date.now(),
      postApprovalBlockedReason: 'sub-session crashed',
    });
    // approved → cancelled — the "exit approved" cleanup must null every
    // post-approval field atomically in the same UPDATE.
    const cancelled = await taskManager.setTaskStatus(task.id, 'cancelled');
    expect(cancelled.status).toBe('cancelled');
    expect(cancelled.postApprovalSessionId).toBeNull();
    expect(cancelled.postApprovalStartedAt).toBeNull();
    expect(cancelled.postApprovalBlockedReason).toBeNull();
  });
});
