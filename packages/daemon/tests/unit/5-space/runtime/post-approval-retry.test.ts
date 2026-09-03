import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import type { Space, SpaceTask, SpaceWorkflow, SpaceWorkflowRun } from '@hyperneo/shared';
import {
  applyDispatch,
  applyLoadTask,
  applyRetryEligibility,
  applyRunEligibility,
  type PostApprovalRetryCtx,
  type PostApprovalRetryDeps,
  runPostApprovalRetry,
  TaskScopedRetrySerializer,
} from '../../../../src/lib/space/runtime/post-approval-retry.ts';
import { PostApprovalRouter } from '../../../../src/lib/space/runtime/post-approval-router.ts';
import { SpaceTaskRepository } from '../../../../src/storage/repositories/space-task-repository.ts';
import { runMigrations } from '../../../../src/storage/schema/index.ts';
import { Database as BunDatabase } from '../../../../src/storage/sqlite-compat';

const SPACE_ID = 'space-par-retry';
const RUN_ID = 'run-retry-1';

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
     VALUES ('wf-retry', ?, 'Retry WF', ?, ?)`
  ).run(SPACE_ID, Date.now(), Date.now());
  db.prepare(
    `INSERT INTO space_workflow_runs (id, space_id, workflow_id, title, status, created_at, updated_at)
     VALUES (?, ?, 'wf-retry', 'Retry run', 'done', ?, ?)`
  ).run(RUN_ID, SPACE_ID, Date.now(), Date.now());
  db.prepare(
    `INSERT INTO space_workflow_runs (id, space_id, workflow_id, title, status, created_at, updated_at)
     VALUES ('run-other', ?, 'wf-retry', 'Other run', 'done', ?, ?)`
  ).run(SPACE_ID, Date.now(), Date.now());
  return db;
}

function stubWorkflow(): SpaceWorkflow {
  return {
    id: 'wf-retry',
    spaceId: SPACE_ID,
    name: 'Retry WF',
    nodes: [
      {
        id: 'n1',
        name: 'Merger',
        agents: [{ agentId: 'merger-id', name: 'merger' }],
        postApproval: { targetAgent: 'merger', instructions: 'Merge {{task_title}}.' },
      },
    ],
    startNodeId: 'n1',
    endNodeId: 'n1',
    tags: [],
    createdAt: Date.now(),
    updatedAt: Date.now(),
    completionAutonomyLevel: 3,
  };
}

function seedBlockedTask(
  repo: SpaceTaskRepository,
  overrides: {
    status?: string;
    workflowRunId?: string | null;
    blockedReason?: string | null;
  } = {}
): SpaceTask {
  const task = repo.createTask({
    spaceId: SPACE_ID,
    title: 'Ship it',
    description: '',
    status: 'in_progress',
    workflowRunId: overrides.workflowRunId === undefined ? RUN_ID : overrides.workflowRunId,
  });
  const updated = repo.updateTask(task.id, {
    status: 'approved',
    approvalSource: 'human',
    approvedAt: Date.now(),
    postApprovalBlockedReason:
      overrides.blockedReason === undefined
        ? 'post-approval spawn deferred: transient'
        : overrides.blockedReason,
    ...(overrides.status ? { status: overrides.status as 'done' } : {}),
  });
  if (!updated) throw new Error('failed to seed task');
  return updated;
}

interface Harness {
  repo: SpaceTaskRepository;
  deps: PostApprovalRetryDeps;
  dispatchCalls: Array<{ taskId: string; approvalSource: string }>;
}

function makeHarness(
  db: BunDatabase,
  options: {
    spaceOverrides?: Partial<Space>;
    dispatchImpl?: PostApprovalRetryDeps['dispatch'];
  } = {}
): Harness {
  const repo = new SpaceTaskRepository(db);
  const dispatchCalls: Harness['dispatchCalls'] = [];
  const space: Space = {
    id: SPACE_ID,
    slug: SPACE_ID,
    workspacePath: '/tmp/ws',
    name: 'Space',
    description: '',
    backgroundContext: '',
    instructions: '',
    sessionIds: [],
    status: 'active',
    paused: false,
    stopped: false,
    maxConcurrentTasks: 2,
    createdAt: Date.now(),
    updatedAt: Date.now(),
    ...(options.spaceOverrides ?? {}),
  };
  let spawnCount = 0;
  const deps: PostApprovalRetryDeps = {
    taskRepo: repo,
    workflowRunRepo: {
      getRun: (id: string) =>
        db
          .prepare('SELECT * FROM space_workflow_runs WHERE id = ?')
          .get(id) as unknown as SpaceWorkflowRun | null,
    },
    spaceManager: { getSpace: async () => space },
    dispatch:
      options.dispatchImpl ??
      (async (taskId, approvalSource) => {
        dispatchCalls.push({ taskId, approvalSource });
        spawnCount += 1;
        return {
          mode: 'spawn',
          postApprovalSessionId: `worker-${spawnCount}`,
          postApprovalStartedAt: Date.now(),
          missingKeys: [],
        };
      }),
  };
  return { repo, deps, dispatchCalls };
}

function ctxFor(h: Harness, taskId: string, task: SpaceTask | null): PostApprovalRetryCtx {
  return { ...h.deps, taskId, task, result: null, halt: null };
}

describe('post-approval retry pipeline stages', () => {
  let db: BunDatabase;
  let h: Harness;

  beforeEach(() => {
    db = makeDb();
    h = makeHarness(db);
  });
  afterEach(() => {
    db.close();
  });

  test('applyLoadTask halts on a missing task', () => {
    const ctx = applyLoadTask(ctxFor(h, 'nope', null));
    expect(ctx.halt).toContain('not found');
  });

  test('applyRetryEligibility halts when not approved', () => {
    const task = seedBlockedTask(h.repo, { status: 'done' });
    const ctx = applyRetryEligibility(ctxFor(h, task.id, h.repo.getTask(task.id)));
    expect(ctx.halt).toContain('not approved');
  });

  test('applyRetryEligibility halts without a blocked dispatch reason', () => {
    const task = seedBlockedTask(h.repo, { blockedReason: null });
    const ctx = applyRetryEligibility(ctxFor(h, task.id, h.repo.getTask(task.id)));
    expect(ctx.halt).toContain('no blocked dispatch');
  });

  test('applyRetryEligibility halts for a standalone task', () => {
    const task = seedBlockedTask(h.repo, { workflowRunId: null });
    const ctx = applyRetryEligibility(ctxFor(h, task.id, h.repo.getTask(task.id)));
    expect(ctx.halt).toContain('not bound to a workflow run');
  });

  test('applyRunEligibility halts on a cancelled run', () => {
    db.prepare(`UPDATE space_workflow_runs SET status = 'cancelled' WHERE id = ?`).run(RUN_ID);
    const task = seedBlockedTask(h.repo);
    const ctx = applyRunEligibility(ctxFor(h, task.id, h.repo.getTask(task.id)));
    expect(ctx.halt).toContain('cancelled');
  });

  test('applyRunEligibility halts on an uncompleted run (post-approval waits for run success)', () => {
    db.prepare(`UPDATE space_workflow_runs SET status = 'in_progress' WHERE id = ?`).run(RUN_ID);
    const task = seedBlockedTask(h.repo);
    const ctx = applyRunEligibility(ctxFor(h, task.id, h.repo.getTask(task.id)));
    expect(ctx.halt).toContain('in_progress');
    expect(ctx.halt).toContain('not a completed run');
  });

  test('applyDispatch re-dispatches with the recorded approval source', async () => {
    const task = seedBlockedTask(h.repo);
    const ctx = await applyDispatch(ctxFor(h, task.id, h.repo.getTask(task.id)));
    expect(ctx.halt).toBeNull();
    expect(h.dispatchCalls).toEqual([{ taskId: task.id, approvalSource: 'human' }]);
    expect(ctx.result?.mode).toBe('spawn');
  });

  test('applyDispatch records a blocked reason when the dispatch throws and the task stays approved', async () => {
    const task = seedBlockedTask(h.repo);
    const throwing = makeHarness(db, {
      dispatchImpl: async () => {
        throw new Error('spawn failed: ENOTFOUND');
      },
    });
    const ctx = await applyDispatch(ctxFor(throwing, task.id, throwing.repo.getTask(task.id)));
    expect(ctx.result?.mode).toBe('skipped');
    expect(throwing.repo.getTask(task.id)?.postApprovalBlockedReason).toContain(
      'Approval recorded'
    );
  });

  test('applyDispatch does not stamp a blocked reason after the task re-parented mid-dispatch', async () => {
    const task = seedBlockedTask(h.repo);
    const reparented = makeHarness(db, {
      dispatchImpl: async (taskId) => {
        reparented.repo.updateTask(taskId, { workflowRunId: 'run-other' });
        throw new Error('spawn failed: ENOTFOUND');
      },
    });
    const ctx = await applyDispatch(ctxFor(reparented, task.id, reparented.repo.getTask(task.id)));
    expect(ctx.result?.mode).toBe('skipped');
    expect(reparented.repo.getTask(task.id)?.postApprovalBlockedReason).not.toContain(
      'Approval recorded'
    );
  });

  test('applyDispatch does not stamp a blocked reason after a new approval generation', async () => {
    const task = seedBlockedTask(h.repo);
    const reapproved = makeHarness(db, {
      dispatchImpl: async (taskId) => {
        reapproved.repo.updateTask(taskId, { approvedAt: Date.now() + 1000 });
        throw new Error('spawn failed: ENOTFOUND');
      },
    });
    const ctx = await applyDispatch(ctxFor(reapproved, task.id, reapproved.repo.getTask(task.id)));
    expect(ctx.result?.mode).toBe('skipped');
    expect(reapproved.repo.getTask(task.id)?.postApprovalBlockedReason).not.toContain(
      'Approval recorded'
    );
  });

  test('applyDispatch does not stamp blocked after a concurrent routing recorded its worker', async () => {
    const task = seedBlockedTask(h.repo);
    const raced = makeHarness(db, {
      dispatchImpl: async (taskId) => {
        raced.repo.casPostApprovalRouting(
          taskId,
          {
            workflowRunId: task.workflowRunId ?? null,
            approvedAt: task.approvedAt ?? null,
            priorPostApprovalSessionId: null,
          },
          { postApprovalSessionId: 'winner-session', postApprovalStartedAt: Date.now() }
        );
        throw new Error('inject failed: websocket gone');
      },
    });
    const ctx = await applyDispatch(ctxFor(raced, task.id, raced.repo.getTask(task.id)));
    expect(ctx.result?.mode).toBe('skipped');
    expect(raced.repo.getTask(task.id)?.postApprovalBlockedReason).not.toContain(
      'Approval recorded'
    );
    expect(raced.repo.getTask(task.id)?.postApprovalSessionId).toBe('winner-session');
  });

  test('full retry halts on an inactive space without dispatching', async () => {
    const paused = makeHarness(db, { spaceOverrides: { paused: true } });
    const task = seedBlockedTask(paused.repo);
    const result = await runPostApprovalRetry({ ...paused.deps, taskId: task.id });
    expect(result.mode).toBe('skipped');
    if (result.mode === 'skipped') expect(result.reason).toContain('paused');
  });
});

describe('runPostApprovalRetry — concurrency against the real CAS', () => {
  let db: BunDatabase;

  beforeEach(() => {
    db = makeDb();
  });
  afterEach(() => {
    db.close();
  });

  test('concurrent retries for one task produce one routed result and no duplicate kickoff', async () => {
    const repo = new SpaceTaskRepository(db);
    const workflow = stubWorkflow();
    const router = new PostApprovalRouter({
      taskRepo: repo,
      spawner: {
        spawnPostApprovalSubSession: async () => ({ sessionId: 'worker-routed' }),
      },
      livenessProbe: { isSessionAlive: () => false },
    });
    const h = makeHarness(db, {
      dispatchImpl: async (taskId) =>
        router.route(repo.getTask(taskId)!, workflow, {
          approvalSource: 'human',
          task_title: 'Ship it',
        }),
    });
    const task = seedBlockedTask(h.repo);
    const queue = new TaskScopedRetrySerializer();
    const results = await Promise.all(
      [1, 2, 3].map(() =>
        queue.run(task.id, () => runPostApprovalRetry({ ...h.deps, taskId: task.id }))
      )
    );
    const spawns = results.filter((r) => r.mode === 'spawn');
    const skips = results.filter((r) => r.mode === 'skipped');
    expect(spawns).toHaveLength(1);
    expect(skips).toHaveLength(2);
    const final = h.repo.getTask(task.id);
    expect(final?.postApprovalSessionId).toBe('worker-routed');
    expect(final?.postApprovalBlockedReason).toBeNull();
  });
});

describe('TaskScopedRetrySerializer', () => {
  test('serializes ops for the same task and frees the slot afterwards', async () => {
    const queue = new TaskScopedRetrySerializer();
    const order: string[] = [];
    const makeOp = (label: string, ms: number) => async () => {
      await new Promise((resolve) => setTimeout(resolve, ms));
      order.push(label);
      return label;
    };
    const first = queue.run('task-a', makeOp('a1', 30));
    const second = queue.run('task-a', makeOp('a2', 1));
    await Promise.all([first, second]);
    expect(order).toEqual(['a1', 'a2']);
    await expect(queue.run('task-a', makeOp('a3', 0))).resolves.toBe('a3');
  });

  test('a failing op does not block later retries for the same task', async () => {
    const queue = new TaskScopedRetrySerializer();
    const failing = queue.run('task-a', async () => {
      throw new Error('boom');
    });
    await expect(failing).rejects.toThrow('boom');
    await expect(queue.run('task-a', async () => 'ok')).resolves.toBe('ok');
  });

  test('different tasks do not queue behind each other', async () => {
    const queue = new TaskScopedRetrySerializer();
    const order: string[] = [];
    const slow = queue.run('task-a', async () => {
      await new Promise((resolve) => setTimeout(resolve, 40));
      order.push('a');
    });
    const fast = queue.run('task-b', async () => {
      order.push('b');
    });
    await Promise.all([slow, fast]);
    expect(order).toEqual(['b', 'a']);
  });
});
