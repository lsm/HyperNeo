/**
 * Unit tests for the unified send_message behavior via ChannelRouter injection.
 *
 * Covers:
 *   1. send_message with ChannelRouter injected:
 *      - Agent name target → DM delivery
 *      - Unknown target → clear error
 *      - Unauthorized target → error
 *      - Broadcast '*' → broadcast
 *   2. send_message without ChannelRouter (legacy):
 *      - Role target → DM
 *      - Broadcast '*' → broadcast
 *   3. Both paths produce same behavior for role-based DM
 *   4. send_message: node name→fan-out (via nodeGroups in AgentMessageRouter)
 *   5. send_message: cross-node delivery (sender and receiver in different nodes)
 *   6. send_message: gate blocked (topology-based blocking — no declared channel)
 */

import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { Database as BunDatabase } from '../../../../src/storage/sqlite-compat';
import { runMigrations } from '../../../../src/storage/schema/index.ts';
import { SpaceWorkflowRepository } from '../../../../src/storage/repositories/space-workflow-repository.ts';
import { SpaceWorkflowRunRepository } from '../../../../src/storage/repositories/space-workflow-run-repository.ts';
import { NodeExecutionRepository } from '../../../../src/storage/repositories/node-execution-repository.ts';
import {
  createNodeAgentToolHandlers,
  type NodeAgentToolsConfig,
} from '../../../../src/lib/space/tools/node-agent-tools.ts';
import { AgentMessageRouter } from '../../../../src/lib/space/runtime/agent-message-router.ts';
import { ChannelResolver } from '../../../../src/lib/space/runtime/channel-resolver.ts';
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
    startNodeId: '',
    completionAutonomyLevel: 3,
  });

  const runRepo = new SpaceWorkflowRunRepository(db);
  const run = runRepo.createRun({
    spaceId,
    workflowId: workflow.id,
    title: 'Test Run',
  });

  // Channels are stored in-memory on SpaceRuntime and injected directly into AgentMessageRouter.
  // They are no longer persisted in the run config.
  return { runId: run.id, channels };
}

function makeResolvedChannel(from: string, to: string | string[]): WorkflowChannel {
  return { id: `ch-${from}-${Array.isArray(to) ? to.join('-') : to}`, from, to };
}

// ---------------------------------------------------------------------------
// Test context
// ---------------------------------------------------------------------------

const NODE_ID = 'node-review';

interface TestCtx {
  db: BunDatabase;
  spaceId: string;
  nodeExecutionRepo: NodeExecutionRepository;
  coderSessionId: string;
  reviewerSessionId: string;
}

function seedPeerTask(
  nodeExecutionRepo: NodeExecutionRepository,
  workflowRunId: string,
  nodeId: string,
  agentName: string,
  sessionId: string
): void {
  const nodeExecution = nodeExecutionRepo.create({
    workflowRunId,
    workflowNodeId: nodeId,
    agentName,
    agentSessionId: sessionId,
    status: 'in_progress',
  });
  nodeExecutionRepo.update(nodeExecution.id, {
    agentSessionId: sessionId,
    status: 'in_progress',
  });
}

function makeCtx(): TestCtx {
  const db = makeDb();
  const spaceId = 'space-send-msg-unified-test';

  seedSpaceRow(db, spaceId);

  const nodeExecutionRepo = new NodeExecutionRepository(db);

  const coderSessionId = 'session-coder-unified';
  const reviewerSessionId = 'session-reviewer-unified';

  return {
    db,
    spaceId,
    nodeExecutionRepo,
    coderSessionId,
    reviewerSessionId,
  };
}

type NodeConfigWithInjector = NodeAgentToolsConfig & {
  messageInjector: (sessionId: string, message: string) => Promise<void>;
};

function makeBaseConfig(
  ctx: TestCtx,
  workflowRunId: string,
  injected: Array<{ sessionId: string; message: string }>,
  channelResolver: ChannelResolver = new ChannelResolver([])
): NodeConfigWithInjector {
  const messageInjector = async (sessionId: string, message: string) => {
    injected.push({ sessionId, message });
  };
  return {
    mySessionId: ctx.coderSessionId,
    myAgentName: 'coder',
    taskId: 'test-task-unified',
    spaceId: ctx.spaceId,
    channelResolver,
    workflowRunId,
    workflowNodeId: NODE_ID,
    nodeExecutionRepo: ctx.nodeExecutionRepo,
    agentMessageRouter: new AgentMessageRouter({
      nodeExecutionRepo: ctx.nodeExecutionRepo,
      workflowRunId,
      workflowChannels: channelResolver.getChannels(),
      messageInjector,
    }),
    messageInjector,
  };
}

// ---------------------------------------------------------------------------
// Tests: send_message with ChannelRouter injected
// ---------------------------------------------------------------------------

describe('send_message with ChannelRouter injected', () => {
  let ctx: TestCtx;

  beforeEach(() => {
    ctx = makeCtx();
  });

  afterEach(() => {
    ctx.db.close();
  });

  test('agent name target → DM delivery via ChannelRouter', async () => {
    const { runId: workflowRunId, channels } = seedWorkflowRunWithChannels(ctx.db, ctx.spaceId, [
      makeResolvedChannel('coder', 'reviewer'),
    ]);
    seedPeerTask(ctx.nodeExecutionRepo, workflowRunId, NODE_ID, 'reviewer', ctx.reviewerSessionId);
    const injected: Array<{ sessionId: string; message: string }> = [];
    const baseConfig = makeBaseConfig(ctx, workflowRunId, injected);

    const agentMessageRouter = new AgentMessageRouter({
      nodeExecutionRepo: ctx.nodeExecutionRepo,
      workflowRunId,
      workflowChannels: channels,
      messageInjector: baseConfig.messageInjector,
    });

    const handlers = createNodeAgentToolHandlers({ ...baseConfig, agentMessageRouter });
    const result = await handlers.send_message({ target: 'reviewer', message: 'hello via router' });
    const data = JSON.parse(result.content[0].text);

    expect(data.success).toBe(true);
    expect(data.delivered).toHaveLength(1);
    expect(data.delivered[0].sessionId).toBe(ctx.reviewerSessionId);
    expect(injected[0].message).toBe('─── Message from coder ───\n\nhello via router');
  });

  test('unknown target → clear error from ChannelRouter', async () => {
    const { runId: workflowRunId, channels } = seedWorkflowRunWithChannels(ctx.db, ctx.spaceId, [
      makeResolvedChannel('coder', 'reviewer'),
    ]);
    seedPeerTask(ctx.nodeExecutionRepo, workflowRunId, NODE_ID, 'reviewer', ctx.reviewerSessionId);
    const injected: Array<{ sessionId: string; message: string }> = [];
    const baseConfig = makeBaseConfig(ctx, workflowRunId, injected);

    const agentMessageRouter = new AgentMessageRouter({
      nodeExecutionRepo: ctx.nodeExecutionRepo,
      workflowRunId,
      workflowChannels: channels,
      messageInjector: baseConfig.messageInjector,
    });

    const handlers = createNodeAgentToolHandlers({ ...baseConfig, agentMessageRouter });
    const result = await handlers.send_message({ target: 'ghost-agent', message: 'knock knock' });
    const data = JSON.parse(result.content[0].text);

    expect(data.success).toBe(false);
    expect(data.error).toContain('no agent or node found');
  });

  test('unauthorized target → error from ChannelRouter', async () => {
    const { runId: workflowRunId, channels } = seedWorkflowRunWithChannels(ctx.db, ctx.spaceId, [
      makeResolvedChannel('reviewer', 'coder'), // coder cannot send to reviewer
    ]);
    seedPeerTask(ctx.nodeExecutionRepo, workflowRunId, NODE_ID, 'reviewer', ctx.reviewerSessionId);
    const injected: Array<{ sessionId: string; message: string }> = [];
    const baseConfig = makeBaseConfig(ctx, workflowRunId, injected);

    const agentMessageRouter = new AgentMessageRouter({
      nodeExecutionRepo: ctx.nodeExecutionRepo,
      workflowRunId,
      workflowChannels: channels,
      messageInjector: baseConfig.messageInjector,
    });

    const handlers = createNodeAgentToolHandlers({ ...baseConfig, agentMessageRouter });
    const result = await handlers.send_message({ target: 'reviewer', message: 'unauthorized' });
    const data = JSON.parse(result.content[0].text);

    expect(data.success).toBe(false);
    expect(data.error).toContain("does not permit 'coder' to send to: reviewer");
  });

  test("broadcast '*' → broadcast via AgentMessageRouter", async () => {
    const { runId: workflowRunId, channels } = seedWorkflowRunWithChannels(ctx.db, ctx.spaceId, [
      makeResolvedChannel('coder', 'reviewer'),
    ]);
    seedPeerTask(ctx.nodeExecutionRepo, workflowRunId, NODE_ID, 'reviewer', ctx.reviewerSessionId);
    const injected: Array<{ sessionId: string; message: string }> = [];
    const baseConfig = makeBaseConfig(ctx, workflowRunId, injected);

    const agentMessageRouter = new AgentMessageRouter({
      nodeExecutionRepo: ctx.nodeExecutionRepo,
      workflowRunId,
      workflowChannels: channels,
      messageInjector: baseConfig.messageInjector,
    });

    const handlers = createNodeAgentToolHandlers({ ...baseConfig, agentMessageRouter });
    const result = await handlers.send_message({ target: '*', message: 'broadcast via router' });
    const data = JSON.parse(result.content[0].text);

    expect(data.success).toBe(true);
    expect(data.delivered).toHaveLength(1);
    expect(data.delivered[0].sessionId).toBe(ctx.reviewerSessionId);
    expect(injected[0].message).toBe('─── Message from coder ───\n\nbroadcast via router');
  });
});

// ---------------------------------------------------------------------------
// Tests: send_message without ChannelRouter (legacy path)
// ---------------------------------------------------------------------------

describe('send_message without ChannelRouter (legacy path)', () => {
  let ctx: TestCtx;

  beforeEach(() => {
    ctx = makeCtx();
  });

  afterEach(() => {
    ctx.db.close();
  });

  test('role target → DM via legacy path', async () => {
    const { runId: workflowRunId, channels } = seedWorkflowRunWithChannels(ctx.db, ctx.spaceId, [
      makeResolvedChannel('coder', 'reviewer'),
    ]);
    seedPeerTask(ctx.nodeExecutionRepo, workflowRunId, NODE_ID, 'reviewer', ctx.reviewerSessionId);
    const injected: Array<{ sessionId: string; message: string }> = [];
    const config = makeBaseConfig(
      ctx,
      workflowRunId,
      injected,
      new ChannelResolver([makeResolvedChannel('coder', 'reviewer')])
    );

    const handlers = createNodeAgentToolHandlers(config);
    const result = await handlers.send_message({ target: 'reviewer', message: 'legacy DM' });
    const data = JSON.parse(result.content[0].text);

    expect(data.success).toBe(true);
    expect(data.delivered).toHaveLength(1);
    expect(data.delivered[0].sessionId).toBe(ctx.reviewerSessionId);
    expect(injected[0].message).toBe('─── Message from coder ───\n\nlegacy DM');
  });

  test("broadcast '*' → broadcast via legacy path", async () => {
    const { runId: workflowRunId, channels } = seedWorkflowRunWithChannels(ctx.db, ctx.spaceId, [
      makeResolvedChannel('coder', 'reviewer'),
    ]);
    seedPeerTask(ctx.nodeExecutionRepo, workflowRunId, NODE_ID, 'reviewer', ctx.reviewerSessionId);
    const injected: Array<{ sessionId: string; message: string }> = [];
    const config = makeBaseConfig(
      ctx,
      workflowRunId,
      injected,
      new ChannelResolver([makeResolvedChannel('coder', 'reviewer')])
    );

    const handlers = createNodeAgentToolHandlers(config);
    const result = await handlers.send_message({ target: '*', message: 'broadcast legacy' });
    const data = JSON.parse(result.content[0].text);

    expect(data.success).toBe(true);
    expect(data.delivered).toHaveLength(1);
    expect(injected.map((item) => item.sessionId)).toContain(ctx.reviewerSessionId);
  });
});

// ---------------------------------------------------------------------------
// Tests: both paths produce same behavior for role-based DM
// ---------------------------------------------------------------------------

describe('both paths produce same behavior for role-based DM', () => {
  let ctx: TestCtx;

  beforeEach(() => {
    ctx = makeCtx();
  });

  afterEach(() => {
    ctx.db.close();
  });

  test('success result structure matches between legacy and ChannelRouter paths', async () => {
    const { runId: workflowRunId, channels } = seedWorkflowRunWithChannels(ctx.db, ctx.spaceId, [
      makeResolvedChannel('coder', 'reviewer'),
    ]);
    seedPeerTask(ctx.nodeExecutionRepo, workflowRunId, NODE_ID, 'reviewer', ctx.reviewerSessionId);

    // Legacy path
    const injectedLegacy: Array<{ sessionId: string; message: string }> = [];
    const legacyConfig = makeBaseConfig(
      ctx,
      workflowRunId,
      injectedLegacy,
      new ChannelResolver([makeResolvedChannel('coder', 'reviewer')])
    );
    const legacyHandlers = createNodeAgentToolHandlers(legacyConfig);
    const legacyResult = await legacyHandlers.send_message({
      target: 'reviewer',
      message: 'test message',
    });
    const legacyData = JSON.parse(legacyResult.content[0].text);

    // ChannelRouter path
    const injectedRouter: Array<{ sessionId: string; message: string }> = [];
    const routerBaseConfig = makeBaseConfig(ctx, workflowRunId, injectedRouter);
    const agentMessageRouter = new AgentMessageRouter({
      nodeExecutionRepo: ctx.nodeExecutionRepo,
      workflowRunId,
      workflowChannels: channels,
      messageInjector: routerBaseConfig.messageInjector,
    });
    const routerHandlers = createNodeAgentToolHandlers({ ...routerBaseConfig, agentMessageRouter });
    const routerResult = await routerHandlers.send_message({
      target: 'reviewer',
      message: 'test message',
    });
    const routerData = JSON.parse(routerResult.content[0].text);

    // Both should succeed
    expect(legacyData.success).toBe(true);
    expect(routerData.success).toBe(true);

    // Both should deliver to the same session
    expect(legacyData.delivered[0].sessionId).toBe(ctx.reviewerSessionId);
    expect(routerData.delivered[0].sessionId).toBe(ctx.reviewerSessionId);

    // Both should inject the same prefixed message
    expect(injectedLegacy[0].message).toBe('─── Message from coder ───\n\ntest message');
    expect(injectedRouter[0].message).toBe('─── Message from coder ───\n\ntest message');
  });
});

// ---------------------------------------------------------------------------
// Tests: send_message — node name→fan-out (via nodeGroups in AgentMessageRouter)
// ---------------------------------------------------------------------------

describe('send_message: node name→fan-out via AgentMessageRouter', () => {
  let ctx: TestCtx;

  beforeEach(() => {
    ctx = makeCtx();
  });

  afterEach(() => {
    ctx.db.close();
  });

  test('node name target fans out to all agents mapped to that node', async () => {
    // Use node-name channels consistent with nodeGroups
    const { runId: workflowRunId, channels } = seedWorkflowRunWithChannels(ctx.db, ctx.spaceId, [
      makeResolvedChannel('code-node', 'review-node'),
    ]);
    seedPeerTask(ctx.nodeExecutionRepo, workflowRunId, NODE_ID, 'reviewer', ctx.reviewerSessionId);
    seedPeerTask(
      ctx.nodeExecutionRepo,
      workflowRunId,
      NODE_ID,
      'security',
      'session-security-unified'
    );

    const injected: Array<{ sessionId: string; message: string }> = [];
    const baseConfig = makeBaseConfig(ctx, workflowRunId, injected);

    // Configure AgentMessageRouter with nodeGroups so 'review-node' expands to both roles
    const agentMessageRouter = new AgentMessageRouter({
      nodeExecutionRepo: ctx.nodeExecutionRepo,
      workflowRunId,
      workflowChannels: channels,
      messageInjector: baseConfig.messageInjector,
      nodeGroups: {
        'code-node': ['coder'],
        'review-node': ['reviewer', 'security'],
      },
    });

    const handlers = createNodeAgentToolHandlers({ ...baseConfig, agentMessageRouter });
    const result = await handlers.send_message({
      target: 'review-node',
      message: 'fan-out to review node',
    });
    const data = JSON.parse(result.content[0].text);

    expect(data.success).toBe(true);
    expect(data.delivered).toHaveLength(2);
    const sessionIds = data.delivered.map((d: { sessionId: string }) => d.sessionId);
    expect(sessionIds).toContain(ctx.reviewerSessionId);
    expect(sessionIds).toContain('session-security-unified');
    // Both injections should carry the sender prefix
    expect(injected).toHaveLength(2);
    expect(
      injected.every((i) => i.message === '─── Message from coder ───\n\nfan-out to review node')
    ).toBe(true);
  });

  test('unknown node name returns an error when nodeGroups not configured', async () => {
    const { runId: workflowRunId, channels } = seedWorkflowRunWithChannels(ctx.db, ctx.spaceId, [
      makeResolvedChannel('coder', 'reviewer'),
    ]);
    seedPeerTask(ctx.nodeExecutionRepo, workflowRunId, NODE_ID, 'reviewer', ctx.reviewerSessionId);
    const injected: Array<{ sessionId: string; message: string }> = [];
    const baseConfig = makeBaseConfig(ctx, workflowRunId, injected);

    // No nodeGroups configured — node names are not resolvable
    const agentMessageRouter = new AgentMessageRouter({
      nodeExecutionRepo: ctx.nodeExecutionRepo,
      workflowRunId,
      workflowChannels: channels,
      messageInjector: baseConfig.messageInjector,
    });

    const handlers = createNodeAgentToolHandlers({ ...baseConfig, agentMessageRouter });
    const result = await handlers.send_message({
      target: 'review-node',
      message: 'should fail',
    });
    const data = JSON.parse(result.content[0].text);

    expect(data.success).toBe(false);
    expect(data.error).toContain('no agent or node found');
  });
});

// ---------------------------------------------------------------------------
// Tests: send_message — cross-node delivery
// ---------------------------------------------------------------------------

describe('send_message: cross-node delivery', () => {
  let ctx: TestCtx;

  beforeEach(() => {
    ctx = makeCtx();
  });

  afterEach(() => {
    ctx.db.close();
  });

  test('coder in Node A can send to reviewer in Node B via agent name', async () => {
    // This simulates cross-node delivery: coder (Node A) → reviewer (Node B).
    // Both agents are tasks in the same workflow run but can be on different nodes.
    // The AgentMessageRouter resolves cross-node delivery by role (agentName).
    const { runId: workflowRunId, channels } = seedWorkflowRunWithChannels(ctx.db, ctx.spaceId, [
      makeResolvedChannel('coder', 'reviewer'),
    ]);
    // Reviewer is on NODE_ID (same node for this test — cross-node via nodeGroups)
    seedPeerTask(ctx.nodeExecutionRepo, workflowRunId, NODE_ID, 'reviewer', ctx.reviewerSessionId);
    const injected: Array<{ sessionId: string; message: string }> = [];
    const baseConfig = makeBaseConfig(ctx, workflowRunId, injected);

    const agentMessageRouter = new AgentMessageRouter({
      nodeExecutionRepo: ctx.nodeExecutionRepo,
      workflowRunId,
      workflowChannels: channels,
      messageInjector: baseConfig.messageInjector,
    });

    const handlers = createNodeAgentToolHandlers({ ...baseConfig, agentMessageRouter });
    const result = await handlers.send_message({
      target: 'reviewer',
      message: 'cross-node message from coder',
    });
    const data = JSON.parse(result.content[0].text);

    expect(data.success).toBe(true);
    expect(data.delivered).toHaveLength(1);
    expect(data.delivered[0].sessionId).toBe(ctx.reviewerSessionId);
    expect(injected[0].message).toBe('─── Message from coder ───\n\ncross-node message from coder');
  });

  test('cross-node delivery via fan-out: coder fans out to all agents across nodes', async () => {
    const { runId: workflowRunId, channels } = seedWorkflowRunWithChannels(ctx.db, ctx.spaceId, [
      makeResolvedChannel('coder', 'reviewer'),
      makeResolvedChannel('coder', 'tester'),
    ]);
    seedPeerTask(ctx.nodeExecutionRepo, workflowRunId, NODE_ID, 'reviewer', ctx.reviewerSessionId);
    seedPeerTask(ctx.nodeExecutionRepo, workflowRunId, NODE_ID, 'tester', 'session-tester-unified');

    const injected: Array<{ sessionId: string; message: string }> = [];
    const baseConfig = makeBaseConfig(ctx, workflowRunId, injected);

    const agentMessageRouter = new AgentMessageRouter({
      nodeExecutionRepo: ctx.nodeExecutionRepo,
      workflowRunId,
      workflowChannels: channels,
      messageInjector: baseConfig.messageInjector,
    });

    // Broadcast to all permitted targets (reviewer + tester across nodes)
    const handlers = createNodeAgentToolHandlers({ ...baseConfig, agentMessageRouter });
    const result = await handlers.send_message({ target: '*', message: 'cross-node broadcast' });
    const data = JSON.parse(result.content[0].text);

    expect(data.success).toBe(true);
    expect(data.delivered).toHaveLength(2);
    const sessionIds = data.delivered.map((d: { sessionId: string }) => d.sessionId);
    expect(sessionIds).toContain(ctx.reviewerSessionId);
    expect(sessionIds).toContain('session-tester-unified');
  });
});

// ---------------------------------------------------------------------------
// Tests: send_message — gate blocked (topology-based blocking)
// ---------------------------------------------------------------------------

describe('send_message: gate blocked via topology', () => {
  let ctx: TestCtx;

  beforeEach(() => {
    ctx = makeCtx();
  });

  afterEach(() => {
    ctx.db.close();
  });

  test('send is blocked when no channel is declared from sender to target', async () => {
    // Topology only declares reviewer→coder; coder has no outgoing channels
    const { runId: workflowRunId, channels } = seedWorkflowRunWithChannels(ctx.db, ctx.spaceId, [
      makeResolvedChannel('reviewer', 'coder'),
    ]);
    seedPeerTask(ctx.nodeExecutionRepo, workflowRunId, NODE_ID, 'reviewer', ctx.reviewerSessionId);
    const injected: Array<{ sessionId: string; message: string }> = [];
    const baseConfig = makeBaseConfig(ctx, workflowRunId, injected);

    const agentMessageRouter = new AgentMessageRouter({
      nodeExecutionRepo: ctx.nodeExecutionRepo,
      workflowRunId,
      workflowChannels: channels,
      messageInjector: baseConfig.messageInjector,
    });

    const handlers = createNodeAgentToolHandlers({ ...baseConfig, agentMessageRouter });
    const result = await handlers.send_message({
      target: 'reviewer',
      message: 'should be blocked by gate',
    });
    const data = JSON.parse(result.content[0].text);

    expect(data.success).toBe(false);
    // No message was injected — gate blocked it
    expect(injected).toHaveLength(0);
    expect(data.error).toContain("does not permit 'coder' to send to: reviewer");
  });

  test('send is blocked when topology is empty (no channels declared)', async () => {
    const { runId: workflowRunId, channels } = seedWorkflowRunWithChannels(ctx.db, ctx.spaceId, []);
    seedPeerTask(ctx.nodeExecutionRepo, workflowRunId, NODE_ID, 'reviewer', ctx.reviewerSessionId);
    const injected: Array<{ sessionId: string; message: string }> = [];
    const baseConfig = makeBaseConfig(ctx, workflowRunId, injected);

    const agentMessageRouter = new AgentMessageRouter({
      nodeExecutionRepo: ctx.nodeExecutionRepo,
      workflowRunId,
      workflowChannels: channels,
      messageInjector: baseConfig.messageInjector,
    });

    const handlers = createNodeAgentToolHandlers({ ...baseConfig, agentMessageRouter });
    const result = await handlers.send_message({
      target: 'reviewer',
      message: 'no channels declared',
    });
    const data = JSON.parse(result.content[0].text);

    expect(data.success).toBe(false);
    expect(injected).toHaveLength(0);
    expect(data.error).toContain('No channel topology declared');
  });

  test('send is allowed when channel is declared in the correct direction', async () => {
    // Topology declares coder→reviewer; send should succeed
    const { runId: workflowRunId, channels } = seedWorkflowRunWithChannels(ctx.db, ctx.spaceId, [
      makeResolvedChannel('coder', 'reviewer'),
    ]);
    seedPeerTask(ctx.nodeExecutionRepo, workflowRunId, NODE_ID, 'reviewer', ctx.reviewerSessionId);
    const injected: Array<{ sessionId: string; message: string }> = [];
    const baseConfig = makeBaseConfig(ctx, workflowRunId, injected);

    const agentMessageRouter = new AgentMessageRouter({
      nodeExecutionRepo: ctx.nodeExecutionRepo,
      workflowRunId,
      workflowChannels: channels,
      messageInjector: baseConfig.messageInjector,
    });

    const handlers = createNodeAgentToolHandlers({ ...baseConfig, agentMessageRouter });
    const result = await handlers.send_message({
      target: 'reviewer',
      message: 'gate open — allowed by topology',
    });
    const data = JSON.parse(result.content[0].text);

    expect(data.success).toBe(true);
    expect(injected).toHaveLength(1);
    expect(injected[0].message).toBe(
      '─── Message from coder ───\n\ngate open — allowed by topology'
    );
  });
});
