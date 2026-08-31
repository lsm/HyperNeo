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

const REPLY_PROTOCOL =
  'Messaging protocol: if this message requests work or information from you, reply to the sender with the outcome when done — or promptly if you cannot do it. Do not leave the sender waiting.';

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

interface TestCtx {
  db: BunDatabase;
  spaceId: string;
  nodeExecutionRepo: NodeExecutionRepository;
  workflowRunRepo: SpaceWorkflowRunRepository;
  nodeId: string;
  coderSessionId: string;
  reviewerSessionId: string;
}

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
    expect(injected[0].message).toBe(
      '─── Message from coder ───\n\nLGTM!\n\n─── Reply ───\n' +
        REPLY_PROTOCOL +
        '\nTo reply, use: send_message with target "coder"'
    );
  });
});

describe('AgentMessageRouter: single agent per role (task-centric model)', () => {
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
      [makeResolvedChannel('reviewer', 'coder')]
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
        return {
          state: 'accepted',
          messageId: `msg-${spaceMessages.length}`,
          sessionId: `space:chat:${spaceId}`,
        };
      },
    });

    const result = await router.deliverMessage({
      fromAgentName: 'coder',
      fromSessionId: ctx.coderSessionId,
      target: 'space-agent',
      message: 'Blocked on product decision',
    });

    expect(result.success).toBe(true);
    expect(result.delivered).toEqual([]);
    expect(result.queued).toEqual([{ agentName: 'space-agent', messageId: 'msg-1' }]);
    expect(spaceMessages).toEqual([
      {
        spaceId: ctx.spaceId,
        message:
          '─── Message from coder (task #236) ───\n\n' +
          'Blocked on product decision\n\n' +
          '─── Reply ───\n' +
          REPLY_PROTOCOL +
          '\n' +
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
        return {
          state: 'accepted',
          messageId: `msg-${spaceMessages.length}`,
          sessionId: `space:chat:${spaceId}`,
        };
      },
    });

    const result = await router.deliverMessage({
      fromAgentName: 'coder',
      fromSessionId: ctx.coderSessionId,
      target: ['space-agent'],
      message: 'Array escalation',
    });

    expect(result.success).toBe(true);
    expect(result.delivered).toEqual([]);
    expect(result.queued).toEqual([{ agentName: 'space-agent', messageId: 'msg-1' }]);
    expect(spaceMessages).toEqual([
      {
        spaceId: ctx.spaceId,
        message:
          '─── Message from coder (task #236) ───\n\n' +
          'Array escalation\n\n' +
          '─── Reply ───\n' +
          REPLY_PROTOCOL +
          '\n' +
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

  test('uses bogus array targets verbatim and reports them as not found', async () => {
    const { runId: workflowRunId, channels: runChannels } = seedWorkflowRunWithChannels(
      ctx.db,
      ctx.spaceId,
      [makeChannel('coder', ['ghost-a', 'ghost-b'])]
    );
    seedPeerTask(ctx.db, ctx.spaceId, workflowRunId, ctx.nodeId, 'coder', ctx.coderSessionId);
    const router = makeRouter(ctx, workflowRunId, [], runChannels);

    const result = await router.deliverMessage({
      fromAgentName: 'coder',
      fromSessionId: ctx.coderSessionId,
      target: ['ghost-a', 'ghost-b'],
      message: 'ping',
    });

    expect(result).toEqual({
      success: false,
      delivered: [],
      failed: [],
      reason:
        'Could not deliver message to target agent(s): ghost-a, ghost-b. ' +
        'The target is declared but no live session received the message.',
      notFoundAgentNames: ['ghost-a', 'ghost-b'],
    });
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
  let ctx: TestCtx;

  beforeEach(() => {
    ctx = makeCtx();
  });

  afterEach(() => {
    ctx.db.close();
  });

  test('isTopologyDeclared is false when slot name differs from node-name-addressed channel source (no nodeGroups)', async () => {
    const { runId: workflowRunId } = seedWorkflowRunWithChannels(ctx.db, ctx.spaceId, [
      makeChannel('Coding', 'Review'),
    ]);
    seedPeerTask(ctx.db, ctx.spaceId, workflowRunId, ctx.nodeId, 'coder', ctx.coderSessionId);

    const router = makeRouter(ctx, workflowRunId, [], [makeChannel('Coding', 'Review')]);

    const result = await router.deliverMessage({
      fromAgentName: 'coder',
      fromSessionId: ctx.coderSessionId,
      target: 'Review',
      message: 'hello review',
    });

    expect(result.success).toBe(false);
    expect(result.reason).toContain("Unknown target 'Review'");
    expect(result.reason).toContain('no agent or node found');
  });

  test('isTopologyDeclared is true when nodeGroups maps slot name to channel source', async () => {
    const { runId: workflowRunId } = seedWorkflowRunWithChannels(ctx.db, ctx.spaceId, [
      makeChannel('Coding', 'Review'),
    ]);
    seedPeerTask(ctx.db, ctx.spaceId, workflowRunId, ctx.nodeId, 'coder', ctx.coderSessionId);

    const pendingMessageRepo = new PendingAgentMessageRepository(ctx.db);
    const router = makeRouter(ctx, workflowRunId, [], [makeChannel('Coding', 'Review')], {
      nodeGroups: { Coding: ['coder'] },
      pendingMessageRepo,
      spaceId: ctx.spaceId,
    });

    const result = await router.deliverMessage({
      fromAgentName: 'coder',
      fromSessionId: ctx.coderSessionId,
      target: 'Review',
      message: 'hello review',
    });

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
    const { runId: workflowRunId, channels: runChannels } = seedWorkflowRunWithChannels(
      ctx.db,
      ctx.spaceId,
      [makeResolvedChannel('coder', 'reviewer'), makeResolvedChannel('coder', 'ghost-role')]
    );
    seedPeerTask(ctx.db, ctx.spaceId, workflowRunId, ctx.nodeId, 'coder', ctx.coderSessionId);
    seedPeerTask(ctx.db, ctx.spaceId, workflowRunId, ctx.nodeId, 'reviewer', ctx.reviewerSessionId);

    const injected: Array<{ sessionId: string; message: string }> = [];
    const router = makeRouter(ctx, workflowRunId, injected, runChannels);

    const result = await router.deliverMessage({
      fromAgentName: 'coder',
      fromSessionId: ctx.coderSessionId,
      target: '*',
      message: 'broadcast to available',
    });

    expect(result.success).toBe(true);
    expect(result.delivered).toHaveLength(1);
    expect(result.delivered[0].agentName).toBe('reviewer');
    expect(result.notFoundAgentNames).toBeDefined();
    expect(result.notFoundAgentNames).toContain('ghost-role');
  });
});

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

    expect(result.success).toBe(false);
    expect(result.queued).toBeDefined();
    expect(result.queued).toHaveLength(1);
    expect(result.queued![0].agentName).toBe('reviewer');
    expect(result.delivered).toHaveLength(0);
    expect(injected).toHaveLength(0);

    const pending = pendingMessageRepo.listPendingForTarget(workflowRunId, 'reviewer');
    expect(pending).toHaveLength(1);
    expect(pending[0].sourceAgentName).toBe('coder');
    expect(pending[0].message).toBe(
      '─── Message from coder ───\n\ncode ready\n\n─── Reply ───\n' +
        REPLY_PROTOCOL +
        '\nTo reply, use: send_message with target "coder"'
    );
    expect(pending[0].targetKind).toBe('node_agent');
  });

  test('resolves target declared in execution even without live session (no sessionId filter)', async () => {
    const { runId: workflowRunId } = seedWorkflowRunWithChannels(ctx.db, ctx.spaceId, [
      makeChannel('coder', 'reviewer'),
    ]);

    seedPeerTask(ctx.db, ctx.spaceId, workflowRunId, ctx.nodeId, 'coder', ctx.coderSessionId);
    ctx.nodeExecutionRepo.createOrIgnore({
      workflowRunId,
      workflowNodeId: ctx.nodeId,
      agentName: 'reviewer',
      status: 'in_progress',
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

    expect(result.success).toBe(false);
    expect(result.queued).toBeDefined();
    expect(result.queued![0].agentName).toBe('reviewer');
  });

  test('activates and queues during pre-session window when the only execution has no session', async () => {
    const { runId: workflowRunId } = seedWorkflowRunWithChannels(ctx.db, ctx.spaceId, [
      makeChannel('coder', 'reviewer'),
    ]);

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
    seedPeerTask(ctx.db, ctx.spaceId, workflowRunId, ctx.nodeId, 'reviewer', ctx.reviewerSessionId);
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

    const router = makeRouter(ctx, workflowRunId, [], [makeChannel('coder', 'reviewer')]);

    const result = await router.deliverMessage({
      fromAgentName: 'coder',
      fromSessionId: ctx.coderSessionId,
      target: 'reviewer',
      message: 'hello',
    });

    expect(result.success).toBe(false);
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

  test('keeps plain queue target names unscoped', async () => {
    const { runId: workflowRunId } = seedWorkflowRunWithChannels(ctx.db, ctx.spaceId, [
      makeChannel('Coding', 'Review'),
    ]);
    seedPeerTask(ctx.db, ctx.spaceId, workflowRunId, 'node-coding', 'coder', ctx.coderSessionId);
    ctx.nodeExecutionRepo.createOrIgnore({
      workflowRunId,
      workflowNodeId: 'missing-review-node',
      agentName: 'reviewer',
      status: 'pending',
    });

    const pendingMessageRepo = new PendingAgentMessageRepository(ctx.db);
    const router = makeRouter(ctx, workflowRunId, [], [makeChannel('Coding', 'Review')], {
      nodeGroups: { Coding: ['coder'], Review: ['reviewer'] },
      workflowNodeNameById: { 'node-coding': 'Coding' },
      pendingMessageRepo,
      spaceId: ctx.spaceId,
    });

    const result = await router.deliverMessage({
      fromAgentName: 'coder',
      fromSessionId: ctx.coderSessionId,
      target: 'reviewer',
      message: 'please review',
    });

    expect(result.queued?.[0].agentName).toBe('reviewer');
    const pending = pendingMessageRepo.listAllForRun(workflowRunId);
    expect(pending).toHaveLength(1);
    expect(pending[0].targetAgentName).toBe('reviewer');
    expect(pending[0].workflowNodeId).toBeNull();
  });

  test('scopes @worker queue target names when the node id is unresolved', async () => {
    const { runId: workflowRunId } = seedWorkflowRunWithChannels(ctx.db, ctx.spaceId, [
      makeChannel('Coding', 'Review'),
    ]);
    seedPeerTask(ctx.db, ctx.spaceId, workflowRunId, 'node-coding', 'coder', ctx.coderSessionId);
    ctx.nodeExecutionRepo.createOrIgnore({
      workflowRunId,
      workflowNodeId: 'missing-review-node',
      agentName: 'reviewer',
      status: 'pending',
    });

    const pendingMessageRepo = new PendingAgentMessageRepository(ctx.db);
    const router = makeRouter(ctx, workflowRunId, [], [makeChannel('Coding', 'Review')], {
      nodeGroups: { Coding: ['coder'], Review: ['reviewer'] },
      workflowNodeNameById: { 'node-coding': 'Coding' },
      pendingMessageRepo,
      spaceId: ctx.spaceId,
    });

    const result = await router.deliverMessage({
      fromAgentName: 'coder',
      fromSessionId: ctx.coderSessionId,
      target: '@worker:Review/reviewer',
      message: 'please review',
    });

    expect(result.queued?.[0].agentName).toBe('Review/reviewer');
    const pending = pendingMessageRepo.listAllForRun(workflowRunId);
    expect(pending).toHaveLength(1);
    expect(pending[0].targetAgentName).toBe('Review/reviewer');
    expect(pending[0].workflowNodeId).toBeNull();
  });

  test('scoped compound row carries the resolved node id (node-name worker handle)', async () => {
    const { runId: workflowRunId } = seedWorkflowRunWithChannels(ctx.db, ctx.spaceId, [
      makeChannel('coder', 'Review'),
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
    expect(result.queued![0].agentName).toBe('Review/reviewer');
    const pending = pendingMessageRepo.listPendingForTarget(workflowRunId, 'reviewer');
    expect(pending).toHaveLength(1);
    expect(pending[0].targetAgentName).toBe('reviewer');
    expect(pending[0].workflowNodeId).toBe('review-node-id');
  });

  test('scoped compound row carries the resolved node id (node-id worker handle)', async () => {
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
    expect(pending[0].workflowNodeId).toBe('ctor-node-id');
  });

  test('a node id that collides with another node name resolves to the id (ids authoritative)', async () => {
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
    expect(pending[0].workflowNodeId).toBe('Review');
  });

  test('a name/id ref collision resolves by the agent slot, not by namespace precedence', async () => {
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
    expect(pending[0].workflowNodeId).toBe('x');
  });

  test('does not fire the activation callback for an unknown worker node ref', async () => {
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

    expect(queuedAgents).toEqual([]);
  });
});

describe('AgentMessageRouter: broadcast * with mixed active/inactive targets', () => {
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
    seedPeerTask(ctx.db, ctx.spaceId, workflowRunId, ctx.nodeId, 'reviewer', ctx.reviewerSessionId);
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

    expect(result.success).toBe(true);
    expect(result.delivered).toHaveLength(1);
    expect(result.delivered[0].agentName).toBe('reviewer');
    expect(result.queued).toHaveLength(1);
    expect(result.queued![0].agentName).toBe('security');
    expect(delivered).toContain(ctx.reviewerSessionId);

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

    expect(result.success).toBe(false);
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
      target: 'reviewer',
      message: 'lazy activation please',
    });

    expect(result.success).toBe(false);
    expect(result.queued).toHaveLength(1);
    expect(result.queued![0].agentName).toBe('reviewer');
    expect(result.delivered).toHaveLength(0);
    expect(result.notFoundAgentNames).toContain('reviewer');

    const pending = pendingMessageRepo.listPendingForTarget(workflowRunId, 'reviewer');
    expect(pending).toHaveLength(1);
    expect(pending[0].message).toContain('lazy activation please');
  });

  test('returns "Unknown target" when slot is not declared in workflow nor in node_executions', async () => {
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
    const { runId: workflowRunId } = seedWorkflowRunWithChannels(ctx.db, ctx.spaceId, [
      makeChannel('coder', 'reviewer'),
    ]);
    seedPeerTask(ctx.db, ctx.spaceId, workflowRunId, ctx.nodeId, 'coder', ctx.coderSessionId);

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
    expect(queuedAgents).toEqual(['reviewer']);
    expect(queuedNodeIds).toEqual(['node-review']);
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
    const pending = pendingMessageRepo.listPendingForTarget(workflowRunId, 'reviewer');
    expect(pending).toHaveLength(1);
    expect(pending[0].targetAgentName).toBe('reviewer');
    expect(pending[0].workflowNodeId).toBe('node-review-a');
  });

  test('does not infer a node name for a slot declared in two node groups', async () => {
    const { runId: workflowRunId } = seedWorkflowRunWithChannels(ctx.db, ctx.spaceId, [
      makeChannel('Coding', ['Review A', 'Review B']),
    ]);
    seedPeerTask(ctx.db, ctx.spaceId, workflowRunId, 'node-coding', 'coder', ctx.coderSessionId);
    seedPeerTask(
      ctx.db,
      ctx.spaceId,
      workflowRunId,
      'unmapped-review-a',
      'reviewer',
      'session-review-a'
    );
    const activatedAgents: string[] = [];
    const router = makeRouter(
      ctx,
      workflowRunId,
      [],
      [makeChannel('Coding', ['Review A', 'Review B'])],
      {
        nodeGroups: { Coding: ['coder'], 'Review A': ['reviewer'], 'Review B': ['reviewer'] },
        workflowNodeNameById: { 'node-coding': 'Coding' },
        activateTargetSession: async (agentName) => {
          activatedAgents.push(agentName);
          return [];
        },
      }
    );

    for (const nodeName of ['Review A', 'Review B']) {
      const result = await router.deliverMessage({
        fromAgentName: 'coder',
        fromSessionId: ctx.coderSessionId,
        target: `@worker:${encodeURIComponent(nodeName)}/reviewer`,
        message: `${nodeName} only`,
      });

      expect(result.success).toBe(false);
      expect(result.delivered).toEqual([]);
      expect(result.notFoundAgentNames).toEqual(['reviewer']);
    }
    expect(activatedAgents).toEqual(['reviewer', 'reviewer']);
  });

  test('treats a generic target as a plain agent name when mixed with a plain target', async () => {
    const { runId: workflowRunId } = seedWorkflowRunWithChannels(ctx.db, ctx.spaceId, [
      makeChannel('coder', 'reviewer'),
    ]);
    seedPeerTask(ctx.db, ctx.spaceId, workflowRunId, ctx.nodeId, 'coder', ctx.coderSessionId);
    seedPeerTask(ctx.db, ctx.spaceId, workflowRunId, ctx.nodeId, 'reviewer', ctx.reviewerSessionId);
    const injected: Array<{ sessionId: string; message: string }> = [];
    const spaceMessages: string[] = [];
    const router = makeRouter(ctx, workflowRunId, injected, [makeChannel('coder', 'reviewer')], {
      spaceId: ctx.spaceId,
      spaceAgentInjector: async (_spaceId, message) => {
        spaceMessages.push(message);
        return {
          state: 'accepted',
          messageId: `msg-${spaceMessages.length}`,
          sessionId: 'sess-stub',
        };
      },
    });

    const result = await router.deliverMessage({
      fromAgentName: 'coder',
      fromSessionId: ctx.coderSessionId,
      target: ['reviewer', '@coordinator'],
      message: 'mixed route',
    });

    expect(result).toEqual({
      success: false,
      delivered: [],
      failed: [],
      reason:
        "Channel topology does not permit 'coder' to send to: @coordinator. " +
        'Permitted targets: reviewer.',
      unauthorizedAgentNames: ['@coordinator'],
      permittedTargets: ['reviewer'],
    });
    expect(injected).toEqual([]);
    expect(spaceMessages).toEqual([]);
  });

  test('preserves earlier generic deliveries when a later @session target is unauthorized', async () => {
    const { runId: workflowRunId } = seedWorkflowRunWithChannels(ctx.db, ctx.spaceId, []);
    seedPeerTask(ctx.db, ctx.spaceId, workflowRunId, ctx.nodeId, 'coder', ctx.coderSessionId);
    const injected: Array<string | null> = [];
    const router = makeRouter(ctx, workflowRunId, [], [], {
      spaceId: ctx.spaceId,
      spaceAgentInjector: async (spaceId, _message, replyToSessionId) => {
        injected.push(replyToSessionId);
        return {
          state: 'accepted',
          messageId: `msg-${injected.length}`,
          sessionId: replyToSessionId ?? `space:chat:${spaceId}`,
        };
      },
      replyRoutingLookup: () => 'session-origin',
    });

    const result = await router.deliverMessage({
      fromAgentName: 'coder',
      fromSessionId: ctx.coderSessionId,
      target: ['@coordinator', '@session:other-session'],
      message: 'partial route',
    });

    expect(result).toEqual({
      success: 'partial',
      delivered: [],
      failed: [],
      reason: "Session target @session:other-session is not an authorized reply route for 'coder'.",
      unauthorizedAgentNames: ['@session:other-session'],
      queued: [{ agentName: 'space-agent', messageId: 'msg-1' }],
      notFoundAgentNames: undefined,
    });
    expect(injected).toEqual([null]);
  });

  test('counts a queued coordinator delivery as partial when a later @worker target is invalid', async () => {
    const { runId: workflowRunId } = seedWorkflowRunWithChannels(ctx.db, ctx.spaceId, []);
    seedPeerTask(ctx.db, ctx.spaceId, workflowRunId, ctx.nodeId, 'coder', ctx.coderSessionId);
    const router = makeRouter(ctx, workflowRunId, [], [], {
      spaceId: ctx.spaceId,
      spaceAgentInjector: async () => ({
        state: 'accepted',
        messageId: 'msg-queued-coordinator',
        sessionId: 'sess-stub',
      }),
    });

    const result = await router.deliverMessage({
      fromAgentName: 'coder',
      fromSessionId: ctx.coderSessionId,
      target: ['@coordinator', '@worker:%2F/bad'],
      message: 'mixed route with invalid worker',
    });

    expect(result.success).toBe('partial');
    expect(result.delivered).toEqual([]);
    expect(result.failed).toEqual([]);
    expect(result.queued).toEqual([
      { agentName: 'space-agent', messageId: 'msg-queued-coordinator' },
    ]);
    expect(result.reason).toContain("Channel topology does not permit 'coder' to send to");
  });

  test('classifies queued coordinator plus unknown worker as partial instead of failure', async () => {
    const { runId: workflowRunId } = seedWorkflowRunWithChannels(ctx.db, ctx.spaceId, []);
    seedPeerTask(ctx.db, ctx.spaceId, workflowRunId, ctx.nodeId, 'coder', ctx.coderSessionId);
    const router = makeRouter(ctx, workflowRunId, [], [], {
      spaceId: ctx.spaceId,
      spaceAgentInjector: async () => ({
        state: 'accepted',
        messageId: 'msg-queued-coordinator',
        sessionId: 'sess-stub',
      }),
    });

    const result = await router.deliverMessage({
      fromAgentName: 'coder',
      fromSessionId: ctx.coderSessionId,
      target: ['@coordinator', '@worker:ghost/ghost'],
      message: 'queued coordinator plus unknown worker',
    });

    expect(result.success).toBe('partial');
    expect(result.queued).toEqual([
      { agentName: 'space-agent', messageId: 'msg-queued-coordinator' },
    ]);
    expect(JSON.stringify(result)).toContain('ghost');
  });

  test('preserves queued coordinator delivery when facade resolution rejects', async () => {
    const { runId: workflowRunId } = seedWorkflowRunWithChannels(ctx.db, ctx.spaceId, []);
    seedPeerTask(ctx.db, ctx.spaceId, workflowRunId, ctx.nodeId, 'coder', ctx.coderSessionId);
    const router = makeRouter(ctx, workflowRunId, [], [], {
      spaceId: ctx.spaceId,
      spaceAgentInjector: async () => ({
        state: 'accepted',
        messageId: 'msg-queued-coordinator',
        sessionId: 'sess-stub',
      }),
      messageResolver: {
        resolveTargets: async () => {
          throw new Error('resolver down');
        },
      } as unknown as NonNullable<AgentMessageRouterConfig['messageResolver']>,
      longTermAgentDelivery: {},
    });

    const result = await router.deliverMessage({
      fromAgentName: 'coder',
      fromSessionId: ctx.coderSessionId,
      target: ['@coordinator', '@role:reviewer'],
      message: 'queued coordinator plus failing resolver',
    });

    expect(result.success).toBe('partial');
    expect(result.delivered).toEqual([]);
    expect(result.failed).toEqual([]);
    expect(result.queued).toEqual([
      { agentName: 'space-agent', messageId: 'msg-queued-coordinator' },
    ]);
    expect(result.reason).toBe('resolver down');
  });

  test('keeps earlier delivered results when a later generic target is invalid', async () => {
    const { runId: workflowRunId } = seedWorkflowRunWithChannels(ctx.db, ctx.spaceId, []);
    seedPeerTask(ctx.db, ctx.spaceId, workflowRunId, ctx.nodeId, 'coder', ctx.coderSessionId);
    const router = makeRouter(ctx, workflowRunId, [], [], {
      spaceId: ctx.spaceId,
      spaceAgentInjector: async () => ({
        state: 'accepted',
        messageId: 'msg-live-coordinator',
        sessionId: `space:chat:${ctx.spaceId}`,
      }),
    });

    const result = await router.deliverMessage({
      fromAgentName: 'coder',
      fromSessionId: ctx.coderSessionId,
      target: ['@coordinator', '@worker:%2F/bad'],
      message: 'delivered then invalid',
    });

    expect(result.success).toBe('partial');
    expect(result.delivered).toEqual([]);
    expect(result.queued).toEqual([
      { agentName: 'space-agent', messageId: 'msg-live-coordinator' },
    ]);
    expect(result.reason).toContain("Channel topology does not permit 'coder' to send to");
  });

  test('reports injector failure to the sender when an idle-coordinator delivery dead-letters', async () => {
    const { runId: workflowRunId } = seedWorkflowRunWithChannels(ctx.db, ctx.spaceId, []);
    seedPeerTask(ctx.db, ctx.spaceId, workflowRunId, ctx.nodeId, 'coder', ctx.coderSessionId);
    const router = makeRouter(ctx, workflowRunId, [], [], {
      spaceId: ctx.spaceId,
      spaceAgentInjector: async () => ({
        state: 'failed' as const,
        messageId: 'msg-dead-lettered',
        sessionId: `space:chat:${ctx.spaceId}`,
        error: 'delivery dead-lettered while awaiting consumption',
      }),
    });

    const result = await router.deliverMessage({
      fromAgentName: 'coder',
      fromSessionId: ctx.coderSessionId,
      target: '@coordinator',
      message: 'escalation that dead-letters',
    });

    expect(result).toEqual({
      success: false,
      delivered: [],
      failed: [
        {
          agentName: 'space-agent',
          sessionId: `space:chat:${ctx.spaceId}`,
          error: 'delivery dead-lettered while awaiting consumption',
        },
      ],
      queued: undefined,
      notFoundAgentNames: undefined,
    });
  });

  test('counts a queued coordinator delivery as partial when a later @session target is unauthorized', async () => {
    const { runId: workflowRunId } = seedWorkflowRunWithChannels(ctx.db, ctx.spaceId, []);
    seedPeerTask(ctx.db, ctx.spaceId, workflowRunId, ctx.nodeId, 'coder', ctx.coderSessionId);
    const router = makeRouter(ctx, workflowRunId, [], [], {
      spaceId: ctx.spaceId,
      spaceAgentInjector: async () => ({
        state: 'accepted',
        messageId: 'msg-queued-coordinator',
        sessionId: 'sess-stub',
      }),
      replyRoutingLookup: () => 'session-origin',
    });

    const result = await router.deliverMessage({
      fromAgentName: 'coder',
      fromSessionId: ctx.coderSessionId,
      target: ['@coordinator', '@session:other-session'],
      message: 'partial route with queued coordinator',
    });

    expect(result).toEqual({
      success: 'partial',
      delivered: [],
      failed: [],
      reason: "Session target @session:other-session is not an authorized reply route for 'coder'.",
      unauthorizedAgentNames: ['@session:other-session'],
      queued: [{ agentName: 'space-agent', messageId: 'msg-queued-coordinator' }],
      notFoundAgentNames: undefined,
    });
  });

  test('rejects unauthorized @session targets with the exact reply-route error', async () => {
    const { runId: workflowRunId } = seedWorkflowRunWithChannels(ctx.db, ctx.spaceId, []);
    seedPeerTask(ctx.db, ctx.spaceId, workflowRunId, ctx.nodeId, 'coder', ctx.coderSessionId);
    const router = makeRouter(ctx, workflowRunId, [], [], {
      spaceId: ctx.spaceId,
      spaceAgentInjector: async () => ({
        state: 'accepted',
        messageId: 'msg-space-agent',
        sessionId: 'sess-stub',
      }),
      replyRoutingLookup: () => 'session-origin',
    });

    const result = await router.deliverMessage({
      fromAgentName: 'coder',
      fromSessionId: ctx.coderSessionId,
      target: '@session:other-session',
      message: 'bad route',
    });

    expect(result).toEqual({
      success: false,
      delivered: [],
      failed: [],
      reason: "Session target @session:other-session is not an authorized reply route for 'coder'.",
      unauthorizedAgentNames: ['@session:other-session'],
      queued: undefined,
      notFoundAgentNames: undefined,
    });
  });

  test('rejects unauthorized @session targets and permits reply-route sessions', async () => {
    const { runId: workflowRunId } = seedWorkflowRunWithChannels(ctx.db, ctx.spaceId, []);
    seedPeerTask(ctx.db, ctx.spaceId, workflowRunId, ctx.nodeId, 'coder', ctx.coderSessionId);
    const injected: string[] = [];
    const router = makeRouter(ctx, workflowRunId, [], [], {
      spaceId: ctx.spaceId,
      spaceAgentInjector: async (_spaceId, _message, replyToSessionId) => {
        injected.push(replyToSessionId ?? 'default');
        return { state: 'accepted', messageId: `msg-${injected.length}`, sessionId: 'sess-stub' };
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
      JSON.stringify([
        ctx.coderSessionId,
        'reviewer',
        '─── Message from coder ───\n\nsame handoff\n\n─── Reply ───\n' +
          REPLY_PROTOCOL +
          '\nTo reply, use: send_message with target "coder"',
      ])
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

    expect(resumedAgents).toHaveLength(0);
  });
});

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
        return { state: 'accepted', messageId: `msg-${injected.length}`, sessionId: 'sess-stub' };
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
    expect(result.delivered).toEqual([]);
    expect(result.queued).toEqual([{ agentName: 'space-agent', messageId: 'msg-1' }]);
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
        return { state: 'accepted', messageId: `msg-${injected.length}`, sessionId: 'sess-stub' };
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
    expect(result.delivered).toEqual([]);
    expect(result.queued).toEqual([{ agentName: 'space-agent', messageId: 'msg-1' }]);
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
        return { state: 'accepted', messageId: `msg-${injected.length}`, sessionId: 'sess-stub' };
      },
    });

    const result = await router.deliverMessage({
      fromAgentName: 'coder',
      fromSessionId: ctx.coderSessionId,
      target: 'space-agent',
      message: 'No lookup configured',
    });

    expect(result.success).toBe(true);
    expect(result.delivered).toEqual([]);
    expect(result.queued).toEqual([{ agentName: 'space-agent', messageId: 'msg-1' }]);
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
      spaceAgentInjector: async () => ({
        state: 'accepted',
        messageId: 'msg-space-agent',
        sessionId: 'sess-stub',
      }),
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

    expect(injected.some((i) => i.sessionId === 'merger-session')).toBe(false);
  });

  test('replaces all other target sessions with the post-approval session', async () => {
    const { runId: workflowRunId, channels: runChannels } = seedWorkflowRunWithChannels(
      ctx.db,
      ctx.spaceId,
      [makeChannel('Review', 'Post-Approval')]
    );
    seedPeerTask(ctx.db, ctx.spaceId, workflowRunId, ctx.nodeId, 'reviewer', ctx.reviewerSessionId);
    seedPeerTask(
      ctx.db,
      ctx.spaceId,
      workflowRunId,
      ctx.nodeId,
      'merger',
      'stale-merger-session-a'
    );
    seedPeerTask(
      ctx.db,
      ctx.spaceId,
      workflowRunId,
      'another-merger-node',
      'merger',
      'stale-merger-session-b'
    );
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

    expect(result.delivered).toEqual([{ agentName: 'merger', sessionId: 'live-merger-session' }]);
    expect(injected.map(({ sessionId }) => sessionId)).toEqual(['live-merger-session']);
  });

  test('prefers the live merger session over a stale merger node_execution', async () => {
    const { runId: workflowRunId, channels: runChannels } = seedWorkflowRunWithChannels(
      ctx.db,
      ctx.spaceId,
      [makeChannel('Review', 'Post-Approval')]
    );
    seedPeerTask(ctx.db, ctx.spaceId, workflowRunId, ctx.nodeId, 'reviewer', ctx.reviewerSessionId);
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
    expect(injected.some((i) => i.sessionId === 'stale-merger-session')).toBe(false);
  });
});
