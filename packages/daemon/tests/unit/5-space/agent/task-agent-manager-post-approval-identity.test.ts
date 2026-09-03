import { beforeEach, describe, expect, it } from 'bun:test';
import type { DaemonInternalEventMap } from '../../../../src/lib/internal-event-bus';
import { InternalEventBus } from '../../../../src/lib/internal-event-bus';
import type { TaskAgentManagerConfig } from '../../../../src/lib/space/runtime/task-agent-manager';
import { TaskAgentManager } from '../../../../src/lib/space/runtime/task-agent-manager';
import { SpaceTaskRepository } from '../../../../src/storage/repositories/space-task-repository';
import { createTables } from '../../../../src/storage/schema';
import { Database as BunDatabase } from '../../../../src/storage/sqlite-compat';

const SPACE_ID = 'space-id';
const RUN_ID = 'run-1';
const TASK_ID = 'task-1';
const POST_APPROVAL_NODE = 'node-post-approval';

function postApprovalSessionId(name: string): string {
  return `space:${SPACE_ID}:task:${TASK_ID}:post-approval:${name}`;
}

interface WorkerSessionOpts {
  sessionId: string;
  agentName?: string;
  workflowRunId?: string;
  taskId?: string;
  createdAt?: number;
  lastActiveAt?: number;
  withExecution?: boolean;
}

function makeDb(): BunDatabase {
  const db = new BunDatabase(':memory:');
  createTables(db);
  db.exec(`
    CREATE TABLE IF NOT EXISTS space_tasks (
      id TEXT PRIMARY KEY,
      space_id TEXT NOT NULL,
      task_number INTEGER NOT NULL DEFAULT 1,
      title TEXT NOT NULL DEFAULT '',
      description TEXT NOT NULL DEFAULT '',
      status TEXT NOT NULL DEFAULT 'in_progress',
      priority TEXT NOT NULL DEFAULT 'normal',
      workflow_run_id TEXT,
      post_approval_session_id TEXT,
      approved_at INTEGER,
      depends_on TEXT NOT NULL DEFAULT '[]',
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS node_executions (
      id TEXT PRIMARY KEY,
      workflow_run_id TEXT NOT NULL,
      workflow_node_id TEXT,
      agent_name TEXT,
      agent_id TEXT,
      agent_session_id TEXT,
      status TEXT NOT NULL DEFAULT 'in_progress',
      result TEXT,
      created_at INTEGER NOT NULL,
      started_at INTEGER,
      completed_at INTEGER,
      updated_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS pending_agent_messages (id TEXT PRIMARY KEY);
  `);
  return db;
}

function provenanceMetadata(
  agentName: string,
  opts: { workflowRunId?: string; nodeId?: string; agentId?: string } = {}
): string {
  return JSON.stringify({
    promptProvenance: {
      source: 'space_agent_custom_prompt',
      hash: 'h',
      agentId: opts.agentId ?? `agent-${agentName}`,
      agentName,
      workflowRunId: opts.workflowRunId ?? RUN_ID,
      nodeId: opts.nodeId ?? POST_APPROVAL_NODE,
      nodeName: 'Post-Approval',
    },
  });
}

function insertWorkerSession(db: BunDatabase, opts: WorkerSessionOpts): void {
  const agentName = opts.agentName ?? 'merger';
  const createdAt = opts.createdAt ?? 0;
  const lastActiveAt = opts.lastActiveAt ?? 1;
  const sessionTaskId = opts.taskId ?? TASK_ID;
  db.prepare(
    `INSERT INTO sessions (id, title, workspace_path, created_at, last_active_at, status, config, metadata, is_worktree, type, session_context)
     VALUES (?, 'Worker', '/tmp/ws', ?, ?, 'active', '{}', ?, 0, 'worker', ?)`
  ).run(
    opts.sessionId,
    createdAt,
    lastActiveAt,
    provenanceMetadata(agentName, { workflowRunId: opts.workflowRunId }),
    JSON.stringify({ spaceId: SPACE_ID, taskId: sessionTaskId })
  );
  if (opts.withExecution) {
    db.prepare(
      `INSERT INTO node_executions (id, workflow_run_id, workflow_node_id, agent_name, agent_session_id, status, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, 'in_progress', 0, 0)`
    ).run(
      `exec-${opts.sessionId}`,
      opts.workflowRunId ?? RUN_ID,
      POST_APPROVAL_NODE,
      agentName,
      opts.sessionId
    );
  }
}

function insertTaskInput(
  db: BunDatabase,
  sessionId: string,
  options: {
    taskId?: string;
    status?: 'deferred' | 'enqueued' | 'submitted' | 'consumed' | 'failed';
    consumedSeq?: number | null;
    timestamp?: number;
  } = {}
): void {
  const status = options.status ?? 'consumed';
  const id = `input-${sessionId}`;
  db.prepare(
    `INSERT INTO sdk_messages (
       id, session_id, message_type, sdk_message, timestamp, send_status, task_id, consumed_seq, sdk_uuid
     ) VALUES (?, ?, 'user', ?, ?, ?, ?, ?, ?)`
  ).run(
    id,
    sessionId,
    JSON.stringify({
      type: 'user',
      uuid: id,
      isSynthetic: true,
      inputKind: 'task',
      message: { role: 'user', content: [{ type: 'text', text: id }] },
    }),
    new Date(options.timestamp ?? 1).toISOString(),
    status,
    options.taskId ?? TASK_ID,
    options.consumedSeq === undefined ? (status === 'consumed' ? 1 : null) : options.consumedSeq,
    id
  );
}

function insertTask(
  db: BunDatabase,
  overrides: {
    status?: string;
    postApprovalSessionId?: string | null;
    approvedAt?: number | null;
  } = {}
): void {
  const status = overrides.status ?? 'in_progress';
  const approvedAt = Object.hasOwn(overrides, 'approvedAt')
    ? overrides.approvedAt
    : status === 'approved' || status === 'done'
      ? 0
      : null;
  db.prepare(
    `INSERT INTO space_tasks (id, space_id, task_number, title, description, status, priority, workflow_run_id, post_approval_session_id, approved_at, depends_on, created_at, updated_at)
     VALUES (?, ?, 1, 'T', '', ?, 'normal', ?, ?, ?, '[]', 0, 0)`
  ).run(TASK_ID, SPACE_ID, status, RUN_ID, overrides.postApprovalSessionId ?? null, approvedAt);
}

function makeManager(db: BunDatabase): TaskAgentManager {
  const workflow = {
    id: 'wf-1',
    nodes: [
      {
        id: POST_APPROVAL_NODE,
        agents: [{ name: 'merger' }],
        postApproval: { targetAgent: 'merger' },
      },
    ],
  };
  return new TaskAgentManager({
    db: { getDatabase: () => db },
    taskRepo: new SpaceTaskRepository(db),
    sessionManager: { registerSession: () => {} },
    internalEventBus: new InternalEventBus<DaemonInternalEventMap>(),
    spaceManager: { getSpace: async () => ({ id: SPACE_ID, workspacePath: '/tmp/ws' }) },
    workflowRunRepo: { getRun: () => ({ id: RUN_ID, workflowId: workflow.id }) },
    spaceWorkflowManager: { getWorkflow: () => workflow, getWorkflowForRun: () => workflow },
    nodeExecutionRepo: { listByWorkflowRun: () => [], listByNode: () => [], update: () => null },
  } as unknown as TaskAgentManagerConfig);
}

describe('TaskAgentManager post-approval worker identity resolution', () => {
  let db: BunDatabase;
  let tam: TaskAgentManager;

  beforeEach(() => {
    db = makeDb();
    tam = makeManager(db);
  });

  it('rejects a cancelled task (terminal gate)', () => {
    insertTask(db, { status: 'cancelled', postApprovalSessionId: 'worker-1' });
    insertWorkerSession(db, { sessionId: 'worker-1' });
    expect(tam.getPostApprovalWorkerSession(TASK_ID)).toBeNull();
  });

  it('rejects an archived task (terminal gate)', () => {
    insertTask(db, { status: 'archived', postApprovalSessionId: 'worker-1' });
    insertWorkerSession(db, { sessionId: 'worker-1' });
    expect(tam.getPostApprovalWorkerSession(TASK_ID)).toBeNull();
  });

  it('resolves the most-recent worker when no hint is given', () => {
    insertTask(db, { postApprovalSessionId: 'worker-recent' });
    insertWorkerSession(db, { sessionId: 'worker-old', lastActiveAt: 1 });
    insertWorkerSession(db, { sessionId: 'worker-recent', lastActiveAt: 5 });
    const res = tam.getPostApprovalWorkerSession(TASK_ID);
    expect(res).toEqual({
      sessionId: 'worker-recent',
      agentName: 'merger',
      nodeId: POST_APPROVAL_NODE,
    });
  });

  it('rejects an explicit hint that differs from the recorded pointer (authoritative record)', () => {
    insertTask(db, { postApprovalSessionId: 'worker-recent' });
    insertWorkerSession(db, { sessionId: 'worker-old', lastActiveAt: 1 });
    insertWorkerSession(db, { sessionId: 'worker-recent', lastActiveAt: 5 });
    expect(tam.getPostApprovalWorkerSession(TASK_ID, 'worker-old')).toBeNull();
  });

  it('rejects a stale canonical hint after the pointer moved to a replacement (two-live-workers hazard)', () => {
    const staleId = postApprovalSessionId('stale');
    const replacementId = postApprovalSessionId('replacement');
    insertTask(db, { status: 'approved', postApprovalSessionId: replacementId });
    insertWorkerSession(db, { sessionId: staleId, lastActiveAt: 1 });
    insertWorkerSession(db, { sessionId: replacementId, lastActiveAt: 5 });
    insertTaskInput(db, staleId);
    expect(tam.getPostApprovalWorkerSession(TASK_ID, staleId)).toBeNull();
    expect(tam.getPostApprovalWorkerSession(TASK_ID, replacementId)).toEqual({
      sessionId: replacementId,
      agentName: 'merger',
      nodeId: POST_APPROVAL_NODE,
    });
  });

  for (const status of ['approved', 'done'] as const) {
    it(`admits a pointerless ${status} hint the durable fallback selects exactly`, () => {
      const sessionId = postApprovalSessionId('durable');
      insertTask(db, { status, postApprovalSessionId: null });
      insertWorkerSession(db, { sessionId, createdAt: 9, lastActiveAt: 9 });
      insertTaskInput(db, sessionId);
      expect(tam.getPostApprovalWorkerSession(TASK_ID, sessionId)).toEqual({
        sessionId,
        agentName: 'merger',
        nodeId: POST_APPROVAL_NODE,
      });
    });
  }

  it('rejects a hint that points at an execution-backed (normal node-agent) session', () => {
    insertTask(db, { postApprovalSessionId: 'worker-1' });
    insertWorkerSession(db, { sessionId: 'worker-1' });
    insertWorkerSession(db, { sessionId: 'coder-1', agentName: 'coder', withExecution: true });
    expect(tam.getPostApprovalWorkerSession(TASK_ID, 'coder-1')).toBeNull();
  });

  it('authorizes an execution-backed hint recorded as the routing pointer', () => {
    const reusedExecId = 'space:space-id:task:task-1:exec:reused';
    insertTask(db, { status: 'approved', postApprovalSessionId: reusedExecId });
    insertWorkerSession(db, { sessionId: reusedExecId, withExecution: true });
    expect(tam.getPostApprovalWorkerSession(TASK_ID, reusedExecId)).toEqual({
      sessionId: reusedExecId,
      agentName: 'merger',
      nodeId: POST_APPROVAL_NODE,
    });
  });

  it('rejects a recorded pointer naming a session owned by another task', () => {
    insertTask(db, { status: 'approved', postApprovalSessionId: 'sibling-worker' });
    insertWorkerSession(db, { sessionId: 'sibling-worker', taskId: 'sibling-task' });
    expect(tam.getPostApprovalWorkerSession(TASK_ID, 'sibling-worker')).toBeNull();
  });

  it('rejects a hint for a worker owned by a different task (task-scoped lookup)', () => {
    insertTask(db, { postApprovalSessionId: 'worker-1' });
    insertWorkerSession(db, { sessionId: 'worker-1' });
    insertWorkerSession(db, { sessionId: 'sibling-worker', taskId: 'sibling-task' });
    expect(tam.getPostApprovalWorkerSession(TASK_ID, 'sibling-worker')).toBeNull();
  });

  it('does NOT resolve a historical worker for a reopened (active) task', () => {
    insertTask(db, { status: 'in_progress', postApprovalSessionId: null });
    insertWorkerSession(db, { sessionId: 'prior-worker', lastActiveAt: 9 });
    expect(tam.getPostApprovalWorkerSession(TASK_ID)).toBeNull();
  });

  for (const status of ['approved', 'done'] as const) {
    it(`falls back for a pointerless ${status} task before any activity timestamp change`, () => {
      const sessionId = postApprovalSessionId(status);
      insertTask(db, { status, postApprovalSessionId: null });
      insertWorkerSession(db, { sessionId, createdAt: 9, lastActiveAt: 9 });
      insertTaskInput(db, sessionId);
      const res = tam.getPostApprovalWorkerSession(TASK_ID);
      expect(res).toEqual({
        sessionId,
        agentName: 'merger',
        nodeId: POST_APPROVAL_NODE,
      });
    });
  }

  it('rejects an unrecorded worker created without kickoff evidence', () => {
    const sessionId = postApprovalSessionId('created');
    insertTask(db, { status: 'done', postApprovalSessionId: null });
    insertWorkerSession(db, { sessionId, lastActiveAt: 9 });
    expect(tam.getPostApprovalWorkerSession(TASK_ID)).toBeNull();
    expect(tam.getPostApprovalWorkerSession(TASK_ID, sessionId)).toBeNull();
  });

  for (const status of ['deferred', 'enqueued', 'submitted', 'failed'] as const) {
    it(`rejects an unrecorded worker whose kickoff is ${status} without consumption`, () => {
      const sessionId = postApprovalSessionId(status);
      insertTask(db, { status: 'done', postApprovalSessionId: null });
      insertWorkerSession(db, { sessionId, lastActiveAt: 9 });
      insertTaskInput(db, sessionId, { status });
      expect(tam.getPostApprovalWorkerSession(TASK_ID)).toBeNull();
    });
  }

  it('skips a newer partial worker to recover an older evidence-qualified worker', () => {
    const validSessionId = postApprovalSessionId('valid');
    insertTask(db, { status: 'done', postApprovalSessionId: null });
    insertWorkerSession(db, { sessionId: validSessionId, lastActiveAt: 5 });
    insertTaskInput(db, validSessionId);
    insertWorkerSession(db, { sessionId: postApprovalSessionId('partial'), lastActiveAt: 9 });
    const res = tam.getPostApprovalWorkerSession(TASK_ID);
    expect(res?.sessionId).toBe(validSessionId);
  });

  it('rejects a consumed task input from an execution-less normal worker', () => {
    insertTask(db, { status: 'done', postApprovalSessionId: null });
    insertWorkerSession(db, {
      sessionId: 'space:space-id:task:task-1:exec:normal',
      lastActiveAt: 9,
    });
    insertTaskInput(db, 'space:space-id:task:task-1:exec:normal');
    expect(tam.getPostApprovalWorkerSession(TASK_ID)).toBeNull();
  });

  it('rejects consumed evidence without a current approval boundary', () => {
    const sessionId = postApprovalSessionId('unbounded');
    insertTask(db, { status: 'done', postApprovalSessionId: null, approvedAt: null });
    insertWorkerSession(db, { sessionId, lastActiveAt: 9 });
    insertTaskInput(db, sessionId, { timestamp: 9 });
    expect(tam.getPostApprovalWorkerSession(TASK_ID)).toBeNull();
  });

  it('rejects a consumed post-approval worker from a prior approval cycle', () => {
    const staleSessionId = postApprovalSessionId('stale');
    insertTask(db, { status: 'approved', postApprovalSessionId: null, approvedAt: 10 });
    insertWorkerSession(db, { sessionId: staleSessionId, createdAt: 5, lastActiveAt: 9 });
    insertTaskInput(db, staleSessionId, { timestamp: 9 });
    expect(tam.getPostApprovalWorkerSession(TASK_ID)).toBeNull();
  });

  it('rejects a consumed pending-queue input before kickoff injection', () => {
    const sessionId = postApprovalSessionId('queue-drain');
    insertTask(db, { status: 'approved', postApprovalSessionId: null, approvedAt: 10 });
    insertWorkerSession(db, { sessionId, createdAt: 10, lastActiveAt: 11 });
    insertTaskInput(db, sessionId, { timestamp: 11 });
    db.prepare('INSERT INTO pending_agent_messages (id) VALUES (?)').run(`input-${sessionId}`);
    expect(tam.getPostApprovalWorkerSession(TASK_ID)).toBeNull();
  });

  it('accepts a consumed post-approval worker from the current approval cycle', () => {
    const sessionId = postApprovalSessionId('current');
    insertTask(db, { status: 'approved', postApprovalSessionId: null, approvedAt: 10 });
    insertWorkerSession(db, { sessionId, createdAt: 10, lastActiveAt: 10 });
    insertTaskInput(db, sessionId, { timestamp: 10 });
    expect(tam.getPostApprovalWorkerSession(TASK_ID)?.sessionId).toBe(sessionId);
    expect(tam.getPostApprovalWorkerSession(TASK_ID, sessionId)?.sessionId).toBe(sessionId);
  });

  it('rejects ambiguous current-cycle evidence from an execution-backed worker', () => {
    const sessionId = 'space:space-id:task:task-1:exec:reused';
    insertTask(db, { status: 'approved', postApprovalSessionId: null, approvedAt: 10 });
    insertWorkerSession(db, { sessionId, lastActiveAt: 10, withExecution: true });
    insertTaskInput(db, sessionId, { timestamp: 10 });
    expect(tam.getPostApprovalWorkerSession(TASK_ID)).toBeNull();
  });

  it('requires consumed kickoff evidence for the same task', () => {
    const sessionId = postApprovalSessionId('other-task');
    insertTask(db, { status: 'done', postApprovalSessionId: null });
    insertWorkerSession(db, { sessionId, lastActiveAt: 9 });
    insertTaskInput(db, sessionId, { taskId: 'other-task' });
    expect(tam.getPostApprovalWorkerSession(TASK_ID)).toBeNull();
  });

  it('keeps the recorded session canonical without fallback evidence', () => {
    const consumedSessionId = postApprovalSessionId('consumed');
    insertTask(db, { status: 'done', postApprovalSessionId: 'worker-recorded' });
    insertWorkerSession(db, { sessionId: 'worker-recorded', lastActiveAt: 1 });
    insertWorkerSession(db, { sessionId: consumedSessionId, lastActiveAt: 9 });
    insertTaskInput(db, consumedSessionId);
    expect(tam.getPostApprovalWorkerSession(TASK_ID)?.sessionId).toBe('worker-recorded');
  });

  it('derives a legacy (pre-provenance) worker nodeId from the workflow route', () => {
    const db2 = makeDb();
    const workflow = {
      id: 'wf-1',
      nodes: [
        {
          id: 'node-merger',
          name: 'Merger',
          agents: [{ name: 'merger' }],
          postApproval: { targetAgent: 'merger' },
        },
        { id: 'node-sibling', name: 'Sibling', agents: [{ name: 'merger' }] },
      ],
    };
    const tam2 = new TaskAgentManager({
      db: { getDatabase: () => db2 },
      taskRepo: new SpaceTaskRepository(db2),
      sessionManager: { registerSession: () => {} },
      internalEventBus: new InternalEventBus<DaemonInternalEventMap>(),
      spaceManager: { getSpace: async () => ({ id: SPACE_ID, workspacePath: '/tmp/ws' }) },
      workflowRunRepo: { getRun: () => ({ id: RUN_ID, workflowId: 'wf-1' }) },
      spaceWorkflowManager: { getWorkflow: () => workflow, getWorkflowForRun: () => workflow },
      nodeExecutionRepo: { listByWorkflowRun: () => [], listByNode: () => [], update: () => null },
    } as unknown as TaskAgentManagerConfig);
    insertTask(db2, { postApprovalSessionId: 'legacy-worker' });
    db2
      .prepare(
        `INSERT INTO sessions (id, title, workspace_path, created_at, last_active_at, status, config, metadata, is_worktree, type, session_context)
         VALUES (?, 'Worker', '/tmp/ws', 0, 1, 'active', '{}', '{}', 0, 'worker', ?)`
      )
      .run('legacy-worker', JSON.stringify({ spaceId: SPACE_ID, taskId: TASK_ID }));
    const res = tam2.getPostApprovalWorkerSession(TASK_ID);
    expect(res).toEqual({ sessionId: 'legacy-worker', agentName: 'merger', nodeId: 'node-merger' });
  });
});

describe('TaskAgentManager.isSessionOnPostApprovalRoute', () => {
  let db: BunDatabase;
  let tam: TaskAgentManager;

  beforeEach(() => {
    db = makeDb();
    tam = makeManager(db);
  });

  function insertExecution(
    sessionId: string,
    opts: { nodeId?: string; agentName?: string; workflowRunId?: string } = {}
  ): void {
    db.prepare(
      `INSERT INTO node_executions (id, workflow_run_id, workflow_node_id, agent_name, agent_session_id, status, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, 'in_progress', 0, 0)`
    ).run(
      `exec-${sessionId}`,
      opts.workflowRunId ?? RUN_ID,
      opts.nodeId ?? POST_APPROVAL_NODE,
      opts.agentName ?? 'merger',
      sessionId
    );
  }

  it('accepts a worker of the task bound to the route node and agent', () => {
    insertWorkerSession(db, { sessionId: 'route-worker' });
    insertExecution('route-worker');
    expect(
      tam.isSessionOnPostApprovalRoute({
        sessionId: 'route-worker',
        taskId: TASK_ID,
        routeNodeId: POST_APPROVAL_NODE,
        routeAgentName: 'merger',
        workflowRunId: RUN_ID,
      })
    ).toBe(true);
  });

  it('rejects the task coder execution on a different node (recorded-pointer slot hazard)', () => {
    insertWorkerSession(db, { sessionId: 'coder-exec', agentName: 'coder' });
    insertExecution('coder-exec', { nodeId: 'node-build', agentName: 'coder' });
    expect(
      tam.isSessionOnPostApprovalRoute({
        sessionId: 'coder-exec',
        taskId: TASK_ID,
        routeNodeId: POST_APPROVAL_NODE,
        routeAgentName: 'merger',
        workflowRunId: RUN_ID,
      })
    ).toBe(false);
  });

  it('rejects an execution-bound worker on the route node but under another agent', () => {
    insertWorkerSession(db, { sessionId: 'other-agent', agentName: 'observer' });
    insertExecution('other-agent', { nodeId: POST_APPROVAL_NODE, agentName: 'observer' });
    expect(
      tam.isSessionOnPostApprovalRoute({
        sessionId: 'other-agent',
        taskId: TASK_ID,
        routeNodeId: POST_APPROVAL_NODE,
        routeAgentName: 'merger',
        workflowRunId: RUN_ID,
      })
    ).toBe(false);
  });

  it('accepts a plain (non-execution-bound) worker of the task', () => {
    insertWorkerSession(db, { sessionId: 'plain-worker' });
    expect(
      tam.isSessionOnPostApprovalRoute({
        sessionId: 'plain-worker',
        taskId: TASK_ID,
        routeNodeId: POST_APPROVAL_NODE,
        routeAgentName: 'merger',
        workflowRunId: RUN_ID,
      })
    ).toBe(true);
  });

  it('rejects a worker session owned by another task', () => {
    insertWorkerSession(db, { sessionId: 'sibling-worker', taskId: 'sibling-task' });
    expect(
      tam.isSessionOnPostApprovalRoute({
        sessionId: 'sibling-worker',
        taskId: TASK_ID,
        routeNodeId: POST_APPROVAL_NODE,
        routeAgentName: 'merger',
        workflowRunId: RUN_ID,
      })
    ).toBe(false);
  });

  it('accepts an execution-bound worker on any node for a legacy route without a node', () => {
    insertWorkerSession(db, { sessionId: 'legacy-reuse' });
    insertExecution('legacy-reuse', { nodeId: 'node-build' });
    expect(
      tam.isSessionOnPostApprovalRoute({
        sessionId: 'legacy-reuse',
        taskId: TASK_ID,
        routeNodeId: null,
        routeAgentName: 'merger',
        workflowRunId: RUN_ID,
      })
    ).toBe(true);
  });
});

describe('TaskAgentManager.isSessionOnPostApprovalRoute — provenance binding', () => {
  let db: BunDatabase;
  let tam: TaskAgentManager;

  beforeEach(() => {
    db = makeDb();
    tam = makeManager(db);
  });

  it('rejects an execution-less worker whose provenance names another workflow run', () => {
    insertWorkerSession(db, { sessionId: 'stale-run-worker', workflowRunId: 'run-old' });
    expect(
      tam.isSessionOnPostApprovalRoute({
        sessionId: 'stale-run-worker',
        taskId: TASK_ID,
        routeNodeId: POST_APPROVAL_NODE,
        routeAgentName: 'merger',
        workflowRunId: RUN_ID,
      })
    ).toBe(false);
  });

  it('rejects an execution-less worker whose provenance names another agent', () => {
    insertWorkerSession(db, { sessionId: 'other-name-worker', agentName: 'observer' });
    expect(
      tam.isSessionOnPostApprovalRoute({
        sessionId: 'other-name-worker',
        taskId: TASK_ID,
        routeNodeId: POST_APPROVAL_NODE,
        routeAgentName: 'merger',
        workflowRunId: RUN_ID,
      })
    ).toBe(false);
  });

  it('admits a legacy execution-less worker without provenance metadata', () => {
    db.prepare(
      `INSERT INTO sessions (id, title, workspace_path, created_at, last_active_at, status, config, metadata, is_worktree, type, session_context)
       VALUES ('legacy-no-provenance', 'Worker', '/tmp/ws', 0, 1, 'active', '{}', '{}', 0, 'worker', ?)`
    ).run(JSON.stringify({ spaceId: SPACE_ID, taskId: TASK_ID }));
    expect(
      tam.isSessionOnPostApprovalRoute({
        sessionId: 'legacy-no-provenance',
        taskId: TASK_ID,
        routeNodeId: POST_APPROVAL_NODE,
        routeAgentName: 'merger',
        workflowRunId: RUN_ID,
      })
    ).toBe(true);
  });

  it('admits an execution-less worker whose provenance matches agent, node, and run', () => {
    insertWorkerSession(db, { sessionId: 'matching-worker' });
    expect(
      tam.isSessionOnPostApprovalRoute({
        sessionId: 'matching-worker',
        taskId: TASK_ID,
        routeNodeId: POST_APPROVAL_NODE,
        routeAgentName: 'merger',
        workflowRunId: RUN_ID,
      })
    ).toBe(true);
  });
});

describe('TaskAgentManager.isSessionOnPostApprovalRoute — execution run binding', () => {
  let db: BunDatabase;
  let tam: TaskAgentManager;

  beforeEach(() => {
    db = makeDb();
    tam = makeManager(db);
  });

  it('rejects an execution-backed worker from another workflow run (re-parented task)', () => {
    db.prepare(
      `INSERT INTO sessions (id, title, workspace_path, created_at, last_active_at, status, config, metadata, is_worktree, type, session_context)
       VALUES ('old-run-exec', 'Worker', '/tmp/ws', 0, 1, 'active', '{}', ?, 0, 'worker', ?)`
    ).run(
      provenanceMetadata('merger', { workflowRunId: RUN_ID }),
      JSON.stringify({ spaceId: SPACE_ID, taskId: TASK_ID })
    );
    db.prepare(
      `INSERT INTO node_executions (id, workflow_run_id, workflow_node_id, agent_name, agent_session_id, status, created_at, updated_at)
       VALUES ('exec-old-run', 'run-old', ?, 'merger', 'old-run-exec', 'in_progress', 0, 0)`
    ).run(POST_APPROVAL_NODE);
    expect(
      tam.isSessionOnPostApprovalRoute({
        sessionId: 'old-run-exec',
        taskId: TASK_ID,
        routeNodeId: POST_APPROVAL_NODE,
        routeAgentName: 'merger',
        workflowRunId: RUN_ID,
      })
    ).toBe(false);
  });

  it('accepts an execution-backed worker bound to the current workflow run', () => {
    db.prepare(
      `INSERT INTO sessions (id, title, workspace_path, created_at, last_active_at, status, config, metadata, is_worktree, type, session_context)
       VALUES ('current-run-exec', 'Worker', '/tmp/ws', 0, 1, 'active', '{}', ?, 0, 'worker', ?)`
    ).run(
      provenanceMetadata('merger', { workflowRunId: RUN_ID }),
      JSON.stringify({ spaceId: SPACE_ID, taskId: TASK_ID })
    );
    db.prepare(
      `INSERT INTO node_executions (id, workflow_run_id, workflow_node_id, agent_name, agent_session_id, status, created_at, updated_at)
       VALUES ('exec-current-run', ?, ?, 'merger', 'current-run-exec', 'in_progress', 0, 0)`
    ).run(RUN_ID, POST_APPROVAL_NODE);
    expect(
      tam.isSessionOnPostApprovalRoute({
        sessionId: 'current-run-exec',
        taskId: TASK_ID,
        routeNodeId: POST_APPROVAL_NODE,
        routeAgentName: 'merger',
        workflowRunId: RUN_ID,
      })
    ).toBe(true);
  });

  it('skips the run check for a legacy route without a current run id', () => {
    db.prepare(
      `INSERT INTO sessions (id, title, workspace_path, created_at, last_active_at, status, config, metadata, is_worktree, type, session_context)
       VALUES ('legacy-run-exec', 'Worker', '/tmp/ws', 0, 1, 'active', '{}', ?, 0, 'worker', ?)`
    ).run(
      provenanceMetadata('merger', { workflowRunId: RUN_ID }),
      JSON.stringify({ spaceId: SPACE_ID, taskId: TASK_ID })
    );
    db.prepare(
      `INSERT INTO node_executions (id, workflow_run_id, workflow_node_id, agent_name, agent_session_id, status, created_at, updated_at)
       VALUES ('exec-legacy-run', 'run-old', ?, 'merger', 'legacy-run-exec', 'in_progress', 0, 0)`
    ).run(POST_APPROVAL_NODE);
    expect(
      tam.isSessionOnPostApprovalRoute({
        sessionId: 'legacy-run-exec',
        taskId: TASK_ID,
        routeNodeId: POST_APPROVAL_NODE,
        routeAgentName: 'merger',
        workflowRunId: null,
      })
    ).toBe(true);
  });
});

describe('TaskAgentManager.spawnPostApprovalSubSession — succeeded-run admission', () => {
  const WORKFLOW = {
    id: 'wf-1',
    nodes: [
      {
        id: POST_APPROVAL_NODE,
        agents: [{ name: 'merger', agentId: 'agent-merger' }],
        postApproval: { targetAgent: 'merger' },
      },
    ],
  };

  function makeSpawnManager(db: BunDatabase, runStatus: string): TaskAgentManager {
    return new TaskAgentManager({
      db: { getDatabase: () => db },
      taskRepo: new SpaceTaskRepository(db),
      sessionManager: { registerSession: () => {} },
      internalEventBus: new InternalEventBus<DaemonInternalEventMap>(),
      spaceManager: { getSpace: async () => ({ id: SPACE_ID, workspacePath: '/tmp/ws' }) },
      workflowRunRepo: { getRun: () => ({ id: RUN_ID, workflowId: 'wf-1', status: runStatus }) },
      spaceWorkflowManager: { getWorkflow: () => WORKFLOW, getWorkflowForRun: () => WORKFLOW },
      nodeExecutionRepo: { listByWorkflowRun: () => [], listByNode: () => [], update: () => null },
    } as unknown as TaskAgentManagerConfig);
  }

  it('refuses the retry kickoff when the workflow run is not done', async () => {
    const db = makeDb();
    insertTask(db, { status: 'approved' });
    const tam = makeSpawnManager(db, 'in_progress');
    await expect(
      tam.spawnPostApprovalSubSession({
        task: {
          id: TASK_ID,
          spaceId: SPACE_ID,
          workflowRunId: RUN_ID,
        } as unknown as Parameters<TaskAgentManager['spawnPostApprovalSubSession']>[0]['task'],
        workflow: WORKFLOW as unknown as Parameters<
          TaskAgentManager['spawnPostApprovalSubSession']
        >[0]['workflow'],
        targetAgent: 'merger',
        kickoffMessage: 'Merge it.',
        requireSucceededRun: true,
      })
    ).rejects.toThrow('run-not-succeeded-before-kickoff');
  });

  it('leaves ordinary dispatches unaffected by the succeeded-run requirement', async () => {
    const db = makeDb();
    insertTask(db, { status: 'approved' });
    const tam = makeSpawnManager(db, 'in_progress');
    let error: unknown = null;
    try {
      await tam.spawnPostApprovalSubSession({
        task: {
          id: TASK_ID,
          spaceId: SPACE_ID,
          workflowRunId: RUN_ID,
        } as unknown as Parameters<TaskAgentManager['spawnPostApprovalSubSession']>[0]['task'],
        workflow: WORKFLOW as unknown as Parameters<
          TaskAgentManager['spawnPostApprovalSubSession']
        >[0]['workflow'],
        targetAgent: 'merger',
        kickoffMessage: 'Merge it.',
      });
    } catch (err) {
      error = err;
    }
    expect(error === null ? '' : String(error)).not.toContain('run-not-succeeded-before-kickoff');
  });
});

describe('TaskAgentManager.spawnPostApprovalSubSession — approval-generation admission', () => {
  const WORKFLOW = {
    id: 'wf-1',
    nodes: [
      {
        id: POST_APPROVAL_NODE,
        agents: [{ name: 'merger', agentId: 'agent-merger' }],
        postApproval: { targetAgent: 'merger' },
      },
    ],
  };

  function makeSpawnManager(db: BunDatabase): TaskAgentManager {
    return new TaskAgentManager({
      db: { getDatabase: () => db },
      taskRepo: new SpaceTaskRepository(db),
      sessionManager: { registerSession: () => {} },
      internalEventBus: new InternalEventBus<DaemonInternalEventMap>(),
      spaceManager: { getSpace: async () => ({ id: SPACE_ID, workspacePath: '/tmp/ws' }) },
      workflowRunRepo: { getRun: () => ({ id: RUN_ID, workflowId: 'wf-1', status: 'done' }) },
      spaceWorkflowManager: { getWorkflow: () => WORKFLOW, getWorkflowForRun: () => WORKFLOW },
      nodeExecutionRepo: { listByWorkflowRun: () => [], listByNode: () => [], update: () => null },
    } as unknown as TaskAgentManagerConfig);
  }

  it('refuses the kickoff when the approval generation changed before delivery', async () => {
    const db = makeDb();
    insertTask(db, { status: 'approved', approvedAt: 500 });
    const tam = makeSpawnManager(db);
    await expect(
      tam.spawnPostApprovalSubSession({
        task: {
          id: TASK_ID,
          spaceId: SPACE_ID,
          workflowRunId: RUN_ID,
        } as unknown as Parameters<TaskAgentManager['spawnPostApprovalSubSession']>[0]['task'],
        workflow: WORKFLOW as unknown as Parameters<
          TaskAgentManager['spawnPostApprovalSubSession']
        >[0]['workflow'],
        targetAgent: 'merger',
        kickoffMessage: 'Merge it.',
        expectedApprovedAt: 400,
      })
    ).rejects.toThrow('approval-generation-changed-before-kickoff');
  });

  it('admits the kickoff when the approval generation matches', async () => {
    const db = makeDb();
    insertTask(db, { status: 'approved', approvedAt: 500 });
    const tam = makeSpawnManager(db);
    let error: unknown = null;
    try {
      await tam.spawnPostApprovalSubSession({
        task: {
          id: TASK_ID,
          spaceId: SPACE_ID,
          workflowRunId: RUN_ID,
        } as unknown as Parameters<TaskAgentManager['spawnPostApprovalSubSession']>[0]['task'],
        workflow: WORKFLOW as unknown as Parameters<
          TaskAgentManager['spawnPostApprovalSubSession']
        >[0]['workflow'],
        targetAgent: 'merger',
        kickoffMessage: 'Merge it.',
        expectedApprovedAt: 500,
      });
    } catch (err) {
      error = err;
    }
    expect(error === null ? '' : String(error)).not.toContain(
      'approval-generation-changed-before-kickoff'
    );
  });
});

describe('TaskAgentManager.spawnPostApprovalSubSession — strict retry admission', () => {
  const WORKFLOW = {
    id: 'wf-1',
    nodes: [
      {
        id: POST_APPROVAL_NODE,
        agents: [{ name: 'merger', agentId: 'agent-merger' }],
        postApproval: { targetAgent: 'merger' },
      },
    ],
  };

  function makeStrictSpawnManager(db: BunDatabase): TaskAgentManager {
    return new TaskAgentManager({
      db: { getDatabase: () => db },
      taskRepo: new SpaceTaskRepository(db),
      sessionManager: { registerSession: () => {} },
      internalEventBus: new InternalEventBus<DaemonInternalEventMap>(),
      spaceManager: { getSpace: async () => ({ id: SPACE_ID, workspacePath: '/tmp/ws' }) },
      workflowRunRepo: { getRun: () => ({ id: RUN_ID, workflowId: 'wf-1', status: 'done' }) },
      spaceWorkflowManager: { getWorkflow: () => WORKFLOW, getWorkflowForRun: () => WORKFLOW },
      nodeExecutionRepo: { listByWorkflowRun: () => [], listByNode: () => [], update: () => null },
    } as unknown as TaskAgentManagerConfig);
  }

  it('refuses the kickoff when a manually completed task is no longer approved', async () => {
    const db = makeDb();
    insertTask(db, { status: 'done', approvedAt: 500 });
    const tam = makeStrictSpawnManager(db);
    await expect(
      tam.spawnPostApprovalSubSession({
        task: {
          id: TASK_ID,
          spaceId: SPACE_ID,
          workflowRunId: RUN_ID,
        } as unknown as Parameters<TaskAgentManager['spawnPostApprovalSubSession']>[0]['task'],
        workflow: WORKFLOW as unknown as Parameters<
          TaskAgentManager['spawnPostApprovalSubSession']
        >[0]['workflow'],
        targetAgent: 'merger',
        kickoffMessage: 'Merge it.',
        expectedApprovedAt: 500,
      })
    ).rejects.toThrow('task-not-approved-before-kickoff');
  });

  it('refuses the kickoff when the task re-parented before delivery', async () => {
    const db = makeDb();
    insertTask(db, { status: 'approved', approvedAt: 500 });
    db.prepare(`UPDATE space_tasks SET workflow_run_id = 'run-new' WHERE id = ?`).run(TASK_ID);
    const tam = makeStrictSpawnManager(db);
    await expect(
      tam.spawnPostApprovalSubSession({
        task: {
          id: TASK_ID,
          spaceId: SPACE_ID,
          workflowRunId: RUN_ID,
        } as unknown as Parameters<TaskAgentManager['spawnPostApprovalSubSession']>[0]['task'],
        workflow: WORKFLOW as unknown as Parameters<
          TaskAgentManager['spawnPostApprovalSubSession']
        >[0]['workflow'],
        targetAgent: 'merger',
        kickoffMessage: 'Merge it.',
        expectedApprovedAt: 500,
        expectedWorkflowRunId: RUN_ID,
      })
    ).rejects.toThrow('task-reparented-before-kickoff');
  });
});

describe('TaskAgentManager post-approval identity — current-run binding', () => {
  let db: BunDatabase;
  let tam: TaskAgentManager;

  beforeEach(() => {
    db = makeDb();
    tam = makeManager(db);
  });

  it('rejects a recorded pointer whose provenance belongs to another workflow run', () => {
    insertTask(db, { status: 'approved', postApprovalSessionId: 'old-run-worker' });
    insertWorkerSession(db, {
      sessionId: 'old-run-worker',
      workflowRunId: 'run-old',
    });
    expect(tam.getPostApprovalWorkerSession(TASK_ID, 'old-run-worker')).toBeNull();
  });

  it('rejects a recorded pointer whose execution belongs to another workflow run', () => {
    insertTask(db, { status: 'approved', postApprovalSessionId: 'old-exec-worker' });
    insertWorkerSession(db, { sessionId: 'old-exec-worker', workflowRunId: RUN_ID });
    db.prepare(
      `INSERT INTO node_executions (id, workflow_run_id, workflow_node_id, agent_name, agent_session_id, status, created_at, updated_at)
       VALUES ('exec-old', 'run-old', ?, 'merger', 'old-exec-worker', 'in_progress', 0, 0)`
    ).run(POST_APPROVAL_NODE);
    expect(tam.getPostApprovalWorkerSession(TASK_ID, 'old-exec-worker')).toBeNull();
  });

  it('admits a recorded pointer bound to the current workflow run', () => {
    insertTask(db, { status: 'approved', postApprovalSessionId: 'current-run-worker' });
    insertWorkerSession(db, { sessionId: 'current-run-worker', workflowRunId: RUN_ID });
    expect(tam.getPostApprovalWorkerSession(TASK_ID, 'current-run-worker')?.sessionId).toBe(
      'current-run-worker'
    );
  });
});
