import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, mock } from 'bun:test';
import type { SDKUserMessage } from '@hyperneo/shared/sdk';
import type { AgentSession } from '../../../../src/lib/agent/agent-session.ts';
import { formatAgentMessage } from '../../../../src/lib/space/agent-message-envelope';
import { TaskAgentManager } from '../../../../src/lib/space/runtime/task-agent-manager';
import type { TaskAgentManagerConfig } from '../../../../src/lib/space/runtime/task-agent-manager';
import { formatPendingRowForNodeAgent } from '../../../../src/lib/space/runtime/pending-envelope';
import { NodeExecutionRepository } from '../../../../src/storage/repositories/node-execution-repository';
import type { PendingAgentMessageRecord } from '../../../../src/storage/repositories/pending-agent-message-repository';
import { PendingAgentMessageRepository } from '../../../../src/storage/repositories/pending-agent-message-repository';
import { SpaceRepository } from '../../../../src/storage/repositories/space-repository';
import { SpaceTaskRepository } from '../../../../src/storage/repositories/space-task-repository';
import { SpaceWorkflowRunRepository } from '../../../../src/storage/repositories/space-workflow-run-repository';
import { Database } from '../../../../src/storage/sqlite-compat';
import { createTestDb, createTestSession } from '../../../helpers/database';
import { createSpaceTables } from '../../helpers/space-test-db';

const NODE_ID = 'node-build';
const NODE_NAME = 'Build';
const AGENT_NAME = 'coder';
const SESSION_ID = 'sub-session-coder';
const ORPHAN_SESSION_ID = 'sub-session-orphan';
const WORKFLOW_ID = 'wf-drain';

interface SpyRepo {
  repo: PendingAgentMessageRepository;
  spy: Record<string, unknown>;
  calls: string[];
  retentionArgs: unknown[][];
  expireArgs: unknown[][];
  listCalls: [string, string | null | undefined][];
}

function spyPendingRepo(repo: PendingAgentMessageRepository): SpyRepo {
  const calls: string[] = [];
  const retentionArgs: unknown[][] = [];
  const expireArgs: unknown[][] = [];
  const listCalls: [string, string | null | undefined][] = [];
  const spy = {
    enforceRetention: (options: { runId?: string | null }) => {
      calls.push('enforceRetention');
      retentionArgs.push([options]);
      return repo.enforceRetention(options);
    },
    expireStale: (runId: string) => {
      calls.push('expireStale');
      expireArgs.push([runId]);
      return repo.expireStale(runId);
    },
    listPendingForTarget: (
      runId: string,
      targetName: string,
      workflowNodeId?: string | null
    ): PendingAgentMessageRecord[] => {
      calls.push(`list:${targetName}${workflowNodeId != null ? `@${workflowNodeId}` : ''}`);
      listCalls.push([targetName, workflowNodeId ?? null]);
      return repo.listPendingForTarget(runId, targetName, workflowNodeId);
    },
    getById: (id: string) => repo.getById(id),
    deferExpiration: (ids: string[], ttlMs?: number) => {
      calls.push(`defer:${ids.join(',')}`);
      repo.deferExpiration(ids, ttlMs);
    },
    listByRunAndStatus: (runId: string, status: string) => repo.listByRunAndStatus(runId, status),
    recordDeliveryAttempt: (id: string, error: string | null) =>
      repo.recordDeliveryAttempt(id, error),
    recordDeliveryError: (id: string, error: string | null) => repo.recordDeliveryError(id, error),
    markFailed: (id: string, error: string) => repo.markFailed(id, error),
    markDelivered: (id: string, sessionId: string) => {
      calls.push(`delivered:${id}`);
      repo.markDelivered(id, sessionId);
    },
    markAttemptFailed: (id: string, error: string) => {
      calls.push(`attemptFailed:${id}`);
      return repo.markAttemptFailed(id, error);
    },
  };
  return { repo, spy, calls, retentionArgs, expireArgs, listCalls };
}

interface EnqueueOverrides {
  sourceAgentName?: string;
  targetKind?: 'node_agent' | 'space_agent';
  targetAgentName?: string;
  message?: string;
  workflowNodeId?: string | null;
  taskId?: string | null;
  deliveryMode?: 'immediate' | 'defer';
}

interface RealDbHarness {
  manager: TaskAgentManager;
  spyRepo: SpyRepo;
  injectMock: ReturnType<typeof mock>;
  publish: ReturnType<typeof mock>;
  db: Database;
  runId: string;
  spaceId: string;
  executionId: string;
  enqueue: (overrides?: EnqueueOverrides) => PendingAgentMessageRecord;
}

function makeRealDbHarness(): RealDbHarness {
  const db = new Database(':memory:');
  createSpaceTables(db);
  const spaceRepo = new SpaceRepository(
    db as unknown as Parameters<typeof SpaceRepository.prototype.constructor>[0]
  );
  const runRepo = new SpaceWorkflowRunRepository(
    db as unknown as Parameters<typeof SpaceWorkflowRunRepository.prototype.constructor>[0]
  );
  const nodeExecutionRepo = new NodeExecutionRepository(
    db as unknown as Parameters<typeof NodeExecutionRepository.prototype.constructor>[0]
  );
  const taskRepo = new SpaceTaskRepository(
    db as unknown as Parameters<typeof SpaceTaskRepository.prototype.constructor>[0]
  );
  const space = spaceRepo.createSpace({ workspacePath: '/w', slug: 's', name: 'S' });
  const now = Date.now();
  (db as unknown as { prepare: (sql: string) => { run: (...args: unknown[]) => void } })
    .prepare(
      `INSERT INTO space_workflows (id, space_id, name, created_at, updated_at) VALUES (?, ?, ?, ?, ?)`
    )
    .run(WORKFLOW_ID, space.id, 'WF', now, now);
  const run = runRepo.createRun({ spaceId: space.id, workflowId: WORKFLOW_ID, title: 'R' });
  const exec = nodeExecutionRepo.create({
    workflowRunId: run.id,
    workflowNodeId: NODE_ID,
    agentName: AGENT_NAME,
    agentSessionId: SESSION_ID,
    status: 'in_progress',
  });

  const spyRepo = spyPendingRepo(
    new PendingAgentMessageRepository(
      db as unknown as Parameters<typeof PendingAgentMessageRepository.prototype.constructor>[0]
    )
  );
  const publish = mock(async (_event: string, _payload: unknown) => {});
  const injectMock = mock(async (...args: unknown[]) => (args[6] as string) ?? 'injected');
  const workflow = { nodes: [{ id: NODE_ID, name: NODE_NAME }] };

  const manager = new TaskAgentManager({
    db: { getDatabase: () => db },
    taskRepo,
    workflowRunRepo: runRepo,
    nodeExecutionRepo,
    pendingMessageRepo: spyRepo.spy,
    internalEventBus: { subscribe: mock(() => () => {}), publish },
    spaceWorkflowManager: {
      getWorkflow: () => workflow,
      getWorkflowForRun: () => workflow,
    },
  } as unknown as TaskAgentManagerConfig);
  (
    manager as unknown as {
      injectSubSessionMessage: (...args: unknown[]) => Promise<string>;
    }
  ).injectSubSessionMessage = injectMock;

  return {
    manager,
    spyRepo,
    injectMock,
    publish,
    db,
    runId: run.id,
    spaceId: space.id,
    executionId: exec.id,
    enqueue: (overrides = {}) =>
      spyRepo.repo.enqueue({
        workflowRunId: run.id,
        spaceId: space.id,
        sourceAgentName: 'reviewer',
        targetKind: 'node_agent',
        targetAgentName: AGENT_NAME,
        message: 'queued note',
        ...overrides,
      }).record,
  };
}

function makeRecord(overrides: Partial<PendingAgentMessageRecord> = {}): PendingAgentMessageRecord {
  return {
    id: 'row-1',
    workflowRunId: 'run-mock',
    spaceId: 'space-mock',
    taskId: null,
    sourceAgentName: 'reviewer',
    targetKind: 'node_agent',
    targetAgentName: AGENT_NAME,
    message: 'queued note',
    workflowNodeId: null,
    idempotencyKey: null,
    attempts: 0,
    maxAttempts: 5,
    lastAttemptAt: null,
    lastError: null,
    status: 'pending',
    deliveredAt: null,
    deliveredSessionId: null,
    expiresAt: Number.MAX_SAFE_INTEGER,
    createdAt: 1,
    deliveryMode: null,
    ...overrides,
  };
}

function makeMockRepoManager(repo: {
  enforceRetention: ReturnType<typeof mock>;
  expireStale: ReturnType<typeof mock>;
  listPendingForTarget: ReturnType<typeof mock>;
  markDelivered: ReturnType<typeof mock>;
  markAttemptFailed: ReturnType<typeof mock>;
}): { manager: TaskAgentManager; injectMock: ReturnType<typeof mock> } {
  const injectMock = mock(async (...args: unknown[]) => (args[6] as string) ?? 'injected');
  const execution = {
    id: 'exec-mock',
    workflowRunId: 'run-mock',
    workflowNodeId: NODE_ID,
    agentName: AGENT_NAME,
    agentSessionId: SESSION_ID,
    status: 'in_progress',
    createdAt: 1,
    updatedAt: 1,
  };
  const workflow = { nodes: [{ id: NODE_ID, name: NODE_NAME }] };
  const manager = new TaskAgentManager({
    db: { getDatabase: () => ({}) },
    nodeExecutionRepo: {
      getByAgentSessionId: mock(() => execution),
      listByAgentSessionId: mock(() => [execution]),
      getById: mock(() => null),
      touchLastActivity: mock(() => {}),
    },
    workflowRunRepo: { getRun: mock(() => ({ workflowId: WORKFLOW_ID })) },
    spaceWorkflowManager: { getWorkflow: () => workflow, getWorkflowForRun: () => workflow },
    pendingMessageRepo: repo,
    internalEventBus: { subscribe: mock(() => () => {}), publish: mock(async () => {}) },
  } as unknown as TaskAgentManagerConfig);
  (
    manager as unknown as {
      injectSubSessionMessage: (...args: unknown[]) => Promise<string>;
    }
  ).injectSubSessionMessage = injectMock;
  return { manager, injectMock };
}

describe('flushPendingMessagesForTarget — drain admission', () => {
  let h: RealDbHarness;
  beforeEach(() => {
    h = makeRealDbHarness();
  });
  afterEach(() => {
    h.db.close();
  });

  it('drains only node_agent rows and leaves space_agent rows pending', async () => {
    const agentRow = h.enqueue({ message: 'agent note' });
    const spaceRow = h.enqueue({ targetKind: 'space_agent', message: 'space note' });

    await h.manager.flushPendingMessagesForTarget(h.runId, AGENT_NAME, SESSION_ID);

    expect(h.injectMock).toHaveBeenCalledTimes(1);
    expect(h.injectMock.mock.calls[0][1] as string).toContain('agent note');
    expect(h.spyRepo.repo.getById(agentRow.id)?.status).toBe('delivered');
    expect(h.spyRepo.repo.getById(spaceRow.id)?.status).toBe('pending');
  });

  it('drains the workflow-node alias queue when the session has an execution on a named node', async () => {
    const aliasRow = h.enqueue({
      targetAgentName: `${NODE_NAME}/${AGENT_NAME}`,
      workflowNodeId: NODE_ID,
      message: 'alias note',
    });

    await h.manager.flushPendingMessagesForTarget(h.runId, AGENT_NAME, SESSION_ID);

    expect(h.spyRepo.listCalls).toEqual([
      [AGENT_NAME, NODE_ID],
      [`${NODE_NAME}/${AGENT_NAME}`, NODE_ID],
    ]);
    expect(h.injectMock).toHaveBeenCalledTimes(1);
    expect(h.spyRepo.repo.getById(aliasRow.id)?.status).toBe('delivered');
  });

  it('node-scoped drain admits run-scoped rows but excludes rows scoped to another node', async () => {
    const sameNode = h.enqueue({ workflowNodeId: NODE_ID, message: 'same node' });
    const runScoped = h.enqueue({ workflowNodeId: null, message: 'run scoped' });
    const otherNode = h.enqueue({ workflowNodeId: 'node-review', message: 'other node' });

    await h.manager.flushPendingMessagesForTarget(h.runId, AGENT_NAME, SESSION_ID);

    expect(h.spyRepo.repo.getById(sameNode.id)?.status).toBe('delivered');
    expect(h.spyRepo.repo.getById(runScoped.id)?.status).toBe('delivered');
    expect(h.spyRepo.repo.getById(otherNode.id)?.status).toBe('pending');
    expect(h.injectMock).toHaveBeenCalledTimes(2);
  });

  it('executionless drain lists run-scoped only and admits just workflowNodeId-null rows', async () => {
    const runScoped = h.enqueue({ workflowNodeId: null, message: 'run scoped' });
    const nodeScoped = h.enqueue({ workflowNodeId: NODE_ID, message: 'node scoped' });
    const aliasRow = h.enqueue({
      targetAgentName: `${NODE_NAME}/${AGENT_NAME}`,
      workflowNodeId: NODE_ID,
      message: 'alias note',
    });

    await h.manager.flushPendingMessagesForTarget(h.runId, AGENT_NAME, ORPHAN_SESSION_ID);

    expect(h.spyRepo.listCalls).toEqual([[AGENT_NAME, null]]);
    expect(h.spyRepo.repo.getById(runScoped.id)?.status).toBe('delivered');
    expect(h.spyRepo.repo.getById(nodeScoped.id)?.status).toBe('pending');
    expect(h.spyRepo.repo.getById(aliasRow.id)?.status).toBe('pending');
    expect(h.injectMock).toHaveBeenCalledTimes(1);
  });

  it('dedups rows returned by both the bare-name and alias listings', async () => {
    const row = makeRecord({ id: 'row-dup', message: 'dup note' });
    const repo = {
      enforceRetention: mock(() => 0),
      expireStale: mock(() => 0),
      listPendingForTarget: mock(() => [row]),
      markDelivered: mock(() => {}),
      markAttemptFailed: mock(() => null),
    };
    const { manager, injectMock } = makeMockRepoManager(repo);

    await manager.flushPendingMessagesForTarget(row.workflowRunId, AGENT_NAME, SESSION_ID);

    expect(injectMock).toHaveBeenCalledTimes(1);
    expect(repo.markDelivered).toHaveBeenCalledTimes(1);
    expect(repo.markDelivered).toHaveBeenCalledWith('row-dup', SESSION_ID);
  });

  it('re-sorts the merged alias listing by createdAt before draining', async () => {
    const aliasRow = makeRecord({
      id: 'row-alias',
      targetAgentName: `${NODE_NAME}/${AGENT_NAME}`,
      message: 'alias first',
      createdAt: 1,
    });
    const lateRow = makeRecord({ id: 'row-late', message: 'late', createdAt: 3 });
    const midRow = makeRecord({ id: 'row-mid', message: 'mid', createdAt: 2 });
    const repo = {
      enforceRetention: mock(() => 0),
      expireStale: mock(() => 0),
      listPendingForTarget: mock((_runId: string, name: string) =>
        name === AGENT_NAME ? [lateRow, midRow] : [aliasRow]
      ),
      markDelivered: mock(() => {}),
      markAttemptFailed: mock(() => null),
    };
    const { manager, injectMock } = makeMockRepoManager(repo);

    await manager.flushPendingMessagesForTarget('run-mock', AGENT_NAME, SESSION_ID);

    const drained = injectMock.mock.calls.map((call: unknown[]) => call[6]);
    expect(drained).toEqual(['row-alias', 'row-mid', 'row-late']);
  });

  it('runs retention and expiry against the run before listing', async () => {
    h.enqueue({ message: 'note' });

    await h.manager.flushPendingMessagesForTarget(h.runId, AGENT_NAME, SESSION_ID);

    expect(h.spyRepo.retentionArgs).toEqual([[{ runId: h.runId, excludeIds: [] }]]);
    expect(h.spyRepo.expireArgs).toEqual([[h.runId]]);
    expect(h.spyRepo.calls.slice(0, 2)).toEqual(['enforceRetention', 'expireStale']);
    expect(h.spyRepo.calls[2]).toMatch(/^list:/);
  });

  it('returns early without injecting when no pending rows match', async () => {
    await h.manager.flushPendingMessagesForTarget(h.runId, AGENT_NAME, SESSION_ID);

    expect(h.injectMock).not.toHaveBeenCalled();
    expect(h.spyRepo.calls).toEqual([
      'enforceRetention',
      'expireStale',
      `list:${AGENT_NAME}@${NODE_ID}`,
      `list:${NODE_NAME}/${AGENT_NAME}@${NODE_ID}`,
    ]);
  });
});

describe('flushPendingMessagesForTarget — envelope formatting', () => {
  let h: RealDbHarness;
  beforeEach(() => {
    h = makeRealDbHarness();
  });
  afterEach(() => {
    h.db.close();
  });

  async function drainedMessage(row: {
    sourceAgentName: string;
    message: string;
    taskId?: string;
  }): Promise<string> {
    const record = h.enqueue({
      sourceAgentName: row.sourceAgentName,
      message: row.message,
      ...(row.taskId != null ? { taskId: row.taskId } : {}),
    });
    await h.manager.flushPendingMessagesForTarget(h.runId, AGENT_NAME, SESSION_ID);
    expect(h.injectMock).toHaveBeenCalledTimes(1);
    expect(h.injectMock.mock.calls[0][0]).toBe(SESSION_ID);
    expect(h.spyRepo.repo.getById(record.id)?.status).toBe('delivered');
    return h.injectMock.mock.calls[0][1] as string;
  }

  it('formats a peer node-agent source through formatAgentMessage', async () => {
    const message = await drainedMessage({
      sourceAgentName: 'reviewer',
      message: 'peer note',
      taskId: 'task-7',
    });

    expect(message).toBe(
      formatAgentMessage({
        fromLevel: 'node-agent',
        fromAgentName: 'reviewer',
        toLevel: 'node-agent',
        body: 'peer note',
        taskId: 'task-7',
        nodeId: AGENT_NAME,
      })
    );
    expect(message).toContain('─── Message from reviewer ───');
    expect(message).toContain('To reply, use: send_message with target "reviewer"');
  });

  it('maps the task-agent source level to the task-agent envelope', async () => {
    const message = await drainedMessage({ sourceAgentName: 'task-agent', message: 'coord note' });

    expect(message).toContain('─── Message from task-agent ───');
    expect(message).toContain('To reply, use: send_message with target "task-agent"');
  });

  it('maps the space-agent source level to the coordinator reply handle', async () => {
    const message = await drainedMessage({
      sourceAgentName: 'space-agent',
      message: 'coordinator note',
    });

    expect(message).toContain('─── Message from space-agent ───');
    expect(message).toContain('To reply, use: send_message with target "@coordinator"');
  });

  it('maps a space-member source to the session-agent envelope', async () => {
    const message = await drainedMessage({
      sourceAgentName: 'space-member',
      message: 'member note',
    });

    expect(message).toContain('─── Message from space-member ───');
    expect(message).toContain('To reply, use: send_message with target "@space-member"');
  });

  it('prefixes human messages instead of enveloping them', async () => {
    const message = await drainedMessage({
      sourceAgentName: 'human',
      message: 'plain human words',
    });

    expect(message).toBe('[Message from human]: plain human words');
  });

  it('passes already-enveloped rows through unchanged', async () => {
    const enveloped = formatAgentMessage({
      fromLevel: 'node-agent',
      fromAgentName: 'reviewer',
      toLevel: 'node-agent',
      body: 'already enveloped',
    });
    const message = await drainedMessage({
      sourceAgentName: 'reviewer',
      message: enveloped,
    });

    expect(message).toBe(enveloped);
  });

  it('re-wraps an envelope whose sender does not match the row source', async () => {
    const foreign = formatAgentMessage({
      fromLevel: 'node-agent',
      fromAgentName: 'someone-else',
      toLevel: 'node-agent',
      body: 'foreign envelope',
    });
    const message = await drainedMessage({
      sourceAgentName: 'reviewer',
      message: foreign,
    });

    expect(message).toContain('─── Message from reviewer ───');
    expect(message).toContain('─── Message from someone-else ───');
    expect(message).toContain(foreign);
  });
});

describe('flushPendingMessagesForTarget — per-row outcomes', () => {
  let h: RealDbHarness;
  beforeEach(() => {
    h = makeRealDbHarness();
  });
  afterEach(() => {
    h.db.close();
  });

  it('marks delivered rows, stamps execution activity, and emits pendingMessage.delivered', async () => {
    const row = h.enqueue({ message: 'delivered note' });

    await h.manager.flushPendingMessagesForTarget(h.runId, AGENT_NAME, SESSION_ID);

    const record = h.spyRepo.repo.getById(row.id);
    expect(record?.status).toBe('delivered');
    expect(record?.deliveredSessionId).toBe(SESSION_ID);
    expect(record?.deliveredAt).not.toBeNull();
    expect(record?.lastError).toBeNull();
    expect(h.spyRepo.calls).toContain(`delivered:${row.id}`);

    const executions = new NodeExecutionRepository(
      h.db as unknown as Parameters<typeof NodeExecutionRepository.prototype.constructor>[0]
    );
    expect(executions.getById(h.executionId)?.lastActivityAt).not.toBeNull();

    const events = h.publish.mock.calls.filter(
      (call: unknown[]) => call[0] === 'space.pendingMessage.delivered'
    );
    expect(events).toHaveLength(1);
    expect(events[0][1]).toEqual({
      sessionId: 'global',
      spaceId: h.spaceId,
      workflowRunId: h.runId,
      targetAgentName: AGENT_NAME,
      targetKind: 'node_agent',
      messageId: row.id,
      deliveredSessionId: SESSION_ID,
    });
  });

  it('passes isSynthetic, deliveryMode, and the row id through to the inject', async () => {
    const syntheticRow = h.enqueue({
      sourceAgentName: 'reviewer',
      message: 'agent note',
      deliveryMode: 'defer',
    });
    const humanRow = h.enqueue({ sourceAgentName: 'human', message: 'human note' });

    await h.manager.flushPendingMessagesForTarget(h.runId, AGENT_NAME, SESSION_ID);

    expect(h.injectMock.mock.calls[0]).toEqual([
      SESSION_ID,
      expect.stringContaining('agent note'),
      true,
      undefined,
      'defer',
      undefined,
      syntheticRow.id,
    ]);
    expect(h.injectMock.mock.calls[1]).toEqual([
      SESSION_ID,
      '[Message from human]: human note',
      false,
      undefined,
      undefined,
      undefined,
      humanRow.id,
    ]);
  });

  it('marks the attempt failed and continues draining the remaining rows', async () => {
    const failingRow = h.enqueue({ message: 'fails first' });
    const laterRow = h.enqueue({ message: 'still drains' });
    (
      h.manager as unknown as {
        injectSubSessionMessage: (...args: unknown[]) => Promise<string>;
      }
    ).injectSubSessionMessage = mock(async (...args: unknown[]) => {
      if (args[6] === failingRow.id) throw new Error('inject exploded');
      return 'ok';
    });

    await h.manager.flushPendingMessagesForTarget(h.runId, AGENT_NAME, SESSION_ID);

    const failed = h.spyRepo.repo.getById(failingRow.id);
    expect(failed?.status).toBe('pending');
    expect(failed?.attempts).toBe(1);
    expect(failed?.lastError).toBe('inject exploded');
    expect(h.spyRepo.calls).toContain(`attemptFailed:${failingRow.id}`);
    expect(h.spyRepo.repo.getById(laterRow.id)?.status).toBe('delivered');
  });
});

interface SpaceAgentHarness {
  manager: TaskAgentManager;
  spyRepo: SpyRepo;
  injector: ReturnType<typeof mock>;
  publish: ReturnType<typeof mock>;
  db: Database;
  runId: string;
  spaceId: string;
  enqueue: (overrides?: EnqueueOverrides) => PendingAgentMessageRecord;
}

function makeSpaceAgentHarness(
  options: {
    withInjector?: boolean;
    injectorImpl?: (
      spaceId: string,
      message: string,
      replyTo: string | null,
      rowId: string
    ) => Promise<{ state: 'accepted' | 'failed'; messageId: string; error?: string }>;
    registry?: { get: (taskId: string) => string | null };
  } = {}
): SpaceAgentHarness {
  const db = new Database(':memory:');
  createSpaceTables(db);
  const spaceRepo = new SpaceRepository(
    db as unknown as Parameters<typeof SpaceRepository.prototype.constructor>[0]
  );
  const runRepo = new SpaceWorkflowRunRepository(
    db as unknown as Parameters<typeof SpaceWorkflowRunRepository.prototype.constructor>[0]
  );
  const space = spaceRepo.createSpace({ workspacePath: '/w', slug: 's2', name: 'S2' });
  const now = Date.now();
  (db as unknown as { prepare: (sql: string) => { run: (...args: unknown[]) => void } })
    .prepare(
      `INSERT INTO space_workflows (id, space_id, name, created_at, updated_at) VALUES (?, ?, ?, ?, ?)`
    )
    .run(WORKFLOW_ID, space.id, 'WF2', now, now);
  const run = runRepo.createRun({ spaceId: space.id, workflowId: WORKFLOW_ID, title: 'R2' });

  const spyRepo = spyPendingRepo(
    new PendingAgentMessageRepository(
      db as unknown as Parameters<typeof PendingAgentMessageRepository.prototype.constructor>[0]
    )
  );
  const publish = mock(async (_event: string, _payload: unknown) => {});
  const acceptedRowIds = new Set<string>();
  const injector = mock(
    async (spaceId: string, message: string, replyTo: string | null, rowId: string) => {
      acceptedRowIds.add(rowId);
      if (options.injectorImpl) {
        return options.injectorImpl(spaceId, message, replyTo, rowId);
      }
      return { state: 'accepted' as const, messageId: rowId };
    }
  );

  const config: Record<string, unknown> = {
    db: {
      getDatabase: () => db,
      getSDKMessageRepo: () => ({
        getDeliveryContent: (_sessionId: string, messageId: string) =>
          acceptedRowIds.has(messageId) ? { content: 'x', sendStatus: 'consumed' } : null,
      }),
    },
    pendingMessageRepo: spyRepo.spy,
    internalEventBus: { subscribe: mock(() => () => {}), publish },
  };
  if (options.withInjector !== false) config.spaceAgentInjector = injector;
  if (options.registry) config.replyRoutingRegistry = options.registry;

  const manager = new TaskAgentManager(config as unknown as TaskAgentManagerConfig);

  return {
    manager,
    spyRepo,
    injector,
    publish,
    db,
    runId: run.id,
    spaceId: space.id,
    enqueue: (overrides = {}) =>
      spyRepo.repo.enqueue({
        workflowRunId: run.id,
        spaceId: space.id,
        sourceAgentName: 'reviewer',
        targetKind: 'space_agent',
        targetAgentName: 'space-agent',
        message: 'space agent note',
        ...overrides,
      }).record,
  };
}

describe('flushPendingMessagesForSpaceAgent — space-agent drain', () => {
  afterEach(() => {
    dbByTest.pop()?.close();
  });

  const dbByTest: Database[] = [];

  it('returns silently without listing when no injector is configured', async () => {
    const h = makeSpaceAgentHarness({ withInjector: false });
    dbByTest.push(h.db);
    const row = h.enqueue({ message: 'no injector' });

    await h.manager.flushPendingMessagesForSpaceAgent(h.spaceId, h.runId);

    expect(h.spyRepo.calls).toEqual([]);
    expect(h.spyRepo.repo.getById(row.id)?.status).toBe('pending');
  });

  it('defers pending-row expiry while an SDK delivery is still active', async () => {
    const h = makeSpaceAgentHarness({
      injectorImpl: async (_spaceId, _message, _replyTo, rowId) => ({
        state: 'accepted',
        messageId: rowId,
        sessionId: `space:chat:stub`,
      }),
    });
    dbByTest.push(h.db);
    const row = h.enqueue({ message: 'still in flight' });
    (h.manager as unknown as { config: Record<string, unknown> }).config.db = {
      getSDKMessageRepo: () => ({
        getDeliveryContent: (_sessionId: string, uuid: string) =>
          uuid === row.id ? { content: 'x', sendStatus: 'enqueued' } : null,
      }),
    };

    await h.manager.flushPendingMessagesForSpaceAgent(h.spaceId, h.runId);

    expect(h.spyRepo.calls).toContain(`defer:${row.id}`);
    expect(h.spyRepo.repo.getById(row.id)?.status).toBe('pending');
  });

  it('settles reply-routed rows against their reply session and falls back to the chat session', async () => {
    const registry = {
      get: mock((taskId: string | null) => (taskId === 'task-gone' ? 'gone-session' : null)),
    };
    const h = makeSpaceAgentHarness({ registry });
    dbByTest.push(h.db);
    const footerRow = h.enqueue({
      message: formatAgentMessage({
        fromLevel: 'node-agent',
        fromAgentName: 'reviewer',
        toLevel: 'space-agent',
        body: 'consumed at footer session',
        taskId: 'task-a',
        replyToSessionId: 'footer-session',
      }),
      taskId: 'task-a',
    });
    const fallbackRow = h.enqueue({ message: 'plain', taskId: 'task-gone' });
    (h.manager as unknown as { config: Record<string, unknown> }).config.db = {
      getSDKMessageRepo: () => ({
        getDeliveryContent: (sessionId: string, uuid: string) => {
          if (uuid === footerRow.id && sessionId === 'footer-session') {
            return { content: 'x', sendStatus: 'consumed' };
          }
          if (uuid === fallbackRow.id && sessionId === `space:chat:${h.spaceId}`) {
            return { content: 'x', sendStatus: 'consumed' };
          }
          return null;
        },
      }),
    };

    await h.manager.flushPendingMessagesForSpaceAgent(h.spaceId, h.runId);

    expect(h.injector).not.toHaveBeenCalled();
    expect(h.spyRepo.repo.getById(footerRow.id)?.deliveredSessionId).toBe('footer-session');
    expect(h.spyRepo.repo.getById(fallbackRow.id)?.deliveredSessionId).toBe(
      `space:chat:${h.spaceId}`
    );
    expect(h.spyRepo.calls).toContain(`delivered:${footerRow.id}`);
    expect(h.spyRepo.calls).toContain(`delivered:${fallbackRow.id}`);
  });

  it('settles space_agent rows already consumed before this drain pass', async () => {
    const h = makeSpaceAgentHarness();
    dbByTest.push(h.db);
    const row = h.enqueue({ message: 'consumed while the daemon was down' });
    (h.manager as unknown as { config: Record<string, unknown> }).config.db = {
      getSDKMessageRepo: () => ({
        getDeliveryContent: (_sessionId: string, uuid: string) =>
          uuid === row.id ? { content: 'x', sendStatus: 'consumed' } : null,
      }),
    };

    await h.manager.flushPendingMessagesForSpaceAgent(h.spaceId, h.runId);

    expect(h.injector).not.toHaveBeenCalled();
    expect(h.spyRepo.repo.getById(row.id)?.status).toBe('delivered');
    expect(h.spyRepo.repo.getById(row.id)?.deliveredSessionId).toBe(`space:chat:${h.spaceId}`);
    const deliveredAt = h.spyRepo.calls.indexOf(`delivered:${row.id}`);
    const expiredAt = h.spyRepo.calls.indexOf('expireStale');
    expect(deliveredAt).toBeGreaterThanOrEqual(0);
    expect(expiredAt).toBeGreaterThan(deliveredAt);
  });

  it('settles a space-agent row once the accepted delivery is consumed', async () => {
    const consumedIds = new Set<string>();
    const h = makeSpaceAgentHarness({
      injectorImpl: async (spaceId, _message, _replyTo, rowId) => {
        consumedIds.add(rowId);
        return { state: 'accepted' as const, messageId: rowId, sessionId: `space:chat:${spaceId}` };
      },
    });
    (h.manager as unknown as { config: Record<string, unknown> }).config.db = {
      getSDKMessageRepo: () => ({
        getDeliveryContent: (_sessionId: string, messageId: string) =>
          consumedIds.has(messageId) ? { content: 'x', sendStatus: 'consumed' } : null,
      }),
    };
    dbByTest.push(h.db);
    const row = h.enqueue({ message: 'accepted while coordinator idle' });

    await h.manager.flushPendingMessagesForSpaceAgent(h.spaceId, h.runId);
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(h.spyRepo.repo.getById(row.id)?.status).toBe('delivered');
    expect(h.spyRepo.repo.getById(row.id)?.deliveredSessionId).toBe(`space:chat:${h.spaceId}`);
    expect(h.spyRepo.calls).toContain(`delivered:${row.id}`);
  });

  it('keeps an accepted row recoverable until the delivery outcome settles', async () => {
    const pendingIds = new Set<string>();
    const h = makeSpaceAgentHarness({
      injectorImpl: async (spaceId, _message, _replyTo, rowId) => {
        pendingIds.add(rowId);
        return { state: 'accepted' as const, messageId: rowId, sessionId: `space:chat:${spaceId}` };
      },
    });
    (h.manager as unknown as { config: Record<string, unknown> }).config.db = {
      getSDKMessageRepo: () => ({
        getDeliveryContent: (_sessionId: string, messageId: string) =>
          pendingIds.has(messageId) ? { content: 'x', sendStatus: 'enqueued' } : null,
      }),
    };
    dbByTest.push(h.db);
    const row = h.enqueue({ message: 'parked after acceptance' });

    await h.manager.flushPendingMessagesForSpaceAgent(h.spaceId, h.runId);
    await new Promise((resolve) => setTimeout(resolve, 10));

    expect(h.spyRepo.repo.getById(row.id)?.status).toBe('pending');
    expect(h.spyRepo.calls).not.toContain(`delivered:${row.id}`);
  });

  it('drains only space_agent rows targeted at the space agent', async () => {
    const h = makeSpaceAgentHarness();
    dbByTest.push(h.db);
    const spaceRow = h.enqueue({ message: 'space row' });
    const nodeRow = h.enqueue({ targetKind: 'node_agent', message: 'node row' });

    await h.manager.flushPendingMessagesForSpaceAgent(h.spaceId, h.runId);

    expect(h.injector).toHaveBeenCalledTimes(1);
    expect(h.spyRepo.repo.getById(spaceRow.id)?.status).toBe('delivered');
    expect(h.spyRepo.repo.getById(nodeRow.id)?.status).toBe('pending');
  });

  it('drains space_agent rows regardless of workflow node scoping', async () => {
    const h = makeSpaceAgentHarness();
    dbByTest.push(h.db);
    const nodeScoped = h.enqueue({ workflowNodeId: 'node-build', message: 'node scoped' });

    await h.manager.flushPendingMessagesForSpaceAgent(h.spaceId, h.runId);

    expect(h.injector).toHaveBeenCalledTimes(1);
    expect(h.spyRepo.repo.getById(nodeScoped.id)?.status).toBe('delivered');
  });

  it('marks rows delivered to the space-chat session id and emits the delivery event', async () => {
    const h = makeSpaceAgentHarness();
    dbByTest.push(h.db);
    const row = h.enqueue({ message: 'chat row' });

    await h.manager.flushPendingMessagesForSpaceAgent(h.spaceId, h.runId);

    const record = h.spyRepo.repo.getById(row.id);
    expect(record?.status).toBe('delivered');
    expect(record?.deliveredSessionId).toBe(`space:chat:${h.spaceId}`);
    expect(h.injector.mock.calls[0][0]).toBe(h.spaceId);
    const events = h.publish.mock.calls.filter(
      (call: unknown[]) => call[0] === 'space.pendingMessage.delivered'
    );
    expect(events).toHaveLength(1);
    expect(events[0][1]).toEqual({
      sessionId: 'global',
      spaceId: h.spaceId,
      workflowRunId: h.runId,
      targetAgentName: 'space-agent',
      targetKind: 'space_agent',
      messageId: row.id,
      deliveredSessionId: `space:chat:${h.spaceId}`,
    });
  });

  it('resolves reply-to from the envelope footer first, then the registry, else null', async () => {
    const registry = {
      get: mock((taskId: string) => (taskId === 'task-9' ? 'registry-session' : null)),
    };
    const h = makeSpaceAgentHarness({ registry });
    dbByTest.push(h.db);
    h.enqueue({
      message: formatAgentMessage({
        fromLevel: 'node-agent',
        fromAgentName: 'reviewer',
        toLevel: 'space-agent',
        body: 'with footer',
        taskId: 'task-a',
        replyToSessionId: 'footer-session',
      }),
      taskId: 'task-a',
    });
    h.enqueue({ message: 'plain status request', taskId: 'task-9' });
    h.enqueue({ message: 'no task context', taskId: null });

    await h.manager.flushPendingMessagesForSpaceAgent(h.spaceId, h.runId);

    expect(h.injector.mock.calls.map((call: unknown[]) => call[2])).toEqual([
      'footer-session',
      'registry-session',
      null,
    ]);
    expect(registry.get.mock.calls.map((call: unknown[]) => call[0])).toEqual(['task-9', 'task-9']);
  });

  it('formats plain rows for the space-agent level and passes enveloped rows through', async () => {
    const h = makeSpaceAgentHarness();
    dbByTest.push(h.db);
    const enveloped = formatAgentMessage({
      fromLevel: 'node-agent',
      fromAgentName: 'reviewer',
      toLevel: 'space-agent',
      body: 'already enveloped',
      taskId: 'task-7',
    });
    h.enqueue({ message: 'plain note', taskId: 'task-7' });
    h.enqueue({ message: enveloped, taskId: 'task-7' });

    await h.manager.flushPendingMessagesForSpaceAgent(h.spaceId, h.runId);

    const formatted = h.injector.mock.calls[0][1] as string;
    expect(formatted).toBe(
      formatAgentMessage({
        fromLevel: 'node-agent',
        fromAgentName: 'reviewer',
        toLevel: 'space-agent',
        body: 'plain note',
        taskId: 'task-7',
      })
    );
    expect(formatted).toContain('send_message_to_task with task_id="task-7"');
    expect(h.injector.mock.calls[1][1]).toBe(enveloped);
  });

  it('marks the attempt failed and continues when the injector rejects', async () => {
    const h = makeSpaceAgentHarness({
      injectorImpl: async (_spaceId, message, _replyTo, rowId) => {
        if (message.includes('fails first')) throw new Error('injector down');
        return { state: 'accepted', messageId: rowId };
      },
    });
    dbByTest.push(h.db);
    const failingRow = h.enqueue({ message: 'fails first' });
    const laterRow = h.enqueue({ message: 'still drains' });

    await h.manager.flushPendingMessagesForSpaceAgent(h.spaceId, h.runId);
    await new Promise((resolve) => setTimeout(resolve, 0));

    const failed = h.spyRepo.repo.getById(failingRow.id);
    expect(failed?.status).toBe('pending');
    expect(failed?.attempts).toBe(1);
    expect(failed?.lastError).toBe('injector down');
    expect(h.spyRepo.repo.getById(laterRow.id)?.status).toBe('delivered');
  });

  it('terminalizes rows whose attempt budget is already spent', async () => {
    const h = makeSpaceAgentHarness();
    dbByTest.push(h.db);
    const row = h.enqueue({ message: 'budget spent' });
    for (let i = 0; i < 5; i++) h.spyRepo.repo.markAttemptFailed(row.id, 'historical failure');

    await h.manager.flushPendingMessagesForSpaceAgent(h.spaceId, h.runId);

    expect(h.injector).not.toHaveBeenCalled();
    expect(h.spyRepo.repo.getById(row.id)?.status).toBe('failed');
    expect(h.spyRepo.repo.getById(row.id)?.lastError).toBe('historical failure');
  });
});

describe('injectSubSessionMessageWithOrigin — terminal guard', () => {
  const GUARD_SESSION_ID = 'sub-session-guard';
  const GUARD_RUN_ID = 'run-guard';

  async function makeGuardManager(
    taskStatus: string | null,
    runStatus: string
  ): Promise<{ manager: TaskAgentManager; db: Database }> {
    const db = await createTestDb();
    db.createSession(createTestSession(GUARD_SESSION_ID));
    const execution = {
      id: 'exec-guard',
      workflowRunId: GUARD_RUN_ID,
      workflowNodeId: NODE_ID,
      agentName: AGENT_NAME,
      agentSessionId: GUARD_SESSION_ID,
      status: 'in_progress',
      createdAt: 1,
      updatedAt: 1,
    };
    const replayMock = mock(async () => ({ success: true, messageCount: 0 }));
    const workflow = { nodes: [{ id: NODE_ID, name: NODE_NAME, agents: [] }] };
    const session = {
      session: { id: GUARD_SESSION_ID, sdkSessionId: 'prior-sdk' },
      getProcessingState: () => ({ status: 'idle' }),
      handleQueryTrigger: replayMock,
      ensureQueryStarted: mock(async () => ({ started: false })),
      clearConversationContext: mock(async () => {}),
    } as unknown as AgentSession;

    const manager = new TaskAgentManager({
      db,
      internalEventBus: { subscribe: mock(() => () => {}), publish: mock(async () => {}) },
      nodeExecutionRepo: {
        getByAgentSessionId: mock(() => execution),
        listByAgentSessionId: mock(() => [execution]),
        getById: mock(() => null),
        touchLastActivity: mock(() => {}),
      },
      workflowRunRepo: { getRun: mock(() => ({ workflowId: WORKFLOW_ID, status: runStatus })) },
      taskRepo: {
        getTask: mock(() => null),
        listByWorkflowRunIncludingArchived: mock(() =>
          taskStatus ? [{ id: 'task-guard', status: taskStatus, workflowRunId: GUARD_RUN_ID }] : []
        ),
      },
      spaceWorkflowManager: { getWorkflow: () => workflow, getWorkflowForRun: () => workflow },
    } as unknown as TaskAgentManagerConfig);
    (manager as unknown as { agentSessionIndex: Map<string, AgentSession> }).agentSessionIndex.set(
      GUARD_SESSION_ID,
      session
    );
    return { manager, db };
  }

  it('rejects when the canonical task is cancelled', async () => {
    const { manager, db } = await makeGuardManager('cancelled', 'in_progress');
    await expect(manager.injectSubSessionMessage(GUARD_SESSION_ID, 'note', true)).rejects.toThrow(
      'task/run is terminal (cancelled)'
    );
    db.close();
  });

  it('rejects when the canonical task is archived', async () => {
    const { manager, db } = await makeGuardManager('archived', 'in_progress');
    await expect(manager.injectSubSessionMessage(GUARD_SESSION_ID, 'note', true)).rejects.toThrow(
      'task/run is terminal (archived)'
    );
    db.close();
  });

  it('rejects when the workflow run is cancelled', async () => {
    const { manager, db } = await makeGuardManager(null, 'cancelled');
    await expect(manager.injectSubSessionMessage(GUARD_SESSION_ID, 'note', true)).rejects.toThrow(
      'task/run is terminal (cancelled)'
    );
    db.close();
  });

  it('lets done task and run states through to the durable injection shell', async () => {
    const { manager, db } = await makeGuardManager('done', 'done');

    const dbId = await manager.injectSubSessionMessage(GUARD_SESSION_ID, 'note', true);

    expect(dbId).toBeTypeOf('string');
    const row = db
      .getDatabase()
      .prepare(
        `SELECT send_status AS sendStatus, sdk_uuid AS sdkUuid FROM sdk_messages WHERE id = ?`
      )
      .get(dbId) as { sendStatus: string; sdkUuid: string };
    expect(row.sendStatus).toBe('enqueued');
    const job = db
      .getDatabase()
      .prepare(
        `SELECT id FROM job_queue WHERE queue = 'message_delivery'
           AND json_extract(payload, '$.messageUuid') = ?`
      )
      .get(row.sdkUuid);
    expect(job).toBeDefined();
    db.close();
  });

  it('rejects runtime-origin injections when the canonical task is done (#3109)', async () => {
    const { manager, db } = await makeGuardManager('done', 'in_progress');

    await expect(
      manager.injectRuntimeRecoveryMessage(GUARD_SESSION_ID, 'recovery nag')
    ).rejects.toThrow('task/run is terminal (done)');
    db.close();
  });
});

describe('pending drain through the v2 injection shell', () => {
  const V2_SESSION_ID = 'sub-session-v2';
  const V2_RUN_ID = 'run-v2';
  const V2_NODE_ID = 'node-coder';

  async function makeV2Harness(deliveryContent: { sendStatus: string }): Promise<{
    manager: TaskAgentManager;
    db: Database;
    markDelivered: ReturnType<typeof mock>;
    replayMock: ReturnType<typeof mock>;
  }> {
    const db = await createTestDb();
    db.createSession(createTestSession(V2_SESSION_ID));
    const storedMessage = formatPendingRowForNodeAgent(
      makeRecord({
        id: 'row-v2',
        workflowRunId: V2_RUN_ID,
        workflowNodeId: V2_NODE_ID,
        message: 'queued v2 note',
      }),
      AGENT_NAME
    );
    const sdkUserMessage: SDKUserMessage & { isSynthetic: boolean; inputKind: string } = {
      type: 'user',
      uuid: 'row-v2',
      session_id: V2_SESSION_ID,
      parent_tool_use_id: null,
      isSynthetic: true,
      inputKind: 'task',
      message: { role: 'user', content: [{ type: 'text', text: storedMessage }] },
    };
    db.saveUserMessage(V2_SESSION_ID, sdkUserMessage, 'enqueued');
    if (deliveryContent.sendStatus === 'failed') {
      db.getSDKMessageRepo().markDeliveryFailedByUuid(V2_SESSION_ID, 'row-v2');
    }
    if (deliveryContent.sendStatus === 'consumed') {
      db.getSDKMessageRepo().markDeliveryConsumedByUuid(V2_SESSION_ID, 'row-v2');
    }
    const replayMock = mock(async () => ({ success: true, messageCount: 0 }));
    const execution = {
      id: 'exec-v2',
      workflowRunId: V2_RUN_ID,
      workflowNodeId: V2_NODE_ID,
      agentName: AGENT_NAME,
      agentSessionId: V2_SESSION_ID,
      status: 'in_progress',
      createdAt: 1,
      updatedAt: 1,
    };
    const workflow = {
      nodes: [{ id: V2_NODE_ID, name: 'Build', agents: [{ agentId: 'Coder', name: AGENT_NAME }] }],
    };
    const row = makeRecord({
      id: 'row-v2',
      workflowRunId: V2_RUN_ID,
      workflowNodeId: V2_NODE_ID,
      message: 'queued v2 note',
    });
    const pendingRepo = {
      enforceRetention: mock(() => 0),
      expireStale: mock(() => 0),
      listPendingForTarget: mock(() => [row]),
      markDelivered: mock(() => {}),
      markAttemptFailed: mock(() => null),
    };
    const session = {
      session: { id: V2_SESSION_ID, sdkSessionId: 'prior-sdk' },
      getProcessingState: () => ({ status: 'idle' }),
      handleQueryTrigger: replayMock,
      ensureQueryStarted: mock(async () => ({ started: false })),
      clearConversationContext: mock(async () => {}),
      messageQueue: { enqueueWithId: mock(async () => {}), size: () => 0 },
    } as unknown as AgentSession;

    const manager = new TaskAgentManager({
      db,
      internalEventBus: { subscribe: mock(() => () => {}), publish: mock(async () => {}) },
      nodeExecutionRepo: {
        getByAgentSessionId: mock(() => execution),
        listByAgentSessionId: mock(() => [execution]),
        getById: mock(() => null),
        touchLastActivity: mock(() => {}),
      },
      workflowRunRepo: { getRun: mock(() => ({ workflowId: WORKFLOW_ID })) },
      taskRepo: {
        getTask: mock(() => null),
        listByWorkflowRunIncludingArchived: mock(() => []),
      },
      spaceWorkflowManager: { getWorkflow: () => workflow, getWorkflowForRun: () => workflow },
      pendingMessageRepo: pendingRepo,
    } as unknown as TaskAgentManagerConfig);
    (manager as unknown as { agentSessionIndex: Map<string, AgentSession> }).agentSessionIndex.set(
      V2_SESSION_ID,
      session
    );
    return {
      manager,
      db,
      markDelivered: pendingRepo.markDelivered,
      replayMock,
    };
  }

  it('a drain retry over a failed delivery row reopens it and re-enqueues without a duplicate row', async () => {
    const h = await makeV2Harness({ sendStatus: 'failed' });

    await h.manager.flushPendingMessagesForTarget(V2_RUN_ID, AGENT_NAME, V2_SESSION_ID);

    expect(h.db.getSDKMessageRepo().getDeliveryContent(V2_SESSION_ID, 'row-v2')?.sendStatus).toBe(
      'enqueued'
    );
    const job = h.db
      .getDatabase()
      .prepare(
        `SELECT id FROM job_queue WHERE queue = 'message_delivery'
           AND json_extract(payload, '$.messageUuid') = 'row-v2'`
      )
      .get();
    expect(job).toBeDefined();
    expect(h.markDelivered).toHaveBeenCalledWith('row-v2', V2_SESSION_ID);
    h.db.close();
  });

  it('a drain retry over a consumed delivery row is a noop yet still marks the pending row delivered', async () => {
    const h = await makeV2Harness({ sendStatus: 'consumed' });

    await h.manager.flushPendingMessagesForTarget(V2_RUN_ID, AGENT_NAME, V2_SESSION_ID);

    expect(h.db.getSDKMessageRepo().getDeliveryContent(V2_SESSION_ID, 'row-v2')?.sendStatus).toBe(
      'consumed'
    );
    const job = h.db
      .getDatabase()
      .prepare(
        `SELECT id FROM job_queue WHERE queue = 'message_delivery'
           AND json_extract(payload, '$.messageUuid') = 'row-v2'`
      )
      .get();
    expect(job).toBeNull();
    expect(h.replayMock).not.toHaveBeenCalled();
    expect(h.markDelivered).toHaveBeenCalledWith('row-v2', V2_SESSION_ID);
    h.db.close();
  });
});
