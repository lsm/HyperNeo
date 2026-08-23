import { describe, expect, test } from 'bun:test';
import type {
  NodeExecution,
  Space,
  SpaceTask,
  SpaceWorkflow,
  SpaceWorkflowRun,
} from '@hyperneo/shared';
import type { AgentSession } from '../../../../src/lib/agent/agent-session.ts';
import type { DaemonInternalEventMap } from '../../../../src/lib/internal-event-bus.ts';
import { InternalEventBus } from '../../../../src/lib/internal-event-bus.ts';
import type { TaskAgentManagerConfig } from '../../../../src/lib/space/runtime/task-agent-manager.ts';
import { TaskAgentManager } from '../../../../src/lib/space/runtime/task-agent-manager.ts';
import { NodeExecutionRepository } from '../../../../src/storage/repositories/node-execution-repository';
import { SpaceRepository } from '../../../../src/storage/repositories/space-repository';
import { SpaceTaskRepository } from '../../../../src/storage/repositories/space-task-repository';
import { SpaceWorkflowRunRepository } from '../../../../src/storage/repositories/space-workflow-run-repository';
import { Database as BunDatabase } from '../../../../src/storage/sqlite-compat';
import { createSpaceTables } from '../../helpers/space-test-db';

const TASK_ID = 'task-1241';
const RUN_ID = 'run-1241';
const SPACE_ID = 'space-1241';
const NODE_ID = 'node-coder';
const AGENT_NAME = 'coder';
const AGENT_ID = 'agent-coder';
const SPAWNED_SESSION_ID = 'spawned-session-real-1';

function makeExecutionRow(execRepo: NodeExecutionRepository, runId: string): NodeExecution {
  return execRepo.create({
    workflowRunId: runId,
    workflowNodeId: NODE_ID,
    agentName: AGENT_NAME,
    agentId: AGENT_ID,
    status: 'pending',
  });
}

function makeWorkflow(): SpaceWorkflow {
  return {
    id: 'wf-1',
    spaceId: SPACE_ID,
    name: 'Coding',
    nodes: [
      { id: NODE_ID, agents: [{ agentId: AGENT_ID, name: AGENT_NAME }] },
      { id: 'node-reviewer', agents: [{ agentId: AGENT_ID, name: 'reviewer' }] },
    ],
    channels: [],
    startNodeId: NODE_ID,
    endNodeId: NODE_ID,
  } as unknown as SpaceWorkflow;
}

function fakeSession(id: string): AgentSession {
  return {
    session: { id },
    getProcessingState: () => ({ status: 'idle' }),
  } as unknown as AgentSession;
}

function fakeCustomAgent() {
  return { id: AGENT_ID, name: AGENT_NAME, customPrompt: 'work', model: 'm', tools: [] };
}

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

interface RealRepoHarness {
  tam: TaskAgentManager;
  execRepo: NodeExecutionRepository;
  taskRepo: SpaceTaskRepository;
  runId: string;
  cancels: string[];
  order: string[];
  workspaceGate: Promise<{ path: string }>;
  releaseWorkspaceGate: (value: { path: string }) => void;
  spawn: (execution: NodeExecution) => Promise<string>;
}

function makeRealRepoHarness(options: { taskStatus?: string } = {}): RealRepoHarness {
  const db = new BunDatabase(':memory:');
  createSpaceTables(db);
  const spaceRow = new SpaceRepository(db).createSpace({
    workspacePath: '/tmp/ws-1241',
    slug: 'spawn-cas',
    name: 'Spawn CAS',
  } as never);
  const spaceId = spaceRow.id;
  const now = Date.now();
  db.prepare(
    `INSERT INTO space_workflows (id, space_id, name, created_at, updated_at) VALUES (?, ?, ?, ?, ?)`
  ).run('wf-1241', spaceId, 'Coding', now, now);
  const runRow = new SpaceWorkflowRunRepository(db).createRun({
    spaceId,
    workflowId: 'wf-1241',
    title: 'Run #1',
  });
  db.prepare(
    `INSERT INTO space_agents (id, space_id, name, created_at, updated_at) VALUES (?, ?, ?, ?, ?)`
  ).run(AGENT_ID, spaceId, 'Coder', now, now);
  const execRepo = new NodeExecutionRepository(db);
  const taskRepo = new SpaceTaskRepository(db);
  const cancels: string[] = [];
  const order: string[] = [];
  const workspaceGate = deferred<{ path: string }>();

  taskRepo.createTaskWithId(TASK_ID, {
    spaceId,
    workflowRunId: runRow.id,
    title: 'After-picture spawn CAS',
    description: '',
    status: options.taskStatus ?? 'in_progress',
  } as never);

  const tam = new TaskAgentManager({
    db: { getDatabase: () => db, getSession: () => null },
    sessionManager: { registerSession: () => {}, getSession: () => undefined },
    internalEventBus: new InternalEventBus<DaemonInternalEventMap>(),
    taskRepo,
    nodeExecutionRepo: execRepo,
    spaceManager: { getSpace: async () => ({ id: SPACE_ID, workspacePath: '/tmp/ws' }) },
    spaceAgentManager: {
      getById: (id: string) => (id !== AGENT_ID ? undefined : fakeCustomAgent()),
    },
    worktreeManager: { createTaskWorktree: () => workspaceGate.promise },
  } as unknown as TaskAgentManagerConfig);

  const internal = tam as unknown as {
    createSubSession: (...args: unknown[]) => Promise<string>;
    getSubSession: (id: string) => AgentSession | undefined;
    ensureNodeAgentAttached: (...args: unknown[]) => Promise<void>;
    registerCompletionCallback: (...args: unknown[]) => void;
    injectMessageIntoSession: (...args: unknown[]) => Promise<string>;
    cancelBySessionId: (id: string) => void;
    buildNodeAgentMcpServerForSession: (...args: unknown[]) => unknown;
  };
  internal.createSubSession = async () => {
    order.push('createSubSession');
    return SPAWNED_SESSION_ID;
  };
  internal.getSubSession = (id: string) =>
    id === SPAWNED_SESSION_ID ? fakeSession(id) : undefined;
  internal.ensureNodeAgentAttached = async () => {
    order.push('ensureNodeAgentAttached');
  };
  internal.registerCompletionCallback = () => {};
  internal.injectMessageIntoSession = async () => 'msg-id';
  internal.cancelBySessionId = (id: string) => {
    cancels.push(id);
  };
  internal.buildNodeAgentMcpServerForSession = () => ({ __role: 'node-agent' });

  const task = {
    id: TASK_ID,
    spaceId: SPACE_ID,
    workflowRunId: RUN_ID,
    title: 'After-picture spawn CAS',
    description: '',
    status: options.taskStatus ?? 'in_progress',
  } as unknown as SpaceTask;
  const space = { id: SPACE_ID, workspacePath: '/tmp/ws' } as unknown as Space;
  const workflowRun = {
    id: RUN_ID,
    workflowId: 'wf-1',
    status: 'in_progress',
  } as unknown as SpaceWorkflowRun;

  return {
    tam,
    execRepo,
    taskRepo,
    runId: runRow.id,
    cancels,
    order,
    workspaceGate: workspaceGate.promise,
    releaseWorkspaceGate: workspaceGate.resolve,
    spawn: (execution) =>
      tam.spawnWorkflowNodeAgentForExecution(task, space, makeWorkflow(), workflowRun, execution, {
        kickoff: false,
      }),
  };
}

describe('spawnWorkflowNodeAgentForExecution — concurrent park/cancel during spawn (AFTER picture, superpipe P5)', () => {
  test('a mid-spawn-loop park (task → stopped) supersedes the next execution reservation: the remainder does not spawn, no unhandled rejection', async () => {
    const unhandled: unknown[] = [];
    const onUnhandled = (err: unknown) => unhandled.push(err);
    process.on('unhandledRejection', onUnhandled);
    const h = makeRealRepoHarness();
    const first = makeExecutionRow(h.execRepo, h.runId);
    const remainder = h.execRepo.create({
      workflowRunId: h.runId,
      workflowNodeId: 'node-reviewer',
      agentName: 'reviewer',
      agentId: AGENT_ID,
      status: 'pending',
    });
    const firstSpawn = h.spawn(first);
    const firstSpawnMessage = firstSpawn.then(
      (id) => `resolved:${id}`,
      (err: unknown) => (err instanceof Error ? err.message : String(err))
    );

    h.taskRepo.updateTask(TASK_ID, { status: 'stopped' });
    const remainderSpawn = h.spawn(remainder);
    const remainderMessage = remainderSpawn.then(
      (id) => `resolved:${id}`,
      (err: unknown) => (err instanceof Error ? err.message : String(err))
    );
    h.releaseWorkspaceGate({ path: '/tmp/wt-1241' });

    expect(await remainderMessage).toContain('superseded at stage reserve-task-spawn');
    expect(h.execRepo.getById(remainder.id)?.status).toBe('pending');
    expect(h.execRepo.getById(remainder.id)?.agentSessionId).toBeNull();
    expect(await firstSpawnMessage).toBe(`resolved:${SPAWNED_SESSION_ID}`);
    expect(h.execRepo.getById(first.id)?.status).toBe('in_progress');
    const task = h.taskRepo.getTask(TASK_ID);
    expect(task?.status).toBe('stopped');
    expect(unhandled).toEqual([]);
    process.off('unhandledRejection', onUnhandled);
  });

  test('a mid-spawn execution cancel loses nothing: the bind CAS supersedes, the spawned session is compensated, and the cancelled row is not resurrected', async () => {
    const unhandled: unknown[] = [];
    const onUnhandled = (err: unknown) => unhandled.push(err);
    process.on('unhandledRejection', onUnhandled);
    const h = makeRealRepoHarness();
    const execution = makeExecutionRow(h.execRepo, h.runId);
    const spawnPromise = h.spawn(execution);
    const spawnMessage = spawnPromise.then(
      () => 'resolved',
      (err: unknown) => (err instanceof Error ? err.message : String(err))
    );

    h.execRepo.update(execution.id, {
      status: 'cancelled',
      result: 'cancelled concurrently',
      completedAt: Date.now(),
    });
    h.releaseWorkspaceGate({ path: '/tmp/wt-1241' });

    expect(await spawnMessage).toContain('superseded at stage bind-execution-session');
    expect(h.order).toEqual(['createSubSession']);
    expect(h.order).not.toContain('ensureNodeAgentAttached');
    expect(h.cancels).toEqual([SPAWNED_SESSION_ID]);
    const row = h.execRepo.getById(execution.id);
    expect(row?.status).toBe('cancelled');
    expect(row?.result).toBe('cancelled concurrently');
    expect(row?.agentSessionId).toBeNull();
    expect(h.taskRepo.getTask(TASK_ID)?.status).toBe('in_progress');
    expect(unhandled).toEqual([]);
    process.off('unhandledRejection', onUnhandled);
  });

  test('a spawned execution binds through CAS and the task reservation is released on success', async () => {
    const h = makeRealRepoHarness();
    const execution = makeExecutionRow(h.execRepo, h.runId);
    const spawnPromise = h.spawn(execution);

    h.releaseWorkspaceGate({ path: '/tmp/wt-1241' });

    await expect(spawnPromise).resolves.toBe(SPAWNED_SESSION_ID);
    const row = h.execRepo.getById(execution.id);
    expect(row?.status).toBe('in_progress');
    expect(row?.agentSessionId).toBe(SPAWNED_SESSION_ID);
    expect(row?.startedAt).not.toBeNull();
    const task = h.taskRepo.getTask(TASK_ID);
    expect(task).not.toBeNull();
    expect(h.taskRepo.reserveSpawnForTick(TASK_ID, ['in_progress', 'open'])).toBe('won');
  });

  test('an attach stall releases the task reservation before slow post-bind work: a sibling execution still spawns (PR #2770 review)', async () => {
    const unhandled: unknown[] = [];
    const onUnhandled = (err: unknown) => unhandled.push(err);
    process.on('unhandledRejection', onUnhandled);
    const attachGate = deferred<void>();
    const h = makeRealRepoHarness();
    h.tam as unknown as { ensureNodeAgentAttached: (...args: unknown[]) => Promise<void> };
    const internal = h.tam as unknown as {
      ensureNodeAgentAttached: (...args: unknown[]) => Promise<void>;
    };
    const originalAttach = internal.ensureNodeAgentAttached.bind(internal);
    let attachCalls = 0;
    internal.ensureNodeAgentAttached = async (...args: unknown[]) => {
      attachCalls += 1;
      if (attachCalls === 1) await attachGate.promise;
      await originalAttach(...args);
    };
    const first = makeExecutionRow(h.execRepo, h.runId);
    const sibling = h.execRepo.create({
      workflowRunId: h.runId,
      workflowNodeId: 'node-reviewer',
      agentName: 'reviewer',
      agentId: AGENT_ID,
      status: 'pending',
    });

    const firstSpawn = h.spawn(first);
    h.releaseWorkspaceGate({ path: '/tmp/wt-1241' });
    await new Promise<void>((resolve) => setImmediate(resolve));
    const siblingSpawn = h.spawn(sibling);

    await expect(siblingSpawn).resolves.toBe(SPAWNED_SESSION_ID);
    expect(h.execRepo.getById(sibling.id)?.status).toBe('in_progress');
    expect(h.execRepo.getById(first.id)?.status).toBe('in_progress');

    attachGate.resolve();
    await expect(firstSpawn).resolves.toBe(SPAWNED_SESSION_ID);
    expect(unhandled).toEqual([]);
    process.off('unhandledRejection', onUnhandled);
  });
});
