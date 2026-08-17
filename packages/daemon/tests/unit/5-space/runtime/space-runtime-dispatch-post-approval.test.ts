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
      isSessionUsableForPostApproval: () => true,
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

/**
 * Seed an approved task that carries a post-approval ROUTE (so the router's
 * dispatchable/guard paths run) plus a blocked reason, optionally with a
 * session pointer — the shapes the resume sweep re-drives.
 */
function seedRouteDeferredTask(
  ctx: Ctx,
  opts: { sessionId?: string | null; instructions?: string } = {}
): string {
  const nodeId = `node-build-${Math.random().toString(36).slice(2, 8)}`;
  const workflow = ctx.workflowManager.createWorkflow({
    spaceId: SPACE_ID,
    name: `Route ${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
    description: 'Test',
    nodes: [
      {
        id: nodeId,
        name: 'Build',
        agents: [{ agentId: 'agent-planner', name: 'Planner' }],
        postApproval: {
          targetAgent: 'Planner',
          instructions: opts.instructions ?? 'Merge {{pr_url}}',
        },
      },
    ],
    transitions: [],
    startNodeId: nodeId,
    endNodeId: nodeId,
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
  ctx.taskRepo.updateTask(task.id, {
    status: 'approved',
    approvalSource: 'human',
    approvedAt: Date.now(),
    postApprovalSessionId: opts.sessionId ?? null,
    postApprovalBlockedReason: 'deferred by a stop; awaiting the resume sweep',
  });
  return task.id;
}

/** The runtime config's Task Agent stub, as a mutable record for overrides. */
function tamOf(ctx: Ctx): Record<string, unknown> {
  return (ctx.runtime as unknown as { config: { taskAgentManager: Record<string, unknown> } })
    .config.taskAgentManager;
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
    // The sweep is fired (fire-and-forget) by the resumed callback — await it
    // deterministically instead of sleeping past it.
    await ctx.runtime.flushResumeSweep(SPACE_ID);

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
    tam.isSessionUsableForPostApproval = () => true; // adversarial probe
    tam.spawnPostApprovalSubSession = async (args: {
      targetAgent: string;
      kickoffMessage: string;
    }) => {
      spawnCalls.push({ targetAgent: args.targetAgent, kickoff: args.kickoffMessage });
      return { sessionId: 'session:merge-resumed' };
    };

    await ctx.spaceManager.stopSpace(SPACE_ID);
    await ctx.spaceManager.startSpace(SPACE_ID);
    // The sweep is fired (fire-and-forget) by the resumed callback — await it
    // deterministically instead of sleeping past it.
    await ctx.runtime.flushResumeSweep(SPACE_ID);

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

  // -------------------------------------------------------------------------
  // Sweep residual-clear gating — the clear must only drop the banner when
  // the dispatch genuinely resolved the deferral. `already-routed` writes
  // nothing, so the sweep clears it; but a stop landing DURING the dispatch
  // await re-records the interruption (step 1.5 nulls the pointer), and a
  // `skipped` dispatch (broken route) resolves nothing — both must KEEP the
  // reason, or the banner silently disappears off a wedged task.
  // -------------------------------------------------------------------------

  test('already-routed with a live session: sweep clears the residual banner', async () => {
    // The paused-hold shape: the dispatch hold deferred while the merger was
    // LIVE (pause keeps sessions alive), so the pointer survives with the
    // reason. On resume the guard reports the session live → already-routed
    // → the sweep drops the banner and leaves the running merger alone.
    const taskId = seedRouteDeferredTask(ctx, { sessionId: 'session:merge-live' });
    const spawnCalls: string[] = [];
    const tam = tamOf(ctx);
    tam.isSessionAlive = () => true;
    tam.spawnPostApprovalSubSession = async (args: { targetAgent: string }) => {
      spawnCalls.push(args.targetAgent);
      return { sessionId: 'should-not-happen' };
    };

    await ctx.spaceManager.stopSpace(SPACE_ID);
    await ctx.spaceManager.startSpace(SPACE_ID);
    await ctx.runtime.flushResumeSweep(SPACE_ID);

    expect(spawnCalls).toEqual([]);
    const final = ctx.taskRepo.getTask(taskId);
    expect(final?.postApprovalSessionId).toBe('session:merge-live'); // left untouched
    expect(final?.postApprovalBlockedReason).toBeNull(); // banner dropped
  });

  test('a stop landing mid-dispatch: sweep keeps the freshly stamped reason', async () => {
    // Same shape, but a second stop lands while the dispatch await is in
    // flight: its step 1.5 nulls the pointer (and would re-stamp the reason).
    // The pointer captured before the dispatch no longer matches → the sweep
    // must NOT clear, or the banner vanishes off a freshly interrupted
    // merger with nothing left to re-drive it.
    const taskId = seedRouteDeferredTask(ctx, { sessionId: 'session:merge-live' });
    const tam = tamOf(ctx);
    tam.isSessionUsableForPostApproval = (sid: string) => {
      // Simulate stopActiveWork 1.5 firing inside the dispatch await.
      ctx.taskRepo.updateTask(taskId, { postApprovalSessionId: null });
      expect(sid).toBe('session:merge-live');
      return true;
    };
    tam.spawnPostApprovalSubSession = async () => ({ sessionId: 'should-not-happen' });

    await ctx.spaceManager.stopSpace(SPACE_ID);
    await ctx.spaceManager.startSpace(SPACE_ID);
    await ctx.runtime.flushResumeSweep(SPACE_ID);

    const final = ctx.taskRepo.getTask(taskId);
    expect(final?.postApprovalSessionId).toBeNull();
    expect(final?.postApprovalBlockedReason).toBeTruthy(); // kept
  });

  test('skipped dispatch (empty template): reason kept for banner recovery', async () => {
    const taskId = seedRouteDeferredTask(ctx, { instructions: '   ' }); // empty template
    const spawnCalls: string[] = [];
    const tam = tamOf(ctx);
    tam.isSessionUsableForPostApproval = () => false;
    tam.spawnPostApprovalSubSession = async (args: { targetAgent: string }) => {
      spawnCalls.push(args.targetAgent);
      return { sessionId: 'should-not-happen' };
    };

    await ctx.spaceManager.stopSpace(SPACE_ID);
    await ctx.spaceManager.startSpace(SPACE_ID);
    await ctx.runtime.flushResumeSweep(SPACE_ID);

    expect(spawnCalls).toEqual([]);
    const final = ctx.taskRepo.getTask(taskId);
    expect(final?.status).toBe('approved');
    expect(final?.postApprovalBlockedReason).toBeTruthy(); // kept — manual recovery
  });

  test('dispatch failure keeps the reason; a deferral continues to the next task', async () => {
    // Task A: the spawner aborts transiently (as if re-stopped mid-dispatch)
    // → converted to the typed deferral → the sweep's catch continues.
    // Task B: standalone (no route) → the no-route branch closes it to done.
    const { TransientSpawnError } = await import(
      '../../../../src/lib/space/runtime/workflow-node-execution-validation.ts'
    );
    const taskA = seedRouteDeferredTask(ctx);
    const plain = seedReviewTask(ctx.taskRepo); // review → standalone approved deferral
    ctx.taskRepo.updateTask(plain.id, {
      status: 'approved',
      approvalSource: 'human',
      approvedAt: Date.now(),
      postApprovalBlockedReason: 'deferred by a stop; awaiting the resume sweep',
    });
    const tam = tamOf(ctx);
    tam.isSessionUsableForPostApproval = () => true; // spawned sessions are usable
    let spawns = 0;
    tam.spawnPostApprovalSubSession = async () => {
      // First attempt aborts transiently (as if re-stopped mid-dispatch); the
      // wrapper's resumed-race compensation re-drives on the active space and
      // the retry succeeds.
      if (++spawns === 1) throw new TransientSpawnError('space stopped during merge spawn');
      return { sessionId: 'session:merge-retry' };
    };

    await ctx.spaceManager.stopSpace(SPACE_ID);
    await ctx.spaceManager.startSpace(SPACE_ID);
    await ctx.runtime.flushResumeSweep(SPACE_ID);
    // The compensation's re-drive is fire-and-forget past the flush — poll
    // for A's recovery.
    for (let i = 0; i < 100 && ctx.taskRepo.getTask(taskA)?.postApprovalBlockedReason; i++) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }

    // B was still processed after A's deferral — the catch `continue`s.
    const finalB = ctx.taskRepo.getTask(plain.id);
    expect(finalB?.status).toBe('done');
    expect(finalB?.postApprovalBlockedReason).toBeNull();
    // A's deferral was compensated: the retry spawned and cleared the reason.
    const finalA = ctx.taskRepo.getTask(taskA);
    expect(finalA?.status).toBe('approved');
    expect(finalA?.postApprovalSessionId).toBe('session:merge-retry');
    expect(finalA?.postApprovalBlockedReason).toBeNull();
    expect(spawns).toBe(2);
  });

  test('a genuine dispatch failure keeps the reason (no deferral rewrite)', async () => {
    const taskId = seedRouteDeferredTask(ctx);
    const tam = tamOf(ctx);
    tam.isSessionUsableForPostApproval = () => false;
    tam.spawnPostApprovalSubSession = async () => {
      throw new Error('boom');
    };

    await ctx.spaceManager.stopSpace(SPACE_ID);
    await ctx.spaceManager.startSpace(SPACE_ID);
    await ctx.runtime.flushResumeSweep(SPACE_ID);

    const final = ctx.taskRepo.getTask(taskId);
    expect(final?.status).toBe('approved');
    // The original wording survives — the sweep keeps it for banner recovery.
    expect(final?.postApprovalBlockedReason).toBe('deferred by a stop; awaiting the resume sweep');
  });

  test('concurrent dispatches serialize: the second short-circuits, one merger spawns', async () => {
    // Two overlapping resume sweeps (resume → pause → resume inside the
    // multi-second spawn window) read the same pre-spawn state — the router
    // stamps the pointer only after the spawn resolves — so without per-task
    // mutual exclusion both pass the already-routed guard and each spawn a
    // merger (duplicate merge work). The second dispatcher must
    // short-circuit while the first is in flight.
    const taskId = seedRouteDeferredTask(ctx);
    const tam = tamOf(ctx);
    let releaseSpawn: (() => void) | null = null;
    const spawnCalls: string[] = [];
    tam.isSessionUsableForPostApproval = () => true; // spawned sessions are usable
    let signalSpawnEntered: (() => void) | null = null;
    const spawnEntered = new Promise<void>((resolve) => {
      signalSpawnEntered = resolve;
    });
    tam.spawnPostApprovalSubSession = () => {
      spawnCalls.push('spawn');
      signalSpawnEntered?.();
      return new Promise((resolve) => {
        releaseSpawn = () => resolve({ sessionId: 'session:merge-first' });
      });
    };

    const first = ctx.runtime.dispatchPostApproval(taskId, 'agent');
    // Gate on the spawn actually being entered — a timer barrier would hang
    // under CI load if the first dispatch hadn't reached the stub yet.
    await spawnEntered;
    const second = await ctx.runtime.dispatchPostApproval(taskId, 'agent');
    releaseSpawn?.();
    const firstResult = await first;

    expect(second.mode).toBe('skipped');
    expect(second.reason ?? '').toMatch(/already in flight/);
    expect(firstResult.mode).toBe('spawn');
    expect(spawnCalls).toEqual(['spawn']); // exactly one merger
  });

  test('a stop racing the sweep clear: verify-and-restore keeps the deferral reason', async () => {
    // The clear is read-then-write with an await between: the gate passes
    // (pointer unchanged), then a stop's step 1.5 lands INSIDE the clear's
    // write window — it sees the reason still set, keeps the wording, and
    // nulls the pointer — and the sweep's clear then erases the reason the
    // stop's deferral depends on (pointer null + reason null + stopped =
    // no automatic recovery). The post-clear verification must detect the
    // changed pointer and restore the reason. The taskRepo.updateTask wrap
    // simulates the stop's step-1.5 write landing exactly between the clear
    // and the verification read.
    const taskId = seedRouteDeferredTask(ctx, { sessionId: 'session:merge-live' });
    const tam = tamOf(ctx);
    tam.isSessionUsableForPostApproval = () => true; // already-routed, live session
    tam.spawnPostApprovalSubSession = async () => ({ sessionId: 'should-not-happen' });
    const origUpdate = ctx.taskRepo.updateTask.bind(ctx.taskRepo);
    ctx.taskRepo.updateTask = (id: string, payload: Record<string, unknown>) => {
      const result = origUpdate(id, payload);
      const isSweepClear =
        payload.postApprovalBlockedReason === null &&
        !('postApprovalSessionId' in payload) &&
        !('status' in payload);
      if (isSweepClear) {
        // The stop's step 1.5 racing the clear: keeps the reason, drops the
        // pointer.
        origUpdate(id, { postApprovalSessionId: null });
      }
      return result;
    };

    await ctx.spaceManager.stopSpace(SPACE_ID);
    await ctx.spaceManager.startSpace(SPACE_ID);
    await ctx.runtime.flushResumeSweep(SPACE_ID);

    const final = ctx.taskRepo.getTask(taskId);
    expect(final?.postApprovalSessionId).toBeNull();
    // The reason the stop's deferral depends on is RESTORED, not erased.
    expect(final?.postApprovalBlockedReason).toBe('deferred by a stop; awaiting the resume sweep');
  });

  test('sweep outer failure is isolated: listBySpace throwing does not reject the flush', async () => {
    ctx.taskRepo.listBySpace = (() => {
      throw new Error('boom-list');
    }) as unknown as typeof ctx.taskRepo.listBySpace;
    await ctx.spaceManager.stopSpace(SPACE_ID);
    await ctx.spaceManager.startSpace(SPACE_ID);
    // Logs the failure and resolves — the flush handle must never reject.
    await expect(ctx.runtime.flushResumeSweep(SPACE_ID)).resolves.toBeUndefined();
  });

  test('unreadable-state abort keeps an honest banner (no false stop claim, honest re-drive)', async () => {
    // The fail-closed pre-kickoff variant throws "state unreadable" — the
    // space was never stopped. The deferral copy must not claim a stop
    // happened nor promise an automatic resume trigger that will not fire
    // (on an active space, space.start is a no-op); a pause→resume cycle is
    // the honest re-drive instruction.
    const taskId = seedRouteDeferredTask(ctx);
    const { TransientSpawnError } = await import(
      '../../../../src/lib/space/runtime/workflow-node-execution-validation.ts'
    );
    const tam = tamOf(ctx);
    tam.spawnPostApprovalSubSession = async () => {
      throw new TransientSpawnError(
        'Space space-dispatch-pa state unreadable during spawn (pre-kickoff (post-approval), ' +
          'task t); failing closed'
      );
    };

    let caught: unknown;
    try {
      await ctx.runtime.dispatchPostApproval(taskId, 'human');
    } catch (err) {
      caught = err;
    }
    expect((caught as Error).name).toBe('PostApprovalDeferredError');
    expect((caught as Error).message).not.toMatch(/stopped during dispatch/);
    expect((caught as Error).message).toMatch(/could not be re-read/);
    expect((caught as Error).message).toMatch(/pausing and resuming/);

    const final = ctx.taskRepo.getTask(taskId);
    expect(final?.status).toBe('approved');
    expect(final?.postApprovalBlockedReason).toMatch(/could not be re-read/);
  });

  test('a start racing the post-route correction: compensation re-drives after the mutex releases', async () => {
    // The P1 interleaving: the correction fires inside the dispatch while the
    // per-task mutex is still held, and a start has already run the resume
    // sweep (which missed the not-yet-stamped reason). The wrapper fires the
    // compensating sweep AFTER the mutex release — a sweep fired any earlier
    // would hit its own in-flight entry and self-skip, deterministically.
    const workflow = ctx.workflowManager.createWorkflow({
      spaceId: SPACE_ID,
      name: `Route bounce ${Date.now()}`,
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
    const tam = tamOf(ctx);
    tam.isSessionUsableForPostApproval = () => true;
    let spawns = 0;
    tam.spawnPostApprovalSubSession = async () => {
      if (++spawns === 1) {
        // The stop commits during the injection await...
        ctx.db.prepare(`UPDATE spaces SET stopped = 1 WHERE id = ?`).run(SPACE_ID);
        return { sessionId: 'session:merge-raced' };
      }
      // ...and the compensation's re-drive spawns fresh on the active space.
      return { sessionId: 'session:merge-compensated' };
    };
    const origUpdate = ctx.taskRepo.updateTask.bind(ctx.taskRepo);
    ctx.taskRepo.updateTask = (id: string, payload: Record<string, unknown>) => {
      const result = origUpdate(id, payload);
      // The start lands exactly when the correction stamps: the wrapper's
      // compensation read then sees an active space and re-drives.
      if (
        payload.postApprovalSessionId === null &&
        typeof payload.postApprovalBlockedReason === 'string' &&
        payload.postApprovalBlockedReason.includes('landed while space')
      ) {
        ctx.db.prepare(`UPDATE spaces SET stopped = 0 WHERE id = ?`).run(SPACE_ID);
      }
      return result;
    };

    let caught: unknown;
    try {
      await ctx.runtime.dispatchPostApproval(task.id, 'agent');
    } catch (err) {
      caught = err;
    }
    expect((caught as Error).name).toBe('PostApprovalDeferredError');
    // The compensating sweep is fire-and-forget past the throw — poll for the
    // re-drive.
    for (
      let i = 0;
      i < 100 &&
      ctx.taskRepo.getTask(task.id)?.postApprovalSessionId !== 'session:merge-compensated';
      i++
    ) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }

    const final = ctx.taskRepo.getTask(task.id);
    expect(final?.status).toBe('approved');
    expect(final?.postApprovalSessionId).toBe('session:merge-compensated');
    expect(final?.postApprovalBlockedReason).toBeNull();
    expect(spawns).toBe(2);
  });

  test('hold-path compensation: a start racing the hold stamp re-drives to closure', async () => {
    // The hold defers while stopped; a start landing between its space read
    // and the stamp means the resume sweep already ran and missed the reason.
    // The wrapper compensation covers the hold exactly like the correction —
    // here a standalone task closes to done on the re-drive.
    const task = seedReviewTask(ctx.taskRepo);
    ctx.db.prepare(`UPDATE spaces SET stopped = 1 WHERE id = ?`).run(SPACE_ID);
    const origUpdate = ctx.taskRepo.updateTask.bind(ctx.taskRepo);
    ctx.taskRepo.updateTask = (id: string, payload: Record<string, unknown>) => {
      const result = origUpdate(id, payload);
      if (
        typeof payload.postApprovalBlockedReason === 'string' &&
        payload.postApprovalBlockedReason.includes('deferred until the space resumes')
      ) {
        ctx.db.prepare(`UPDATE spaces SET stopped = 0 WHERE id = ?`).run(SPACE_ID);
      }
      return result;
    };

    let caught: unknown;
    try {
      await ctx.runtime.dispatchPostApproval(task.id, 'human');
    } catch (err) {
      caught = err;
    }
    expect((caught as Error).name).toBe('PostApprovalDeferredError');
    for (let i = 0; i < 100 && ctx.taskRepo.getTask(task.id)?.status !== 'done'; i++) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }

    // Re-driven on the now-active space: the no-route branch closes it.
    expect(ctx.taskRepo.getTask(task.id)?.status).toBe('done');
    expect(ctx.taskRepo.getTask(task.id)?.postApprovalBlockedReason).toBeNull();
  });

  test('deferral stamps emit space.task.updated (the banner reaches web clients)', async () => {
    const task = seedReviewTask(ctx.taskRepo);
    ctx.db.prepare(`UPDATE spaces SET stopped = 1 WHERE id = ?`).run(SPACE_ID);

    await expect(ctx.runtime.dispatchPostApproval(task.id, 'human')).rejects.toThrow(
      /deferred until the space resumes/
    );
    // The hold's stamp emitted the refreshed task — the web store refreshes
    // tasks ONLY on this event.
    const emitted = ctx.emitted.filter(
      (e) => e.task.id === task.id && e.task.postApprovalBlockedReason !== null
    );
    expect(emitted.length).toBeGreaterThanOrEqual(1);
  });

  test('a stop→start bounce mid-spawn: the dead-session probe corrects the healthy stamp', async () => {
    // The P2-1 interleaving: the dispatch passes hold and assert while live;
    // the stop interrupts the just-registered merger; a start lands before
    // the post-route read, so the SPACE check sees active — only the
    // session-level probe (interrupted = not usable) still corrects, and the
    // wrapper compensation then re-spawns on the active space.
    const workflow = ctx.workflowManager.createWorkflow({
      spaceId: SPACE_ID,
      name: `Route probe ${Date.now()}`,
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
    const tam = tamOf(ctx);
    // The first spawn's session reads DEAD (interrupted by the stop's
    // cleanup); the compensation's fresh spawn reads usable.
    tam.isSessionUsableForPostApproval = (sid: string) => sid !== 'session:merge-bounce';
    let spawns = 0;
    tam.spawnPostApprovalSubSession = async () => {
      return { sessionId: ++spawns === 1 ? 'session:merge-bounce' : 'session:merge-alive' };
    };

    let caught: unknown;
    try {
      await ctx.runtime.dispatchPostApproval(task.id, 'agent');
    } catch (err) {
      caught = err;
    }
    expect((caught as Error).name).toBe('PostApprovalDeferredError');
    expect((caught as Error).message).toMatch(/dead merge session/);
    for (
      let i = 0;
      i < 100 && ctx.taskRepo.getTask(task.id)?.postApprovalSessionId !== 'session:merge-alive';
      i++
    ) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }

    const final = ctx.taskRepo.getTask(task.id);
    expect(final?.postApprovalSessionId).toBe('session:merge-alive');
    expect(final?.postApprovalBlockedReason).toBeNull();
    expect(spawns).toBe(2);
  });

  test('paused space with a live spawned merger: the space check is excluded, pointer kept', async () => {
    // Pause keeps in-flight work alive — the post-route correction must NOT
    // fire for a paused space whose spawned merger is genuinely usable. The
    // pause lands between the hold read and the post-route read.
    const task = seedReviewTask(ctx.taskRepo);
    const workflow = ctx.workflowManager.createWorkflow({
      spaceId: SPACE_ID,
      name: `Route paused ${Date.now()}`,
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
    ctx.taskRepo.updateTask(task.id, { workflowRunId: run.id });
    const tam = tamOf(ctx);
    tam.isSessionUsableForPostApproval = () => true; // genuinely live merger
    tam.spawnPostApprovalSubSession = async () => ({ sessionId: 'session:merge-paused' });
    const origUpdate = ctx.taskRepo.updateTask.bind(ctx.taskRepo);
    ctx.taskRepo.updateTask = (id: string, payload: Record<string, unknown>) => {
      const result = origUpdate(id, payload);
      // The pause lands when the router stamps the healthy pointer.
      if (payload.postApprovalSessionId === 'session:merge-paused') {
        ctx.db.prepare(`UPDATE spaces SET paused = 1 WHERE id = ?`).run(SPACE_ID);
      }
      return result;
    };

    const result = await ctx.runtime.dispatchPostApproval(task.id, 'agent');
    expect(result.mode).toBe('spawn');
    const final = ctx.taskRepo.getTask(task.id);
    // Pointer kept, no correction, no banner — the merger is live on pause.
    expect(final?.postApprovalSessionId).toBe('session:merge-paused');
    expect(final?.postApprovalBlockedReason).toBeNull();
  });

  test('fresh-spawn pointer change during the clear window: NO stale-reason restore', async () => {
    // The restore discriminator is the stop signature (pointer nulled). A
    // concurrent re-dispatch's fresh spawn stamps a NON-null S2 and clears
    // the reason itself — restoring the pre-dispatch reason there would
    // banner healthy work.
    const taskId = seedRouteDeferredTask(ctx, { sessionId: 'session:merge-live' });
    const tam = tamOf(ctx);
    tam.isSessionUsableForPostApproval = () => true;
    tam.spawnPostApprovalSubSession = async () => ({ sessionId: 'should-not-happen' });
    const origUpdate = ctx.taskRepo.updateTask.bind(ctx.taskRepo);
    ctx.taskRepo.updateTask = (id: string, payload: Record<string, unknown>) => {
      const result = origUpdate(id, payload);
      const isSweepClear =
        payload.postApprovalBlockedReason === null &&
        !('postApprovalSessionId' in payload) &&
        !('status' in payload);
      if (isSweepClear) {
        // A concurrent re-dispatch's spawn branch landing right after the
        // clear: fresh pointer S2 + its own reason clear.
        origUpdate(id, { postApprovalSessionId: 'session:merge-fresh' });
      }
      return result;
    };

    await ctx.spaceManager.stopSpace(SPACE_ID);
    await ctx.spaceManager.startSpace(SPACE_ID);
    await ctx.runtime.flushResumeSweep(SPACE_ID);

    const final = ctx.taskRepo.getTask(taskId);
    expect(final?.postApprovalSessionId).toBe('session:merge-fresh');
    // No stale reason restored onto the live fresh spawn.
    expect(final?.postApprovalBlockedReason).toBeNull();
  });

  test('overlapping resume sweeps: flushResumeSweep stays deterministic (conditional delete)', async () => {
    // Two tasks, two gated spawns. sweep1 (older) gates on task A; sweep2
    // (newer, fired by a second resume) skips A on the mutex and gates on B.
    // When sweep1 finishes first, its finally must NOT evict sweep2's map
    // entry — a flush during sweep2 must keep waiting until B releases.
    const taskA = seedRouteDeferredTask(ctx);
    const taskB = seedRouteDeferredTask(ctx);
    const tam = tamOf(ctx);
    tam.isSessionUsableForPostApproval = () => true;
    const releaseGates: Array<() => void> = [];
    const gatedSpawn = () =>
      new Promise<{ sessionId: string }>((resolve) => {
        releaseGates.push(() => resolve({ sessionId: `session:merge-${releaseGates.length}` }));
      });
    tam.spawnPostApprovalSubSession = gatedSpawn;

    await ctx.spaceManager.stopSpace(SPACE_ID);
    await ctx.spaceManager.startSpace(SPACE_ID); // sweep1: dispatches A (gated)
    await new Promise((resolve) => setTimeout(resolve, 10));
    await ctx.spaceManager.pauseSpace(SPACE_ID);
    await ctx.spaceManager.resumeSpace(SPACE_ID); // sweep2: skips A, gates on B

    // Release A (sweep1's only task): sweep1 finishes while sweep2 still
    // gates on B.
    releaseGates[0]!();
    await new Promise((resolve) => setTimeout(resolve, 10));

    // Flush tracks the LATEST sweep (sweep2, still running): it must not
    // resolve while B is gated. (With an unconditional delete, sweep1's
    // finally would have evicted sweep2's entry and the flush would return.)
    const flush = ctx.runtime.flushResumeSweep(SPACE_ID);
    const winner = await Promise.race([
      flush.then(() => 'flush'),
      new Promise((resolve) => setTimeout(() => resolve('timeout'), 50)),
    ]);
    expect(winner).toBe('timeout');

    releaseGates[1]!();
    await flush;
    expect(ctx.taskRepo.getTask(taskA)?.postApprovalBlockedReason).toBeNull();
    expect(ctx.taskRepo.getTask(taskB)?.postApprovalBlockedReason).toBeNull();
  });

  test('an interrupted merger pointer re-spawns instead of pinning already-routed', async () => {
    // The class-level safety net: any stop-race window the pointer-nulling
    // correctors miss leaves postApprovalSessionId on an INTERRUPTED session.
    // The old lazy probe counts 'interrupted' alive and would short-circuit
    // already-routed forever; the interruption-aware guard falls through and
    // re-spawns. The two probes deliberately disagree on this session — the
    // exact 'interrupted' shape — so reverting the wiring fails this test.
    const taskId = seedRouteDeferredTask(ctx, { sessionId: 'session:merge-interrupted' });
    const tam = tamOf(ctx);
    tam.isSessionAlive = () => true; // the OLD probe: interrupted counts alive
    // The guard: the interrupted session reads dead; a fresh spawn reads usable.
    tam.isSessionUsableForPostApproval = (sid: string) => sid !== 'session:merge-interrupted';
    const spawnCalls: string[] = [];
    tam.spawnPostApprovalSubSession = async () => {
      spawnCalls.push('spawn');
      return { sessionId: 'session:merge-fresh' };
    };

    const result = await ctx.runtime.dispatchPostApproval(taskId, 'agent');

    expect(result.mode).toBe('spawn');
    expect(spawnCalls).toEqual(['spawn']);
    expect(ctx.taskRepo.getTask(taskId)?.postApprovalSessionId).toBe('session:merge-fresh');
    expect(ctx.taskRepo.getTask(taskId)?.postApprovalBlockedReason).toBeNull();
  });

  test('terminal-run reconcile: stopped-space deferral is not a reconciliation failure', async () => {
    // The reconcileTerminalRunTasks dispatch site (sibling of the completion
    // sweep's): with the space stopped, dispatchPostApproval commits the
    // approval and throws the typed deferral — the catch must swallow it so
    // the reconciliation pass treats it as deferred, not failed.
    const createdRun = ctx.workflowRunRepo.createRun({
      spaceId: SPACE_ID,
      workflowId: 'wf-none',
      title: 'Run',
    });
    ctx.db
      .prepare(`UPDATE space_workflow_runs SET status = 'done' WHERE id = ?`)
      .run(createdRun.id);
    const task = ctx.taskRepo.createTask({
      spaceId: SPACE_ID,
      title: 'Reconcile me',
      description: '',
      status: 'in_progress',
      workflowRunId: createdRun.id,
    });
    ctx.db.prepare(`UPDATE spaces SET stopped = 1 WHERE id = ?`).run(SPACE_ID);

    const rt = ctx.runtime as unknown as {
      reconcileTerminalRunTasks: (run: { id: string }) => Promise<void>;
    };
    await expect(
      rt.reconcileTerminalRunTasks(ctx.workflowRunRepo.getRun(createdRun.id)!)
    ).resolves.toBeUndefined();

    const final = ctx.taskRepo.getTask(task.id);
    expect(final?.status).toBe('approved');
    expect(final?.postApprovalBlockedReason).toMatch(/stopped; post-approval dispatch deferred/);
  });

  test('correction read failure: the unreadable deferral still stamps the blocked reason', async () => {
    // P1 (round 7): the fix-up catch used to throw the typed 'unreadable'
    // deferral WITHOUT stamping postApprovalBlockedReason — the RPC handler
    // treats every typed deferral as already durably recorded (no re-stamp),
    // the resume sweep filters on the reason, and the wrapper excludes
    // 'unreadable' from firing, so the task would wedge `approved` with no
    // banner and no recovery signal. The catch now stamps before throwing.
    const workflow = ctx.workflowManager.createWorkflow({
      spaceId: SPACE_ID,
      name: `Route unreadable ${Date.now()}`,
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
    const task = seedReviewTask(ctx.taskRepo);
    ctx.taskRepo.updateTask(task.id, { workflowRunId: run.id });
    const tam = tamOf(ctx);
    tam.isSessionUsableForPostApproval = () => true;
    tam.spawnPostApprovalSubSession = async () => ({ sessionId: 'session:merge-corr' });
    // Call-counted getSpace: the pre-route read + the hold read return an
    // active space; the post-route correction read throws.
    let reads = 0;
    ctx.spaceManager.getSpace = async () => {
      reads += 1;
      if (reads >= 3) throw new Error('db hiccup');
      return { id: SPACE_ID, stopped: false, paused: false } as never;
    };

    let caught: unknown;
    try {
      await ctx.runtime.dispatchPostApproval(task.id, 'agent');
    } catch (err) {
      caught = err;
    }
    expect((caught as Error).name).toBe('PostApprovalDeferredError');
    const final = ctx.taskRepo.getTask(task.id);
    expect(final?.status).toBe('approved');
    // The P1 assertion: the reason is stamped even on the unreadable path.
    expect(final?.postApprovalBlockedReason).toMatch(/could not be stop-corrected/);
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
      // The stop actually commits (the pre-kickoff assert window): the
      // wrapper's resumed-race compensation then reads a stopped space and
      // correctly does not fire.
      ctx.db.prepare(`UPDATE spaces SET stopped = 1 WHERE id = ?`).run(SPACE_ID);
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

  test('a stop committing mid-spawn: the router healthy stamp is corrected to the deferral', async () => {
    // The window neither the hold nor the spawner's pre-kickoff assert can
    // close: the dispatch passes both reads while the space is live, and the
    // stop commits during the kickoff-injection await. The router then stamps
    // `postApprovalSessionId` (pointing at the session the stop's cleanup just
    // interrupted) and clears the reason — without the post-route correction
    // the task wedges: every later guard counts the interrupted session alive,
    // the resume sweep filters on the (null) reason, and the tick blocks
    // spawns for approved tasks.
    const workflow = ctx.workflowManager.createWorkflow({
      spaceId: SPACE_ID,
      name: `Route race ${Date.now()}`,
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
    const tam = tamOf(ctx);
    tam.spawnPostApprovalSubSession = async () => {
      // The stop commits while the kickoff injection is in flight — after the
      // dispatch hold and the spawner's pre-kickoff assert both read live.
      ctx.db.prepare(`UPDATE spaces SET stopped = 1 WHERE id = ?`).run(SPACE_ID);
      return { sessionId: 'session:merge-raced' };
    };

    let caught: unknown;
    try {
      await ctx.runtime.dispatchPostApproval(task.id, 'agent');
    } catch (err) {
      caught = err;
    }
    expect((caught as Error).name).toBe('PostApprovalDeferredError');
    expect((caught as Error).message).toMatch(/landed while space .* stopped/);

    const final = ctx.taskRepo.getTask(task.id);
    expect(final?.status).toBe('approved');
    // The router's healthy stamp is corrected: pointer dropped (the interrupted
    // session must not pin the already-routed guard), reason recorded.
    expect(final?.postApprovalSessionId).toBeNull();
    expect(final?.postApprovalBlockedReason).toMatch(/merge session was interrupted/);
  });

  test('an injection dying under a stop converts to the deferral regardless of error type', async () => {
    // Same window, alternate ending: the stop's cleanup interrupts the
    // just-registered merger DURING the injection, so the spawner fails with a
    // raw error (not a TransientSpawnError). With a stop in force at the
    // catch's re-read, the durable deferral is the right record whatever the
    // error was.
    const workflow = ctx.workflowManager.createWorkflow({
      spaceId: SPACE_ID,
      name: `Route inj ${Date.now()}`,
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
    const tam = tamOf(ctx);
    tam.spawnPostApprovalSubSession = async () => {
      ctx.db.prepare(`UPDATE spaces SET stopped = 1 WHERE id = ?`).run(SPACE_ID);
      throw new Error('injection interrupted by cleanup');
    };

    let caught: unknown;
    try {
      await ctx.runtime.dispatchPostApproval(task.id, 'agent');
    } catch (err) {
      caught = err;
    }
    expect((caught as Error).name).toBe('PostApprovalDeferredError');

    const final = ctx.taskRepo.getTask(task.id);
    expect(final?.status).toBe('approved');
    expect(final?.postApprovalSessionId).toBeNull();
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
