import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import type { SpaceWorkflow } from '@hyperneo/shared';
import { SpaceManager } from '../../../../src/lib/space/managers/space-manager.ts';
import { SpaceWorkflowManager } from '../../../../src/lib/space/managers/space-workflow-manager.ts';
import type { SpaceRuntimeConfig } from '../../../../src/lib/space/runtime/space-runtime.ts';
import { SpaceRuntime } from '../../../../src/lib/space/runtime/space-runtime.ts';
import { NodeExecutionRepository } from '../../../../src/storage/repositories/node-execution-repository';
import { SDKMessageRepository } from '../../../../src/storage/repositories/sdk-message-repository';
import { SpaceLongHorizonAgentRepository } from '../../../../src/storage/repositories/space-long-horizon-agent-repository.ts';
import { SpaceTaskRepository } from '../../../../src/storage/repositories/space-task-repository.ts';
import { SpaceWorkflowRepository } from '../../../../src/storage/repositories/space-workflow-repository.ts';
import { SpaceWorkflowRunRepository } from '../../../../src/storage/repositories/space-workflow-run-repository.ts';
import { runMigrations } from '../../../../src/storage/schema/index.ts';
import { Database as BunDatabase } from '../../../../src/storage/sqlite-compat';
import { seedUnifiedAgentMirror } from '../../helpers/seed-unified-agent';

function makeDb(): BunDatabase {
  const db = new BunDatabase(':memory:');
  db.exec('PRAGMA foreign_keys = ON');
  runMigrations(db, () => {});
  db.exec(`
		CREATE TABLE IF NOT EXISTS sdk_messages (
			id TEXT PRIMARY KEY,
			session_id TEXT NOT NULL,
			message_type TEXT NOT NULL,
			message_subtype TEXT,
			sdk_message TEXT NOT NULL,
			timestamp TEXT NOT NULL,
			send_status TEXT,
			origin TEXT,
			is_renderable INTEGER NOT NULL DEFAULT 1,
			is_terminal INTEGER NOT NULL DEFAULT 0,
			conversation_turn_index INTEGER,
			parent_tool_use_id TEXT,
			task_id TEXT,
			sdk_uuid TEXT,
			replacement_metadata_normalized INTEGER NOT NULL DEFAULT 0
		);
		CREATE TABLE IF NOT EXISTS sdk_message_replacements (
			source_message_id TEXT NOT NULL,
			session_id TEXT NOT NULL,
			task_id TEXT,
			target_uuid TEXT NOT NULL,
			kind TEXT NOT NULL CHECK(kind IN ('superseded', 'retracted')),
			PRIMARY KEY (source_message_id, target_uuid, kind)
		);
		CREATE INDEX IF NOT EXISTS idx_sdk_messages_task_id ON sdk_messages(task_id);
	`);
  return db;
}

function seedSpaceRow(db: BunDatabase, spaceId: string, maxConcurrentTasks = 1): void {
  db.prepare(
    `INSERT INTO spaces (id, workspace_path, name, description, background_context, instructions,
     allowed_models, session_ids, slug, status, max_concurrent_tasks, created_at, updated_at)
     VALUES (?, '/tmp/ws-3821', ?, '', '', '', '[]', '[]', ?, 'active', ?, ?, ?)`
  ).run(spaceId, `Space ${spaceId}`, spaceId, maxConcurrentTasks, Date.now(), Date.now());
}

function buildLinearWorkflow(
  spaceId: string,
  workflowManager: SpaceWorkflowManager,
  nodes: Array<{ id: string; name: string; agentId: string }>
): SpaceWorkflow {
  const transitions = nodes.slice(0, -1).map((step, i) => ({
    from: step.id,
    to: nodes[i + 1].id,
    condition: { type: 'always' as const },
    order: 0,
  }));
  return workflowManager.createWorkflow({
    spaceId,
    name: `WF-3821-${Date.now()}-${Math.random()}`,
    description: 'Test',
    nodes,
    transitions,
    startNodeId: nodes[0].id,
    rules: [],
    tags: [],
    completionAutonomyLevel: 3,
  });
}

function makeTaskAgentManagerMock(aliveSessionIds: Set<string>) {
  return {
    isSessionAlive: (sessionId: string) => aliveSessionIds.has(sessionId),
    isSessionInMemory: (sessionId: string) => aliveSessionIds.has(sessionId),
    isSessionWorkerForTask: () => false,
    isSessionOnPostApprovalRoute: () => false,
    cancelBySessionId: () => {},
    spawnPostApprovalSubSession: async () => {
      throw new Error('unexpected post-approval spawn in this suite');
    },
    isSpawning: () => false,
    isTaskAgentAlive: () => false,
    isExecutionSpawning: () => false,
    spawnWorkflowNodeAgent: async () => 'session:spawned',
    spawnWorkflowNodeAgentForExecution: async () => 'session:spawned',
    rehydrate: async () => {},
    interruptBySessionId: async () => {},
    restartStuckSubSession: async () => {},
    injectRuntimeRecoveryMessage: async (sessionId: string) => `runtime-nag:${sessionId}`,
    getAgentSessionById: () => null,
    injectIntoTaskAgent: async () => ({ injected: false, reason: 'no-session' }),
  };
}

async function waitFor(
  predicate: () => boolean,
  timeoutMs = 2_000,
  intervalMs = 10
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return true;
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  return predicate();
}

describe('SpaceRuntime — post-crash open-task dispatch (post-approval window)', () => {
  let db: BunDatabase;
  let workflowRunRepo: SpaceWorkflowRunRepository;
  let taskRepo: SpaceTaskRepository;
  let nodeExecutionRepo: NodeExecutionRepository;
  let sdkMessageRepo: SDKMessageRepository;
  let workflowManager: SpaceWorkflowManager;
  let spaceManager: SpaceManager;

  const SPACE_ID = 'space-3821';
  const AGENT = 'agent-3821';
  const STEP_A = 'step-a';

  beforeEach(() => {
    db = makeDb();
    seedSpaceRow(db, SPACE_ID);
    seedUnifiedAgentMirror(db, { id: AGENT, spaceId: SPACE_ID, name: 'Coder' });
    workflowRunRepo = new SpaceWorkflowRunRepository(db);
    taskRepo = new SpaceTaskRepository(db);
    nodeExecutionRepo = new NodeExecutionRepository(db);
    sdkMessageRepo = new SDKMessageRepository(db);
    const workflowRepo = new SpaceWorkflowRepository(db);
    workflowManager = new SpaceWorkflowManager(workflowRepo);
    spaceManager = new SpaceManager(db);
  });

  afterEach(() => {
    try {
      db.close();
    } catch {}
  });

  function makeRuntime(aliveSessionIds: Set<string> = new Set()): SpaceRuntime {
    return new SpaceRuntime({
      db,
      spaceManager,
      longHorizonAgentRepo: new SpaceLongHorizonAgentRepository(db),
      spaceWorkflowManager: workflowManager,
      workflowRunRepo,
      taskRepo,
      nodeExecutionRepo,
      sdkMessageRepo,
      taskAgentManager: makeTaskAgentManagerMock(aliveSessionIds) as never,
    } as SpaceRuntimeConfig);
  }

  function seedApprovedPriorTask(workflow: SpaceWorkflow, runStatus: 'done' | 'in_progress') {
    const run = workflowRunRepo.createRun({
      spaceId: SPACE_ID,
      workflowId: workflow.id,
      title: 'Prior run',
    });
    workflowRunRepo.transitionStatus(run.id, 'in_progress');
    if (runStatus === 'done') {
      workflowRunRepo.transitionStatus(run.id, 'done');
    }
    const task = taskRepo.createTask({
      spaceId: SPACE_ID,
      title: 'Prior approved task',
      description: '',
      workflowRunId: run.id,
      status: 'approved',
    });
    taskRepo.updateTask(task.id, {
      approvedAt: Date.now() - 60_000,
      postApprovalSessionId: 'session:dead-post-approval',
    });
    return { run, task };
  }

  test('open-at-crash task dispatches after restart while the crashed approved task re-dispatches', async () => {
    const workflow = buildLinearWorkflow(SPACE_ID, workflowManager, [
      { id: STEP_A, name: 'Code', agentId: AGENT },
    ]);
    const { task: prior } = seedApprovedPriorTask(workflow, 'done');
    const open = taskRepo.createTask({
      spaceId: SPACE_ID,
      title: 'Open at crash',
      description: '',
      status: 'open',
      preferredWorkflowId: workflow.id,
    });

    const rt = makeRuntime(new Set());
    await rt.executeTick();

    const attached = taskRepo.getTask(open.id)!;
    expect(attached.status).toBe('in_progress');
    expect(attached.workflowRunId).not.toBeNull();

    const priorSettled = await waitFor(() => taskRepo.getTask(prior.id)?.status === 'done');
    expect(priorSettled).toBe(true);
    expect(taskRepo.getTask(prior.id)?.postApprovalSessionId ?? null).toBeNull();
  });

  test('approved task with a live post-approval worker keeps deferring standalone admission', async () => {
    const workflow = buildLinearWorkflow(SPACE_ID, workflowManager, [
      { id: STEP_A, name: 'Code', agentId: AGENT },
    ]);
    const { task: prior } = seedApprovedPriorTask(workflow, 'done');
    const open = taskRepo.createTask({
      spaceId: SPACE_ID,
      title: 'Waiting task',
      description: '',
      status: 'open',
      preferredWorkflowId: workflow.id,
    });

    const rt = makeRuntime(new Set(['session:dead-post-approval']));
    await rt.executeTick();
    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(taskRepo.getTask(open.id)?.status).toBe('open');
    expect(taskRepo.getTask(open.id)?.workflowRunId ?? null).toBeNull();
    expect(taskRepo.getTask(prior.id)?.status).toBe('approved');
  });

  test('approved task whose dispatch has not recorded a session yet keeps holding the slot', async () => {
    const workflow = buildLinearWorkflow(SPACE_ID, workflowManager, [
      { id: STEP_A, name: 'Code', agentId: AGENT },
    ]);
    const { run, task: prior } = seedApprovedPriorTask(workflow, 'done');
    taskRepo.updateTask(prior.id, { postApprovalSessionId: null });
    const open = taskRepo.createTask({
      spaceId: SPACE_ID,
      title: 'Waiting task',
      description: '',
      status: 'open',
      preferredWorkflowId: workflow.id,
    });

    const rt = makeRuntime(new Set());
    await rt.executeTick();
    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(taskRepo.getTask(open.id)?.status).toBe('open');
    expect(taskRepo.getTask(prior.id)?.status).toBe('approved');
    expect(workflowRunRepo.getRun(run.id)?.status).toBe('done');
  });

  test('blocked post-approval dispatch on a non-succeeded run defers admission without throwing', async () => {
    const workflow = buildLinearWorkflow(SPACE_ID, workflowManager, [
      { id: STEP_A, name: 'Code', agentId: AGENT },
    ]);
    const { task: prior } = seedApprovedPriorTask(workflow, 'in_progress');
    taskRepo.updateTask(prior.id, {
      postApprovalSessionId: null,
      postApprovalBlockedReason: 'post-approval spawn deferred',
    });
    const open = taskRepo.createTask({
      spaceId: SPACE_ID,
      title: 'Waiting task',
      description: '',
      status: 'open',
      preferredWorkflowId: workflow.id,
    });

    const rt = makeRuntime(new Set());
    await expect(rt.executeTick()).resolves.toBeUndefined();
    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(taskRepo.getTask(open.id)?.status).toBe('open');
    expect(taskRepo.getTask(prior.id)?.status).toBe('approved');
  });
});
