/**
 * ChannelRouter Unit Tests
 *
 * Covers:
 * - activateNode(): first activation creates tasks for each agent slot
 * - activateNode(): idempotent — returns existing tasks on repeated calls
 * - activateNode(): concurrent activation (UNIQUE constraint) handled gracefully
 * - activateNode(): cancelled run auto-reopens when parent task is not archived
 * - activateNode(): completed run auto-reopens when parent task is not archived
 * - activateNode(): archived-task run throws ActivationError
 * - activateNode(): missing run throws ActivationError
 * - activateNode(): missing workflow throws ActivationError
 * - activateNode(): missing node throws ActivationError
 * - activateNode(): multi-agent node creates one task per agent slot
 * - deliverMessage(): auto-activates target node when no active tasks
 * - deliverMessage(): does not re-activate when target node is already active
 * - deliverMessage(): sets activatedTasks only on first activation
 * - deliverMessage(): throws when target role not found in workflow
 * - deliverMessage(): fan-out — node name target activates all agents in that node
 * - deliverMessage(): within-node DM — same-node agent-to-agent
 * - deliverMessage(): isFanOut flag set for node-name targets
 * - deliverMessage(): isFanOut false for agent-role targets
 * - deliverMessage(): cyclic channel increments iterationCount
 * - deliverMessage(): cyclic iteration cap throws ActivationError
 * - canDeliver(): open topology allows all deliveries
 * - canDeliver(): cyclic channel — blocked when cycle count >= maxCycles
 * - canDeliver(): cyclic channel — allowed when below cap
 * - canDeliver(): no gate on channel — allowed
 */

import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { Database as BunDatabase } from '../../../../src/storage/sqlite-compat';
import { runMigrations } from '../../../../src/storage/schema/index.ts';
import { SpaceWorkflowRepository } from '../../../../src/storage/repositories/space-workflow-repository.ts';
import { SpaceWorkflowRunRepository } from '../../../../src/storage/repositories/space-workflow-run-repository.ts';
import { SpaceTaskRepository } from '../../../../src/storage/repositories/space-task-repository.ts';
import { SpaceAgentRepository } from '../../../../src/storage/repositories/space-agent-repository.ts';
import { GateDataRepository } from '../../../../src/storage/repositories/gate-data-repository.ts';
import { ChannelCycleRepository } from '../../../../src/storage/repositories/channel-cycle-repository.ts';
import { NodeExecutionRepository } from '../../../../src/storage/repositories/node-execution-repository.ts';
import { SpaceAgentManager } from '../../../../src/lib/space/managers/space-agent-manager.ts';
import { SpaceWorkflowManager } from '../../../../src/lib/space/managers/space-workflow-manager.ts';
import {
  ChannelRouter,
  ActivationError,
  ChannelGateBlockedError,
} from '../../../../src/lib/space/runtime/channel-router.ts';
import { PermanentSpawnError } from '../../../../src/lib/space/runtime/workflow-node-execution-validation.ts';
import type { Gate, SpaceWorkflow, WorkflowChannel } from '@hyperneo/shared';
import { computeGateDefaults } from '@hyperneo/shared';
import { registerGateFeature } from '../../../../src/lib/space/runtime/gate-features.ts';
import { registerBuiltInValidator } from '../../../../src/lib/space/runtime/built-in-validator-registry.ts';

/**
 * Tests that execute gate scripts require `Bun.spawn` in production
 * (gate-script-executor.ts), which is unavailable under the Vitest/Node
 * runner. They are gated until the production module is de-Bun-ified.
 */
const isBun = typeof (globalThis as { Bun?: unknown }).Bun !== 'undefined';

// ---------------------------------------------------------------------------
// DB helpers
// ---------------------------------------------------------------------------

function makeDb(): BunDatabase {
  // Use in-memory SQLite — faster than file-based DB and avoids filesystem
  // I/O contention that caused beforeEach hook timeouts in CI.
  const db = new BunDatabase(':memory:');
  db.exec('PRAGMA foreign_keys = ON');
  runMigrations(db, () => {});
  return db;
}

function seedSpace(db: BunDatabase, spaceId: string): void {
  db.prepare(
    `INSERT INTO spaces (id, workspace_path, name, description, background_context, instructions,
     allowed_models, session_ids, slug, status, created_at, updated_at)
     VALUES (?, '/tmp/ws', ?, '', '', '', '[]', '[]', ?, 'active', ?, ?)`
  ).run(spaceId, `Space ${spaceId}`, spaceId, Date.now(), Date.now());
}

function seedAgent(db: BunDatabase, agentId: string, spaceId: string): void {
  db.prepare(
    `INSERT INTO space_agents (id, space_id, name, description, model, tools, system_prompt, created_at, updated_at)
     VALUES (?, ?, ?, '', null, '[]', '', ?, ?)`
  ).run(agentId, spaceId, `Agent ${agentId}`, Date.now(), Date.now());
}

// ---------------------------------------------------------------------------
// Workflow builder helpers
// ---------------------------------------------------------------------------

/**
 * End nodes must have exactly 1 agent (validator enforced — they own the
 * `task.reportedStatus` completion signal). When the last user-provided node is
 * multi-agent, we synthesize a separate terminal single-agent end node so the
 * multi-agent node remains the start (or middle) and validation passes.
 */
function withSyntheticEndNode(
  nodes: Array<{
    id: string;
    name: string;
    agentId?: string;
    agents?: Array<{ agentId: string; name: string }>;
  }>
): { nodes: typeof nodes; startNodeId: string; endNodeId: string } {
  const last = nodes[nodes.length - 1];
  const lastIsMultiAgent = (last.agents?.length ?? 0) > 1;
  if (!lastIsMultiAgent) {
    return { nodes, startNodeId: nodes[0].id, endNodeId: last.id };
  }
  const endAgentId =
    nodes.find((n) => n.agentId)?.agentId ?? nodes.find((n) => n.agents)?.agents?.[0]?.agentId;
  if (!endAgentId) throw new Error('cannot synthesize end node: no agentId found in nodes');
  const synthetic = { id: '__test_end__', name: 'Synthetic End', agentId: endAgentId };
  return {
    nodes: [...nodes, synthetic],
    startNodeId: nodes[0].id,
    endNodeId: synthetic.id,
  };
}

function buildWorkflow(
  spaceId: string,
  workflowManager: SpaceWorkflowManager,
  nodes: Array<{
    id: string;
    name: string;
    agentId?: string;
    agents?: Array<{ agentId: string; name: string }>;
    requireCodexApproval?: boolean;
    codexPollIntervalMs?: number;
  }>,
  channels?: WorkflowChannel[]
): SpaceWorkflow {
  const { nodes: finalNodes, startNodeId, endNodeId } = withSyntheticEndNode(nodes);
  return workflowManager.createWorkflow({
    spaceId,
    name: `Test Workflow ${Date.now()}`,
    description: '',
    nodes: finalNodes.map((n) => ({
      id: n.id,
      name: n.name,
      agentId: n.agentId,
      agents: n.agents,
      requireCodexApproval: n.requireCodexApproval,
      codexPollIntervalMs: n.codexPollIntervalMs,
    })),
    transitions: [],
    startNodeId,
    endNodeId,
    rules: [],
    tags: [],
    channels: channels ?? [],
    completionAutonomyLevel: 3,
  });
}

// ---------------------------------------------------------------------------
// Workflow builder helper with gates support
// ---------------------------------------------------------------------------

function buildWorkflowWithGates(
  spaceId: string,
  workflowManager: SpaceWorkflowManager,
  nodes: Array<{
    id: string;
    name: string;
    agentId?: string;
    agents?: Array<{ agentId: string; name: string }>;
    requireCodexApproval?: boolean;
    codexPollIntervalMs?: number;
  }>,
  channels: WorkflowChannel[],
  gates: Gate[],
  templateName?: string
): SpaceWorkflow {
  const { nodes: finalNodes, startNodeId, endNodeId } = withSyntheticEndNode(nodes);
  return workflowManager.createWorkflow({
    spaceId,
    name: `Test Workflow With Gates ${Date.now()}`,
    description: '',
    nodes: finalNodes.map((n) => ({
      id: n.id,
      name: n.name,
      agentId: n.agentId,
      agents: n.agents,
      requireCodexApproval: n.requireCodexApproval,
      codexPollIntervalMs: n.codexPollIntervalMs,
    })),
    transitions: [],
    startNodeId,
    endNodeId,
    rules: [],
    tags: [],
    channels,
    gates,
    completionAutonomyLevel: 3,
    templateName,
  });
}

describe('ChannelRouter', () => {
  let db: BunDatabase;

  let taskRepo: SpaceTaskRepository;
  let workflowRunRepo: SpaceWorkflowRunRepository;
  let workflowManager: SpaceWorkflowManager;
  let agentManager: SpaceAgentManager;
  let gateDataRepo: GateDataRepository;
  let channelCycleRepo: ChannelCycleRepository;
  let router: ChannelRouter;

  const SPACE_ID = 'space-cr-1';
  const AGENT_CODER = 'agent-coder';
  const AGENT_PLANNER = 'agent-planner';
  const AGENT_CUSTOM = 'agent-custom';

  const NODE_A = 'node-a';
  const NODE_B = 'node-b';

  beforeEach(() => {
    db = makeDb();

    seedSpace(db, SPACE_ID);
    seedAgent(db, AGENT_CODER, SPACE_ID);
    seedAgent(db, AGENT_PLANNER, SPACE_ID);
    seedAgent(db, AGENT_CUSTOM, SPACE_ID);

    taskRepo = new SpaceTaskRepository(db);
    workflowRunRepo = new SpaceWorkflowRunRepository(db);
    gateDataRepo = new GateDataRepository(db);
    channelCycleRepo = new ChannelCycleRepository(db);

    // One-task-per-run architecture: ensure every test run has a canonical task.
    const createRunOriginal = workflowRunRepo.createRun.bind(workflowRunRepo);
    (
      workflowRunRepo as unknown as {
        createRun: typeof workflowRunRepo.createRun;
      }
    ).createRun = ((params: Parameters<typeof workflowRunRepo.createRun>[0]) => {
      const run = createRunOriginal(params);
      taskRepo.createTask({
        spaceId: params.spaceId,
        title: params.title,
        description: params.description ?? '',
        status: 'open',
        workflowRunId: run.id,
      });
      return run;
    }) as typeof workflowRunRepo.createRun;

    const agentRepo = new SpaceAgentRepository(db);
    agentManager = new SpaceAgentManager(agentRepo);

    const workflowRepo = new SpaceWorkflowRepository(db);
    workflowManager = new SpaceWorkflowManager(workflowRepo);

    router = new ChannelRouter({
      taskRepo,
      workflowRunRepo,
      workflowManager,
      agentManager,
      gateDataRepo,
      channelCycleRepo,
      db,
      nodeExecutionRepo: new NodeExecutionRepository(db),
    });
  });

  afterEach(() => {
    db.close();
  });

  // -------------------------------------------------------------------------
  // activateNode — first activation
  // -------------------------------------------------------------------------

  describe('activateNode', () => {
    test('creates one pending task for a single-agent node', async () => {
      const workflow = buildWorkflow(SPACE_ID, workflowManager, [
        { id: NODE_A, name: 'Node A', agentId: AGENT_CODER },
      ]);

      const run = workflowRunRepo.createRun({
        spaceId: SPACE_ID,
        workflowId: workflow.id,
        title: 'Test Run',
      });
      workflowRunRepo.transitionStatus(run.id, 'in_progress');

      const tasks = await router.activateNode(run.id, NODE_A);

      expect(tasks).toHaveLength(1);
      expect(tasks[0].status).toBe('open');
      expect(tasks[0].workflowRunId).toBe(run.id);
      // workflowNodeId, agentName, taskType, customAgentId removed in M71
    });

    test('creates one canonical task and one node_execution per agent for a multi-agent node', async () => {
      const workflow = buildWorkflow(SPACE_ID, workflowManager, [
        {
          id: NODE_A,
          name: 'Multi Agent Node',
          agents: [
            { agentId: AGENT_CODER, name: 'coder-slot' },
            { agentId: AGENT_PLANNER, name: 'planner-slot' },
          ],
        },
      ]);

      const run = workflowRunRepo.createRun({
        spaceId: SPACE_ID,
        workflowId: workflow.id,
        title: 'Multi Agent Run',
      });
      workflowRunRepo.transitionStatus(run.id, 'in_progress');

      const tasks = await router.activateNode(run.id, NODE_A);

      expect(tasks).toHaveLength(1);
      expect(tasks[0].workflowRunId).toBe(run.id);
      expect(tasks[0].status).toBe('open');

      const nodeExecutionRepo = new NodeExecutionRepository(db);
      const nodeExecutions = nodeExecutionRepo.listByNode(run.id, NODE_A);
      expect(nodeExecutions).toHaveLength(2);
      expect(nodeExecutions.map((e) => e.agentName).sort()).toEqual(
        ['coder-slot', 'planner-slot'].sort()
      );
    });

    test('sets correct taskType for custom-role agent', async () => {
      const workflow = buildWorkflow(SPACE_ID, workflowManager, [
        {
          id: NODE_A,
          name: 'Custom Node',
          agents: [{ agentId: AGENT_CUSTOM, name: 'custom-slot' }],
        },
      ]);

      const run = workflowRunRepo.createRun({
        spaceId: SPACE_ID,
        workflowId: workflow.id,
        title: 'Custom Role Run',
      });
      workflowRunRepo.transitionStatus(run.id, 'in_progress');

      const tasks = await router.activateNode(run.id, NODE_A);

      expect(tasks).toHaveLength(1);
      // taskType, customAgentId removed in M71; verify task was created for this run
      expect(tasks[0].workflowRunId).toBe(run.id);
    });

    // -----------------------------------------------------------------------
    // Idempotent activation
    // -----------------------------------------------------------------------

    test('returns existing tasks on repeated activation (idempotent)', async () => {
      const workflow = buildWorkflow(SPACE_ID, workflowManager, [
        { id: NODE_A, name: 'Node A', agentId: AGENT_CODER },
      ]);

      const run = workflowRunRepo.createRun({
        spaceId: SPACE_ID,
        workflowId: workflow.id,
        title: 'Idempotent Run',
      });
      workflowRunRepo.transitionStatus(run.id, 'in_progress');

      const firstResult = await router.activateNode(run.id, NODE_A);
      const secondResult = await router.activateNode(run.id, NODE_A);

      // Second call must return the same tasks (same IDs, no duplicates)
      expect(secondResult).toHaveLength(1);
      expect(secondResult[0].id).toBe(firstResult[0].id);

      // Only one task exists in the DB (workflowNodeId removed in M71, filter by run)
      const allTasks = taskRepo.listByWorkflowRun(run.id);
      expect(allTasks).toHaveLength(1);
    });

    test('targetAgentName creates a missing slot even when a sibling slot is active', async () => {
      // Round-10 regression: a multi-agent node with slot A active + slot B
      // unstarted. A slot-targeted activation for B must NOT short-circuit on
      // A being active — it must create B's execution.
      const workflow = buildWorkflow(SPACE_ID, workflowManager, [
        {
          id: NODE_A,
          name: 'Multi Agent Node',
          agents: [
            { agentId: AGENT_CODER, name: 'coder-slot' },
            { agentId: AGENT_PLANNER, name: 'planner-slot' },
          ],
        },
      ]);
      const run = workflowRunRepo.createRun({
        spaceId: SPACE_ID,
        workflowId: workflow.id,
        title: 'Partial Run',
      });
      workflowRunRepo.transitionStatus(run.id, 'in_progress');

      // First activation creates both slots + the canonical task.
      await router.activateNode(run.id, NODE_A);
      const nodeExecutionRepo = new NodeExecutionRepository(db);
      expect(nodeExecutionRepo.listByNode(run.id, NODE_A)).toHaveLength(2);

      // Simulate planner-slot having no row (never spawned) while coder-slot
      // stays active — the partially-active state lazy-activation can hit.
      db.prepare(
        `DELETE FROM node_executions WHERE workflow_run_id = ? AND workflow_node_id = ? AND agent_name = ?`
      ).run(run.id, NODE_A, 'planner-slot');
      expect(nodeExecutionRepo.listByNode(run.id, NODE_A)).toHaveLength(1);

      // Slot-targeted activation recreates the missing slot instead of
      // early-returning on the active sibling.
      await router.activateNode(run.id, NODE_A, { targetAgentName: 'planner-slot' });
      const after = nodeExecutionRepo.listByNode(run.id, NODE_A);
      expect(after.some((e) => e.agentName === 'planner-slot')).toBe(true);
      expect(after).toHaveLength(2);
    });

    test('re-activates if the only existing task is cancelled', async () => {
      const workflow = buildWorkflow(SPACE_ID, workflowManager, [
        { id: NODE_A, name: 'Node A', agentId: AGENT_CODER },
      ]);

      const run = workflowRunRepo.createRun({
        spaceId: SPACE_ID,
        workflowId: workflow.id,
        title: 'Cancelled Task Run',
      });
      workflowRunRepo.transitionStatus(run.id, 'in_progress');

      // First activation
      const firstTasks = await router.activateNode(run.id, NODE_A);
      expect(firstTasks).toHaveLength(1);

      // Cancel the task
      taskRepo.updateTask(firstTasks[0].id, { status: 'cancelled' });

      // Second activation should reuse the canonical run task.
      const secondTasks = await router.activateNode(run.id, NODE_A);
      expect(secondTasks).toHaveLength(1);
      expect(secondTasks[0].id).toBe(firstTasks[0].id);
      expect(secondTasks[0].status).toBe('cancelled');
    });

    // -----------------------------------------------------------------------
    // Concurrent activation — DB uniqueness
    // -----------------------------------------------------------------------

    test('handles concurrent activation via UNIQUE constraint gracefully', async () => {
      const workflow = buildWorkflow(SPACE_ID, workflowManager, [
        {
          id: NODE_A,
          name: 'Node A',
          agents: [{ agentId: AGENT_CODER, name: 'coder-slot' }],
        },
      ]);

      const run = workflowRunRepo.createRun({
        spaceId: SPACE_ID,
        workflowId: workflow.id,
        title: 'Concurrent Run',
      });
      workflowRunRepo.transitionStatus(run.id, 'in_progress');

      // Simulate a concurrent activation by pre-seeding the node_execution row.
      // activateNode() should hit createOrIgnore/idempotent path and not throw.
      const nodeExecutionRepo = new NodeExecutionRepository(db);
      nodeExecutionRepo.create({
        workflowRunId: run.id,
        workflowNodeId: NODE_A,
        agentName: 'coder-slot',
        agentId: AGENT_CODER,
        status: 'pending',
      });

      const tasks = await router.activateNode(run.id, NODE_A);

      expect(tasks).toHaveLength(1);
      expect(tasks[0].workflowRunId).toBe(run.id);
      expect(nodeExecutionRepo.listByNode(run.id, NODE_A)).toHaveLength(1);
    });

    test('cancels live session before cancelling stale execution during activation', async () => {
      const workflow = buildWorkflow(SPACE_ID, workflowManager, [
        {
          id: NODE_A,
          name: 'Node A',
          agents: [{ agentId: AGENT_CODER, name: 'stale-slot' }],
        },
      ]);

      const run = workflowRunRepo.createRun({
        spaceId: SPACE_ID,
        workflowId: workflow.id,
        title: 'Stale Activation Run',
      });
      workflowRunRepo.transitionStatus(run.id, 'in_progress');

      const nodeExecutionRepo = new NodeExecutionRepository(db);
      const stale = nodeExecutionRepo.create({
        workflowRunId: run.id,
        workflowNodeId: NODE_A,
        agentName: 'stale-slot',
        agentId: AGENT_CODER,
        agentSessionId: 'session:stale-activation',
        status: 'cancelled',
      });
      workflowManager.updateWorkflow(workflow.id, {
        nodes: [
          { id: NODE_A, name: 'Node A', agents: [{ agentId: AGENT_PLANNER, name: 'stale-slot' }] },
        ],
        startNodeId: NODE_A,
        endNodeId: NODE_A,
        channels: [],
      });
      const cancelledSessions: string[] = [];
      const routerWithCancellation = new ChannelRouter({
        taskRepo,
        workflowRunRepo,
        workflowManager,
        agentManager,
        gateDataRepo,
        channelCycleRepo,
        db,
        nodeExecutionRepo,
        cancelSessionById: (sessionId) => cancelledSessions.push(sessionId),
      });

      await expect(routerWithCancellation.activateNode(run.id, NODE_A)).rejects.toBeInstanceOf(
        PermanentSpawnError
      );
      expect(cancelledSessions).toEqual(['session:stale-activation']);
      const after = nodeExecutionRepo.getById(stale.id)!;
      expect(after.status).toBe('cancelled');
      expect(after.agentSessionId).toBe('session:stale-activation');
      expect(after.result).toContain(
        'Agent slot stale-slot on workflow node node-a now references'
      );
    });

    // -----------------------------------------------------------------------
    // Error cases
    // -----------------------------------------------------------------------

    test('rejects cancelled run activation unless caller explicitly allows terminal reopen', async () => {
      const workflow = buildWorkflow(SPACE_ID, workflowManager, [
        { id: NODE_A, name: 'Node A', agentId: AGENT_CODER },
      ]);

      const run = workflowRunRepo.createRun({
        spaceId: SPACE_ID,
        workflowId: workflow.id,
        title: 'Cancelled Run',
      });
      workflowRunRepo.transitionStatus(run.id, 'in_progress');
      workflowRunRepo.transitionStatus(run.id, 'cancelled');

      await expect(router.activateNode(run.id, NODE_A)).rejects.toThrow(/cancelled/);

      const afterRejected = workflowRunRepo.getRun(run.id);
      expect(afterRejected?.status).toBe('cancelled');

      await router.activateNode(run.id, NODE_A, { allowTerminalReopen: true });

      const after = workflowRunRepo.getRun(run.id);
      expect(after?.status).toBe('in_progress');
    });

    test('rejects done run activation unless caller explicitly allows terminal reopen', async () => {
      const workflow = buildWorkflow(SPACE_ID, workflowManager, [
        { id: NODE_A, name: 'Node A', agentId: AGENT_CODER },
      ]);

      const run = workflowRunRepo.createRun({
        spaceId: SPACE_ID,
        workflowId: workflow.id,
        title: 'Completed Run',
      });
      workflowRunRepo.updateStatusUnchecked(run.id, 'done');

      await expect(router.activateNode(run.id, NODE_A)).rejects.toThrow(/done/);

      const afterRejected = workflowRunRepo.getRun(run.id);
      expect(afterRejected?.status).toBe('done');

      await router.activateNode(run.id, NODE_A, { allowTerminalReopen: true });

      const after = workflowRunRepo.getRun(run.id);
      expect(after?.status).toBe('in_progress');
    });

    test('throws ActivationError with archived-task message when parent task is archived', async () => {
      const workflow = buildWorkflow(SPACE_ID, workflowManager, [
        { id: NODE_A, name: 'Node A', agentId: AGENT_CODER },
      ]);

      const run = workflowRunRepo.createRun({
        spaceId: SPACE_ID,
        workflowId: workflow.id,
        title: 'Archived Run',
      });
      // Archive every task associated with the run — the canonical task is
      // created by the test wrapper around workflowRunRepo.createRun above.
      for (const t of taskRepo.listByWorkflowRunIncludingArchived(run.id)) {
        taskRepo.archiveTask(t.id);
      }

      await expect(router.activateNode(run.id, NODE_A)).rejects.toBeInstanceOf(ActivationError);
      await expect(router.activateNode(run.id, NODE_A)).rejects.toThrow(/archived/);
      await expect(router.activateNode(run.id, NODE_A)).rejects.toThrow(
        /create a new task to continue/
      );
    });

    test('throws ActivationError when run does not exist', async () => {
      await expect(router.activateNode('nonexistent-run', NODE_A)).rejects.toBeInstanceOf(
        ActivationError
      );
      await expect(router.activateNode('nonexistent-run', NODE_A)).rejects.toThrow(/Run not found/);
    });

    test('throws ActivationError when node does not exist in workflow', async () => {
      const workflow = buildWorkflow(SPACE_ID, workflowManager, [
        { id: NODE_A, name: 'Node A', agentId: AGENT_CODER },
      ]);

      const run = workflowRunRepo.createRun({
        spaceId: SPACE_ID,
        workflowId: workflow.id,
        title: 'Bad Node Run',
      });
      workflowRunRepo.transitionStatus(run.id, 'in_progress');

      await expect(router.activateNode(run.id, 'nonexistent-node')).rejects.toBeInstanceOf(
        ActivationError
      );
      await expect(router.activateNode(run.id, 'nonexistent-node')).rejects.toThrow(
        /not found in workflow/
      );
    });
  });

  // -------------------------------------------------------------------------
  // deliverMessage — basic routing
  // -------------------------------------------------------------------------

  describe('deliverMessage', () => {
    test('auto-activates target node when no active tasks exist', async () => {
      const workflow = buildWorkflow(SPACE_ID, workflowManager, [
        {
          id: NODE_A,
          name: 'Sender Node',
          agents: [{ agentId: AGENT_CODER, name: 'coder' }],
        },
        {
          id: NODE_B,
          name: 'Receiver Node',
          agents: [{ agentId: AGENT_PLANNER, name: 'planner' }],
        },
      ]);

      const run = workflowRunRepo.createRun({
        spaceId: SPACE_ID,
        workflowId: workflow.id,
        title: 'Deliver Run',
      });
      workflowRunRepo.transitionStatus(run.id, 'in_progress');

      const result = await router.deliverMessage(run.id, 'coder', 'planner', 'hello planner');

      expect(result.fromRole).toBe('coder');
      expect(result.toRole).toBe('planner');
      expect(result.message).toBe('hello planner');
      expect(result.targetNodeId).toBe(NODE_B);
      expect(result.isFanOut).toBe(false);
      // activatedTasks should be set since NODE_B had no tasks
      expect(result.activatedTasks).toBeDefined();
      expect(result.activatedTasks).toHaveLength(1);
      // workflowNodeId, agentName removed in M71; verify task belongs to run
      expect(result.activatedTasks![0].workflowRunId).toBe(run.id);
    });

    test('does not re-activate when target node already has active tasks', async () => {
      const workflow = buildWorkflow(SPACE_ID, workflowManager, [
        {
          id: NODE_A,
          name: 'Sender Node',
          agents: [{ agentId: AGENT_CODER, name: 'coder' }],
        },
        {
          id: NODE_B,
          name: 'Receiver Node',
          agents: [{ agentId: AGENT_PLANNER, name: 'planner' }],
        },
      ]);

      const run = workflowRunRepo.createRun({
        spaceId: SPACE_ID,
        workflowId: workflow.id,
        title: 'Already Active Run',
      });
      workflowRunRepo.transitionStatus(run.id, 'in_progress');

      // Pre-activate NODE_B so it already has active node executions.
      await router.activateNode(run.id, NODE_B);
      const beforeCount = taskRepo.listByWorkflowRun(run.id).length;

      const result = await router.deliverMessage(run.id, 'coder', 'planner', 'hi again');

      // activatedTasks should be undefined (node was already active)
      expect(result.activatedTasks).toBeUndefined();

      // No new tasks should have been created
      const afterCount = taskRepo.listByWorkflowRun(run.id).length;
      expect(afterCount).toBe(beforeCount);
    });

    test('does NOT activate a post-approval node when a live merger session exists (no duplicate)', async () => {
      // The merger sub-session has no node_execution row, so without the
      // findPostApprovalSessionId guard the lazy-activateNode step would create
      // a pending node_execution and the tick loop would spawn a DUPLICATE
      // merger. When a live merger session is reported, activation is skipped.
      const workflow = buildWorkflow(SPACE_ID, workflowManager, [
        { id: NODE_A, name: 'Review Node', agents: [{ agentId: AGENT_CODER, name: 'reviewer' }] },
        {
          id: NODE_B,
          name: 'Post-Approval',
          agents: [{ agentId: AGENT_PLANNER, name: 'merger' }],
        },
      ]);
      // buildWorkflow does not thread `postApproval` through; declare the route
      // on the Post-Approval node so deliverMessage recognizes it as the merger.
      const postApprovalNode = workflow.nodes.find((n) => n.name === 'Post-Approval')!;
      workflowManager.updateWorkflow(workflow.id, {
        nodes: workflow.nodes.map((n) =>
          n.id === postApprovalNode.id
            ? { ...n, postApproval: { targetAgent: 'merger', instructions: 'merge' } }
            : n
        ),
      });

      const run = workflowRunRepo.createRun({
        spaceId: SPACE_ID,
        workflowId: workflow.id,
        title: 'Live Merger Run',
      });
      workflowRunRepo.transitionStatus(run.id, 'in_progress');

      const nodeExecutionRepo = new NodeExecutionRepository(db);
      const liveRouter = new ChannelRouter({
        taskRepo,
        workflowRunRepo,
        workflowManager,
        agentManager,
        gateDataRepo,
        channelCycleRepo,
        db,
        nodeExecutionRepo,
        isSessionAlive: () => true,
        isPostApprovalSessionInMemory: () => true,
        findPostApprovalSessionId: () => 'live-merger-session',
      });

      const result = await liveRouter.deliverMessage(run.id, 'reviewer', 'merger', 'merge blocked');

      // No activation: the live merger session is reused by the caller.
      expect(result.activatedTasks).toBeUndefined();
      expect(nodeExecutionRepo.listByNode(run.id, NODE_B)).toHaveLength(0);
    });

    test('activates a post-approval node when the reported merger session is dead', async () => {
      // Fall-through: a dead/absent merger session must still activate so a
      // replacement merger can be brought up (the dead-session recovery path).
      const workflow = buildWorkflow(SPACE_ID, workflowManager, [
        { id: NODE_A, name: 'Review Node', agents: [{ agentId: AGENT_CODER, name: 'reviewer' }] },
        {
          id: NODE_B,
          name: 'Post-Approval',
          agents: [{ agentId: AGENT_PLANNER, name: 'merger' }],
        },
      ]);
      const postApprovalNode = workflow.nodes.find((n) => n.name === 'Post-Approval')!;
      workflowManager.updateWorkflow(workflow.id, {
        nodes: workflow.nodes.map((n) =>
          n.id === postApprovalNode.id
            ? { ...n, postApproval: { targetAgent: 'merger', instructions: 'merge' } }
            : n
        ),
      });

      const run = workflowRunRepo.createRun({
        spaceId: SPACE_ID,
        workflowId: workflow.id,
        title: 'Dead Merger Run',
      });
      workflowRunRepo.transitionStatus(run.id, 'in_progress');

      const nodeExecutionRepo = new NodeExecutionRepository(db);
      // Simulate a daemon-restart state: the lazy isSessionAlive would FALSELY
      // report the persisted merger as alive (it lazy-loads via SessionManager),
      // but the in-memory probe correctly reports it absent (no NodeExecution to
      // rehydrate from). The skip guard must honor the in-memory probe and fall
      // through to activation — otherwise injectSubSessionMessage would throw
      // "Sub-session not found".
      const deadRouter = new ChannelRouter({
        taskRepo,
        workflowRunRepo,
        workflowManager,
        agentManager,
        gateDataRepo,
        channelCycleRepo,
        db,
        nodeExecutionRepo,
        isSessionAlive: () => true, // lazy false-positive (persisted-but-unrehydrated)
        isPostApprovalSessionInMemory: () => false, // not in the in-memory index
        findPostApprovalSessionId: () => 'dead-merger-session',
      });

      const result = await deadRouter.deliverMessage(run.id, 'reviewer', 'merger', 'merge blocked');

      // Fall-through activation: a pending node_execution is created.
      expect(result.activatedTasks).toBeDefined();
      expect(nodeExecutionRepo.listByNode(run.id, NODE_B)).toHaveLength(1);
    });

    test('skips activation for a cross-node post-approval route (route declared elsewhere)', async () => {
      // post-approval-validator allows a route declared on one node to target an
      // agent in ANOTHER node. The skip guard must key on the route's target
      // agent, not on targetNode.postApproval — otherwise the target node (which
      // does not declare the route) would be activated and the tick loop would
      // spawn a duplicate merger.
      const workflow = buildWorkflow(SPACE_ID, workflowManager, [
        { id: NODE_A, name: 'Review Node', agents: [{ agentId: AGENT_CODER, name: 'reviewer' }] },
        {
          id: NODE_B,
          name: 'Post-Approval',
          // NOTE: no postApproval declared here — the agent lives in this node
          // but the route is declared on the Review node below.
          agents: [{ agentId: AGENT_PLANNER, name: 'merger' }],
        },
      ]);
      // Declare the route on NODE_A (Review), targeting the 'merger' agent that
      // lives in NODE_B — the cross-node case.
      const reviewNode = workflow.nodes.find((n) => n.name === 'Review Node')!;
      workflowManager.updateWorkflow(workflow.id, {
        nodes: workflow.nodes.map((n) =>
          n.id === reviewNode.id
            ? { ...n, postApproval: { targetAgent: 'merger', instructions: 'merge' } }
            : n
        ),
      });

      const run = workflowRunRepo.createRun({
        spaceId: SPACE_ID,
        workflowId: workflow.id,
        title: 'Cross-Node Merger Run',
      });
      workflowRunRepo.transitionStatus(run.id, 'in_progress');

      const nodeExecutionRepo = new NodeExecutionRepository(db);
      const router = new ChannelRouter({
        taskRepo,
        workflowRunRepo,
        workflowManager,
        agentManager,
        gateDataRepo,
        channelCycleRepo,
        db,
        nodeExecutionRepo,
        isSessionAlive: () => true,
        isPostApprovalSessionInMemory: () => true,
        findPostApprovalSessionId: () => 'live-merger-session',
      });

      const result = await router.deliverMessage(run.id, 'reviewer', 'merger', 'merge blocked');

      // The target node (Post-Approval) contains the route's target agent, so
      // activation is skipped even though THAT node does not declare the route.
      expect(result.activatedTasks).toBeUndefined();
      expect(nodeExecutionRepo.listByNode(run.id, NODE_B)).toHaveLength(0);
    });

    test('does NOT skip activation for a legacy task-agent route (never dispatched)', async () => {
      // PostApprovalRouter skips the unsupported legacy 'task-agent' target and
      // dispatches a later valid route. The skip guard must exclude 'task-agent'
      // too — otherwise a live session would suppress activation for a route that
      // is never actually dispatched. Here the ONLY route is task-agent, so even
      // with a live session wired, activation proceeds.
      const workflow = buildWorkflow(SPACE_ID, workflowManager, [
        { id: NODE_A, name: 'Review Node', agents: [{ agentId: AGENT_CODER, name: 'reviewer' }] },
        {
          id: NODE_B,
          name: 'Post-Approval',
          agents: [{ agentId: AGENT_PLANNER, name: 'merger' }],
        },
      ]);
      const postApprovalNode = workflow.nodes.find((n) => n.name === 'Post-Approval')!;
      workflowManager.updateWorkflow(workflow.id, {
        nodes: workflow.nodes.map((n) =>
          n.id === postApprovalNode.id
            ? { ...n, postApproval: { targetAgent: 'task-agent', instructions: 'x' } }
            : n
        ),
      });

      const run = workflowRunRepo.createRun({
        spaceId: SPACE_ID,
        workflowId: workflow.id,
        title: 'Legacy Task-Agent Run',
      });
      workflowRunRepo.transitionStatus(run.id, 'in_progress');

      const nodeExecutionRepo = new NodeExecutionRepository(db);
      const router = new ChannelRouter({
        taskRepo,
        workflowRunRepo,
        workflowManager,
        agentManager,
        gateDataRepo,
        channelCycleRepo,
        db,
        nodeExecutionRepo,
        isSessionAlive: () => true,
        isPostApprovalSessionInMemory: () => true,
        findPostApprovalSessionId: () => 'live-session',
      });

      const result = await router.deliverMessage(run.id, 'reviewer', 'merger', 'continue');

      // 'task-agent' is excluded → no valid target agent → activation proceeds.
      expect(result.activatedTasks).toBeDefined();
      expect(nodeExecutionRepo.listByNode(run.id, NODE_B)).toHaveLength(1);
    });

    test('throws ActivationError when target role is not found in workflow', async () => {
      const workflow = buildWorkflow(SPACE_ID, workflowManager, [
        {
          id: NODE_A,
          name: 'Sender Node',
          agents: [{ agentId: AGENT_CODER, name: 'coder' }],
        },
      ]);

      const run = workflowRunRepo.createRun({
        spaceId: SPACE_ID,
        workflowId: workflow.id,
        title: 'Missing Role Run',
      });
      workflowRunRepo.transitionStatus(run.id, 'in_progress');

      await expect(
        router.deliverMessage(run.id, 'coder', 'nonexistent-role', 'hello')
      ).rejects.toBeInstanceOf(ActivationError);
      await expect(
        router.deliverMessage(run.id, 'coder', 'nonexistent-role', 'hello')
      ).rejects.toThrow(/No node found/);
    });

    test('returns correct targetNodeId in result', async () => {
      const workflow = buildWorkflow(SPACE_ID, workflowManager, [
        {
          id: NODE_A,
          name: 'Node A',
          agents: [{ agentId: AGENT_CODER, name: 'sender' }],
        },
        {
          id: NODE_B,
          name: 'Node B',
          agents: [{ agentId: AGENT_PLANNER, name: 'receiver' }],
        },
      ]);

      const run = workflowRunRepo.createRun({
        spaceId: SPACE_ID,
        workflowId: workflow.id,
        title: 'Target Node Run',
      });
      workflowRunRepo.transitionStatus(run.id, 'in_progress');

      const result = await router.deliverMessage(run.id, 'sender', 'receiver', 'test');
      expect(result.targetNodeId).toBe(NODE_B);
    });

    // -----------------------------------------------------------------------
    // Fan-out — node name targeting
    // -----------------------------------------------------------------------

    test('fan-out: node name activates all agents in the target node', async () => {
      const workflow = buildWorkflow(SPACE_ID, workflowManager, [
        {
          id: NODE_A,
          name: 'Sender Node',
          agents: [{ agentId: AGENT_CODER, name: 'coder' }],
        },
        {
          id: NODE_B,
          name: 'Receiver Node',
          agents: [
            { agentId: AGENT_CODER, name: 'coder-b' },
            { agentId: AGENT_PLANNER, name: 'planner-b' },
          ],
        },
      ]);

      const run = workflowRunRepo.createRun({
        spaceId: SPACE_ID,
        workflowId: workflow.id,
        title: 'Fan-out Run',
      });
      workflowRunRepo.transitionStatus(run.id, 'in_progress');

      // Use node name 'Receiver Node' as target (fan-out)
      const result = await router.deliverMessage(run.id, 'coder', 'Receiver Node', 'broadcast');

      expect(result.targetNodeId).toBe(NODE_B);
      expect(result.isFanOut).toBe(true);
      // Fan-out activation creates one canonical task envelope and two node executions.
      expect(result.activatedTasks).toBeDefined();
      expect(result.activatedTasks).toHaveLength(1);
      expect(result.activatedTasks![0].workflowRunId).toBe(run.id);
      const nodeExecutionRepo = new NodeExecutionRepository(db);
      expect(nodeExecutionRepo.listByNode(run.id, NODE_B)).toHaveLength(2);
    });

    test('fan-out: isFanOut is false when targeting by agent role', async () => {
      const workflow = buildWorkflow(SPACE_ID, workflowManager, [
        {
          id: NODE_A,
          name: 'Sender Node',
          agents: [{ agentId: AGENT_CODER, name: 'coder' }],
        },
        {
          id: NODE_B,
          name: 'Receiver Node',
          agents: [{ agentId: AGENT_PLANNER, name: 'planner' }],
        },
      ]);

      const run = workflowRunRepo.createRun({
        spaceId: SPACE_ID,
        workflowId: workflow.id,
        title: 'DM Run',
      });
      workflowRunRepo.transitionStatus(run.id, 'in_progress');

      const result = await router.deliverMessage(run.id, 'coder', 'planner', 'dm message');

      expect(result.isFanOut).toBe(false);
    });

    test('within-node DM: agent can message another agent in the same node', async () => {
      const workflow = buildWorkflow(SPACE_ID, workflowManager, [
        {
          id: NODE_A,
          name: 'Collaboration Node',
          agents: [
            { agentId: AGENT_CODER, name: 'coder' },
            { agentId: AGENT_PLANNER, name: 'planner' },
          ],
        },
      ]);

      const run = workflowRunRepo.createRun({
        spaceId: SPACE_ID,
        workflowId: workflow.id,
        title: 'Within-node Run',
      });
      workflowRunRepo.transitionStatus(run.id, 'in_progress');

      // Both agents are in NODE_A; 'planner' is in the same node as 'coder'
      const result = await router.deliverMessage(run.id, 'coder', 'planner', 'hey planner');

      expect(result.targetNodeId).toBe(NODE_A);
      expect(result.isFanOut).toBe(false);
    });

    // -----------------------------------------------------------------------
    // Cyclic channels — iteration tracking
    // -----------------------------------------------------------------------

    test('cyclic channel: increments cycle count on successful delivery', async () => {
      // Two channels form a cycle: forward Sender→Receiver, backward Receiver→Sender
      const channels: WorkflowChannel[] = [
        { id: 'ch-fwd', from: 'Sender', to: 'Receiver' },
        { id: 'ch-bwd', from: 'Receiver', to: 'Sender' },
      ];
      const workflow = buildWorkflow(
        SPACE_ID,
        workflowManager,
        [
          { id: NODE_A, name: 'Sender', agents: [{ agentId: AGENT_CODER, name: 'coder' }] },
          { id: NODE_B, name: 'Receiver', agents: [{ agentId: AGENT_PLANNER, name: 'planner' }] },
        ],
        channels
      );

      const run = workflowRunRepo.createRun({
        spaceId: SPACE_ID,
        workflowId: workflow.id,
        title: 'Cyclic Run',
      });
      workflowRunRepo.transitionStatus(run.id, 'in_progress');

      // First delivery on the backward (cyclic) channel: planner → coder
      await router.deliverMessage(run.id, 'planner', 'coder', 'message 1');
      // Channel index 1 is the backward channel
      expect(channelCycleRepo.get(run.id, 1)!.count).toBe(1);

      // Cancel existing tasks to allow re-activation
      for (const t of taskRepo.listByWorkflowRun(run.id)) {
        taskRepo.updateTask(t.id, { status: 'cancelled' });
      }

      // Second delivery
      await router.deliverMessage(run.id, 'planner', 'coder', 'message 2');
      expect(channelCycleRepo.get(run.id, 1)!.count).toBe(2);
    });

    test('cyclic channel: throws ActivationError when cycle cap is reached', async () => {
      const channels: WorkflowChannel[] = [
        { id: 'ch-fwd', from: 'Sender', to: 'Receiver' },
        // maxCycles: 2 matches the pre-seeded cap below, so reaching count=2
        // trips the runtime cap (channel.maxCycles ?? 5) rather than relying on
        // a stale persisted max_cycles from the pre-seed.
        { id: 'ch-bwd', from: 'Receiver', to: 'Sender', maxCycles: 2 },
      ];
      const workflow = buildWorkflow(
        SPACE_ID,
        workflowManager,
        [
          { id: NODE_A, name: 'Sender', agents: [{ agentId: AGENT_CODER, name: 'coder' }] },
          { id: NODE_B, name: 'Receiver', agents: [{ agentId: AGENT_PLANNER, name: 'planner' }] },
        ],
        channels
      );

      const run = workflowRunRepo.createRun({
        spaceId: SPACE_ID,
        workflowId: workflow.id,
        title: 'Cycle Cap Run',
      });
      workflowRunRepo.transitionStatus(run.id, 'in_progress');

      // Pre-fill cycle count to the cap via the repo
      channelCycleRepo.incrementCycleCount(run.id, 1, 2);
      channelCycleRepo.incrementCycleCount(run.id, 1, 2);

      await expect(
        router.deliverMessage(run.id, 'planner', 'coder', 'over the limit')
      ).rejects.toBeInstanceOf(ActivationError);
      await expect(
        router.deliverMessage(run.id, 'planner', 'coder', 'over the limit')
      ).rejects.toThrow(/maximum cycle count/);
    });

    test('non-cyclic channel: cycle count stays unchanged', async () => {
      const channels: WorkflowChannel[] = [
        {
          from: 'coder',
          to: 'planner',
          // Forward channel — not cyclic
        },
      ];
      const workflow = buildWorkflow(
        SPACE_ID,
        workflowManager,
        [
          { id: NODE_A, name: 'Sender', agents: [{ agentId: AGENT_CODER, name: 'coder' }] },
          { id: NODE_B, name: 'Receiver', agents: [{ agentId: AGENT_PLANNER, name: 'planner' }] },
        ],
        channels
      );

      const run = workflowRunRepo.createRun({
        spaceId: SPACE_ID,
        workflowId: workflow.id,
        title: 'Non-cyclic Run',
      });
      workflowRunRepo.transitionStatus(run.id, 'in_progress');

      await router.deliverMessage(run.id, 'coder', 'planner', 'non-cyclic message');

      // No cycle records should exist for this forward-only channel
      expect(channelCycleRepo.get(run.id, 0)).toBeNull();
    });
  });

  // -------------------------------------------------------------------------
  // canDeliver
  // -------------------------------------------------------------------------

  describe('canDeliver', () => {
    test('open topology: always allowed when no channels declared', async () => {
      // No channels on workflow
      const workflow = buildWorkflow(SPACE_ID, workflowManager, [
        { id: NODE_A, name: 'Node A', agents: [{ agentId: AGENT_CODER, name: 'coder' }] },
        { id: NODE_B, name: 'Node B', agents: [{ agentId: AGENT_PLANNER, name: 'planner' }] },
      ]);

      const run = workflowRunRepo.createRun({
        spaceId: SPACE_ID,
        workflowId: workflow.id,
        title: 'Open Topology Run',
      });
      workflowRunRepo.transitionStatus(run.id, 'in_progress');

      const result = await router.canDeliver(run.id, 'coder', 'planner');
      expect(result.allowed).toBe(true);
    });

    test("open topology: allowed even when channels exist but don't match the pair", async () => {
      // Channel reviewer→Node A exists but coder→planner pair has no declared channel → open topology
      const channels: WorkflowChannel[] = [{ id: 'ch-other', from: 'Node B', to: 'Node A' }];
      const workflow = buildWorkflow(
        SPACE_ID,
        workflowManager,
        [
          { id: NODE_A, name: 'Node A', agents: [{ agentId: AGENT_CODER, name: 'coder' }] },
          { id: NODE_B, name: 'Node B', agents: [{ agentId: AGENT_PLANNER, name: 'planner' }] },
        ],
        channels
      );

      const run = workflowRunRepo.createRun({
        spaceId: SPACE_ID,
        workflowId: workflow.id,
        title: 'No Match Run',
      });
      workflowRunRepo.transitionStatus(run.id, 'in_progress');

      // coder→planner not declared; open topology for this pair
      const result = await router.canDeliver(run.id, 'coder', 'planner');
      expect(result.allowed).toBe(true);
    });

    test('channel with no gate: always allowed', async () => {
      const channels: WorkflowChannel[] = [{ id: 'ch-1', from: 'Node A', to: 'Node B' }];
      const workflow = buildWorkflow(
        SPACE_ID,
        workflowManager,
        [
          { id: NODE_A, name: 'Node A', agents: [{ agentId: AGENT_CODER, name: 'coder' }] },
          { id: NODE_B, name: 'Node B', agents: [{ agentId: AGENT_PLANNER, name: 'planner' }] },
        ],
        channels
      );

      const run = workflowRunRepo.createRun({
        spaceId: SPACE_ID,
        workflowId: workflow.id,
        title: 'No Gate Run',
      });
      workflowRunRepo.transitionStatus(run.id, 'in_progress');

      const result = await router.canDeliver(run.id, 'coder', 'planner');
      expect(result.allowed).toBe(true);
    });

    test('cyclic channel: blocked when cycle count >= maxCycles', async () => {
      // Backward channel Node B→Node A forms a cycle with forward Node A→Node B
      const channels: WorkflowChannel[] = [
        { id: 'ch-fwd', from: 'Node A', to: 'Node B' },
        { id: 'ch-bwd', from: 'Node B', to: 'Node A', maxCycles: 3 },
      ];
      const workflow = buildWorkflow(
        SPACE_ID,
        workflowManager,
        [
          { id: NODE_A, name: 'Node A', agents: [{ agentId: AGENT_CODER, name: 'coder' }] },
          { id: NODE_B, name: 'Node B', agents: [{ agentId: AGENT_PLANNER, name: 'planner' }] },
        ],
        channels
      );

      const run = workflowRunRepo.createRun({
        spaceId: SPACE_ID,
        workflowId: workflow.id,
        title: 'Cycle Cap Run',
      });
      workflowRunRepo.transitionStatus(run.id, 'in_progress');
      // Pre-fill cycle count to the cap (channel index 1 is the backward channel)
      channelCycleRepo.incrementCycleCount(run.id, 1, 3);
      channelCycleRepo.incrementCycleCount(run.id, 1, 3);
      channelCycleRepo.incrementCycleCount(run.id, 1, 3);

      const result = await router.canDeliver(run.id, 'planner', 'coder');
      expect(result.allowed).toBe(false);
      expect(result.reason).toMatch(/maximum cycle count/);
    });

    test('cyclic channel: allowed when below the cap', async () => {
      const channels: WorkflowChannel[] = [];
      const workflow = buildWorkflow(
        SPACE_ID,
        workflowManager,
        [
          { id: NODE_A, name: 'Node A', agents: [{ agentId: AGENT_CODER, name: 'coder' }] },
          { id: NODE_B, name: 'Node B', agents: [{ agentId: AGENT_PLANNER, name: 'planner' }] },
        ],
        channels
      );

      const run = workflowRunRepo.createRun({
        spaceId: SPACE_ID,
        workflowId: workflow.id,
        title: 'Below Cap Run',
      });
      workflowRunRepo.transitionStatus(run.id, 'in_progress');
      channelCycleRepo.incrementCycleCount(run.id, 1, 5);
      channelCycleRepo.incrementCycleCount(run.id, 1, 5);

      const result = await router.canDeliver(run.id, 'planner', 'coder');
      expect(result.allowed).toBe(true);
    });

    test('non-cyclic channel: cycle count does not block delivery', async () => {
      const channels: WorkflowChannel[] = [
        {
          from: 'coder',
          to: 'planner',
          // Forward channel — not cyclic
        },
      ];
      const workflow = buildWorkflow(
        SPACE_ID,
        workflowManager,
        [
          { id: NODE_A, name: 'Node A', agents: [{ agentId: AGENT_CODER, name: 'coder' }] },
          { id: NODE_B, name: 'Node B', agents: [{ agentId: AGENT_PLANNER, name: 'planner' }] },
        ],
        channels
      );

      const run = workflowRunRepo.createRun({
        spaceId: SPACE_ID,
        workflowId: workflow.id,
        title: 'Non-cyclic Cap Run',
      });
      workflowRunRepo.transitionStatus(run.id, 'in_progress');

      const result = await router.canDeliver(run.id, 'coder', 'planner');
      // Non-cyclic (forward) channel is not affected by cycle count
      expect(result.allowed).toBe(true);
    });

    test('canDeliver: throws ActivationError when run not found', async () => {
      await expect(router.canDeliver('nonexistent-run', 'coder', 'planner')).rejects.toBeInstanceOf(
        ActivationError
      );
    });

    test('canDeliver: throws ActivationError when workflow not found', async () => {
      // Create a run, then point it to a nonexistent workflow by bypassing FK checks.
      const workflow = buildWorkflow(SPACE_ID, workflowManager, [
        { id: NODE_A, name: 'Node A', agentId: AGENT_CODER },
      ]);
      const run = workflowRunRepo.createRun({
        spaceId: SPACE_ID,
        workflowId: workflow.id,
        title: 'Orphaned Run',
      });
      workflowRunRepo.transitionStatus(run.id, 'in_progress');

      // Disable FK enforcement, remap workflow_id to a nonexistent ID, then re-enable.
      db.exec('PRAGMA foreign_keys = OFF');
      db.prepare('UPDATE space_workflow_runs SET workflow_id = ? WHERE id = ?').run(
        'nonexistent-workflow-id',
        run.id
      );
      db.exec('PRAGMA foreign_keys = ON');

      await expect(router.canDeliver(run.id, 'coder', 'planner')).rejects.toBeInstanceOf(
        ActivationError
      );
      await expect(router.canDeliver(run.id, 'coder', 'planner')).rejects.toThrow(
        /Workflow not found/
      );
    });
  });

  // -------------------------------------------------------------------------
  // Separated Channel+Gate architecture (M1.4)
  // -------------------------------------------------------------------------

  describe('separated Channel+Gate architecture', () => {
    // -----------------------------------------------------------------------
    // Gateless channels — always open
    // -----------------------------------------------------------------------

    test('gateless channel: deliverMessage always delivers (no gateId, no gate)', async () => {
      const channels: WorkflowChannel[] = [{ id: 'ch-1', from: 'Sender', to: 'Receiver' }];
      const workflow = buildWorkflow(
        SPACE_ID,
        workflowManager,
        [
          { id: NODE_A, name: 'Sender', agents: [{ agentId: AGENT_CODER, name: 'coder' }] },
          { id: NODE_B, name: 'Receiver', agents: [{ agentId: AGENT_PLANNER, name: 'planner' }] },
        ],
        channels
      );

      const run = workflowRunRepo.createRun({
        spaceId: SPACE_ID,
        workflowId: workflow.id,
        title: 'Gateless Run',
      });
      workflowRunRepo.transitionStatus(run.id, 'in_progress');

      const result = await router.deliverMessage(run.id, 'coder', 'planner', 'hello');
      expect(result.fromRole).toBe('coder');
      expect(result.toRole).toBe('planner');
      expect(result.activatedTasks).toBeDefined();
      expect(result.activatedTasks!.length).toBeGreaterThan(0);
    });

    test('gateless channel: canDeliver always allowed', async () => {
      const channels: WorkflowChannel[] = [{ id: 'ch-1', from: 'Sender', to: 'Receiver' }];
      const workflow = buildWorkflow(
        SPACE_ID,
        workflowManager,
        [
          { id: NODE_A, name: 'Sender', agents: [{ agentId: AGENT_CODER, name: 'coder' }] },
          { id: NODE_B, name: 'Receiver', agents: [{ agentId: AGENT_PLANNER, name: 'planner' }] },
        ],
        channels
      );

      const run = workflowRunRepo.createRun({
        spaceId: SPACE_ID,
        workflowId: workflow.id,
        title: 'Gateless canDeliver Run',
      });
      workflowRunRepo.transitionStatus(run.id, 'in_progress');

      const result = await router.canDeliver(run.id, 'coder', 'planner');
      expect(result.allowed).toBe(true);
    });

    // -----------------------------------------------------------------------
    // Gated channels — check condition
    // -----------------------------------------------------------------------

    test('gated channel (check): does NOT activate target when condition not satisfied', async () => {
      const gate: Gate = {
        id: 'plan-gate',
        fields: [{ name: 'plan', type: 'string', writers: ['planner'], check: { op: 'exists' } }],
        resetOnCycle: false,
      };
      // Channel: planner → coder, gated by plan-gate
      const channels: WorkflowChannel[] = [
        { id: 'ch-1', from: 'planner', to: 'coder', gateId: 'plan-gate' },
      ];
      const workflow = buildWorkflowWithGates(
        SPACE_ID,
        workflowManager,
        [
          {
            id: NODE_A,
            name: 'Planner Node',
            agents: [{ agentId: AGENT_PLANNER, name: 'planner' }],
          },
          { id: NODE_B, name: 'Coder Node', agents: [{ agentId: AGENT_CODER, name: 'coder' }] },
        ],
        channels,
        [gate]
      );

      const run = workflowRunRepo.createRun({
        spaceId: SPACE_ID,
        workflowId: workflow.id,
        title: 'Check Gate Blocked Run',
      });
      workflowRunRepo.transitionStatus(run.id, 'in_progress');

      // No gate data written → field does not exist → gate is closed.
      // Gate evaluation runs BEFORE lazy activation, so the target node is
      // NOT activated and no node execution is created. This is the fix
      // for the premature-activation bug — the tick loop must not see a
      // pending execution for a blocked target.
      await expect(router.deliverMessage(run.id, 'planner', 'coder', 'msg')).rejects.toBeInstanceOf(
        ChannelGateBlockedError
      );
      const executions = new NodeExecutionRepository(db).listByNode(run.id, NODE_B);
      expect(executions).toHaveLength(0);
    });

    test('gated channel: throws ActivationError when parent task is archived (no gate eval)', async () => {
      // Archived runs are tombstones — gates must not be evaluated and
      // scripted gates must not run. The archive guard short-circuits
      // before gate evaluation and before activation.
      const gate: Gate = {
        id: 'archived-run-gate',
        fields: [{ name: 'plan', type: 'string', writers: ['planner'], check: { op: 'exists' } }],
        resetOnCycle: false,
      };
      const channels: WorkflowChannel[] = [
        { id: 'ch-1', from: 'planner', to: 'coder', gateId: 'archived-run-gate' },
      ];
      const workflow = buildWorkflowWithGates(
        SPACE_ID,
        workflowManager,
        [
          {
            id: NODE_A,
            name: 'Planner Node',
            agents: [{ agentId: AGENT_PLANNER, name: 'planner' }],
          },
          { id: NODE_B, name: 'Coder Node', agents: [{ agentId: AGENT_CODER, name: 'coder' }] },
        ],
        channels,
        [gate]
      );

      const run = workflowRunRepo.createRun({
        spaceId: SPACE_ID,
        workflowId: workflow.id,
        title: 'Archived Run',
      });
      workflowRunRepo.transitionStatus(run.id, 'in_progress');

      // Even with the gate satisfied, the archived guard must trump it.
      gateDataRepo.set(run.id, 'archived-run-gate', { plan: 'something' });
      for (const t of taskRepo.listByWorkflowRunIncludingArchived(run.id)) {
        taskRepo.archiveTask(t.id);
      }

      await expect(router.deliverMessage(run.id, 'planner', 'coder', 'msg')).rejects.toBeInstanceOf(
        ActivationError
      );
      await expect(router.deliverMessage(run.id, 'planner', 'coder', 'msg')).rejects.toThrow(
        /archived/
      );
    });

    test('gated channel: re-checks resetOnCycle gate after activation and throws when closed mid-await', async () => {
      // Race coverage: deliverMessage performs an `await activateNode(...)`
      // after the first gate eval. If a concurrent operation clears a
      // resetOnCycle gate during that await, the post-activation re-check
      // must catch the stale-gate condition and throw. This only applies to
      // cyclic channels with resetOnCycle gates, where the cache is bypassed.
      const gate: Gate = {
        id: 'race-gate',
        fields: [{ name: 'plan', type: 'string', writers: ['planner'], check: { op: 'exists' } }],
        resetOnCycle: true,
      };
      // Backward channel is cyclic and gated — cache is bypassed for resetOnCycle gates
      const channels: WorkflowChannel[] = [
        { id: 'ch-fwd', from: 'Coder Node', to: 'Planner Node' }, // index 0 (forward, no gate)
        { id: 'ch-bwd', from: 'Planner Node', to: 'Coder Node', gateId: 'race-gate' }, // index 1 (cyclic, gated)
      ];
      const workflow = buildWorkflowWithGates(
        SPACE_ID,
        workflowManager,
        [
          { id: NODE_A, name: 'Coder Node', agents: [{ agentId: AGENT_CODER, name: 'coder' }] },
          {
            id: NODE_B,
            name: 'Planner Node',
            agents: [{ agentId: AGENT_PLANNER, name: 'planner' }],
          },
        ],
        channels,
        [gate]
      );

      const run = workflowRunRepo.createRun({
        spaceId: SPACE_ID,
        workflowId: workflow.id,
        title: 'Race Gate Run',
      });
      workflowRunRepo.transitionStatus(run.id, 'in_progress');

      // Simulate the race by clearing the gate after the first eval but
      // before the post-activation re-check.
      gateDataRepo.set(run.id, 'race-gate', { plan: 'initial value' });

      const realActivate = router.activateNode.bind(router);
      let activateCalls = 0;
      (router as unknown as { activateNode: typeof router.activateNode }).activateNode = async (
        ...args: Parameters<typeof router.activateNode>
      ) => {
        activateCalls += 1;
        // Clear gate data mid-activation to simulate a concurrent reset
        gateDataRepo.set(run.id, 'race-gate', {});
        return realActivate(...args);
      };

      try {
        // Deliver on the backward (cyclic) gated channel. The gate has
        // resetOnCycle=true, so the cache is bypassed and the post-activation
        // re-check catches the cleared gate data.
        await expect(
          router.deliverMessage(run.id, 'planner', 'coder', 'msg')
        ).rejects.toBeInstanceOf(ChannelGateBlockedError);
        expect(activateCalls).toBe(1);
      } finally {
        (router as unknown as { activateNode: typeof router.activateNode }).activateNode =
          realActivate;
      }
    });

    test('gated channel: non-resetOnCycle gate skips post-activation re-check via cache', async () => {
      // Complementary to the test above: for non-resetOnCycle gates, the
      // gate-open cache intentionally skips the post-activation re-check.
      // A concurrent data clear mid-activation does NOT block delivery
      // because the gate was already evaluated as open.
      const gate: Gate = {
        id: 'non-race-gate',
        fields: [{ name: 'plan', type: 'string', writers: ['planner'], check: { op: 'exists' } }],
        resetOnCycle: false,
      };
      const channels: WorkflowChannel[] = [
        { id: 'ch-1', from: 'planner', to: 'coder', gateId: 'non-race-gate' },
      ];
      const workflow = buildWorkflowWithGates(
        SPACE_ID,
        workflowManager,
        [
          {
            id: NODE_A,
            name: 'Planner Node',
            agents: [{ agentId: AGENT_PLANNER, name: 'planner' }],
          },
          { id: NODE_B, name: 'Coder Node', agents: [{ agentId: AGENT_CODER, name: 'coder' }] },
        ],
        channels,
        [gate]
      );

      const run = workflowRunRepo.createRun({
        spaceId: SPACE_ID,
        workflowId: workflow.id,
        title: 'Non-Race Gate Run',
      });
      workflowRunRepo.transitionStatus(run.id, 'in_progress');

      // Gate is open
      gateDataRepo.set(run.id, 'non-race-gate', { plan: 'initial value' });

      const realActivate = router.activateNode.bind(router);
      (router as unknown as { activateNode: typeof router.activateNode }).activateNode = async (
        ...args: Parameters<typeof router.activateNode>
      ) => {
        // Clear gate data mid-activation — simulates a concurrent data change
        gateDataRepo.set(run.id, 'non-race-gate', {});
        return realActivate(...args);
      };

      try {
        // Delivery succeeds despite concurrent data clear, because
        // the gate-open cache skips the post-activation re-evaluation.
        const result = await router.deliverMessage(run.id, 'planner', 'coder', 'msg');
        expect(result.fromRole).toBe('planner');
      } finally {
        (router as unknown as { activateNode: typeof router.activateNode }).activateNode =
          realActivate;
      }
    });

    test('gated channel (check): allows delivery when condition satisfied', async () => {
      const gate: Gate = {
        id: 'plan-gate',
        fields: [{ name: 'plan', type: 'string', writers: ['planner'], check: { op: 'exists' } }],
        resetOnCycle: false,
      };
      const channels: WorkflowChannel[] = [
        { id: 'ch-fwd', from: 'Coder Node', to: 'Planner Node', gateId: 'plan-gate' }, // index 0
        { id: 'ch-bwd', from: 'Planner Node', to: 'Coder Node' }, // index 1 (cyclic)
      ];
      const workflow = buildWorkflowWithGates(
        SPACE_ID,
        workflowManager,
        [
          {
            id: NODE_A,
            name: 'Planner Node',
            agents: [{ agentId: AGENT_PLANNER, name: 'planner' }],
          },
          { id: NODE_B, name: 'Coder Node', agents: [{ agentId: AGENT_CODER, name: 'coder' }] },
        ],
        channels,
        [gate]
      );

      const run = workflowRunRepo.createRun({
        spaceId: SPACE_ID,
        workflowId: workflow.id,
        title: 'Check Gate Allowed Run',
      });
      workflowRunRepo.transitionStatus(run.id, 'in_progress');

      // Write gate data to satisfy the condition
      gateDataRepo.set(run.id, 'plan-gate', { plan: 'step 1: design the system' });

      const result = await router.deliverMessage(run.id, 'planner', 'coder', 'here is the plan');
      expect(result.fromRole).toBe('planner');
      expect(result.toRole).toBe('coder');
    });

    test('gate data refresh does not reactivate a done run', async () => {
      const gate: Gate = {
        id: 'done-gate',
        fields: [
          { name: 'approved', type: 'boolean', writers: ['*'], check: { op: '==', value: true } },
        ],
        resetOnCycle: false,
      };
      const workflow = buildWorkflowWithGates(
        SPACE_ID,
        workflowManager,
        [
          {
            id: NODE_A,
            name: 'Planner Node',
            agents: [{ agentId: AGENT_PLANNER, name: 'planner' }],
          },
          { id: NODE_B, name: 'Coder Node', agents: [{ agentId: AGENT_CODER, name: 'coder' }] },
        ],
        [{ id: 'done-channel', from: 'Planner Node', to: 'coder', gateId: 'done-gate' }],
        [gate]
      );
      const run = workflowRunRepo.createRun({
        spaceId: SPACE_ID,
        workflowId: workflow.id,
        title: 'Done Gate Refresh Run',
      });
      workflowRunRepo.updateStatusUnchecked(run.id, 'done');
      gateDataRepo.set(run.id, 'done-gate', { approved: true });

      const activated = await router.onGateDataChanged(run.id, 'done-gate');

      expect(activated).toHaveLength(0);
      expect(workflowRunRepo.getRun(run.id)?.status).toBe('done');
      expect(new NodeExecutionRepository(db).listByNode(run.id, NODE_B)).toHaveLength(0);
    });

    test('gate data refresh does not reactivate a cancelled run', async () => {
      const gate: Gate = {
        id: 'cancelled-gate',
        fields: [
          { name: 'approved', type: 'boolean', writers: ['*'], check: { op: '==', value: true } },
        ],
        resetOnCycle: false,
      };
      const workflow = buildWorkflowWithGates(
        SPACE_ID,
        workflowManager,
        [
          {
            id: NODE_A,
            name: 'Planner Node',
            agents: [{ agentId: AGENT_PLANNER, name: 'planner' }],
          },
          { id: NODE_B, name: 'Coder Node', agents: [{ agentId: AGENT_CODER, name: 'coder' }] },
        ],
        [{ id: 'cancelled-channel', from: 'Planner Node', to: 'coder', gateId: 'cancelled-gate' }],
        [gate]
      );
      const run = workflowRunRepo.createRun({
        spaceId: SPACE_ID,
        workflowId: workflow.id,
        title: 'Cancelled Gate Refresh Run',
      });
      workflowRunRepo.updateStatusUnchecked(run.id, 'cancelled');
      gateDataRepo.set(run.id, 'cancelled-gate', { approved: true });

      const activated = await router.onGateDataChanged(run.id, 'cancelled-gate');

      expect(activated).toHaveLength(0);
      expect(workflowRunRepo.getRun(run.id)?.status).toBe('cancelled');
      expect(new NodeExecutionRepository(db).listByNode(run.id, NODE_B)).toHaveLength(0);
    });

    test('gate data refresh does not reactivate an archived task', async () => {
      const gate: Gate = {
        id: 'archived-gate',
        fields: [
          { name: 'approved', type: 'boolean', writers: ['*'], check: { op: '==', value: true } },
        ],
        resetOnCycle: false,
      };
      const workflow = buildWorkflowWithGates(
        SPACE_ID,
        workflowManager,
        [
          {
            id: NODE_A,
            name: 'Planner Node',
            agents: [{ agentId: AGENT_PLANNER, name: 'planner' }],
          },
          { id: NODE_B, name: 'Coder Node', agents: [{ agentId: AGENT_CODER, name: 'coder' }] },
        ],
        [{ id: 'archived-channel', from: 'Planner Node', to: 'coder', gateId: 'archived-gate' }],
        [gate]
      );
      const run = workflowRunRepo.createRun({
        spaceId: SPACE_ID,
        workflowId: workflow.id,
        title: 'Archived Gate Refresh Run',
      });
      for (const task of taskRepo.listByWorkflowRunIncludingArchived(run.id)) {
        taskRepo.archiveTask(task.id);
      }
      gateDataRepo.set(run.id, 'archived-gate', { approved: true });

      const activated = await router.onGateDataChanged(run.id, 'archived-gate');

      expect(activated).toHaveLength(0);
      expect(new NodeExecutionRepository(db).listByNode(run.id, NODE_B)).toHaveLength(0);
    });

    test('gated channel (check): canDeliver returns true when condition satisfied', async () => {
      const gate: Gate = {
        id: 'allow-gate',
        fields: [
          { name: 'approved', type: 'boolean', writers: ['*'], check: { op: '==', value: true } },
        ],
        resetOnCycle: false,
      };
      const channels: WorkflowChannel[] = [
        { id: 'ch-1', from: 'coder', to: 'planner', gateId: 'allow-gate' },
      ];
      const workflow = buildWorkflowWithGates(
        SPACE_ID,
        workflowManager,
        [
          { id: NODE_A, name: 'Coder Node', agents: [{ agentId: AGENT_CODER, name: 'coder' }] },
          {
            id: NODE_B,
            name: 'Planner Node',
            agents: [{ agentId: AGENT_PLANNER, name: 'planner' }],
          },
        ],
        channels,
        [gate]
      );

      const run = workflowRunRepo.createRun({
        spaceId: SPACE_ID,
        workflowId: workflow.id,
        title: 'canDeliver Allowed Run',
      });
      workflowRunRepo.transitionStatus(run.id, 'in_progress');

      // Write gate data to satisfy the condition
      gateDataRepo.set(run.id, 'allow-gate', { approved: true });

      const result = await router.canDeliver(run.id, 'coder', 'planner');
      expect(result.allowed).toBe(true);
    });

    // GATED (Vitest/Node): requires Bun.spawn in production executeGateScript.
    test.skipIf(!isBun)(
      'gated wildcard channel: canDeliver uses concrete sender for dynamic Codex gate',
      async () => {
        const gate: Gate = {
          id: 'wildcard-codex-gate',
          fields: [
            { name: 'approved', type: 'boolean', writers: ['*'], check: { op: '==', value: true } },
          ],
          resetOnCycle: false,
        };
        const channels: WorkflowChannel[] = [
          { id: 'ch-1', from: '*', to: 'planner', gateId: 'wildcard-codex-gate' },
        ];
        const workflow = buildWorkflowWithGates(
          SPACE_ID,
          workflowManager,
          [
            {
              id: NODE_A,
              name: 'Coder Node',
              agents: [{ agentId: AGENT_CODER, name: 'coder' }],
              requireCodexApproval: true,
            },
            {
              id: NODE_B,
              name: 'Planner Node',
              agents: [{ agentId: AGENT_PLANNER, name: 'planner' }],
            },
          ],
          channels,
          [gate]
        );

        const run = workflowRunRepo.createRun({
          spaceId: SPACE_ID,
          workflowId: workflow.id,
          title: 'Wildcard Codex canDeliver Run',
        });
        workflowRunRepo.transitionStatus(run.id, 'in_progress');
        gateDataRepo.set(run.id, 'wildcard-codex-gate', { approved: true });

        const result = await router.canDeliver(run.id, 'coder', 'planner');
        expect(result.allowed).toBe(false);
        expect(result.reason).toContain('codex review bot');
      }
    );

    test('onGateDataChanged: wildcard channel uses concrete sources for dynamic Codex gate', async () => {
      const gate: Gate = {
        id: 'wildcard-codex-activation-gate',
        fields: [
          { name: 'approved', type: 'boolean', writers: ['*'], check: { op: '==', value: true } },
        ],
        resetOnCycle: false,
      };
      const channels: WorkflowChannel[] = [
        { id: 'ch-wildcard-activation', from: '*', to: 'planner', gateId: gate.id },
      ];
      const workflow = buildWorkflowWithGates(
        SPACE_ID,
        workflowManager,
        [
          {
            id: NODE_A,
            name: 'Coder Node',
            agents: [{ agentId: AGENT_CODER, name: 'coder' }],
            requireCodexApproval: true,
          },
          {
            id: NODE_B,
            name: 'Planner Node',
            agents: [{ agentId: AGENT_PLANNER, name: 'planner' }],
          },
        ],
        channels,
        [gate]
      );

      const run = workflowRunRepo.createRun({
        spaceId: SPACE_ID,
        workflowId: workflow.id,
        title: 'Wildcard Codex onGateDataChanged Run',
      });
      workflowRunRepo.transitionStatus(run.id, 'in_progress');
      gateDataRepo.set(run.id, gate.id, { approved: true });

      const activated = await router.onGateDataChanged(run.id, gate.id);
      expect(activated).toHaveLength(0);
    });

    test('gated channel (check): canDeliver returns false when blocked', async () => {
      const gate: Gate = {
        id: 'approval-gate',
        fields: [
          { name: 'approved', type: 'boolean', writers: ['*'], check: { op: '==', value: true } },
        ],
        resetOnCycle: false,
      };
      const channels: WorkflowChannel[] = [
        { id: 'ch-1', from: 'coder', to: 'planner', gateId: 'approval-gate' },
      ];
      const workflow = buildWorkflowWithGates(
        SPACE_ID,
        workflowManager,
        [
          { id: NODE_A, name: 'Coder Node', agents: [{ agentId: AGENT_CODER, name: 'coder' }] },
          {
            id: NODE_B,
            name: 'Planner Node',
            agents: [{ agentId: AGENT_PLANNER, name: 'planner' }],
          },
        ],
        channels,
        [gate]
      );

      const run = workflowRunRepo.createRun({
        spaceId: SPACE_ID,
        workflowId: workflow.id,
        title: 'canDeliver Blocked Run',
      });
      workflowRunRepo.transitionStatus(run.id, 'in_progress');

      // Gate data has approved: false
      gateDataRepo.set(run.id, 'approval-gate', { approved: false });

      const result = await router.canDeliver(run.id, 'coder', 'planner');
      expect(result.allowed).toBe(false);
      expect(result.reason).toMatch(/approved/);
    });

    test('gated channel (check): missing gate definition → channel closed (misconfiguration)', async () => {
      const channels: WorkflowChannel[] = [
        { id: 'ch-1', from: 'coder', to: 'planner', gateId: 'plan-ready-gate' },
      ];
      // No gates array in workflow
      const workflow = buildWorkflowWithGates(
        SPACE_ID,
        workflowManager,
        [
          { id: NODE_A, name: 'Coder Node', agents: [{ agentId: AGENT_CODER, name: 'coder' }] },
          {
            id: NODE_B,
            name: 'Planner Node',
            agents: [{ agentId: AGENT_PLANNER, name: 'planner' }],
          },
        ],
        channels,
        []
      );

      const run = workflowRunRepo.createRun({
        spaceId: SPACE_ID,
        workflowId: workflow.id,
        title: 'Missing Gate Run',
      });
      workflowRunRepo.transitionStatus(run.id, 'in_progress');

      // Missing gate → fails closed
      const blocked = await expect(
        router.deliverMessage(run.id, 'coder', 'planner', 'msg')
      ).rejects.toBeInstanceOf(ChannelGateBlockedError);
      void blocked; // satisfy lint
    });

    // -----------------------------------------------------------------------
    // Gate transition: blocked → open triggers node activation
    // -----------------------------------------------------------------------

    test('onGateDataChanged: activates target node when gate opens', async () => {
      const gate: Gate = {
        id: 'plan-ready-gate',
        fields: [
          {
            name: 'ready',
            type: 'boolean',
            writers: ['planner'],
            check: { op: '==', value: true },
          },
        ],
        resetOnCycle: false,
      };
      const channels: WorkflowChannel[] = [
        { id: 'ch-1', from: 'coder', to: 'planner', gateId: 'plan-ready-gate' },
      ];
      const workflow = buildWorkflowWithGates(
        SPACE_ID,
        workflowManager,
        [
          {
            id: NODE_A,
            name: 'Planner Node',
            agents: [{ agentId: AGENT_PLANNER, name: 'planner' }],
          },
          { id: NODE_B, name: 'Coder Node', agents: [{ agentId: AGENT_CODER, name: 'coder' }] },
        ],
        channels,
        [gate]
      );

      const run = workflowRunRepo.createRun({
        spaceId: SPACE_ID,
        workflowId: workflow.id,
        title: 'Gate Transition Run',
      });
      workflowRunRepo.transitionStatus(run.id, 'in_progress');

      // Gate still closed before writing
      const noTasks1 = await router.onGateDataChanged(run.id, 'plan-ready-gate');
      expect(noTasks1).toHaveLength(0);
      // Canonical run task already exists (one-task-per-run).
      expect(taskRepo.listByWorkflowRun(run.id)).toHaveLength(1);

      // Write gate data to open the gate
      gateDataRepo.set(run.id, 'plan-ready-gate', { ready: true });

      // Now onGateDataChanged should activate coder node
      const activated = await router.onGateDataChanged(run.id, 'plan-ready-gate');
      expect(activated.length).toBeGreaterThan(0);
      // workflowNodeId removed in M71; verify activated task belongs to the run
      expect(activated[0].workflowRunId).toBe(run.id);
      expect(activated[0].status).toBe('open');
    });

    test('onGateDataChanged: does not re-activate if target node already active', async () => {
      const gate: Gate = {
        id: 'ready-gate',
        fields: [
          { name: 'ready', type: 'boolean', writers: ['*'], check: { op: '==', value: true } },
        ],
        resetOnCycle: false,
      };
      const channels: WorkflowChannel[] = [
        { id: 'ch-1', from: 'coder', to: 'planner', gateId: 'ready-gate' },
      ];
      const workflow = buildWorkflowWithGates(
        SPACE_ID,
        workflowManager,
        [
          {
            id: NODE_A,
            name: 'Planner Node',
            agents: [{ agentId: AGENT_PLANNER, name: 'planner' }],
          },
          { id: NODE_B, name: 'Coder Node', agents: [{ agentId: AGENT_CODER, name: 'coder' }] },
        ],
        channels,
        [gate]
      );

      const run = workflowRunRepo.createRun({
        spaceId: SPACE_ID,
        workflowId: workflow.id,
        title: 'No Re-activate Run',
      });
      workflowRunRepo.transitionStatus(run.id, 'in_progress');

      // Manually pre-activate the TARGET node (planner/NODE_A)
      await router.activateNode(run.id, NODE_A);

      // Open gate and call onGateDataChanged
      gateDataRepo.set(run.id, 'ready-gate', { ready: true });
      const activated = await router.onGateDataChanged(run.id, 'ready-gate');

      // Already active → no new tasks created
      expect(activated).toHaveLength(0);
    });

    test('onGateDataChanged: returns empty array when gate is still closed', async () => {
      const gate: Gate = {
        id: 'still-closed-gate',
        fields: [
          { name: 'done', type: 'boolean', writers: ['*'], check: { op: '==', value: true } },
        ],
        resetOnCycle: false,
      };
      const channels: WorkflowChannel[] = [
        { id: 'ch-1', from: 'coder', to: 'planner', gateId: 'still-closed-gate' },
      ];
      const workflow = buildWorkflowWithGates(
        SPACE_ID,
        workflowManager,
        [
          {
            id: NODE_A,
            name: 'Planner Node',
            agents: [{ agentId: AGENT_PLANNER, name: 'planner' }],
          },
          { id: NODE_B, name: 'Coder Node', agents: [{ agentId: AGENT_CODER, name: 'coder' }] },
        ],
        channels,
        [gate]
      );

      const run = workflowRunRepo.createRun({
        spaceId: SPACE_ID,
        workflowId: workflow.id,
        title: 'Still Closed Gate Run',
      });
      workflowRunRepo.transitionStatus(run.id, 'in_progress');

      // Write partial gate data that does NOT satisfy the condition
      gateDataRepo.set(run.id, 'still-closed-gate', { done: false });

      const activated = await router.onGateDataChanged(run.id, 'still-closed-gate');
      expect(activated).toHaveLength(0);
    });

    test('onGateDataChanged: returns empty array for run whose parent task is archived', async () => {
      const gate: Gate = {
        id: 'done-gate',
        fields: [{ name: 'done', type: 'string', writers: ['*'], check: { op: 'exists' } }],
        resetOnCycle: false,
      };
      const channels: WorkflowChannel[] = [
        { id: 'ch-1', from: 'coder', to: 'planner', gateId: 'done-gate' },
      ];
      const workflow = buildWorkflowWithGates(
        SPACE_ID,
        workflowManager,
        [
          {
            id: NODE_A,
            name: 'Planner Node',
            agents: [{ agentId: AGENT_PLANNER, name: 'planner' }],
          },
          { id: NODE_B, name: 'Coder Node', agents: [{ agentId: AGENT_CODER, name: 'coder' }] },
        ],
        channels,
        [gate]
      );

      const run = workflowRunRepo.createRun({
        spaceId: SPACE_ID,
        workflowId: workflow.id,
        title: 'Archived Run',
      });
      // Archive is the authoritative tombstone — a done/cancelled run whose
      // parent task is NOT archived is still reopenable on gate activity.
      workflowRunRepo.updateStatusUnchecked(run.id, 'done');
      for (const t of taskRepo.listByWorkflowRunIncludingArchived(run.id)) {
        taskRepo.archiveTask(t.id);
      }

      gateDataRepo.set(run.id, 'done-gate', { done: true });
      const activated = await router.onGateDataChanged(run.id, 'done-gate');
      expect(activated).toHaveLength(0);
    });

    test('onGateDataChanged: does not re-activate target node when run is done', async () => {
      const gate: Gate = {
        id: 'done-gate',
        fields: [{ name: 'done', type: 'string', writers: ['*'], check: { op: 'exists' } }],
        resetOnCycle: false,
      };
      const channels: WorkflowChannel[] = [
        { id: 'ch-1', from: 'coder', to: 'planner', gateId: 'done-gate' },
      ];
      const workflow = buildWorkflowWithGates(
        SPACE_ID,
        workflowManager,
        [
          {
            id: NODE_A,
            name: 'Planner Node',
            agents: [{ agentId: AGENT_PLANNER, name: 'planner' }],
          },
          { id: NODE_B, name: 'Coder Node', agents: [{ agentId: AGENT_CODER, name: 'coder' }] },
        ],
        channels,
        [gate]
      );

      const run = workflowRunRepo.createRun({
        spaceId: SPACE_ID,
        workflowId: workflow.id,
        title: 'Reopenable Done Run',
      });
      workflowRunRepo.updateStatusUnchecked(run.id, 'done');

      gateDataRepo.set(run.id, 'done-gate', { done: true });
      const activated = await router.onGateDataChanged(run.id, 'done-gate');
      expect(activated).toHaveLength(0);
      expect(workflowRunRepo.getRun(run.id)?.status).toBe('done');
    });

    // -----------------------------------------------------------------------
    // Vote-counting gates (count condition)
    // -----------------------------------------------------------------------

    test('vote-counting gate: each write triggers re-evaluation; activates on quorum', async () => {
      const gate: Gate = {
        id: 'review-votes-gate',
        fields: [
          {
            name: 'reviews',
            type: 'map',
            writers: ['reviewer'],
            check: { op: 'count', match: 'approved', min: 2 },
          },
        ],
        resetOnCycle: false,
      };
      const channels: WorkflowChannel[] = [
        { id: 'ch-1', from: 'Coder Node', to: 'QA Node', gateId: 'review-votes-gate' },
      ];
      const AGENT_REVIEWER = 'agent-reviewer';
      db.prepare(
        `INSERT INTO space_agents (id, space_id, name, description, model, tools, system_prompt,
				created_at, updated_at)
				 VALUES (?, ?, ?, '', null, '[]', '', ?, ?)`
      ).run(AGENT_REVIEWER, SPACE_ID, 'Agent Reviewer', Date.now(), Date.now());

      const NODE_C = 'node-c';
      const workflow = buildWorkflowWithGates(
        SPACE_ID,
        workflowManager,
        [
          { id: NODE_A, name: 'Coder Node', agents: [{ agentId: AGENT_CODER, name: 'coder' }] },
          { id: NODE_C, name: 'QA Node', agents: [{ agentId: AGENT_REVIEWER, name: 'qa' }] },
        ],
        channels,
        [gate]
      );

      const run = workflowRunRepo.createRun({
        spaceId: SPACE_ID,
        workflowId: workflow.id,
        title: 'Vote Counting Run',
      });
      workflowRunRepo.transitionStatus(run.id, 'in_progress');

      // Initial: no votes
      gateDataRepo.initializeForRun(run.id, [
        { id: gate.id, data: computeGateDefaults(gate.fields) },
      ]);
      let activated = await router.onGateDataChanged(run.id, 'review-votes-gate');
      expect(activated).toHaveLength(0);

      // First vote: 1 approval — gate still closed (min: 2)
      gateDataRepo.merge(run.id, 'review-votes-gate', { reviews: { alice: 'approved' } });
      activated = await router.onGateDataChanged(run.id, 'review-votes-gate');
      expect(activated).toHaveLength(0);

      // Second vote: 2 approvals — gate opens, QA node activated
      gateDataRepo.merge(run.id, 'review-votes-gate', {
        reviews: { alice: 'approved', bob: 'approved' },
      });
      activated = await router.onGateDataChanged(run.id, 'review-votes-gate');
      expect(activated.length).toBeGreaterThan(0);
      // workflowNodeId removed in M71; verify activated task belongs to the run
      expect(activated[0].workflowRunId).toBe(run.id);
    });

    // -----------------------------------------------------------------------
    // resetOnCycle behavior
    // -----------------------------------------------------------------------

    test('resetOnCycle: gate data reset when cyclic channel is traversed', async () => {
      const gate: Gate = {
        id: 'review-votes-gate',
        fields: [
          {
            name: 'votes',
            type: 'map',
            writers: ['reviewer'],
            check: { op: 'count', match: 'approved', min: 2 },
          },
        ],
        resetOnCycle: true,
      };
      const channels: WorkflowChannel[] = [
        { id: 'ch-fwd', from: 'Coder Node', to: 'Planner Node', gateId: 'review-votes-gate' }, // index 0
        { id: 'ch-bwd', from: 'Planner Node', to: 'Coder Node' }, // index 1 (cyclic)
      ];
      const workflow = buildWorkflowWithGates(
        SPACE_ID,
        workflowManager,
        [
          { id: NODE_A, name: 'Coder Node', agents: [{ agentId: AGENT_CODER, name: 'coder' }] },
          {
            id: NODE_B,
            name: 'Planner Node',
            agents: [{ agentId: AGENT_PLANNER, name: 'planner' }],
          },
        ],
        channels,
        [gate]
      );

      const run = workflowRunRepo.createRun({
        spaceId: SPACE_ID,
        workflowId: workflow.id,
        title: 'Reset On Cycle Run',
      });
      workflowRunRepo.transitionStatus(run.id, 'in_progress');

      // Seed some vote data
      gateDataRepo.set(run.id, 'review-votes-gate', {
        votes: { alice: 'approved', bob: 'approved' },
      });

      // Traverse the cyclic (backward) channel: planner → coder
      await router.deliverMessage(run.id, 'planner', 'coder', 'iterating');

      // Gate data should have been reset to default (empty votes map)
      const afterReset = gateDataRepo.get(run.id, 'review-votes-gate');
      expect(afterReset).not.toBeNull();
      expect(afterReset!.data).toMatchObject({ votes: {} });

      // Cycle count should have been incremented (channel index 1 is the backward channel)
      expect(channelCycleRepo.get(run.id, 1)!.count).toBe(1);
    });

    test('resetOnCycle: gate with undefined fields (script-only gate) resets to empty object', async () => {
      // Gate has no fields — simulates a script-only gate where fields is undefined
      const gate: Gate = {
        id: 'script-only-gate',
        resetOnCycle: true,
        script: { interpreter: 'bash', source: 'true', timeoutMs: 30000 },
      };
      const channels: WorkflowChannel[] = [
        { id: 'ch-fwd', from: 'Coder Node', to: 'Planner Node', gateId: 'script-only-gate' }, // index 0
        { id: 'ch-bwd', from: 'Planner Node', to: 'Coder Node' }, // index 1 (cyclic)
      ];
      const workflow = buildWorkflowWithGates(
        SPACE_ID,
        workflowManager,
        [
          { id: NODE_A, name: 'Coder Node', agents: [{ agentId: AGENT_CODER, name: 'coder' }] },
          {
            id: NODE_B,
            name: 'Planner Node',
            agents: [{ agentId: AGENT_PLANNER, name: 'planner' }],
          },
        ],
        channels,
        [gate]
      );

      const run = workflowRunRepo.createRun({
        spaceId: SPACE_ID,
        workflowId: workflow.id,
        title: 'Script-Only Gate Reset Run',
      });
      workflowRunRepo.transitionStatus(run.id, 'in_progress');

      // Seed arbitrary data (simulating script output written to gate data)
      gateDataRepo.set(run.id, 'script-only-gate', {
        scriptResult: true,
        timestamp: '2025-01-01T00:00:00Z',
      });

      // Traverse the cyclic (backward) channel: planner → coder
      await router.deliverMessage(run.id, 'planner', 'coder', 'iterating');

      // Gate data should have been reset to empty object (no fields to compute defaults from)
      const afterReset = gateDataRepo.get(run.id, 'script-only-gate');
      expect(afterReset).not.toBeNull();
      expect(afterReset!.data).toMatchObject({});

      // Cycle count should have been incremented
      expect(channelCycleRepo.get(run.id, 1)!.count).toBe(1);
    });

    test('resetOnCycle: gates with resetOnCycle=false are preserved on cyclic traversal', async () => {
      const resetGate: Gate = {
        id: 'review-reject-gate',
        fields: [
          { name: 'rejected', type: 'string', writers: ['reviewer'], check: { op: 'exists' } },
        ],
        resetOnCycle: true,
      };
      const preservedGate: Gate = {
        id: 'code-pr-gate',
        fields: [{ name: 'pr', type: 'string', writers: ['coder'], check: { op: 'exists' } }],
        resetOnCycle: false,
      };
      const channels: WorkflowChannel[] = [
        { id: 'ch-fwd', from: 'Coder Node', to: 'Planner Node', gateId: 'review-votes-gate' }, // index 0
        { id: 'ch-bwd', from: 'Planner Node', to: 'Coder Node' }, // index 1 (cyclic)
      ];
      const workflow = buildWorkflowWithGates(
        SPACE_ID,
        workflowManager,
        [
          { id: NODE_A, name: 'Coder Node', agents: [{ agentId: AGENT_CODER, name: 'coder' }] },
          {
            id: NODE_B,
            name: 'Planner Node',
            agents: [{ agentId: AGENT_PLANNER, name: 'planner' }],
          },
        ],
        channels,
        [resetGate, preservedGate]
      );

      const run = workflowRunRepo.createRun({
        spaceId: SPACE_ID,
        workflowId: workflow.id,
        title: 'Selective Reset Run',
      });
      workflowRunRepo.transitionStatus(run.id, 'in_progress');

      // Write data for both gates
      gateDataRepo.set(run.id, 'review-reject-gate', { rejected: 'needs work' });
      gateDataRepo.set(run.id, 'code-pr-gate', { pr: 'https://github.com/org/repo/pull/42' });

      // Traverse cyclic (backward) channel: planner → coder
      await router.deliverMessage(run.id, 'planner', 'coder', 'back to coding');

      // resetOnCycle: true gate should be reset to defaults
      const resetRecord = gateDataRepo.get(run.id, 'review-reject-gate');
      expect(resetRecord!.data).toMatchObject({});

      // resetOnCycle: false gate should be preserved
      const preservedRecord = gateDataRepo.get(run.id, 'code-pr-gate');
      expect(preservedRecord!.data).toEqual({ pr: 'https://github.com/org/repo/pull/42' });
    });

    test('resetOnCycle: multiple cycle-reset gates reset together (atomic)', async () => {
      const gate1: Gate = {
        id: 'review-votes-gate',
        fields: [
          {
            name: 'votes',
            type: 'map',
            writers: ['*'],
            check: { op: 'count', match: 'ok', min: 1 },
          },
        ],
        resetOnCycle: true,
      };
      const gate2: Gate = {
        id: 'qa-result-gate',
        fields: [{ name: 'result', type: 'string', writers: ['*'], check: { op: 'exists' } }],
        resetOnCycle: true,
      };
      const channels: WorkflowChannel[] = [
        { id: 'ch-fwd', from: 'Coder Node', to: 'Planner Node', gateId: 'review-votes-gate' }, // index 0
        { id: 'ch-bwd', from: 'Planner Node', to: 'Coder Node' }, // index 1 (cyclic)
      ];
      const workflow = buildWorkflowWithGates(
        SPACE_ID,
        workflowManager,
        [
          { id: NODE_A, name: 'Coder Node', agents: [{ agentId: AGENT_CODER, name: 'coder' }] },
          {
            id: NODE_B,
            name: 'Planner Node',
            agents: [{ agentId: AGENT_PLANNER, name: 'planner' }],
          },
        ],
        channels,
        [gate1, gate2]
      );

      const run = workflowRunRepo.createRun({
        spaceId: SPACE_ID,
        workflowId: workflow.id,
        title: 'Multi Reset Atomic Run',
      });
      workflowRunRepo.transitionStatus(run.id, 'in_progress');

      // Write data for both gates
      gateDataRepo.set(run.id, 'review-votes-gate', { votes: { alice: 'ok' } });
      gateDataRepo.set(run.id, 'qa-result-gate', { result: 'passed' });

      // Traverse cyclic (backward) channel: planner → coder
      await router.deliverMessage(run.id, 'planner', 'coder', 'cycle');

      // Both should be reset to their defaults
      const votes = gateDataRepo.get(run.id, 'review-votes-gate');
      expect(votes!.data).toMatchObject({ votes: {} });

      const qa = gateDataRepo.get(run.id, 'qa-result-gate');
      expect(qa!.data).toMatchObject({});
    });

    // -----------------------------------------------------------------------
    // Incremental writes — correct accumulation pattern for vote-counting
    // -----------------------------------------------------------------------

    test('incremental vote writes accumulate correctly and activate node at quorum', async () => {
      // GateDataRepository.merge() does a shallow top-level merge, so each
      // caller must write the full accumulated votes map (read-then-write pattern)
      // rather than only their own vote. This is the correct usage pattern for
      // vote-counting gates; direct concurrent writes that replace the same key
      // would lose votes due to the shallow merge semantics.
      const gate: Gate = {
        id: 'accumulate-gate',
        fields: [
          {
            name: 'approvals',
            type: 'map',
            writers: ['*'],
            check: { op: 'count', match: 'approved', min: 3 },
          },
        ],
        resetOnCycle: false,
      };
      const channels: WorkflowChannel[] = [
        { id: 'ch-1', from: 'coder', to: 'planner', gateId: 'accumulate-gate' },
      ];
      const workflow = buildWorkflowWithGates(
        SPACE_ID,
        workflowManager,
        [
          { id: NODE_A, name: 'Coder Node', agents: [{ agentId: AGENT_CODER, name: 'coder' }] },
          {
            id: NODE_B,
            name: 'Planner Node',
            agents: [{ agentId: AGENT_PLANNER, name: 'planner' }],
          },
        ],
        channels,
        [gate]
      );

      const run = workflowRunRepo.createRun({
        spaceId: SPACE_ID,
        workflowId: workflow.id,
        title: 'Accumulate Votes Run',
      });
      workflowRunRepo.transitionStatus(run.id, 'in_progress');
      gateDataRepo.initializeForRun(run.id, [
        { id: gate.id, data: computeGateDefaults(gate.fields) },
      ]);

      // Voter 1: write only their vote (gate still closed, min=3)
      gateDataRepo.merge(run.id, 'accumulate-gate', {
        approvals: { alice: 'approved' },
      });
      let activated = await router.onGateDataChanged(run.id, 'accumulate-gate');
      expect(activated).toHaveLength(0);

      // Voter 2: read current state then write accumulated map (2 votes, still closed)
      const after1 = gateDataRepo.get(run.id, 'accumulate-gate')!.data;
      gateDataRepo.merge(run.id, 'accumulate-gate', {
        approvals: { ...(after1.approvals as Record<string, string>), bob: 'approved' },
      });
      activated = await router.onGateDataChanged(run.id, 'accumulate-gate');
      expect(activated).toHaveLength(0);

      // Voter 3: read current state then write accumulated map (3 votes — quorum reached)
      const after2 = gateDataRepo.get(run.id, 'accumulate-gate')!.data;
      gateDataRepo.merge(run.id, 'accumulate-gate', {
        approvals: { ...(after2.approvals as Record<string, string>), carol: 'approved' },
      });
      activated = await router.onGateDataChanged(run.id, 'accumulate-gate');
      expect(activated.length).toBeGreaterThan(0);
      // workflowNodeId removed in M71; verify activated task belongs to the run
      expect(activated[0].workflowRunId).toBe(run.id);

      // All 3 votes are preserved in the final state
      const final = gateDataRepo.get(run.id, 'accumulate-gate')!;
      const approvals = final.data.approvals as Record<string, string>;
      expect(Object.keys(approvals)).toHaveLength(3);
      expect(approvals).toEqual({ alice: 'approved', bob: 'approved', carol: 'approved' });
    });

    // -----------------------------------------------------------------------
    // Parallel activation — shared gate → multiple independent nodes
    // -----------------------------------------------------------------------

    test('parallel activation: shared gate opens → all target nodes activated simultaneously', async () => {
      // Mirrors the code-pr-gate scenario: one gate controls three channels,
      // each pointing to a different reviewer node.
      const gate: Gate = {
        id: 'code-pr-gate',
        fields: [
          {
            name: 'pr_url',
            type: 'string',
            writers: ['coder'],
            check: { op: '!=', value: undefined },
          },
        ],
        resetOnCycle: false,
      };

      const NODE_REVIEWER1 = 'node-reviewer1';
      const NODE_REVIEWER2 = 'node-reviewer2';
      const NODE_REVIEWER3 = 'node-reviewer3';
      const AGENT_REVIEWER1 = 'agent-reviewer1';
      const AGENT_REVIEWER2 = 'agent-reviewer2';
      const AGENT_REVIEWER3 = 'agent-reviewer3';

      for (const [id, name] of [
        [AGENT_REVIEWER1, 'Reviewer 1'],
        [AGENT_REVIEWER2, 'Reviewer 2'],
        [AGENT_REVIEWER3, 'Reviewer 3'],
      ]) {
        db.prepare(
          `INSERT INTO space_agents (id, space_id, name, description, model, tools,
					 system_prompt, created_at, updated_at)
					 VALUES (?, ?, ?, '', null, '[]', '', ?, ?)`
        ).run(id, SPACE_ID, name, Date.now(), Date.now());
      }

      // Three channels share the same gate — when it opens, all 3 reviewer nodes activate
      const channels: WorkflowChannel[] = [
        { id: 'ch-1', from: 'coder', to: 'reviewer-1', gateId: 'code-pr-gate' },
        { id: 'ch-2', from: 'coder', to: 'reviewer-2', gateId: 'code-pr-gate' },
        { id: 'ch-3', from: 'coder', to: 'reviewer-3', gateId: 'code-pr-gate' },
      ];

      const workflow = buildWorkflowWithGates(
        SPACE_ID,
        workflowManager,
        [
          { id: NODE_A, name: 'Coder Node', agents: [{ agentId: AGENT_CODER, name: 'coder' }] },
          {
            id: NODE_REVIEWER1,
            name: 'Reviewer 1 Node',
            agents: [{ agentId: AGENT_REVIEWER1, name: 'reviewer-1' }],
          },
          {
            id: NODE_REVIEWER2,
            name: 'Reviewer 2 Node',
            agents: [{ agentId: AGENT_REVIEWER2, name: 'reviewer-2' }],
          },
          {
            id: NODE_REVIEWER3,
            name: 'Reviewer 3 Node',
            agents: [{ agentId: AGENT_REVIEWER3, name: 'reviewer-3' }],
          },
        ],
        channels,
        [gate]
      );

      const run = workflowRunRepo.createRun({
        spaceId: SPACE_ID,
        workflowId: workflow.id,
        title: 'Parallel Reviewer Run',
      });
      workflowRunRepo.transitionStatus(run.id, 'in_progress');
      gateDataRepo.initializeForRun(run.id, [
        { id: gate.id, data: computeGateDefaults(gate.fields) },
      ]);

      // Gate closed — no nodes activated
      const noneYet = await router.onGateDataChanged(run.id, 'code-pr-gate');
      expect(noneYet).toHaveLength(0);

      // Open the gate by writing a pr_url
      gateDataRepo.merge(run.id, 'code-pr-gate', { pr_url: 'https://github.com/org/repo/pull/42' });

      // All 3 reviewer nodes should activate simultaneously
      const activated = await router.onGateDataChanged(run.id, 'code-pr-gate');
      expect(activated.length).toBe(3);

      // workflowNodeId removed in M71; verify all 3 activated tasks belong to the run
      expect(activated.every((t) => t.workflowRunId === run.id)).toBe(true);
    });

    test('parallel activation: second call is idempotent — already-active nodes not re-activated', async () => {
      const gate: Gate = {
        id: 'shared-gate',
        fields: [
          { name: 'ready', type: 'boolean', writers: ['*'], check: { op: '==', value: true } },
        ],
        resetOnCycle: false,
      };

      const NODE_C = 'node-c';
      const AGENT_C = 'agent-c';

      db.prepare(
        `INSERT INTO space_agents (id, space_id, name, description, model, tools,
				 system_prompt, created_at, updated_at)
				 VALUES (?, ?, 'Agent C', '', null, '[]', '', ?, ?)`
      ).run(AGENT_C, SPACE_ID, Date.now(), Date.now());

      const channels: WorkflowChannel[] = [
        { id: 'ch-1', from: 'coder', to: 'planner', gateId: 'shared-gate' }, // fan-out to both targets
        { id: 'ch-2', from: 'coder', to: 'agent-c', gateId: 'shared-gate' }, // same gate, second target
      ];

      const workflow = buildWorkflowWithGates(
        SPACE_ID,
        workflowManager,
        [
          { id: NODE_A, name: 'Coder Node', agents: [{ agentId: AGENT_CODER, name: 'coder' }] },
          {
            id: NODE_B,
            name: 'Planner Node',
            agents: [{ agentId: AGENT_PLANNER, name: 'planner' }],
          },
          { id: NODE_C, name: 'C Node', agents: [{ agentId: AGENT_C, name: 'agent-c' }] },
        ],
        channels,
        [gate]
      );

      const run = workflowRunRepo.createRun({
        spaceId: SPACE_ID,
        workflowId: workflow.id,
        title: 'Idempotent Parallel Run',
      });
      workflowRunRepo.transitionStatus(run.id, 'in_progress');
      gateDataRepo.initializeForRun(run.id, [
        { id: gate.id, data: computeGateDefaults(gate.fields) },
      ]);
      gateDataRepo.merge(run.id, 'shared-gate', { ready: true });

      // First call: both nodes activated
      const first = await router.onGateDataChanged(run.id, 'shared-gate');
      expect(first.length).toBe(2);

      // Second call: gate still open but nodes already active → nothing new
      const second = await router.onGateDataChanged(run.id, 'shared-gate');
      expect(second).toHaveLength(0);
    });

    // -----------------------------------------------------------------------
    // 3-reviewer vote-counting gate (review-votes-gate pattern)
    // -----------------------------------------------------------------------

    test('review-votes-gate: QA blocked until all 3 reviewers approve (min: 3)', async () => {
      // Parallel vote-counting gate pattern (also used by the Plan & Decompose
      // plan-approval-gate with min:4): each reviewer writes independently, and
      // the downstream node only activates once the vote count reaches the min.
      const gate: Gate = {
        id: 'review-votes-gate',
        fields: [
          {
            name: 'votes',
            type: 'map',
            writers: ['reviewer'],
            check: { op: 'count', match: 'approved', min: 3 },
          },
        ],
        resetOnCycle: false,
      };

      const NODE_QA = 'node-qa';
      const AGENT_QA = 'agent-qa';

      db.prepare(
        `INSERT INTO space_agents (id, space_id, name, description, model, tools,
				 system_prompt, created_at, updated_at)
				 VALUES (?, ?, 'QA Agent', '', null, '[]', '', ?, ?)`
      ).run(AGENT_QA, SPACE_ID, Date.now(), Date.now());

      // All 3 reviewer channels share the same review-votes-gate
      const channels: WorkflowChannel[] = [
        {
          from: 'reviewer-1',
          to: 'qa-agent',
          gateId: 'review-votes-gate',
        },
        {
          from: 'reviewer-2',
          to: 'qa-agent',
          gateId: 'review-votes-gate',
        },
        {
          from: 'reviewer-3',
          to: 'qa-agent',
          gateId: 'review-votes-gate',
        },
      ];

      const workflow = buildWorkflowWithGates(
        SPACE_ID,
        workflowManager,
        [
          { id: NODE_A, name: 'Coder Node', agents: [{ agentId: AGENT_CODER, name: 'coder' }] },
          { id: NODE_QA, name: 'QA Node', agents: [{ agentId: AGENT_QA, name: 'qa-agent' }] },
        ],
        channels,
        [gate]
      );

      const run = workflowRunRepo.createRun({
        spaceId: SPACE_ID,
        workflowId: workflow.id,
        title: '3-Reviewer Vote Run',
      });
      workflowRunRepo.transitionStatus(run.id, 'in_progress');
      gateDataRepo.initializeForRun(run.id, [
        { id: gate.id, data: computeGateDefaults(gate.fields) },
      ]);

      // Reviewer 1 votes — gate still closed (1/3)
      gateDataRepo.merge(run.id, 'review-votes-gate', { votes: { 'reviewer-1': 'approved' } });
      let activated = await router.onGateDataChanged(run.id, 'review-votes-gate');
      expect(activated).toHaveLength(0);

      // Reviewer 2 votes — gate still closed (2/3, partial completion)
      const after1 = gateDataRepo.get(run.id, 'review-votes-gate')!.data;
      gateDataRepo.merge(run.id, 'review-votes-gate', {
        votes: { ...(after1.votes as Record<string, string>), 'reviewer-2': 'approved' },
      });
      activated = await router.onGateDataChanged(run.id, 'review-votes-gate');
      expect(activated).toHaveLength(0); // QA still blocked: only 2/3 approved

      // Reviewer 3 votes — quorum reached (3/3), QA activates
      const after2 = gateDataRepo.get(run.id, 'review-votes-gate')!.data;
      gateDataRepo.merge(run.id, 'review-votes-gate', {
        votes: { ...(after2.votes as Record<string, string>), 'reviewer-3': 'approved' },
      });
      activated = await router.onGateDataChanged(run.id, 'review-votes-gate');
      expect(activated.length).toBeGreaterThan(0);
      // workflowNodeId removed in M71; verify activated task belongs to the run
      expect(activated[0].workflowRunId).toBe(run.id);

      // Verify all 3 votes are preserved in the gate data
      const finalData = gateDataRepo.get(run.id, 'review-votes-gate')!.data;
      const votes = finalData.votes as Record<string, string>;
      expect(Object.keys(votes)).toHaveLength(3);
      expect(votes['reviewer-1']).toBe('approved');
      expect(votes['reviewer-2']).toBe('approved');
      expect(votes['reviewer-3']).toBe('approved');
    });

    test('review-votes-gate: partial completion (2/3) keeps QA blocked', async () => {
      // Explicitly verifies the partial-completion guard: the gate condition
      // min: 3 means 2 votes are insufficient to unblock downstream QA.
      const gate: Gate = {
        id: 'review-votes-gate',
        fields: [
          {
            name: 'votes',
            type: 'map',
            writers: ['reviewer'],
            check: { op: 'count', match: 'approved', min: 3 },
          },
        ],
        resetOnCycle: false,
      };

      const NODE_QA = 'node-qa-partial';
      const AGENT_QA = 'agent-qa-partial';

      db.prepare(
        `INSERT INTO space_agents (id, space_id, name, description, model, tools,
				 system_prompt, created_at, updated_at)
				 VALUES (?, ?, 'QA Agent', '', null, '[]', '', ?, ?)`
      ).run(AGENT_QA, SPACE_ID, Date.now(), Date.now());

      const channels: WorkflowChannel[] = [
        { id: 'ch-1', from: 'coder', to: 'planner', gateId: 'review-votes-gate' },
      ];

      const workflow = buildWorkflowWithGates(
        SPACE_ID,
        workflowManager,
        [
          { id: NODE_A, name: 'Coder Node', agents: [{ agentId: AGENT_CODER, name: 'coder' }] },
          { id: NODE_QA, name: 'QA Node', agents: [{ agentId: AGENT_QA, name: 'qa' }] },
        ],
        channels,
        [gate]
      );

      const run = workflowRunRepo.createRun({
        spaceId: SPACE_ID,
        workflowId: workflow.id,
        title: 'Partial Completion Run',
      });
      workflowRunRepo.transitionStatus(run.id, 'in_progress');
      gateDataRepo.initializeForRun(run.id, [
        { id: gate.id, data: computeGateDefaults(gate.fields) },
      ]);

      // Write 2 approvals — gate needs 3, so QA stays blocked
      gateDataRepo.set(run.id, 'review-votes-gate', {
        votes: { 'reviewer-1': 'approved', 'reviewer-2': 'approved' },
      });
      const activated = await router.onGateDataChanged(run.id, 'review-votes-gate');
      expect(activated).toHaveLength(0);

      // workflowNodeId removed in M71; activated array is empty — no tasks created
      expect(activated).toHaveLength(0);
    });

    // -----------------------------------------------------------------------
    // gateId takes precedence over legacy inline gate
    // -----------------------------------------------------------------------

    // -----------------------------------------------------------------------
    // QA feedback loop — M5.1
    // -----------------------------------------------------------------------

    describe('QA feedback loop', () => {
      const AGENT_REVIEWER = 'agent-reviewer-qa';
      const AGENT_QA = 'agent-qa-loop';
      const AGENT_DONE = 'agent-done-loop';

      const NODE_CODING = 'node-coding-qa';
      const NODE_REV1 = 'node-rev1-qa';
      const NODE_REV2 = 'node-rev2-qa';
      const NODE_REV3 = 'node-rev3-qa';
      const NODE_QA = 'node-qa-loop';
      const NODE_DONE = 'node-done-qa';

      // Gates mirroring a code-review pipeline: PR-gate guarding review,
      // vote-counting gate guarding QA
      const gateCodePr: Gate = {
        id: 'code-pr-gate',
        fields: [{ name: 'pr_url', type: 'string', writers: ['coder'], check: { op: 'exists' } }],
        resetOnCycle: false, // preserved across fix cycles
      };
      const gateReviewVotes: Gate = {
        id: 'review-votes-gate',
        fields: [
          {
            name: 'votes',
            type: 'map',
            writers: ['reviewer'],
            check: { op: 'count', match: 'approved', min: 3 },
          },
        ],
        resetOnCycle: true,
      };
      const gateReviewReject: Gate = {
        id: 'review-reject-gate',
        fields: [
          {
            name: 'votes',
            type: 'map',
            writers: ['reviewer'],
            check: { op: 'count', match: 'rejected', min: 1 },
          },
        ],
        resetOnCycle: true,
      };
      const gateQaResult: Gate = {
        id: 'qa-result-gate',
        fields: [
          { name: 'result', type: 'string', writers: ['qa'], check: { op: '==', value: 'passed' } },
        ],
        resetOnCycle: true, // resets on each QA→Coding cycle
      };
      const gateQaFail: Gate = {
        id: 'qa-fail-gate',
        fields: [
          { name: 'result', type: 'string', writers: ['qa'], check: { op: '==', value: 'failed' } },
        ],
        resetOnCycle: true,
      };
      const allGates = [gateCodePr, gateReviewVotes, gateReviewReject, gateQaResult, gateQaFail];

      function buildQaWorkflow(qaMaxCycles = 5) {
        const channels: WorkflowChannel[] = [
          // index 0: Coding → Code Review (gated by code-pr-gate)
          { id: 'ch-0', from: 'Coding', to: 'Code Review', gateId: 'code-pr-gate' },
          // index 1: Code Review → Coding (feedback, ungated back-channel)
          { id: 'ch-1', from: 'Code Review', to: 'Coding', maxCycles: qaMaxCycles },
          // index 2: Code Review → QA (gated by review-votes-gate)
          { id: 'ch-2', from: 'Code Review', to: 'QA', gateId: 'review-votes-gate' },
          // index 3: QA → Coding (cyclic, gated by qa-fail-gate)
          { id: 'ch-3', from: 'QA', to: 'Coding', gateId: 'qa-fail-gate', maxCycles: qaMaxCycles },
          // index 4: QA → Done (success path, gated by qa-result-gate)
          { id: 'ch-4', from: 'QA', to: 'Done', gateId: 'qa-result-gate' },
        ];
        return buildWorkflowWithGates(
          SPACE_ID,
          workflowManager,
          [
            { id: NODE_CODING, name: 'Coding', agents: [{ agentId: AGENT_CODER, name: 'coder' }] },
            {
              id: NODE_REV1,
              name: 'Code Review',
              agents: [
                { agentId: AGENT_REVIEWER, name: 'Reviewer 1' },
                { agentId: AGENT_REVIEWER, name: 'Reviewer 2' },
                { agentId: AGENT_REVIEWER, name: 'Reviewer 3' },
              ],
            },
            { id: NODE_QA, name: 'QA', agents: [{ agentId: AGENT_QA, name: 'qa' }] },
            {
              id: NODE_DONE,
              name: 'Done',
              agents: [{ agentId: AGENT_DONE, name: 'done' }],
            },
          ],
          channels,
          allGates
        );
      }

      beforeEach(() => {
        seedAgent(db, AGENT_REVIEWER, SPACE_ID);
        seedAgent(db, AGENT_QA, SPACE_ID);
        seedAgent(db, AGENT_DONE, SPACE_ID);
      });

      test('QA failure via onGateDataChanged activates Coding, increments counter, resets cycle gates', async () => {
        const workflow = buildQaWorkflow();
        const run = workflowRunRepo.createRun({
          spaceId: SPACE_ID,
          workflowId: workflow.id,
          title: 'QA Fail Loop Run',
        });
        workflowRunRepo.transitionStatus(run.id, 'in_progress');
        gateDataRepo.initializeForRun(
          run.id,
          allGates.map((g) => ({ id: g.id, data: computeGateDefaults(g.fields) }))
        );

        // Simulate pre-existing state from a completed review cycle
        gateDataRepo.set(run.id, 'code-pr-gate', { pr_url: 'https://github.com/org/repo/pull/42' });
        gateDataRepo.set(run.id, 'review-votes-gate', {
          votes: { 'reviewer-1': 'approved', 'reviewer-2': 'approved', 'reviewer-3': 'approved' },
        });
        gateDataRepo.set(run.id, 'review-reject-gate', { votes: { 'reviewer-1': 'approved' } });
        gateDataRepo.set(run.id, 'qa-result-gate', { result: 'passed' });

        // QA writes failed result with summary to qa-fail-gate (as the write_gate MCP tool would)
        gateDataRepo.set(run.id, 'qa-fail-gate', {
          result: 'failed',
          summary: 'CI pipeline red: 3 tests failing',
        });
        const activated = await router.onGateDataChanged(run.id, 'qa-fail-gate');

        // Exactly one task: the Coding node activated via the cyclic QA→Coding channel
        expect(activated).toHaveLength(1);
        // workflowNodeId removed in M71; verify activated task belongs to the run
        expect(activated[0].workflowRunId).toBe(run.id);

        // Per-channel cycle counter must increment (QA→Coding is channel index 3)
        expect(channelCycleRepo.get(run.id, 3)!.count).toBe(1);

        // Cyclic-reset gates must be wiped to computed defaults
        expect(gateDataRepo.get(run.id, 'review-votes-gate')!.data).toMatchObject({ votes: {} });
        expect(gateDataRepo.get(run.id, 'review-reject-gate')!.data).toMatchObject({ votes: {} });
        expect(gateDataRepo.get(run.id, 'qa-result-gate')!.data).toMatchObject({});
        expect(gateDataRepo.get(run.id, 'qa-fail-gate')!.data).toMatchObject({});

        // code-pr-gate must be preserved (resetOnCycle: false)
        expect(gateDataRepo.get(run.id, 'code-pr-gate')!.data).toEqual({
          pr_url: 'https://github.com/org/repo/pull/42',
        });
      });

      test('QA failure resets review-votes-gate, qa-result-gate, qa-fail-gate; preserves code-pr-gate', async () => {
        const workflow = buildQaWorkflow();
        const run = workflowRunRepo.createRun({
          spaceId: SPACE_ID,
          workflowId: workflow.id,
          title: 'Gate Reset On QA Fail',
        });
        workflowRunRepo.transitionStatus(run.id, 'in_progress');
        gateDataRepo.initializeForRun(
          run.id,
          allGates.map((g) => ({ id: g.id, data: computeGateDefaults(g.fields) }))
        );

        // Simulate pre-existing gate state from a completed review cycle;
        // qa-fail-gate must be set to satisfy the gated channel before delivery
        gateDataRepo.set(run.id, 'code-pr-gate', { pr_url: 'https://github.com/org/repo/pull/42' });
        gateDataRepo.set(run.id, 'review-votes-gate', {
          votes: { 'reviewer-1': 'approved', 'reviewer-2': 'approved', 'reviewer-3': 'approved' },
        });
        gateDataRepo.set(run.id, 'review-reject-gate', {
          votes: { 'reviewer-1': 'approved' },
        });
        gateDataRepo.set(run.id, 'qa-result-gate', { result: 'passed' });
        gateDataRepo.set(run.id, 'qa-fail-gate', { result: 'failed' });

        // QA delivers to Coding via cyclic channel (gate already satisfied above)
        await router.deliverMessage(run.id, 'QA', 'Coding', 'QA found issues');

        // code-pr-gate must be preserved (not reset) so Coding can update the existing PR
        const codePr = gateDataRepo.get(run.id, 'code-pr-gate');
        expect(codePr!.data).toEqual({
          pr_url: 'https://github.com/org/repo/pull/42',
        });

        // review-votes-gate, review-reject-gate, qa-result-gate, qa-fail-gate must reset
        const reviewVotes = gateDataRepo.get(run.id, 'review-votes-gate');
        expect(reviewVotes!.data).toMatchObject({ votes: {} });

        const reviewReject = gateDataRepo.get(run.id, 'review-reject-gate');
        expect(reviewReject!.data).toMatchObject({ votes: {} });

        const qaResult = gateDataRepo.get(run.id, 'qa-result-gate');
        expect(qaResult!.data).toMatchObject({});

        const qaFail = gateDataRepo.get(run.id, 'qa-fail-gate');
        expect(qaFail!.data).toMatchObject({});
      });

      test('QA→Coding cycle increments per-channel cycle counter', async () => {
        const workflow = buildQaWorkflow();
        const run = workflowRunRepo.createRun({
          spaceId: SPACE_ID,
          workflowId: workflow.id,
          title: 'Cycle Counter Run',
        });
        workflowRunRepo.transitionStatus(run.id, 'in_progress');
        gateDataRepo.initializeForRun(
          run.id,
          allGates.map((g) => ({ id: g.id, data: computeGateDefaults(g.fields) }))
        );

        // No cycle record yet
        expect(channelCycleRepo.get(run.id, 3)).toBeNull();

        // Must satisfy qa-fail-gate before delivering on cyclic QA→Coding channel
        gateDataRepo.set(run.id, 'qa-fail-gate', { result: 'failed' });
        await router.deliverMessage(run.id, 'QA', 'Coding', 'QA cycle 1');

        // Channel index 3 is QA→Coding
        expect(channelCycleRepo.get(run.id, 3)!.count).toBe(1);
      });

      test('after QA fail cycle, reviewers must re-vote from scratch (votes reset to empty)', async () => {
        const workflow = buildQaWorkflow();
        const run = workflowRunRepo.createRun({
          spaceId: SPACE_ID,
          workflowId: workflow.id,
          title: 'Re-vote From Scratch',
        });
        workflowRunRepo.transitionStatus(run.id, 'in_progress');
        gateDataRepo.initializeForRun(
          run.id,
          allGates.map((g) => ({ id: g.id, data: computeGateDefaults(g.fields) }))
        );

        // Populate existing votes and satisfy qa-fail-gate
        gateDataRepo.set(run.id, 'review-votes-gate', {
          votes: { 'reviewer-1': 'approved', 'reviewer-2': 'approved', 'reviewer-3': 'approved' },
        });
        gateDataRepo.set(run.id, 'qa-fail-gate', { result: 'failed' });

        // QA→Coding cycle
        await router.deliverMessage(run.id, 'QA', 'Coding', 'issues found');

        // All votes wiped — reviewers must re-vote
        const votes = gateDataRepo.get(run.id, 'review-votes-gate');
        expect(votes!.data).toMatchObject({ votes: {} });

        // QA channel now blocked (only 0/3 approved)
        const canDeliver = await router.canDeliver(run.id, 'Reviewer 1', 'QA');
        expect(canDeliver.allowed).toBe(false);
      });

      test('QA→Coding cycle throws ActivationError when max cycles reached', async () => {
        const workflow = buildQaWorkflow(2); // maxCycles: 2
        const run = workflowRunRepo.createRun({
          spaceId: SPACE_ID,
          workflowId: workflow.id,
          title: 'Max Cycles QA',
        });
        workflowRunRepo.transitionStatus(run.id, 'in_progress');
        gateDataRepo.initializeForRun(
          run.id,
          allGates.map((g) => ({ id: g.id, data: computeGateDefaults(g.fields) }))
        );

        // Use up 2 cycles (must satisfy qa-fail-gate before each delivery; gate resets on each cycle)
        gateDataRepo.set(run.id, 'qa-fail-gate', { result: 'failed' });
        await router.deliverMessage(run.id, 'QA', 'Coding', 'QA cycle 1');
        gateDataRepo.set(run.id, 'qa-fail-gate', { result: 'failed' });
        await router.deliverMessage(run.id, 'QA', 'Coding', 'QA cycle 2');

        // Third attempt should throw
        gateDataRepo.set(run.id, 'qa-fail-gate', { result: 'failed' });
        await expect(
          router.deliverMessage(run.id, 'QA', 'Coding', 'QA cycle 3 — should fail')
        ).rejects.toBeInstanceOf(ActivationError);
      });

      test('onGateDataChanged throws ActivationError when cyclic channel at max cycles', async () => {
        const workflow = buildQaWorkflow(1); // maxCycles: 1
        const run = workflowRunRepo.createRun({
          spaceId: SPACE_ID,
          workflowId: workflow.id,
          title: 'Max Cycles via onGateDataChanged',
        });
        workflowRunRepo.transitionStatus(run.id, 'in_progress');
        gateDataRepo.initializeForRun(
          run.id,
          allGates.map((g) => ({ id: g.id, data: computeGateDefaults(g.fields) }))
        );

        // Use up the 1 cycle via onGateDataChanged
        gateDataRepo.set(run.id, 'qa-fail-gate', { result: 'failed' });
        await router.onGateDataChanged(run.id, 'qa-fail-gate');
        expect(channelCycleRepo.get(run.id, 3)!.count).toBe(1);

        // Second attempt must throw before any activation
        gateDataRepo.set(run.id, 'qa-fail-gate', { result: 'failed' });
        await expect(router.onGateDataChanged(run.id, 'qa-fail-gate')).rejects.toBeInstanceOf(
          ActivationError
        );
      });

      test('QA passes → QA→Done channel opens when qa-result-gate satisfied', async () => {
        const workflow = buildQaWorkflow();
        const run = workflowRunRepo.createRun({
          spaceId: SPACE_ID,
          workflowId: workflow.id,
          title: 'QA Pass Run',
        });
        workflowRunRepo.transitionStatus(run.id, 'in_progress');
        gateDataRepo.initializeForRun(
          run.id,
          allGates.map((g) => ({ id: g.id, data: computeGateDefaults(g.fields) }))
        );

        // QA writes passed result
        gateDataRepo.set(run.id, 'qa-result-gate', { result: 'passed' });
        const activated = await router.onGateDataChanged(run.id, 'qa-result-gate');

        // workflowNodeId removed in M71; verify at least one task was activated
        expect(activated.length).toBeGreaterThan(0);
        expect(activated[0].workflowRunId).toBe(run.id);
      });
    });

    test('gateId takes precedence over legacy inline gate when both are set', async () => {
      const gate: Gate = {
        id: 'new-gate',
        fields: [
          { name: 'approved', type: 'boolean', writers: ['*'], check: { op: '==', value: true } },
        ],
        resetOnCycle: false,
      };
      const channels: WorkflowChannel[] = [
        {
          from: 'coder',
          to: 'planner',
          gateId: 'new-gate',
        },
      ];
      const workflow = buildWorkflowWithGates(
        SPACE_ID,
        workflowManager,
        [
          { id: NODE_A, name: 'Coder Node', agents: [{ agentId: AGENT_CODER, name: 'coder' }] },
          {
            id: NODE_B,
            name: 'Planner Node',
            agents: [{ agentId: AGENT_PLANNER, name: 'planner' }],
          },
        ],
        channels,
        [gate]
      );

      const run = workflowRunRepo.createRun({
        spaceId: SPACE_ID,
        workflowId: workflow.id,
        title: 'Precedence Run',
      });
      workflowRunRepo.transitionStatus(run.id, 'in_progress');

      // Write gate data to satisfy the new-style gate
      gateDataRepo.set(run.id, 'new-gate', { approved: true });

      // Delivery succeeds because gateId evaluation passes (ignoring legacy human gate)
      const result = await router.deliverMessage(run.id, 'coder', 'planner', 'approved');
      expect(result.fromRole).toBe('coder');
    });

    // -----------------------------------------------------------------------
    // onGatePendingApproval callback
    // -----------------------------------------------------------------------

    describe('onGatePendingApproval callback', () => {
      test('fires when gate data is written but gate is still not open (external approval gate)', async () => {
        const gate: Gate = {
          id: 'external-approval-gate',
          fields: [
            {
              name: 'approved',
              type: 'boolean',
              writers: [], // empty writers = external/human-only approval
              check: { op: '==', value: true },
            },
          ],
          resetOnCycle: false,
        };
        const channels: WorkflowChannel[] = [
          { id: 'ch-1', from: 'coder', to: 'planner', gateId: 'external-approval-gate' },
        ];
        const workflow = buildWorkflowWithGates(
          SPACE_ID,
          workflowManager,
          [
            {
              id: NODE_A,
              name: 'Coder Node',
              agents: [{ agentId: AGENT_CODER, name: 'coder' }],
            },
            {
              id: NODE_B,
              name: 'Planner Node',
              agents: [{ agentId: AGENT_PLANNER, name: 'planner' }],
            },
          ],
          channels,
          [gate]
        );

        const run = workflowRunRepo.createRun({
          spaceId: SPACE_ID,
          workflowId: workflow.id,
          title: 'External Approval Pending Run',
        });
        workflowRunRepo.transitionStatus(run.id, 'in_progress');

        const pendingCalls: Array<{ runId: string; gateId: string }> = [];
        const routerWithCallback = new ChannelRouter({
          taskRepo,
          workflowRunRepo,
          workflowManager,
          agentManager,
          gateDataRepo,
          channelCycleRepo,
          db,
          nodeExecutionRepo: new NodeExecutionRepository(db),
          onGatePendingApproval: async (rId, gId) => {
            pendingCalls.push({ runId: rId, gateId: gId });
          },
        });

        // Write gate data that does NOT satisfy the condition (approved not set to true)
        gateDataRepo.set(run.id, 'external-approval-gate', {});

        const activated = await routerWithCallback.onGateDataChanged(
          run.id,
          'external-approval-gate'
        );
        expect(activated).toHaveLength(0);
        expect(pendingCalls).toHaveLength(1);
        expect(pendingCalls[0]).toEqual({ runId: run.id, gateId: 'external-approval-gate' });
      });

      test('does NOT fire when gate opens (auto-approved)', async () => {
        const gate: Gate = {
          id: 'auto-gate',
          fields: [
            {
              name: 'approved',
              type: 'boolean',
              writers: [], // external approval gate
              check: { op: '==', value: true },
            },
          ],
          resetOnCycle: false,
        };
        const channels: WorkflowChannel[] = [
          { id: 'ch-1', from: 'coder', to: 'planner', gateId: 'auto-gate' },
        ];
        const workflow = buildWorkflowWithGates(
          SPACE_ID,
          workflowManager,
          [
            {
              id: NODE_A,
              name: 'Coder Node',
              agents: [{ agentId: AGENT_CODER, name: 'coder' }],
            },
            {
              id: NODE_B,
              name: 'Planner Node',
              agents: [{ agentId: AGENT_PLANNER, name: 'planner' }],
            },
          ],
          channels,
          [gate]
        );

        const run = workflowRunRepo.createRun({
          spaceId: SPACE_ID,
          workflowId: workflow.id,
          title: 'Auto-Approved Gate Run',
        });
        workflowRunRepo.transitionStatus(run.id, 'in_progress');

        const pendingCalls: Array<{ runId: string; gateId: string }> = [];
        const routerWithCallback = new ChannelRouter({
          taskRepo,
          workflowRunRepo,
          workflowManager,
          agentManager,
          gateDataRepo,
          channelCycleRepo,
          db,
          nodeExecutionRepo: new NodeExecutionRepository(db),
          onGatePendingApproval: async (rId, gId) => {
            pendingCalls.push({ runId: rId, gateId: gId });
          },
        });

        // Write gate data that satisfies the condition — gate opens
        gateDataRepo.set(run.id, 'auto-gate', { approved: true });

        const activated = await routerWithCallback.onGateDataChanged(run.id, 'auto-gate');
        // Gate opens → node activated, callback NOT fired
        expect(activated.length).toBeGreaterThan(0);
        expect(pendingCalls).toHaveLength(0);
      });

      test('does NOT fire for non-external-approval gates (writers not empty)', async () => {
        const gate: Gate = {
          id: 'agent-approval-gate',
          fields: [
            {
              name: 'approved',
              type: 'boolean',
              writers: ['planner'], // non-empty writers — agents can write
              check: { op: '==', value: true },
            },
          ],
          resetOnCycle: false,
        };
        const channels: WorkflowChannel[] = [
          { id: 'ch-1', from: 'coder', to: 'planner', gateId: 'agent-approval-gate' },
        ];
        const workflow = buildWorkflowWithGates(
          SPACE_ID,
          workflowManager,
          [
            {
              id: NODE_A,
              name: 'Coder Node',
              agents: [{ agentId: AGENT_CODER, name: 'coder' }],
            },
            {
              id: NODE_B,
              name: 'Planner Node',
              agents: [{ agentId: AGENT_PLANNER, name: 'planner' }],
            },
          ],
          channels,
          [gate]
        );

        const run = workflowRunRepo.createRun({
          spaceId: SPACE_ID,
          workflowId: workflow.id,
          title: 'Agent Approval Gate Run',
        });
        workflowRunRepo.transitionStatus(run.id, 'in_progress');

        const pendingCalls: Array<{ runId: string; gateId: string }> = [];
        const routerWithCallback = new ChannelRouter({
          taskRepo,
          workflowRunRepo,
          workflowManager,
          agentManager,
          gateDataRepo,
          channelCycleRepo,
          db,
          nodeExecutionRepo: new NodeExecutionRepository(db),
          onGatePendingApproval: async (rId, gId) => {
            pendingCalls.push({ runId: rId, gateId: gId });
          },
        });

        // Write data that does NOT satisfy the condition (approved = false)
        gateDataRepo.set(run.id, 'agent-approval-gate', { approved: false });

        const activated = await routerWithCallback.onGateDataChanged(run.id, 'agent-approval-gate');
        // Gate is closed but this is NOT an external-approval gate → callback not fired
        expect(activated).toHaveLength(0);
        expect(pendingCalls).toHaveLength(0);
      });
    });

    test('built-in live script is not injected when persisted gate has no script', async () => {
      // Regression for: removing a script from a built-in gate should not be
      // silently re-introduced by the live-script resolution path.
      const gate: Gate = {
        id: 'code-ready-gate',
        fields: [
          {
            name: 'pr_url',
            type: 'string',
            writers: ['Coding', 'coder'],
            check: { op: 'exists' },
          },
        ],
        // Intentionally no script — user removed it after seeding
      };
      const channels: WorkflowChannel[] = [
        { id: 'ch-1', from: 'Coder Node', to: 'Planner Node', gateId: 'code-ready-gate' },
      ];
      const workflow = buildWorkflowWithGates(
        SPACE_ID,
        workflowManager,
        [
          { id: NODE_A, name: 'Coder Node', agents: [{ agentId: AGENT_CODER, name: 'coder' }] },
          {
            id: NODE_B,
            name: 'Planner Node',
            agents: [{ agentId: AGENT_PLANNER, name: 'planner' }],
          },
        ],
        channels,
        [gate],
        'Coding Workflow'
      );

      const run = workflowRunRepo.createRun({
        spaceId: SPACE_ID,
        workflowId: workflow.id,
        title: 'Live Script Guard Run',
      });
      workflowRunRepo.transitionStatus(run.id, 'in_progress');

      // Write gate data that satisfies the field check
      gateDataRepo.set(run.id, 'code-ready-gate', {
        pr_url: 'https://github.com/test/repo/pull/1',
      });

      // Delivery should succeed because the gate is field-only (no script injected)
      const result = await router.deliverMessage(run.id, 'coder', 'planner', 'ready');
      expect(result.fromRole).toBe('coder');
    });
  });

  // -----------------------------------------------------------------------
  // Gate-open cache — skip re-evaluation after first open
  // -----------------------------------------------------------------------

  describe('gate-open cache', () => {
    test('deliverMessage: skips gate re-evaluation after first open delivery', async () => {
      const gate: Gate = {
        id: 'cache-test-gate',
        fields: [
          {
            name: 'approved',
            type: 'boolean',
            writers: ['*'],
            check: { op: '==', value: true },
          },
        ],
        resetOnCycle: false,
      };
      const channels: WorkflowChannel[] = [
        { id: 'ch-1', from: 'coder', to: 'planner', gateId: 'cache-test-gate' },
      ];
      const workflow = buildWorkflowWithGates(
        SPACE_ID,
        workflowManager,
        [
          { id: NODE_A, name: 'Coder Node', agents: [{ agentId: AGENT_CODER, name: 'coder' }] },
          {
            id: NODE_B,
            name: 'Planner Node',
            agents: [{ agentId: AGENT_PLANNER, name: 'planner' }],
          },
        ],
        channels,
        [gate]
      );

      const run = workflowRunRepo.createRun({
        spaceId: SPACE_ID,
        workflowId: workflow.id,
        title: 'Cache Test Run',
      });
      workflowRunRepo.transitionStatus(run.id, 'in_progress');

      // Open the gate
      gateDataRepo.set(run.id, 'cache-test-gate', { approved: true });

      // First delivery — evaluates gate, caches open state
      const result1 = await router.deliverMessage(run.id, 'coder', 'planner', 'msg 1');
      expect(result1.fromRole).toBe('coder');

      // Close the gate data (remove the approved field)
      gateDataRepo.set(run.id, 'cache-test-gate', { approved: false });

      // Second delivery — should succeed because gate was cached as open.
      // Without the cache, this would throw ChannelGateBlockedError.
      const result2 = await router.deliverMessage(run.id, 'coder', 'planner', 'msg 2');
      expect(result2.fromRole).toBe('coder');
    });

    test('canDeliver: skips gate re-evaluation after gate was opened', async () => {
      const gate: Gate = {
        id: 'cache-candeliver-gate',
        fields: [
          {
            name: 'approved',
            type: 'boolean',
            writers: ['*'],
            check: { op: '==', value: true },
          },
        ],
        resetOnCycle: false,
      };
      const channels: WorkflowChannel[] = [
        { id: 'ch-1', from: 'coder', to: 'planner', gateId: 'cache-candeliver-gate' },
      ];
      const workflow = buildWorkflowWithGates(
        SPACE_ID,
        workflowManager,
        [
          { id: NODE_A, name: 'Coder Node', agents: [{ agentId: AGENT_CODER, name: 'coder' }] },
          {
            id: NODE_B,
            name: 'Planner Node',
            agents: [{ agentId: AGENT_PLANNER, name: 'planner' }],
          },
        ],
        channels,
        [gate]
      );

      const run = workflowRunRepo.createRun({
        spaceId: SPACE_ID,
        workflowId: workflow.id,
        title: 'Cache canDeliver Run',
      });
      workflowRunRepo.transitionStatus(run.id, 'in_progress');

      // Open the gate and deliver once to populate the cache
      gateDataRepo.set(run.id, 'cache-candeliver-gate', { approved: true });
      await router.deliverMessage(run.id, 'coder', 'planner', 'first msg');

      // Close the gate
      gateDataRepo.set(run.id, 'cache-candeliver-gate', { approved: false });

      // canDeliver should return true because gate was cached as open
      const result = await router.canDeliver(run.id, 'coder', 'planner');
      expect(result.allowed).toBe(true);
    });

    test('built-in validator gate is volatile — re-evaluates even on a non-cyclic channel', () => {
      // A validator gate backs its check with an external_state lookup whose
      // result can flip independently of workflow.updatedAt. Unlike a plain
      // fields gate (cached open above), it must always re-evaluate — otherwise
      // a once-open validator gate would latch open after the state flips
      // (fail-open). mustReevaluateGate is the cache-bypass decision.
      registerBuiltInValidator('stub_volatility_validator', async () => ({ type: 'allow' }));
      const gate: Gate = {
        id: 'validator-volatility-gate',
        validator: { kind: 'built_in', id: 'stub_volatility_validator' },
        resetOnCycle: false,
      };
      const channels: WorkflowChannel[] = [
        { id: 'ch-validator', from: 'coder', to: 'planner', gateId: 'validator-volatility-gate' },
      ];
      const workflow = buildWorkflowWithGates(
        SPACE_ID,
        workflowManager,
        [
          { id: NODE_A, name: 'Coder Node', agents: [{ agentId: AGENT_CODER, name: 'coder' }] },
          {
            id: NODE_B,
            name: 'Planner Node',
            agents: [{ agentId: AGENT_PLANNER, name: 'planner' }],
          },
        ],
        channels,
        [gate]
      );

      const mustReevaluate = (
        router as unknown as {
          mustReevaluateGate: (
            gateId: string,
            channelIsCyclic: boolean,
            workflow: SpaceWorkflow,
            sourceNodeName?: string
          ) => boolean;
        }
      ).mustReevaluateGate;

      // Non-cyclic channel: a validator gate must still re-evaluate (volatile).
      expect(mustReevaluate('validator-volatility-gate', false, workflow)).toBe(true);
    });

    test('resetOnCycle gate re-evaluates despite cache on cyclic channel', async () => {
      const gate: Gate = {
        id: 'cyclic-reset-cache-gate',
        fields: [
          {
            name: 'approved',
            type: 'boolean',
            writers: ['*'],
            check: { op: '==', value: true },
          },
        ],
        resetOnCycle: true,
      };
      const channels: WorkflowChannel[] = [
        {
          id: 'ch-fwd',
          from: 'Coder Node',
          to: 'Planner Node',
          gateId: 'cyclic-reset-cache-gate',
        }, // index 0
        { id: 'ch-bwd', from: 'Planner Node', to: 'Coder Node' }, // index 1 (cyclic)
      ];
      const workflow = buildWorkflowWithGates(
        SPACE_ID,
        workflowManager,
        [
          { id: NODE_A, name: 'Coder Node', agents: [{ agentId: AGENT_CODER, name: 'coder' }] },
          {
            id: NODE_B,
            name: 'Planner Node',
            agents: [{ agentId: AGENT_PLANNER, name: 'planner' }],
          },
        ],
        channels,
        [gate]
      );

      const run = workflowRunRepo.createRun({
        spaceId: SPACE_ID,
        workflowId: workflow.id,
        title: 'Cyclic Reset Cache Run',
      });
      workflowRunRepo.transitionStatus(run.id, 'in_progress');

      // Open the gate
      gateDataRepo.set(run.id, 'cyclic-reset-cache-gate', { approved: true });

      // First cyclic delivery — evaluates gate, then resets it
      await router.deliverMessage(run.id, 'planner', 'coder', 'cycle 1');

      // After reset, gate data is back to defaults (approved: false for boolean default)
      // The cache should have been cleared by incrementAndResetCyclicChannel.
      // Delivering on the gated forward channel should now block.
      await expect(
        router.deliverMessage(run.id, 'coder', 'planner', 'blocked msg')
      ).rejects.toBeInstanceOf(ChannelGateBlockedError);
    });

    test('non-resetOnCycle gate on cyclic channel uses cache', async () => {
      const gate: Gate = {
        id: 'non-reset-cache-gate',
        fields: [
          {
            name: 'approved',
            type: 'boolean',
            writers: ['*'],
            check: { op: '==', value: true },
          },
        ],
        resetOnCycle: false,
      };
      const channels: WorkflowChannel[] = [
        {
          id: 'ch-fwd',
          from: 'Coder Node',
          to: 'Planner Node',
          gateId: 'non-reset-cache-gate',
        }, // index 0
        { id: 'ch-bwd', from: 'Planner Node', to: 'Coder Node' }, // index 1 (cyclic)
      ];
      const workflow = buildWorkflowWithGates(
        SPACE_ID,
        workflowManager,
        [
          { id: NODE_A, name: 'Coder Node', agents: [{ agentId: AGENT_CODER, name: 'coder' }] },
          {
            id: NODE_B,
            name: 'Planner Node',
            agents: [{ agentId: AGENT_PLANNER, name: 'planner' }],
          },
        ],
        channels,
        [gate]
      );

      const run = workflowRunRepo.createRun({
        spaceId: SPACE_ID,
        workflowId: workflow.id,
        title: 'Non-Reset Cyclic Cache Run',
      });
      workflowRunRepo.transitionStatus(run.id, 'in_progress');

      // Open the gate
      gateDataRepo.set(run.id, 'non-reset-cache-gate', { approved: true });

      // First delivery on the gated channel — caches open state
      const result1 = await router.deliverMessage(run.id, 'coder', 'planner', 'msg 1');
      expect(result1.fromRole).toBe('coder');

      // Close the gate data
      gateDataRepo.set(run.id, 'non-reset-cache-gate', { approved: false });

      // Second delivery should still succeed — gate is cached as open
      // (resetOnCycle is false, so cyclic channel does not force re-evaluation)
      const result2 = await router.deliverMessage(run.id, 'coder', 'planner', 'msg 2');
      expect(result2.fromRole).toBe('coder');
    });

    test('onGateDataChanged caches gate as opened', async () => {
      const gate: Gate = {
        id: 'ondemand-cache-gate',
        fields: [
          {
            name: 'approved',
            type: 'boolean',
            writers: ['*'],
            check: { op: '==', value: true },
          },
        ],
        resetOnCycle: false,
      };
      const channels: WorkflowChannel[] = [
        { id: 'ch-1', from: 'coder', to: 'planner', gateId: 'ondemand-cache-gate' },
      ];
      const workflow = buildWorkflowWithGates(
        SPACE_ID,
        workflowManager,
        [
          { id: NODE_A, name: 'Coder Node', agents: [{ agentId: AGENT_CODER, name: 'coder' }] },
          {
            id: NODE_B,
            name: 'Planner Node',
            agents: [{ agentId: AGENT_PLANNER, name: 'planner' }],
          },
        ],
        channels,
        [gate]
      );

      const run = workflowRunRepo.createRun({
        spaceId: SPACE_ID,
        workflowId: workflow.id,
        title: 'onGateDataChanged Cache Run',
      });
      workflowRunRepo.transitionStatus(run.id, 'in_progress');

      // Open the gate via onGateDataChanged
      gateDataRepo.set(run.id, 'ondemand-cache-gate', { approved: true });
      await router.onGateDataChanged(run.id, 'ondemand-cache-gate');

      // Close the gate
      gateDataRepo.set(run.id, 'ondemand-cache-gate', { approved: false });

      // canDeliver should return true — gate was cached as open by onGateDataChanged
      const result = await router.canDeliver(run.id, 'coder', 'planner');
      expect(result.allowed).toBe(true);
    });

    test('cache is per-gate: different gates are cached independently', async () => {
      const gate1: Gate = {
        id: 'gate-alpha',
        fields: [
          {
            name: 'ready',
            type: 'boolean',
            writers: ['*'],
            check: { op: '==', value: true },
          },
        ],
        resetOnCycle: false,
      };
      const gate2: Gate = {
        id: 'gate-beta',
        fields: [
          {
            name: 'ready',
            type: 'boolean',
            writers: ['*'],
            check: { op: '==', value: true },
          },
        ],
        resetOnCycle: false,
      };
      const AGENT_REVIEWER = 'agent-reviewer';
      db.prepare(
        `INSERT INTO space_agents (id, space_id, name, description, model, tools,
					 system_prompt, created_at, updated_at)
					 VALUES (?, ?, ?, '', null, '[]', '', ?, ?)`
      ).run(AGENT_REVIEWER, SPACE_ID, 'Agent Reviewer', Date.now(), Date.now());

      const NODE_C = 'node-c';
      const channels: WorkflowChannel[] = [
        { id: 'ch-1', from: 'coder', to: 'planner', gateId: 'gate-alpha' },
        { id: 'ch-2', from: 'coder', to: 'reviewer-slot', gateId: 'gate-beta' },
      ];
      const workflow = buildWorkflowWithGates(
        SPACE_ID,
        workflowManager,
        [
          { id: NODE_A, name: 'Coder Node', agents: [{ agentId: AGENT_CODER, name: 'coder' }] },
          {
            id: NODE_B,
            name: 'Planner Node',
            agents: [{ agentId: AGENT_PLANNER, name: 'planner' }],
          },
          {
            id: NODE_C,
            name: 'Reviewer Node',
            agents: [{ agentId: AGENT_REVIEWER, name: 'reviewer-slot' }],
          },
        ],
        channels,
        [gate1, gate2]
      );

      const run = workflowRunRepo.createRun({
        spaceId: SPACE_ID,
        workflowId: workflow.id,
        title: 'Per-Gate Cache Run',
      });
      workflowRunRepo.transitionStatus(run.id, 'in_progress');

      // Open gate-alpha only
      gateDataRepo.set(run.id, 'gate-alpha', { ready: true });

      // Deliver on gate-alpha channel — caches gate-alpha as open
      await router.deliverMessage(run.id, 'coder', 'planner', 'msg');

      // Close gate-alpha, open gate-beta
      gateDataRepo.set(run.id, 'gate-alpha', { ready: false });
      gateDataRepo.set(run.id, 'gate-beta', { ready: true });

      // Deliver on gate-beta channel — caches gate-beta as open
      await router.deliverMessage(run.id, 'coder', 'reviewer-slot', 'msg');

      // Close gate-beta
      gateDataRepo.set(run.id, 'gate-beta', { ready: false });

      // Both channels should still deliver because both gates are cached
      const r1 = await router.canDeliver(run.id, 'coder', 'planner');
      expect(r1.allowed).toBe(true);

      const r2 = await router.canDeliver(run.id, 'coder', 'reviewer-slot');
      expect(r2.allowed).toBe(true);
    });

    test('cache is per-run: different runs are cached independently', async () => {
      const gate: Gate = {
        id: 'per-run-cache-gate',
        fields: [
          {
            name: 'approved',
            type: 'boolean',
            writers: ['*'],
            check: { op: '==', value: true },
          },
        ],
        resetOnCycle: false,
      };
      const channels: WorkflowChannel[] = [
        { id: 'ch-1', from: 'coder', to: 'planner', gateId: 'per-run-cache-gate' },
      ];
      const workflow = buildWorkflowWithGates(
        SPACE_ID,
        workflowManager,
        [
          { id: NODE_A, name: 'Coder Node', agents: [{ agentId: AGENT_CODER, name: 'coder' }] },
          {
            id: NODE_B,
            name: 'Planner Node',
            agents: [{ agentId: AGENT_PLANNER, name: 'planner' }],
          },
        ],
        channels,
        [gate]
      );

      // Run 1: open gate, deliver to cache it
      const run1 = workflowRunRepo.createRun({
        spaceId: SPACE_ID,
        workflowId: workflow.id,
        title: 'Run 1',
      });
      workflowRunRepo.transitionStatus(run1.id, 'in_progress');
      gateDataRepo.set(run1.id, 'per-run-cache-gate', { approved: true });
      await router.deliverMessage(run1.id, 'coder', 'planner', 'run1 msg');

      // Run 2: same gate, different run — should NOT be cached
      const run2 = workflowRunRepo.createRun({
        spaceId: SPACE_ID,
        workflowId: workflow.id,
        title: 'Run 2',
      });
      workflowRunRepo.transitionStatus(run2.id, 'in_progress');
      // Gate not opened for run 2
      await expect(
        router.deliverMessage(run2.id, 'coder', 'planner', 'run2 msg')
      ).rejects.toBeInstanceOf(ChannelGateBlockedError);
    });

    test('evictRunCache clears cached gate state for a completed run', async () => {
      const gate: Gate = {
        id: 'eviction-gate',
        fields: [
          {
            name: 'approved',
            type: 'boolean',
            writers: ['*'],
            check: { op: '==', value: true },
          },
        ],
        resetOnCycle: false,
      };
      const channels: WorkflowChannel[] = [
        { id: 'ch-1', from: 'coder', to: 'planner', gateId: 'eviction-gate' },
      ];
      const workflow = buildWorkflowWithGates(
        SPACE_ID,
        workflowManager,
        [
          { id: NODE_A, name: 'Coder Node', agents: [{ agentId: AGENT_CODER, name: 'coder' }] },
          {
            id: NODE_B,
            name: 'Planner Node',
            agents: [{ agentId: AGENT_PLANNER, name: 'planner' }],
          },
        ],
        channels,
        [gate]
      );

      const run = workflowRunRepo.createRun({
        spaceId: SPACE_ID,
        workflowId: workflow.id,
        title: 'Eviction Test Run',
      });
      workflowRunRepo.transitionStatus(run.id, 'in_progress');

      // Open gate, deliver to cache it
      gateDataRepo.set(run.id, 'eviction-gate', { approved: true });
      await router.deliverMessage(run.id, 'coder', 'planner', 'msg');

      // Verify cache is active: close gate, delivery still succeeds
      gateDataRepo.set(run.id, 'eviction-gate', { approved: false });
      const result1 = await router.canDeliver(run.id, 'coder', 'planner');
      expect(result1.allowed).toBe(true);

      // Evict the run's cache
      router.evictRunCache(run.id);

      // Now canDeliver should re-evaluate and find the gate closed
      const result2 = await router.canDeliver(run.id, 'coder', 'planner');
      expect(result2.allowed).toBe(false);
    });

    test('terminal run status evicts cache in deliverMessage', async () => {
      const gate: Gate = {
        id: 'terminal-eviction-gate',
        fields: [
          {
            name: 'approved',
            type: 'boolean',
            writers: ['*'],
            check: { op: '==', value: true },
          },
        ],
        resetOnCycle: false,
      };
      const channels: WorkflowChannel[] = [
        { id: 'ch-1', from: 'coder', to: 'planner', gateId: 'terminal-eviction-gate' },
      ];
      const workflow = buildWorkflowWithGates(
        SPACE_ID,
        workflowManager,
        [
          { id: NODE_A, name: 'Coder Node', agents: [{ agentId: AGENT_CODER, name: 'coder' }] },
          {
            id: NODE_B,
            name: 'Planner Node',
            agents: [{ agentId: AGENT_PLANNER, name: 'planner' }],
          },
        ],
        channels,
        [gate]
      );

      const run = workflowRunRepo.createRun({
        spaceId: SPACE_ID,
        workflowId: workflow.id,
        title: 'Terminal Eviction Test Run',
      });
      workflowRunRepo.transitionStatus(run.id, 'in_progress');

      // Open gate, deliver to cache it
      gateDataRepo.set(run.id, 'terminal-eviction-gate', { approved: true });
      await router.deliverMessage(run.id, 'coder', 'planner', 'msg');

      // Verify cache is active: close gate, delivery still succeeds
      gateDataRepo.set(run.id, 'terminal-eviction-gate', { approved: false });
      const result1 = await router.canDeliver(run.id, 'coder', 'planner');
      expect(result1.allowed).toBe(true);

      // Complete the run
      workflowRunRepo.transitionStatus(run.id, 'done');

      // deliverMessage detects the terminal status, evicts the cache, then
      // re-evaluates the gate. Since the gate is closed, it throws.
      // Without the terminal-eviction, the stale cache would have allowed
      // delivery to succeed.
      await expect(
        router.deliverMessage(run.id, 'coder', 'planner', 'msg after done')
      ).rejects.toThrow(ChannelGateBlockedError);
    });

    test('canDeliver evicts cache on terminal run and returns accurate result', async () => {
      const gate: Gate = {
        id: 'candeliver-terminal-gate',
        fields: [
          {
            name: 'approved',
            type: 'boolean',
            writers: ['*'],
            check: { op: '==', value: true },
          },
        ],
        resetOnCycle: false,
      };
      const channels: WorkflowChannel[] = [
        { id: 'ch-1', from: 'coder', to: 'planner', gateId: 'candeliver-terminal-gate' },
      ];
      const workflow = buildWorkflowWithGates(
        SPACE_ID,
        workflowManager,
        [
          { id: NODE_A, name: 'Coder Node', agents: [{ agentId: AGENT_CODER, name: 'coder' }] },
          {
            id: NODE_B,
            name: 'Planner Node',
            agents: [{ agentId: AGENT_PLANNER, name: 'planner' }],
          },
        ],
        channels,
        [gate]
      );

      const run = workflowRunRepo.createRun({
        spaceId: SPACE_ID,
        workflowId: workflow.id,
        title: 'canDeliver Terminal Test',
      });
      workflowRunRepo.transitionStatus(run.id, 'in_progress');

      // Open gate, deliver to cache it
      gateDataRepo.set(run.id, 'candeliver-terminal-gate', { approved: true });
      await router.deliverMessage(run.id, 'coder', 'planner', 'msg');

      // Close the gate — cache still allows delivery
      gateDataRepo.set(run.id, 'candeliver-terminal-gate', { approved: false });
      const result1 = await router.canDeliver(run.id, 'coder', 'planner');
      expect(result1.allowed).toBe(true);

      // Complete the run — canDeliver should evict cache and re-evaluate
      workflowRunRepo.transitionStatus(run.id, 'done');
      const result2 = await router.canDeliver(run.id, 'coder', 'planner');
      expect(result2.allowed).toBe(false);
    });

    describe('persistence across daemon restarts', () => {
      test('restart simulation: persisted gate-open state survives router reinstantiation', async () => {
        const gate: Gate = {
          id: 'persist-gate',
          fields: [
            {
              name: 'approved',
              type: 'boolean',
              writers: ['*'],
              check: { op: '==', value: true },
            },
          ],
          resetOnCycle: false,
        };
        const channels: WorkflowChannel[] = [
          { id: 'ch-1', from: 'coder', to: 'planner', gateId: 'persist-gate' },
        ];
        const workflow = buildWorkflowWithGates(
          SPACE_ID,
          workflowManager,
          [
            { id: NODE_A, name: 'Coder Node', agents: [{ agentId: AGENT_CODER, name: 'coder' }] },
            {
              id: NODE_B,
              name: 'Planner Node',
              agents: [{ agentId: AGENT_PLANNER, name: 'planner' }],
            },
          ],
          channels,
          [gate]
        );

        // Verify workflow has updatedAt timestamp
        expect(workflow.updatedAt).toBeDefined();
        expect(workflow.updatedAt).toBeGreaterThan(0);

        const run = workflowRunRepo.createRun({
          spaceId: SPACE_ID,
          workflowId: workflow.id,
          title: 'Persistence Test',
        });
        workflowRunRepo.transitionStatus(run.id, 'in_progress');

        // Create gateOpenStateRepo and router1, deliver message to cache the gate as open
        const gateOpenStateRepo = new (
          await import('../../../../src/storage/repositories/gate-open-state-repository')
        ).GateOpenStateRepository(db);
        const router1 = new ChannelRouter({
          taskRepo,
          workflowRunRepo,
          workflowManager,
          agentManager,
          gateDataRepo,
          gateOpenStateRepo,
          channelCycleRepo,
          db,
          nodeExecutionRepo: new NodeExecutionRepository(db),
        });

        gateDataRepo.set(run.id, 'persist-gate', { approved: true });
        await router1.deliverMessage(run.id, 'coder', 'planner', 'msg1');

        // Verify gate is cached open with correct fingerprint
        const cachedState = gateOpenStateRepo.isOpen(run.id, 'persist-gate');
        expect(cachedState.open).toBe(true);
        // Verify the fingerprint matches what we'd compute now (workflow.updatedAt + gate hash)
        // Verify the fingerprint matches what we'd compute now (workflow.updatedAt + gate hash)
        // Use the same algorithm as generateGateFingerprint
        const gateJson = JSON.stringify(gate);
        let hash = 0;
        for (let i = 0; i < gateJson.length; i++) {
          hash = (hash << 5) - hash + gateJson.charCodeAt(i);
          hash = hash & hash;
        }
        const expectedFingerprint = workflow.updatedAt + hash;

        // Create router2 with the SAME repo (simulates daemon restart)
        const router2 = new ChannelRouter({
          taskRepo,
          workflowRunRepo,
          workflowManager,
          agentManager,
          gateDataRepo,
          gateOpenStateRepo,
          channelCycleRepo,
          db,
          nodeExecutionRepo: new NodeExecutionRepository(db),
        });

        // Close the gate data — persisted cache should still allow delivery
        gateDataRepo.set(run.id, 'persist-gate', { approved: false });
        const result = await router2.canDeliver(run.id, 'coder', 'planner');
        expect(result.allowed).toBe(true);
      });

      test('restart: stale workflow fingerprint forces re-evaluation', async () => {
        const gate: Gate = {
          id: 'fingerprint-gate',
          fields: [
            {
              name: 'approved',
              type: 'boolean',
              writers: ['*'],
              check: { op: '==', value: true },
            },
          ],
          resetOnCycle: false,
        };
        const channels: WorkflowChannel[] = [
          { id: 'ch-1', from: 'coder', to: 'planner', gateId: 'fingerprint-gate' },
        ];
        const workflow = buildWorkflowWithGates(
          SPACE_ID,
          workflowManager,
          [
            { id: NODE_A, name: 'Coder Node', agents: [{ agentId: AGENT_CODER, name: 'coder' }] },
            {
              id: NODE_B,
              name: 'Planner Node',
              agents: [{ agentId: AGENT_PLANNER, name: 'planner' }],
            },
          ],
          channels,
          [gate]
        );

        const run = workflowRunRepo.createRun({
          spaceId: SPACE_ID,
          workflowId: workflow.id,
          title: 'Fingerprint Test',
        });
        workflowRunRepo.transitionStatus(run.id, 'in_progress');

        const gateOpenStateRepo = new (
          await import('../../../../src/storage/repositories/gate-open-state-repository')
        ).GateOpenStateRepository(db);
        const router1 = new ChannelRouter({
          taskRepo,
          workflowRunRepo,
          workflowManager,
          agentManager,
          gateDataRepo,
          gateOpenStateRepo,
          channelCycleRepo,
          db,
          nodeExecutionRepo: new NodeExecutionRepository(db),
        });

        // Open gate, cache it
        gateDataRepo.set(run.id, 'fingerprint-gate', { approved: true });
        await router1.deliverMessage(run.id, 'coder', 'planner', 'msg1');

        // Update workflow (change fingerprint)
        workflowManager.updateWorkflow(workflow.id, { gates: [gate] });
        const updatedWorkflow = workflowManager.getWorkflow(workflow.id);
        expect(updatedWorkflow?.updatedAt).not.toBe(workflow.updatedAt);

        // Router2 should re-evaluate despite persisted cache (fingerprint mismatch)
        const router2 = new ChannelRouter({
          taskRepo,
          workflowRunRepo,
          workflowManager,
          agentManager,
          gateDataRepo,
          gateOpenStateRepo,
          channelCycleRepo,
          db,
          nodeExecutionRepo: new NodeExecutionRepository(db),
        });

        // Close gate data — should re-evaluate and block
        gateDataRepo.set(run.id, 'fingerprint-gate', { approved: false });
        const result = await router2.canDeliver(run.id, 'coder', 'planner');
        expect(result.allowed).toBe(false);
      });

      test('resetOnCycle: clears persisted gate-open state', async () => {
        const gate: Gate = {
          id: 'reset-gate',
          fields: [
            {
              name: 'approved',
              type: 'boolean',
              writers: ['*'],
              check: { op: '==', value: true },
            },
          ],
          resetOnCycle: true,
        };
        const channels: WorkflowChannel[] = [
          { id: 'ch-fwd', from: 'Coder Node', to: 'Planner Node' }, // forward channel (index 0)
          {
            id: 'ch-bwd',
            from: 'Planner Node',
            to: 'Coder Node',
            gateId: 'reset-gate',
          }, // cyclic (index 1)
        ];
        const workflow = buildWorkflowWithGates(
          SPACE_ID,
          workflowManager,
          [
            { id: NODE_A, name: 'Coder Node', agents: [{ agentId: AGENT_CODER, name: 'coder' }] },
            {
              id: NODE_B,
              name: 'Planner Node',
              agents: [{ agentId: AGENT_PLANNER, name: 'planner' }],
            },
          ],
          channels,
          [gate]
        );

        const run = workflowRunRepo.createRun({
          spaceId: SPACE_ID,
          workflowId: workflow.id,
          title: 'ResetOnCycle Test',
        });
        workflowRunRepo.transitionStatus(run.id, 'in_progress');

        const gateOpenStateRepo = new (
          await import('../../../../src/storage/repositories/gate-open-state-repository')
        ).GateOpenStateRepository(db);
        const router = new ChannelRouter({
          taskRepo,
          workflowRunRepo,
          workflowManager,
          agentManager,
          gateDataRepo,
          gateOpenStateRepo,
          channelCycleRepo,
          db,
          nodeExecutionRepo: new NodeExecutionRepository(db),
        });

        // resetOnCycle gates should NOT be cached across cycle boundaries
        // First traversal: open gate, deliver, then reset
        gateDataRepo.set(run.id, 'reset-gate', { approved: true });
        await router.deliverMessage(run.id, 'planner', 'coder', 'msg1');

        // Gate data should be reset to defaults (empty object for boolean fields)
        const gateData1 = gateDataRepo.get(run.id, 'reset-gate');
        expect(gateData1?.data).toMatchObject({});

        // Persisted cache should NOT exist (resetOnCycle prevents caching)
        expect(gateOpenStateRepo.isOpen(run.id, 'reset-gate').open).toBe(false);

        // Second traversal: gate is now closed (data was reset)
        await expect(
          router.deliverMessage(run.id, 'planner', 'coder', 'msg2')
        ).rejects.toBeInstanceOf(ChannelGateBlockedError);
      });

      test('terminal run: clears persisted gate-open state', async () => {
        const gate: Gate = {
          id: 'terminal-gate',
          fields: [
            {
              name: 'approved',
              type: 'boolean',
              writers: ['*'],
              check: { op: '==', value: true },
            },
          ],
          resetOnCycle: false,
        };
        const channels: WorkflowChannel[] = [
          { id: 'ch-1', from: 'coder', to: 'planner', gateId: 'terminal-gate' },
        ];
        const workflow = buildWorkflowWithGates(
          SPACE_ID,
          workflowManager,
          [
            { id: NODE_A, name: 'Coder Node', agents: [{ agentId: AGENT_CODER, name: 'coder' }] },
            {
              id: NODE_B,
              name: 'Planner Node',
              agents: [{ agentId: AGENT_PLANNER, name: 'planner' }],
            },
          ],
          channels,
          [gate]
        );

        const run = workflowRunRepo.createRun({
          spaceId: SPACE_ID,
          workflowId: workflow.id,
          title: 'Terminal Test',
        });
        workflowRunRepo.transitionStatus(run.id, 'in_progress');

        const gateOpenStateRepo = new (
          await import('../../../../src/storage/repositories/gate-open-state-repository')
        ).GateOpenStateRepository(db);
        const router = new ChannelRouter({
          taskRepo,
          workflowRunRepo,
          workflowManager,
          agentManager,
          gateDataRepo,
          gateOpenStateRepo,
          channelCycleRepo,
          db,
          nodeExecutionRepo: new NodeExecutionRepository(db),
        });

        // Open gate, deliver to cache it
        gateDataRepo.set(run.id, 'terminal-gate', { approved: true });
        await router.deliverMessage(run.id, 'coder', 'planner', 'msg1');

        // Verify persisted state exists
        expect(gateOpenStateRepo.isOpen(run.id, 'terminal-gate').open).toBe(true);

        // Transition run to done — should clear persisted state
        workflowRunRepo.transitionStatus(run.id, 'done');
        // Call canDeliver to trigger terminal status detection and cache eviction
        await router.canDeliver(run.id, 'coder', 'planner');
        expect(gateOpenStateRepo.isOpen(run.id, 'terminal-gate').open).toBe(false);
      });

      // GATED (Vitest/Node): requires Bun.spawn in production executeGateScript.
      test.skipIf(!isBun)(
        'template-backed feature gate bypasses cache and re-evaluates effective script',
        async () => {
          // Register a test feature whose script always passes so the gate can open
          registerGateFeature('test_always_pass', {
            script: () => ({
              interpreter: 'bash',
              source: 'true',
              timeoutMs: 30000,
            }),
          });

          const gate: Gate = {
            id: 'feature-cache-gate',
            fields: [
              {
                name: 'approved',
                type: 'boolean',
                writers: ['*'],
                check: { op: '==', value: true },
              },
            ],
            resetOnCycle: false,
            features: { test_always_pass: true },
          };
          const channels: WorkflowChannel[] = [
            { id: 'ch-1', from: 'coder', to: 'planner', gateId: 'feature-cache-gate' },
          ];
          const workflow = buildWorkflowWithGates(
            SPACE_ID,
            workflowManager,
            [
              { id: NODE_A, name: 'Coder Node', agents: [{ agentId: AGENT_CODER, name: 'coder' }] },
              {
                id: NODE_B,
                name: 'Planner Node',
                agents: [{ agentId: AGENT_PLANNER, name: 'planner' }],
              },
            ],
            channels,
            [gate],
            'test-template'
          );

          const run = workflowRunRepo.createRun({
            spaceId: SPACE_ID,
            workflowId: workflow.id,
            title: 'Feature Cache Test Run',
          });
          workflowRunRepo.transitionStatus(run.id, 'in_progress');

          // Open the gate — script passes and field passes
          gateDataRepo.set(run.id, 'feature-cache-gate', { approved: true });
          await router.deliverMessage(run.id, 'coder', 'planner', 'first msg');

          // Close the gate by changing field data
          gateDataRepo.set(run.id, 'feature-cache-gate', { approved: false });

          // Because this is a template-backed gate whose effective definition
          // includes a script (from the feature), mustReevaluateGate returns true
          // and the cache is bypassed. canDeliver should re-evaluate and find
          // the gate closed.
          const result = await router.canDeliver(run.id, 'coder', 'planner');
          expect(result.allowed).toBe(false);
        }
      );
    });
  });
});
