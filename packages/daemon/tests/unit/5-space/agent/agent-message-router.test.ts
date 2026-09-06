import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { Database as BunDatabase } from '../../../../src/storage/sqlite-compat';
import { runMigrations } from '../../../../src/storage/schema/index.ts';
import { NodeExecutionRepository } from '../../../../src/storage/repositories/node-execution-repository.ts';
import { SpaceWorkflowRepository } from '../../../../src/storage/repositories/space-workflow-repository.ts';
import { SpaceWorkflowRunRepository } from '../../../../src/storage/repositories/space-workflow-run-repository.ts';
import { AgentMessageRouter } from '../../../../src/lib/space/runtime/agent-message-router.ts';
import type { AgentMessageRouterConfig } from '../../../../src/lib/space/runtime/agent-message-router.ts';
import type { WorkflowChannel } from '@hyperneo/shared';
import type { SessionTarget } from '../../../../src/lib/session-resolution/target.ts';

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
  const deliverToTarget: NonNullable<AgentMessageRouterConfig['deliverToTarget']> = async (
    target,
    message,
    messageId,
    sessionIdHint
  ) => {
    const sessionId =
      target.kind === 'session'
        ? target.sessionId
        : target.kind === 'agent'
          ? `space:chat:${target.spaceId}`
          : (sessionIdHint ??
            ctx.nodeExecutionRepo
              .listByWorkflowRun(workflowRunId)
              .find(
                (execution) =>
                  execution.agentName === target.agentName &&
                  (target.workflowNodeId === undefined ||
                    execution.workflowNodeId === target.workflowNodeId)
              )?.agentSessionId ??
            '');
    injected.push({ sessionId, message });
    return { state: 'delivered', sessionId, messageId };
  };
  return new AgentMessageRouter({
    nodeExecutionRepo: ctx.nodeExecutionRepo,
    workflowRunId,
    workflowChannels: channels,
    messageInjector: async (sessionId, message) => {
      injected.push({ sessionId, message });
    },
    ...overrides,
    deliverToTarget:
      overrides.deliverToTarget ??
      (overrides.messageInjector || overrides.spaceAgentInjector ? undefined : deliverToTarget),
    taskId: overrides.taskId === null ? undefined : (overrides.taskId ?? 'task-test'),
  });
}

describe('AgentMessageRouter: single-target delivery door', () => {
  let ctx: TestCtx;

  beforeEach(() => {
    ctx = makeCtx();
  });

  afterEach(() => {
    ctx.db.close();
  });

  test('keeps channel activation before one worker-door call', async () => {
    const { runId: workflowRunId, channels } = seedWorkflowRunWithChannels(ctx.db, ctx.spaceId, [
      makeChannel('coder', 'reviewer'),
    ]);
    seedPeerTask(ctx.db, ctx.spaceId, workflowRunId, 'node-coder', 'coder', ctx.coderSessionId);
    seedPeerTask(
      ctx.db,
      ctx.spaceId,
      workflowRunId,
      'node-reviewer',
      'reviewer',
      ctx.reviewerSessionId
    );
    const order: string[] = [];
    const targets: SessionTarget[] = [];
    const router = makeRouter(ctx, workflowRunId, [], channels, {
      taskId: 'task-1',
      channelRouter: {
        deliverMessage: async () => {
          order.push('channel');
          return {} as never;
        },
      } as AgentMessageRouterConfig['channelRouter'],
      deliverToTarget: async (target, _message, messageId) => {
        order.push('door');
        targets.push(target);
        return { state: 'delivered', sessionId: ctx.reviewerSessionId, messageId };
      },
    });

    const result = await router.deliverMessage({
      fromAgentName: 'coder',
      fromSessionId: ctx.coderSessionId,
      target: 'reviewer',
      message: 'review',
    });

    expect(result.success).toBe(true);
    expect(order).toEqual(['channel', 'door']);
    expect(targets).toEqual([
      {
        kind: 'worker',
        taskId: 'task-1',
        agentName: 'reviewer',
        workflowNodeId: 'node-reviewer',
      },
    ]);
  });

  test('keeps fan-out and partial failures caller-side', async () => {
    const { runId: workflowRunId, channels } = seedWorkflowRunWithChannels(ctx.db, ctx.spaceId, [
      makeChannel('coder', ['reviewer', 'security']),
    ]);
    seedPeerTask(ctx.db, ctx.spaceId, workflowRunId, 'node-coder', 'coder', ctx.coderSessionId);
    seedPeerTask(
      ctx.db,
      ctx.spaceId,
      workflowRunId,
      'node-reviewer',
      'reviewer',
      'session-reviewer'
    );
    seedPeerTask(
      ctx.db,
      ctx.spaceId,
      workflowRunId,
      'node-security',
      'security',
      'session-security'
    );
    const targets: SessionTarget[] = [];
    const router = makeRouter(ctx, workflowRunId, [], channels, {
      taskId: 'task-1',
      deliverToTarget: async (target, _message, messageId) => {
        targets.push(target);
        if (target.kind === 'worker' && target.agentName === 'security') {
          throw new Error('security unavailable');
        }
        return { state: 'delivered', sessionId: 'session-reviewer', messageId };
      },
    });

    const result = await router.deliverMessage({
      fromAgentName: 'coder',
      fromSessionId: ctx.coderSessionId,
      target: ['reviewer', 'security'],
      message: 'review',
    });

    expect(targets).toHaveLength(2);
    expect(result.success).toBe('partial');
    expect(result.delivered).toEqual([{ agentName: 'reviewer', sessionId: 'session-reviewer' }]);
    expect(result.failed).toEqual([
      { agentName: 'security', sessionId: 'session-security', error: 'security unavailable' },
    ]);
  });

  test('keeps duplicate worker names scoped to the caller-expanded node', async () => {
    const { runId: workflowRunId, channels } = seedWorkflowRunWithChannels(ctx.db, ctx.spaceId, [
      makeChannel('Coding', 'Review A'),
    ]);
    seedPeerTask(ctx.db, ctx.spaceId, workflowRunId, 'node-coder', 'coder', ctx.coderSessionId);
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
    const targets: SessionTarget[] = [];
    const router = makeRouter(ctx, workflowRunId, [], channels, {
      taskId: 'task-1',
      nodeGroups: { Coding: ['coder'], 'Review A': ['reviewer'], 'Review B': ['reviewer'] },
      workflowNodeNameById: {
        'node-coder': 'Coding',
        'node-review-a': 'Review A',
        'node-review-b': 'Review B',
      },
      deliverToTarget: async (target, _message, messageId) => {
        targets.push(target);
        return { state: 'delivered', sessionId: 'session-review-a', messageId };
      },
    });

    await router.deliverMessage({
      fromAgentName: 'coder',
      fromSessionId: ctx.coderSessionId,
      target: '@worker:Review%20A/reviewer',
      message: 'review A',
    });

    expect(targets).toEqual([
      {
        kind: 'worker',
        taskId: 'task-1',
        agentName: 'reviewer',
        workflowNodeId: 'node-review-a',
      },
    ]);
  });

  test('routes coordinator and authorized session targets through their target kinds', async () => {
    const { runId: workflowRunId } = seedWorkflowRunWithChannels(ctx.db, ctx.spaceId, []);
    seedPeerTask(ctx.db, ctx.spaceId, workflowRunId, ctx.nodeId, 'coder', ctx.coderSessionId);
    const targets: SessionTarget[] = [];
    const router = makeRouter(ctx, workflowRunId, [], [], {
      spaceId: ctx.spaceId,
      replyRoutingLookup: () => 'authorized-session',
      deliverToTarget: async (target, _message, messageId) => {
        targets.push(target);
        return {
          state: 'delivered',
          sessionId: target.kind === 'session' ? target.sessionId : `space:chat:${ctx.spaceId}`,
          messageId,
        };
      },
    });

    await router.deliverMessage({
      fromAgentName: 'coder',
      fromSessionId: ctx.coderSessionId,
      target: '@coordinator',
      message: 'escalate',
    });
    await router.deliverMessage({
      fromAgentName: 'coder',
      fromSessionId: ctx.coderSessionId,
      target: '@session:authorized-session',
      message: 'reply',
    });

    expect(targets).toEqual([
      { kind: 'agent', spaceId: ctx.spaceId, agentId: 'coordinator' },
      { kind: 'session', sessionId: 'authorized-session' },
    ]);
  });

  test('rejects unauthorized sessions before invoking the door', async () => {
    const { runId: workflowRunId } = seedWorkflowRunWithChannels(ctx.db, ctx.spaceId, []);
    seedPeerTask(ctx.db, ctx.spaceId, workflowRunId, ctx.nodeId, 'coder', ctx.coderSessionId);
    const targets: SessionTarget[] = [];
    const router = makeRouter(ctx, workflowRunId, [], [], {
      spaceId: ctx.spaceId,
      replyRoutingLookup: () => 'authorized-session',
      deliverToTarget: async (target, _message, messageId) => {
        targets.push(target);
        return { state: 'delivered', sessionId: 'other-session', messageId };
      },
    });

    const result = await router.deliverMessage({
      fromAgentName: 'coder',
      fromSessionId: ctx.coderSessionId,
      target: '@session:other-session',
      message: 'not authorized',
    });

    expect(result.success).toBe(false);
    expect(targets).toEqual([]);
  });
});

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

    const router = makeRouter(ctx, workflowRunId, [], [makeChannel('Coding', 'Review')], {
      nodeGroups: { Coding: ['coder'] },
      spaceId: ctx.spaceId,
    });

    const result = await router.deliverMessage({
      fromAgentName: 'coder',
      fromSessionId: ctx.coderSessionId,
      target: 'Review',
      message: 'hello review',
    });

    expect(result.success).toBe(false);
    expect(result.notFoundAgentNames).toEqual(['Review']);
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

  test('delivers to the live session and reports inactive declared agents as not found', async () => {
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

    const injected: string[] = [];

    const router = new AgentMessageRouter({
      nodeExecutionRepo: ctx.nodeExecutionRepo,
      workflowRunId,
      workflowChannels: [makeChannel('coder', 'reviewer'), makeChannel('coder', 'security')],
      messageInjector: async (sid) => {
        injected.push(sid);
      },
      spaceId: ctx.spaceId,
      taskId: null,
    });

    const result = await router.deliverMessage({
      fromAgentName: 'coder',
      fromSessionId: ctx.coderSessionId,
      target: ['reviewer', 'security'],
      message: 'status update',
    });

    expect(result.success).toBe('partial');
    expect(result.delivered).toHaveLength(1);
    expect(result.delivered[0].agentName).toBe('reviewer');
    expect(injected).toContain(ctx.reviewerSessionId);
    expect(result.notFoundAgentNames).toContain('security');
  });

  test('still returns no-session error for topology-declared target without a live session', async () => {
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

describe('AgentMessageRouter: broadcast * with mixed active/inactive targets', () => {
  let ctx: TestCtx;

  beforeEach(() => {
    ctx = makeCtx();
  });

  afterEach(() => {
    ctx.db.close();
  });

  test('delivers to active targets and reports inactive declared targets as not found', async () => {
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
        spaceId: ctx.spaceId,
      }
    );

    const result = await router.deliverMessage({
      fromAgentName: 'coder',
      fromSessionId: ctx.coderSessionId,
      target: '*',
      message: 'broadcast to all',
    });

    expect(result.success).toBe('partial');
    expect(result.delivered).toHaveLength(1);
    expect(result.delivered[0].agentName).toBe('reviewer');
    expect(result.notFoundAgentNames).toContain('security');
    expect(delivered).toContain(ctx.reviewerSessionId);
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

  test('returns "Unknown target" when slot is not declared in workflow nor in node_executions', async () => {
    const { runId: workflowRunId } = seedWorkflowRunWithChannels(ctx.db, ctx.spaceId, [
      makeChannel('coder-node', 'review-node'),
    ]);
    seedPeerTask(ctx.db, ctx.spaceId, workflowRunId, ctx.nodeId, 'coder', ctx.coderSessionId);

    const router = makeRouter(ctx, workflowRunId, [], [makeChannel('coder-node', 'review-node')], {
      nodeGroups: {
        'coder-node': ['coder'],
        'review-node': ['reviewer'],
      },
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
