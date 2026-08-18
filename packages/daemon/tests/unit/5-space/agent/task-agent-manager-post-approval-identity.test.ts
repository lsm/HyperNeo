import { describe, expect, it, beforeEach } from 'bun:test';
import { Database as BunDatabase } from '../../../../src/storage/sqlite-compat';
import { createTables } from '../../../../src/storage/schema';
import { TaskAgentManager } from '../../../../src/lib/space/runtime/task-agent-manager';
import type { TaskAgentManagerConfig } from '../../../../src/lib/space/runtime/task-agent-manager';
import { SpaceTaskRepository } from '../../../../src/storage/repositories/space-task-repository';
import { InternalEventBus } from '../../../../src/lib/internal-event-bus';
import type { DaemonInternalEventMap } from '../../../../src/lib/internal-event-bus';

const SPACE_ID = 'space-id';
const RUN_ID = 'run-1';
const TASK_ID = 'task-1';
const POST_APPROVAL_NODE = 'node-post-approval';

interface WorkerSessionOpts {
  sessionId: string;
  agentName?: string;
  workflowRunId?: string;
  taskId?: string;
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
  const lastActiveAt = opts.lastActiveAt ?? 1;
  const sessionTaskId = opts.taskId ?? TASK_ID;
  db.prepare(
    `INSERT INTO sessions (id, title, workspace_path, created_at, last_active_at, status, config, metadata, is_worktree, type, session_context)
     VALUES (?, 'Worker', '/tmp/ws', 0, ?, 'active', '{}', ?, 0, 'worker', ?)`
  ).run(
    opts.sessionId,
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

function insertTask(
  db: BunDatabase,
  overrides: { status?: string; postApprovalSessionId?: string | null } = {}
): void {
  db.prepare(
    `INSERT INTO space_tasks (id, space_id, task_number, title, description, status, priority, workflow_run_id, post_approval_session_id, depends_on, created_at, updated_at)
     VALUES (?, ?, 1, 'T', '', ?, 'normal', ?, ?, '[]', 0, 0)`
  ).run(
    TASK_ID,
    SPACE_ID,
    overrides.status ?? 'in_progress',
    RUN_ID,
    overrides.postApprovalSessionId ?? null
  );
}

function makeManager(db: BunDatabase): TaskAgentManager {
  return new TaskAgentManager({
    db: { getDatabase: () => db },
    taskRepo: new SpaceTaskRepository(db),
    sessionManager: { registerSession: () => {} },
    internalEventBus: new InternalEventBus<DaemonInternalEventMap>(),
    spaceManager: { getSpace: async () => ({ id: SPACE_ID, workspacePath: '/tmp/ws' }) },
    spaceWorkflowManager: { getWorkflow: () => null, getWorkflowForRun: () => null },
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

  it('honors an explicit hint to select an OLDER worker (P1 misroute)', () => {
    insertTask(db, { postApprovalSessionId: 'worker-recent' });
    insertWorkerSession(db, { sessionId: 'worker-old', lastActiveAt: 1 });
    insertWorkerSession(db, { sessionId: 'worker-recent', lastActiveAt: 5 });
    const res = tam.getPostApprovalWorkerSession(TASK_ID, 'worker-old');
    expect(res).toEqual({
      sessionId: 'worker-old',
      agentName: 'merger',
      nodeId: POST_APPROVAL_NODE,
    });
  });

  it('rejects a hint that points at an execution-backed (normal node-agent) session', () => {
    insertTask(db, { postApprovalSessionId: 'worker-1' });
    insertWorkerSession(db, { sessionId: 'worker-1' });
    insertWorkerSession(db, { sessionId: 'coder-1', agentName: 'coder', withExecution: true });
    expect(tam.getPostApprovalWorkerSession(TASK_ID, 'coder-1')).toBeNull();
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

  it('falls back to durable provenance when the pointer is cleared (done task)', () => {
    insertTask(db, { status: 'done', postApprovalSessionId: null });
    insertWorkerSession(db, { sessionId: 'worker-done', lastActiveAt: 9 });
    const res = tam.getPostApprovalWorkerSession(TASK_ID);
    expect(res).toEqual({
      sessionId: 'worker-done',
      agentName: 'merger',
      nodeId: POST_APPROVAL_NODE,
    });
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
