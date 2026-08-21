import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { Database as BunDatabase } from '../../../../src/storage/sqlite-compat';
import type { SpaceTask } from '@hyperneo/shared';
import { runMigrations } from '../../../../src/storage/schema/index.ts';
import { SpaceWorkflowRepository } from '../../../../src/storage/repositories/space-workflow-repository.ts';
import { SpaceWorkflowRunRepository } from '../../../../src/storage/repositories/space-workflow-run-repository.ts';
import { SpaceTaskRepository } from '../../../../src/storage/repositories/space-task-repository.ts';
import { SpaceAgentRepository } from '../../../../src/storage/repositories/space-agent-repository.ts';
import { SpaceAgentManager } from '../../../../src/lib/space/managers/space-agent-manager.ts';
import { SpaceWorkflowManager } from '../../../../src/lib/space/managers/space-workflow-manager.ts';
import { SpaceManager } from '../../../../src/lib/space/managers/space-manager.ts';
import { SpaceRuntime } from '../../../../src/lib/space/runtime/space-runtime.ts';
import type { SpaceRuntimeConfig } from '../../../../src/lib/space/runtime/space-runtime.ts';
import { NodeExecutionRepository } from '../../../../src/storage/repositories/node-execution-repository.ts';
import { InternalEventBus } from '../../../../src/lib/internal-event-bus.ts';
import type { DaemonInternalEventMap } from '../../../../src/lib/internal-event-bus.ts';

type BusEventKind =
  | 'task_blocked'
  | 'workflow_run_blocked'
  | 'task_timeout'
  | 'workflow_run_completed'
  | 'workflow_run_reopened'
  | 'agent_crash'
  | 'task_retry'
  | 'workflow_run_needs_attention'
  | 'task_awaiting_approval';

interface CapturedEvent {
  kind: BusEventKind;
  payload: Record<string, unknown>;
}

const EVENT_MAP: Record<string, BusEventKind> = {
  'space.task.blocked': 'task_blocked',
  'space.workflowRun.blocked': 'workflow_run_blocked',
  'space.task.timeout': 'task_timeout',
  'space.workflowRun.completed': 'workflow_run_completed',
  'space.workflowRun.reopened': 'workflow_run_reopened',
  'space.agent.crashed': 'agent_crash',
  'space.workflowRun.retry': 'task_retry',
  'space.workflowRun.needsAttention': 'workflow_run_needs_attention',
  'space.task.awaitingApproval': 'task_awaiting_approval',
};

class BusEventCollector {
  readonly events: CapturedEvent[] = [];
  private unsubscribers: Array<() => void> = [];

  constructor(bus: InternalEventBus<DaemonInternalEventMap>) {
    for (const [eventName, kind] of Object.entries(EVENT_MAP)) {
      const unsub = bus.subscribe(
        eventName as keyof DaemonInternalEventMap,
        (payload) => {
          this.events.push({ kind, payload: payload as Record<string, unknown> });
        },
        { subscriberName: `test-collector:${eventName}` }
      );
      this.unsubscribers.push(unsub);
    }
  }

  clear(): void {
    this.events.length = 0;
  }

  destroy(): void {
    for (const unsub of this.unsubscribers) unsub();
    this.unsubscribers.length = 0;
  }
}

function makeDb(): BunDatabase {
  const db = new BunDatabase(':memory:');
  db.exec('PRAGMA foreign_keys = ON');
  runMigrations(db, () => {});
  return db;
}

function seedSpaceRow(db: BunDatabase, spaceId: string, workspacePath = '/tmp/ws'): void {
  db.prepare(
    `INSERT INTO spaces (id, workspace_path, name, description, background_context, instructions,
     allowed_models, session_ids, slug, status, created_at, updated_at)
     VALUES (?, ?, ?, '', '', '', '[]', '[]', ?, 'active', ?, ?)`
  ).run(spaceId, workspacePath, `Space ${spaceId}`, spaceId, Date.now(), Date.now());
}

function setSpaceTaskTimeoutMs(db: BunDatabase, spaceId: string, timeoutMs: number): void {
  db.prepare(`UPDATE spaces SET config = ? WHERE id = ?`).run(
    JSON.stringify({ taskTimeoutMs: timeoutMs }),
    spaceId
  );
}

function seedAgentRow(db: BunDatabase, agentId: string, spaceId: string): void {
  db.prepare(
    `INSERT INTO space_agents (id, space_id, name, description, model, tools, system_prompt, created_at, updated_at)
     VALUES (?, ?, ?, '', null, '[]', '', ?, ?)`
  ).run(agentId, spaceId, `Agent ${agentId}`, Date.now(), Date.now());
}

class MockTaskAgentManager {
  readonly cancelledSessions: string[] = [];
  readonly liveSubSessionsByTaskId = new Map<string, string[]>();

  cancelBySessionId(sessionId: string): void {
    this.cancelledSessions.push(sessionId);
    for (const [taskId, ids] of this.liveSubSessionsByTaskId) {
      this.liveSubSessionsByTaskId.set(
        taskId,
        ids.filter((sid) => sid !== sessionId)
      );
    }
  }

  getLiveSubSessionIdsForTasks(taskIds: string[]): string[] {
    const ids = new Set<string>();
    for (const taskId of taskIds) {
      for (const sid of this.liveSubSessionsByTaskId.get(taskId) ?? []) ids.add(sid);
    }
    return [...ids];
  }
}

class TaskUpdateCollector {
  readonly tasks: SpaceTask[] = [];

  handle({ task }: { task: SpaceTask }): void {
    this.tasks.push(task);
  }
}

function buildLinearWorkflow(
  spaceId: string,
  workflowManager: SpaceWorkflowManager,
  nodes: Array<{ id: string; name: string; agentId: string }>,
  conditions: Array<{ type: 'always' | 'human' }> = []
) {
  const transitions = nodes.slice(0, -1).map((step, i) => ({
    from: step.id,
    to: nodes[i + 1].id,
    condition: conditions[i] ?? { type: 'always' as const },
    order: 0,
  }));

  return workflowManager.createWorkflow({
    spaceId,
    name: `Workflow ${Date.now()}-${Math.random()}`,
    description: '',
    nodes,
    transitions,
    startNodeId: nodes[0].id,
    rules: [],
    tags: [],
    completionAutonomyLevel: 3,
  });
}

describe('SpaceRuntime — edge cases and resilience', () => {
  let db: BunDatabase;

  let workflowRunRepo: SpaceWorkflowRunRepository;
  let taskRepo: SpaceTaskRepository;
  let nodeExecutionRepo: NodeExecutionRepository;
  let agentManager: SpaceAgentManager;
  let workflowManager: SpaceWorkflowManager;
  let spaceManager: SpaceManager;
  let bus: InternalEventBus<DaemonInternalEventMap>;
  let collector: BusEventCollector;
  let runtime: SpaceRuntime;

  const SPACE_ID = 'space-edge-1';
  const WORKSPACE = '/tmp/edge-ws';
  const AGENT = 'agent-edge-coder';

  function makeRuntime(extraConfig?: Partial<SpaceRuntimeConfig>): SpaceRuntime {
    return new SpaceRuntime({
      db,
      spaceManager,
      spaceAgentManager: agentManager,
      spaceWorkflowManager: workflowManager,
      workflowRunRepo,
      taskRepo,
      nodeExecutionRepo,
      internalEventBus: bus,
      ...extraConfig,
    });
  }

  function updateFirstNodeExecution(
    runId: string,
    params: Parameters<NodeExecutionRepository['update']>[1]
  ): void {
    const execution = nodeExecutionRepo.listByWorkflowRun(runId)[0];
    if (!execution) {
      throw new Error(`No node execution found for run ${runId}`);
    }
    nodeExecutionRepo.update(execution.id, params);
  }

  beforeEach(() => {
    db = makeDb();

    seedSpaceRow(db, SPACE_ID, WORKSPACE);
    seedAgentRow(db, AGENT, SPACE_ID);

    workflowRunRepo = new SpaceWorkflowRunRepository(db);
    taskRepo = new SpaceTaskRepository(db);
    nodeExecutionRepo = new NodeExecutionRepository(db);

    const agentRepo = new SpaceAgentRepository(db);
    agentManager = new SpaceAgentManager(agentRepo);

    const workflowRepo = new SpaceWorkflowRepository(db);
    workflowManager = new SpaceWorkflowManager(workflowRepo);

    spaceManager = new SpaceManager(db);
    bus = new InternalEventBus<DaemonInternalEventMap>();
    collector = new BusEventCollector(bus);
    runtime = makeRuntime();
  });

  afterEach(() => {
    collector.destroy();
    try {
      db.close();
    } catch {}
    try {
    } catch {}
  });

  describe('InternalEventBus — tick loop resilience', () => {
    test('tick does not crash when InternalEventBus publishAsync throws', async () => {
      const throwingBus = new InternalEventBus<DaemonInternalEventMap>();
      throwingBus.subscribe(
        'space.task.blocked',
        () => {
          throw new Error('Subscriber error');
        },
        { subscriberName: 'throwing-subscriber' }
      );

      const rt = makeRuntime({ internalEventBus: throwingBus });

      const wf = buildLinearWorkflow(SPACE_ID, workflowManager, [
        { id: 'step-throw-1', name: 'Only Step', agentId: AGENT },
      ]);
      const { run } = await rt.startWorkflowRun(SPACE_ID, wf.id, 'Run');
      updateFirstNodeExecution(run.id, { status: 'blocked', result: 'Build failed' });

      await expect(rt.executeTick()).resolves.toBeUndefined();
    });

    test('tick does not crash for standalone task when subscriber throws', async () => {
      const throwingBus = new InternalEventBus<DaemonInternalEventMap>();
      throwingBus.subscribe(
        'space.task.blocked',
        () => {
          throw new Error('Subscriber error');
        },
        { subscriberName: 'throwing-subscriber' }
      );

      const rt = makeRuntime({ internalEventBus: throwingBus });

      taskRepo.createTask({
        spaceId: SPACE_ID,
        title: 'Standalone',
        description: '',
        status: 'blocked',
      });

      await expect(rt.executeTick()).resolves.toBeUndefined();
    });

    test('tick does not crash for task_timeout when subscriber throws', async () => {
      setSpaceTaskTimeoutMs(db, SPACE_ID, 1000);
      const throwingBus = new InternalEventBus<DaemonInternalEventMap>();
      throwingBus.subscribe(
        'space.task.timeout',
        () => {
          throw new Error('Subscriber error');
        },
        { subscriberName: 'throwing-subscriber' }
      );

      const rt = makeRuntime({ internalEventBus: throwingBus });

      const task = taskRepo.createTask({
        spaceId: SPACE_ID,
        title: 'Slow Standalone',
        description: '',
        status: 'in_progress',
      });
      db.prepare('UPDATE space_tasks SET started_at = ? WHERE id = ?').run(
        Date.now() - 5000,
        task.id
      );

      await expect(rt.executeTick()).resolves.toBeUndefined();
    });
  });

  describe('rapid status changes between ticks', () => {
    test('task goes blocked→pending→in_progress→blocked between ticks — one notification on final state', async () => {
      const wf = buildLinearWorkflow(SPACE_ID, workflowManager, [
        { id: 'step-rapid', name: 'Only Step', agentId: AGENT },
      ]);
      const { run, tasks } = await runtime.startWorkflowRun(SPACE_ID, wf.id, 'Run');

      await runtime.executeTick();
      expect(collector.events).toHaveLength(0);

      updateFirstNodeExecution(run.id, { status: 'blocked', result: 'First failure' });
      updateFirstNodeExecution(run.id, {
        status: 'pending',
        result: null,
        startedAt: null,
        completedAt: null,
      });
      updateFirstNodeExecution(run.id, { status: 'in_progress' });
      updateFirstNodeExecution(run.id, { status: 'blocked', result: 'Final failure' });

      await runtime.executeTick();

      const blockedEvents = collector.events.filter((e) => e.kind === 'task_blocked');
      expect(blockedEvents).toHaveLength(1);
      expect(blockedEvents[0].payload['reason']).toBe('Final failure');
      expect(blockedEvents[0].payload['taskId']).toBe(tasks[0].id);
    });

    test('standalone task rapid changes — only final blocked state generates notification', async () => {
      const task = taskRepo.createTask({
        spaceId: SPACE_ID,
        title: 'Rapid Standalone',
        description: '',
        status: 'open',
      });

      await runtime.executeTick();
      expect(collector.events).toHaveLength(0);

      taskRepo.updateTask(task.id, { status: 'blocked', error: 'Transient error' });
      taskRepo.updateTask(task.id, { status: 'open', error: null });
      taskRepo.updateTask(task.id, { status: 'in_progress' });
      taskRepo.updateTask(task.id, { status: 'blocked', error: 'Persistent error' });

      await runtime.executeTick();

      const naEvents = collector.events.filter((e) => e.kind === 'task_blocked');
      expect(naEvents).toHaveLength(1);
      expect(naEvents[0].payload['reason']).toBe('Task requires attention');
    });
  });

  describe('rehydration — workflow tasks in blocked on restart', () => {
    test('workflow task in blocked is not re-notified on first tick after restart', async () => {
      const wf = buildLinearWorkflow(SPACE_ID, workflowManager, [
        { id: 'step-rehydrate', name: 'Only Step', agentId: AGENT },
      ]);
      const { run } = await runtime.startWorkflowRun(SPACE_ID, wf.id, 'Run');
      updateFirstNodeExecution(run.id, { status: 'blocked', result: 'Pre-restart error' });

      await runtime.executeTick();

      const originalEvents = collector.events.filter((e) => e.kind === 'task_blocked');
      expect(originalEvents).toHaveLength(1);

      const freshBus = new InternalEventBus<DaemonInternalEventMap>();
      const freshCollector = new BusEventCollector(freshBus);
      const freshRuntime = makeRuntime({ internalEventBus: freshBus });

      await freshRuntime.executeTick();

      const reNotified = freshCollector.events.filter((e) => e.kind === 'task_blocked');
      expect(reNotified).toHaveLength(0);

      await freshRuntime.executeTick();
      expect(freshCollector.events.filter((e) => e.kind === 'task_blocked')).toHaveLength(0);
      freshCollector.destroy();
    });

    test('multiple workflow runs with blocked tasks — none re-notified after restart', async () => {
      const wfA = buildLinearWorkflow(SPACE_ID, workflowManager, [
        { id: 'step-rehy-a', name: 'Step A', agentId: AGENT },
      ]);
      const wfB = buildLinearWorkflow(SPACE_ID, workflowManager, [
        { id: 'step-rehy-b', name: 'Step B', agentId: AGENT },
      ]);

      const { run: runA } = await runtime.startWorkflowRun(SPACE_ID, wfA.id, 'Run A');
      const { run: runB } = await runtime.startWorkflowRun(SPACE_ID, wfB.id, 'Run B');

      updateFirstNodeExecution(runA.id, { status: 'blocked', result: 'Error A' });
      updateFirstNodeExecution(runB.id, { status: 'blocked', result: 'Error B' });

      await runtime.executeTick();
      expect(collector.events.filter((e) => e.kind === 'task_blocked')).toHaveLength(2);

      const freshBus = new InternalEventBus<DaemonInternalEventMap>();
      const freshCollector = new BusEventCollector(freshBus);
      const freshRuntime = makeRuntime({ internalEventBus: freshBus });

      await freshRuntime.executeTick();

      const reNotified = freshCollector.events.filter((e) => e.kind === 'task_blocked');
      expect(reNotified).toHaveLength(0);
      freshCollector.destroy();
    });
  });

  describe('deduplication — standalone tasks across many ticks', () => {
    test('same standalone task in blocked for 5+ ticks emits only 1 notification', async () => {
      const task = taskRepo.createTask({
        spaceId: SPACE_ID,
        title: 'Persistent Issue',
        description: '',
        status: 'blocked',
      });

      for (let i = 0; i < 5; i++) {
        await runtime.executeTick();
      }

      const naEvents = collector.events.filter((e) => e.kind === 'task_blocked');
      expect(naEvents).toHaveLength(1);
      expect(naEvents[0].payload['taskId']).toBe(task.id);
    });

    test('standalone task in timeout for 5+ ticks emits only 1 notification', async () => {
      setSpaceTaskTimeoutMs(db, SPACE_ID, 1000);

      const task = taskRepo.createTask({
        spaceId: SPACE_ID,
        title: 'Stuck Standalone',
        description: '',
        status: 'in_progress',
      });
      db.prepare('UPDATE space_tasks SET started_at = ? WHERE id = ?').run(
        Date.now() - 30000,
        task.id
      );

      for (let i = 0; i < 5; i++) {
        await runtime.executeTick();
      }

      const timeoutEvents = collector.events.filter((e) => e.kind === 'task_timeout');
      expect(timeoutEvents).toHaveLength(1);
    });

    test('dedup key refreshed after task resolves and re-enters blocked', async () => {
      const task = taskRepo.createTask({
        spaceId: SPACE_ID,
        title: 'Flapping Task',
        description: '',
        status: 'blocked',
      });

      await runtime.executeTick();
      expect(collector.events.filter((e) => e.kind === 'task_blocked')).toHaveLength(1);

      await runtime.executeTick();
      expect(collector.events.filter((e) => e.kind === 'task_blocked')).toHaveLength(1);

      taskRepo.updateTask(task.id, { status: 'in_progress', error: null });

      await runtime.executeTick();
      expect(collector.events.filter((e) => e.kind === 'task_blocked')).toHaveLength(1);

      taskRepo.updateTask(task.id, { status: 'blocked', error: 'Second error' });

      await runtime.executeTick();
      expect(collector.events.filter((e) => e.kind === 'task_blocked')).toHaveLength(2);
    });
  });

  describe('workflow-backed dependency block cleanup', () => {
    test('blocking an in-progress workflow task stops run and active node agents', async () => {
      const tam = new MockTaskAgentManager();
      const rt = makeRuntime({ taskAgentManager: tam as never });
      const wf = buildLinearWorkflow(SPACE_ID, workflowManager, [
        { id: 'step-dep-block', name: 'Only Step', agentId: AGENT },
      ]);
      const { run, tasks } = await rt.startWorkflowRun(SPACE_ID, wf.id, 'Run');
      const task = tasks[0];
      const [execution] = nodeExecutionRepo.listByWorkflowRun(run.id);
      nodeExecutionRepo.update(execution.id, {
        status: 'in_progress',
        agentSessionId: 'node-session-1',
      });
      taskRepo.updateTask(task.id, { taskAgentSessionId: 'task-session-1' });

      const blocked = await rt.blockWorkflowBackedTask(SPACE_ID, task.id, {
        dependsOn: ['missing-dep'],
        status: 'blocked',
        blockReason: 'dependency_added',
        result: 'Dependency added while task was in progress',
        completedAt: null,
      });

      expect(blocked?.status).toBe('blocked');
      expect(blocked?.blockReason).toBe('dependency_added');
      expect(workflowRunRepo.getRun(run.id)?.status).toBe('blocked');
      expect(tam.cancelledSessions).toEqual(['node-session-1', 'task-session-1']);
      const cancelledExecution = nodeExecutionRepo.getById(execution.id)!;
      expect(cancelledExecution.status).toBe('cancelled');
      expect(cancelledExecution.agentSessionId).toBeNull();
      const clearedTask = taskRepo.getTask(task.id)!;
      expect(blocked?.workflowRunId).toBe(run.id);
      expect(blocked?.taskAgentSessionId).toBeUndefined();
      expect(clearedTask.workflowRunId).toBe(run.id);
      expect(clearedTask.taskAgentSessionId).toBeUndefined();
      expect(collector.events.filter((e) => e.kind === 'task_blocked')).toHaveLength(1);
      expect(collector.events.filter((e) => e.kind === 'workflow_run_blocked')).toHaveLength(1);
    });

    test('uses original runtime pointers when block payload overwrites them', async () => {
      const tam = new MockTaskAgentManager();
      const rt = makeRuntime({ taskAgentManager: tam as never });
      const wf = buildLinearWorkflow(SPACE_ID, workflowManager, [
        { id: 'step-pointer-overwrite', name: 'Only Step', agentId: AGENT },
      ]);
      const { run, tasks } = await rt.startWorkflowRun(SPACE_ID, wf.id, 'Run');
      const task = tasks[0];
      const [execution] = nodeExecutionRepo.listByWorkflowRun(run.id);
      nodeExecutionRepo.update(execution.id, {
        status: 'in_progress',
        agentSessionId: 'node-session-1',
      });
      taskRepo.updateTask(task.id, { taskAgentSessionId: 'original-task-session' });

      const blocked = await rt.blockWorkflowBackedTask(SPACE_ID, task.id, {
        dependsOn: ['missing-dep'],
        status: 'blocked',
        blockReason: 'dependency_added',
        result: 'Dependency added while task was in progress',
        completedAt: null,
        taskAgentSessionId: 'payload-task-session',
        workflowRunId: null,
      });

      expect(blocked?.status).toBe('blocked');
      expect(blocked?.workflowRunId).toBe(run.id);
      expect(blocked?.taskAgentSessionId).toBeUndefined();
      expect(workflowRunRepo.getRun(run.id)?.status).toBe('blocked');
      expect(tam.cancelledSessions).toContain('node-session-1');
      expect(tam.cancelledSessions).toContain('original-task-session');
      expect(tam.cancelledSessions).not.toContain('payload-task-session');
      const clearedTask = taskRepo.getTask(task.id)!;
      expect(clearedTask.workflowRunId).toBe(run.id);
      expect(clearedTask.taskAgentSessionId).toBeUndefined();
      const cancelledExecution = nodeExecutionRepo.getById(execution.id)!;
      expect(cancelledExecution.status).toBe('cancelled');
      expect(cancelledExecution.agentSessionId).toBeNull();
    });

    test('ignores payload task session when dependency-block task had no session pointer', async () => {
      const tam = new MockTaskAgentManager();
      const rt = makeRuntime({ taskAgentManager: tam as never });
      const wf = buildLinearWorkflow(SPACE_ID, workflowManager, [
        { id: 'step-dep-payload-session', name: 'Only Step', agentId: AGENT },
      ]);
      const { run, tasks } = await rt.startWorkflowRun(SPACE_ID, wf.id, 'Run');
      const task = tasks[0];
      const [execution] = nodeExecutionRepo.listByWorkflowRun(run.id);
      nodeExecutionRepo.update(execution.id, {
        status: 'in_progress',
        agentSessionId: 'node-session-dep-payload-ignore',
      });
      taskRepo.updateTask(task.id, { taskAgentSessionId: null });

      await rt.blockWorkflowBackedTask(SPACE_ID, task.id, {
        dependsOn: ['missing-dep'],
        status: 'blocked',
        blockReason: 'dependency_added',
        result: 'Dependency added while task was in progress',
        completedAt: null,
        taskAgentSessionId: 'unrelated-session',
      });

      expect(tam.cancelledSessions).toEqual(['node-session-dep-payload-ignore']);
      expect(tam.cancelledSessions).not.toContain('unrelated-session');
    });

    test('pausing a workflow-backed task stops node agents and clears task session pointer', async () => {
      const tam = new MockTaskAgentManager();
      const updates = new TaskUpdateCollector();
      const rt = makeRuntime({
        taskAgentManager: tam as never,
        onTaskUpdated: async (event) => updates.handle(event),
      });
      const wf = buildLinearWorkflow(SPACE_ID, workflowManager, [
        { id: 'step-pause', name: 'Only Step', agentId: AGENT },
      ]);
      const { run, tasks } = await rt.startWorkflowRun(SPACE_ID, wf.id, 'Run');
      const task = tasks[0];
      const [execution] = nodeExecutionRepo.listByWorkflowRun(run.id);
      nodeExecutionRepo.update(execution.id, {
        status: 'in_progress',
        agentSessionId: 'node-session-pause',
      });
      taskRepo.updateTask(task.id, {
        status: 'in_progress',
        taskAgentSessionId: 'task-session-pause',
      });
      updates.tasks.length = 0;

      const paused = await rt.stopWorkflowBackedTaskForStatus(SPACE_ID, task.id, {
        status: 'open',
      });

      expect(paused?.status).toBe('open');
      expect(paused?.workflowRunId).toBe(run.id);
      expect(paused?.taskAgentSessionId).toBeUndefined();
      expect(workflowRunRepo.getRun(run.id)?.status).toBe('in_progress');
      expect(tam.cancelledSessions).toEqual(['node-session-pause', 'task-session-pause']);
      const cancelledExecution = nodeExecutionRepo.getById(execution.id)!;
      expect(cancelledExecution.status).toBe('cancelled');
      expect(cancelledExecution.agentSessionId).toBeNull();
      expect(updates.tasks).toHaveLength(1);
      expect(updates.tasks[0].status).toBe('open');
      expect(updates.tasks[0].taskAgentSessionId).toBeUndefined();
    });

    test('pausing a workflow-backed task preserves idle execution history', async () => {
      const tam = new MockTaskAgentManager();
      const rt = makeRuntime({ taskAgentManager: tam as never });
      const wf = buildLinearWorkflow(SPACE_ID, workflowManager, [
        { id: 'step-pause-idle', name: 'Idle Step', agentId: AGENT },
        { id: 'step-pause-active', name: 'Active Step', agentId: AGENT },
      ]);
      const { run, tasks } = await rt.startWorkflowRun(SPACE_ID, wf.id, 'Run');
      const task = tasks[0];
      const [idleExecution] = nodeExecutionRepo.listByNode(run.id, 'step-pause-idle');
      nodeExecutionRepo.update(idleExecution.id, {
        status: 'idle',
        agentSessionId: 'idle-session-pause',
        result: 'idle output',
        completedAt: Date.now() - 1000,
      });
      const activeExecution = nodeExecutionRepo.create({
        workflowRunId: run.id,
        workflowNodeId: 'step-pause-active',
        agentName: 'agent-1',
        agentId: AGENT,
        status: 'in_progress',
        agentSessionId: 'active-session-pause',
      });
      taskRepo.updateTask(task.id, {
        status: 'in_progress',
        taskAgentSessionId: 'task-session-pause-idle',
      });

      await rt.stopWorkflowBackedTaskForStatus(SPACE_ID, task.id, { status: 'open' });

      const preservedExecution = nodeExecutionRepo.getById(idleExecution.id)!;
      expect(preservedExecution.status).toBe('idle');
      expect(preservedExecution.agentSessionId).toBe('idle-session-pause');
      expect(preservedExecution.result).toBe('idle output');
      const cancelledExecution = nodeExecutionRepo.getById(activeExecution.id)!;
      expect(cancelledExecution.status).toBe('cancelled');
      expect(cancelledExecution.agentSessionId).toBeNull();
      expect(tam.cancelledSessions).toEqual(['active-session-pause', 'task-session-pause-idle']);
    });

    test('ignores payload task session when status-stop task had no session pointer', async () => {
      const tam = new MockTaskAgentManager();
      const rt = makeRuntime({ taskAgentManager: tam as never });
      const wf = buildLinearWorkflow(SPACE_ID, workflowManager, [
        { id: 'step-status-payload-session', name: 'Only Step', agentId: AGENT },
      ]);
      const { run, tasks } = await rt.startWorkflowRun(SPACE_ID, wf.id, 'Run');
      const task = tasks[0];
      const [execution] = nodeExecutionRepo.listByWorkflowRun(run.id);
      nodeExecutionRepo.update(execution.id, {
        status: 'in_progress',
        agentSessionId: 'node-session-payload-ignore',
      });
      taskRepo.updateTask(task.id, {
        status: 'in_progress',
        taskAgentSessionId: null,
      });

      const cancelled = await rt.stopWorkflowBackedTaskForStatus(SPACE_ID, task.id, {
        status: 'cancelled',
        taskAgentSessionId: 'unrelated-session',
      });

      expect(cancelled?.taskAgentSessionId).toBeUndefined();
      expect(tam.cancelledSessions).toEqual(['node-session-payload-ignore']);
      expect(tam.cancelledSessions).not.toContain('unrelated-session');
    });

    test('validates metadata fields when stopping workflow-backed task status', async () => {
      const rt = makeRuntime();
      const wf = buildLinearWorkflow(SPACE_ID, workflowManager, [
        { id: 'step-status-metadata', name: 'Only Step', agentId: AGENT },
      ]);
      const { tasks } = await rt.startWorkflowRun(SPACE_ID, wf.id, 'Run');
      const task = tasks[0];
      taskRepo.updateTask(task.id, { status: 'in_progress' });

      await expect(
        rt.stopWorkflowBackedTaskForStatus(SPACE_ID, task.id, {
          status: 'cancelled',
          dependsOn: [task.id],
        })
      ).rejects.toThrow('A task cannot depend on itself');
      expect(taskRepo.getTask(task.id)?.dependsOn).toEqual([]);
      expect(taskRepo.getTask(task.id)?.status).toBe('cancelled');
    });

    test('cancelling a workflow-backed task stops sessions and cancels run', async () => {
      const tam = new MockTaskAgentManager();
      const rt = makeRuntime({ taskAgentManager: tam as never });
      const wf = buildLinearWorkflow(SPACE_ID, workflowManager, [
        { id: 'step-cancel-task', name: 'Only Step', agentId: AGENT },
      ]);
      const { run, tasks } = await rt.startWorkflowRun(SPACE_ID, wf.id, 'Run');
      const task = tasks[0];
      const [execution] = nodeExecutionRepo.listByWorkflowRun(run.id);
      nodeExecutionRepo.update(execution.id, {
        status: 'in_progress',
        agentSessionId: 'node-session-cancel-task',
      });
      taskRepo.updateTask(task.id, {
        status: 'in_progress',
        taskAgentSessionId: 'task-session-cancel-task',
      });

      const cancelled = await rt.stopWorkflowBackedTaskForStatus(SPACE_ID, task.id, {
        status: 'cancelled',
        cancelReason: 'user cancelled',
      });

      expect(cancelled?.status).toBe('cancelled');
      expect(cancelled?.approvalReason).toBe('user cancelled');
      expect(cancelled?.workflowRunId).toBe(run.id);
      expect(cancelled?.taskAgentSessionId).toBeUndefined();
      expect(workflowRunRepo.getRun(run.id)?.status).toBe('cancelled');
      expect(tam.cancelledSessions).toEqual([
        'node-session-cancel-task',
        'task-session-cancel-task',
      ]);
      const cancelledExecution = nodeExecutionRepo.getById(execution.id)!;
      expect(cancelledExecution.status).toBe('cancelled');
      expect(cancelledExecution.agentSessionId).toBeNull();
    });

    test('cancelling a workflow run stops active task and node sessions', async () => {
      const tam = new MockTaskAgentManager();
      const rt = makeRuntime({ taskAgentManager: tam as never });
      const wf = buildLinearWorkflow(SPACE_ID, workflowManager, [
        { id: 'step-cancel-run', name: 'Only Step', agentId: AGENT },
      ]);
      const { run, tasks } = await rt.startWorkflowRun(SPACE_ID, wf.id, 'Run');
      const task = tasks[0];
      const [execution] = nodeExecutionRepo.listByWorkflowRun(run.id);
      nodeExecutionRepo.update(execution.id, {
        status: 'in_progress',
        agentSessionId: 'node-session-cancel-run',
      });
      taskRepo.updateTask(task.id, {
        status: 'in_progress',
        taskAgentSessionId: 'task-session-cancel-run',
      });

      const cancelledRun = await rt.cancelWorkflowRun(SPACE_ID, run.id);

      expect(cancelledRun.status).toBe('cancelled');
      const cancelledTask = taskRepo.getTask(task.id)!;
      expect(cancelledTask.status).toBe('cancelled');
      expect(cancelledTask.workflowRunId).toBe(run.id);
      expect(cancelledTask.taskAgentSessionId).toBeUndefined();
      expect(tam.cancelledSessions).toEqual(['node-session-cancel-run', 'task-session-cancel-run']);
      const cancelledExecution = nodeExecutionRepo.getById(execution.id)!;
      expect(cancelledExecution.status).toBe('cancelled');
      expect(cancelledExecution.agentSessionId).toBeNull();
    });

    test('cancelling a run interrupts a live node session whose execution row has a null agentSessionId', async () => {
      const tam = new MockTaskAgentManager();
      const rt = makeRuntime({ taskAgentManager: tam as never });
      const wf = buildLinearWorkflow(SPACE_ID, workflowManager, [
        { id: 'step-null-window', name: 'Only Step', agentId: AGENT },
      ]);
      const { run, tasks } = await rt.startWorkflowRun(SPACE_ID, wf.id, 'Run');
      const task = tasks[0];
      const [execution] = nodeExecutionRepo.listByWorkflowRun(run.id);
      nodeExecutionRepo.update(execution.id, {
        status: 'in_progress',
        agentSessionId: null,
      });
      taskRepo.updateTask(task.id, { status: 'in_progress' });
      tam.liveSubSessionsByTaskId.set(task.id, ['live-coder-session-null-window']);

      const cancelled = await rt.stopWorkflowBackedTaskForStatus(SPACE_ID, task.id, {
        status: 'cancelled',
        cancelReason: 'user cancelled',
      });

      expect(cancelled?.status).toBe('cancelled');
      expect(tam.cancelledSessions).toContain('live-coder-session-null-window');
    });

    test('live-session sweep does not double-cancel a session already handled by the row loop', async () => {
      const tam = new MockTaskAgentManager();
      const rt = makeRuntime({ taskAgentManager: tam as never });
      const wf = buildLinearWorkflow(SPACE_ID, workflowManager, [
        { id: 'step-sweep-dedupe', name: 'Only Step', agentId: AGENT },
      ]);
      const { run, tasks } = await rt.startWorkflowRun(SPACE_ID, wf.id, 'Run');
      const task = tasks[0];
      const [execution] = nodeExecutionRepo.listByWorkflowRun(run.id);
      nodeExecutionRepo.update(execution.id, {
        status: 'in_progress',
        agentSessionId: 'row-session-dedupe',
      });
      taskRepo.updateTask(task.id, { status: 'in_progress' });
      tam.liveSubSessionsByTaskId.set(task.id, ['row-session-dedupe']);

      await rt.stopWorkflowBackedTaskForStatus(SPACE_ID, task.id, { status: 'cancelled' });

      const count = tam.cancelledSessions.filter((s) => s === 'row-session-dedupe').length;
      expect(count).toBe(1);
    });

    test('preserves completed executions and emits only post-cleanup task update', async () => {
      const tam = new MockTaskAgentManager();
      const updates = new TaskUpdateCollector();
      const rt = makeRuntime({
        taskAgentManager: tam as never,
        onTaskUpdated: async (event) => updates.handle(event),
      });
      const wf = buildLinearWorkflow(SPACE_ID, workflowManager, [
        { id: 'step-complete', name: 'Completed Step', agentId: AGENT },
        { id: 'step-active', name: 'Active Step', agentId: AGENT },
      ]);
      const { run, tasks } = await rt.startWorkflowRun(SPACE_ID, wf.id, 'Run');
      const task = tasks[0];
      const [firstExecution] = nodeExecutionRepo.listByNode(run.id, 'step-complete');
      nodeExecutionRepo.update(firstExecution.id, {
        status: 'idle',
        result: 'completed output',
        completedAt: Date.now() - 1000,
      });
      const activeExecution = nodeExecutionRepo.create({
        workflowRunId: run.id,
        workflowNodeId: 'step-active',
        agentName: 'agent-1',
        agentId: AGENT,
        status: 'in_progress',
        agentSessionId: 'node-session-2',
      });
      taskRepo.updateTask(task.id, { taskAgentSessionId: 'task-session-2' });
      updates.tasks.length = 0;

      const blocked = await rt.blockWorkflowBackedTask(SPACE_ID, task.id, {
        dependsOn: ['missing-dep'],
        status: 'blocked',
        blockReason: 'dependency_added',
        result: 'Dependency added while task was in progress',
        completedAt: null,
      });

      expect(blocked?.taskAgentSessionId).toBeUndefined();
      expect(updates.tasks).toHaveLength(1);
      expect(updates.tasks[0].status).toBe('blocked');
      expect(updates.tasks[0].taskAgentSessionId).toBeUndefined();
      const preservedExecution = nodeExecutionRepo.getById(firstExecution.id)!;
      expect(preservedExecution.status).toBe('idle');
      expect(preservedExecution.result).toBe('completed output');
      expect(preservedExecution.agentSessionId).toBeNull();
      const cancelledExecution = nodeExecutionRepo.getById(activeExecution.id)!;
      expect(cancelledExecution.status).toBe('cancelled');
      expect(cancelledExecution.agentSessionId).toBeNull();
      expect(tam.cancelledSessions).toEqual(['node-session-2', 'task-session-2']);
    });
  });

  describe('external run cancellation — no stale notifications', () => {
    test('run cancelled externally between ticks — no notification on subsequent tick', async () => {
      const wf = buildLinearWorkflow(SPACE_ID, workflowManager, [
        { id: 'step-cancel-ext', name: 'Only Step', agentId: AGENT },
      ]);
      const { run, tasks } = await runtime.startWorkflowRun(SPACE_ID, wf.id, 'Run');

      taskRepo.updateTask(tasks[0].id, { status: 'in_progress' });
      await runtime.executeTick();
      expect(collector.events).toHaveLength(0);

      workflowRunRepo.transitionStatus(run.id, 'cancelled');

      await runtime.executeTick();

      expect(collector.events.filter((e) => e.kind === 'workflow_run_completed')).toHaveLength(0);
      expect(collector.events.filter((e) => e.kind === 'task_blocked')).toHaveLength(0);
    });

    test('run cancelled externally while task is in blocked — no stale task notification on next tick', async () => {
      const wf = buildLinearWorkflow(SPACE_ID, workflowManager, [
        { id: 'step-cancel-na', name: 'Only Step', agentId: AGENT },
      ]);
      const { run } = await runtime.startWorkflowRun(SPACE_ID, wf.id, 'Run');
      updateFirstNodeExecution(run.id, { status: 'blocked', result: 'Error' });

      await runtime.executeTick();
      expect(collector.events.filter((e) => e.kind === 'task_blocked')).toHaveLength(1);

      workflowRunRepo.transitionStatus(run.id, 'cancelled');

      await runtime.executeTick();

      expect(collector.events.filter((e) => e.kind === 'task_blocked')).toHaveLength(1);
      expect(collector.events.filter((e) => e.kind === 'workflow_run_completed')).toHaveLength(0);
    });

    test('run cancelled between rehydration and first tick — no notification emitted', async () => {
      const wf = buildLinearWorkflow(SPACE_ID, workflowManager, [
        { id: 'step-cancel-rehy', name: 'Only Step', agentId: AGENT },
      ]);
      const { run } = await runtime.startWorkflowRun(SPACE_ID, wf.id, 'Run');

      workflowRunRepo.transitionStatus(run.id, 'cancelled');

      const freshBus = new InternalEventBus<DaemonInternalEventMap>();
      const freshCollector = new BusEventCollector(freshBus);
      const freshRuntime = makeRuntime({ internalEventBus: freshBus });

      await freshRuntime.executeTick();

      expect(freshCollector.events).toHaveLength(0);
      freshCollector.destroy();
    });
  });
});
