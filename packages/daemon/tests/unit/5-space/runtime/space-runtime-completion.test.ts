import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { Database as BunDatabase } from '../../../../src/storage/sqlite-compat';
import { runMigrations } from '../../../../src/storage/schema/index.ts';
import { SpaceWorkflowRepository } from '../../../../src/storage/repositories/space-workflow-repository.ts';
import { SpaceWorkflowRunRepository } from '../../../../src/storage/repositories/space-workflow-run-repository.ts';
import { WorkflowRunArtifactRepository } from '../../../../src/storage/repositories/workflow-run-artifact-repository.ts';
import { CodingArtifactProfile } from '../../../../src/lib/space/workflows/coding-artifact-profile.ts';
import { SpaceTaskRepository } from '../../../../src/storage/repositories/space-task-repository.ts';
import { SpaceAgentRepository } from '../../../../src/storage/repositories/space-agent-repository.ts';
import { EvolutionScopeService } from '../../../../src/lib/space/evolution-scope-service.ts';
import { EvolutionRepository } from '../../../../src/storage/repositories/evolution-repository.ts';
import { SpaceRepository } from '../../../../src/storage/repositories/space-repository.ts';
import { SpaceGoalRepository } from '../../../../src/storage/repositories/space-goal-repository.ts';
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

function seedAgentRow(db: BunDatabase, agentId: string, spaceId: string): void {
  db.prepare(
    `INSERT INTO space_agents (id, space_id, name, description, model, tools, system_prompt, created_at, updated_at)
     VALUES (?, ?, ?, '', null, '[]', '', ?, ?)`
  ).run(agentId, spaceId, `Agent ${agentId}`, Date.now(), Date.now());
}

function buildLinearWorkflow(
  spaceId: string,
  workflowManager: SpaceWorkflowManager,
  nodes: Array<{ id: string; name: string; agentId: string }>,
  channels?: Array<{ from: string; to: string | string[] }>
): SpaceWorkflow {
  return workflowManager.createWorkflow({
    spaceId,
    name: `Workflow ${Date.now()}-${Math.random()}`,
    description: '',
    nodes,
    transitions: [],
    startNodeId: nodes[0].id,
    rules: [],
    tags: [],
    channels,
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

function seedNodeExec(
  db: BunDatabase,
  workflowRunId: string,
  workflowNodeId: string,
  agentName: string,
  status: string
): string {
  const repo = new NodeExecutionRepository(db);
  const existing = repo.listByNode(workflowRunId, workflowNodeId);
  if (existing.length > 0) {
    const byAgent = existing.find((exec) => exec.agentName === agentName);
    const target = byAgent ?? (existing.length === 1 ? existing[0] : null);
    if (target) {
      repo.update(target.id, {
        status: status as 'pending' | 'in_progress' | 'idle' | 'done' | 'cancelled' | 'blocked',
        result: null,
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
		     VALUES (?, ?, ?, ?, NULL, NULL, ?, NULL, ?, NULL, NULL, ?)`
  ).run(id, workflowRunId, workflowNodeId, agentName, status, now, now);
  return id;
}

class MockTaskAgentManager {
  readonly cancelledSessions: string[] = [];
  readonly interruptedSessions: string[] = [];
  readonly spawnedExecutionSessions: string[] = [];
  readonly spawnedPostApprovalSessions: string[] = [];

  constructor(private readonly nodeExecutionRepo?: NodeExecutionRepository) {}

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

  async spawnWorkflowNodeAgent(
    _task: SpaceTask,
    _space: Space,
    _workflow: SpaceWorkflow | null,
    _run: SpaceWorkflowRun | null
  ): Promise<string> {
    return 'mock-session';
  }

  async spawnWorkflowNodeAgentForExecution(
    _task: SpaceTask,
    _space: Space,
    _workflow: SpaceWorkflow,
    _run: SpaceWorkflowRun,
    execution: { id: string }
  ): Promise<string> {
    const sessionId = `mock-session:${execution.id}`;
    this.spawnedExecutionSessions.push(sessionId);
    this.nodeExecutionRepo?.update(execution.id, {
      status: 'in_progress',
      agentSessionId: sessionId,
      startedAt: Date.now(),
      completedAt: null,
    });
    return sessionId;
  }

  async rehydrate(): Promise<void> {}

  cancelBySessionId(agentSessionId: string): void {
    this.cancelledSessions.push(agentSessionId);
  }

  async interruptBySessionId(agentSessionId: string): Promise<void> {
    this.interruptedSessions.push(agentSessionId);
  }

  async injectIntoTaskAgent(
    _taskId: string,
    _awarenessBody: string
  ): Promise<{ injected: boolean; reason?: string }> {
    return { injected: false, reason: 'no-session' };
  }

  async spawnPostApprovalSubSession(args: {
    task: SpaceTask;
    workflow: SpaceWorkflow;
    targetAgent: string;
    kickoffMessage: string;
  }): Promise<{ sessionId: string }> {
    const { task, workflow, targetAgent } = args;
    let matchedNodeId: string | null = null;
    let matchedAgentId: string | null = null;
    for (const node of workflow.nodes) {
      for (const slot of node.agents ?? []) {
        if (slot.name === targetAgent || slot.agentId === targetAgent) {
          matchedNodeId = node.id;
          matchedAgentId = slot.agentId ?? null;
          break;
        }
      }
      if (matchedNodeId) break;
    }
    if (!matchedNodeId) {
      throw new Error(
        `MockTaskAgentManager.spawnPostApprovalSubSession: no agent slot "${targetAgent}" in workflow ${workflow.id}`
      );
    }
    const sessionId = `mock-postapproval:${task.id}`;
    if (this.nodeExecutionRepo && task.workflowRunId) {
      const existing = this.nodeExecutionRepo.listByNode(task.workflowRunId, matchedNodeId);
      const row = existing[0];
      if (row) {
        this.nodeExecutionRepo.update(row.id, {
          status: 'in_progress',
          agentSessionId: sessionId,
          startedAt: Date.now(),
          completedAt: null,
        });
      } else {
        this.nodeExecutionRepo.createOrIgnore({
          workflowRunId: task.workflowRunId,
          workflowNodeId: matchedNodeId,
          agentName: targetAgent,
          agentId: matchedAgentId ?? undefined,
          agentSessionId: sessionId,
          status: 'in_progress',
        });
      }
    }
    this.spawnedPostApprovalSessions.push(sessionId);
    return { sessionId };
  }
}

describe('SpaceRuntime — completion detection & status transitions', () => {
  let db: BunDatabase;

  let workflowRunRepo: SpaceWorkflowRunRepository;
  let artifactRepo: WorkflowRunArtifactRepository;
  let taskRepo: SpaceTaskRepository;
  let agentManager: SpaceAgentManager;
  let workflowManager: SpaceWorkflowManager;
  let spaceManager: SpaceManager;
  let bus: InternalEventBus<DaemonInternalEventMap>;
  let collector: BusEventCollector;

  let nodeExecutionRepo: NodeExecutionRepository;

  const SPACE_ID = 'space-cd-1';
  const WORKSPACE = '/tmp/cd-ws';
  const AGENT_A = 'agent-cd-a';
  const AGENT_B = 'agent-cd-b';
  const AGENT_C = 'agent-cd-c';

  function makeRuntimeWithTam(extraConfig?: Partial<SpaceRuntimeConfig>): SpaceRuntime {
    const nodeExecutionRepo = new NodeExecutionRepository(db);
    const config: SpaceRuntimeConfig = {
      db,
      spaceManager,
      spaceAgentManager: agentManager,
      spaceWorkflowManager: workflowManager,
      workflowRunRepo,
      taskRepo,
      artifactRepo,
      nodeExecutionRepo,
      artifactProfile: new CodingArtifactProfile({ db, artifactRepo }),
      internalEventBus: bus,
      taskAgentManager: new MockTaskAgentManager(nodeExecutionRepo) as unknown as TaskAgentManager,
      ...extraConfig,
    };
    return new SpaceRuntime(config);
  }

  beforeEach(() => {
    db = makeDb();

    seedSpaceRow(db, SPACE_ID, WORKSPACE);
    seedAgentRow(db, AGENT_A, SPACE_ID);
    seedAgentRow(db, AGENT_B, SPACE_ID);
    seedAgentRow(db, AGENT_C, SPACE_ID);

    workflowRunRepo = new SpaceWorkflowRunRepository(db);
    artifactRepo = new WorkflowRunArtifactRepository(db);
    taskRepo = new SpaceTaskRepository(db);

    const agentRepo = new SpaceAgentRepository(db);
    agentManager = new SpaceAgentManager(agentRepo);

    const workflowRepo = new SpaceWorkflowRepository(db);
    workflowManager = new SpaceWorkflowManager(workflowRepo);

    spaceManager = new SpaceManager(db);
    bus = new InternalEventBus<DaemonInternalEventMap>();
    collector = new BusEventCollector(bus);
    nodeExecutionRepo = new NodeExecutionRepository(db);
  });

  afterEach(() => {
    collector.destroy();
    try {
      db.close();
    } catch {
      /* ignore */
    }
    try {
    } catch {
      /* ignore */
    }
  });

  describe('artifact-backed task result capture', () => {
    test('completion result artifact populates task result, reportedSummary, and Forge task_result evidence', async () => {
      const SUMMARY = 'Smoke result artifact captured PR-ready outcome';
      const rt = makeRuntimeWithTam();
      const workflow = buildLinearWorkflow(SPACE_ID, workflowManager, [
        { id: 'node-artifact-result', name: 'Coding', agentId: AGENT_A },
      ]);
      const evolutionRepo = new EvolutionRepository(db);
      const scope = evolutionRepo.createScope({
        spaceId: SPACE_ID,
        kind: 'custom',
        name: 'Forge self-validation smoke',
        objective:
          'Validate result artifact auto-capture after PR #1991; a task cannot validate a fix that only runs after merge/restart, so this follow-up task guards future regressions.',
      });
      const evolutionScopeService = new EvolutionScopeService({
        evolutionRepo,
        spaceRepo: new SpaceRepository(db),
        goalRepo: new SpaceGoalRepository(db),
        taskRepo,
        workflowRunRepo,
        artifactRepo,
      });

      const { run, tasks } = await rt.startWorkflowRun(SPACE_ID, workflow.id, 'Result smoke run');
      const task = tasks[0];
      taskRepo.updateTask(task.id, { evolutionScopeId: scope.id, status: 'done' });
      artifactRepo.upsert({
        id: 'artifact-task-result-smoke',
        runId: run.id,
        nodeId: 'node-artifact-result',
        artifactType: 'decision',
        artifactKey: 'final',
        data: { summary: SUMMARY, pr_url: 'https://github.com/neokai/neokai/pull/1991' },
      });
      seedNodeExec(db, run.id, 'node-artifact-result', 'agent', 'idle');

      await rt.executeTick();

      const completedTask = taskRepo.getTask(task.id)!;
      expect(workflowRunRepo.getRun(run.id)?.status).toBe('done');
      expect(completedTask.result).toBe(SUMMARY);
      expect(completedTask.reportedSummary).toBe(SUMMARY);
      const evidence = evolutionScopeService.captureCompletedTaskEvidence({
        taskId: task.id,
      }).evidence;
      const taskEvidence = evidence.find((item) => item.kind === 'task_result');
      expect(taskEvidence?.summary).toContain(SUMMARY);
      expect(taskEvidence?.summary).not.toContain('completed without task.result');
      expect(taskEvidence?.metadata.result).toBe(SUMMARY);
      expect(taskEvidence?.metadata.reportedSummary).toBe(SUMMARY);
    });
  });

  describe('completedAt timestamp', () => {
    test('sets completedAt when CompletionDetector marks run as done', async () => {
      const rt = makeRuntimeWithTam();
      const workflow = buildLinearWorkflow(SPACE_ID, workflowManager, [
        { id: 'step-ts', name: 'Step', agentId: AGENT_A },
      ]);

      const { run, tasks } = await rt.startWorkflowRun(SPACE_ID, workflow.id, 'Run');

      const freshRun = workflowRunRepo.getRun(run.id);
      expect(freshRun?.completedAt).toBeNull();

      taskRepo.updateTask(tasks[0].id, { status: 'done' });

      seedNodeExec(db, run.id, 'step-ts', 'agent', 'idle');

      const beforeTick = Date.now();
      await rt.executeTick();

      const completedRun = workflowRunRepo.getRun(run.id);
      expect(completedRun?.status).toBe('done');
      expect(completedRun?.completedAt).toBeDefined();
      expect(typeof completedRun?.completedAt).toBe('number');
      expect(completedRun!.completedAt!).toBeGreaterThanOrEqual(beforeTick);
      expect(completedRun!.completedAt!).toBeLessThanOrEqual(Date.now() + 100);
    });
  });

  describe('multi-node workflow completion', () => {
    test('multi-node with all tasks done → run completes', async () => {
      const rt = makeRuntimeWithTam();
      const workflow = buildLinearWorkflow(SPACE_ID, workflowManager, [
        { id: 'node-cd-1', name: 'Plan', agentId: AGENT_B },
        { id: 'node-cd-2', name: 'Code', agentId: AGENT_A },
      ]);

      const { run, tasks } = await rt.startWorkflowRun(SPACE_ID, workflow.id, 'Run');
      expect(tasks).toHaveLength(1);

      taskRepo.updateTask(tasks[0].id, { status: 'done' });

      const taskManager = rt.getTaskManagerForSpace(SPACE_ID);
      const secondTask = await taskManager.createTask({
        title: 'Code',
        description: '',
        workflowRunId: run.id,
        workflowNodeId: 'node-cd-2',
        taskType: 'coding',
        agentName: 'coder',
        status: 'done',
      });

      seedNodeExec(db, run.id, 'node-cd-1', 'agent', 'idle');
      seedNodeExec(db, run.id, 'node-cd-2', 'coder', 'idle');

      await rt.executeTick();

      const completedRun = workflowRunRepo.getRun(run.id);
      expect(completedRun?.status).toBe('done');
      expect(completedRun?.completedAt).toBeDefined();

      const completedEvents = collector.events.filter((e) => e.kind === 'workflow_run_completed');
      expect(completedEvents).toHaveLength(1);
      if (completedEvents[0].kind === 'workflow_run_completed') {
        expect(completedEvents[0].payload['runId']).toBe(run.id);
        expect(completedEvents[0].payload['status']).toBe('done');
      }
    });

    test('multi-node with mixed terminal statuses (done + cancelled) → run completes', async () => {
      const rt = makeRuntimeWithTam();
      const workflow = buildLinearWorkflow(SPACE_ID, workflowManager, [
        { id: 'node-mix-1', name: 'Plan', agentId: AGENT_B },
        { id: 'node-mix-2', name: 'Code', agentId: AGENT_A },
      ]);

      const { run, tasks } = await rt.startWorkflowRun(SPACE_ID, workflow.id, 'Run');

      taskRepo.updateTask(tasks[0].id, { status: 'done' });

      const taskManager = rt.getTaskManagerForSpace(SPACE_ID);
      await taskManager.createTask({
        title: 'Code',
        description: '',
        workflowRunId: run.id,
        workflowNodeId: 'node-mix-2',
        taskType: 'coding',
        agentName: 'coder',
        status: 'cancelled',
      });

      seedNodeExec(db, run.id, 'node-mix-1', 'agent', 'idle');
      seedNodeExec(db, run.id, 'node-mix-2', 'coder', 'cancelled');

      await rt.executeTick();

      const completedRun = workflowRunRepo.getRun(run.id);
      expect(completedRun?.status).toBe('done');

      const completedEvents = collector.events.filter((e) => e.kind === 'workflow_run_completed');
      expect(completedEvents).toHaveLength(1);
    });

    test('multi-node with canonical task in_progress → run does NOT complete', async () => {
      const rt = makeRuntimeWithTam();
      const workflow = buildLinearWorkflow(SPACE_ID, workflowManager, [
        { id: 'node-ip-1', name: 'Plan', agentId: AGENT_B },
        { id: 'node-ip-2', name: 'Code', agentId: AGENT_A },
      ]);

      const { run } = await rt.startWorkflowRun(SPACE_ID, workflow.id, 'Run');

      seedNodeExec(db, run.id, 'node-ip-1', 'agent', 'idle');
      seedNodeExec(db, run.id, 'node-ip-2', 'coder', 'in_progress');

      await rt.executeTick();

      const runAfter = workflowRunRepo.getRun(run.id);
      expect(runAfter?.status).toBe('in_progress');

      const completedEvents = collector.events.filter((e) => e.kind === 'workflow_run_completed');
      expect(completedEvents).toHaveLength(0);
    });
  });

  describe('tick loop early returns', () => {
    test('processRunTick skips run in blocked state', async () => {
      const rt = makeRuntimeWithTam();
      const workflow = buildLinearWorkflow(SPACE_ID, workflowManager, [
        { id: 'step-na-skip', name: 'Step', agentId: AGENT_A },
      ]);

      const { run, tasks } = await rt.startWorkflowRun(SPACE_ID, workflow.id, 'Run');
      workflowRunRepo.transitionStatus(run.id, 'blocked');

      taskRepo.updateTask(tasks[0].id, { status: 'done' });

      await rt.executeTick();

      const runAfter = workflowRunRepo.getRun(run.id);
      expect(runAfter?.status).toBe('blocked');

      const completedEvents = collector.events.filter((e) => e.kind === 'workflow_run_completed');
      expect(completedEvents).toHaveLength(0);
    });

    test('processRunTick skips run in done state', async () => {
      const rt = makeRuntimeWithTam();
      const workflow = buildLinearWorkflow(SPACE_ID, workflowManager, [
        { id: 'step-done-skip', name: 'Step', agentId: AGENT_A },
      ]);

      const { run, tasks } = await rt.startWorkflowRun(SPACE_ID, workflow.id, 'Run');

      taskRepo.updateTask(tasks[0].id, { status: 'done' });
      seedNodeExec(db, run.id, 'step-done-skip', 'agent', 'idle');
      await rt.executeTick();

      expect(workflowRunRepo.getRun(run.id)?.status).toBe('done');
      expect(rt.executorCount).toBe(0);

      collector.clear();

      await rt.executeTick();
      expect(collector.events).toHaveLength(0);
    });

    test('processRunTick skips run in cancelled state', async () => {
      const rt = makeRuntimeWithTam();
      const workflow = buildLinearWorkflow(SPACE_ID, workflowManager, [
        { id: 'step-cancel-skip', name: 'Step', agentId: AGENT_A },
      ]);

      const { run } = await rt.startWorkflowRun(SPACE_ID, workflow.id, 'Run');

      workflowRunRepo.transitionStatus(run.id, 'cancelled');

      collector.clear();
      await rt.executeTick();

      const completedEvents = collector.events.filter((e) => e.kind === 'workflow_run_completed');
      expect(completedEvents).toHaveLength(0);

      expect(rt.executorCount).toBe(0);
    });
  });

  describe('status transition lifecycle', () => {
    test('in_progress → done is a valid transition via CompletionDetector', async () => {
      const rt = makeRuntimeWithTam();
      const workflow = buildLinearWorkflow(SPACE_ID, workflowManager, [
        { id: 'step-lifecycle', name: 'Step', agentId: AGENT_A },
      ]);

      const { run, tasks } = await rt.startWorkflowRun(SPACE_ID, workflow.id, 'Run');
      expect(run.status).toBe('in_progress');

      taskRepo.updateTask(tasks[0].id, { status: 'done' });
      seedNodeExec(db, run.id, 'step-lifecycle', 'agent', 'idle');
      await rt.executeTick();

      const runAfter = workflowRunRepo.getRun(run.id);
      expect(runAfter?.status).toBe('done');
    });

    test('done run cannot transition again — subsequent ticks are no-ops', async () => {
      const rt = makeRuntimeWithTam();
      const workflow = buildLinearWorkflow(SPACE_ID, workflowManager, [
        { id: 'step-Immutable', name: 'Step', agentId: AGENT_A },
      ]);

      const { run, tasks } = await rt.startWorkflowRun(SPACE_ID, workflow.id, 'Run');

      taskRepo.updateTask(tasks[0].id, { status: 'done' });
      seedNodeExec(db, run.id, 'step-Immutable', 'agent', 'idle');
      await rt.executeTick();

      expect(workflowRunRepo.getRun(run.id)?.status).toBe('done');
      expect(collector.events.filter((e) => e.kind === 'workflow_run_completed')).toHaveLength(1);

      await rt.executeTick();
      await rt.executeTick();
      await rt.executeTick();

      expect(collector.events.filter((e) => e.kind === 'workflow_run_completed')).toHaveLength(1);
    });

    test('blocked run does not auto-complete even when all tasks become terminal', async () => {
      const rt = makeRuntimeWithTam();
      const workflow = buildLinearWorkflow(SPACE_ID, workflowManager, [
        { id: 'step-na-no-auto', name: 'Step', agentId: AGENT_A },
      ]);

      const { run, tasks } = await rt.startWorkflowRun(SPACE_ID, workflow.id, 'Run');

      workflowRunRepo.transitionStatus(run.id, 'blocked');

      taskRepo.updateTask(tasks[0].id, { status: 'done' });

      await rt.executeTick();

      const runAfter = workflowRunRepo.getRun(run.id);
      expect(runAfter?.status).toBe('blocked');
      expect(runAfter?.completedAt).toBeNull();
    });

    test('canonical task in `blocked` is not pushed through dispatchPostApproval on run completion', async () => {
      const rt = makeRuntimeWithTam();
      const workflow = buildLinearWorkflow(SPACE_ID, workflowManager, [
        { id: 'node-blk-1', name: 'Plan', agentId: AGENT_B },
        { id: 'node-blk-2', name: 'Code', agentId: AGENT_A },
      ]);

      const { run, tasks } = await rt.startWorkflowRun(SPACE_ID, workflow.id, 'Run');
      expect(tasks).toHaveLength(1);

      taskRepo.updateTask(tasks[0].id, { status: 'done' });

      const taskManager = rt.getTaskManagerForSpace(SPACE_ID);
      const blockedTask = await taskManager.createTask({
        title: 'Code',
        description: '',
        workflowRunId: run.id,
        workflowNodeId: 'node-blk-2',
        taskType: 'coding',
        agentName: 'coder',
        status: 'blocked',
        blockReason: 'dependency_failed',
      });

      seedNodeExec(db, run.id, 'node-blk-1', 'agent', 'idle');
      seedNodeExec(db, run.id, 'node-blk-2', 'coder', 'idle');

      await rt.executeTick();

      expect(workflowRunRepo.getRun(run.id)?.status).toBe('done');

      const blockedAfter = taskRepo.getTask(blockedTask.id);
      expect(['blocked', 'archived']).toContain(blockedAfter?.status);
      expect(blockedAfter?.status).not.toBe('approved');
      expect(blockedAfter?.status).not.toBe('done');
    });

    test('blocked → in_progress → done lifecycle via resume', async () => {
      const rt = makeRuntimeWithTam();
      const workflow = buildLinearWorkflow(SPACE_ID, workflowManager, [
        { id: 'step-resume', name: 'Step', agentId: AGENT_A },
      ]);

      const { run, tasks } = await rt.startWorkflowRun(SPACE_ID, workflow.id, 'Run');

      workflowRunRepo.transitionStatus(run.id, 'blocked');
      expect(workflowRunRepo.getRun(run.id)?.status).toBe('blocked');

      workflowRunRepo.transitionStatus(run.id, 'in_progress');
      expect(workflowRunRepo.getRun(run.id)?.status).toBe('in_progress');

      taskRepo.updateTask(tasks[0].id, { status: 'done' });
      seedNodeExec(db, run.id, 'step-resume', 'agent', 'idle');
      await rt.executeTick();

      const finalRun = workflowRunRepo.getRun(run.id);
      expect(finalRun?.status).toBe('done');
      expect(finalRun?.completedAt).toBeDefined();

      const completedEvents = collector.events.filter((e) => e.kind === 'workflow_run_completed');
      expect(completedEvents).toHaveLength(1);
    });

    test('cascade-cancelling an in_progress dependent also cancels its workflow run', async () => {
      const rt = makeRuntimeWithTam();
      const workflowA = buildLinearWorkflow(SPACE_ID, workflowManager, [
        { id: 'node-cascade-a', name: 'A', agentId: AGENT_A },
      ]);
      const workflowB = buildLinearWorkflow(SPACE_ID, workflowManager, [
        { id: 'node-cascade-b', name: 'B', agentId: AGENT_A },
      ]);

      const { run: runA, tasks: tasksA } = await rt.startWorkflowRun(
        SPACE_ID,
        workflowA.id,
        'Run A'
      );
      const { run: runB, tasks: tasksB } = await rt.startWorkflowRun(
        SPACE_ID,
        workflowB.id,
        'Run B'
      );

      taskRepo.updateTask(tasksB[0].id, { dependsOn: [tasksA[0].id] });

      workflowRunRepo.transitionStatus(runA.id, 'cancelled');

      await rt.executeTick();

      expect(taskRepo.getTask(tasksA[0].id)?.status).toBe('cancelled');

      expect(taskRepo.getTask(tasksB[0].id)?.status).toBe('cancelled');

      expect(workflowRunRepo.getRun(runB.id)?.status).toBe('cancelled');
    });
  });

  describe('pending-but-blocked via workflow channels', () => {
    test('canonical task done → run completes (task-status drives completion)', async () => {
      const rt = makeRuntimeWithTam();

      const workflow = workflowManager.createWorkflow({
        spaceId: SPACE_ID,
        name: `Channeled Workflow ${Date.now()}`,
        description: '',
        nodes: [
          {
            id: 'chan-plan',
            name: 'planner',
            agents: [{ agentId: AGENT_B, name: 'Planner' }],
          },
          {
            id: 'chan-code',
            name: 'coder',
            agents: [{ agentId: AGENT_A, name: 'Coder' }],
          },
        ],
        startNodeId: 'chan-plan',
        tags: [],
        completionAutonomyLevel: 3,
      });

      const { run, tasks } = await rt.startWorkflowRun(SPACE_ID, workflow.id, 'Run');
      expect(tasks).toHaveLength(1);

      taskRepo.updateTask(tasks[0].id, { status: 'done' });
      seedNodeExec(db, run.id, 'chan-plan', 'Planner', 'idle');

      await rt.executeTick();

      const runAfter = workflowRunRepo.getRun(run.id);
      expect(runAfter?.status).toBe('done');

      const completedEvents = collector.events.filter((e) => e.kind === 'workflow_run_completed');
      expect(completedEvents).toHaveLength(1);
    });

    test('all channels satisfied — completion proceeds normally', async () => {
      const rt = makeRuntimeWithTam();

      const workflow = workflowManager.createWorkflow({
        spaceId: SPACE_ID,
        name: `Full Channel Workflow ${Date.now()}`,
        description: '',
        nodes: [
          { id: 'full-plan', name: 'planner', agentId: AGENT_B },
          { id: 'full-code', name: 'coder', agentId: AGENT_A },
        ],
        startNodeId: 'full-plan',
        rules: [],
        tags: [],
        transitions: [],
        completionAutonomyLevel: 3,
      });

      const { run, tasks } = await rt.startWorkflowRun(SPACE_ID, workflow.id, 'Run');

      taskRepo.updateTask(tasks[0].id, { status: 'done' });

      const taskManager = rt.getTaskManagerForSpace(SPACE_ID);
      await taskManager.createTask({
        title: 'Code',
        description: '',
        workflowRunId: run.id,
        workflowNodeId: 'full-code',
        taskType: 'coding',
        agentName: 'coder',
        status: 'done',
      });

      seedNodeExec(db, run.id, 'full-plan', 'agent', 'idle');
      seedNodeExec(db, run.id, 'full-code', 'coder', 'idle');

      await rt.executeTick();

      const completedRun = workflowRunRepo.getRun(run.id);
      expect(completedRun?.status).toBe('done');

      const completedEvents = collector.events.filter((e) => e.kind === 'workflow_run_completed');
      expect(completedEvents).toHaveLength(1);
    });

    test('no channels on workflow — completion only checks canonical task status', async () => {
      const rt = makeRuntimeWithTam();

      const workflow = buildLinearWorkflow(SPACE_ID, workflowManager, [
        { id: 'no-chan-1', name: 'Plan', agentId: AGENT_B },
        { id: 'no-chan-2', name: 'Code', agentId: AGENT_A },
      ]);

      const { run, tasks } = await rt.startWorkflowRun(SPACE_ID, workflow.id, 'Run');

      taskRepo.updateTask(tasks[0].id, { status: 'done' });
      seedNodeExec(db, run.id, 'no-chan-1', 'agent', 'idle');

      await rt.executeTick();

      const completedRun = workflowRunRepo.getRun(run.id);
      expect(completedRun?.status).toBe('done');

      const completedEvents = collector.events.filter((e) => e.kind === 'workflow_run_completed');
      expect(completedEvents).toHaveLength(1);
    });

    test('wildcard channel does not block completion', async () => {
      const rt = makeRuntimeWithTam();

      const workflow = workflowManager.createWorkflow({
        spaceId: SPACE_ID,
        name: `Wildcard Channel ${Date.now()}`,
        description: '',
        nodes: [{ id: 'wc-plan', name: 'planner', agentId: AGENT_B }],
        startNodeId: 'wc-plan',
        rules: [],
        tags: [],
        transitions: [],
        completionAutonomyLevel: 3,
      });

      const { run, tasks } = await rt.startWorkflowRun(SPACE_ID, workflow.id, 'Run');

      taskRepo.updateTask(tasks[0].id, { status: 'done' });
      seedNodeExec(db, run.id, 'wc-plan', 'planner', 'idle');

      await rt.executeTick();

      const completedRun = workflowRunRepo.getRun(run.id);
      expect(completedRun?.status).toBe('done');

      const completedEvents = collector.events.filter((e) => e.kind === 'workflow_run_completed');
      expect(completedEvents).toHaveLength(1);
    });
  });

  describe('multi-agent parallel node', () => {
    test('multi-agent step + canonical task done → run completes', async () => {
      const rt = makeRuntimeWithTam();
      const workflow = workflowManager.createWorkflow({
        spaceId: SPACE_ID,
        name: `Parallel Complete ${Date.now()}`,
        description: '',
        nodes: [
          {
            id: 'par-node',
            name: 'Parallel Step',
            agents: [
              { agentId: AGENT_A, name: 'coder' },
              { agentId: AGENT_B, name: 'planner' },
              { agentId: AGENT_C, name: 'general' },
            ],
          },
          withSyntheticEnd(AGENT_A),
        ],
        startNodeId: 'par-node',
        endNodeId: SYNTHETIC_END_NODE_ID,
        rules: [],
        tags: [],
        transitions: [],
        completionAutonomyLevel: 3,
      });

      const { run, tasks } = await rt.startWorkflowRun(SPACE_ID, workflow.id, 'Run');
      expect(tasks).toHaveLength(1);

      taskRepo.updateTask(tasks[0].id, { status: 'done' });
      seedNodeExec(db, run.id, 'par-node', 'coder', 'idle');
      seedNodeExec(db, run.id, 'par-node', 'planner', 'idle');
      seedNodeExec(db, run.id, 'par-node', 'general', 'cancelled');

      await rt.executeTick();

      const completedRun = workflowRunRepo.getRun(run.id);
      expect(completedRun?.status).toBe('done');
      expect(completedRun?.completedAt).toBeDefined();

      const completedEvents = collector.events.filter((e) => e.kind === 'workflow_run_completed');
      expect(completedEvents).toHaveLength(1);
    });

    test('multi-agent step + canonical task in_progress → run stays in_progress', async () => {
      const rt = makeRuntimeWithTam();
      const workflow = workflowManager.createWorkflow({
        spaceId: SPACE_ID,
        name: `Parallel Partial ${Date.now()}`,
        description: '',
        nodes: [
          {
            id: 'par-partial',
            name: 'Parallel Step',
            agents: [
              { agentId: AGENT_A, name: 'coder' },
              { agentId: AGENT_B, name: 'planner' },
            ],
          },
          withSyntheticEnd(AGENT_A),
        ],
        startNodeId: 'par-partial',
        endNodeId: SYNTHETIC_END_NODE_ID,
        rules: [],
        tags: [],
        transitions: [],
        completionAutonomyLevel: 3,
      });

      const { run } = await rt.startWorkflowRun(SPACE_ID, workflow.id, 'Run');

      seedNodeExec(db, run.id, 'par-partial', 'coder', 'idle');
      seedNodeExec(db, run.id, 'par-partial', 'planner', 'in_progress');

      await rt.executeTick();

      const runAfter = workflowRunRepo.getRun(run.id);
      expect(runAfter?.status).toBe('in_progress');

      const completedEvents = collector.events.filter((e) => e.kind === 'workflow_run_completed');
      expect(completedEvents).toHaveLength(0);
    });

    test('multi-agent step: completion detected when canonical task flips terminal', async () => {
      const rt = makeRuntimeWithTam();
      const workflow = workflowManager.createWorkflow({
        spaceId: SPACE_ID,
        name: `Staggered Complete ${Date.now()}`,
        description: '',
        nodes: [
          {
            id: 'stag-node',
            name: 'Staggered Step',
            agents: [
              { agentId: AGENT_A, name: 'coder' },
              { agentId: AGENT_B, name: 'planner' },
            ],
          },
          withSyntheticEnd(AGENT_A),
        ],
        startNodeId: 'stag-node',
        endNodeId: SYNTHETIC_END_NODE_ID,
        rules: [],
        tags: [],
        transitions: [],
        completionAutonomyLevel: 3,
      });

      const { run, tasks } = await rt.startWorkflowRun(SPACE_ID, workflow.id, 'Run');

      seedNodeExec(db, run.id, 'stag-node', 'coder', 'in_progress');
      seedNodeExec(db, run.id, 'stag-node', 'planner', 'in_progress');

      await rt.executeTick();
      expect(workflowRunRepo.getRun(run.id)?.status).toBe('in_progress');
      expect(collector.events.filter((e) => e.kind === 'workflow_run_completed')).toHaveLength(0);

      taskRepo.updateTask(tasks[0].id, { status: 'done' });
      await rt.executeTick();

      expect(workflowRunRepo.getRun(run.id)?.status).toBe('done');
      expect(collector.events.filter((e) => e.kind === 'workflow_run_completed')).toHaveLength(1);

      await rt.executeTick();
      expect(collector.events.filter((e) => e.kind === 'workflow_run_completed')).toHaveLength(1);
    });

    test('mixed-status multi-agent start node: tick loop syncs per-agent node_executions', async () => {
      const rt = makeRuntimeWithTam();
      const workflow = workflowManager.createWorkflow({
        spaceId: SPACE_ID,
        name: `Mixed Status Sync ${Date.now()}`,
        description: '',
        nodes: [
          {
            id: 'mix-start',
            name: 'Mixed Start Node',
            agents: [
              { agentId: AGENT_A, name: 'coder' },
              { agentId: AGENT_B, name: 'reviewer' },
            ],
          },
          withSyntheticEnd(AGENT_A),
        ],
        startNodeId: 'mix-start',
        endNodeId: SYNTHETIC_END_NODE_ID,
        rules: [],
        tags: [],
        transitions: [],
        completionAutonomyLevel: 3,
      });

      const { run, tasks } = await rt.startWorkflowRun(SPACE_ID, workflow.id, 'Run');

      const startExecs = nodeExecutionRepo
        .listByWorkflowRun(run.id)
        .filter((e) => e.workflowNodeId === 'mix-start');
      expect(startExecs).toHaveLength(2);
      expect(startExecs.every((e) => e.status === 'pending')).toBe(true);

      seedNodeExec(db, run.id, 'mix-start', 'coder', 'idle');
      seedNodeExec(db, run.id, 'mix-start', 'reviewer', 'in_progress');

      await rt.executeTick();

      const execsAfter = nodeExecutionRepo
        .listByWorkflowRun(run.id)
        .filter((e) => e.workflowNodeId === 'mix-start');
      const coderExec = execsAfter.find((e) => e.agentName === 'coder');
      const reviewerExec = execsAfter.find((e) => e.agentName === 'reviewer');
      expect(coderExec?.status).toBe('idle');
      expect(reviewerExec?.status).toBe('in_progress');

      expect(workflowRunRepo.getRun(run.id)?.status).toBe('in_progress');
      expect(collector.events.filter((e) => e.kind === 'workflow_run_completed')).toHaveLength(0);

      seedNodeExec(db, run.id, 'mix-start', 'reviewer', 'idle');
      taskRepo.updateTask(tasks[0].id, { status: 'done' });
      await rt.executeTick();

      const startExecsFinal = nodeExecutionRepo
        .listByWorkflowRun(run.id)
        .filter((e) => e.workflowNodeId === 'mix-start');
      expect(startExecsFinal.every((e) => e.status === 'idle')).toBe(true);
      expect(workflowRunRepo.getRun(run.id)?.status).toBe('done');
      expect(collector.events.filter((e) => e.kind === 'workflow_run_completed')).toHaveLength(1);
    });
  });

  describe('dedup cleanup on completion', () => {
    test('dedup entries are cleaned up when executor is removed on completion', async () => {
      const rt = makeRuntimeWithTam();
      const workflow = buildLinearWorkflow(SPACE_ID, workflowManager, [
        { id: 'step-dedup-clean', name: 'Step', agentId: AGENT_A },
      ]);

      const { run, tasks } = await rt.startWorkflowRun(SPACE_ID, workflow.id, 'Run');
      const taskId = tasks[0].id;
      const dedupKey = `${taskId}:timeout`;

      expect(rt.getNotifiedTaskSet().has(dedupKey)).toBe(false);

      db.prepare(`UPDATE spaces SET config = ? WHERE id = ?`).run(
        JSON.stringify({ taskTimeoutMs: 1 }),
        SPACE_ID
      );
      seedNodeExec(db, run.id, 'step-dedup-clean', 'agent', 'in_progress');
      db.prepare(
        `UPDATE node_executions
				 SET started_at = ?, updated_at = ?
				 WHERE workflow_run_id = ? AND workflow_node_id = ?`
      ).run(Date.now() - 10_000, Date.now() - 10_000, run.id, 'step-dedup-clean');
      await rt.executeTick();
      expect(rt.getNotifiedTaskSet().has(dedupKey)).toBe(true);

      taskRepo.updateTask(taskId, { status: 'done' });
      seedNodeExec(db, run.id, 'step-dedup-clean', 'agent', 'idle');
      await rt.executeTick();

      const completedEvents = collector.events.filter((e) => e.kind === 'workflow_run_completed');
      expect(completedEvents).toHaveLength(1);
      expect(rt.getNotifiedTaskSet().has(dedupKey)).toBe(false);
    });
  });

  describe('end-node bypass completion', () => {
    test('end node execution done → run completes via end-node short-circuit', async () => {
      const rt = makeRuntimeWithTam();

      const workflow = workflowManager.createWorkflow({
        spaceId: SPACE_ID,
        name: `End-Node Bypass ${Date.now()}`,
        description: '',
        nodes: [
          { id: 'en-start', name: 'Start', agentId: AGENT_A },
          { id: 'en-end', name: 'End', agentId: AGENT_B },
        ],
        startNodeId: 'en-start',
        endNodeId: 'en-end',
        tags: [],
        completionAutonomyLevel: 3,
      });
      expect(workflow.endNodeId).toBe('en-end');

      const { run, tasks } = await rt.startWorkflowRun(SPACE_ID, workflow.id, 'Run');

      taskRepo.updateTask(tasks[0].id, { status: 'done' });

      seedNodeExec(db, run.id, 'en-start', 'Start', 'idle');
      seedNodeExec(db, run.id, 'en-end', 'End', 'idle');

      await rt.executeTick();

      const completedRun = workflowRunRepo.getRun(run.id);
      expect(completedRun?.status).toBe('done');
      expect(completedRun?.completedAt).toBeDefined();

      const completedEvents = collector.events.filter((e) => e.kind === 'workflow_run_completed');
      expect(completedEvents).toHaveLength(1);
      if (completedEvents[0].kind === 'workflow_run_completed') {
        expect(completedEvents[0].payload['status']).toBe('done');
      }
    });

    test('canonical task done interrupts siblings but keeps sessions alive (idle)', async () => {
      const mockTam = new MockTaskAgentManager(nodeExecutionRepo);
      mockTam.isSessionAlive = () => true;
      const rt = makeRuntimeWithTam({
        taskAgentManager: mockTam as unknown as TaskAgentManager,
      });

      const workflow = workflowManager.createWorkflow({
        spaceId: SPACE_ID,
        name: `Sibling Interrupt On Task Terminal ${Date.now()}`,
        description: '',
        nodes: [
          { id: 'ec-sibling', name: 'Sibling', agentId: AGENT_A },
          { id: 'ec-end', name: 'End', agentId: AGENT_B },
        ],
        startNodeId: 'ec-sibling',
        endNodeId: 'ec-end',
        tags: [],
        completionAutonomyLevel: 3,
      });

      const { run, tasks } = await rt.startWorkflowRun(SPACE_ID, workflow.id, 'Run');

      const siblingExecId = seedNodeExec(db, run.id, 'ec-sibling', 'Sibling', 'in_progress');
      const siblingSessionId = 'mock-sibling-session-001';
      db.prepare('UPDATE node_executions SET agent_session_id = ? WHERE id = ?').run(
        siblingSessionId,
        siblingExecId
      );
      seedNodeExec(db, run.id, 'ec-end', 'End', 'idle');

      taskRepo.updateTask(tasks[0].id, { status: 'done' });

      await rt.executeTick();

      const completedRun = workflowRunRepo.getRun(run.id);
      expect(completedRun?.status).toBe('done');

      const execs = nodeExecutionRepo.listByWorkflowRun(run.id);
      const siblingExec = execs.find((e) => e.workflowNodeId === 'ec-sibling');
      expect(siblingExec?.status).toBe('idle');
      expect(siblingExec?.agentSessionId).toBe(siblingSessionId);
      expect(mockTam.interruptedSessions).toContain(siblingSessionId);
      expect(mockTam.cancelledSessions).not.toContain(siblingSessionId);

      const completedEvents = collector.events.filter((e) => e.kind === 'workflow_run_completed');
      expect(completedEvents).toHaveLength(1);
    });

    test('non-end terminal source is preserved during sibling quiescing', async () => {
      const mockTam = new MockTaskAgentManager(nodeExecutionRepo);
      mockTam.isSessionAlive = () => true;
      const rt = makeRuntimeWithTam({
        taskAgentManager: mockTam as unknown as TaskAgentManager,
      });

      const workflow = workflowManager.createWorkflow({
        spaceId: SPACE_ID,
        name: `Non-End Terminal Preserve ${Date.now()}`,
        description: '',
        nodes: [
          { id: 'vt-code', name: 'Coding', agentId: AGENT_A },
          { id: 'vt-checker', name: 'Checker', agentId: AGENT_B },
          { id: 'vt-review', name: 'Review', agentId: AGENT_C },
        ],
        startNodeId: 'vt-code',
        endNodeId: 'vt-review',
        tags: [],
        completionAutonomyLevel: 3,
      });

      const { run, tasks } = await rt.startWorkflowRun(SPACE_ID, workflow.id, 'Run');
      taskRepo.updateTask(tasks[0].id, {
        status: 'in_progress',
        reportedStatus: 'done',
        pendingCompletionSubmittedByNodeId: 'vt-checker',
        postApprovalSourceNodeId: 'vt-checker',
      });

      const checkerExecId = seedNodeExec(db, run.id, 'vt-checker', 'Checker', 'in_progress');
      const checkerSessionId = 'checker-terminal-session-001';
      db.prepare('UPDATE node_executions SET agent_session_id = ? WHERE id = ?').run(
        checkerSessionId,
        checkerExecId
      );
      const codingExecId = seedNodeExec(db, run.id, 'vt-code', 'Coding', 'in_progress');
      const codingSessionId = 'coding-sibling-session-001';
      db.prepare('UPDATE node_executions SET agent_session_id = ? WHERE id = ?').run(
        codingSessionId,
        codingExecId
      );
      seedNodeExec(db, run.id, 'vt-review', 'Review', 'idle');

      await rt.executeTick();

      const execs = nodeExecutionRepo.listByWorkflowRun(run.id);
      const checkerExec = execs.find((e) => e.workflowNodeId === 'vt-checker');
      const codingExec = execs.find((e) => e.workflowNodeId === 'vt-code');
      expect(checkerExec?.status).toBe('in_progress');
      expect(checkerExec?.agentSessionId).toBe(checkerSessionId);
      expect(codingExec?.status).toBe('idle');
      expect(mockTam.interruptedSessions).not.toContain(checkerSessionId);
      expect(mockTam.interruptedSessions).toContain(codingSessionId);
    });

    test('canonical task blocked still quiesces siblings on run completion', async () => {
      const mockTam = new MockTaskAgentManager(nodeExecutionRepo);
      mockTam.isSessionAlive = () => true;
      const rt = makeRuntimeWithTam({
        taskAgentManager: mockTam as unknown as TaskAgentManager,
      });

      const workflow = buildLinearWorkflow(SPACE_ID, workflowManager, [
        { id: 'blk-sibling', name: 'Sibling', agentId: AGENT_A },
        { id: 'blk-end', name: 'End', agentId: AGENT_B },
      ]);

      const { run, tasks } = await rt.startWorkflowRun(SPACE_ID, workflow.id, 'Run');
      expect(tasks).toHaveLength(1);

      taskRepo.updateTask(tasks[0].id, {
        status: 'blocked',
        reportedStatus: 'blocked',
        reportedSummary: 'cascade-blocked',
      });

      const siblingExecId = seedNodeExec(db, run.id, 'blk-sibling', 'Sibling', 'in_progress');
      const siblingSessionId = 'blk-sibling-session-001';
      db.prepare('UPDATE node_executions SET agent_session_id = ? WHERE id = ?').run(
        siblingSessionId,
        siblingExecId
      );
      seedNodeExec(db, run.id, 'blk-end', 'End', 'idle');

      await rt.executeTick();

      expect(workflowRunRepo.getRun(run.id)?.status).toBe('done');

      const canonical = taskRepo.getTask(tasks[0].id);
      expect(canonical?.status).not.toBe('approved');
      expect(canonical?.status).not.toBe('done');

      const execs = nodeExecutionRepo.listByWorkflowRun(run.id);
      const siblingExec = execs.find((e) => e.workflowNodeId === 'blk-sibling');
      expect(siblingExec?.status).toBe('idle');
      expect(siblingExec?.agentSessionId).toBe(siblingSessionId);
      expect(mockTam.interruptedSessions).toContain(siblingSessionId);
      expect(mockTam.cancelledSessions).not.toContain(siblingSessionId);
    });

    test('post-approval merge session spawned in the completion block is NOT interrupted by the sibling-quiesce sweep', async () => {
      const mockTam = new MockTaskAgentManager(nodeExecutionRepo);
      mockTam.isSessionAlive = () => true;
      const rt = makeRuntimeWithTam({
        taskAgentManager: mockTam as unknown as TaskAgentManager,
      });

      const workflow = workflowManager.createWorkflow({
        spaceId: SPACE_ID,
        name: `Post-Approval Spawn Survives Quiesce ${Date.now()}`,
        description: '',
        nodes: [
          {
            id: 'pa-coder',
            name: 'Coding',
            agents: [{ agentId: AGENT_A, name: 'Coder' }],
          },
          {
            id: 'pa-review',
            name: 'Review',
            agents: [{ agentId: AGENT_B, name: 'Reviewer' }],
            postApproval: { targetAgent: 'Merger', instructions: 'merge the PR' },
          },
          {
            id: 'pa-merge',
            name: 'Merge',
            agents: [{ agentId: AGENT_C, name: 'Merger' }],
          },
        ],
        startNodeId: 'pa-coder',
        endNodeId: 'pa-review',
        tags: [],
        completionAutonomyLevel: 3,
      });

      const { run, tasks } = await rt.startWorkflowRun(SPACE_ID, workflow.id, 'Run');

      taskRepo.updateTask(tasks[0].id, {
        status: 'in_progress',
        reportedStatus: 'done',
        pendingCompletionSubmittedByNodeId: 'pa-review',
        postApprovalSourceNodeId: 'pa-review',
      });

      const coderExecId = seedNodeExec(db, run.id, 'pa-coder', 'Coding', 'in_progress');
      const coderSessionId = 'pa-coder-session-001';
      db.prepare('UPDATE node_executions SET agent_session_id = ? WHERE id = ?').run(
        coderSessionId,
        coderExecId
      );
      seedNodeExec(db, run.id, 'pa-review', 'Review', 'idle');

      await rt.executeTick();

      expect(workflowRunRepo.getRun(run.id)?.status).toBe('done');
      const canonical = taskRepo.getTask(tasks[0].id);
      expect(canonical?.status).toBe('approved');
      expect(canonical?.postApprovalSessionId).toBeTruthy();
      expect(mockTam.spawnedPostApprovalSessions).toHaveLength(1);
      const mergeSessionId = mockTam.spawnedPostApprovalSessions[0];

      expect(mockTam.interruptedSessions).not.toContain(mergeSessionId);
      const execs = nodeExecutionRepo.listByWorkflowRun(run.id);
      const mergeExec = execs.find((e) => e.workflowNodeId === 'pa-merge');
      expect(mergeExec?.status).toBe('in_progress');
      expect(mergeExec?.agentSessionId).toBe(mergeSessionId);

      const coderExec = execs.find((e) => e.workflowNodeId === 'pa-coder');
      expect(coderExec?.status).toBe('idle');
      expect(coderExec?.agentSessionId).toBe(coderSessionId);
      expect(mockTam.interruptedSessions).toContain(coderSessionId);
      expect(mockTam.cancelledSessions).not.toContain(coderSessionId);
    });

    test('sibling session remains reachable for send_message after workflow completion (#1515)', async () => {
      const mockTam = new MockTaskAgentManager(nodeExecutionRepo);
      mockTam.isSessionAlive = () => true;
      const rt = makeRuntimeWithTam({
        taskAgentManager: mockTam as unknown as TaskAgentManager,
      });

      const workflow = workflowManager.createWorkflow({
        spaceId: SPACE_ID,
        name: `Post-Completion Messaging ${Date.now()}`,
        description: '',
        nodes: [
          { id: 'coder-node', name: 'Coder', agentId: AGENT_A },
          { id: 'reviewer-node', name: 'Reviewer', agentId: AGENT_B },
        ],
        startNodeId: 'coder-node',
        endNodeId: 'reviewer-node',
        tags: [],
        completionAutonomyLevel: 3,
      });

      const { run, tasks } = await rt.startWorkflowRun(SPACE_ID, workflow.id, 'Run');
      const coderSessionId = 'coder-session-1515';
      const coderExecId = seedNodeExec(db, run.id, 'coder-node', 'Coder', 'in_progress');
      db.prepare('UPDATE node_executions SET agent_session_id = ? WHERE id = ?').run(
        coderSessionId,
        coderExecId
      );
      seedNodeExec(db, run.id, 'reviewer-node', 'Reviewer', 'idle');

      taskRepo.updateTask(tasks[0].id, { status: 'done' });
      await rt.executeTick();

      const coderExec = nodeExecutionRepo
        .listByWorkflowRun(run.id)
        .find((e) => e.workflowNodeId === 'coder-node');
      expect(coderExec?.status).toBe('idle');
      expect(coderExec?.agentSessionId).toBe(coderSessionId);

      expect(mockTam.interruptedSessions).toContain(coderSessionId);
      expect(mockTam.cancelledSessions).not.toContain(coderSessionId);

      const updatedTask = taskRepo.getTask(tasks[0].id);
      expect(updatedTask?.status).toBe('done');
    });

    test('workflow without endNodeId is rejected at start', async () => {
      const rt = makeRuntimeWithTam();

      const workflow = workflowManager.createWorkflow({
        spaceId: SPACE_ID,
        name: `No End Node ${Date.now()}`,
        description: '',
        nodes: [
          { id: 'no-en-1', name: 'Step 1', agentId: AGENT_A },
          { id: 'no-en-2', name: 'Step 2', agentId: AGENT_B },
        ],
        startNodeId: 'no-en-1',
        tags: [],
        completionAutonomyLevel: 3,
      });

      db.prepare(`UPDATE space_workflows SET end_node_id = NULL WHERE id = ?`).run(workflow.id);
      const legacyWorkflow = workflowManager.getWorkflow(workflow.id)!;
      expect(legacyWorkflow.endNodeId).toBeUndefined();
      await expect(rt.startWorkflowRun(SPACE_ID, legacyWorkflow.id, 'Run')).rejects.toThrow(
        'is missing endNodeId'
      );
    });

    test('result artifact summary populates task outcome on run completion', async () => {
      const rt = makeRuntimeWithTam();

      const workflow = workflowManager.createWorkflow({
        spaceId: SPACE_ID,
        name: `Artifact Result Completion ${Date.now()}`,
        description: '',
        nodes: [{ id: 'artifact-end', name: 'End', agentId: AGENT_A }],
        startNodeId: 'artifact-end',
        endNodeId: 'artifact-end',
        tags: [],
        completionAutonomyLevel: 3,
      });

      const { run, tasks } = await rt.startWorkflowRun(SPACE_ID, workflow.id, 'Run');
      artifactRepo.upsert({
        id: 'artifact-result-summary-old',
        runId: run.id,
        nodeId: 'End',
        artifactType: 'decision',
        artifactKey: 'old-cycle',
        data: { summary: 'Stale requested changes summary' },
      });
      artifactRepo.upsert({
        id: 'artifact-result-summary',
        runId: run.id,
        nodeId: 'End',
        artifactType: 'decision',
        artifactKey: 'final',
        data: { summary: 'Implemented artifact summary propagation' },
      });
      taskRepo.updateTask(tasks[0].id, { status: 'in_progress', reportedStatus: 'done' });
      seedNodeExec(db, run.id, 'artifact-end', 'End', 'idle');

      await rt.executeTick();

      const taskAfter = taskRepo.getTask(tasks[0].id);
      expect(workflowRunRepo.getRun(run.id)?.status).toBe('done');
      expect(taskAfter?.result).toBe('Implemented artifact summary propagation');
      expect(taskAfter?.reportedSummary).toBe('Implemented artifact summary propagation');
    });

    test('updated result artifact summary wins over newer-created stale artifact', async () => {
      const rt = makeRuntimeWithTam();

      const workflow = workflowManager.createWorkflow({
        spaceId: SPACE_ID,
        name: `Updated Artifact Result Completion ${Date.now()}`,
        description: '',
        nodes: [{ id: 'updated-artifact-end', name: 'End', agentId: AGENT_A }],
        startNodeId: 'updated-artifact-end',
        endNodeId: 'updated-artifact-end',
        tags: [],
        completionAutonomyLevel: 3,
      });

      const { run, tasks } = await rt.startWorkflowRun(SPACE_ID, workflow.id, 'Run');
      artifactRepo.upsert({
        id: 'artifact-reused-result',
        runId: run.id,
        nodeId: 'End',
        artifactType: 'decision',
        artifactKey: 'final',
        data: { summary: 'Initial reused-key summary' },
      });
      artifactRepo.upsert({
        id: 'artifact-newer-stale-result',
        runId: run.id,
        nodeId: 'End',
        artifactType: 'decision',
        artifactKey: 'later-created-stale',
        data: { summary: 'Stale summary from later-created row' },
      });
      const staleArtifact = artifactRepo.listByRun(run.id, {
        artifactType: 'decision',
      })[1];
      artifactRepo.upsert({
        id: 'artifact-reused-result-updated',
        runId: run.id,
        nodeId: 'End',
        artifactType: 'decision',
        artifactKey: 'final',
        data: { summary: 'Updated reused-key summary' },
      });
      if (staleArtifact) {
        db.prepare(`UPDATE workflow_run_artifacts SET updated_at = ? WHERE id = ?`).run(
          staleArtifact.updatedAt - 1,
          staleArtifact.id
        );
      }
      taskRepo.updateTask(tasks[0].id, { status: 'in_progress', reportedStatus: 'done' });
      seedNodeExec(db, run.id, 'updated-artifact-end', 'End', 'idle');

      await rt.executeTick();

      const taskAfter = taskRepo.getTask(tasks[0].id);
      expect(taskAfter?.result).toBe('Updated reused-key summary');
      expect(taskAfter?.reportedSummary).toBe('Updated reused-key summary');
    });

    test('null task result is filled from result artifact summary', async () => {
      const rt = makeRuntimeWithTam();

      const workflow = workflowManager.createWorkflow({
        spaceId: SPACE_ID,
        name: `Null Result Artifact Fill ${Date.now()}`,
        description: '',
        nodes: [{ id: 'null-result-end', name: 'End', agentId: AGENT_A }],
        startNodeId: 'null-result-end',
        endNodeId: 'null-result-end',
        tags: [],
        completionAutonomyLevel: 3,
      });

      const { run, tasks } = await rt.startWorkflowRun(SPACE_ID, workflow.id, 'Run');
      artifactRepo.upsert({
        id: 'artifact-null-result-summary',
        runId: run.id,
        nodeId: 'End',
        artifactType: 'decision',
        artifactKey: 'final',
        data: { summary: 'Filled null task result' },
      });
      taskRepo.updateTask(tasks[0].id, {
        status: 'in_progress',
        result: null,
        reportedStatus: 'done',
      });
      seedNodeExec(db, run.id, 'null-result-end', 'End', 'idle');

      await rt.executeTick();

      const taskAfter = taskRepo.getTask(tasks[0].id);
      expect(taskAfter?.result).toBe('Filled null task result');
      expect(taskAfter?.reportedSummary).toBe('Filled null task result');
    });

    test('fresh result artifact replaces stale task result from prior review cycle', async () => {
      const rt = makeRuntimeWithTam();

      const workflow = workflowManager.createWorkflow({
        spaceId: SPACE_ID,
        name: `Preserve Existing Result ${Date.now()}`,
        description: '',
        nodes: [{ id: 'preserve-end', name: 'End', agentId: AGENT_A }],
        startNodeId: 'preserve-end',
        endNodeId: 'preserve-end',
        tags: [],
        completionAutonomyLevel: 3,
      });

      const { run, tasks } = await rt.startWorkflowRun(SPACE_ID, workflow.id, 'Run');
      artifactRepo.upsert({
        id: 'artifact-preserve-summary',
        runId: run.id,
        nodeId: 'End',
        artifactType: 'decision',
        artifactKey: 'final',
        data: { summary: 'Fresh artifact summary after retry' },
      });
      taskRepo.updateTask(tasks[0].id, {
        status: 'in_progress',
        result: 'Stale result from rejected cycle',
        reportedStatus: 'done',
        reportedSummary: 'Stale reported summary from rejected cycle',
      });
      seedNodeExec(db, run.id, 'preserve-end', 'End', 'idle');

      await rt.executeTick();

      const taskAfter = taskRepo.getTask(tasks[0].id);
      expect(taskAfter?.result).toBe('Fresh artifact summary after retry');
      expect(taskAfter?.reportedSummary).toBe('Fresh artifact summary after retry');
    });

    test('reported summary replaces generic error task result when no artifact exists', async () => {
      const rt = makeRuntimeWithTam();

      const workflow = workflowManager.createWorkflow({
        spaceId: SPACE_ID,
        name: `Generic Error Fallback ${Date.now()}`,
        description: '',
        nodes: [{ id: 'generic-error-end', name: 'End', agentId: AGENT_A }],
        startNodeId: 'generic-error-end',
        endNodeId: 'generic-error-end',
        tags: [],
        completionAutonomyLevel: 3,
      });

      const { run, tasks } = await rt.startWorkflowRun(SPACE_ID, workflow.id, 'Run');
      taskRepo.updateTask(tasks[0].id, {
        status: 'in_progress',
        result:
          'An unexpected error occurred. Please try again or contact support if the issue persists.',
        reportedStatus: 'done',
        reportedSummary: 'PR #2007 merged to dev via squash merge.',
      });
      seedNodeExec(db, run.id, 'generic-error-end', 'End', 'idle');

      await rt.executeTick();

      const taskAfter = taskRepo.getTask(tasks[0].id);
      expect(taskAfter?.result).toBe('PR #2007 merged to dev via squash merge.');
      expect(taskAfter?.reportedSummary).toBe('PR #2007 merged to dev via squash merge.');
    });

    test('ignores generic error sibling result when filling terminal run result', async () => {
      const rt = makeRuntimeWithTam();

      const workflow = workflowManager.createWorkflow({
        spaceId: SPACE_ID,
        name: `Generic Sibling Fallback ${Date.now()}`,
        description: '',
        nodes: [{ id: 'generic-sibling-end', name: 'End', agentId: AGENT_A }],
        startNodeId: 'generic-sibling-end',
        endNodeId: 'generic-sibling-end',
        tags: [],
        completionAutonomyLevel: 3,
      });

      const { run, tasks } = await rt.startWorkflowRun(SPACE_ID, workflow.id, 'Run');
      taskRepo.updateTask(tasks[0].id, {
        status: 'done',
        result: null,
        reportedSummary: null,
      });
      const duplicate = await rt.getTaskManagerForSpace(SPACE_ID).createTask({
        title: 'duplicate generic sibling',
        description: '',
        workflowRunId: run.id,
        status: 'done',
      });
      taskRepo.updateTask(duplicate.id, {
        result:
          'An unexpected error occurred. Please try again or contact support if the issue persists.',
      });
      workflowRunRepo.updateRun(run.id, { status: 'done' });

      await rt.executeTick();

      const taskAfter = taskRepo.getTask(tasks[0].id);
      expect(taskAfter?.result).toBeNull();
      expect(taskAfter?.reportedSummary).toBeNull();
    });

    test('uses later meaningful sibling result after earlier generic sibling result', async () => {
      const rt = makeRuntimeWithTam();

      const workflow = workflowManager.createWorkflow({
        spaceId: SPACE_ID,
        name: `Meaningful Sibling Fallback ${Date.now()}`,
        description: '',
        nodes: [{ id: 'meaningful-sibling-end', name: 'End', agentId: AGENT_A }],
        startNodeId: 'meaningful-sibling-end',
        endNodeId: 'meaningful-sibling-end',
        tags: [],
        completionAutonomyLevel: 3,
      });

      const { run, tasks } = await rt.startWorkflowRun(SPACE_ID, workflow.id, 'Run');
      taskRepo.updateTask(tasks[0].id, {
        status: 'done',
        result: null,
        reportedSummary: null,
      });
      const genericDuplicate = await rt.getTaskManagerForSpace(SPACE_ID).createTask({
        title: 'duplicate generic sibling',
        description: '',
        workflowRunId: run.id,
        status: 'done',
      });
      taskRepo.updateTask(genericDuplicate.id, {
        result:
          'An unexpected error occurred. Please try again or contact support if the issue persists.',
      });
      const meaningfulDuplicate = await rt.getTaskManagerForSpace(SPACE_ID).createTask({
        title: 'duplicate meaningful sibling',
        description: '',
        workflowRunId: run.id,
        status: 'done',
      });
      taskRepo.updateTask(meaningfulDuplicate.id, {
        result: 'PR #2007 merged to dev via squash merge.',
      });
      workflowRunRepo.updateRun(run.id, { status: 'done' });

      await rt.executeTick();

      const taskAfter = taskRepo.getTask(tasks[0].id);
      expect(taskAfter?.result).toBe('PR #2007 merged to dev via squash merge.');
      expect(taskAfter?.reportedSummary).toBe('PR #2007 merged to dev via squash merge.');
    });

    test('reportedStatus alone is enough to mark a run for completion resolution', async () => {
      const rt = makeRuntimeWithTam();

      const workflow = workflowManager.createWorkflow({
        spaceId: SPACE_ID,
        name: `Reported Status Drives Resolution ${Date.now()}`,
        description: '',
        nodes: [
          { id: 'rs-start', name: 'Start', agentId: AGENT_A },
          { id: 'rs-end', name: 'End', agentId: AGENT_B },
        ],
        startNodeId: 'rs-start',
        endNodeId: 'rs-end',
        tags: [],
        completionAutonomyLevel: 3,
      });

      const { run, tasks } = await rt.startWorkflowRun(SPACE_ID, workflow.id, 'Run');

      taskRepo.updateTask(tasks[0].id, {
        status: 'in_progress',
        reportedStatus: 'done',
        reportedSummary: 'work complete',
      });
      seedNodeExec(db, run.id, 'rs-end', 'End', 'idle');

      await rt.executeTick();

      const runAfter = workflowRunRepo.getRun(run.id);
      expect(runAfter?.status).toBe('done');
      expect(collector.events.filter((e) => e.kind === 'workflow_run_completed')).toHaveLength(1);
    });

    test('end node execution cancelled (terminal) also triggers run completion', async () => {
      const rt = makeRuntimeWithTam();

      const workflow = workflowManager.createWorkflow({
        spaceId: SPACE_ID,
        name: `End Node Cancelled ${Date.now()}`,
        description: '',
        nodes: [
          { id: 'enc-start', name: 'Start', agentId: AGENT_A },
          { id: 'enc-end', name: 'End', agentId: AGENT_B },
        ],
        startNodeId: 'enc-start',
        endNodeId: 'enc-end',
        tags: [],
        completionAutonomyLevel: 3,
      });

      const { run, tasks } = await rt.startWorkflowRun(SPACE_ID, workflow.id, 'Run');
      taskRepo.updateTask(tasks[0].id, { status: 'done' });

      seedNodeExec(db, run.id, 'enc-start', 'Start', 'idle');
      seedNodeExec(db, run.id, 'enc-end', 'End', 'cancelled');

      await rt.executeTick();

      const completedRun = workflowRunRepo.getRun(run.id);
      expect(completedRun?.status).toBe('done');
      expect(collector.events.filter((e) => e.kind === 'workflow_run_completed')).toHaveLength(1);
    });
  });

  describe('orchestration task auto-complete on run completion', () => {
    test('legacy in_progress orchestration task is ignored when run completes', async () => {
      const rt = makeRuntimeWithTam();

      const workflow = buildLinearWorkflow(SPACE_ID, workflowManager, [
        { id: 'orch-node-1', name: 'Step', agentId: AGENT_A },
      ]);

      const { run, tasks } = await rt.startWorkflowRun(SPACE_ID, workflow.id, 'Orch Run');

      const orchTask = taskRepo.createTask({
        spaceId: SPACE_ID,
        title: 'Orchestration',
        description: 'Task agent orchestration task',
        workflowRunId: run.id,
        status: 'in_progress',
        taskAgentSessionId: `space:${SPACE_ID}:task:${tasks[0].id}`,
      });

      taskRepo.updateTask(tasks[0].id, { status: 'done' });
      seedNodeExec(db, run.id, 'orch-node-1', 'agent', 'idle');

      await rt.executeTick();

      expect(workflowRunRepo.getRun(run.id)?.status).toBe('done');

      const orchTaskAfter = taskRepo.getTask(orchTask.id);
      expect(orchTaskAfter?.status).toBe('archived');
    });

    test('canonical task result wins over duplicate sibling result during terminal reconcile', async () => {
      const rt = makeRuntimeWithTam();

      const workflow = buildLinearWorkflow(SPACE_ID, workflowManager, [
        { id: 'canonical-sibling-node', name: 'Step', agentId: AGENT_A },
      ]);

      const { run, tasks } = await rt.startWorkflowRun(SPACE_ID, workflow.id, 'Canonical Run');
      const duplicateTask = taskRepo.createTask({
        spaceId: SPACE_ID,
        title: 'Duplicate stale result',
        description: 'Older duplicate task from previous cycle',
        workflowRunId: run.id,
        status: 'done',
        result: 'Stale sibling result',
      });

      taskRepo.updateTask(tasks[0].id, {
        status: 'done',
        result: 'Canonical final result',
      });
      seedNodeExec(db, run.id, 'canonical-sibling-node', 'agent', 'idle');

      await rt.executeTick();

      const canonicalAfter = taskRepo.getTask(tasks[0].id);
      const duplicateAfter = taskRepo.getTask(duplicateTask.id);
      expect(workflowRunRepo.getRun(run.id)?.status).toBe('done');
      expect(canonicalAfter?.result).toBe('Canonical final result');
      expect(duplicateAfter?.status).toBe('archived');
    });

    test('open orchestration task is skipped on run completion (no throw)', async () => {
      const rt = makeRuntimeWithTam();

      const workflow = buildLinearWorkflow(SPACE_ID, workflowManager, [
        { id: 'orch-open-1', name: 'Step', agentId: AGENT_A },
      ]);

      const { run, tasks } = await rt.startWorkflowRun(SPACE_ID, workflow.id, 'Orch Open Run');

      const orchTask = taskRepo.createTask({
        spaceId: SPACE_ID,
        title: 'Orchestration Open',
        description: 'Task agent orchestration task in open state',
        workflowRunId: run.id,
        status: 'open',
        taskAgentSessionId: `space:${SPACE_ID}:task:${tasks[0].id}`,
      });

      taskRepo.updateTask(tasks[0].id, { status: 'done' });
      seedNodeExec(db, run.id, 'orch-open-1', 'agent', 'idle');

      await rt.executeTick();

      expect(workflowRunRepo.getRun(run.id)?.status).toBe('done');

      const orchTaskAfter = taskRepo.getTask(orchTask.id);
      expect(orchTaskAfter?.status).toBe('archived');
    });
  });
});
