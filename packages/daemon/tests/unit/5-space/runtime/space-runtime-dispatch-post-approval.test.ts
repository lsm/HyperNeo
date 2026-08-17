/**
 * Regression coverage for SpaceRuntime.dispatchPostApproval (PR 2/5 review fixes).
 *
 * Drives the **full flow** through `dispatchPostApproval` (not just
 * `setTaskStatus`) to pin down two bugs the initial implementation had:
 *
 *   Bug 1 — `approvalReason` from `contextExtras` was silently dropped on the
 *   `review → approved` transition. `SpaceTaskManager.setTaskStatus` would then
 *   stamp `approvalReason: null`, overwriting whatever the caller had already
 *   written via `updateTask`.
 *
 *   Bug 2 — The no-route branch (`workflow.postApproval` absent → direct
 *   `approved → done`) bypassed `safeOnTaskUpdated`, leaving UI listeners in
 *   the dark until the next poll. Only the RPC path emitted (because
 *   `approvePendingCompletion` re-reads + emits after dispatch); the end-node
 *   tick path did not.
 *
 * These tests guard the fixes by:
 *   - Asserting `approvalReason` is persisted after `dispatchPostApproval`
 *     on the review → approved transition with a reason in `contextExtras`.
 *   - Asserting `onTaskUpdated` is invoked with a task in status `done` after
 *     a no-route dispatch (covers the end-node tick path that has no follow-up).
 */

import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { Database as BunDatabase } from '../../../../src/storage/sqlite-compat';
import { runMigrations } from '../../../../src/storage/schema/index.ts';
import { SpaceWorkflowRepository } from '../../../../src/storage/repositories/space-workflow-repository.ts';
import { SpaceWorkflowRunRepository } from '../../../../src/storage/repositories/space-workflow-run-repository.ts';
import { SpaceTaskRepository } from '../../../../src/storage/repositories/space-task-repository.ts';
import { SpaceAgentRepository } from '../../../../src/storage/repositories/space-agent-repository.ts';
import { NodeExecutionRepository } from '../../../../src/storage/repositories/node-execution-repository.ts';
import { SpaceAgentManager } from '../../../../src/lib/space/managers/space-agent-manager.ts';
import { SpaceWorkflowManager } from '../../../../src/lib/space/managers/space-workflow-manager.ts';
import { SpaceManager } from '../../../../src/lib/space/managers/space-manager.ts';
import { SpaceRuntime } from '../../../../src/lib/space/runtime/space-runtime.ts';
import type { SpaceRuntimeConfig } from '../../../../src/lib/space/runtime/space-runtime.ts';
import type { SpaceTask } from '@hyperneo/shared';

const SPACE_ID = 'space-dispatch-pa';

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

interface Ctx {
  db: BunDatabase;
  runtime: SpaceRuntime;
  taskRepo: SpaceTaskRepository;
  spaceManager: SpaceManager;
  workflowManager: SpaceWorkflowManager;
  workflowRunRepo: SpaceWorkflowRunRepository;
  emitted: Array<{ spaceId: string; task: SpaceTask }>;
  injected: string[];
}

function buildRuntime(): Ctx {
  const db = makeDb();
  const workflowRunRepo = new SpaceWorkflowRunRepository(db);
  const taskRepo = new SpaceTaskRepository(db);
  const nodeExecutionRepo = new NodeExecutionRepository(db);
  const agentRepo = new SpaceAgentRepository(db);
  const agentManager = new SpaceAgentManager(agentRepo);
  const workflowRepo = new SpaceWorkflowRepository(db);
  const workflowManager = new SpaceWorkflowManager(workflowRepo);
  const spaceManager = new SpaceManager(db);

  const emitted: Array<{ spaceId: string; task: SpaceTask }> = [];
  const injected: string[] = [];
  const config: SpaceRuntimeConfig = {
    db,
    spaceManager,
    spaceAgentManager: agentManager,
    spaceWorkflowManager: workflowManager,
    workflowRunRepo,
    taskRepo,
    nodeExecutionRepo,
    onTaskUpdated: async ({ spaceId, task }) => {
      emitted.push({ spaceId, task });
    },
    // Minimal Task Agent stub — only inline Task Agent post-approval routes
    // use injectIntoTaskAgent. The no-route tests below must not touch it.
    taskAgentManager: {
      injectIntoTaskAgent: async (_taskId, message) => {
        injected.push(message);
        return { injected: false };
      },
      spawnPostApprovalSubSession: async () => ({ sessionId: 'stub-session' }),
      isSessionAlive: () => false,
    } as unknown as NonNullable<SpaceRuntimeConfig['taskAgentManager']>,
  };

  const runtime = new SpaceRuntime(config);
  return {
    db,
    runtime,
    taskRepo,
    spaceManager,
    workflowManager,
    workflowRunRepo,
    emitted,
    injected,
  };
}

function seedReviewTask(taskRepo: SpaceTaskRepository): SpaceTask {
  // Start in 'in_progress' then transition to 'review' via the repo (setting
  // status directly bypasses the transition validator, which is fine for a
  // fixture — the runtime does NOT look at transition history).
  const t = taskRepo.createTask({
    spaceId: SPACE_ID,
    title: 'Ship it',
    description: '',
    status: 'in_progress',
  });
  const updated = taskRepo.updateTask(t.id, { status: 'review' });
  if (!updated) throw new Error('failed to seed review task');
  return updated;
}

describe('SpaceRuntime.dispatchPostApproval — end-to-end', () => {
  let ctx: Ctx;

  beforeEach(() => {
    ctx = buildRuntime();
  });
  afterEach(() => {
    try {
      ctx.db.close();
    } catch {
      /* ignore */
    }
  });

  // ---------------------------------------------------------------------------
  // Bug 1 regression
  // ---------------------------------------------------------------------------

  test('forwards approvalReason from contextExtras to setTaskStatus (review → approved)', async () => {
    const task = seedReviewTask(ctx.taskRepo);

    await ctx.runtime.dispatchPostApproval(task.id, 'human', {
      approvalReason: 'LGTM — ship it',
    });

    const final = ctx.taskRepo.getTask(task.id);
    expect(final?.status).toBe('done'); // no-route → closed
    expect(final?.approvalSource).toBe('human');
    // The critical assertion: reason survives the round-trip. Prior to the
    // fix it would be null because dispatchPostApproval silently dropped it.
    expect(final?.approvalReason).toBe('LGTM — ship it');
    expect(final?.approvedAt).toBeTypeOf('number');
  });

  test('undefined approvalReason leaves it null (no spurious stamp)', async () => {
    const task = seedReviewTask(ctx.taskRepo);

    await ctx.runtime.dispatchPostApproval(task.id, 'human', {});

    const final = ctx.taskRepo.getTask(task.id);
    expect(final?.approvalReason).toBeNull();
    expect(final?.approvalSource).toBe('human');
  });

  // ---------------------------------------------------------------------------
  // Bug 2 regression
  // ---------------------------------------------------------------------------

  test('emits onTaskUpdated with status=done after no-route dispatch', async () => {
    const task = seedReviewTask(ctx.taskRepo);

    await ctx.runtime.dispatchPostApproval(task.id, 'agent');

    // At least two emits expected: one for review → approved (step 1), one
    // for the post-router state (approved → done). The end-of-dispatch emit
    // is the critical one — without it the UI would not learn about the
    // closure until the next poll.
    const doneEmits = ctx.emitted.filter((e) => e.task.status === 'done');
    expect(doneEmits.length).toBeGreaterThanOrEqual(1);
    expect(doneEmits[doneEmits.length - 1].task.id).toBe(task.id);
  });

  test('already-approved task still fires post-dispatch emit on no-route', async () => {
    const t = ctx.taskRepo.createTask({
      spaceId: SPACE_ID,
      title: 'Already approved',
      description: '',
      status: 'in_progress',
    });
    ctx.taskRepo.updateTask(t.id, {
      status: 'approved',
      approvalSource: 'agent',
      approvedAt: Date.now(),
    });

    await ctx.runtime.dispatchPostApproval(t.id, 'agent');

    const final = ctx.taskRepo.getTask(t.id);
    expect(final?.status).toBe('done');
    // Should still emit even though the transition step was skipped.
    expect(ctx.emitted.some((e) => e.task.id === t.id && e.task.status === 'done')).toBe(true);
  });

  test('no-route dispatch does not inject informational Task Agent awareness', async () => {
    const task = seedReviewTask(ctx.taskRepo);

    await ctx.runtime.dispatchPostApproval(task.id, 'agent');

    expect(ctx.taskRepo.getTask(task.id)?.status).toBe('done');
    expect(ctx.injected).toHaveLength(0);
  });

  // ---------------------------------------------------------------------------
  // Stopped/paused-space hold — post-approval work is NEW work, so the
  // dispatch is held; but the approval DECISION commits first (Layer C), the
  // deferral is durably recorded as postApprovalBlockedReason by the runtime
  // itself (banner exists regardless of caller), and the typed
  // PostApprovalDeferredError is what tick sites swallow and human callers
  // report without re-stamping. space.start/space.resume re-drives it.
  // ---------------------------------------------------------------------------

  test('stopped space: approval commits, deferral stamped + thrown typed', async () => {
    const task = seedReviewTask(ctx.taskRepo);
    ctx.db.prepare(`UPDATE spaces SET stopped = 1 WHERE id = ?`).run(SPACE_ID);

    let caught: unknown;
    try {
      await ctx.runtime.dispatchPostApproval(task.id, 'human', {});
    } catch (err) {
      caught = err;
    }
    expect((caught as Error).name).toBe('PostApprovalDeferredError');

    // Layer C: the human decision is durable — never swallowed by the hold.
    const final = ctx.taskRepo.getTask(task.id);
    expect(final?.status).toBe('approved');
    expect(final?.approvalSource).toBe('human');
    // The pending-completion banner fields are cleared (the approval is
    // recorded; only the post-approval WORK is deferred).
    expect(final?.pendingCheckpointType).toBeNull();
    // The deferral is durably recorded by the RUNTIME (not left to callers) —
    // tick call sites have no Layer C catch, so this stamp is the banner.
    expect(final?.postApprovalBlockedReason).toMatch(/stopped; post-approval dispatch deferred/);
    expect(final?.postApprovalBlockedReason).toMatch(/re-runs automatically on space\.start/);
    // No post-approval work started.
    expect(ctx.injected).toEqual([]);
  });

  test('paused space: same contract — approval commits, dispatch defers', async () => {
    const task = seedReviewTask(ctx.taskRepo);
    ctx.db.prepare(`UPDATE spaces SET paused = 1 WHERE id = ?`).run(SPACE_ID);

    let caught: unknown;
    try {
      await ctx.runtime.dispatchPostApproval(task.id, 'human', {});
    } catch (err) {
      caught = err;
    }
    expect((caught as Error).name).toBe('PostApprovalDeferredError');

    expect(ctx.taskRepo.getTask(task.id)?.status).toBe('approved');
    expect(ctx.taskRepo.getTask(task.id)?.postApprovalBlockedReason).toMatch(
      /paused; post-approval dispatch deferred/
    );
    expect(ctx.injected).toEqual([]);
  });

  test('space.start re-drives the deferred dispatch (approval closes to done)', async () => {
    // The resume path the deferral message promises: onSpaceResumed sweeps
    // approved tasks with a blocked reason and re-invokes
    // dispatchPostApproval, which (with the space active) completes — here
    // the no-route branch closes the task to done and clears the reason.
    const task = seedReviewTask(ctx.taskRepo);
    await ctx.spaceManager.stopSpace(SPACE_ID);

    await expect(ctx.runtime.dispatchPostApproval(task.id, 'human', {})).rejects.toThrow(
      /stopped; post-approval dispatch deferred/
    );
    expect(ctx.taskRepo.getTask(task.id)?.postApprovalBlockedReason).toBeTruthy();

    await ctx.spaceManager.startSpace(SPACE_ID);
    // The sweep is fired (fire-and-forget) by the resumed callback — let it
    // settle before asserting.
    await new Promise((resolve) => setTimeout(resolve, 25));

    const final = ctx.taskRepo.getTask(task.id);
    expect(final?.status).toBe('done');
    expect(final?.postApprovalBlockedReason).toBeNull();
  });

  test('space.start re-spawns an interrupted merge with full route context (stop nulled the pointer)', async () => {
    // The route-bearing resume for the case stopActiveWork's step 1.5
    // records: a merger session was interrupted mid-merge, so the pointer is
    // NULLed and only the blocked reason marks the deferral. The stub's probe
    // is deliberately adversarial — it reports every session alive
    // (isAgentSessionAlive counts 'interrupted' as alive, the exact false
    // positive this shape must not depend on) — proving the resume cannot be
    // wedged by the router's already-routed guard: with no pointer the guard
    // is never consulted, the spawner runs, and the task is re-stamped with
    // the fresh merge session.
    const workflow = ctx.workflowManager.createWorkflow({
      spaceId: SPACE_ID,
      name: `Route resume ${Date.now()}`,
      description: 'Test',
      nodes: [
        {
          id: 'node-build',
          name: 'Build',
          agents: [{ agentId: 'agent-planner', name: 'Planner' }],
          postApproval: { targetAgent: 'Planner', instructions: 'Merge {{pr_url}}' },
        },
      ],
      transitions: [],
      startNodeId: 'node-build',
      endNodeId: 'node-build',
      rules: [],
      tags: [],
      completionAutonomyLevel: 3,
    });
    const run = ctx.workflowRunRepo.createRun({
      spaceId: SPACE_ID,
      workflowId: workflow.id,
      title: 'Run',
    });
    const task = ctx.taskRepo.createTask({
      spaceId: SPACE_ID,
      title: 'Ship it',
      description: '',
      status: 'in_progress',
      workflowRunId: run.id,
    });
    // The exact post-stop shape step 1.5 writes: approved, pointer nulled,
    // reason stamped (the message keeps the interrupted session id for the
    // banner).
    ctx.taskRepo.updateTask(task.id, {
      status: 'approved',
      approvalSource: 'human',
      approvedAt: Date.now(),
      postApprovalSessionId: null,
      postApprovalBlockedReason:
        'post-approval session session:merge-1 interrupted by space.stop; ' +
        'the dispatch re-runs automatically when the space starts',
    });

    const spawnCalls: Array<{ targetAgent: string; kickoff: string }> = [];
    const tam = (
      ctx.runtime as unknown as { config: { taskAgentManager: Record<string, unknown> } }
    ).config.taskAgentManager;
    tam.isSessionAlive = () => true; // adversarial: 'interrupted' counts as alive
    tam.spawnPostApprovalSubSession = async (args: {
      targetAgent: string;
      kickoffMessage: string;
    }) => {
      spawnCalls.push({ targetAgent: args.targetAgent, kickoff: args.kickoffMessage });
      return { sessionId: 'session:merge-resumed' };
    };

    await ctx.spaceManager.stopSpace(SPACE_ID);
    await ctx.spaceManager.startSpace(SPACE_ID);
    // The sweep is fired (fire-and-forget) by the resumed callback — let it
    // settle before asserting.
    await new Promise((resolve) => setTimeout(resolve, 25));

    expect(spawnCalls).toHaveLength(1);
    expect(spawnCalls[0]!.targetAgent).toBe('Planner');
    expect(spawnCalls[0]!.kickoff).toContain('Merge');
    const final = ctx.taskRepo.getTask(task.id);
    // The spawn branch does not close the task — the merger's mark_complete
    // does once the merge lands.
    expect(final?.status).toBe('approved');
    expect(final?.postApprovalSessionId).toBe('session:merge-resumed');
    expect(final?.postApprovalBlockedReason).toBeNull(); // banner resolved
  });

  test('a stop landing mid-dispatch converts to the same durable deferral', async () => {
    // The merge spawner's pre-kickoff stop check throws TransientSpawnError
    // from inside router.route; dispatchPostApproval must convert it into the
    // typed durable deferral (banner + resume re-drive) instead of leaking a
    // raw spawn error past an already-committed approval.
    const workflow = ctx.workflowManager.createWorkflow({
      spaceId: SPACE_ID,
      name: `Route ${Date.now()}`,
      description: 'Test',
      nodes: [
        {
          id: 'node-build',
          name: 'Build',
          agents: [{ agentId: 'agent-planner', name: 'Planner' }],
          postApproval: { targetAgent: 'Planner', instructions: 'Merge {{pr_url}}' },
        },
      ],
      transitions: [],
      startNodeId: 'node-build',
      endNodeId: 'node-build',
      rules: [],
      tags: [],
      completionAutonomyLevel: 3,
    });
    const run = ctx.workflowRunRepo.createRun({
      spaceId: SPACE_ID,
      workflowId: workflow.id,
      title: 'Run',
    });
    const task = ctx.taskRepo.createTask({
      spaceId: SPACE_ID,
      title: 'Ship it',
      description: '',
      status: 'in_progress',
      workflowRunId: run.id,
    });
    ctx.taskRepo.updateTask(task.id, { status: 'review' });
    // The spawner aborts as if a stop landed between the hold and the kickoff.
    const { TransientSpawnError } = await import(
      '../../../../src/lib/space/runtime/workflow-node-execution-validation.ts'
    );
    const tam = (
      ctx.runtime as unknown as { config: { taskAgentManager: Record<string, unknown> } }
    ).config.taskAgentManager;
    tam.spawnPostApprovalSubSession = async () => {
      throw new TransientSpawnError('space stopped during merge spawn');
    };

    let caught: unknown;
    try {
      await ctx.runtime.dispatchPostApproval(task.id, 'agent');
    } catch (err) {
      caught = err;
    }
    expect((caught as Error).name).toBe('PostApprovalDeferredError');
    expect((caught as Error).message).toMatch(/stopped during dispatch/);

    const final = ctx.taskRepo.getTask(task.id);
    expect(final?.status).toBe('approved');
    expect(final?.postApprovalBlockedReason).toMatch(/stopped during dispatch/);
  });

  // ---------------------------------------------------------------------------
  // Layer B regression — pending-completion fields cleared after dispatch
  // ---------------------------------------------------------------------------

  test('Layer B: clears all four pending-completion fields after no-route dispatch', async () => {
    const task = seedReviewTask(ctx.taskRepo);
    // Stamp the pending-completion fields exactly as `submit_for_approval`
    // does, so we can assert they are null once dispatch completes. This task
    // has no workflow → no Post-Approval route → the no-route branch runs and
    // closes it to `done`.
    ctx.taskRepo.updateTask(task.id, {
      pendingCheckpointType: 'task_completion',
      pendingCompletionSubmittedByNodeId: 'node-review',
      pendingCompletionSubmittedAt: Date.now(),
      pendingCompletionReason: 'ready for human review',
    });

    await ctx.runtime.dispatchPostApproval(task.id, 'human');

    const final = ctx.taskRepo.getTask(task.id);
    expect(final?.status).toBe('done');
    expect(final?.postApprovalSessionId).toBeNull();
    // All four pending-completion fields must be cleared.
    expect(final?.pendingCheckpointType).toBeNull();
    expect(final?.pendingCompletionSubmittedByNodeId).toBeNull();
    expect(final?.pendingCompletionSubmittedAt).toBeNull();
    expect(final?.pendingCompletionReason).toBeNull();
  });
});
