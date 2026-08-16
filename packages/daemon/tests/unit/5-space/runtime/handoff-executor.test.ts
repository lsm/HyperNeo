/**
 * Runtime tests for HandoffExecutor (task #923).
 *
 * Covers the handoff operation's contract surface with focused, deterministic
 * cases: success delivery, channel authorization, transition resolution,
 * gate-free (hook-only) commit, hook validator (allow + block), cyclic
 * maxCycles enforcement, queued activation, and terminal run-state rejection.
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import type {
  HandoffTransition,
  SpaceWorkflow,
  WorkflowChannel,
  WorkflowHook,
  WorkflowHookResult,
  WorkflowNode,
} from '@hyperneo/shared';
import type { HandoffExecutorConfig } from '../../../../src/lib/space/runtime/handoff-executor.ts';
import {
  HandoffExecutor,
  isCyclicHandoff,
  resolveHandoffTargetSlots,
} from '../../../../src/lib/space/runtime/handoff-executor.ts';
import type { HookExecutor } from '../../../../src/lib/space/runtime/hook-executor.ts';
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
  hooks?: WorkflowHook[];
}): SpaceWorkflow {
  return {
    id: 'wf-handoff-test',
    spaceId: 'space-handoff-test',
    name: 'Handoff Test',
    nodes: opts.nodes,
    startNodeId: opts.nodes[0]?.id ?? '',
    channels: opts.channels,
    hooks: opts.hooks,
    tags: [],
    createdAt: Date.now(),
    updatedAt: Date.now(),
    completionAutonomyLevel: 3,
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
  const executor = new HandoffExecutor({
    workflowRunRepo: ctx.workflowRunRepo,
    workflow,
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
  // Seed the SENDER's live execution row before each execute so sender
  // validation passes — mirrors production, where the calling agent always
  // has an active node execution. Tests that exercise sender validation
  // itself construct the executor directly instead.
  const original = executor.execute.bind(executor);
  executor.execute = async (params) => {
    seedPeer(ctx.db, ctx.runId, params.workflowNodeId, params.fromAgentName, params.fromSessionId);
    return original(params);
  };
  return executor;
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

  test('a broadcast that cannot reach every recipient fails (all required)', async () => {
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

    // A broadcast transfers ownership to every node, so it is only accepted
    // when all recipients are reachable. Atomicity: the unreachable recipient
    // (tester) is detected BEFORE any delivery, so the reachable one never
    // receives the handoff (no partial delivery / duplicate ownership).
    expect(result.status).toBe('failed');
    expect(result.delivered).toEqual([]);
    expect(result.reason).toContain('0/2');
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

  test('rejects data keys when the transition declares no hook', async () => {
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
    expect(result.reason).toContain('rogue');
    expect(result.reason).toContain('none');
  });

  test('rejects data keys the bound hook does not declare (template fields only)', async () => {
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
          // The hook's declared handoff shape: only pr_url.
          templateData: { pr_url: '' },
          validator: { kind: 'built_in', id: 'pr_ready' },
          authorizedCallers: [{ sourceNode: 'coding' }],
        },
      ],
    });
    const executor = makeExecutor(ctx, workflow, {
      hookExecutor: stubHookExecutor({ type: 'allow' }),
    });

    const rogue = await executor.execute({
      fromAgentName: 'coder',
      fromSessionId: 'session-coder',
      workflowNodeId: 'n-coding',
      operation: { target: 'review', summary: 'go', data: { pr_url: 'https://x/1', rogue: 1 } },
    });
    expect(rogue.status).toBe('blocked');
    expect(rogue.stage).toBe('resolve_target');
    expect(rogue.reason).toContain('rogue');

    // A declared key passes shape validation (delivery then depends on the
    // hook validator, stubbed to allow here).
    seedPeer(ctx.db, ctx.runId, 'n-review', 'reviewer', 'session-reviewer');
    const ok = await executor.execute({
      fromAgentName: 'coder',
      fromSessionId: 'session-coder',
      workflowNodeId: 'n-coding',
      operation: { target: 'review', summary: 'go', data: { pr_url: 'https://x/1' } },
    });
    expect(ok.status).toBe('delivered');
    expect(ctx.injected[ctx.injected.length - 1].message).toContain('pr_url');
  });

  test('a hook with no templateData declares no data fields (fail closed)', async () => {
    const workflow = makeWorkflow({
      nodes: [
        node('n-coding', 'coding', 'coder', [
          { id: 'to-review', target: 'review', hookId: 'hook-pr-ready' },
        ]),
        node('n-review', 'review', 'reviewer'),
      ],
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
    const executor = makeExecutor(ctx, workflow);

    const result = await executor.execute({
      fromAgentName: 'coder',
      fromSessionId: 'session-coder',
      workflowNodeId: 'n-coding',
      operation: { target: 'review', summary: 'go', data: { pr_url: 'https://x/1' } },
    });

    expect(result.status).toBe('blocked');
    expect(result.stage).toBe('resolve_target');
    expect(result.reason).toContain('pr_url');
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

  test('authorizes a slot-addressed channel (coder → reviewer), not just node names', async () => {
    const workflow = makeWorkflow({
      nodes: [
        node('n-coding', 'coding', 'coder', [{ id: 'to-review', target: 'review' }]),
        node('n-review', 'review', 'reviewer'),
      ],
      // Slot-addressed channel (valid per export-format), no node-name channel.
      channels: [{ id: 'ch-slot', from: 'coder', to: 'reviewer' }],
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

  test('does not authorize a slot through a sibling slot channel (per-slot auth)', async () => {
    const reviewNode: WorkflowNode = {
      id: 'n-review',
      name: 'review',
      agents: [
        { agentId: 'a-agent', name: 'reviewer-a' },
        { agentId: 'b-agent', name: 'reviewer-b' },
      ],
    };
    const workflow = makeWorkflow({
      nodes: [
        node('n-coding', 'coding', 'coder', [{ id: 'to-b', target: 'reviewer-b' }]),
        reviewNode,
      ],
      // Channel targets reviewer-a only — reviewer-b must not sneak through it.
      channels: [{ id: 'ch-a', from: 'coder', to: 'reviewer-a' }],
    });
    const executor = makeExecutor(ctx, workflow);

    const result = await executor.execute({
      fromAgentName: 'coder',
      fromSessionId: 'session-coder',
      workflowNodeId: 'n-coding',
      operation: { target: 'reviewer-b', summary: 'go' },
    });

    expect(result.status).toBe('blocked');
    expect(result.stage).toBe('authorize_channel');
    expect(result.reason).toContain('reviewer-b');
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

  test('dispatches an emit_follow_up result to its target node before reporting success', async () => {
    const workflow = makeWorkflow({
      nodes: [
        node('n-coding', 'coding', 'coder', [
          { id: 'to-review', target: 'review', hookId: 'hook-follow' },
        ]),
        node('n-review', 'review', 'reviewer'),
        node('n-qa', 'qa', 'tester'),
      ],
      // Both targets reachable so the follow-up to qa is channel-authorized.
      channels: [{ id: 'ch', from: 'coding', to: ['review', 'qa'] }],
      hooks: [
        {
          id: 'hook-follow',
          enabled: true,
          sourceNode: 'coding',
          method: 'send_message',
          validator: { kind: 'built_in', id: 'pr_ready' },
          authorizedCallers: [{ sourceNode: 'coding' }],
        },
      ],
    });
    seedPeer(ctx.db, ctx.runId, 'n-review', 'reviewer', 'session-reviewer');
    seedPeer(ctx.db, ctx.runId, 'n-qa', 'tester', 'session-tester');
    const executor = makeExecutor(ctx, workflow, {
      hookExecutor: stubHookExecutor({
        type: 'emit_follow_up',
        targetNode: 'qa',
        message: 'please double-check the migrations',
      }),
    });

    const result = await executor.execute({
      fromAgentName: 'coder',
      fromSessionId: 'session-coder',
      workflowNodeId: 'n-coding',
      operation: { target: 'review', summary: 'go' },
    });

    // The handoff itself delivered to review…
    expect(result.status).toBe('delivered');
    expect(result.delivered).toEqual([{ agentName: 'reviewer', sessionId: 'session-reviewer' }]);
    // …and the hook's follow-up reached its own target node (qa).
    const followUp = ctx.injected.find((m) => m.sessionId === 'session-tester');
    expect(followUp).toBeDefined();
    expect(followUp!.message).toContain('please double-check the migrations');
  });

  test('drops an emit_follow_up target the channel topology does not permit', async () => {
    const workflow = makeWorkflow({
      nodes: [
        node('n-coding', 'coding', 'coder', [
          { id: 'to-review', target: 'review', hookId: 'hook-follow' },
        ]),
        node('n-review', 'review', 'reviewer'),
        node('n-qa', 'qa', 'tester'),
      ],
      // Only coding→review is declared — qa is NOT reachable from coding.
      channels: [{ id: 'ch', from: 'coding', to: 'review' }],
      hooks: [
        {
          id: 'hook-follow',
          enabled: true,
          sourceNode: 'coding',
          method: 'send_message',
          validator: { kind: 'built_in', id: 'pr_ready' },
          authorizedCallers: [{ sourceNode: 'coding' }],
        },
      ],
    });
    seedPeer(ctx.db, ctx.runId, 'n-review', 'reviewer', 'session-reviewer');
    seedPeer(ctx.db, ctx.runId, 'n-qa', 'tester', 'session-tester');
    const executor = makeExecutor(ctx, workflow, {
      hookExecutor: stubHookExecutor({
        type: 'emit_follow_up',
        targetNode: 'qa',
        message: 'should not arrive',
      }),
    });

    const result = await executor.execute({
      fromAgentName: 'coder',
      fromSessionId: 'session-coder',
      workflowNodeId: 'n-coding',
      operation: { target: 'review', summary: 'go' },
    });

    // The handoff still delivers; the unauthorized follow-up is dropped.
    expect(result.status).toBe('delivered');
    expect(ctx.injected.find((m) => m.sessionId === 'session-tester')).toBeUndefined();
    expect(ctx.injected).toHaveLength(1); // only the review handoff envelope
  });

  test('a side-effect hook does not block the handoff (non-blocking semantics)', async () => {
    const workflow = makeWorkflow({
      nodes: [
        node('n-coding', 'coding', 'coder', [
          { id: 'to-review', target: 'review', hookId: 'hook-side' },
        ]),
        node('n-review', 'review', 'reviewer'),
      ],
      channels: [{ id: 'ch', from: 'coding', to: 'review' }],
      hooks: [
        {
          id: 'hook-side',
          enabled: true,
          sourceNode: 'coding',
          method: 'send_message',
          classification: 'side_effect',
          validator: { kind: 'built_in', id: 'pr_ready' },
          authorizedCallers: [{ sourceNode: 'coding' }],
        },
      ],
    });
    seedPeer(ctx.db, ctx.runId, 'n-review', 'reviewer', 'session-reviewer');
    // A side-effect hook returning block must NOT gate the handoff (mirrors the
    // shared hook engine, which records block results without blocking for
    // side_effect hooks).
    const executor = makeExecutor(ctx, workflow, {
      hookExecutor: stubHookExecutor({ type: 'block', reason: 'recorded only' }),
    });

    const result = await executor.execute({
      fromAgentName: 'coder',
      fromSessionId: 'session-coder',
      workflowNodeId: 'n-coding',
      operation: { target: 'review', summary: 'go' },
    });

    expect(result.status).toBe('delivered');
    expect(result.hook?.result.type).toBe('block');
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

  test('a cyclic transition without maxCycles defaults to a cap of 5', async () => {
    // review→coding is cyclic (coding→review transition closes the loop) but
    // omits maxCycles; it must still be capped at the default (5), not unbounded.
    const workflow = makeWorkflow({
      nodes: [
        node('n-coding', 'coding', 'coder', [{ id: 'to-review', target: 'review' }]),
        node('n-review', 'review', 'reviewer', [{ id: 'to-coding', target: 'coding' }]),
      ],
    });
    seedPeer(ctx.db, ctx.runId, 'n-coding', 'coder', 'session-coder');
    const executor = makeExecutor(ctx, workflow);
    const key = 'n-review/to-coding';
    const op = {
      fromAgentName: 'reviewer',
      fromSessionId: 'session-reviewer',
      workflowNodeId: 'n-review',
      operation: { target: 'coding', summary: 'feedback' },
    };

    for (let i = 0; i < 5; i++) {
      const result = await executor.execute(op);
      expect(result.status).toBe('delivered');
    }
    const blocked = await executor.execute(op);
    expect(blocked.status).toBe('blocked');
    expect(blocked.stage).toBe('cycle_limit');
    expect(blocked.reason).toContain('5');
  });

  test('a forward edge inside a loop is not capped at the default (back-edge carries maxCycles)', async () => {
    // Loop coding→review→coding with maxCycles:10 on the BACK edge. Under
    // reachability-only cyclicity the forward edge was also classified cyclic
    // and silently bound to the default 5 — defeating the configured 10. With
    // the node-order backward-edge test the forward edge is uncapped.
    const workflow = makeWorkflow({
      nodes: [
        node('n-coding', 'coding', 'coder', [{ id: 'to-review', target: 'review' }]),
        node('n-review', 'review', 'reviewer', [
          { id: 'to-coding', target: 'coding', maxCycles: 10 },
        ]),
      ],
    });
    seedPeer(ctx.db, ctx.runId, 'n-review', 'reviewer', 'session-reviewer');
    const executor = makeExecutor(ctx, workflow);

    // 6+ forward handoffs exceed the old default cap of 5 — all must deliver.
    for (let i = 0; i < 6; i++) {
      const result = await executor.execute({
        fromAgentName: 'coder',
        fromSessionId: 'session-coder',
        workflowNodeId: 'n-coding',
        operation: { target: 'review', summary: `round ${i}` },
      });
      expect(result.status).toBe('delivered');
    }
    expect(ctx.handoffCycleRepo.get(ctx.runId, 'n-coding/to-review')?.count ?? 0).toBe(0);

    // The back-edge keeps its own configured cap.
    seedPeer(ctx.db, ctx.runId, 'n-coding', 'coder', 'session-coder');
    const backOp = {
      fromAgentName: 'reviewer',
      fromSessionId: 'session-reviewer',
      workflowNodeId: 'n-review',
      operation: { target: 'coding', summary: 'feedback' },
    };
    for (let i = 0; i < 10; i++) {
      const result = await executor.execute(backOp);
      expect(result.status).toBe('delivered');
    }
    const blocked = await executor.execute(backOp);
    expect(blocked.status).toBe('blocked');
    expect(blocked.stage).toBe('cycle_limit');
    expect(blocked.reason).toContain('10');
  });

  test('a discussion channel back-edge does not make a forward transition cyclic', async () => {
    // Forward transition coding→review + a discussion CHANNEL review→coding.
    // The channel is messaging topology, not control flow, so coding→review must
    // NOT be classified cyclic (and thus not capped) — ownership cannot return
    // to coding via a peer message.
    const workflow = makeWorkflow({
      nodes: [
        node('n-coding', 'coding', 'coder', [{ id: 'to-review', target: 'review', maxCycles: 1 }]),
        node('n-review', 'review', 'reviewer'),
      ],
      channels: [
        { id: 'ch-fwd', from: 'coding', to: 'review' }, // authorizes the handoff
        { id: 'ch-back', from: 'review', to: 'coding' }, // discussion back-edge
      ],
    });
    seedPeer(ctx.db, ctx.runId, 'n-review', 'reviewer', 'session-reviewer');
    const executor = makeExecutor(ctx, workflow);

    for (let i = 0; i < 3; i++) {
      const result = await executor.execute({
        fromAgentName: 'coder',
        fromSessionId: 'session-coder',
        workflowNodeId: 'n-coding',
        operation: { target: 'review', summary: `round ${i}` },
      });
      expect(result.status).toBe('delivered'); // never capped — not cyclic
    }
  });

  test('a refund does not decrement across a human-reset epoch boundary', () => {
    // Direct repo test of the epoch guard: a reservation made before a human
    // reset must not erase a post-reset reservation when its (late) refund runs.
    const key = 'n-review/to-coding';
    // Handoff A reserves (epoch 0, count 1).
    const a = ctx.handoffCycleRepo.increment(ctx.runId, key, 5);
    expect(a.reserved).toBe(true);
    expect(a.epoch).toBe(0);
    expect(ctx.handoffCycleRepo.get(ctx.runId, key)?.count).toBe(1);

    // Human touch resets the run — epoch bumps to 1, count zeroes.
    ctx.handoffCycleRepo.resetAllForRun(ctx.runId);
    expect(ctx.handoffCycleRepo.get(ctx.runId, key)?.epoch).toBe(1);

    // Handoff B reserves post-reset (epoch 1, count 1).
    const b = ctx.handoffCycleRepo.increment(ctx.runId, key, 5);
    expect(b.epoch).toBe(1);
    expect(ctx.handoffCycleRepo.get(ctx.runId, key)?.count).toBe(1);

    // A's late refund (epoch 0) is a no-op — B's reservation survives.
    ctx.handoffCycleRepo.decrement(ctx.runId, key, a.epoch);
    expect(ctx.handoffCycleRepo.get(ctx.runId, key)?.count).toBe(1);

    // B's own refund (epoch 1) still works.
    ctx.handoffCycleRepo.decrement(ctx.runId, key, b.epoch);
    expect(ctx.handoffCycleRepo.get(ctx.runId, key)?.count).toBe(0);
  });

  test('increment returns reserved:false once the cap is reached (cap signal)', () => {
    const key = 'n-review/to-coding';
    expect(ctx.handoffCycleRepo.increment(ctx.runId, key, 2).reserved).toBe(true);
    expect(ctx.handoffCycleRepo.increment(ctx.runId, key, 2).reserved).toBe(true);
    // Cap of 2 reached — the cap-guarded UPSERT no-ops and reserved is false
    // (NOT inferred from row existence, which would always be true here).
    const at = ctx.handoffCycleRepo.increment(ctx.runId, key, 2);
    expect(at.reserved).toBe(false);
    expect(ctx.handoffCycleRepo.get(ctx.runId, key)?.count).toBe(2);
  });

  test('an incomplete broadcast refunds its cycle reservation', async () => {
    // Cyclic broadcast: coding (LAST in node order) → all. review is earlier
    // in node order and has a transition back to coding, so the broadcast
    // hands ownership backward and is cyclic (maxCycles 2).
    const workflow = makeWorkflow({
      nodes: [
        node('n-review', 'review', 'reviewer', [{ id: 'back', target: 'coding' }]),
        node('n-qa', 'qa', 'tester'),
        node('n-coding', 'coding', 'coder', [{ id: 'broadcast', target: '*', maxCycles: 2 }]),
      ],
      channels: [{ id: 'ch', from: 'coding', to: ['review', 'qa'] }],
    });
    seedPeer(ctx.db, ctx.runId, 'n-review', 'reviewer', 'session-reviewer');
    // qa (tester) is NOT live and no queue is configured → broadcast incomplete.
    const executor = makeExecutor(ctx, workflow);
    const key = 'n-coding/broadcast';

    const result = await executor.execute({
      fromAgentName: 'coder',
      fromSessionId: 'session-coder',
      workflowNodeId: 'n-coding',
      operation: { target: '*', summary: 'all' },
    });

    expect(result.status).toBe('failed');
    // The broadcast wasn't accepted, so its reservation is refunded (count 0),
    // even though the reviewer received a message.
    expect(ctx.handoffCycleRepo.get(ctx.runId, key)?.count ?? 0).toBe(0);
  });
});

describe('HandoffExecutor: queued activation', () => {
  let ctx: Ctx;
  beforeEach(() => {
    ctx = makeCtx();
  });
  afterEach(() => ctx.db.close());

  test('delivers to a session the activation callback returns before its row is observable', async () => {
    const workflow = makeWorkflow({
      nodes: [
        node('n-coding', 'coding', 'coder', [{ id: 'to-review', target: 'review' }]),
        node('n-review', 'review', 'reviewer'),
      ],
      channels: [{ id: 'ch', from: 'coding', to: 'review' }],
    });
    // No seeded execution row; activation spawns a live session but the
    // node_executions reread still finds nothing — the returned session must
    // be used rather than queueing (send_message parity).
    const executor = makeExecutor(ctx, workflow, {
      activateTargetSession: async (agentName) => {
        ctx.activations.push(agentName);
        return [{ agentName, sessionId: 'session-just-activated' }];
      },
    });

    const result = await executor.execute({
      fromAgentName: 'coder',
      fromSessionId: 'session-coder',
      workflowNodeId: 'n-coding',
      operation: { target: 'review', summary: 'go' },
    });

    expect(result.status).toBe('delivered');
    expect(result.delivered).toEqual([
      { agentName: 'reviewer', sessionId: 'session-just-activated' },
    ]);
    expect(ctx.injected).toHaveLength(1);
    expect(ctx.injected[0].sessionId).toBe('session-just-activated');
  });

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

  test('does not select a pending execution that retained a dead session id (spawn retry)', async () => {
    const workflow = makeWorkflow({
      nodes: [
        node('n-coding', 'coding', 'coder', [{ id: 'to-review', target: 'review' }]),
        node('n-review', 'review', 'reviewer'),
      ],
      channels: [{ id: 'ch', from: 'coding', to: 'review' }],
    });
    // A spawn-retry pending row RETAINS the previous (dead) agentSessionId —
    // selecting it would inject into the dead session instead of letting the
    // queue (or activation) recover the handoff. Mirrors the production
    // session lookup in task-agent-manager.ts, which excludes `pending`.
    const repo = new NodeExecutionRepository(ctx.db);
    const pending = repo.createOrIgnore({
      workflowRunId: ctx.runId,
      workflowNodeId: 'n-review',
      agentName: 'reviewer',
      agentSessionId: 'session-dead',
      status: 'pending',
    });
    repo.update(pending.id, { agentSessionId: 'session-dead', status: 'pending' });
    const executor = makeExecutor(ctx, workflow, {
      pendingMessageRepo: ctx.pendingMessageRepo,
    });

    const result = await executor.execute({
      fromAgentName: 'coder',
      fromSessionId: 'session-coder',
      workflowNodeId: 'n-coding',
      operation: { target: 'review', summary: 'go' },
    });

    expect(result.status).toBe('queued'); // durable queue recovers it
    expect(ctx.injected).toHaveLength(0); // never injected into the dead session
  });

  test('delivers to a waiting_rebind peer (live session), matching send_message parity', async () => {
    const workflow = makeWorkflow({
      nodes: [
        node('n-coding', 'coding', 'coder', [{ id: 'to-review', target: 'review' }]),
        node('n-review', 'review', 'reviewer'),
      ],
      channels: [{ id: 'ch', from: 'coding', to: 'review' }],
    });
    // waiting_rebind is an orphaned-tool-result recovery pause — the session is
    // alive. A handoff must reach it directly, not fall through to reactivation.
    const repo = new NodeExecutionRepository(ctx.db);
    const rebind = repo.createOrIgnore({
      workflowRunId: ctx.runId,
      workflowNodeId: 'n-review',
      agentName: 'reviewer',
      agentSessionId: 'session-rebind',
      status: 'waiting_rebind',
    });
    repo.update(rebind.id, { agentSessionId: 'session-rebind', status: 'waiting_rebind' });
    const executor = makeExecutor(ctx, workflow);

    const result = await executor.execute({
      fromAgentName: 'coder',
      fromSessionId: 'session-coder',
      workflowNodeId: 'n-coding',
      operation: { target: 'review', summary: 'go' },
    });

    expect(result.status).toBe('delivered');
    expect(result.delivered[0].sessionId).toBe('session-rebind');
    expect(ctx.activations).toHaveLength(0); // did not fall through to activation
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

describe('HandoffExecutor: sender validation', () => {
  let ctx: Ctx;
  beforeEach(() => {
    ctx = makeCtx();
  });
  afterEach(() => ctx.db.close());

  /** Direct executor (no sender auto-seed from makeExecutor). */
  function bareExecutor(workflow: SpaceWorkflow): HandoffExecutor {
    return new HandoffExecutor({
      workflowRunRepo: ctx.workflowRunRepo,
      workflow,
      handoffCycleRepo: ctx.handoffCycleRepo,
      nodeExecutionRepo: ctx.nodeExecutionRepo,
      workflowRunId: ctx.runId,
      spaceId: ctx.spaceId,
      messageInjector: async () => {},
    });
  }

  function senderWorkflow(): SpaceWorkflow {
    return makeWorkflow({
      nodes: [
        node('n-coding', 'coding', 'coder', [{ id: 'to-review', target: 'review' }]),
        node('n-review', 'review', 'reviewer'),
      ],
    });
  }

  test('blocks when no execution matches the sender identity', async () => {
    const executor = bareExecutor(senderWorkflow());
    const result = await executor.execute({
      fromAgentName: 'coder',
      fromSessionId: 'session-coder',
      workflowNodeId: 'n-coding',
      operation: { target: 'review', summary: 'go' },
    });
    expect(result.status).toBe('blocked');
    expect(result.stage).toBe('resolve_source');
    expect(result.reason).toContain('No active execution');
  });

  test('blocks a cancelled sender execution (stale session finishing late)', async () => {
    const repo = new NodeExecutionRepository(ctx.db);
    const cancelled = repo.createOrIgnore({
      workflowRunId: ctx.runId,
      workflowNodeId: 'n-coding',
      agentName: 'coder',
      agentSessionId: 'session-coder',
      status: 'cancelled',
    });
    repo.update(cancelled.id, { agentSessionId: 'session-coder', status: 'cancelled' });
    const executor = bareExecutor(senderWorkflow());

    const result = await executor.execute({
      fromAgentName: 'coder',
      fromSessionId: 'session-coder',
      workflowNodeId: 'n-coding',
      operation: { target: 'review', summary: 'go' },
    });

    expect(result.status).toBe('blocked');
    expect(result.stage).toBe('resolve_source');
  });

  test('blocks a pending sender execution that retained a dead session id', async () => {
    const repo = new NodeExecutionRepository(ctx.db);
    const pending = repo.createOrIgnore({
      workflowRunId: ctx.runId,
      workflowNodeId: 'n-coding',
      agentName: 'coder',
      agentSessionId: 'session-coder',
      status: 'pending',
    });
    repo.update(pending.id, { agentSessionId: 'session-coder', status: 'pending' });
    const executor = bareExecutor(senderWorkflow());

    const result = await executor.execute({
      fromAgentName: 'coder',
      fromSessionId: 'session-coder',
      workflowNodeId: 'n-coding',
      operation: { target: 'review', summary: 'go' },
    });

    expect(result.status).toBe('blocked');
    expect(result.stage).toBe('resolve_source');
  });

  test('blocks a mismatched (agent, session, node) triple even when the row exists', async () => {
    // A live execution exists for coder on n-coding, but the caller claims a
    // different session id — it must not authorize coder's transitions.
    seedPeer(ctx.db, ctx.runId, 'n-coding', 'coder', 'session-real-coder');
    const executor = bareExecutor(senderWorkflow());

    const result = await executor.execute({
      fromAgentName: 'coder',
      fromSessionId: 'session-impostor',
      workflowNodeId: 'n-coding',
      operation: { target: 'review', summary: 'go' },
    });

    expect(result.status).toBe('blocked');
    expect(result.stage).toBe('resolve_source');
  });

  test('a live sender execution authorizes the handoff', async () => {
    seedPeer(ctx.db, ctx.runId, 'n-coding', 'coder', 'session-coder');
    seedPeer(ctx.db, ctx.runId, 'n-review', 'reviewer', 'session-reviewer');
    const executor = bareExecutor(senderWorkflow());

    const result = await executor.execute({
      fromAgentName: 'coder',
      fromSessionId: 'session-coder',
      workflowNodeId: 'n-coding',
      operation: { target: 'review', summary: 'go' },
    });

    expect(result.status).toBe('delivered');
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
      pairs: [{ slot: 'reviewer', node: 'review' }],
      nodes: ['review'],
      slots: ['reviewer'],
    });
  });

  test('resolveHandoffTargetSlots: slot name targets a single slot', () => {
    const t: HandoffTransition = { id: 't', target: 'reviewer' };
    expect(resolveHandoffTargetSlots(workflow, coding, t)).toEqual({
      pairs: [{ slot: 'reviewer', node: 'review' }],
      nodes: ['review'],
      slots: ['reviewer'],
    });
  });

  test('resolveHandoffTargetSlots: broadcast excludes the sender node', () => {
    const t: HandoffTransition = { id: 't', target: '*' };
    expect(resolveHandoffTargetSlots(workflow, coding, t)).toEqual({
      pairs: [{ slot: 'reviewer', node: 'review' }],
      nodes: ['review'],
      slots: ['reviewer'],
    });
  });

  test('isCyclicHandoff: a back-edge is cyclic, a forward edge is not', () => {
    const wf = makeWorkflow({
      nodes: [
        node('n-coding', 'coding', 'coder', [{ id: 't1', target: 'review' }]),
        node('n-review', 'review', 'reviewer', [{ id: 't2', target: 'coding' }]),
      ],
    });
    // review→coding hands ownership backward (review is later in the nodes
    // array) — the back-edge closes the loop coding→review→coding.
    expect(isCyclicHandoff(wf, 'review', ['coding'])).toBe(true);
    // coding→review is a FORWARD edge: it must NOT be classified cyclic even
    // though review can route back (mirrors isChannelCyclic's node-order test;
    // capping the forward edge at the default would defeat a maxCycles set on
    // the back-edge that actually loops).
    expect(isCyclicHandoff(wf, 'coding', ['review'])).toBe(false);
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
