/**
 * SpaceRuntime Completion Detection & Status Transition Tests
 *
 * Tests the tick loop integration with CompletionDetector:
 *   - Status transition in_progress → done sets completedAt
 *   - Multi-node workflows with mixed terminal statuses
 *   - blocked / done / cancelled runs are skipped
 *   - Pending-but-blocked via workflow channels
 *   - No duplicate notifications across ticks
 */

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

// ---------------------------------------------------------------------------
// BusEventCollector — captures InternalEventBus events for test assertions
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// DB helpers
// ---------------------------------------------------------------------------

function makeDb(): BunDatabase {
  // Use in-memory SQLite — faster than file-based DB and avoids filesystem
  // I/O contention that caused beforeEach hook timeouts in CI.
  const db = new BunDatabase(':memory:');
  db.exec('PRAGMA foreign_keys = ON');
  runMigrations(db, () => {});

  // runMigrations() applies migrations only; these unit fixtures need the base
  // sdk_messages table because runtime recovery inspects persisted SDK output.
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

// End nodes must have exactly 1 agent (validator rule). For tests that exercise
// a multi-agent step, append a downstream single-agent end node so the
// multi-agent step remains an intermediate node.
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

// ---------------------------------------------------------------------------
// MockTaskAgentManager
// ---------------------------------------------------------------------------

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

  // PR 3/5 introduced post-approval awareness injection via
  // `injectIntoTaskAgent`. These tests do not assert on delivery; return a
  // trivial "no session" result so the runtime's best-effort branch is taken.
  async injectIntoTaskAgent(
    _taskId: string,
    _awarenessBody: string
  ): Promise<{ injected: boolean; reason?: string }> {
    return { injected: false, reason: 'no-session' };
  }

  // PostApprovalRouter delegates the spawn to `taskAgentManager
  // .spawnPostApprovalSubSession`. The real TaskAgentManager creates a
  // node-agent sub-session and (via createSubSession) stamps the matched
  // node's node_execution row `in_progress` with the new agentSessionId. We
  // replicate just that observable side effect so the sibling-quiesce sweep
  // sees the freshly-spawned session exactly as production does.
  async spawnPostApprovalSubSession(args: {
    task: SpaceTask;
    workflow: SpaceWorkflow;
    targetAgent: string;
    kickoffMessage: string;
  }): Promise<{ sessionId: string }> {
    const { task, workflow, targetAgent } = args;
    // Mirror TaskAgentManager.spawnPostApprovalSubSession's slot resolution:
    // first node whose agent slot matches `targetAgent` by name or agentId.
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

// ---------------------------------------------------------------------------
// Test suite
// ---------------------------------------------------------------------------

describe('SpaceRuntime — completion detection & status transitions', () => {
  // Exercises completion detection (`reportedStatus` → status transitions,
  // workflow-run advancement, end-node short-circuit) and the
  // PostApprovalRouter dispatch on `approved`. The legacy
  // `resolveCompletionWithActions` pipeline was deleted in PR 4/5; routing
  // always goes through `dispatchPostApproval` now.

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

  // -------------------------------------------------------------------------
  // Artifact-backed task result capture
  // -------------------------------------------------------------------------

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

  // -------------------------------------------------------------------------
  // Forge evidence refresh on resolved-task reconciliation (task #918)
  // -------------------------------------------------------------------------

  describe('Forge evidence refresh on resolved-task reconciliation', () => {
    test('reconciliation refreshes auto-captured evidence captured before the run completed', async () => {
      // complete_validation_task commits a workflow-backed task's `done` while
      // its run is still `in_progress` — the terminal transition captures
      // Forge evidence against that provisional state (run status, null
      // completedAt). Reconciliation finalizes the run; it must also REFRESH
      // the evidence (createAutoEvidenceOnce upserts) so the Forge record
      // matches the finalized outcome instead of the provisional one.
      const evolutionRepo = new EvolutionRepository(db);
      const scope = evolutionRepo.createScope({
        spaceId: SPACE_ID,
        kind: 'custom',
        name: 'Evidence refresh scope',
        objective: 'Guard the post-reconciliation evidence refresh for externally completed tasks.',
      });
      const evolutionScopeService = new EvolutionScopeService({
        evolutionRepo,
        spaceRepo: new SpaceRepository(db),
        goalRepo: new SpaceGoalRepository(db),
        taskRepo,
        workflowRunRepo,
        artifactRepo,
      });
      const rt = makeRuntimeWithTam({ evolutionScopeService });
      const workflow = buildLinearWorkflow(SPACE_ID, workflowManager, [
        { id: 'node-ev-refresh', name: 'Coding', agentId: AGENT_A },
      ]);

      const { run, tasks } = await rt.startWorkflowRun(
        SPACE_ID,
        workflow.id,
        'Evidence refresh run'
      );
      const task = tasks[0];
      // External validation-only completion shape: task done, run still active.
      taskRepo.updateTask(task.id, {
        evolutionScopeId: scope.id,
        status: 'done',
        result: 'validated: no PR involved',
      });
      seedNodeExec(db, run.id, 'node-ev-refresh', 'agent', 'idle');

      // Provisional capture exactly as the terminal transition performs it —
      // while the run is still in_progress.
      evolutionScopeService.captureCompletedTaskEvidence({ taskId: task.id });
      const runEvidenceBefore = evolutionRepo
        .listEvidence(scope.id)
        .find((item) => item.sourceId === run.id && item.metadata.autoCaptured === true);
      expect(runEvidenceBefore?.metadata.status).toBe('in_progress');
      expect(runEvidenceBefore?.metadata.completedAt).toBeNull();

      await rt.executeTick();

      expect(workflowRunRepo.getRun(run.id)?.status).toBe('done');
      // The SAME evidence row (upsert, not a duplicate) now carries the
      // finalized run state.
      const runEvidenceAfter = evolutionRepo
        .listEvidence(scope.id)
        .find((item) => item.sourceId === run.id && item.metadata.autoCaptured === true);
      expect(runEvidenceAfter?.id).toBe(runEvidenceBefore?.id);
      expect(runEvidenceAfter?.metadata.status).toBe('done');
      expect(runEvidenceAfter?.metadata.completedAt).not.toBeNull();
    });

    test('rereads the canonical task before routing — external done during duplicate repair is not re-routed', async () => {
      // Interleaving: the tick snapshots the canonical task as in_progress,
      // then awaits archiveDuplicateRunTasks for a legacy duplicate. An
      // external terminal write (complete_validation_task) lands during that
      // await — CompletionDetector rereads the DB and sees `done`, but the
      // tick's local snapshot is stale. Deciding taskAlreadyResolved from the
      // stale row would push the freshly-done task through
      // dispatchPostApproval (invalid done→approved attempt); the reread
      // routes it through the resolved branch instead, preserving the
      // external result.
      const rt = makeRuntimeWithTam();
      const workflow = buildLinearWorkflow(SPACE_ID, workflowManager, [
        { id: 'node-stale', name: 'Coding', agentId: AGENT_A },
      ]);
      const { run, tasks } = await rt.startWorkflowRun(SPACE_ID, workflow.id, 'Stale snapshot run');
      const task = tasks[0];
      // Legacy duplicate (different title → the run-title match keeps the
      // original task canonical; the duplicate gets archived on the next
      // tick's repair pass).
      const dup = taskRepo.createTask({
        spaceId: SPACE_ID,
        title: 'Legacy per-node task',
        description: '',
        status: 'in_progress',
        workflowRunId: run.id,
      });
      seedNodeExec(db, run.id, 'node-stale', 'agent', 'in_progress');

      const originalUpdateTask = taskRepo.updateTask.bind(taskRepo);
      let externallyCompleted = false;
      taskRepo.updateTask = ((
        id: string,
        params: Parameters<SpaceTaskRepository['updateTask']>[1]
      ) => {
        const result = originalUpdateTask(id, params);
        // The external validation completion lands exactly while the tick is
        // inside archiveDuplicateRunTasks' write for the duplicate.
        if (id === dup.id && params.status === 'archived' && !externallyCompleted) {
          externallyCompleted = true;
          originalUpdateTask(task.id, {
            status: 'done',
            result: 'external validation outcome',
          });
        }
        return result;
      }) as typeof taskRepo.updateTask;

      try {
        await rt.executeTick();
      } finally {
        taskRepo.updateTask = originalUpdateTask;
      }

      expect(externallyCompleted).toBe(true);
      expect(workflowRunRepo.getRun(run.id)?.status).toBe('done');
      // The resolved branch ran: the external result survives untouched
      // (a re-route attempt would have thrown or overwritten it).
      const finalTask = taskRepo.getTask(task.id);
      expect(finalTask?.status).toBe('done');
      expect(finalTask?.result).toBe('external validation outcome');
    });

    test('does not re-terminalize a task recovered during the run-done transition', async () => {
      // Interleaving: CompletionDetector sees the done task, and the tick
      // transitions the run to done — but a concurrent
      // recoverWorkflowBackedTask lands during that awaited transition
      // notification, reopening BOTH the run and the task (the recovery
      // transaction resets the task with reportedStatus cleared). The
      // refreshed task observes the recovery; continuing on the stale
      // runIsComplete decision would dispatch post-approval, re-terminalize
      // the recovered task, and quiesce the freshly recovered workers. The
      // completion recompute must return instead.
      const rt = makeRuntimeWithTam();
      const workflow = buildLinearWorkflow(SPACE_ID, workflowManager, [
        { id: 'node-recover', name: 'Coding', agentId: AGENT_A },
      ]);
      const { run, tasks } = await rt.startWorkflowRun(SPACE_ID, workflow.id, 'Recovery race run');
      const task = tasks[0];
      taskRepo.updateTask(task.id, { status: 'done', result: 'completed by worker' });
      seedNodeExec(db, run.id, 'node-recover', 'agent', 'in_progress');

      const originalTransition = workflowRunRepo.transitionStatus.bind(workflowRunRepo);
      let reopened = false;
      workflowRunRepo.transitionStatus = ((
        id: string,
        status: Parameters<SpaceWorkflowRunRepository['transitionStatus']>[1]
      ) => {
        const result = originalTransition(id, status);
        if (id === run.id && status === 'done' && !reopened) {
          reopened = true;
          // Simulate the concurrent recovery transaction committing during
          // the awaited transition notification: run → in_progress, task
          // reset exactly as recoverWorkflowBackedTask writes it.
          originalTransition(run.id, 'in_progress');
          taskRepo.updateTask(task.id, {
            status: 'in_progress',
            reportedStatus: null,
            result: null,
            completedAt: null,
          });
        }
        return result;
      }) as typeof workflowRunRepo.transitionStatus;

      try {
        await rt.executeTick();
      } finally {
        workflowRunRepo.transitionStatus = originalTransition;
      }

      expect(reopened).toBe(true);
      // The explicit recovery is not undone: the task and run stay
      // in_progress, and the recovered worker's execution stays alive.
      expect(taskRepo.getTask(task.id)?.status).toBe('in_progress');
      expect(taskRepo.getTask(task.id)?.result).toBeNull();
      expect(workflowRunRepo.getRun(run.id)?.status).toBe('in_progress');
      const execution = nodeExecutionRepo.listByWorkflowRun(run.id);
      expect(execution.some((e) => e.status === 'in_progress')).toBe(true);
    });

    test('does not quiesce workers recovered during the resolved-branch outcome publish', async () => {
      // Interleaving (task #918, resolved-task branch): the externally
      // completed task is `done` with a result, and the decision-artifact
      // summary DIFFERS — so buildTaskOutcomeUpdates produces updates and the
      // branch awaits updateTaskAndEmit. A concurrent recoverWorkflowBackedTask
      // commits during that await (run → in_progress, task reset, execution
      // restarted). The sibling-sweep decision (`finalTaskStatus`) was computed
      // from the PRE-await snapshot (done); without a recovery recheck the
      // sweep's freshly-read victim list would idle + interrupt the recovered
      // worker.
      const mockTam = new MockTaskAgentManager(nodeExecutionRepo);
      mockTam.isSessionAlive = () => true;
      const rt = makeRuntimeWithTam({
        taskAgentManager: mockTam as unknown as TaskAgentManager,
      });
      // Two nodes so the recovered worker sits on a NON-end node — the sweep
      // excludes the end node's executions via its sourceNodeId fallback, so
      // an end-node victim would never prove the recheck.
      const workflow = workflowManager.createWorkflow({
        spaceId: SPACE_ID,
        name: `Outcome Publish Recovery ${Date.now()}`,
        description: '',
        nodes: [
          { id: 'node-outcome-recover', name: 'Coding', agentId: AGENT_A },
          { id: 'node-outcome-end', name: 'Review', agentId: AGENT_B },
        ],
        startNodeId: 'node-outcome-recover',
        endNodeId: 'node-outcome-end',
        tags: [],
        completionAutonomyLevel: 3,
      });
      const { run, tasks } = await rt.startWorkflowRun(
        SPACE_ID,
        workflow.id,
        'Outcome publish recovery run'
      );
      const task = tasks[0];
      // External validation-completion shape: task done with an outcome, run
      // still active; the terminal decision artifact carries a DIFFERENT
      // summary so the resolved branch's outcome update is non-empty.
      taskRepo.updateTask(task.id, {
        status: 'done',
        result: 'external validation outcome',
      });
      artifactRepo.upsert({
        id: 'artifact-outcome-recovery',
        runId: run.id,
        nodeId: 'node-outcome-recover',
        artifactType: 'decision',
        artifactKey: 'final',
        data: { summary: 'Reconciled artifact summary' },
      });
      const recoveredExecId = seedNodeExec(
        db,
        run.id,
        'node-outcome-recover',
        'agent',
        'in_progress'
      );
      const recoveredSessionId = 'recovered-worker-session';
      db.prepare('UPDATE node_executions SET agent_session_id = ? WHERE id = ?').run(
        recoveredSessionId,
        recoveredExecId
      );

      type UpdateTaskAndEmit = (
        spaceId: string,
        taskId: string,
        params: Record<string, unknown>
      ) => Promise<unknown>;
      const rtInternal = rt as unknown as { updateTaskAndEmit: UpdateTaskAndEmit };
      const original = rtInternal.updateTaskAndEmit.bind(rt);
      let recovered = false;
      rtInternal.updateTaskAndEmit = (async (spaceId, taskId, params) => {
        const result = await original(spaceId, taskId, params);
        if (!recovered && params.result) {
          recovered = true;
          // The recovery transaction commits after the outcome publish —
          // exactly what a concurrent recoverWorkflowBackedTask does while
          // the tick is inside this await.
          workflowRunRepo.transitionStatus(run.id, 'in_progress');
          taskRepo.updateTask(task.id, {
            status: 'in_progress',
            reportedStatus: null,
            result: null,
            completedAt: null,
          });
        }
        return result;
      }) as UpdateTaskAndEmit;

      try {
        await rt.executeTick();
      } finally {
        rtInternal.updateTaskAndEmit = original;
      }

      expect(recovered).toBe(true);
      // The recovery is not undone: task and run stay in_progress, and the
      // recovered worker is neither idled nor interrupted.
      expect(taskRepo.getTask(task.id)?.status).toBe('in_progress');
      expect(workflowRunRepo.getRun(run.id)?.status).toBe('in_progress');
      const execution = nodeExecutionRepo
        .listByWorkflowRun(run.id)
        .find((e) => e.agentSessionId === recoveredSessionId);
      expect(execution?.status).toBe('in_progress');
      expect(mockTam.interruptedSessions).not.toContain(recoveredSessionId);
    });

    test('does not flip the run to done when a recovery lands before the transition', async () => {
      // Interleaving (task #918): CompletionDetector decides `runIsComplete`
      // from the done task, then several AWAITED sweeps run before the
      // run→done transition. A recoverWorkflowBackedTask landing inside one
      // of those awaits reopens the task (in_progress, reportedStatus
      // cleared). Transitioning on the stale decision would stomp the
      // recovery — the run reads done, ticks early-return for it, the
      // reopened task's pending execution never spawns, and the periodic
      // reconciler later force-dispatches the task back to done. The
      // pre-transition recheck must let the next tick evaluate the
      // recovered state instead.
      const rt = makeRuntimeWithTam();
      const workflow = buildLinearWorkflow(SPACE_ID, workflowManager, [
        { id: 'node-pre-transition', name: 'Coding', agentId: AGENT_A },
      ]);
      const { run, tasks } = await rt.startWorkflowRun(
        SPACE_ID,
        workflow.id,
        'Pre-transition recovery run'
      );
      const task = tasks[0];
      // External validation-completion shape: task done, run still active.
      taskRepo.updateTask(task.id, { status: 'done', result: 'external validation outcome' });
      seedNodeExec(db, run.id, 'node-pre-transition', 'agent', 'in_progress');

      const rtInternal = rt as unknown as {
        completionDetector: { isComplete: (query: unknown) => boolean };
      };
      const originalIsComplete = rtInternal.completionDetector.isComplete.bind(
        rtInternal.completionDetector
      );
      let recovered = false;
      rtInternal.completionDetector.isComplete = (query: unknown) => {
        const result = originalIsComplete(query);
        if (result && !recovered) {
          recovered = true;
          // The recovery commits right AFTER the completion decision —
          // inside the awaited sweeps, before the transition.
          taskRepo.updateTask(task.id, {
            status: 'in_progress',
            reportedStatus: null,
            result: null,
            completedAt: null,
          });
        }
        return result;
      };

      try {
        await rt.executeTick();
      } finally {
        rtInternal.completionDetector.isComplete = originalIsComplete;
      }

      expect(recovered).toBe(true);
      // The recovery is honored: task AND run stay in_progress — the run was
      // never flipped to done on the stale decision.
      expect(taskRepo.getTask(task.id)?.status).toBe('in_progress');
      expect(taskRepo.getTask(task.id)?.result).toBeNull();
      expect(workflowRunRepo.getRun(run.id)?.status).toBe('in_progress');
    });

    test('does not flip the run to done when a recovery reopens the task to open', async () => {
      // recoverWorkflowBackedTask(..., 'open') leaves the run `in_progress`
      // and the task `open` with reportedStatus cleared. `open` carries no
      // completion signal, so the pre-transition recheck must refuse the
      // flip — an open task attached to a done run would never be driven
      // again by subsequent ticks.
      const rt = makeRuntimeWithTam();
      const workflow = buildLinearWorkflow(SPACE_ID, workflowManager, [
        { id: 'node-open-recovery', name: 'Coding', agentId: AGENT_A },
      ]);
      const { run, tasks } = await rt.startWorkflowRun(SPACE_ID, workflow.id, 'Open recovery run');
      const task = tasks[0];
      taskRepo.updateTask(task.id, { status: 'done', result: 'external validation outcome' });
      seedNodeExec(db, run.id, 'node-open-recovery', 'agent', 'in_progress');

      const rtInternal = rt as unknown as {
        completionDetector: { isComplete: (query: unknown) => boolean };
      };
      const originalIsComplete = rtInternal.completionDetector.isComplete.bind(
        rtInternal.completionDetector
      );
      let recovered = false;
      rtInternal.completionDetector.isComplete = (query: unknown) => {
        const result = originalIsComplete(query);
        if (result && !recovered) {
          recovered = true;
          // Recovery to OPEN: run untouched (still in_progress), task reset.
          taskRepo.updateTask(task.id, {
            status: 'open',
            reportedStatus: null,
            result: null,
            completedAt: null,
          });
        }
        return result;
      };

      try {
        await rt.executeTick();
      } finally {
        rtInternal.completionDetector.isComplete = originalIsComplete;
      }

      expect(recovered).toBe(true);
      expect(taskRepo.getTask(task.id)?.status).toBe('open');
      expect(workflowRunRepo.getRun(run.id)?.status).toBe('in_progress');
    });

    test('does not finalize the old run when the done task moves to another run mid-tick', async () => {
      // spaceTask.update can move a done task to a DIFFERENT run while the
      // tick is between its completion decision and the run→done transition.
      // The refreshed task keeps its completion signal, but finalizing the
      // OLD run would apply its outcome and post-approval routing to a task
      // the new run owns — prematurely completing that workflow. Both the
      // pre- and post-transition predicates require the task to still be
      // attached to this run.
      const rt = makeRuntimeWithTam();
      const workflow = buildLinearWorkflow(SPACE_ID, workflowManager, [
        { id: 'node-move', name: 'Coding', agentId: AGENT_A },
      ]);
      const { run, tasks } = await rt.startWorkflowRun(SPACE_ID, workflow.id, 'Move run');
      const task = tasks[0];
      taskRepo.updateTask(task.id, { status: 'done', result: 'external validation outcome' });
      seedNodeExec(db, run.id, 'node-move', 'agent', 'in_progress');
      const otherWorkflow = buildLinearWorkflow(SPACE_ID, workflowManager, [
        { id: 'node-move-other', name: 'Other', agentId: AGENT_B },
      ]);
      const otherRun = workflowRunRepo.createRun({
        spaceId: SPACE_ID,
        workflowId: otherWorkflow.id,
        title: 'Other run',
        description: '',
      });
      workflowRunRepo.updateRun(otherRun.id, { status: 'in_progress' });

      const rtInternal = rt as unknown as {
        completionDetector: { isComplete: (query: unknown) => boolean };
      };
      const originalIsComplete = rtInternal.completionDetector.isComplete.bind(
        rtInternal.completionDetector
      );
      let moved = false;
      rtInternal.completionDetector.isComplete = (query: unknown) => {
        const result = originalIsComplete(query);
        if (result && !moved) {
          moved = true;
          // The task moves runs after the completion decision, status kept.
          taskRepo.updateTask(task.id, { workflowRunId: otherRun.id });
        }
        return result;
      };

      try {
        await rt.executeTick();
      } finally {
        rtInternal.completionDetector.isComplete = originalIsComplete;
      }

      expect(moved).toBe(true);
      // The OLD run was never finalized on the moved task's signal.
      expect(workflowRunRepo.getRun(run.id)?.status).toBe('in_progress');
      expect(taskRepo.getTask(task.id)?.workflowRunId).toBe(otherRun.id);
    });

    test('does not finalize the run when the done task is detached mid-tick', async () => {
      // spaceTask.update can clear workflowRunId entirely while the tick is
      // between its completion decision and the run→done transition. A
      // detached task retaining reportedStatus must not finalize the old
      // run — its outcome and post-approval routing would then be applied
      // to a task that no longer belongs to any run.
      const rt = makeRuntimeWithTam();
      const workflow = buildLinearWorkflow(SPACE_ID, workflowManager, [
        { id: 'node-detach', name: 'Coding', agentId: AGENT_A },
      ]);
      const { run, tasks } = await rt.startWorkflowRun(SPACE_ID, workflow.id, 'Detach run');
      const task = tasks[0];
      taskRepo.updateTask(task.id, { status: 'done', result: 'external validation outcome' });
      seedNodeExec(db, run.id, 'node-detach', 'agent', 'in_progress');

      const rtInternal = rt as unknown as {
        completionDetector: { isComplete: (query: unknown) => boolean };
      };
      const originalIsComplete = rtInternal.completionDetector.isComplete.bind(
        rtInternal.completionDetector
      );
      let detached = false;
      rtInternal.completionDetector.isComplete = (query: unknown) => {
        const result = originalIsComplete(query);
        if (result && !detached) {
          detached = true;
          taskRepo.updateTask(task.id, { workflowRunId: null });
        }
        return result;
      };

      try {
        await rt.executeTick();
      } finally {
        rtInternal.completionDetector.isComplete = originalIsComplete;
      }

      expect(detached).toBe(true);
      // The run was never finalized on the detached task's signal. (The
      // task's own final shape is the recovery machinery's business — a
      // stalled-run recovery may legitimately reattach and reset it — what
      // must NOT happen is the run→done flip on a signal the task no longer
      // carries for this run.)
      expect(workflowRunRepo.getRun(run.id)?.status).toBe('in_progress');
    });

    test('a stale tick does not re-close a channel-reopened run generation', async () => {
      // Another tick closes the run; ChannelRouter reopens it (done →
      // in_progress, NEW startedAt) while THIS tick awaits earlier
      // completion work. The reopened run is in_progress and its task
      // stayed done (channel reopen leaves it), so every status-only
      // predicate passes — the stale tick must not transition the new
      // lifecycle back to done. Both tick predicates bind to the run
      // generation observed at entry.
      const rt = makeRuntimeWithTam();
      const workflow = buildLinearWorkflow(SPACE_ID, workflowManager, [
        { id: 'node-reopened-gen', name: 'Coding', agentId: AGENT_A },
      ]);
      const { run, tasks } = await rt.startWorkflowRun(
        SPACE_ID,
        workflow.id,
        'Reopened generation run'
      );
      const task = tasks[0];
      taskRepo.updateTask(task.id, { status: 'done', result: 'external validation outcome' });
      seedNodeExec(db, run.id, 'node-reopened-gen', 'agent', 'in_progress');

      const rtInternal = rt as unknown as {
        completionDetector: { isComplete: (query: unknown) => boolean };
      };
      const originalIsComplete = rtInternal.completionDetector.isComplete.bind(
        rtInternal.completionDetector
      );
      let reopened = false;
      rtInternal.completionDetector.isComplete = (query: unknown) => {
        const result = originalIsComplete(query);
        if (result && !reopened) {
          reopened = true;
          // Concurrent tick closes; a channel activation reopens (restamps
          // startedAt); the task stays done throughout.
          workflowRunRepo.transitionStatus(run.id, 'done');
          workflowRunRepo.transitionStatus(run.id, 'in_progress');
        }
        return result;
      };

      try {
        await rt.executeTick();
      } finally {
        rtInternal.completionDetector.isComplete = originalIsComplete;
      }

      expect(reopened).toBe(true);
      // The reopened lifecycle survives: the run stays in_progress.
      expect(workflowRunRepo.getRun(run.id)?.status).toBe('in_progress');
    });
  });

  // -------------------------------------------------------------------------
  // completedAt timestamp
  // -------------------------------------------------------------------------

  describe('completedAt timestamp', () => {
    test('sets completedAt when CompletionDetector marks run as done', async () => {
      const rt = makeRuntimeWithTam();
      const workflow = buildLinearWorkflow(SPACE_ID, workflowManager, [
        { id: 'step-ts', name: 'Step', agentId: AGENT_A },
      ]);

      const { run, tasks } = await rt.startWorkflowRun(SPACE_ID, workflow.id, 'Run');

      // Verify run starts without completedAt
      const freshRun = workflowRunRepo.getRun(run.id);
      expect(freshRun?.completedAt).toBeNull();

      taskRepo.updateTask(tasks[0].id, { status: 'done' });

      // Create matching node_execution record for CompletionDetector
      seedNodeExec(db, run.id, 'step-ts', 'agent', 'idle');

      // Capture time before tick to verify completedAt is recent
      const beforeTick = Date.now();
      await rt.executeTick();

      const completedRun = workflowRunRepo.getRun(run.id);
      expect(completedRun?.status).toBe('done');
      expect(completedRun?.completedAt).toBeDefined();
      expect(typeof completedRun?.completedAt).toBe('number');
      // Verify completedAt is set to a recent timestamp (within the tick's execution window)
      expect(completedRun!.completedAt!).toBeGreaterThanOrEqual(beforeTick);
      expect(completedRun!.completedAt!).toBeLessThanOrEqual(Date.now() + 100);
    });
  });

  // -------------------------------------------------------------------------
  // Multi-node workflow completion
  // -------------------------------------------------------------------------

  describe('multi-node workflow completion', () => {
    test('multi-node with all tasks done → run completes', async () => {
      const rt = makeRuntimeWithTam();
      const workflow = buildLinearWorkflow(SPACE_ID, workflowManager, [
        { id: 'node-cd-1', name: 'Plan', agentId: AGENT_B },
        { id: 'node-cd-2', name: 'Code', agentId: AGENT_A },
      ]);

      const { run, tasks } = await rt.startWorkflowRun(SPACE_ID, workflow.id, 'Run');
      expect(tasks).toHaveLength(1); // Only start node activated

      // Complete the start node task
      taskRepo.updateTask(tasks[0].id, { status: 'done' });

      // Manually activate the second node and complete it
      // (In production this would be done by ChannelRouter.activateNode)
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

      // Create node_execution records for CompletionDetector
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

      // First node done
      taskRepo.updateTask(tasks[0].id, { status: 'done' });

      // Second node cancelled
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

      // Create node_execution records for CompletionDetector
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

      // Canonical task is left in default in_progress; node executions are
      // in flight. Completion is purely task-status driven, so the run must
      // not complete while the canonical task is non-terminal.
      seedNodeExec(db, run.id, 'node-ip-1', 'agent', 'idle');
      seedNodeExec(db, run.id, 'node-ip-2', 'coder', 'in_progress');

      await rt.executeTick();

      const runAfter = workflowRunRepo.getRun(run.id);
      expect(runAfter?.status).toBe('in_progress');

      const completedEvents = collector.events.filter((e) => e.kind === 'workflow_run_completed');
      expect(completedEvents).toHaveLength(0);
    });
  });

  // -------------------------------------------------------------------------
  // Tick loop early returns for terminal/paused run states
  // -------------------------------------------------------------------------

  describe('tick loop early returns', () => {
    test('processRunTick skips run in blocked state', async () => {
      const rt = makeRuntimeWithTam();
      const workflow = buildLinearWorkflow(SPACE_ID, workflowManager, [
        { id: 'step-na-skip', name: 'Step', agentId: AGENT_A },
      ]);

      const { run, tasks } = await rt.startWorkflowRun(SPACE_ID, workflow.id, 'Run');
      // Escalate to blocked
      workflowRunRepo.transitionStatus(run.id, 'blocked');

      // Set task to done — normally this would trigger completion
      taskRepo.updateTask(tasks[0].id, { status: 'done' });

      await rt.executeTick();

      // Run should still be blocked (not done) because
      // processRunTick returns early for blocked runs
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

      // Complete the task and let tick mark run as done
      taskRepo.updateTask(tasks[0].id, { status: 'done' });
      seedNodeExec(db, run.id, 'step-done-skip', 'agent', 'idle');
      await rt.executeTick();

      expect(workflowRunRepo.getRun(run.id)?.status).toBe('done');
      expect(rt.executorCount).toBe(0);

      // Reset the sink to track events after first tick
      collector.clear();

      // Second tick — no events, no errors
      await rt.executeTick();
      expect(collector.events).toHaveLength(0);
    });

    test('processRunTick skips run in cancelled state', async () => {
      const rt = makeRuntimeWithTam();
      const workflow = buildLinearWorkflow(SPACE_ID, workflowManager, [
        { id: 'step-cancel-skip', name: 'Step', agentId: AGENT_A },
      ]);

      const { run } = await rt.startWorkflowRun(SPACE_ID, workflow.id, 'Run');

      // Cancel via status transition
      workflowRunRepo.transitionStatus(run.id, 'cancelled');

      collector.clear();
      await rt.executeTick();

      // No notifications for cancelled runs (cleanupTerminalExecutors
      // does NOT emit for cancelled, only for done)
      const completedEvents = collector.events.filter((e) => e.kind === 'workflow_run_completed');
      expect(completedEvents).toHaveLength(0);

      // Executor cleaned up
      expect(rt.executorCount).toBe(0);
    });
  });

  // -------------------------------------------------------------------------
  // Status transition lifecycle via tick loop
  // -------------------------------------------------------------------------

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

      // Multiple additional ticks
      await rt.executeTick();
      await rt.executeTick();
      await rt.executeTick();

      // Still exactly one done event
      expect(collector.events.filter((e) => e.kind === 'workflow_run_completed')).toHaveLength(1);
    });

    test('blocked run does not auto-complete even when all tasks become terminal', async () => {
      const rt = makeRuntimeWithTam();
      const workflow = buildLinearWorkflow(SPACE_ID, workflowManager, [
        { id: 'step-na-no-auto', name: 'Step', agentId: AGENT_A },
      ]);

      const { run, tasks } = await rt.startWorkflowRun(SPACE_ID, workflow.id, 'Run');

      // Move to blocked
      workflowRunRepo.transitionStatus(run.id, 'blocked');

      // All tasks terminal
      taskRepo.updateTask(tasks[0].id, { status: 'done' });

      await rt.executeTick();

      // Run stays blocked — processRunTick returns early
      const runAfter = workflowRunRepo.getRun(run.id);
      expect(runAfter?.status).toBe('blocked');
      expect(runAfter?.completedAt).toBeNull();
    });

    test('canonical task in `blocked` is not pushed through dispatchPostApproval on run completion', async () => {
      // Regression for the cascade-block path: if a task was cascade-blocked
      // (`dependency_failed`) while its workflow run continued and then
      // completed, the runtime previously tried to transition
      // `blocked → approved` via dispatchPostApproval, which is invalid.
      // The completion guard must treat `blocked` as already-resolved.
      const rt = makeRuntimeWithTam();
      const workflow = buildLinearWorkflow(SPACE_ID, workflowManager, [
        { id: 'node-blk-1', name: 'Plan', agentId: AGENT_B },
        { id: 'node-blk-2', name: 'Code', agentId: AGENT_A },
      ]);

      const { run, tasks } = await rt.startWorkflowRun(SPACE_ID, workflow.id, 'Run');
      expect(tasks).toHaveLength(1);

      // First-node task completes normally — this is what signals
      // CompletionDetector that the run is complete.
      taskRepo.updateTask(tasks[0].id, { status: 'done' });

      // Second-node task is `blocked` (e.g. cascade-blocked by a dependency
      // failure on a sibling task) when the run reaches completion.
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

      // Should not throw with "Invalid status transition from 'blocked' to 'approved'".
      await rt.executeTick();

      // Run reaches `done` via CompletionDetector.
      expect(workflowRunRepo.getRun(run.id)?.status).toBe('done');

      // Blocked task is left in `blocked` (or archived alongside the run) —
      // it must NEVER be transitioned to `approved`/`done`, which would be
      // an invalid `blocked → approved` transition.
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

      // Step 1: escalate to blocked
      workflowRunRepo.transitionStatus(run.id, 'blocked');
      expect(workflowRunRepo.getRun(run.id)?.status).toBe('blocked');

      // Step 2: human resolves → resume to in_progress
      workflowRunRepo.transitionStatus(run.id, 'in_progress');
      expect(workflowRunRepo.getRun(run.id)?.status).toBe('in_progress');

      // Step 3: complete all tasks
      taskRepo.updateTask(tasks[0].id, { status: 'done' });
      seedNodeExec(db, run.id, 'step-resume', 'agent', 'idle');
      await rt.executeTick();

      // Step 4: run should now be done
      const finalRun = workflowRunRepo.getRun(run.id);
      expect(finalRun?.status).toBe('done');
      expect(finalRun?.completedAt).toBeDefined();

      const completedEvents = collector.events.filter((e) => e.kind === 'workflow_run_completed');
      expect(completedEvents).toHaveLength(1);
    });

    test('cascade-cancelling an in_progress dependent also cancels its workflow run', async () => {
      // Regression: when the runtime cancels task A (e.g. via the run-cancel
      // reconcile path), the cascade transitions in_progress dependent task B
      // to `cancelled`. Without the run-cancel hook, B's workflow run stays
      // `in_progress` and CompletionDetector finalizes it as `done` on the
      // next tick (because a `cancelled` task signals completion). The hook
      // must transition B's run to `cancelled` so the lifecycle/audit state
      // is consistent.
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

      // Wire B → depends on A.
      taskRepo.updateTask(tasksB[0].id, { dependsOn: [tasksA[0].id] });

      // Cancel run A externally; the runtime tick will mirror the run
      // cancellation onto task A (via reconcileTerminalRunTasks /
      // processRunTick), which calls updateTaskAndEmit and triggers our
      // cascade.
      workflowRunRepo.transitionStatus(runA.id, 'cancelled');

      await rt.executeTick();

      // Task A is cancelled.
      expect(taskRepo.getTask(tasksA[0].id)?.status).toBe('cancelled');

      // Cascade: task B is cancelled too.
      expect(taskRepo.getTask(tasksB[0].id)?.status).toBe('cancelled');

      // Run B is cancelled (NOT silently finalized to `done`).
      expect(workflowRunRepo.getRun(runB.id)?.status).toBe('cancelled');
    });
  });

  // -------------------------------------------------------------------------
  // Pending-but-blocked via workflow channels in tick loop context
  // -------------------------------------------------------------------------

  describe('pending-but-blocked via workflow channels', () => {
    test('canonical task done → run completes (task-status drives completion)', async () => {
      // Completion is purely task-status driven: when the single canonical
      // task reaches a terminal status, the run completes, regardless of
      // channel topology or which node the canonical task is attached to.
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
      expect(tasks).toHaveLength(1); // Only start node

      // Mark the canonical task done; completion fires regardless of
      // whether downstream nodes were ever activated.
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

      // Complete start node
      taskRepo.updateTask(tasks[0].id, { status: 'done' });

      // Manually activate second node and complete it
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

      // Create node_execution records for CompletionDetector
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

      // Workflow with NO channels
      const workflow = buildLinearWorkflow(SPACE_ID, workflowManager, [
        { id: 'no-chan-1', name: 'Plan', agentId: AGENT_B },
        { id: 'no-chan-2', name: 'Code', agentId: AGENT_A },
      ]);

      const { run, tasks } = await rt.startWorkflowRun(SPACE_ID, workflow.id, 'Run');

      // Mark canonical task done — completion fires regardless of channels.
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

  // -------------------------------------------------------------------------
  // Multi-agent parallel node completion
  // -------------------------------------------------------------------------

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

      // Completion is task-status driven; mark the canonical task done.
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

      // Canonical task left in default in_progress.
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

      // Tick 1: canonical task in_progress; no completion.
      await rt.executeTick();
      expect(workflowRunRepo.getRun(run.id)?.status).toBe('in_progress');
      expect(collector.events.filter((e) => e.kind === 'workflow_run_completed')).toHaveLength(0);

      // Tick 2: canonical task flips to done; completion fires.
      taskRepo.updateTask(tasks[0].id, { status: 'done' });
      await rt.executeTick();

      expect(workflowRunRepo.getRun(run.id)?.status).toBe('done');
      expect(collector.events.filter((e) => e.kind === 'workflow_run_completed')).toHaveLength(1);

      // Tick 3: no duplicate
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

      // startWorkflowRun() creates per-agent node_execution records for the
      // multi-agent start step (not the synthetic end). Both should be
      // 'pending' initially.
      const startExecs = nodeExecutionRepo
        .listByWorkflowRun(run.id)
        .filter((e) => e.workflowNodeId === 'mix-start');
      expect(startExecs).toHaveLength(2);
      expect(startExecs.every((e) => e.status === 'pending')).toBe(true);

      // Set executions to heterogeneous statuses: coder done, reviewer still in_progress.
      seedNodeExec(db, run.id, 'mix-start', 'coder', 'idle');
      seedNodeExec(db, run.id, 'mix-start', 'reviewer', 'in_progress');

      await rt.executeTick();

      // Node executions should reflect the seeded mixed state.
      const execsAfter = nodeExecutionRepo
        .listByWorkflowRun(run.id)
        .filter((e) => e.workflowNodeId === 'mix-start');
      const coderExec = execsAfter.find((e) => e.agentName === 'coder');
      const reviewerExec = execsAfter.find((e) => e.agentName === 'reviewer');
      expect(coderExec?.status).toBe('idle');
      expect(reviewerExec?.status).toBe('in_progress');

      // Run stays in_progress while canonical task is in_progress.
      expect(workflowRunRepo.getRun(run.id)?.status).toBe('in_progress');
      expect(collector.events.filter((e) => e.kind === 'workflow_run_completed')).toHaveLength(0);

      // Flip canonical task to done; reviewer execution becomes idle as the
      // agent finishes.
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

  // -------------------------------------------------------------------------
  // Dedup cleanup on terminal executor removal
  // -------------------------------------------------------------------------

  describe('dedup cleanup on completion', () => {
    test('dedup entries are cleaned up when executor is removed on completion', async () => {
      const rt = makeRuntimeWithTam();
      const workflow = buildLinearWorkflow(SPACE_ID, workflowManager, [
        { id: 'step-dedup-clean', name: 'Step', agentId: AGENT_A },
      ]);

      const { run, tasks } = await rt.startWorkflowRun(SPACE_ID, workflow.id, 'Run');
      const taskId = tasks[0].id;
      const dedupKey = `${taskId}:timeout`;

      // Empty dedup set at start
      expect(rt.getNotifiedTaskSet().has(dedupKey)).toBe(false);

      // Trigger timeout dedup by marking the execution stale.
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

      // Complete the run
      taskRepo.updateTask(taskId, { status: 'done' });
      seedNodeExec(db, run.id, 'step-dedup-clean', 'agent', 'idle');
      await rt.executeTick();

      // Run should be done
      const completedEvents = collector.events.filter((e) => e.kind === 'workflow_run_completed');
      expect(completedEvents).toHaveLength(1);
      // Dedup entry was removed when executor was cleaned up
      expect(rt.getNotifiedTaskSet().has(dedupKey)).toBe(false);
    });
  });

  // ─────────────────────────────────────────────────────────────────────────────
  // End-node bypass completion scenarios
  // ─────────────────────────────────────────────────────────────────────────────

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

      // Complete start node task
      taskRepo.updateTask(tasks[0].id, { status: 'done' });

      // Seed both node executions — end node is done
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
      // Per issue #1515: node agent sessions must remain reachable via
      // send_message until the parent task reaches `archived`. When the
      // task transitions to `done` / `cancelled`, sibling NodeExecutions
      // still in flight are interrupted (session stops processing) and
      // their status transitions to `idle` — NOT `cancelled` — so they
      // remain a valid message target. The session itself is kept alive
      // in memory; only `archived` triggers full teardown.
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

      // Sibling exec in flight with an agent session.
      const siblingExecId = seedNodeExec(db, run.id, 'ec-sibling', 'Sibling', 'in_progress');
      const siblingSessionId = 'mock-sibling-session-001';
      db.prepare('UPDATE node_executions SET agent_session_id = ? WHERE id = ?').run(
        siblingSessionId,
        siblingExecId
      );
      seedNodeExec(db, run.id, 'ec-end', 'End', 'idle');

      // Canonical task transitions to done; runtime quiesces in-flight siblings.
      taskRepo.updateTask(tasks[0].id, { status: 'done' });

      await rt.executeTick();

      const completedRun = workflowRunRepo.getRun(run.id);
      expect(completedRun?.status).toBe('done');

      const execs = nodeExecutionRepo.listByWorkflowRun(run.id);
      const siblingExec = execs.find((e) => e.workflowNodeId === 'ec-sibling');
      // Sibling execution transitions to `idle` (reachable), not `cancelled` (destroyed).
      expect(siblingExec?.status).toBe('idle');
      // Sibling session retains its agentSessionId so send_message can still reach it.
      expect(siblingExec?.agentSessionId).toBe(siblingSessionId);
      // Runtime interrupted the session — but did NOT delete/cancel it.
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
        // The sweep reads the durable source field, so stamp it too — vt-checker
        // is a NON-end node (end is vt-review); without this the sweep would
        // fall back to the end node and interrupt vt-checker instead of
        // excluding it. Mirrors what `onApproveTask` writes in production.
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
      // Regression: when the canonical task is `blocked` (treated as
      // already-resolved by the completion guard) but the run reaches
      // `done` via CompletionDetector (a sibling task is `done`/`cancelled`
      // or `reportedStatus` is set), in-flight sibling NodeExecutions
      // must still be quiesced. Otherwise the run is `done` while
      // siblings linger in `in_progress`, creating inconsistent
      // run/execution lifecycle state.
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

      // Canonical task is `blocked` (e.g. cascade-blocked by a dependency
      // failure) AND has `reportedStatus` set, so CompletionDetector
      // considers the run complete. The completion guard treats `blocked`
      // as already-resolved, but sibling quiescing must still fire.
      taskRepo.updateTask(tasks[0].id, {
        status: 'blocked',
        reportedStatus: 'blocked',
        reportedSummary: 'cascade-blocked',
      });

      // Sibling exec is in flight with a live session.
      const siblingExecId = seedNodeExec(db, run.id, 'blk-sibling', 'Sibling', 'in_progress');
      const siblingSessionId = 'blk-sibling-session-001';
      db.prepare('UPDATE node_executions SET agent_session_id = ? WHERE id = ?').run(
        siblingSessionId,
        siblingExecId
      );
      seedNodeExec(db, run.id, 'blk-end', 'End', 'idle');

      await rt.executeTick();

      // Run reaches `done`.
      expect(workflowRunRepo.getRun(run.id)?.status).toBe('done');

      // Canonical stays in `blocked` (or archived alongside the run) —
      // must NEVER be transitioned to `approved`/`done`.
      const canonical = taskRepo.getTask(tasks[0].id);
      expect(canonical?.status).not.toBe('approved');
      expect(canonical?.status).not.toBe('done');

      // In-flight sibling must be quiesced to `idle` — not stranded
      // in `in_progress` while the run is `done`.
      const execs = nodeExecutionRepo.listByWorkflowRun(run.id);
      const siblingExec = execs.find((e) => e.workflowNodeId === 'blk-sibling');
      expect(siblingExec?.status).toBe('idle');
      expect(siblingExec?.agentSessionId).toBe(siblingSessionId);
      expect(mockTam.interruptedSessions).toContain(siblingSessionId);
      expect(mockTam.cancelledSessions).not.toContain(siblingSessionId);
    });

    test('post-approval merge session spawned in the completion block is NOT interrupted by the sibling-quiesce sweep', async () => {
      // Regression (PR11 incident): when an end-node reviewer approves a task,
      // `processRunTick`'s `runIsComplete` block calls `dispatchPostApproval`,
      // which spawns a merge/post-approval sub-session on a node OTHER than the
      // completion-submitting (source) node. The sibling-quiesce sweep that
      // runs in the SAME synchronous block used to interrupt that
      // freshly-spawned session ~2ms after it started, leaving it
      // `error_during_execution`/terminal and stranding the task. The sweep's
      // victim set must exclude the session the router just spawned while still
      // quiescing genuine pre-existing in-flight siblings (e.g. a coder still
      // running).
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
            // The reviewer node submits completion; its postApproval route
            // hands off to a dedicated merge agent on a DIFFERENT node.
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

      // Reviewer (end node) submits completion: reportedStatus is set while
      // status stays `in_progress`, so the task is NOT already-resolved →
      // `dispatchPostApproval` runs and the spawn branch fires. The source
      // node is the completion submitter ('pa-review').
      taskRepo.updateTask(tasks[0].id, {
        status: 'in_progress',
        reportedStatus: 'done',
        pendingCompletionSubmittedByNodeId: 'pa-review',
        postApprovalSourceNodeId: 'pa-review',
      });

      // Genuine pre-existing sibling: a coder still in flight. Must be quiesced.
      const coderExecId = seedNodeExec(db, run.id, 'pa-coder', 'Coding', 'in_progress');
      const coderSessionId = 'pa-coder-session-001';
      db.prepare('UPDATE node_executions SET agent_session_id = ? WHERE id = ?').run(
        coderSessionId,
        coderExecId
      );
      // Source/end node execution (excluded from the sweep by sourceNodeId).
      seedNodeExec(db, run.id, 'pa-review', 'Review', 'idle');
      // No 'pa-merge' execution seeded — the post-approval spawn creates it.

      await rt.executeTick();

      // Run completed and the canonical task parked at `approved` awaiting
      // mark_complete, with the spawned session stamped on the task.
      expect(workflowRunRepo.getRun(run.id)?.status).toBe('done');
      const canonical = taskRepo.getTask(tasks[0].id);
      expect(canonical?.status).toBe('approved');
      expect(canonical?.postApprovalSessionId).toBeTruthy();
      expect(mockTam.spawnedPostApprovalSessions).toHaveLength(1);
      const mergeSessionId = mockTam.spawnedPostApprovalSessions[0];

      // The freshly-spawned merge session SURVIVES — not interrupted, execution
      // still `in_progress`, session id intact.
      expect(mockTam.interruptedSessions).not.toContain(mergeSessionId);
      const execs = nodeExecutionRepo.listByWorkflowRun(run.id);
      const mergeExec = execs.find((e) => e.workflowNodeId === 'pa-merge');
      expect(mergeExec?.status).toBe('in_progress');
      expect(mergeExec?.agentSessionId).toBe(mergeSessionId);

      // The genuine pre-existing sibling IS still quiesced — the fix must not
      // weaken sibling cleanup, only stop killing the just-spawned session.
      const coderExec = execs.find((e) => e.workflowNodeId === 'pa-coder');
      expect(coderExec?.status).toBe('idle');
      expect(coderExec?.agentSessionId).toBe(coderSessionId);
      expect(mockTam.interruptedSessions).toContain(coderSessionId);
      expect(mockTam.cancelledSessions).not.toContain(coderSessionId);
    });

    test('sibling session remains reachable for send_message after workflow completion (#1515)', async () => {
      // Regression for issue #1515: when a downstream node (e.g. a reviewer)
      // tries to resolve peers for send_message AFTER an upstream sibling
      // has completed, the sibling's session must still appear as a valid
      // target. This test asserts the post-completion state that feeds
      // AgentMessageRouter.deliverMessage's peer lookup:
      //
      //   1. The sibling NodeExecution row status === 'idle' (not cancelled)
      //   2. The sibling agentSessionId is still populated
      //
      // These two invariants are what list_peers / deliverMessage rely on
      // when the Task Agent asks for a reviewer→coder send_message to
      // succeed after the coder node has finished.
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

      // Reviewer flips the canonical task to done (e.g. after merging a PR).
      taskRepo.updateTask(tasks[0].id, { status: 'done' });
      await rt.executeTick();

      // The coder NodeExecution must remain a valid send_message target:
      // status=idle (listed by list_peers) and agentSessionId preserved
      // (used by AgentMessageRouter.deliverMessage to locate the session).
      const coderExec = nodeExecutionRepo
        .listByWorkflowRun(run.id)
        .find((e) => e.workflowNodeId === 'coder-node');
      expect(coderExec?.status).toBe('idle');
      expect(coderExec?.agentSessionId).toBe(coderSessionId);

      // TaskAgentManager was instructed to interrupt (not destroy) the
      // coder session — the session object itself is still registered
      // and reachable for message injection.
      expect(mockTam.interruptedSessions).toContain(coderSessionId);
      expect(mockTam.cancelledSessions).not.toContain(coderSessionId);

      // The parent task is `done`, not yet `archived` — in production this
      // means TaskAgentManager's archive listener has not fired, so the
      // sub-session record also survives full cleanup.
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

      // Simulate a legacy workflow row persisted before end_node_id existed.
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
      // Even when task.status has not yet flipped to a terminal state, a
      // non-null `reportedStatus` signals the runtime to resolve completion
      // on the next tick. After PR 2/5 the resolution path is
      // `in_progress → approved → done` via `dispatchPostApproval`
      // (completion-actions removed in PR 4/5).
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

      // Tasks in real runs move to `in_progress` when their agent spawns;
      // the mock TAM here skips that so we do it explicitly before setting
      // `reportedStatus`. The transition validator rejects `open → approved`.
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
      // End node exec is 'cancelled' — still terminal, should trigger completion
      seedNodeExec(db, run.id, 'enc-end', 'End', 'cancelled');

      await rt.executeTick();

      // 'cancelled' is a terminal status for end-node short-circuit
      const completedRun = workflowRunRepo.getRun(run.id);
      expect(completedRun?.status).toBe('done');
      expect(collector.events.filter((e) => e.kind === 'workflow_run_completed')).toHaveLength(1);
    });
  });

  // ─────────────────────────────────────────────────────────────────────────────
  // Orchestration task auto-complete on run completion
  // ─────────────────────────────────────────────────────────────────────────────

  describe('orchestration task auto-complete on run completion', () => {
    test('legacy in_progress orchestration task is ignored when run completes', async () => {
      const rt = makeRuntimeWithTam();

      const workflow = buildLinearWorkflow(SPACE_ID, workflowManager, [
        { id: 'orch-node-1', name: 'Step', agentId: AGENT_A },
      ]);

      const { run, tasks } = await rt.startWorkflowRun(SPACE_ID, workflow.id, 'Orch Run');

      // Create an orchestration task with taskAgentSessionId starting with 'space:'
      const orchTask = taskRepo.createTask({
        spaceId: SPACE_ID,
        title: 'Orchestration',
        description: 'Task agent orchestration task',
        workflowRunId: run.id,
        status: 'in_progress',
        taskAgentSessionId: `space:${SPACE_ID}:task:${tasks[0].id}`,
      });

      // Complete the workflow node execution
      taskRepo.updateTask(tasks[0].id, { status: 'done' });
      seedNodeExec(db, run.id, 'orch-node-1', 'agent', 'idle');

      await rt.executeTick();

      // Run should be done
      expect(workflowRunRepo.getRun(run.id)?.status).toBe('done');

      // Strict one-task-per-run repair archives duplicate helper/orchestration tasks.
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

      // Create an orchestration task with taskAgentSessionId but in 'open' state
      const orchTask = taskRepo.createTask({
        spaceId: SPACE_ID,
        title: 'Orchestration Open',
        description: 'Task agent orchestration task in open state',
        workflowRunId: run.id,
        status: 'open',
        taskAgentSessionId: `space:${SPACE_ID}:task:${tasks[0].id}`,
      });

      // Complete the workflow node execution
      taskRepo.updateTask(tasks[0].id, { status: 'done' });
      seedNodeExec(db, run.id, 'orch-open-1', 'agent', 'idle');

      // Should not throw
      await rt.executeTick();

      // Run should be done
      expect(workflowRunRepo.getRun(run.id)?.status).toBe('done');

      // Strict one-task-per-run repair archives duplicate helper/orchestration tasks.
      const orchTaskAfter = taskRepo.getTask(orchTask.id);
      expect(orchTaskAfter?.status).toBe('archived');
    });
  });
});
