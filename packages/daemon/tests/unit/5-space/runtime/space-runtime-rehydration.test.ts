/**
 * SpaceRuntime — Crash Recovery and Rehydration Tests (Task 3.3)
 *
 * Tests that the runtime correctly rehydrates in-progress workflow runs on startup:
 *
 *   1. in_progress runs are picked up by a fresh runtime (executor created)
 *   2. blocked runs are also rehydratable (human-gate-blocked runs resume after approval)
 *   3. done, cancelled, and pending runs are NOT rehydrated (terminal/transient states)
 *   4. taskAgentManager.rehydrate() is called during rehydrateExecutors()
 *   5. Open (unspawned) tasks for an in_progress run are processed after rehydration
 *   6. Multiple in_progress runs across the same space all rehydrate
 *   7. Runs across multiple spaces all rehydrate
 */

import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { Database as BunDatabase } from 'bun:sqlite';
import { runMigrations } from '../../../../src/storage/schema/index.ts';
import { SpaceWorkflowRepository } from '../../../../src/storage/repositories/space-workflow-repository.ts';
import { SpaceWorkflowRunRepository } from '../../../../src/storage/repositories/space-workflow-run-repository.ts';
import { SpaceTaskRepository } from '../../../../src/storage/repositories/space-task-repository.ts';
import { SpaceAgentRepository } from '../../../../src/storage/repositories/space-agent-repository.ts';
import { NodeExecutionRepository } from '../../../../src/storage/repositories/node-execution-repository.ts';
import { GateDataRepository } from '../../../../src/storage/repositories/gate-data-repository.ts';
import { WorkflowRunArtifactRepository } from '../../../../src/storage/repositories/workflow-run-artifact-repository.ts';
import { SpaceAgentManager } from '../../../../src/lib/space/managers/space-agent-manager.ts';
import { SpaceWorkflowManager } from '../../../../src/lib/space/managers/space-workflow-manager.ts';
import { SpaceManager } from '../../../../src/lib/space/managers/space-manager.ts';
import { SpaceRuntime } from '../../../../src/lib/space/runtime/space-runtime.ts';
import type { SpaceRuntimeConfig } from '../../../../src/lib/space/runtime/space-runtime.ts';
import type { SpaceWorkflow } from '@neokai/shared';

// ---------------------------------------------------------------------------
// DB / seed helpers
// ---------------------------------------------------------------------------

function makeDb(): BunDatabase {
  // Use in-memory SQLite — faster than file-based DB and avoids filesystem
  // I/O contention that caused beforeEach hook timeouts in CI.
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

// ---------------------------------------------------------------------------
// Test suite
// ---------------------------------------------------------------------------

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
    return new SpaceRuntime({
      db,
      spaceManager,
      spaceAgentManager: agentManager,
      spaceWorkflowManager: workflowManager,
      workflowRunRepo,
      taskRepo,
      nodeExecutionRepo: new NodeExecutionRepository(db),
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

  // -------------------------------------------------------------------------
  // 1. in_progress run picked up by fresh runtime
  // -------------------------------------------------------------------------

  describe('in_progress runs are rehydrated on startup', () => {
    test('fresh runtime creates executor for an in_progress run from DB', async () => {
      const workflow = buildLinearWorkflow(SPACE_ID, workflowManager, [
        { id: STEP_A, name: 'Step A', agentId: AGENT },
      ]);

      // Simulate: run was started before crash, now in_progress in DB
      const pendingRun = workflowRunRepo.createRun({
        spaceId: SPACE_ID,
        workflowId: workflow.id,
        title: 'Crashed Run',
      });
      workflowRunRepo.transitionStatus(pendingRun.id, 'in_progress');

      // Fresh runtime — simulates daemon restart
      const freshRuntime = makeRuntime();
      expect(freshRuntime.executorCount).toBe(0); // not yet rehydrated

      // First executeTick() triggers rehydration
      await freshRuntime.executeTick();

      // Executor should now exist for the in_progress run
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

    test('fresh runtime restarts gate polls for a rehydrated in_progress run', async () => {
      const workflow = workflowManager.createWorkflow({
        spaceId: SPACE_ID,
        name: `Polled Workflow-${Date.now()}-${Math.random()}`,
        description: 'Test',
        nodes: [
          { id: STEP_A, name: 'Step A', agentId: AGENT },
          { id: STEP_B, name: 'Step B', agentId: AGENT },
        ],
        transitions: [],
        channels: [{ id: 'channel-a-b', from: 'Step A', to: 'Step B', gateId: 'gate-polled' }],
        gates: [
          {
            id: 'gate-polled',
            resetOnCycle: false,
            poll: {
              intervalMs: 60_000,
              script: 'printf poll',
              target: 'to',
            },
          },
        ],
        startNodeId: STEP_A,
        endNodeId: STEP_B,
        rules: [],
        tags: [],
        completionAutonomyLevel: 3,
      });

      const pendingRun = workflowRunRepo.createRun({
        spaceId: SPACE_ID,
        workflowId: workflow.id,
        title: 'Polled Run',
      });
      const run = workflowRunRepo.transitionStatus(pendingRun.id, 'in_progress');
      taskRepo.createTask({
        spaceId: SPACE_ID,
        title: 'Polled Run',
        description: '',
        workflowRunId: run.id,
        status: 'in_progress',
      });

      const freshRuntime = makeRuntime();
      freshRuntime.setTaskAgentManager({
        isExecutionSpawning: () => false,
        isSessionAlive: () => true,
        spawnWorkflowNodeAgentForExecution: async () => 'session-1',
        cancelBySessionId: () => {},
        interruptBySessionId: async () => {},
        rehydrate: async () => {},
        injectSubSessionMessage: () => {},
      } as never);

      await freshRuntime.executeTick();

      expect(freshRuntime.getExecutor(run.id)).toBeDefined();
      expect(freshRuntime.getActiveGatePollCount()).toBe(1);
      expect(freshRuntime.isGatePollActive(run.id, 'gate-polled')).toBe(true);
      await freshRuntime.stop();
    });

    test('fresh runtime restarts gate polls for a review-pending task', async () => {
      const workflow = workflowManager.createWorkflow({
        spaceId: SPACE_ID,
        name: `Review Polled Workflow-${Date.now()}-${Math.random()}`,
        description: 'Test',
        nodes: [
          { id: STEP_A, name: 'Step A', agentId: AGENT },
          { id: STEP_B, name: 'Step B', agentId: AGENT },
        ],
        transitions: [],
        channels: [{ id: 'channel-review', from: 'Step A', to: 'Step B', gateId: 'gate-review' }],
        gates: [
          {
            id: 'gate-review',
            resetOnCycle: false,
            poll: { intervalMs: 60_000, script: 'printf poll', target: 'from' },
          },
        ],
        startNodeId: STEP_A,
        endNodeId: STEP_B,
        rules: [],
        tags: [],
        completionAutonomyLevel: 3,
      });

      const pendingRun = workflowRunRepo.createRun({
        spaceId: SPACE_ID,
        workflowId: workflow.id,
        title: 'Review Polled Run',
      });
      const run = workflowRunRepo.transitionStatus(pendingRun.id, 'in_progress');
      taskRepo.createTask({
        spaceId: SPACE_ID,
        title: 'Review Polled Run',
        description: '',
        workflowRunId: run.id,
        status: 'review',
      });

      const freshRuntime = makeRuntime();
      freshRuntime.setTaskAgentManager({
        isExecutionSpawning: () => false,
        isSessionAlive: () => true,
        spawnWorkflowNodeAgentForExecution: async () => 'session-1',
        cancelBySessionId: () => {},
        interruptBySessionId: async () => {},
        rehydrate: async () => {},
        injectSubSessionMessage: () => {},
      } as never);

      await freshRuntime.executeTick();

      expect(freshRuntime.getExecutor(run.id)).toBeDefined();
      expect(freshRuntime.isGatePollActive(run.id, 'gate-review')).toBe(true);
      await freshRuntime.stop();
    });

    test('poll context resolves most recently updated PR URL from gate data', () => {
      const run = workflowRunRepo.transitionStatus(
        workflowRunRepo.createRun({
          spaceId: SPACE_ID,
          workflowId: 'workflow-gate-pr',
          title: 'Gate Data PR Run',
        }).id,
        'in_progress'
      );
      const gateDataRepo = new GateDataRepository(db);
      gateDataRepo.set(run.id, 'z-older-gate', {
        pr_url: 'https://github.com/acme/widgets/pull/1',
      });
      gateDataRepo.set(run.id, 'a-newer-gate', {
        pr_url: 'https://github.com/acme/widgets/pull/123',
      });

      const runtime = makeRuntime({ gateDataRepo });

      expect(runtime.getPollPrUrlForRun(run.id)).toBe('https://github.com/acme/widgets/pull/123');
    });

    test('poll context falls back to artifact PR URL when gate data has no PR URL', () => {
      const run = workflowRunRepo.transitionStatus(
        workflowRunRepo.createRun({
          spaceId: SPACE_ID,
          workflowId: 'workflow-artifact-pr',
          title: 'Artifact PR Run',
        }).id,
        'in_progress'
      );
      const gateDataRepo = new GateDataRepository(db);
      gateDataRepo.set(run.id, 'code-ready-gate', { unrelated: 'value' });
      const artifactRepo = new WorkflowRunArtifactRepository(db);
      artifactRepo.upsert({
        id: 'artifact-pr-url',
        runId: run.id,
        nodeId: STEP_A,
        artifactType: 'result',
        artifactKey: 'pr',
        data: { pr_url: 'https://github.com/acme/widgets/pull/456' },
      });

      const runtime = makeRuntime({ gateDataRepo, artifactRepo });

      expect(runtime.getPollPrUrlForRun(run.id)).toBe('https://github.com/acme/widgets/pull/456');
    });

    test('ensurePollsForRun stops existing polls when workflow lookup fails', async () => {
      const workflow = workflowManager.createWorkflow({
        spaceId: SPACE_ID,
        name: `Missing Workflow Poll-${Date.now()}-${Math.random()}`,
        description: 'Test',
        nodes: [
          { id: STEP_A, name: 'Step A', agentId: AGENT },
          { id: STEP_B, name: 'Step B', agentId: AGENT },
        ],
        transitions: [],
        channels: [{ id: 'channel-missing', from: 'Step A', to: 'Step B', gateId: 'gate-missing' }],
        gates: [
          {
            id: 'gate-missing',
            resetOnCycle: false,
            poll: { intervalMs: 60_000, script: 'printf poll', target: 'from' },
          },
        ],
        startNodeId: STEP_A,
        endNodeId: STEP_B,
        rules: [],
        tags: [],
        completionAutonomyLevel: 3,
      });
      const run = workflowRunRepo.transitionStatus(
        workflowRunRepo.createRun({
          spaceId: SPACE_ID,
          workflowId: workflow.id,
          title: 'Missing Workflow Poll Run',
        }).id,
        'in_progress'
      );
      taskRepo.createTask({
        spaceId: SPACE_ID,
        title: 'Missing Workflow Poll Run',
        description: '',
        workflowRunId: run.id,
        status: 'in_progress',
      });
      const runtime = makeRuntime();
      runtime.setTaskAgentManager({
        isExecutionSpawning: () => false,
        isSessionAlive: () => true,
        spawnWorkflowNodeAgentForExecution: async () => 'session-1',
        cancelBySessionId: () => {},
        interruptBySessionId: async () => {},
        rehydrate: async () => {},
        injectSubSessionMessage: () => {},
      } as never);

      await runtime.executeTick();
      expect(runtime.isGatePollActive(run.id, 'gate-missing')).toBe(true);

      workflowManager.deleteWorkflow(workflow.id);
      (runtime as unknown as { executorMeta: Map<string, unknown> }).executorMeta.delete(run.id);
      await (runtime as unknown as { ensurePollsForRun: (r: typeof run) => Promise<void> })[
        'ensurePollsForRun'
      ](run);

      expect(runtime.isGatePollActive(run.id, 'gate-missing')).toBe(false);
      await runtime.stop();
    });

    test('gate poll session resolver ignores cancelled fallback sessions', async () => {
      const workflow = workflowManager.createWorkflow({
        spaceId: SPACE_ID,
        name: `Cancelled Fallback Poll-${Date.now()}-${Math.random()}`,
        description: 'Test',
        nodes: [
          { id: STEP_A, name: 'Step A', agentId: AGENT },
          { id: STEP_B, name: 'Step B', agentId: AGENT },
        ],
        transitions: [],
        channels: [
          { id: 'channel-cancelled', from: 'Step A', to: 'Step B', gateId: 'gate-cancelled' },
        ],
        gates: [
          {
            id: 'gate-cancelled',
            resetOnCycle: false,
            poll: { intervalMs: 60_000, script: 'printf poll', target: 'from' },
          },
        ],
        startNodeId: STEP_A,
        endNodeId: STEP_B,
        rules: [],
        tags: [],
        completionAutonomyLevel: 3,
      });
      const run = workflowRunRepo.transitionStatus(
        workflowRunRepo.createRun({
          spaceId: SPACE_ID,
          workflowId: workflow.id,
          title: 'Cancelled Fallback Poll Run',
        }).id,
        'in_progress'
      );
      taskRepo.createTask({
        spaceId: SPACE_ID,
        title: 'Cancelled Fallback Poll Run',
        description: '',
        workflowRunId: run.id,
        status: 'in_progress',
      });
      const nodeExecutionRepo = new NodeExecutionRepository(db);
      const execution = nodeExecutionRepo.create({
        workflowRunId: run.id,
        workflowNodeId: STEP_A,
        agentName: 'agent',
        agentId: AGENT,
        agentSessionId: 'session-cancelled',
        status: 'idle',
      });
      nodeExecutionRepo.update(execution.id, { status: 'cancelled' });
      const injected: string[] = [];
      const runtime = makeRuntime({ nodeExecutionRepo });
      runtime.setTaskAgentManager({
        isExecutionSpawning: () => false,
        isSessionAlive: () => false,
        spawnWorkflowNodeAgentForExecution: async () => 'session-1',
        cancelBySessionId: () => {},
        interruptBySessionId: async () => {},
        rehydrate: async () => {},
        injectSubSessionMessage: (_sessionId: string, message: string) => {
          injected.push(message);
        },
      } as never);

      await runtime.executeTick();
      await runtime.stop();

      expect(injected).toEqual([]);
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

  // -------------------------------------------------------------------------
  // 2. blocked runs are also rehydratable
  // -------------------------------------------------------------------------

  describe('blocked runs are rehydrated on startup', () => {
    test('fresh runtime creates executor for a blocked run from DB', async () => {
      // blocked runs represent human-gate-blocked workflows — they need their
      // executor reloaded so the run can advance once the gate is resolved
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

      // Blocked runs are rehydratable — executor should exist
      expect(freshRuntime.executorCount).toBe(1);
      expect(freshRuntime.getExecutor(pendingRun.id)).toBeDefined();
    });

    test('fresh runtime restarts gate polls for a rehydrated blocked run with a non-terminal task', async () => {
      const workflow = workflowManager.createWorkflow({
        spaceId: SPACE_ID,
        name: `Blocked Polled Workflow-${Date.now()}-${Math.random()}`,
        description: 'Test',
        nodes: [
          { id: STEP_A, name: 'Step A', agentId: AGENT },
          { id: STEP_B, name: 'Step B', agentId: AGENT },
        ],
        transitions: [],
        channels: [{ id: 'channel-blocked', from: 'Step A', to: 'Step B', gateId: 'gate-blocked' }],
        gates: [
          {
            id: 'gate-blocked',
            resetOnCycle: false,
            poll: { intervalMs: 60_000, script: 'printf poll', target: 'to' },
          },
        ],
        startNodeId: STEP_A,
        endNodeId: STEP_B,
        rules: [],
        tags: [],
        completionAutonomyLevel: 3,
      });
      const pendingRun = workflowRunRepo.createRun({
        spaceId: SPACE_ID,
        workflowId: workflow.id,
        title: 'Blocked Polled Run',
      });
      const inProgressRun = workflowRunRepo.transitionStatus(pendingRun.id, 'in_progress');
      const blockedRun = workflowRunRepo.transitionStatus(inProgressRun.id, 'blocked');
      taskRepo.createTask({
        spaceId: SPACE_ID,
        title: 'Blocked Polled Run',
        description: '',
        workflowRunId: blockedRun.id,
        status: 'blocked',
      });

      const freshRuntime = makeRuntime();
      freshRuntime.setTaskAgentManager({
        isExecutionSpawning: () => false,
        isSessionAlive: () => true,
        spawnWorkflowNodeAgentForExecution: async () => 'session-1',
        cancelBySessionId: () => {},
        interruptBySessionId: async () => {},
        rehydrate: async () => {},
        injectSubSessionMessage: () => {},
      } as never);

      await freshRuntime.executeTick();
      await freshRuntime.executeTick();

      expect(freshRuntime.getExecutor(blockedRun.id)).toBeDefined();
      expect(freshRuntime.isGatePollActive(blockedRun.id, 'gate-blocked')).toBe(true);
      await freshRuntime.stop();
    });
  });

  // -------------------------------------------------------------------------
  // 3. Terminal and transient states are NOT rehydrated
  // -------------------------------------------------------------------------

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

      // Create run but do NOT transition to in_progress — stays pending
      const run = workflowRunRepo.createRun({
        spaceId: SPACE_ID,
        workflowId: workflow.id,
        title: 'Pending Run',
      });
      // Verify it's actually pending
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

      // Active run (in_progress)
      const activeRun = workflowRunRepo.createRun({
        spaceId: SPACE_ID,
        workflowId: wfActive.id,
        title: 'Active',
      });
      workflowRunRepo.transitionStatus(activeRun.id, 'in_progress');

      // Done run
      const doneRun = workflowRunRepo.createRun({
        spaceId: SPACE_ID,
        workflowId: wfDone.id,
        title: 'Done',
      });
      workflowRunRepo.transitionStatus(doneRun.id, 'in_progress');
      workflowRunRepo.transitionStatus(doneRun.id, 'done');

      // Cancelled run
      const cancelledRun = workflowRunRepo.createRun({
        spaceId: SPACE_ID,
        workflowId: wfCancelled.id,
        title: 'Cancelled',
      });
      workflowRunRepo.transitionStatus(cancelledRun.id, 'in_progress');
      workflowRunRepo.transitionStatus(cancelledRun.id, 'cancelled');

      // Blocked run (rehydratable)
      const blockedRun = workflowRunRepo.createRun({
        spaceId: SPACE_ID,
        workflowId: wfBlocked.id,
        title: 'Blocked',
      });
      workflowRunRepo.transitionStatus(blockedRun.id, 'in_progress');
      workflowRunRepo.transitionStatus(blockedRun.id, 'blocked');

      const freshRuntime = makeRuntime();
      await freshRuntime.executeTick();

      // Only in_progress and blocked runs should be rehydrated
      expect(freshRuntime.executorCount).toBe(2);
      expect(freshRuntime.getExecutor(activeRun.id)).toBeDefined();
      expect(freshRuntime.getExecutor(blockedRun.id)).toBeDefined();
      expect(freshRuntime.getExecutor(doneRun.id)).toBeUndefined();
      expect(freshRuntime.getExecutor(cancelledRun.id)).toBeUndefined();
    });
  });

  // -------------------------------------------------------------------------
  // 4. taskAgentManager.rehydrate() is called during rehydrateExecutors()
  // -------------------------------------------------------------------------

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

      // Before any tick, rehydrate has not been called
      expect(rehydrateCallCount).toBe(0);

      // First tick triggers rehydration
      await rt.executeTick();
      expect(rehydrateCallCount).toBe(1);

      // Second tick does NOT re-call rehydrate (idempotent)
      await rt.executeTick();
      expect(rehydrateCallCount).toBe(1);
    });

    test('taskAgentManager.rehydrate() called even when no runs exist', async () => {
      // rehydrate() should be called regardless of how many runs are found —
      // it's always called as part of the startup sequence
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
      // Executors must be loaded first so Task Agents can use MCP tools
      // that rely on the executor map during rehydration
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
          // Capture executor count at the moment rehydrate() is called
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

      // Executor must have been added BEFORE rehydrate() was called
      expect(executorCountAtRehydrate).toBe(1);
    });
  });

  // -------------------------------------------------------------------------
  // 5. Open tasks are processed after rehydration (work is not lost)
  // -------------------------------------------------------------------------

  describe('open tasks resumed after rehydration', () => {
    test('open task for an in_progress run is spawned on first tick after restart', async () => {
      // Scenario: daemon crashed after starting the run + creating a task,
      // but before the Task Agent was spawned. On restart, the task should
      // be picked up and spawned.
      const workflow = buildLinearWorkflow(SPACE_ID, workflowManager, [
        { id: STEP_A, name: 'Step A', agentId: AGENT },
      ]);

      // Simulate crash: run is in_progress, task is open (not yet spawned)
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

      // The previously unspawned task should now have been picked up
      expect(spawned).toContain(unspawnedTask.id);
      const updated = taskRepo.getTask(unspawnedTask.id)!;
      expect(updated.status).toBe('in_progress');
      expect(updated.taskAgentSessionId).toBe(`session:${unspawnedTask.id}`);
    });

    test('in_progress task with live agent is not re-spawned after rehydration', async () => {
      // Scenario: task was already running when the daemon crashed.
      // After restart, the Task Agent session is still alive — no re-spawn.
      const workflow = buildLinearWorkflow(SPACE_ID, workflowManager, [
        { id: STEP_A, name: 'Step A', agentId: AGENT },
      ]);

      const run = workflowRunRepo.createRun({
        spaceId: SPACE_ID,
        workflowId: workflow.id,
        title: 'Live Agent Run',
      });
      workflowRunRepo.transitionStatus(run.id, 'in_progress');

      // Task was already in_progress with a session
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
        isSessionAlive: (sessionId: string) => sessionId === 'session:existing', // alive
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

      // No new spawn — agent is alive
      expect(spawnCount).toBe(0);
      const task = taskRepo.getTask(existingTask.id)!;
      // Session ID unchanged
      expect(task.taskAgentSessionId).toBe('session:existing');
    });
  });

  // -------------------------------------------------------------------------
  // 6. Runs across multiple spaces all rehydrate
  // -------------------------------------------------------------------------

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
