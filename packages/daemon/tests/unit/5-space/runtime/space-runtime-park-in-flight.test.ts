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
import type { NodeExecutionStatus } from '@hyperneo/shared';
import { InternalEventBus } from '../../../../src/lib/internal-event-bus.ts';
import type { DaemonInternalEventMap } from '../../../../src/lib/internal-event-bus.ts';

function makeDb(): BunDatabase {
  const db = new BunDatabase(':memory:');
  db.exec('PRAGMA foreign_keys = ON');
  runMigrations(db, () => {});
  return db;
}

function seedSpaceRow(db: BunDatabase, spaceId: string, workspacePath: string): void {
  db.prepare(
    `INSERT INTO spaces (id, workspace_path, name, description, background_context, instructions,
     allowed_models, session_ids, slug, status, created_at, updated_at)
     VALUES (?, ?, ?, '', '', '', '[]', '[]', ?, 'active', ?, ?)`
  ).run(spaceId, workspacePath, `Space ${spaceId}`, spaceId, Date.now(), Date.now());
}

function seedAgentRow(db: BunDatabase, agentId: string, spaceId: string): void {
  db.prepare(
    `INSERT INTO space_agents (id, space_id, name, description, model, tools, system_prompt, created_at, updated_at)
     VALUES (?, ?, ?, '', null, '[]', '', ?, ?)`
  ).run(agentId, spaceId, `Agent ${agentId}`, Date.now(), Date.now());
}

describe('SpaceRuntime — parkInFlightExecutionsForSpace()', () => {
  let db: BunDatabase;

  let workflowRunRepo: SpaceWorkflowRunRepository;
  let taskRepo: SpaceTaskRepository;
  let agentManager: SpaceAgentManager;
  let workflowManager: SpaceWorkflowManager;
  let spaceManager: SpaceManager;
  let nodeExecutionRepo: NodeExecutionRepository;
  let bus: InternalEventBus<DaemonInternalEventMap>;
  let busUnsubs: Array<() => void>;
  let notifications: Array<{ kind: string; payload: Record<string, unknown> }>;

  const SPACE_EVENT_MAP: Record<string, string> = {
    'space.task.updated': 'task_updated',
    'space.workflowRun.updated': 'workflow_run_updated',
    'space.task.blocked': 'task_blocked',
    'space.task.unblocked': 'task_unblocked',
    'space.task.completed': 'task_completed',
    'space.task.failed': 'task_failed',
    'space.workflowRun.completed': 'workflow_run_completed',
    'space.workflowRun.failed': 'workflow_run_failed',
    'space.workflowRun.blocked': 'workflow_run_blocked',
    'space.workflowRun.reopened': 'workflow_run_reopened',
    'space.workflowRun.retry': 'task_retry',
    'space.workflowRun.needsAttention': 'workflow_run_needs_attention',
  };

  const SPACE_ID = 'space-park-1';
  const EMPTY_SPACE_ID = 'space-park-empty';
  const OTHER_SPACE_ID = 'space-park-other';
  const AGENT = 'agent-park-1';
  const OTHER_AGENT = 'agent-park-other';

  function makeRuntime(overrides?: Partial<SpaceRuntimeConfig>): SpaceRuntime {
    return new SpaceRuntime({
      db,
      spaceManager,
      spaceAgentManager: agentManager,
      spaceWorkflowManager: workflowManager,
      workflowRunRepo,
      taskRepo,
      nodeExecutionRepo,
      internalEventBus: bus,
      ...overrides,
    });
  }

  function buildWorkflow(spaceId: string, agentId: string = AGENT) {
    const token = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const nodes = [
      { id: `step-a-${token}`, name: 'Step A', agentId },
      { id: `step-b-${token}`, name: 'Step B', agentId },
      { id: `step-c-${token}`, name: 'Step C', agentId },
      { id: `step-d-${token}`, name: 'Step D', agentId },
      { id: `step-e-${token}`, name: 'Step E', agentId },
    ];
    const transitions = nodes.slice(0, -1).map((step, i) => ({
      from: step.id,
      to: nodes[i + 1].id,
      condition: { type: 'always' as const },
      order: 0,
    }));
    const workflow = workflowManager.createWorkflow({
      spaceId,
      name: `Workflow-${token}`,
      description: 'Test',
      nodes,
      transitions,
      channels: nodes.slice(0, -1).map((step, i) => ({
        id: `${step.id}-to-${nodes[i + 1].id}`,
        from: step.name,
        to: nodes[i + 1].name,
      })),
      startNodeId: nodes[0].id,
      endNodeId: nodes.at(-1)?.id,
      rules: [],
      tags: [],
      completionAutonomyLevel: 3,
    });
    return {
      workflow,
      stepA: nodes[0].id,
      stepB: nodes[1].id,
      stepC: nodes[2].id,
      stepD: nodes[3].id,
      stepE: nodes[4].id,
    };
  }

  function createRun(spaceId: string, workflowId: string, title: string) {
    const run = workflowRunRepo.createRun({ spaceId, workflowId, title });
    workflowRunRepo.transitionStatus(run.id, 'in_progress');
    return run;
  }

  function seedExec(
    runId: string,
    nodeId: string,
    agentName: string,
    status: NodeExecutionStatus,
    opts: { agentSessionId?: string | null; result?: string | null } = {},
    agentId: string = AGENT
  ) {
    const created = nodeExecutionRepo.createOrIgnore({
      workflowRunId: runId,
      workflowNodeId: nodeId,
      agentName,
      agentId,
      status: 'pending',
    });
    nodeExecutionRepo.update(created.id, {
      status,
      agentSessionId: opts.agentSessionId ?? null,
      result: opts.result ?? null,
    });
    return created;
  }

  beforeEach(() => {
    db = makeDb();
    seedSpaceRow(db, SPACE_ID, '/tmp/ws-park-1');
    seedSpaceRow(db, EMPTY_SPACE_ID, '/tmp/ws-park-empty');
    seedSpaceRow(db, OTHER_SPACE_ID, '/tmp/ws-park-other');
    seedAgentRow(db, AGENT, SPACE_ID);
    seedAgentRow(db, OTHER_AGENT, OTHER_SPACE_ID);

    workflowRunRepo = new SpaceWorkflowRunRepository(db);
    taskRepo = new SpaceTaskRepository(db);
    const agentRepo = new SpaceAgentRepository(db);
    agentManager = new SpaceAgentManager(agentRepo);
    const workflowRepo = new SpaceWorkflowRepository(db);
    workflowManager = new SpaceWorkflowManager(workflowRepo);
    spaceManager = new SpaceManager(db);
    nodeExecutionRepo = new NodeExecutionRepository(db);
    bus = new InternalEventBus<DaemonInternalEventMap>();
    busUnsubs = [];
    for (const [eventName, kind] of Object.entries(SPACE_EVENT_MAP)) {
      const unsub = bus.subscribe(
        eventName as keyof DaemonInternalEventMap,
        (payload) => {
          notifications.push({ kind, payload: payload as Record<string, unknown> });
        },
        { subscriberName: `test-park:${eventName}` }
      );
      busUnsubs.push(unsub);
    }
    notifications = [];
  });

  afterEach(() => {
    for (const unsub of busUnsubs) unsub();
    busUnsubs = [];
    try {
      db.close();
    } catch {
      /* ignore */
    }
  });

  test('resets in_progress executions to pending with null result and session', () => {
    const { workflow, stepA, stepB } = buildWorkflow(SPACE_ID);
    const run = createRun(SPACE_ID, workflow.id, 'Park Run');
    const execA = seedExec(run.id, stepA, 'Step A', 'in_progress', {
      agentSessionId: 'session-a',
      result: 'partial work in flight',
    });
    const execB = seedExec(run.id, stepB, 'Step B', 'in_progress', {
      agentSessionId: 'session-b',
    });

    makeRuntime().parkInFlightExecutionsForSpace(SPACE_ID);

    const parkedA = nodeExecutionRepo.getById(execA.id)!;
    const parkedB = nodeExecutionRepo.getById(execB.id)!;
    expect(parkedA.status).toBe('pending');
    expect(parkedA.result).toBeNull();
    expect(parkedA.agentSessionId).toBeNull();
    expect(parkedB.status).toBe('pending');
    expect(parkedB.result).toBeNull();
    expect(parkedB.agentSessionId).toBeNull();
  });

  test('leaves idle, waiting_rebind, pending, and cancelled executions untouched in an affected run', () => {
    const { workflow, stepA, stepB, stepC, stepD, stepE } = buildWorkflow(SPACE_ID);
    const run = createRun(SPACE_ID, workflow.id, 'Mixed Run');
    const execIdle = seedExec(run.id, stepA, 'Step A', 'idle', {
      agentSessionId: 'session-idle',
      result: 'finished work',
    });
    const execWaitingRebind = seedExec(run.id, stepB, 'Step B', 'waiting_rebind', {
      agentSessionId: 'session-rebind',
      result: 'waiting for orphaned tool_result recovery',
    });
    const execPending = seedExec(run.id, stepC, 'Step C', 'pending');
    const execCancelled = seedExec(run.id, stepD, 'Step D', 'cancelled', {
      agentSessionId: 'session-cancelled',
      result: 'cancelled by user',
    });
    const execInFlight = seedExec(run.id, stepE, 'Step E', 'in_progress', {
      agentSessionId: 'session-in-flight',
    });
    const other = buildWorkflow(OTHER_SPACE_ID, OTHER_AGENT);
    const runOther = createRun(OTHER_SPACE_ID, other.workflow.id, 'Other Run');
    const execOther = seedExec(
      runOther.id,
      other.stepA,
      'Step A',
      'in_progress',
      { agentSessionId: 'session-other' },
      OTHER_AGENT
    );

    makeRuntime().parkInFlightExecutionsForSpace(SPACE_ID);

    const idle = nodeExecutionRepo.getById(execIdle.id)!;
    const waitingRebind = nodeExecutionRepo.getById(execWaitingRebind.id)!;
    const pending = nodeExecutionRepo.getById(execPending.id)!;
    const cancelled = nodeExecutionRepo.getById(execCancelled.id)!;
    const parked = nodeExecutionRepo.getById(execInFlight.id)!;
    const untouchedOther = nodeExecutionRepo.getById(execOther.id)!;
    expect(idle.status).toBe('idle');
    expect(idle.result).toBe('finished work');
    expect(idle.agentSessionId).toBe('session-idle');
    expect(waitingRebind.status).toBe('waiting_rebind');
    expect(waitingRebind.result).toBe('waiting for orphaned tool_result recovery');
    expect(waitingRebind.agentSessionId).toBe('session-rebind');
    expect(pending.status).toBe('pending');
    expect(pending.result).toBeNull();
    expect(pending.agentSessionId).toBeNull();
    expect(cancelled.status).toBe('cancelled');
    expect(cancelled.result).toBe('cancelled by user');
    expect(cancelled.agentSessionId).toBe('session-cancelled');
    expect(parked.status).toBe('pending');
    expect(parked.result).toBeNull();
    expect(parked.agentSessionId).toBeNull();
    expect(untouchedOther.status).toBe('in_progress');
    expect(untouchedOther.agentSessionId).toBe('session-other');
  });

  test('clears stuck state, crash counts, and retry budgets for every run of the space only', () => {
    const first = buildWorkflow(SPACE_ID);
    const affectedRun = createRun(SPACE_ID, first.workflow.id, 'Affected Run');
    const execA = seedExec(affectedRun.id, first.stepA, 'Step A', 'in_progress', {
      agentSessionId: 'session-a',
    });
    const second = buildWorkflow(SPACE_ID);
    const idleOnlyRun = createRun(SPACE_ID, second.workflow.id, 'Idle-Only Run');
    const execIdleOnly = seedExec(idleOnlyRun.id, second.stepA, 'Step A', 'idle', {
      agentSessionId: 'session-idle',
    });
    const other = buildWorkflow(OTHER_SPACE_ID, OTHER_AGENT);
    const runOther = createRun(OTHER_SPACE_ID, other.workflow.id, 'Other Space Run');
    const execOther = seedExec(
      runOther.id,
      other.stepA,
      'Step A',
      'in_progress',
      { agentSessionId: 'session-other' },
      OTHER_AGENT
    );

    const rt = makeRuntime();
    const internals = rt as any;
    internals.agentStuckRecovery.set(`${affectedRun.id}:${execA.id}`, {
      nagCount: 1,
      restartCount: 1,
      lastAction: 'nagged',
      lastActionAt: Date.now(),
      lastObservedMessageId: 'msg-1',
      lastObservedMessageAt: Date.now(),
      lastObservedProgressMessageId: 'msg-1',
      lastObservedProgressMessageAt: Date.now(),
      lastRuntimeNagMessageId: 'nag-1',
      lastSessionId: 'session-a',
      pendingRestartNotice: null,
    });
    internals.nonTerminalIdleStates.set(`${affectedRun.id}:${execA.id}`, {
      lastSessionId: 'session-a',
      lastObservedMessageId: 'message-id',
      lastObservedProgressMessageId: 'message-id',
      lastObservedProgressMessageAt: Date.now(),
      lastRuntimeNudgeMessageId: 'nudge-id',
      nudgeCount: 3,
      failedNudgeCount: 0,
      lastNudgeAt: Date.now(),
      lastAttentionLogAt: null,
    });
    internals.taskCrashCounts.set(`${affectedRun.id}:${execA.id}`, 2);
    internals.blockedRetryCounts.set(affectedRun.id, 1);
    internals.agentStuckRecovery.set(`${idleOnlyRun.id}:${execIdleOnly.id}`, {
      nagCount: 1,
    });
    internals.taskCrashCounts.set(`${idleOnlyRun.id}:${execIdleOnly.id}`, 1);
    internals.blockedRetryCounts.set(idleOnlyRun.id, 2);
    internals.agentStuckRecovery.set(`${runOther.id}:${execOther.id}`, { nagCount: 1 });
    internals.taskCrashCounts.set(`${runOther.id}:${execOther.id}`, 1);
    internals.blockedRetryCounts.set(runOther.id, 3);

    rt.parkInFlightExecutionsForSpace(SPACE_ID);

    expect(internals.agentStuckRecovery.has(`${affectedRun.id}:${execA.id}`)).toBe(false);
    expect(internals.nonTerminalIdleStates.has(`${affectedRun.id}:${execA.id}`)).toBe(false);
    expect(internals.taskCrashCounts.has(`${affectedRun.id}:${execA.id}`)).toBe(false);
    expect(internals.blockedRetryCounts.has(affectedRun.id)).toBe(false);
    expect(internals.agentStuckRecovery.has(`${idleOnlyRun.id}:${execIdleOnly.id}`)).toBe(false);
    expect(internals.blockedRetryCounts.has(idleOnlyRun.id)).toBe(false);
    expect(internals.taskCrashCounts.get(`${idleOnlyRun.id}:${execIdleOnly.id}`)).toBe(1);
    expect(internals.agentStuckRecovery.get(`${runOther.id}:${execOther.id}`)).toEqual({
      nagCount: 1,
    });
    expect(internals.taskCrashCounts.get(`${runOther.id}:${execOther.id}`)).toBe(1);
    expect(internals.blockedRetryCounts.get(runOther.id)).toBe(3);
    expect(nodeExecutionRepo.getById(execIdleOnly.id)?.status).toBe('idle');
    expect(nodeExecutionRepo.getById(execOther.id)?.status).toBe('in_progress');
  });

  test('does not write task or run statuses and emits no lifecycle events', () => {
    const { workflow, stepA } = buildWorkflow(SPACE_ID);
    const run = createRun(SPACE_ID, workflow.id, 'Status Run');
    seedExec(run.id, stepA, 'Step A', 'in_progress', {
      agentSessionId: 'session-a',
    });
    const task = taskRepo.createTask({
      spaceId: SPACE_ID,
      title: 'Status Run',
      description: '',
      workflowRunId: run.id,
      workflowNodeId: stepA,
      status: 'in_progress',
    });

    makeRuntime().parkInFlightExecutionsForSpace(SPACE_ID);

    expect(workflowRunRepo.getRun(run.id)?.status).toBe('in_progress');
    expect(taskRepo.getTask(task.id)?.status).toBe('in_progress');
    expect(notifications).toHaveLength(0);
  });

  test('space with no runs is a no-op', () => {
    const { workflow, stepA } = buildWorkflow(SPACE_ID);
    const run = createRun(SPACE_ID, workflow.id, 'Unrelated Run');
    const exec = seedExec(run.id, stepA, 'Step A', 'in_progress', {
      agentSessionId: 'session-a',
    });

    expect(makeRuntime().parkInFlightExecutionsForSpace(EMPTY_SPACE_ID)).toBeUndefined();
    expect(nodeExecutionRepo.getById(exec.id)?.status).toBe('in_progress');
    expect(workflowRunRepo.getRun(run.id)?.status).toBe('in_progress');
    expect(notifications).toHaveLength(0);
  });
});
