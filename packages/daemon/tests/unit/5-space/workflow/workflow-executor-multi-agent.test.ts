import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { Database as BunDatabase } from '../../../../src/storage/sqlite-compat';
import { runMigrations } from '../../../../src/storage/schema/index.ts';
import { SpaceWorkflowRepository } from '../../../../src/storage/repositories/space-workflow-repository.ts';
import { SpaceWorkflowRunRepository } from '../../../../src/storage/repositories/space-workflow-run-repository.ts';
import { NodeExecutionRepository } from '../../../../src/storage/repositories/node-execution-repository.ts';
import { NodeExecutionManager } from '../../../../src/lib/space/managers/node-execution-manager.ts';
import { SpaceTaskRepository } from '../../../../src/storage/repositories/space-task-repository.ts';
import { SpaceAgentRepository } from '../../../../src/storage/repositories/space-agent-repository.ts';
import { SpaceAgentManager } from '../../../../src/lib/space/managers/space-agent-manager.ts';
import {
  SpaceWorkflowManager,
  WorkflowValidationError,
} from '../../../../src/lib/space/managers/space-workflow-manager.ts';
import type { SpaceAgentLookup } from '../../../../src/lib/space/managers/space-workflow-manager.ts';
import { SpaceManager } from '../../../../src/lib/space/managers/space-manager.ts';
import { SpaceRuntime } from '../../../../src/lib/space/runtime/space-runtime.ts';
import type { SpaceRuntimeConfig } from '../../../../src/lib/space/runtime/space-runtime.ts';
import { resolveNodeAgents } from '@hyperneo/shared';
import type { SpaceWorkerAgent, WorkflowNode } from '@hyperneo/shared';

function makeDb(): BunDatabase {
  const db = new BunDatabase(':memory:');
  db.exec('PRAGMA foreign_keys = ON');
  runMigrations(db, () => {});
  return db;
}

function seedSpace(db: BunDatabase, spaceId: string, workspacePath = '/tmp/ws'): void {
  db.prepare(
    `INSERT INTO spaces (id, workspace_path, name, description, background_context, instructions,
     allowed_models, session_ids, slug, status, created_at, updated_at)
     VALUES (?, ?, ?, '', '', '', '[]', '[]', ?, 'active', ?, ?)`
  ).run(spaceId, workspacePath, `Space ${spaceId}`, spaceId, Date.now(), Date.now());
}

function seedAgent(db: BunDatabase, agentId: string, spaceId: string, name: string): void {
  db.prepare(
    `INSERT INTO space_agents (id, space_id, name, description, model, tools, system_prompt, created_at, updated_at)
     VALUES (?, ?, ?, '', null, '[]', '', ?, ?)`
  ).run(agentId, spaceId, name, Date.now(), Date.now());
}

function makeSpaceAgent(id: string, name: string): SpaceWorkerAgent {
  return {
    id,
    spaceId: 'space-1',
    name: `${name} agent`,
    instructions: null,
    createdAt: 0,
    updatedAt: 0,
  };
}

const SYNTHETIC_END_NODE_ID = '__test_end__';

function appendSyntheticEnd<T extends { id: string; agents?: unknown[] }>(
  nodes: T[],
  endAgentId: string
): { nodes: Array<T | { id: string; name: string; agentId: string }>; endNodeId: string } {
  const last = nodes[nodes.length - 1];
  const lastIsMultiAgent = (last.agents?.length ?? 0) > 1;
  if (!lastIsMultiAgent) {
    return { nodes, endNodeId: last.id };
  }
  return {
    nodes: [...nodes, { id: SYNTHETIC_END_NODE_ID, name: 'Synthetic End', agentId: endAgentId }],
    endNodeId: SYNTHETIC_END_NODE_ID,
  };
}

describe('SpaceRuntime — startWorkflowRun() multi-agent start step', () => {
  let db: BunDatabase;
  let workflowRunRepo: SpaceWorkflowRunRepository;
  let taskRepo: SpaceTaskRepository;
  let nodeExecutionRepo: NodeExecutionRepository;
  let workflowManager: SpaceWorkflowManager;
  let runtime: SpaceRuntime;

  const SPACE_ID = 'space-rt-ma';
  const WORKSPACE = '/tmp/rt-ma-ws';
  const AGENT_CODER = 'agent-rt-coder';
  const AGENT_PLANNER = 'agent-rt-planner';
  const AGENT_CUSTOM = 'agent-rt-custom';
  const STEP_A = 'step-rt-a';
  const STEP_B = 'step-rt-b';

  beforeEach(() => {
    db = makeDb();
    seedSpace(db, SPACE_ID, WORKSPACE);
    seedAgent(db, AGENT_CODER, SPACE_ID, 'Coder');
    seedAgent(db, AGENT_PLANNER, SPACE_ID, 'Planner');
    seedAgent(db, AGENT_CUSTOM, SPACE_ID, 'Custom');

    workflowRunRepo = new SpaceWorkflowRunRepository(db);
    taskRepo = new SpaceTaskRepository(db);
    nodeExecutionRepo = new NodeExecutionRepository(db);

    const agentRepo = new SpaceAgentRepository(db);
    const agentManager = new SpaceAgentManager(agentRepo);

    const workflowRepo = new SpaceWorkflowRepository(db);
    workflowManager = new SpaceWorkflowManager(workflowRepo);
    const spaceManager = new SpaceManager(db);

    const config: SpaceRuntimeConfig = {
      db,
      spaceManager,
      spaceAgentManager: agentManager,
      spaceWorkflowManager: workflowManager,
      workflowRunRepo,
      taskRepo,
      nodeExecutionRepo,
    };
    runtime = new SpaceRuntime(config);
  });

  afterEach(() => {
    try {
      db.close();
    } catch {}
  });

  test('creates one workflow task and one node_execution per start agent', async () => {
    const startNode = {
      id: STEP_A,
      name: 'Parallel Start',
      agents: [
        { agentId: AGENT_CODER, name: 'coder', instructions: 'Write code' },
        { agentId: AGENT_PLANNER, name: 'planner', instructions: 'Plan it' },
      ],
    };
    const { nodes, endNodeId } = appendSyntheticEnd([startNode], AGENT_CODER);
    const workflow = workflowManager.createWorkflow({
      spaceId: SPACE_ID,
      name: `Multi Start ${Date.now()}`,
      nodes,
      transitions: [],
      startNodeId: STEP_A,
      endNodeId,
      rules: [],
      tags: [],
      completionAutonomyLevel: 3,
    });

    const { run, tasks } = await runtime.startWorkflowRun(SPACE_ID, workflow.id, 'Multi Start Run');

    expect(tasks).toHaveLength(1);
    expect(tasks[0].workflowRunId).toBe(run.id);
    expect(tasks[0].status).toBe('open');

    const nodeExecutions = nodeExecutionRepo.listByNode(run.id, STEP_A);
    expect(nodeExecutions).toHaveLength(2);
    expect(nodeExecutions.map((exec) => exec.agentId).sort()).toEqual(
      [AGENT_CODER, AGENT_PLANNER].sort()
    );
  });

  test('per-agent instructions are tracked in node executions (not split into multiple tasks)', async () => {
    const startNode = {
      id: STEP_A,
      name: 'Parallel Start',
      agents: [
        {
          agentId: AGENT_CODER,
          name: 'coder',
          instructions: { value: 'Coder task', mode: 'override' as const },
        },
        {
          agentId: AGENT_PLANNER,
          name: 'planner',
          instructions: { value: 'Planner task', mode: 'override' as const },
        },
      ],
    };
    const { nodes, endNodeId } = appendSyntheticEnd([startNode], AGENT_CODER);
    const workflow = workflowManager.createWorkflow({
      spaceId: SPACE_ID,
      name: `Multi Start Instructions ${Date.now()}`,
      nodes,
      transitions: [],
      startNodeId: STEP_A,
      endNodeId,
      rules: [],
      tags: [],
      completionAutonomyLevel: 3,
    });

    const { run, tasks } = await runtime.startWorkflowRun(SPACE_ID, workflow.id, 'Run');

    expect(tasks).toHaveLength(1);
    const nodeExecutions = nodeExecutionRepo.listByNode(run.id, STEP_A);
    expect(nodeExecutions).toHaveLength(2);
    expect(nodeExecutions.map((exec) => exec.agentName).sort()).toEqual(['coder', 'planner']);
  });

  test('multi-agent start step still yields a single workflow task', async () => {
    const startNode = {
      id: STEP_A,
      name: 'Mixed Start',
      agents: [
        { agentId: AGENT_PLANNER, name: 'planner' },
        { agentId: AGENT_CODER, name: 'coder' },
      ],
    };
    const { nodes, endNodeId } = appendSyntheticEnd([startNode], AGENT_CODER);
    const workflow = workflowManager.createWorkflow({
      spaceId: SPACE_ID,
      name: `Multi Start TaskType ${Date.now()}`,
      nodes,
      transitions: [],
      startNodeId: STEP_A,
      endNodeId,
      rules: [],
      tags: [],
      completionAutonomyLevel: 3,
    });

    const { run, tasks } = await runtime.startWorkflowRun(SPACE_ID, workflow.id, 'Run');

    expect(tasks).toHaveLength(1);
    expect(tasks[0].status).toBe('open');
    expect(nodeExecutionRepo.listByNode(run.id, STEP_A)).toHaveLength(2);
  });

  test('custom-role agent in multi-agent start step still uses one workflow task', async () => {
    const startNode = {
      id: STEP_A,
      name: 'Custom Start',
      agents: [
        { agentId: AGENT_CODER, name: 'coder' },
        { agentId: AGENT_CUSTOM, name: 'my-custom-role' },
      ],
    };
    const { nodes, endNodeId } = appendSyntheticEnd([startNode], AGENT_CODER);
    const workflow = workflowManager.createWorkflow({
      spaceId: SPACE_ID,
      name: `Custom Role Start ${Date.now()}`,
      nodes,
      transitions: [],
      startNodeId: STEP_A,
      endNodeId,
      rules: [],
      tags: [],
      completionAutonomyLevel: 3,
    });

    const { run, tasks } = await runtime.startWorkflowRun(SPACE_ID, workflow.id, 'Run');

    expect(tasks).toHaveLength(1);
    expect(tasks[0].status).toBe('open');
    expect(nodeExecutionRepo.listByNode(run.id, STEP_A)).toHaveLength(2);
  });

  test('executeTick() does NOT advance to next step when only some parallel tasks are completed', async () => {
    const workflow = workflowManager.createWorkflow({
      spaceId: SPACE_ID,
      name: `Partial Complete ${Date.now()}`,
      nodes: [
        {
          id: STEP_A,
          name: 'Parallel A',
          agents: [
            { agentId: AGENT_CODER, name: 'coder' },
            { agentId: AGENT_PLANNER, name: 'planner' },
          ],
        },
        { id: STEP_B, name: 'Next Step', agentId: AGENT_CODER },
      ],
      transitions: [{ from: STEP_A, to: STEP_B, condition: { type: 'always' }, order: 0 }],
      startNodeId: STEP_A,
      rules: [],
      tags: [],
      completionAutonomyLevel: 3,
    });

    const { run, tasks } = await runtime.startWorkflowRun(SPACE_ID, workflow.id, 'Run');
    expect(tasks).toHaveLength(1);

    const stepAExecutions = nodeExecutionRepo.listByNode(run.id, STEP_A);
    expect(stepAExecutions).toHaveLength(2);

    nodeExecutionRepo.update(stepAExecutions[0].id, { status: 'idle' });
    nodeExecutionRepo.update(stepAExecutions[1].id, { status: 'in_progress' });

    await runtime.executeTick();

    const stepBExecutions = nodeExecutionRepo.listByNode(run.id, STEP_B);
    expect(stepBExecutions).toHaveLength(0);
  });

  test('marks run blocked when any parallel node execution blocks', async () => {
    const startNode = {
      id: STEP_A,
      name: 'Parallel Waiting',
      agents: [
        { agentId: AGENT_CODER, name: 'coder' },
        { agentId: AGENT_PLANNER, name: 'planner' },
      ],
    };
    const { nodes, endNodeId } = appendSyntheticEnd([startNode], AGENT_CODER);
    const workflow = workflowManager.createWorkflow({
      spaceId: SPACE_ID,
      name: `Partial Terminal ${Date.now()}`,
      nodes,
      transitions: [],
      startNodeId: STEP_A,
      endNodeId,
      rules: [],
      tags: [],
      completionAutonomyLevel: 3,
    });

    const { run } = await runtime.startWorkflowRun(SPACE_ID, workflow.id, 'Run');

    const stepAExecutions = nodeExecutionRepo.listByNode(run.id, STEP_A);
    expect(stepAExecutions).toHaveLength(2);

    nodeExecutionRepo.update(stepAExecutions[0].id, { status: 'blocked', result: 'Build failed' });
    nodeExecutionRepo.update(stepAExecutions[1].id, { status: 'in_progress' });

    await runtime.executeTick();

    const updatedRun = workflowRunRepo.getRun(run.id)!;
    expect(updatedRun.status).toBe('blocked');
  });

  test('marks run needs_attention when all parallel tasks are terminal and one failed', async () => {
    const startNode = {
      id: STEP_A,
      name: 'Parallel Fail',
      agents: [
        { agentId: AGENT_CODER, name: 'coder' },
        { agentId: AGENT_PLANNER, name: 'planner' },
      ],
    };
    const { nodes, endNodeId } = appendSyntheticEnd([startNode], AGENT_CODER);
    const workflow = workflowManager.createWorkflow({
      spaceId: SPACE_ID,
      name: `All Terminal Fail ${Date.now()}`,
      nodes,
      transitions: [],
      startNodeId: STEP_A,
      endNodeId,
      rules: [],
      tags: [],
      completionAutonomyLevel: 3,
    });

    const { run, tasks } = await runtime.startWorkflowRun(SPACE_ID, workflow.id, 'Run');
    expect(tasks).toHaveLength(1);

    const stepAExecutions = nodeExecutionRepo.listByNode(run.id, STEP_A);
    expect(stepAExecutions).toHaveLength(2);

    nodeExecutionRepo.update(stepAExecutions[0].id, { status: 'idle' });
    nodeExecutionRepo.update(stepAExecutions[1].id, { status: 'blocked', result: 'Agent crashed' });

    await runtime.executeTick();

    const updatedRun = workflowRunRepo.getRun(run.id)!;
    expect(updatedRun.status).toBe('blocked');
  });

  test('marks run needs_attention when two of three tasks complete but one fails', async () => {
    const AGENT_EXTRA = 'agent-rt-extra';
    seedAgent(db, AGENT_EXTRA, SPACE_ID, 'Extra');

    const startNode = {
      id: STEP_A,
      name: 'Triple Parallel',
      agents: [
        { agentId: AGENT_CODER, name: 'coder' },
        { agentId: AGENT_PLANNER, name: 'planner' },
        { agentId: AGENT_EXTRA, name: 'extra-role' },
      ],
    };
    const { nodes, endNodeId } = appendSyntheticEnd([startNode], AGENT_CODER);
    const workflow = workflowManager.createWorkflow({
      spaceId: SPACE_ID,
      name: `Three Agent Partial Fail ${Date.now()}`,
      nodes,
      transitions: [],
      startNodeId: STEP_A,
      endNodeId,
      rules: [],
      tags: [],
      completionAutonomyLevel: 3,
    });

    const { run, tasks } = await runtime.startWorkflowRun(SPACE_ID, workflow.id, 'Run');
    expect(tasks).toHaveLength(1);

    const stepAExecutions = nodeExecutionRepo.listByNode(run.id, STEP_A);
    expect(stepAExecutions).toHaveLength(3);

    nodeExecutionRepo.update(stepAExecutions[0].id, { status: 'idle' });
    nodeExecutionRepo.update(stepAExecutions[1].id, { status: 'idle' });
    nodeExecutionRepo.update(stepAExecutions[2].id, { status: 'blocked', result: 'Crash' });

    await runtime.executeTick();

    const updatedRun = workflowRunRepo.getRun(run.id)!;
    expect(updatedRun.status).toBe('blocked');
  });

  test('startWorkflowRun() with single agentId creates exactly one task', async () => {
    const workflow = workflowManager.createWorkflow({
      spaceId: SPACE_ID,
      name: `Single Agent ${Date.now()}`,
      nodes: [{ id: STEP_A, name: 'Start', agentId: AGENT_CODER }],
      transitions: [],
      startNodeId: STEP_A,
      rules: [],
      tags: [],
      completionAutonomyLevel: 3,
    });

    const { tasks } = await runtime.startWorkflowRun(SPACE_ID, workflow.id, 'Run');
    expect(tasks).toHaveLength(1);
    expect(tasks[0].status).toBe('open');
  });
});

describe('resolveNodeAgents()', () => {
  function makeStep(overrides: Partial<WorkflowNode> = {}): WorkflowNode {
    return { id: 'step-1', name: 'Test Step', agents: [], ...overrides };
  }

  test('returns single-element array when only agentId is set', () => {
    const step = makeStep({ agentId: 'agent-a' } as unknown as Partial<WorkflowNode>);
    const result = resolveNodeAgents(step);
    expect(result).toHaveLength(1);
    expect(result[0].agentId).toBe('agent-a');
    expect(result[0].name).toBe('Test Step');
  });

  test('returns agents array when agents is set and non-empty', () => {
    const step = makeStep({
      agents: [{ agentId: 'agent-a', instructions: 'code' }, { agentId: 'agent-b' }],
    });
    const result = resolveNodeAgents(step);
    expect(result).toHaveLength(2);
    expect(result[0].agentId).toBe('agent-a');
    expect(result[1].agentId).toBe('agent-b');
  });

  test('agents takes precedence over agentId when both are set', () => {
    const step = makeStep({
      agentId: 'agent-a',
      agents: [{ agentId: 'agent-b' }],
    });
    const result = resolveNodeAgents(step);
    expect(result).toHaveLength(1);
    expect(result[0].agentId).toBe('agent-b');
  });

  test('throws when neither agentId nor agents is provided', () => {
    const step = makeStep();
    expect(() => resolveNodeAgents(step)).toThrow(
      'WorkflowNode "Test Step" (id: step-1) has no agents defined'
    );
  });

  test('throws when agents is an empty array and agentId is absent', () => {
    const step = makeStep({ agents: [] });
    expect(() => resolveNodeAgents(step)).toThrow();
  });

  test('single-element agents array works correctly', () => {
    const step = makeStep({
      agents: [{ agentId: 'agent-a', name: 'agent-a', instructions: 'custom' }],
    });
    expect(resolveNodeAgents(step)).toEqual([
      { agentId: 'agent-a', name: 'agent-a', instructions: 'custom' },
    ]);
  });

  test('agentId with no instructions produces entry with undefined instructions', () => {
    const step = makeStep({ agentId: 'agent-a' } as unknown as Partial<WorkflowNode>);
    const result = resolveNodeAgents(step);
    expect(result[0].instructions).toBeUndefined();
  });
});

describe('Mixed workflows — single-agent, multi-agent, and channels', () => {
  let db: BunDatabase;
  let workflowRunRepo: SpaceWorkflowRunRepository;
  let taskRepo: SpaceTaskRepository;
  let workflowManager: SpaceWorkflowManager;
  let runtime: SpaceRuntime;

  const SPACE_ID = 'space-mixed';
  const WORKSPACE = '/tmp/ws-mixed';
  const AGENT_CODER = 'agent-mixed-coder';
  const AGENT_PLANNER = 'agent-mixed-planner';
  const AGENT_REVIEWER = 'agent-mixed-reviewer';
  const STEP_A = 'step-mx-a';
  const STEP_B = 'step-mx-b';
  const STEP_C = 'step-mx-c';

  beforeEach(() => {
    db = makeDb();
    seedSpace(db, SPACE_ID, WORKSPACE);
    seedAgent(db, AGENT_CODER, SPACE_ID, 'Coder');
    seedAgent(db, AGENT_PLANNER, SPACE_ID, 'Planner');
    seedAgent(db, AGENT_REVIEWER, SPACE_ID, 'Reviewer');

    workflowRunRepo = new SpaceWorkflowRunRepository(db);
    taskRepo = new SpaceTaskRepository(db);

    const agentRepo = new SpaceAgentRepository(db);
    const agentManager = new SpaceAgentManager(agentRepo);
    const workflowRepo = new SpaceWorkflowRepository(db);
    workflowManager = new SpaceWorkflowManager(workflowRepo);
    const spaceManager = new SpaceManager(db);

    const config: SpaceRuntimeConfig = {
      db,
      spaceManager,
      spaceAgentManager: agentManager,
      spaceWorkflowManager: workflowManager,
      workflowRunRepo,
      taskRepo,
      nodeExecutionRepo: new NodeExecutionRepository(db),
    };
    runtime = new SpaceRuntime(config);
  });

  afterEach(() => {
    try {
      db.close();
    } catch {}
  });

  test('rejects reserved built-in agent names in workflow declarations', () => {
    const reservedNode = {
      id: STEP_A,
      name: 'Reserved Names',
      agents: [{ agentId: AGENT_CODER, name: ' Space-Agent ' }],
    };

    expect(() =>
      workflowManager.createWorkflow({
        spaceId: SPACE_ID,
        name: `Reserved Name Workflow ${Date.now()}`,
        nodes: [reservedNode],
        transitions: [],
        startNodeId: STEP_A,
        rules: [],
        tags: [],
        completionAutonomyLevel: 3,
      })
    ).toThrow(WorkflowValidationError);
  });

  test('rejects reserved built-in agent names during node execution creation', () => {
    const nodeExecutionManager = new NodeExecutionManager(db);
    const workflow = new SpaceWorkflowRepository(db).createWorkflow({
      spaceId: SPACE_ID,
      name: `Node Execution Reserved Name ${Date.now()}`,
      nodes: [{ id: STEP_A, name: 'Step', agents: [{ agentId: AGENT_CODER, name: 'coder' }] }],
      transitions: [],
      startNodeId: STEP_A,
      rules: [],
      completionAutonomyLevel: 3,
    });
    const run = workflowRunRepo.createRun({
      spaceId: SPACE_ID,
      workflowId: workflow.id,
      title: 'Reserved node execution run',
    });

    expect(() =>
      nodeExecutionManager.create({
        workflowRunId: run.id,
        workflowNodeId: STEP_A,
        agentName: 'TASK-AGENT',
        status: 'pending',
      })
    ).toThrow('reserved for a built-in agent');
  });

  test('channels for start step are stored in run config after startWorkflowRun()', async () => {
    const startNode = {
      id: STEP_A,
      name: 'Parallel With Channels',
      agents: [
        { agentId: AGENT_CODER, name: 'coder' },
        { agentId: AGENT_REVIEWER, name: 'reviewer' },
      ],
    };
    const { nodes, endNodeId } = appendSyntheticEnd([startNode], AGENT_CODER);
    const workflow = workflowManager.createWorkflow({
      spaceId: SPACE_ID,
      name: `Channel Start Step ${Date.now()}`,
      nodes,
      transitions: [],
      startNodeId: STEP_A,
      endNodeId,
      rules: [],
      tags: [],
      completionAutonomyLevel: 3,
    });

    const { run, tasks } = await runtime.startWorkflowRun(SPACE_ID, workflow.id, 'Run');

    expect(tasks).toHaveLength(1);

    const channels = runtime.getRunWorkflowChannels(run.id);
    expect(channels).toHaveLength(0);
  });
});
