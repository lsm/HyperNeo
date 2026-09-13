import { afterEach, beforeEach, expect, mock, test } from 'bun:test';
import type { NodeExecution, Session, SpaceLongHorizonAgent, SpaceTask } from '@hyperneo/shared';
import { invokeOperation } from '../../../../src/lib/operations/invoke';
import { createOperationRegistry } from '../../../../src/lib/operations/registry';
import { longTermAgentSessionId } from '../../../../src/lib/space/long-term-agent-session';
import { SpaceTaskManager } from '../../../../src/lib/space/managers/space-task-manager';
import {
  createOwnedPendingCompletionOperation,
  loadCompletionTarget,
  type OwnedPendingCompletionDependencies,
  requireCompletionTarget,
  resolveCompletionActor,
} from '../../../../src/lib/space/operations/owned-pending-completion';
import { SessionRepository } from '../../../../src/storage/repositories/session-repository';
import { SpaceRepository } from '../../../../src/storage/repositories/space-repository';
import { SpaceTaskRepository } from '../../../../src/storage/repositories/space-task-repository';
import { Database } from '../../../../src/storage/sqlite-compat';
import { createTestSession } from '../../../helpers/database';
import { createSpaceTables } from '../../helpers/space-test-db';

let db: Database;
let spaceId: string;
let task: SpaceTask;
let tasks: SpaceTaskRepository;
let sessions: SessionRepository;
let dependencies: OwnedPendingCompletionDependencies;
let order: string[];
const coordinator = { id: 'default-agent' } as SpaceLongHorizonAgent;

beforeEach(() => {
  db = new Database(':memory:');
  createSpaceTables(db);
  spaceId = new SpaceRepository(db).createSpace({
    name: 'Space',
    slug: 'space',
    workspacePath: '/repo',
  }).id;
  tasks = new SpaceTaskRepository(db);
  sessions = new SessionRepository(db);
  const created = tasks.createTask({ spaceId, title: 'Task', description: '', status: 'review' });
  task = tasks.updateTask(created.id, { pendingCheckpointType: 'task_completion' })!;
  order = [];
  dependencies = {
    getSession: (id) => sessions.getSession(id),
    getTask: (id) => tasks.getTask(id),
    coordinatorLookup: { getCoordinator: () => coordinator },
    getSpaceAutonomyLevel: async () => 5,
    policyContext: {
      longHorizonAgentRepo: {
        getById: (id) => ({ id, spaceId, status: 'active' }) as unknown as SpaceLongHorizonAgent,
      },
    },
    getTaskManager: mock((id) => new SpaceTaskManager(db, id)),
    dispatchApproval: mock(async (owner, id, source, reason, guard) => {
      expect(owner).toBe(spaceId);
      expect(source).toBe('human');
      await new SpaceTaskManager(db, owner).setTaskStatus(id, 'approved', {
        ...guard,
        approvalSource: source,
        approvalReason: reason,
      });
      order.push('dispatch');
    }),
    warn: mock(() => {}),
    emitTaskUpdated: mock(async () => {
      order.push('event');
    }),
    audit: mock(() => {
      order.push('audit');
    }),
  };
});
afterEach(() => db.close());

function persist(
  type: Session['type'],
  id = 'session',
  owner: string | null = spaceId,
  agentId?: string
) {
  const session: Session = {
    ...createTestSession(id),
    type,
    workspacePath: '/repo',
    context: owner ? { spaceId: owner } : undefined,
    ...(agentId ? { metadata: { promptProvenance: { agentId } } } : {}),
  };
  sessions.createSession(session, { enforceWorkspaceOwnership: false });
  return session;
}

function invoke(
  sessionId?: string,
  input: unknown = { taskId: task.id, approved: true },
  source: 'rpc' | 'mcp' | 'internal' = 'mcp'
) {
  return invokeOperation(
    createOperationRegistry([createOwnedPendingCompletionOperation(dependencies)]),
    'task.resolvePendingCompletion',
    input,
    { source, sessionId }
  );
}

test.each(['chat', 'legacy-chat', 'default-agent', 'legacy-task'] as const)(
  'admits persisted %s and preserves result and audit',
  async (kind) => {
    const session =
      kind === 'chat' || kind === 'legacy-chat'
        ? persist('space_chat', `space:chat:${spaceId}`, kind === 'legacy-chat' ? null : spaceId)
        : kind === 'default-agent'
          ? persist(
              'worker',
              longTermAgentSessionId(spaceId, coordinator.id),
              spaceId,
              coordinator.id
            )
          : persist('space_task_agent');
    const outcome = await invoke(session.id, {
      taskId: task.id,
      approved: true,
      reason: '  raw  ',
    });
    expect(outcome.kind).toBe('completed');
    if (outcome.kind !== 'completed') throw new Error(outcome.message);
    expect(outcome.value).toMatchObject({
      id: task.id,
      status: 'approved',
      approvalSource: 'human',
      approvalReason: '  raw  ',
      approvedAt: expect.any(Number),
      pendingCheckpointType: null,
    });
    expect(order).toEqual(['dispatch', 'event', 'audit']);
    expect(dependencies.audit).toHaveBeenCalledWith(
      expect.objectContaining({ id: session.id }),
      expect.objectContaining({ status: 'review' }),
      { taskId: task.id, approved: true, reason: '  raw  ' }
    );
    expect(dependencies.emitTaskUpdated).toHaveBeenCalledTimes(1);
  }
);

test.each(['rpc', 'internal'] as const)(
  'trusted %s caller needs no session and creates no MCP audit',
  async (source) => {
    expect((await invoke(undefined, undefined, source)).kind).toBe('completed');
    expect(order).toEqual(['dispatch', 'event']);
    expect(dependencies.audit).not.toHaveBeenCalled();
  }
);

test.each(['missing', 'ordinary', 'member', 'noncanonical-chat', 'missing-coordinator'] as const)(
  'denies %s before mutation',
  async (kind) => {
    let session: Session | undefined;
    if (kind === 'ordinary') session = persist('worker', 'ordinary', null);
    if (kind === 'member') session = persist('worker');
    if (kind === 'noncanonical-chat') session = persist('space_chat', 'not-canonical');
    if (kind === 'missing-coordinator') {
      session = persist('space_chat', `space:chat:${spaceId}`);
      dependencies.coordinatorLookup = { getCoordinator: () => null };
    }
    const outcome = await invoke(session?.id ?? 'missing');
    expect(outcome.kind).toBe('failed');
    expect(dependencies.getTaskManager).not.toHaveBeenCalled();
    expect(order).toEqual([]);
    expect(tasks.getTask(task.id)?.status).toBe('review');
  }
);

test('admits a Space agent that is not the space manager', async () => {
  const session = persist('worker', longTermAgentSessionId(spaceId, 'other'), spaceId, 'other');
  expect((await invoke(session.id)).kind).toBe('completed');
  expect(tasks.getTask(task.id)?.status).toBe('approved');
});

test('denies a long-term agent session whose backing agent is no longer active', async () => {
  const session = persist('worker', longTermAgentSessionId(spaceId, 'agent-1'), spaceId, 'agent-1');
  dependencies.policyContext = {
    longHorizonAgentRepo: {
      getById: () =>
        ({ id: 'agent-1', spaceId, status: 'paused' }) as unknown as SpaceLongHorizonAgent,
    },
  };
  const outcome = await invoke(session.id);
  expect(outcome.kind).toBe('failed');
  expect(dependencies.getTaskManager).not.toHaveBeenCalled();
  expect(tasks.getTask(task.id)?.status).toBe('review');
});

test('admits a long-term agent session whose backing agent is still active', async () => {
  const session = persist('worker', longTermAgentSessionId(spaceId, 'agent-1'), spaceId, 'agent-1');
  dependencies.policyContext = {
    longHorizonAgentRepo: {
      getById: () =>
        ({ id: 'agent-1', spaceId, status: 'active' }) as unknown as SpaceLongHorizonAgent,
    },
  };
  expect((await invoke(session.id)).kind).toBe('completed');
  expect(tasks.getTask(task.id)?.status).toBe('approved');
});

test('denies a long-term agent below the required autonomy level via the operations MCP path', async () => {
  const session = persist('worker', longTermAgentSessionId(spaceId, 'other'), spaceId, 'other');
  dependencies.getSpaceAutonomyLevel = async () => 4;
  const outcome = await invoke(session.id);
  expect(outcome).toMatchObject({
    kind: 'failed',
    message: expect.stringContaining('space autonomy level 4 < required level 5'),
  });
  expect(dependencies.getTaskManager).not.toHaveBeenCalled();
  expect(tasks.getTask(task.id)?.status).toBe('review');
});

test('admits a long-term agent at the required autonomy level via the operations MCP path', async () => {
  const session = persist('worker', longTermAgentSessionId(spaceId, 'other'), spaceId, 'other');
  dependencies.getSpaceAutonomyLevel = async () => 5;
  expect((await invoke(session.id)).kind).toBe('completed');
  expect(tasks.getTask(task.id)?.status).toBe('approved');
});

test('denies a canonical space-chat caller below the required autonomy level', async () => {
  const session = persist('space_chat', `space:chat:${spaceId}`, spaceId);
  dependencies.getSpaceAutonomyLevel = async () => 4;
  const outcome = await invoke(session.id);
  expect(outcome.kind).toBe('failed');
  expect(tasks.getTask(task.id)?.status).toBe('review');
});

test('legacy task-agent caller bypasses the operations-path autonomy gate entirely', async () => {
  const session = persist('space_task_agent');
  dependencies.getSpaceAutonomyLevel = async () => 1;
  expect((await invoke(session.id)).kind).toBe('completed');
  expect(tasks.getTask(task.id)?.status).toBe('approved');
});

test('denies workflow worker even with default-agent provenance', async () => {
  const session = persist('worker', 'worker', spaceId, coordinator.id);
  dependencies.policyContext = {
    nodeExecutionRepo: {
      getByAgentSessionId: () => ({ id: 'execution' }) as NodeExecution,
      getById: () => null,
    },
    taskRepo: tasks,
  };
  expect((await invoke(session.id)).kind).toBe('failed');
  expect(dependencies.getTaskManager).not.toHaveBeenCalled();
});

test('denies cross-Space actor before task mutation', async () => {
  const session = persist('space_task_agent', 'foreign', 'other-space');
  const outcome = await invoke(session.id);
  expect(outcome).toMatchObject({
    kind: 'failed',
    code: 'execution_failed',
    message: expect.stringContaining('does not belong'),
  });
  expect(order).toEqual([]);
});

test('target gates reject absent, standalone and non-review checkpoints', async () => {
  const input = { taskId: task.id, approved: true };
  const actor = { source: 'rpc' as const };
  expect(await loadCompletionTarget(input, actor, async () => null)).toEqual({
    reason: expect.any(Error),
  });
  expect(requireCompletionTarget({ ...task, spaceId: '' }, input, actor)).toEqual({
    reason: expect.any(Error),
  });
  expect(requireCompletionTarget({ ...task, pendingCheckpointType: null }, input, actor)).toEqual({
    reason: expect.any(Error),
  });
  expect(requireCompletionTarget({ ...task, status: 'open' }, input, actor)).toEqual({
    reason: expect.any(Error),
  });
  expect(requireCompletionTarget(task, input, actor)).toEqual({ value: task });
  expect(
    resolveCompletionActor({ source: 'mcp' }, () => null, dependencies.coordinatorLookup, {})
  ).toEqual({ reason: expect.any(Error) });
});

test.each([
  { taskId: 'task', approved: 'yes' },
  { taskId: 'task', approved: true, role: 'coordinator' },
])('schema rejects caller-controlled fields or wrong types %j', async (input) => {
  expect(await invoke(undefined, input, 'rpc')).toMatchObject({
    kind: 'failed',
    code: 'invalid_input',
  });
  expect(order).toEqual([]);
});

test('committed dispatch warning survives catalog result validation', async () => {
  dependencies.dispatchApproval = async (_owner, id) => {
    tasks.updateTask(id, { status: 'approved', approvalSource: 'human' });
    throw new Error('interrupted');
  };
  const outcome = await invoke(undefined, undefined, 'rpc');
  expect(outcome).toMatchObject({
    kind: 'completed',
    value: {
      status: 'approved',
      postApprovalBlockedReason: expect.stringContaining('Approval recorded'),
    },
  });
  expect(dependencies.warn).toHaveBeenCalledWith(task.id, 'interrupted');
  expect(order).toEqual(['event']);
});

test('pre-commit failure produces no event or audit', async () => {
  const session = persist('space_task_agent');
  dependencies.dispatchApproval = async () => {
    throw new Error('failure');
  };
  expect(await invoke(session.id)).toMatchObject({
    kind: 'failed',
    code: 'execution_failed',
    message: 'failure',
  });
  expect(order).toEqual([]);
});

test('rejection preserves reason and ignores best-effort event/audit failures', async () => {
  const session = persist('space_task_agent');
  dependencies.emitTaskUpdated = async () => {
    order.push('event');
    throw new Error('event');
  };
  dependencies.audit = () => {
    order.push('audit');
    throw new Error('audit');
  };
  const outcome = await invoke(session.id, { taskId: task.id, approved: false, reason: '' });
  expect(outcome).toMatchObject({
    kind: 'completed',
    value: { status: 'in_progress', approvalReason: '' },
  });
  expect(order).toEqual(['event', 'audit']);
  expect(dependencies.dispatchApproval).not.toHaveBeenCalled();
});

test('opposing owned decisions admit one generation and produce one successful notification', async () => {
  const session = persist('space_task_agent');
  let arrivals = 0;
  let release!: () => void;
  const barrier = new Promise<void>((resolve) => {
    release = resolve;
  });
  dependencies.getTask = async (id) => {
    const snapshot = tasks.getTask(id);
    if (++arrivals === 2) release();
    await barrier;
    return snapshot;
  };
  const results = await Promise.all([
    invoke(session.id, { taskId: task.id, approved: true }),
    invoke(session.id, { taskId: task.id, approved: false }),
  ]);
  expect(results.filter((result) => result.kind === 'completed')).toHaveLength(1);
  expect(results.find((result) => result.kind === 'failed')).toMatchObject({
    code: 'execution_failed',
    message: expect.stringContaining('superseded'),
  });
  expect(dependencies.emitTaskUpdated).toHaveBeenCalledTimes(1);
  expect(dependencies.audit).toHaveBeenCalledTimes(1);
  expect(dependencies.warn).not.toHaveBeenCalled();
});

test.each([true, false])(
  'refreshed checkpoint supersedes owned decision before write (approved=%s)',
  async (approved) => {
    const session = persist('space_task_agent');
    dependencies.getTaskManager = (owner) => {
      tasks.updateTask(task.id, {
        status: 'review',
        pendingCheckpointType: 'task_completion',
        pendingCompletionReason: 'new review',
      });
      return new SpaceTaskManager(db, owner);
    };
    const outcome = await invoke(session.id, { taskId: task.id, approved });
    expect(outcome).toMatchObject({
      kind: 'failed',
      code: 'execution_failed',
      message: expect.stringContaining('superseded'),
    });
    expect(tasks.getTask(task.id)).toMatchObject({
      status: 'review',
      pendingCompletionGeneration: 1,
      pendingCompletionReason: 'new review',
    });
    expect(dependencies.emitTaskUpdated).not.toHaveBeenCalled();
    expect(dependencies.audit).not.toHaveBeenCalled();
    expect(dependencies.warn).not.toHaveBeenCalled();
  }
);
