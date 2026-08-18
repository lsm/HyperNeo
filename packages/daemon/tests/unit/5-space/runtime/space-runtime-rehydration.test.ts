import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { Database as BunDatabase } from '../../../../src/storage/sqlite-compat';
import { runMigrations } from '../../../../src/storage/schema/index.ts';
import { SpaceWorkflowRepository } from '../../../../src/storage/repositories/space-workflow-repository.ts';
import { SpaceWorkflowRunRepository } from '../../../../src/storage/repositories/space-workflow-run-repository.ts';
import { SpaceTaskRepository } from '../../../../src/storage/repositories/space-task-repository.ts';
import { SpaceAgentRepository } from '../../../../src/storage/repositories/space-agent-repository.ts';
import { NodeExecutionRepository } from '../../../../src/storage/repositories/node-execution-repository.ts';
import { CodingArtifactProfile } from '../../../../src/lib/space/workflows/coding-artifact-profile.ts';
import { ToolContinuationRecoveryRepository } from '../../../../src/storage/repositories/tool-continuation-recovery-repository.ts';
import { SpaceAgentManager } from '../../../../src/lib/space/managers/space-agent-manager.ts';
import { SpaceWorkflowManager } from '../../../../src/lib/space/managers/space-workflow-manager.ts';
import { SpaceManager } from '../../../../src/lib/space/managers/space-manager.ts';
import { SpaceRuntime } from '../../../../src/lib/space/runtime/space-runtime.ts';
import type { SpaceRuntimeConfig } from '../../../../src/lib/space/runtime/space-runtime.ts';
import type { SpaceWorkflow } from '@hyperneo/shared';

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

function seedAgentRow(db: BunDatabase, agentId: string, spaceId: string): void {
  db.prepare(
    `INSERT INTO space_agents (id, space_id, name, description, model, tools, system_prompt, created_at, updated_at)
     VALUES (?, ?, ?, '', null, '[]', '', ?, ?)`
  ).run(agentId, spaceId, `Agent ${agentId}`, Date.now(), Date.now());
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
    name: `Workflow-${Date.now()}-${Math.random()}`,
    description: 'Test',
    nodes,
    transitions,
    startNodeId: nodes[0].id,
    rules: [],
    tags: [],
    completionAutonomyLevel: 3,
  });
}

describe('SpaceRuntime — crash recovery and rehydration', () => {
  let db: BunDatabase;

  let workflowRunRepo: SpaceWorkflowRunRepository;
  let taskRepo: SpaceTaskRepository;
  let agentManager: SpaceAgentManager;
  let workflowManager: SpaceWorkflowManager;
  let spaceManager: SpaceManager;

  const SPACE_ID = 'space-rehydration-1';
  const AGENT = 'agent-rehy-1';
  const STEP_A = 'step-a';
  const STEP_B = 'step-b';

  function makeRuntime(overrides?: Partial<SpaceRuntimeConfig>): SpaceRuntime {
    const artifactRepo = overrides?.artifactRepo;
    const artifactProfile = new CodingArtifactProfile(artifactRepo ? { db, artifactRepo } : { db });
    return new SpaceRuntime({
      db,
      spaceManager,
      spaceAgentManager: agentManager,
      spaceWorkflowManager: workflowManager,
      workflowRunRepo,
      taskRepo,
      nodeExecutionRepo: new NodeExecutionRepository(db),
      artifactProfile,
      ...overrides,
    });
  }

  beforeEach(() => {
    db = makeDb();
    seedSpaceRow(db, SPACE_ID);
    seedAgentRow(db, AGENT, SPACE_ID);

    workflowRunRepo = new SpaceWorkflowRunRepository(db);
    taskRepo = new SpaceTaskRepository(db);
    const agentRepo = new SpaceAgentRepository(db);
    agentManager = new SpaceAgentManager(agentRepo);
    const workflowRepo = new SpaceWorkflowRepository(db);
    workflowManager = new SpaceWorkflowManager(workflowRepo);
    spaceManager = new SpaceManager(db);
  });

  afterEach(() => {
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

  describe('in_progress runs are rehydrated on startup', () => {
    test('fresh runtime creates executor for an in_progress run from DB', async () => {
      const workflow = buildLinearWorkflow(SPACE_ID, workflowManager, [
        { id: STEP_A, name: 'Step A', agentId: AGENT },
      ]);

      const pendingRun = workflowRunRepo.createRun({
        spaceId: SPACE_ID,
        workflowId: workflow.id,
        title: 'Crashed Run',
      });
      workflowRunRepo.transitionStatus(pendingRun.id, 'in_progress');

      const freshRuntime = makeRuntime();
      expect(freshRuntime.executorCount).toBe(0);

      await freshRuntime.executeTick();

      expect(freshRuntime.executorCount).toBe(1);
      expect(freshRuntime.getExecutor(pendingRun.id)).toBeDefined();
    });

    test('rehydrated in_progress run executor is the correct run ID', async () => {
      const workflow = buildLinearWorkflow(SPACE_ID, workflowManager, [
        { id: STEP_A, name: 'Step A', agentId: AGENT },
      ]);

      const runA = workflowRunRepo.createRun({
        spaceId: SPACE_ID,
        workflowId: workflow.id,
        title: 'Run A',
      });
      workflowRunRepo.transitionStatus(runA.id, 'in_progress');

      const freshRuntime = makeRuntime();
      await freshRuntime.executeTick();

      expect(freshRuntime.getExecutor(runA.id)).toBeDefined();
    });

    test('multiple in_progress runs all rehydrated by fresh runtime', async () => {
      const wfA = buildLinearWorkflow(SPACE_ID, workflowManager, [
        { id: 'step-multi-a', name: 'Step A', agentId: AGENT },
      ]);
      const wfB = buildLinearWorkflow(SPACE_ID, workflowManager, [
        { id: 'step-multi-b', name: 'Step B', agentId: AGENT },
      ]);

      const runA = workflowRunRepo.createRun({
        spaceId: SPACE_ID,
        workflowId: wfA.id,
        title: 'Run A',
      });
      workflowRunRepo.transitionStatus(runA.id, 'in_progress');

      const runB = workflowRunRepo.createRun({
        spaceId: SPACE_ID,
        workflowId: wfB.id,
        title: 'Run B',
      });
      workflowRunRepo.transitionStatus(runB.id, 'in_progress');

      const freshRuntime = makeRuntime();
      await freshRuntime.executeTick();

      expect(freshRuntime.executorCount).toBe(2);
      expect(freshRuntime.getExecutor(runA.id)).toBeDefined();
      expect(freshRuntime.getExecutor(runB.id)).toBeDefined();
    });
  });

  describe('blocked runs are rehydrated on startup', () => {
    test('fresh runtime creates executor for a blocked run from DB', async () => {
      const workflow = buildLinearWorkflow(SPACE_ID, workflowManager, [
        { id: STEP_A, name: 'Step A', agentId: AGENT },
      ]);

      const pendingRun = workflowRunRepo.createRun({
        spaceId: SPACE_ID,
        workflowId: workflow.id,
        title: 'Blocked Run',
      });
      workflowRunRepo.transitionStatus(pendingRun.id, 'in_progress');
      workflowRunRepo.transitionStatus(pendingRun.id, 'blocked');

      const freshRuntime = makeRuntime();
      await freshRuntime.executeTick();

      expect(freshRuntime.executorCount).toBe(1);
      expect(freshRuntime.getExecutor(pendingRun.id)).toBeDefined();
    });
  });

  describe('non-rehydratable run states are skipped', () => {
    test('done runs are not rehydrated', async () => {
      const workflow = buildLinearWorkflow(SPACE_ID, workflowManager, [
        { id: STEP_A, name: 'Step A', agentId: AGENT },
      ]);

      const run = workflowRunRepo.createRun({
        spaceId: SPACE_ID,
        workflowId: workflow.id,
        title: 'Done Run',
      });
      workflowRunRepo.transitionStatus(run.id, 'in_progress');
      workflowRunRepo.transitionStatus(run.id, 'done');

      const freshRuntime = makeRuntime();
      await freshRuntime.executeTick();

      expect(freshRuntime.executorCount).toBe(0);
      expect(freshRuntime.getExecutor(run.id)).toBeUndefined();
    });

    test('daemon restart with stale hook state does not reactivate done run', async () => {
      const workflow = buildLinearWorkflow(SPACE_ID, workflowManager, [
        { id: STEP_A, name: 'Step A', agentId: AGENT },
      ]);
      const run = workflowRunRepo.createRun({
        spaceId: SPACE_ID,
        workflowId: workflow.id,
        title: 'Done Run With Stale Hook State',
      });
      const inProgress = workflowRunRepo.transitionStatus(run.id, 'in_progress');
      taskRepo.createTask({
        spaceId: SPACE_ID,
        title: 'Done Run With Stale Hook State',
        description: '',
        workflowRunId: inProgress.id,
        status: 'done',
      });
      const execution = new NodeExecutionRepository(db).create({
        workflowRunId: inProgress.id,
        workflowNodeId: STEP_A,
        agentName: 'agent',
        agentId: AGENT,
        agentSessionId: 'stale-session',
        status: 'done',
      });
      workflowRunRepo.transitionStatus(inProgress.id, 'done');
      const recoveryRepo = new ToolContinuationRecoveryRepository(db);
      recoveryRepo.ensureSchema();
      recoveryRepo.recordToolUse({
        toolUseId: 'stale-tool-use',
        sessionId: 'stale-session',
        ttlMs: 60_000,
        owner: { executionId: execution.id, workflowRunId: inProgress.id },
      });
      recoveryRepo.queueContinuation({
        toolUseId: 'stale-tool-use',
        sessionId: 'stale-session',
        requestBody: { messages: [{ role: 'user', content: [] }] },
        reason: 'late continuation after completion',
        ttlMs: 60_000,
      });

      const freshRuntime = makeRuntime({
        taskAgentManager: {
          rehydrate: async () => {},
          isSessionAlive: () => false,
          getAgentSessionById: () => null,
          isExecutionSpawning: () => false,
        } as never,
      });
      await freshRuntime.executeTick();

      expect(freshRuntime.executorCount).toBe(0);
      expect(freshRuntime.getExecutor(inProgress.id)).toBeUndefined();
      expect(workflowRunRepo.getRun(inProgress.id)?.status).toBe('done');
      expect(new NodeExecutionRepository(db).getById(execution.id)?.status).toBe('done');
    });

    test('cancelled runs are not rehydrated', async () => {
      const workflow = buildLinearWorkflow(SPACE_ID, workflowManager, [
        { id: STEP_A, name: 'Step A', agentId: AGENT },
      ]);

      const run = workflowRunRepo.createRun({
        spaceId: SPACE_ID,
        workflowId: workflow.id,
        title: 'Cancelled Run',
      });
      workflowRunRepo.transitionStatus(run.id, 'in_progress');
      workflowRunRepo.transitionStatus(run.id, 'cancelled');

      const freshRuntime = makeRuntime();
      await freshRuntime.executeTick();

      expect(freshRuntime.executorCount).toBe(0);
      expect(freshRuntime.getExecutor(run.id)).toBeUndefined();
    });

    test('pending runs are not rehydrated (transient pre-start state)', async () => {
      const workflow = buildLinearWorkflow(SPACE_ID, workflowManager, [
        { id: STEP_A, name: 'Step A', agentId: AGENT },
      ]);

      const run = workflowRunRepo.createRun({
        spaceId: SPACE_ID,
        workflowId: workflow.id,
        title: 'Pending Run',
      });
      expect(run.status).toBe('pending');

      const freshRuntime = makeRuntime();
      await freshRuntime.executeTick();

      expect(freshRuntime.executorCount).toBe(0);
      expect(freshRuntime.getExecutor(run.id)).toBeUndefined();
    });

    test('only in_progress/blocked runs rehydrated when mix of states exists', async () => {
      const wfActive = buildLinearWorkflow(SPACE_ID, workflowManager, [
        { id: 'step-active', name: 'Active', agentId: AGENT },
      ]);
      const wfDone = buildLinearWorkflow(SPACE_ID, workflowManager, [
        { id: 'step-done', name: 'Done', agentId: AGENT },
      ]);
      const wfCancelled = buildLinearWorkflow(SPACE_ID, workflowManager, [
        { id: 'step-cancelled', name: 'Cancelled', agentId: AGENT },
      ]);
      const wfBlocked = buildLinearWorkflow(SPACE_ID, workflowManager, [
        { id: 'step-blocked', name: 'Blocked', agentId: AGENT },
      ]);

      const activeRun = workflowRunRepo.createRun({
        spaceId: SPACE_ID,
        workflowId: wfActive.id,
        title: 'Active',
      });
      workflowRunRepo.transitionStatus(activeRun.id, 'in_progress');

      const doneRun = workflowRunRepo.createRun({
        spaceId: SPACE_ID,
        workflowId: wfDone.id,
        title: 'Done',
      });
      workflowRunRepo.transitionStatus(doneRun.id, 'in_progress');
      workflowRunRepo.transitionStatus(doneRun.id, 'done');

      const cancelledRun = workflowRunRepo.createRun({
        spaceId: SPACE_ID,
        workflowId: wfCancelled.id,
        title: 'Cancelled',
      });
      workflowRunRepo.transitionStatus(cancelledRun.id, 'in_progress');
      workflowRunRepo.transitionStatus(cancelledRun.id, 'cancelled');

      const blockedRun = workflowRunRepo.createRun({
        spaceId: SPACE_ID,
        workflowId: wfBlocked.id,
        title: 'Blocked',
      });
      workflowRunRepo.transitionStatus(blockedRun.id, 'in_progress');
      workflowRunRepo.transitionStatus(blockedRun.id, 'blocked');

      const freshRuntime = makeRuntime();
      await freshRuntime.executeTick();

      expect(freshRuntime.executorCount).toBe(2);
      expect(freshRuntime.getExecutor(activeRun.id)).toBeDefined();
      expect(freshRuntime.getExecutor(blockedRun.id)).toBeDefined();
      expect(freshRuntime.getExecutor(doneRun.id)).toBeUndefined();
      expect(freshRuntime.getExecutor(cancelledRun.id)).toBeUndefined();
    });
  });

  describe('agent session rehydration', () => {
    test('taskAgentManager.rehydrate() is called once on first executeTick()', async () => {
      const workflow = buildLinearWorkflow(SPACE_ID, workflowManager, [
        { id: STEP_A, name: 'Step A', agentId: AGENT },
      ]);

      const run = workflowRunRepo.createRun({
        spaceId: SPACE_ID,
        workflowId: workflow.id,
        title: 'Agent Rehydration Run',
      });
      workflowRunRepo.transitionStatus(run.id, 'in_progress');

      let rehydrateCallCount = 0;
      const mockTAM = {
        isExecutionSpawning: () => false,
        isSessionAlive: () => false,
        spawnWorkflowNodeAgentForExecution: async (task: unknown) => {
          const t = task as { id: string };
          taskRepo.updateTask(t.id, { taskAgentSessionId: `session:${t.id}` });
          return `session:${t.id}`;
        },
        cancelBySessionId: () => {},
        interruptBySessionId: async () => {},
        rehydrate: async () => {
          rehydrateCallCount++;
        },
      };

      const rt = new SpaceRuntime({
        db,
        spaceManager,
        spaceAgentManager: agentManager,
        spaceWorkflowManager: workflowManager,
        workflowRunRepo,
        taskRepo,
        nodeExecutionRepo: new NodeExecutionRepository(db),
        taskAgentManager: mockTAM as never,
      });

      expect(rehydrateCallCount).toBe(0);

      await rt.executeTick();
      expect(rehydrateCallCount).toBe(1);

      await rt.executeTick();
      expect(rehydrateCallCount).toBe(1);
    });

    test('taskAgentManager.rehydrate() called even when no runs exist', async () => {
      let rehydrateCallCount = 0;
      const mockTAM = {
        isExecutionSpawning: () => false,
        isSessionAlive: () => false,
        spawnWorkflowNodeAgentForExecution: async () => 'session-1',
        cancelBySessionId: () => {},
        interruptBySessionId: async () => {},
        rehydrate: async () => {
          rehydrateCallCount++;
        },
      };

      const rt = new SpaceRuntime({
        db,
        spaceManager,
        spaceAgentManager: agentManager,
        spaceWorkflowManager: workflowManager,
        workflowRunRepo,
        taskRepo,
        nodeExecutionRepo: new NodeExecutionRepository(db),
        taskAgentManager: mockTAM as never,
      });

      await rt.executeTick();
      expect(rehydrateCallCount).toBe(1);
    });

    test('executor map is populated before taskAgentManager.rehydrate() is called', async () => {
      const workflow = buildLinearWorkflow(SPACE_ID, workflowManager, [
        { id: STEP_A, name: 'Step A', agentId: AGENT },
      ]);

      const run = workflowRunRepo.createRun({
        spaceId: SPACE_ID,
        workflowId: workflow.id,
        title: 'Order Test Run',
      });
      workflowRunRepo.transitionStatus(run.id, 'in_progress');

      let executorCountAtRehydrate = -1;
      let rtRef: SpaceRuntime | null = null;

      const mockTAM = {
        isExecutionSpawning: () => false,
        isSessionAlive: () => false,
        spawnWorkflowNodeAgentForExecution: async (task: unknown) => {
          const t = task as { id: string };
          taskRepo.updateTask(t.id, { taskAgentSessionId: `session:${t.id}` });
          return `session:${t.id}`;
        },
        cancelBySessionId: () => {},
        interruptBySessionId: async () => {},
        rehydrate: async () => {
          executorCountAtRehydrate = rtRef?.executorCount ?? 0;
        },
      };

      rtRef = new SpaceRuntime({
        db,
        spaceManager,
        spaceAgentManager: agentManager,
        spaceWorkflowManager: workflowManager,
        workflowRunRepo,
        taskRepo,
        nodeExecutionRepo: new NodeExecutionRepository(db),
        taskAgentManager: mockTAM as never,
      });

      await rtRef.executeTick();

      expect(executorCountAtRehydrate).toBe(1);
    });
  });

  describe('open tasks resumed after rehydration', () => {
    test('open task for an in_progress run is spawned on first tick after restart', async () => {
      const workflow = buildLinearWorkflow(SPACE_ID, workflowManager, [
        { id: STEP_A, name: 'Step A', agentId: AGENT },
      ]);

      const run = workflowRunRepo.createRun({
        spaceId: SPACE_ID,
        workflowId: workflow.id,
        title: 'Unspawned Run',
      });
      workflowRunRepo.transitionStatus(run.id, 'in_progress');
      const unspawnedTask = taskRepo.createTask({
        spaceId: SPACE_ID,
        title: 'Step A',
        description: '',
        workflowRunId: run.id,
        workflowNodeId: STEP_A,
        status: 'open',
      });
      new NodeExecutionRepository(db).createOrIgnore({
        workflowRunId: run.id,
        workflowNodeId: STEP_A,
        agentName: unspawnedTask.title,
        agentId: AGENT,
        status: 'pending',
      });

      const spawned: string[] = [];
      const mockTAM = {
        isExecutionSpawning: () => false,
        isSessionAlive: () => false,
        spawnWorkflowNodeAgentForExecution: async (task: unknown) => {
          const t = task as { id: string };
          spawned.push(t.id);
          taskRepo.updateTask(t.id, { taskAgentSessionId: `session:${t.id}` });
          return `session:${t.id}`;
        },
        cancelBySessionId: () => {},
        interruptBySessionId: async () => {},
        rehydrate: async () => {},
      };

      const freshRuntime = new SpaceRuntime({
        db,
        spaceManager,
        spaceAgentManager: agentManager,
        spaceWorkflowManager: workflowManager,
        workflowRunRepo,
        taskRepo,
        nodeExecutionRepo: new NodeExecutionRepository(db),
        taskAgentManager: mockTAM as never,
      });

      await freshRuntime.executeTick();

      expect(spawned).toContain(unspawnedTask.id);
      const updated = taskRepo.getTask(unspawnedTask.id)!;
      expect(updated.status).toBe('in_progress');
      expect(updated.taskAgentSessionId).toBe(`session:${unspawnedTask.id}`);
    });

    test('in_progress task with live agent is not re-spawned after rehydration', async () => {
      const workflow = buildLinearWorkflow(SPACE_ID, workflowManager, [
        { id: STEP_A, name: 'Step A', agentId: AGENT },
      ]);

      const run = workflowRunRepo.createRun({
        spaceId: SPACE_ID,
        workflowId: workflow.id,
        title: 'Live Agent Run',
      });
      workflowRunRepo.transitionStatus(run.id, 'in_progress');

      const existingTask = taskRepo.createTask({
        spaceId: SPACE_ID,
        title: 'Step A',
        description: '',
        workflowRunId: run.id,
        workflowNodeId: STEP_A,
        status: 'in_progress',
      });
      taskRepo.updateTask(existingTask.id, {
        taskAgentSessionId: 'session:existing',
      });

      let spawnCount = 0;
      const mockTAM = {
        isExecutionSpawning: () => false,
        isSessionAlive: (sessionId: string) => sessionId === 'session:existing',
        spawnWorkflowNodeAgentForExecution: async (task: unknown) => {
          const t = task as { id: string };
          spawnCount++;
          taskRepo.updateTask(t.id, { taskAgentSessionId: `session:${t.id}` });
          return `session:${t.id}`;
        },
        cancelBySessionId: () => {},
        interruptBySessionId: async () => {},
        rehydrate: async () => {},
      };

      const freshRuntime = new SpaceRuntime({
        db,
        spaceManager,
        spaceAgentManager: agentManager,
        spaceWorkflowManager: workflowManager,
        workflowRunRepo,
        taskRepo,
        nodeExecutionRepo: new NodeExecutionRepository(db),
        taskAgentManager: mockTAM as never,
      });

      await freshRuntime.executeTick();

      expect(spawnCount).toBe(0);
      const task = taskRepo.getTask(existingTask.id)!;
      expect(task.taskAgentSessionId).toBe('session:existing');
    });
  });

  describe('cross-space rehydration', () => {
    test('in_progress runs from two different spaces are both rehydrated', async () => {
      const SPACE_B = 'space-rehydration-2';
      seedSpaceRow(db, SPACE_B, '/tmp/ws-b');
      seedAgentRow(db, 'agent-b', SPACE_B);

      const wfA = buildLinearWorkflow(SPACE_ID, workflowManager, [
        { id: 'step-cross-a', name: 'Step A', agentId: AGENT },
      ]);
      const wfB = buildLinearWorkflow(SPACE_B, workflowManager, [
        { id: 'step-cross-b', name: 'Step B', agentId: 'agent-b' },
      ]);

      const runA = workflowRunRepo.createRun({
        spaceId: SPACE_ID,
        workflowId: wfA.id,
        title: 'Run A',
      });
      workflowRunRepo.transitionStatus(runA.id, 'in_progress');

      const runB = workflowRunRepo.createRun({
        spaceId: SPACE_B,
        workflowId: wfB.id,
        title: 'Run B',
      });
      workflowRunRepo.transitionStatus(runB.id, 'in_progress');

      const freshRuntime = makeRuntime();
      await freshRuntime.executeTick();

      expect(freshRuntime.executorCount).toBe(2);
      expect(freshRuntime.getExecutor(runA.id)).toBeDefined();
      expect(freshRuntime.getExecutor(runB.id)).toBeDefined();
    });
  });
});
