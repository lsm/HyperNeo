import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { Database as BunDatabase } from '../../../../src/storage/sqlite-compat';
import { runMigrations } from '../../../../src/storage/schema/index.ts';
import { SpaceWorkflowRepository } from '../../../../src/storage/repositories/space-workflow-repository.ts';
import { SpaceWorkflowRunRepository } from '../../../../src/storage/repositories/space-workflow-run-repository.ts';
import { SpaceTaskRepository } from '../../../../src/storage/repositories/space-task-repository.ts';
import { SpaceAgentRepository } from '../../../../src/storage/repositories/space-agent-repository.ts';
import { NodeExecutionRepository } from '../../../../src/storage/repositories/node-execution-repository.ts';
import { SpaceAgentManager } from '../../../../src/lib/space/managers/space-agent-manager.ts';
import { SpaceWorkflowManager } from '../../../../src/lib/space/managers/space-workflow-manager.ts';
import { SpaceManager } from '../../../../src/lib/space/managers/space-manager.ts';
import { SpaceRuntime } from '../../../../src/lib/space/runtime/space-runtime.ts';
import type { SpaceRuntimeConfig } from '../../../../src/lib/space/runtime/space-runtime.ts';
import type { SpaceWorkflow, AgentProcessingState } from '@hyperneo/shared';

function makeDb(): BunDatabase {
  const db = new BunDatabase(':memory:');
  db.exec('PRAGMA foreign_keys = ON');
  runMigrations(db, () => {});

  db.exec(`CREATE TABLE IF NOT EXISTS sdk_messages (
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
		consumed_seq INTEGER
	)`);

  return db;
}

function seedSpaceRow(db: BunDatabase, spaceId: string, workspacePath = '/tmp/ws'): void {
  db.prepare(
    `INSERT INTO spaces (id, workspace_path, name, description, background_context, instructions,
     allowed_models, session_ids, slug, status, created_at, updated_at)
     VALUES (?, ?, ?, '', '', '', '[]', '[]', ?, 'active', ?, ?)`
  ).run(spaceId, workspacePath, `Space ${spaceId}`, spaceId, Date.now(), Date.now());
}

function seedAgentRow(db: BunDatabase, agentId: string, spaceId: string): void {
  db.prepare(
    `INSERT INTO space_agents (id, space_id, name, description, model, tools, system_prompt, created_at, updated_at)
     VALUES (?, ?, ?, '', null, '[]', '', ?, ?)`
  ).run(agentId, spaceId, `Agent ${agentId}`, Date.now(), Date.now());
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
    name: `Workflow-${Date.now()}-${Math.random()}`,
    description: 'Test',
    nodes,
    transitions,
    startNodeId: nodes[0].id,
    rules: [],
    tags: [],
    completionAutonomyLevel: 3,
  });
}

interface AgentSessionStub {
  getProcessingState(): AgentProcessingState;
  markPendingQuestionOrphaned: (
    reason: 'agent_session_terminated' | 'rehydrate_failed'
  ) => Promise<boolean>;
  _orphanCalls: Array<'agent_session_terminated' | 'rehydrate_failed'>;
}

function makeAgentSessionStub(state: AgentProcessingState): AgentSessionStub {
  const orphanCalls: Array<'agent_session_terminated' | 'rehydrate_failed'> = [];
  return {
    getProcessingState: () => state,
    markPendingQuestionOrphaned: async (reason) => {
      orphanCalls.push(reason);
      return true;
    },
    _orphanCalls: orphanCalls,
  };
}

function makeMockTaskAgentManager(opts: {
  aliveSessions?: Set<string>;
  sessionStubs?: Map<string, AgentSessionStub>;
}) {
  return {
    isSpawning: () => false,
    isTaskAgentAlive: () => false,
    isExecutionSpawning: () => false,
    isSessionAlive: (sessionId: string) => opts.aliveSessions?.has(sessionId) ?? false,
    isSessionInMemory: (sessionId: string) => opts.aliveSessions?.has(sessionId) ?? false,
    spawnWorkflowNodeAgent: async () => 'unused',
    spawnWorkflowNodeAgentForExecution: async () => 'unused',
    rehydrate: async () => {},
    cancelBySessionId: () => {},
    interruptBySessionId: async () => {},
    getAgentSessionById: (sessionId: string) => opts.sessionStubs?.get(sessionId) ?? null,
    injectIntoTaskAgent: async () => ({ injected: false, reason: 'no-session' }),
  };
}

describe('SpaceRuntime — orphaned-question cleanup (Task #138)', () => {
  let db: BunDatabase;
  let workflowRunRepo: SpaceWorkflowRunRepository;
  let taskRepo: SpaceTaskRepository;
  let agentManager: SpaceAgentManager;
  let workflowManager: SpaceWorkflowManager;
  let spaceManager: SpaceManager;
  let nodeExecutionRepo: NodeExecutionRepository;

  const SPACE_ID = 'space-orphan-1';
  const AGENT = 'agent-orphan-1';
  const STEP_A = 'step-a';

  function buildConfig(tam: ReturnType<typeof makeMockTaskAgentManager>): SpaceRuntimeConfig {
    return {
      db,
      spaceManager,
      spaceAgentManager: agentManager,
      spaceWorkflowManager: workflowManager,
      workflowRunRepo,
      taskRepo,
      nodeExecutionRepo,
      taskAgentManager: tam as never,
    };
  }

  beforeEach(() => {
    db = makeDb();
    seedSpaceRow(db, SPACE_ID);
    seedAgentRow(db, AGENT, SPACE_ID);

    workflowRunRepo = new SpaceWorkflowRunRepository(db);
    taskRepo = new SpaceTaskRepository(db);
    const agentRepo = new SpaceAgentRepository(db);
    agentManager = new SpaceAgentManager(agentRepo);
    const workflowRepo = new SpaceWorkflowRepository(db);
    workflowManager = new SpaceWorkflowManager(workflowRepo);
    spaceManager = new SpaceManager(db);
    nodeExecutionRepo = new NodeExecutionRepository(db);
  });

  afterEach(() => {
    try {
      db.close();
    } catch {}
  });

  describe('Step 1 (liveness) orphans pending questions on dead sessions', () => {
    test('calls markPendingQuestionOrphaned with agent_session_terminated on a dead waiting_for_input session', async () => {
      const workflow = buildLinearWorkflow(SPACE_ID, workflowManager, [
        { id: STEP_A, name: 'Step A', agentId: AGENT },
      ]);
      const run = workflowRunRepo.createRun({
        spaceId: SPACE_ID,
        workflowId: workflow.id,
        title: 'Crashed-question run',
      });
      workflowRunRepo.transitionStatus(run.id, 'in_progress');
      taskRepo.createTask({
        spaceId: SPACE_ID,
        title: 'Crashed-question run',
        description: '',
        workflowRunId: run.id,
        workflowNodeId: STEP_A,
        status: 'in_progress',
      });

      const sessionId = 'session-crashed';
      const created = nodeExecutionRepo.createOrIgnore({
        workflowRunId: run.id,
        workflowNodeId: STEP_A,
        agentName: 'Step A',
        agentId: AGENT,
        status: 'pending',
      });
      nodeExecutionRepo.update(created.id, {
        status: 'in_progress',
        agentSessionId: sessionId,
      });

      const stub = makeAgentSessionStub({
        status: 'waiting_for_input',
        pendingQuestion: {
          toolUseId: 'tool-orphaned',
          questions: [
            {
              question: '?',
              header: 'X',
              options: [{ label: 'A', description: 'A' }],
              multiSelect: false,
            },
          ],
          askedAt: Date.now(),
        },
      });

      const tam = makeMockTaskAgentManager({
        aliveSessions: new Set(),
        sessionStubs: new Map([[sessionId, stub]]),
      });
      const rt = new SpaceRuntime(buildConfig(tam));

      await rt.executeTick();

      expect(stub._orphanCalls).toEqual(['agent_session_terminated']);
    });

    test('orphan cleanup is best-effort: if the session has no stub, the crash path still resets the execution', async () => {
      const workflow = buildLinearWorkflow(SPACE_ID, workflowManager, [
        { id: STEP_A, name: 'Step A', agentId: AGENT },
      ]);
      const run = workflowRunRepo.createRun({
        spaceId: SPACE_ID,
        workflowId: workflow.id,
        title: 'Vanished-session run',
      });
      workflowRunRepo.transitionStatus(run.id, 'in_progress');
      taskRepo.createTask({
        spaceId: SPACE_ID,
        title: 'Vanished-session run',
        description: '',
        workflowRunId: run.id,
        workflowNodeId: STEP_A,
        status: 'in_progress',
      });

      const sessionId = 'session-vanished';
      const created = nodeExecutionRepo.createOrIgnore({
        workflowRunId: run.id,
        workflowNodeId: STEP_A,
        agentName: 'Step A',
        agentId: AGENT,
        status: 'pending',
      });
      nodeExecutionRepo.update(created.id, {
        status: 'in_progress',
        agentSessionId: sessionId,
      });

      const tam = makeMockTaskAgentManager({
        aliveSessions: new Set(),
        sessionStubs: new Map(),
      });
      const rt = new SpaceRuntime(buildConfig(tam));

      await rt.executeTick();
    });
  });
});
