/**
 * Unit tests for AgentMessageRouter
 *
 * Covers all message routing scenarios:
 *   - Agent name (role) target → DM
 *   - Multiple agents sharing a role → fan-out
 *   - Broadcast '*' → all permitted targets
 *   - Node name target → fan-out via nodeGroups
 *   - Unknown target → clear error
 *   - Unauthorized target → error with permitted targets
 *   - Empty topology → error
 *   - Partial delivery failure → partial success
 *   - All deliveries fail → false success
 */

import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { Database as BunDatabase } from '../../../../src/storage/sqlite-compat';
import { runMigrations } from '../../../../src/storage/schema/index.ts';
import { PendingAgentMessageRepository } from '../../../../src/storage/repositories/pending-agent-message-repository.ts';
import { NodeExecutionRepository } from '../../../../src/storage/repositories/node-execution-repository.ts';
import { SpaceWorkflowRepository } from '../../../../src/storage/repositories/space-workflow-repository.ts';
import { SpaceWorkflowRunRepository } from '../../../../src/storage/repositories/space-workflow-run-repository.ts';
import { AgentMessageRouter } from '../../../../src/lib/space/runtime/agent-message-router.ts';
import type { AgentMessageRouterConfig } from '../../../../src/lib/space/runtime/agent-message-router.ts';
import type { WorkflowChannel } from '@hyperneo/shared';

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

function seedSpaceRow(db: BunDatabase, spaceId: string): void {
  db.prepare(
    `INSERT INTO spaces (id, workspace_path, name, description, background_context, instructions,
     allowed_models, session_ids, slug, status, created_at, updated_at)
     VALUES (?, '/tmp', ?, '', '', '', '[]', '[]', ?, 'active', ?, ?)`
  ).run(spaceId, `Space ${spaceId}`, spaceId, Date.now(), Date.now());
}

function seedWorkflowRunWithChannels(
  db: BunDatabase,
  spaceId: string,
  channels: WorkflowChannel[]
): { runId: string; channels: WorkflowChannel[] } {
  const workflowRepo = new SpaceWorkflowRepository(db);
  const workflow = workflowRepo.createWorkflow({
    spaceId,
    name: 'Test Workflow',
    description: '',
    nodes: [],
    transitions: [],
    startNodeId: '',
    rules: [],
    completionAutonomyLevel: 3,
  });

  const runRepo = new SpaceWorkflowRunRepository(db);
  const run = runRepo.createRun({
    spaceId,
    workflowId: workflow.id,
    title: 'Test Run',
  });

  // Channels are now passed directly to AgentMessageRouter (not stored in run config)
  return { runId: run.id, channels };
}

function makeChannel(from: string, to: string | string[]): WorkflowChannel {
  return {
    id: `ch-${from}-${Array.isArray(to) ? to.join('-') : to}`,
    from,
    to,
  };
}
function makeResolvedChannel(
  fromAgentName: string,
  toRole: string,
  _isHubSpoke = false
): WorkflowChannel {
  return makeChannel(fromAgentName, toRole);
}

// ---------------------------------------------------------------------------
// Test context
// ---------------------------------------------------------------------------

interface TestCtx {
  db: BunDatabase;
  spaceId: string;
  nodeExecutionRepo: NodeExecutionRepository;
  workflowRunRepo: SpaceWorkflowRunRepository;
  nodeId: string;
  coderSessionId: string;
  reviewerSessionId: string;
}

/** Seeds a node execution with the given role and session for routing purposes. */
function seedPeerTask(
  repoOrDb: NodeExecutionRepository | BunDatabase,
  arg2: string,
  arg3: string,
  arg4: string,
  arg5: string,
  arg6?: string
): void {
  const nodeExecutionRepo =
    repoOrDb instanceof NodeExecutionRepository ? repoOrDb : new NodeExecutionRepository(repoOrDb);
  const workflowRunId = repoOrDb instanceof NodeExecutionRepository ? arg2 : arg3;
  const nodeId = repoOrDb instanceof NodeExecutionRepository ? arg3 : arg4;
  const agentName = repoOrDb instanceof NodeExecutionRepository ? arg4 : arg5;
  const sessionId = repoOrDb instanceof NodeExecutionRepository ? arg5 : (arg6 ?? '');

  const execution = nodeExecutionRepo.createOrIgnore({
    workflowRunId,
    workflowNodeId: nodeId,
    agentName,
    agentSessionId: sessionId,
    status: 'in_progress',
  });
  nodeExecutionRepo.update(execution.id, {
    agentSessionId: sessionId,
    status: 'in_progress',
  });
}

function makeCtx(): TestCtx {
  const db = makeDb();
  const spaceId = 'space-channel-router-test';

  seedSpaceRow(db, spaceId);

  const nodeExecutionRepo = new NodeExecutionRepository(db);
  const workflowRunRepo = new SpaceWorkflowRunRepository(db);

  const nodeId = 'node-test-router';
  const coderSessionId = 'session-coder';
  const reviewerSessionId = 'session-reviewer';

  return {
    db,
    spaceId,
    nodeExecutionRepo,
    workflowRunRepo,
    nodeId,
    coderSessionId,
    reviewerSessionId,
  };
}

function makeRouter(
  ctx: TestCtx,
  workflowRunId: string,
  injected: Array<{ sessionId: string; message: string }>,
  channels: WorkflowChannel[] = [],
  overrides: Partial<AgentMessageRouterConfig> = {}
): AgentMessageRouter {
  return new AgentMessageRouter({
    nodeExecutionRepo: ctx.nodeExecutionRepo,
    workflowRunId,
    workflowChannels: channels,
    messageInjector: async (sessionId, message) => {
      injected.push({ sessionId, message });
    },
    ...overrides,
  });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('AgentMessageRouter: agent name (role) target → DM', () => {
  let ctx: TestCtx;

  beforeEach(() => {
    ctx = makeCtx();
  });

  afterEach(() => {
    ctx.db.close();
  });

  test('delivers message to single session with matching role', async () => {
    const { runId: workflowRunId, channels: runChannels } = seedWorkflowRunWithChannels(
      ctx.db,
      ctx.spaceId,
      [makeResolvedChannel('coder', 'reviewer')]
    );
    seedPeerTask(ctx.db, ctx.spaceId, workflowRunId, ctx.nodeId, 'coder', ctx.coderSessionId);
    seedPeerTask(ctx.db, ctx.spaceId, workflowRunId, ctx.nodeId, 'reviewer', ctx.reviewerSessionId);
    const injected: Array<{ sessionId: string; message: string }> = [];
    const router = makeRouter(ctx, workflowRunId, injected, runChannels);

    const result = await router.deliverMessage({
      fromAgentName: 'coder',
      fromSessionId: ctx.coderSessionId,
      target: 'reviewer',
      message: 'LGTM!',
    });

    expect(result.success).toBe(true);
    expect(result.delivered).toHaveLength(1);
    expect(result.delivered[0].sessionId).toBe(ctx.reviewerSessionId);
    expect(result.delivered[0].agentName).toBe('reviewer');
    expect(injected).toHaveLength(1);
    expect(injected[0].message).toBe('─── Message from coder ───\n\nLGTM!');
  });
});

describe('AgentMessageRouter: single agent per role (task-centric model)', () => {
  // In the new task-centric model, each agent_name is unique per (workflow_run, node).
  // Fan-out to multiple agents of the same role is no longer supported — each role maps
  // to exactly one task/session. This describe block verifies DM to a single peer works.
  let ctx: TestCtx;

  beforeEach(() => {
    ctx = makeCtx();
  });

  afterEach(() => {
    ctx.db.close();
  });

  test('delivers to the single session with the target role', async () => {
    const { runId: workflowRunId, channels: runChannels } = seedWorkflowRunWithChannels(
      ctx.db,
      ctx.spaceId,
      [makeResolvedChannel('coder', 'reviewer')]
    );
    seedPeerTask(ctx.db, ctx.spaceId, workflowRunId, ctx.nodeId, 'coder', ctx.coderSessionId);
    seedPeerTask(ctx.db, ctx.spaceId, workflowRunId, ctx.nodeId, 'reviewer', ctx.reviewerSessionId);

    const injected: Array<{ sessionId: string; message: string }> = [];
    const router = makeRouter(ctx, workflowRunId, injected, runChannels);

    const result = await router.deliverMessage({
      fromAgentName: 'coder',
      fromSessionId: ctx.coderSessionId,
      target: 'reviewer',
      message: 'hello!',
    });

    expect(result.success).toBe(true);
    expect(result.delivered).toHaveLength(1);
    expect(result.delivered[0].sessionId).toBe(ctx.reviewerSessionId);
  });
});

describe('AgentMessageRouter: broadcast * → all permitted targets', () => {
  let ctx: TestCtx;

  beforeEach(() => {
    ctx = makeCtx();
  });

  afterEach(() => {
    ctx.db.close();
  });

  test('delivers to all topology-permitted targets', async () => {
    const { runId: workflowRunId, channels: runChannels } = seedWorkflowRunWithChannels(
      ctx.db,
      ctx.spaceId,
      [makeResolvedChannel('coder', 'reviewer'), makeResolvedChannel('coder', 'security')]
    );
    seedPeerTask(ctx.db, ctx.spaceId, workflowRunId, ctx.nodeId, 'coder', ctx.coderSessionId);
    seedPeerTask(ctx.db, ctx.spaceId, workflowRunId, ctx.nodeId, 'reviewer', ctx.reviewerSessionId);
    // Add a security member
    seedPeerTask(ctx.db, ctx.spaceId, workflowRunId, ctx.nodeId, 'security', 'session-security');

    const injected: string[] = [];
    const router = makeRouter(ctx, workflowRunId, [], runChannels, {
      messageInjector: async (sid) => {
        injected.push(sid);
      },
    });

    const result = await router.deliverMessage({
      fromAgentName: 'coder',
      fromSessionId: ctx.coderSessionId,
      target: '*',
      message: 'broadcast!',
    });

    expect(result.success).toBe(true);
    expect(result.delivered).toHaveLength(2);
    expect(injected).toContain(ctx.reviewerSessionId);
    expect(injected).toContain('session-security');
  });

  test('returns error when role has no permitted targets', async () => {
    const { runId: workflowRunId, channels: runChannels } = seedWorkflowRunWithChannels(
      ctx.db,
      ctx.spaceId,
      [
        makeResolvedChannel('reviewer', 'coder'), // coder has no outgoing channels
      ]
    );
    seedPeerTask(ctx.db, ctx.spaceId, workflowRunId, ctx.nodeId, 'coder', ctx.coderSessionId);
    const router = makeRouter(ctx, workflowRunId, [], runChannels);

    const result = await router.deliverMessage({
      fromAgentName: 'coder',
      fromSessionId: ctx.coderSessionId,
      target: '*',
      message: 'broadcast',
    });

    expect(result.success).toBe(false);
    expect(result.reason).toContain("No permitted targets for agent 'coder'");
  });
});

describe('AgentMessageRouter: built-in inter-level targets', () => {
  let ctx: TestCtx;

  beforeEach(() => {
    ctx = makeCtx();
  });

  afterEach(() => {
    ctx.db.close();
  });

  test('delivers node messages to the Space Agent without declared topology', async () => {
    const { runId: workflowRunId, channels: runChannels } = seedWorkflowRunWithChannels(
      ctx.db,
      ctx.spaceId,
      []
    );
    seedPeerTask(ctx.db, ctx.spaceId, workflowRunId, ctx.nodeId, 'coder', ctx.coderSessionId);
    const spaceMessages: Array<{ spaceId: string; message: string }> = [];
    const router = makeRouter(ctx, workflowRunId, [], runChannels, {
      spaceId: ctx.spaceId,
      taskId: 'task-123',
      taskNumber: 236,
      spaceAgentInjector: async (spaceId, message) => {
        spaceMessages.push({ spaceId, message });
      },
    });

    const result = await router.deliverMessage({
      fromAgentName: 'coder',
      fromSessionId: ctx.coderSessionId,
      target: 'space-agent',
      message: 'Blocked on product decision',
    });

    expect(result.success).toBe(true);
    expect(result.delivered).toEqual([
      { agentName: 'space-agent', sessionId: `space:chat:${ctx.spaceId}` },
    ]);
    expect(spaceMessages).toEqual([
      {
        spaceId: ctx.spaceId,
        message:
          '─── Message from coder (task #236) ───\n\n' +
          'Blocked on product decision\n\n' +
          '─── Reply ───\n' +
          'To reply, use: send_message_to_task with task_id="task-123" and target node "coder"',
      },
    ]);
  });

  test('delivers array target space-agent to the built-in Space Agent', async () => {
    const { runId: workflowRunId, channels: runChannels } = seedWorkflowRunWithChannels(
      ctx.db,
      ctx.spaceId,
      []
    );
    seedPeerTask(ctx.db, ctx.spaceId, workflowRunId, ctx.nodeId, 'coder', ctx.coderSessionId);
    const spaceMessages: Array<{ spaceId: string; message: string }> = [];
    const router = makeRouter(ctx, workflowRunId, [], runChannels, {
      spaceId: ctx.spaceId,
      taskId: 'task-123',
      taskNumber: 236,
      spaceAgentInjector: async (spaceId, message) => {
        spaceMessages.push({ spaceId, message });
      },
    });

    const result = await router.deliverMessage({
      fromAgentName: 'coder',
      fromSessionId: ctx.coderSessionId,
      target: ['space-agent'],
      message: 'Array escalation',
    });

    expect(result.success).toBe(true);
    expect(result.delivered).toEqual([
      { agentName: 'space-agent', sessionId: `space:chat:${ctx.spaceId}` },
    ]);
    expect(spaceMessages).toEqual([
      {
        spaceId: ctx.spaceId,
        message:
          '─── Message from coder (task #236) ───\n\n' +
          'Array escalation\n\n' +
          '─── Reply ───\n' +
          'To reply, use: send_message_to_task with task_id="task-123" and target node "coder"',
      },
    ]);
  });
  test('targeting task-agent returns failure (removed)', async () => {
    const { runId: workflowRunId, channels: runChannels } = seedWorkflowRunWithChannels(
      ctx.db,
      ctx.spaceId,
      []
    );
    seedPeerTask(ctx.db, ctx.spaceId, workflowRunId, ctx.nodeId, 'coder', ctx.coderSessionId);
    const router = makeRouter(ctx, workflowRunId, [], runChannels, {
      taskId: 'task-123',
      taskNumber: 236,
    });

    const result = await router.deliverMessage({
      fromAgentName: 'coder',
      fromSessionId: ctx.coderSessionId,
      target: 'task-agent',
      message: 'Need coordination',
    });

    expect(result.success).toBe(false);
  });
});

describe('AgentMessageRouter: unknown target → clear error', () => {
  let ctx: TestCtx;

  beforeEach(() => {
    ctx = makeCtx();
  });

  afterEach(() => {
    ctx.db.close();
  });

  test('returns error with "no agent or node found" when target unknown', async () => {
    const { runId: workflowRunId, channels: runChannels } = seedWorkflowRunWithChannels(
      ctx.db,
      ctx.spaceId,
      [makeResolvedChannel('coder', 'reviewer')]
    );
    seedPeerTask(ctx.db, ctx.spaceId, workflowRunId, ctx.nodeId, 'coder', ctx.coderSessionId);
    seedPeerTask(ctx.db, ctx.spaceId, workflowRunId, ctx.nodeId, 'reviewer', ctx.reviewerSessionId);
    const router = makeRouter(ctx, workflowRunId, [], runChannels);

    const result = await router.deliverMessage({
      fromAgentName: 'coder',
      fromSessionId: ctx.coderSessionId,
      target: 'nonexistent-agent',
      message: 'hello',
    });

    expect(result.success).toBe(false);
    expect(result.reason).toContain('no agent or node found');
    expect(result.reason).toContain("Unknown target 'nonexistent-agent'");
  });

  test('lists reachable targets in error when peers exist', async () => {
    const { runId: workflowRunId, channels: runChannels } = seedWorkflowRunWithChannels(
      ctx.db,
      ctx.spaceId,
      [makeResolvedChannel('coder', 'reviewer')]
    );
    seedPeerTask(ctx.db, ctx.spaceId, workflowRunId, ctx.nodeId, 'coder', ctx.coderSessionId);
    seedPeerTask(ctx.db, ctx.spaceId, workflowRunId, ctx.nodeId, 'reviewer', ctx.reviewerSessionId);
    const router = makeRouter(ctx, workflowRunId, [], runChannels);

    const result = await router.deliverMessage({
      fromAgentName: 'coder',
      fromSessionId: ctx.coderSessionId,
      target: 'ghost',
      message: 'ping',
    });

    expect(result.success).toBe(false);
    expect(result.reason).toContain('Reachable targets: reviewer');
  });
});

describe('AgentMessageRouter: unauthorized target → error with permitted targets', () => {
  let ctx: TestCtx;

  beforeEach(() => {
    ctx = makeCtx();
  });

  afterEach(() => {
    ctx.db.close();
  });

  test('returns error when channel topology forbids the send', async () => {
    // reviewer → coder channel only (coder cannot send to reviewer)
    const { runId: workflowRunId, channels: runChannels } = seedWorkflowRunWithChannels(
      ctx.db,
      ctx.spaceId,
      [makeResolvedChannel('reviewer', 'coder')]
    );
    seedPeerTask(ctx.db, ctx.spaceId, workflowRunId, ctx.nodeId, 'coder', ctx.coderSessionId);
    seedPeerTask(ctx.db, ctx.spaceId, workflowRunId, ctx.nodeId, 'reviewer', ctx.reviewerSessionId);
    const router = makeRouter(ctx, workflowRunId, [], runChannels);

    const result = await router.deliverMessage({
      fromAgentName: 'coder',
      fromSessionId: ctx.coderSessionId,
      target: 'reviewer',
      message: 'unauthorized!',
    });

    expect(result.success).toBe(false);
    expect(result.reason).toContain("does not permit 'coder' to send to: reviewer");
    expect(result.reason).toContain('Permitted targets:');
  });
});

describe('AgentMessageRouter: unauthorized target → error with structured fields', () => {
  let ctx: TestCtx;

  beforeEach(() => {
    ctx = makeCtx();
  });

  afterEach(() => {
    ctx.db.close();
  });

  test('populates unauthorizedAgentNames and permittedTargets structured fields on auth failure', async () => {
    // reviewer → coder channel only (coder cannot send to reviewer)
    const { runId: workflowRunId, channels: runChannels } = seedWorkflowRunWithChannels(
      ctx.db,
      ctx.spaceId,
      [makeResolvedChannel('reviewer', 'coder')]
    );
    seedPeerTask(ctx.db, ctx.spaceId, workflowRunId, ctx.nodeId, 'coder', ctx.coderSessionId);
    seedPeerTask(ctx.db, ctx.spaceId, workflowRunId, ctx.nodeId, 'reviewer', ctx.reviewerSessionId);
    const router = makeRouter(ctx, workflowRunId, [], runChannels);

    const result = await router.deliverMessage({
      fromAgentName: 'coder',
      fromSessionId: ctx.coderSessionId,
      target: 'reviewer',
      message: 'unauthorized!',
    });

    expect(result.success).toBe(false);
    expect(result.unauthorizedAgentNames).toBeDefined();
    expect(result.unauthorizedAgentNames).toContain('reviewer');
    expect(result.permittedTargets).toBeDefined();
    // coder has no permitted targets in this topology
    expect(result.permittedTargets).toHaveLength(0);
  });
});

describe('AgentMessageRouter: empty topology → error', () => {
  let ctx: TestCtx;

  beforeEach(() => {
    ctx = makeCtx();
  });

  afterEach(() => {
    ctx.db.close();
  });

  test('returns error when no channel topology is declared', async () => {
    // No channels in run config
    const { runId: workflowRunId, channels: runChannels } = seedWorkflowRunWithChannels(
      ctx.db,
      ctx.spaceId,
      []
    );
    seedPeerTask(ctx.db, ctx.spaceId, workflowRunId, ctx.nodeId, 'coder', ctx.coderSessionId);
    const router = makeRouter(ctx, workflowRunId, [], runChannels);

    const result = await router.deliverMessage({
      fromAgentName: 'coder',
      fromSessionId: ctx.coderSessionId,
      target: 'reviewer',
      message: 'test',
    });

    expect(result.success).toBe(false);
    expect(result.reason).toContain('No channel topology declared');
  });

  test('returns error when workflowRunId is empty (no run config)', async () => {
    const router = makeRouter(ctx, '', []);

    const result = await router.deliverMessage({
      fromAgentName: 'coder',
      fromSessionId: ctx.coderSessionId,
      target: 'reviewer',
      message: 'test',
    });

    expect(result.success).toBe(false);
    expect(result.reason).toContain('No channel topology declared');
  });
});

describe('AgentMessageRouter: partial delivery failure → partial success', () => {
  let ctx: TestCtx;

  beforeEach(() => {
    ctx = makeCtx();
  });

  afterEach(() => {
    ctx.db.close();
  });

  test('returns false success when the single session fails', async () => {
    // In the new model, each agent_name is unique per node — only one reviewer session.
    // Failure to deliver to that session results in success=false, not partial.
    const { runId: workflowRunId, channels: runChannels } = seedWorkflowRunWithChannels(
      ctx.db,
      ctx.spaceId,
      [makeResolvedChannel('coder', 'reviewer')]
    );
    seedPeerTask(ctx.db, ctx.spaceId, workflowRunId, ctx.nodeId, 'coder', ctx.coderSessionId);
    seedPeerTask(ctx.db, ctx.spaceId, workflowRunId, ctx.nodeId, 'reviewer', ctx.reviewerSessionId);

    const router = makeRouter(ctx, workflowRunId, [], runChannels, {
      messageInjector: async (_sid) => {
        throw new Error('injection failed');
      },
    });

    const result = await router.deliverMessage({
      fromAgentName: 'coder',
      fromSessionId: ctx.coderSessionId,
      target: 'reviewer',
      message: 'hello',
    });

    expect(result.success).toBe(false);
    expect(result.delivered).toHaveLength(0);
    expect(result.failed).toHaveLength(1);
  });
});

describe('AgentMessageRouter: all deliveries fail → false success', () => {
  let ctx: TestCtx;

  beforeEach(() => {
    ctx = makeCtx();
  });

  afterEach(() => {
    ctx.db.close();
  });

  test('returns success: false when all injections fail', async () => {
    const { runId: workflowRunId, channels: runChannels } = seedWorkflowRunWithChannels(
      ctx.db,
      ctx.spaceId,
      [makeResolvedChannel('coder', 'reviewer')]
    );
    seedPeerTask(ctx.db, ctx.spaceId, workflowRunId, ctx.nodeId, 'coder', ctx.coderSessionId);
    seedPeerTask(ctx.db, ctx.spaceId, workflowRunId, ctx.nodeId, 'reviewer', ctx.reviewerSessionId);
    const router = makeRouter(ctx, workflowRunId, [], runChannels, {
      messageInjector: async () => {
        throw new Error('always fails');
      },
    });

    const result = await router.deliverMessage({
      fromAgentName: 'coder',
      fromSessionId: ctx.coderSessionId,
      target: 'reviewer',
      message: 'test',
    });

    expect(result.success).toBe(false);
    expect(result.delivered).toHaveLength(0);
    expect(result.failed).toHaveLength(1);
  });
});

describe('AgentMessageRouter: node name target with nodeGroups → fan-out', () => {
  let ctx: TestCtx;

  beforeEach(() => {
    ctx = makeCtx();
  });

  afterEach(() => {
    ctx.db.close();
  });

  test('delivers to all roles mapped to a node name', async () => {
    // Use node names in channels (coder-node → review-node), matching nodeGroups
    const { runId: workflowRunId, channels: runChannels } = seedWorkflowRunWithChannels(
      ctx.db,
      ctx.spaceId,
      [makeChannel('coder-node', 'review-node')]
    );
    seedPeerTask(ctx.db, ctx.spaceId, workflowRunId, ctx.nodeId, 'coder', ctx.coderSessionId);
    seedPeerTask(ctx.db, ctx.spaceId, workflowRunId, ctx.nodeId, 'reviewer', ctx.reviewerSessionId);
    seedPeerTask(ctx.db, ctx.spaceId, workflowRunId, ctx.nodeId, 'security', 'session-security');

    const injected: string[] = [];
    const router = makeRouter(ctx, workflowRunId, [], runChannels, {
      messageInjector: async (sid) => {
        injected.push(sid);
      },
      nodeGroups: {
        'coder-node': ['coder'],
        'review-node': ['reviewer', 'security'],
      },
    });

    const result = await router.deliverMessage({
      fromAgentName: 'coder',
      fromSessionId: ctx.coderSessionId,
      target: 'review-node',
      message: 'fan-out to node!',
    });

    expect(result.success).toBe(true);
    expect(result.delivered).toHaveLength(2);
    expect(injected).toContain(ctx.reviewerSessionId);
    expect(injected).toContain('session-security');
  });
});

describe('AgentMessageRouter: node name target without nodeGroups → unknown target error', () => {
  let ctx: TestCtx;

  beforeEach(() => {
    ctx = makeCtx();
  });

  afterEach(() => {
    ctx.db.close();
  });

  test('returns unknown target error when nodeGroups not configured', async () => {
    const { runId: workflowRunId, channels: runChannels } = seedWorkflowRunWithChannels(
      ctx.db,
      ctx.spaceId,
      [makeResolvedChannel('coder', 'reviewer')]
    );
    seedPeerTask(ctx.db, ctx.spaceId, workflowRunId, ctx.nodeId, 'coder', ctx.coderSessionId);
    seedPeerTask(ctx.db, ctx.spaceId, workflowRunId, ctx.nodeId, 'reviewer', ctx.reviewerSessionId);
    const router = makeRouter(ctx, workflowRunId, [], runChannels);
    // No nodeGroups configured

    const result = await router.deliverMessage({
      fromAgentName: 'coder',
      fromSessionId: ctx.coderSessionId,
      target: 'review-node',
      message: 'fan-out attempt',
    });

    expect(result.success).toBe(false);
    expect(result.reason).toContain("Unknown target 'review-node'");
    expect(result.reason).toContain('no agent or node found');
  });
});

describe('AgentMessageRouter: fromNodeName resolution edge cases', () => {
  // These tests guard the isTopologyDeclared check: when channels are node-name addressed
  // (e.g. from:'Coding') but the agent slot name differs (e.g. 'coder'), the check must
  // not false-positive by treating the slot name as a valid channel source.
  let ctx: TestCtx;

  beforeEach(() => {
    ctx = makeCtx();
  });

  afterEach(() => {
    ctx.db.close();
  });

  test('isTopologyDeclared is false when slot name differs from node-name-addressed channel source (no nodeGroups)', async () => {
    // Channel: { from: 'Coding', to: 'Review' }  ← node-name addressed
    // Agent slot name: 'coder'  ← doesn't match 'Coding'
    // No nodeGroups → fromNodeName resolves to identity 'coder'
    // getPermittedTargets('coder') → [] → isTopologyDeclared('Review') = false
    // Expected: "Unknown target 'Review'" (not "no active sessions found")
    const { runId: workflowRunId } = seedWorkflowRunWithChannels(ctx.db, ctx.spaceId, [
      makeChannel('Coding', 'Review'),
    ]);
    seedPeerTask(ctx.db, ctx.spaceId, workflowRunId, ctx.nodeId, 'coder', ctx.coderSessionId);

    // No nodeGroups — router cannot translate 'coder' → 'Coding'
    const router = makeRouter(ctx, workflowRunId, [], [makeChannel('Coding', 'Review')]);

    const result = await router.deliverMessage({
      fromAgentName: 'coder',
      fromSessionId: ctx.coderSessionId,
      target: 'Review',
      message: 'hello review',
    });

    expect(result.success).toBe(false);
    // Target was not in any execution record AND fromNodeName ('coder') ≠ channel source
    // ('Coding'), so topology check returns [] → isTopologyDeclared = false → unknown target
    expect(result.reason).toContain("Unknown target 'Review'");
    expect(result.reason).toContain('no agent or node found');
  });

  test('isTopologyDeclared is true when nodeGroups maps slot name to channel source', async () => {
    // Same channel setup as above, but this time nodeGroups tells the router that
    // agent 'coder' belongs to node 'Coding'. fromNodeName('coder') → 'Coding'.
    // getPermittedTargets('Coding') → ['Review'] → isTopologyDeclared('Review') = true.
    // No active session for 'Review', so message is queued (pendingMessageRepo provided).
    const { runId: workflowRunId } = seedWorkflowRunWithChannels(ctx.db, ctx.spaceId, [
      makeChannel('Coding', 'Review'),
    ]);
    seedPeerTask(ctx.db, ctx.spaceId, workflowRunId, ctx.nodeId, 'coder', ctx.coderSessionId);
    // 'Review' node not yet activated — no execution record

    const pendingMessageRepo = new PendingAgentMessageRepository(ctx.db);
    const router = makeRouter(ctx, workflowRunId, [], [makeChannel('Coding', 'Review')], {
      nodeGroups: { Coding: ['coder'] }, // maps slot → node name
      pendingMessageRepo,
      spaceId: ctx.spaceId,
    });

    const result = await router.deliverMessage({
      fromAgentName: 'coder',
      fromSessionId: ctx.coderSessionId,
      target: 'Review',
      message: 'hello review',
    });

    // With nodeGroups, the topology resolves correctly → isTopologyDeclared = true
    // No session exists → message queued (not "unknown target")
    expect(result.success).toBe(false);
    expect(result.queued).toHaveLength(1);
    expect(result.queued?.[0].agentName).toBe('Review');
  });
});

describe('AgentMessageRouter: notFoundAgentNames structured field', () => {
  let ctx: TestCtx;

  beforeEach(() => {
    ctx = makeCtx();
  });

  afterEach(() => {
    ctx.db.close();
  });

  test('populates notFoundAgentNames on broadcast when some permitted roles have no active sessions', async () => {
    // topology permits coder → reviewer and coder → ghost-role
    // but ghost-role has no active sessions
    const { runId: workflowRunId, channels: runChannels } = seedWorkflowRunWithChannels(
      ctx.db,
      ctx.spaceId,
      [makeResolvedChannel('coder', 'reviewer'), makeResolvedChannel('coder', 'ghost-role')]
    );
    seedPeerTask(ctx.db, ctx.spaceId, workflowRunId, ctx.nodeId, 'coder', ctx.coderSessionId);
    seedPeerTask(ctx.db, ctx.spaceId, workflowRunId, ctx.nodeId, 'reviewer', ctx.reviewerSessionId);
    // ghost-role has no task/session seeded

    const injected: Array<{ sessionId: string; message: string }> = [];
    const router = makeRouter(ctx, workflowRunId, injected, runChannels);

    // Broadcast to all permitted targets — reviewer exists, ghost-role does not
    const result = await router.deliverMessage({
      fromAgentName: 'coder',
      fromSessionId: ctx.coderSessionId,
      target: '*',
      message: 'broadcast to available',
    });

    // reviewer was delivered, ghost-role was not found
    expect(result.success).toBe(true);
    expect(result.delivered).toHaveLength(1);
    expect(result.delivered[0].agentName).toBe('reviewer');
    expect(result.notFoundAgentNames).toBeDefined();
    expect(result.notFoundAgentNames).toContain('ghost-role');
  });
});

// ---------------------------------------------------------------------------
// Tests: queue-when-inactive — Bug #2 fix (declared-but-no-session targets)
// ---------------------------------------------------------------------------

describe('AgentMessageRouter: queue message for declared-but-inactive target', () => {
  let ctx: TestCtx;

  beforeEach(() => {
    ctx = makeCtx();
  });

  afterEach(() => {
    ctx.db.close();
  });

  test('queues message when target has a pending execution but no active session', async () => {
    const { runId: workflowRunId } = seedWorkflowRunWithChannels(ctx.db, ctx.spaceId, [
      makeChannel('coder', 'reviewer'),
    ]);

    // Seed coder with session, reviewer WITHOUT a session (pending activation)
    seedPeerTask(ctx.db, ctx.spaceId, workflowRunId, ctx.nodeId, 'coder', ctx.coderSessionId);
    ctx.nodeExecutionRepo.createOrIgnore({
      workflowRunId,
      workflowNodeId: ctx.nodeId,
      agentName: 'reviewer',
      status: 'pending',
    });

    const pendingMessageRepo = new PendingAgentMessageRepository(ctx.db);
    const injected: string[] = [];

    const router = new AgentMessageRouter({
      nodeExecutionRepo: ctx.nodeExecutionRepo,
      workflowRunId,
      workflowChannels: [makeChannel('coder', 'reviewer')],
      messageInjector: async (sid) => {
        injected.push(sid);
      },
      pendingMessageRepo,
      spaceId: ctx.spaceId,
      taskId: null,
    });

    const result = await router.deliverMessage({
      fromAgentName: 'coder',
      fromSessionId: ctx.coderSessionId,
      target: 'reviewer',
      message: 'code ready',
    });

    // Message should be queued, not failed
    expect(result.success).toBe(false);
    expect(result.queued).toBeDefined();
    expect(result.queued).toHaveLength(1);
    expect(result.queued![0].agentName).toBe('reviewer');
    expect(result.delivered).toHaveLength(0);
    expect(injected).toHaveLength(0);

    // Verify queue record
    const pending = pendingMessageRepo.listPendingForTarget(workflowRunId, 'reviewer');
    expect(pending).toHaveLength(1);
    expect(pending[0].sourceAgentName).toBe('coder');
    expect(pending[0].message).toBe('─── Message from coder ───\n\ncode ready');
    expect(pending[0].targetKind).toBe('node_agent');
  });

  test('resolves target declared in execution even without live session (no sessionId filter)', async () => {
    // Bug #2: target resolution was filtering to only executions with agentSessionId.
    // Now it resolves all declared executions, enabling queuing.
    const { runId: workflowRunId } = seedWorkflowRunWithChannels(ctx.db, ctx.spaceId, [
      makeChannel('coder', 'reviewer'),
    ]);

    seedPeerTask(ctx.db, ctx.spaceId, workflowRunId, ctx.nodeId, 'coder', ctx.coderSessionId);
    // reviewer has an execution record but NO session ID
    ctx.nodeExecutionRepo.createOrIgnore({
      workflowRunId,
      workflowNodeId: ctx.nodeId,
      agentName: 'reviewer',
      status: 'in_progress', // in_progress but session hasn't been spawned yet
    });

    const pendingMessageRepo = new PendingAgentMessageRepository(ctx.db);

    const router = new AgentMessageRouter({
      nodeExecutionRepo: ctx.nodeExecutionRepo,
      workflowRunId,
      workflowChannels: [makeChannel('coder', 'reviewer')],
      messageInjector: async () => {},
      pendingMessageRepo,
      spaceId: ctx.spaceId,
      taskId: null,
    });

    const result = await router.deliverMessage({
      fromAgentName: 'coder',
      fromSessionId: ctx.coderSessionId,
      target: 'reviewer',
      message: 'hello reviewer',
    });

    // Should succeed by queuing, not fail with "Unknown target" or "No active sessions"
    expect(result.success).toBe(false);
    expect(result.queued).toBeDefined();
    expect(result.queued![0].agentName).toBe('reviewer');
  });

  test('activates and queues during pre-session window when the only execution has no session', async () => {
    const { runId: workflowRunId } = seedWorkflowRunWithChannels(ctx.db, ctx.spaceId, [
      makeChannel('coder', 'reviewer'),
    ]);

    // Mirrors the runtime log path: the run has a node_execution row, but no
    // agentSessionId has been assigned yet.
    ctx.nodeExecutionRepo.createOrIgnore({
      workflowRunId,
      workflowNodeId: ctx.nodeId,
      agentName: 'reviewer',
      status: 'pending',
    });

    const pendingMessageRepo = new PendingAgentMessageRepository(ctx.db);
    const activated: Array<{ runId: string; from: string; to: string; message: string }> = [];
    const injected: Array<{ sessionId: string; message: string }> = [];
    const router = makeRouter(ctx, workflowRunId, injected, [makeChannel('coder', 'reviewer')], {
      pendingMessageRepo,
      spaceId: ctx.spaceId,
      channelRouter: {
        deliverMessage: async (runId: string, from: string, to: string, msg: string) => {
          activated.push({ runId, from, to, message: msg });
          return {
            fromRole: from,
            toRole: to,
            message: msg,
            targetNodeId: 'review-node',
            isFanOut: false,
            activatedTasks: [{}],
          };
        },
      } as AgentMessageRouterConfig['channelRouter'],
    });

    const result = await router.deliverMessage({
      fromAgentName: 'coder',
      fromSessionId: ctx.coderSessionId,
      target: 'reviewer',
      message: 'code ready',
    });

    expect(result.success).toBe(false);
    expect(result.delivered).toHaveLength(0);
    expect(result.queued).toHaveLength(1);
    expect(result.queued![0].agentName).toBe('reviewer');
    expect(injected).toHaveLength(0);
    expect(activated).toEqual([
      { runId: workflowRunId, from: 'coder', to: 'reviewer', message: 'code ready' },
    ]);
    expect(pendingMessageRepo.listPendingForTarget(workflowRunId, 'reviewer')).toHaveLength(1);
  });

  test('delivers to live session if available, queues for inactive declared agents', async () => {
    const { runId: workflowRunId } = seedWorkflowRunWithChannels(ctx.db, ctx.spaceId, [
      makeChannel('coder', 'reviewer'),
      makeChannel('coder', 'security'),
    ]);

    seedPeerTask(ctx.db, ctx.spaceId, workflowRunId, ctx.nodeId, 'coder', ctx.coderSessionId);
    // reviewer has live session
    seedPeerTask(ctx.db, ctx.spaceId, workflowRunId, ctx.nodeId, 'reviewer', ctx.reviewerSessionId);
    // security has no session
    ctx.nodeExecutionRepo.createOrIgnore({
      workflowRunId,
      workflowNodeId: ctx.nodeId,
      agentName: 'security',
      status: 'pending',
    });

    const pendingMessageRepo = new PendingAgentMessageRepository(ctx.db);
    const injected: string[] = [];

    const router = new AgentMessageRouter({
      nodeExecutionRepo: ctx.nodeExecutionRepo,
      workflowRunId,
      workflowChannels: [makeChannel('coder', 'reviewer'), makeChannel('coder', 'security')],
      messageInjector: async (sid) => {
        injected.push(sid);
      },
      pendingMessageRepo,
      spaceId: ctx.spaceId,
      taskId: null,
    });

    const result = await router.deliverMessage({
      fromAgentName: 'coder',
      fromSessionId: ctx.coderSessionId,
      target: ['reviewer', 'security'],
      message: 'status update',
    });

    expect(result.success).toBe(true);
    expect(result.delivered).toHaveLength(1);
    expect(result.delivered[0].agentName).toBe('reviewer');
    expect(injected).toContain(ctx.reviewerSessionId);

    expect(result.queued).toBeDefined();
    expect(result.queued).toHaveLength(1);
    expect(result.queued![0].agentName).toBe('security');
  });

  test('still returns no-session error for topology-declared target without pendingMessageRepo', async () => {
    // Without a queue, topology-declared targets with no session result in notFound error
    const { runId: workflowRunId } = seedWorkflowRunWithChannels(ctx.db, ctx.spaceId, [
      makeChannel('coder', 'reviewer'),
    ]);

    seedPeerTask(ctx.db, ctx.spaceId, workflowRunId, ctx.nodeId, 'coder', ctx.coderSessionId);
    // reviewer has an execution but no session
    ctx.nodeExecutionRepo.createOrIgnore({
      workflowRunId,
      workflowNodeId: ctx.nodeId,
      agentName: 'reviewer',
      status: 'pending',
    });

    // No pendingMessageRepo configured
    const router = makeRouter(ctx, workflowRunId, [], [makeChannel('coder', 'reviewer')]);

    const result = await router.deliverMessage({
      fromAgentName: 'coder',
      fromSessionId: ctx.coderSessionId,
      target: 'reviewer',
      message: 'hello',
    });

    expect(result.success).toBe(false);
    // Reworded in Task #133: distinguishes "declared but no session" from
    // "unknown agent". Both pre-pendingRepo paths converge on this message.
    expect(result.reason).toContain('Could not deliver message to target agent(s): reviewer');
    expect(result.reason).toContain('no live session received the message');
  });
});

describe('AgentMessageRouter: persist workflowNodeId on queued @worker targets', () => {
  let ctx: TestCtx;

  beforeEach(() => {
    ctx = makeCtx();
  });

  afterEach(() => {
    ctx.db.close();
  });

  test('scoped compound row carries the resolved node id (node-name worker handle)', async () => {
    // @worker targets scope the queued row with a compound "<node>/<agent>" so two
    // nodes reusing a slot name don't cross-drain. The router also persists the
    // resolved workflowNodeId so the handoff resolver pins the exact node instead
    // of parsing the concatenated string (ambiguous when a component has "/").
    const { runId: workflowRunId } = seedWorkflowRunWithChannels(ctx.db, ctx.spaceId, [
      makeChannel('coder', 'Review'),
    ]);
    // Coder has an active session; reviewer is declared but inactive → queues.
    seedPeerTask(ctx.db, ctx.spaceId, workflowRunId, ctx.nodeId, 'coder', ctx.coderSessionId);
    ctx.nodeExecutionRepo.createOrIgnore({
      workflowRunId,
      workflowNodeId: 'review-node-id',
      agentName: 'reviewer',
      status: 'pending',
    });

    const pendingMessageRepo = new PendingAgentMessageRepository(ctx.db);
    const router = new AgentMessageRouter({
      nodeExecutionRepo: ctx.nodeExecutionRepo,
      workflowRunId,
      workflowChannels: [makeChannel('coder', 'Review')],
      messageInjector: async () => {},
      pendingMessageRepo,
      spaceId: ctx.spaceId,
      taskId: null,
      workflowNodeNameById: { 'review-node-id': 'Review' },
    });

    const result = await router.deliverMessage({
      fromAgentName: 'coder',
      fromSessionId: ctx.coderSessionId,
      target: '@worker:Review/reviewer',
      message: 'please review',
    });

    expect(result.queued).toBeDefined();
    expect(result.queued).toHaveLength(1);
    // The compound is reported to the caller; the row stores the BARE agent name
    // pinned to the canonical node id, so the resolver never parses the string.
    expect(result.queued![0].agentName).toBe('Review/reviewer');
    const pending = pendingMessageRepo.listPendingForTarget(workflowRunId, 'reviewer');
    expect(pending).toHaveLength(1);
    expect(pending[0].targetAgentName).toBe('reviewer');
    expect(pending[0].workflowNodeId).toBe('review-node-id');
  });

  test('scoped compound row carries the resolved node id (node-id worker handle)', async () => {
    // actor-registry worker handles encode the node id directly; the router
    // recognizes an id ref and persists it unchanged.
    const { runId: workflowRunId } = seedWorkflowRunWithChannels(ctx.db, ctx.spaceId, [
      makeChannel('coder', 'review-node-id'),
    ]);
    seedPeerTask(ctx.db, ctx.spaceId, workflowRunId, ctx.nodeId, 'coder', ctx.coderSessionId);
    ctx.nodeExecutionRepo.createOrIgnore({
      workflowRunId,
      workflowNodeId: 'review-node-id',
      agentName: 'reviewer',
      status: 'pending',
    });

    const pendingMessageRepo = new PendingAgentMessageRepository(ctx.db);
    const router = new AgentMessageRouter({
      nodeExecutionRepo: ctx.nodeExecutionRepo,
      workflowRunId,
      workflowChannels: [makeChannel('coder', 'review-node-id')],
      messageInjector: async () => {},
      pendingMessageRepo,
      spaceId: ctx.spaceId,
      taskId: null,
      workflowNodeNameById: { 'review-node-id': 'Review' },
    });

    const result = await router.deliverMessage({
      fromAgentName: 'coder',
      fromSessionId: ctx.coderSessionId,
      target: '@worker:review-node-id/reviewer',
      message: 'please review',
    });

    expect(result.queued).toBeDefined();
    expect(result.queued).toHaveLength(1);
    expect(result.queued![0].agentName).toBe('review-node-id/reviewer');
    const pending = pendingMessageRepo.listPendingForTarget(workflowRunId, 'reviewer');
    expect(pending).toHaveLength(1);
    expect(pending[0].targetAgentName).toBe('reviewer');
    expect(pending[0].workflowNodeId).toBe('review-node-id');
  });

  test('a node named like an inherited Object.prototype key still resolves to its id', async () => {
    // "constructor"/"toString"/etc. are on Object.prototype, so an `in`-based id
    // lookup would falsely treat the name as an existing node id and pin the row
    // to a nonexistent workflowNodeId. The resolver must use own properties only.
    const { runId: workflowRunId } = seedWorkflowRunWithChannels(ctx.db, ctx.spaceId, [
      makeChannel('coder', 'constructor'),
    ]);
    seedPeerTask(ctx.db, ctx.spaceId, workflowRunId, ctx.nodeId, 'coder', ctx.coderSessionId);
    ctx.nodeExecutionRepo.createOrIgnore({
      workflowRunId,
      workflowNodeId: 'ctor-node-id',
      agentName: 'ctor-agent',
      status: 'pending',
    });

    const pendingMessageRepo = new PendingAgentMessageRepository(ctx.db);
    const router = new AgentMessageRouter({
      nodeExecutionRepo: ctx.nodeExecutionRepo,
      workflowRunId,
      workflowChannels: [makeChannel('coder', 'constructor')],
      messageInjector: async () => {},
      pendingMessageRepo,
      spaceId: ctx.spaceId,
      taskId: null,
      workflowNodeNameById: { 'ctor-node-id': 'constructor' },
    });

    const result = await router.deliverMessage({
      fromAgentName: 'coder',
      fromSessionId: ctx.coderSessionId,
      target: '@worker:constructor/ctor-agent',
      message: 'please review',
    });

    expect(result.queued).toBeDefined();
    expect(result.queued).toHaveLength(1);
    expect(result.queued![0].agentName).toBe('constructor/ctor-agent');
    const pending = pendingMessageRepo.listPendingForTarget(workflowRunId, 'ctor-agent');
    expect(pending).toHaveLength(1);
    expect(pending[0].targetAgentName).toBe('ctor-agent');
    // The real node id — NOT the inherited-key name "constructor".
    expect(pending[0].workflowNodeId).toBe('ctor-node-id');
  });

  test('a node id that collides with another node name resolves to the id (ids authoritative)', async () => {
    // Node id "x" is named "Review"; a different node has caller-supplied id
    // "Review". An @worker address using the id "Review" must pin to that id,
    // not to node "x" (whose name matches first in insertion order).
    const { runId: workflowRunId } = seedWorkflowRunWithChannels(ctx.db, ctx.spaceId, [
      makeChannel('coder', 'Review'),
    ]);
    seedPeerTask(ctx.db, ctx.spaceId, workflowRunId, ctx.nodeId, 'coder', ctx.coderSessionId);
    ctx.nodeExecutionRepo.createOrIgnore({
      workflowRunId,
      workflowNodeId: 'Review',
      agentName: 'other-agent',
      status: 'pending',
    });

    const pendingMessageRepo = new PendingAgentMessageRepository(ctx.db);
    const router = new AgentMessageRouter({
      nodeExecutionRepo: ctx.nodeExecutionRepo,
      workflowRunId,
      workflowChannels: [makeChannel('coder', 'Review')],
      messageInjector: async () => {},
      pendingMessageRepo,
      spaceId: ctx.spaceId,
      taskId: null,
      // node id "x" has name "Review"; node id "Review" has name "other".
      workflowNodeNameById: { x: 'Review', Review: 'other' },
    });

    const result = await router.deliverMessage({
      fromAgentName: 'coder',
      fromSessionId: ctx.coderSessionId,
      target: '@worker:Review/other-agent',
      message: 'please review',
    });

    expect(result.queued).toBeDefined();
    expect(result.queued).toHaveLength(1);
    const pending = pendingMessageRepo.listPendingForTarget(workflowRunId, 'other-agent');
    expect(pending).toHaveLength(1);
    // Pinned to the id "Review" (the second node), NOT node "x" whose name is "Review".
    expect(pending[0].workflowNodeId).toBe('Review');
  });

  test('a name/id ref collision resolves by the agent slot, not by namespace precedence', async () => {
    // Node id "x" is named "Review" (slot "reviewer"); another node has id
    // "Review" (slot "other-agent"). An @worker address "Review/reviewer" is
    // ambiguous as a string — "Review" is node-x's NAME and the other node's ID —
    // so neither name-first nor id-first is always right. Resolve the pair: only
    // node-x declares "reviewer".
    const { runId: workflowRunId } = seedWorkflowRunWithChannels(ctx.db, ctx.spaceId, [
      makeChannel('coder', 'Review'),
    ]);
    seedPeerTask(ctx.db, ctx.spaceId, workflowRunId, ctx.nodeId, 'coder', ctx.coderSessionId);
    ctx.nodeExecutionRepo.createOrIgnore({
      workflowRunId,
      workflowNodeId: 'x',
      agentName: 'reviewer',
      status: 'pending',
    });
    const pendingMessageRepo = new PendingAgentMessageRepository(ctx.db);
    const router = new AgentMessageRouter({
      nodeExecutionRepo: ctx.nodeExecutionRepo,
      workflowRunId,
      workflowChannels: [makeChannel('coder', 'Review')],
      messageInjector: async () => {},
      pendingMessageRepo,
      spaceId: ctx.spaceId,
      taskId: null,
      workflowNodeNameById: { x: 'Review', Review: 'Other' },
      nodeGroups: { Review: ['reviewer'], Other: ['other-agent'] },
    });

    const result = await router.deliverMessage({
      fromAgentName: 'coder',
      fromSessionId: ctx.coderSessionId,
      target: '@worker:Review/reviewer',
      message: 'please review',
    });

    expect(result.queued).toBeDefined();
    expect(result.queued).toHaveLength(1);
    const pending = pendingMessageRepo.listPendingForTarget(workflowRunId, 'reviewer');
    expect(pending).toHaveLength(1);
    // Pinned to node id "x" (name "Review", declares "reviewer") — NOT the node
    // whose id is "Review", which an id-first lookup would wrongly select.
    expect(pending[0].workflowNodeId).toBe('x');
  });

  test('does not fire the activation callback for an unknown worker node ref', async () => {
    // @worker:WrongNode/reviewer — WrongNode is unknown, so resolveWorkflowNodeId
    // returns undefined. The activation callback must NOT fire, or it would
    // activate an unrelated node that happens to declare 'reviewer'.
    const { runId: workflowRunId } = seedWorkflowRunWithChannels(ctx.db, ctx.spaceId, [
      makeChannel('coder', 'reviewer'),
    ]);
    seedPeerTask(ctx.db, ctx.spaceId, workflowRunId, ctx.nodeId, 'coder', ctx.coderSessionId);
    ctx.nodeExecutionRepo.createOrIgnore({
      workflowRunId,
      workflowNodeId: 'review-node',
      agentName: 'reviewer',
      status: 'pending',
    });
    const pendingMessageRepo = new PendingAgentMessageRepository(ctx.db);
    const queuedAgents: string[] = [];
    const router = new AgentMessageRouter({
      nodeExecutionRepo: ctx.nodeExecutionRepo,
      workflowRunId,
      workflowChannels: [makeChannel('coder', 'reviewer')],
      messageInjector: async () => {},
      pendingMessageRepo,
      spaceId: ctx.spaceId,
      taskId: null,
      workflowNodeNameById: { 'review-node': 'Review' },
      nodeGroups: { Review: ['reviewer'] },
      onMessageQueued: (agentName) => queuedAgents.push(agentName),
    });

    await router.deliverMessage({
      fromAgentName: 'coder',
      fromSessionId: ctx.coderSessionId,
      target: '@worker:WrongNode/reviewer',
      message: 'please review',
    });

    // Row queued (compound, unresolved node), but activation callback NOT fired.
    expect(queuedAgents).toEqual([]);
  });
});

describe('AgentMessageRouter: broadcast * with mixed active/inactive targets', () => {
  // Tests gap: broadcast with pendingMessageRepo where some targets have sessions
  // (deliver) and others are declared-but-inactive (queue).
  let ctx: TestCtx;

  beforeEach(() => {
    ctx = makeCtx();
  });

  afterEach(() => {
    ctx.db.close();
  });

  test('delivers to active targets and queues for inactive declared targets', async () => {
    const { runId: workflowRunId } = seedWorkflowRunWithChannels(ctx.db, ctx.spaceId, [
      makeChannel('coder', 'reviewer'),
      makeChannel('coder', 'security'),
    ]);

    seedPeerTask(ctx.db, ctx.spaceId, workflowRunId, ctx.nodeId, 'coder', ctx.coderSessionId);
    // reviewer has a live session
    seedPeerTask(ctx.db, ctx.spaceId, workflowRunId, ctx.nodeId, 'reviewer', ctx.reviewerSessionId);
    // security is declared but has no session yet
    ctx.nodeExecutionRepo.createOrIgnore({
      workflowRunId,
      workflowNodeId: ctx.nodeId,
      agentName: 'security',
      status: 'pending',
    });

    const pendingMessageRepo = new PendingAgentMessageRepository(ctx.db);
    const delivered: string[] = [];
    const router = makeRouter(
      ctx,
      workflowRunId,
      [],
      [makeChannel('coder', 'reviewer'), makeChannel('coder', 'security')],
      {
        messageInjector: async (sid) => {
          delivered.push(sid);
        },
        pendingMessageRepo,
        spaceId: ctx.spaceId,
      }
    );

    const result = await router.deliverMessage({
      fromAgentName: 'coder',
      fromSessionId: ctx.coderSessionId,
      target: '*',
      message: 'broadcast to all',
    });

    // reviewer is delivered; security is queued
    expect(result.success).toBe(true);
    expect(result.delivered).toHaveLength(1);
    expect(result.delivered[0].agentName).toBe('reviewer');
    expect(result.queued).toHaveLength(1);
    expect(result.queued![0].agentName).toBe('security');
    expect(delivered).toContain(ctx.reviewerSessionId);

    // Verify the queued message is persisted
    const pending = pendingMessageRepo.listPendingForTarget(workflowRunId, 'security');
    expect(pending).toHaveLength(1);
    expect(pending[0].sourceAgentName).toBe('coder');
  });
});

describe('AgentMessageRouter: queue enqueue failure graceful degradation', () => {
  let ctx: TestCtx;

  beforeEach(() => {
    ctx = makeCtx();
  });

  afterEach(() => {
    ctx.db.close();
  });

  test('falls back to notFound when pendingMessageRepo.enqueue throws', async () => {
    // If the DB write for queueing fails, the router must not crash — it should
    // treat the target as notFound and return a "no active sessions" error.
    const { runId: workflowRunId } = seedWorkflowRunWithChannels(ctx.db, ctx.spaceId, [
      makeChannel('coder', 'reviewer'),
    ]);
    seedPeerTask(ctx.db, ctx.spaceId, workflowRunId, ctx.nodeId, 'coder', ctx.coderSessionId);
    // reviewer declared but no session
    ctx.nodeExecutionRepo.createOrIgnore({
      workflowRunId,
      workflowNodeId: ctx.nodeId,
      agentName: 'reviewer',
      status: 'pending',
    });

    // Mock pendingMessageRepo that always throws on enqueue
    const failingRepo = {
      enqueue: () => {
        throw new Error('DB write failed');
      },
      listPendingForTarget: () => [],
    } as unknown as PendingAgentMessageRepository;

    const router = makeRouter(ctx, workflowRunId, [], [makeChannel('coder', 'reviewer')], {
      pendingMessageRepo: failingRepo,
      spaceId: ctx.spaceId,
    });

    const result = await router.deliverMessage({
      fromAgentName: 'coder',
      fromSessionId: ctx.coderSessionId,
      target: 'reviewer',
      message: 'hello',
    });

    // Enqueue threw → graceful degradation to notFound path
    expect(result.success).toBe(false);
    // Reworded in Task #133: distinguishes "declared but no session" from
    // "unknown agent". Both pre-pendingRepo paths converge on this message.
    expect(result.reason).toContain('Could not deliver message to target agent(s): reviewer');
    expect(result.reason).toContain('no live session received the message');
    expect(result.notFoundAgentNames).toContain('reviewer');
  });
});

describe('AgentMessageRouter: workflow-declared (via nodeGroups) slot target with no execution row', () => {
  let ctx: TestCtx;

  beforeEach(() => {
    ctx = makeCtx();
  });

  afterEach(() => {
    ctx.db.close();
  });

  test('queues message when target is a workflow-declared slot with no node_execution row', async () => {
    // Regression for Task #133: a slot declared in workflow.nodes (via nodeGroups)
    // but never spawned (no node_execution row) should be reachable as a queue target,
    // not rejected as "Unknown target". The fix populates `allDeclaredAgentNames`
    // from nodeGroups so the slot-name lookup resolves before topology fallback.
    const { runId: workflowRunId } = seedWorkflowRunWithChannels(ctx.db, ctx.spaceId, [
      makeChannel('coder-node', 'review-node'),
    ]);
    seedPeerTask(ctx.db, ctx.spaceId, workflowRunId, ctx.nodeId, 'coder', ctx.coderSessionId);
    // `reviewer` is in nodeGroups but has NO node_execution row. The previous
    // implementation's allDeclaredAgentNames was sourced solely from
    // node_executions, so this fell through to the topology fallback (which
    // happens to also resolve here, but only for slot-name targets that the
    // workflow definition exposes). Direct slot-name target now hits the
    // nodeGroups-derived allDeclaredAgentNames and queues cleanly.
    const pendingMessageRepo = new PendingAgentMessageRepository(ctx.db);
    const router = makeRouter(ctx, workflowRunId, [], [makeChannel('coder-node', 'review-node')], {
      nodeGroups: {
        'coder-node': ['coder'],
        'review-node': ['reviewer'],
      },
      pendingMessageRepo,
      spaceId: ctx.spaceId,
    });

    const result = await router.deliverMessage({
      fromAgentName: 'coder',
      fromSessionId: ctx.coderSessionId,
      target: 'reviewer',
      message: 'lazy activation please',
    });

    expect(result.success).toBe(false);
    expect(result.queued).toHaveLength(1);
    expect(result.queued![0].agentName).toBe('reviewer');
    expect(result.delivered).toHaveLength(0);
    // The hard-error path was NOT taken — no "Unknown target" reason.
    // The missing live session is still surfaced for delivery accuracy.
    expect(result.notFoundAgentNames).toContain('reviewer');

    const pending = pendingMessageRepo.listPendingForTarget(workflowRunId, 'reviewer');
    expect(pending).toHaveLength(1);
    expect(pending[0].message).toContain('lazy activation please');
  });

  test('returns "Unknown target" when slot is not declared in workflow nor in node_executions', async () => {
    // Positive control: a name that is genuinely unknown — not in nodeGroups
    // AND not in any node_execution row — must still return the hard error.
    const { runId: workflowRunId } = seedWorkflowRunWithChannels(ctx.db, ctx.spaceId, [
      makeChannel('coder-node', 'review-node'),
    ]);
    seedPeerTask(ctx.db, ctx.spaceId, workflowRunId, ctx.nodeId, 'coder', ctx.coderSessionId);

    const pendingMessageRepo = new PendingAgentMessageRepository(ctx.db);
    const router = makeRouter(ctx, workflowRunId, [], [makeChannel('coder-node', 'review-node')], {
      nodeGroups: {
        'coder-node': ['coder'],
        'review-node': ['reviewer'],
      },
      pendingMessageRepo,
      spaceId: ctx.spaceId,
    });

    const result = await router.deliverMessage({
      fromAgentName: 'coder',
      fromSessionId: ctx.coderSessionId,
      target: 'ghost-slot',
      message: 'who?',
    });

    expect(result.success).toBe(false);
    expect(result.reason).toContain("Unknown target 'ghost-slot'");
    // Reachable peers list now includes nodeGroups-derived 'reviewer'.
    expect(result.reason).toContain('reviewer');
  });
});

describe('AgentMessageRouter: pure topology target (no execution, no nodeGroups) with pendingMessageRepo', () => {
  let ctx: TestCtx;

  beforeEach(() => {
    ctx = makeCtx();
  });

  afterEach(() => {
    ctx.db.close();
  });

  test('queues message when target is topology-declared but has no execution record', async () => {
    // 'reviewer' is in channel topology (coder→reviewer) but has NO execution record at all
    // (the node hasn't been activated yet). With pendingMessageRepo, the message is queued.
    // This is the pure topology path: isTopologyDeclared = true via getPermittedTargets,
    // but allDeclaredAgentNames does not contain 'reviewer'.
    const { runId: workflowRunId } = seedWorkflowRunWithChannels(ctx.db, ctx.spaceId, [
      makeChannel('coder', 'reviewer'),
    ]);
    seedPeerTask(ctx.db, ctx.spaceId, workflowRunId, ctx.nodeId, 'coder', ctx.coderSessionId);
    // No execution record for 'reviewer' at all

    const pendingMessageRepo = new PendingAgentMessageRepository(ctx.db);
    const router = makeRouter(ctx, workflowRunId, [], [makeChannel('coder', 'reviewer')], {
      pendingMessageRepo,
      spaceId: ctx.spaceId,
    });

    const result = await router.deliverMessage({
      fromAgentName: 'coder',
      fromSessionId: ctx.coderSessionId,
      target: 'reviewer',
      message: 'activate and review',
    });

    expect(result.success).toBe(false);
    expect(result.queued).toHaveLength(1);
    expect(result.queued![0].agentName).toBe('reviewer');
    expect(result.delivered).toHaveLength(0);

    const pending = pendingMessageRepo.listPendingForTarget(workflowRunId, 'reviewer');
    expect(pending).toHaveLength(1);
    expect(pending[0].message).toContain('activate and review');
  });
});

describe('AgentMessageRouter: generic address targets', () => {
  let ctx: TestCtx;

  beforeEach(() => {
    ctx = makeCtx();
  });

  afterEach(() => {
    ctx.db.close();
  });

  test('routes @worker to matching node and agent only', async () => {
    const { runId: workflowRunId } = seedWorkflowRunWithChannels(ctx.db, ctx.spaceId, [
      makeChannel('Coding', 'Review A'),
    ]);
    seedPeerTask(ctx.db, ctx.spaceId, workflowRunId, 'node-coding', 'coder', ctx.coderSessionId);
    seedPeerTask(
      ctx.db,
      ctx.spaceId,
      workflowRunId,
      'node-review-a',
      'reviewer',
      'session-review-a'
    );
    seedPeerTask(
      ctx.db,
      ctx.spaceId,
      workflowRunId,
      'node-review-b',
      'reviewer',
      'session-review-b'
    );
    const injected: Array<{ sessionId: string; message: string }> = [];
    const router = makeRouter(ctx, workflowRunId, injected, [makeChannel('Coding', 'Review A')], {
      nodeGroups: { Coding: ['coder'], 'Review A': ['reviewer'], 'Review B': ['reviewer'] },
      workflowNodeNameById: {
        'node-coding': 'Coding',
        'node-review-a': 'Review A',
        'node-review-b': 'Review B',
      },
    });

    const result = await router.deliverMessage({
      fromAgentName: 'coder',
      fromSessionId: ctx.coderSessionId,
      target: `@worker:${encodeURIComponent(workflowRunId)}/${encodeURIComponent('Review A')}/reviewer`,
      message: 'review A only',
    });

    expect(result.success).toBe(true);
    expect(injected.map((call) => call.sessionId)).toEqual(['session-review-a']);
  });

  test('passes agent name to channel checks for agent-name topologies', async () => {
    const { runId: workflowRunId } = seedWorkflowRunWithChannels(ctx.db, ctx.spaceId, [
      makeChannel('coder', 'reviewer'),
    ]);
    seedPeerTask(ctx.db, ctx.spaceId, workflowRunId, 'node-coding', 'coder', ctx.coderSessionId);
    seedPeerTask(
      ctx.db,
      ctx.spaceId,
      workflowRunId,
      'node-review-a',
      'reviewer',
      'session-review-a'
    );
    const checkedTargets: string[] = [];
    const router = makeRouter(ctx, workflowRunId, [], [makeChannel('Coding', 'reviewer')], {
      nodeGroups: { Coding: ['coder'], 'Review A': ['reviewer'] },
      workflowNodeNameById: { 'node-coding': 'Coding', 'node-review-a': 'Review A' },
      channelRouter: {
        deliverMessage: async (_runId, _from, target) => {
          checkedTargets.push(target);
          return {} as never;
        },
      } as AgentMessageRouterConfig['channelRouter'],
    });

    await router.deliverMessage({
      fromAgentName: 'coder',
      fromSessionId: ctx.coderSessionId,
      target: `@worker:${encodeURIComponent(workflowRunId)}/${encodeURIComponent('Review A')}/reviewer`,
      message: 'review A only',
    });

    expect(checkedTargets).toEqual(['reviewer']);
  });

  test('passes the requested worker node to channel checks', async () => {
    const { runId: workflowRunId } = seedWorkflowRunWithChannels(ctx.db, ctx.spaceId, [
      makeChannel('Coding', 'Review A'),
    ]);
    seedPeerTask(ctx.db, ctx.spaceId, workflowRunId, 'node-coding', 'coder', ctx.coderSessionId);
    seedPeerTask(
      ctx.db,
      ctx.spaceId,
      workflowRunId,
      'node-review-a',
      'reviewer',
      'session-review-a'
    );
    const checkedTargets: string[] = [];
    const router = makeRouter(ctx, workflowRunId, [], [makeChannel('Coding', 'Review A')], {
      nodeGroups: { Coding: ['coder'], 'Review A': ['reviewer'] },
      workflowNodeNameById: { 'node-coding': 'Coding', 'node-review-a': 'Review A' },
      channelRouter: {
        deliverMessage: async (_runId, _from, target) => {
          checkedTargets.push(target);
          return {} as never;
        },
      } as AgentMessageRouterConfig['channelRouter'],
    });

    await router.deliverMessage({
      fromAgentName: 'coder',
      fromSessionId: ctx.coderSessionId,
      target: `@worker:${encodeURIComponent(workflowRunId)}/${encodeURIComponent('Review A')}/reviewer`,
      message: 'review A only',
    });

    expect(checkedTargets).toEqual(['Review A']);
  });

  test('queues inactive @worker targets and fires queue callback', async () => {
    const { runId: workflowRunId } = seedWorkflowRunWithChannels(ctx.db, ctx.spaceId, [
      makeChannel('Coding', 'Review'),
    ]);
    seedPeerTask(ctx.db, ctx.spaceId, workflowRunId, 'node-coding', 'coder', ctx.coderSessionId);
    ctx.nodeExecutionRepo.createOrIgnore({
      workflowRunId,
      workflowNodeId: 'node-review',
      agentName: 'reviewer',
      status: 'pending',
    });
    const pendingMessageRepo = new PendingAgentMessageRepository(ctx.db);
    const queuedAgents: string[] = [];
    const queuedNodeIds: string[] = [];
    const router = makeRouter(ctx, workflowRunId, [], [makeChannel('Coding', 'Review')], {
      nodeGroups: { Coding: ['coder'], Review: ['reviewer'] },
      workflowNodeNameById: { 'node-coding': 'Coding', 'node-review': 'Review' },
      pendingMessageRepo,
      spaceId: ctx.spaceId,
      onMessageQueued: (agentName, workflowNodeId) => {
        queuedAgents.push(agentName);
        queuedNodeIds.push(workflowNodeId ?? '');
      },
    });

    const result = await router.deliverMessage({
      fromAgentName: 'coder',
      fromSessionId: ctx.coderSessionId,
      target: `@worker:${encodeURIComponent(workflowRunId)}/Review/reviewer`,
      message: 'wake reviewer',
    });

    expect(result.success).toBe(false);
    expect(result.queued).toHaveLength(1);
    // onMessageQueued now receives the BARE slot name (+ resolved node id) so the
    // activation callback can match declared agents; the compound is for reporting only.
    expect(queuedAgents).toEqual(['reviewer']);
    expect(queuedNodeIds).toEqual(['node-review']);
    // The row stores the bare agent name pinned to the node id.
    const pending = pendingMessageRepo.listPendingForTarget(workflowRunId, 'reviewer');
    expect(pending).toHaveLength(1);
    expect(pending[0].targetAgentName).toBe('reviewer');
    expect(pending[0].workflowNodeId).toBe('node-review');
  });

  test('keeps queued @worker targets scoped by node name when agent names repeat', async () => {
    const { runId: workflowRunId } = seedWorkflowRunWithChannels(ctx.db, ctx.spaceId, [
      makeChannel('Coding', 'Review A'),
    ]);
    seedPeerTask(ctx.db, ctx.spaceId, workflowRunId, 'node-coding', 'coder', ctx.coderSessionId);
    ctx.nodeExecutionRepo.createOrIgnore({
      workflowRunId,
      workflowNodeId: 'node-review-a',
      agentName: 'reviewer',
      status: 'pending',
    });
    seedPeerTask(
      ctx.db,
      ctx.spaceId,
      workflowRunId,
      'node-review-b',
      'reviewer',
      'session-review-b'
    );
    const pendingMessageRepo = new PendingAgentMessageRepository(ctx.db);
    const router = makeRouter(ctx, workflowRunId, [], [makeChannel('Coding', 'Review A')], {
      nodeGroups: { Coding: ['coder'], 'Review A': ['reviewer'], 'Review B': ['reviewer'] },
      workflowNodeNameById: {
        'node-coding': 'Coding',
        'node-review-a': 'Review A',
        'node-review-b': 'Review B',
      },
      pendingMessageRepo,
      spaceId: ctx.spaceId,
    });

    const result = await router.deliverMessage({
      fromAgentName: 'coder',
      fromSessionId: ctx.coderSessionId,
      target: `@worker:${encodeURIComponent(workflowRunId)}/${encodeURIComponent('Review A')}/reviewer`,
      message: 'queue review A only',
    });

    expect(result.success).toBe(false);
    // Scoped by workflowNodeId: the row pins to Review A's node id, so it won't
    // drain to Review B even though both reuse the 'reviewer' slot.
    const pending = pendingMessageRepo.listPendingForTarget(workflowRunId, 'reviewer');
    expect(pending).toHaveLength(1);
    expect(pending[0].targetAgentName).toBe('reviewer');
    expect(pending[0].workflowNodeId).toBe('node-review-a');
  });

  test('preserves earlier generic deliveries when a later @session target is unauthorized', async () => {
    const { runId: workflowRunId } = seedWorkflowRunWithChannels(ctx.db, ctx.spaceId, []);
    seedPeerTask(ctx.db, ctx.spaceId, workflowRunId, ctx.nodeId, 'coder', ctx.coderSessionId);
    const injected: Array<string | null> = [];
    const router = makeRouter(ctx, workflowRunId, [], [], {
      spaceId: ctx.spaceId,
      spaceAgentInjector: async (_spaceId, _message, replyToSessionId) => {
        injected.push(replyToSessionId);
      },
      replyRoutingLookup: () => 'session-origin',
    });

    const result = await router.deliverMessage({
      fromAgentName: 'coder',
      fromSessionId: ctx.coderSessionId,
      target: ['@coordinator', '@session:other-session'],
      message: 'partial route',
    });

    expect(result.success).toBe('partial');
    expect(result.delivered).toEqual([
      { agentName: 'space-agent', sessionId: `space:chat:${ctx.spaceId}` },
    ]);
    expect(result.reason).toContain('not an authorized reply route');
    expect(result.unauthorizedAgentNames).toEqual(['@session:other-session']);
    expect(injected).toEqual([null]);
  });

  test('rejects unauthorized @session targets and permits reply-route sessions', async () => {
    const { runId: workflowRunId } = seedWorkflowRunWithChannels(ctx.db, ctx.spaceId, []);
    seedPeerTask(ctx.db, ctx.spaceId, workflowRunId, ctx.nodeId, 'coder', ctx.coderSessionId);
    const injected: string[] = [];
    const router = makeRouter(ctx, workflowRunId, [], [], {
      spaceId: ctx.spaceId,
      spaceAgentInjector: async (_spaceId, _message, replyToSessionId) => {
        injected.push(replyToSessionId ?? 'default');
      },
      replyRoutingLookup: () => 'session-origin',
    });

    const rejected = await router.deliverMessage({
      fromAgentName: 'coder',
      fromSessionId: ctx.coderSessionId,
      target: '@session:other-session',
      message: 'bad route',
    });
    expect(rejected.success).toBe(false);
    expect(rejected.reason).toContain('not an authorized reply route');

    const delivered = await router.deliverMessage({
      fromAgentName: 'coder',
      fromSessionId: ctx.coderSessionId,
      target: '@session:session-origin',
      message: 'good route',
    });
    expect(delivered.success).toBe(true);
    expect(injected).toEqual(['session-origin']);
  });

  test('returns structured errors for malformed and unsupported generic targets', async () => {
    const { runId: workflowRunId } = seedWorkflowRunWithChannels(ctx.db, ctx.spaceId, [
      makeChannel('Coding', 'Review'),
    ]);
    seedPeerTask(ctx.db, ctx.spaceId, workflowRunId, 'node-coding', 'coder', ctx.coderSessionId);
    const router = makeRouter(ctx, workflowRunId, [], [makeChannel('Coding', 'Review')], {
      nodeGroups: { Coding: ['coder'], Review: ['reviewer'] },
      workflowNodeNameById: { 'node-coding': 'Coding', 'node-review': 'Review' },
    });

    const malformed = await router.deliverMessage({
      fromAgentName: 'coder',
      fromSessionId: ctx.coderSessionId,
      target: '@worker:Review/%GG',
      message: 'bad target',
    });
    expect(malformed.success).toBe(false);
    expect(malformed.reason).toContain('Invalid worker target');

    const unsupported = await router.deliverMessage({
      fromAgentName: 'coder',
      fromSessionId: ctx.coderSessionId,
      target: '@role:reviewer',
      message: 'bad target',
    });
    expect(unsupported.success).toBe(false);
    expect(unsupported.reason).toContain('not supported');
  });
});

// ---------------------------------------------------------------------------
// Tests: onMessageQueued callback — auto-resume hook (Task #70)
// ---------------------------------------------------------------------------

describe('AgentMessageRouter: onMessageQueued callback fires for non-deduped enqueues', () => {
  let ctx: TestCtx;

  beforeEach(() => {
    ctx = makeCtx();
  });

  afterEach(() => {
    ctx.db.close();
  });

  test('calls onMessageQueued with agent name when message is newly queued', async () => {
    const { runId: workflowRunId } = seedWorkflowRunWithChannels(ctx.db, ctx.spaceId, [
      makeChannel('coder', 'reviewer'),
    ]);

    seedPeerTask(ctx.db, ctx.spaceId, workflowRunId, ctx.nodeId, 'coder', ctx.coderSessionId);
    // reviewer declared but no session
    ctx.nodeExecutionRepo.createOrIgnore({
      workflowRunId,
      workflowNodeId: ctx.nodeId,
      agentName: 'reviewer',
      status: 'pending',
    });

    const pendingMessageRepo = new PendingAgentMessageRepository(ctx.db);
    const resumedAgents: string[] = [];

    const router = new AgentMessageRouter({
      nodeExecutionRepo: ctx.nodeExecutionRepo,
      workflowRunId,
      workflowChannels: [makeChannel('coder', 'reviewer')],
      messageInjector: async () => {},
      pendingMessageRepo,
      spaceId: ctx.spaceId,
      taskId: null,
      onMessageQueued: (agentName) => resumedAgents.push(agentName),
    });

    await router.deliverMessage({
      fromAgentName: 'coder',
      fromSessionId: ctx.coderSessionId,
      target: 'reviewer',
      message: 'activate and review',
    });

    expect(resumedAgents).toHaveLength(1);
    expect(resumedAgents[0]).toBe('reviewer');
  });

  test('does NOT call onMessageQueued when pendingMessageRepo returns deduped=true', async () => {
    const { runId: workflowRunId } = seedWorkflowRunWithChannels(ctx.db, ctx.spaceId, [
      makeChannel('coder', 'reviewer'),
    ]);

    seedPeerTask(ctx.db, ctx.spaceId, workflowRunId, ctx.nodeId, 'coder', ctx.coderSessionId);
    ctx.nodeExecutionRepo.createOrIgnore({
      workflowRunId,
      workflowNodeId: ctx.nodeId,
      agentName: 'reviewer',
      status: 'pending',
    });

    // Mock repo that always reports deduped=true (simulating an already-queued message)
    const existingRecord = {
      id: 'existing-msg-id',
      workflowRunId,
      spaceId: ctx.spaceId,
      taskId: null,
      sourceAgentName: 'coder',
      targetAgentName: 'reviewer',
      targetKind: 'node_agent',
      message: 'already queued',
      status: 'pending',
      attempts: 0,
      maxAttempts: 3,
      idempotencyKey: null,
      createdAt: Date.now(),
      updatedAt: Date.now(),
      expiresAt: Date.now() + 600_000,
      lastAttemptAt: null,
      lastError: null,
    };
    const dedupedRepo = {
      enqueue: () => ({ record: existingRecord, deduped: true }),
      listPendingForTarget: () => [existingRecord],
    } as unknown as PendingAgentMessageRepository;

    const resumedAgents: string[] = [];

    const router = new AgentMessageRouter({
      nodeExecutionRepo: ctx.nodeExecutionRepo,
      workflowRunId,
      workflowChannels: [makeChannel('coder', 'reviewer')],
      messageInjector: async () => {},
      pendingMessageRepo: dedupedRepo,
      spaceId: ctx.spaceId,
      taskId: null,
      onMessageQueued: (agentName) => resumedAgents.push(agentName),
    });

    await router.deliverMessage({
      fromAgentName: 'coder',
      fromSessionId: ctx.coderSessionId,
      target: 'reviewer',
      message: 'review please again',
    });

    // Deduped → callback must NOT fire
    expect(resumedAgents).toHaveLength(0);
  });

  test('dedupes repeated queued handoff sends with a stable idempotency key', async () => {
    const { runId: workflowRunId } = seedWorkflowRunWithChannels(ctx.db, ctx.spaceId, [
      makeChannel('coder', 'reviewer'),
    ]);

    seedPeerTask(ctx.db, ctx.spaceId, workflowRunId, ctx.nodeId, 'coder', ctx.coderSessionId);
    ctx.nodeExecutionRepo.createOrIgnore({
      workflowRunId,
      workflowNodeId: ctx.nodeId,
      agentName: 'reviewer',
      status: 'pending',
    });

    const pendingMessageRepo = new PendingAgentMessageRepository(ctx.db);
    const resumedAgents: string[] = [];
    const router = new AgentMessageRouter({
      nodeExecutionRepo: ctx.nodeExecutionRepo,
      workflowRunId,
      workflowChannels: [makeChannel('coder', 'reviewer')],
      messageInjector: async () => {},
      pendingMessageRepo,
      spaceId: ctx.spaceId,
      taskId: null,
      onMessageQueued: (agentName) => resumedAgents.push(agentName),
    });

    for (let i = 0; i < 2; i++) {
      await router.deliverMessage({
        fromAgentName: 'coder',
        fromSessionId: ctx.coderSessionId,
        target: 'reviewer',
        message: 'same handoff',
      });
    }

    const pending = pendingMessageRepo.listPendingForTarget(workflowRunId, 'reviewer');
    expect(pending).toHaveLength(1);
    expect(pending[0].maxAttempts).toBe(3);
    expect(pending[0].idempotencyKey).toBe(
      JSON.stringify([ctx.coderSessionId, 'reviewer', '─── Message from coder ───\n\nsame handoff'])
    );
    expect(pending[0].expiresAt - pending[0].createdAt).toBeLessThanOrEqual(60_000);
    expect(resumedAgents).toEqual(['reviewer']);

    pendingMessageRepo.markDelivered(pending[0].id, 'session:reviewer:delivered');
    await router.deliverMessage({
      fromAgentName: 'coder',
      fromSessionId: ctx.coderSessionId,
      target: 'reviewer',
      message: 'same handoff',
    });
    expect(pendingMessageRepo.listPendingForTarget(workflowRunId, 'reviewer')).toHaveLength(1);
    expect(pendingMessageRepo.listAllForRun(workflowRunId)).toHaveLength(2);
    expect(resumedAgents).toEqual(['reviewer', 'reviewer']);
  });

  test('does not dedupe distinct tuples that contain colon separators', async () => {
    const { runId: workflowRunId } = seedWorkflowRunWithChannels(ctx.db, ctx.spaceId, [
      makeChannel('coder', 'reviewer:b'),
      makeChannel('coder', 'b:msg'),
    ]);
    seedPeerTask(ctx.db, ctx.spaceId, workflowRunId, ctx.nodeId, 'coder', ctx.coderSessionId);
    for (const agentName of ['reviewer:b', 'b:msg']) {
      ctx.nodeExecutionRepo.createOrIgnore({
        workflowRunId,
        workflowNodeId: ctx.nodeId,
        agentName,
        status: 'pending',
      });
    }
    const pendingMessageRepo = new PendingAgentMessageRepository(ctx.db);
    const router = new AgentMessageRouter({
      nodeExecutionRepo: ctx.nodeExecutionRepo,
      workflowRunId,
      workflowChannels: [makeChannel('coder', 'reviewer:b'), makeChannel('coder', 'b:msg')],
      messageInjector: async () => {},
      pendingMessageRepo,
      spaceId: ctx.spaceId,
      taskId: null,
    });

    await router.deliverMessage({
      fromAgentName: 'coder',
      fromSessionId: 'session:a',
      target: 'reviewer:b',
      message: 'msg',
    });
    await router.deliverMessage({
      fromAgentName: 'coder',
      fromSessionId: 'session:a:reviewer',
      target: 'b:msg',
      message: '',
    });

    expect(pendingMessageRepo.listPendingForTarget(workflowRunId, 'reviewer:b')).toHaveLength(1);
    expect(pendingMessageRepo.listPendingForTarget(workflowRunId, 'b:msg')).toHaveLength(1);
    expect(pendingMessageRepo.listAllForRun(workflowRunId)).toHaveLength(2);
  });

  test('does NOT call onMessageQueued when message is delivered directly (live session)', async () => {
    const { runId: workflowRunId } = seedWorkflowRunWithChannels(ctx.db, ctx.spaceId, [
      makeChannel('coder', 'reviewer'),
    ]);

    seedPeerTask(ctx.db, ctx.spaceId, workflowRunId, ctx.nodeId, 'coder', ctx.coderSessionId);
    // reviewer has a live session
    seedPeerTask(ctx.db, ctx.spaceId, workflowRunId, ctx.nodeId, 'reviewer', ctx.reviewerSessionId);

    const pendingMessageRepo = new PendingAgentMessageRepository(ctx.db);
    const resumedAgents: string[] = [];

    const router = new AgentMessageRouter({
      nodeExecutionRepo: ctx.nodeExecutionRepo,
      workflowRunId,
      workflowChannels: [makeChannel('coder', 'reviewer')],
      messageInjector: async () => {},
      pendingMessageRepo,
      spaceId: ctx.spaceId,
      taskId: null,
      onMessageQueued: (agentName) => resumedAgents.push(agentName),
    });

    await router.deliverMessage({
      fromAgentName: 'coder',
      fromSessionId: ctx.coderSessionId,
      target: 'reviewer',
      message: 'review ready',
    });

    // Message delivered directly — callback must not have fired
    expect(resumedAgents).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Tests: replyRoutingLookup — symmetric reply routing for ad-hoc sessions
// ---------------------------------------------------------------------------

describe('AgentMessageRouter: replyRoutingLookup routes space-agent replies to originating session', () => {
  let ctx: TestCtx;

  beforeEach(() => {
    ctx = makeCtx();
  });

  afterEach(() => {
    ctx.db.close();
  });

  test('routes space-agent message to replyToSessionId when lookup returns a value', async () => {
    const { runId: workflowRunId, channels: runChannels } = seedWorkflowRunWithChannels(
      ctx.db,
      ctx.spaceId,
      []
    );
    seedPeerTask(ctx.db, ctx.spaceId, workflowRunId, ctx.nodeId, 'coder', ctx.coderSessionId);

    const injected: Array<{ spaceId: string; message: string; replyTo?: string | null }> = [];
    const router = makeRouter(ctx, workflowRunId, [], runChannels, {
      spaceId: ctx.spaceId,
      taskId: 'task-123',
      taskNumber: 42,
      spaceAgentInjector: async (spaceId, message, replyTo) => {
        injected.push({ spaceId, message, replyTo });
      },
      replyRoutingLookup: () => 'session-adhoc-member-1',
    });

    const result = await router.deliverMessage({
      fromAgentName: 'coder',
      fromSessionId: ctx.coderSessionId,
      target: 'space-agent',
      message: 'Blocked on decision',
    });

    expect(result.success).toBe(true);
    expect(result.delivered).toEqual([
      { agentName: 'space-agent', sessionId: 'session-adhoc-member-1' },
    ]);
    expect(injected).toHaveLength(1);
    expect(injected[0].replyTo).toBe('session-adhoc-member-1');
  });

  test('routes space-agent message to default space:chat: when lookup returns null', async () => {
    const { runId: workflowRunId, channels: runChannels } = seedWorkflowRunWithChannels(
      ctx.db,
      ctx.spaceId,
      []
    );
    seedPeerTask(ctx.db, ctx.spaceId, workflowRunId, ctx.nodeId, 'coder', ctx.coderSessionId);

    const injected: Array<{ spaceId: string; message: string; replyTo?: string | null }> = [];
    const router = makeRouter(ctx, workflowRunId, [], runChannels, {
      spaceId: ctx.spaceId,
      taskId: 'task-123',
      taskNumber: 42,
      spaceAgentInjector: async (spaceId, message, replyTo) => {
        injected.push({ spaceId, message, replyTo });
      },
      replyRoutingLookup: () => null,
    });

    const result = await router.deliverMessage({
      fromAgentName: 'coder',
      fromSessionId: ctx.coderSessionId,
      target: 'space-agent',
      message: 'Default routing',
    });

    expect(result.success).toBe(true);
    expect(result.delivered).toEqual([
      { agentName: 'space-agent', sessionId: `space:chat:${ctx.spaceId}` },
    ]);
    expect(injected).toHaveLength(1);
    expect(injected[0].replyTo).toBeNull();
  });

  test('routes space-agent message to default space:chat: when no replyRoutingLookup provided', async () => {
    const { runId: workflowRunId, channels: runChannels } = seedWorkflowRunWithChannels(
      ctx.db,
      ctx.spaceId,
      []
    );
    seedPeerTask(ctx.db, ctx.spaceId, workflowRunId, ctx.nodeId, 'coder', ctx.coderSessionId);

    const injected: Array<{ spaceId: string; message: string; replyTo?: string | null }> = [];
    const router = makeRouter(ctx, workflowRunId, [], runChannels, {
      spaceId: ctx.spaceId,
      taskId: 'task-123',
      spaceAgentInjector: async (spaceId, message, replyTo) => {
        injected.push({ spaceId, message, replyTo });
      },
      // No replyRoutingLookup — backward compat
    });

    const result = await router.deliverMessage({
      fromAgentName: 'coder',
      fromSessionId: ctx.coderSessionId,
      target: 'space-agent',
      message: 'No lookup configured',
    });

    expect(result.success).toBe(true);
    expect(result.delivered).toEqual([
      { agentName: 'space-agent', sessionId: `space:chat:${ctx.spaceId}` },
    ]);
    expect(injected).toHaveLength(1);
    expect(injected[0].replyTo).toBeNull();
  });

  test('passes sender agentName to replyRoutingLookup for per-node resolution', async () => {
    const { runId: workflowRunId, channels: runChannels } = seedWorkflowRunWithChannels(
      ctx.db,
      ctx.spaceId,
      []
    );
    seedPeerTask(ctx.db, ctx.spaceId, workflowRunId, ctx.nodeId, 'coder', ctx.coderSessionId);

    const lookupCalls: Array<string | null | undefined> = [];
    const router = makeRouter(ctx, workflowRunId, [], runChannels, {
      spaceId: ctx.spaceId,
      taskId: 'task-123',
      spaceAgentInjector: async () => {},
      replyRoutingLookup: (agentName) => {
        lookupCalls.push(agentName ?? null);
        return agentName === 'coder' ? 'session-adhoc-coder' : null;
      },
    });

    await router.deliverMessage({
      fromAgentName: 'coder',
      fromSessionId: ctx.coderSessionId,
      target: 'space-agent',
      message: 'Node-specific routing',
    });

    expect(lookupCalls).toEqual(['coder']);
  });
});

describe('AgentMessageRouter: post-approval merger session is scoped to its target agent', () => {
  let ctx: TestCtx;

  beforeEach(() => {
    ctx = makeCtx();
  });

  afterEach(() => {
    ctx.db.close();
  });

  // The merger sub-session has no node_execution row; it is exposed as a peer
  // only under the post-approval route's target agent name (e.g. 'merger'). It
  // must NOT be mapped to every other declared-but-unactivated agent, or a
  // message to an unrelated inactive node would be injected into the merger.
  function makeMergerOverrides(mergerSessionId: string) {
    return {
      nodeGroups: {
        Review: ['reviewer'],
        'Post-Approval': ['merger'],
        'Unused-Branch': ['conditional-agent'],
      },
      findPostApprovalSessionId: () => mergerSessionId,
      findPostApprovalTargetAgentName: () => 'merger',
    };
  }

  test('routes a message to the merger target into the live merger session', async () => {
    const { runId: workflowRunId, channels: runChannels } = seedWorkflowRunWithChannels(
      ctx.db,
      ctx.spaceId,
      // Node-name channels (production shape); nodeGroups maps slots→nodes.
      [makeChannel('Review', 'Post-Approval'), makeChannel('Review', 'Unused-Branch')]
    );
    // Only the reviewer (sender) has a live node_execution; 'merger' and
    // 'conditional-agent' are declared but never activated.
    seedPeerTask(ctx.db, ctx.spaceId, workflowRunId, ctx.nodeId, 'reviewer', ctx.reviewerSessionId);
    const injected: Array<{ sessionId: string; message: string }> = [];
    const router = makeRouter(
      ctx,
      workflowRunId,
      injected,
      runChannels,
      makeMergerOverrides('merger-session')
    );

    const result = await router.deliverMessage({
      fromAgentName: 'reviewer',
      fromSessionId: ctx.reviewerSessionId,
      target: 'merger',
      message: 'merge blocked',
    });

    expect(result.success).toBe(true);
    expect(injected.some((i) => i.sessionId === 'merger-session')).toBe(true);
  });

  test('does NOT route a message to an unrelated unactivated agent into the merger session', async () => {
    const { runId: workflowRunId, channels: runChannels } = seedWorkflowRunWithChannels(
      ctx.db,
      ctx.spaceId,
      // Node-name channels (production shape); nodeGroups maps slots→nodes.
      [makeChannel('Review', 'Post-Approval'), makeChannel('Review', 'Unused-Branch')]
    );
    seedPeerTask(ctx.db, ctx.spaceId, workflowRunId, ctx.nodeId, 'reviewer', ctx.reviewerSessionId);
    const injected: Array<{ sessionId: string; message: string }> = [];
    const router = makeRouter(
      ctx,
      workflowRunId,
      injected,
      runChannels,
      makeMergerOverrides('merger-session')
    );

    await router.deliverMessage({
      fromAgentName: 'reviewer',
      fromSessionId: ctx.reviewerSessionId,
      target: 'conditional-agent',
      message: 'should not reach the merger',
    });

    // The merger session must not receive a message addressed to a different,
    // unactivated agent (the pre-fix over-matching bug).
    expect(injected.some((i) => i.sessionId === 'merger-session')).toBe(false);
  });

  test('prefers the live merger session over a stale merger node_execution', async () => {
    // A prior duplicate-activation (or a terminal merger execution) can leave a
    // stale node_execution for 'merger' with an old session id. The live
    // postApprovalSessionId is the merger that is actually waiting; the
    // continuation must reach IT, not the stale execution.
    const { runId: workflowRunId, channels: runChannels } = seedWorkflowRunWithChannels(
      ctx.db,
      ctx.spaceId,
      [makeChannel('Review', 'Post-Approval')]
    );
    seedPeerTask(ctx.db, ctx.spaceId, workflowRunId, ctx.nodeId, 'reviewer', ctx.reviewerSessionId);
    // Stale merger execution with an OLD session id.
    seedPeerTask(ctx.db, ctx.spaceId, workflowRunId, ctx.nodeId, 'merger', 'stale-merger-session');
    const injected: Array<{ sessionId: string; message: string }> = [];
    const router = makeRouter(ctx, workflowRunId, injected, runChannels, {
      nodeGroups: { Review: ['reviewer'], 'Post-Approval': ['merger'] },
      findPostApprovalSessionId: () => 'live-merger-session',
      findPostApprovalTargetAgentName: () => 'merger',
    });

    const result = await router.deliverMessage({
      fromAgentName: 'reviewer',
      fromSessionId: ctx.reviewerSessionId,
      target: 'merger',
      message: 'continue',
    });

    expect(result.success).toBe(true);
    expect(injected.some((i) => i.sessionId === 'live-merger-session')).toBe(true);
    // The stale execution's session must not receive the message.
    expect(injected.some((i) => i.sessionId === 'stale-merger-session')).toBe(false);
  });
});
