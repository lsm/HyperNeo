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

import { describe, test, expect, beforeEach, afterEach, mock, spyOn } from 'bun:test';
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
import {
  createCompleteValidationTaskHandler,
  type CompleteValidationTaskHandlerDeps,
} from '../../../../src/lib/space/tools/end-node-handlers.ts';
import { SpaceWorkflowRepository } from '../../../../src/storage/repositories/space-workflow-repository.ts';
import { SpaceWorkflowRunRepository } from '../../../../src/storage/repositories/space-workflow-run-repository.ts';
import { NodeExecutionRepository } from '../../../../src/storage/repositories/node-execution-repository.ts';
import { SpaceLongHorizonAgentRepository } from '../../../../src/storage/repositories/space-long-horizon-agent-repository.ts';
import { WorkflowRunArtifactRepository } from '../../../../src/storage/repositories/workflow-run-artifact-repository.ts';
import { SpaceWorkflowManager } from '../../../../src/lib/space/managers/space-workflow-manager.ts';
import { SpaceManager } from '../../../../src/lib/space/managers/space-manager.ts';
import { CodingArtifactProfile } from '../../../../src/lib/space/workflows/coding-artifact-profile.ts';
import { McpAuditLogRepository } from '../../../../src/storage/repositories/mcp-audit-log-repository.ts';
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

  function makeGateDeps(opts: { state?: string; throwOnLookup?: boolean; prUrl?: string } = {}) {
    const { state = 'MERGED', throwOnLookup = false, prUrl = PR_URL } = opts;
    return {
      resolvePrUrl: () => prUrl,
      getPrState: async () => {
        if (throwOnLookup) throw new Error('GitHub unreachable');
        return state;
      },
    };
  }

  const task = { id: 't-1', spaceId: 's-1' } as SpaceTask;

  test('passes when the PR is MERGED', async () => {
    const gate = createPrMergedGate(makeGateDeps({ state: 'MERGED' }));
    const result = await gate(task);
    expect(result).toEqual({ ok: true });
  });

  test('blocks while the PR is OPEN (merge not yet done)', async () => {
    const gate = createPrMergedGate(makeGateDeps({ state: 'OPEN' }));
    const result = await gate(task);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain('still OPEN');
      expect(result.error).toContain(PR_URL);
    }
  });

  test('blocks when the PR is CLOSED without a merge', async () => {
    const gate = createPrMergedGate(makeGateDeps({ state: 'CLOSED' }));
    const result = await gate(task);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain('CLOSED');
      expect(result.error).toContain('not merged');
    }
  });

  test('fails closed on lookup error', async () => {
    const gate = createPrMergedGate(makeGateDeps({ throwOnLookup: true }));
    const result = await gate(task);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain('could not verify');
    }
  });

  test('passes when no pr_url resolves and the workflow does not require one', async () => {
    const gate = createPrMergedGate(makeGateDeps({ prUrl: '' }));
    const result = await gate(task);
    expect(result).toEqual({ ok: true });
  });

  test('fails closed when a required pr_url does not resolve', async () => {
    const gate = createPrMergedGate({
      resolvePrUrl: () => '',
      requirePrUrl: true,
      getPrState: async () => {
        throw new Error('must not be called');
      },
    });
    const result = await gate(task);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain("could not resolve the run's PR URL");
      expect(result.error).toContain('stays approved');
    }
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

// ---------------------------------------------------------------------------
// complete_validation_task — validation-only (no-PR) completion path
// (task #918; relocated from space-agent-tools.test.ts when the tool moved
// to the node-agent surface — this factory is the tool's entire guard chain)
// ---------------------------------------------------------------------------
//
// Node-agent-exclusive (task #918): the handler lives in
// `createCompleteValidationTaskHandler` (end-node-handlers.ts) and is mirrored
// onto node-agent servers like `mark_complete` — workflow workers are its
// callers. These tests drive the factory's guard chain directly; the
// registration surface (node-agent presence / space-agent-tools absence) is
// covered in node-agent-tools.test.ts and the tool-registration suite above.

describe('createCompleteValidationTaskHandler — complete_validation_task', () => {
  interface ValidationCtx {
    db: BunDatabase;
    spaceId: string;
    agentId: string;
    workflowManager: SpaceWorkflowManager;
    workflowRunRepo: SpaceWorkflowRunRepository;
    taskRepo: SpaceTaskRepository;
    taskManager: SpaceTaskManager;
    nodeExecutionRepo: NodeExecutionRepository;
    spaceManager: SpaceManager;
    longHorizonAgentRepo: SpaceLongHorizonAgentRepository;
    goalService: SpaceGoalService;
    artifactProfile: CodingArtifactProfile;
  }

  function makeValidationCtx(): ValidationCtx {
    const db = new BunDatabase(':memory:');
    db.exec('PRAGMA foreign_keys = ON');
    runMigrations(db, () => {});
    db.exec(`CREATE TABLE IF NOT EXISTS sessions (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      workspace_path TEXT,
      created_at TEXT NOT NULL,
      last_active_at TEXT NOT NULL,
      status TEXT NOT NULL,
      config TEXT NOT NULL,
      metadata TEXT NOT NULL,
      is_worktree INTEGER DEFAULT 0,
      worktree_path TEXT,
      main_repo_path TEXT,
      worktree_branch TEXT,
      git_branch TEXT,
      sdk_session_id TEXT,
      acp_session_id TEXT,
      available_commands TEXT,
      processing_state TEXT,
      archived_at TEXT,
      parent_id TEXT,
      type TEXT DEFAULT 'worker',
      session_context TEXT
    )`);
    const spaceId = 'space-validation-tools';
    db.prepare(
      `INSERT INTO spaces (id, workspace_path, name, description, background_context, instructions,
       allowed_models, session_ids, slug, status, created_at, updated_at)
       VALUES (?, '/tmp/validation-ws', ?, '', '', '', '[]', '[]', ?, 'active', ?, ?)`
    ).run(spaceId, `Space ${spaceId}`, spaceId, Date.now(), Date.now());
    const agentId = 'agent-validator-1';
    db.prepare(
      `INSERT INTO space_agents (id, space_id, name, description, model, tools, system_prompt, created_at, updated_at)
       VALUES (?, ?, 'Validator', '', null, '[]', '', ?, ?)`
    ).run(agentId, spaceId, Date.now(), Date.now());
    const taskRepo = new SpaceTaskRepository(db);
    const artifactRepo = new WorkflowRunArtifactRepository(db);
    return {
      db,
      spaceId,
      agentId,
      workflowManager: new SpaceWorkflowManager(new SpaceWorkflowRepository(db)),
      workflowRunRepo: new SpaceWorkflowRunRepository(db),
      taskRepo,
      taskManager: new SpaceTaskManager(db, spaceId),
      nodeExecutionRepo: new NodeExecutionRepository(db),
      spaceManager: new SpaceManager(db),
      longHorizonAgentRepo: new SpaceLongHorizonAgentRepository(db),
      goalService: new SpaceGoalService({
        goalRepo: new SpaceGoalRepository(db),
        goalEventRepo: new SpaceGoalEventRepository(db),
        taskRepo,
        spaceRepo: new SpaceRepository(db),
        scheduleService: new ScheduleService({
          db,
          scheduleRepo: new TaskScheduleRepository(db),
          jobQueue: new JobQueueRepository(db),
          spaceRepo: new SpaceRepository(db),
        }),
        db,
      }),
      artifactProfile: new CodingArtifactProfile({ db, artifactRepo }),
    };
  }

  let ctx: ValidationCtx;
  beforeEach(() => {
    ctx = makeValidationCtx();
  });
  afterEach(() => {
    ctx.db.close();
  });

  // Build the handler with the same dependency shape TaskAgentManager wires
  // into node-agent servers. Returns an object so call sites read
  // `.complete_validation_task({...})`.
  function makeValidationTool(overrides: Partial<CompleteValidationTaskHandlerDeps> = {}): {
    complete_validation_task: ReturnType<typeof createCompleteValidationTaskHandler>;
  } {
    return {
      complete_validation_task: createCompleteValidationTaskHandler({
        spaceId: ctx.spaceId,
        db: ctx.db,
        taskRepo: ctx.taskRepo,
        taskManager: ctx.taskManager,
        workflowRunRepo: ctx.workflowRunRepo,
        getWorkflowForRun: (run) => ctx.workflowManager.getWorkflowForRun(run),
        nodeExecutionRepo: ctx.nodeExecutionRepo,
        resolvePrimaryLinkUrl: (runId) => {
          const strict = ctx.artifactProfile.resolvePrimaryLinkUrlStrict(runId);
          return strict.readable ? strict.url : null;
        },
        spaceManager: ctx.spaceManager,
        goalService: ctx.goalService,
        ...overrides,
      }),
    };
  }

  async function createTask(status: 'review' | 'in_progress'): Promise<string> {
    await ctx.spaceManager.updateSpace(ctx.spaceId, { autonomyLevel: 5 });
    const task = await ctx.taskManager.createTask({
      title: 'Forge review task',
      description: 'no-code validation task',
    });
    ctx.taskRepo.updateTask(task.id, { status });
    return task.id;
  }

  // Build a task whose workflow run declares a completion autonomy level, so
  // the gate is exercised against a real workflow (mirrors the approve_task
  // autonomy tests).
  function createWorkflowTask(
    requiredLevel: number,
    overrides: { status?: 'review' | 'in_progress' } = {}
  ): SpaceTask {
    const nodeId = `node-${Math.random().toString(36).slice(2)}`;
    const workflow = ctx.workflowManager.createWorkflow({
      spaceId: ctx.spaceId,
      name: `Validation gated workflow ${requiredLevel} ${nodeId.slice(-6)}`,
      description: '',
      nodes: [{ id: nodeId, name: 'Review', agentId: ctx.agentId }],
      transitions: [],
      startNodeId: nodeId,
      endNodeId: nodeId,
      rules: [],
      completionAutonomyLevel: requiredLevel,
    });
    const run = ctx.workflowRunRepo.createRun({
      spaceId: ctx.spaceId,
      workflowId: workflow.id,
      title: 'Validation gated run',
      description: '',
    });
    // Validation completion requires a runnable (`in_progress`) run — promote
    // out of the transient `pending` state exactly as the start path does.
    ctx.workflowRunRepo.updateRun(run.id, { status: 'in_progress' });
    return ctx.taskRepo.createTask({
      spaceId: ctx.spaceId,
      title: 'Validation task',
      description: '',
      status: overrides.status ?? 'in_progress',
      workflowRunId: run.id,
    });
  }

  test('completes a no-PR task in review → done and captures the validation outcome', async () => {
    const taskId = await createTask('review');

    const result = await makeValidationTool().complete_validation_task({
      task_id: taskId,
      validation_outcome: 'Reviewed 3 episodes; all evidence scoped correctly.',
      reason: 'weekly self_nag',
    });
    const parsed = JSON.parse(result.content[0].text);

    expect(parsed.success).toBe(true);
    expect(parsed.task.status).toBe('done');
    expect(parsed.task.result).toBe('Reviewed 3 episodes; all evidence scoped correctly.');
    // review → done stamps approvalSource 'agent' and approvalReason from `reason`.
    expect(parsed.task.approvalSource).toBe('agent');
    expect(parsed.task.approvalReason).toBe('weekly self_nag');
    expect(parsed.task.approvedAt).not.toBeNull();
    expect(ctx.taskRepo.getTask(taskId)?.result).toBe(
      'Reviewed 3 episodes; all evidence scoped correctly.'
    );
    expect(ctx.taskRepo.getTask(taskId)?.approvalReason).toBe('weekly self_nag');
  });

  test('completes a no-PR task in_progress → done', async () => {
    const taskId = await createTask('in_progress');

    const result = await makeValidationTool().complete_validation_task({
      task_id: taskId,
      validation_outcome: 'Diagnostic: no regression found in CI shard 4.',
    });
    const parsed = JSON.parse(result.content[0].text);

    expect(parsed.success).toBe(true);
    expect(parsed.task.status).toBe('done');
    expect(parsed.task.result).toBe('Diagnostic: no regression found in CI shard 4.');
    // The approval metadata is stamped atomically with the in_progress→done
    // commit (setTaskStatus honors an explicit approvalSource on that
    // transition), so the terminal task records its agent-completion —
    // audit parity with the review→done path.
    expect(parsed.task.approvalSource).toBe('agent');
    expect(ctx.taskRepo.getTask(taskId)?.approvalSource).toBe('agent');
    expect(ctx.taskRepo.getTask(taskId)?.approvedAt).not.toBeNull();
    expect(ctx.taskRepo.getTask(taskId)?.status).toBe('done');
  });

  test('completes a workflow-backed task whose run has no PR (real no-PR resolution)', async () => {
    // A workflow-backed task with no primary-link artifact: the strict
    // resolver returns '{ url: '', readable: true }' organically, so the
    // no-PR guard is exercised for real.
    // The run carries a node execution so it is not the degenerate execution-less
    // shape the run-lifecycle guard rejects.
    await ctx.spaceManager.updateSpace(ctx.spaceId, { autonomyLevel: 5 });
    const task = createWorkflowTask(5, { status: 'in_progress' });
    ctx.nodeExecutionRepo.create({
      workflowRunId: task.workflowRunId!,
      workflowNodeId: 'node-review',
      agentName: 'Review',
      agentId: ctx.agentId,
      status: 'idle',
    });

    const result = await makeValidationTool().complete_validation_task({
      task_id: task.id,
      validation_outcome: 'Reviewed Forge scope; no PR involved.',
    });
    const parsed = JSON.parse(result.content[0].text);

    expect(parsed.success).toBe(true);
    expect(parsed.task.status).toBe('done');
    expect(parsed.task.result).toBe('Reviewed Forge scope; no PR involved.');
    expect(ctx.taskRepo.getTask(task.id)?.status).toBe('done');
  });

  test('rejects a workflow-backed task whose run has no node executions (stranded-run guard)', async () => {
    // Completing the task of an execution-less run would strand the run: the
    // tick loop's completion detection early-returns when there are no node
    // executions, so the run would stay active forever. Mirrors the archive_task
    // active-run guard precedent (task #849, G1).
    await ctx.spaceManager.updateSpace(ctx.spaceId, { autonomyLevel: 5 });
    const task = createWorkflowTask(5, { status: 'in_progress' });

    const result = await makeValidationTool().complete_validation_task({
      task_id: task.id,
      validation_outcome: 'validated',
    });
    const parsed = JSON.parse(result.content[0].text);

    expect(parsed.success).toBe(false);
    expect(parsed.error).toContain('no node executions');
    expect(parsed.error).toContain('Cancel the run instead');
    expect(ctx.taskRepo.getTask(task.id)?.status).toBe('in_progress');
  });

  test('rejects a workflow-backed task whose run is cancelled', async () => {
    // Cancellation/recovery edge: the task can linger in in_progress while
    // its run is already cancelled. Completing it would mark cancelled work
    // done, capture success evidence, and unblock dependents.
    await ctx.spaceManager.updateSpace(ctx.spaceId, { autonomyLevel: 5 });
    const task = createWorkflowTask(5, { status: 'in_progress' });
    ctx.nodeExecutionRepo.create({
      workflowRunId: task.workflowRunId!,
      workflowNodeId: 'node-review',
      agentName: 'Review',
      agentId: ctx.agentId,
      status: 'idle',
    });
    ctx.workflowRunRepo.updateRun(task.workflowRunId!, { status: 'cancelled' });

    const result = await makeValidationTool().complete_validation_task({
      task_id: task.id,
      validation_outcome: 'validated',
    });
    const parsed = JSON.parse(result.content[0].text);

    expect(parsed.success).toBe(false);
    expect(parsed.error).toContain('cancelled workflow run');
    expect(ctx.taskRepo.getTask(task.id)?.status).toBe('in_progress');
  });

  test('rejects a workflow-backed task whose run is blocked', async () => {
    // The runtime's blocking paths transition the run to `blocked` first and
    // update the task behind awaits, so a window exists where the run is
    // blocked but the task row still reads in_progress. A blocked run never
    // reaches completion detection (`processRunTick` routes it through
    // blocked-run recovery first), so completing the task would strand the
    // run or be overwritten by the pending task-block step.
    await ctx.spaceManager.updateSpace(ctx.spaceId, { autonomyLevel: 5 });
    const task = createWorkflowTask(5, { status: 'in_progress' });
    ctx.nodeExecutionRepo.create({
      workflowRunId: task.workflowRunId!,
      workflowNodeId: 'node-review',
      agentName: 'Review',
      agentId: ctx.agentId,
      status: 'idle',
    });
    ctx.workflowRunRepo.updateRun(task.workflowRunId!, { status: 'blocked' });

    const result = await makeValidationTool().complete_validation_task({
      task_id: task.id,
      validation_outcome: 'validated',
    });
    const parsed = JSON.parse(result.content[0].text);

    expect(parsed.success).toBe(false);
    expect(parsed.error).toContain('blocked workflow run');
    expect(ctx.taskRepo.getTask(task.id)?.status).toBe('in_progress');
  });

  test('rejects a workflow-backed task whose run is still pending', async () => {
    // `pending` is a transient pre-initialization state: the normal start path
    // promotes a run to in_progress before attaching its task, and
    // rehydration excludes pending runs. A completion landing on a still-
    // pending run would strand it outside every lifecycle loop.
    await ctx.spaceManager.updateSpace(ctx.spaceId, { autonomyLevel: 5 });
    const task = createWorkflowTask(5, { status: 'in_progress' });
    ctx.nodeExecutionRepo.create({
      workflowRunId: task.workflowRunId!,
      workflowNodeId: 'node-review',
      agentName: 'Review',
      agentId: ctx.agentId,
      status: 'idle',
    });
    ctx.workflowRunRepo.updateRun(task.workflowRunId!, { status: 'pending' });

    const result = await makeValidationTool().complete_validation_task({
      task_id: task.id,
      validation_outcome: 'validated',
    });
    const parsed = JSON.parse(result.content[0].text);

    expect(parsed.success).toBe(false);
    expect(parsed.error).toContain('pending workflow run');
    expect(ctx.taskRepo.getTask(task.id)?.status).toBe('in_progress');
  });

  test('terminal precondition rechecks the run: a cancellation or block landing before the write aborts completion', async () => {
    // Interleaving exercise for the terminal run-runnable recheck.
    // `stopActiveWork` cancels a `review` task's RUN while deliberately
    // excluding the task row from its task-cancellation pass, and the blocking
    // paths flip the run to `blocked` before their task update — in both cases
    // the run change is invisible to the exact-status predicate on the task
    // UPDATE. Simulate that here: the run is still runnable at the handler's
    // early guard, and flips inside setTaskStatus' task reread — the last sync
    // point before the precondition. Without the recheck the completion would
    // commit on a dead/parked run; with it, the write aborts and the review
    // state survives.
    for (const flipTo of ['cancelled', 'blocked'] as const) {
      await ctx.spaceManager.updateSpace(ctx.spaceId, { autonomyLevel: 5 });
      const task = createWorkflowTask(5, { status: 'review' });
      ctx.nodeExecutionRepo.create({
        workflowRunId: task.workflowRunId!,
        workflowNodeId: 'node-review',
        agentName: 'Review',
        agentId: ctx.agentId,
        status: 'idle',
      });
      const runId = task.workflowRunId!;
      const originalGetTask = ctx.taskManager.getTask.bind(ctx.taskManager);
      let runFlipped = false;
      const getTaskSpy = spyOn(ctx.taskManager, 'getTask').mockImplementation(
        async (taskId: string) => {
          if (taskId === task.id && !runFlipped) {
            runFlipped = true;
            ctx.workflowRunRepo.updateRun(runId, { status: flipTo });
          }
          return originalGetTask(taskId);
        }
      );

      try {
        const result = await makeValidationTool().complete_validation_task({
          task_id: task.id,
          validation_outcome: 'validated',
        });
        const parsed = JSON.parse(result.content[0].text);

        expect(parsed.success).toBe(false);
        expect(parsed.error).toContain(`${flipTo} workflow run`);
        expect(parsed.error).toContain('rechecked at the terminal write');
        // The review state (and its pending fields) survive the aborted write.
        expect(ctx.taskRepo.getTask(task.id)?.status).toBe('review');
        expect(ctx.taskRepo.getTask(task.id)?.result).toBeNull();
      } finally {
        getTaskSpy.mockRestore();
      }
    }
  });

  test('terminal precondition refuses a mid-flight re-attachment to a different workflow run', async () => {
    // `startWorkflowRun({parentTaskId})` can attach a task to a new run
    // WITHOUT changing its status — invisible to the exact-status SQL
    // predicate. All run-dependent guards (autonomy's workflow, PR, status,
    // canonical ownership, hooks, routes) evaluated against the ORIGINAL run;
    // committing against the new one would bypass the new run's guards. The
    // precondition binds the write to the checked run association.
    await ctx.spaceManager.updateSpace(ctx.spaceId, { autonomyLevel: 5 });
    const task = createWorkflowTask(5, { status: 'in_progress' });
    ctx.nodeExecutionRepo.create({
      workflowRunId: task.workflowRunId!,
      workflowNodeId: 'node-review',
      agentName: 'Review',
      agentId: ctx.agentId,
      status: 'idle',
    });
    // A second run the task gets re-attached to mid-flight.
    const otherWorkflow = ctx.workflowManager.createWorkflow({
      spaceId: ctx.spaceId,
      name: `Reattach workflow ${Math.random().toString(36).slice(2, 8)}`,
      description: '',
      nodes: [{ id: 'node-other', name: 'Other', agentId: ctx.agentId }],
      transitions: [],
      startNodeId: 'node-other',
      endNodeId: 'node-other',
      rules: [],
      completionAutonomyLevel: 5,
    });
    const otherRun = ctx.workflowRunRepo.createRun({
      spaceId: ctx.spaceId,
      workflowId: otherWorkflow.id,
      title: 'Reattach run',
      description: '',
    });
    const originalGetTask = ctx.taskManager.getTask.bind(ctx.taskManager);
    let reattached = false;
    const getTaskSpy = spyOn(ctx.taskManager, 'getTask').mockImplementation(
      async (taskId: string) => {
        if (taskId === task.id && !reattached) {
          reattached = true;
          ctx.taskRepo.updateTask(task.id, { workflowRunId: otherRun.id });
        }
        return originalGetTask(taskId);
      }
    );

    try {
      const result = await makeValidationTool().complete_validation_task({
        task_id: task.id,
        validation_outcome: 'validated',
      });
      const parsed = JSON.parse(result.content[0].text);

      expect(parsed.success).toBe(false);
      expect(parsed.error).toContain('workflow run association changed');
      // The task survives (still in_progress, now attached to the other run —
      // the re-attachment itself is legitimate runtime behavior).
      const after = ctx.taskRepo.getTask(task.id);
      expect(after?.status).toBe('in_progress');
      expect(after?.workflowRunId).toBe(otherRun.id);
      expect(after?.result).toBeNull();
    } finally {
      getTaskSpy.mockRestore();
    }
  });

  test('terminal precondition rechecks the checkpoint: a concurrent submit_for_approval mid-completion aborts it', async () => {
    // The early checkpoint guard sees an in_progress task (no checkpoint).
    // A concurrent submit_for_approval then flips it to review and stamps the
    // human-approval checkpoint BEFORE setTaskStatus' reread — `review` is in
    // the allowed set and the exact-status predicate keys on the reread
    // status, so only the precondition's checkpoint recheck on `current`
    // catches the flip. Standalone task (no run): proves the recheck is not
    // hidden behind the run-identity early-return.
    const taskId = await createTask('in_progress');
    const originalGetTask = ctx.taskManager.getTask.bind(ctx.taskManager);
    let submitted = false;
    const getTaskSpy = spyOn(ctx.taskManager, 'getTask').mockImplementation(async (id: string) => {
      if (id === taskId && !submitted) {
        submitted = true;
        // Mirrors submitTaskForReview's atomic single-UPDATE write.
        ctx.taskRepo.updateTask(taskId, {
          status: 'review',
          pendingCheckpointType: 'task_completion',
          pendingCompletionReason: 'needs human approval',
        });
      }
      return originalGetTask(id);
    });

    try {
      const result = await makeValidationTool().complete_validation_task({
        task_id: taskId,
        validation_outcome: 'should be refused',
      });
      const parsed = JSON.parse(result.content[0].text);

      expect(parsed.success).toBe(false);
      expect(parsed.error).toContain('submitted for human approval during completion');
      // The requested human review survives — status review, checkpoint intact.
      const after = ctx.taskRepo.getTask(taskId);
      expect(after?.status).toBe('review');
      expect(after?.pendingCheckpointType).toBe('task_completion');
      expect(after?.result).toBeNull();
    } finally {
      getTaskSpy.mockRestore();
    }
  });

  test('terminal precondition revalidates autonomy lowered mid-flight', async () => {
    // The entry gate resolved effective autonomy at 5 (space 5, required 5).
    // An operator lowers the space level to 2 between the gate and the
    // terminal write — the write must refuse rather than complete work under
    // revoked authority. The precondition rereads the level synchronously
    // from the spaces row.
    const taskId = await createTask('in_progress');
    const originalGetTask = ctx.taskManager.getTask.bind(ctx.taskManager);
    let lowered = false;
    const getTaskSpy = spyOn(ctx.taskManager, 'getTask').mockImplementation(async (id: string) => {
      if (id === taskId && !lowered) {
        lowered = true;
        await ctx.spaceManager.updateSpace(ctx.spaceId, { autonomyLevel: 2 });
      }
      return originalGetTask(id);
    });

    try {
      const result = await makeValidationTool().complete_validation_task({
        task_id: taskId,
        validation_outcome: 'should be refused',
      });
      const parsed = JSON.parse(result.content[0].text);

      expect(parsed.success).toBe(false);
      expect(parsed.error).toContain('effective autonomy was lowered to 2');
      expect(parsed.error).toContain('submit_for_approval');
      expect(ctx.taskRepo.getTask(taskId)?.status).toBe('in_progress');
      expect(ctx.taskRepo.getTask(taskId)?.result).toBeNull();
    } finally {
      getTaskSpy.mockRestore();
    }
  });

  test('quiesces same-node peer agents, sparing only the caller', async () => {
    // The reconciliation sweep excludes every execution on the recorded
    // source NODE, so peers in a multi-slot node would survive in_progress
    // after the task completes — still able to act on finished work. The
    // tool narrows the spared set to the caller: same-node peers go idle and
    // are interrupted; the caller's own execution (mid-tool-call) and
    // cross-node executions (the runtime sweep's business) are untouched.
    await ctx.spaceManager.updateSpace(ctx.spaceId, { autonomyLevel: 5 });
    const task = createWorkflowTask(5, { status: 'in_progress' });
    ctx.nodeExecutionRepo.create({
      workflowRunId: task.workflowRunId!,
      workflowNodeId: 'node-mid-worker',
      agentName: 'Worker',
      agentId: ctx.agentId,
      status: 'in_progress',
      agentSessionId: 'worker-session-mid',
    });
    ctx.nodeExecutionRepo.create({
      workflowRunId: task.workflowRunId!,
      workflowNodeId: 'node-mid-worker',
      agentName: 'Peer',
      agentId: ctx.agentId,
      status: 'in_progress',
      agentSessionId: 'peer-session',
    });
    ctx.nodeExecutionRepo.create({
      workflowRunId: task.workflowRunId!,
      workflowNodeId: 'node-other',
      agentName: 'Other',
      agentId: ctx.agentId,
      status: 'in_progress',
      agentSessionId: 'other-session',
    });
    ctx.db
      .prepare(
        `INSERT INTO sessions (
            id, title, workspace_path, created_at, last_active_at, status, config, metadata,
            is_worktree, git_branch, processing_state, type, session_context
          ) VALUES (?, ?, ?, ?, ?, 'active', '{}', '{}', 1, 'feature/validation', ?, 'worker', ?)`
      )
      .run(
        'worker-session-mid',
        'Mid-node worker',
        '/tmp/session-workspace',
        new Date(0).toISOString(),
        new Date().toISOString(),
        JSON.stringify({ status: 'idle' }),
        JSON.stringify({ spaceId: ctx.spaceId, taskId: task.id })
      );
    const interrupted: string[] = [];
    const handlers = makeValidationTool({
      callerSessionId: 'worker-session-mid',
      interruptBySessionId: async (sessionId: string) => {
        interrupted.push(sessionId);
      },
    });

    const result = await handlers.complete_validation_task({
      task_id: task.id,
      validation_outcome: 'validated; peers should stand down',
    });
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.success).toBe(true);
    expect(parsed.task.status).toBe('done');

    const executionBySession = new Map(
      ctx.nodeExecutionRepo.listByWorkflowRun(task.workflowRunId!).map((e) => [e.agentSessionId, e])
    );
    // The peer is quiesced and interrupted...
    expect(executionBySession.get('peer-session')?.status).toBe('idle');
    expect(interrupted).toEqual(['peer-session']);
    // ...the caller's own execution is spared (mid-tool-call)...
    expect(executionBySession.get('worker-session-mid')?.status).toBe('in_progress');
    // ...and cross-node executions are left for the runtime sweep.
    expect(executionBySession.get('other-session')?.status).toBe('in_progress');
  });

  test('an external (execution-less) completion quiesces every active run worker', async () => {
    // A coordinator/long-horizon/ad-hoc caller has no node execution in the
    // run, so no source node is recorded and the reconciliation sweep's
    // endNodeId fallback would spare the entire end node — workers that never
    // submitted this verdict would survive in_progress. The tool quiesces
    // every active execution of the run instead (the caller's session is not
    // among them, so there is nothing to spare).
    await ctx.spaceManager.updateSpace(ctx.spaceId, { autonomyLevel: 5 });
    const task = createWorkflowTask(5, { status: 'in_progress' });
    ctx.nodeExecutionRepo.create({
      workflowRunId: task.workflowRunId!,
      workflowNodeId: 'node-review',
      agentName: 'Review',
      agentId: ctx.agentId,
      status: 'in_progress',
      agentSessionId: 'end-node-session',
    });
    ctx.nodeExecutionRepo.create({
      workflowRunId: task.workflowRunId!,
      workflowNodeId: 'node-mid-worker',
      agentName: 'Worker',
      agentId: ctx.agentId,
      status: 'in_progress',
      agentSessionId: 'mid-node-session',
    });
    const interrupted: string[] = [];
    const handlers = makeValidationTool({
      interruptBySessionId: async (sessionId: string) => {
        interrupted.push(sessionId);
      },
    });

    const result = await handlers.complete_validation_task({
      task_id: task.id,
      validation_outcome: 'coordinator completed externally',
    });
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.success).toBe(true);
    expect(parsed.task.status).toBe('done');

    const executions = ctx.nodeExecutionRepo.listByWorkflowRun(task.workflowRunId!);
    expect(executions.map((e) => e.status)).toEqual(['idle', 'idle']);
    expect(interrupted.sort()).toEqual(['end-node-session', 'mid-node-session']);
  });

  test('skips the worker sweep when the task is reopened during post-commit work', async () => {
    // setTaskStatus commits `done` BEFORE awaiting its post-commit cascade,
    // so a concurrent reopen (recoverWorkflowBackedTask / message-driven
    // revival) can restore the task and restart executions while the
    // returned snapshot still says done. The sweep rereads the CURRENT task
    // row and refuses to idle/interrupt the newly recovered workers.
    await ctx.spaceManager.updateSpace(ctx.spaceId, { autonomyLevel: 5 });
    const task = createWorkflowTask(5, { status: 'in_progress' });
    ctx.nodeExecutionRepo.create({
      workflowRunId: task.workflowRunId!,
      workflowNodeId: 'node-review',
      agentName: 'Review',
      agentId: ctx.agentId,
      status: 'in_progress',
      agentSessionId: 'recovered-worker',
    });
    const interrupted: string[] = [];
    const originalSetStatus = ctx.taskManager.setTaskStatus.bind(ctx.taskManager);
    const setStatusSpy = spyOn(ctx.taskManager, 'setTaskStatus').mockImplementation(
      async (...callArgs: Parameters<typeof originalSetStatus>) => {
        const result = await originalSetStatus(...callArgs);
        // Reopen lands inside setTaskStatus's post-commit tail — after the
        // done commit, before the handler regains control.
        ctx.taskRepo.updateTask(task.id, { status: 'in_progress', result: null });
        return result;
      }
    );
    const handlers = makeValidationTool({
      interruptBySessionId: async (sessionId: string) => {
        interrupted.push(sessionId);
      },
    });

    try {
      const result = await handlers.complete_validation_task({
        task_id: task.id,
        validation_outcome: 'completed, then reopened concurrently',
      });
      const parsed = JSON.parse(result.content[0].text);
      expect(parsed.success).toBe(true);

      // The recovered worker survives: never idled, never interrupted.
      expect(interrupted).toEqual([]);
      const execution = ctx.nodeExecutionRepo
        .listByWorkflowRun(task.workflowRunId!)
        .find((e) => e.agentSessionId === 'recovered-worker');
      expect(execution?.status).toBe('in_progress');
    } finally {
      setStatusSpy.mockRestore();
    }
  });

  test('rejects a task whose run references a workflow definition that cannot be resolved', async () => {
    // Imported/legacy shape: the run's workflow row is gone. Completing the
    // task would strand the run in_progress forever — rehydration cannot
    // register executorMeta for it and processRunTick returns before
    // completion handling. Treat "no resolvable definition" as refuse,
    // not as "no hooks / no routes".
    await ctx.spaceManager.updateSpace(ctx.spaceId, { autonomyLevel: 5 });
    const task = createWorkflowTask(5, { status: 'in_progress' });
    ctx.nodeExecutionRepo.create({
      workflowRunId: task.workflowRunId!,
      workflowNodeId: 'node-review',
      agentName: 'Review',
      agentId: ctx.agentId,
      status: 'idle',
    });
    // The schema's FKs make a genuinely definition-less run hard to produce
    // via normal writes (deleting a workflow cascades its runs); the guard's
    // branch is what matters, so drive getWorkflowForRun to the null the
    // imported/corrupt-payload shape produces.
    const workflowSpy = spyOn(ctx.workflowManager, 'getWorkflowForRun').mockReturnValue(null);
    let parsed: { success: boolean; error?: string };
    try {
      parsed = JSON.parse(
        (
          await makeValidationTool().complete_validation_task({
            task_id: task.id,
            validation_outcome: 'validated',
          })
        ).content[0].text
      );
    } finally {
      workflowSpy.mockRestore();
    }

    expect(parsed.success).toBe(false);
    expect(parsed.error).toContain('workflow definition cannot be resolved');
    expect(ctx.taskRepo.getTask(task.id)?.status).toBe('in_progress');
  });

  test('rejects a task whose workflow run belongs to a different space', async () => {
    // Imported/malformed shape: the task's space check passes, but its
    // workflowRunId points at a run owned by another space. Completing it
    // (and sweeping that run's executions) from this space would mutate a
    // foreign lifecycle. The foreign run lives in the SAME database (the
    // tasks→runs FK requires it) but under a different space row.
    await ctx.spaceManager.updateSpace(ctx.spaceId, { autonomyLevel: 5 });
    const foreignSpaceId = `space-foreign-${Math.random().toString(36).slice(2, 8)}`;
    ctx.db
      .prepare(
        `INSERT INTO spaces (id, workspace_path, name, description, background_context, instructions,
         allowed_models, session_ids, slug, status, created_at, updated_at)
         VALUES (?, '/tmp/foreign-ws', ?, '', '', '', '[]', '[]', ?, 'active', ?, ?)`
      )
      .run(foreignSpaceId, `Space ${foreignSpaceId}`, foreignSpaceId, Date.now(), Date.now());
    const nodeId = `node-${Math.random().toString(36).slice(2)}`;
    const foreignWorkflow = ctx.workflowManager.createWorkflow({
      spaceId: foreignSpaceId,
      name: `Foreign workflow ${nodeId.slice(-6)}`,
      description: '',
      nodes: [{ id: nodeId, name: 'Review', agentId: ctx.agentId }],
      transitions: [],
      startNodeId: nodeId,
      endNodeId: nodeId,
      rules: [],
      completionAutonomyLevel: 5,
    });
    const foreignRun = ctx.workflowRunRepo.createRun({
      spaceId: foreignSpaceId,
      workflowId: foreignWorkflow.id,
      title: 'Foreign run',
      description: '',
    });
    ctx.workflowRunRepo.updateRun(foreignRun.id, { status: 'in_progress' });

    // Local task (this space) malformed to point at the foreign run.
    const task = await createTask('in_progress');
    ctx.taskRepo.updateTask(task, { workflowRunId: foreignRun.id });

    // Ownership is validated BEFORE any foreign policy is consulted: the
    // PR resolver must not even be called for the foreign run (its workflow's
    // completionAutonomyLevel is likewise never read — the reject happens
    // ahead of the autonomy gate).
    let resolverCalls = 0;
    const result = await makeValidationTool({
      resolvePrimaryLinkUrl: () => {
        resolverCalls += 1;
        return '';
      },
    }).complete_validation_task({
      task_id: task,
      validation_outcome: 'should be refused',
    });
    const parsed = JSON.parse(result.content[0].text);

    expect(parsed.success).toBe(false);
    expect(parsed.error).toContain('different space');
    expect(resolverCalls).toBe(0);
    expect(ctx.taskRepo.getTask(task)?.status).toBe('in_progress');
  });

  test('rejects a workflow-backed task whose workflow declares a post-approval route', async () => {
    // A direct done would silently skip the route: the tick loop treats an
    // already-done task as resolved and never calls dispatchPostApproval.
    // Route-declaring workflows must close via submit_for_approval so the
    // router fires.
    await ctx.spaceManager.updateSpace(ctx.spaceId, { autonomyLevel: 5 });
    const nodeId = `node-${Math.random().toString(36).slice(2)}`;
    const workflow = ctx.workflowManager.createWorkflow({
      spaceId: ctx.spaceId,
      name: 'Publish-gated workflow',
      description: '',
      nodes: [{ id: nodeId, name: 'Review', agentId: ctx.agentId }],
      transitions: [],
      startNodeId: nodeId,
      endNodeId: nodeId,
      rules: [],
      completionAutonomyLevel: 5,
      postApproval: { targetAgent: 'Review', instructions: 'Publish it.' },
    });
    const run = ctx.workflowRunRepo.createRun({
      spaceId: ctx.spaceId,
      workflowId: workflow.id,
      title: 'Publish run',
      description: '',
    });
    ctx.workflowRunRepo.updateRun(run.id, { status: 'in_progress' });
    const task = ctx.taskRepo.createTask({
      spaceId: ctx.spaceId,
      title: 'Publish task',
      description: '',
      status: 'in_progress',
      workflowRunId: run.id,
    });
    ctx.nodeExecutionRepo.create({
      workflowRunId: run.id,
      workflowNodeId: nodeId,
      agentName: 'Review',
      agentId: ctx.agentId,
      status: 'idle',
    });

    const result = await makeValidationTool().complete_validation_task({
      task_id: task.id,
      validation_outcome: 'validated',
    });
    const parsed = JSON.parse(result.content[0].text);

    expect(parsed.success).toBe(false);
    expect(parsed.error).toContain('post-approval route');
    expect(parsed.error).toContain('submit_for_approval');
    expect(ctx.taskRepo.getTask(task.id)?.status).toBe('in_progress');
  });

  test('rejects a non-canonical duplicate task of a multi-task run', async () => {
    // Imported/legacy runs can temporarily carry duplicates. The tick loop
    // picks the canonical task and archives every duplicate, so completing a
    // duplicate here would be discarded while its side effects (evidence
    // capture, dependent unblocking) persisted. The guard applies the tick's
    // exact selection rule (pickCanonicalRunTask).
    await ctx.spaceManager.updateSpace(ctx.spaceId, { autonomyLevel: 5 });
    // Seed the legacy duplicate FIRST so it holds the lower task number —
    // that makes it canonical once attached to the target's run.
    const legacyDup = ctx.taskRepo.createTask({
      spaceId: ctx.spaceId,
      title: 'Legacy per-node task',
      description: '',
      status: 'in_progress',
    });
    const task = createWorkflowTask(5, { status: 'in_progress' });
    expect(task.taskNumber).toBeGreaterThan(legacyDup.taskNumber);
    ctx.taskRepo.updateTask(legacyDup.id, { workflowRunId: task.workflowRunId });
    ctx.nodeExecutionRepo.create({
      workflowRunId: task.workflowRunId!,
      workflowNodeId: 'node-review',
      agentName: 'Review',
      agentId: ctx.agentId,
      status: 'idle',
    });

    // Completing the NON-canonical task is rejected.
    const denied = JSON.parse(
      (
        await makeValidationTool().complete_validation_task({
          task_id: task.id,
          validation_outcome: 'should be refused',
        })
      ).content[0].text
    );
    expect(denied.success).toBe(false);
    expect(denied.error).toContain('not the canonical task');
    expect(ctx.taskRepo.getTask(task.id)?.status).toBe('in_progress');

    // Completing the canonical task still works.
    const allowed = JSON.parse(
      (
        await makeValidationTool().complete_validation_task({
          task_id: legacyDup.id,
          validation_outcome: 'canonical task validated',
        })
      ).content[0].text
    );
    expect(allowed.success).toBe(true);
    expect(ctx.taskRepo.getTask(legacyDup.id)?.status).toBe('done');
  });

  test('rejects when space autonomy is below workflow completionAutonomyLevel', async () => {
    await ctx.spaceManager.updateSpace(ctx.spaceId, { autonomyLevel: 3 });
    const task = createWorkflowTask(5);

    const result = await makeValidationTool().complete_validation_task({
      task_id: task.id,
      validation_outcome: 'validated',
    });
    const parsed = JSON.parse(result.content[0].text);

    expect(parsed.success).toBe(false);
    expect(parsed.error).toContain('complete_validation_task not permitted');
    expect(parsed.error).toContain('space autonomy level 3 < workflow completionAutonomyLevel 5');
    // Task is unchanged.
    expect(ctx.taskRepo.getTask(task.id)?.status).toBe('in_progress');
  });

  test('allows completion when space autonomy meets workflow completionAutonomyLevel', async () => {
    await ctx.spaceManager.updateSpace(ctx.spaceId, { autonomyLevel: 5 });
    const task = createWorkflowTask(5);
    ctx.nodeExecutionRepo.create({
      workflowRunId: task.workflowRunId!,
      workflowNodeId: 'node-review',
      agentName: 'Review',
      agentId: ctx.agentId,
      status: 'idle',
    });

    const result = await makeValidationTool().complete_validation_task({
      task_id: task.id,
      validation_outcome: 'Validation passed; no code change required.',
    });
    const parsed = JSON.parse(result.content[0].text);

    expect(parsed.success).toBe(true);
    expect(parsed.task.status).toBe('done');
    expect(parsed.task.result).toBe('Validation passed; no code change required.');
  });

  test('no agent autonomy ceiling applies on the worker-only surface', async () => {
    // The surface is node-agent-exclusive: its callers are workflow workers,
    // which have no long-horizon autonomy identity, so the SPACE level is
    // the effective level and no per-agent ceiling machinery exists in the
    // handler. A space at the required level completes even though a
    // long-horizon agent in the same space is capped below it (the cap has
    // no path into this tool).
    await ctx.spaceManager.updateSpace(ctx.spaceId, { autonomyLevel: 5 });
    const caller = ctx.longHorizonAgentRepo.create({
      spaceId: ctx.spaceId,
      handle: 'capped-forge-agent',
      displayName: 'Capped Forge Agent',
      autonomyLevel: 3,
    });
    expect(ctx.longHorizonAgentRepo.getById(caller.id)?.autonomyLevel).toBe(3);
    const task = createWorkflowTask(5);
    ctx.nodeExecutionRepo.create({
      workflowRunId: task.workflowRunId!,
      workflowNodeId: 'node-review',
      agentName: 'Review',
      agentId: ctx.agentId,
      status: 'idle',
    });

    const result = await makeValidationTool().complete_validation_task({
      task_id: task.id,
      validation_outcome: 'worker completes at the space level',
    });
    const parsed = JSON.parse(result.content[0].text);

    expect(parsed.success).toBe(true);
    expect(parsed.task.status).toBe('done');
  });

  test('space-level autonomy rejection also writes an audit entry', async () => {
    await ctx.spaceManager.updateSpace(ctx.spaceId, { autonomyLevel: 3 });
    const task = createWorkflowTask(5);
    const auditRepo = new McpAuditLogRepository(ctx.db);

    const result = await makeValidationTool({
      audit: (params, targetTaskId) =>
        auditRepo.createEntry({
          toolName: 'complete_validation_task',
          paramsSummary: JSON.stringify(params),
          spaceId: ctx.spaceId,
          taskId: targetTaskId ?? task.id,
        }),
    }).complete_validation_task({
      task_id: task.id,
      validation_outcome: 'validated',
    });
    const parsed = JSON.parse(result.content[0].text);

    expect(parsed.success).toBe(false);
    expect(parsed.error).toContain('space autonomy level 3');
    expect(ctx.taskRepo.getTask(task.id)?.status).toBe('in_progress');

    const entries = auditRepo.listByTask(task.id);
    const entry = entries.find((e) => e.toolName === 'complete_validation_task');
    expect(entry).toBeDefined();
    const details = JSON.parse(entry!.paramsSummary) as Record<string, unknown>;
    expect(details.blocked).toBe(true);
    expect(details.reason).toBe('space_autonomy');
    expect(details.spaceLevel).toBe(3);
    expect(details.required).toBe(5);
  });

  test('rejects a task whose workflow run already has a PR', async () => {
    await ctx.spaceManager.updateSpace(ctx.spaceId, { autonomyLevel: 5 });
    const task = createWorkflowTask(5, { status: 'review' });
    // The run records a primary link (PR) — the task is PR-bound.
    const result = await makeValidationTool({
      resolvePrimaryLinkUrl: () => 'https://github.com/owner/repo/pull/123',
    }).complete_validation_task({
      task_id: task.id,
      validation_outcome: 'should not reach here',
    });

    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.success).toBe(false);
    expect(parsed.error).toContain('has a PR');
    expect(parsed.error).toContain('https://github.com/owner/repo/pull/123');
    expect(ctx.taskRepo.getTask(task.id)?.status).toBe('review');
  });

  test('rejects tasks in ineligible statuses', async () => {
    await ctx.spaceManager.updateSpace(ctx.spaceId, { autonomyLevel: 5 });
    const created = await ctx.taskManager.createTask({
      title: 'open task',
      description: 'not started',
    });
    const taskId = created.id;
    // Newly created task is `open`.
    expect(ctx.taskRepo.getTask(taskId)?.status).toBe('open');

    const result = await makeValidationTool().complete_validation_task({
      task_id: taskId,
      validation_outcome: 'validated',
    });
    const parsed = JSON.parse(result.content[0].text);

    expect(parsed.success).toBe(false);
    expect(parsed.error).toContain("'open' status");
  });

  test('rejects a review task awaiting human completion approval (task_completion checkpoint)', async () => {
    // `submit_for_approval` parks a task in review under an explicit promise
    // that a HUMAN approves or rejects it. Closing it directly to done here
    // would clear the pending checkpoint and bypass that gate — the exact
    // bypass the review path exists to prevent. The human flow
    // (approve_pending_completion) owns those tasks.
    const taskId = await createTask('review');
    ctx.taskRepo.updateTask(taskId, {
      pendingCheckpointType: 'task_completion',
      pendingCompletionReason: 'needs human approval',
    });

    const result = await makeValidationTool().complete_validation_task({
      task_id: taskId,
      validation_outcome: 'should be refused',
    });
    const parsed = JSON.parse(result.content[0].text);

    expect(parsed.success).toBe(false);
    expect(parsed.error).toContain('awaiting human completion approval');
    expect(parsed.error).toContain('approve_pending_completion');
    // The checkpoint promise survives — the human still owns the decision.
    const after = ctx.taskRepo.getTask(taskId);
    expect(after?.status).toBe('review');
    expect(after?.pendingCheckpointType).toBe('task_completion');
  });

  test('rejects an empty validation outcome', async () => {
    const taskId = await createTask('in_progress');

    const result = await makeValidationTool().complete_validation_task({
      task_id: taskId,
      validation_outcome: '   ',
    });
    const parsed = JSON.parse(result.content[0].text);

    expect(parsed.success).toBe(false);
    expect(parsed.error).toContain('validation_outcome is required');
    expect(ctx.taskRepo.getTask(taskId)?.status).toBe('in_progress');
  });

  test('rejects a task that does not belong to this space', async () => {
    const taskId = await createTask('in_progress');

    const result = await makeValidationTool({ spaceId: 'other-space' }).complete_validation_task({
      task_id: taskId,
      validation_outcome: 'validated',
    });
    const parsed = JSON.parse(result.content[0].text);

    expect(parsed.success).toBe(false);
    expect(parsed.error).toContain('does not belong');
  });

  test('rejects an unknown task id', async () => {
    const result = await makeValidationTool().complete_validation_task({
      task_id: 'nonexistent-task',
      validation_outcome: 'validated',
    });
    const parsed = JSON.parse(result.content[0].text);

    expect(parsed.success).toBe(false);
    expect(parsed.error).toContain('Task not found');
  });

  test('worker sessions may only complete their own task; unresolvable bindings fail closed', async () => {
    // Two no-PR in_progress tasks; the caller is a worker session spawned for
    // task A (session_context.taskId bound). It must not complete task B.
    const seedBoundSession = (id: string, context: Record<string, unknown>) => {
      ctx.db
        .prepare(
          `INSERT INTO sessions (
            id, title, workspace_path, created_at, last_active_at, status, config, metadata,
            is_worktree, git_branch, processing_state, type, session_context
          ) VALUES (?, ?, ?, ?, ?, 'active', '{}', '{}', 1, 'feature/validation', ?, 'worker', ?)`
        )
        .run(
          id,
          `Session ${id}`,
          '/tmp/session-workspace',
          new Date(0).toISOString(),
          new Date().toISOString(),
          JSON.stringify({ status: 'idle' }),
          JSON.stringify({ spaceId: ctx.spaceId, ...context })
        );
    };
    await ctx.spaceManager.updateSpace(ctx.spaceId, { autonomyLevel: 5 });
    const taskA = await createTask('in_progress');
    const taskB = await createTask('in_progress');
    seedBoundSession('worker-session-a', { taskId: taskA });

    const denied = JSON.parse(
      (
        await makeValidationTool({ callerSessionId: 'worker-session-a' }).complete_validation_task({
          task_id: taskB,
          validation_outcome: 'should be refused',
        })
      ).content[0].text
    );
    expect(denied.success).toBe(false);
    expect(denied.error).toContain('own task');
    expect(ctx.taskRepo.getTask(taskB)?.status).toBe('in_progress');

    // Same worker completing ITS OWN task is fine.
    const allowed = JSON.parse(
      (
        await makeValidationTool({ callerSessionId: 'worker-session-a' }).complete_validation_task({
          task_id: taskA,
          validation_outcome: 'own task validated',
        })
      ).content[0].text
    );
    expect(allowed.success).toBe(true);
    expect(allowed.task.status).toBe('done');

    // The surface is node-agent-exclusive: every legitimate caller is a
    // task-bound worker, so a session whose binding CANNOT be resolved
    // (here: no session_context.taskId) fails closed rather than being
    // treated as a privileged unbound caller.
    seedBoundSession('unbound-session', {});
    const unbound = JSON.parse(
      (
        await makeValidationTool({ callerSessionId: 'unbound-session' }).complete_validation_task({
          task_id: taskB,
          validation_outcome: 'should be refused',
        })
      ).content[0].text
    );
    expect(unbound.success).toBe(false);
    expect(unbound.error).toContain('task binding cannot be resolved');
    expect(ctx.taskRepo.getTask(taskB)?.status).toBe('in_progress');
  });

  test('fails closed when the caller session row is missing, foreign, or malformed', async () => {
    // The binding lookup returns "unresolvable" for every degenerate shape —
    // no session row at all, a row scoped to another space, or context JSON
    // that does not parse. On this node-agent-exclusive surface each must
    // reject; none may degrade into the external-caller quiesce-ALL shape.
    await ctx.spaceManager.updateSpace(ctx.spaceId, { autonomyLevel: 5 });
    const task = await createTask('in_progress');

    // No session row at all.
    const missing = JSON.parse(
      (
        await makeValidationTool({ callerSessionId: 'ghost-session' }).complete_validation_task({
          task_id: task,
          validation_outcome: 'should be refused',
        })
      ).content[0].text
    );
    expect(missing.success).toBe(false);
    expect(missing.error).toContain('task binding cannot be resolved');

    // A session row scoped to ANOTHER space (space-scoped lookup misses it).
    ctx.db
      .prepare(
        `INSERT INTO sessions (
            id, title, workspace_path, created_at, last_active_at, status, config, metadata,
            is_worktree, git_branch, processing_state, type, session_context
          ) VALUES (?, ?, ?, ?, ?, 'active', '{}', '{}', 0, NULL, ?, 'worker', ?)`
      )
      .run(
        'foreign-space-session',
        'Foreign worker',
        '/tmp/ws',
        new Date(0).toISOString(),
        new Date().toISOString(),
        JSON.stringify({ status: 'idle' }),
        JSON.stringify({ spaceId: 'some-other-space', taskId: task })
      );
    const foreign = JSON.parse(
      (
        await makeValidationTool({
          callerSessionId: 'foreign-space-session',
        }).complete_validation_task({
          task_id: task,
          validation_outcome: 'should be refused',
        })
      ).content[0].text
    );
    expect(foreign.success).toBe(false);
    expect(foreign.error).toContain('task binding cannot be resolved');

    // Malformed context JSON.
    ctx.db
      .prepare(
        `INSERT INTO sessions (
            id, title, workspace_path, created_at, last_active_at, status, config, metadata,
            is_worktree, git_branch, processing_state, type, session_context
          ) VALUES (?, ?, ?, ?, ?, 'active', '{}', '{}', 0, NULL, ?, 'worker', ?)`
      )
      .run(
        'malformed-session',
        'Malformed worker',
        '/tmp/ws',
        new Date(0).toISOString(),
        new Date().toISOString(),
        JSON.stringify({ status: 'idle' }),
        '{not json'
      );
    const malformed = JSON.parse(
      (
        await makeValidationTool({
          callerSessionId: 'malformed-session',
        }).complete_validation_task({
          task_id: task,
          validation_outcome: 'should be refused',
        })
      ).content[0].text
    );
    expect(malformed.success).toBe(false);
    expect(malformed.error).toContain('task binding cannot be resolved');
    // The task was never touched by any of the three attempts.
    expect(ctx.taskRepo.getTask(task)?.status).toBe('in_progress');
  });

  test('rejects when the run PR state cannot be checked (indeterminate read)', async () => {
    // The no-PR gate is three-state: '' = definitively no PR, url = PR-bound,
    // null = could not check (transient hook-state/artifact read failure, or
    // no domain profile wired). null must fail closed — treating it as "no
    // PR" would let a PR-bound run bypass the review/merge path.
    await ctx.spaceManager.updateSpace(ctx.spaceId, { autonomyLevel: 5 });
    const task = createWorkflowTask(5, { status: 'in_progress' });
    ctx.nodeExecutionRepo.create({
      workflowRunId: task.workflowRunId!,
      workflowNodeId: 'node-review',
      agentName: 'Review',
      agentId: ctx.agentId,
      status: 'idle',
    });

    const result = await makeValidationTool({
      resolvePrimaryLinkUrl: () => null,
    }).complete_validation_task({
      task_id: task.id,
      validation_outcome: 'should be refused',
    });
    const parsed = JSON.parse(result.content[0].text);

    expect(parsed.success).toBe(false);
    expect(parsed.error).toContain('could not be checked for a PR');
    expect(parsed.error).toContain('refusing validation-only completion');
    expect(ctx.taskRepo.getTask(task.id)?.status).toBe('in_progress');
  });

  test('terminal precondition refuses an indeterminate PR recheck', async () => {
    // The early guard read the run as PR-less, but the reread at the
    // terminal write cannot check — the write must refuse rather than
    // commit a validation-only done against an unverifiable PR state.
    await ctx.spaceManager.updateSpace(ctx.spaceId, { autonomyLevel: 5 });
    const task = createWorkflowTask(5, { status: 'in_progress' });
    ctx.nodeExecutionRepo.create({
      workflowRunId: task.workflowRunId!,
      workflowNodeId: 'node-review',
      agentName: 'Review',
      agentId: ctx.agentId,
      status: 'idle',
    });
    let reads = 0;
    const result = await makeValidationTool({
      resolvePrimaryLinkUrl: () => {
        reads += 1;
        // First read: the early guard sees a definitive no-PR. Second read:
        // the terminal precondition's reread fails to check.
        return reads === 1 ? '' : null;
      },
    }).complete_validation_task({
      task_id: task.id,
      validation_outcome: 'should be refused at the write',
    });
    const parsed = JSON.parse(result.content[0].text);

    expect(parsed.success).toBe(false);
    expect(parsed.error).toContain('could not be rechecked for a PR');
    expect(ctx.taskRepo.getTask(task.id)?.status).toBe('in_progress');
    expect(ctx.taskRepo.getTask(task.id)?.result).toBeNull();
  });

  test('the strict profile resolver distinguishes unreadable from no-PR', async () => {
    // CodingArtifactProfile.resolvePrimaryLinkUrlStrict backs the production
    // wiring: a failed artifact read with no url found must report
    // readable:false (the handler rejects), while the same failure with a PR
    // already found still reports the url — "PR-bound" is certain regardless
    // of the other source's failure.
    const throwingRepo = {
      listByRun: () => {
        throw new Error('artifact read failed');
      },
    } as unknown as WorkflowRunArtifactRepository;
    const profile = new CodingArtifactProfile({ db: ctx.db, artifactRepo: throwingRepo });

    const unreadable = profile.resolvePrimaryLinkUrlStrict('run-unreadable');
    expect(unreadable).toEqual({ url: '', readable: false });
    // The lenient method keeps its infra contract: degrade to ''.
    expect(profile.resolvePrimaryLinkUrl('run-unreadable')).toBe('');

    const okRepo = new WorkflowRunArtifactRepository(ctx.db);
    const readableProfile = new CodingArtifactProfile({ db: ctx.db, artifactRepo: okRepo });
    expect(readableProfile.resolvePrimaryLinkUrlStrict('run-none')).toEqual({
      url: '',
      readable: true,
    });
  });

  test('rejects a task-bound worker whose executions live on a previous run attachment', async () => {
    // `startWorkflowRun({parentTaskId})` re-attaches a task to a new run
    // while the OLD run's workers keep their session_context.taskId binding.
    // Such a stale worker must not complete the task: it is wrapped in the
    // spawn-time run's hook engine, and falling through to the
    // no-source/external shape would grant it the quiesce-ALL sweep over the
    // new run's workers. The guard rejects instead of granting external
    // semantics to a bound caller.
    await ctx.spaceManager.updateSpace(ctx.spaceId, { autonomyLevel: 5 });
    const task = createWorkflowTask(5, { status: 'in_progress' });
    // The current run's own worker (must stay untouched by the rejection).
    ctx.nodeExecutionRepo.create({
      workflowRunId: task.workflowRunId!,
      workflowNodeId: 'node-current',
      agentName: 'CurrentWorker',
      agentId: ctx.agentId,
      status: 'in_progress',
      agentSessionId: 'current-worker-session',
    });
    // A PREVIOUS run the task was once attached to, still carrying this
    // worker's execution.
    const prevNodeId = `node-prev-${Math.random().toString(36).slice(2, 8)}`;
    const prevWorkflow = ctx.workflowManager.createWorkflow({
      spaceId: ctx.spaceId,
      name: `Previous workflow ${prevNodeId.slice(-6)}`,
      description: '',
      nodes: [{ id: prevNodeId, name: 'Previous', agentId: ctx.agentId }],
      transitions: [],
      startNodeId: prevNodeId,
      endNodeId: prevNodeId,
      rules: [],
      completionAutonomyLevel: 5,
    });
    const prevRun = ctx.workflowRunRepo.createRun({
      spaceId: ctx.spaceId,
      workflowId: prevWorkflow.id,
      title: 'Previous run',
      description: '',
    });
    ctx.workflowRunRepo.updateRun(prevRun.id, { status: 'in_progress' });
    ctx.nodeExecutionRepo.create({
      workflowRunId: prevRun.id,
      workflowNodeId: prevNodeId,
      agentName: 'StaleWorker',
      agentId: ctx.agentId,
      status: 'in_progress',
      agentSessionId: 'stale-worker-session',
    });
    // The stale worker's session is bound to the task (its binding survives
    // the re-attachment) but has no execution in the CURRENT run.
    ctx.db
      .prepare(
        `INSERT INTO sessions (
            id, title, workspace_path, created_at, last_active_at, status, config, metadata,
            is_worktree, git_branch, processing_state, type, session_context
          ) VALUES (?, ?, '/tmp/ws', ?, ?, 'active', '{}', '{}', 0, NULL, ?, 'worker', ?)`
      )
      .run(
        'stale-worker-session',
        'Stale worker',
        new Date(0).toISOString(),
        new Date().toISOString(),
        JSON.stringify({ status: 'idle' }),
        JSON.stringify({ spaceId: ctx.spaceId, taskId: task.id })
      );

    const result = await makeValidationTool({
      callerSessionId: 'stale-worker-session',
    }).complete_validation_task({
      task_id: task.id,
      validation_outcome: 'should be refused',
    });
    const parsed = JSON.parse(result.content[0].text);

    expect(parsed.success).toBe(false);
    expect(parsed.error).toContain('re-attached to a different workflow run');
    expect(ctx.taskRepo.getTask(task.id)?.status).toBe('in_progress');
    // Neither run's workers were swept.
    const currentExec = ctx.nodeExecutionRepo
      .listByWorkflowRun(task.workflowRunId!)
      .find((e) => e.agentSessionId === 'current-worker-session');
    expect(currentExec?.status).toBe('in_progress');
    const staleExec = ctx.nodeExecutionRepo
      .listByWorkflowRun(prevRun.id)
      .find((e) => e.agentSessionId === 'stale-worker-session');
    expect(staleExec?.status).toBe('in_progress');
  });

  test('records the completing worker’s node so reconciliation quiesce spares the caller', async () => {
    // A non-end-node worker completing its own workflow-backed task: the
    // completion must carry the caller's node (committed atomically with done
    // as the durable postApprovalSourceNodeId) so the tick loop's
    // sibling-quiesce — which resolves its exclusion as
    // postApprovalSourceNodeId ?? pending… ?? endNodeId — does not fall back to
    // endNodeId, interrupt the actual caller, and spare the unrelated end-node
    // worker. Callers with no node execution in the task's run
    // (coordinator/task-agent, or a worker from another run) leave the field
    // untouched.
    await ctx.spaceManager.updateSpace(ctx.spaceId, { autonomyLevel: 5 });
    const task = createWorkflowTask(5, { status: 'in_progress' });
    ctx.nodeExecutionRepo.create({
      workflowRunId: task.workflowRunId!,
      // Deliberately NOT the workflow's end node — the fallback this test guards.
      workflowNodeId: 'node-mid-worker',
      agentName: 'Worker',
      agentId: ctx.agentId,
      status: 'in_progress',
      agentSessionId: 'worker-session-mid',
    });
    ctx.db
      .prepare(
        `INSERT INTO sessions (
            id, title, workspace_path, created_at, last_active_at, status, config, metadata,
            is_worktree, git_branch, processing_state, type, session_context
          ) VALUES (?, ?, ?, ?, ?, 'active', '{}', '{}', 1, 'feature/validation', ?, 'worker', ?)`
      )
      .run(
        'worker-session-mid',
        'Mid-node worker',
        '/tmp/session-workspace',
        new Date(0).toISOString(),
        new Date().toISOString(),
        JSON.stringify({ status: 'idle' }),
        JSON.stringify({ spaceId: ctx.spaceId, taskId: task.id })
      );

    const result = await makeValidationTool({
      callerSessionId: 'worker-session-mid',
    }).complete_validation_task({
      task_id: task.id,
      validation_outcome: 'validated from a non-end node',
    });
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.success).toBe(true);
    expect(parsed.task.status).toBe('done');
    // The caller's node is recorded both on the row and in the returned task.
    expect(ctx.taskRepo.getTask(task.id)?.postApprovalSourceNodeId).toBe('node-mid-worker');
    expect(parsed.task.postApprovalSourceNodeId).toBe('node-mid-worker');

    // A caller whose session has NO execution in the task's run leaves the
    // field untouched (no fabrication, no cross-run stamping).
    const other = createWorkflowTask(5, { status: 'in_progress' });
    ctx.nodeExecutionRepo.create({
      workflowRunId: other.workflowRunId!,
      workflowNodeId: 'node-other',
      agentName: 'Review',
      agentId: ctx.agentId,
      status: 'idle',
    });
    const coordinator = JSON.parse(
      (
        await makeValidationTool().complete_validation_task({
          task_id: other.id,
          validation_outcome: 'coordinator completed; no node execution',
        })
      ).content[0].text
    );
    expect(coordinator.success).toBe(true);
    expect(ctx.taskRepo.getTask(other.id)?.postApprovalSourceNodeId).toBeNull();

    // The atomic stamp OVERRIDES the review→done review-exit clear: a worker
    // completing its own review-status task still records its node — proving
    // source and status commit in one UPDATE (no terminal-without-source
    // window even on the path that clears the field).
    const reviewTask = createWorkflowTask(5, { status: 'review' });
    ctx.nodeExecutionRepo.create({
      workflowRunId: reviewTask.workflowRunId!,
      workflowNodeId: 'node-mid-worker',
      agentName: 'Worker',
      agentId: ctx.agentId,
      status: 'in_progress',
      agentSessionId: 'worker-session-review',
    });
    // The caller-binding guard fail-closes without a resolvable session row.
    ctx.db
      .prepare(
        `INSERT INTO sessions (
            id, title, workspace_path, created_at, last_active_at, status, config, metadata,
            is_worktree, git_branch, processing_state, type, session_context
          ) VALUES (?, ?, '/tmp/session-workspace', ?, ?, 'active', '{}', '{}', 0, NULL, ?, 'worker', ?)`
      )
      .run(
        'worker-session-review',
        'Review-status worker',
        new Date(0).toISOString(),
        new Date().toISOString(),
        JSON.stringify({ status: 'idle' }),
        JSON.stringify({ spaceId: ctx.spaceId, taskId: reviewTask.id })
      );
    const reviewed = JSON.parse(
      (
        await makeValidationTool({
          callerSessionId: 'worker-session-review',
        }).complete_validation_task({
          task_id: reviewTask.id,
          validation_outcome: 'validated from review by a mid-node worker',
        })
      ).content[0].text
    );
    expect(reviewed.success).toBe(true);
    expect(ctx.taskRepo.getTask(reviewTask.id)?.postApprovalSourceNodeId).toBe('node-mid-worker');
  });

  test('terminal precondition refuses a PR acquired during completion', async () => {
    // The early no-PR guard read the run as PR-less; a save_artifact between
    // that read and the terminal write records the run's primary link. The
    // precondition's recheck must refuse the write rather than complete a
    // PR-bound task through the validation-only path.
    await ctx.spaceManager.updateSpace(ctx.spaceId, { autonomyLevel: 5 });
    const task = createWorkflowTask(5, { status: 'in_progress' });
    ctx.nodeExecutionRepo.create({
      workflowRunId: task.workflowRunId!,
      workflowNodeId: 'node-review',
      agentName: 'Review',
      agentId: ctx.agentId,
      status: 'idle',
    });
    let reads = 0;
    const result = await makeValidationTool({
      resolvePrimaryLinkUrl: (runId) => {
        reads += 1;
        // First read (early guard): no PR. Second read (precondition
        // recheck): the PR landed mid-completion.
        if (reads === 1) return '';
        const artifact = ctx.taskRepo.listByWorkflowRun(runId);
        void artifact;
        return 'https://github.com/owner/repo/pull/999';
      },
    }).complete_validation_task({
      task_id: task.id,
      validation_outcome: 'should be refused at the write',
    });
    const parsed = JSON.parse(result.content[0].text);

    expect(parsed.success).toBe(false);
    expect(parsed.error).toContain('acquired a PR');
    expect(parsed.error).toContain('https://github.com/owner/repo/pull/999');
    expect(ctx.taskRepo.getTask(task.id)?.status).toBe('in_progress');
    expect(ctx.taskRepo.getTask(task.id)?.result).toBeNull();
  });

  test('allowedSourceStatuses refuses a mid-flight cancellation through the tool', async () => {
    // Handler-level exercise of the exact-status predicate: a user cancels
    // the task between the handler's eligibility check and setTaskStatus'
    // reread — cancelled → done is a VALID transition-matrix edge, so only
    // the allowedSourceStatuses condition (bound to the reread state inside
    // the UPDATE) keeps the cancellation from being overwritten.
    await ctx.spaceManager.updateSpace(ctx.spaceId, { autonomyLevel: 5 });
    const task = createWorkflowTask(5, { status: 'in_progress' });
    ctx.nodeExecutionRepo.create({
      workflowRunId: task.workflowRunId!,
      workflowNodeId: 'node-review',
      agentName: 'Review',
      agentId: ctx.agentId,
      status: 'idle',
    });
    const originalGetTask = ctx.taskManager.getTask.bind(ctx.taskManager);
    let cancelled = false;
    const getTaskSpy = spyOn(ctx.taskManager, 'getTask').mockImplementation(
      async (taskId: string) => {
        if (taskId === task.id && !cancelled) {
          cancelled = true;
          ctx.taskRepo.updateTask(task.id, { status: 'cancelled' });
        }
        return originalGetTask(taskId);
      }
    );

    try {
      const result = await makeValidationTool().complete_validation_task({
        task_id: task.id,
        validation_outcome: 'should be refused',
      });
      const parsed = JSON.parse(result.content[0].text);

      expect(parsed.success).toBe(false);
      expect(parsed.error).toMatch(/concurrently to 'cancelled'|changed concurrently/);
      // The cancellation was NOT lost.
      expect(ctx.taskRepo.getTask(task.id)?.status).toBe('cancelled');
      expect(ctx.taskRepo.getTask(task.id)?.result).toBeNull();
    } finally {
      getTaskSpy.mockRestore();
    }
  });

  test('success path emits the task-updated event, audit entry, and goal terminal handling', async () => {
    // Side-effect parity with the sibling completion handlers: the success
    // path must emit `space.task.updated`, write the completion audit entry,
    // and hand the terminal task to the goal service.
    await ctx.spaceManager.updateSpace(ctx.spaceId, { autonomyLevel: 5 });
    const task = await createTask('in_progress');
    const published: Array<{ taskId: string; spaceId: string }> = [];
    const audited: Array<{ params: Record<string, unknown>; taskId?: string }> = [];
    const goalsHandled: string[] = [];

    const result = await makeValidationTool({
      internalEventBus: {
        publish: (async (topic: string, payload: { taskId: string; spaceId: string }) => {
          if (topic === 'space.task.updated') {
            published.push({ taskId: payload.taskId, spaceId: payload.spaceId });
          }
          return Promise.resolve();
        }) as CompleteValidationTaskHandlerDeps['internalEventBus'],
      },
      audit: (params, targetTaskId) => {
        audited.push({ params, taskId: targetTaskId });
      },
      goalService: {
        handleTaskTerminal: (taskId: string) => {
          goalsHandled.push(taskId);
        },
      } as unknown as CompleteValidationTaskHandlerDeps['goalService'],
    }).complete_validation_task({
      task_id: task,
      validation_outcome: 'validated; side effects fire',
    });
    const parsed = JSON.parse(result.content[0].text);

    expect(parsed.success).toBe(true);
    expect(published).toEqual([{ taskId: task, spaceId: ctx.spaceId }]);
    expect(audited).toHaveLength(1);
    expect(audited[0].taskId).toBe(task);
    expect(audited[0].params.completionMode).toBe('validation_only');
    expect(audited[0].params.previousStatus).toBe('in_progress');
    expect(goalsHandled).toEqual([task]);
  });

  test('rejects a task whose workflow run row is missing', async () => {
    // Imported/malformed shape: the task row carries a workflowRunId that
    // resolves to no run. Previously every run-dependent guard was skipped
    // (`run && …` fail-open); the run is now fetched once up front and a
    // missing row refuses before any run policy is read.
    await ctx.spaceManager.updateSpace(ctx.spaceId, { autonomyLevel: 5 });
    await ctx.spaceManager.updateSpace(ctx.spaceId, { autonomyLevel: 5 });
    const task = createWorkflowTask(5, { status: 'in_progress' });
    // The tasks→runs FK makes a genuinely row-less runId unproducible via
    // normal writes (deleting a run detaches its tasks), so drive the
    // repository read to the null the imported/corrupt-payload shape
    // produces — the guard's branch is what matters.
    const runSpy = spyOn(ctx.workflowRunRepo, 'getRun').mockReturnValue(null);
    let parsed: { success: boolean; error?: string };
    try {
      parsed = JSON.parse(
        (
          await makeValidationTool().complete_validation_task({
            task_id: task.id,
            validation_outcome: 'should be refused',
          })
        ).content[0].text
      );
    } finally {
      runSpy.mockRestore();
    }

    expect(parsed.success).toBe(false);
    expect(parsed.error).toContain('cannot be resolved');
    expect(ctx.taskRepo.getTask(task.id)?.status).toBe('in_progress');
  });

  test('skips the worker sweep when the task re-attaches to a new run during the post-commit cascade', async () => {
    // setTaskStatus commits `done` BEFORE awaiting its post-commit cascade,
    // and `startWorkflowRun({parentTaskId})` can re-attach the task to a NEW
    // run during that await — status unchanged (done), so the sweep's
    // status gate alone cannot see it. Sweeping then would list the NEW
    // run's executions while excluding the OLD run's source node/execution,
    // idling workers just launched for it. The sweep is bound to the run
    // every guard evaluated against.
    await ctx.spaceManager.updateSpace(ctx.spaceId, { autonomyLevel: 5 });
    const task = createWorkflowTask(5, { status: 'in_progress' });
    ctx.nodeExecutionRepo.create({
      workflowRunId: task.workflowRunId!,
      workflowNodeId: 'node-mid-worker',
      agentName: 'Worker',
      agentId: ctx.agentId,
      status: 'in_progress',
      agentSessionId: 'reattach-worker-session',
    });
    ctx.db
      .prepare(
        `INSERT INTO sessions (
            id, title, workspace_path, created_at, last_active_at, status, config, metadata,
            is_worktree, git_branch, processing_state, type, session_context
          ) VALUES (?, ?, '/tmp/ws', ?, ?, 'active', '{}', '{}', 0, NULL, ?, 'worker', ?)`
      )
      .run(
        'reattach-worker-session',
        'Reattaching worker',
        new Date(0).toISOString(),
        new Date().toISOString(),
        JSON.stringify({ status: 'idle' }),
        JSON.stringify({ spaceId: ctx.spaceId, taskId: task.id })
      );
    // The new run carries a worker on the SAME node id as the old source —
    // without the run binding the sweep would quiesce it.
    const reattachWorkflow = ctx.workflowManager.createWorkflow({
      spaceId: ctx.spaceId,
      name: 'Reattach sweep workflow',
      description: '',
      nodes: [{ id: 'node-mid-worker', name: 'Worker', agentId: ctx.agentId }],
      transitions: [],
      startNodeId: 'node-mid-worker',
      endNodeId: 'node-mid-worker',
      rules: [],
      completionAutonomyLevel: 5,
    });
    const reattachRun = ctx.workflowRunRepo.createRun({
      spaceId: ctx.spaceId,
      workflowId: reattachWorkflow.id,
      title: 'Reattach sweep run',
      description: '',
    });
    ctx.workflowRunRepo.updateRun(reattachRun.id, { status: 'in_progress' });
    ctx.nodeExecutionRepo.create({
      workflowRunId: reattachRun.id,
      workflowNodeId: 'node-mid-worker',
      agentName: 'NewWorker',
      agentId: ctx.agentId,
      status: 'in_progress',
      agentSessionId: 'new-run-worker-session',
    });
    const interrupted: string[] = [];
    const originalSetStatus = ctx.taskManager.setTaskStatus.bind(ctx.taskManager);
    const setStatusSpy = spyOn(ctx.taskManager, 'setTaskStatus').mockImplementation(
      async (...callArgs: Parameters<typeof originalSetStatus>) => {
        const result = await originalSetStatus(...callArgs);
        // The re-attachment lands inside the post-commit cascade — after the
        // done commit, before the handler regains control. Status stays done.
        ctx.taskRepo.updateTask(task.id, { workflowRunId: reattachRun.id });
        return result;
      }
    );

    try {
      const result = await makeValidationTool({
        callerSessionId: 'reattach-worker-session',
        interruptBySessionId: async (sessionId: string) => {
          interrupted.push(sessionId);
        },
      }).complete_validation_task({
        task_id: task.id,
        validation_outcome: 'completed for the original run',
      });
      const parsed = JSON.parse(result.content[0].text);
      expect(parsed.success).toBe(true);
    } finally {
      setStatusSpy.mockRestore();
    }

    // The NEW run's worker is untouched: never idled, never interrupted.
    const newRunWorker = ctx.nodeExecutionRepo
      .listByWorkflowRun(reattachRun.id)
      .find((e) => e.agentSessionId === 'new-run-worker-session');
    expect(newRunWorker?.status).toBe('in_progress');
    expect(interrupted).toEqual([]);
  });

  test('terminal precondition refuses when the completing worker execution is recycled mid-flight', async () => {
    // The runtime's alive-stuck restart path clears an execution row's
    // agentSessionId and flips it to `pending` so the slot can be reused by
    // a replacement worker — WITHOUT changing the run association. When
    // that lands between the handler's source lookup and the terminal
    // write, this session is no longer the live worker of record; the
    // post-commit sweep's execution-id exclusion would then spare the
    // REUSED row and leave the replacement worker active on a done task.
    // The precondition requires the caller's execution to still be
    // in_progress and still bound to the caller's session.
    await ctx.spaceManager.updateSpace(ctx.spaceId, { autonomyLevel: 5 });
    const task = createWorkflowTask(5, { status: 'in_progress' });
    const recycledExec = ctx.nodeExecutionRepo.create({
      workflowRunId: task.workflowRunId!,
      workflowNodeId: 'node-recycled',
      agentName: 'Worker',
      agentId: ctx.agentId,
      status: 'in_progress',
      agentSessionId: 'recycled-worker-session',
    });
    ctx.db
      .prepare(
        `INSERT INTO sessions (
            id, title, workspace_path, created_at, last_active_at, status, config, metadata,
            is_worktree, git_branch, processing_state, type, session_context
          ) VALUES (?, ?, '/tmp/ws', ?, ?, 'active', '{}', '{}', 0, NULL, ?, 'worker', ?)`
      )
      .run(
        'recycled-worker-session',
        'Recycled worker',
        new Date(0).toISOString(),
        new Date().toISOString(),
        JSON.stringify({ status: 'idle' }),
        JSON.stringify({ spaceId: ctx.spaceId, taskId: task.id })
      );
    const originalGetTask = ctx.taskManager.getTask.bind(ctx.taskManager);
    let recycled = false;
    const getTaskSpy = spyOn(ctx.taskManager, 'getTask').mockImplementation(
      async (taskId: string) => {
        if (taskId === task.id && !recycled) {
          recycled = true;
          // The restart path recycles the caller's execution slot inside
          // setTaskStatus' reread, before the precondition runs.
          ctx.nodeExecutionRepo.update(recycledExec.id, {
            agentSessionId: null,
            status: 'pending',
          });
        }
        return originalGetTask(taskId);
      }
    );

    try {
      const result = await makeValidationTool({
        callerSessionId: 'recycled-worker-session',
      }).complete_validation_task({
        task_id: task.id,
        validation_outcome: 'should be refused',
      });
      const parsed = JSON.parse(result.content[0].text);

      expect(parsed.success).toBe(false);
      expect(parsed.error).toContain('recycled');
      expect(ctx.taskRepo.getTask(task.id)?.status).toBe('in_progress');
      expect(ctx.taskRepo.getTask(task.id)?.result).toBeNull();
    } finally {
      getTaskSpy.mockRestore();
    }
  });
});
