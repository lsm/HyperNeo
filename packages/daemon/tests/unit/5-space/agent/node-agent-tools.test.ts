import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { Database as BunDatabase } from '../../../../src/storage/sqlite-compat';
import { runMigrations } from '../../../../src/storage/schema/index.ts';
import { SpaceTaskRepository } from '../../../../src/storage/repositories/space-task-repository.ts';
import { SpaceTaskManager } from '../../../../src/lib/space/managers/space-task-manager.ts';
import { NodeExecutionRepository } from '../../../../src/storage/repositories/node-execution-repository.ts';
import { WorkflowRunArtifactRepository } from '../../../../src/storage/repositories/workflow-run-artifact-repository.ts';
import {
  createNodeAgentToolHandlers,
  createNodeAgentMcpServer,
  type NodeAgentToolsConfig,
} from '../../../../src/lib/space/tools/node-agent-tools.ts';
import { AgentMessageRouter } from '../../../../src/lib/space/runtime/agent-message-router.ts';
import { ChannelResolver } from '../../../../src/lib/space/runtime/channel-resolver.ts';
import { PendingAgentMessageRepository } from '../../../../src/storage/repositories/pending-agent-message-repository.ts';
import { McpAuditLogRepository } from '../../../../src/storage/repositories/mcp-audit-log-repository.ts';
import { ExternalEventStore } from '../../../../src/lib/external-events/external-event-store.ts';
import type { ExternalEvent } from '../../../../src/lib/external-events/types.ts';
import { jsonResult } from '../../../../src/lib/space/tools/tool-result.ts';
import type {
  SaveArtifactInput,
  SubscribeExternalEventInput,
} from '../../../../src/lib/space/tools/node-agent-tool-schemas.ts';
import {
  clearBuiltInValidatorRegistry,
  registerBuiltInValidator,
} from '../../../../src/lib/space/runtime/built-in-validator-registry.ts';
import type { SpaceWorkflow, WorkflowChannel } from '@hyperneo/shared';
import type {
  DaemonInternalEventMap,
  InternalEventBus,
} from '../../../../src/lib/internal-event-bus.ts';
import { CodingArtifactProfile } from '../../../../src/lib/space/workflows/coding-artifact-profile.ts';
import type { WorkflowArtifactProfile } from '../../../../src/lib/space/runtime/artifact-profile.ts';

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

function seedSpaceWorkflowRunRow(
  db: BunDatabase,
  runId: string,
  spaceId: string,
  workflowId: string
): void {
  const now = Date.now();
  db.prepare(
    `INSERT INTO space_workflow_runs
     (id, space_id, workflow_id, title, status, created_at, updated_at)
     VALUES (?, ?, ?, '', 'pending', ?, ?)`
  ).run(runId, spaceId, workflowId, now, now);
}

function makeFreshRunId(db: BunDatabase, spaceId: string): string {
  const runId = `run-${Math.random().toString(36).slice(2)}`;
  seedSpaceWorkflowRunRow(db, runId, spaceId, 'wf-seed');
  return runId;
}

function toNodeExecutionStatus(
  status: string
): 'pending' | 'in_progress' | 'idle' | 'blocked' | 'cancelled' {
  switch (status) {
    case 'pending':
    case 'open':
      return 'pending';
    case 'in_progress':
      return 'in_progress';
    case 'idle':
    case 'done':
    case 'completed':
      return 'idle';
    case 'blocked':
    case 'failed':
      return 'blocked';
    case 'cancelled':
      return 'cancelled';
    default:
      return 'in_progress';
  }
}

function seedSpaceTask(
  db: BunDatabase,
  spaceId: string,
  workflowRunId: string,
  workflowNodeId: string,
  agentName: string,
  status: string = 'in_progress',
  result: string | null = null,
  sessionId: string | null = null
): string {
  const id = `task-${Math.random().toString(36).slice(2)}`;
  const now = Date.now();
  db.exec('PRAGMA foreign_keys = OFF');
  db.prepare(
    `INSERT INTO space_tasks
         (id, space_id, task_number, title, description, status, priority, result,
          workflow_run_id, depends_on, created_at, updated_at)
         VALUES (?, ?, (SELECT COALESCE(MAX(task_number), 0) + 1 FROM space_tasks WHERE space_id = ?), ?, '', ?, 'normal', ?, ?, '[]', ?, ?)`
  ).run(id, spaceId, spaceId, agentName, status, result, workflowRunId, now, now);
  if (sessionId) {
    db.prepare('UPDATE space_tasks SET task_agent_session_id = ? WHERE id = ?').run(sessionId, id);
  }
  db.exec('PRAGMA foreign_keys = ON');

  const nodeExecutionRepo = new NodeExecutionRepository(db);
  const execution = nodeExecutionRepo.createOrIgnore({
    workflowRunId,
    workflowNodeId,
    agentName,
    agentSessionId: sessionId,
    status: toNodeExecutionStatus(status),
  });
  nodeExecutionRepo.update(execution.id, {
    agentSessionId: sessionId,
    status: toNodeExecutionStatus(status),
    result,
  });

  return id;
}

function makeResolvedChannel(
  from: string,
  to: string,
  _isHubSpoke = false,
  _overrides: Record<string, unknown> = {}
): WorkflowChannel {
  return {
    id: `ch-${from}-${to}`,
    from,
    to,
  };
}

interface TestCtx {
  db: BunDatabase;
  spaceId: string;
  taskRepo: SpaceTaskRepository;
  taskManager: SpaceTaskManager;
  spaceTaskRepo: SpaceTaskRepository;
  nodeExecutionRepo: NodeExecutionRepository;
  artifactRepo: WorkflowRunArtifactRepository;
  artifactProfile: WorkflowArtifactProfile;
  workflowRunId: string;
  nodeId: string;
  coderSessionId: string;
  reviewerSessionId: string;
  taskAgentSessionId: string;
  parentTaskId: string;
  stepTaskId: string;
}

function makeCtx(): TestCtx {
  const db = makeDb();
  const spaceId = 'space-node-tools-test';

  seedSpaceRow(db, spaceId);

  const taskRepo = new SpaceTaskRepository(db);
  const spaceTaskRepo = taskRepo;
  const taskManager = new SpaceTaskManager(db, spaceId);
  const nodeExecutionRepo = new NodeExecutionRepository(db);
  const artifactRepo = new WorkflowRunArtifactRepository(db);
  const artifactProfile = new CodingArtifactProfile({ db, artifactRepo });

  const taskAgentSessionId = 'session-task-agent';
  const coderSessionId = 'session-coder';
  const reviewerSessionId = 'session-reviewer';

  const workflowRunId = 'run-node-tools-default';
  const nodeId = 'node-node-tools-default';

  seedSpaceWorkflowRunRow(db, workflowRunId, spaceId, 'wf-seed');

  seedSpaceTask(db, spaceId, workflowRunId, nodeId, 'coder', 'in_progress', null, coderSessionId);
  seedSpaceTask(
    db,
    spaceId,
    workflowRunId,
    nodeId,
    'reviewer',
    'in_progress',
    null,
    reviewerSessionId
  );

  const parentTask = taskRepo.createTask({
    spaceId,
    title: 'Parent Task',
    description: '',
    status: 'in_progress',
  });
  const stepTask = taskRepo.createTask({
    spaceId,
    title: 'Step Task',
    description: '',
    status: 'in_progress',
  });

  return {
    db,
    spaceId,
    taskRepo,
    taskManager,
    spaceTaskRepo,
    nodeExecutionRepo,
    artifactRepo,
    artifactProfile,
    workflowRunId,
    nodeId,
    coderSessionId,
    reviewerSessionId,
    taskAgentSessionId,
    parentTaskId: parentTask.id,
    stepTaskId: stepTask.id,
  };
}

type NodeConfigOverrides = Partial<NodeAgentToolsConfig> & {
  messageInjector?: (sessionId: string, message: string) => Promise<void>;
};

function makeConfig(ctx: TestCtx, overrides: NodeConfigOverrides = {}): NodeAgentToolsConfig {
  const { messageInjector, ...configOverrides } = overrides;
  const workflowRunId = configOverrides.workflowRunId ?? ctx.workflowRunId;
  const nodeExecutionRepo = configOverrides.nodeExecutionRepo ?? ctx.nodeExecutionRepo;
  const channelResolver = configOverrides.channelResolver ?? new ChannelResolver([]);
  const injector = messageInjector ?? (async () => {});
  const agentMessageRouter =
    configOverrides.agentMessageRouter ??
    new AgentMessageRouter({
      nodeExecutionRepo,
      workflowRunId,
      workflowChannels: channelResolver.getChannels(),
      messageInjector: injector,
    });

  return {
    mySessionId: ctx.coderSessionId,
    myAgentName: 'coder',
    taskId: ctx.parentTaskId,
    spaceId: ctx.spaceId,
    channelResolver,
    workflowRunId,
    workflowNodeId: ctx.nodeId,
    nodeExecutionRepo,
    agentMessageRouter,
    workflow: null,
    artifactRepo: ctx.artifactRepo,
    artifactProfile: ctx.artifactProfile,
    ...configOverrides,
  };
}

function makeResolver(channels: WorkflowChannel[]): ChannelResolver {
  return new ChannelResolver(channels);
}

describe('node-agent-tools: list_peers', () => {
  let ctx: TestCtx;

  beforeEach(() => {
    ctx = makeCtx();
  });

  afterEach(() => {
    ctx.db.close();
  });

  test('returns peers excluding self and task-agent', async () => {
    const config = makeConfig(ctx);
    const handlers = createNodeAgentToolHandlers(config);
    const result = await handlers.list_peers({});
    const data = JSON.parse(result.content[0].text);

    expect(data.success).toBe(true);
    expect(data.peers).toHaveLength(1);
    expect(data.peers[0].agentName).toBe('reviewer');
    expect(data.peers[0].sessionId).toBe(ctx.reviewerSessionId);
    expect(data.myAgentName).toBe('coder');
  });

  test('reports no channel topology when none declared', async () => {
    const config = makeConfig(ctx);
    const handlers = createNodeAgentToolHandlers(config);
    const result = await handlers.list_peers({});
    const data = JSON.parse(result.content[0].text);

    expect(data.channelTopologyDeclared).toBe(false);
    expect(data.permittedTargets).toEqual(['space-agent']);
    expect(data.message).toContain('Use "space-agent"');
  });

  test('reports permitted targets when channels declared', async () => {
    const config = makeConfig(ctx, {
      channelResolver: makeResolver([makeResolvedChannel('coder', 'reviewer')]),
    });
    const handlers = createNodeAgentToolHandlers(config);
    const result = await handlers.list_peers({});
    const data = JSON.parse(result.content[0].text);

    expect(data.channelTopologyDeclared).toBe(true);
    expect(data.permittedTargets).toEqual(['reviewer', 'space-agent']);
  });

  test('returns empty peer list when no peers in the run', async () => {
    const isolatedRunId = makeFreshRunId(ctx.db, ctx.spaceId);
    seedSpaceTask(
      ctx.db,
      ctx.spaceId,
      isolatedRunId,
      ctx.nodeId,
      'coder',
      'in_progress',
      null,
      ctx.coderSessionId
    );

    const config = makeConfig(ctx, { workflowRunId: isolatedRunId });
    const handlers = createNodeAgentToolHandlers(config);
    const result = await handlers.list_peers({});
    const data = JSON.parse(result.content[0].text);

    expect(data.success).toBe(true);
    expect(data.peers).toHaveLength(0);
  });

  test('excludes open task with no session from peers list', async () => {
    const isolatedRunId = makeFreshRunId(ctx.db, ctx.spaceId);
    seedSpaceTask(ctx.db, ctx.spaceId, isolatedRunId, ctx.nodeId, 'tester', 'open', null);

    const config = makeConfig(ctx, { workflowRunId: isolatedRunId });
    const handlers = createNodeAgentToolHandlers(config);
    const result = await handlers.list_peers({});
    const data = JSON.parse(result.content[0].text);

    expect(data.success).toBe(true);
    expect(data.peers).toHaveLength(0);
  });

  test('excludes failed task with no session from peers list', async () => {
    const isolatedRunId = makeFreshRunId(ctx.db, ctx.spaceId);
    seedSpaceTask(
      ctx.db,
      ctx.spaceId,
      isolatedRunId,
      ctx.nodeId,
      'tester',
      'blocked',
      'Failed before session'
    );

    const config = makeConfig(ctx, { workflowRunId: isolatedRunId });
    const handlers = createNodeAgentToolHandlers(config);
    const result = await handlers.list_peers({});
    const data = JSON.parse(result.content[0].text);

    expect(data.success).toBe(true);
    expect(data.peers).toHaveLength(0);
  });

  test('includes idle task with no session in peers list', async () => {
    const isolatedRunId = makeFreshRunId(ctx.db, ctx.spaceId);
    seedSpaceTask(ctx.db, ctx.spaceId, isolatedRunId, ctx.nodeId, 'tester', 'done', 'Done');

    const config = makeConfig(ctx, { workflowRunId: isolatedRunId });
    const handlers = createNodeAgentToolHandlers(config);
    const result = await handlers.list_peers({});
    const data = JSON.parse(result.content[0].text);

    expect(data.success).toBe(true);
    expect(data.peers).toHaveLength(1);
    expect(data.peers[0].agentName).toBe('tester');
    expect(data.peers[0].sessionId).toBeNull();
    expect(data.peers[0].status).toBe('completed');
    expect(data.peers[0].completionState.completionSummary).toBe('Done');
  });
});

describe('node-agent-tools: send_message', () => {
  let ctx: TestCtx;

  beforeEach(() => {
    ctx = makeCtx();
  });

  afterEach(() => {
    ctx.db.close();
  });

  test('point-to-point succeeds when channel declared', async () => {
    const injected: Array<{ sessionId: string; message: string }> = [];
    const config = makeConfig(ctx, {
      channelResolver: makeResolver([makeResolvedChannel('coder', 'reviewer')]),
      messageInjector: async (sid, msg) => {
        injected.push({ sessionId: sid, message: msg });
      },
    });
    const handlers = createNodeAgentToolHandlers(config);
    const result = await handlers.send_message({ target: 'reviewer', message: 'LGTM!' });
    const data = JSON.parse(result.content[0].text);

    expect(data.success).toBe(true);
    expect(data.delivered).toHaveLength(1);
    expect(data.delivered[0].sessionId).toBe(ctx.reviewerSessionId);
    expect(data.delivered[0].agentName).toBe('reviewer');
    expect(injected).toHaveLength(1);
    expect(injected[0].message).toBe('─── Message from coder ───\n\nLGTM!');
  });

  test('point-to-point fails when channel not declared', async () => {
    const config = makeConfig(ctx, {
      channelResolver: makeResolver([makeResolvedChannel('reviewer', 'coder')]),
    });
    const handlers = createNodeAgentToolHandlers(config);
    const result = await handlers.send_message({ target: 'reviewer', message: 'hello' });
    const data = JSON.parse(result.content[0].text);

    expect(data.success).toBe(false);
    expect(data.error).toContain("does not permit 'coder' to send to: reviewer");
    expect(data.unauthorizedAgentNames).toContain('reviewer');
  });

  test('returns error when no channels declared at all (empty topology blocks send_message)', async () => {
    const config = makeConfig(ctx);
    const handlers = createNodeAgentToolHandlers(config);
    const result = await handlers.send_message({ target: 'reviewer', message: 'test' });
    const data = JSON.parse(result.content[0].text);

    expect(data.success).toBe(false);
    expect(data.error).toContain('No channel topology declared');
  });

  test('delivers space-agent target through send_message tool handler', async () => {
    const spaceMessages: Array<{ spaceId: string; message: string }> = [];
    const agentMessageRouter = new AgentMessageRouter({
      nodeExecutionRepo: ctx.nodeExecutionRepo,
      workflowRunId: ctx.workflowRunId,
      workflowChannels: [],
      messageInjector: async () => {},
      spaceId: ctx.spaceId,
      taskId: ctx.parentTaskId,
      taskNumber: 42,
      spaceAgentInjector: async (spaceId, message) => {
        spaceMessages.push({ spaceId, message });
      },
    });
    const config = makeConfig(ctx, { agentMessageRouter });
    const handlers = createNodeAgentToolHandlers(config);

    const result = await handlers.send_message({
      target: 'space-agent',
      message: 'Need space-level judgment',
    });
    const data = JSON.parse(result.content[0].text);

    expect(data.success).toBe(true);
    expect(data.delivered).toEqual([
      { agentName: 'space-agent', sessionId: `space:chat:${ctx.spaceId}` },
    ]);
    expect(spaceMessages).toEqual([
      {
        spaceId: ctx.spaceId,
        message:
          '─── Message from coder (task #42) ───\n\n' +
          'Need space-level judgment\n\n' +
          '─── Reply ───\n' +
          `To reply, use: send_message_to_task with task_id="${ctx.parentTaskId}" and target node "coder"`,
      },
    ]);
  });

  test('broadcast (*) succeeds and delivers to all permitted targets', async () => {
    const injected: string[] = [];
    const config = makeConfig(ctx, {
      channelResolver: makeResolver([makeResolvedChannel('coder', 'reviewer')]),
      messageInjector: async (sid) => {
        injected.push(sid);
      },
    });
    const handlers = createNodeAgentToolHandlers(config);
    const result = await handlers.send_message({ target: '*', message: 'broadcast!' });
    const data = JSON.parse(result.content[0].text);

    expect(data.success).toBe(true);
    expect(data.delivered).toHaveLength(1);
    expect(injected).toContain(ctx.reviewerSessionId);
  });

  test('broadcast (*) fails when no channels declared', async () => {
    const config = makeConfig(ctx, {
      channelResolver: makeResolver([makeResolvedChannel('reviewer', 'coder')]),
    });
    const handlers = createNodeAgentToolHandlers(config);
    const result = await handlers.send_message({ target: '*', message: 'broadcast' });
    const data = JSON.parse(result.content[0].text);

    expect(data.success).toBe(false);
    expect(data.error).toContain("No permitted targets for agent 'coder'");
  });

  test('broadcast (*) with empty topology returns error', async () => {
    const config = makeConfig(ctx);
    const handlers = createNodeAgentToolHandlers(config);
    const result = await handlers.send_message({ target: '*', message: 'broadcast' });
    const data = JSON.parse(result.content[0].text);

    expect(data.success).toBe(false);
    expect(data.error).toContain('No channel topology declared');
  });

  test('multicast delivers to all specified target roles', async () => {
    seedSpaceTask(
      ctx.db,
      ctx.spaceId,
      ctx.workflowRunId,
      ctx.nodeId,
      'security',
      'in_progress',
      null,
      'session-security'
    );

    const injected: string[] = [];
    const config = makeConfig(ctx, {
      channelResolver: makeResolver([
        makeResolvedChannel('coder', 'reviewer'),
        makeResolvedChannel('coder', 'security'),
      ]),
      messageInjector: async (sid) => {
        injected.push(sid);
      },
    });
    const handlers = createNodeAgentToolHandlers(config);
    const result = await handlers.send_message({
      target: ['reviewer', 'security'],
      message: 'multicast!',
    });
    const data = JSON.parse(result.content[0].text);

    expect(data.success).toBe(true);
    expect(data.delivered).toHaveLength(2);
    expect(injected).toContain(ctx.reviewerSessionId);
    expect(injected).toContain('session-security');
  });

  test('multicast partial authorization fails with full error', async () => {
    seedSpaceTask(
      ctx.db,
      ctx.spaceId,
      ctx.workflowRunId,
      ctx.nodeId,
      'security',
      'in_progress',
      null,
      'session-security'
    );
    const config = makeConfig(ctx, {
      channelResolver: makeResolver([makeResolvedChannel('coder', 'reviewer')]),
    });
    const handlers = createNodeAgentToolHandlers(config);
    const result = await handlers.send_message({
      target: ['reviewer', 'security'],
      message: 'msg',
    });
    const data = JSON.parse(result.content[0].text);

    expect(data.success).toBe(false);
    expect(data.unauthorizedAgentNames).toContain('security');
  });

  test('hub-spoke: spoke cannot send to other spokes', async () => {
    const config = makeConfig(ctx, {
      channelResolver: makeResolver([
        makeResolvedChannel('hub', 'coder', true),
        makeResolvedChannel('coder', 'hub', true),
        makeResolvedChannel('hub', 'reviewer', true),
        makeResolvedChannel('reviewer', 'hub', true),
      ]),
    });
    const handlers = createNodeAgentToolHandlers(config);
    const result = await handlers.send_message({ target: 'reviewer', message: 'hello' });
    const data = JSON.parse(result.content[0].text);

    expect(data.success).toBe(false);
    expect(data.error).toContain("does not permit 'coder' to send to: reviewer");
  });

  test('hub-spoke: spoke can reply to hub', async () => {
    seedSpaceTask(
      ctx.db,
      ctx.spaceId,
      ctx.workflowRunId,
      ctx.nodeId,
      'hub',
      'in_progress',
      null,
      'session-hub'
    );
    const injected: string[] = [];
    const config = makeConfig(ctx, {
      channelResolver: makeResolver([
        makeResolvedChannel('hub', 'coder', true),
        makeResolvedChannel('coder', 'hub', true),
      ]),
      messageInjector: async (sid) => {
        injected.push(sid);
      },
    });
    const handlers = createNodeAgentToolHandlers(config);
    const result = await handlers.send_message({ target: 'hub', message: 'done!' });
    const data = JSON.parse(result.content[0].text);

    expect(data.success).toBe(true);
    expect(injected).toContain('session-hub');
  });

  test('bidirectional: both directions work', async () => {
    const biResolver = makeResolver([
      makeResolvedChannel('coder', 'reviewer'),
      makeResolvedChannel('reviewer', 'coder'),
    ]);
    const injectedToReviewer: string[] = [];
    const config = makeConfig(ctx, {
      channelResolver: biResolver,
      messageInjector: async (sid) => {
        injectedToReviewer.push(sid);
      },
    });
    const handlers = createNodeAgentToolHandlers(config);

    const r1 = await handlers.send_message({ target: 'reviewer', message: 'code ready' });
    expect(JSON.parse(r1.content[0].text).success).toBe(true);

    const configAsReviewer = makeConfig(ctx, {
      channelResolver: biResolver,
      mySessionId: ctx.reviewerSessionId,
      myAgentName: 'reviewer',
      messageInjector: async (sid) => {
        injectedToReviewer.push(sid);
      },
    });
    const handlersAsReviewer = createNodeAgentToolHandlers(configAsReviewer);
    const r2 = await handlersAsReviewer.send_message({ target: 'coder', message: 'approved' });
    expect(JSON.parse(r2.content[0].text).success).toBe(true);
  });

  test('returns no-active-sessions when topology declares target but no session exists yet', async () => {
    const config = makeConfig(ctx, {
      channelResolver: makeResolver([makeResolvedChannel('coder', 'tester')]),
    });
    const handlers = createNodeAgentToolHandlers(config);
    const result = await handlers.send_message({ target: 'tester', message: 'test pls' });
    const data = JSON.parse(result.content[0].text);

    expect(data.success).toBe(false);
    expect(data.error).toContain('Could not deliver message to target agent(s): tester');
    expect(data.error).toContain('no live session received the message');
  });

  test('returns unknown-target when role is not in topology or any execution', async () => {
    const config = makeConfig(ctx, {
      channelResolver: makeResolver([makeResolvedChannel('coder', 'reviewer')]),
    });
    const handlers = createNodeAgentToolHandlers(config);
    const result = await handlers.send_message({
      target: 'totally-unknown',
      message: 'test pls',
    });
    const data = JSON.parse(result.content[0].text);

    expect(data.success).toBe(false);
    expect(data.error).toContain("Unknown target 'totally-unknown'");
  });

  test('handles partial injection failures gracefully (partial success)', async () => {
    seedSpaceTask(
      ctx.db,
      ctx.spaceId,
      ctx.workflowRunId,
      ctx.nodeId,
      'security',
      'in_progress',
      null,
      'session-security'
    );
    let callCount = 0;
    const config = makeConfig(ctx, {
      channelResolver: makeResolver([
        makeResolvedChannel('coder', 'reviewer'),
        makeResolvedChannel('coder', 'security'),
      ]),
      messageInjector: async (_sid) => {
        callCount++;
        if (callCount === 1) throw new Error('injection failed');
      },
    });
    const handlers = createNodeAgentToolHandlers(config);
    const result = await handlers.send_message({
      target: ['reviewer', 'security'],
      message: 'hello',
    });
    const data = JSON.parse(result.content[0].text);

    expect(data.success).toBe('partial');
    expect(data.delivered).toHaveLength(1);
    expect(data.failed).toHaveLength(1);
    expect(callCount).toBe(2);
  });

  test('fails entirely when all injections fail', async () => {
    const config = makeConfig(ctx, {
      channelResolver: makeResolver([makeResolvedChannel('coder', 'reviewer')]),
      messageInjector: async () => {
        throw new Error('always fails');
      },
    });
    const handlers = createNodeAgentToolHandlers(config);
    const result = await handlers.send_message({ target: 'reviewer', message: 'test' });
    const data = JSON.parse(result.content[0].text);

    expect(data.success).toBe(false);
    expect(data.failed).toHaveLength(1);
    expect(data.delivered).toBeUndefined();
  });

  test('best-effort multicast: first delivery succeeds, second fails — partial success', async () => {
    seedSpaceTask(
      ctx.db,
      ctx.spaceId,
      ctx.workflowRunId,
      ctx.nodeId,
      'security',
      'in_progress',
      null,
      'session-security'
    );

    let callCount = 0;
    const config = makeConfig(ctx, {
      channelResolver: makeResolver([
        makeResolvedChannel('coder', 'reviewer'),
        makeResolvedChannel('coder', 'security'),
      ]),
      messageInjector: async (_sid, _msg) => {
        callCount++;
        if (callCount === 2) throw new Error('session not available');
      },
    });
    const handlers = createNodeAgentToolHandlers(config);

    const result = await handlers.send_message({
      target: ['reviewer', 'security'],
      message: 'Hello',
    });
    const data = JSON.parse(result.content[0].text);

    expect(data.success).toBe('partial');
    expect(data.delivered).toHaveLength(1);
    expect(data.failed).toHaveLength(1);
    expect(data.failed[0].error).toContain('session not available');
    expect(callCount).toBe(2);
  });

  test('best-effort multicast: all deliveries fail — success: false', async () => {
    const config = makeConfig(ctx, {
      channelResolver: makeResolver([makeResolvedChannel('coder', 'reviewer')]),
      messageInjector: async () => {
        throw new Error('all sessions unavailable');
      },
    });
    const handlers = createNodeAgentToolHandlers(config);

    const result = await handlers.send_message({ target: 'reviewer', message: 'Hello' });
    const data = JSON.parse(result.content[0].text);

    expect(data.success).toBe(false);
    expect(data.delivered).toBeUndefined();
    expect(data.failed).toHaveLength(1);
  });
});

describe('node-agent-tools: save_artifact', () => {
  let ctx: TestCtx;

  beforeEach(() => {
    ctx = makeCtx();
  });

  afterEach(() => {
    ctx.db.close();
  });

  test('save_artifact({ shape, data }) writes a shape to the artifact store', async () => {
    const handlers = createNodeAgentToolHandlers(makeConfig(ctx));
    const result = await handlers.save_artifact({
      shape: 'note',
      data: { text: 'PR #42 merged.' },
    });
    const data = JSON.parse(result.content[0].text);

    expect(data.success).toBe(true);
    expect(data.artifact.shape).toBe('note');
    expect(data.artifact.nodeId).toBe(ctx.nodeId);
    expect(data.artifact.runId).toBe(ctx.workflowRunId);

    const artifacts = ctx.artifactRepo.listByRun(ctx.workflowRunId, { artifactType: 'note' });
    expect(artifacts).toHaveLength(1);
    expect(artifacts[0].data.text).toBe('PR #42 merged.');
    expect(artifacts[0].nodeId).toBe(ctx.nodeId);
  });

  test('save_artifact({ shape: "link", kind, data }) persists a structured link', async () => {
    const handlers = createNodeAgentToolHandlers(makeConfig(ctx));
    const result = await handlers.save_artifact({
      shape: 'link',
      kind: 'pr',
      data: { url: 'https://github.com/acme/app/pull/42', title: 'Add thing' },
    });
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.success).toBe(true);

    const artifacts = ctx.artifactRepo.listByRun(ctx.workflowRunId, { artifactType: 'link' });
    expect(artifacts).toHaveLength(1);
    expect(artifacts[0].data.url).toBe('https://github.com/acme/app/pull/42');
    expect(artifacts[0].data.kind).toBe('pr');
    expect(artifacts[0].data.title).toBe('Add thing');
  });

  test('save_artifact({ shape, summary, data }) persists both fields', async () => {
    const handlers = createNodeAgentToolHandlers(makeConfig(ctx));
    const result = await handlers.save_artifact({
      shape: 'decision',
      summary: 'work done',
      data: { recommendation: 'approve', counts: { p0: 0 } },
    });
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.success).toBe(true);

    const artifacts = ctx.artifactRepo.listByRun(ctx.workflowRunId, {
      artifactType: 'decision',
    });
    expect(artifacts).toHaveLength(1);
    expect(artifacts[0].data.summary).toBe('work done');
    expect(artifacts[0].data.recommendation).toBe('approve');
    expect(artifacts[0].data.counts).toEqual({ p0: 0 });
  });

  test('note shape upserts in place (single rolling status, no per-round growth)', async () => {
    const handlers = createNodeAgentToolHandlers(makeConfig(ctx));
    const r1 = JSON.parse(
      (await handlers.save_artifact({ shape: 'note', data: { text: 'first' } })).content[0].text
    );
    expect(r1.success).toBe(true);

    const r2 = JSON.parse(
      (await handlers.save_artifact({ shape: 'note', data: { text: 'second' } })).content[0].text
    );
    expect(r2.success).toBe(true);
    expect(r2.artifact.id).toBe(r1.artifact.id);

    const artifacts = ctx.artifactRepo.listByRun(ctx.workflowRunId, { artifactType: 'note' });
    expect(artifacts).toHaveLength(1);
    expect(artifacts[0].data.text).toBe('second');
  });

  test('link identity is keyed by kind (one per kind, distinct rows)', async () => {
    const handlers = createNodeAgentToolHandlers(makeConfig(ctx));
    await handlers.save_artifact({
      shape: 'link',
      kind: 'pr',
      data: { url: 'https://example.com/pr/1' },
    });
    await handlers.save_artifact({
      shape: 'link',
      kind: 'issue',
      data: { url: 'https://example.com/issue/2' },
    });
    await handlers.save_artifact({
      shape: 'link',
      kind: 'pr',
      data: { url: 'https://example.com/pr/1-updated' },
    });

    const links = ctx.artifactRepo.listByRun(ctx.workflowRunId, { artifactType: 'link' });
    expect(links).toHaveLength(2);
    const pr = links.find((a) => a.data.kind === 'pr');
    expect(pr?.data.url).toBe('https://example.com/pr/1-updated');
  });

  test('decision multi-round history via explicit key', async () => {
    const handlers = createNodeAgentToolHandlers(makeConfig(ctx));
    const r1 = JSON.parse(
      (
        await handlers.save_artifact({
          shape: 'decision',
          kind: 'review',
          key: 'round-0',
          data: { recommendation: 'request_changes' },
        })
      ).content[0].text
    );
    const r2 = JSON.parse(
      (
        await handlers.save_artifact({
          shape: 'decision',
          kind: 'review',
          key: 'round-1',
          data: { recommendation: 'approve' },
        })
      ).content[0].text
    );
    expect(r1.success).toBe(true);
    expect(r2.success).toBe(true);
    expect(r2.artifact.id).not.toBe(r1.artifact.id);

    const decisions = ctx.artifactRepo.listByRun(ctx.workflowRunId, {
      artifactType: 'decision',
    });
    expect(decisions).toHaveLength(2);
  });

  test('rejects an unknown shape', async () => {
    const handlers = createNodeAgentToolHandlers(makeConfig(ctx));
    const result = await handlers.save_artifact({
      // @ts-expect-error — intentionally invalid shape
      shape: 'banana',
      data: { url: 'x' },
    });
    const data = JSON.parse(result.content[0].text);
    expect(data.success).toBe(false);
    expect(data.error).toContain('shape');
  });

  test('rejects a payload missing a required shape field', async () => {
    const handlers = createNodeAgentToolHandlers(makeConfig(ctx));
    const result = await handlers.save_artifact({ shape: 'link', data: { title: 'no url' } });
    const data = JSON.parse(result.content[0].text);
    expect(data.success).toBe(false);
    expect(data.error).toContain('url');
  });

  test('returns error when artifactRepo is absent', async () => {
    const handlers = createNodeAgentToolHandlers(makeConfig(ctx, { artifactRepo: undefined }));
    const result = await handlers.save_artifact({ shape: 'note', data: { text: 'done' } });
    const data = JSON.parse(result.content[0].text);
    expect(data.success).toBe(false);
  });

  test('returns error when neither summary nor data provided', async () => {
    const handlers = createNodeAgentToolHandlers(makeConfig(ctx));
    const result = await handlers.save_artifact({ shape: 'note' });
    const data = JSON.parse(result.content[0].text);

    expect(data.success).toBe(false);
    expect(data.error).toContain('summary');
  });

  test('rejects when shape is missing — the legacy `type` alias is no longer accepted', async () => {
    const handlers = createNodeAgentToolHandlers(makeConfig(ctx));
    const result = await handlers.save_artifact({
      // @ts-expect-error — legacy `type` is no longer part of the schema
      type: 'progress',
      summary: 'halfway done',
    });
    const data = JSON.parse(result.content[0].text);
    expect(data.success).toBe(false);
    expect(data.error).toContain('shape');
  });

  test('every migrated prompt payload is accepted and persists', async () => {
    const handlers = createNodeAgentToolHandlers(makeConfig(ctx));
    const run = async (payload: Parameters<typeof handlers.save_artifact>[0]) => {
      const parsed = JSON.parse((await handlers.save_artifact(payload)).content[0].text);
      expect(parsed.success).toBe(true);
      return parsed;
    };

    await run({
      shape: 'decision',
      summary: 'Created 2 tasks from plan: foo, bar',
      data: {
        recommendation: 'dispatched',
        created_task_ids: ['t1', 't2'],
        stack_prefix: 'plan-x',
        stack_branches: ['plan/x/foo', 'plan/x/bar'],
      },
    });

    await run({ shape: 'link', kind: 'pr', data: { url: 'https://github.com/o/r/pull/9' } });
    await run({
      shape: 'decision',
      summary: 'QA passed',
      data: {
        recommendation: 'pass',
        test_output: 'ok',
        ui_changed: true,
        dev_server_started: true,
        browser_validation: 'exercised login flow',
      },
    });

    await run({
      shape: 'decision',
      key: 'outcome',
      summary: 'Done',
      data: { recommendation: 'completed' },
    });

    await run({
      shape: 'note',
      kind: 'merge_conflict',
      key: 'attempt-0',
      summary: 'Merge conflict attempt 0 on PR https://github.com/o/r/pull/9',
      data: {
        pr_url: 'https://github.com/o/r/pull/9',
        base_branch: 'dev',
        approved_head_oid: 'abc',
        conflicting_files: ['a.ts'],
        attempt: 0,
      },
    });
    await run({
      shape: 'note',
      kind: 'merge_conflict',
      key: 'attempt-1',
      summary: 'Merge conflict attempt 1 on PR https://github.com/o/r/pull/9',
      data: { pr_url: 'https://github.com/o/r/pull/9', attempt: 1 },
    });

    await run({
      shape: 'link',
      kind: 'merge',
      data: {
        url: 'https://github.com/o/r/pull/9',
        merged_at: '2026-01-01',
        approval_source: 'human',
      },
    });

    await run({
      shape: 'note',
      kind: 'qa',
      key: 'cycle-1',
      summary: 'QA failed (cycle 1): login redirect broken',
    });
    await run({
      shape: 'note',
      kind: 'qa',
      key: 'cycle-2',
      summary: 'QA failed (cycle 2): flaky test on retry',
    });

    const notes = ctx.artifactRepo.listByRun(ctx.workflowRunId, { artifactType: 'note' });
    expect(notes.map((n) => n.artifactKey).sort()).toEqual([
      'merge_conflict:attempt-0',
      'merge_conflict:attempt-1',
      'qa:cycle-1',
      'qa:cycle-2',
    ]);
  });
});

describe('node-agent-tools: list_artifacts', () => {
  let ctx: TestCtx;

  beforeEach(() => {
    ctx = makeCtx();
  });

  afterEach(() => {
    ctx.db.close();
  });

  async function seedMixed() {
    const writer = createNodeAgentToolHandlers(makeConfig(ctx));
    const writes: SaveArtifactInput[] = [
      { shape: 'link', kind: 'pr', data: { url: 'https://example.com/pr/1' } },
      { shape: 'link', kind: 'issue', data: { url: 'https://example.com/issues/2' } },
      { shape: 'link', kind: 'preview', data: { url: 'https://example.com/preview/3' } },
      { shape: 'decision', kind: 'review', data: { recommendation: 'approve' } },
      { shape: 'decision', kind: 'gate', data: { recommendation: 'approved' } },
      { shape: 'note', data: { text: 'rolling status' } },
    ];
    for (const w of writes) {
      const r = await writer.save_artifact(w);
      expect(JSON.parse(r.content[0].text).success).toBe(true);
    }
    return createNodeAgentToolHandlers(makeConfig(ctx));
  }

  function artifactsOf(result: { content: Array<{ text: string }> }) {
    return JSON.parse(result.content[0].text).artifacts as Array<{
      type: string;
      data: Record<string, unknown>;
    }>;
  }

  test('direct shape name { type: "link" } returns all links (no kind filter)', async () => {
    const handlers = await seedMixed();
    const artifacts = artifactsOf(await handlers.list_artifacts({ type: 'link' }));
    expect(artifacts).toHaveLength(3);
    expect(artifacts.map((a) => a.data.kind).sort()).toEqual(['issue', 'pr', 'preview']);
  });

  test('no type returns every artifact', async () => {
    const handlers = await seedMixed();
    const artifacts = artifactsOf(await handlers.list_artifacts({}));
    expect(artifacts).toHaveLength(6);
  });
});

describe('node-agent-tools: list_channels', () => {
  let ctx: TestCtx;

  beforeEach(() => {
    ctx = makeCtx();
  });

  afterEach(() => {
    ctx.db.close();
  });

  test('returns empty channels when workflow is null', async () => {
    const config = makeConfig(ctx, { workflow: null });
    const handlers = createNodeAgentToolHandlers(config);
    const result = await handlers.list_channels({});
    const data = JSON.parse(result.content[0].text);

    expect(data.success).toBe(true);
    expect(data.channels).toHaveLength(0);
    expect(data.total).toBe(0);
  });

  test('returns empty channels when workflow has no channels', async () => {
    const workflow: SpaceWorkflow = {
      id: 'wf-1',
      spaceId: ctx.spaceId,
      name: 'Test Workflow',
      description: '',
      nodes: [],
      startNodeId: '',
      rules: [],
      tags: [],
      channels: [],
    };
    const config = makeConfig(ctx, { workflow });
    const handlers = createNodeAgentToolHandlers(config);
    const result = await handlers.list_channels({});
    const data = JSON.parse(result.content[0].text);

    expect(data.success).toBe(true);
    expect(data.channels).toHaveLength(0);
  });
});

describe('node-agent-tools: list_reachable_agents', () => {
  let ctx: TestCtx;

  beforeEach(() => {
    ctx = makeCtx();
  });

  afterEach(() => {
    ctx.db.close();
  });

  test('returns within-node peers excluding self and task-agent', async () => {
    const config = makeConfig(ctx);
    const handlers = createNodeAgentToolHandlers(config);
    const result = await handlers.list_reachable_agents({});
    const data = JSON.parse(result.content[0].text);

    expect(data.success).toBe(true);
    expect(data.myAgentName).toBe('coder');
    expect(data.withinNodePeers).toHaveLength(1);
    expect(data.withinNodePeers[0].agentName).toBe('reviewer');
    expect(data.withinNodePeers[0].status).toBe('active');
  });

  test('returns empty cross-node targets when no channels declared', async () => {
    const config = makeConfig(ctx);
    const handlers = createNodeAgentToolHandlers(config);
    const result = await handlers.list_reachable_agents({});
    const data = JSON.parse(result.content[0].text);

    expect(data.success).toBe(true);
    expect(data.reachabilityDeclared).toBe(false);
    expect(data.crossNodeTargets).toHaveLength(0);
    expect(data.spaceAgent).toEqual({
      target: 'space-agent',
      description: 'Space-level escalation target. Use to request human/space-level judgment.',
    });
    expect(data.message).toContain('space-agent escalation target');
  });

  test('returns cross-node targets for channels to roles not in current group', async () => {
    const config = makeConfig(ctx, {
      channelResolver: makeResolver([makeResolvedChannel('coder', 'tester')]),
    });
    const handlers = createNodeAgentToolHandlers(config);
    const result = await handlers.list_reachable_agents({});
    const data = JSON.parse(result.content[0].text);

    expect(data.success).toBe(true);
    expect(data.reachabilityDeclared).toBe(true);
    expect(data.crossNodeTargets).toHaveLength(1);
    expect(data.crossNodeTargets[0].nodeName).toBe('tester');
  });

  test('within-node peer with a channel does not appear in cross-node targets', async () => {
    const config = makeConfig(ctx, {
      channelResolver: makeResolver([makeResolvedChannel('coder', 'reviewer')]),
    });
    const handlers = createNodeAgentToolHandlers(config);
    const result = await handlers.list_reachable_agents({});
    const data = JSON.parse(result.content[0].text);

    expect(data.withinNodePeers).toHaveLength(1);
    expect(data.withinNodePeers[0].agentName).toBe('reviewer');
    expect(data.crossNodeTargets).toHaveLength(0);
  });

  test('fan-out target marked as isFanOut true', async () => {
    const config = makeConfig(ctx, {
      channelResolver: makeResolver([
        makeResolvedChannel('coder', 'qa-node', false, { isFanOut: true }),
      ]),
    });
    const handlers = createNodeAgentToolHandlers(config);
    const result = await handlers.list_reachable_agents({});
    const data = JSON.parse(result.content[0].text);

    expect(data.crossNodeTargets).toHaveLength(1);
    expect(data.crossNodeTargets[0].nodeName).toBe('qa-node');
  });

  test('deduplicates cross-node targets from multiple channels to same role', async () => {
    const config = makeConfig(ctx, {
      channelResolver: makeResolver([
        makeResolvedChannel('coder', 'tester'),
        makeResolvedChannel('coder', 'tester'),
      ]),
    });
    const handlers = createNodeAgentToolHandlers(config);
    const result = await handlers.list_reachable_agents({});
    const data = JSON.parse(result.content[0].text);

    expect(data.crossNodeTargets).toHaveLength(1);
  });

  test('only includes outgoing channels (fromRole matches myAgentName)', async () => {
    const config = makeConfig(ctx, {
      channelResolver: makeResolver([makeResolvedChannel('tester', 'coder')]),
    });
    const handlers = createNodeAgentToolHandlers(config);
    const result = await handlers.list_reachable_agents({});
    const data = JSON.parse(result.content[0].text);

    expect(data.crossNodeTargets).toHaveLength(0);
  });
});

describe('node-agent-tools: external event subscriptions', () => {
  let ctx: TestCtx;

  beforeEach(() => {
    ctx = makeCtx();
  });

  afterEach(() => {
    ctx.db.close();
  });

  test('delegates subscribe_external_event and audits successful calls', async () => {
    const calls: Array<{ topicPattern: string; label?: string }> = [];
    const handlers = createNodeAgentToolHandlers(
      makeConfig(ctx, {
        onSubscribeExternalEvent: async (args) => {
          calls.push(args);
          return { content: [{ type: 'text', text: JSON.stringify({ success: true }) }] };
        },
        auditLogRepo: new McpAuditLogRepository(ctx.db),
      })
    );

    const result = await handlers.subscribe_external_event({
      topicPattern: 'github/*/*/pull_request/*.*',
      label: 'PR updates',
    });
    const data = JSON.parse(result.content[0].text);

    expect(data.success).toBe(true);
    expect(calls).toEqual([{ topicPattern: 'github/*/*/pull_request/*.*', label: 'PR updates' }]);

    const auditRepo = new McpAuditLogRepository(ctx.db);
    const entries = auditRepo
      .listBySession(ctx.coderSessionId)
      .filter((entry) => entry.toolName === 'subscribe_external_event');
    expect(entries).toHaveLength(1);
    expect(entries[0].paramsSummary).toBe(
      JSON.stringify({ topicPattern: 'github/*/*/pull_request/*.*', label: 'PR updates' })
    );
  });

  test('delegates unsubscribe_external_event', async () => {
    const calls: string[] = [];
    const handlers = createNodeAgentToolHandlers(
      makeConfig(ctx, {
        onUnsubscribeExternalEvent: async (args) => {
          calls.push(args.topicPattern);
          return { content: [{ type: 'text', text: JSON.stringify({ success: true }) }] };
        },
      })
    );

    const result = await handlers.unsubscribe_external_event({
      topicPattern: 'github/*/*/pull_request/*.*',
    });
    const data = JSON.parse(result.content[0].text);

    expect(data.success).toBe(true);
    expect(calls).toEqual(['github/*/*/pull_request/*.*']);
  });

  test('returns unavailable when subscription callbacks are not wired', async () => {
    const handlers = createNodeAgentToolHandlers(makeConfig(ctx));

    const result = await handlers.subscribe_external_event({
      topicPattern: 'github/*/*/pull_request/*.*',
    });
    const data = JSON.parse(result.content[0].text);

    expect(data.success).toBe(false);
    expect(data.error).toContain('not available');
  });

  test('createNodeAgentMcpServer registers external event tools only when callbacks are wired', () => {
    const withoutCallback = createNodeAgentMcpServer(makeConfig(ctx));
    const withoutRegistered = Object.keys(
      (withoutCallback as unknown as { instance: { _registeredTools: Record<string, unknown> } })
        .instance._registeredTools
    );
    expect(withoutRegistered).not.toContain('subscribe_external_event');
    expect(withoutRegistered).not.toContain('unsubscribe_external_event');

    const withCallback = createNodeAgentMcpServer(
      makeConfig(ctx, {
        onSubscribeExternalEvent: async () => ({
          content: [{ type: 'text', text: JSON.stringify({ success: true }) }],
        }),
        onUnsubscribeExternalEvent: async () => ({
          content: [{ type: 'text', text: JSON.stringify({ success: true }) }],
        }),
      })
    );
    const withRegistered = Object.keys(
      (withCallback as unknown as { instance: { _registeredTools: Record<string, unknown> } })
        .instance._registeredTools
    );
    expect(withRegistered).toContain('subscribe_external_event');
    expect(withRegistered).toContain('unsubscribe_external_event');
  });
});

function makeGitHubEvent(overrides: Partial<ExternalEvent> = {}): ExternalEvent {
  return {
    id: crypto.randomUUID(),
    spaceId: 'space-node-tools-test',
    source: 'github',
    topic: 'github/owner/repo/pull_request_review_comment/42.created',
    occurredAt: Date.now(),
    ingestedAt: Date.now(),
    summary: 'review comment on PR #42',
    dedupeKey: `dedupe-${Math.random().toString(36).slice(2)}`,
    externalUrl: 'https://github.com/owner/repo/pull/42#discussion_r1',
    payload: {
      eventType: 'pull_request_review_comment',
      action: 'created',
      actor: 'octocat',
      actorType: 'User',
      body: 'nit: prefer const',
      prNumber: 42,
      prUrl: 'https://github.com/owner/repo/pull/42',
      entityId: '42',
      repoOwner: 'owner',
      repoName: 'repo',
      deliveryId: 'delivery-1',
      externalId: 'ext-1',
      source: 'webhook',
      rawPayload: {
        comment: {
          id: 1,
          node_id: 'PRRC_node1',
          body: 'nit: prefer const',
          path: 'src/index.ts',
          line: 10,
          side: 'RIGHT',
          in_reply_to_id: null,
          html_url: 'https://github.com/owner/repo/pull/42#discussion_r1',
          pull_request_url: 'https://github.com/owner/repo/pull/42',
        },
      },
    },
    ...overrides,
  };
}

describe('node-agent-tools: get_external_event', () => {
  let ctx: TestCtx;

  beforeEach(() => {
    ctx = makeCtx();
  });

  afterEach(() => {
    ctx.db.close();
  });

  test('returns the full record (incl. rawPayload) for a known eventId', async () => {
    const store = new ExternalEventStore(ctx.db);
    const event = makeGitHubEvent({ spaceId: ctx.spaceId });
    store.store(event);

    const handlers = createNodeAgentToolHandlers(makeConfig(ctx, { externalEventStore: store }));
    const result = await handlers.get_external_event({ eventId: event.id });
    const data = JSON.parse(result.content[0].text);

    expect(data.success).toBe(true);
    expect(data.event.id).toBe(event.id);
    expect(data.event.topic).toBe(event.topic);
    expect(data.event.summary).toBe(event.summary);
    expect(data.event.externalUrl).toBe(event.externalUrl);
    expect(data.event.payload.body).toBe('nit: prefer const');
    expect(data.event.payload.rawPayload.comment.node_id).toBe('PRRC_node1');
    expect(data.event.payload.rawPayload.comment.path).toBe('src/index.ts');
    expect(data.event.payload.actor).toBe('octocat');
    expect(data.event.payload.eventType).toBe('pull_request_review_comment');
  });

  test('returns a not-found result for an unknown eventId', async () => {
    const store = new ExternalEventStore(ctx.db);
    const handlers = createNodeAgentToolHandlers(makeConfig(ctx, { externalEventStore: store }));
    const result = await handlers.get_external_event({ eventId: 'does-not-exist' });
    const data = JSON.parse(result.content[0].text);

    expect(data.success).toBe(false);
    expect(data.error).toContain('not found');
  });

  test('treats an event in another space as not-found (no cross-space leak)', async () => {
    const store = new ExternalEventStore(ctx.db);
    ctx.db
      .prepare(
        `INSERT INTO spaces (id, workspace_path, name, description, background_context, instructions,
         allowed_models, session_ids, slug, status, created_at, updated_at)
         VALUES (?, '/tmp/space-other', ?, '', '', '', '[]', '[]', ?, 'active', ?, ?)`
      )
      .run('space-other', 'Space other', 'space-other', Date.now(), Date.now());
    const event = makeGitHubEvent({ spaceId: 'space-other' });
    store.store(event);

    const handlers = createNodeAgentToolHandlers(makeConfig(ctx, { externalEventStore: store }));
    const result = await handlers.get_external_event({ eventId: event.id });
    const data = JSON.parse(result.content[0].text);

    expect(data.success).toBe(false);
    expect(data.error).toContain('not found');
  });

  test('returns unavailable when the store is not wired', async () => {
    const handlers = createNodeAgentToolHandlers(makeConfig(ctx));
    const result = await handlers.get_external_event({ eventId: 'any' });
    const data = JSON.parse(result.content[0].text);

    expect(data.success).toBe(false);
    expect(data.error).toContain('not available');
  });

  test('createNodeAgentMcpServer registers get_external_event only when the store is wired', () => {
    const store = new ExternalEventStore(ctx.db);

    const withoutStore = createNodeAgentMcpServer(makeConfig(ctx));
    const withoutRegistered = Object.keys(
      (withoutStore as unknown as { instance: { _registeredTools: Record<string, unknown> } })
        .instance._registeredTools
    );
    expect(withoutRegistered).not.toContain('get_external_event');

    const withStore = createNodeAgentMcpServer(makeConfig(ctx, { externalEventStore: store }));
    const withRegistered = Object.keys(
      (withStore as unknown as { instance: { _registeredTools: Record<string, unknown> } }).instance
        ._registeredTools
    );
    expect(withRegistered).toContain('get_external_event');
  });
});

function seedDelivery(
  store: ExternalEventStore,
  event: ExternalEvent,
  overrides: {
    deliveryKey?: string;
    workflowRunId?: string;
    taskId?: string;
    nodeId?: string;
    agentName?: string;
  } = {}
): void {
  store.store(event);
  store.registerExpectedDelivery(event.id, overrides.deliveryKey ?? `dk-${event.id}`, {
    workflowRunId: overrides.workflowRunId ?? 'run-node-tools-default',
    taskId: overrides.taskId ?? 'task-node-tools-default',
    nodeId: overrides.nodeId ?? 'node-node-tools-default',
    agentName: overrides.agentName ?? 'coder',
  });
}

describe('node-agent-tools: list_deliveries', () => {
  let ctx: TestCtx;

  beforeEach(() => {
    ctx = makeCtx();
  });

  afterEach(() => {
    ctx.db.close();
  });

  test('returns deliveries for the current run by default with event essence', async () => {
    const store = new ExternalEventStore(ctx.db);
    const event = makeGitHubEvent({ spaceId: ctx.spaceId });
    seedDelivery(store, event, { deliveryKey: 'dk-default' });

    const handlers = createNodeAgentToolHandlers(makeConfig(ctx, { externalEventStore: store }));
    const result = await handlers.list_deliveries({});
    const data = JSON.parse(result.content[0].text);

    expect(data.success).toBe(true);
    expect(data.deliveries).toHaveLength(1);
    const delivery = data.deliveries[0];
    expect(delivery.deliveryKey).toBe('dk-default');
    expect(delivery.state).toBe('pending');
    expect(delivery.workflowRunId).toBe(ctx.workflowRunId);
    expect(delivery.nodeId).toBe(ctx.nodeId);
    expect(delivery.event.topic).toBe(event.topic);
    expect(delivery.event.source).toBe('github');
    expect(delivery.event.summary).toBe(event.summary);
    expect(delivery.event.externalUrl).toBe(event.externalUrl);
    expect(delivery.event.state).toBe('published');
  });

  test('filters by nodeId within the current run', async () => {
    const store = new ExternalEventStore(ctx.db);
    const event = makeGitHubEvent({ spaceId: ctx.spaceId });
    seedDelivery(store, event, {
      deliveryKey: 'dk-coder',
      nodeId: 'node-coder',
      agentName: 'coder',
    });
    seedDelivery(store, event, {
      deliveryKey: 'dk-reviewer',
      nodeId: 'node-reviewer',
      agentName: 'reviewer',
    });

    const handlers = createNodeAgentToolHandlers(makeConfig(ctx, { externalEventStore: store }));
    const result = await handlers.list_deliveries({ nodeId: 'node-reviewer' });
    const data = JSON.parse(result.content[0].text);

    expect(data.deliveries).toHaveLength(1);
    expect(data.deliveries[0].deliveryKey).toBe('dk-reviewer');
  });

  test('filters by delivery state', async () => {
    const store = new ExternalEventStore(ctx.db);
    const event = makeGitHubEvent({ spaceId: ctx.spaceId });
    seedDelivery(store, event, { deliveryKey: 'dk-pending' });
    seedDelivery(store, event, { deliveryKey: 'dk-delivered' });
    store.markDeliveryDelivered(event.id, 'dk-delivered');

    const handlers = createNodeAgentToolHandlers(makeConfig(ctx, { externalEventStore: store }));

    const delivered = await handlers.list_deliveries({ state: 'delivered' });
    const deliveredData = JSON.parse(delivered.content[0].text);
    expect(deliveredData.deliveries).toHaveLength(1);
    expect(deliveredData.deliveries[0].deliveryKey).toBe('dk-delivered');
    expect(deliveredData.deliveries[0].state).toBe('delivered');

    const pending = await handlers.list_deliveries({ state: 'pending' });
    const pendingData = JSON.parse(pending.content[0].text);
    expect(pendingData.deliveries).toHaveLength(1);
    expect(pendingData.deliveries[0].deliveryKey).toBe('dk-pending');
  });

  test('isolates by workflow run — another run is excluded by default', async () => {
    const store = new ExternalEventStore(ctx.db);
    const event = makeGitHubEvent({ spaceId: ctx.spaceId });
    seedDelivery(store, event, { deliveryKey: 'dk-mine' });
    seedDelivery(store, event, {
      deliveryKey: 'dk-other-run',
      workflowRunId: 'run-node-tools-other',
    });

    const handlers = createNodeAgentToolHandlers(makeConfig(ctx, { externalEventStore: store }));
    const result = await handlers.list_deliveries({});
    const data = JSON.parse(result.content[0].text);

    expect(data.deliveries).toHaveLength(1);
    expect(data.deliveries[0].deliveryKey).toBe('dk-mine');

    const other = await handlers.list_deliveries({ workflowRunId: 'run-node-tools-other' });
    const otherData = JSON.parse(other.content[0].text);
    expect(otherData.deliveries).toHaveLength(1);
    expect(otherData.deliveries[0].deliveryKey).toBe('dk-other-run');
  });

  test('does not leak deliveries from another space', async () => {
    const store = new ExternalEventStore(ctx.db);
    const ownEvent = makeGitHubEvent({ spaceId: ctx.spaceId });
    seedDelivery(store, ownEvent, { deliveryKey: 'dk-own' });

    ctx.db
      .prepare(
        `INSERT INTO spaces (id, workspace_path, name, description, background_context, instructions,
         allowed_models, session_ids, slug, status, created_at, updated_at)
         VALUES (?, '/tmp/space-other-list', ?, '', '', '', '[]', '[]', ?, 'active', ?, ?)`
      )
      .run('space-other-list', 'Space other', 'space-other-list', Date.now(), Date.now());
    const foreignEvent = makeGitHubEvent({
      spaceId: 'space-other-list',
      id: crypto.randomUUID(),
      dedupeKey: `dedupe-foreign-${Math.random().toString(36).slice(2)}`,
    });
    seedDelivery(store, foreignEvent, {
      deliveryKey: 'dk-foreign',
      workflowRunId: ctx.workflowRunId,
    });

    const handlers = createNodeAgentToolHandlers(makeConfig(ctx, { externalEventStore: store }));
    const result = await handlers.list_deliveries({});
    const data = JSON.parse(result.content[0].text);

    expect(data.deliveries).toHaveLength(1);
    expect(data.deliveries[0].deliveryKey).toBe('dk-own');
  });

  test('returns unavailable when the store is not wired', async () => {
    const handlers = createNodeAgentToolHandlers(makeConfig(ctx));
    const result = await handlers.list_deliveries({});
    const data = JSON.parse(result.content[0].text);

    expect(data.success).toBe(false);
    expect(data.error).toContain('not available');
  });

  test('createNodeAgentMcpServer registers list_deliveries only when the store is wired', () => {
    const store = new ExternalEventStore(ctx.db);

    const withoutStore = createNodeAgentMcpServer(makeConfig(ctx));
    const withoutRegistered = Object.keys(
      (withoutStore as unknown as { instance: { _registeredTools: Record<string, unknown> } })
        .instance._registeredTools
    );
    expect(withoutRegistered).not.toContain('list_deliveries');

    const withStore = createNodeAgentMcpServer(makeConfig(ctx, { externalEventStore: store }));
    const withRegistered = Object.keys(
      (withStore as unknown as { instance: { _registeredTools: Record<string, unknown> } }).instance
        ._registeredTools
    );
    expect(withRegistered).toContain('list_deliveries');
  });
});

describe('node-agent-tools: list_subscriptions', () => {
  let ctx: TestCtx;

  beforeEach(() => {
    ctx = makeCtx();
  });

  afterEach(() => {
    ctx.db.close();
  });

  test('delegates to onListSubscriptions, defaulting to the current run', async () => {
    const calls: Array<{ workflowRunId?: string; nodeId?: string }> = [];
    const handlers = createNodeAgentToolHandlers(
      makeConfig(ctx, {
        onListSubscriptions: async (args) => {
          calls.push(args);
          return {
            content: [
              {
                type: 'text',
                text: JSON.stringify({ success: true, declared: [], persisted: [] }),
              },
            ],
          };
        },
      })
    );

    const result = await handlers.list_subscriptions({});
    const data = JSON.parse(result.content[0].text);

    expect(data.success).toBe(true);
    expect(calls).toEqual([{ workflowRunId: undefined, nodeId: undefined }]);
  });

  test('forwards workflowRunId and nodeId overrides', async () => {
    const calls: Array<{ workflowRunId?: string; nodeId?: string }> = [];
    const handlers = createNodeAgentToolHandlers(
      makeConfig(ctx, {
        onListSubscriptions: async (args) => {
          calls.push(args);
          return { content: [{ type: 'text', text: JSON.stringify({ success: true }) }] };
        },
      })
    );

    await handlers.list_subscriptions({
      workflowRunId: 'run-other',
      nodeId: 'node-review',
    });

    expect(calls).toEqual([{ workflowRunId: 'run-other', nodeId: 'node-review' }]);
  });

  test('returns unavailable when onListSubscriptions is not wired', async () => {
    const handlers = createNodeAgentToolHandlers(makeConfig(ctx));

    const result = await handlers.list_subscriptions({});
    const data = JSON.parse(result.content[0].text);

    expect(data.success).toBe(false);
    expect(data.error).toContain('not available');
  });

  test('a realistic result envelope survives the jsonResult round-trip', async () => {
    const handlers = createNodeAgentToolHandlers(
      makeConfig(ctx, {
        onListSubscriptions: async () => ({
          content: [
            {
              type: 'text',
              text: JSON.stringify({
                success: true,
                result: {
                  workflowRunId: ctx.workflowRunId,
                  nodeId: null,
                  declared: [
                    {
                      nodeId: 'code',
                      agentName: 'coder',
                      topic: 'github/o/r/issues/*',
                      active: true,
                    },
                  ],
                  persisted: [],
                  active: [],
                  mismatches: { declaredNotActive: 0, persistedNotActive: 0, orphanActive: 0 },
                },
              }),
            },
          ],
        }),
      })
    );

    const result = await handlers.list_subscriptions({});
    const data = JSON.parse(result.content[0].text);

    expect(data.success).toBe(true);
    expect(data.result.workflowRunId).toBe(ctx.workflowRunId);
    expect(data.result.declared).toHaveLength(1);
    expect(data.result.declared[0]).toMatchObject({ topic: 'github/o/r/issues/*', active: true });
    expect(data.result.mismatches).toEqual({
      declaredNotActive: 0,
      persistedNotActive: 0,
      orphanActive: 0,
    });
  });

  test('createNodeAgentMcpServer registers list_subscriptions only when the callback is wired', () => {
    const withoutCallback = createNodeAgentMcpServer(makeConfig(ctx));
    const withoutRegistered = Object.keys(
      (withoutCallback as unknown as { instance: { _registeredTools: Record<string, unknown> } })
        .instance._registeredTools
    );
    expect(withoutRegistered).not.toContain('list_subscriptions');

    const withCallback = createNodeAgentMcpServer(
      makeConfig(ctx, {
        onListSubscriptions: async () => ({
          content: [{ type: 'text', text: JSON.stringify({ success: true }) }],
        }),
      })
    );
    const withRegistered = Object.keys(
      (withCallback as unknown as { instance: { _registeredTools: Record<string, unknown> } })
        .instance._registeredTools
    );
    expect(withRegistered).toContain('list_subscriptions');
  });
});

describe('node-agent-tools: createNodeAgentMcpServer', () => {
  let ctx: TestCtx;

  beforeEach(() => {
    ctx = makeCtx();
  });

  afterEach(() => {
    ctx.db.close();
  });

  test('creates an MCP server with expected tools', () => {
    const config = makeConfig(ctx);
    const server = createNodeAgentMcpServer(config);

    expect(server).toBeDefined();
    expect(typeof server).toBe('object');
  });
});

describe('node-agent-tools: system prompt uses only visible prompt text', () => {
  test('buildCustomAgentSystemPrompt returns configured text only', async () => {
    const { buildCustomAgentSystemPrompt } = await import(
      '../../../../src/lib/space/agents/custom-agent.ts'
    );

    const prompt = buildCustomAgentSystemPrompt({
      id: 'agent-1',
      spaceId: 'space-1',
      name: 'Coder',
      customPrompt: 'Visible workflow prompt',
      createdAt: Date.now(),
      updatedAt: Date.now(),
    });

    expect(prompt).toBe('Visible workflow prompt');
  });
});

describe('list_peers — completion state', () => {
  let ctx: TestCtx;

  beforeEach(() => {
    ctx = makeCtx();
  });

  afterEach(() => {
    ctx.db.close();
  });

  test('list_peers includes completionState for each peer based on space_tasks', async () => {
    const workflowNodeId = 'node-abc';
    const workflowRunId = 'run-test-abc';

    seedSpaceWorkflowRunRow(ctx.db, workflowRunId, ctx.spaceId, 'wf-seed');

    seedSpaceTask(
      ctx.db,
      ctx.spaceId,
      workflowRunId,
      workflowNodeId,
      'reviewer',
      'done',
      'All looks good!'
    );

    const config = makeConfig(ctx, {
      workflowRunId,
      workflowNodeId,
    });
    const handlers = createNodeAgentToolHandlers(config);
    const result = await handlers.list_peers({});
    const data = JSON.parse(result.content[0].text);

    expect(data.success).toBe(true);
    const reviewerPeer = data.peers.find((p: { agentName: string }) => p.agentName === 'reviewer');
    expect(reviewerPeer).toBeDefined();
    expect(reviewerPeer.completionState).not.toBeNull();
    expect(reviewerPeer.completionState.taskStatus).toBe('idle');
    expect(reviewerPeer.completionState.completionSummary).toBe('All looks good!');
    expect(reviewerPeer.completionState.agentName).toBe('reviewer');
  });

  test('list_peers shows nodeCompletionState for all tasks on the node', async () => {
    const workflowNodeId = 'node-xyz';
    const workflowRunId = 'run-test-xyz';

    seedSpaceWorkflowRunRow(ctx.db, workflowRunId, ctx.spaceId, 'wf-seed');

    seedSpaceTask(ctx.db, ctx.spaceId, workflowRunId, workflowNodeId, 'coder', 'in_progress', null);
    seedSpaceTask(
      ctx.db,
      ctx.spaceId,
      workflowRunId,
      workflowNodeId,
      'reviewer',
      'done',
      'Review done'
    );

    const config = makeConfig(ctx, {
      workflowRunId,
      workflowNodeId,
    });
    const handlers = createNodeAgentToolHandlers(config);
    const result = await handlers.list_peers({});
    const data = JSON.parse(result.content[0].text);

    expect(data.success).toBe(true);
    expect(Array.isArray(data.nodeCompletionState)).toBe(true);
    expect(data.nodeCompletionState).toHaveLength(2);

    const coderState = data.nodeCompletionState.find(
      (s: { agentName: string }) => s.agentName === 'coder'
    );
    expect(coderState).toBeDefined();
    expect(coderState.taskStatus).toBe('in_progress');

    const reviewerState = data.nodeCompletionState.find(
      (s: { agentName: string }) => s.agentName === 'reviewer'
    );
    expect(reviewerState).toBeDefined();
    expect(reviewerState.taskStatus).toBe('idle');
    expect(reviewerState.completionSummary).toBe('Review done');
  });

  test('list_peers works without space_tasks (no tasks on node)', async () => {
    const workflowNodeId = 'node-empty';
    const workflowRunId = 'run-test-empty';

    const config = makeConfig(ctx, {
      workflowRunId,
      workflowNodeId,
    });
    const handlers = createNodeAgentToolHandlers(config);
    const result = await handlers.list_peers({});
    const data = JSON.parse(result.content[0].text);

    expect(data.success).toBe(true);
    expect(data.nodeCompletionState).toHaveLength(0);
    for (const peer of data.peers) {
      expect(peer.completionState).toBeNull();
    }
  });
});

describe('node-agent-tools: create_standalone_task', () => {
  let ctx: TestCtx;

  beforeEach(() => {
    ctx = makeCtx();
  });

  afterEach(() => {
    ctx.db.close();
  });

  test('delegates to onCreateStandaloneTask and returns the created task', async () => {
    const config = makeConfig(ctx, {
      onCreateStandaloneTask: async (args) => {
        const task = await ctx.taskManager.createTask({
          title: args.title,
          description: args.description,
          priority: args.priority,
          preferredWorkflowId: args.workflow_id ?? null,
          dependsOn: args.depends_on,
        });
        return {
          content: [{ type: 'text', text: JSON.stringify({ success: true, task }) }],
        };
      },
    });
    const handlers = createNodeAgentToolHandlers(config);
    const result = await handlers.create_standalone_task({
      title: 'Follow-up task',
      description: 'Do the follow-up work',
      priority: 'high',
      workflow_id: 'wf-follow-up',
    });
    const data = JSON.parse(result.content[0].text);

    expect(data.success).toBe(true);
    expect(data.task.title).toBe('Follow-up task');
    expect(data.task.priority).toBe('high');
    expect(data.task.preferredWorkflowId).toBe('wf-follow-up');
  });

  test('returns a clear error when callback is not wired', async () => {
    const handlers = createNodeAgentToolHandlers(makeConfig(ctx));
    const result = await handlers.create_standalone_task({
      title: 'Follow-up task',
      description: 'Do the follow-up work',
    });
    const data = JSON.parse(result.content[0].text);

    expect(data.success).toBe(false);
    expect(data.error).toContain('not available');
  });

  test('createNodeAgentMcpServer registers create_standalone_task only when callback is wired', () => {
    const withoutCallback = createNodeAgentMcpServer(makeConfig(ctx));
    const withoutRegistered = Object.keys(
      (withoutCallback as unknown as { instance: { _registeredTools: Record<string, unknown> } })
        .instance._registeredTools
    );
    expect(withoutRegistered).not.toContain('create_standalone_task');

    const withCallback = createNodeAgentMcpServer(
      makeConfig(ctx, {
        onCreateStandaloneTask: async () => ({
          content: [{ type: 'text', text: JSON.stringify({ success: true }) }],
        }),
      })
    );
    const withRegistered = Object.keys(
      (withCallback as unknown as { instance: { _registeredTools: Record<string, unknown> } })
        .instance._registeredTools
    );
    expect(withRegistered).toContain('create_standalone_task');
  });
});

describe('node-agent-tools: restore_node_agent', () => {
  let ctx: TestCtx;

  beforeEach(() => {
    ctx = makeCtx();
  });

  afterEach(() => {
    ctx.db.close();
  });

  test('returns success with session/agent identity even without onRestoreNodeAgent callback', async () => {
    const config = makeConfig(ctx);
    const handlers = createNodeAgentToolHandlers(config);
    const result = await handlers.restore_node_agent({});
    const data = JSON.parse(result.content[0].text);

    expect(data.success).toBe(true);
    expect(data.sessionId).toBe(ctx.coderSessionId);
    expect(data.agentName).toBe('coder');
    expect(typeof data.message).toBe('string');
    expect(data.message).toContain('node-agent MCP server is registered');
  });

  test('invokes onRestoreNodeAgent callback with the supplied reason', async () => {
    const captured: Array<{ reason?: string }> = [];
    const config = makeConfig(ctx, {
      onRestoreNodeAgent: (args) => {
        captured.push(args);
      },
    });
    const handlers = createNodeAgentToolHandlers(config);
    await handlers.restore_node_agent({ reason: 'previous send_message returned No such tool' });

    expect(captured).toHaveLength(1);
    expect(captured[0]!.reason).toBe('previous send_message returned No such tool');
  });

  test('still returns success when the onRestoreNodeAgent callback throws', async () => {
    const config = makeConfig(ctx, {
      onRestoreNodeAgent: () => {
        throw new Error('reattach failed');
      },
    });
    const handlers = createNodeAgentToolHandlers(config);
    const result = await handlers.restore_node_agent({ reason: 'diagnostic' });
    const data = JSON.parse(result.content[0].text);

    expect(data.success).toBe(true);
    expect(data.sessionId).toBe(ctx.coderSessionId);
  });

  test('awaits async onRestoreNodeAgent callback before returning', async () => {
    let resolved = false;
    const config = makeConfig(ctx, {
      onRestoreNodeAgent: async () => {
        await new Promise((r) => setTimeout(r, 10));
        resolved = true;
      },
    });
    const handlers = createNodeAgentToolHandlers(config);
    await handlers.restore_node_agent({});

    expect(resolved).toBe(true);
  });

  test('createNodeAgentMcpServer registers restore_node_agent tool', () => {
    const config = makeConfig(ctx);
    const server = createNodeAgentMcpServer(config);
    const registered = Object.keys(
      (server as unknown as { instance: { _registeredTools: Record<string, unknown> } }).instance
        ._registeredTools
    );
    expect(registered).toContain('restore_node_agent');
  });
});

describe('node-agent-tools: list_peers — cross-node peer discovery', () => {
  let ctx: TestCtx;

  beforeEach(() => {
    ctx = makeCtx();
  });

  afterEach(() => {
    ctx.db.close();
  });

  test('shows cross-node peer as not_started when node has not been activated yet', async () => {
    const reviewNodeId = 'node-review';
    const codingNodeId = ctx.nodeId;

    const workflow: SpaceWorkflow = {
      id: 'wf-cross-node',
      spaceId: ctx.spaceId,
      name: 'Research Workflow',
      description: '',
      nodes: [
        {
          id: codingNodeId,
          name: 'Coding',
          agents: [{ agentId: 'agent-coder', name: 'coder' }],
        },
        {
          id: reviewNodeId,
          name: 'Review',
          agents: [{ agentId: 'agent-reviewer', name: 'agent-reviewer' }],
        },
      ],
      startNodeId: codingNodeId,
      endNodeId: reviewNodeId,
      transitions: [],
      rules: [],
      channels: [{ id: 'ch-coding-review', from: 'Coding', to: 'Review' }],
    };

    const channelResolver = makeResolver([
      { id: 'ch-coding-review', from: 'Coding', to: 'Review' },
    ]);

    const config = makeConfig(ctx, {
      myAgentName: 'coder',
      mySessionId: ctx.coderSessionId,
      workflowNodeId: codingNodeId,
      channelResolver,
      workflow,
    });
    const handlers = createNodeAgentToolHandlers(config);
    const result = await handlers.list_peers({});
    const data = JSON.parse(result.content[0].text);

    expect(data.success).toBe(true);
    const crossNodePeer = data.peers.find(
      (p: { agentName: string }) => p.agentName === 'agent-reviewer'
    );
    expect(crossNodePeer).toBeDefined();
    expect(crossNodePeer.status).toBe('not_started');
    expect(crossNodePeer.completionState.taskStatus).toBe('not_started');
    expect(crossNodePeer.nodeName).toBe('Review');

    expect(data.permittedTargets).toContain('Review');
    expect(data.permittedTargets).toContain('agent-reviewer');
  });

  test('shows cross-node peer with active status when node has been activated', async () => {
    const reviewNodeId = 'node-review-activated';
    const codingNodeId = ctx.nodeId;

    const workflow: SpaceWorkflow = {
      id: 'wf-cross-node-active',
      spaceId: ctx.spaceId,
      name: 'Active Workflow',
      description: '',
      nodes: [
        {
          id: codingNodeId,
          name: 'Coding',
          agents: [{ agentId: 'agent-coder', name: 'coder' }],
        },
        {
          id: reviewNodeId,
          name: 'Review',
          agents: [{ agentId: 'agent-reviewer', name: 'agent-reviewer' }],
        },
      ],
      startNodeId: codingNodeId,
      endNodeId: reviewNodeId,
      transitions: [],
      rules: [],
      channels: [{ id: 'ch-coding-review', from: 'Coding', to: 'Review' }],
    };

    const channelResolver = makeResolver([
      { id: 'ch-coding-review', from: 'Coding', to: 'Review' },
    ]);

    const reviewerSessionId = 'session-reviewer-cross';
    const nodeExecutionRepo = ctx.nodeExecutionRepo;
    const exec = nodeExecutionRepo.createOrIgnore({
      workflowRunId: ctx.workflowRunId,
      workflowNodeId: reviewNodeId,
      agentName: 'agent-reviewer',
      agentSessionId: reviewerSessionId,
      status: 'in_progress',
    });
    nodeExecutionRepo.update(exec.id, { agentSessionId: reviewerSessionId });

    const config = makeConfig(ctx, {
      myAgentName: 'coder',
      mySessionId: ctx.coderSessionId,
      workflowNodeId: codingNodeId,
      channelResolver,
      workflow,
    });
    const handlers = createNodeAgentToolHandlers(config);
    const result = await handlers.list_peers({});
    const data = JSON.parse(result.content[0].text);

    expect(data.success).toBe(true);
    const crossNodePeer = data.peers.find(
      (p: { agentName: string }) => p.agentName === 'agent-reviewer'
    );
    expect(crossNodePeer).toBeDefined();
    expect(crossNodePeer.status).toBe('active');
    expect(crossNodePeer.sessionId).toBe(reviewerSessionId);
    expect(crossNodePeer.nodeName).toBe('Review');
  });

  test('shows cross-node peer with completed status when execution is idle', async () => {
    const reviewNodeId = 'node-review-done';
    const codingNodeId = ctx.nodeId;

    const workflow: SpaceWorkflow = {
      id: 'wf-cross-node-done',
      spaceId: ctx.spaceId,
      name: 'Done Workflow',
      description: '',
      nodes: [
        {
          id: codingNodeId,
          name: 'Coding',
          agents: [{ agentId: 'agent-coder', name: 'coder' }],
        },
        {
          id: reviewNodeId,
          name: 'Review',
          agents: [{ agentId: 'agent-reviewer', name: 'agent-reviewer' }],
        },
      ],
      startNodeId: codingNodeId,
      endNodeId: reviewNodeId,
      transitions: [],
      rules: [],
      channels: [{ id: 'ch-coding-review', from: 'Coding', to: 'Review' }],
    };

    const channelResolver = makeResolver([
      { id: 'ch-coding-review', from: 'Coding', to: 'Review' },
    ]);

    const nodeExecutionRepo = ctx.nodeExecutionRepo;
    const exec = nodeExecutionRepo.createOrIgnore({
      workflowRunId: ctx.workflowRunId,
      workflowNodeId: reviewNodeId,
      agentName: 'agent-reviewer',
      agentSessionId: 'session-reviewer-done',
      status: 'idle',
    });
    nodeExecutionRepo.update(exec.id, { result: 'LGTM!', status: 'idle' });

    const config = makeConfig(ctx, {
      myAgentName: 'coder',
      mySessionId: ctx.coderSessionId,
      workflowNodeId: codingNodeId,
      channelResolver,
      workflow,
    });
    const handlers = createNodeAgentToolHandlers(config);
    const result = await handlers.list_peers({});
    const data = JSON.parse(result.content[0].text);

    expect(data.success).toBe(true);
    const crossNodePeer = data.peers.find(
      (p: { agentName: string }) => p.agentName === 'agent-reviewer'
    );
    expect(crossNodePeer).toBeDefined();
    expect(crossNodePeer.status).toBe('completed');
    expect(crossNodePeer.completionState.completionSummary).toBe('LGTM!');
    expect(crossNodePeer.nodeName).toBe('Review');
  });

  test('does not include cross-node peers when no channel topology declared', async () => {
    const config = makeConfig(ctx, {
      channelResolver: makeResolver([]),
      workflow: null,
    });
    const handlers = createNodeAgentToolHandlers(config);
    const result = await handlers.list_peers({});
    const data = JSON.parse(result.content[0].text);

    expect(data.success).toBe(true);
    expect(data.peers).toHaveLength(1);
    expect(data.peers[0].agentName).toBe('reviewer');
  });

  test('cross-node peer uses topology target name as agentName when workflow is null', async () => {
    const config = makeConfig(ctx, {
      myAgentName: 'coder',
      mySessionId: ctx.coderSessionId,
      workflowNodeId: ctx.nodeId,
      channelResolver: makeResolver([{ id: 'ch-coder-review', from: 'coder', to: 'Review' }]),
      workflow: null,
    });
    const handlers = createNodeAgentToolHandlers(config);
    const result = await handlers.list_peers({});
    const data = JSON.parse(result.content[0].text);

    expect(data.success).toBe(true);
    const crossPeer = data.peers.find((p: { agentName: string }) => p.agentName === 'Review');
    expect(crossPeer).toBeDefined();
    expect(crossPeer.status).toBe('not_started');
    expect(crossPeer.nodeName).toBe('Review');
  });

  test('cross-node peer uses node name when resolveNodeAgents throws (no agents defined)', async () => {
    const reviewNodeId = 'node-review-no-agents';
    const codingNodeId = ctx.nodeId;

    const workflow: SpaceWorkflow = {
      id: 'wf-no-agents',
      spaceId: ctx.spaceId,
      name: 'No Agents Workflow',
      description: '',
      nodes: [
        {
          id: codingNodeId,
          name: 'Coding',
          agents: [{ agentId: 'agent-coder', name: 'coder' }],
        },
        { id: reviewNodeId, name: 'Review', agents: [] },
      ],
      startNodeId: codingNodeId,
      endNodeId: reviewNodeId,
      transitions: [],
      rules: [],
      channels: [{ id: 'ch-coding-review', from: 'Coding', to: 'Review' }],
    };

    const config = makeConfig(ctx, {
      myAgentName: 'coder',
      mySessionId: ctx.coderSessionId,
      workflowNodeId: codingNodeId,
      channelResolver: makeResolver([{ id: 'ch-coding-review', from: 'Coding', to: 'Review' }]),
      workflow,
    });
    const handlers = createNodeAgentToolHandlers(config);
    const result = await handlers.list_peers({});
    const data = JSON.parse(result.content[0].text);

    expect(data.success).toBe(true);
    const crossPeer = data.peers.find((p: { agentName: string }) => p.agentName === 'Review');
    expect(crossPeer).toBeDefined();
    expect(crossPeer.status).toBe('not_started');
    expect(crossPeer.nodeName).toBe('Review');
  });

  test('cross-node peer with pending execution status appears as not_started', async () => {
    const reviewNodeId = 'node-review-pending';
    const codingNodeId = ctx.nodeId;

    const workflow: SpaceWorkflow = {
      id: 'wf-pending-status',
      spaceId: ctx.spaceId,
      name: 'Pending Status Workflow',
      description: '',
      nodes: [
        {
          id: codingNodeId,
          name: 'Coding',
          agents: [{ agentId: 'agent-coder', name: 'coder' }],
        },
        {
          id: reviewNodeId,
          name: 'Review',
          agents: [{ agentId: 'agent-reviewer', name: 'agent-reviewer' }],
        },
      ],
      startNodeId: codingNodeId,
      endNodeId: reviewNodeId,
      transitions: [],
      rules: [],
      channels: [{ id: 'ch-coding-review', from: 'Coding', to: 'Review' }],
    };

    ctx.nodeExecutionRepo.createOrIgnore({
      workflowRunId: ctx.workflowRunId,
      workflowNodeId: reviewNodeId,
      agentName: 'agent-reviewer',
      status: 'pending',
    });

    const config = makeConfig(ctx, {
      myAgentName: 'coder',
      mySessionId: ctx.coderSessionId,
      workflowNodeId: codingNodeId,
      channelResolver: makeResolver([{ id: 'ch-coding-review', from: 'Coding', to: 'Review' }]),
      workflow,
    });
    const handlers = createNodeAgentToolHandlers(config);
    const result = await handlers.list_peers({});
    const data = JSON.parse(result.content[0].text);

    expect(data.success).toBe(true);
    const crossPeer = data.peers.find(
      (p: { agentName: string }) => p.agentName === 'agent-reviewer'
    );
    expect(crossPeer).toBeDefined();
    expect(crossPeer.status).toBe('not_started');
    expect(crossPeer.completionState.taskStatus).toBe('pending');
    expect(crossPeer.nodeName).toBe('Review');
  });
});

describe('node-agent-tools: send_message — queue-when-inactive', () => {
  let ctx: TestCtx;

  beforeEach(() => {
    ctx = makeCtx();
  });

  afterEach(() => {
    ctx.db.close();
  });

  test('queues message for declared-but-inactive agent when pendingMessageRepo provided', async () => {
    const isolatedRunId = makeFreshRunId(ctx.db, ctx.spaceId);

    const nodeExecutionRepo = ctx.nodeExecutionRepo;
    nodeExecutionRepo.createOrIgnore({
      workflowRunId: isolatedRunId,
      workflowNodeId: 'node-review',
      agentName: 'reviewer',
      status: 'pending',
    });

    const pendingMessageRepo = new PendingAgentMessageRepository(ctx.db);
    const agentMessageRouter = new AgentMessageRouter({
      nodeExecutionRepo,
      workflowRunId: isolatedRunId,
      workflowChannels: [{ id: 'ch-coder-reviewer', from: 'coder', to: 'reviewer' }],
      messageInjector: async () => {
        throw new Error('Should not be called — reviewer has no session');
      },
      pendingMessageRepo,
      spaceId: ctx.spaceId,
      taskId: null,
    });

    const config = makeConfig(ctx, {
      workflowRunId: isolatedRunId,
      channelResolver: makeResolver([{ id: 'ch-coder-reviewer', from: 'coder', to: 'reviewer' }]),
      agentMessageRouter,
    });
    const handlers = createNodeAgentToolHandlers(config);
    const result = await handlers.send_message({
      target: 'reviewer',
      message: 'code is ready for review',
    });
    const data = JSON.parse(result.content[0].text);

    expect(data.success).toBe(false);
    expect(data.queued).toBeDefined();
    expect(data.queued).toHaveLength(1);
    expect(data.queued[0].agentName).toBe('reviewer');
    expect(data.delivered ?? []).toHaveLength(0);

    const pending = pendingMessageRepo.listPendingForTarget(isolatedRunId, 'reviewer');
    expect(pending).toHaveLength(1);
    expect(pending[0].sourceAgentName).toBe('coder');
    expect(pending[0].message).toBe('─── Message from coder ───\n\ncode is ready for review');
    expect(pending[0].targetKind).toBe('node_agent');
  });

  test('queues message with data appendix for declared-but-inactive agent', async () => {
    const isolatedRunId = makeFreshRunId(ctx.db, ctx.spaceId);

    const nodeExecutionRepo = ctx.nodeExecutionRepo;
    nodeExecutionRepo.createOrIgnore({
      workflowRunId: isolatedRunId,
      workflowNodeId: 'node-review',
      agentName: 'reviewer',
      status: 'pending',
    });

    const pendingMessageRepo = new PendingAgentMessageRepository(ctx.db);
    const agentMessageRouter = new AgentMessageRouter({
      nodeExecutionRepo,
      workflowRunId: isolatedRunId,
      workflowChannels: [{ id: 'ch-coder-reviewer', from: 'coder', to: 'reviewer' }],
      messageInjector: async () => {},
      pendingMessageRepo,
      spaceId: ctx.spaceId,
      taskId: null,
    });

    const config = makeConfig(ctx, {
      workflowRunId: isolatedRunId,
      channelResolver: makeResolver([{ id: 'ch-coder-reviewer', from: 'coder', to: 'reviewer' }]),
      agentMessageRouter,
    });
    const handlers = createNodeAgentToolHandlers(config);
    const result = await handlers.send_message({
      target: 'reviewer',
      message: 'please review my PR',
      data: { pr_url: 'https://github.com/example/repo/pull/1' },
    });
    const data = JSON.parse(result.content[0].text);

    expect(data.success).toBe(false);
    expect(data.queued).toHaveLength(1);

    const pending = pendingMessageRepo.listPendingForTarget(isolatedRunId, 'reviewer');
    expect(pending).toHaveLength(1);
    expect(pending[0].message).toContain('please review my PR');
    expect(pending[0].message).toContain('pr_url');
  });

  test('delivers immediately when target has an active session, queues when it does not', async () => {
    const isolatedRunId = makeFreshRunId(ctx.db, ctx.spaceId);

    const nodeExecutionRepo = ctx.nodeExecutionRepo;
    const revExec = nodeExecutionRepo.createOrIgnore({
      workflowRunId: isolatedRunId,
      workflowNodeId: 'node-review',
      agentName: 'reviewer',
      agentSessionId: 'session-reviewer-live',
      status: 'in_progress',
    });
    nodeExecutionRepo.update(revExec.id, { agentSessionId: 'session-reviewer-live' });

    nodeExecutionRepo.createOrIgnore({
      workflowRunId: isolatedRunId,
      workflowNodeId: 'node-security',
      agentName: 'security',
      status: 'pending',
    });

    const pendingMessageRepo = new PendingAgentMessageRepository(ctx.db);
    const injectedSessions: string[] = [];
    const agentMessageRouter = new AgentMessageRouter({
      nodeExecutionRepo,
      workflowRunId: isolatedRunId,
      workflowChannels: [
        { id: 'ch-coder-reviewer', from: 'coder', to: 'reviewer' },
        { id: 'ch-coder-security', from: 'coder', to: 'security' },
      ],
      messageInjector: async (sid) => {
        injectedSessions.push(sid);
      },
      pendingMessageRepo,
      spaceId: ctx.spaceId,
      taskId: null,
    });

    const config = makeConfig(ctx, {
      mySessionId: ctx.coderSessionId,
      workflowRunId: isolatedRunId,
      channelResolver: makeResolver([
        { id: 'ch-coder-reviewer', from: 'coder', to: 'reviewer' },
        { id: 'ch-coder-security', from: 'coder', to: 'security' },
      ]),
      agentMessageRouter,
    });
    const handlers = createNodeAgentToolHandlers(config);
    const result = await handlers.send_message({
      target: ['reviewer', 'security'],
      message: 'hello from coder',
    });
    const data = JSON.parse(result.content[0].text);

    expect(data.success).toBe(true);
    expect(data.delivered).toHaveLength(1);
    expect(data.delivered[0].agentName).toBe('reviewer');
    expect(injectedSessions).toContain('session-reviewer-live');

    expect(data.queued).toHaveLength(1);
    expect(data.queued[0].agentName).toBe('security');
    const securityPending = pendingMessageRepo.listPendingForTarget(isolatedRunId, 'security');
    expect(securityPending).toHaveLength(1);
  });
});

describe('node-agent-tools: list_tasks', () => {
  let ctx: TestCtx;

  beforeEach(() => {
    ctx = makeCtx();
  });

  afterEach(() => {
    ctx.db.close();
  });

  test('lists tasks in the space', async () => {
    const config = makeConfig(ctx, { taskRepo: ctx.taskRepo });
    const handlers = createNodeAgentToolHandlers(config);
    const result = await handlers.list_tasks({});
    const data = JSON.parse(result.content[0].text);

    expect(data.success).toBe(true);
    expect(data.tasks.length).toBeGreaterThanOrEqual(2);
    expect(data.has_more).toBe(false);
  });

  test('filters tasks by status', async () => {
    const config = makeConfig(ctx, { taskRepo: ctx.taskRepo });
    const handlers = createNodeAgentToolHandlers(config);
    const result = await handlers.list_tasks({ status: 'in_progress' });
    const data = JSON.parse(result.content[0].text);

    expect(data.success).toBe(true);
    expect(data.tasks.every((t: { status: string }) => t.status === 'in_progress')).toBe(true);
  });

  test('returns compact tasks when compact:true', async () => {
    const config = makeConfig(ctx, { taskRepo: ctx.taskRepo });
    const handlers = createNodeAgentToolHandlers(config);
    const result = await handlers.list_tasks({ compact: true });
    const data = JSON.parse(result.content[0].text);

    expect(data.success).toBe(true);
    expect(data.tasks[0]).toHaveProperty('id');
    expect(data.tasks[0]).toHaveProperty('title');
    expect(data.tasks[0]).toHaveProperty('status');
    expect(data.tasks[0]).toHaveProperty('priority');
    expect(data.tasks[0]).toHaveProperty('createdAt');
    expect(data.tasks[0]).not.toHaveProperty('description');
  });

  test('paginates with limit and offset', async () => {
    const config = makeConfig(ctx, { taskRepo: ctx.taskRepo });
    const handlers = createNodeAgentToolHandlers(config);

    const page1 = await handlers.list_tasks({ limit: 1, offset: 0 });
    const data1 = JSON.parse(page1.content[0].text);
    expect(data1.tasks).toHaveLength(1);
    expect(data1.has_more).toBe(true);

    const page2 = await handlers.list_tasks({ limit: 1, offset: 1 });
    const data2 = JSON.parse(page2.content[0].text);
    expect(data2.tasks).toHaveLength(1);
    expect(data2.tasks[0].id).not.toBe(data1.tasks[0].id);
  });

  test('returns error when taskRepo is not available', async () => {
    const config = makeConfig(ctx, { taskRepo: undefined });
    const handlers = createNodeAgentToolHandlers(config);
    const result = await handlers.list_tasks({});
    const data = JSON.parse(result.content[0].text);

    expect(data.success).toBe(false);
    expect(data.error).toContain('Task repository not available');
  });
});

describe('node-agent-tools: get_task', () => {
  let ctx: TestCtx;

  beforeEach(() => {
    ctx = makeCtx();
  });

  afterEach(() => {
    ctx.db.close();
  });

  test('gets task by task_number', async () => {
    const config = makeConfig(ctx, { taskRepo: ctx.taskRepo });
    const handlers = createNodeAgentToolHandlers(config);

    const task = ctx.taskRepo.createTask({
      spaceId: ctx.spaceId,
      title: 'Task by number',
      description: '',
    });

    const result = await handlers.get_task({ task_number: task.taskNumber });
    const data = JSON.parse(result.content[0].text);

    expect(data.success).toBe(true);
    expect(data.task.id).toBe(task.id);
    expect(data.task.title).toBe('Task by number');
  });

  test('gets task by task_id', async () => {
    const config = makeConfig(ctx, { taskRepo: ctx.taskRepo });
    const handlers = createNodeAgentToolHandlers(config);

    const task = ctx.taskRepo.createTask({
      spaceId: ctx.spaceId,
      title: 'Task by ID',
      description: '',
    });

    const result = await handlers.get_task({ task_id: task.id });
    const data = JSON.parse(result.content[0].text);

    expect(data.success).toBe(true);
    expect(data.task.id).toBe(task.id);
  });

  test('scopes task_id lookup to current space', async () => {
    const config = makeConfig(ctx, { taskRepo: ctx.taskRepo });
    const handlers = createNodeAgentToolHandlers(config);

    const otherSpaceId = 'other-space';
    ctx.db
      .prepare(
        `INSERT INTO spaces (id, workspace_path, name, description, background_context, instructions,
				 allowed_models, session_ids, slug, status, created_at, updated_at)
				 VALUES (?, ?, ?, '', '', '', '[]', '[]', ?, 'active', ?, ?)`
      )
      .run(otherSpaceId, '/tmp/other', 'Other', 'other', Date.now(), Date.now());

    const otherTask = ctx.taskRepo.createTask({
      spaceId: otherSpaceId,
      title: 'Other space task',
      description: '',
    });

    const result = await handlers.get_task({ task_id: otherTask.id });
    const data = JSON.parse(result.content[0].text);

    expect(data.success).toBe(false);
    expect(data.error).toContain('Task not found');
  });

  test('returns error when neither task_id nor task_number is provided', async () => {
    const config = makeConfig(ctx, { taskRepo: ctx.taskRepo });
    const handlers = createNodeAgentToolHandlers(config);
    const result = await handlers.get_task({});
    const data = JSON.parse(result.content[0].text);

    expect(data.success).toBe(false);
    expect(data.error).toContain('Either task_id or task_number is required');
  });

  test('returns error for non-existent task', async () => {
    const config = makeConfig(ctx, { taskRepo: ctx.taskRepo });
    const handlers = createNodeAgentToolHandlers(config);
    const result = await handlers.get_task({ task_number: 99999 });
    const data = JSON.parse(result.content[0].text);

    expect(data.success).toBe(false);
    expect(data.error).toContain('Task not found');
  });

  test('returns error when taskRepo is not available', async () => {
    const config = makeConfig(ctx, { taskRepo: undefined });
    const handlers = createNodeAgentToolHandlers(config);
    const result = await handlers.get_task({ task_id: 'some-id' });
    const data = JSON.parse(result.content[0].text);

    expect(data.success).toBe(false);
    expect(data.error).toContain('Task repository not available');
  });
});

describe('node-agent-tools: list_audit_entries', () => {
  let ctx: TestCtx;
  let auditLogRepo: McpAuditLogRepository;

  beforeEach(() => {
    ctx = makeCtx();
    auditLogRepo = new McpAuditLogRepository(ctx.db);
  });

  afterEach(() => {
    ctx.db.close();
  });

  test('lists audit entries by space with real total and has_more', async () => {
    auditLogRepo.createEntry({ toolName: 'send_message', spaceId: ctx.spaceId });
    auditLogRepo.createEntry({ toolName: 'save_artifact', spaceId: ctx.spaceId });

    const config = makeConfig(ctx, { auditLogRepo });
    const handlers = createNodeAgentToolHandlers(config);
    const result = await handlers.list_audit_entries({});
    const data = JSON.parse(result.content[0].text);

    expect(data.success).toBe(true);
    expect(data.entries).toHaveLength(2);
    expect(data.total).toBe(2);
    expect(data.has_more).toBe(false);
    const toolNames = data.entries.map((e: { toolName: string }) => e.toolName);
    expect(toolNames).toContain('send_message');
    expect(toolNames).toContain('save_artifact');
  });

  test('filters audit entries by task_id with real total', async () => {
    const taskA = 'task-a';
    const taskB = 'task-b';
    auditLogRepo.createEntry({ toolName: 't1', spaceId: ctx.spaceId, taskId: taskA });
    auditLogRepo.createEntry({ toolName: 't2', spaceId: ctx.spaceId, taskId: taskA });
    auditLogRepo.createEntry({ toolName: 't3', spaceId: ctx.spaceId, taskId: taskB });

    const config = makeConfig(ctx, { auditLogRepo });
    const handlers = createNodeAgentToolHandlers(config);
    const result = await handlers.list_audit_entries({ task_id: taskA });
    const data = JSON.parse(result.content[0].text);

    expect(data.success).toBe(true);
    expect(data.entries).toHaveLength(2);
    expect(data.total).toBe(2);
    expect(data.has_more).toBe(false);
    expect(data.entries.every((e: { taskId: string }) => e.taskId === taskA)).toBe(true);
  });

  test('filters audit entries by session_id with real total', async () => {
    const sessA = 'sess-a';
    const sessB = 'sess-b';
    auditLogRepo.createEntry({ toolName: 't1', spaceId: ctx.spaceId, sessionId: sessA });
    auditLogRepo.createEntry({ toolName: 't2', spaceId: ctx.spaceId, sessionId: sessA });
    auditLogRepo.createEntry({ toolName: 't3', spaceId: ctx.spaceId, sessionId: sessB });

    const config = makeConfig(ctx, { auditLogRepo });
    const handlers = createNodeAgentToolHandlers(config);
    const result = await handlers.list_audit_entries({ session_id: sessA });
    const data = JSON.parse(result.content[0].text);

    expect(data.success).toBe(true);
    expect(data.entries).toHaveLength(2);
    expect(data.total).toBe(2);
    expect(data.has_more).toBe(false);
    expect(data.entries.every((e: { sessionId: string }) => e.sessionId === sessA)).toBe(true);
  });

  test('task_id filter is scoped to current space', async () => {
    const sharedTaskId = 'shared-task';
    auditLogRepo.createEntry({ toolName: 't1', spaceId: ctx.spaceId, taskId: sharedTaskId });
    auditLogRepo.createEntry({ toolName: 't2', spaceId: 'other-space', taskId: sharedTaskId });

    const config = makeConfig(ctx, { auditLogRepo });
    const handlers = createNodeAgentToolHandlers(config);
    const result = await handlers.list_audit_entries({ task_id: sharedTaskId });
    const data = JSON.parse(result.content[0].text);

    expect(data.success).toBe(true);
    expect(data.entries).toHaveLength(1);
    expect(data.entries[0].toolName).toBe('t1');
    expect(data.total).toBe(1);
  });

  test('session_id filter is scoped to current space', async () => {
    const sharedSessionId = 'shared-session';
    auditLogRepo.createEntry({ toolName: 't1', spaceId: ctx.spaceId, sessionId: sharedSessionId });
    auditLogRepo.createEntry({
      toolName: 't2',
      spaceId: 'other-space',
      sessionId: sharedSessionId,
    });

    const config = makeConfig(ctx, { auditLogRepo });
    const handlers = createNodeAgentToolHandlers(config);
    const result = await handlers.list_audit_entries({ session_id: sharedSessionId });
    const data = JSON.parse(result.content[0].text);

    expect(data.success).toBe(true);
    expect(data.entries).toHaveLength(1);
    expect(data.entries[0].toolName).toBe('t1');
    expect(data.total).toBe(1);
  });

  test('task_id filter takes precedence over session_id', async () => {
    auditLogRepo.createEntry({
      toolName: 't1',
      spaceId: ctx.spaceId,
      taskId: 'task-x',
      sessionId: 'sess-a',
    });
    auditLogRepo.createEntry({
      toolName: 't2',
      spaceId: ctx.spaceId,
      taskId: 'task-y',
      sessionId: 'sess-a',
    });

    const config = makeConfig(ctx, { auditLogRepo });
    const handlers = createNodeAgentToolHandlers(config);
    const result = await handlers.list_audit_entries({ task_id: 'task-x', session_id: 'sess-a' });
    const data = JSON.parse(result.content[0].text);

    expect(data.success).toBe(true);
    expect(data.entries).toHaveLength(1);
    expect(data.entries[0].taskId).toBe('task-x');
  });

  test('paginates with limit and offset, reporting real total and has_more', async () => {
    auditLogRepo.createEntry({ toolName: 't1', spaceId: ctx.spaceId });
    auditLogRepo.createEntry({ toolName: 't2', spaceId: ctx.spaceId });
    auditLogRepo.createEntry({ toolName: 't3', spaceId: ctx.spaceId });

    const config = makeConfig(ctx, { auditLogRepo });
    const handlers = createNodeAgentToolHandlers(config);

    const page1 = await handlers.list_audit_entries({ limit: 2, offset: 0 });
    const data1 = JSON.parse(page1.content[0].text);
    expect(data1.entries).toHaveLength(2);
    expect(data1.total).toBe(3);
    expect(data1.has_more).toBe(true);

    const page2 = await handlers.list_audit_entries({ limit: 2, offset: 2 });
    const data2 = JSON.parse(page2.content[0].text);
    expect(data2.entries).toHaveLength(1);
    expect(data2.total).toBe(3);
    expect(data2.has_more).toBe(false);
    expect(data2.entries[0].toolName).toMatch(/^t[123]$/);
  });

  test('returns empty array with total=0 and has_more=false when no entries match', async () => {
    const config = makeConfig(ctx, { auditLogRepo });
    const handlers = createNodeAgentToolHandlers(config);
    const result = await handlers.list_audit_entries({ task_id: 'nonexistent' });
    const data = JSON.parse(result.content[0].text);

    expect(data.success).toBe(true);
    expect(data.entries).toEqual([]);
    expect(data.total).toBe(0);
    expect(data.has_more).toBe(false);
  });

  test('returns error when auditLogRepo is not available', async () => {
    const config = makeConfig(ctx, { auditLogRepo: undefined });
    const handlers = createNodeAgentToolHandlers(config);
    const result = await handlers.list_audit_entries({});
    const data = JSON.parse(result.content[0].text);

    expect(data.success).toBe(false);
    expect(data.error).toContain('Audit log repository not available');
  });
});

describe('node-agent-tools \u2014 publish_task', () => {
  let ctx: TestCtx;
  beforeEach(() => {
    ctx = makeCtx();
  });
  afterEach(() => {
    ctx.db.close();
  });

  test('publishes a draft task via callback', async () => {
    const draftTask = ctx.taskRepo.createTask({
      spaceId: ctx.spaceId,
      title: 'Draft task',
      description: 'Will publish',
      status: 'draft',
    });

    const onPublishTask = async (args: { task_id: string }) => {
      const updated = await ctx.taskManager.publishTask(args.task_id);
      return jsonResult({ success: true, task: updated });
    };

    const config = makeConfig(ctx, { onPublishTask });
    const handlers = createNodeAgentToolHandlers(config);
    const result = await handlers.publish_task({ task_id: draftTask.id });
    const data = JSON.parse(result.content[0].text);

    expect(data.success).toBe(true);
    expect(data.task.status).toBe('open');
  });

  test('returns error when callback is not available', async () => {
    const config = makeConfig(ctx);
    const handlers = createNodeAgentToolHandlers(config);
    const result = await handlers.publish_task({ task_id: 'any-id' });
    const data = JSON.parse(result.content[0].text);

    expect(data.success).toBe(false);
    expect(data.error).toContain('not available');
  });

  test('returns error when callback fails', async () => {
    const openTask = ctx.taskRepo.createTask({
      spaceId: ctx.spaceId,
      title: 'Open task',
      description: 'Not draft',
      status: 'open',
    });

    const onPublishTask = async (args: { task_id: string }) => {
      try {
        const updated = await ctx.taskManager.publishTask(args.task_id);
        return jsonResult({ success: true, task: updated });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return jsonResult({ success: false, error: message });
      }
    };

    const config = makeConfig(ctx, { onPublishTask });
    const handlers = createNodeAgentToolHandlers(config);
    const result = await handlers.publish_task({ task_id: openTask.id });
    const data = JSON.parse(result.content[0].text);

    expect(data.success).toBe(false);
    expect(data.error).toContain("'open'");
  });
  test('callback emits space.task.updated event after publishing', async () => {
    const draftTask = ctx.taskRepo.createTask({
      spaceId: ctx.spaceId,
      title: 'Draft task',
      description: 'Event emission test',
      status: 'draft',
    });

    const publishedEvents: Array<{
      event: string;
      data: { sessionId: string; spaceId: string; taskId: string };
    }> = [];
    const mockEventBus = {
      publish: async (
        event: string,
        data: { sessionId: string; spaceId: string; taskId: string }
      ) => {
        publishedEvents.push({ event, data });
        return { delivered: 1, failures: [] };
      },
    } as unknown as InternalEventBus<DaemonInternalEventMap>;

    const onPublishTask = async (args: { task_id: string }) => {
      try {
        const updated = await ctx.taskManager.publishTask(args.task_id);
        mockEventBus
          ?.publish('space.task.updated', {
            sessionId: 'global',
            spaceId: ctx.spaceId,
            taskId: updated.id,
            task: updated,
          })
          .catch(() => {});
        return jsonResult({ success: true, task: updated });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return jsonResult({ success: false, error: message });
      }
    };

    const config = makeConfig(ctx, { onPublishTask });
    const handlers = createNodeAgentToolHandlers(config);
    const result = await handlers.publish_task({ task_id: draftTask.id });
    const data = JSON.parse(result.content[0].text);

    expect(data.success).toBe(true);
    expect(data.task.status).toBe('open');
    expect(publishedEvents).toHaveLength(1);
    expect(publishedEvents[0].event).toBe('space.task.updated');
    expect(publishedEvents[0].data.taskId).toBe(draftTask.id);
    expect(publishedEvents[0].data.spaceId).toBe(ctx.spaceId);
    expect(publishedEvents[0].data.sessionId).toBe('global');
  });
});

describe('node-agent-tools \u2014 archive_task', () => {
  let ctx: TestCtx;
  beforeEach(() => {
    ctx = makeCtx();
  });
  afterEach(() => {
    ctx.db.close();
  });

  test('archives a draft task via callback', async () => {
    const draftTask = ctx.taskRepo.createTask({
      spaceId: ctx.spaceId,
      title: 'Draft task',
      description: 'Will archive',
      status: 'draft',
    });

    const onArchiveTask = async (args: { task_id: string }) => {
      const updated = await ctx.taskManager.archiveTask(args.task_id);
      return jsonResult({ success: true, task: updated });
    };

    const config = makeConfig(ctx, { onArchiveTask });
    const handlers = createNodeAgentToolHandlers(config);
    const result = await handlers.archive_task({ task_id: draftTask.id });
    const data = JSON.parse(result.content[0].text);

    expect(data.success).toBe(true);
    expect(data.task.status).toBe('archived');
  });

  test('archives a cancelled task via callback', async () => {
    const task = ctx.taskRepo.createTask({
      spaceId: ctx.spaceId,
      title: 'Task',
      description: 'Will cancel then archive',
      status: 'open',
    });
    await ctx.taskManager.cancelTask(task.id);

    const onArchiveTask = async (args: { task_id: string }) => {
      const updated = await ctx.taskManager.archiveTask(args.task_id);
      return jsonResult({ success: true, task: updated });
    };

    const config = makeConfig(ctx, { onArchiveTask });
    const handlers = createNodeAgentToolHandlers(config);
    const result = await handlers.archive_task({ task_id: task.id });
    const data = JSON.parse(result.content[0].text);

    expect(data.success).toBe(true);
    expect(data.task.status).toBe('archived');
  });

  test('returns error when callback is not available', async () => {
    const config = makeConfig(ctx);
    const handlers = createNodeAgentToolHandlers(config);
    const result = await handlers.archive_task({ task_id: 'any-id' });
    const data = JSON.parse(result.content[0].text);

    expect(data.success).toBe(false);
    expect(data.error).toContain('not available');
  });

  test('returns error when trying to archive an already-archived task', async () => {
    const task = ctx.taskRepo.createTask({
      spaceId: ctx.spaceId,
      title: 'Task',
      description: 'Already archived',
      status: 'draft',
    });
    await ctx.taskManager.archiveTask(task.id);

    const onArchiveTask = async (args: { task_id: string }) => {
      try {
        const updated = await ctx.taskManager.archiveTask(args.task_id);
        return jsonResult({ success: true, task: updated });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return jsonResult({ success: false, error: message });
      }
    };

    const config = makeConfig(ctx, { onArchiveTask });
    const handlers = createNodeAgentToolHandlers(config);
    const result = await handlers.archive_task({ task_id: task.id });
    const data = JSON.parse(result.content[0].text);

    expect(data.success).toBe(false);
    expect(data.error).toContain('archived');
  });
  test('callback emits space.task.updated event after archiving', async () => {
    const task = ctx.taskRepo.createTask({
      spaceId: ctx.spaceId,
      title: 'Draft task',
      description: 'Event emission test',
      status: 'draft',
    });

    const publishedEvents: Array<{
      event: string;
      data: { sessionId: string; spaceId: string; taskId: string };
    }> = [];
    const mockEventBus = {
      publish: async (
        event: string,
        data: { sessionId: string; spaceId: string; taskId: string }
      ) => {
        publishedEvents.push({ event, data });
        return { delivered: 1, failures: [] };
      },
    } as unknown as InternalEventBus<DaemonInternalEventMap>;

    const onArchiveTask = async (args: { task_id: string }) => {
      try {
        const updated = await ctx.taskManager.archiveTask(args.task_id);
        mockEventBus
          ?.publish('space.task.updated', {
            sessionId: 'global',
            spaceId: ctx.spaceId,
            taskId: updated.id,
            task: updated,
          })
          .catch(() => {});
        return jsonResult({ success: true, task: updated });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return jsonResult({ success: false, error: message });
      }
    };

    const config = makeConfig(ctx, { onArchiveTask });
    const handlers = createNodeAgentToolHandlers(config);
    const result = await handlers.archive_task({ task_id: task.id });
    const data = JSON.parse(result.content[0].text);

    expect(data.success).toBe(true);
    expect(data.task.status).toBe('archived');
    expect(publishedEvents).toHaveLength(1);
    expect(publishedEvents[0].event).toBe('space.task.updated');
    expect(publishedEvents[0].data.taskId).toBe(task.id);
    expect(publishedEvents[0].data.spaceId).toBe(ctx.spaceId);
    expect(publishedEvents[0].data.sessionId).toBe('global');
  });

  test('clears pending-completion fields when archiving from review', async () => {
    const task = ctx.taskRepo.createTask({
      spaceId: ctx.spaceId,
      title: 'Review task',
      description: 'Will archive from review',
      status: 'open',
    });
    await ctx.taskManager.startTask(task.id);
    await ctx.taskManager.submitTaskForReview(task.id, {
      submittedByNodeId: null,
      reason: 'Test submission',
    });
    const reviewTask = ctx.taskRepo.getTask(task.id);
    expect(reviewTask?.pendingCheckpointType).toBe('task_completion');

    const onArchiveTask = async (args: { task_id: string }) => {
      const updated = await ctx.taskManager.archiveTask(args.task_id);
      return jsonResult({ success: true, task: updated });
    };

    const config = makeConfig(ctx, { onArchiveTask });
    const handlers = createNodeAgentToolHandlers(config);
    const result = await handlers.archive_task({ task_id: task.id });
    const data = JSON.parse(result.content[0].text);

    expect(data.success).toBe(true);
    expect(data.task.status).toBe('archived');
    expect(data.task.pendingCheckpointType).toBeNull();
    expect(data.task.pendingCompletionSubmittedByNodeId).toBeNull();
  });
});

describe('node-agent-tools: subscribe_pr_events', () => {
  let ctx: TestCtx;

  beforeEach(() => {
    ctx = makeCtx();
  });
  afterEach(() => {
    ctx.db.close();
  });

  test('uses an explicit prUrl arg instead of the run PR', async () => {
    let captured: { topicPattern: string } | null = null;
    const onSubscribeExternalEvent = async (args: SubscribeExternalEventInput) => {
      captured = args;
      return jsonResult({ success: true, topicPattern: args.topicPattern });
    };

    const handlers = createNodeAgentToolHandlers(makeConfig(ctx, { onSubscribeExternalEvent }));
    const result = await handlers.subscribe_pr_events({
      prUrl: 'https://github.com/acme/widgets/pull/999',
    });
    const data = JSON.parse(result.content[0].text);

    expect(data.success).toBe(true);
    expect(captured!.topicPattern).toBe('github/acme/widgets/pull_request/999.*');
  });

  test('errors when no PR URL is resolvable for the run', async () => {
    const onSubscribeExternalEvent = async () => jsonResult({ success: true });
    const handlers = createNodeAgentToolHandlers(makeConfig(ctx, { onSubscribeExternalEvent }));
    const result = await handlers.subscribe_pr_events({});
    const data = JSON.parse(result.content[0].text);

    expect(data.success).toBe(false);
    expect(data.error).toMatch(/No PR URL/i);
  });

  test('errors when an explicit prUrl cannot be parsed', async () => {
    const onSubscribeExternalEvent = async () => jsonResult({ success: true });
    const handlers = createNodeAgentToolHandlers(makeConfig(ctx, { onSubscribeExternalEvent }));
    const result = await handlers.subscribe_pr_events({ prUrl: 'not-a-pr-url' });
    const data = JSON.parse(result.content[0].text);

    expect(data.success).toBe(false);
    expect(data.error).toMatch(/Could not parse/i);
  });

  test('errors when external-event subscriptions are not available', async () => {
    const handlers = createNodeAgentToolHandlers(makeConfig(ctx));
    const result = await handlers.subscribe_pr_events({});
    const data = JSON.parse(result.content[0].text);

    expect(data.success).toBe(false);
    expect(data.error).toMatch(/not available/i);
  });
});

describe('node-agent-tools: pr_url payloads do not auto-subscribe', () => {
  let ctx: TestCtx;

  beforeEach(() => {
    ctx = makeCtx();
  });
  afterEach(() => {
    ctx.db.close();
  });

  test('save_artifact with pr_url succeeds without requiring a subscription callback', async () => {
    const handlers = createNodeAgentToolHandlers(makeConfig(ctx));
    const result = await handlers.save_artifact({
      shape: 'link',
      kind: 'pr',
      data: { url: 'https://github.com/acme/widgets/pull/123' },
    });
    const data = JSON.parse(result.content[0].text);

    expect(data.success).toBe(true);
    const artifacts = ctx.artifactRepo.listByRun(ctx.workflowRunId);
    expect(artifacts).toHaveLength(1);
    expect(artifacts[0]!.data.url).toBe('https://github.com/acme/widgets/pull/123');
  });

  test('send_message with pr_url succeeds without requiring a subscription callback', async () => {
    const delivered: Array<{ sessionId: string; message: string }> = [];
    const config = makeConfig(ctx, {
      channelResolver: makeResolver([makeResolvedChannel('coder', 'reviewer')]),
      messageInjector: async (sessionId, message) => {
        delivered.push({ sessionId, message });
      },
    });
    const handlers = createNodeAgentToolHandlers(config);
    const result = await handlers.send_message({
      target: 'reviewer',
      message: 'PR up for review',
      data: { pr_url: 'https://github.com/acme/widgets/pull/55' },
    });
    const data = JSON.parse(result.content[0].text);

    expect(data.success).toBe(true);
    expect(delivered).toHaveLength(1);
    expect(delivered[0]!.sessionId).toBe(ctx.reviewerSessionId);
  });
});
