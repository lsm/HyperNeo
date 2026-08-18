import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { Database as BunDatabase } from '../../../../src/storage/sqlite-compat';
import { runMigrations } from '../../../../src/storage/schema/index.ts';
import { NodeExecutionRepository } from '../../../../src/storage/repositories/node-execution-repository.ts';
import { SpaceWorkflowRepository } from '../../../../src/storage/repositories/space-workflow-repository.ts';
import { SpaceWorkflowRunRepository } from '../../../../src/storage/repositories/space-workflow-run-repository.ts';
import {
  createNodeAgentToolHandlers,
  type NodeAgentToolsConfig,
} from '../../../../src/lib/space/tools/node-agent-tools.ts';
import { AgentMessageRouter } from '../../../../src/lib/space/runtime/agent-message-router.ts';
import { ChannelResolver } from '../../../../src/lib/space/runtime/channel-resolver.ts';
import type { WorkflowChannel } from '@hyperneo/shared';

const STEP_NODE_ID = 'node-integration-step';

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

function seedTask(
  db: BunDatabase,
  _spaceId: string,
  workflowRunId: string,
  agentName: string,
  sessionId: string | null,
  nodeId: string = STEP_NODE_ID,
  status: 'pending' | 'in_progress' | 'done' | 'blocked' | 'cancelled' = 'in_progress'
): void {
  const repo = new NodeExecutionRepository(db);
  const execution = repo.create({
    workflowRunId,
    workflowNodeId: nodeId,
    agentName,
    agentSessionId: sessionId,
    status,
  });
  repo.update(execution.id, {
    agentSessionId: sessionId,
    status,
  });
}

function seedWorkflowRunWithChannels(
  db: BunDatabase,
  spaceId: string,
  channels: WorkflowChannel[]
): { runId: string; resolver: ChannelResolver } {
  const workflowRepo = new SpaceWorkflowRepository(db);
  const workflow = workflowRepo.createWorkflow({
    spaceId,
    name: `Integration Test Workflow ${Math.random().toString(36).slice(2)}`,
    nodes: [{ name: 'step', agents: [{ agentId: 'agent-1', name: 'agent' }] }],
    completionAutonomyLevel: 3,
  });

  const runRepo = new SpaceWorkflowRunRepository(db);
  const run = runRepo.createRun({
    spaceId,
    workflowId: workflow.id,
    title: 'Integration Test Run',
  });

  return { runId: run.id, resolver: new ChannelResolver(channels) };
}

function makeResolvedChannel(from: string, to: string | string[]): WorkflowChannel {
  return { id: `ch-${from}-${Array.isArray(to) ? to.join('-') : to}`, from, to };
}

interface TestDb {
  db: BunDatabase;
  spaceId: string;
  nodeExecutionRepo: NodeExecutionRepository;
  workflowRunRepo: SpaceWorkflowRunRepository;
  workflowRunId: string;
}

function makeTestDb(): TestDb {
  const db = makeDb();
  const spaceId = `space-${Math.random().toString(36).slice(2)}`;
  seedSpaceRow(db, spaceId);
  const nodeExecutionRepo = new NodeExecutionRepository(db);
  const workflowRunRepo = new SpaceWorkflowRunRepository(db);

  const workflowRepo = new SpaceWorkflowRepository(db);
  const workflow = workflowRepo.createWorkflow({
    spaceId,
    name: 'Integration Test Workflow',
    nodes: [{ name: 'step', agents: [{ agentId: 'agent-1', name: 'agent' }] }],
    completionAutonomyLevel: 3,
  });
  const run = workflowRunRepo.createRun({
    spaceId,
    workflowId: workflow.id,
    title: 'Integration Test Run',
  });

  return {
    db,
    spaceId,
    nodeExecutionRepo,
    workflowRunRepo,
    workflowRunId: run.id,
  };
}

interface InjectedMessage {
  sessionId: string;
  message: string;
  timestamp: number;
}

function makeMessageCapture() {
  const messages: InjectedMessage[] = [];
  const injector = async (sessionId: string, message: string) => {
    messages.push({ sessionId, message, timestamp: Date.now() });
  };
  return { messages, injector };
}

function makeStepConfig(
  tdb: TestDb,
  sessionId: string,
  agentName: string,
  channelResolver: ChannelResolver,
  injector: (sessionId: string, message: string) => Promise<void>
): NodeAgentToolsConfig {
  const agentMessageRouter = new AgentMessageRouter({
    nodeExecutionRepo: tdb.nodeExecutionRepo,
    workflowRunId: tdb.workflowRunId,
    workflowChannels: channelResolver.getChannels(),
    messageInjector: injector,
  });
  return {
    mySessionId: sessionId,
    myAgentName: agentName,
    taskId: 'task-integration-test',
    spaceId: tdb.spaceId,
    channelResolver,
    workflowRunId: tdb.workflowRunId,
    nodeExecutionRepo: tdb.nodeExecutionRepo,
    workflowNodeId: STEP_NODE_ID,
    agentMessageRouter,
  };
}

describe('cross-group isolation', () => {
  let tdb: TestDb;

  beforeEach(() => {
    tdb = makeTestDb();
  });

  afterEach(() => {
    tdb.db.close();
  });

  test('send_message never reaches group B members (group scoping)', async () => {
    const tdbA = makeTestDb();
    const tdbB = makeTestDb();

    try {
      seedTask(tdbA.db, tdbA.spaceId, tdbA.workflowRunId, 'coder', 'session-coder-d');
      seedTask(tdbA.db, tdbA.spaceId, tdbA.workflowRunId, 'reviewer', 'session-reviewer-d');

      seedTask(tdbB.db, tdbB.spaceId, tdbB.workflowRunId, 'coder', 'session-coder-e');
      seedTask(tdbB.db, tdbB.spaceId, tdbB.workflowRunId, 'reviewer', 'session-reviewer-e');

      const { messages, injector } = makeMessageCapture();

      const resolver = new ChannelResolver([
        makeResolvedChannel('coder', 'reviewer'),
        makeResolvedChannel('reviewer', 'coder'),
      ]);

      const config = makeStepConfig(tdbA, 'session-coder-d', 'coder', resolver, injector);
      const handlers = createNodeAgentToolHandlers(config);

      const result = await handlers.send_message({ target: 'reviewer', message: 'review this' });
      const data = JSON.parse(result.content[0].text);

      expect(data.success).toBe(true);
      const deliveredIds = messages.map((m) => m.sessionId);
      expect(deliveredIds).toContain('session-reviewer-d');
      expect(deliveredIds).not.toContain('session-reviewer-e');
      expect(deliveredIds).not.toContain('session-coder-e');
    } finally {
      tdbA.db.close();
      tdbB.db.close();
    }
  });
});

describe('channel direction enforcement', () => {
  let tdb: TestDb;

  beforeEach(() => {
    tdb = makeTestDb();
  });

  afterEach(() => {
    tdb.db.close();
  });

  test('send on declared one-way channel succeeds', async () => {
    seedTask(tdb.db, tdb.spaceId, tdb.workflowRunId, 'coder', 'session-coder');
    seedTask(tdb.db, tdb.spaceId, tdb.workflowRunId, 'reviewer', 'session-reviewer');

    const resolver = new ChannelResolver([makeResolvedChannel('coder', 'reviewer')]);

    const { messages, injector } = makeMessageCapture();
    const config = makeStepConfig(tdb, 'session-coder', 'coder', resolver, injector);
    const handlers = createNodeAgentToolHandlers(config);

    const result = await handlers.send_message({ target: 'reviewer', message: 'please review' });
    const data = JSON.parse(result.content[0].text);

    expect(data.success).toBe(true);
    expect(messages).toHaveLength(1);
    expect(messages[0].sessionId).toBe('session-reviewer');
    expect(messages[0].message).toContain('─── Message from coder ───');
    expect(messages[0].message).toContain('please review');
  });

  test('reverse direction is rejected when only one-way channel declared', async () => {
    seedTask(tdb.db, tdb.spaceId, tdb.workflowRunId, 'coder', 'session-coder');
    seedTask(tdb.db, tdb.spaceId, tdb.workflowRunId, 'reviewer', 'session-reviewer');

    const resolver = new ChannelResolver([makeResolvedChannel('coder', 'reviewer')]);

    const { messages, injector } = makeMessageCapture();
    const config = makeStepConfig(tdb, 'session-reviewer', 'reviewer', resolver, injector);
    const handlers = createNodeAgentToolHandlers(config);

    const result = await handlers.send_message({ target: 'coder', message: 'feedback' });
    const data = JSON.parse(result.content[0].text);

    expect(data.success).toBe(false);
    expect(data.error).toContain('does not permit');
    expect(messages).toHaveLength(0);
  });

  test('no channels declared blocks all send_message calls', async () => {
    seedTask(tdb.db, tdb.spaceId, tdb.workflowRunId, 'coder', 'session-coder');
    seedTask(tdb.db, tdb.spaceId, tdb.workflowRunId, 'reviewer', 'session-reviewer');

    const resolver = new ChannelResolver([]);

    const { messages, injector } = makeMessageCapture();
    const config = makeStepConfig(tdb, 'session-coder', 'coder', resolver, injector);
    const handlers = createNodeAgentToolHandlers(config);

    const result = await handlers.send_message({ target: 'reviewer', message: 'hi' });
    const data = JSON.parse(result.content[0].text);

    expect(data.success).toBe(false);
    expect(data.error).toContain('No channel topology');
    expect(messages).toHaveLength(0);
  });
});

describe('bidirectional point-to-point A↔B', () => {
  let tdb: TestDb;

  beforeEach(() => {
    tdb = makeTestDb();
  });

  afterEach(() => {
    tdb.db.close();
  });

  test('both directions of bidirectional channel deliver correctly', async () => {
    seedTask(tdb.db, tdb.spaceId, tdb.workflowRunId, 'alice', 'session-alice');
    seedTask(tdb.db, tdb.spaceId, tdb.workflowRunId, 'bob', 'session-bob');

    const resolver = new ChannelResolver([
      makeResolvedChannel('alice', 'bob'),
      makeResolvedChannel('bob', 'alice'),
    ]);

    const { messages, injector } = makeMessageCapture();

    const aliceConfig = makeStepConfig(tdb, 'session-alice', 'alice', resolver, injector);
    const aliceHandlers = createNodeAgentToolHandlers(aliceConfig);

    const r1 = await aliceHandlers.send_message({ target: 'bob', message: 'hello bob' });
    const d1 = JSON.parse(r1.content[0].text);
    expect(d1.success).toBe(true);

    const bobConfig = makeStepConfig(tdb, 'session-bob', 'bob', resolver, injector);
    const bobHandlers = createNodeAgentToolHandlers(bobConfig);

    const r2 = await bobHandlers.send_message({ target: 'alice', message: 'hello alice' });
    const d2 = JSON.parse(r2.content[0].text);
    expect(d2.success).toBe(true);

    const aliceReceived = messages.filter((m) => m.sessionId === 'session-alice');
    const bobReceived = messages.filter((m) => m.sessionId === 'session-bob');

    expect(aliceReceived).toHaveLength(1);
    expect(aliceReceived[0].message).toContain('─── Message from bob ───');
    expect(aliceReceived[0].message).toContain('hello alice');

    expect(bobReceived).toHaveLength(1);
    expect(bobReceived[0].message).toContain('─── Message from alice ───');
    expect(bobReceived[0].message).toContain('hello bob');
  });

  test('full A↔B exchange with message attribution', async () => {
    seedTask(tdb.db, tdb.spaceId, tdb.workflowRunId, 'coder', 'session-coder');
    seedTask(tdb.db, tdb.spaceId, tdb.workflowRunId, 'reviewer', 'session-reviewer');

    const resolver = new ChannelResolver([
      makeResolvedChannel('coder', 'reviewer'),
      makeResolvedChannel('reviewer', 'coder'),
    ]);

    const { messages, injector } = makeMessageCapture();

    const coderHandlers = createNodeAgentToolHandlers(
      makeStepConfig(tdb, 'session-coder', 'coder', resolver, injector)
    );
    await coderHandlers.send_message({ target: 'reviewer', message: 'PR ready for review' });

    const reviewerHandlers = createNodeAgentToolHandlers(
      makeStepConfig(tdb, 'session-reviewer', 'reviewer', resolver, injector)
    );
    await reviewerHandlers.send_message({
      target: 'coder',
      message: 'Please fix the type error on line 42',
    });

    await coderHandlers.send_message({ target: 'reviewer', message: 'Fixed — see updated PR' });

    const reviewerMessages = messages.filter((m) => m.sessionId === 'session-reviewer');
    const coderMessages = messages.filter((m) => m.sessionId === 'session-coder');

    expect(reviewerMessages).toHaveLength(2);
    expect(reviewerMessages[0].message).toContain('PR ready for review');
    expect(reviewerMessages[1].message).toContain('Fixed — see updated PR');

    expect(coderMessages).toHaveLength(1);
    expect(coderMessages[0].message).toContain('Please fix the type error on line 42');
  });
});

describe('fan-out one-way A→[B,C,D]', () => {
  let tdb: TestDb;

  beforeEach(() => {
    tdb = makeTestDb();
  });

  afterEach(() => {
    tdb.db.close();
  });

  function setupFanOutTasks(tdb: TestDb) {
    seedTask(tdb.db, tdb.spaceId, tdb.workflowRunId, 'hub', 'session-hub');
    seedTask(tdb.db, tdb.spaceId, tdb.workflowRunId, 'spoke-b', 'session-spoke-b');
    seedTask(tdb.db, tdb.spaceId, tdb.workflowRunId, 'spoke-c', 'session-spoke-c');
    seedTask(tdb.db, tdb.spaceId, tdb.workflowRunId, 'spoke-d', 'session-spoke-d');
  }

  test('hub broadcasts to all spokes via wildcard target', async () => {
    setupFanOutTasks(tdb);

    const resolver = new ChannelResolver([
      makeResolvedChannel('hub', 'spoke-b'),
      makeResolvedChannel('hub', 'spoke-c'),
      makeResolvedChannel('hub', 'spoke-d'),
    ]);

    const { messages, injector } = makeMessageCapture();
    const hubHandlers = createNodeAgentToolHandlers(
      makeStepConfig(tdb, 'session-hub', 'hub', resolver, injector)
    );

    const result = await hubHandlers.send_message({ target: '*', message: 'broadcast task' });
    const data = JSON.parse(result.content[0].text);

    expect(data.success).toBe(true);

    const deliveredIds = messages.map((m) => m.sessionId);
    expect(deliveredIds).toContain('session-spoke-b');
    expect(deliveredIds).toContain('session-spoke-c');
    expect(deliveredIds).toContain('session-spoke-d');
    expect(messages).toHaveLength(3);

    messages.forEach((m) => {
      expect(m.message).toContain('─── Message from hub ───');
      expect(m.message).toContain('broadcast task');
    });
  });

  test('spokes cannot reply to hub when channel is one-way only', async () => {
    setupFanOutTasks(tdb);

    const resolver = new ChannelResolver([
      makeResolvedChannel('hub', 'spoke-b'),
      makeResolvedChannel('hub', 'spoke-c'),
      makeResolvedChannel('hub', 'spoke-d'),
    ]);

    const { messages, injector } = makeMessageCapture();

    const spokeBHandlers = createNodeAgentToolHandlers(
      makeStepConfig(tdb, 'session-spoke-b', 'spoke-b', resolver, injector)
    );

    const result = await spokeBHandlers.send_message({ target: 'hub', message: 'reply' });
    const data = JSON.parse(result.content[0].text);

    expect(data.success).toBe(false);
    expect(data.error).toContain('does not permit');
    expect(messages).toHaveLength(0);
  });

  test('spoke cannot send to sibling spoke in one-way fan-out', async () => {
    setupFanOutTasks(tdb);

    const resolver = new ChannelResolver([
      makeResolvedChannel('hub', 'spoke-b'),
      makeResolvedChannel('hub', 'spoke-c'),
      makeResolvedChannel('hub', 'spoke-d'),
    ]);

    const { messages, injector } = makeMessageCapture();

    const spokeBHandlers = createNodeAgentToolHandlers(
      makeStepConfig(tdb, 'session-spoke-b', 'spoke-b', resolver, injector)
    );

    const result = await spokeBHandlers.send_message({
      target: 'spoke-c',
      message: 'cross-spoke message',
    });
    const data = JSON.parse(result.content[0].text);

    expect(data.success).toBe(false);
    expect(data.error).toContain('does not permit');
    expect(messages).toHaveLength(0);
  });

  test('explicit multicast to subset of spokes', async () => {
    setupFanOutTasks(tdb);

    const resolver = new ChannelResolver([
      makeResolvedChannel('hub', 'spoke-b'),
      makeResolvedChannel('hub', 'spoke-c'),
      makeResolvedChannel('hub', 'spoke-d'),
    ]);

    const { messages, injector } = makeMessageCapture();
    const hubHandlers = createNodeAgentToolHandlers(
      makeStepConfig(tdb, 'session-hub', 'hub', resolver, injector)
    );

    const result = await hubHandlers.send_message({
      target: ['spoke-b', 'spoke-c'],
      message: 'targeted broadcast',
    });
    const data = JSON.parse(result.content[0].text);

    expect(data.success).toBe(true);
    const deliveredIds = messages.map((m) => m.sessionId);
    expect(deliveredIds).toContain('session-spoke-b');
    expect(deliveredIds).toContain('session-spoke-c');
    expect(deliveredIds).not.toContain('session-spoke-d');
  });
});

describe('hub-spoke bidirectional A↔[B,C,D]', () => {
  let tdb: TestDb;

  beforeEach(() => {
    tdb = makeTestDb();
  });

  afterEach(() => {
    tdb.db.close();
  });

  function setupHubSpokeTasks(tdb: TestDb) {
    seedTask(tdb.db, tdb.spaceId, tdb.workflowRunId, 'lead', 'session-lead');
    seedTask(tdb.db, tdb.spaceId, tdb.workflowRunId, 'worker-b', 'session-worker-b');
    seedTask(tdb.db, tdb.spaceId, tdb.workflowRunId, 'worker-c', 'session-worker-c');
    seedTask(tdb.db, tdb.spaceId, tdb.workflowRunId, 'worker-d', 'session-worker-d');
  }

  test('(a) hub broadcasts to all spokes', async () => {
    setupHubSpokeTasks(tdb);

    const resolver = new ChannelResolver([
      makeResolvedChannel('lead', 'worker-b', true),
      makeResolvedChannel('lead', 'worker-c', true),
      makeResolvedChannel('lead', 'worker-d', true),
      makeResolvedChannel('worker-b', 'lead', true),
      makeResolvedChannel('worker-c', 'lead', true),
      makeResolvedChannel('worker-d', 'lead', true),
    ]);

    const { messages, injector } = makeMessageCapture();
    const leadHandlers = createNodeAgentToolHandlers(
      makeStepConfig(tdb, 'session-lead', 'lead', resolver, injector)
    );

    const result = await leadHandlers.send_message({
      target: '*',
      message: 'assigned tasks to all workers',
    });
    const data = JSON.parse(result.content[0].text);

    expect(data.success).toBe(true);
    expect(messages).toHaveLength(3);

    const deliveredIds = messages.map((m) => m.sessionId);
    expect(deliveredIds).toContain('session-worker-b');
    expect(deliveredIds).toContain('session-worker-c');
    expect(deliveredIds).toContain('session-worker-d');
  });

  test('(b) each spoke independently replies to hub', async () => {
    setupHubSpokeTasks(tdb);

    const resolver = new ChannelResolver([
      makeResolvedChannel('lead', 'worker-b', true),
      makeResolvedChannel('lead', 'worker-c', true),
      makeResolvedChannel('lead', 'worker-d', true),
      makeResolvedChannel('worker-b', 'lead', true),
      makeResolvedChannel('worker-c', 'lead', true),
      makeResolvedChannel('worker-d', 'lead', true),
    ]);

    const { messages, injector } = makeMessageCapture();

    const workerBHandlers = createNodeAgentToolHandlers(
      makeStepConfig(tdb, 'session-worker-b', 'worker-b', resolver, injector)
    );
    const r1 = await workerBHandlers.send_message({ target: 'lead', message: 'worker-b done' });
    expect(JSON.parse(r1.content[0].text).success).toBe(true);

    const workerCHandlers = createNodeAgentToolHandlers(
      makeStepConfig(tdb, 'session-worker-c', 'worker-c', resolver, injector)
    );
    const r2 = await workerCHandlers.send_message({ target: 'lead', message: 'worker-c done' });
    expect(JSON.parse(r2.content[0].text).success).toBe(true);

    const workerDHandlers = createNodeAgentToolHandlers(
      makeStepConfig(tdb, 'session-worker-d', 'worker-d', resolver, injector)
    );
    const r3 = await workerDHandlers.send_message({ target: 'lead', message: 'worker-d done' });
    expect(JSON.parse(r3.content[0].text).success).toBe(true);

    const leadMessages = messages.filter((m) => m.sessionId === 'session-lead');
    expect(leadMessages).toHaveLength(3);

    const contents = leadMessages.map((m) => m.message);
    expect(contents.some((c) => c.includes('worker-b done'))).toBe(true);
    expect(contents.some((c) => c.includes('worker-c done'))).toBe(true);
    expect(contents.some((c) => c.includes('worker-d done'))).toBe(true);
  });

  test('(c) spoke B→spoke C is rejected (spoke isolation)', async () => {
    setupHubSpokeTasks(tdb);

    const resolver = new ChannelResolver([
      makeResolvedChannel('lead', 'worker-b', true),
      makeResolvedChannel('lead', 'worker-c', true),
      makeResolvedChannel('lead', 'worker-d', true),
      makeResolvedChannel('worker-b', 'lead', true),
      makeResolvedChannel('worker-c', 'lead', true),
      makeResolvedChannel('worker-d', 'lead', true),
    ]);

    const { messages, injector } = makeMessageCapture();

    const workerBHandlers = createNodeAgentToolHandlers(
      makeStepConfig(tdb, 'session-worker-b', 'worker-b', resolver, injector)
    );

    const result = await workerBHandlers.send_message({
      target: 'worker-c',
      message: 'cross-spoke attempt',
    });
    const data = JSON.parse(result.content[0].text);

    expect(data.success).toBe(false);
    expect(data.error).toContain('does not permit');
    expect(messages).toHaveLength(0);
  });

  test('hub ↔ spokes complete exchange: assign → reply → follow-up', async () => {
    setupHubSpokeTasks(tdb);

    const resolver = new ChannelResolver([
      makeResolvedChannel('lead', 'worker-b', true),
      makeResolvedChannel('lead', 'worker-c', true),
      makeResolvedChannel('lead', 'worker-d', true),
      makeResolvedChannel('worker-b', 'lead', true),
      makeResolvedChannel('worker-c', 'lead', true),
      makeResolvedChannel('worker-d', 'lead', true),
    ]);

    const { messages, injector } = makeMessageCapture();

    const leadHandlers = createNodeAgentToolHandlers(
      makeStepConfig(tdb, 'session-lead', 'lead', resolver, injector)
    );
    const workerBHandlers = createNodeAgentToolHandlers(
      makeStepConfig(tdb, 'session-worker-b', 'worker-b', resolver, injector)
    );

    await leadHandlers.send_message({ target: '*', message: 'start your tasks' });

    await workerBHandlers.send_message({ target: 'lead', message: 'task complete' });

    await leadHandlers.send_message({ target: 'worker-b', message: 'great work, merge it' });

    const workerBInbox = messages.filter((m) => m.sessionId === 'session-worker-b');
    const leadInbox = messages.filter((m) => m.sessionId === 'session-lead');

    expect(workerBInbox).toHaveLength(2);
    expect(workerBInbox[0].message).toContain('start your tasks');
    expect(workerBInbox[1].message).toContain('great work, merge it');

    expect(leadInbox).toHaveLength(1);
    expect(leadInbox[0].message).toContain('task complete');
  });
});

describe('concurrent message injection — both messages delivered', () => {
  let tdb: TestDb;

  beforeEach(() => {
    tdb = makeTestDb();
  });

  afterEach(() => {
    tdb.db.close();
  });

  test('two agents injecting to same target simultaneously delivers both messages', async () => {
    seedTask(tdb.db, tdb.spaceId, tdb.workflowRunId, 'sender-a', 'session-sender-a');
    seedTask(tdb.db, tdb.spaceId, tdb.workflowRunId, 'sender-b', 'session-sender-b');
    seedTask(tdb.db, tdb.spaceId, tdb.workflowRunId, 'target', 'session-target');

    const resolver = new ChannelResolver([
      makeResolvedChannel('sender-a', 'target'),
      makeResolvedChannel('sender-b', 'target'),
    ]);

    const { messages, injector } = makeMessageCapture();

    const senderAHandlers = createNodeAgentToolHandlers(
      makeStepConfig(tdb, 'session-sender-a', 'sender-a', resolver, injector)
    );
    const senderBHandlers = createNodeAgentToolHandlers(
      makeStepConfig(tdb, 'session-sender-b', 'sender-b', resolver, injector)
    );

    const [rA, rB] = await Promise.all([
      senderAHandlers.send_message({ target: 'target', message: 'message from A' }),
      senderBHandlers.send_message({ target: 'target', message: 'message from B' }),
    ]);

    expect(JSON.parse(rA.content[0].text).success).toBe(true);
    expect(JSON.parse(rB.content[0].text).success).toBe(true);

    const targetMessages = messages.filter((m) => m.sessionId === 'session-target');
    expect(targetMessages).toHaveLength(2);

    const contents = targetMessages.map((m) => m.message);
    expect(contents.some((c) => c.includes('message from A'))).toBe(true);
    expect(contents.some((c) => c.includes('message from B'))).toBe(true);
  });

  test('concurrent injections into different targets do not interfere', async () => {
    seedTask(tdb.db, tdb.spaceId, tdb.workflowRunId, 'hub-c', 'session-hub-c');
    seedTask(tdb.db, tdb.spaceId, tdb.workflowRunId, 'spoke-x', 'session-spoke-x');
    seedTask(tdb.db, tdb.spaceId, tdb.workflowRunId, 'spoke-y', 'session-spoke-y');

    const resolver = new ChannelResolver([
      makeResolvedChannel('hub-c', 'spoke-x'),
      makeResolvedChannel('hub-c', 'spoke-y'),
    ]);

    const { messages, injector } = makeMessageCapture();

    const hubHandlers = createNodeAgentToolHandlers(
      makeStepConfig(tdb, 'session-hub-c', 'hub-c', resolver, injector)
    );

    const [r1, r2] = await Promise.all([
      hubHandlers.send_message({ target: 'spoke-x', message: 'task for X' }),
      hubHandlers.send_message({ target: 'spoke-y', message: 'task for Y' }),
    ]);

    expect(JSON.parse(r1.content[0].text).success).toBe(true);
    expect(JSON.parse(r2.content[0].text).success).toBe(true);

    const spokeXMessages = messages.filter((m) => m.sessionId === 'session-spoke-x');
    const spokeYMessages = messages.filter((m) => m.sessionId === 'session-spoke-y');

    expect(spokeXMessages).toHaveLength(1);
    expect(spokeXMessages[0].message).toContain('task for X');
    expect(spokeYMessages).toHaveLength(1);
    expect(spokeYMessages[0].message).toContain('task for Y');
  });
});

describe('data reload and DB-based validation', () => {
  let tdb: TestDb;

  beforeEach(() => {
    tdb = makeTestDb();
  });

  afterEach(() => {
    tdb.db.close();
  });

  test('channel topology resolves correctly after workflow run re-fetch', async () => {
    const { runId: workflowRunId, resolver } = seedWorkflowRunWithChannels(tdb.db, tdb.spaceId, [
      makeResolvedChannel('coder', 'reviewer'),
      makeResolvedChannel('reviewer', 'coder'),
    ]);

    const freshRunRepo = new SpaceWorkflowRunRepository(tdb.db);
    const reloadedRun = freshRunRepo.getRun(workflowRunId);

    expect(reloadedRun).not.toBeNull();

    expect(resolver.isEmpty()).toBe(false);
    expect(resolver.canSend('coder', 'reviewer')).toBe(true);
    expect(resolver.canSend('reviewer', 'coder')).toBe(true);
    expect(resolver.canSend('coder', 'tester')).toBe(false);
  });

  test('send_message works correctly with a resolver built from workflow channel data', async () => {
    seedTask(tdb.db, tdb.spaceId, tdb.workflowRunId, 'coder', 'session-coder-rs');
    seedTask(tdb.db, tdb.spaceId, tdb.workflowRunId, 'reviewer', 'session-reviewer-rs');

    const channelResolver = new ChannelResolver([makeResolvedChannel('coder', 'reviewer')]);

    const { messages, injector } = makeMessageCapture();

    const freshNodeExecutionRepo = new NodeExecutionRepository(tdb.db);
    const agentMessageRouter = new AgentMessageRouter({
      nodeExecutionRepo: freshNodeExecutionRepo,
      workflowRunId: tdb.workflowRunId,
      workflowChannels: channelResolver.getChannels(),
      messageInjector: injector,
    });
    const config: NodeAgentToolsConfig = {
      mySessionId: 'session-coder-rs',
      myAgentName: 'coder',
      taskId: 'task-reload-send',
      spaceId: tdb.spaceId,
      channelResolver,
      workflowRunId: tdb.workflowRunId,
      nodeExecutionRepo: freshNodeExecutionRepo,
      workflowNodeId: STEP_NODE_ID,
      agentMessageRouter,
    };

    const handlers = createNodeAgentToolHandlers(config);
    const result = await handlers.send_message({
      target: 'reviewer',
      message: 'post-reload check',
    });
    const data = JSON.parse(result.content[0].text);

    expect(data.success).toBe(true);
    expect(messages).toHaveLength(1);
    expect(messages[0].sessionId).toBe('session-reviewer-rs');
    expect(messages[0].message).toContain('post-reload check');
  });

  test('node executions are still accessible after fresh repository over same DB', async () => {
    seedTask(tdb.db, tdb.spaceId, tdb.workflowRunId, 'coder', 'session-coder-reload');
    seedTask(tdb.db, tdb.spaceId, tdb.workflowRunId, 'reviewer', 'session-reviewer-reload');

    const freshRepo = new NodeExecutionRepository(tdb.db);
    const executions = freshRepo
      .listByWorkflowRun(tdb.workflowRunId)
      .filter((e) => e.agentSessionId);

    expect(executions.length).toBe(2);
    const sessionIds = executions.map((e) => e.agentSessionId);
    expect(sessionIds).toContain('session-coder-reload');
    expect(sessionIds).toContain('session-reviewer-reload');
  });
});

describe('error paths — missing workflowRunId', () => {
  let tdb: TestDb;

  beforeEach(() => {
    tdb = makeTestDb();
  });

  afterEach(() => {
    tdb.db.close();
  });

  test('send_message fails with no-active-sessions when workflowRunId is empty', async () => {
    const { messages, injector } = makeMessageCapture();
    const channelResolver = new ChannelResolver([makeResolvedChannel('coder', 'reviewer')]);
    const agentMessageRouter = new AgentMessageRouter({
      nodeExecutionRepo: tdb.nodeExecutionRepo,
      workflowRunId: '',
      workflowChannels: channelResolver.getChannels(),
      messageInjector: injector,
    });

    const config: NodeAgentToolsConfig = {
      mySessionId: 'session-coder-norun',
      myAgentName: 'coder',
      taskId: 'task-norun',
      spaceId: tdb.spaceId,
      channelResolver,
      workflowRunId: '',
      nodeExecutionRepo: tdb.nodeExecutionRepo,
      workflowNodeId: STEP_NODE_ID,
      agentMessageRouter,
    };

    const handlers = createNodeAgentToolHandlers(config);
    const result = await handlers.send_message({ target: 'reviewer', message: 'hello' });
    const data = JSON.parse(result.content[0].text);

    expect(data.success).toBe(false);
    expect((data.error as string).toLowerCase()).toContain('could not deliver');
    expect((data.error as string).toLowerCase()).toContain('reviewer');
    expect(messages).toHaveLength(0);
  });

  test('list_peers returns empty peers when workflowRunId is empty', async () => {
    const channelResolver = new ChannelResolver([]);
    const config: NodeAgentToolsConfig = {
      mySessionId: 'session-coder-norun',
      myAgentName: 'coder',
      taskId: 'task-norun',
      spaceId: tdb.spaceId,
      channelResolver,
      workflowRunId: '',
      nodeExecutionRepo: tdb.nodeExecutionRepo,
      workflowNodeId: STEP_NODE_ID,
      agentMessageRouter: new AgentMessageRouter({
        nodeExecutionRepo: tdb.nodeExecutionRepo,
        workflowRunId: '',
        workflowChannels: channelResolver.getChannels(),
        messageInjector: async () => {},
      }),
    };

    const handlers = createNodeAgentToolHandlers(config);
    const result = await handlers.list_peers({});
    const data = JSON.parse(result.content[0].text);

    expect(data.success).toBe(true);
    expect((data.peers as unknown[]).length).toBe(0);
  });
});

describe('Task Agent channel participation', () => {
  let tdb: TestDb;

  beforeEach(() => {
    tdb = makeTestDb();
  });

  afterEach(() => {
    tdb.db.close();
  });

  test('ChannelResolver: canSend returns true when coder→task-agent channel declared', async () => {
    const { resolver } = seedWorkflowRunWithChannels(tdb.db, tdb.spaceId, [
      makeResolvedChannel('coder', 'task-agent'),
    ]);

    expect(resolver.canSend('coder', 'task-agent')).toBe(true);
  });

  test('ChannelResolver: canSend returns false when no channel to task-agent', async () => {
    const { resolver } = seedWorkflowRunWithChannels(tdb.db, tdb.spaceId, [
      makeResolvedChannel('coder', 'reviewer'),
    ]);

    expect(resolver.canSend('coder', 'task-agent')).toBe(false);
  });

  test('ChannelResolver: getPermittedTargets includes task-agent when channel declared', async () => {
    const { resolver } = seedWorkflowRunWithChannels(tdb.db, tdb.spaceId, [
      makeResolvedChannel('reviewer', 'task-agent'),
    ]);

    const permitted = resolver.getPermittedTargets('reviewer');
    expect(permitted).toContain('task-agent');
  });

  test('ChannelResolver: task-agent permittedTargets includes coder when task-agent→coder declared', async () => {
    const { resolver } = seedWorkflowRunWithChannels(tdb.db, tdb.spaceId, [
      makeResolvedChannel('task-agent', 'coder'),
    ]);

    const permitted = resolver.getPermittedTargets('task-agent');
    expect(permitted).toContain('coder');
  });

  test('send_message to task-agent fails when no taskAgentRouter is injected', async () => {
    seedTask(tdb.db, tdb.spaceId, tdb.workflowRunId, 'coder', 'session-coder');

    const resolver = new ChannelResolver([makeResolvedChannel('coder', 'task-agent')]);

    const { messages, injector } = makeMessageCapture();
    const config = makeStepConfig(tdb, 'session-coder', 'coder', resolver, injector);
    const handlers = createNodeAgentToolHandlers(config);

    const result = await handlers.send_message({ target: 'task-agent', message: 'Hello TA' });
    const data = JSON.parse(result.content[0].text);

    expect(data.success).toBe(false);
    expect((data.error as string).toLowerCase()).toContain('could not deliver');
    expect((data.error as string).toLowerCase()).toContain('task-agent');
    expect(messages).toHaveLength(0);
  });

  test('list_peers includes task-agent when task-agent task is seeded', async () => {
    seedTask(tdb.db, tdb.spaceId, tdb.workflowRunId, 'coder', 'session-coder');
    seedTask(tdb.db, tdb.spaceId, tdb.workflowRunId, 'task-agent', 'session-task-agent');

    const resolver = new ChannelResolver([makeResolvedChannel('coder', 'task-agent')]);

    const config = makeStepConfig(tdb, 'session-coder', 'coder', resolver, async () => {});
    const handlers = createNodeAgentToolHandlers(config);

    const result = await handlers.list_peers({});
    const data = JSON.parse(result.content[0].text);

    expect(data.success).toBe(true);
    const peers = data.peers as Array<{ sessionId: string; agentName: string }>;
    const peerIds = peers.map((p: { sessionId: string }) => p.sessionId);
    expect(peerIds).toContain('session-task-agent');
    expect(peerIds).not.toContain('session-coder');
  });

  test('removing channel to task-agent updates getPermittedTargets', async () => {
    const { resolver: resolverWith } = seedWorkflowRunWithChannels(tdb.db, tdb.spaceId, [
      makeResolvedChannel('coder', 'task-agent'),
    ]);

    expect(resolverWith.getPermittedTargets('coder')).toContain('task-agent');

    const resolverEmpty = new ChannelResolver([]);
    expect(resolverEmpty.getPermittedTargets('coder')).not.toContain('task-agent');
  });
});
