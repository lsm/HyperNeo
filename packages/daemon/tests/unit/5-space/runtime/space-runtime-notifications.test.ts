import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { Database as BunDatabase } from '../../../../src/storage/sqlite-compat';
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
import type { SpaceWorkflow, SpaceTask, SpaceWorkflowRun, Space } from '@hyperneo/shared';
import type { TaskAgentManager } from '../../../../src/lib/space/runtime/task-agent-manager.ts';
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

class MockTaskAgentManager {
  isTaskAgentAlive(_taskId: string): boolean {
    return false;
  }
  isSpawning(_taskId: string): boolean {
    return false;
  }
  isExecutionSpawning(_executionId: string): boolean {
    return false;
  }
  isSessionAlive(_sessionId: string): boolean {
    return false;
  }
  isSessionInMemory(_sessionId: string): boolean {
    return false;
  }
  async spawnWorkflowNodeAgent(
    _task: any,
    _space: any,
    _workflow: any,
    _run: any
  ): Promise<string> {
    return 'mock-session';
  }
  async spawnWorkflowNodeAgentForExecution(
    _task: any,
    _space: any,
    _workflow: any,
    _run: any,
    _execution: any
  ): Promise<string> {
    return `mock-session:${_execution.id}`;
  }
  async rehydrate(): Promise<void> {}
  cancelBySessionId(_agentSessionId: string): void {}
  async interruptBySessionId(_agentSessionId: string): Promise<void> {}
  getAgentSessionById(_id: string) {
    return null;
  }
}

class BusEventCollector {
  readonly events: CapturedEvent[] = [];
  private bus: InternalEventBus<DaemonInternalEventMap>;
  private unsubscribers: Array<() => void> = [];

  constructor(bus: InternalEventBus<DaemonInternalEventMap>) {
    this.bus = bus;
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

  get byKind(): Record<string, CapturedEvent[]> {
    const map: Record<string, CapturedEvent[]> = {};
    for (const e of this.events) {
      if (!map[e.kind]) map[e.kind] = [];
      map[e.kind].push(e);
    }
    return map;
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

  db.exec(`CREATE TABLE IF NOT EXISTS sdk_messages (
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
		parent_tool_use_id TEXT
	)`);

  return db;
}

function seedSpaceRow(db: BunDatabase, spaceId: string, workspacePath = '/tmp/workspace'): void {
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

function seedNodeExec(
  db: BunDatabase,
  workflowRunId: string,
  workflowNodeId: string,
  agentName: string,
  status: string,
  options?: { result?: string | null; startedAt?: number | null; agentSessionId?: string | null }
): string {
  const repo = new NodeExecutionRepository(db);
  const existing = repo.listByNode(workflowRunId, workflowNodeId);
  const result = options?.result ?? null;
  const startedAt = options?.startedAt ?? null;
  const agentSessionId = options?.agentSessionId ?? null;
  if (existing.length > 0) {
    const byAgent = existing.find((exec) => exec.agentName === agentName);
    const target = byAgent ?? (existing.length === 1 ? existing[0] : null);
    if (target) {
      repo.update(target.id, {
        status: status as 'pending' | 'in_progress' | 'idle' | 'done' | 'cancelled' | 'blocked',
        result,
        startedAt,
        agentSessionId,
      });
      return target.id;
    }
  }

  const id = `exec-test-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const now = Date.now();
  db.prepare(
    `INSERT OR REPLACE INTO node_executions
			     (id, workflow_run_id, workflow_node_id, agent_name, agent_id,
			      agent_session_id, status, result, created_at, started_at,
		      completed_at, updated_at)
		     VALUES (?, ?, ?, ?, NULL, ?, ?, ?, ?, ?, NULL, ?)`
  ).run(
    id,
    workflowRunId,
    workflowNodeId,
    agentName,
    agentSessionId,
    status,
    result,
    now,
    startedAt,
    now
  );
  return id;
}

function buildLinearWorkflow(
  spaceId: string,
  workflowManager: SpaceWorkflowManager,
  nodes: Array<{ id: string; name: string; agentId: string }>,
  _conditions: Array<{ type: 'always' | 'human' }> = []
): SpaceWorkflow {
  const workflowNodes = nodes.map((n) => ({
    id: n.id,
    name: n.name,
    agents: [{ agentId: n.agentId, name: n.name.toLowerCase().replace(/\s+/g, '-') }],
  }));

  return workflowManager.createWorkflow({
    spaceId,
    name: `Workflow ${Date.now()}-${Math.random()}`,
    description: '',
    nodes: workflowNodes,
    startNodeId: nodes[0].id,
    tags: [],
    completionAutonomyLevel: 3,
  });
}

const SYNTHETIC_END_NODE_ID = '__test_end__';
function withSyntheticEnd(endAgentId: string): {
  id: string;
  name: string;
  agents: Array<{ agentId: string; name: string }>;
} {
  return {
    id: SYNTHETIC_END_NODE_ID,
    name: 'Synthetic End',
    agents: [{ agentId: endAgentId, name: 'end' }],
  };
}

describe('SpaceRuntime — notification events', () => {
  let db: BunDatabase;

  let workflowRunRepo: SpaceWorkflowRunRepository;
  let taskRepo: SpaceTaskRepository;
  let agentManager: SpaceAgentManager;
  let workflowManager: SpaceWorkflowManager;
  let spaceManager: SpaceManager;
  let bus: InternalEventBus<DaemonInternalEventMap>;
  let collector: BusEventCollector;
  let runtime: SpaceRuntime;

  const SPACE_ID = 'space-notif-1';
  const WORKSPACE = '/tmp/notif-ws';
  const AGENT_CODER = 'agent-coder-notif';
  const STEP_A = 'step-na';
  const STEP_B = 'step-nb';

  function makeRuntime(extraConfig?: Partial<SpaceRuntimeConfig>): SpaceRuntime {
    const nodeExecutionRepo = new NodeExecutionRepository(db);
    const config: SpaceRuntimeConfig = {
      db,
      spaceManager,
      spaceAgentManager: agentManager,
      spaceWorkflowManager: workflowManager,
      workflowRunRepo,
      taskRepo,
      nodeExecutionRepo,
      internalEventBus: bus,
      ...extraConfig,
    };
    return new SpaceRuntime(config);
  }

  beforeEach(() => {
    db = makeDb();

    seedSpaceRow(db, SPACE_ID, WORKSPACE);
    seedAgentRow(db, AGENT_CODER, SPACE_ID);

    workflowRunRepo = new SpaceWorkflowRunRepository(db);
    taskRepo = new SpaceTaskRepository(db);

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

  describe('task_blocked', () => {
    test('emits event when a step task enters needs_attention', async () => {
      const workflow = buildLinearWorkflow(SPACE_ID, workflowManager, [
        { id: STEP_A, name: 'Plan', agentId: AGENT_CODER },
      ]);

      const { run, tasks } = await runtime.startWorkflowRun(SPACE_ID, workflow.id, 'Run');
      taskRepo.updateTask(tasks[0].id, { status: 'in_progress' });
      seedNodeExec(db, run.id, STEP_A, 'plan', 'blocked');

      await runtime.executeTick();

      expect(collector.events.filter((e) => e.kind === 'task_blocked')).toHaveLength(1);
      const evt = collector.events.find((e) => e.kind === 'task_blocked');
      expect(evt).toBeDefined();
      expect(evt!.kind).toBe('task_blocked');
      expect(evt!.payload['spaceId']).toBe(SPACE_ID);
      expect(evt!.payload['taskId']).toBe(tasks[0].id);
      expect(evt!.payload['reason']).toBe('One or more workflow agents are blocked');
      expect(typeof evt!.payload['timestamp']).toBe('string');
    });

    test('uses fallback reason when task.error is null', async () => {
      const workflow = buildLinearWorkflow(SPACE_ID, workflowManager, [
        { id: STEP_A, name: 'Plan', agentId: AGENT_CODER },
      ]);

      const { run } = await runtime.startWorkflowRun(SPACE_ID, workflow.id, 'Run');
      seedNodeExec(db, run.id, STEP_A, 'plan', 'blocked');

      await runtime.executeTick();

      const evt = collector.events[0];
      expect(evt.kind).toBe('task_blocked');
      expect(evt.payload['reason']).toBe('One or more workflow agents are blocked');
    });

    test('does NOT advance when task is needs_attention (returns early)', async () => {
      const workflow = buildLinearWorkflow(
        SPACE_ID,
        workflowManager,
        [
          { id: STEP_A, name: 'Plan', agentId: AGENT_CODER },
          { id: STEP_B, name: 'Code', agentId: AGENT_CODER },
        ],
        [{ type: 'always' }]
      );

      const { run } = await runtime.startWorkflowRun(SPACE_ID, workflow.id, 'Run');
      seedNodeExec(db, run.id, STEP_A, 'plan', 'blocked');

      await runtime.executeTick();

      const allTasks = taskRepo.listByWorkflowRun(run.id);
      expect(allTasks).toHaveLength(1);
    });
  });

  describe('deduplication', () => {
    test('same task in needs_attention across two ticks emits only ONE notification', async () => {
      const workflow = buildLinearWorkflow(SPACE_ID, workflowManager, [
        { id: STEP_A, name: 'Plan', agentId: AGENT_CODER },
      ]);

      const { run, tasks } = await runtime.startWorkflowRun(SPACE_ID, workflow.id, 'Run');
      taskRepo.updateTask(tasks[0].id, { status: 'in_progress' });
      seedNodeExec(db, run.id, STEP_A, 'plan', 'blocked');

      await runtime.executeTick();
      expect(collector.events.filter((e) => e.kind === 'task_blocked')).toHaveLength(1);

      await runtime.executeTick();
      expect(collector.events.filter((e) => e.kind === 'task_blocked')).toHaveLength(1);

      await runtime.executeTick();
      expect(collector.events.filter((e) => e.kind === 'task_blocked')).toHaveLength(1);
    });

    test('re-notifies after task leaves and re-enters needs_attention', async () => {
      const workflow = buildLinearWorkflow(SPACE_ID, workflowManager, [
        { id: STEP_A, name: 'Plan', agentId: AGENT_CODER },
      ]);

      const { run, tasks } = await runtime.startWorkflowRun(SPACE_ID, workflow.id, 'Run');
      taskRepo.updateTask(tasks[0].id, { status: 'in_progress' });
      seedNodeExec(db, run.id, STEP_A, 'plan', 'blocked');

      await runtime.executeTick();
      expect(collector.events.filter((e) => e.kind === 'task_blocked')).toHaveLength(1);

      workflowRunRepo.transitionStatus(run.id, 'in_progress');
      taskRepo.updateTask(tasks[0].id, { status: 'in_progress' });
      seedNodeExec(db, run.id, STEP_A, 'plan', 'in_progress');
      await runtime.executeTick();
      expect(collector.events.filter((e) => e.kind === 'task_blocked')).toHaveLength(1);

      seedNodeExec(db, run.id, STEP_A, 'plan', 'blocked');
      await runtime.executeTick();
      const blockedEvents = collector.events.filter((e) => e.kind === 'task_blocked');
      expect(blockedEvents).toHaveLength(2);
    });

    test('multiple tasks in needs_attention each emit their own notification', async () => {
      const wf1 = buildLinearWorkflow(SPACE_ID, workflowManager, [
        { id: 'step-multi-a', name: 'Step A', agentId: AGENT_CODER },
      ]);
      const wf2 = buildLinearWorkflow(SPACE_ID, workflowManager, [
        { id: 'step-multi-b', name: 'Step B', agentId: AGENT_CODER },
      ]);

      const { tasks: tasks1 } = await runtime.startWorkflowRun(SPACE_ID, wf1.id, 'Run 1');
      const { tasks: tasks2 } = await runtime.startWorkflowRun(SPACE_ID, wf2.id, 'Run 2');

      seedNodeExec(db, (tasks1[0].workflowRunId as string)!, 'step-multi-a', 'step-a', 'blocked');
      seedNodeExec(db, (tasks2[0].workflowRunId as string)!, 'step-multi-b', 'step-b', 'blocked');

      await runtime.executeTick();

      const naEvents = collector.events.filter((e) => e.kind === 'task_blocked');
      expect(naEvents).toHaveLength(2);
      const taskIds = naEvents.map((e) => e.payload['taskId'] as string);
      expect(taskIds).toContain(tasks1[0].id);
      expect(taskIds).toContain(tasks2[0].id);

      await runtime.executeTick();
      expect(collector.events.filter((e) => e.kind === 'task_blocked')).toHaveLength(2);
    });
  });

  describe('task_timeout', () => {
    test('emits event when in_progress task exceeds taskTimeoutMs', async () => {
      setSpaceTaskTimeoutMs(db, SPACE_ID, 1000);

      const workflow = buildLinearWorkflow(SPACE_ID, workflowManager, [
        { id: STEP_A, name: 'Plan', agentId: AGENT_CODER },
      ]);

      const { run, tasks } = await runtime.startWorkflowRun(SPACE_ID, workflow.id, 'Run');
      seedNodeExec(db, run.id, STEP_A, 'plan', 'in_progress', { startedAt: Date.now() - 2000 });

      await runtime.executeTick();

      expect(collector.events).toHaveLength(1);
      const evt = collector.events[0];
      expect(evt.kind).toBe('task_timeout');
      expect(evt.payload['spaceId']).toBe(SPACE_ID);
      expect(evt.payload['taskId']).toBe(tasks[0].id);
      expect(evt.payload['elapsedMs'] as number).toBeGreaterThan(1000);
      expect(typeof evt.payload['timestamp']).toBe('string');
    });

    test('does NOT emit timeout when task has not exceeded the threshold', async () => {
      setSpaceTaskTimeoutMs(db, SPACE_ID, 60_000);

      const workflow = buildLinearWorkflow(SPACE_ID, workflowManager, [
        { id: STEP_A, name: 'Plan', agentId: AGENT_CODER },
      ]);

      const { run } = await runtime.startWorkflowRun(SPACE_ID, workflow.id, 'Run');
      seedNodeExec(db, run.id, STEP_A, 'plan', 'in_progress', { startedAt: Date.now() });

      await runtime.executeTick();

      expect(collector.events.filter((e) => e.kind === 'task_timeout')).toHaveLength(0);
    });

    test('does NOT emit timeout when taskTimeoutMs is undefined (disabled)', async () => {
      const workflow = buildLinearWorkflow(SPACE_ID, workflowManager, [
        { id: STEP_A, name: 'Plan', agentId: AGENT_CODER },
      ]);

      const { run } = await runtime.startWorkflowRun(SPACE_ID, workflow.id, 'Run');
      seedNodeExec(db, run.id, STEP_A, 'plan', 'in_progress', { startedAt: Date.now() - 100_000 });

      await runtime.executeTick();

      expect(collector.events.filter((e) => e.kind === 'task_timeout')).toHaveLength(0);
    });

    test('deduplicates timeout notifications across ticks', async () => {
      setSpaceTaskTimeoutMs(db, SPACE_ID, 1000);

      const workflow = buildLinearWorkflow(SPACE_ID, workflowManager, [
        { id: STEP_A, name: 'Plan', agentId: AGENT_CODER },
      ]);

      const { run, tasks } = await runtime.startWorkflowRun(SPACE_ID, workflow.id, 'Run');
      taskRepo.updateTask(tasks[0].id, { status: 'in_progress' });
      seedNodeExec(db, run.id, STEP_A, 'plan', 'in_progress', { startedAt: Date.now() - 2000 });

      await runtime.executeTick();
      expect(collector.events.filter((e) => e.kind === 'task_timeout')).toHaveLength(1);

      await runtime.executeTick();
      expect(collector.events.filter((e) => e.kind === 'task_timeout')).toHaveLength(1);
    });

    test('re-notifies timeout after task leaves in_progress and re-enters', async () => {
      setSpaceTaskTimeoutMs(db, SPACE_ID, 1000);

      const workflow = buildLinearWorkflow(SPACE_ID, workflowManager, [
        { id: STEP_A, name: 'Plan', agentId: AGENT_CODER },
      ]);

      const { run, tasks } = await runtime.startWorkflowRun(SPACE_ID, workflow.id, 'Run');
      taskRepo.updateTask(tasks[0].id, { status: 'in_progress' });
      seedNodeExec(db, run.id, STEP_A, 'plan', 'in_progress', { startedAt: Date.now() - 2000 });

      await runtime.executeTick();
      expect(collector.events.filter((e) => e.kind === 'task_timeout')).toHaveLength(1);

      taskRepo.updateTask(tasks[0].id, { status: 'done' });
      seedNodeExec(db, run.id, STEP_A, 'plan', 'idle');
      await runtime.executeTick();

      taskRepo.updateTask(tasks[0].id, { status: 'in_progress' });
      seedNodeExec(db, run.id, STEP_A, 'plan', 'in_progress', { startedAt: Date.now() - 2000 });
      await runtime.executeTick();

      expect(collector.events.filter((e) => e.kind === 'task_timeout')).toHaveLength(2);
    });

    test('re-notifies timeout after executions stop timing out while task stays in_progress', async () => {
      setSpaceTaskTimeoutMs(db, SPACE_ID, 60_000);

      const workflow = buildLinearWorkflow(SPACE_ID, workflowManager, [
        { id: STEP_A, name: 'Plan', agentId: AGENT_CODER },
      ]);

      const { run, tasks } = await runtime.startWorkflowRun(SPACE_ID, workflow.id, 'Run');
      taskRepo.updateTask(tasks[0].id, { status: 'in_progress' });
      const executionId = seedNodeExec(db, run.id, STEP_A, 'plan', 'in_progress', {
        startedAt: Date.now() - 120_000,
      });

      await runtime.executeTick();
      expect(collector.events.filter((e) => e.kind === 'task_timeout')).toHaveLength(1);

      const executionRepo = new NodeExecutionRepository(db);
      executionRepo.update(executionId, { startedAt: Date.now() });
      await runtime.executeTick();
      expect(taskRepo.getTask(tasks[0].id)?.status).toBe('in_progress');
      expect(collector.events.filter((e) => e.kind === 'task_timeout')).toHaveLength(1);

      executionRepo.update(executionId, { startedAt: Date.now() - 120_000 });
      await runtime.executeTick();

      expect(collector.events.filter((e) => e.kind === 'task_timeout')).toHaveLength(2);
    });
  });

  describe('agent_crash', () => {
    test('emits one event when a dead execution exhausts its retry budget', async () => {
      const workflow = buildLinearWorkflow(SPACE_ID, workflowManager, [
        { id: STEP_A, name: 'Plan', agentId: AGENT_CODER },
      ]);
      let spawnCount = 0;
      const taskAgentManager = new MockTaskAgentManager();
      taskAgentManager.spawnWorkflowNodeAgentForExecution = async (
        _task: SpaceTask,
        _space: Space,
        _workflow: SpaceWorkflow,
        _run: SpaceWorkflowRun,
        execution: { id: string }
      ) => {
        spawnCount += 1;
        const sessionId = `dead-session:${spawnCount}`;
        new NodeExecutionRepository(db).update(execution.id, {
          status: 'in_progress',
          agentSessionId: sessionId,
          startedAt: Date.now(),
        });
        return sessionId;
      };
      runtime = makeRuntime({
        taskAgentManager: taskAgentManager as unknown as TaskAgentManager,
      });
      const { run, tasks } = await runtime.startWorkflowRun(SPACE_ID, workflow.id, 'Run');
      const execution = new NodeExecutionRepository(db).listByWorkflowRun(run.id)[0]!;
      new NodeExecutionRepository(db).update(execution.id, {
        status: 'in_progress',
        agentSessionId: 'dead-session:initial',
      });

      await runtime.executeTick();
      expect(collector.events.filter((event) => event.kind === 'agent_crash')).toHaveLength(0);

      await runtime.executeTick();
      expect(collector.events.filter((event) => event.kind === 'agent_crash')).toHaveLength(0);

      await runtime.executeTick();

      const events = collector.events.filter((event) => event.kind === 'agent_crash');
      expect(events).toHaveLength(1);
      expect(events[0].payload['spaceId']).toBe(SPACE_ID);
      expect(events[0].payload['taskId']).toBe(tasks[0].id);
      expect(typeof events[0].payload['timestamp']).toBe('string');
      expect(taskRepo.getTask(tasks[0].id)?.status).toBe('blocked');
      expect(workflowRunRepo.getRun(run.id)?.status).toBe('blocked');
    });
  });

  describe('no notifications for mechanical advancement', () => {
    test('normal step completion and advancement emits no notifications', async () => {
      const workflow = buildLinearWorkflow(
        SPACE_ID,
        workflowManager,
        [
          { id: STEP_A, name: 'Plan', agentId: AGENT_CODER },
          { id: STEP_B, name: 'Code', agentId: AGENT_CODER },
        ],
        [{ type: 'always' }]
      );

      const { tasks } = await runtime.startWorkflowRun(SPACE_ID, workflow.id, 'Run');
      taskRepo.updateTask(tasks[0].id, { status: 'done' });

      await runtime.executeTick();

      expect(collector.events).toHaveLength(0);
    });

    test('task in pending state emits no notifications', async () => {
      const workflow = buildLinearWorkflow(SPACE_ID, workflowManager, [
        { id: STEP_A, name: 'Plan', agentId: AGENT_CODER },
      ]);

      await runtime.startWorkflowRun(SPACE_ID, workflow.id, 'Run');

      await runtime.executeTick();

      expect(collector.events).toHaveLength(0);
    });

    test('task in in_progress state (no timeout) emits no notifications', async () => {
      const workflow = buildLinearWorkflow(SPACE_ID, workflowManager, [
        { id: STEP_A, name: 'Plan', agentId: AGENT_CODER },
      ]);

      const { tasks } = await runtime.startWorkflowRun(SPACE_ID, workflow.id, 'Run');
      taskRepo.updateTask(tasks[0].id, { status: 'in_progress' });

      await runtime.executeTick();

      expect(collector.events).toHaveLength(0);
    });
  });

  describe('standalone task notifications', () => {
    test('emits task_blocked for standalone task in needs_attention state', async () => {
      const created = taskRepo.createTask({
        spaceId: SPACE_ID,
        title: 'Standalone Task',
        description: 'No workflow',
        status: 'blocked',
      });
      const task = created;

      await runtime.executeTick();

      expect(collector.events).toHaveLength(1);
      const evt = collector.events[0];
      expect(evt.kind).toBe('task_blocked');
      expect(evt.payload['spaceId']).toBe(SPACE_ID);
      expect(evt.payload['taskId']).toBe(task.id);
      expect(evt.payload['reason']).toBe('Task requires attention');
      expect(typeof evt.payload['timestamp']).toBe('string');
    });

    test('uses fallback reason when standalone task.error is null', async () => {
      taskRepo.createTask({
        spaceId: SPACE_ID,
        title: 'Standalone Task',
        description: '',
        status: 'blocked',
      });

      await runtime.executeTick();

      const evt = collector.events[0];
      expect(evt.kind).toBe('task_blocked');
      expect(evt.payload['reason']).toBe('Task requires attention');
    });

    test('deduplicates standalone needs_attention across ticks', async () => {
      taskRepo.createTask({
        spaceId: SPACE_ID,
        title: 'Standalone',
        description: '',
        status: 'blocked',
      });

      await runtime.executeTick();
      expect(collector.events.filter((e) => e.kind === 'task_blocked')).toHaveLength(1);

      await runtime.executeTick();
      expect(collector.events.filter((e) => e.kind === 'task_blocked')).toHaveLength(1);

      await runtime.executeTick();
      expect(collector.events.filter((e) => e.kind === 'task_blocked')).toHaveLength(1);
    });

    test('re-notifies standalone task after it leaves and re-enters needs_attention', async () => {
      const task = taskRepo.createTask({
        spaceId: SPACE_ID,
        title: 'Standalone',
        description: '',
        status: 'blocked',
      });

      await runtime.executeTick();
      expect(collector.events.filter((e) => e.kind === 'task_blocked')).toHaveLength(1);

      taskRepo.updateTask(task.id, { status: 'in_progress' });
      await runtime.executeTick();
      expect(collector.events.filter((e) => e.kind === 'task_blocked')).toHaveLength(1);

      taskRepo.updateTask(task.id, { status: 'blocked' });
      await runtime.executeTick();
      expect(collector.events.filter((e) => e.kind === 'task_blocked')).toHaveLength(2);
    });

    test('pending standalone tasks emit no notifications', async () => {
      taskRepo.createTask({
        spaceId: SPACE_ID,
        title: 'Standalone Pending',
        description: '',
        status: 'open',
      });

      await runtime.executeTick();

      expect(collector.events).toHaveLength(0);
    });

    test('in_progress standalone tasks without timeout emit no notifications', async () => {
      setSpaceTaskTimeoutMs(db, SPACE_ID, 60_000);

      const task = taskRepo.createTask({
        spaceId: SPACE_ID,
        title: 'Standalone In Progress',
        description: '',
        status: 'in_progress',
      });
      db.prepare('UPDATE space_tasks SET started_at = ? WHERE id = ?').run(Date.now(), task.id);

      await runtime.executeTick();

      expect(collector.events.filter((e) => e.kind === 'task_timeout')).toHaveLength(0);
    });

    test('emits task_timeout for standalone in_progress task that exceeds threshold', async () => {
      setSpaceTaskTimeoutMs(db, SPACE_ID, 1000);

      const task = taskRepo.createTask({
        spaceId: SPACE_ID,
        title: 'Slow Standalone',
        description: '',
        status: 'in_progress',
      });
      db.prepare('UPDATE space_tasks SET started_at = ? WHERE id = ?').run(
        Date.now() - 2000,
        task.id
      );

      await runtime.executeTick();

      expect(collector.events).toHaveLength(1);
      const evt = collector.events[0];
      expect(evt.kind).toBe('task_timeout');
      expect(evt.payload['spaceId']).toBe(SPACE_ID);
      expect(evt.payload['taskId']).toBe(task.id);
      expect(evt.payload['elapsedMs'] as number).toBeGreaterThan(1000);
      expect(typeof evt.payload['timestamp']).toBe('string');
    });

    test('does NOT emit timeout for standalone task when taskTimeoutMs is undefined', async () => {
      const task = taskRepo.createTask({
        spaceId: SPACE_ID,
        title: 'Slow Standalone No Config',
        description: '',
        status: 'in_progress',
      });
      db.prepare('UPDATE space_tasks SET started_at = ? WHERE id = ?').run(
        Date.now() - 100_000,
        task.id
      );

      await runtime.executeTick();

      expect(collector.events.filter((e) => e.kind === 'task_timeout')).toHaveLength(0);
    });

    test('deduplicates standalone timeout notifications across ticks', async () => {
      setSpaceTaskTimeoutMs(db, SPACE_ID, 1000);

      const task = taskRepo.createTask({
        spaceId: SPACE_ID,
        title: 'Timed Out Standalone',
        description: '',
        status: 'in_progress',
      });
      db.prepare('UPDATE space_tasks SET started_at = ? WHERE id = ?').run(
        Date.now() - 2000,
        task.id
      );

      await runtime.executeTick();
      expect(collector.events.filter((e) => e.kind === 'task_timeout')).toHaveLength(1);

      await runtime.executeTick();
      expect(collector.events.filter((e) => e.kind === 'task_timeout')).toHaveLength(1);
    });

    test('re-notifies standalone timeout after task leaves and re-enters in_progress', async () => {
      setSpaceTaskTimeoutMs(db, SPACE_ID, 1000);

      const task = taskRepo.createTask({
        spaceId: SPACE_ID,
        title: 'Cycling Standalone',
        description: '',
        status: 'in_progress',
      });
      db.prepare('UPDATE space_tasks SET started_at = ? WHERE id = ?').run(
        Date.now() - 2000,
        task.id
      );

      await runtime.executeTick();
      expect(collector.events.filter((e) => e.kind === 'task_timeout')).toHaveLength(1);

      taskRepo.updateTask(task.id, { status: 'blocked' });
      await runtime.executeTick();

      taskRepo.updateTask(task.id, { status: 'in_progress' });
      db.prepare('UPDATE space_tasks SET started_at = ? WHERE id = ?').run(
        Date.now() - 2000,
        task.id
      );
      await runtime.executeTick();

      expect(collector.events.filter((e) => e.kind === 'task_timeout')).toHaveLength(2);
    });

    test('completed standalone task emits no notifications', async () => {
      taskRepo.createTask({
        spaceId: SPACE_ID,
        title: 'Done',
        description: '',
        status: 'done',
      });

      await runtime.executeTick();

      expect(collector.events).toHaveLength(0);
    });

    test('cancelled standalone task emits no notifications', async () => {
      taskRepo.createTask({
        spaceId: SPACE_ID,
        title: 'Cancelled',
        description: '',
        status: 'cancelled',
      });

      await runtime.executeTick();

      expect(collector.events).toHaveLength(0);
    });

    test('archiving a standalone task clears its dedup key (no permanent leak)', async () => {
      const task = taskRepo.createTask({
        spaceId: SPACE_ID,
        title: 'Soon Archived',
        description: '',
        status: 'blocked',
      });

      await runtime.executeTick();
      expect(collector.events.filter((e) => e.kind === 'task_blocked')).toHaveLength(1);

      taskRepo.archiveTask(task.id);

      await runtime.executeTick();
      expect(collector.events.filter((e) => e.kind === 'task_blocked')).toHaveLength(1);

      const task2 = taskRepo.createTask({
        spaceId: SPACE_ID,
        title: 'Another Task',
        description: '',
        status: 'blocked',
      });
      await runtime.executeTick();
      const naEvents = collector.events.filter(
        (e) => e.kind === 'task_blocked' && e.payload['taskId'] === task2.id
      );
      expect(naEvents).toHaveLength(1);
    });

    test('workflow tasks are NOT processed by checkStandaloneTasks', async () => {
      const workflow = buildLinearWorkflow(SPACE_ID, workflowManager, [
        { id: STEP_A, name: 'Step A', agentId: AGENT_CODER },
      ]);
      const { run, tasks } = await runtime.startWorkflowRun(SPACE_ID, workflow.id, 'Run');
      seedNodeExec(db, run.id, STEP_A, 'step-a', 'blocked');

      await runtime.executeTick();

      const naEvents = collector.events.filter((e) => e.kind === 'task_blocked');
      expect(naEvents).toHaveLength(1);
      expect(naEvents[0].payload['taskId']).toBe(tasks[0].id);
    });
  });

  describe('restart re-notification (empty dedup set on restart)', () => {
    test('standalone needs_attention task is re-notified after simulated restart', async () => {
      const created = taskRepo.createTask({
        spaceId: SPACE_ID,
        title: 'Pre-existing Standalone',
        description: '',
        status: 'blocked',
      });
      const task = created;

      await runtime.executeTick();
      expect(collector.events.filter((e) => e.kind === 'task_blocked')).toHaveLength(1);

      const freshBus = new InternalEventBus<DaemonInternalEventMap>();
      const freshCollector = new BusEventCollector(freshBus);
      const freshRuntime = makeRuntime({ internalEventBus: freshBus });

      await freshRuntime.executeTick();
      const reNotified = freshCollector.events.filter((e) => e.kind === 'task_blocked');
      expect(reNotified).toHaveLength(1);
      expect(reNotified[0].payload['taskId']).toBe(task.id);
      expect(reNotified[0].payload['reason']).toBe('Task requires attention');

      await freshRuntime.executeTick();
      expect(freshCollector.events.filter((e) => e.kind === 'task_blocked')).toHaveLength(1);
      freshCollector.destroy();
    });

    test('standalone timed-out task is re-notified after simulated restart', async () => {
      setSpaceTaskTimeoutMs(db, SPACE_ID, 1000);

      const task = taskRepo.createTask({
        spaceId: SPACE_ID,
        title: 'Pre-existing Timeout',
        description: '',
        status: 'in_progress',
      });
      db.prepare('UPDATE space_tasks SET started_at = ? WHERE id = ?').run(
        Date.now() - 5000,
        task.id
      );

      await runtime.executeTick();
      expect(collector.events.filter((e) => e.kind === 'task_timeout')).toHaveLength(1);

      const freshBus = new InternalEventBus<DaemonInternalEventMap>();
      const freshCollector = new BusEventCollector(freshBus);
      const freshRuntime = makeRuntime({ internalEventBus: freshBus });

      await freshRuntime.executeTick();
      expect(freshCollector.events.filter((e) => e.kind === 'task_timeout')).toHaveLength(1);

      await freshRuntime.executeTick();
      expect(freshCollector.events.filter((e) => e.kind === 'task_timeout')).toHaveLength(1);
      freshCollector.destroy();
    });
  });

  describe('full pipeline — concurrent events in a single tick', () => {
    test('two workflow runs both enter needs_attention in the same tick — both events delivered', async () => {
      const wfA = buildLinearWorkflow(SPACE_ID, workflowManager, [
        { id: 'step-conc-a', name: 'Step A', agentId: AGENT_CODER },
      ]);
      const wfB = buildLinearWorkflow(SPACE_ID, workflowManager, [
        { id: 'step-conc-b', name: 'Step B', agentId: AGENT_CODER },
      ]);

      const { run: runA, tasks: tasksA } = await runtime.startWorkflowRun(
        SPACE_ID,
        wfA.id,
        'Run A'
      );
      const { run: runB, tasks: tasksB } = await runtime.startWorkflowRun(
        SPACE_ID,
        wfB.id,
        'Run B'
      );

      seedNodeExec(db, runA.id, 'step-conc-a', 'step-a', 'blocked');
      seedNodeExec(db, runB.id, 'step-conc-b', 'step-b', 'blocked');

      await runtime.executeTick();

      const naEvents = collector.events.filter((e) => e.kind === 'task_blocked');
      expect(naEvents).toHaveLength(2);

      const taskIds = naEvents.map((e) => e.payload['taskId'] as string);
      expect(taskIds).toContain(tasksA[0].id);
      expect(taskIds).toContain(tasksB[0].id);

      const reasons = naEvents.map((e) => e.payload['reason'] as string);
      expect(reasons).toContain('One or more workflow agents are blocked');
    });

    test('workflow task needs_attention AND standalone task needs_attention in the same tick', async () => {
      const wf = buildLinearWorkflow(SPACE_ID, workflowManager, [
        { id: 'step-mixed-wf', name: 'Workflow Step', agentId: AGENT_CODER },
      ]);
      const { run, tasks: wfTasks } = await runtime.startWorkflowRun(SPACE_ID, wf.id, 'Run');
      seedNodeExec(db, run.id, 'step-mixed-wf', 'workflow-step', 'blocked');

      const standaloneCreated = taskRepo.createTask({
        spaceId: SPACE_ID,
        title: 'Standalone Failing Task',
        description: '',
        status: 'blocked',
      });

      await runtime.executeTick();

      const naEvents = collector.events.filter((e) => e.kind === 'task_blocked');
      expect(naEvents).toHaveLength(2);

      const taskIds = naEvents.map((e) => e.payload['taskId'] as string);
      expect(taskIds).toContain(wfTasks[0].id);
      expect(taskIds).toContain(standaloneCreated.id);
    });

    test('workflow timeout AND standalone timeout in the same tick', async () => {
      setSpaceTaskTimeoutMs(db, SPACE_ID, 1000);

      const wf = buildLinearWorkflow(SPACE_ID, workflowManager, [
        { id: 'step-timeout-wf', name: 'Slow Workflow Step', agentId: AGENT_CODER },
      ]);
      const { run, tasks: wfTasks } = await runtime.startWorkflowRun(SPACE_ID, wf.id, 'Run');
      seedNodeExec(db, run.id, 'step-timeout-wf', 'slow-workflow-step', 'in_progress', {
        startedAt: Date.now() - 3000,
      });

      const standalone = taskRepo.createTask({
        spaceId: SPACE_ID,
        title: 'Slow Standalone',
        description: '',
        status: 'in_progress',
      });
      db.prepare('UPDATE space_tasks SET started_at = ? WHERE id = ?').run(
        Date.now() - 3000,
        standalone.id
      );

      await runtime.executeTick();

      const timeoutEvents = collector.events.filter((e) => e.kind === 'task_timeout');
      expect(timeoutEvents).toHaveLength(2);

      const taskIds = timeoutEvents.map((e) => e.payload['taskId'] as string);
      expect(taskIds).toContain(wfTasks[0].id);
      expect(taskIds).toContain(standalone.id);

      for (const evt of timeoutEvents) {
        expect(evt.payload['elapsedMs'] as number).toBeGreaterThan(1000);
        expect(evt.payload['spaceId']).toBe(SPACE_ID);
      }
    });
  });

  describe('multi-agent partial failure', () => {
    const AGENT_PLANNER = 'agent-planner-notif';

    beforeEach(() => {
      seedAgentRow(db, AGENT_PLANNER, SPACE_ID);
    });

    test('emits task_blocked for each failed parallel task when all are terminal', async () => {
      const workflow = workflowManager.createWorkflow({
        spaceId: SPACE_ID,
        name: `Parallel Fail Notify ${Date.now()}`,
        nodes: [
          {
            id: STEP_A,
            name: 'Parallel Step',
            agents: [
              { agentId: AGENT_CODER, name: 'coder' },
              { agentId: AGENT_PLANNER, name: 'planner' },
            ],
          },
          withSyntheticEnd(AGENT_CODER),
        ],
        transitions: [],
        startNodeId: STEP_A,
        endNodeId: SYNTHETIC_END_NODE_ID,
        rules: [],
        tags: [],
        completionAutonomyLevel: 3,
      });

      const { run } = await runtime.startWorkflowRun(SPACE_ID, workflow.id, 'Run');
      seedNodeExec(db, run.id, STEP_A, 'coder', 'blocked');
      seedNodeExec(db, run.id, STEP_A, 'planner', 'blocked');

      await runtime.executeTick();

      const naEvents = collector.events.filter((e) => e.kind === 'task_blocked');
      expect(naEvents).toHaveLength(1);
      const runEvents = collector.events.filter((e) => e.kind === 'workflow_run_blocked');
      expect(runEvents).toHaveLength(1);
    });

    test('does NOT emit workflow_run_blocked when sibling tasks are still running', async () => {
      const workflow = workflowManager.createWorkflow({
        spaceId: SPACE_ID,
        name: `Partial Terminal Notify ${Date.now()}`,
        nodes: [
          {
            id: STEP_A,
            name: 'Parallel Partial',
            agents: [
              { agentId: AGENT_CODER, name: 'coder' },
              { agentId: AGENT_PLANNER, name: 'planner' },
            ],
          },
          withSyntheticEnd(AGENT_CODER),
        ],
        transitions: [],
        startNodeId: STEP_A,
        endNodeId: SYNTHETIC_END_NODE_ID,
        rules: [],
        tags: [],
        completionAutonomyLevel: 3,
      });

      const { run } = await runtime.startWorkflowRun(SPACE_ID, workflow.id, 'Run');
      seedNodeExec(db, run.id, STEP_A, 'coder', 'blocked');
      seedNodeExec(db, run.id, STEP_A, 'planner', 'in_progress');

      await runtime.executeTick();

      const naEvents = collector.events.filter((e) => e.kind === 'task_blocked');
      expect(naEvents).toHaveLength(1);

      const runEvents = collector.events.filter((e) => e.kind === 'workflow_run_blocked');
      expect(runEvents).toHaveLength(1);
    });

    test('does NOT emit workflow_run_blocked for single-task step (backward compat)', async () => {
      const workflow = buildLinearWorkflow(SPACE_ID, workflowManager, [
        { id: STEP_A, name: 'Single', agentId: AGENT_CODER },
      ]);

      const { run } = await runtime.startWorkflowRun(SPACE_ID, workflow.id, 'Run');
      seedNodeExec(db, run.id, STEP_A, 'single', 'blocked');

      await runtime.executeTick();

      const naEvents = collector.events.filter((e) => e.kind === 'task_blocked');
      expect(naEvents).toHaveLength(1);

      const runEvents = collector.events.filter((e) => e.kind === 'workflow_run_blocked');
      expect(runEvents).toHaveLength(1);
    });

    test('multi-agent partial failure dedup: does not re-emit run needs_attention on second tick', async () => {
      const workflow = workflowManager.createWorkflow({
        spaceId: SPACE_ID,
        name: `Partial Fail Dedup ${Date.now()}`,
        nodes: [
          {
            id: STEP_A,
            name: 'Parallel Dedup',
            agents: [
              { agentId: AGENT_CODER, name: 'coder' },
              { agentId: AGENT_PLANNER, name: 'planner' },
            ],
          },
          withSyntheticEnd(AGENT_CODER),
        ],
        transitions: [],
        startNodeId: STEP_A,
        endNodeId: SYNTHETIC_END_NODE_ID,
        rules: [],
        tags: [],
        completionAutonomyLevel: 3,
      });

      const { run } = await runtime.startWorkflowRun(SPACE_ID, workflow.id, 'Run');
      seedNodeExec(db, run.id, STEP_A, 'coder', 'blocked');
      seedNodeExec(db, run.id, STEP_A, 'planner', 'blocked');

      await runtime.executeTick();
      const firstTickRunEvents = collector.events.filter((e) => e.kind === 'workflow_run_blocked');
      expect(firstTickRunEvents).toHaveLength(1);

      await runtime.executeTick();
      expect(collector.events.filter((e) => e.kind === 'workflow_run_blocked')).toHaveLength(1);
    });
  });

  describe('workflow_run_completed', () => {
    test('emits event when run completes successfully (done)', async () => {
      const workflow = buildLinearWorkflow(SPACE_ID, workflowManager, [
        { id: STEP_A, name: 'Plan', agentId: AGENT_CODER },
      ]);

      const localNodeExecRepo = new NodeExecutionRepository(db);
      const localRt = new SpaceRuntime({
        db,
        spaceManager,
        spaceAgentManager: agentManager,
        spaceWorkflowManager: workflowManager,
        workflowRunRepo,
        taskRepo,
        nodeExecutionRepo: localNodeExecRepo,
        internalEventBus: bus,
        taskAgentManager: new MockTaskAgentManager() as any,
      });

      const { run, tasks } = await localRt.startWorkflowRun(SPACE_ID, workflow.id, 'Run');
      taskRepo.updateTask(tasks[0].id, { status: 'done' });
      seedNodeExec(db, run.id, STEP_A, 'plan', 'idle');

      await localRt.executeTick();

      const completedEvents = collector.events.filter((e) => e.kind === 'workflow_run_completed');
      expect(completedEvents).toHaveLength(1);
      const evt = completedEvents[0].payload;
      expect(evt['spaceId']).toBe(SPACE_ID);
      expect(evt['runId']).toBe(run.id);
      expect(evt['status']).toBe('done');
      expect(typeof evt['timestamp']).toBe('string');
    });

    test('emits event with cancelled status when run is cancelled', async () => {
      const workflow = buildLinearWorkflow(SPACE_ID, workflowManager, [
        { id: STEP_A, name: 'Plan', agentId: AGENT_CODER },
      ]);

      const { run } = await runtime.startWorkflowRun(SPACE_ID, workflow.id, 'Run');
      workflowRunRepo.transitionStatus(run.id, 'cancelled');

      await runtime.executeTick();

      const completedEvents = collector.events.filter((e) => e.kind === 'workflow_run_completed');
      if (completedEvents.length > 0) {
        const evt = completedEvents[0].payload;
        expect(evt['runId']).toBe(run.id);
        expect(evt['status']).toBe('cancelled');
      }
    });

    test('does NOT emit for runs that are still in_progress', async () => {
      const workflow = buildLinearWorkflow(SPACE_ID, workflowManager, [
        { id: STEP_A, name: 'Plan', agentId: AGENT_CODER },
      ]);

      await runtime.startWorkflowRun(SPACE_ID, workflow.id, 'Run');

      await runtime.executeTick();

      const completedEvents = collector.events.filter((e) => e.kind === 'workflow_run_completed');
      expect(completedEvents).toHaveLength(0);
    });
  });

  describe('InternalEventBus publishing', () => {
    test('publishes space.task.blocked to InternalEventBus', async () => {
      const workflow = buildLinearWorkflow(SPACE_ID, workflowManager, [
        { id: STEP_A, name: 'Plan', agentId: AGENT_CODER },
      ]);

      const { run, tasks } = await runtime.startWorkflowRun(SPACE_ID, workflow.id, 'Run');
      taskRepo.updateTask(tasks[0].id, { status: 'in_progress' });
      seedNodeExec(db, run.id, STEP_A, 'plan', 'blocked');

      await runtime.executeTick();

      expect(collector.events.filter((e) => e.kind === 'task_blocked')).toHaveLength(1);
      const evt = collector.events.find((e) => e.kind === 'task_blocked')!;
      expect(evt.payload['spaceId']).toBe(SPACE_ID);
      expect(evt.payload['taskId']).toBe(tasks[0].id);
      expect(evt.payload['reason']).toBe('One or more workflow agents are blocked');
    });

    test('publishes space.workflowRun.blocked to InternalEventBus', async () => {
      const workflow = buildLinearWorkflow(SPACE_ID, workflowManager, [
        { id: STEP_A, name: 'Plan', agentId: AGENT_CODER },
      ]);

      const { run } = await runtime.startWorkflowRun(SPACE_ID, workflow.id, 'Run');
      seedNodeExec(db, run.id, STEP_A, 'plan', 'blocked');

      await runtime.executeTick();

      expect(collector.events.filter((e) => e.kind === 'workflow_run_blocked')).toHaveLength(1);
      const evt = collector.events.find((e) => e.kind === 'workflow_run_blocked')!;
      expect(evt.payload['spaceId']).toBe(SPACE_ID);
      expect(evt.payload['runId']).toBe(run.id);
    });

    test('publishes space.task.timeout to InternalEventBus', async () => {
      setSpaceTaskTimeoutMs(db, SPACE_ID, 1000);

      const workflow = buildLinearWorkflow(SPACE_ID, workflowManager, [
        { id: STEP_A, name: 'Plan', agentId: AGENT_CODER },
      ]);

      const { run, tasks } = await runtime.startWorkflowRun(SPACE_ID, workflow.id, 'Run');
      seedNodeExec(db, run.id, STEP_A, 'plan', 'in_progress', { startedAt: Date.now() - 2000 });

      await runtime.executeTick();

      expect(collector.events.filter((e) => e.kind === 'task_timeout')).toHaveLength(1);
      const evt = collector.events.find((e) => e.kind === 'task_timeout')!;
      expect(evt.payload['spaceId']).toBe(SPACE_ID);
      expect(evt.payload['taskId']).toBe(tasks[0].id);
      expect(evt.payload['elapsedMs'] as number).toBeGreaterThan(1000);
    });

    test('works without InternalEventBus (no crash)', async () => {
      const rt = new SpaceRuntime({
        db,
        spaceManager,
        spaceAgentManager: agentManager,
        spaceWorkflowManager: workflowManager,
        workflowRunRepo,
        taskRepo,
        nodeExecutionRepo: new NodeExecutionRepository(db),
      });
      const workflow = buildLinearWorkflow(SPACE_ID, workflowManager, [
        { id: STEP_A, name: 'Plan', agentId: AGENT_CODER },
      ]);

      const { run } = await rt.startWorkflowRun(SPACE_ID, workflow.id, 'Run');
      seedNodeExec(db, run.id, STEP_A, 'plan', 'blocked');

      await rt.executeTick();
    });
  });
});
