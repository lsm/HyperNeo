/**
 * Runtime tests for HandoffExecutor (task #923).
 *
 * Covers the handoff operation's contract surface with focused, deterministic
 * cases: success delivery, channel authorization, transition resolution,
 * gate commit (open + closed), hook validator (allow + block), cyclic
 * maxCycles enforcement, queued activation, and terminal run-state rejection.
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import type {
  Gate,
  HandoffTransition,
  SpaceWorkflow,
  WorkflowChannel,
  WorkflowHook,
  WorkflowHookResult,
  WorkflowNode,
} from '@hyperneo/shared';
import type { GateScriptExecutorFn } from '../../../../src/lib/space/runtime/gate-evaluator.ts';
import type { HandoffExecutorConfig } from '../../../../src/lib/space/runtime/handoff-executor.ts';
import {
  HandoffExecutor,
  isCyclicHandoff,
  resolveHandoffTargetSlots,
} from '../../../../src/lib/space/runtime/handoff-executor.ts';
import type { HookExecutor } from '../../../../src/lib/space/runtime/hook-executor.ts';
import { GateDataRepository } from '../../../../src/storage/repositories/gate-data-repository.ts';
import { HandoffCycleRepository } from '../../../../src/storage/repositories/handoff-cycle-repository.ts';
import { NodeExecutionRepository } from '../../../../src/storage/repositories/node-execution-repository.ts';
import { PendingAgentMessageRepository } from '../../../../src/storage/repositories/pending-agent-message-repository.ts';
import { SpaceWorkflowRepository } from '../../../../src/storage/repositories/space-workflow-repository.ts';
import { SpaceWorkflowRunRepository } from '../../../../src/storage/repositories/space-workflow-run-repository.ts';
import { runMigrations } from '../../../../src/storage/schema/index.ts';
import { Database as BunDatabase } from '../../../../src/storage/sqlite-compat';

// ---------------------------------------------------------------------------
// DB + seed helpers
// ---------------------------------------------------------------------------

function makeDb(): BunDatabase {
  const db = new BunDatabase(':memory:');
  db.exec('PRAGMA foreign_keys = ON');
  runMigrations(db, () => {});
  return db;
}

function seedSpaceRow(db: BunDatabase, spaceId: string): void {
  db.prepare(
    `INSERT INTO spaces (id, workspace_path, name, description, background_context, instructions,
     allowed_models, session_ids, slug, status, created_at, updated_at)
     VALUES (?, '/tmp', ?, '', '', '', '[]', '[]', ?, 'active', ?, ?)`
  ).run(spaceId, `Space ${spaceId}`, spaceId, Date.now(), Date.now());
}

/** Create a placeholder workflow + run to satisfy FKs; returns the run id. */
function seedRun(db: BunDatabase, spaceId: string): string {
  const workflowRepo = new SpaceWorkflowRepository(db);
  const workflow = workflowRepo.createWorkflow({
    spaceId,
    name: 'Handoff Test Workflow',
    description: '',
    nodes: [],
    transitions: [],
    startNodeId: '',
    rules: [],
    completionAutonomyLevel: 3,
  });
  const runRepo = new SpaceWorkflowRunRepository(db);
  const run = runRepo.createRun({ spaceId, workflowId: workflow.id, title: 'Handoff Run' });
  return run.id;
}

function seedPeer(
  db: BunDatabase,
  workflowRunId: string,
  nodeId: string,
  agentName: string,
  sessionId: string
): void {
  const repo = new NodeExecutionRepository(db);
  const execution = repo.createOrIgnore({
    workflowRunId,
    workflowNodeId: nodeId,
    agentName,
    agentSessionId: sessionId,
    status: 'in_progress',
  });
  repo.update(execution.id, { agentSessionId: sessionId, status: 'in_progress' });
}

// ---------------------------------------------------------------------------
// Workflow literal builders
// ---------------------------------------------------------------------------

function node(
  id: string,
  name: string,
  agentSlot: string,
  transitions?: HandoffTransition[]
): WorkflowNode {
  return {
    id,
    name,
    agents: [{ agentId: `${agentSlot}-agent`, name: agentSlot }],
    transitions,
  };
}

function makeWorkflow(opts: {
  nodes: WorkflowNode[];
  channels?: WorkflowChannel[];
  gates?: Gate[];
  hooks?: WorkflowHook[];
}): SpaceWorkflow {
  return {
    id: 'wf-handoff-test',
    spaceId: 'space-handoff-test',
    name: 'Handoff Test',
    nodes: opts.nodes,
    startNodeId: opts.nodes[0]?.id ?? '',
    channels: opts.channels,
    gates: opts.gates,
    hooks: opts.hooks,
    tags: [],
    createdAt: Date.now(),
    updatedAt: Date.now(),
    completionAutonomyLevel: 3,
  };
}

function approvedGate(gateId: string, writer: string): Gate {
  return {
    id: gateId,
    resetOnCycle: false,
    fields: [
      {
        name: 'approved',
        type: 'boolean',
        writers: [writer],
        check: { op: '==', value: true },
      },
    ],
  };
}

// ---------------------------------------------------------------------------
// Executor builder
// ---------------------------------------------------------------------------

interface Ctx {
  db: BunDatabase;
  spaceId: string;
  runId: string;
  nodeExecutionRepo: NodeExecutionRepository;
  workflowRunRepo: SpaceWorkflowRunRepository;
  gateDataRepo: GateDataRepository;
  handoffCycleRepo: HandoffCycleRepository;
  pendingMessageRepo: PendingAgentMessageRepository;
  injected: Array<{ sessionId: string; message: string }>;
  activations: string[];
}

function makeCtx(): Ctx {
  const db = makeDb();
  const spaceId = 'space-handoff-test';
  seedSpaceRow(db, spaceId);
  const runId = seedRun(db, spaceId);
  return {
    db,
    spaceId,
    runId,
    nodeExecutionRepo: new NodeExecutionRepository(db),
    workflowRunRepo: new SpaceWorkflowRunRepository(db),
    gateDataRepo: new GateDataRepository(db),
    handoffCycleRepo: new HandoffCycleRepository(db),
    pendingMessageRepo: new PendingAgentMessageRepository(db),
    injected: [],
    activations: [],
  };
}

function makeExecutor(
  ctx: Ctx,
  workflow: SpaceWorkflow,
  overrides: Partial<HandoffExecutorConfig> = {}
): HandoffExecutor {
  return new HandoffExecutor({
    workflowRunRepo: ctx.workflowRunRepo,
    workflow,
    gateDataRepo: ctx.gateDataRepo,
    handoffCycleRepo: ctx.handoffCycleRepo,
    nodeExecutionRepo: ctx.nodeExecutionRepo,
    workflowRunId: ctx.runId,
    spaceId: ctx.spaceId,
    messageInjector: async (sessionId, message) => {
      ctx.injected.push({ sessionId, message });
    },
    activateTargetSession: async (agentName) => {
      ctx.activations.push(agentName);
      return [];
    },
    ...overrides,
  });
}

/** Stub HookExecutor that returns a fixed validator result. */
function stubHookExecutor(result: WorkflowHookResult): HookExecutor {
  return { execute: async () => ({ result }) } as unknown as HookExecutor;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('HandoffExecutor: success', () => {
  let ctx: Ctx;
  beforeEach(() => {
    ctx = makeCtx();
  });
  afterEach(() => ctx.db.close());

  test('delivers the peer-message envelope to a live target session', async () => {
    const workflow = makeWorkflow({
      nodes: [
        node('n-coding', 'coding', 'coder', [{ id: 'to-review', target: 'review' }]),
        node('n-review', 'review', 'reviewer'),
      ],
      channels: [{ id: 'ch-coding-review', from: 'coding', to: 'review' }],
    });
    seedPeer(ctx.db, ctx.runId, 'n-review', 'reviewer', 'session-reviewer');
    const executor = makeExecutor(ctx, workflow);

    const result = await executor.execute({
      fromAgentName: 'coder',
      fromSessionId: 'session-coder',
      workflowNodeId: 'n-coding',
      operation: { target: 'review', summary: 'PR ready for review' },
    });

    expect(result.status).toBe('delivered');
    expect(result.transition?.id).toBe('to-review');
    expect(result.targetNodes).toEqual(['review']);
    expect(result.targetSlots).toEqual(['reviewer']);
    expect(result.delivered).toEqual([{ agentName: 'reviewer', sessionId: 'session-reviewer' }]);
    expect(ctx.injected).toHaveLength(1);
    expect(ctx.injected[0].sessionId).toBe('session-reviewer');
    expect(ctx.injected[0].message).toContain('PR ready for review');
    expect(ctx.injected[0].message).toContain('─── Message from coder ───');
  });

  test('broadcast target delivers to every other node', async () => {
    const workflow = makeWorkflow({
      nodes: [
        node('n-coding', 'coding', 'coder', [{ id: 'broadcast', target: '*' }]),
        node('n-review', 'review', 'reviewer'),
        node('n-qa', 'qa', 'tester'),
      ],
      channels: [{ id: 'ch-broadcast', from: 'coding', to: ['review', 'qa'] }],
    });
    seedPeer(ctx.db, ctx.runId, 'n-review', 'reviewer', 'session-reviewer');
    seedPeer(ctx.db, ctx.runId, 'n-qa', 'tester', 'session-tester');
    const executor = makeExecutor(ctx, workflow);

    const result = await executor.execute({
      fromAgentName: 'coder',
      fromSessionId: 'session-coder',
      workflowNodeId: 'n-coding',
      operation: { target: '*', summary: 'heads up' },
    });

    expect(result.status).toBe('delivered');
    expect(result.targetNodes.sort()).toEqual(['qa', 'review']);
    expect(result.delivered).toHaveLength(2);
    expect(ctx.injected).toHaveLength(2);
  });

  test('partial delivery: reachable target delivered, unreachable reported', async () => {
    const workflow = makeWorkflow({
      nodes: [
        node('n-coding', 'coding', 'coder', [{ id: 'broadcast', target: '*' }]),
        node('n-review', 'review', 'reviewer'),
        node('n-qa', 'qa', 'tester'),
      ],
      channels: [{ id: 'ch-broadcast', from: 'coding', to: ['review', 'qa'] }],
    });
    // Only reviewer is live; tester has no session and no queue is configured.
    seedPeer(ctx.db, ctx.runId, 'n-review', 'reviewer', 'session-reviewer');
    const executor = makeExecutor(ctx, workflow);

    const result = await executor.execute({
      fromAgentName: 'coder',
      fromSessionId: 'session-coder',
      workflowNodeId: 'n-coding',
      operation: { target: '*', summary: 'heads up' },
    });

    expect(result.status).toBe('delivered');
    expect(result.delivered).toEqual([{ agentName: 'reviewer', sessionId: 'session-reviewer' }]);
    expect(result.reason).toContain('tester');
  });
});

describe('HandoffExecutor: transition resolution', () => {
  let ctx: Ctx;
  beforeEach(() => {
    ctx = makeCtx();
  });
  afterEach(() => ctx.db.close());

  test('blocks when the target resolves to no declared transition', async () => {
    const workflow = makeWorkflow({
      nodes: [
        node('n-coding', 'coding', 'coder', [{ id: 'to-review', target: 'review' }]),
        node('n-review', 'review', 'reviewer'),
      ],
    });
    const executor = makeExecutor(ctx, workflow);

    const result = await executor.execute({
      fromAgentName: 'coder',
      fromSessionId: 'session-coder',
      workflowNodeId: 'n-coding',
      operation: { target: 'qa', summary: 'go' },
    });

    expect(result.status).toBe('blocked');
    expect(result.stage).toBe('resolve_transition');
    expect(result.reason).toContain('qa');
    expect(result.delivered).toHaveLength(0);
  });

  test('blocks when the sender node declares no transitions', async () => {
    const workflow = makeWorkflow({
      nodes: [node('n-coding', 'coding', 'coder'), node('n-review', 'review', 'reviewer')],
    });
    const executor = makeExecutor(ctx, workflow);

    const result = await executor.execute({
      fromAgentName: 'coder',
      fromSessionId: 'session-coder',
      workflowNodeId: 'n-coding',
      operation: { target: 'review', summary: 'go' },
    });

    expect(result.status).toBe('blocked');
    expect(result.stage).toBe('resolve_transition');
  });

  test('fails when the sender node id is unknown', async () => {
    const workflow = makeWorkflow({
      nodes: [node('n-coding', 'coding', 'coder'), node('n-review', 'review', 'reviewer')],
    });
    const executor = makeExecutor(ctx, workflow);

    const result = await executor.execute({
      fromAgentName: 'coder',
      fromSessionId: 'session-coder',
      workflowNodeId: 'n-missing',
      operation: { target: 'review', summary: 'go' },
    });

    expect(result.status).toBe('failed');
    expect(result.stage).toBe('resolve_source');
  });

  test('rejects a self-targeted handoff (round boundary)', async () => {
    const workflow = makeWorkflow({
      nodes: [
        node('n-coding', 'coding', 'coder', [{ id: 'to-self', target: 'coding' }]),
        node('n-review', 'review', 'reviewer'),
      ],
    });
    const executor = makeExecutor(ctx, workflow);

    const result = await executor.execute({
      fromAgentName: 'coder',
      fromSessionId: 'session-coder',
      workflowNodeId: 'n-coding',
      operation: { target: 'coding', summary: 'loop' },
    });

    expect(result.status).toBe('blocked');
    expect(result.stage).toBe('resolve_target');
    expect(result.reason).toContain("sender's own node");
  });

  test('rejects data keys when the transition declares no gate or hook', async () => {
    const workflow = makeWorkflow({
      nodes: [
        node('n-coding', 'coding', 'coder', [{ id: 'to-review', target: 'review' }]),
        node('n-review', 'review', 'reviewer'),
      ],
      channels: [{ id: 'ch', from: 'coding', to: 'review' }],
    });
    const executor = makeExecutor(ctx, workflow);

    const result = await executor.execute({
      fromAgentName: 'coder',
      fromSessionId: 'session-coder',
      workflowNodeId: 'n-coding',
      operation: { target: 'review', summary: 'go', data: { rogue: 1 } },
    });

    expect(result.status).toBe('blocked');
    expect(result.stage).toBe('resolve_target');
    expect(result.reason).toContain('no gate or hook');
  });
});

describe('HandoffExecutor: channel authorization', () => {
  let ctx: Ctx;
  beforeEach(() => {
    ctx = makeCtx();
  });
  afterEach(() => ctx.db.close());

  test('blocks when topology is declared but no channel permits the target', async () => {
    const workflow = makeWorkflow({
      nodes: [
        node('n-coding', 'coding', 'coder', [
          { id: 'to-review', target: 'review' },
          { id: 'to-qa', target: 'qa' },
        ]),
        node('n-review', 'review', 'reviewer'),
        node('n-qa', 'qa', 'tester'),
      ],
      // Only coding→review is declared; coding→qa is not.
      channels: [{ id: 'ch-coding-review', from: 'coding', to: 'review' }],
    });
    const executor = makeExecutor(ctx, workflow);

    const result = await executor.execute({
      fromAgentName: 'coder',
      fromSessionId: 'session-coder',
      workflowNodeId: 'n-coding',
      operation: { target: 'qa', summary: 'go' },
    });

    expect(result.status).toBe('blocked');
    expect(result.stage).toBe('authorize_channel');
    expect(result.reason).toContain('qa');
  });

  test('open topology (no channels) permits a declared transition', async () => {
    const workflow = makeWorkflow({
      nodes: [
        node('n-coding', 'coding', 'coder', [{ id: 'to-review', target: 'review' }]),
        node('n-review', 'review', 'reviewer'),
      ],
    });
    seedPeer(ctx.db, ctx.runId, 'n-review', 'reviewer', 'session-reviewer');
    const executor = makeExecutor(ctx, workflow);

    const result = await executor.execute({
      fromAgentName: 'coder',
      fromSessionId: 'session-coder',
      workflowNodeId: 'n-coding',
      operation: { target: 'review', summary: 'go' },
    });

    expect(result.status).toBe('delivered');
  });
});

describe('HandoffExecutor: gate commit', () => {
  let ctx: Ctx;
  beforeEach(() => {
    ctx = makeCtx();
  });
  afterEach(() => ctx.db.close());

  test('blocks when the declared gate condition is not satisfied', async () => {
    const workflow = makeWorkflow({
      nodes: [
        node('n-coding', 'coding', 'coder', [
          { id: 'to-review', target: 'review', gateId: 'gate-approved' },
        ]),
        node('n-review', 'review', 'reviewer'),
      ],
      channels: [{ id: 'ch', from: 'coding', to: 'review' }],
      gates: [approvedGate('gate-approved', 'coder')],
    });
    const executor = makeExecutor(ctx, workflow);

    const result = await executor.execute({
      fromAgentName: 'coder',
      fromSessionId: 'session-coder',
      workflowNodeId: 'n-coding',
      operation: { target: 'review', summary: 'go', data: { approved: false } },
    });

    expect(result.status).toBe('blocked');
    expect(result.stage).toBe('gate');
    expect(result.gate?.open).toBe(false);
    // Gate data was still committed (approved=false merged) before evaluation.
    expect(ctx.gateDataRepo.get(ctx.runId, 'gate-approved')?.data.approved).toBe(false);
    expect(result.delivered).toHaveLength(0);
  });

  test('proceeds without re-writing when the gate is already open and no data is supplied', async () => {
    const workflow = makeWorkflow({
      nodes: [
        node('n-coding', 'coding', 'coder', [
          { id: 'to-review', target: 'review', gateId: 'gate-approved' },
        ]),
        node('n-review', 'review', 'reviewer'),
      ],
      channels: [{ id: 'ch', from: 'coding', to: 'review' }],
      gates: [approvedGate('gate-approved', 'coder')],
    });
    // Gate already opened by a prior write (e.g. human approval via RPC).
    ctx.gateDataRepo.merge(ctx.runId, 'gate-approved', { approved: true, approvalSource: 'human' });
    seedPeer(ctx.db, ctx.runId, 'n-review', 'reviewer', 'session-reviewer');
    const executor = makeExecutor(ctx, workflow);

    const result = await executor.execute({
      fromAgentName: 'coder',
      fromSessionId: 'session-coder',
      workflowNodeId: 'n-coding',
      operation: { target: 'review', summary: 'go' },
    });

    expect(result.status).toBe('delivered');
    expect(result.gate?.open).toBe(true);
    // No agent write occurred — the prior human approvalSource is preserved.
    expect(ctx.gateDataRepo.get(ctx.runId, 'gate-approved')?.data.approvalSource).toBe('human');
  });

  test('delivers when the declared gate opens after committing the data', async () => {
    const workflow = makeWorkflow({
      nodes: [
        node('n-coding', 'coding', 'coder', [
          { id: 'to-review', target: 'review', gateId: 'gate-approved' },
        ]),
        node('n-review', 'review', 'reviewer'),
      ],
      channels: [{ id: 'ch', from: 'coding', to: 'review' }],
      gates: [approvedGate('gate-approved', 'coder')],
    });
    seedPeer(ctx.db, ctx.runId, 'n-review', 'reviewer', 'session-reviewer');
    const executor = makeExecutor(ctx, workflow);

    const result = await executor.execute({
      fromAgentName: 'coder',
      fromSessionId: 'session-coder',
      workflowNodeId: 'n-coding',
      operation: { target: 'review', summary: 'go', data: { approved: true } },
    });

    expect(result.status).toBe('delivered');
    expect(result.gate?.open).toBe(true);
    expect(ctx.gateDataRepo.get(ctx.runId, 'gate-approved')?.data.approved).toBe(true);
  });

  test('rejects data keys outside the gate declared shape', async () => {
    const workflow = makeWorkflow({
      nodes: [
        node('n-coding', 'coding', 'coder', [
          { id: 'to-review', target: 'review', gateId: 'gate-approved' },
        ]),
        node('n-review', 'review', 'reviewer'),
      ],
      channels: [{ id: 'ch', from: 'coding', to: 'review' }],
      gates: [approvedGate('gate-approved', 'coder')],
    });
    const executor = makeExecutor(ctx, workflow);

    const result = await executor.execute({
      fromAgentName: 'coder',
      fromSessionId: 'session-coder',
      workflowNodeId: 'n-coding',
      operation: { target: 'review', summary: 'go', data: { approved: true, rogue: 1 } },
    });

    expect(result.status).toBe('blocked');
    expect(result.stage).toBe('gate');
    expect(result.reason).toContain('rogue');
  });

  test('propagates a rate-limited scripted gate as a retryable block', async () => {
    const gate: Gate = {
      id: 'gate-scripted',
      resetOnCycle: false,
      fields: [
        { name: 'approved', type: 'boolean', writers: ['coder'], check: { op: '==', value: true } },
      ],
      script: { interpreter: 'bash', source: 'exit 1' },
    };
    const workflow = makeWorkflow({
      nodes: [
        node('n-coding', 'coding', 'coder', [
          { id: 'to-review', target: 'review', gateId: 'gate-scripted' },
        ]),
        node('n-review', 'review', 'reviewer'),
      ],
      channels: [{ id: 'ch', from: 'coding', to: 'review' }],
      gates: [gate],
    });
    const executor = makeExecutor(ctx, workflow, {
      scriptExecutor: (async () => ({
        success: false,
        rateLimited: true,
        retryAfterMs: 5000,
        data: {},
        error: 'GitHub 403',
      })) as GateScriptExecutorFn,
      scriptContext: { workspacePath: '/tmp', runId: ctx.runId },
    });

    const result = await executor.execute({
      fromAgentName: 'coder',
      fromSessionId: 'session-coder',
      workflowNodeId: 'n-coding',
      operation: { target: 'review', summary: 'go', data: { approved: true } },
    });

    expect(result.status).toBe('blocked');
    expect(result.stage).toBe('gate');
    expect(result.rateLimited).toBe(true);
    expect(result.retryAfterMs).toBe(5000);
    expect(result.gate?.rateLimited).toBe(true);
  });

  test('autonomy path: a no-writers field is writable at sufficient autonomy', async () => {
    const gate: Gate = {
      id: 'gate-autonomy',
      resetOnCycle: false,
      requiredLevel: 3,
      fields: [
        { name: 'approved', type: 'boolean', writers: [], check: { op: '==', value: true } },
      ],
    };
    const workflow = makeWorkflow({
      nodes: [
        node('n-coding', 'coding', 'coder', [
          { id: 'to-review', target: 'review', gateId: 'gate-autonomy' },
        ]),
        node('n-review', 'review', 'reviewer'),
      ],
      channels: [{ id: 'ch', from: 'coding', to: 'review' }],
      gates: [gate],
    });
    seedPeer(ctx.db, ctx.runId, 'n-review', 'reviewer', 'session-reviewer');
    const executor = makeExecutor(ctx, workflow, {
      getSpaceAutonomyLevel: async () => 5,
    });

    const result = await executor.execute({
      fromAgentName: 'coder',
      fromSessionId: 'session-coder',
      workflowNodeId: 'n-coding',
      operation: { target: 'review', summary: 'go', data: { approved: true } },
    });

    expect(result.status).toBe('delivered');
    expect(result.gate?.open).toBe(true);
  });

  test('autonomy path: a no-writers field is rejected below required autonomy', async () => {
    const gate: Gate = {
      id: 'gate-autonomy',
      resetOnCycle: false,
      requiredLevel: 3,
      fields: [
        { name: 'approved', type: 'boolean', writers: [], check: { op: '==', value: true } },
      ],
    };
    const workflow = makeWorkflow({
      nodes: [
        node('n-coding', 'coding', 'coder', [
          { id: 'to-review', target: 'review', gateId: 'gate-autonomy' },
        ]),
        node('n-review', 'review', 'reviewer'),
      ],
      channels: [{ id: 'ch', from: 'coding', to: 'review' }],
      gates: [gate],
    });
    const executor = makeExecutor(ctx, workflow, {
      getSpaceAutonomyLevel: async () => 1,
    });

    const result = await executor.execute({
      fromAgentName: 'coder',
      fromSessionId: 'session-coder',
      workflowNodeId: 'n-coding',
      operation: { target: 'review', summary: 'go', data: { approved: true } },
    });

    expect(result.status).toBe('blocked');
    expect(result.stage).toBe('gate');
    expect(result.reason).toContain('not authorized');
  });
});

describe('HandoffExecutor: hook validator', () => {
  let ctx: Ctx;
  beforeEach(() => {
    ctx = makeCtx();
  });
  afterEach(() => ctx.db.close());

  function workflowWithHook(): SpaceWorkflow {
    return makeWorkflow({
      nodes: [
        node('n-coding', 'coding', 'coder', [
          { id: 'to-review', target: 'review', hookId: 'hook-pr-ready' },
        ]),
        node('n-review', 'review', 'reviewer'),
      ],
      channels: [{ id: 'ch', from: 'coding', to: 'review' }],
      hooks: [
        {
          id: 'hook-pr-ready',
          enabled: true,
          sourceNode: 'coding',
          method: 'send_message',
          validator: { kind: 'built_in', id: 'pr_ready' },
          authorizedCallers: [{ sourceNode: 'coding' }],
        },
      ],
    });
  }

  test('blocks when the hook validator returns block', async () => {
    const executor = makeExecutor(ctx, workflowWithHook(), {
      hookExecutor: stubHookExecutor({ type: 'block', reason: 'PR not ready' }),
    });

    const result = await executor.execute({
      fromAgentName: 'coder',
      fromSessionId: 'session-coder',
      workflowNodeId: 'n-coding',
      operation: { target: 'review', summary: 'go' },
    });

    expect(result.status).toBe('blocked');
    expect(result.stage).toBe('hook');
    expect(result.hook?.result.type).toBe('block');
    expect(result.reason).toBe('PR not ready');
    expect(result.delivered).toHaveLength(0);
  });

  test('delivers when the hook validator allows', async () => {
    seedPeer(ctx.db, ctx.runId, 'n-review', 'reviewer', 'session-reviewer');
    const executor = makeExecutor(ctx, workflowWithHook(), {
      hookExecutor: stubHookExecutor({ type: 'allow' }),
    });

    const result = await executor.execute({
      fromAgentName: 'coder',
      fromSessionId: 'session-coder',
      workflowNodeId: 'n-coding',
      operation: { target: 'review', summary: 'go' },
    });

    expect(result.status).toBe('delivered');
    expect(result.hook?.result.type).toBe('allow');
  });

  test('propagates a retryable_block hook as a retryable block', async () => {
    const executor = makeExecutor(ctx, workflowWithHook(), {
      hookExecutor: stubHookExecutor({
        type: 'retryable_block',
        reason: 'review not posted yet',
        retryAfterMs: 30_000,
      }),
    });

    const result = await executor.execute({
      fromAgentName: 'coder',
      fromSessionId: 'session-coder',
      workflowNodeId: 'n-coding',
      operation: { target: 'review', summary: 'go' },
    });

    expect(result.status).toBe('blocked');
    expect(result.stage).toBe('hook');
    expect(result.hook?.result.type).toBe('retryable_block');
    expect(result.retryAfterMs).toBe(30_000);
    expect(result.reason).toBe('review not posted yet');
  });

  test('a throwing validator maps to a failed result (never throws)', async () => {
    const throwingHook = {
      execute: async () => {
        throw new Error('validator crashed');
      },
    } as unknown as HookExecutor;
    const executor = makeExecutor(ctx, workflowWithHook(), { hookExecutor: throwingHook });

    const result = await executor.execute({
      fromAgentName: 'coder',
      fromSessionId: 'session-coder',
      workflowNodeId: 'n-coding',
      operation: { target: 'review', summary: 'go' },
    });

    expect(result.status).toBe('failed');
    expect(result.stage).toBe('hook');
    expect(result.reason).toContain('validator crashed');
  });

  test('blocks when the hook is not authorized for the sending slot', async () => {
    // Hook authorizes a different slot than the sender.
    const workflow = makeWorkflow({
      nodes: [
        node('n-coding', 'coding', 'coder', [
          { id: 'to-review', target: 'review', hookId: 'hook-pr-ready' },
        ]),
        node('n-review', 'review', 'reviewer'),
      ],
      channels: [{ id: 'ch', from: 'coding', to: 'review' }],
      hooks: [
        {
          id: 'hook-pr-ready',
          enabled: true,
          sourceNode: 'coding',
          method: 'send_message',
          validator: { kind: 'built_in', id: 'pr_ready' },
          authorizedCallers: [{ sourceNode: 'coding', agentSlots: ['someone-else'] }],
        },
      ],
    });
    const executor = makeExecutor(ctx, workflow, {
      hookExecutor: stubHookExecutor({ type: 'allow' }),
    });

    const result = await executor.execute({
      fromAgentName: 'coder',
      fromSessionId: 'session-coder',
      workflowNodeId: 'n-coding',
      operation: { target: 'review', summary: 'go' },
    });

    expect(result.status).toBe('blocked');
    expect(result.stage).toBe('hook');
    expect(result.hook?.result.type).toBe('block');
    expect(result.reason).toContain('authorized caller');
  });
});

describe('HandoffExecutor: cyclic maxCycles', () => {
  let ctx: Ctx;
  beforeEach(() => {
    ctx = makeCtx();
  });
  afterEach(() => ctx.db.close());

  test('blocks once a cyclic transition reaches its maxCycles cap', async () => {
    const workflow = makeWorkflow({
      nodes: [
        // coding → review (creates the back-edge that makes review→coding cyclic)
        node('n-coding', 'coding', 'coder', [{ id: 'to-review', target: 'review' }]),
        // review → coding is the cyclic transition under test (maxCycles 2)
        node('n-review', 'review', 'reviewer', [
          { id: 'to-coding', target: 'coding', maxCycles: 2 },
        ]),
      ],
      // Open topology (no channels): the transition graph alone forms the
      // coding→review→coding loop, so isCyclicHandoff is true for review→coding.
    });
    seedPeer(ctx.db, ctx.runId, 'n-coding', 'coder', 'session-coder');
    const executor = makeExecutor(ctx, workflow);

    const first = await executor.execute({
      fromAgentName: 'reviewer',
      fromSessionId: 'session-reviewer',
      workflowNodeId: 'n-review',
      operation: { target: 'coding', summary: 'feedback' },
    });
    const second = await executor.execute({
      fromAgentName: 'reviewer',
      fromSessionId: 'session-reviewer',
      workflowNodeId: 'n-review',
      operation: { target: 'coding', summary: 'more feedback' },
    });
    const third = await executor.execute({
      fromAgentName: 'reviewer',
      fromSessionId: 'session-reviewer',
      workflowNodeId: 'n-review',
      operation: { target: 'coding', summary: 'still feedback' },
    });

    expect(first.status).toBe('delivered');
    expect(second.status).toBe('delivered');
    expect(third.status).toBe('blocked');
    expect(third.stage).toBe('cycle_limit');
    expect(third.reason).toContain('maxCycles');
    expect(third.delivered).toHaveLength(0);
  });

  test('does not enforce a cap on an acyclic transition', async () => {
    const workflow = makeWorkflow({
      nodes: [
        node('n-coding', 'coding', 'coder', [{ id: 'to-review', target: 'review', maxCycles: 1 }]),
        node('n-review', 'review', 'reviewer'),
      ],
      channels: [{ id: 'ch', from: 'coding', to: 'review' }],
    });
    seedPeer(ctx.db, ctx.runId, 'n-review', 'reviewer', 'session-reviewer');
    const executor = makeExecutor(ctx, workflow);

    // coding→review is acyclic (no path back), so maxCycles does not apply and
    // the handoff is never capped.
    for (let i = 0; i < 3; i++) {
      const result = await executor.execute({
        fromAgentName: 'coder',
        fromSessionId: 'session-coder',
        workflowNodeId: 'n-coding',
        operation: { target: 'review', summary: `round ${i}` },
      });
      expect(result.status).toBe('delivered');
    }
  });

  test('a failed delivery does not consume a cycle (reservation refunded)', async () => {
    const workflow = makeWorkflow({
      nodes: [
        node('n-coding', 'coding', 'coder', [{ id: 'to-review', target: 'review' }]),
        node('n-review', 'review', 'reviewer', [
          { id: 'to-coding', target: 'coding', maxCycles: 1 },
        ]),
      ],
    });
    // No live coder session and no pendingMessageRepo → every review→coding
    // handoff fails delivery. (activateTargetSession in makeExecutor returns [].)
    const executor = makeExecutor(ctx, workflow);
    const key = `n-review/to-coding`;

    for (let i = 0; i < 3; i++) {
      const result = await executor.execute({
        fromAgentName: 'reviewer',
        fromSessionId: 'session-reviewer',
        workflowNodeId: 'n-review',
        operation: { target: 'coding', summary: `attempt ${i}` },
      });
      expect(result.status).toBe('failed');
      expect(result.stage).toBe('deliver');
    }

    // The reservation was refunded each time — the cap is intact (0 takes) and a
    // later successful handoff is still allowed.
    expect(ctx.handoffCycleRepo.get(ctx.runId, key)?.count ?? 0).toBe(0);

    seedPeer(ctx.db, ctx.runId, 'n-coding', 'coder', 'session-coder');
    const ok = await executor.execute({
      fromAgentName: 'reviewer',
      fromSessionId: 'session-reviewer',
      workflowNodeId: 'n-review',
      operation: { target: 'coding', summary: 'now it works' },
    });
    expect(ok.status).toBe('delivered');
    expect(ctx.handoffCycleRepo.get(ctx.runId, key)?.count).toBe(1);
  });

  test('a deduped enqueue does not charge a second cycle', async () => {
    const workflow = makeWorkflow({
      nodes: [
        node('n-coding', 'coding', 'coder', [{ id: 'to-review', target: 'review' }]),
        node('n-review', 'review', 'reviewer', [
          { id: 'to-coding', target: 'coding', maxCycles: 2 },
        ]),
      ],
    });
    // Target offline; pendingMessageRepo configured so handoffs queue.
    const executor = makeExecutor(ctx, workflow, {
      pendingMessageRepo: ctx.pendingMessageRepo,
    });
    const key = 'n-review/to-coding';
    const op = {
      fromAgentName: 'reviewer',
      fromSessionId: 'session-reviewer',
      workflowNodeId: 'n-review',
      operation: { target: 'coding', summary: 'dup' },
    };

    const first = await executor.execute(op);
    const second = await executor.execute(op); // identical → deduped enqueue

    expect(first.status).toBe('queued');
    expect(second.status).toBe('queued');
    // The first (new enqueue) charged a cycle; the second (deduped) was
    // refunded — the cap is intact at 1, not 2.
    expect(ctx.handoffCycleRepo.get(ctx.runId, key)?.count).toBe(1);
  });
});

describe('HandoffExecutor: queued activation', () => {
  let ctx: Ctx;
  beforeEach(() => {
    ctx = makeCtx();
  });
  afterEach(() => ctx.db.close());

  test('queues when the target session is not yet active', async () => {
    const workflow = makeWorkflow({
      nodes: [
        node('n-coding', 'coding', 'coder', [{ id: 'to-review', target: 'review' }]),
        node('n-review', 'review', 'reviewer'),
      ],
      channels: [{ id: 'ch', from: 'coding', to: 'review' }],
    });
    // No seedPeer for reviewer → no live session. activateTargetSession returns [].
    const executor = makeExecutor(ctx, workflow, {
      pendingMessageRepo: ctx.pendingMessageRepo,
    });

    const result = await executor.execute({
      fromAgentName: 'coder',
      fromSessionId: 'session-coder',
      workflowNodeId: 'n-coding',
      operation: { target: 'review', summary: 'go' },
    });

    expect(result.status).toBe('queued');
    expect(result.queued).toHaveLength(1);
    expect(result.queued[0].agentName).toBe('reviewer');
    expect(result.delivered).toHaveLength(0);
    expect(ctx.activations).toContain('reviewer');
  });

  test('does not deliver to a stale (cancelled) execution session', async () => {
    const workflow = makeWorkflow({
      nodes: [
        node('n-coding', 'coding', 'coder', [{ id: 'to-review', target: 'review' }]),
        node('n-review', 'review', 'reviewer'),
      ],
      channels: [{ id: 'ch', from: 'coding', to: 'review' }],
    });
    // A cancelled execution retains a dead session id; it must not be selected.
    const repo = new NodeExecutionRepository(ctx.db);
    const stale = repo.createOrIgnore({
      workflowRunId: ctx.runId,
      workflowNodeId: 'n-review',
      agentName: 'reviewer',
      agentSessionId: 'session-stale',
      status: 'cancelled',
    });
    repo.update(stale.id, { agentSessionId: 'session-stale', status: 'cancelled' });
    const executor = makeExecutor(ctx, workflow); // no queue → fails rather than injects

    const result = await executor.execute({
      fromAgentName: 'coder',
      fromSessionId: 'session-coder',
      workflowNodeId: 'n-coding',
      operation: { target: 'review', summary: 'go' },
    });

    expect(result.status).toBe('failed');
    expect(ctx.injected).toHaveLength(0); // never injected into the stale session
  });
});

describe('HandoffExecutor: run-state validation', () => {
  let ctx: Ctx;
  beforeEach(() => {
    ctx = makeCtx();
  });
  afterEach(() => ctx.db.close());

  test('blocks a handoff on a terminal (done) run', async () => {
    const workflow = makeWorkflow({
      nodes: [
        node('n-coding', 'coding', 'coder', [{ id: 'to-review', target: 'review' }]),
        node('n-review', 'review', 'reviewer'),
      ],
      channels: [{ id: 'ch', from: 'coding', to: 'review' }],
    });
    ctx.workflowRunRepo.updateRun(ctx.runId, { status: 'done' });
    const executor = makeExecutor(ctx, workflow);

    const result = await executor.execute({
      fromAgentName: 'coder',
      fromSessionId: 'session-coder',
      workflowNodeId: 'n-coding',
      operation: { target: 'review', summary: 'go' },
    });

    expect(result.status).toBe('blocked');
    expect(result.stage).toBe('resolve_run');
    expect(result.reason).toContain('done');
  });

  test('blocks a handoff on a cancelled run', async () => {
    const workflow = makeWorkflow({
      nodes: [
        node('n-coding', 'coding', 'coder', [{ id: 'to-review', target: 'review' }]),
        node('n-review', 'review', 'reviewer'),
      ],
      channels: [{ id: 'ch', from: 'coding', to: 'review' }],
    });
    ctx.workflowRunRepo.updateRun(ctx.runId, { status: 'cancelled' });
    const executor = makeExecutor(ctx, workflow);

    const result = await executor.execute({
      fromAgentName: 'coder',
      fromSessionId: 'session-coder',
      workflowNodeId: 'n-coding',
      operation: { target: 'review', summary: 'go' },
    });

    expect(result.status).toBe('blocked');
    expect(result.stage).toBe('resolve_run');
    expect(result.reason).toContain('cancelled');
  });

  test('fails when the run does not exist', async () => {
    const workflow = makeWorkflow({
      nodes: [node('n-coding', 'coding', 'coder'), node('n-review', 'review', 'reviewer')],
    });
    const executor = new HandoffExecutor({
      workflowRunRepo: ctx.workflowRunRepo,
      workflow,
      gateDataRepo: ctx.gateDataRepo,
      handoffCycleRepo: ctx.handoffCycleRepo,
      nodeExecutionRepo: ctx.nodeExecutionRepo,
      workflowRunId: 'run-does-not-exist',
      spaceId: ctx.spaceId,
      messageInjector: async () => {},
    });

    const result = await executor.execute({
      fromAgentName: 'coder',
      fromSessionId: 'session-coder',
      workflowNodeId: 'n-coding',
      operation: { target: 'review', summary: 'go' },
    });

    expect(result.status).toBe('failed');
    expect(result.stage).toBe('resolve_run');
  });
});

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

describe('HandoffExecutor pure helpers', () => {
  const coding = node('n-coding', 'coding', 'coder');
  const review = node('n-review', 'review', 'reviewer');
  const workflow = makeWorkflow({ nodes: [coding, review] });

  test('resolveHandoffTargetSlots: node name fans out to all slots', () => {
    const t: HandoffTransition = { id: 't', target: 'review' };
    expect(resolveHandoffTargetSlots(workflow, coding, t)).toEqual({
      nodes: ['review'],
      slots: ['reviewer'],
    });
  });

  test('resolveHandoffTargetSlots: slot name targets a single slot', () => {
    const t: HandoffTransition = { id: 't', target: 'reviewer' };
    expect(resolveHandoffTargetSlots(workflow, coding, t)).toEqual({
      nodes: ['review'],
      slots: ['reviewer'],
    });
  });

  test('resolveHandoffTargetSlots: broadcast excludes the sender node', () => {
    const t: HandoffTransition = { id: 't', target: '*' };
    expect(resolveHandoffTargetSlots(workflow, coding, t)).toEqual({
      nodes: ['review'],
      slots: ['reviewer'],
    });
  });

  test('isCyclicHandoff: a back-edge is cyclic', () => {
    const wf = makeWorkflow({
      nodes: [
        node('n-coding', 'coding', 'coder', [{ id: 't1', target: 'review' }]),
        node('n-review', 'review', 'reviewer', [{ id: 't2', target: 'coding' }]),
      ],
    });
    // review→coding closes the loop coding→review→coding.
    expect(isCyclicHandoff(wf, 'review', ['coding'])).toBe(true);
    // coding→review has a path back (review→coding), so it is also cyclic.
    expect(isCyclicHandoff(wf, 'coding', ['review'])).toBe(true);
  });

  test('isCyclicHandoff: a forward-only edge is acyclic', () => {
    const wf = makeWorkflow({
      nodes: [
        node('n-coding', 'coding', 'coder', [{ id: 't1', target: 'review' }]),
        node('n-review', 'review', 'reviewer'),
      ],
    });
    expect(isCyclicHandoff(wf, 'coding', ['review'])).toBe(false);
  });
});
