import { afterEach, beforeEach, expect, mock, test } from 'bun:test';
import { AgentSession } from '../../../../src/lib/agent/agent-session';
import { SpaceRuntimeService } from '../../../../src/lib/space/runtime/space-runtime-service';
import { resolveSpaceMcpSessionPolicy } from '../../../../src/lib/space/runtime/space-mcp-session-policy';
import { createDatabaseDirectTaskWorkerResolver } from '../../../../src/lib/tasks/direct-task-worker-identity';
import { Database } from '../../../../src/storage/sqlite-compat';
import { SessionRepository } from '../../../../src/storage/repositories/session-repository';
import { SpaceTaskRepository } from '../../../../src/storage/repositories/space-task-repository';
import { SpaceRepository } from '../../../../src/storage/repositories/space-repository';
import { DirectTaskExecutionRepository } from '../../../../src/storage/repositories/direct-task-execution-repository';
import { createSpaceTables } from '../../helpers/space-test-db';
import { createTestSession } from '../../../helpers/database';

let db: Database;
let sessions: SessionRepository;
let tasks: SpaceTaskRepository;
let attempts: DirectTaskExecutionRepository;
let spaceId: string;
let taskId: string;
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
  attempts = new DirectTaskExecutionRepository(db);
  taskId = tasks.createTask({ spaceId, title: 'Task', description: '' }).id;
  sessions.createSession(
    { ...createTestSession('direct'), context: { spaceId, taskId } },
    { enforceWorkspaceOwnership: false }
  );
  attempts.select(taskId);
  attempts.claim(taskId, 'attempt', 'direct');
});
afterEach(() => db.close());

function policy() {
  return resolveSpaceMcpSessionPolicy(sessions.getSession('direct')!, {
    resolveDirectWorker: createDatabaseDirectTaskWorkerResolver(db),
    hasDirectWorkerProvenance: (id) => attempts.hasSessionProvenance(id),
  });
}

test('reserved and running identities never inherit legacy or member tools', () => {
  for (const phase of ['reserved', 'running']) {
    if (phase === 'running') attempts.activate('attempt', 'direct');
    expect(policy()).toEqual({
      role: 'direct_task_worker',
      owner: 'direct-task-executor',
      spaceId,
      isWorkflowWorker: false,
      requiredServers: [],
      attachLongTermAgentTools: false,
    });
  }
});

test('stopped or mismatched provenance remains dormant without execution ownership', () => {
  attempts.stop('attempt', 'direct', 'cancelled');
  expect(policy()).toMatchObject({
    role: 'direct_task_worker',
    owner: 'none',
  });
  sessions.updateSession('direct', { type: 'space_task_agent', context: { spaceId: 'other' } });
  expect(policy()).toMatchObject({
    role: 'direct_task_worker',
    owner: 'none',
    requiredServers: [],
  });
});

test('an unowned Space session stays outside the Space with or without direct-worker lookups', () => {
  const session = { ...createTestSession('ordinary'), context: { spaceId } };
  const plain = resolveSpaceMcpSessionPolicy(session);
  const resolveDirectWorker = mock(createDatabaseDirectTaskWorkerResolver(db));
  expect(
    resolveSpaceMcpSessionPolicy(session, {
      resolveDirectWorker,
      hasDirectWorkerProvenance: (id) => attempts.hasSessionProvenance(id),
    })
  ).toEqual(plain);
  expect(plain.role).toBe('universal_read');
  expect(resolveDirectWorker).not.toHaveBeenCalled();
});

test.each([
  'reserved',
  'running',
  'stopped',
  'mismatched',
  'task_deleted',
  'space_deleted',
] as const)('workflow provisioning does not load or replay a %s direct session', async (state) => {
  if (state === 'task_deleted') db.prepare('DELETE FROM space_tasks WHERE id = ?').run(taskId);
  if (state === 'space_deleted') db.prepare('DELETE FROM spaces WHERE id = ?').run(spaceId);
  if (state === 'task_deleted' || state === 'space_deleted') {
    sessions.updateSession('direct', { context: {} });
    expect(policy()).toMatchObject({ role: 'direct_task_worker', owner: 'none' });
  }
  if (state === 'running') attempts.activate('attempt', 'direct');
  if (state === 'stopped') attempts.stop('attempt', 'direct', 'cancelled');
  if (state === 'mismatched')
    sessions.updateSession('direct', { context: { spaceId, taskId: 'other' } });
  const provisionWorkflowSession = mock(async () => {});
  const mcpSelfHeal = mock(async () => {});
  const getSpace = mock(async () => null);
  const getSessionAsync = mock(async () => null);
  const provisioner = Object.assign(Object.create(SpaceRuntimeService.prototype), {
    taskAgentManager: { provisionWorkflowSession, mcpSelfHeal },
    config: {
      db,
      taskRepo: tasks,
      spaceManager: { getSpace },
      sessionManager: { getSessionAsync },
    },
  }) as SpaceRuntimeService;
  const agent = { getSessionData: () => sessions.getSession('direct')! } as AgentSession;
  await provisioner.provisionWorkflowSession(agent, {
    startQuery: true,
    replayPendingMessages: true,
  });
  await provisioner.reattachWorkflowMcpServers(agent, ['space-actions']);
  expect(provisionWorkflowSession).not.toHaveBeenCalled();
  expect(mcpSelfHeal).not.toHaveBeenCalled();
  expect(getSpace).not.toHaveBeenCalled();
  expect(getSessionAsync).not.toHaveBeenCalled();
});

test.each([
  'reserved',
  'running',
  'stopped',
  'mismatched',
  'task_deleted',
  'space_deleted',
] as const)(
  'both provider startup paths reject %s direct provenance before SDK startup',
  async (state) => {
    if (state === 'task_deleted') db.prepare('DELETE FROM space_tasks WHERE id = ?').run(taskId);
    if (state === 'space_deleted') db.prepare('DELETE FROM spaces WHERE id = ?').run(spaceId);
    if (state === 'task_deleted' || state === 'space_deleted') {
      sessions.updateSession('direct', { context: {} });
      expect(policy()).toMatchObject({ role: 'direct_task_worker', owner: 'none' });
    }
    if (state === 'running') attempts.activate('attempt', 'direct');
    if (state === 'stopped') attempts.stop('attempt', 'direct', 'cancelled');
    if (state === 'mismatched') sessions.updateSession('direct', { context: {} });
    for (const provider of [undefined, 'acp']) {
      const start = mock(async () => {});
      const session = sessions.getSession('direct')!;
      const target = {
        session: { ...session, config: { ...session.config, provider } },
        db: { getDatabase: () => db },
        queryRunner: { start },
      } as unknown as AgentSession;
      await expect(AgentSession.prototype.startStreamingQuery.call(target)).rejects.toThrow(
        'executor activation admission'
      );
      expect(start).not.toHaveBeenCalled();
    }
  }
);

test('ordinary query startup still invokes its existing runner', async () => {
  const start = mock(async () => {});
  const target = {
    session: createTestSession('ordinary'),
    db: { getDatabase: () => db },
    queryRunner: { start },
  } as unknown as AgentSession;
  await AgentSession.prototype.startStreamingQuery.call(target);
  expect(start).toHaveBeenCalledTimes(1);
});
