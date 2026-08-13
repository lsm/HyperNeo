/**
 * ChannelRouter Unit Tests
 *
 * Covers ungated channel routing:
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
 */

import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { Database as BunDatabase } from '../../../../src/storage/sqlite-compat';
import { runMigrations } from '../../../../src/storage/schema/index.ts';
import { SpaceWorkflowRepository } from '../../../../src/storage/repositories/space-workflow-repository.ts';
import { SpaceWorkflowRunRepository } from '../../../../src/storage/repositories/space-workflow-run-repository.ts';
import { SpaceTaskRepository } from '../../../../src/storage/repositories/space-task-repository.ts';
import { SpaceAgentRepository } from '../../../../src/storage/repositories/space-agent-repository.ts';
import { ChannelCycleRepository } from '../../../../src/storage/repositories/channel-cycle-repository.ts';
import { NodeExecutionRepository } from '../../../../src/storage/repositories/node-execution-repository.ts';
import { SpaceAgentManager } from '../../../../src/lib/space/managers/space-agent-manager.ts';
import { SpaceWorkflowManager } from '../../../../src/lib/space/managers/space-workflow-manager.ts';
import {
  ChannelRouter,
  ActivationError,
} from '../../../../src/lib/space/runtime/channel-router.ts';
import {
  MissingWorkflowAgentError,
  PermanentSpawnError,
} from '../../../../src/lib/space/runtime/workflow-node-execution-validation.ts';
import type { SpaceWorkflow, WorkflowChannel } from '@hyperneo/shared';
import { InternalEventBus } from '../../../../src/lib/internal-event-bus.ts';
import type { DaemonInternalEventMap } from '../../../../src/lib/internal-event-bus.ts';

// ---------------------------------------------------------------------------
// DB helpers
// ---------------------------------------------------------------------------

function makeDb(): BunDatabase {
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

describe('ChannelRouter', () => {
  let db: BunDatabase;

  let taskRepo: SpaceTaskRepository;
  let workflowRunRepo: SpaceWorkflowRunRepository;
  let workflowManager: SpaceWorkflowManager;
  let agentManager: SpaceAgentManager;
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
      channelCycleRepo,
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
    });

    test('throws an actionable MissingWorkflowAgentError (not a raw FK error) when a slot references a deleted agent', async () => {
      const workflow = buildWorkflow(SPACE_ID, workflowManager, [
        { id: NODE_A, name: 'Coding', agentId: AGENT_CODER },
        { id: NODE_B, name: 'Review', agentId: AGENT_CUSTOM },
      ]);
      const run = workflowRunRepo.createRun({
        spaceId: SPACE_ID,
        workflowId: workflow.id,
        title: 'Stale Agent Activation',
      });
      workflowRunRepo.transitionStatus(run.id, 'in_progress');

      db.prepare(`DELETE FROM space_agents WHERE id = ?`).run(AGENT_CUSTOM);

      let caught: unknown;
      try {
        await router.activateNode(run.id, NODE_B);
      } catch (err) {
        caught = err;
      }

      expect(caught).toBeInstanceOf(MissingWorkflowAgentError);
      const message = (caught as MissingWorkflowAgentError).message;
      expect(message).toContain(run.id);
      expect(message).toContain('Review');
      expect(message).toContain(AGENT_CUSTOM);
      expect(message).not.toMatch(/FOREIGN KEY/i);
      expect(new NodeExecutionRepository(db).listByNode(run.id, NODE_B)).toHaveLength(0);
    });

    test('slot-targeted activation succeeds even when a sibling slot references a deleted agent', async () => {
      const workflow = buildWorkflow(SPACE_ID, workflowManager, [
        {
          id: NODE_A,
          name: 'Review Team',
          agents: [
            { agentId: AGENT_CODER, name: 'coder-slot' },
            { agentId: AGENT_CUSTOM, name: 'custom-slot' },
          ],
        },
        { id: NODE_B, name: 'End', agentId: AGENT_PLANNER },
      ]);
      const run = workflowRunRepo.createRun({
        spaceId: SPACE_ID,
        workflowId: workflow.id,
        title: 'Slot Targeted',
      });
      workflowRunRepo.transitionStatus(run.id, 'in_progress');

      db.prepare(`DELETE FROM space_agents WHERE id = ?`).run(AGENT_CUSTOM);

      await router.activateNode(run.id, NODE_A, { targetAgentName: 'coder-slot' });

      const execs = new NodeExecutionRepository(db).listByNode(run.id, NODE_A);
      expect(execs.map((e) => e.agentName)).toContain('coder-slot');
      expect(execs.map((e) => e.agentName)).not.toContain('custom-slot');
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

    test('lazy activation reads the PINNED node definition, not a later head edit (read cutover)', async () => {
      const workflow = buildWorkflow(SPACE_ID, workflowManager, [
        {
          id: NODE_A,
          name: 'Multi Agent Node',
          agents: [{ agentId: AGENT_CODER, name: 'coder-slot' }],
        },
        { id: 'node-end', name: 'End Node', agentId: AGENT_CUSTOM },
      ]);

      const raw = workflowManager.getWorkflowForRunStart(workflow.id)!.rawWorkflow;
      const run = workflowRunRepo.createPinnedRun({
        spaceId: SPACE_ID,
        workflowId: workflow.id,
        title: 'Pinned Run',
        rawWorkflow: raw,
      });
      workflowRunRepo.transitionStatus(run.id, 'in_progress');

      const head = workflowManager.getWorkflow(workflow.id)!;
      workflowManager.updateWorkflow(workflow.id, {
        nodes: head.nodes.map((n) =>
          n.id === NODE_A
            ? {
                ...n,
                agents: [...(n.agents ?? []), { agentId: AGENT_PLANNER, name: 'planner-slot' }],
              }
            : n
        ),
      });
      expect(
        workflowManager.getWorkflow(workflow.id)!.nodes.find((n) => n.id === NODE_A)!.agents
      ).toHaveLength(2);

      await router.activateNode(run.id, NODE_A);
      const slots = new NodeExecutionRepository(db)
        .listByNode(run.id, NODE_A)
        .map((e) => e.agentName);
      expect(slots).toEqual(['coder-slot']);
      expect(slots).not.toContain('planner-slot');
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

      expect(secondResult).toHaveLength(1);
      expect(secondResult[0].id).toBe(firstResult[0].id);

      const allTasks = taskRepo.listByWorkflowRun(run.id);
      expect(allTasks).toHaveLength(1);
    });

    test('targetAgentName creates a missing slot even when a sibling slot is active', async () => {
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

      await router.activateNode(run.id, NODE_A);
      const nodeExecutionRepo = new NodeExecutionRepository(db);
      expect(nodeExecutionRepo.listByNode(run.id, NODE_A)).toHaveLength(2);

      db.prepare(
        `DELETE FROM node_executions WHERE workflow_run_id = ? AND workflow_node_id = ? AND agent_name = ?`
      ).run(run.id, NODE_A, 'planner-slot');
      expect(nodeExecutionRepo.listByNode(run.id, NODE_A)).toHaveLength(1);

      await router.activateNode(run.id, NODE_A, { targetAgentName: 'planner-slot' });
      const after = nodeExecutionRepo.listByNode(run.id, NODE_A);
      expect(after.some((e) => e.agentName === 'planner-slot')).toBe(true);
      expect(after).toHaveLength(2);
    });

    test('targetAgentName does not short-circuit on a terminal target slot', async () => {
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
        title: 'Terminal Target Run',
      });
      workflowRunRepo.transitionStatus(run.id, 'in_progress');
      await router.activateNode(run.id, NODE_A);
      const nodeExecutionRepo = new NodeExecutionRepository(db);
      const planner = nodeExecutionRepo
        .listByNode(run.id, NODE_A)
        .find((e) => e.agentName === 'planner-slot')!;
      nodeExecutionRepo.update(planner.id, {
        status: 'cancelled',
        agentSessionId: null,
        completedAt: Date.now(),
      });

      await router.activateNode(run.id, NODE_A, { targetAgentName: 'planner-slot' });
      const after = nodeExecutionRepo
        .listByNode(run.id, NODE_A)
        .find((e) => e.agentName === 'planner-slot')!;
      expect(after.status).not.toBe('cancelled');
    });

    test('targetAgentName creates only the requested slot, not its siblings', async () => {
      const workflow = buildWorkflow(SPACE_ID, workflowManager, [
        {
          id: NODE_A,
          name: 'Multi Agent Node',
          agents: [
            { agentId: AGENT_CODER, name: 'coder-slot' },
            { agentId: AGENT_PLANNER, name: 'planner-slot' },
            { agentId: AGENT_CUSTOM, name: 'qa-slot' },
          ],
        },
      ]);
      const run = workflowRunRepo.createRun({
        spaceId: SPACE_ID,
        workflowId: workflow.id,
        title: 'Sibling Spawn Run',
      });
      workflowRunRepo.transitionStatus(run.id, 'in_progress');
      await router.activateNode(run.id, NODE_A);
      const nodeExecutionRepo = new NodeExecutionRepository(db);
      expect(nodeExecutionRepo.listByNode(run.id, NODE_A)).toHaveLength(3);

      db.prepare(
        `DELETE FROM node_executions WHERE workflow_run_id = ? AND workflow_node_id = ? AND agent_name IN (?, ?)`
      ).run(run.id, NODE_A, 'planner-slot', 'qa-slot');
      expect(nodeExecutionRepo.listByNode(run.id, NODE_A)).toHaveLength(1);

      await router.activateNode(run.id, NODE_A, { targetAgentName: 'planner-slot' });
      const after = nodeExecutionRepo.listByNode(run.id, NODE_A);
      expect(after.some((e) => e.agentName === 'planner-slot')).toBe(true);
      expect(after.some((e) => e.agentName === 'qa-slot')).toBe(false);
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

      const firstTasks = await router.activateNode(run.id, NODE_A);
      expect(firstTasks).toHaveLength(1);

      taskRepo.updateTask(firstTasks[0].id, { status: 'cancelled' });

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
        channelCycleRepo,
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
      expect(result.activatedTasks).toBeDefined();
      expect(result.activatedTasks).toHaveLength(1);
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

      await router.activateNode(run.id, NODE_B);
      const beforeCount = taskRepo.listByWorkflowRun(run.id).length;

      const result = await router.deliverMessage(run.id, 'coder', 'planner', 'hi again');

      expect(result.activatedTasks).toBeUndefined();

      const afterCount = taskRepo.listByWorkflowRun(run.id).length;
      expect(afterCount).toBe(beforeCount);
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

      const result = await router.deliverMessage(run.id, 'coder', 'Receiver Node', 'broadcast');

      expect(result.targetNodeId).toBe(NODE_B);
      expect(result.isFanOut).toBe(true);
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

      const result = await router.deliverMessage(run.id, 'coder', 'planner', 'hey planner');

      expect(result.targetNodeId).toBe(NODE_A);
      expect(result.isFanOut).toBe(false);
    });

    // -----------------------------------------------------------------------
    // Cyclic channels — rate-based dead-loop detection
    // -----------------------------------------------------------------------

    test('cyclic channel: records a traversal event on successful delivery', async () => {
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

      await router.deliverMessage(run.id, 'planner', 'coder', 'message 1');
      expect(channelCycleRepo.countRecentCycleEvents(run.id, 1)).toBe(1);

      for (const t of taskRepo.listByWorkflowRun(run.id)) {
        taskRepo.updateTask(t.id, { status: 'cancelled' });
      }

      await router.deliverMessage(run.id, 'planner', 'coder', 'message 2');
      expect(channelCycleRepo.countRecentCycleEvents(run.id, 1)).toBe(2);
    });

    test('cyclic channel: a long review spread over time never trips (lifetime cap no longer blocks)', async () => {
      // Reproduces the PR #2473 / task #942 false-block: many review rounds on
      // the same cyclic channel (here 11 — over the old maxCycles of 5), but
      // spread out over hours. The retired lifetime cap blocked this; the
      // rate-based detector must allow it.
      const channels: WorkflowChannel[] = [
        { id: 'ch-fwd', from: 'Sender', to: 'Receiver' },
        { id: 'ch-bwd', from: 'Receiver', to: 'Sender', maxCycles: 5 },
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
        title: 'Long Review Run',
      });
      workflowRunRepo.transitionStatus(run.id, 'in_progress');

      // 11 round-trips, 20 minutes apart. None cluster inside any 5-minute
      // window, so the rolling rate stays well below the threshold (15).
      const now = Date.now();
      for (let i = 1; i <= 11; i++) {
        channelCycleRepo.recordCycleEvent(run.id, 1, now - i * 20 * 60 * 1000);
      }
      expect(channelCycleRepo.countRecentCycleEvents(run.id, 1, now)).toBe(0);

      // Delivery proceeds — no false block.
      const delivered = await router.deliverMessage(run.id, 'planner', 'coder', 'round 12');
      expect(delivered.runId).toBe(run.id);
    });

    test('cyclic channel: throws ActivationError when a tight ping-pong trips the dead-loop threshold', async () => {
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
        title: 'Dead-Loop Run',
      });
      workflowRunRepo.transitionStatus(run.id, 'in_progress');

      // 15 rapid traversals within the window → the next send trips.
      const now = Date.now();
      for (let i = 0; i < 15; i++) channelCycleRepo.recordCycleEvent(run.id, 1, now - i * 1000);

      await expect(
        router.deliverMessage(run.id, 'planner', 'coder', 'runaway ping-pong')
      ).rejects.toBeInstanceOf(ActivationError);
      await expect(
        router.deliverMessage(run.id, 'planner', 'coder', 'runaway ping-pong')
      ).rejects.toThrow(/dead loop/);
    });

    test('cyclic channel: dead-loop trip surfaces a space.workflowRun.deadLoop event', async () => {
      const bus = new InternalEventBus<DaemonInternalEventMap>();
      const deadLoopEvents: DaemonInternalEventMap['space.workflowRun.deadLoop'][] = [];
      const unsub = bus.subscribe(
        'space.workflowRun.deadLoop',
        (e) => {
          deadLoopEvents.push(e);
        },
        { subscriberName: 'test-collector:space.workflowRun.deadLoop' }
      );

      const routerWithBus = new ChannelRouter({
        taskRepo,
        workflowRunRepo,
        workflowManager,
        agentManager,
        channelCycleRepo,
        nodeExecutionRepo: new NodeExecutionRepository(db),
        internalEventBus: bus,
      });

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
        title: 'Surfacing Run',
      });
      workflowRunRepo.transitionStatus(run.id, 'in_progress');

      const now = Date.now();
      for (let i = 0; i < 15; i++) channelCycleRepo.recordCycleEvent(run.id, 1, now - i * 1000);

      await expect(
        routerWithBus.deliverMessage(run.id, 'planner', 'coder', 'runaway')
      ).rejects.toThrow(/dead loop/);

      expect(deadLoopEvents).toHaveLength(1);
      const evt = deadLoopEvents[0];
      expect(evt.spaceId).toBe(SPACE_ID);
      expect(evt.fromAgent).toBe('planner');
      expect(evt.toTarget).toBe('coder');
      expect(evt.channelIndex).toBe(1);
      expect(evt.recentCount).toBe(15);
      expect(evt.threshold).toBe(15);

      unsub();
    });

    test('cyclic channel: repeated blocked sends dedupe the dead-loop event within the window', async () => {
      const bus = new InternalEventBus<DaemonInternalEventMap>();
      const deadLoopEvents: DaemonInternalEventMap['space.workflowRun.deadLoop'][] = [];
      const unsub = bus.subscribe(
        'space.workflowRun.deadLoop',
        (e) => {
          deadLoopEvents.push(e);
        },
        { subscriberName: 'test-collector:space.workflowRun.deadLoop:dedupe' }
      );

      const routerWithBus = new ChannelRouter({
        taskRepo,
        workflowRunRepo,
        workflowManager,
        agentManager,
        channelCycleRepo,
        nodeExecutionRepo: new NodeExecutionRepository(db),
        internalEventBus: bus,
      });

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
        title: 'Dedupe Run',
      });
      workflowRunRepo.transitionStatus(run.id, 'in_progress');

      const now = Date.now();
      for (let i = 0; i < 15; i++) channelCycleRepo.recordCycleEvent(run.id, 1, now - i * 1000);

      // A retrying agent attempts the blocked send several times in a row.
      for (let i = 0; i < 3; i++) {
        await expect(
          routerWithBus.deliverMessage(run.id, 'planner', 'coder', 'retry')
        ).rejects.toThrow(/dead loop/);
      }

      // Only the first trip surfaces — the UI is not spammed.
      expect(deadLoopEvents).toHaveLength(1);

      unsub();
    });

    test('cyclic channel: a new loop after a human-touch reset surfaces a fresh notification', async () => {
      // Dedupe is cleared when a cyclic send is allowed again, so a distinct
      // second incident after explicit human intervention is still surfaced.
      const bus = new InternalEventBus<DaemonInternalEventMap>();
      const deadLoopEvents: DaemonInternalEventMap['space.workflowRun.deadLoop'][] = [];
      const unsub = bus.subscribe(
        'space.workflowRun.deadLoop',
        (e) => {
          deadLoopEvents.push(e);
        },
        { subscriberName: 'test-collector:space.workflowRun.deadLoop:reset-reloop' }
      );

      const routerWithBus = new ChannelRouter({
        taskRepo,
        workflowRunRepo,
        workflowManager,
        agentManager,
        channelCycleRepo,
        nodeExecutionRepo: new NodeExecutionRepository(db),
        internalEventBus: bus,
      });

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
        title: 'Reset Reloop Run',
      });
      workflowRunRepo.transitionStatus(run.id, 'in_progress');

      // First incident: block + notify.
      const t0 = Date.now();
      for (let i = 0; i < 15; i++) channelCycleRepo.recordCycleEvent(run.id, 1, t0 - i * 1000);
      await expect(
        routerWithBus.deliverMessage(run.id, 'planner', 'coder', 'first loop')
      ).rejects.toThrow(/dead loop/);
      expect(deadLoopEvents).toHaveLength(1);

      // Human touch clears the loop; the next send is allowed (and drops dedupe).
      channelCycleRepo.resetAllForRun(run.id);
      const delivered = await routerWithBus.deliverMessage(
        run.id,
        'planner',
        'coder',
        'after reset'
      );
      expect(delivered.runId).toBe(run.id);

      // A second, distinct rapid loop must surface a FRESH notification.
      const t1 = Date.now();
      for (let i = 0; i < 15; i++) channelCycleRepo.recordCycleEvent(run.id, 1, t1 - i * 1000);
      await expect(
        routerWithBus.deliverMessage(run.id, 'planner', 'coder', 'second loop')
      ).rejects.toThrow(/dead loop/);
      expect(deadLoopEvents).toHaveLength(2);

      unsub();
    });

    test('cyclic channel: human touch (resetAllForRun) lifts a dead-loop block', async () => {
      // Router-level coverage of the reset-on-human-touch contract — the repo
      // layer is covered separately in channel-cycle-repository.test.ts.
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
        title: 'Reset Run',
      });
      workflowRunRepo.transitionStatus(run.id, 'in_progress');

      const now = Date.now();
      for (let i = 0; i < 15; i++) channelCycleRepo.recordCycleEvent(run.id, 1, now - i * 1000);

      // Blocked before the human touch.
      await expect(router.deliverMessage(run.id, 'planner', 'coder', 'blocked')).rejects.toThrow(
        /dead loop/
      );

      // Human touch resets the run's cycle state.
      channelCycleRepo.resetAllForRun(run.id);

      // After reset, delivery succeeds again (the block is lifted).
      const delivered = await router.deliverMessage(run.id, 'planner', 'coder', 'after reset');
      expect(delivered.runId).toBe(run.id);
    });

    test('non-cyclic channel: records no traversal event', async () => {
      const channels: WorkflowChannel[] = [
        {
          from: 'coder',
          to: 'planner',
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

      expect(channelCycleRepo.countRecentCycleEvents(run.id, 0)).toBe(0);
    });

    test('cyclic channel: a reservation persists when activation throws after reserve (self-healing)', async () => {
      // Reserve-before-activation: if activation fails AFTER the reservation
      // commits, one extra row remains. It biases safely toward blocking and
      // ages out after the window — pin this documented edge.
      const channels: WorkflowChannel[] = [
        { id: 'ch-fwd', from: 'Coding', to: 'Review' },
        { id: 'ch-bwd', from: 'Review', to: 'Coding' },
      ];
      const workflow = buildWorkflow(
        SPACE_ID,
        workflowManager,
        [
          { id: NODE_A, name: 'Coding', agents: [{ agentId: AGENT_CODER, name: 'coder' }] },
          { id: NODE_B, name: 'Review', agents: [{ agentId: AGENT_PLANNER, name: 'planner' }] },
        ],
        channels
      );
      const run = workflowRunRepo.createRun({
        spaceId: SPACE_ID,
        workflowId: workflow.id,
        title: 'Orphan Reservation Run',
      });
      workflowRunRepo.transitionStatus(run.id, 'in_progress');

      // Delete the target agent so activation throws AFTER the cyclic
      // reservation has already committed (target resolution still succeeds
      // because resolveNodeAgents does not validate agent existence).
      db.prepare(`DELETE FROM space_agents WHERE id = ?`).run(AGENT_CODER);

      expect(channelCycleRepo.countRecentCycleEvents(run.id, 1)).toBe(0);
      await expect(router.deliverMessage(run.id, 'planner', 'coder', 'orphan')).rejects.toThrow();
      // The reservation row persisted despite the activation failure.
      expect(channelCycleRepo.countRecentCycleEvents(run.id, 1)).toBe(1);
    });
  });

  // -------------------------------------------------------------------------
  // canDeliver
  // -------------------------------------------------------------------------

  describe('canDeliver', () => {
    test('open topology: always allowed when no channels declared', async () => {
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

      const result = await router.canDeliver(run.id, 'coder', 'planner');
      expect(result.allowed).toBe(true);
    });

    test('declared channel (no gate): always allowed', async () => {
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

    test('cyclic channel: blocked when a tight ping-pong trips the dead-loop threshold', async () => {
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
        title: 'Dead-Loop canDeliver Run',
      });
      workflowRunRepo.transitionStatus(run.id, 'in_progress');
      const now = Date.now();
      for (let i = 0; i < 15; i++) channelCycleRepo.recordCycleEvent(run.id, 1, now - i * 1000);

      const result = await router.canDeliver(run.id, 'planner', 'coder');
      expect(result.allowed).toBe(false);
      expect(result.reason).toMatch(/dead loop/);
    });

    test('cyclic channel: allowed below the dead-loop threshold', async () => {
      const channels: WorkflowChannel[] = [
        { id: 'ch-fwd', from: 'Node A', to: 'Node B' },
        { id: 'ch-bwd', from: 'Node B', to: 'Node A' },
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
        title: 'Below Threshold Run',
      });
      workflowRunRepo.transitionStatus(run.id, 'in_progress');
      const now = Date.now();
      // 14 recent traversals — one short of the threshold.
      for (let i = 0; i < 14; i++) channelCycleRepo.recordCycleEvent(run.id, 1, now - i * 1000);

      const result = await router.canDeliver(run.id, 'planner', 'coder');
      expect(result.allowed).toBe(true);
    });

    test('canDeliver is read-only: it never records a traversal event', async () => {
      // Locks the documented contract: canDeliver is a non-mutating query that
      // may prune out-of-window rows but must never INSERT. Seeds straddle the
      // window boundary so a regression that recorded on the query path would
      // shift the in-window count.
      const channels: WorkflowChannel[] = [
        { id: 'ch-fwd', from: 'Node A', to: 'Node B' },
        { id: 'ch-bwd', from: 'Node B', to: 'Node A' },
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
        title: 'Read-only canDeliver Run',
      });
      workflowRunRepo.transitionStatus(run.id, 'in_progress');

      const now = Date.now();
      const WINDOW = 5 * 60 * 1000;
      channelCycleRepo.recordCycleEvent(run.id, 1, now - 10_000); // well inside
      channelCycleRepo.recordCycleEvent(run.id, 1, now - (WINDOW - 1000)); // just inside the boundary
      channelCycleRepo.recordCycleEvent(run.id, 1, now - (WINDOW + 1000)); // just outside (pruned)
      const before = channelCycleRepo.countRecentCycleEvents(run.id, 1);
      expect(before).toBe(2); // the two in-window events

      // Repeated queries must not insert any new traversal.
      for (let i = 0; i < 5; i++) {
        const result = await router.canDeliver(run.id, 'planner', 'coder');
        expect(result.allowed).toBe(true);
      }

      expect(channelCycleRepo.countRecentCycleEvents(run.id, 1)).toBe(before);
    });

    test('non-cyclic channel: cycle count does not block delivery', async () => {
      const channels: WorkflowChannel[] = [
        {
          from: 'coder',
          to: 'planner',
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
      expect(result.allowed).toBe(true);
    });

    test('canDeliver: throws ActivationError when run not found', async () => {
      await expect(router.canDeliver('nonexistent-run', 'coder', 'planner')).rejects.toBeInstanceOf(
        ActivationError
      );
    });

    test('canDeliver: throws ActivationError when workflow not found', async () => {
      const workflow = buildWorkflow(SPACE_ID, workflowManager, [
        { id: NODE_A, name: 'Node A', agentId: AGENT_CODER },
      ]);
      const run = workflowRunRepo.createRun({
        spaceId: SPACE_ID,
        workflowId: workflow.id,
        title: 'Orphaned Run',
      });
      workflowRunRepo.transitionStatus(run.id, 'in_progress');

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
});
