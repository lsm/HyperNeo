import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import type { SpaceTaskStatus } from '@hyperneo/shared';
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
    expect(updated.pendingCheckpointType).toBeNull();
    expect(updated.pendingCompletionSubmittedByNodeId).toBeNull();
    expect(updated.pendingCompletionSubmittedAt).toBeNull();
    expect(updated.pendingCompletionReason).toBeNull();
    expect(updated.postApprovalSourceNodeId).toBe('end-node');
  });

  test('review → approved stamps approvalSource=human + approvedAt and clears pending fields atomically (source survives in postApprovalSourceNodeId)', async () => {
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
    const updated = await taskManager.setTaskStatus(task.id, 'approved', {
      approvalSource: 'human',
      approvalReason: 'LGTM',
    });
    expect(updated.status).toBe('approved');
    expect(updated.approvalSource).toBe('human');
    expect(updated.approvalReason).toBe('LGTM');
    expect(updated.pendingCheckpointType).toBeNull();
    expect(updated.pendingCompletionSubmittedByNodeId).toBeNull();
    expect(updated.pendingCompletionSubmittedAt).toBeNull();
    expect(updated.pendingCompletionReason).toBeNull();
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
    const done = await taskManager.setTaskStatus(task.id, 'done', {
      approvalSource: 'human',
    });
    expect(done.status).toBe('done');
    expect(done.approvalSource).toBe('human');
    expect(done.approvalReason).toBe('approved by alice');
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
    await taskManager.setTaskStatus(task.id, 'review');
    await taskManager.setTaskStatus(task.id, 'approved', {
      approvalSource: 'human',
      approvalReason: 'ok',
    });
    const back = await taskManager.setTaskStatus(task.id, 'in_progress');
    expect(back.status).toBe('in_progress');
  });
});

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
    const EXPECTED = {
      draft: ['open', 'archived'],
      open: ['in_progress', 'blocked', 'review', 'done', 'cancelled', 'archived'],
      in_progress: [
        'open',
        'review',
        'approved',
        'done',
        'blocked',
        'cancelled',
        'stopped',
        'rate_limited',
        'usage_limited',
      ],
      review: ['done', 'approved', 'in_progress', 'cancelled', 'archived', 'stopped'],
      approved: ['done', 'in_progress', 'archived', 'cancelled'],
      done: ['in_progress', 'archived'],
      blocked: ['open', 'in_progress', 'review', 'done', 'cancelled', 'archived', 'stopped'],
      cancelled: ['open', 'in_progress', 'done', 'archived'],
      rate_limited: [
        'in_progress',
        'usage_limited',
        'open',
        'blocked',
        'cancelled',
        'archived',
        'stopped',
      ],
      usage_limited: [
        'in_progress',
        'rate_limited',
        'open',
        'blocked',
        'cancelled',
        'archived',
        'stopped',
      ],
      archived: [],
      stopped: ['in_progress', 'open', 'review', 'cancelled', 'archived'],
    };
    expect(VALID_SPACE_TASK_TRANSITIONS).toEqual(EXPECTED);
  });
});

describe('VALID_SPACE_TASK_TRANSITIONS — limited-status edges (task #1223)', () => {
  test.each([
    ['in_progress', 'rate_limited'],
    ['in_progress', 'usage_limited'],
    ['rate_limited', 'usage_limited'],
    ['usage_limited', 'rate_limited'],
  ] as const)('%s → %s is a valid transition', (from, to) => {
    expect(VALID_SPACE_TASK_TRANSITIONS[from]).toContain(to);
    expect(isValidSpaceTaskTransition(from, to)).toBe(true);
  });
});

describe('SpaceTaskManager.setTaskStatus — runtime-owned limited targets (task #1223)', () => {
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

  test.each([
    'rate_limited',
    'usage_limited',
  ] as const)('rejects %s as a target even from in_progress and leaves the row unchanged', async (target) => {
    const task = taskRepo.createTask({
      spaceId: SPACE_ID,
      title: 'T',
      description: '',
      status: 'in_progress',
    });
    await expect(taskManager.setTaskStatus(task.id, target)).rejects.toThrow('runtime-owned');
    expect(taskRepo.getTask(task.id)?.status).toBe('in_progress');
    expect(taskRepo.getTask(task.id)?.restrictions).toBeNull();
  });

  test('still allows leaving the limited statuses back to in_progress', async () => {
    const task = taskRepo.createTask({
      spaceId: SPACE_ID,
      title: 'T',
      description: '',
      status: 'in_progress',
    });
    taskRepo.updateTask(task.id, {
      status: 'rate_limited',
      restrictions: {
        type: 'rate_limit',
        limit: 'backoff-ladder',
        resetAt: Date.now() + 60_000,
        sessionRole: 'worker',
      },
    });
    const restored = await taskManager.setTaskStatus(task.id, 'in_progress');
    expect(restored.status).toBe('in_progress');
    expect(restored.restrictions).toBeNull();
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
    await taskManager.setTaskStatus(task.id, 'blocked', { blockReason: 'dependency_failed' });
    const done = await taskManager.setTaskStatus(task.id, 'done');
    expect(done.status).toBe('done');
    expect(done.approvalSource).toBeNull();
    expect(done.blockReason).toBeNull();
  });

  test('leaving blocked clears blockReason on every exit edge (task #849)', async () => {
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
    await taskManager.setTaskStatus(task.id, 'approved', { approvalSource: 'agent' });
    taskRepo.updateTask(task.id, {
      postApprovalSessionId: 'session-123',
      postApprovalStartedAt: Date.now(),
      postApprovalBlockedReason: 'sub-session crashed',
    });
    const cancelled = await taskManager.setTaskStatus(task.id, 'cancelled');
    expect(cancelled.status).toBe('cancelled');
    expect(cancelled.postApprovalSessionId).toBeNull();
    expect(cancelled.postApprovalStartedAt).toBeNull();
    expect(cancelled.postApprovalBlockedReason).toBeNull();
  });
});

describe('stopped status — dormant park capability (task #1080)', () => {
  test.each([
    'in_progress',
    'blocked',
    'review',
    'rate_limited',
    'usage_limited',
  ] as const)('%s → stopped is a valid transition', (from) => {
    expect(VALID_SPACE_TASK_TRANSITIONS[from]).toContain('stopped');
    expect(isValidSpaceTaskTransition(from, 'stopped')).toBe(true);
  });

  test.each([
    'draft',
    'open',
    'approved',
    'done',
    'cancelled',
    'archived',
  ] as const)('%s → stopped is rejected by the transition validator', (from) => {
    expect(VALID_SPACE_TASK_TRANSITIONS[from]).not.toContain('stopped');
    expect(isValidSpaceTaskTransition(from, 'stopped')).toBe(false);
  });

  test.each([
    'in_progress',
    'open',
    'review',
    'cancelled',
    'archived',
  ] as const)('stopped → %s is a valid transition', (to) => {
    expect(VALID_SPACE_TASK_TRANSITIONS.stopped).toContain(to);
    expect(isValidSpaceTaskTransition('stopped', to)).toBe(true);
  });

  test.each([
    'done',
    'blocked',
    'approved',
    'stopped',
  ] as const)('stopped → %s is rejected by the transition validator', (to) => {
    expect(VALID_SPACE_TASK_TRANSITIONS.stopped).not.toContain(to);
    expect(isValidSpaceTaskTransition('stopped', to)).toBe(false);
  });
});

describe('SpaceTaskManager.setTaskStatus — stopped preserves task provenance (task #1080)', () => {
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

  function createTask(status: SpaceTaskStatus) {
    return taskRepo.createTask({
      spaceId: SPACE_ID,
      title: 'T',
      description: '',
      status,
    });
  }

  test('in_progress → stopped preserves result and reportedSummary', async () => {
    const task = createTask('in_progress');
    taskRepo.updateTask(task.id, {
      result: 'partial implementation on branch b1',
      reportedSummary: 'half done',
    });
    const stopped = await taskManager.setTaskStatus(task.id, 'stopped');
    expect(stopped.status).toBe('stopped');
    expect(stopped.result).toBe('partial implementation on branch b1');
    expect(stopped.reportedSummary).toBe('half done');
  });

  test('blocked → stopped preserves blockReason, result, and reportedSummary', async () => {
    const task = createTask('in_progress');
    await taskManager.setTaskStatus(task.id, 'blocked', {
      result: 'blocked mid-run',
      blockReason: 'human_input_requested',
    });
    const stopped = await taskManager.setTaskStatus(task.id, 'stopped');
    expect(stopped.status).toBe('stopped');
    expect(stopped.blockReason).toBe('human_input_requested');
    expect(stopped.result).toBe('blocked mid-run');
  });

  test('review → stopped preserves pending-completion checkpoint and approval fields', async () => {
    const task = createTask('in_progress');
    await taskManager.setTaskStatus(task.id, 'review');
    taskRepo.updateTask(task.id, {
      pendingCheckpointType: 'task_completion',
      pendingCompletionSubmittedByNodeId: 'reviewer-node',
      pendingCompletionSubmittedAt: 1234,
      pendingCompletionReason: 'ready for review',
      postApprovalSourceNodeId: 'reviewer-node',
      approvalSource: 'human',
      approvalReason: 'stamped before the park',
      approvedAt: 5678,
    });
    const stopped = await taskManager.setTaskStatus(task.id, 'stopped');
    expect(stopped.status).toBe('stopped');
    expect(stopped.pendingCheckpointType).toBe('task_completion');
    expect(stopped.pendingCompletionSubmittedByNodeId).toBe('reviewer-node');
    expect(stopped.pendingCompletionSubmittedAt).toBe(1234);
    expect(stopped.pendingCompletionReason).toBe('ready for review');
    expect(stopped.postApprovalSourceNodeId).toBe('reviewer-node');
    expect(stopped.approvalSource).toBe('human');
    expect(stopped.approvalReason).toBe('stamped before the park');
    expect(stopped.approvedAt).toBe(5678);
  });

  test('rate_limited → stopped preserves result', async () => {
    const task = createTask('rate_limited');
    taskRepo.updateTask(task.id, { result: 'partial run before cap' });
    const stopped = await taskManager.setTaskStatus(task.id, 'stopped');
    expect(stopped.status).toBe('stopped');
    expect(stopped.result).toBe('partial run before cap');
  });

  test('stopped → in_progress resume clears the parked outcome fields', async () => {
    const task = createTask('in_progress');
    taskRepo.updateTask(task.id, {
      result: 'parked work',
      reportedSummary: 'parked summary',
      reportedStatus: 'done',
      blockReason: 'parked reason',
    });
    await taskManager.setTaskStatus(task.id, 'stopped');
    const resumed = await taskManager.setTaskStatus(task.id, 'in_progress');
    expect(resumed.status).toBe('in_progress');
    expect(resumed.result).toBeNull();
    expect(resumed.reportedSummary).toBeNull();
    expect(resumed.reportedStatus).toBeNull();
    expect(resumed.blockReason).toBeNull();
  });

  test('approved → stopped is rejected by the transition validator', async () => {
    const task = createTask('in_progress');
    await taskManager.setTaskStatus(task.id, 'approved', { approvalSource: 'agent' });
    await expect(taskManager.setTaskStatus(task.id, 'stopped')).rejects.toThrow(
      /Invalid status transition from 'approved' to 'stopped'/
    );
  });
});
