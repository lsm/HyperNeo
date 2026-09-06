import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test';
import type { AgentSession } from '../../../../src/lib/agent/agent-session.ts';
import { signalDeliveryConsumed } from '../../../../src/lib/agent/message-delivery';
import type {
  EnsureSessionOutcome,
  SessionTarget,
} from '../../../../src/lib/session-resolution/target.ts';
import { formatAgentMessage } from '../../../../src/lib/space/agent-message-envelope';
import type { TaskAgentManagerConfig } from '../../../../src/lib/space/runtime/task-agent-manager';
import { TaskAgentManager } from '../../../../src/lib/space/runtime/task-agent-manager';
import { NodeExecutionRepository } from '../../../../src/storage/repositories/node-execution-repository';
import type { PendingAgentMessageRecord } from '../../../../src/storage/repositories/pending-agent-message-repository';
import { PendingAgentMessageRepository } from '../../../../src/storage/repositories/pending-agent-message-repository';
import { SpaceRepository } from '../../../../src/storage/repositories/space-repository';
import { SpaceTaskRepository } from '../../../../src/storage/repositories/space-task-repository';
import { SpaceWorkflowRunRepository } from '../../../../src/storage/repositories/space-workflow-run-repository';
import { Database } from '../../../../src/storage/sqlite-compat';
import { createSpaceTables } from '../../helpers/space-test-db';

const NODE_ID = 'node-build';
const NODE_NAME = 'Build';
const AGENT_NAME = 'coder';
const SESSION_ID = 'sub-session-coder';
const ORPHAN_SESSION_ID = 'sub-session-orphan';
const WORKFLOW_ID = 'wf-drain';
const TASK_ID = 'task-drain';

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

interface DeliveryCall {
  workflowRunId: string;
  args: {
    target: Record<string, unknown>;
    message: string;
    messageId: string;
    inputKind: string;
    origin: string;
  };
}

interface DeliveryFake {
  calls: DeliveryCall[];
  deliver: ReturnType<typeof mock>;
  failMessageIds: Set<string>;
}

function makeDeliveryFake(
  resolveSession: (target: Record<string, unknown>) => string
): DeliveryFake {
  const calls: DeliveryCall[] = [];
  const failMessageIds = new Set<string>();
  const deliver = mock(async (workflowRunId: string, args: DeliveryCall['args']) => {
    calls.push({ workflowRunId, args: { ...args, target: { ...args.target } } });
    if (failMessageIds.has(args.messageId)) {
      return { state: 'failed' as const, messageId: args.messageId, error: 'delivery lane down' };
    }
    return {
      state: 'delivered' as const,
      sessionId: resolveSession(args.target),
      messageId: args.messageId,
    };
  });
  return { calls, deliver, failMessageIds };
}

interface EnqueueOverrides {
  sourceAgentName?: string;
  targetKind?: 'node_agent' | 'space_agent';
  targetAgentName?: string;
  message?: string;
  workflowNodeId?: string | null;
  taskId?: string | null;
  deliveryMode?: 'immediate' | 'defer';
  idempotencyKey?: string | null;
  ttlMs?: number;
  maxAttempts?: number;
}

interface RealDbHarness {
  manager: TaskAgentManager;
  spyRepo: SpyRepo;
  delivery: DeliveryFake;
  ensureTargetSession: ReturnType<typeof mock>;
  publish: ReturnType<typeof mock>;
  db: Database;
  runId: string;
  spaceId: string;
  executionId: string;
  enqueue: (overrides?: EnqueueOverrides) => PendingAgentMessageRecord;
}

function makeRealDbHarness(
  options: { ensureImpl?: (target: SessionTarget) => Promise<EnsureSessionOutcome> } = {}
): RealDbHarness {
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
  const delivery = makeDeliveryFake(() => SESSION_ID);
  const ensureTargetSession = mock(
    options.ensureImpl ??
      (async () => ({ kind: 'resolved', sessionId: SESSION_ID, created: false }))
  );
  const workflow = { nodes: [{ id: NODE_ID, name: NODE_NAME }] };

  const manager = new TaskAgentManager({
    db: { getDatabase: () => db },
    taskRepo,
    workflowRunRepo: runRepo,
    nodeExecutionRepo,
    pendingMessageRepo: spyRepo.spy,
    ensureTargetSession,
    agentMessageDelivery: delivery.deliver,
    internalEventBus: { subscribe: mock(() => () => {}), publish },
    spaceWorkflowManager: {
      getWorkflow: () => workflow,
      getWorkflowForRun: () => workflow,
    },
  } as unknown as TaskAgentManagerConfig);

  return {
    manager,
    spyRepo,
    delivery,
    ensureTargetSession,
    publish,
    db,
    runId: run.id,
    spaceId: space.id,
    executionId: exec.id,
    enqueue: (overrides = {}) =>
      spyRepo.repo.enqueue({
        workflowRunId: run.id,
        spaceId: space.id,
        taskId: TASK_ID,
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

function makeMockRepoManager(
  repo: {
    enforceRetention: ReturnType<typeof mock>;
    expireStale: ReturnType<typeof mock>;
    listPendingForTarget: ReturnType<typeof mock>;
    markDelivered: ReturnType<typeof mock>;
    markAttemptFailed: ReturnType<typeof mock>;
  },
  options: {
    executionPresent?: boolean;
    provenance?: { workflowRunId: string; agentName: string; nodeId?: string };
  } = {}
): {
  manager: TaskAgentManager;
  delivery: DeliveryFake;
  ensureTargetSession: ReturnType<typeof mock>;
} {
  const delivery = makeDeliveryFake(() => SESSION_ID);
  const ensureTargetSession = mock(async () => ({
    kind: 'resolved',
    sessionId: SESSION_ID,
    created: false,
  }));
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
  const db = {
    prepare: mock(() => ({
      get: mock(() =>
        options.provenance
          ? { metadata: JSON.stringify({ promptProvenance: options.provenance }) }
          : undefined
      ),
    })),
  };
  const manager = new TaskAgentManager({
    db: { getDatabase: () => db },
    nodeExecutionRepo: {
      getByAgentSessionId: mock(() => (options.executionPresent === false ? null : execution)),
      listByAgentSessionId: mock(() => [execution]),
      getById: mock(() => null),
      touchLastActivity: mock(() => {}),
    },
    taskRepo: { getTask: mock(() => null), listByWorkflowRun: mock(() => [{ id: 'task-mock' }]) },
    workflowRunRepo: { getRun: mock(() => ({ workflowId: WORKFLOW_ID })) },
    spaceWorkflowManager: { getWorkflow: () => workflow, getWorkflowForRun: () => workflow },
    pendingMessageRepo: repo,
    ensureTargetSession,
    agentMessageDelivery: delivery.deliver,
    internalEventBus: { subscribe: mock(() => () => {}), publish: mock(async () => {}) },
  } as unknown as TaskAgentManagerConfig);
  return { manager, delivery, ensureTargetSession };
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

    expect(h.delivery.calls).toHaveLength(1);
    expect(h.delivery.calls[0].args.message).toContain('agent note');
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
    expect(h.delivery.calls).toHaveLength(1);
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
    expect(h.delivery.calls).toHaveLength(2);
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
    expect(h.delivery.calls).toHaveLength(1);
  });

  it('executionless drain uses matching session provenance to admit node-scoped rows', async () => {
    const matchingNode = makeRecord({ id: 'row-node', workflowNodeId: NODE_ID });
    const siblingNode = makeRecord({ id: 'row-sibling', workflowNodeId: 'node-review' });
    const repo = {
      enforceRetention: mock(() => 0),
      expireStale: mock(() => 0),
      listPendingForTarget: mock(() => [matchingNode, siblingNode]),
      markDelivered: mock(() => {}),
      markAttemptFailed: mock(() => null),
    };
    const { manager, delivery } = makeMockRepoManager(repo, {
      executionPresent: false,
      provenance: { workflowRunId: 'run-mock', agentName: AGENT_NAME, nodeId: NODE_ID },
    });

    await manager.flushPendingMessagesForTarget('run-mock', AGENT_NAME, SESSION_ID);

    expect(repo.listPendingForTarget).toHaveBeenCalledWith('run-mock', AGENT_NAME, NODE_ID);
    expect(delivery.calls.map((call) => call.args.messageId)).toEqual(['row-node']);
    expect(repo.markDelivered).toHaveBeenCalledWith('row-node', SESSION_ID);
  });

  it('executionless drain uses a trusted legacy node hint when provenance lacks a node', async () => {
    const nodeScoped = makeRecord({ id: 'row-node', workflowNodeId: NODE_ID });
    const siblingNode = makeRecord({ id: 'row-sibling', workflowNodeId: 'node-review' });
    const repo = {
      enforceRetention: mock(() => 0),
      expireStale: mock(() => 0),
      listPendingForTarget: mock(() => [nodeScoped, siblingNode]),
      markDelivered: mock(() => {}),
      markAttemptFailed: mock(() => null),
    };
    const { manager, delivery } = makeMockRepoManager(repo, {
      executionPresent: false,
      provenance: { workflowRunId: 'run-mock', agentName: AGENT_NAME },
    });

    await manager.flushPendingMessagesForTarget('run-mock', AGENT_NAME, SESSION_ID, NODE_ID);

    expect(repo.listPendingForTarget).toHaveBeenCalledWith('run-mock', AGENT_NAME, NODE_ID);
    expect(delivery.calls.map((call) => call.args.messageId)).toEqual(['row-node']);
    expect(repo.markDelivered).toHaveBeenCalledWith('row-node', SESSION_ID);
  });

  it('executionless drain ignores provenance from another run', async () => {
    const nodeScoped = makeRecord({ id: 'row-node', workflowNodeId: NODE_ID });
    const repo = {
      enforceRetention: mock(() => 0),
      expireStale: mock(() => 0),
      listPendingForTarget: mock(() => [nodeScoped]),
      markDelivered: mock(() => {}),
      markAttemptFailed: mock(() => null),
    };
    const { manager, delivery } = makeMockRepoManager(repo, {
      executionPresent: false,
      provenance: { workflowRunId: 'run-other', agentName: AGENT_NAME, nodeId: NODE_ID },
    });

    await manager.flushPendingMessagesForTarget('run-mock', AGENT_NAME, SESSION_ID);

    expect(repo.listPendingForTarget).toHaveBeenCalledWith('run-mock', AGENT_NAME);
    expect(delivery.calls).toHaveLength(0);
    expect(repo.markDelivered).not.toHaveBeenCalled();
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
    const { manager, delivery } = makeMockRepoManager(repo);

    await manager.flushPendingMessagesForTarget(row.workflowRunId, AGENT_NAME, SESSION_ID);

    expect(delivery.calls).toHaveLength(1);
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
    const { manager, delivery } = makeMockRepoManager(repo);

    await manager.flushPendingMessagesForTarget('run-mock', AGENT_NAME, SESSION_ID);

    expect(delivery.calls.map((call) => call.args.messageId)).toEqual([
      'row-alias',
      'row-mid',
      'row-late',
    ]);
  });

  it('runs retention and expiry against the run before listing', async () => {
    h.enqueue({ message: 'note' });

    await h.manager.flushPendingMessagesForTarget(h.runId, AGENT_NAME, SESSION_ID);

    expect(h.spyRepo.retentionArgs).toEqual([[{ runId: h.runId, excludeIds: [] }]]);
    expect(h.spyRepo.expireArgs).toEqual([[h.runId]]);
    expect(h.spyRepo.calls.slice(0, 2)).toEqual(['enforceRetention', 'expireStale']);
    expect(h.spyRepo.calls[2]).toMatch(/^list:/);
  });

  it('returns early without handing off when no pending rows match', async () => {
    await h.manager.flushPendingMessagesForTarget(h.runId, AGENT_NAME, SESSION_ID);

    expect(h.delivery.calls).toHaveLength(0);
    expect(h.spyRepo.calls).toEqual([
      'enforceRetention',
      'expireStale',
      `list:${AGENT_NAME}@${NODE_ID}`,
      `list:${NODE_NAME}/${AGENT_NAME}@${NODE_ID}`,
    ]);
  });

  it('returns early without listing when no session ensurer is configured', async () => {
    const harness = makeRealDbHarness();
    (harness.manager as unknown as { config: TaskAgentManagerConfig }).config.ensureTargetSession =
      undefined;
    const row = harness.enqueue({ message: 'no ensurer' });
    try {
      await harness.manager.flushPendingMessagesForTarget(harness.runId, AGENT_NAME, SESSION_ID);

      expect(harness.spyRepo.calls).toEqual([]);
      expect(harness.spyRepo.repo.getById(row.id)?.status).toBe('pending');
      expect(harness.delivery.calls).toHaveLength(0);
    } finally {
      harness.db.close();
    }
  });
});

describe('flushPendingMessagesForTarget — door resolution and handoff', () => {
  let h: RealDbHarness;
  beforeEach(() => {
    h = makeRealDbHarness();
  });
  afterEach(() => {
    h.db.close();
  });

  it('resolves each drained row through a worker-kind ensureSession target', async () => {
    const nodeRow = h.enqueue({ workflowNodeId: NODE_ID, message: 'node scoped' });
    const runRow = h.enqueue({ workflowNodeId: null, message: 'run scoped' });

    await h.manager.flushPendingMessagesForTarget(h.runId, AGENT_NAME, SESSION_ID);

    expect(h.ensureTargetSession.mock.calls.map((call: unknown[]) => call[0])).toEqual([
      { kind: 'worker', taskId: TASK_ID, agentName: AGENT_NAME, workflowNodeId: NODE_ID },
      { kind: 'worker', taskId: TASK_ID, agentName: AGENT_NAME, workflowNodeId: NODE_ID },
    ]);
    expect(h.delivery.calls.map((call) => call.args.target)).toEqual([
      { kind: 'worker', taskId: TASK_ID, agentName: AGENT_NAME, workflowNodeId: NODE_ID },
      { kind: 'worker', taskId: TASK_ID, agentName: AGENT_NAME, workflowNodeId: NODE_ID },
    ]);
    expect(h.spyRepo.repo.getById(nodeRow.id)?.status).toBe('delivered');
    expect(h.spyRepo.repo.getById(runRow.id)?.status).toBe('delivered');
  });

  it('pins run-scoped rows to the execution being flushed when the agent spans nodes', async () => {
    h.enqueue({ workflowNodeId: null, message: 'run scoped' });
    const siblingNode = new NodeExecutionRepository(
      h.db as unknown as Parameters<typeof NodeExecutionRepository.prototype.constructor>[0]
    ).create({
      workflowRunId: h.runId,
      workflowNodeId: 'node-review',
      agentName: AGENT_NAME,
      agentSessionId: 'sub-session-coder-review',
      status: 'in_progress',
    });
    expect(siblingNode.id).toBeTruthy();

    await h.manager.flushPendingMessagesForTarget(h.runId, AGENT_NAME, SESSION_ID);

    expect(h.ensureTargetSession).toHaveBeenCalledTimes(1);
    expect(h.ensureTargetSession).toHaveBeenCalledWith({
      kind: 'worker',
      taskId: TASK_ID,
      agentName: AGENT_NAME,
      workflowNodeId: NODE_ID,
    });
  });

  it('falls back to the run-latest task when a row carries no taskId', async () => {
    const row = h.enqueue({ taskId: null, message: 'no task on row' });
    const taskRepo = new SpaceTaskRepository(
      h.db as unknown as Parameters<typeof SpaceTaskRepository.prototype.constructor>[0]
    );
    const task = taskRepo.createTask({
      spaceId: h.spaceId,
      title: 'T',
      workflowRunId: h.runId,
    } as Parameters<typeof taskRepo.createTask>[0]);

    await h.manager.flushPendingMessagesForTarget(h.runId, AGENT_NAME, SESSION_ID);

    expect(h.ensureTargetSession).toHaveBeenCalledWith({
      kind: 'worker',
      taskId: task.id,
      agentName: AGENT_NAME,
      workflowNodeId: NODE_ID,
    });
    expect(h.spyRepo.repo.getById(row.id)?.status).toBe('delivered');
  });

  it('delivers taskless recovery rows to the known session when no task resolves', async () => {
    const row = h.enqueue({ taskId: null, message: 'orphan recovery row' });

    await h.manager.flushPendingMessagesForTarget(h.runId, AGENT_NAME, SESSION_ID);

    expect(h.ensureTargetSession).toHaveBeenCalledWith({ kind: 'session', sessionId: SESSION_ID });
    expect(h.delivery.calls[0].args.target).toEqual({ kind: 'session', sessionId: SESSION_ID });
    expect(h.spyRepo.repo.getById(row.id)?.status).toBe('delivered');
  });

  it('charges an attempt and skips taskless recovery rows when the run is cancelled', async () => {
    const row = h.enqueue({ taskId: null, message: 'recovery after cancel' });
    h.db
      .prepare('UPDATE space_workflow_runs SET status = ? WHERE id = ?')
      .run('cancelled', h.runId);

    await h.manager.flushPendingMessagesForTarget(h.runId, AGENT_NAME, SESSION_ID);

    expect(h.delivery.calls).toHaveLength(0);
    const record = h.spyRepo.repo.getById(row.id);
    expect(record?.status).toBe('pending');
    expect(record?.lastError).toBe('task/run is terminal (cancelled)');
  });

  it('scopes the delivery messageId to the pending record id', async () => {
    const keyedRow = h.enqueue({
      idempotencyKey: 'human:task-7:coder:node-build:cli-42',
      message: 'keyed note',
    });
    const unkeyedRow = h.enqueue({ message: 'unkeyed note' });

    await h.manager.flushPendingMessagesForTarget(h.runId, AGENT_NAME, SESSION_ID);

    expect(h.delivery.calls.map((call) => call.args.messageId)).toEqual([
      keyedRow.id,
      unkeyedRow.id,
    ]);
  });

  it('migrates a row exactly once across a simulated double drain', async () => {
    const row = h.enqueue({
      idempotencyKey: 'human:task-7:coder:node-build:cli-42',
      message: 'migrate once',
    });

    await h.manager.flushPendingMessagesForTarget(h.runId, AGENT_NAME, SESSION_ID);
    await h.manager.flushPendingMessagesForTarget(h.runId, AGENT_NAME, SESSION_ID);

    expect(h.delivery.calls).toHaveLength(1);
    expect(h.delivery.calls[0].args.messageId).toBe(row.id);
  });

  it('delivers a re-enqueued row under its own uuid instead of the consumed key', async () => {
    const key = 'human:task-7:coder:node-build:cli-43';
    h.enqueue({ idempotencyKey: key, message: 'repeated send' });

    await h.manager.flushPendingMessagesForTarget(h.runId, AGENT_NAME, SESSION_ID);
    const resent = h.enqueue({ idempotencyKey: key, message: 'repeated send' });

    await h.manager.flushPendingMessagesForTarget(h.runId, AGENT_NAME, SESSION_ID);

    expect(h.delivery.calls).toHaveLength(2);
    expect(h.delivery.calls[1].args.messageId).toBe(resent.id);
    expect(h.delivery.calls[0].args.messageId).not.toBe(h.delivery.calls[1].args.messageId);
    expect(h.spyRepo.repo.getById(resent.id)?.status).toBe('delivered');
  });

  it('charges an attempt and keeps the row pending when the door cannot resolve', async () => {
    const harness = makeRealDbHarness({
      ensureImpl: async () => ({ kind: 'unresolved', reason: 'activation_timeout' }),
    });
    const row = harness.enqueue({ message: 'door blocked' });
    try {
      await harness.manager.flushPendingMessagesForTarget(harness.runId, AGENT_NAME, SESSION_ID);

      expect(harness.delivery.calls).toHaveLength(0);
      const record = harness.spyRepo.repo.getById(row.id);
      expect(record?.status).toBe('pending');
      expect(record?.attempts).toBe(1);
      expect(record?.lastError).toBe('session resolution: activation_timeout');
    } finally {
      harness.db.close();
    }
  });

  it('retries a door-blocked row on the next drain pass', async () => {
    let doorOpen = false;
    const harness = makeRealDbHarness({
      ensureImpl: async () =>
        doorOpen
          ? { kind: 'resolved', sessionId: SESSION_ID, created: false }
          : { kind: 'unresolved', reason: 'activation_timeout' },
    });
    const row = harness.enqueue({ message: 'retry me' });
    try {
      await harness.manager.flushPendingMessagesForTarget(harness.runId, AGENT_NAME, SESSION_ID);
      expect(harness.spyRepo.repo.getById(row.id)?.status).toBe('pending');

      doorOpen = true;
      await harness.manager.flushPendingMessagesForTarget(harness.runId, AGENT_NAME, SESSION_ID);

      expect(harness.delivery.calls).toHaveLength(1);
      expect(harness.spyRepo.repo.getById(row.id)?.status).toBe('delivered');
    } finally {
      harness.db.close();
    }
  });

  it('charges an attempt and keeps the row pending when routed delivery fails', async () => {
    const row = h.enqueue({
      idempotencyKey: 'human:task-7:coder:node-build:cli-44',
      message: 'lane rejects',
    });
    h.delivery.failMessageIds.add(row.id);

    await h.manager.flushPendingMessagesForTarget(h.runId, AGENT_NAME, SESSION_ID);

    expect(h.delivery.calls).toHaveLength(1);
    const record = h.spyRepo.repo.getById(row.id);
    expect(record?.status).toBe('pending');
    expect(record?.attempts).toBe(1);
    expect(record?.lastError).toBe('routed delivery failed: delivery lane down');
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
    expect(h.delivery.calls).toHaveLength(1);
    expect(h.delivery.calls[0].args.target).toEqual({
      kind: 'worker',
      taskId: row.taskId ?? TASK_ID,
      agentName: AGENT_NAME,
      workflowNodeId: NODE_ID,
    });
    expect(h.spyRepo.repo.getById(record.id)?.status).toBe('delivered');
    return h.delivery.calls[0].args.message;
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

  it('stamps human rows with the chat origin and agent rows with space_inject', async () => {
    const agentRow = h.enqueue({
      sourceAgentName: 'reviewer',
      message: 'agent note',
      deliveryMode: 'defer',
    });
    const humanRow = h.enqueue({ sourceAgentName: 'human', message: 'human note' });

    await h.manager.flushPendingMessagesForTarget(h.runId, AGENT_NAME, SESSION_ID);

    expect(h.delivery.calls[0].args).toMatchObject({
      origin: 'space_inject',
      inputKind: 'task',
      messageId: agentRow.id,
    });
    expect(h.delivery.calls[0].args.message).toContain('agent note');
    expect(h.delivery.calls[1].args).toMatchObject({
      origin: 'chat',
      inputKind: 'human',
      messageId: humanRow.id,
    });
    expect(h.delivery.calls[1].args.message).toBe('[Message from human]: human note');
  });

  it('marks the attempt failed and continues draining the remaining rows', async () => {
    const failingRow = h.enqueue({ message: 'fails first' });
    const laterRow = h.enqueue({ message: 'still drains' });
    h.delivery.failMessageIds.add(failingRow.idempotencyKey ?? failingRow.id);

    await h.manager.flushPendingMessagesForTarget(h.runId, AGENT_NAME, SESSION_ID);

    const failed = h.spyRepo.repo.getById(failingRow.id);
    expect(failed?.status).toBe('pending');
    expect(failed?.attempts).toBe(1);
    expect(h.spyRepo.calls).toContain(`attemptFailed:${failingRow.id}`);
    expect(h.spyRepo.repo.getById(laterRow.id)?.status).toBe('delivered');
  });
});

interface SpaceAgentHarness {
  manager: TaskAgentManager;
  spyRepo: SpyRepo;
  delivery: DeliveryFake;
  ensureTargetSession: ReturnType<typeof mock>;
  publish: ReturnType<typeof mock>;
  db: Database;
  runId: string;
  spaceId: string;
  enqueue: (overrides?: EnqueueOverrides) => PendingAgentMessageRecord;
}

function makeSpaceAgentHarness(
  options: {
    withEnsurer?: boolean;
    ensureImpl?: (target: SessionTarget) => Promise<EnsureSessionOutcome>;
    registry?: { get: (taskId: string) => string | null };
    retryDelayMs?: number;
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
  const spaceIdRef = { id: space.id };
  const coordinatorSession = `space:agent:${spaceIdRef.id}:coordinator`;
  const delivery = makeDeliveryFake((target) =>
    target.kind === 'agent'
      ? coordinatorSession
      : ((target.sessionId as string) ?? coordinatorSession)
  );
  const ensureTargetSession = mock(
    options.ensureImpl ??
      (async (target: SessionTarget) =>
        target.kind === 'agent'
          ? { kind: 'resolved', sessionId: coordinatorSession, created: false }
          : { kind: 'resolved', sessionId: target.sessionId, created: false })
  );

  const config: Record<string, unknown> = {
    db: { getDatabase: () => db },
    pendingMessageRepo: spyRepo.spy,
    ensureTargetSession,
    agentMessageDelivery: delivery.deliver,
    spaceAgentRetryDelayMs: options.retryDelayMs ?? 10,
    internalEventBus: { subscribe: mock(() => () => {}), publish },
  };
  if (options.withEnsurer === false) config.ensureTargetSession = undefined;
  if (options.registry) config.replyRoutingRegistry = options.registry;

  const manager = new TaskAgentManager(config as unknown as TaskAgentManagerConfig);

  return {
    manager,
    spyRepo,
    delivery,
    ensureTargetSession,
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

  it('returns silently without listing when no session ensurer is configured', async () => {
    const h = makeSpaceAgentHarness({ withEnsurer: false });
    dbByTest.push(h.db);
    const row = h.enqueue({ message: 'no ensurer' });

    await h.manager.flushPendingMessagesForSpaceAgent(h.spaceId, h.runId);

    expect(h.spyRepo.calls).toEqual([]);
    expect(h.spyRepo.repo.getById(row.id)?.status).toBe('pending');
  });

  it('excludes rows still owned by a legacy SDK delivery from re-delivery and retention', async () => {
    const h = makeSpaceAgentHarness();
    dbByTest.push(h.db);
    const row = h.enqueue({ message: 'still in flight' });
    (h.manager as unknown as { config: Record<string, unknown> }).config.db = {
      getDatabase: () => h.db,
      getSDKMessageRepo: () => ({
        getDeliveryContent: (_sessionId: string, uuid: string) =>
          uuid === row.id ? { content: 'x', sendStatus: 'enqueued' } : null,
      }),
    };

    await h.manager.flushPendingMessagesForSpaceAgent(h.spaceId, h.runId);

    expect(h.delivery.calls).toHaveLength(0);
    expect(h.spyRepo.repo.getById(row.id)?.status).toBe('pending');
    expect(h.spyRepo.calls).toContain(`defer:${row.id}`);
    expect(h.spyRepo.retentionArgs[0]?.[0]).toMatchObject({ excludeIds: [row.id] });
  });

  it('retries rows whose legacy SDK delivery already failed instead of stranding them', async () => {
    const h = makeSpaceAgentHarness();
    dbByTest.push(h.db);
    const row = h.enqueue({ message: 'legacy delivery failed' });
    (h.manager as unknown as { config: Record<string, unknown> }).config.db = {
      getDatabase: () => h.db,
      getSDKMessageRepo: () => ({
        getDeliveryContent: (_sessionId: string, uuid: string) =>
          uuid === row.id ? { content: 'x', sendStatus: 'failed' } : null,
      }),
    };

    await h.manager.flushPendingMessagesForSpaceAgent(h.spaceId, h.runId);

    expect(h.delivery.calls).toHaveLength(1);
    expect(h.delivery.calls[0].args.messageId).toBe(row.id);
    expect(h.spyRepo.repo.getById(row.id)?.status).toBe('delivered');
  });

  it('keeps watching legacy in-flight rows and hands them off once the delivery fails', async () => {
    const h = makeSpaceAgentHarness({ retryDelayMs: 10 });
    dbByTest.push(h.db);
    const row = h.enqueue({ message: 'legacy delivery in flight then fails' });
    let legacyStatus = 'enqueued';
    (h.manager as unknown as { config: Record<string, unknown> }).config.db = {
      getDatabase: () => h.db,
      getSDKMessageRepo: () => ({
        getDeliveryContent: (_sessionId: string, uuid: string) =>
          uuid === row.id ? { content: 'x', sendStatus: legacyStatus } : null,
      }),
    };

    await h.manager.flushPendingMessagesForSpaceAgent(h.spaceId, h.runId);

    expect(h.delivery.calls).toHaveLength(0);
    expect(h.spyRepo.repo.getById(row.id)?.status).toBe('pending');

    legacyStatus = 'failed';
    await new Promise((resolve) => setTimeout(resolve, 60));

    expect(h.delivery.calls).toHaveLength(1);
    expect(h.spyRepo.repo.getById(row.id)?.status).toBe('delivered');
  });

  it('keeps watching legacy in-flight rows and settles them once consumed', async () => {
    const h = makeSpaceAgentHarness({ retryDelayMs: 10 });
    dbByTest.push(h.db);
    const row = h.enqueue({ message: 'legacy delivery in flight then consumed' });
    let legacyStatus = 'submitted';
    (h.manager as unknown as { config: Record<string, unknown> }).config.db = {
      getDatabase: () => h.db,
      getSDKMessageRepo: () => ({
        getDeliveryContent: (_sessionId: string, uuid: string) =>
          uuid === row.id ? { content: 'x', sendStatus: legacyStatus } : null,
      }),
    };

    await h.manager.flushPendingMessagesForSpaceAgent(h.spaceId, h.runId);

    expect(h.spyRepo.repo.getById(row.id)?.status).toBe('pending');

    legacyStatus = 'consumed';
    await new Promise((resolve) => setTimeout(resolve, 60));

    expect(h.delivery.calls).toHaveLength(0);
    const record = h.spyRepo.repo.getById(row.id);
    expect(record?.status).toBe('delivered');
    expect(record?.deliveredSessionId).toBe(`space:chat:${h.spaceId}`);
  });

  it('schedules a failure-driven re-drain that delivers once the door recovers', async () => {
    let doorOpen = false;
    const h = makeSpaceAgentHarness({
      retryDelayMs: 10,
      ensureImpl: async () =>
        doorOpen
          ? { kind: 'resolved', sessionId: `space:agent:${h.spaceId}:coordinator`, created: false }
          : { kind: 'unresolved', reason: 'ensure_failed' },
    });
    dbByTest.push(h.db);
    const row = h.enqueue({ message: 'transient door failure' });

    await h.manager.flushPendingMessagesForSpaceAgent(h.spaceId, h.runId);

    expect(h.delivery.calls).toHaveLength(0);
    expect(h.spyRepo.repo.getById(row.id)?.status).toBe('pending');

    doorOpen = true;
    await new Promise((resolve) => setTimeout(resolve, 60));

    expect(h.delivery.calls).toHaveLength(1);
    expect(h.spyRepo.repo.getById(row.id)?.status).toBe('delivered');
  });

  it('does not arm a re-drain when the drain fully succeeds', async () => {
    const h = makeSpaceAgentHarness();
    dbByTest.push(h.db);
    const row = h.enqueue({ message: 'delivered first try' });

    await h.manager.flushPendingMessagesForSpaceAgent(h.spaceId, h.runId);

    expect(h.delivery.calls).toHaveLength(1);
    expect(h.spyRepo.repo.getById(row.id)?.status).toBe('delivered');
    const timers = (h.manager as unknown as { spaceAgentRetryTimers: Map<string, unknown> })
      .spaceAgentRetryTimers;
    expect(timers.size).toBe(0);
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
      getDatabase: () => h.db,
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

    expect(h.delivery.calls).toHaveLength(0);
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
      getDatabase: () => h.db,
      getSDKMessageRepo: () => ({
        getDeliveryContent: (_sessionId: string, uuid: string) =>
          uuid === row.id ? { content: 'x', sendStatus: 'consumed' } : null,
      }),
    };

    await h.manager.flushPendingMessagesForSpaceAgent(h.spaceId, h.runId);

    expect(h.delivery.calls).toHaveLength(0);
    expect(h.spyRepo.repo.getById(row.id)?.status).toBe('delivered');
    expect(h.spyRepo.repo.getById(row.id)?.deliveredSessionId).toBe(`space:chat:${h.spaceId}`);
    const deliveredAt = h.spyRepo.calls.indexOf(`delivered:${row.id}`);
    const expiredAt = h.spyRepo.calls.indexOf('expireStale');
    expect(deliveredAt).toBeGreaterThanOrEqual(0);
    expect(expiredAt).toBeGreaterThan(deliveredAt);
  });

  it('drains only space_agent rows targeted at the space agent', async () => {
    const h = makeSpaceAgentHarness();
    dbByTest.push(h.db);
    const spaceRow = h.enqueue({ message: 'space row' });
    const nodeRow = h.enqueue({ targetKind: 'node_agent', message: 'node row' });

    await h.manager.flushPendingMessagesForSpaceAgent(h.spaceId, h.runId);

    expect(h.delivery.calls).toHaveLength(1);
    expect(h.delivery.calls[0].args.message).toContain('space row');
    expect(h.spyRepo.repo.getById(spaceRow.id)?.status).toBe('delivered');
    expect(h.spyRepo.repo.getById(nodeRow.id)?.status).toBe('pending');
  });

  it('drains space_agent rows regardless of workflow node scoping', async () => {
    const h = makeSpaceAgentHarness();
    dbByTest.push(h.db);
    const nodeScoped = h.enqueue({ workflowNodeId: 'node-build', message: 'node scoped' });

    await h.manager.flushPendingMessagesForSpaceAgent(h.spaceId, h.runId);

    expect(h.delivery.calls).toHaveLength(1);
    expect(h.spyRepo.repo.getById(nodeScoped.id)?.status).toBe('delivered');
  });

  it('marks rows delivered to the door-resolved coordinator session and emits the delivery event', async () => {
    const h = makeSpaceAgentHarness();
    dbByTest.push(h.db);
    const row = h.enqueue({ message: 'chat row' });

    await h.manager.flushPendingMessagesForSpaceAgent(h.spaceId, h.runId);

    const record = h.spyRepo.repo.getById(row.id);
    expect(record?.status).toBe('delivered');
    expect(record?.deliveredSessionId).toBe(`space:agent:${h.spaceId}:coordinator`);
    expect(h.delivery.calls[0].args.target).toEqual({
      kind: 'agent',
      spaceId: h.spaceId,
      agentId: 'coordinator',
    });
    expect(h.delivery.calls[0].args.origin).toBe('space_agent');
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
      deliveredSessionId: `space:agent:${h.spaceId}:coordinator`,
    });
  });

  it('resolves reply-to from the envelope footer first, then the registry, else the coordinator', async () => {
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

    expect(h.ensureTargetSession.mock.calls.map((call: unknown[]) => call[0])).toEqual([
      { kind: 'session', sessionId: 'footer-session' },
      { kind: 'session', sessionId: 'registry-session' },
      { kind: 'agent', spaceId: h.spaceId, agentId: 'coordinator' },
    ]);
    expect(registry.get.mock.calls.map((call: unknown[]) => call[0])).toEqual(['task-9', 'task-9']);
  });

  it('falls back to the coordinator agent target when a reply session is gone', async () => {
    let coordinator = '';
    const h = makeSpaceAgentHarness({
      ensureImpl: async (target: SessionTarget) =>
        target.kind === 'agent'
          ? { kind: 'resolved', sessionId: coordinator, created: true }
          : { kind: 'unresolved', reason: 'not_found' },
    });
    coordinator = `space:agent:${h.spaceId}:coordinator`;
    dbByTest.push(h.db);
    h.delivery.deliver.mockImplementation(
      async (_runId: string, args: { target: { kind: string }; messageId: string }) =>
        args.target.kind === 'session'
          ? { state: 'not_found' as const, messageId: args.messageId, error: 'not_found' }
          : { state: 'delivered' as const, sessionId: coordinator, messageId: args.messageId }
    );
    const row = h.enqueue({
      message: formatAgentMessage({
        fromLevel: 'node-agent',
        fromAgentName: 'reviewer',
        toLevel: 'space-agent',
        body: 'reply session vanished',
        taskId: 'task-a',
        replyToSessionId: 'gone-session',
      }),
      taskId: 'task-a',
    });

    await h.manager.flushPendingMessagesForSpaceAgent(h.spaceId, h.runId);

    expect(h.ensureTargetSession.mock.calls.map((call: unknown[]) => call[0])).toEqual([
      { kind: 'session', sessionId: 'gone-session' },
      { kind: 'agent', spaceId: h.spaceId, agentId: 'coordinator' },
    ]);
    expect(
      h.delivery.deliver.mock.calls.map(
        (call: unknown[]) => (call[1] as { target: unknown }).target
      )
    ).toEqual([
      { kind: 'session', sessionId: 'gone-session' },
      { kind: 'agent', spaceId: h.spaceId, agentId: 'coordinator' },
    ]);
    expect(h.spyRepo.calls).toContain(`delivered:${row.id}`);
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

    const formatted = h.delivery.calls[0].args.message;
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
    expect(h.delivery.calls[1].args.message).toBe(enveloped);
  });

  it('charges an attempt and continues when routed delivery fails', async () => {
    const h = makeSpaceAgentHarness();
    dbByTest.push(h.db);
    const failingRow = h.enqueue({ message: 'fails first' });
    const laterRow = h.enqueue({ message: 'still drains' });
    h.delivery.failMessageIds.add(failingRow.idempotencyKey ?? failingRow.id);

    await h.manager.flushPendingMessagesForSpaceAgent(h.spaceId, h.runId);

    const failed = h.spyRepo.repo.getById(failingRow.id);
    expect(failed?.status).toBe('pending');
    expect(failed?.attempts).toBe(1);
    expect(h.spyRepo.repo.getById(laterRow.id)?.status).toBe('delivered');
  });

  it('terminalizes rows whose attempt budget is already spent', async () => {
    const h = makeSpaceAgentHarness();
    dbByTest.push(h.db);
    const row = h.enqueue({ message: 'budget spent' });
    for (let i = 0; i < 5; i++) h.spyRepo.repo.markAttemptFailed(row.id, 'historical failure');

    await h.manager.flushPendingMessagesForSpaceAgent(h.spaceId, h.runId);

    expect(h.delivery.calls).toHaveLength(0);
    expect(h.spyRepo.repo.getById(row.id)?.status).toBe('failed');
    expect(h.spyRepo.repo.getById(row.id)?.lastError).toBe('historical failure');
  });
});

describe('injectSubSessionMessageWithOrigin — terminal guard', () => {
  const GUARD_SESSION_ID = 'sub-session-guard';
  const GUARD_RUN_ID = 'run-guard';

  function makeGuardManager(
    taskStatus: string | null,
    runStatus: string
  ): {
    manager: TaskAgentManager;
    saveUserMessage: ReturnType<typeof mock>;
    jobQueueEnqueue: ReturnType<typeof mock>;
    mailboxEnqueue: ReturnType<typeof mock>;
  } {
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
    const saveUserMessage = mock(() => 'db-id');
    const jobQueueEnqueue = mock(
      (args: { payload?: { sessionId?: string; messageUuid?: string } }) => {
        const uuid = args?.payload?.messageUuid;
        if (uuid) signalDeliveryConsumed(args!.payload!.sessionId!, uuid);
        return { id: 'job-1' };
      }
    );
    let guardMailboxConsumed = false;
    const mailboxEnqueue = mock(() => {
      guardMailboxConsumed = true;
      return { id: 'mailbox-job-1' };
    });
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
      db: {
        getDatabase: () => ({}),
        saveUserMessage,
        getUserMessageIdsByStatus: mock(() => []),
        getSDKMessageRepo: () => ({
          getDeliveryContent: () =>
            guardMailboxConsumed ? { content: 'x', sendStatus: 'consumed' } : null,
          getDeliveryMessageIdsByUuids: () => ['db-id'],
          normalizeDeliveryMessageForMailbox: mock(() => false),
          reopenDeliveryByUuid: mock(() => null),
          markDeliveryDeferredByUuid: mock(() => null),
          markDeliveryFailedByUuid: mock(() => null),
          failDeliveryUnlessProcessing: mock(() => null),
        }),
        getJobQueueRepo: () => ({
          activeDeliveryMessageUuids: () => new Set<string>(),
          activeMailboxMessageUuids: () => new Set<string>(),
          mailboxEntryJobStatus: () => 'completed' as const,
          cancelPendingMailboxEntry: () => false,
          cancelHeldDeliveryJob: () => false,
          enqueue: jobQueueEnqueue,
          enqueueUniquePending: mailboxEnqueue,
        }),
      },
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
    return { manager, saveUserMessage, jobQueueEnqueue, mailboxEnqueue };
  }

  it('rejects when the canonical task is cancelled', async () => {
    const { manager } = makeGuardManager('cancelled', 'in_progress');
    await expect(manager.injectSubSessionMessage(GUARD_SESSION_ID, 'note', true)).rejects.toThrow(
      'task/run is terminal (cancelled)'
    );
  });

  it('rejects when the canonical task is archived', async () => {
    const { manager } = makeGuardManager('archived', 'in_progress');
    await expect(manager.injectSubSessionMessage(GUARD_SESSION_ID, 'note', true)).rejects.toThrow(
      'task/run is terminal (archived)'
    );
  });

  it('rejects when the workflow run is cancelled', async () => {
    const { manager } = makeGuardManager(null, 'cancelled');
    await expect(manager.injectSubSessionMessage(GUARD_SESSION_ID, 'note', true)).rejects.toThrow(
      'task/run is terminal (cancelled)'
    );
  });

  it('lets done task and run states through to the durable injection shell', async () => {
    const { manager, saveUserMessage, mailboxEnqueue } = makeGuardManager('done', 'done');

    const dbId = await manager.injectSubSessionMessage(GUARD_SESSION_ID, 'note', true);

    expect(dbId).toBe('db-id');
    expect(saveUserMessage).not.toHaveBeenCalled();
    expect(mailboxEnqueue).toHaveBeenCalledTimes(1);
    const enqueueArgs = mailboxEnqueue.mock.calls[0][0] as {
      queue?: string;
      payload?: { to?: { sessionId?: string }; origin?: string; messageUuid?: string };
    };
    expect(enqueueArgs.queue).toBe('mailbox');
    expect(enqueueArgs.payload?.to?.sessionId).toBe(GUARD_SESSION_ID);
    expect(enqueueArgs.payload?.origin).toBe('space_inject');
    expect(typeof enqueueArgs.payload?.messageUuid).toBe('string');
  });

  it('rejects runtime-origin injections when the canonical task is done (#3109)', async () => {
    const { manager } = makeGuardManager('done', 'in_progress');

    await expect(
      manager.injectRuntimeRecoveryMessage(GUARD_SESSION_ID, 'recovery nag')
    ).rejects.toThrow('task/run is terminal (done)');
  });
});
