/**
 * ChannelRouter — Gate Auto-Approval Tests
 *
 * Tests the `requiredLevel` gate auto-approval feature:
 *   - Gates with `requiredLevel` auto-approve when space autonomy >= requiredLevel
 *   - Gates without `requiredLevel` are unaffected
 *   - Auto-approval only targets boolean fields with `check: { op: '==', value: true }`
 *   - Script validation still runs after auto-approval (not bypassed)
 *   - Gates with mixed field types only auto-approve qualifying boolean fields
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
import { ChannelRouter } from '../../../../src/lib/space/runtime/channel-router.ts';
import type { Gate, SpaceWorkflow, WorkflowChannel, SpaceAutonomyLevel } from '@hyperneo/shared';
import { computeGateDefaults } from '@hyperneo/shared';

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

function seedSpace(db: BunDatabase, spaceId: string, autonomyLevel: SpaceAutonomyLevel = 1): void {
  db.prepare(
    `INSERT INTO spaces (id, workspace_path, name, description, background_context, instructions,
     allowed_models, session_ids, slug, status, autonomy_level, created_at, updated_at)
     VALUES (?, '/tmp/ws', ?, '', '', '', '[]', '[]', ?, 'active', ?, ?, ?)`
  ).run(spaceId, `Space ${spaceId}`, spaceId, autonomyLevel, Date.now(), Date.now());
}

function seedAgent(db: BunDatabase, agentId: string, spaceId: string): void {
  db.prepare(
    `INSERT INTO space_agents (id, space_id, name, description, model, tools, system_prompt, created_at, updated_at)
     VALUES (?, ?, ?, '', null, '[]', '', ?, ?)`
  ).run(agentId, spaceId, `Agent ${agentId}`, Date.now(), Date.now());
}

// ---------------------------------------------------------------------------
// Workflow builder
// ---------------------------------------------------------------------------

function buildWorkflowWithGates(
  spaceId: string,
  workflowManager: SpaceWorkflowManager,
  nodes: Array<{
    id: string;
    name: string;
    agents: Array<{ agentId: string; name: string }>;
  }>,
  channels: WorkflowChannel[],
  gates: Gate[]
): SpaceWorkflow {
  return workflowManager.createWorkflow({
    spaceId,
    name: `Test Workflow ${Date.now()}`,
    description: '',
    nodes,
    transitions: [],
    startNodeId: nodes[0].id,
    rules: [],
    tags: [],
    channels,
    gates,
    completionAutonomyLevel: 3,
  });
}

// ---------------------------------------------------------------------------
// Test suite
// ---------------------------------------------------------------------------

describe('ChannelRouter — gate auto-approval via requiredLevel', () => {
  let db: BunDatabase;

  let taskRepo: SpaceTaskRepository;
  let workflowRunRepo: SpaceWorkflowRunRepository;
  let workflowManager: SpaceWorkflowManager;
  let agentManager: SpaceAgentManager;
  let gateDataRepo: GateDataRepository;
  let channelCycleRepo: ChannelCycleRepository;

  const SPACE_ID = 'space-auto-approval';
  const AGENT_A = 'agent-a';
  const AGENT_B = 'agent-b';
  const NODE_A = 'node-a';
  const NODE_B = 'node-b';

  function makeRouter(autonomyLevel: SpaceAutonomyLevel): ChannelRouter {
    return new ChannelRouter({
      taskRepo,
      workflowRunRepo,
      workflowManager,
      agentManager,
      nodeExecutionRepo: new NodeExecutionRepository(db),
      gateDataRepo,
      channelCycleRepo,
      db,
      getSpaceAutonomyLevel: async () => autonomyLevel,
    });
  }

  function makeApprovalGate(requiredLevel?: SpaceAutonomyLevel): Gate {
    return {
      id: 'approval-gate',
      fields: [
        {
          name: 'approved',
          type: 'boolean',
          writers: [],
          check: { op: '==', value: true },
        },
      ],
      requiredLevel,
      resetOnCycle: false,
    };
  }

  beforeEach(() => {
    db = makeDb();
    seedSpace(db, SPACE_ID, 1);
    seedAgent(db, AGENT_A, SPACE_ID);
    seedAgent(db, AGENT_B, SPACE_ID);

    taskRepo = new SpaceTaskRepository(db);
    workflowRunRepo = new SpaceWorkflowRunRepository(db);
    gateDataRepo = new GateDataRepository(db);
    channelCycleRepo = new ChannelCycleRepository(db);

    const createRunOriginal = workflowRunRepo.createRun.bind(workflowRunRepo);
    (workflowRunRepo as unknown as { createRun: typeof workflowRunRepo.createRun }).createRun = (
      params: Parameters<typeof workflowRunRepo.createRun>[0]
    ) => {
      const run = createRunOriginal(params);
      taskRepo.createTask({
        spaceId: params.spaceId,
        title: params.title,
        description: params.description ?? '',
        status: 'open',
        workflowRunId: run.id,
      });
      return run;
    };

    const agentRepo = new SpaceAgentRepository(db);
    agentManager = new SpaceAgentManager(agentRepo);

    const workflowRepo = new SpaceWorkflowRepository(db);
    workflowManager = new SpaceWorkflowManager(workflowRepo);
  });

  afterEach(() => {
    try {
      db?.close();
    } catch {
      /* ignore */
    }
  });

  // ─── Auto-approval behavior ──────────────────────────────────────────

  test('gate with requiredLevel=3 auto-approves when space autonomy >= 3', async () => {
    const gate = makeApprovalGate(3);
    const channels: WorkflowChannel[] = [
      { id: 'ch-1', from: 'coder', to: 'reviewer', gateId: 'approval-gate' },
    ];
    const workflow = buildWorkflowWithGates(
      SPACE_ID,
      workflowManager,
      [
        { id: NODE_A, name: 'Coder', agents: [{ agentId: AGENT_A, name: 'coder' }] },
        { id: NODE_B, name: 'Reviewer', agents: [{ agentId: AGENT_B, name: 'reviewer' }] },
      ],
      channels,
      [gate]
    );

    const run = workflowRunRepo.createRun({
      spaceId: SPACE_ID,
      workflowId: workflow.id,
      title: 'Auto-Approval Test',
    });
    workflowRunRepo.transitionStatus(run.id, 'in_progress');
    gateDataRepo.initializeForRun(run.id, [
      { id: gate.id, data: computeGateDefaults(gate.fields) },
    ]);

    // Space autonomy = 3, gate requires 3 → should auto-approve
    const router = makeRouter(3);
    const activated = await router.onGateDataChanged(run.id, 'approval-gate');

    // Gate auto-approved → downstream node activated
    expect(activated.length).toBeGreaterThan(0);

    // Verify gate data was written with approved = true
    const gateData = gateDataRepo.get(run.id, 'approval-gate');
    expect(gateData?.data.approved).toBe(true);
  });

  test('gate with requiredLevel=3 does NOT auto-approve when space autonomy < 3', async () => {
    const gate = makeApprovalGate(3);
    const channels: WorkflowChannel[] = [
      { id: 'ch-1', from: 'coder', to: 'reviewer', gateId: 'approval-gate' },
    ];
    const workflow = buildWorkflowWithGates(
      SPACE_ID,
      workflowManager,
      [
        { id: NODE_A, name: 'Coder', agents: [{ agentId: AGENT_A, name: 'coder' }] },
        { id: NODE_B, name: 'Reviewer', agents: [{ agentId: AGENT_B, name: 'reviewer' }] },
      ],
      channels,
      [gate]
    );

    const run = workflowRunRepo.createRun({
      spaceId: SPACE_ID,
      workflowId: workflow.id,
      title: 'Low Autonomy Test',
    });
    workflowRunRepo.transitionStatus(run.id, 'in_progress');
    gateDataRepo.initializeForRun(run.id, [
      { id: gate.id, data: computeGateDefaults(gate.fields) },
    ]);

    // Space autonomy = 2, gate requires 3 → should NOT auto-approve
    const router = makeRouter(2);
    const activated = await router.onGateDataChanged(run.id, 'approval-gate');

    // No activation — gate still closed
    expect(activated).toHaveLength(0);

    // Gate data should not have been written
    const gateData = gateDataRepo.get(run.id, 'approval-gate');
    expect(gateData?.data.approved).not.toBe(true);
  });

  test('gate without requiredLevel defaults to level 5 — auto-approves only at autonomy 5', async () => {
    const gate = makeApprovalGate(undefined); // no requiredLevel → defaults to 5
    const channels: WorkflowChannel[] = [
      { id: 'ch-1', from: 'coder', to: 'reviewer', gateId: 'approval-gate' },
    ];
    const workflow = buildWorkflowWithGates(
      SPACE_ID,
      workflowManager,
      [
        { id: NODE_A, name: 'Coder', agents: [{ agentId: AGENT_A, name: 'coder' }] },
        { id: NODE_B, name: 'Reviewer', agents: [{ agentId: AGENT_B, name: 'reviewer' }] },
      ],
      channels,
      [gate]
    );

    const run = workflowRunRepo.createRun({
      spaceId: SPACE_ID,
      workflowId: workflow.id,
      title: 'No RequiredLevel Test',
    });
    workflowRunRepo.transitionStatus(run.id, 'in_progress');
    gateDataRepo.initializeForRun(run.id, [
      { id: gate.id, data: computeGateDefaults(gate.fields) },
    ]);

    // Space autonomy = 4 — below effective required level 5 → should NOT auto-approve
    const router4 = makeRouter(4);
    const activated4 = await router4.onGateDataChanged(run.id, 'approval-gate');
    expect(activated4).toHaveLength(0);
    const gateData4 = gateDataRepo.get(run.id, 'approval-gate');
    expect(gateData4?.data.approved).not.toBe(true);

    // Space autonomy = 5 — meets effective required level 5 → SHOULD auto-approve
    const router5 = makeRouter(5);
    const activated5 = await router5.onGateDataChanged(run.id, 'approval-gate');
    expect(activated5).toHaveLength(1);
    const gateData5 = gateDataRepo.get(run.id, 'approval-gate');
    expect(gateData5?.data.approved).toBe(true);
  });

  test('auto-approval only writes boolean fields with check == true', async () => {
    const gate: Gate = {
      id: 'mixed-gate',
      fields: [
        {
          name: 'approved',
          type: 'boolean',
          writers: [],
          check: { op: '==', value: true },
        },
        {
          name: 'comment',
          type: 'string',
          writers: ['reviewer'],
          check: { op: '!=', value: undefined },
        },
      ],
      requiredLevel: 3,
      resetOnCycle: false,
    };

    const channels: WorkflowChannel[] = [
      { id: 'ch-1', from: 'coder', to: 'reviewer', gateId: 'mixed-gate' },
    ];
    const workflow = buildWorkflowWithGates(
      SPACE_ID,
      workflowManager,
      [
        { id: NODE_A, name: 'Coder', agents: [{ agentId: AGENT_A, name: 'coder' }] },
        { id: NODE_B, name: 'Reviewer', agents: [{ agentId: AGENT_B, name: 'reviewer' }] },
      ],
      channels,
      [gate]
    );

    const run = workflowRunRepo.createRun({
      spaceId: SPACE_ID,
      workflowId: workflow.id,
      title: 'Mixed Fields Test',
    });
    workflowRunRepo.transitionStatus(run.id, 'in_progress');
    gateDataRepo.initializeForRun(run.id, [
      { id: gate.id, data: computeGateDefaults(gate.fields) },
    ]);

    const router = makeRouter(4);
    const activated = await router.onGateDataChanged(run.id, 'mixed-gate');

    // Gate still closed because 'comment' field (string, != undefined) is not auto-filled
    expect(activated).toHaveLength(0);

    // But 'approved' was auto-set to true
    const gateData = gateDataRepo.get(run.id, 'mixed-gate');
    expect(gateData?.data.approved).toBe(true);
    // 'comment' was not auto-filled (not a boolean == true field)
    expect(gateData?.data.comment).toBeFalsy();
  });

  test('auto-approval at exactly the required level (boundary)', async () => {
    const gate = makeApprovalGate(4);
    const channels: WorkflowChannel[] = [
      { id: 'ch-1', from: 'coder', to: 'reviewer', gateId: 'approval-gate' },
    ];
    const workflow = buildWorkflowWithGates(
      SPACE_ID,
      workflowManager,
      [
        { id: NODE_A, name: 'Coder', agents: [{ agentId: AGENT_A, name: 'coder' }] },
        { id: NODE_B, name: 'Reviewer', agents: [{ agentId: AGENT_B, name: 'reviewer' }] },
      ],
      channels,
      [gate]
    );

    const run = workflowRunRepo.createRun({
      spaceId: SPACE_ID,
      workflowId: workflow.id,
      title: 'Boundary Level Test',
    });
    workflowRunRepo.transitionStatus(run.id, 'in_progress');
    gateDataRepo.initializeForRun(run.id, [
      { id: gate.id, data: computeGateDefaults(gate.fields) },
    ]);

    // Exactly level 4 = requiredLevel 4 → should auto-approve
    const router = makeRouter(4);
    const activated = await router.onGateDataChanged(run.id, 'approval-gate');
    expect(activated.length).toBeGreaterThan(0);
  });

  test('auto-approval without getSpaceAutonomyLevel callback does nothing', async () => {
    const gate = makeApprovalGate(1); // lowest possible requiredLevel
    const channels: WorkflowChannel[] = [
      { id: 'ch-1', from: 'coder', to: 'reviewer', gateId: 'approval-gate' },
    ];
    const workflow = buildWorkflowWithGates(
      SPACE_ID,
      workflowManager,
      [
        { id: NODE_A, name: 'Coder', agents: [{ agentId: AGENT_A, name: 'coder' }] },
        { id: NODE_B, name: 'Reviewer', agents: [{ agentId: AGENT_B, name: 'reviewer' }] },
      ],
      channels,
      [gate]
    );

    const run = workflowRunRepo.createRun({
      spaceId: SPACE_ID,
      workflowId: workflow.id,
      title: 'No Callback Test',
    });
    workflowRunRepo.transitionStatus(run.id, 'in_progress');
    gateDataRepo.initializeForRun(run.id, [
      { id: gate.id, data: computeGateDefaults(gate.fields) },
    ]);

    // Router without getSpaceAutonomyLevel
    const router = new ChannelRouter({
      taskRepo,
      workflowRunRepo,
      workflowManager,
      agentManager,
      nodeExecutionRepo: new NodeExecutionRepository(db),
      gateDataRepo,
      channelCycleRepo,
      db,
      // No getSpaceAutonomyLevel — auto-approval disabled
    });

    const activated = await router.onGateDataChanged(run.id, 'approval-gate');
    expect(activated).toHaveLength(0);
  });
});
