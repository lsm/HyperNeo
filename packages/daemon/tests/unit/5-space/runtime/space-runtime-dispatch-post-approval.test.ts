import { SessionRepository } from '../../../../src/storage/repositories/session-repository';
import { JobQueueRepository } from '../../../../src/storage/repositories/job-queue-repository';
import { DirectTaskExecutionRepository } from '../../../../src/storage/repositories/direct-task-execution-repository';
import { createDirectTaskStarter } from '../../../../src/lib/space/runtime/start-direct-task';
import { createDirectOutcomeHandler } from '../../../../src/lib/space/runtime/direct-outcome-jobs';
import { createSpaceOperationRegistryProvider } from '../../../../src/lib/space/operations/registry';
import { createOperationRpcHandler } from '../../../../src/lib/operations/rpc-adapter';
import { createOperationMcpHandler } from '../../../../src/lib/operations/mcp-adapter';
import { SessionManager } from '../../../../src/lib/session/session-manager';
import type { AgentSession } from '../../../../src/lib/agent/agent-session';
import type { Database as AppDatabase } from '../../../../src/storage/database';
import type { CallContext, SpaceLongHorizonAgent } from '@hyperneo/shared';
import { PendingCompletionSupersededError } from '../../../../src/lib/space/operations/pending-completion-guard';
import { SpaceTaskManager } from '../../../../src/lib/space/managers/space-task-manager';
import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { Database as BunDatabase } from '../../../../src/storage/sqlite-compat';
import { createTables, runMigrations } from '../../../../src/storage/schema/index.ts';
import { SpaceWorkflowRepository } from '../../../../src/storage/repositories/space-workflow-repository.ts';
import { SpaceWorkflowRunRepository } from '../../../../src/storage/repositories/space-workflow-run-repository.ts';
import { SpaceTaskRepository } from '../../../../src/storage/repositories/space-task-repository.ts';
import { SpaceLongHorizonAgentRepository } from '../../../../src/storage/repositories/space-long-horizon-agent-repository.ts';
import { NodeExecutionRepository } from '../../../../src/storage/repositories/node-execution-repository.ts';
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
  createTables(db);
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
  workflowManager: SpaceWorkflowManager;
  workflowRunRepo: SpaceWorkflowRunRepository;
  emitted: Array<{ spaceId: string; task: SpaceTask }>;
  injected: string[];
  spawned: Array<{ targetAgent: string; kickoffMessage: string }>;
  cancelled: string[];
}

function buildRuntime(
  options: { prUrl?: string; onSpawn?: () => void; onSpaceLookup?: () => void | Promise<void> } = {}
): Ctx {
  const db = makeDb();
  const workflowRunRepo = new SpaceWorkflowRunRepository(db);
  const taskRepo = new SpaceTaskRepository(db);
  const nodeExecutionRepo = new NodeExecutionRepository(db);
  const agentRepo = new SpaceLongHorizonAgentRepository(db);
  const workflowRepo = new SpaceWorkflowRepository(db);
  const workflowManager = new SpaceWorkflowManager(workflowRepo);
  const realSpaceManager = new SpaceManager(db);
  const spaceManager = options.onSpaceLookup
    ? ({
        getSpace: async (id: string) => {
          await options.onSpaceLookup?.();
          return await realSpaceManager.getSpace(id);
        },
      } as unknown as SpaceManager)
    : realSpaceManager;

  const emitted: Array<{ spaceId: string; task: SpaceTask }> = [];
  const injected: string[] = [];
  const spawned: Ctx['spawned'] = [];
  const cancelled: string[] = [];
  const liveSessions = new Set<string>();
  const config: SpaceRuntimeConfig = {
    db,
    spaceManager,
    longHorizonAgentRepo: agentRepo,
    spaceWorkflowManager: workflowManager,
    workflowRunRepo,
    taskRepo,
    nodeExecutionRepo,
    onTaskUpdated: async ({ spaceId, task }) => {
      emitted.push({ spaceId, task });
    },
    ...(options.prUrl
      ? {
          artifactProfile: {
            resolvePrimaryLinkUrl: () => '',
            resolveInitialPrimaryLinkUrl: () => options.prUrl!,
            summarizeRunOutcome: () => null,
          },
        }
      : {}),
    taskAgentManager: {
      injectIntoTaskAgent: async (_taskId, message) => {
        injected.push(message);
        return { injected: false };
      },
      spawnPostApprovalSubSession: async (args: {
        targetAgent: string;
        kickoffMessage: string;
      }) => {
        options.onSpawn?.();
        spawned.push({
          targetAgent: args.targetAgent,
          kickoffMessage: args.kickoffMessage,
        });
        liveSessions.add('stub-session');
        return { sessionId: 'stub-session' };
      },
      isSessionAlive: (sessionId: string) => liveSessions.has(sessionId),
      isSessionOnPostApprovalRoute: () => true,
      cancelBySessionId: (sessionId: string) => {
        cancelled.push(sessionId);
      },
    } as unknown as NonNullable<SpaceRuntimeConfig['taskAgentManager']>,
  };

  const runtime = new SpaceRuntime(config);
  return {
    db,
    runtime,
    taskRepo,
    workflowManager,
    workflowRunRepo,
    emitted,
    injected,
    spawned,
    cancelled,
  };
}

function seedReviewTask(taskRepo: SpaceTaskRepository): SpaceTask {
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
    } catch {}
  });

  test.each(['reject', 'resubmit'] as const)(
    'approval loses when %s commits during awaited Space lookup',
    async (action) => {
      ctx.db.close();
      let taskId = '';
      let generation = 0;
      let changed = false;
      ctx = buildRuntime({
        onSpaceLookup: async () => {
          if (changed) return;
          changed = true;
          const competitor = new SpaceTaskManager(ctx.db, SPACE_ID);
          if (action === 'reject')
            await competitor.setTaskStatus(taskId, 'in_progress', {
              expectedPendingCompletionGeneration: generation,
            });
          else
            await competitor.submitTaskForReview(taskId, {
              submittedByNodeId: null,
              reason: 'new review',
            });
        },
      });
      const seeded = seedReviewTask(ctx.taskRepo);
      const pending = await new SpaceTaskManager(ctx.db, SPACE_ID).submitTaskForReview(seeded.id, {
        submittedByNodeId: null,
        reason: 'old review',
      });
      taskId = pending.id;
      generation = pending.pendingCompletionGeneration!;
      await expect(
        ctx.runtime.dispatchPostApproval(
          taskId,
          'human',
          { approvalReason: 'stale' },
          { expectedPendingCompletionGeneration: generation }
        )
      ).rejects.toBeInstanceOf(PendingCompletionSupersededError);
      expect(ctx.taskRepo.getTask(taskId)?.status).toBe(
        action === 'reject' ? 'in_progress' : 'review'
      );
      expect(ctx.taskRepo.getTask(taskId)?.pendingCompletionGeneration).toBe(
        action === 'reject' ? generation : generation + 1
      );
      expect(ctx.emitted).toEqual([]);
      expect(ctx.injected).toEqual([]);
      expect(ctx.spawned).toEqual([]);
      expect(ctx.cancelled).toEqual([]);
    }
  );

  test('forwards approvalReason from contextExtras to setTaskStatus (review → approved)', async () => {
    const task = seedReviewTask(ctx.taskRepo);

    await ctx.runtime.dispatchPostApproval(task.id, 'human', {
      approvalReason: 'LGTM — ship it',
    });

    const final = ctx.taskRepo.getTask(task.id);
    expect(final?.status).toBe('done');
    expect(final?.approvalSource).toBe('human');
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

  test('emits onTaskUpdated with status=done after no-route dispatch', async () => {
    const task = seedReviewTask(ctx.taskRepo);

    await ctx.runtime.dispatchPostApproval(task.id, 'agent');

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
    expect(ctx.emitted.some((e) => e.task.id === t.id && e.task.status === 'done')).toBe(true);
  });

  test('no-route dispatch does not inject informational Task Agent awareness', async () => {
    const task = seedReviewTask(ctx.taskRepo);

    await ctx.runtime.dispatchPostApproval(task.id, 'agent');

    expect(ctx.taskRepo.getTask(task.id)?.status).toBe('done');
    expect(ctx.injected).toHaveLength(0);
  });

  test('Layer B: clears all four pending-completion fields after no-route dispatch', async () => {
    const task = seedReviewTask(ctx.taskRepo);
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
    expect(final?.pendingCheckpointType).toBeNull();
    expect(final?.pendingCompletionSubmittedByNodeId).toBeNull();
    expect(final?.pendingCompletionSubmittedAt).toBeNull();
    expect(final?.pendingCompletionReason).toBeNull();
  });
});

describe('SpaceRuntime.retryPostApprovalDispatch — canonical serialized retry', () => {
  let ctx: Ctx;

  function seedBlockedRoutedTask(target: Ctx = ctx): SpaceTask {
    const workflow = target.workflowManager.createWorkflow({
      spaceId: SPACE_ID,
      name: 'Routed WF',
      description: '',
      nodes: [
        { id: 'n1', name: 'Build', agents: [{ agentId: 'coder-id', name: 'coder' }] },
        {
          id: 'n2',
          name: 'Reviewer',
          agents: [{ agentId: 'reviewer-id', name: 'reviewer' }],
          postApproval: {
            targetAgent: 'reviewer',
            instructions:
              'Merge {{pr_url}} under authority {{approval_authority}} in {{workspace_path}} for {{task_id}}.',
          },
        },
      ],
      startNodeId: 'n1',
      tags: [],
      completionAutonomyLevel: 3,
    });
    const run = target.workflowRunRepo.createRun({
      spaceId: SPACE_ID,
      workflowId: workflow.id,
      title: 'Ship it',
      description: '',
    });
    target.workflowRunRepo.updateStatusUnchecked(run.id, 'done');
    const task = target.taskRepo.createTask({
      spaceId: SPACE_ID,
      title: 'Ship it',
      description: '',
      status: 'in_progress',
      workflowRunId: run.id,
    });
    const approved = target.taskRepo.updateTask(task.id, {
      status: 'approved',
      approvalSource: 'human',
      approvedAt: Date.now(),
      postApprovalSourceNodeId: 'n2',
      postApprovalBlockedReason: 'post-approval spawn deferred: transient',
    });
    if (!approved) throw new Error('failed to seed blocked task');
    return approved;
  }

  beforeEach(() => {
    ctx = buildRuntime({ prUrl: 'https://github.com/lsm/HyperNeo/pull/7' });
  });
  afterEach(() => {
    try {
      ctx.db.close();
    } catch {}
  });

  test('re-dispatches through the normal full context and clears the blocked reason', async () => {
    const task = seedBlockedRoutedTask();

    const result = await ctx.runtime.retryPostApprovalDispatch(task.id);

    expect(result.mode).toBe('spawn');
    expect(ctx.spawned).toHaveLength(1);
    expect(ctx.spawned[0].targetAgent).toBe('reviewer');
    expect(ctx.spawned[0].kickoffMessage).toContain('https://github.com/lsm/HyperNeo/pull/7');
    expect(ctx.spawned[0].kickoffMessage).toContain('Reviewer');
    expect(ctx.spawned[0].kickoffMessage).toContain('/tmp/ws');
    expect(ctx.spawned[0].kickoffMessage).toContain(task.id);
    const final = ctx.taskRepo.getTask(task.id);
    expect(final?.status).toBe('approved');
    expect(final?.postApprovalSessionId).toBe('stub-session');
    expect(final?.postApprovalBlockedReason).toBeNull();
    expect(ctx.emitted.some((e) => e.task.id === task.id && e.task.status === 'approved')).toBe(
      true
    );
  });

  test('concurrent retries for one task produce one spawn and one skip', async () => {
    const task = seedBlockedRoutedTask();

    const results = await Promise.all([
      ctx.runtime.retryPostApprovalDispatch(task.id),
      ctx.runtime.retryPostApprovalDispatch(task.id),
    ]);

    const spawns = results.filter((r) => r.mode === 'spawn');
    const skips = results.filter((r) => r.mode === 'skipped');
    expect(spawns).toHaveLength(1);
    expect(skips).toHaveLength(1);
    expect(ctx.spawned).toHaveLength(1);
    expect(ctx.taskRepo.getTask(task.id)?.postApprovalSessionId).toBe('stub-session');
  });

  test('an unblocked approved task does not re-dispatch through retry', async () => {
    const task = seedBlockedRoutedTask();
    ctx.taskRepo.updateTask(task.id, { postApprovalBlockedReason: null });

    const result = await ctx.runtime.retryPostApprovalDispatch(task.id);

    expect(result.mode).toBe('skipped');
    expect(ctx.spawned).toHaveLength(0);
  });

  test('retry on a task without a recorded approval source dispatches without re-stamping', async () => {
    const task = seedBlockedRoutedTask();
    ctx.taskRepo.updateTask(task.id, { approvalSource: null });

    const result = await ctx.runtime.retryPostApprovalDispatch(task.id);

    expect(result.mode).toBe('spawn');
    expect(ctx.taskRepo.getTask(task.id)?.approvalSource).toBeNull();
  });

  test('requireAlreadyApproved dispatch refuses to approve a review checkpoint', async () => {
    const task = seedReviewTask(ctx.taskRepo);
    ctx.taskRepo.updateTask(task.id, {
      pendingCheckpointType: 'task_completion',
      pendingCompletionSubmittedByNodeId: 'node-review',
      pendingCompletionSubmittedAt: Date.now(),
      pendingCompletionReason: 'ready for human review',
    });

    const result = await ctx.runtime.dispatchPostApproval(
      task.id,
      'human',
      {},
      {
        requireAlreadyApproved: true,
      }
    );

    expect(result.mode).toBe('skipped');
    const final = ctx.taskRepo.getTask(task.id);
    expect(final?.status).toBe('review');
    expect(final?.approvalSource).toBeNull();
    expect(final?.pendingCheckpointType).toBe('task_completion');
    expect(final?.pendingCompletionSubmittedByNodeId).toBe('node-review');
    expect(ctx.spawned).toHaveLength(0);
  });

  test('expected generation guards refuse a dispatch after re-parenting or re-approval', async () => {
    const task = seedBlockedRoutedTask();

    const reparented = await ctx.runtime.dispatchPostApproval(
      task.id,
      'human',
      {},
      {
        requireAlreadyApproved: true,
        expectedWorkflowRunId: 'run-other',
        expectedApprovedAt: task.approvedAt ?? null,
      }
    );
    expect(reparented.mode).toBe('skipped');
    if (reparented.mode === 'skipped') {
      expect(reparented.reason).toContain('re-parented');
    }

    const reapproved = await ctx.runtime.dispatchPostApproval(
      task.id,
      'human',
      {},
      {
        requireAlreadyApproved: true,
        expectedWorkflowRunId: task.workflowRunId ?? null,
        expectedApprovedAt: (task.approvedAt ?? 0) + 5,
      }
    );
    expect(reapproved.mode).toBe('skipped');
    if (reapproved.mode === 'skipped') {
      expect(reapproved.reason).toContain('approval generation');
    }

    expect(ctx.spawned).toHaveLength(0);
  });

  test('retry dispatch cancels the spawned worker when the run was re-activated mid-flight', async () => {
    let runIdToFlip: string | null = null;
    const reactive = buildRuntime({
      prUrl: 'https://github.com/lsm/HyperNeo/pull/7',
      onSpawn: () => {
        if (runIdToFlip) {
          reactive.workflowRunRepo.updateStatusUnchecked(runIdToFlip, 'in_progress');
        }
      },
    });
    const task = seedBlockedRoutedTask(reactive);
    runIdToFlip = task.workflowRunId ?? null;

    const result = await reactive.runtime.retryPostApprovalDispatch(task.id);

    expect(result.mode).toBe('skipped');
    expect(reactive.cancelled).toEqual(['stub-session']);
    expect(reactive.taskRepo.getTask(task.id)?.postApprovalSessionId).toBeNull();
  });

  test('retry dispatch refuses a generation flipped during the awaited space lookup', async () => {
    let flip: (() => void) | null = null;
    let lookups = 0;
    const reactive = buildRuntime({
      prUrl: 'https://github.com/lsm/HyperNeo/pull/7',
      onSpaceLookup: () => {
        lookups += 1;
        if (lookups > 1) flip?.();
      },
    });
    const task = seedBlockedRoutedTask(reactive);
    flip = () => {
      reactive.taskRepo.updateTask(task.id, { approvedAt: Date.now() + 9000 });
    };

    const result = await reactive.runtime.retryPostApprovalDispatch(task.id);

    expect(result.mode).toBe('skipped');
    if (result.mode === 'skipped') {
      expect(result.reason).toContain('awaiting lookups');
    }
    expect(reactive.spawned).toHaveLength(0);
    expect(reactive.taskRepo.getTask(task.id)?.postApprovalSessionId).toBeNull();
  });

  test('retry dispatch refuses when the space becomes inactive during the dispatch lookup', async () => {
    let lookups = 0;
    const reactive = buildRuntime({
      onSpaceLookup: () => {
        lookups += 1;
        if (lookups > 1) {
          reactive.db.prepare(`UPDATE spaces SET paused = 1 WHERE id = ?`).run(SPACE_ID);
        }
      },
    });
    const task = seedBlockedRoutedTask(reactive);

    const result = await reactive.runtime.retryPostApprovalDispatch(task.id);

    expect(result.mode).toBe('skipped');
    if (result.mode === 'skipped') {
      expect(result.reason).toContain('space became inactive');
    }
    expect(reactive.taskRepo.getTask(task.id)?.status).toBe('approved');
  });

  test('retry dispatch refuses a re-activated run before no-route completion', async () => {
    let activeRunId = '';
    const reactive = buildRuntime({
      onSpaceLookup: () => {
        if (activeRunId) {
          reactive.workflowRunRepo.updateStatusUnchecked(activeRunId, 'in_progress');
        }
      },
    });
    const workflow = reactive.workflowManager.createWorkflow({
      spaceId: SPACE_ID,
      name: 'No-route WF',
      description: '',
      nodes: [{ id: 'n1', name: 'Build', agents: [{ agentId: 'coder-id', name: 'coder' }] }],
      startNodeId: 'n1',
      tags: [],
      completionAutonomyLevel: 3,
    });
    const run = reactive.workflowRunRepo.createRun({
      spaceId: SPACE_ID,
      workflowId: workflow.id,
      title: 'Ship it',
      description: '',
    });
    reactive.workflowRunRepo.updateStatusUnchecked(run.id, 'done');
    const task = reactive.taskRepo.createTask({
      spaceId: SPACE_ID,
      title: 'Ship it',
      description: '',
      status: 'in_progress',
      workflowRunId: run.id,
    });
    reactive.taskRepo.updateTask(task.id, {
      status: 'approved',
      approvalSource: 'human',
      approvedAt: Date.now(),
      postApprovalBlockedReason: 'post-approval completion threw after approval',
    });
    activeRunId = run.id;

    const result = await reactive.runtime.retryPostApprovalDispatch(task.id);

    expect(result.mode).toBe('skipped');
    expect(reactive.taskRepo.getTask(task.id)?.status).toBe('approved');
  });
});

test.each(['rpc', 'mcp'] as const)(
  'direct task completes through shared %s approval without a workflow',
  async (source) => {
    const context = buildRuntime();
    const { db, taskRepo, runtime } = context;
    try {
      const sessions = new SessionRepository(db);
      const jobs = new JobQueueRepository(db);
      const attempts = new DirectTaskExecutionRepository(db);
      const task = taskRepo.createTask({ spaceId: SPACE_ID, title: 'Direct', description: '' });
      let cached: AgentSession | null = null;
      const starter = createDirectTaskStarter({
        db,
        defaultModel: 'claude-sonnet-4-6',
        sessionDb: {
          getSession: (id) => sessions.getSession(id),
          createSession: (session) =>
            sessions.createSession(session, { enforceWorkspaceOwnership: false }),
        },
        sessionManager: {
          getCachedSession: () => cached ?? undefined,
          getSessionForControl: async (id) => {
            cached = {
              getSessionData: () => sessions.getSession(id)!,
              isQueryActiveOrStarting: () => false,
              getProcessingState: () => ({ status: 'idle' }),
              isInterruptInProgress: () => false,
              getTrackedAgentRootPidsSplit: () => ({ live: [], exited: [] }),
              handleInterrupt: async () => {},
              cleanup: async () => {},
            } as unknown as AgentSession;
            return cached;
          },
          unregisterSession: async () => {
            cached = null;
          },
        },
      });
      const started = await starter({ taskId: task.id, requestKey: 'first' });
      if (!started.started) throw new Error(started.reason);
      const coordinatorId = `space:chat:${SPACE_ID}`;
      sessions.createSession(
        {
          ...sessions.getSession(started.attempt.sessionId)!,
          id: coordinatorId,
          type: 'space_chat',
          context: { spaceId: SPACE_ID },
        },
        { enforceWorkspaceOwnership: false }
      );
      const manager = new SpaceTaskManager(db, SPACE_ID);
      const getTaskManager = () => manager;
      const emitTaskUpdated = async (_spaceId: string, updated: SpaceTask) => {
        context.emitted.push({ spaceId: SPACE_ID, task: updated });
      };
      const provider = createSpaceOperationRegistryProvider(
        { getDatabase: () => db, notifyChange: () => {} } as unknown as AppDatabase,
        jobs,
        {
          getSession: (id) => sessions.getSession(id),
          getTaskManager,
          taskRepo,
          notifyStandalone: () => {},
          emitTaskUpdated,
          blockExecution: async () => {
            throw new Error('unexpected workflow stop');
          },
        },
        {
          getSession: (id) => sessions.getSession(id),
          getTask: (id) => taskRepo.getTask(id),
          getTaskManager,
          coordinatorLookup: {
            getCoordinator: () => ({ id: 'coordinator' }) as SpaceLongHorizonAgent,
          },
          dispatchApproval: (_spaceId, id, approvalSource, reason, guard) =>
            runtime.dispatchPostApproval(id, approvalSource, { approvalReason: reason }, guard),
          warn: () => {
            throw new Error('unexpected approval failure');
          },
          emitTaskUpdated,
          audit: () => {},
        }
      );
      const worker = createOperationMcpHandler(provider, () => ({
        sessionId: started.attempt.sessionId,
      }));
      const submitted = JSON.parse(
        (
          await worker({
            name: 'task.submitForReview',
            input: { taskId: task.id, reason: 'Ready' },
          })
        ).content[0].text
      ) as { accepted: boolean; jobId: string };
      expect(submitted.accepted).toBe(true);
      expect(taskRepo.getTask(task.id)?.status).toBe('in_progress');
      const owner = Object.assign(Object.create(SessionManager.prototype), {
        directStopVerificationJobs: new Map(),
      }) as SessionManager;
      const finalized = await createDirectOutcomeHandler({
        db,
        jobQueue: jobs,
        sessionManager: {
          coalesceDirectStopVerification: owner.coalesceDirectStopVerification.bind(owner),
          getCachedSession: () => cached,
          isSessionLoading: () => false,
          unregisterSession: async () => {
            cached = null;
          },
        },
      })(jobs.getJob(submitted.jobId)!);
      expect(finalized).toMatchObject({ finalized: true });
      expect(taskRepo.getTask(task.id)).toMatchObject({
        status: 'review',
        pendingCheckpointType: 'task_completion',
        pendingCompletionSubmittedByNodeId: null,
        pendingCompletionReason: 'Ready',
      });
      expect(attempts.getActive(task.id)).toBeNull();
      const invocation = {
        name: 'task.resolvePendingCompletion',
        input: { taskId: task.id, approved: true, reason: 'Accepted' },
      };
      const approved =
        source === 'rpc'
          ? await createOperationRpcHandler(provider, () => ({}))(invocation, {} as CallContext)
          : JSON.parse(
              (
                await createOperationMcpHandler(provider, () => ({ sessionId: coordinatorId }))(
                  invocation
                )
              ).content[0].text
            );
      expect(approved).toMatchObject({
        status: 'done',
        approvalSource: 'human',
        approvalReason: 'Accepted',
      });
      expect(taskRepo.getTask(task.id)).toMatchObject({
        status: 'done',
        workflowRunId: null,
        pendingCheckpointType: null,
      });
      expect(attempts.get(started.attempt.id)?.phase).toBe('stopped');
      expect(context.spawned).toEqual([]);
      expect(context.injected).toEqual([]);
      expect(
        context.emitted.some(
          ({ task: updated }) => updated.id === task.id && updated.status === 'done'
        )
      ).toBe(true);
    } finally {
      db.close();
    }
  }
);
