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
  return { db, runtime, taskRepo, emitted, injected };
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
  // Stopped-space hold — post-approval work is NEW work; a stopped space must
  // not start it (the merge sub-session / inline Task Agent turn).
  // ---------------------------------------------------------------------------

  test('holds dispatch while the space is stopped (approved work deferred to resume)', async () => {
    const task = seedReviewTask(ctx.taskRepo);
    ctx.db.prepare(`UPDATE spaces SET stopped = 1 WHERE id = ?`).run(SPACE_ID);

    const result = await ctx.runtime.dispatchPostApproval(task.id, 'human', {});

    expect(result.mode).toBe('skipped');
    expect(result.reason).toContain('stopped');
    // Nothing was transitioned, emitted, or injected — the review status
    // persists and a resumed tick re-dispatches.
    expect(ctx.taskRepo.getTask(task.id)?.status).toBe('review');
    expect(ctx.emitted).toEqual([]);
    expect(ctx.injected).toEqual([]);
  });

  test('holds dispatch while the space is paused', async () => {
    const task = seedReviewTask(ctx.taskRepo);
    ctx.db.prepare(`UPDATE spaces SET paused = 1 WHERE id = ?`).run(SPACE_ID);

    const result = await ctx.runtime.dispatchPostApproval(task.id, 'human', {});

    expect(result.mode).toBe('skipped');
    expect(result.reason).toContain('paused');
    expect(ctx.taskRepo.getTask(task.id)?.status).toBe('review');
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
