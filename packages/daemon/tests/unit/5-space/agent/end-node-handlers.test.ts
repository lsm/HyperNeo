/**
 * Unit tests for createEndNodeHandlers() — the Design v2 two-tool contract
 * for end-node agents.
 *
 * Covers:
 *   - approve_task        — autonomy-gated self-close
 *   - submit_for_approval — always-available human sign-off request
 *
 * These handlers were extracted from task-agent-manager.ts so they can be
 * unit-tested directly with a real SQLite DB and no live agent sessions.
 */

import { describe, test, expect, beforeEach, afterEach, mock } from 'bun:test';
import { Database as BunDatabase } from '../../../../src/storage/sqlite-compat';
import { runMigrations } from '../../../../src/storage/schema/index.ts';
import { SpaceTaskRepository } from '../../../../src/storage/repositories/space-task-repository.ts';
import { SpaceGoalEventRepository } from '../../../../src/storage/repositories/space-goal-event-repository.ts';
import { SpaceGoalRepository } from '../../../../src/storage/repositories/space-goal-repository.ts';
import { TaskScheduleRepository } from '../../../../src/storage/repositories/task-schedule-repository.ts';
import { JobQueueRepository } from '../../../../src/storage/repositories/job-queue-repository.ts';
import { SpaceRepository } from '../../../../src/storage/repositories/space-repository.ts';
import { SpaceTaskManager } from '../../../../src/lib/space/managers/space-task-manager.ts';
import { ScheduleService } from '../../../../src/lib/space/schedule/schedule-service.ts';
import { SpaceGoalService } from '../../../../src/lib/space/goals/goal-service.ts';
import {
  createEndNodeHandlers,
  createMarkCompleteHandler,
  createPrMergedGate,
} from '../../../../src/lib/space/tools/end-node-handlers.ts';
import type { EndNodeHandlerDeps } from '../../../../src/lib/space/tools/end-node-handlers.ts';
import type { Space, SpaceTask, SpaceWorkflow } from '@hyperneo/shared';
import type {
  DaemonInternalEventMap,
  InternalEventBus,
} from '../../../../src/lib/internal-event-bus.ts';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function makeDb(): BunDatabase {
  // Use in-memory SQLite — faster than file-based DB and avoids filesystem
  // I/O contention that caused beforeEach hook timeouts in CI.
  const db = new BunDatabase(':memory:');
  db.exec('PRAGMA foreign_keys = ON');
  runMigrations(db, () => {});
  return db;
}

function seedSpaceRow(db: BunDatabase, spaceId: string, autonomyLevel = 1): void {
  db.prepare(
    `INSERT INTO spaces (id, workspace_path, name, description, background_context, instructions,
     allowed_models, session_ids, slug, status, autonomy_level, created_at, updated_at)
     VALUES (?, '/tmp', ?, '', '', '', '[]', '[]', ?, 'active', ?, ?, ?)`
  ).run(spaceId, `Space ${spaceId}`, spaceId, autonomyLevel, Date.now(), Date.now());
}

function makeSpace(spaceId: string, autonomyLevel?: number): Space {
  return {
    id: spaceId,
    workspacePath: '/tmp',
    name: `Space ${spaceId}`,
    description: '',
    backgroundContext: '',
    instructions: '',
    sessionIds: [],
    status: 'active',
    autonomyLevel,
    createdAt: Date.now(),
    updatedAt: Date.now(),
  };
}

function makeWorkflow(completionAutonomyLevel: number, endNodeId = 'end-node'): SpaceWorkflow {
  return {
    id: 'wf-test',
    spaceId: 'space-test',
    name: 'Test WF',
    description: '',
    nodes: [{ id: endNodeId, name: 'end', agents: [] }],
    channels: [],
    gates: [],
    startNodeId: endNodeId,
    endNodeId,
    completionAutonomyLevel,
    tags: [],
    createdAt: Date.now(),
    updatedAt: Date.now(),
  } as unknown as SpaceWorkflow;
}

interface MockBusCtx {
  bus: InternalEventBus<DaemonInternalEventMap>;
  emitted: Array<{ name: string; payload: Record<string, unknown> }>;
}

function makeMockBus(): MockBusCtx {
  const emitted: Array<{ name: string; payload: Record<string, unknown> }> = [];
  const bus = {
    publish: mock(async (name: string, payload: Record<string, unknown>) => {
      emitted.push({ name, payload });
    }),
  } as unknown as InternalEventBus<DaemonInternalEventMap>;
  return { bus, emitted };
}

interface TestCtx {
  db: BunDatabase;
  spaceId: string;
  taskRepo: SpaceTaskRepository;
  taskManager: SpaceTaskManager;
  goalEventRepo: SpaceGoalEventRepository;
  goalService: SpaceGoalService;
}

function makeCtx(autonomyLevel = 1): TestCtx {
  const db = makeDb();
  const spaceId = 'space-end-node-test';
  seedSpaceRow(db, spaceId, autonomyLevel);
  const taskRepo = new SpaceTaskRepository(db);
  const spaceRepo = new SpaceRepository(db);
  const scheduleRepo = new TaskScheduleRepository(db);
  const goalEventRepo = new SpaceGoalEventRepository(db);
  const scheduleService = new ScheduleService({
    db,
    scheduleRepo,
    jobQueue: new JobQueueRepository(db),
    spaceRepo,
  });
  return {
    db,
    spaceId,
    taskRepo,
    // Real SpaceTaskManager so the centralised transition validator runs
    // inside `submitTaskForReview` — exercises the same code path that the
    // production wiring takes from `task-agent-manager.ts`.
    taskManager: new SpaceTaskManager(db, spaceId),
    goalEventRepo,
    goalService: new SpaceGoalService({
      goalRepo: new SpaceGoalRepository(db),
      goalEventRepo,
      taskRepo,
      spaceRepo,
      scheduleService,
      db,
    }),
  };
}

/** Build deps with sensible defaults + overrides. */
function makeDeps(
  ctx: TestCtx,
  taskId: string,
  overrides: Partial<EndNodeHandlerDeps> = {}
): EndNodeHandlerDeps {
  return {
    taskId,
    spaceId: ctx.spaceId,
    workflow: makeWorkflow(3),
    workflowNodeId: 'end-node',
    agentName: 'test-agent',
    taskRepo: ctx.taskRepo,
    taskManager: ctx.taskManager,
    spaceManager: {
      getSpace: async () => makeSpace(ctx.spaceId, 3),
    },
    ...overrides,
  };
}

// ===========================================================================
// mark_complete — post-approval completion
// ===========================================================================

describe('createMarkCompleteHandler', () => {
  let ctx: TestCtx;
  beforeEach(() => {
    ctx = makeCtx();
  });
  afterEach(() => {
    ctx.db.close();
  });

  test('applies goal_update after marking a linked task complete', async () => {
    const goal = ctx.goalService.createGoal({
      spaceId: ctx.spaceId,
      title: 'Improve onboarding',
    });
    const task = ctx.taskRepo.createTask({
      spaceId: ctx.spaceId,
      title: 'T',
      description: '',
      status: 'approved',
      goalId: goal.id,
    });
    const handler = createMarkCompleteHandler({
      taskId: task.id,
      spaceId: ctx.spaceId,
      taskRepo: ctx.taskRepo,
      taskManager: ctx.taskManager,
      goalService: ctx.goalService,
    });

    const out = await handler({
      goal_update: {
        summary: 'First milestone shipped',
        progress: 55,
        metrics: { activated: 20 },
        nextSteps: ['Measure adoption'],
      },
    });
    const parsed = JSON.parse(out.content[0].text);
    expect(parsed.success).toBe(true);

    const updatedGoal = ctx.goalService.getGoal(goal.id);
    expect(updatedGoal?.summary).toBe('First milestone shipped');
    expect(updatedGoal?.progress).toBe(55);
    expect(updatedGoal?.metrics).toEqual({ activated: 20 });
    expect(updatedGoal?.nextSteps).toEqual(['Measure adoption']);

    const updateEvent = ctx.goalEventRepo
      .listByGoal(goal.id)
      .find((event) => event.eventType === 'updated');
    expect(updateEvent?.source).toBe('workflow_node_agent');
    expect(updateEvent?.sourceTaskId).toBe(task.id);
    expect(updateEvent?.diff?.progress).toEqual({ previous: 0, current: 55 });
  });

  test('does not persist goal_update when marking the task complete fails', async () => {
    const goal = ctx.goalService.createGoal({
      spaceId: ctx.spaceId,
      title: 'Keep consistent',
    });
    const task = ctx.taskRepo.createTask({
      spaceId: ctx.spaceId,
      title: 'T',
      description: '',
      status: 'approved',
      goalId: goal.id,
    });
    const setTaskStatus = mock(async () => {
      throw new Error('transition raced');
    });
    const handler = createMarkCompleteHandler({
      taskId: task.id,
      spaceId: ctx.spaceId,
      taskRepo: ctx.taskRepo,
      taskManager: { setTaskStatus, updateTask: ctx.taskManager.updateTask.bind(ctx.taskManager) },
      goalService: ctx.goalService,
    });

    const out = await handler({ goal_update: { summary: 'Should not persist', progress: 90 } });
    const parsed = JSON.parse(out.content[0].text);

    expect(parsed.success).toBe(false);
    expect(parsed.error).toBe('transition raced');
    expect(ctx.taskRepo.getTask(task.id)?.status).toBe('approved');
    expect(ctx.taskRepo.getTask(task.id)?.result).toBeNull();
    const unchangedGoal = ctx.goalService.getGoal(goal.id);
    expect(unchangedGoal?.summary).toBe('');
    expect(unchangedGoal?.progress).toBe(0);
    expect(ctx.goalEventRepo.listByGoal(goal.id).map((event) => event.eventType)).toEqual([
      'created',
    ]);
  });

  test('rejects goal_update on a task without a linked goal', async () => {
    const task = ctx.taskRepo.createTask({
      spaceId: ctx.spaceId,
      title: 'T',
      description: '',
      status: 'approved',
    });
    const handler = createMarkCompleteHandler({
      taskId: task.id,
      spaceId: ctx.spaceId,
      taskRepo: ctx.taskRepo,
      taskManager: ctx.taskManager,
      goalService: ctx.goalService,
    });

    const out = await handler({ goal_update: { summary: 'No linked goal' } });
    const parsed = JSON.parse(out.content[0].text);
    expect(parsed.success).toBe(false);
    expect(parsed.error).toContain('not linked to a goal');
    expect(ctx.taskRepo.getTask(task.id)?.status).toBe('approved');
  });

  test('mark_complete fails closed while the run PR is still OPEN', async () => {
    const task = ctx.taskRepo.createTask({
      spaceId: ctx.spaceId,
      title: 'T',
      description: '',
      status: 'approved',
    });
    const handler = createMarkCompleteHandler({
      taskId: task.id,
      spaceId: ctx.spaceId,
      taskRepo: ctx.taskRepo,
      taskManager: ctx.taskManager,
      assertPrMerged: async () => ({
        ok: false,
        error:
          "mark_complete merge gate: the run's PR is still OPEN (https://github.com/a/b/pull/1). Merge it before calling mark_complete (gh pr merge), then retry.",
      }),
    });

    const out = await handler({});
    const parsed = JSON.parse(out.content[0].text);
    expect(parsed.success).toBe(false);
    expect(parsed.error).toContain('still OPEN');
    // The task stays approved — completion is blocked, not faked.
    expect(ctx.taskRepo.getTask(task.id)?.status).toBe('approved');
  });

  test('mark_complete fails closed on lookup error (no merge evidence)', async () => {
    const task = ctx.taskRepo.createTask({
      spaceId: ctx.spaceId,
      title: 'T',
      description: '',
      status: 'approved',
    });
    const handler = createMarkCompleteHandler({
      taskId: task.id,
      spaceId: ctx.spaceId,
      taskRepo: ctx.taskRepo,
      taskManager: ctx.taskManager,
      assertPrMerged: async () => ({
        ok: false,
        error: 'mark_complete merge gate: could not verify the run PR state — GitHub unreachable.',
      }),
    });

    const out = await handler({});
    const parsed = JSON.parse(out.content[0].text);
    expect(parsed.success).toBe(false);
    expect(parsed.error).toContain('could not verify');
    expect(ctx.taskRepo.getTask(task.id)?.status).toBe('approved');
  });

  test('mark_complete proceeds when the gate passes (PR merged)', async () => {
    const task = ctx.taskRepo.createTask({
      spaceId: ctx.spaceId,
      title: 'T',
      description: '',
      status: 'approved',
    });
    const handler = createMarkCompleteHandler({
      taskId: task.id,
      spaceId: ctx.spaceId,
      taskRepo: ctx.taskRepo,
      taskManager: ctx.taskManager,
      assertPrMerged: async () => ({ ok: true }),
    });

    const out = await handler({});
    const parsed = JSON.parse(out.content[0].text);
    expect(parsed.success).toBe(true);
    expect(ctx.taskRepo.getTask(task.id)?.status).toBe('done');
  });

  test('mark_complete proceeds when no gate is installed (non-merge workflow)', async () => {
    const task = ctx.taskRepo.createTask({
      spaceId: ctx.spaceId,
      title: 'T',
      description: '',
      status: 'approved',
    });
    // No assertPrMerged dep → the gate is a no-op.
    const handler = createMarkCompleteHandler({
      taskId: task.id,
      spaceId: ctx.spaceId,
      taskRepo: ctx.taskRepo,
      taskManager: ctx.taskManager,
    });

    const out = await handler({});
    const parsed = JSON.parse(out.content[0].text);
    expect(parsed.success).toBe(true);
    expect(ctx.taskRepo.getTask(task.id)?.status).toBe('done');
  });

  test('mark_complete uses result artifact before stale generic task result', async () => {
    const task = ctx.taskRepo.createTask({
      spaceId: ctx.spaceId,
      title: 'T',
      description: '',
      status: 'approved',
    });
    ctx.taskRepo.updateTask(task.id, {
      result:
        'An unexpected error occurred. Please try again or contact support if the issue persists.',
      reportedSummary: 'PR #2007 merged to dev via squash merge.',
    });
    const handler = createMarkCompleteHandler({
      taskId: task.id,
      spaceId: ctx.spaceId,
      taskRepo: ctx.taskRepo,
      taskManager: ctx.taskManager,
      resolveResultArtifactSummary: () =>
        'Merge artifact: PR #2007 merged to dev via squash merge.',
    });

    const out = await handler({});
    const parsed = JSON.parse(out.content[0].text);
    expect(parsed.success).toBe(true);

    const updated = ctx.taskRepo.getTask(task.id);
    expect(updated?.status).toBe('done');
    expect(updated?.result).toBe('Merge artifact: PR #2007 merged to dev via squash merge.');
    expect(updated?.reportedSummary).toBe(
      'Merge artifact: PR #2007 merged to dev via squash merge.'
    );
  });

  test('mark_complete falls back to reported summary instead of generic task result', async () => {
    const task = ctx.taskRepo.createTask({
      spaceId: ctx.spaceId,
      title: 'T',
      description: '',
      status: 'approved',
    });
    ctx.taskRepo.updateTask(task.id, {
      result:
        'An unexpected error occurred. Please try again or contact support if the issue persists.',
      reportedSummary: 'PR #2007 merged to dev via squash merge.',
    });
    const handler = createMarkCompleteHandler({
      taskId: task.id,
      spaceId: ctx.spaceId,
      taskRepo: ctx.taskRepo,
      taskManager: ctx.taskManager,
    });

    const out = await handler({});
    const parsed = JSON.parse(out.content[0].text);
    expect(parsed.success).toBe(true);

    const updated = ctx.taskRepo.getTask(task.id);
    expect(updated?.status).toBe('done');
    expect(updated?.result).toBe('PR #2007 merged to dev via squash merge.');
    expect(updated?.reportedSummary).toBe('PR #2007 merged to dev via squash merge.');
  });

  test('mark_complete preserves meaningful task result before reported summary', async () => {
    const task = ctx.taskRepo.createTask({
      spaceId: ctx.spaceId,
      title: 'T',
      description: '',
      status: 'approved',
    });
    ctx.taskRepo.updateTask(task.id, {
      result: 'Manual correction: deployment verified.',
      reportedSummary: 'Older reported summary from previous cycle.',
    });
    const handler = createMarkCompleteHandler({
      taskId: task.id,
      spaceId: ctx.spaceId,
      taskRepo: ctx.taskRepo,
      taskManager: ctx.taskManager,
    });

    const out = await handler({});
    const parsed = JSON.parse(out.content[0].text);
    expect(parsed.success).toBe(true);

    const updated = ctx.taskRepo.getTask(task.id);
    expect(updated?.status).toBe('done');
    expect(updated?.result).toBe('Manual correction: deployment verified.');
    expect(updated?.reportedSummary).toBe('Older reported summary from previous cycle.');
  });

  test('emits space.task.updated for cascaded dependent tasks', async () => {
    const task = ctx.taskRepo.createTask({
      spaceId: ctx.spaceId,
      title: 'T',
      description: '',
      status: 'approved',
    });
    const cascadedTask: SpaceTask = {
      ...task,
      id: 'dependent-task',
      status: 'open',
      dependsOn: [task.id],
    };
    const updatedTask: SpaceTask = { ...task, status: 'done' };
    const { bus, emitted } = makeMockBus();
    const setTaskStatus = mock(async (_taskId, _status, options) => {
      await options?.onCascadedTasks?.([cascadedTask]);
      return updatedTask;
    });
    const handler = createMarkCompleteHandler({
      taskId: task.id,
      spaceId: ctx.spaceId,
      taskRepo: ctx.taskRepo,
      taskManager: { setTaskStatus, updateTask: ctx.taskManager.updateTask.bind(ctx.taskManager) },
      internalEventBus: bus,
    });

    await handler({});

    const updateEvents = emitted.filter((e) => e.name === 'space.task.updated');
    expect(updateEvents.map((e) => e.payload.taskId)).toEqual([cascadedTask.id, task.id]);
    expect(setTaskStatus).toHaveBeenCalledWith(
      task.id,
      'done',
      expect.objectContaining({ onCascadedTasks: expect.any(Function) })
    );
  });
});

// ===========================================================================
// createPrMergedGate — the merge-completion gate factory
// ===========================================================================

describe('createPrMergedGate', () => {
  const PR_URL = 'https://github.com/lsm/HyperNeo/pull/1234';

  function makeGate(opts: { state?: string; throwOnLookup?: boolean; prUrl?: string } = {}) {
    const { state = 'MERGED', throwOnLookup = false, prUrl = PR_URL } = opts;
    return createPrMergedGate({
      resolvePrUrl: () => prUrl,
      getPrState: async () => {
        if (throwOnLookup) throw new Error('GitHub unreachable');
        return state;
      },
    });
  }

  const task = { id: 't-1', spaceId: 's-1' } as SpaceTask;

  test('passes when the PR is MERGED', async () => {
    const gate = makeGate({ state: 'MERGED' });
    const result = await gate(task);
    expect(result).toEqual({ ok: true });
  });

  test('blocks while the PR is OPEN (merge not yet done)', async () => {
    const gate = makeGate({ state: 'OPEN' });
    const result = await gate(task);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain('still OPEN');
      expect(result.error).toContain(PR_URL);
    }
  });

  test('blocks when the PR is CLOSED without a merge', async () => {
    const gate = makeGate({ state: 'CLOSED' });
    const result = await gate(task);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain('CLOSED');
      expect(result.error).toContain('not merged');
    }
  });

  test('fails closed on lookup error', async () => {
    const gate = makeGate({ throwOnLookup: true });
    const result = await gate(task);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain('could not verify');
    }
  });

  test('passes when no pr_url resolves (non-PR run) — no lookup attempted', async () => {
    const gate = makeGate({ prUrl: '' });
    const result = await gate(task);
    expect(result).toEqual({ ok: true });
  });
});

// ===========================================================================
// approve_task — autonomy-gated self-close
// ===========================================================================

describe('createEndNodeHandlers — approve_task', () => {
  let ctx: TestCtx;
  beforeEach(() => {
    ctx = makeCtx();
  });
  afterEach(() => {
    ctx.db.close();
  });

  test('returns error when space.autonomyLevel < workflow.completionAutonomyLevel', async () => {
    const task = ctx.taskRepo.createTask({
      spaceId: ctx.spaceId,
      title: 'T',
      description: '',
      status: 'in_progress',
    });
    const { onApproveTask } = createEndNodeHandlers(
      makeDeps(ctx, task.id, {
        workflow: makeWorkflow(3),
        spaceManager: { getSpace: async () => makeSpace(ctx.spaceId, 1) },
      })
    );

    const out = await onApproveTask({});
    const parsed = JSON.parse(out.content[0].text);

    expect(parsed.success).toBe(false);
    expect(parsed.error).toContain('approve_task not permitted');
    expect(parsed.error).toContain('space autonomy level 1');
    expect(parsed.error).toContain('completionAutonomyLevel 3');

    // task unchanged
    const t = ctx.taskRepo.getTask(task.id);
    expect(t?.reportedStatus).toBeFalsy();
  });

  test('defaults to level 1 when space has no autonomy set', async () => {
    const task = ctx.taskRepo.createTask({
      spaceId: ctx.spaceId,
      title: 'T',
      description: '',
      status: 'in_progress',
    });
    const { onApproveTask } = createEndNodeHandlers(
      makeDeps(ctx, task.id, {
        workflow: makeWorkflow(3),
        spaceManager: { getSpace: async () => makeSpace(ctx.spaceId, undefined) },
      })
    );

    const out = await onApproveTask({});
    const parsed = JSON.parse(out.content[0].text);
    expect(parsed.success).toBe(false);
    expect(parsed.error).toContain('space autonomy level 1');
  });

  test('defaults to required level 5 when workflow is null (blocks approval)', async () => {
    const task = ctx.taskRepo.createTask({
      spaceId: ctx.spaceId,
      title: 'T',
      description: '',
      status: 'in_progress',
    });
    const { onApproveTask } = createEndNodeHandlers(
      makeDeps(ctx, task.id, {
        workflow: null,
        spaceManager: { getSpace: async () => makeSpace(ctx.spaceId, 4) },
      })
    );

    const out = await onApproveTask({});
    const parsed = JSON.parse(out.content[0].text);
    expect(parsed.success).toBe(false);
    expect(parsed.error).toContain('completionAutonomyLevel 5');
  });

  test('sets reportedStatus=done when autonomy is sufficient', async () => {
    const task = ctx.taskRepo.createTask({
      spaceId: ctx.spaceId,
      title: 'T',
      description: '',
      status: 'in_progress',
    });
    const { onApproveTask } = createEndNodeHandlers(
      makeDeps(ctx, task.id, {
        workflow: makeWorkflow(3),
        spaceManager: { getSpace: async () => makeSpace(ctx.spaceId, 3) },
      })
    );

    const out = await onApproveTask({});
    const parsed = JSON.parse(out.content[0].text);

    expect(parsed.success).toBe(true);
    expect(parsed.taskId).toBe(task.id);
    expect(parsed.message).toContain('completion-action pipeline');

    const t = ctx.taskRepo.getTask(task.id);
    expect(t?.reportedStatus).toBe('done');
  });

  test('clears pending-completion fields except approval source node', async () => {
    const task = ctx.taskRepo.createTask({
      spaceId: ctx.spaceId,
      title: 'T',
      description: '',
      status: 'review',
    });
    // Prime the pending-completion fields as if submit_for_approval ran first.
    ctx.taskRepo.updateTask(task.id, {
      pendingCheckpointType: 'task_completion',
      pendingCompletionSubmittedByNodeId: 'end-node',
      pendingCompletionSubmittedAt: Date.now() - 1000,
      pendingCompletionReason: 'prior reason',
    });

    const { onApproveTask } = createEndNodeHandlers(
      makeDeps(ctx, task.id, {
        workflow: makeWorkflow(2),
        spaceManager: { getSpace: async () => makeSpace(ctx.spaceId, 3) },
      })
    );

    const out = await onApproveTask({});
    expect(JSON.parse(out.content[0].text).success).toBe(true);

    const t = ctx.taskRepo.getTask(task.id);
    expect(t?.reportedStatus).toBe('done');
    expect(t?.pendingCheckpointType).toBeNull();
    expect(t?.pendingCompletionSubmittedByNodeId).toBe('end-node');
    expect(t?.pendingCompletionSubmittedAt).toBeNull();
    expect(t?.pendingCompletionReason).toBeNull();
  });

  test('records calling node as approval source for post-approval routing', async () => {
    const task = ctx.taskRepo.createTask({
      spaceId: ctx.spaceId,
      title: 'T',
      description: '',
      status: 'in_progress',
    });
    const { onApproveTask } = createEndNodeHandlers(
      makeDeps(ctx, task.id, {
        workflow: makeWorkflow(2, 'validation-node'),
        workflowNodeId: 'validation-node',
        spaceManager: { getSpace: async () => makeSpace(ctx.spaceId, 3) },
      })
    );

    const out = await onApproveTask({});
    expect(JSON.parse(out.content[0].text).success).toBe(true);

    const t = ctx.taskRepo.getTask(task.id);
    expect(t?.reportedStatus).toBe('done');
    expect(t?.pendingCompletionSubmittedByNodeId).toBe('validation-node');
    // The router/dispatch read this durable field (not the pending-completion
    // fields, which are cleared on entering `approved`) — task #851.
    expect(t?.postApprovalSourceNodeId).toBe('validation-node');
  });

  test('emits space.task.updated with the updated task on success', async () => {
    const task = ctx.taskRepo.createTask({
      spaceId: ctx.spaceId,
      title: 'T',
      description: '',
      status: 'in_progress',
    });
    const { bus, emitted } = makeMockBus();
    const { onApproveTask } = createEndNodeHandlers(
      makeDeps(ctx, task.id, {
        workflow: makeWorkflow(3),
        spaceManager: { getSpace: async () => makeSpace(ctx.spaceId, 3) },
        internalEventBus: bus,
      })
    );

    await onApproveTask({});

    const updateEvents = emitted.filter((e) => e.name === 'space.task.updated');
    expect(updateEvents).toHaveLength(1);
    expect(updateEvents[0].payload.taskId).toBe(task.id);
    expect(updateEvents[0].payload.spaceId).toBe(ctx.spaceId);
    const emittedTask = updateEvents[0].payload.task as { id: string; reportedStatus: string };
    expect(emittedTask.id).toBe(task.id);
    expect(emittedTask.reportedStatus).toBe('done');
  });

  test('does NOT emit space.task.updated when permission check fails', async () => {
    const task = ctx.taskRepo.createTask({
      spaceId: ctx.spaceId,
      title: 'T',
      description: '',
      status: 'in_progress',
    });
    const { bus, emitted } = makeMockBus();
    const { onApproveTask } = createEndNodeHandlers(
      makeDeps(ctx, task.id, {
        workflow: makeWorkflow(5),
        spaceManager: { getSpace: async () => makeSpace(ctx.spaceId, 1) },
        internalEventBus: bus,
      })
    );

    await onApproveTask({});
    expect(emitted).toHaveLength(0);
  });

  test('returns error when task does not exist (even at sufficient autonomy)', async () => {
    const { onApproveTask } = createEndNodeHandlers(
      makeDeps(ctx, 'ghost-task', {
        workflow: makeWorkflow(3),
        spaceManager: { getSpace: async () => makeSpace(ctx.spaceId, 5) },
      })
    );
    const out = await onApproveTask({});
    const parsed = JSON.parse(out.content[0].text);
    expect(parsed.success).toBe(false);
    expect(parsed.error).toContain('ghost-task');
  });
});

// ===========================================================================
// submit_for_approval — always available
// ===========================================================================

describe('createEndNodeHandlers — submit_for_approval', () => {
  let ctx: TestCtx;
  beforeEach(() => {
    ctx = makeCtx();
  });
  afterEach(() => {
    ctx.db.close();
  });

  test('sets status=review and populates pending-completion fields', async () => {
    const task = ctx.taskRepo.createTask({
      spaceId: ctx.spaceId,
      title: 'T',
      description: '',
      status: 'in_progress',
    });
    const { onSubmitForApproval } = createEndNodeHandlers(
      makeDeps(ctx, task.id, { workflowNodeId: 'end-node-xyz' })
    );

    const before = Date.now();
    const out = await onSubmitForApproval({ reason: 'needs review' });
    const after = Date.now();

    const parsed = JSON.parse(out.content[0].text);
    expect(parsed.success).toBe(true);
    expect(parsed.message).toContain('submitted for human review');
    expect(parsed.message).toContain('needs review');

    const t = ctx.taskRepo.getTask(task.id);
    expect(t?.status).toBe('review');
    expect(t?.pendingCheckpointType).toBe('task_completion');
    expect(t?.pendingCompletionSubmittedByNodeId).toBe('end-node-xyz');
    expect(t?.pendingCompletionReason).toBe('needs review');
    expect(t?.pendingCompletionSubmittedAt).toBeGreaterThanOrEqual(before);
    expect(t?.pendingCompletionSubmittedAt).toBeLessThanOrEqual(after);
  });

  test('handles missing reason (optional field)', async () => {
    const task = ctx.taskRepo.createTask({
      spaceId: ctx.spaceId,
      title: 'T',
      description: '',
      status: 'in_progress',
    });
    const { onSubmitForApproval } = createEndNodeHandlers(makeDeps(ctx, task.id));

    const out = await onSubmitForApproval({});
    const parsed = JSON.parse(out.content[0].text);

    expect(parsed.success).toBe(true);
    // Message omits the "(reason: ...)" suffix when reason is missing.
    expect(parsed.message).not.toContain('(reason:');

    const t = ctx.taskRepo.getTask(task.id);
    expect(t?.status).toBe('review');
    expect(t?.pendingCompletionReason).toBeNull();
  });

  test('succeeds regardless of space autonomy level', async () => {
    // submit_for_approval must work even at level 1 (the most restrictive).
    const task = ctx.taskRepo.createTask({
      spaceId: ctx.spaceId,
      title: 'T',
      description: '',
      status: 'in_progress',
    });
    const { onSubmitForApproval } = createEndNodeHandlers(
      makeDeps(ctx, task.id, {
        workflow: makeWorkflow(5),
        spaceManager: { getSpace: async () => makeSpace(ctx.spaceId, 1) },
      })
    );

    const out = await onSubmitForApproval({ reason: 'low-autonomy submit' });
    const parsed = JSON.parse(out.content[0].text);
    expect(parsed.success).toBe(true);

    const t = ctx.taskRepo.getTask(task.id);
    expect(t?.status).toBe('review');
  });

  test('emits space.task.updated with the updated task', async () => {
    const task = ctx.taskRepo.createTask({
      spaceId: ctx.spaceId,
      title: 'T',
      description: '',
      status: 'in_progress',
    });
    const { bus, emitted } = makeMockBus();
    const { onSubmitForApproval } = createEndNodeHandlers(
      makeDeps(ctx, task.id, { internalEventBus: bus })
    );

    await onSubmitForApproval({ reason: 'escalate' });

    const updateEvents = emitted.filter((e) => e.name === 'space.task.updated');
    expect(updateEvents).toHaveLength(1);
    expect(updateEvents[0].payload.taskId).toBe(task.id);
    const emittedTask = updateEvents[0].payload.task as {
      id: string;
      status: string;
      pendingCheckpointType: string;
    };
    expect(emittedTask.id).toBe(task.id);
    expect(emittedTask.status).toBe('review');
    expect(emittedTask.pendingCheckpointType).toBe('task_completion');
  });

  test('succeeds when task is in blocked status', async () => {
    const task = ctx.taskRepo.createTask({
      spaceId: ctx.spaceId,
      title: 'T',
      description: '',
      status: 'blocked',
    });
    const { onSubmitForApproval } = createEndNodeHandlers(makeDeps(ctx, task.id));

    const out = await onSubmitForApproval({ reason: 'from blocked' });
    const parsed = JSON.parse(out.content[0].text);

    expect(parsed.success).toBe(true);
    const t = ctx.taskRepo.getTask(task.id);
    expect(t?.status).toBe('review');
    expect(t?.pendingCompletionReason).toBe('from blocked');
  });

  test('succeeds when task is in open status', async () => {
    const task = ctx.taskRepo.createTask({
      spaceId: ctx.spaceId,
      title: 'T',
      description: '',
      status: 'open',
    });
    const { onSubmitForApproval } = createEndNodeHandlers(makeDeps(ctx, task.id));

    const out = await onSubmitForApproval({ reason: 'from open' });
    const parsed = JSON.parse(out.content[0].text);

    expect(parsed.success).toBe(true);
    const t = ctx.taskRepo.getTask(task.id);
    expect(t?.status).toBe('review');
    expect(t?.pendingCompletionReason).toBe('from open');
  });

  test('returns error when task does not exist', async () => {
    const { onSubmitForApproval } = createEndNodeHandlers(makeDeps(ctx, 'ghost'));
    const out = await onSubmitForApproval({ reason: 'x' });
    const parsed = JSON.parse(out.content[0].text);
    expect(parsed.success).toBe(false);
    expect(parsed.error).toContain('ghost');
  });
});

// ===========================================================================
// daemonHub is optional
// ===========================================================================

describe('createEndNodeHandlers — daemonHub is optional', () => {
  let ctx: TestCtx;
  beforeEach(() => {
    ctx = makeCtx();
  });
  afterEach(() => {
    ctx.db.close();
  });

  test('approve_task succeeds without a daemonHub', async () => {
    const task = ctx.taskRepo.createTask({
      spaceId: ctx.spaceId,
      title: 'T',
      description: '',
      status: 'in_progress',
    });
    const { onApproveTask } = createEndNodeHandlers(
      makeDeps(ctx, task.id, {
        workflow: makeWorkflow(1),
        spaceManager: { getSpace: async () => makeSpace(ctx.spaceId, 5) },
        internalEventBus: undefined,
      })
    );

    const out = await onApproveTask({});
    expect(JSON.parse(out.content[0].text).success).toBe(true);
    expect(ctx.taskRepo.getTask(task.id)?.reportedStatus).toBe('done');
  });

  test('submit_for_approval succeeds without a daemonHub', async () => {
    const task = ctx.taskRepo.createTask({
      spaceId: ctx.spaceId,
      title: 'T',
      description: '',
      status: 'in_progress',
    });
    const { onSubmitForApproval } = createEndNodeHandlers(
      makeDeps(ctx, task.id, { internalEventBus: undefined })
    );

    const out = await onSubmitForApproval({});
    expect(JSON.parse(out.content[0].text).success).toBe(true);
    expect(ctx.taskRepo.getTask(task.id)?.status).toBe('review');
  });
});
