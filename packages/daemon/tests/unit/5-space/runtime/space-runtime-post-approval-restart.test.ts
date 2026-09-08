import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import type { SpaceWorkflow } from '@hyperneo/shared';
import { SpaceManager } from '../../../../src/lib/space/managers/space-manager.ts';
import { SpaceWorkflowManager } from '../../../../src/lib/space/managers/space-workflow-manager.ts';
import type { SpaceRuntimeConfig } from '../../../../src/lib/space/runtime/space-runtime.ts';
import { SpaceRuntime } from '../../../../src/lib/space/runtime/space-runtime.ts';
import { NodeExecutionRepository } from '../../../../src/storage/repositories/node-execution-repository';
import { SDKMessageRepository } from '../../../../src/storage/repositories/sdk-message-repository';
import { SpaceLongHorizonAgentRepository } from '../../../../src/storage/repositories/space-long-horizon-agent-repository.ts';
import { SpaceTaskRepository } from '../../../../src/storage/repositories/space-task-repository.ts';
import { SpaceWorkflowRepository } from '../../../../src/storage/repositories/space-workflow-repository.ts';
import { SpaceWorkflowRunRepository } from '../../../../src/storage/repositories/space-workflow-run-repository.ts';
import { runMigrations } from '../../../../src/storage/schema/index.ts';
import { Database as BunDatabase } from '../../../../src/storage/sqlite-compat';
import { seedUnifiedAgentMirror } from '../../helpers/seed-unified-agent';

function makeDb(): BunDatabase {
  const db = new BunDatabase(':memory:');
  db.exec('PRAGMA foreign_keys = ON');
  runMigrations(db, () => {});
  db.exec(`
		CREATE TABLE IF NOT EXISTS sdk_messages (
			id TEXT PRIMARY KEY,
			session_id TEXT NOT NULL,
			message_type TEXT NOT NULL,
			message_subtype TEXT,
			sdk_message TEXT NOT NULL,
			timestamp TEXT NOT NULL,
			send_status TEXT,
			origin TEXT,
			is_renderable INTEGER NOT NULL DEFAULT 1,
			is_terminal INTEGER NOT NULL DEFAULT 0,
			conversation_turn_index INTEGER,
			parent_tool_use_id TEXT,
			task_id TEXT,
			sdk_uuid TEXT,
			replacement_metadata_normalized INTEGER NOT NULL DEFAULT 0
		);
		CREATE TABLE IF NOT EXISTS sdk_message_replacements (
			source_message_id TEXT NOT NULL,
			session_id TEXT NOT NULL,
			task_id TEXT,
			target_uuid TEXT NOT NULL,
			kind TEXT NOT NULL CHECK(kind IN ('superseded', 'retracted')),
			PRIMARY KEY (source_message_id, target_uuid, kind)
		);
		CREATE INDEX IF NOT EXISTS idx_sdk_messages_task_id ON sdk_messages(task_id);
	`);
  return db;
}

function seedSpaceRow(db: BunDatabase, spaceId: string, maxConcurrentTasks = 1): void {
  db.prepare(
    `INSERT INTO spaces (id, workspace_path, name, description, background_context, instructions,
     allowed_models, session_ids, slug, status, max_concurrent_tasks, created_at, updated_at)
     VALUES (?, '/tmp/ws-3821', ?, '', '', '', '[]', '[]', ?, 'active', ?, ?, ?)`
  ).run(spaceId, `Space ${spaceId}`, spaceId, maxConcurrentTasks, Date.now(), Date.now());
}

function buildLinearWorkflow(
  spaceId: string,
  workflowManager: SpaceWorkflowManager,
  nodes: Array<{ id: string; name: string; agentId: string }>
): SpaceWorkflow {
  const transitions = nodes.slice(0, -1).map((step, i) => ({
    from: step.id,
    to: nodes[i + 1].id,
    condition: { type: 'always' as const },
    order: 0,
  }));
  return workflowManager.createWorkflow({
    spaceId,
    name: `WF-3821-${Date.now()}-${Math.random()}`,
    description: 'Test',
    nodes,
    transitions,
    startNodeId: nodes[0].id,
    rules: [],
    tags: [],
    completionAutonomyLevel: 3,
  });
}

interface TamMockOptions {
  alive?: Set<string>;
  spawnImpl?: () => Promise<{ sessionId: string }>;
  onSpawnExecution?: () => void;
  adoption?: {
    orphanSessionId: string;
    disposed?: boolean;
    stopDuringRestore?: boolean;
    failResume?: boolean;
  };
  revivable?: string[];
  terminalRestoreIds?: string[];
  notAdmittedRestoreIds?: string[];
  offRouteSessionIds?: string[];
}

function makeTaskAgentManagerMock(options: TamMockOptions = {}) {
  const aliveSessionIds = options.alive ?? new Set<string>();
  const spawnPostApprovalImpl = options.spawnImpl;
  const onSpawnExecution = options.onSpawnExecution;
  const adoption = options.adoption;
  const cancelled: string[] = [];
  const restoreCalls: Array<{ sessionId: string; deferredStart: boolean }> = [];
  const queryActiveIds = new Set<string>();
  let runtimeRef: { stop: () => Promise<void> } | null = null;
  return {
    isSessionAlive: (sessionId: string) => aliveSessionIds.has(sessionId),
    isSessionInMemory: (sessionId: string) => aliveSessionIds.has(sessionId),
    isSessionWorkerForTask: () => false,
    isSessionOnPostApprovalRoute: () => options.offRouteSessionIds === undefined,
    cancelBySessionId: (sessionId: string) => {
      cancelled.push(sessionId);
    },
    spawnPostApprovalSubSession:
      spawnPostApprovalImpl ??
      (async () => {
        throw new Error('unexpected post-approval spawn in this suite');
      }),
    getPostApprovalWorkerSession: adoption
      ? () => ({ sessionId: adoption.orphanSessionId, agentName: 'Code', nodeId: null })
      : undefined,
    restorePostApprovalWorkerSession: async (
      _taskId: string,
      sessionId: string,
      _supplied: unknown,
      restoreOptions?: { startQuery?: boolean }
    ) => {
      const durable =
        (adoption && sessionId === adoption.orphanSessionId) ||
        options.revivable?.includes(sessionId);
      if (!durable) return null;
      if (adoption?.stopDuringRestore && runtimeRef) {
        void runtimeRef.stop();
      }
      restoreCalls.push({ sessionId, deferredStart: restoreOptions?.startQuery === false });
      if (options.terminalRestoreIds?.includes(sessionId)) return sessionId;
      if (adoption?.failResume && restoreOptions?.startQuery !== false) {
        aliveSessionIds.delete(sessionId);
        return sessionId;
      }
      aliveSessionIds.add(sessionId);
      if (!options.notAdmittedRestoreIds?.includes(sessionId)) {
        queryActiveIds.add(sessionId);
      }
      return sessionId;
    },
    isSpawning: () => false,
    isTaskAgentAlive: () => false,
    isExecutionSpawning: () => false,
    isDisposed: () => adoption?.disposed === true,
    hasPendingRateLimitCooldown: () => false,
    stopSessionsVerified: async (sessionIds: string[]) =>
      sessionIds.map((sessionId) => ({ sessionId, stopped: true })),
    isSessionQueryActiveOrStarting: (sessionId: string) => queryActiveIds.has(sessionId),
    setRuntimeRef: (ref: { stop: () => Promise<void> }) => {
      runtimeRef = ref;
    },
    spawnWorkflowNodeAgent: async () => 'session:spawned',
    spawnWorkflowNodeAgentForExecution: async () => {
      onSpawnExecution?.();
      return 'session:spawned';
    },
    rehydrate: async () => {},
    interruptBySessionId: async () => {},
    restartStuckSubSession: async () => {},
    injectRuntimeRecoveryMessage: async (sessionId: string) => `runtime-nag:${sessionId}`,
    getAgentSessionById: () => null,
    injectIntoTaskAgent: async () => ({ injected: false, reason: 'no-session' }),
    _cancelled: cancelled,
    _restoreCalls: restoreCalls,
  };
}

async function waitFor(
  predicate: () => boolean,
  timeoutMs = 2_000,
  intervalMs = 10
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return true;
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  return predicate();
}

describe('SpaceRuntime — post-crash open-task dispatch (post-approval window)', () => {
  let db: BunDatabase;
  let workflowRunRepo: SpaceWorkflowRunRepository;
  let taskRepo: SpaceTaskRepository;
  let nodeExecutionRepo: NodeExecutionRepository;
  let sdkMessageRepo: SDKMessageRepository;
  let workflowManager: SpaceWorkflowManager;
  let spaceManager: SpaceManager;

  const SPACE_ID = 'space-3821';
  const AGENT = 'agent-3821';
  const STEP_A = 'step-a';

  beforeEach(() => {
    db = makeDb();
    seedSpaceRow(db, SPACE_ID);
    seedUnifiedAgentMirror(db, { id: AGENT, spaceId: SPACE_ID, name: 'Coder' });
    workflowRunRepo = new SpaceWorkflowRunRepository(db);
    taskRepo = new SpaceTaskRepository(db);
    nodeExecutionRepo = new NodeExecutionRepository(db);
    sdkMessageRepo = new SDKMessageRepository(db);
    const workflowRepo = new SpaceWorkflowRepository(db);
    workflowManager = new SpaceWorkflowManager(workflowRepo);
    spaceManager = new SpaceManager(db);
  });

  afterEach(() => {
    try {
      db.close();
    } catch {}
  });

  function makeRuntime(options: TamMockOptions = {}): {
    runtime: SpaceRuntime;
    cancelled: string[];
    restoreCalls: Array<{ sessionId: string; deferredStart: boolean }>;
  } {
    const tam = makeTaskAgentManagerMock(options);
    const runtime = new SpaceRuntime({
      db,
      spaceManager,
      longHorizonAgentRepo: new SpaceLongHorizonAgentRepository(db),
      spaceWorkflowManager: workflowManager,
      workflowRunRepo,
      taskRepo,
      nodeExecutionRepo,
      sdkMessageRepo,
      taskAgentManager: tam as never,
    } as SpaceRuntimeConfig);
    tam.setRuntimeRef(runtime);
    return {
      runtime,
      cancelled: (tam as { _cancelled: string[] })._cancelled,
      restoreCalls: (tam as { _restoreCalls: Array<{ sessionId: string; deferredStart: boolean }> })
        ._restoreCalls,
    };
  }

  function buildRouteWorkflow(): SpaceWorkflow {
    return workflowManager.createWorkflow({
      spaceId: SPACE_ID,
      name: `WF-3821-route-${Date.now()}-${Math.random()}`,
      description: 'Test',
      nodes: [
        {
          id: STEP_A,
          name: 'Code',
          agentId: AGENT,
          postApproval: { targetAgent: 'Code', instructions: 'Run the merge procedure' },
        },
      ],
      transitions: [],
      startNodeId: STEP_A,
      rules: [],
      tags: [],
      completionAutonomyLevel: 3,
    });
  }

  function seedApprovedPriorTask(
    workflow: SpaceWorkflow,
    runStatus: 'done' | 'in_progress',
    pointer: string | null = 'session:dead-post-approval'
  ) {
    const run = workflowRunRepo.createRun({
      spaceId: SPACE_ID,
      workflowId: workflow.id,
      title: 'Prior run',
    });
    workflowRunRepo.transitionStatus(run.id, 'in_progress');
    if (runStatus === 'done') {
      workflowRunRepo.transitionStatus(run.id, 'done');
    }
    const task = taskRepo.createTask({
      spaceId: SPACE_ID,
      title: 'Prior approved task',
      description: '',
      workflowRunId: run.id,
      status: 'approved',
    });
    taskRepo.updateTask(task.id, {
      approvedAt: Date.now() - 60_000,
      postApprovalSessionId: pointer,
    });
    return { run, task };
  }

  test('open-at-crash task dispatches after restart while the crashed approved task re-dispatches', async () => {
    const workflow = buildLinearWorkflow(SPACE_ID, workflowManager, [
      { id: STEP_A, name: 'Code', agentId: AGENT },
    ]);
    const { task: prior } = seedApprovedPriorTask(workflow, 'done');
    const open = taskRepo.createTask({
      spaceId: SPACE_ID,
      title: 'Open at crash',
      description: '',
      status: 'open',
      preferredWorkflowId: workflow.id,
    });

    const { runtime: rt } = makeRuntime();
    await rt.executeTick();

    const attached = taskRepo.getTask(open.id)!;
    expect(attached.status).toBe('in_progress');
    expect(attached.workflowRunId).not.toBeNull();

    const priorSettled = await waitFor(() => taskRepo.getTask(prior.id)?.status === 'done');
    expect(priorSettled).toBe(true);
    expect(taskRepo.getTask(prior.id)?.postApprovalSessionId ?? null).toBeNull();
  });

  test('replaced post-approval worker keeps holding the slot until the recovered task settles', async () => {
    const workflow = buildRouteWorkflow();
    const { task: prior } = seedApprovedPriorTask(workflow, 'done');
    const open = taskRepo.createTask({
      spaceId: SPACE_ID,
      title: 'Queued task',
      description: '',
      status: 'open',
      preferredWorkflowId: workflow.id,
    });

    const alive = new Set<string>();
    const replacements: string[] = [];
    const { runtime: rt } = makeRuntime({
      alive,
      spawnImpl: async () => {
        replacements.push('session:replacement-post-approval');
        alive.add('session:replacement-post-approval');
        return { sessionId: 'session:replacement-post-approval' };
      },
    });
    await rt.executeTick();

    expect(replacements).toEqual(['session:replacement-post-approval']);
    expect(taskRepo.getTask(prior.id)?.status).toBe('approved');
    expect(taskRepo.getTask(prior.id)?.postApprovalSessionId).toBe(
      'session:replacement-post-approval'
    );
    expect(taskRepo.getTask(open.id)?.status).toBe('open');
    expect(taskRepo.getTask(open.id)?.workflowRunId ?? null).toBeNull();

    taskRepo.updateTask(prior.id, { status: 'done', completedAt: Date.now() });
    await rt.executeTick();

    expect(taskRepo.getTask(open.id)?.status).toBe('in_progress');
    expect(taskRepo.getTask(open.id)?.workflowRunId).not.toBeNull();
  });

  test('in-flight original dispatch claims the approval so the tick never double-dispatches', async () => {
    const workflow = buildRouteWorkflow();
    const { task: prior } = seedApprovedPriorTask(workflow, 'done', null);
    taskRepo.updateTask(prior.id, { approvedAt: Date.now() - 5 * 60_000 });

    const alive = new Set<string>();
    let spawnCount = 0;
    let releaseSpawn: (() => void) | null = null;
    const { runtime: rt } = makeRuntime({
      alive,
      spawnImpl: () =>
        new Promise<{ sessionId: string }>((resolve) => {
          spawnCount++;
          releaseSpawn = () => {
            alive.add('session:original-dispatch');
            resolve({ sessionId: 'session:original-dispatch' });
          };
        }),
    });

    const originalDispatch = rt.dispatchPostApproval(prior.id, 'agent');
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(spawnCount).toBe(1);

    await rt.executeTick();

    expect(spawnCount).toBe(1);
    expect(taskRepo.getTask(prior.id)?.postApprovalSessionId ?? null).toBeNull();

    releaseSpawn!();
    await originalDispatch;

    expect(spawnCount).toBe(1);
    expect(taskRepo.getTask(prior.id)?.postApprovalSessionId).toBe('session:original-dispatch');
  });

  test('failing recovery of an unrecorded approval persists the blocked reason', async () => {
    const workflow = buildRouteWorkflow();
    const { task: prior } = seedApprovedPriorTask(workflow, 'done', null);
    taskRepo.updateTask(prior.id, { approvedAt: Date.now() - 5 * 60_000 });

    const { runtime: rt } = makeRuntime({
      spawnImpl: async () => {
        throw new Error('configured target agent is missing');
      },
    });
    await rt.executeTick();

    const after = taskRepo.getTask(prior.id)!;
    expect(after.status).toBe('approved');
    expect(after.postApprovalBlockedReason).toContain('target agent is missing');
  });

  test('stopped runtime refuses new post-approval dispatches', async () => {
    const workflow = buildRouteWorkflow();
    const { task: prior } = seedApprovedPriorTask(workflow, 'done');

    const { runtime: rt } = makeRuntime({
      spawnImpl: async () => {
        throw new Error('spawn must not be reached');
      },
    });
    await rt.stop();

    const result = await rt.dispatchPostApproval(prior.id, 'agent');
    expect(result).toMatchObject({ mode: 'skipped' });
    expect(taskRepo.getTask(prior.id)?.postApprovalSessionId).toBe('session:dead-post-approval');
  });

  test('run-tick slot admission defers while a dead post-approval worker awaits replacement', async () => {
    const workflow = buildRouteWorkflow();
    const { task: prior } = seedApprovedPriorTask(workflow, 'done');

    const waitingRun = workflowRunRepo.createRun({
      spaceId: SPACE_ID,
      workflowId: workflow.id,
      title: 'Waiting run',
    });
    workflowRunRepo.transitionStatus(waitingRun.id, 'in_progress');
    const waitingTask = taskRepo.createTask({
      spaceId: SPACE_ID,
      title: 'Waiting canonical task',
      description: '',
      workflowRunId: waitingRun.id,
      status: 'open',
    });
    nodeExecutionRepo.createOrIgnore({
      workflowRunId: waitingRun.id,
      workflowNodeId: STEP_A,
      agentName: 'Code',
      agentId: AGENT,
      status: 'pending',
    });

    const alive = new Set<string>();
    const replacements: string[] = [];
    const executionSpawns: number[] = [];
    const { runtime: rt } = makeRuntime({
      alive,
      spawnImpl: async () => {
        replacements.push('session:replacement-post-approval');
        alive.add('session:replacement-post-approval');
        return { sessionId: 'session:replacement-post-approval' };
      },
      onSpawnExecution: () => executionSpawns.push(1),
    });

    await rt.executeTick();

    expect(replacements).toEqual(['session:replacement-post-approval']);
    expect(executionSpawns).toEqual([]);
    expect(taskRepo.getTask(waitingTask.id)?.status).toBe('open');
    expect(taskRepo.getTask(prior.id)?.postApprovalSessionId).toBe(
      'session:replacement-post-approval'
    );
  });

  test('durable orphan kickoff is adopted without executing before the routing wins', async () => {
    const workflow = buildRouteWorkflow();
    const { task: prior } = seedApprovedPriorTask(workflow, 'done', null);
    taskRepo.updateTask(prior.id, { approvedAt: Date.now() - 5 * 60_000 });

    const spawned: string[] = [];
    const { runtime: rt, restoreCalls } = makeRuntime({
      spawnImpl: async () => {
        spawned.push('session:replacement-post-approval');
        return { sessionId: 'session:replacement-post-approval' };
      },
      adoption: { orphanSessionId: 'session:durable-orphan' },
    });

    await rt.executeTick();

    expect(spawned).toEqual([]);
    expect(restoreCalls.map((call) => call.deferredStart)).toEqual([true, false]);
    const after = taskRepo.getTask(prior.id)!;
    expect(after.status).toBe('approved');
    expect(after.postApprovalSessionId).toBe('session:durable-orphan');
  });

  test('orphan adoption stopped mid-restore cancels the revived session without recording it', async () => {
    const workflow = buildRouteWorkflow();
    const { task: prior } = seedApprovedPriorTask(workflow, 'done', null);
    taskRepo.updateTask(prior.id, { approvedAt: Date.now() - 5 * 60_000 });

    const spawned: string[] = [];
    const {
      runtime: rt,
      cancelled,
      restoreCalls,
    } = makeRuntime({
      spawnImpl: async () => {
        spawned.push('session:replacement-post-approval');
        return { sessionId: 'session:replacement-post-approval' };
      },
      adoption: { orphanSessionId: 'session:durable-orphan', stopDuringRestore: true },
    });

    await rt.executeTick();

    expect(spawned).toEqual([]);
    expect(restoreCalls.length).toBe(1);
    expect(cancelled).toContain('session:durable-orphan');
    expect(taskRepo.getTask(prior.id)?.postApprovalSessionId ?? null).toBeNull();
  });

  test('disposed manager skips orphan adoption entirely', async () => {
    const workflow = buildRouteWorkflow();
    const { task: prior } = seedApprovedPriorTask(workflow, 'done', null);
    taskRepo.updateTask(prior.id, { approvedAt: Date.now() - 5 * 60_000 });

    const spawned: string[] = [];
    const {
      runtime: rt,
      cancelled,
      restoreCalls,
    } = makeRuntime({
      spawnImpl: async () => {
        spawned.push('session:replacement-post-approval');
        return { sessionId: 'session:replacement-post-approval' };
      },
      adoption: { orphanSessionId: 'session:durable-orphan', disposed: true },
    });

    await rt.executeTick();

    expect(spawned).toEqual([]);
    expect(restoreCalls).toEqual([]);
    expect(cancelled).toEqual([]);
    expect(taskRepo.getTask(prior.id)?.postApprovalSessionId ?? null).toBeNull();
  });

  test('overlapping dispatch claims keep the surviving dispatch claimed', async () => {
    const workflow = buildRouteWorkflow();
    const { task: prior } = seedApprovedPriorTask(workflow, 'done', null);
    taskRepo.updateTask(prior.id, { approvedAt: Date.now() - 5 * 60_000 });

    let spawnCount = 0;
    const pendingSpawns: Array<{
      resolve: (value: { sessionId: string }) => void;
      reject: (reason: unknown) => void;
    }> = [];
    const { runtime: rt } = makeRuntime({
      spawnImpl: () =>
        new Promise<{ sessionId: string }>((resolve, reject) => {
          spawnCount++;
          pendingSpawns.push({ resolve, reject });
        }),
    });

    const firstDispatch = rt.dispatchPostApproval(prior.id, 'agent');
    const secondDispatch = rt.dispatchPostApproval(prior.id, 'agent');
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(spawnCount).toBe(2);

    pendingSpawns[0]!.reject(new Error('lost the status race'));
    await firstDispatch.catch(() => undefined);

    await rt.executeTick();

    expect(spawnCount).toBe(2);
    expect(taskRepo.getTask(prior.id)?.postApprovalSessionId ?? null).toBeNull();

    pendingSpawns[1]!.resolve({ sessionId: 'session:original-2' });
    await secondDispatch;

    expect(taskRepo.getTask(prior.id)?.postApprovalSessionId).toBe('session:original-2');
  });

  test('recorded worker past its cooldown is resumed instead of replaced', async () => {
    const workflow = buildRouteWorkflow();
    const { task: prior } = seedApprovedPriorTask(workflow, 'done');

    const spawned: string[] = [];
    const { runtime: rt, restoreCalls } = makeRuntime({
      spawnImpl: async () => {
        spawned.push('session:replacement-post-approval');
        return { sessionId: 'session:replacement-post-approval' };
      },
      revivable: ['session:dead-post-approval'],
    });

    await rt.executeTick();

    expect(spawned).toEqual([]);
    expect(restoreCalls.map((call) => call.sessionId)).toEqual(['session:dead-post-approval']);
    expect(taskRepo.getTask(prior.id)?.status).toBe('approved');
    expect(taskRepo.getTask(prior.id)?.postApprovalSessionId).toBe('session:dead-post-approval');
  });

  test('recorded worker that restores as terminal is replaced', async () => {
    const workflow = buildRouteWorkflow();
    const { task: prior } = seedApprovedPriorTask(workflow, 'done');

    const spawned: string[] = [];
    const { runtime: rt, restoreCalls } = makeRuntime({
      spawnImpl: async () => {
        spawned.push('session:replacement-post-approval');
        return { sessionId: 'session:replacement-post-approval' };
      },
      revivable: ['session:dead-post-approval'],
      terminalRestoreIds: ['session:dead-post-approval'],
    });

    await rt.executeTick();

    expect(restoreCalls.map((call) => call.sessionId)).toEqual(['session:dead-post-approval']);
    expect(spawned).toEqual(['session:replacement-post-approval']);
    expect(taskRepo.getTask(prior.id)?.postApprovalSessionId).toBe(
      'session:replacement-post-approval'
    );
  });

  test('recorded worker is not revived while its run has not succeeded', async () => {
    const workflow = buildRouteWorkflow();
    const { task: prior } = seedApprovedPriorTask(workflow, 'in_progress');

    const spawned: string[] = [];
    const { runtime: rt, restoreCalls } = makeRuntime({
      spawnImpl: async () => {
        spawned.push('session:replacement-post-approval');
        return { sessionId: 'session:replacement-post-approval' };
      },
      revivable: ['session:dead-post-approval'],
    });

    await rt.executeTick();

    expect(restoreCalls).toEqual([]);
    expect(spawned).toEqual([]);
    expect(taskRepo.getTask(prior.id)?.status).toBe('approved');
    expect(taskRepo.getTask(prior.id)?.postApprovalSessionId).toBe('session:dead-post-approval');
  });

  test('adoption whose worker cannot be resumed records a retryable blocked reason', async () => {
    const workflow = buildRouteWorkflow();
    const { task: prior } = seedApprovedPriorTask(workflow, 'done', null);
    taskRepo.updateTask(prior.id, { approvedAt: Date.now() - 5 * 60_000 });

    const spawned: string[] = [];
    const { runtime: rt, cancelled } = makeRuntime({
      spawnImpl: async () => {
        spawned.push('session:replacement-post-approval');
        return { sessionId: 'session:replacement-post-approval' };
      },
      adoption: { orphanSessionId: 'session:durable-orphan', failResume: true },
    });

    await rt.executeTick();

    expect(spawned).toEqual([]);
    expect(cancelled).toContain('session:durable-orphan');
    const after = taskRepo.getTask(prior.id)!;
    expect(after.status).toBe('approved');
    expect(after.postApprovalSessionId ?? null).toBeNull();
    expect(after.postApprovalBlockedReason).toContain('could not be resumed');
  });

  test('restored worker whose query was not admitted is left retryable', async () => {
    const workflow = buildRouteWorkflow();
    const { task: prior } = seedApprovedPriorTask(workflow, 'done');

    const spawned: string[] = [];
    const { runtime: rt, restoreCalls } = makeRuntime({
      spawnImpl: async () => {
        spawned.push('session:replacement-post-approval');
        return { sessionId: 'session:replacement-post-approval' };
      },
      revivable: ['session:dead-post-approval'],
      notAdmittedRestoreIds: ['session:dead-post-approval'],
    });

    await rt.executeTick();

    expect(restoreCalls.map((call) => call.sessionId)).toEqual(['session:dead-post-approval']);
    expect(spawned).toEqual([]);
    const after = taskRepo.getTask(prior.id)!;
    expect(after.status).toBe('approved');
    expect(after.postApprovalSessionId ?? null).toBeNull();
    expect(after.postApprovalBlockedReason).toContain('query was not admitted');
  });

  test('a dispatch that outlives a stop/start cycle cannot release the next cycle claim', async () => {
    const workflow = buildRouteWorkflow();
    const { task: prior } = seedApprovedPriorTask(workflow, 'done', null);
    taskRepo.updateTask(prior.id, { approvedAt: Date.now() - 5 * 60_000 });

    let spawnCount = 0;
    const pendingSpawns: Array<{
      resolve: (value: { sessionId: string }) => void;
      reject: (reason: unknown) => void;
    }> = [];
    const { runtime: rt } = makeRuntime({
      spawnImpl: () =>
        new Promise<{ sessionId: string }>((resolve, reject) => {
          spawnCount++;
          pendingSpawns.push({ resolve, reject });
        }),
    });

    const staleDispatch = rt.dispatchPostApproval(prior.id, 'agent');
    await new Promise((resolve) => setTimeout(resolve, 20));

    await rt.stop();
    rt.start();

    const survivingDispatch = rt.dispatchPostApproval(prior.id, 'agent');
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(spawnCount).toBe(2);

    pendingSpawns[0]!.reject(new Error('shutdown superseded the stale dispatch'));
    await staleDispatch.catch(() => undefined);

    await rt.executeTick();

    expect(spawnCount).toBe(2);
    expect(taskRepo.getTask(prior.id)?.postApprovalSessionId ?? null).toBeNull();

    pendingSpawns[1]!.resolve({ sessionId: 'session:surviving-dispatch' });
    await survivingDispatch;
    await rt.stop();

    expect(taskRepo.getTask(prior.id)?.postApprovalSessionId).toBe('session:surviving-dispatch');
  });

  test('approved task with a live post-approval worker keeps deferring standalone admission', async () => {
    const workflow = buildLinearWorkflow(SPACE_ID, workflowManager, [
      { id: STEP_A, name: 'Code', agentId: AGENT },
    ]);
    const { task: prior } = seedApprovedPriorTask(workflow, 'done');
    const open = taskRepo.createTask({
      spaceId: SPACE_ID,
      title: 'Waiting task',
      description: '',
      status: 'open',
      preferredWorkflowId: workflow.id,
    });

    const { runtime: rt } = makeRuntime({ alive: new Set(['session:dead-post-approval']) });
    await rt.executeTick();
    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(taskRepo.getTask(open.id)?.status).toBe('open');
    expect(taskRepo.getTask(open.id)?.workflowRunId ?? null).toBeNull();
    expect(taskRepo.getTask(prior.id)?.status).toBe('approved');
  });

  test('approved task whose dispatch has not recorded a session yet keeps holding the slot', async () => {
    const workflow = buildLinearWorkflow(SPACE_ID, workflowManager, [
      { id: STEP_A, name: 'Code', agentId: AGENT },
    ]);
    const { run, task: prior } = seedApprovedPriorTask(workflow, 'done', null);
    const open = taskRepo.createTask({
      spaceId: SPACE_ID,
      title: 'Waiting task',
      description: '',
      status: 'open',
      preferredWorkflowId: workflow.id,
    });

    const { runtime: rt } = makeRuntime();
    await rt.executeTick();
    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(taskRepo.getTask(open.id)?.status).toBe('open');
    expect(taskRepo.getTask(prior.id)?.status).toBe('approved');
    expect(workflowRunRepo.getRun(run.id)?.status).toBe('done');
  });

  test('approval that crashed before recording a dispatch is recovered once past the grace window', async () => {
    const workflow = buildLinearWorkflow(SPACE_ID, workflowManager, [
      { id: STEP_A, name: 'Code', agentId: AGENT },
    ]);
    const { task: prior } = seedApprovedPriorTask(workflow, 'done', null);
    taskRepo.updateTask(prior.id, { approvedAt: Date.now() - 5 * 60_000 });
    const open = taskRepo.createTask({
      spaceId: SPACE_ID,
      title: 'Queued task',
      description: '',
      status: 'open',
      preferredWorkflowId: workflow.id,
    });

    const { runtime: rt } = makeRuntime();
    await rt.executeTick();

    expect(taskRepo.getTask(prior.id)?.status).toBe('done');
    expect(taskRepo.getTask(prior.id)?.postApprovalSessionId ?? null).toBeNull();
    const attached = taskRepo.getTask(open.id)!;
    expect(attached.status).toBe('in_progress');
    expect(attached.workflowRunId).not.toBeNull();
  });

  test('transient reconcile scan failure keeps approved tasks counted against slots', async () => {
    const workflow = buildLinearWorkflow(SPACE_ID, workflowManager, [
      { id: STEP_A, name: 'Code', agentId: AGENT },
    ]);
    const { task: prior } = seedApprovedPriorTask(workflow, 'done');
    const open = taskRepo.createTask({
      spaceId: SPACE_ID,
      title: 'Queued task',
      description: '',
      status: 'open',
      preferredWorkflowId: workflow.id,
    });

    const faultyTaskRepo = Object.create(taskRepo) as SpaceTaskRepository;
    faultyTaskRepo.listByStatus = () => {
      throw new Error('transient scan failure');
    };
    const rt = new SpaceRuntime({
      db,
      spaceManager,
      longHorizonAgentRepo: new SpaceLongHorizonAgentRepository(db),
      spaceWorkflowManager: workflowManager,
      workflowRunRepo,
      taskRepo: faultyTaskRepo,
      nodeExecutionRepo,
      sdkMessageRepo,
      taskAgentManager: makeTaskAgentManagerMock(new Set()) as never,
    } as SpaceRuntimeConfig);

    await expect(rt.executeTick()).resolves.toBeUndefined();

    expect(taskRepo.getTask(prior.id)?.status).toBe('approved');
    expect(taskRepo.getTask(open.id)?.status).toBe('open');
    expect(taskRepo.getTask(open.id)?.workflowRunId ?? null).toBeNull();
  });

  test('blocked post-approval dispatch on a non-succeeded run defers admission without throwing', async () => {
    const workflow = buildLinearWorkflow(SPACE_ID, workflowManager, [
      { id: STEP_A, name: 'Code', agentId: AGENT },
    ]);
    const { task: prior } = seedApprovedPriorTask(workflow, 'in_progress');
    taskRepo.updateTask(prior.id, {
      postApprovalSessionId: null,
      postApprovalBlockedReason: 'post-approval spawn deferred',
    });
    const open = taskRepo.createTask({
      spaceId: SPACE_ID,
      title: 'Waiting task',
      description: '',
      status: 'open',
      preferredWorkflowId: workflow.id,
    });

    const { runtime: rt } = makeRuntime();
    await expect(rt.executeTick()).resolves.toBeUndefined();
    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(taskRepo.getTask(open.id)?.status).toBe('open');
    expect(taskRepo.getTask(prior.id)?.status).toBe('approved');
  });
});
