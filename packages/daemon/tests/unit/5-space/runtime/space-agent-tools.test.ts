/**
 * Unit tests for createSpaceAgentToolHandlers()
 *
 * Covers (per M7 spec tools):
 * - list_workflows: returns space workflows
 * - start_workflow_run: explicit workflowId required; creates run + tasks
 * - get_workflow_run: returns run status, current step, and node executions
 * - change_plan: description update; workflow switch (cancel + restart)
 * - list_tasks: filter by status, workflowRunId
 */

import { describe, test, expect, beforeEach, afterEach, mock, spyOn } from 'bun:test';
import type { ModelInfo } from '@hyperneo/shared';
import { Database as BunDatabase } from '../../../../src/storage/sqlite-compat';
import { createTables, runMigrations } from '../../../../src/storage/schema/index.ts';
import { SpaceWorkflowRepository } from '../../../../src/storage/repositories/space-workflow-repository.ts';
import { SpaceWorkflowRunRepository } from '../../../../src/storage/repositories/space-workflow-run-repository.ts';
import { SpaceTaskRepository } from '../../../../src/storage/repositories/space-task-repository.ts';
import { SpaceGoalEventRepository } from '../../../../src/storage/repositories/space-goal-event-repository.ts';
import { SpaceGoalRepository } from '../../../../src/storage/repositories/space-goal-repository.ts';
import { SpaceRepository } from '../../../../src/storage/repositories/space-repository.ts';
import { TaskScheduleRepository } from '../../../../src/storage/repositories/task-schedule-repository.ts';
import { EvolutionRepository } from '../../../../src/storage/repositories/evolution-repository.ts';
import { WorkflowRunArtifactRepository } from '../../../../src/storage/repositories/workflow-run-artifact-repository.ts';
import { JobQueueRepository } from '../../../../src/storage/repositories/job-queue-repository.ts';
import { NodeExecutionRepository } from '../../../../src/storage/repositories/node-execution-repository.ts';
import { SpaceAgentRepository } from '../../../../src/storage/repositories/space-agent-repository.ts';
import { SpaceLongHorizonAgentRepository } from '../../../../src/storage/repositories/space-long-horizon-agent-repository.ts';
import { McpAuditLogRepository } from '../../../../src/storage/repositories/mcp-audit-log-repository.ts';
import { SpaceAgentManager } from '../../../../src/lib/space/managers/space-agent-manager.ts';
import { SpaceWorkflowManager } from '../../../../src/lib/space/managers/space-workflow-manager.ts';
import { SpaceTaskManager } from '../../../../src/lib/space/managers/space-task-manager.ts';
import { SpaceManager } from '../../../../src/lib/space/managers/space-manager.ts';
import { SpaceRuntime } from '../../../../src/lib/space/runtime/space-runtime.ts';
import { ScheduleService } from '../../../../src/lib/space/schedule/schedule-service.ts';
import { SpaceGoalService } from '../../../../src/lib/space/goals/goal-service.ts';
import { EvolutionScopeService } from '../../../../src/lib/space/evolution-scope-service.ts';
import { EvolutionEpisodeService } from '../../../../src/lib/space/evolution-episode-service.ts';
import {
  createSpaceAgentMcpServer,
  createSpaceAgentToolHandlers,
  validateTemplateReminder,
} from '../../../../src/lib/space/tools/space-agent-tools.ts';
import { getLongHorizonAgentTemplate } from '../../../../src/lib/space/agents/long-horizon-agent-templates.ts';
import { ExternalEventStore } from '../../../../src/lib/external-events/external-event-store.ts';
import type { ExternalEvent } from '../../../../src/lib/external-events/types.ts';
import type { SpaceTask, SpaceWorkflow } from '@hyperneo/shared';
import type { TaskAgentManager } from '../../../../src/lib/space/runtime/task-agent-manager.ts';
import { formatAgentMessage } from '../../../../src/lib/space/agent-message-envelope.ts';
import { getModelsCache, setModelsCache } from '../../../../src/lib/model-service.ts';

// ---------------------------------------------------------------------------
// DB + space setup helpers
// ---------------------------------------------------------------------------

function makeDb(): BunDatabase {
  // Use in-memory SQLite — faster than file-based DB and avoids filesystem
  // I/O contention that caused beforeEach hook timeouts in CI.
  const db = new BunDatabase(':memory:');
  db.exec('PRAGMA foreign_keys = ON');
  runMigrations(db, () => {});

  db.exec(`CREATE TABLE IF NOT EXISTS sessions (
    id TEXT PRIMARY KEY,
    title TEXT NOT NULL,
    workspace_path TEXT,
    created_at TEXT NOT NULL,
    last_active_at TEXT NOT NULL,
    status TEXT NOT NULL,
    config TEXT NOT NULL,
    metadata TEXT NOT NULL,
    is_worktree INTEGER DEFAULT 0,
    worktree_path TEXT,
    main_repo_path TEXT,
    worktree_branch TEXT,
    git_branch TEXT,
    sdk_session_id TEXT,
    acp_session_id TEXT,
    sdk_origin_path TEXT,
    available_commands TEXT,
    processing_state TEXT,
    archived_at TEXT,
    parent_id TEXT,
    type TEXT DEFAULT 'worker',
    session_context TEXT
  )`);

  // runMigrations() applies migrations only; these unit fixtures need the base
  // sdk_messages table because runtime recovery inspects persisted SDK output.
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
		task_id TEXT,
		sdk_uuid TEXT,
		replacement_metadata_normalized INTEGER NOT NULL DEFAULT 0
	)`);
  db.exec(`CREATE TABLE IF NOT EXISTS sdk_message_replacements (
		source_message_id TEXT NOT NULL,
		session_id TEXT NOT NULL,
		task_id TEXT,
		target_uuid TEXT NOT NULL,
		kind TEXT NOT NULL CHECK(kind IN ('superseded', 'retracted')),
		PRIMARY KEY (source_message_id, target_uuid, kind)
	)`);

  // runMigrations() does not create the job_queue table (it is bootstrapped
  // from storage/schema, not a migration). Goal check-in schedules enqueue
  // fire jobs, so the table must exist for schedule-editing tests.
  db.exec(`CREATE TABLE IF NOT EXISTS job_queue (
		id TEXT PRIMARY KEY,
		queue TEXT NOT NULL,
		status TEXT NOT NULL DEFAULT 'pending'
			CHECK(status IN ('pending', 'processing', 'completed', 'failed', 'dead')),
		payload TEXT NOT NULL DEFAULT '{}',
		result TEXT,
		error TEXT,
		priority INTEGER NOT NULL DEFAULT 0,
		max_retries INTEGER NOT NULL DEFAULT 3,
		retry_count INTEGER NOT NULL DEFAULT 0,
		run_at INTEGER NOT NULL,
		created_at INTEGER NOT NULL,
		started_at TEXT,
		completed_at TEXT
	)`);

  return db;
}

function seedSpaceRow(db: BunDatabase, spaceId: string, workspacePath = '/tmp/workspace'): void {
  db.prepare(
    `INSERT INTO spaces (id, workspace_path, name, description, background_context, instructions,
     allowed_models, session_ids, slug, status, created_at, updated_at)
     VALUES (?, ?, ?, '', '', '', '[]', '[]', ?, 'active', ?, ?)`
  ).run(spaceId, workspacePath, `Space ${spaceId}`, spaceId, Date.now(), Date.now());
}

function seedAgentRow(db: BunDatabase, agentId: string, spaceId: string, name: string): void {
  db.prepare(
    `INSERT INTO space_agents (id, space_id, name, description, model, tools, system_prompt, created_at, updated_at)
     VALUES (?, ?, ?, '', null, '[]', '', ?, ?)`
  ).run(agentId, spaceId, name, Date.now(), Date.now());
}

// ---------------------------------------------------------------------------
// Build a single-step workflow (terminal — no transitions)
// ---------------------------------------------------------------------------

function buildSingleStepWorkflow(
  spaceId: string,
  workflowManager: SpaceWorkflowManager,
  agentId: string,
  name: string,
  tags: string[] = [],
  description = '',
  disabled = false
): SpaceWorkflow {
  const stepId = `step-${Math.random().toString(36).slice(2)}`;
  const wf = workflowManager.createWorkflow({
    spaceId,
    name,
    description,
    nodes: [{ id: stepId, name: 'Work', agentId }],
    transitions: [],
    startNodeId: stepId,
    rules: [],
    tags,
    completionAutonomyLevel: 3,
    disabled,
  });
  return wf;
}

// ---------------------------------------------------------------------------
// Test context
// ---------------------------------------------------------------------------

interface TestCtx {
  db: BunDatabase;
  spaceId: string;
  agentId: string;
  workflowManager: SpaceWorkflowManager;
  workflowRunRepo: SpaceWorkflowRunRepository;
  taskRepo: SpaceTaskRepository;
  taskManager: SpaceTaskManager;
  agentManager: SpaceAgentManager;
  runtime: SpaceRuntime;
  nodeExecutionRepo: NodeExecutionRepository;
  spaceManager: SpaceManager;
  longHorizonAgentRepo: SpaceLongHorizonAgentRepository;
  goalService: SpaceGoalService;
  goalRepo: SpaceGoalRepository;
  scheduleService: ScheduleService;
  evolutionRepo: EvolutionRepository;
  evolutionScopeService: EvolutionScopeService;
  evolutionEpisodeService: EvolutionEpisodeService;
}

function makeCtx(): TestCtx {
  const db = makeDb();
  const spaceId = 'space-tools-test';
  const workspacePath = '/tmp/test-workspace';

  seedSpaceRow(db, spaceId, workspacePath);

  const agentId = 'agent-coder-1';
  seedAgentRow(db, agentId, spaceId, 'Coder');

  const agentRepo = new SpaceAgentRepository(db);
  const agentManager = new SpaceAgentManager(agentRepo);

  const workflowRepo = new SpaceWorkflowRepository(db);
  const workflowManager = new SpaceWorkflowManager(workflowRepo);

  const workflowRunRepo = new SpaceWorkflowRunRepository(db);
  const nodeExecutionRepo = new NodeExecutionRepository(db);
  const taskRepo = new SpaceTaskRepository(db);
  const spaceManager = new SpaceManager(db);
  const longHorizonAgentRepo = new SpaceLongHorizonAgentRepository(db);

  const runtime = new SpaceRuntime({
    db,
    spaceManager,
    spaceAgentManager: agentManager,
    spaceWorkflowManager: workflowManager,
    workflowRunRepo,
    taskRepo,
    nodeExecutionRepo,
    longHorizonAgentRepo,
  });

  const taskManager = new SpaceTaskManager(db, spaceId);
  const spaceRepo = new SpaceRepository(db);
  const scheduleRepo = new TaskScheduleRepository(db);
  const scheduleService = new ScheduleService({
    db,
    scheduleRepo,
    jobQueue: new JobQueueRepository(db),
    spaceRepo,
  });
  const goalRepo = new SpaceGoalRepository(db);
  const goalService = new SpaceGoalService({
    goalRepo,
    goalEventRepo: new SpaceGoalEventRepository(db),
    taskRepo,
    spaceRepo,
    scheduleService,
    db,
  });
  const evolutionRepo = new EvolutionRepository(db);
  const evolutionScopeService = new EvolutionScopeService({
    evolutionRepo,
    spaceRepo,
    goalRepo,
    taskRepo,
    workflowRunRepo,
  });
  const evolutionEpisodeService = new EvolutionEpisodeService({
    evolutionRepo,
    taskRepo,
    workflowRunRepo,
    artifactRepo: new WorkflowRunArtifactRepository(db),
    goalService,
    judgeEpisode: async () => ({
      title: 'Dogfood episode',
      outcomeSummary: 'Scoped evidence reviewed',
      findings: [
        {
          domain: 'workflow',
          kind: 'optimization',
          impact: 'medium',
          confidence: 0.8,
          evidence: ['manual note'],
          proposedAction: 'Add follow-up task',
        },
      ],
      candidateLessons: [
        {
          appliesTo: ['workflow'],
          rule: 'Keep evidence scoped',
          why: 'Reduces drift',
          confidence: 0.9,
        },
      ],
      proposals: [
        {
          title: 'Improve Forge MCP dogfood',
          description: 'Use MCP tools for Forge path',
          reason: 'Judge found next step',
          priority: 'high',
        },
      ],
    }),
  });

  return {
    db,
    spaceId,
    agentId,
    workflowManager,
    workflowRunRepo,
    taskRepo,
    taskManager,
    agentManager,
    runtime,
    nodeExecutionRepo,
    spaceManager,
    longHorizonAgentRepo,
    goalService,
    goalRepo,
    scheduleService,
    evolutionRepo,
    evolutionScopeService,
    evolutionEpisodeService,
  };
}

function makeHandlers(
  ctx: TestCtx,
  overrides: Partial<Parameters<typeof createSpaceAgentToolHandlers>[0]> = {}
) {
  return createSpaceAgentToolHandlers({
    spaceId: ctx.spaceId,
    db: ctx.db,
    runtime: ctx.runtime,
    workflowManager: ctx.workflowManager,
    taskRepo: ctx.taskRepo,
    workflowRunRepo: ctx.workflowRunRepo,
    taskManager: ctx.taskManager,
    spaceAgentManager: ctx.agentManager,
    nodeExecutionRepo: ctx.nodeExecutionRepo,
    spaceManager: ctx.spaceManager,
    longHorizonAgentRepo: ctx.longHorizonAgentRepo,
    goalService: ctx.goalService,
    goalRepo: ctx.goalRepo,
    scheduleService: ctx.scheduleService,
    evolutionScopeService: ctx.evolutionScopeService,
    evolutionEpisodeService: ctx.evolutionEpisodeService,
    ...overrides,
  });
}

async function startWorkflowRun(
  ctx: TestCtx,
  args: { workflow_id?: string; workflowId?: string; title: string; description?: string }
) {
  const workflowId =
    args.workflow_id ??
    args.workflowId ??
    ctx.workflowManager.listWorkflows(ctx.spaceId)[0]?.id ??
    '';
  const { run, tasks } = await ctx.runtime.startWorkflowRun(
    ctx.spaceId,
    workflowId,
    args.title,
    args.description
  );
  return {
    content: [{ type: 'text', text: JSON.stringify({ success: true, run, tasks }) }],
  };
}

function getRegisteredToolNames(server: ReturnType<typeof createSpaceAgentMcpServer>): string[] {
  const instance = server.instance as unknown as { _registeredTools: Record<string, unknown> };
  return Object.keys(instance._registeredTools);
}

function getRegisteredTool(server: ReturnType<typeof createSpaceAgentMcpServer>, name: string) {
  const instance = server.instance as unknown as {
    _registeredTools: Record<string, { inputSchema: unknown }>;
  };
  return instance._registeredTools[name];
}

function parseResult(result: { content: Array<{ text: string }> }) {
  return JSON.parse(result.content[0].text) as Record<string, unknown>;
}

function expectToolInputParses(
  server: ReturnType<typeof createSpaceAgentMcpServer>,
  name: string,
  input: Record<string, unknown>
) {
  const inputSchema = getRegisteredTool(server, name).inputSchema;
  if (hasParser(inputSchema)) {
    inputSchema.parse(input);
    return;
  }
  const shape = inputSchema as Record<string, unknown>;
  for (const [key, value] of Object.entries(input)) {
    const field = shape[key];
    if (hasParser(field)) field.parse(value);
  }
}

function hasParser(value: unknown): value is { parse: (input: unknown) => unknown } {
  return typeof (value as { parse?: unknown } | null)?.parse === 'function';
}

describe('schema evolution setup', () => {
  test('createTables works before space_agents exists', () => {
    const db = new BunDatabase(':memory:');
    expect(() => createTables(db)).not.toThrow();
    db.close();
  });
});

describe('createSpaceAgentMcpServer — tool registration', () => {
  let ctx: TestCtx;
  beforeEach(() => {
    ctx = makeCtx();
  });
  afterEach(() => {
    ctx.db.close();
  });

  test('does not register start_workflow_run for Space Agent sessions', () => {
    const server = createSpaceAgentMcpServer({
      spaceId: ctx.spaceId,
      runtime: ctx.runtime,
      workflowManager: ctx.workflowManager,
      taskRepo: ctx.taskRepo,
      nodeExecutionRepo: ctx.nodeExecutionRepo,
      workflowRunRepo: ctx.workflowRunRepo,
      taskManager: ctx.taskManager,
      spaceAgentManager: ctx.agentManager,
    });

    const names = getRegisteredToolNames(server);
    expect(names).not.toContain('start_workflow_run');
    expect(names).toContain('create_standalone_task');
    expect(names).toContain('approve_task');
    expect(names).toContain('approve_pending_completion');
    expect(names).toContain('complete_validation_task');
    expect(names).toContain('list_sessions');
    expect(names).toContain('get_session_detail');
    expect(names).toContain('get_session_messages');
    expect(names).toContain('send_session_message');
    expect(names).toContain('update_session_state');
    expect(names).toContain('interrupt_session');
    expect(names).not.toContain('create_agent');
    expect(names).not.toContain('assign_agent_to_goal');
    expect(names).not.toContain('create_agent_reminder');
    expect(names).not.toContain('create_goal');
  });

  test('registers long-horizon agent tools when database is configured', () => {
    const server = createSpaceAgentMcpServer({
      spaceId: ctx.spaceId,
      db: ctx.db,
      runtime: ctx.runtime,
      workflowManager: ctx.workflowManager,
      taskRepo: ctx.taskRepo,
      nodeExecutionRepo: ctx.nodeExecutionRepo,
      workflowRunRepo: ctx.workflowRunRepo,
      taskManager: ctx.taskManager,
      spaceAgentManager: ctx.agentManager,
    });

    const names = getRegisteredToolNames(server);
    expect(names).toContain('create_agent');
    expect(names).toContain('assign_agent_to_goal');
    expect(names).toContain('create_agent_reminder');
    expect(() =>
      expectToolInputParses(server, 'update_agent', {
        agent_id: 'agent-1',
        status: 'disabled',
      })
    ).not.toThrow();
    expect(() =>
      expectToolInputParses(server, 'list_agents', { status: 'disabled' })
    ).not.toThrow();
  });

  test('registers goal tools when goalService is configured', () => {
    const server = createSpaceAgentMcpServer({
      spaceId: ctx.spaceId,
      runtime: ctx.runtime,
      workflowManager: ctx.workflowManager,
      taskRepo: ctx.taskRepo,
      nodeExecutionRepo: ctx.nodeExecutionRepo,
      workflowRunRepo: ctx.workflowRunRepo,
      taskManager: ctx.taskManager,
      spaceAgentManager: ctx.agentManager,
      goalService: ctx.goalService,
    });

    const names = getRegisteredToolNames(server);
    expect(names).toContain('create_goal');
    expect(names).toContain('update_goal');
    expect(names).toContain('trigger_goal_task');
    expect(names).toContain('list_goal_tasks');
    expect(names).toContain('list_goal_events');
  });

  test('registers Forge tools when evolution services are configured', () => {
    const server = createSpaceAgentMcpServer({
      spaceId: ctx.spaceId,
      runtime: ctx.runtime,
      workflowManager: ctx.workflowManager,
      taskRepo: ctx.taskRepo,
      nodeExecutionRepo: ctx.nodeExecutionRepo,
      workflowRunRepo: ctx.workflowRunRepo,
      taskManager: ctx.taskManager,
      spaceAgentManager: ctx.agentManager,
      goalService: ctx.goalService,
      evolutionScopeService: ctx.evolutionScopeService,
      evolutionEpisodeService: ctx.evolutionEpisodeService,
    });

    const names = getRegisteredToolNames(server);
    expect(names).toContain('create_forge_scope');
    expect(names).toContain('add_forge_manual_note');
    expect(names).toContain('create_forge_episode');
    expect(names).toContain('list_forge_lessons');
    expect(names).toContain('list_forge_proposals');
    expect(names).toContain('resolve_forge_scope');
    expect(names).toContain('update_forge_lesson');
    expect(names).toContain('create_task_from_forge_proposal');
  });
});

// ---------------------------------------------------------------------------
// session management tools
// ---------------------------------------------------------------------------

describe('createSpaceAgentToolHandlers — archive_task active-run guard (task #849)', () => {
  let ctx: TestCtx;
  beforeEach(() => {
    ctx = makeCtx();
  });
  afterEach(() => {
    ctx.db.close();
  });

  test('rejects archiving the canonical task of an active (non-terminal) workflow run', async () => {
    // G1 widened the archive strand to open→archived; the agent tool must not
    // bypass the RPC handler's guard. `isWorkflowRunActive` is injected, so the
    // run's actual status is irrelevant to the guard's decision — we only need
    // a real run row to satisfy the workflow_run_id FK.
    const wf = buildSingleStepWorkflow(ctx.spaceId, ctx.workflowManager, ctx.agentId, 'WF');
    const run = ctx.workflowRunRepo.createRun({
      spaceId: ctx.spaceId,
      workflowId: wf.id,
      title: 'Run',
    });
    const task = ctx.taskRepo.createTask({
      spaceId: ctx.spaceId,
      title: 'T',
      description: '',
      status: 'open',
      workflowRunId: run.id,
    });
    const handlers = makeHandlers(ctx, { isWorkflowRunActive: () => true });

    const result = parseResult(await handlers.archive_task({ task_id: task.id }));

    expect(result.success).toBe(false);
    expect(result.error).toMatch(/active workflow run/);
    // The task is left untouched.
    expect(ctx.taskRepo.getTask(task.id)?.status).toBe('open');
  });

  test('allows archiving a task on a terminal (done/cancelled) run', async () => {
    const wf = buildSingleStepWorkflow(ctx.spaceId, ctx.workflowManager, ctx.agentId, 'WF');
    const run = ctx.workflowRunRepo.createRun({
      spaceId: ctx.spaceId,
      workflowId: wf.id,
      title: 'Run',
    });
    const task = ctx.taskRepo.createTask({
      spaceId: ctx.spaceId,
      title: 'T',
      description: '',
      status: 'open',
      workflowRunId: run.id,
    });
    const handlers = makeHandlers(ctx, { isWorkflowRunActive: () => false });

    const result = parseResult(await handlers.archive_task({ task_id: task.id }));

    expect(result.success).toBe(true);
    expect((result.task as SpaceTask).status).toBe('archived');
  });

  test('allows archiving a task with no workflow run', async () => {
    const task = ctx.taskRepo.createTask({
      spaceId: ctx.spaceId,
      title: 'T',
      description: '',
      status: 'open',
    });
    const handlers = makeHandlers(ctx);

    const result = parseResult(await handlers.archive_task({ task_id: task.id }));

    expect(result.success).toBe(true);
    expect((result.task as SpaceTask).status).toBe('archived');
  });
});

describe('createSpaceAgentToolHandlers — session management tools', () => {
  let ctx: TestCtx;
  beforeEach(() => {
    ctx = makeCtx();
  });
  afterEach(() => {
    ctx.db.close();
  });

  function seedSession(
    id: string,
    spaceId = ctx.spaceId,
    processingState = { status: 'idle' },
    context: Record<string, unknown> = {}
  ) {
    ctx.db
      .prepare(
        `INSERT INTO sessions (
          id, title, workspace_path, created_at, last_active_at, status, config, metadata,
          is_worktree, git_branch, processing_state, type, session_context
        ) VALUES (?, ?, ?, ?, ?, 'active', '{}', '{}', 1, 'feature/session-tools', ?, 'worker', ?)`
      )
      .run(
        id,
        `Session ${id}`,
        '/tmp/session-workspace',
        new Date(0).toISOString(),
        new Date().toISOString(),
        JSON.stringify(processingState),
        JSON.stringify({ spaceId, ...context })
      );
  }

  test('list_sessions includes ad-hoc sessions in current space only', async () => {
    seedSession('adhoc-1', ctx.spaceId, { status: 'waiting_for_input' });
    seedSession('other-space', 'other-space', { status: 'idle' });
    const handlers = makeHandlers(ctx);

    const parsed = parseResult(await handlers.list_sessions({}));

    expect(parsed.success).toBe(true);
    const sessions = parsed.sessions as Array<{ id: string; status: string; type: string }>;
    expect(sessions.map((session) => session.id)).toContain('adhoc-1');
    expect(sessions.map((session) => session.id)).not.toContain('other-space');
    expect(sessions[0].status).toBe('waiting_for_input');
    expect(sessions[0].type).toBe('ad-hoc');
  });

  test('get_session_detail returns parsed processing state and message summaries', async () => {
    seedSession('stuck-1', ctx.spaceId, {
      status: 'waiting_for_input',
      pendingQuestion: { toolUseId: 'q1' },
    });
    ctx.db
      .prepare(
        `INSERT INTO sdk_messages (
          id, session_id, message_type, message_subtype, sdk_message, timestamp,
          send_status, origin, is_renderable, is_terminal, parent_tool_use_id, task_id
        ) VALUES (?, ?, 'assistant', NULL, ?, ?, 'consumed', 'system', 1, 0, NULL, NULL)`
      )
      .run(
        'msg-1',
        'stuck-1',
        JSON.stringify({
          type: 'assistant',
          message: { content: [{ type: 'text', text: 'Need input' }] },
        }),
        new Date().toISOString()
      );
    const handlers = makeHandlers(ctx);

    const parsed = parseResult(await handlers.get_session_detail({ session_id: 'stuck-1' }));

    expect(parsed.success).toBe(true);
    const session = parsed.session as {
      processing_state: { status: string; pendingQuestion: { toolUseId: string } };
      last_messages: Array<{ content_summary: string }>;
    };
    expect(session.processing_state.status).toBe('waiting_for_input');
    expect(session.processing_state.pendingQuestion.toolUseId).toBe('q1');
    expect(session.last_messages[0].content_summary).toBe('Need input');
  });

  test('send_session_message resolves pending question through live session', async () => {
    seedSession('adhoc-send', ctx.spaceId, {
      status: 'waiting_for_input',
      pendingQuestion: {
        toolUseId: 'q1',
        questions: [{ options: [{ label: 'Use option A' }] }],
      },
    });
    const responses: unknown[] = [];
    const handlers = makeHandlers(ctx, {
      getRuntimeSession: () =>
        ({
          handleQuestionResponse: async (_toolUseId: string, draftResponses: unknown[]) => {
            responses.push(_toolUseId, draftResponses);
          },
        }) as never,
    });

    const parsed = parseResult(
      await handlers.send_session_message({
        session_id: 'adhoc-send',
        message: 'Use option A',
        answer_question: true,
      })
    );

    expect(parsed.success).toBe(true);
    expect(parsed.delivered).toBe(true);
    expect(parsed.message_id).toBe('q1');
    expect(responses).toEqual(['q1', [{ questionIndex: 0, selectedLabels: ['Use option A'] }]]);
  });

  test('send_session_message delivers normal input through SessionManager', async () => {
    seedSession('adhoc-deliver', ctx.spaceId, { status: 'idle' });
    const sent: unknown[] = [];
    const handlers = makeHandlers(ctx, {
      sessionManager: {
        getCachedSession: () => null,
        getSessionAsync: async () => ({ startQueryAndEnqueue: async () => {} }) as never,
        sendUserMessage: async (message: unknown) => {
          sent.push(message);
        },
      },
    });

    const parsed = parseResult(
      await handlers.send_session_message({ session_id: 'adhoc-deliver', message: 'Proceed' })
    );

    expect(parsed.success).toBe(true);
    expect(parsed.delivered).toBe(true);
    expect(sent).toEqual([
      {
        sessionId: 'adhoc-deliver',
        messageId: parsed.message_id,
        content: 'Proceed',
      },
    ]);
  });

  test('interrupt_session routes through live interrupt path with autonomy gate', async () => {
    seedSession('adhoc-interrupt', ctx.spaceId, { status: 'processing' });
    let interrupted = false;
    const handlers = makeHandlers(ctx, {
      getSpaceAutonomyLevel: async () => 4,
      getRuntimeSession: () =>
        ({
          handleInterrupt: async () => {
            interrupted = true;
          },
        }) as never,
    });

    const parsed = parseResult(
      await handlers.interrupt_session({ session_id: 'adhoc-interrupt', reason: 'hung' })
    );

    expect(parsed.success).toBe(true);
    expect(parsed.interrupted).toBe(true);
    expect(interrupted).toBe(true);
    const resultRows = ctx.db
      .prepare(`SELECT message_type FROM sdk_messages WHERE session_id = ?`)
      .all('adhoc-interrupt') as Array<{ message_type: string }>;
    expect(resultRows).toEqual([]);
  });

  test('interrupt_session rejects cold sessions without lazy-loading', async () => {
    seedSession('adhoc-cold-interrupt', ctx.spaceId, { status: 'processing' });
    let loaded = false;
    const handlers = makeHandlers(ctx, {
      getSpaceAutonomyLevel: async () => 4,
      sessionManager: {
        getCachedSession: () => null,
        getSessionAsync: async () => {
          loaded = true;
          return null;
        },
        sendUserMessage: async () => {},
      },
    });

    const parsed = parseResult(
      await handlers.interrupt_session({ session_id: 'adhoc-cold-interrupt', reason: 'hung' })
    );

    expect(parsed.success).toBe(false);
    expect(String(parsed.error)).toContain('requires a live cached session');
    expect(loaded).toBe(false);
  });

  test('list_sessions applies filters before SQL pagination', async () => {
    for (let i = 0; i < 3; i += 1) seedSession(`newer-adhoc-${i}`, ctx.spaceId, { status: 'idle' });
    seedSession(
      'older-worker-filtered',
      ctx.spaceId,
      { status: 'idle' },
      { taskId: 'task-filtered' }
    );
    const handlers = makeHandlers(ctx);

    const parsed = parseResult(await handlers.list_sessions({ type: 'worker', limit: 1 }));

    expect(parsed.success).toBe(true);
    expect(parsed.sessions).toEqual([
      expect.objectContaining({ id: 'older-worker-filtered', type: 'worker' }),
    ]);
  });

  test('list_sessions treats rate-limit cooldown as active', async () => {
    seedSession('cooldown-session', ctx.spaceId, { status: 'rate_limit_cooldown' });
    const handlers = makeHandlers(ctx);

    const active = parseResult(await handlers.list_sessions({ status: 'active' }));
    const idle = parseResult(await handlers.list_sessions({ status: 'idle' }));

    expect((active.sessions as Array<{ id: string }>).map((session) => session.id)).toContain(
      'cooldown-session'
    );
    expect((idle.sessions as Array<{ id: string }>).map((session) => session.id)).not.toContain(
      'cooldown-session'
    );
  });

  test('list_sessions classifies task-bound sessions as workers after filtering', async () => {
    seedSession('newer-adhoc', ctx.spaceId, { status: 'idle' });
    seedSession('older-worker', ctx.spaceId, { status: 'idle' }, { taskId: 'task-1' });
    const handlers = makeHandlers(ctx);

    const parsed = parseResult(await handlers.list_sessions({ type: 'worker', limit: 2 }));

    expect(parsed.success).toBe(true);
    expect(parsed.sessions).toEqual([
      expect.objectContaining({ id: 'older-worker', type: 'worker' }),
    ]);
  });

  test('get_session_messages returns requested message summaries', async () => {
    seedSession('messages-session', ctx.spaceId, { status: 'idle' });
    for (const [id, text] of [
      ['msg-1', 'First'],
      ['msg-2', 'Second'],
    ]) {
      ctx.db
        .prepare(
          `INSERT INTO sdk_messages (
            id, session_id, message_type, message_subtype, sdk_message, timestamp,
            send_status, origin, is_renderable, is_terminal, parent_tool_use_id, task_id
          ) VALUES (?, 'messages-session', 'assistant', NULL, ?, ?, 'consumed', 'system', 1, 0, NULL, NULL)`
        )
        .run(
          id,
          JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text }] } }),
          new Date(id === 'msg-1' ? 1 : 2).toISOString()
        );
    }
    const handlers = makeHandlers(ctx);

    const parsed = parseResult(
      await handlers.get_session_messages({ session_id: 'messages-session', limit: 1 })
    );

    expect(parsed.success).toBe(true);
    expect(parsed.messages).toEqual([
      expect.objectContaining({ id: 'msg-2', content_summary: 'Second' }),
    ]);
  });

  test('get_session_messages excludes operational and retracted frames before limiting', async () => {
    seedSession('operational-session', ctx.spaceId, { status: 'idle' });
    const insertMessage = (
      id: string,
      messageType: string,
      messageSubtype: string | null,
      sdkMessage: Record<string, unknown>,
      timestampMs: number
    ) => {
      ctx.db
        .prepare(
          `INSERT INTO sdk_messages (
            id, session_id, message_type, message_subtype, sdk_message, timestamp,
            send_status, origin, is_renderable, is_terminal, parent_tool_use_id, task_id,
            sdk_uuid, replacement_metadata_normalized
          ) VALUES (?, 'operational-session', ?, ?, ?, ?, 'consumed', 'system', 1, 0, NULL, NULL, ?, 1)`
        )
        .run(
          id,
          messageType,
          messageSubtype,
          JSON.stringify(sdkMessage),
          new Date(timestampMs).toISOString(),
          typeof sdkMessage.uuid === 'string' && sdkMessage.uuid.length > 0 ? sdkMessage.uuid : null
        );
    };

    insertMessage(
      'msg-visible',
      'assistant',
      null,
      {
        type: 'assistant',
        uuid: 'visible-uuid',
        message: { content: [{ type: 'text', text: 'Visible' }] },
      },
      1
    );
    insertMessage(
      'msg-retracted',
      'assistant',
      null,
      {
        type: 'assistant',
        uuid: 'retracted-uuid',
        message: { content: [{ type: 'text', text: 'Retracted' }] },
      },
      2
    );
    ctx.db
      .prepare(`UPDATE sdk_messages SET sdk_message = ? WHERE id = ?`)
      .run('{not-json', 'msg-retracted');
    insertMessage(
      'fallback-notice',
      'system',
      'model_refusal_fallback',
      {
        type: 'system',
        subtype: 'model_refusal_fallback',
        retracted_message_uuids: ['retracted-uuid'],
      },
      3
    );
    insertMessage(
      'msg-superseded',
      'assistant',
      null,
      {
        type: 'assistant',
        uuid: 'superseded-uuid',
        message: { content: [{ type: 'text', text: 'Superseded' }] },
      },
      4
    );
    insertMessage(
      'msg-replacement',
      'assistant',
      null,
      {
        type: 'assistant',
        uuid: 'replacement-uuid',
        supersedes: ['superseded-uuid'],
        message: { content: [{ type: 'text', text: 'Replacement' }] },
      },
      5
    );
    ctx.db
      .prepare(
        `INSERT INTO sdk_message_replacements (
           source_message_id, session_id, target_uuid, kind
         ) VALUES
           ('fallback-notice', 'operational-session', 'retracted-uuid', 'retracted'),
           ('msg-replacement', 'operational-session', 'superseded-uuid', 'superseded')`
      )
      .run();
    for (const [id, subtype, timestampMs] of [
      ['msg-thinking', 'thinking_tokens', 6],
      ['msg-state', 'session_state_changed', 7],
      ['msg-commands', 'commands_changed', 8],
    ] as const) {
      insertMessage(id, 'system', subtype, { type: 'system', subtype }, timestampMs);
    }
    const handlers = makeHandlers(ctx);

    const parsed = parseResult(
      await handlers.get_session_messages({ session_id: 'operational-session', limit: 2 })
    );

    expect(parsed.success).toBe(true);
    expect(parsed.messages).toEqual([
      expect.objectContaining({ id: 'msg-replacement', content_summary: 'Replacement' }),
      expect.objectContaining({ id: 'fallback-notice' }),
    ]);
  });

  test('update_session_state rejects cached ad-hoc live sessions', async () => {
    seedSession('adhoc-live-update', ctx.spaceId, { status: 'processing' });
    const handlers = makeHandlers(ctx, {
      getSpaceAutonomyLevel: async () => 4,
      sessionManager: {
        getCachedSession: () => ({ getProcessingState: () => ({ status: 'processing' }) }) as never,
        getSessionAsync: async () => null,
        sendUserMessage: async () => {},
      },
    });

    const parsed = parseResult(
      await handlers.update_session_state({
        session_id: 'adhoc-live-update',
        processing_state: 'idle',
      })
    );

    expect(parsed.success).toBe(false);
    expect(String(parsed.error)).toContain('cannot mutate live sessions');
  });

  test('update_session_state does not lazy-load cold sessions', async () => {
    seedSession('adhoc-cold-update', ctx.spaceId, { status: 'processing' });
    let loaded = false;
    const handlers = makeHandlers(ctx, {
      getSpaceAutonomyLevel: async () => 4,
      sessionManager: {
        getCachedSession: () => null,
        getSessionAsync: async () => {
          loaded = true;
          return null;
        },
        sendUserMessage: async () => {},
      },
    });

    const parsed = parseResult(
      await handlers.update_session_state({
        session_id: 'adhoc-cold-update',
        processing_state: 'idle',
      })
    );

    expect(parsed.success).toBe(true);
    expect(loaded).toBe(false);
  });

  test('send_session_message cross-session requires autonomy', async () => {
    seedSession('other-member', ctx.spaceId, { status: 'idle' });
    const handlers = makeHandlers(ctx, {
      mySessionId: 'caller-session',
      getSpaceAutonomyLevel: async () => 3,
      getRuntimeSession: () => ({ startQueryAndEnqueue: async () => {} }) as never,
    });

    const parsed = parseResult(
      await handlers.send_session_message({ session_id: 'other-member', message: 'Proceed' })
    );

    expect(parsed.success).toBe(false);
    expect(String(parsed.error)).toContain('space autonomy level 3 < required level 4');
  });

  test('send_session_message cross-session gates named non-coordinator agents', async () => {
    seedSession('other-member-named-agent', ctx.spaceId, { status: 'idle' });
    const handlers = makeHandlers(ctx, {
      myAgentName: 'scout',
      mySessionId: 'caller-session',
      getSpaceAutonomyLevel: async () => 3,
      getRuntimeSession: () => ({ startQueryAndEnqueue: async () => {} }) as never,
    });

    const parsed = parseResult(
      await handlers.send_session_message({
        session_id: 'other-member-named-agent',
        message: 'Proceed',
      })
    );

    expect(parsed.success).toBe(false);
    expect(String(parsed.error)).toContain('space autonomy level 3 < required level 4');
  });

  test('send_session_message coordinator can send cross-session without autonomy gate', async () => {
    seedSession('other-member-coordinator', ctx.spaceId, { status: 'idle' });
    const handlers = makeHandlers(ctx, {
      myAgentName: 'space-agent',
      mySessionId: 'caller-session',
      getSpaceAutonomyLevel: async () => 3,
      getRuntimeSession: () => ({ startQueryAndEnqueue: async () => {} }) as never,
    });

    const parsed = parseResult(
      await handlers.send_session_message({
        session_id: 'other-member-coordinator',
        message: 'Proceed',
      })
    );

    expect(parsed.success).toBe(true);
  });

  test('get_session_messages cursor handles duplicate timestamps', async () => {
    seedSession('cursor-session', ctx.spaceId, { status: 'idle' });
    for (const id of ['msg-c', 'msg-b', 'msg-a']) {
      ctx.db
        .prepare(
          `INSERT INTO sdk_messages (
            id, session_id, message_type, message_subtype, sdk_message, timestamp,
            send_status, origin, is_renderable, is_terminal, parent_tool_use_id, task_id
          ) VALUES (?, 'cursor-session', 'assistant', NULL, ?, ?, 'consumed', 'system', 1, 0, NULL, NULL)`
        )
        .run(
          id,
          JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: id }] } }),
          new Date(1).toISOString()
        );
    }
    const handlers = makeHandlers(ctx);

    const firstPage = parseResult(
      await handlers.get_session_messages({ session_id: 'cursor-session', limit: 1 })
    );
    const cursor = (firstPage.messages as Array<{ cursor: string }>)[0].cursor;
    const secondPage = parseResult(
      await handlers.get_session_messages({
        session_id: 'cursor-session',
        limit: 1,
        before: cursor,
      })
    );

    expect((firstPage.messages as Array<{ id: string }>)[0].id).toBe('msg-c');
    expect((secondPage.messages as Array<{ id: string }>)[0].id).toBe('msg-b');
  });

  test('update_session_state updates state and clears pending question', async () => {
    seedSession('adhoc-update', ctx.spaceId, {
      status: 'waiting_for_input',
      pendingQuestion: { toolUseId: 'q1' },
    });
    const handlers = makeHandlers(ctx, { getSpaceAutonomyLevel: async () => 4 });

    const parsed = parseResult(
      await handlers.update_session_state({
        session_id: 'adhoc-update',
        processing_state: 'idle',
        clear_pending_question: true,
      })
    );

    expect(parsed.success).toBe(true);
    expect(parsed.updated).toBe(true);
    expect(parsed.new_state).toEqual({ status: 'idle' });
  });

  test('update_session_state rejects waiting state without pending question', async () => {
    seedSession('adhoc-waiting-without-question', ctx.spaceId, { status: 'idle' });
    const handlers = makeHandlers(ctx, { getSpaceAutonomyLevel: async () => 4 });

    const parsed = parseResult(
      await handlers.update_session_state({
        session_id: 'adhoc-waiting-without-question',
        processing_state: 'waiting_for_input',
      })
    );

    expect(parsed.success).toBe(false);
    expect(String(parsed.error)).toContain('without an existing pending question');
  });

  test('update_session_state rejects when autonomy level is too low', async () => {
    seedSession('adhoc-low-autonomy', ctx.spaceId, { status: 'processing' });
    const handlers = makeHandlers(ctx, { getSpaceAutonomyLevel: async () => 3 });

    const parsed = parseResult(
      await handlers.update_session_state({
        session_id: 'adhoc-low-autonomy',
        processing_state: 'idle',
      })
    );

    expect(parsed.success).toBe(false);
    expect(String(parsed.error)).toContain('space autonomy level 3 < required level 4');
  });
});

// ---------------------------------------------------------------------------
// goal tools
// ---------------------------------------------------------------------------

describe('createSpaceAgentToolHandlers — long-horizon agent tools', () => {
  let ctx: TestCtx;
  let modelsCacheSnapshot: Map<string, ModelInfo[]>;
  beforeEach(() => {
    modelsCacheSnapshot = getModelsCache();
    ctx = makeCtx();
  });
  afterEach(() => {
    setModelsCache(modelsCacheSnapshot);
    ctx.db.close();
  });

  test('creates, updates, pauses, archives, and templates agents', async () => {
    const handlers = makeHandlers(ctx);

    const created = JSON.parse(
      (
        await handlers.create_agent({
          name: 'Scout',
          description: 'Tracks quality signals',
          tools: ['Read', 'Grep'],
        })
      ).content[0].text
    );
    expect(created.success).toBe(true);
    expect(created.agent.status).toBe('active');
    expect(created.agent.handle).toBe('scout');
    expect(created.agent.toolPermissions).toEqual({ tools: ['Read', 'Grep'] });

    const workerHandleCollision = JSON.parse(
      (await handlers.create_agent({ name: 'Coder' })).content[0].text
    );
    expect(workerHandleCollision.success).toBe(true);
    expect(workerHandleCollision.agent.handle).toBe('coder-2');

    const slugged = JSON.parse(
      (await handlers.create_agent({ name: 'QA/Review:@Lead' })).content[0].text
    );
    expect(slugged.success).toBe(true);
    expect(slugged.agent.handle).toBe('qa-review-lead');

    const blankCreateName = JSON.parse(
      (await handlers.create_agent({ name: '  ' })).content[0].text
    );
    expect(blankCreateName.success).toBe(false);
    expect(blankCreateName.error).toBe('Agent name cannot be empty');

    const updated = JSON.parse(
      (
        await handlers.update_agent({
          agent_id: created.agent.id,
          description: 'Tracks product-quality signals',
          thinking_level: 'think8k',
        })
      ).content[0].text
    );
    expect(updated.success).toBe(true);
    expect(updated.agent.thinkingLevel).toBe('think8k');
    expect(updated.agent.instructions).toBe('Tracks product-quality signals');

    const cleared = JSON.parse(
      (
        await handlers.update_agent({
          agent_id: created.agent.id,
          custom_prompt: null,
          setting_sources: null,
        })
      ).content[0].text
    );
    expect(cleared.success).toBe(true);
    expect(cleared.agent.instructions).toBe('');
    expect(cleared.agent.settingSources).toBeNull();

    const blankUpdateName = JSON.parse(
      (
        await handlers.update_agent({
          agent_id: created.agent.id,
          name: '  ',
        })
      ).content[0].text
    );
    expect(blankUpdateName.success).toBe(false);
    expect(blankUpdateName.error).toBe('Agent name cannot be empty');

    const paused = JSON.parse(
      (await handlers.pause_agent({ agent_id: created.agent.id })).content[0].text
    );
    expect(paused.agent.status).toBe('paused');
    const archived = JSON.parse(
      (await handlers.archive_agent({ agent_id: created.agent.id })).content[0].text
    );
    expect(archived.agent.status).toBe('archived');

    const templated = JSON.parse(
      (
        await handlers.create_agent_from_template({
          template_name: 'Reviewer',
          name: 'Reviewer Copy',
        })
      ).content[0].text
    );
    expect(templated.success).toBe(true);
    expect(templated.agent.templateKey).toBe('Reviewer');
    expect(templated.agent.handle).toBe('reviewer-copy');
    const templatedWorkerHandleCollision = JSON.parse(
      (
        await handlers.create_agent_from_template({
          template_name: 'Coder',
          name: 'Coder',
        })
      ).content[0].text
    );
    expect(templatedWorkerHandleCollision.success).toBe(true);
    expect(templatedWorkerHandleCollision.agent.handle).toBe('coder-3');
    const duplicateTemplate = JSON.parse(
      (
        await handlers.create_agent_from_template({
          template_name: 'Reviewer',
          name: 'Reviewer Copy',
        })
      ).content[0].text
    );
    expect(duplicateTemplate.success).toBe(true);
    expect(duplicateTemplate.agent.handle).toBe('reviewer-copy-2');

    const blankTemplateName = JSON.parse(
      (
        await handlers.create_agent_from_template({
          template_name: 'Reviewer',
          name: '  ',
        })
      ).content[0].text
    );
    expect(blankTemplateName.success).toBe(false);
    expect(blankTemplateName.error).toBe('Agent name cannot be empty');

    const listed = JSON.parse((await handlers.list_agents({ status: 'archived' })).content[0].text);
    expect(listed.agents.map((agent: { id: string }) => agent.id)).toContain(created.agent.id);
  });

  test('update_agent clears the session provider when the override is explicitly cleared (P2)', async () => {
    const clearLongTermAgentSessionProvider = mock(async () => {});
    const handlers = makeHandlers(ctx, { clearLongTermAgentSessionProvider });

    const created = JSON.parse(
      (await handlers.create_agent({ name: 'Scout', provider: 'openrouter' })).content[0].text
    );
    expect(created.success).toBe(true);

    // provider: null is an explicit clear (vs absent = don't touch). The
    // session's persisted provider must be dropped or wake-time retention
    // would restore the stale override and make the clear a no-op.
    const cleared = JSON.parse(
      (await handlers.update_agent({ agent_id: created.agent.id, provider: null })).content[0].text
    );
    expect(cleared.success).toBe(true);
    expect(clearLongTermAgentSessionProvider).toHaveBeenCalledWith(ctx.spaceId, created.agent.id);

    clearLongTermAgentSessionProvider.mockClear();
    await handlers.update_agent({ agent_id: created.agent.id, provider: 'kimi' });
    await handlers.update_agent({ agent_id: created.agent.id, description: 'untouched' });
    expect(clearLongTermAgentSessionProvider).not.toHaveBeenCalled();
  });

  test('rejects invalid model overrides for MCP-created long-horizon agents', async () => {
    setModelsCache(
      new Map([
        [
          'global',
          [
            {
              id: 'sonnet',
              name: 'Claude Sonnet',
              alias: 'default',
              provider: 'anthropic',
              family: 'sonnet',
              contextWindow: 200000,
              description: 'Best balance of speed and intelligence',
              releaseDate: '2025-01-01',
              available: true,
            },
          ],
        ],
      ])
    );
    const handlers = makeHandlers(ctx);

    const invalidCreate = JSON.parse(
      (
        await handlers.create_agent({
          name: 'Bad Model',
          model: 'not-a-model',
          provider: 'anthropic',
        })
      ).content[0].text
    );
    expect(invalidCreate).toEqual({
      success: false,
      error: 'Unrecognized model "not-a-model" for provider "anthropic"',
    });

    const invalidTemplate = JSON.parse(
      (
        await handlers.create_agent_from_template({
          template_name: 'Reviewer',
          model: 'not-a-model',
        })
      ).content[0].text
    );
    expect(invalidTemplate).toEqual({
      success: false,
      error: 'Unrecognized model: "not-a-model"',
    });

    const created = JSON.parse(
      (await handlers.create_agent({ name: 'Valid Model' })).content[0].text
    );
    const invalidUpdate = JSON.parse(
      (
        await handlers.update_agent({
          agent_id: created.agent.id,
          model: 'not-a-model',
          provider: 'anthropic',
        })
      ).content[0].text
    );
    expect(invalidUpdate).toEqual({
      success: false,
      error: 'Unrecognized model "not-a-model" for provider "anthropic"',
    });

    const providerOnlyTarget = JSON.parse(
      (
        await handlers.create_agent({
          name: 'Provider Switch',
          model: 'sonnet',
          provider: 'anthropic',
        })
      ).content[0].text
    );
    const invalidProviderOnlyUpdate = JSON.parse(
      (
        await handlers.update_agent({
          agent_id: providerOnlyTarget.agent.id,
          provider: 'openrouter',
        })
      ).content[0].text
    );
    expect(invalidProviderOnlyUpdate).toEqual({
      success: false,
      error: 'Unrecognized model "sonnet" for provider "openrouter"',
    });
  });

  test('emits long-horizon agent events after MCP create and update', async () => {
    const publish = mock(async () => {});
    const handlers = makeHandlers(ctx, {
      internalEventBus: {
        publish,
      } as unknown as Parameters<typeof createSpaceAgentToolHandlers>[0]['internalEventBus'],
      mySessionId: 'mcp-session',
    });

    const created = JSON.parse((await handlers.create_agent({ name: 'Notifier' })).content[0].text);
    expect(created.success).toBe(true);
    expect(publish).toHaveBeenCalledWith('spaceLongHorizonAgent.created', {
      sessionId: 'mcp-session',
      spaceId: ctx.spaceId,
      agent: expect.objectContaining({ id: created.agent.id, displayName: 'Notifier' }),
    });

    const updated = JSON.parse(
      (
        await handlers.update_agent({
          agent_id: created.agent.id,
          name: 'Notifier Renamed',
        })
      ).content[0].text
    );
    expect(updated.success).toBe(true);
    expect(publish).toHaveBeenCalledWith('spaceLongHorizonAgent.updated', {
      sessionId: 'mcp-session',
      spaceId: ctx.spaceId,
      agent: expect.objectContaining({ id: created.agent.id, displayName: 'Notifier Renamed' }),
    });
  });

  test('manages agent assignments, reminders, and event subscriptions', async () => {
    const handlers = makeHandlers(ctx);
    const agent = JSON.parse(
      (await handlers.create_agent({ name: 'Manager' })).content[0].text
    ).agent;
    const goal = JSON.parse(
      (await handlers.create_goal({ title: 'Goal', description: 'Desc' })).content[0].text
    ).goal;
    const scope = JSON.parse(
      (
        await handlers.create_forge_scope({
          kind: 'custom',
          name: 'Scope',
          objective: 'Track evidence',
        })
      ).content[0].text
    ).scope;

    expect(
      JSON.parse(
        (await handlers.assign_agent_to_goal({ agent_id: agent.id, goal_id: goal.id })).content[0]
          .text
      ).success
    ).toBe(true);
    expect(
      JSON.parse(
        (await handlers.assign_agent_to_forge_scope({ agent_id: agent.id, scope_id: scope.id }))
          .content[0].text
      ).success
    ).toBe(true);

    const reminder = JSON.parse(
      (
        await handlers.create_agent_reminder({
          agent_id: agent.id,
          message: 'Check progress',
          remind_at: Date.now() + 60_000,
        })
      ).content[0].text
    );
    expect(reminder.success).toBe(true);
    expect(reminder.reminder.message).toBe('Check progress');
    expect(reminder.reminder.remind_at).toBe(reminder.reminder.runAt);
    await handlers.create_agent_reminder({
      agent_id: agent.id,
      message: 'Check earlier',
      remind_at: reminder.reminder.remind_at - 1_000,
    });
    const reminders = JSON.parse(
      (await handlers.list_agent_reminders({ agent_id: agent.id, status: 'active' })).content[0]
        .text
    );
    expect(reminders.reminders.map((item: { message: string }) => item.message)).toEqual([
      'Check earlier',
      'Check progress',
    ]);
    expect(reminders.reminders.map((item: { remind_at: number }) => item.remind_at)).toEqual(
      reminders.reminders.map((item: { runAt: number }) => item.runAt)
    );
    ctx.db
      .prepare(`UPDATE space_long_horizon_agent_reminders SET status = 'fired' WHERE id = ?`)
      .run(reminder.reminder.id);
    const completedReminders = JSON.parse(
      (await handlers.list_agent_reminders({ agent_id: agent.id, status: 'done' })).content[0].text
    );
    expect(completedReminders.reminders).toHaveLength(1);
    expect(completedReminders.reminders[0].status).toBe('done');

    const longHorizonAgent = ctx.longHorizonAgentRepo.create({
      id: 'lh-tools-agent',
      spaceId: ctx.spaceId,
      handle: '@tools-agent',
      displayName: 'Tools Agent',
    });
    expect(
      JSON.parse(
        (
          await handlers.subscribe_agent_event({
            agent_id: longHorizonAgent.id,
            topic_pattern: 'github/*/*/pull_request/*',
            label: 'PR activity',
          })
        ).content[0].text
      ).success
    ).toBe(true);
    const subscriptions = JSON.parse(
      (await handlers.list_agent_event_subscriptions({ agent_id: longHorizonAgent.id })).content[0]
        .text
    );
    expect(subscriptions.subscriptions[0].topic).toBe('github/*/*/pull_request/*');
    expect(subscriptions.subscriptions[0].filter).toEqual({ label: 'PR activity' });

    const relabeled = JSON.parse(
      (
        await handlers.subscribe_agent_event({
          agent_id: longHorizonAgent.id,
          topic_pattern: 'github/*/*/pull_request/*',
          label: 'PR triage',
        })
      ).content[0].text
    );
    expect(relabeled.success).toBe(true);
    const afterRelabel = JSON.parse(
      (await handlers.list_agent_event_subscriptions({ agent_id: longHorizonAgent.id })).content[0]
        .text
    );
    expect(afterRelabel.subscriptions).toHaveLength(1);
    expect(afterRelabel.subscriptions[0].filter).toEqual({ label: 'PR triage' });

    const staleBeforePause = ctx.runtime['topicTrie'].lookup(
      'github/lsm/neokai/pull_request/opened'
    );
    expect(staleBeforePause.some((target) => target.kind === 'long_horizon_agent')).toBe(true);
    const pausedSubscribedAgent = JSON.parse(
      (await handlers.pause_agent({ agent_id: longHorizonAgent.id })).content[0].text
    );
    expect(pausedSubscribedAgent.success).toBe(true);
    const staleAfterPause = ctx.runtime['topicTrie'].lookup(
      'github/lsm/neokai/pull_request/opened'
    );
    expect(staleAfterPause.some((target) => target.kind === 'long_horizon_agent')).toBe(false);

    const removed = JSON.parse(
      (
        await handlers.unsubscribe_agent_event({
          agent_id: longHorizonAgent.id,
          topic_pattern: 'github/*/*/pull_request/*',
        })
      ).content[0].text
    );
    expect(removed.success).toBe(true);
    const afterUnsubscribe = JSON.parse(
      (await handlers.list_agent_event_subscriptions({ agent_id: longHorizonAgent.id })).content[0]
        .text
    );
    expect(afterUnsubscribe.subscriptions).toEqual([]);

    const workerOnlyAgent = await ctx.agentManager.create({
      spaceId: ctx.spaceId,
      name: 'Worker Only',
    });
    expect(workerOnlyAgent.ok).toBe(true);
    if (!workerOnlyAgent.ok) throw new Error(workerOnlyAgent.error);

    const listedWorkerOnly = JSON.parse(
      (await handlers.list_agent_event_subscriptions({ agent_id: workerOnlyAgent.value.id }))
        .content[0].text
    );
    expect(listedWorkerOnly).toEqual({ success: true, subscriptions: [] });
    expect(ctx.longHorizonAgentRepo.getById(workerOnlyAgent.value.id)).toBeNull();
    const unsubscribedWorkerOnly = JSON.parse(
      (
        await handlers.unsubscribe_agent_event({
          agent_id: workerOnlyAgent.value.id,
          topic_pattern: 'github/*/*/pull_request/*',
        })
      ).content[0].text
    );
    expect(unsubscribedWorkerOnly.success).toBe(true);
    expect(ctx.longHorizonAgentRepo.getById(workerOnlyAgent.value.id)).toBeNull();
    const subscribedWorkerOnly = JSON.parse(
      (
        await handlers.subscribe_agent_event({
          agent_id: workerOnlyAgent.value.id,
          topic_pattern: 'github/*/*/pull_request/*',
        })
      ).content[0].text
    );
    expect(subscribedWorkerOnly.success).toBe(false);
    expect(subscribedWorkerOnly.error).toBe('Expected long-horizon agent id, got worker agent id.');
    expect(ctx.longHorizonAgentRepo.getById(workerOnlyAgent.value.id)).toBeNull();

    const sharedLongHorizonAgent = ctx.longHorizonAgentRepo.create({
      id: workerOnlyAgent.value.id,
      spaceId: ctx.spaceId,
      handle: `${workerOnlyAgent.value.handle}-lh`,
      displayName: 'Shared Legacy Agent',
      instructions: 'Independent prompt',
      toolPermissions: { tools: ['Read'] },
    });
    const subscribedShared = JSON.parse(
      (
        await handlers.subscribe_agent_event({
          agent_id: workerOnlyAgent.value.id,
          topic_pattern: 'github/*/*/pull_request/*',
        })
      ).content[0].text
    );
    expect(subscribedShared.success).toBe(true);
    const updatedWorker = await ctx.agentManager.update(workerOnlyAgent.value.id, {
      status: 'paused',
      customPrompt: 'Worker-only prompt update',
      tools: ['Read', 'Edit'],
    });
    expect(updatedWorker.ok).toBe(true);
    expect(ctx.longHorizonAgentRepo.getById(sharedLongHorizonAgent.id)).toEqual(
      expect.objectContaining({
        status: 'active',
        instructions: 'Independent prompt',
        toolPermissions: { tools: ['Read'] },
      })
    );
    expect(
      JSON.parse(
        (await handlers.unassign_agent_from_goal({ agent_id: agent.id, goal_id: goal.id }))
          .content[0].text
      ).success
    ).toBe(true);
    expect(
      JSON.parse(
        (await handlers.unassign_agent_from_forge_scope({ agent_id: agent.id, scope_id: scope.id }))
          .content[0].text
      ).success
    ).toBe(true);
  });

  test('returns errors for missing and cross-space agents', async () => {
    const handlers = makeHandlers(ctx);
    const missingId = 'missing-agent';

    const missing = JSON.parse((await handlers.get_agent({ agent_id: missingId })).content[0].text);
    expect(missing.success).toBe(false);
    expect(missing.error).toBe(`Long-horizon agent not found: ${missingId}`);

    const otherSpaceId = 'other-space';
    seedSpaceRow(ctx.db, otherSpaceId);
    seedAgentRow(ctx.db, 'agent-other-space', otherSpaceId, 'Other Space Agent');

    const crossSpace = JSON.parse(
      (
        await handlers.update_agent({
          agent_id: 'agent-other-space',
          description: 'Should not update',
        })
      ).content[0].text
    );
    expect(crossSpace.success).toBe(false);
    expect(crossSpace.error).toBe('Long-horizon agent not found: agent-other-space');

    const missingReminder = JSON.parse(
      (
        await handlers.create_agent_reminder({
          agent_id: missingId,
          message: 'No target',
          remind_at: Date.now(),
        })
      ).content[0].text
    );
    expect(missingReminder.success).toBe(false);
    expect(missingReminder.error).toBe(`Long-horizon agent not found: ${missingId}`);
  });

  test('rejects worker-only ids on long-horizon goal, scope, reminder, and get tools', async () => {
    const handlers = makeHandlers(ctx);
    const workerOnly = await ctx.agentManager.create({
      spaceId: ctx.spaceId,
      name: 'Worker Only',
    });
    expect(workerOnly.ok).toBe(true);
    if (!workerOnly.ok) throw new Error(workerOnly.error);
    const workerId = workerOnly.value.id;

    const goal = ctx.goalService.createGoal({
      spaceId: ctx.spaceId,
      title: 'Test Goal',
    });
    const scope = ctx.evolutionScopeService.createScope({
      spaceId: ctx.spaceId,
      kind: 'custom',
      name: 'Test Scope',
      objective: 'Track evidence',
    });

    const expectedError = 'Expected long-horizon agent id, got worker agent id.';

    const getResult = JSON.parse(
      (await handlers.get_agent({ agent_id: workerId })).content[0].text
    );
    expect(getResult.success).toBe(false);
    expect(getResult.error).toBe(expectedError);

    const assignGoal = JSON.parse(
      (await handlers.assign_agent_to_goal({ agent_id: workerId, goal_id: goal.id })).content[0]
        .text
    );
    expect(assignGoal.success).toBe(false);
    expect(assignGoal.error).toBe(expectedError);

    const assignScope = JSON.parse(
      (await handlers.assign_agent_to_forge_scope({ agent_id: workerId, scope_id: scope.id }))
        .content[0].text
    );
    expect(assignScope.success).toBe(false);
    expect(assignScope.error).toBe(expectedError);

    const reminder = JSON.parse(
      (
        await handlers.create_agent_reminder({
          agent_id: workerId,
          message: 'No target',
          remind_at: Date.now(),
        })
      ).content[0].text
    );
    expect(reminder.success).toBe(false);
    expect(reminder.error).toBe(expectedError);

    const listReminders = JSON.parse(
      (await handlers.list_agent_reminders({ agent_id: workerId })).content[0].text
    );
    expect(listReminders.success).toBe(false);
    expect(listReminders.error).toBe(expectedError);
  });

  test('returns errors from database-backed tools when database is not configured', async () => {
    const handlers = createSpaceAgentToolHandlers({
      spaceId: ctx.spaceId,
      runtime: ctx.runtime,
      workflowManager: ctx.workflowManager,
      taskRepo: ctx.taskRepo,
      workflowRunRepo: ctx.workflowRunRepo,
      taskManager: ctx.taskManager,
      spaceAgentManager: ctx.agentManager,
      nodeExecutionRepo: ctx.nodeExecutionRepo,
      spaceManager: ctx.spaceManager,
      goalService: ctx.goalService,
      evolutionScopeService: ctx.evolutionScopeService,
      evolutionEpisodeService: ctx.evolutionEpisodeService,
    });

    const goal = JSON.parse(
      (await handlers.create_goal({ title: 'No DB Goal', description: 'Desc' })).content[0].text
    ).goal;

    const assignment = JSON.parse(
      (await handlers.assign_agent_to_goal({ agent_id: 'no-db-agent', goal_id: goal.id }))
        .content[0].text
    );
    expect(assignment.success).toBe(false);
    expect(assignment.error).toBe('Long-horizon agent management not available');

    const reminder = JSON.parse(
      (
        await handlers.create_agent_reminder({
          agent_id: 'no-db-agent',
          message: 'No DB',
          remind_at: Date.now(),
        })
      ).content[0].text
    );
    expect(reminder.success).toBe(false);
    expect(reminder.error).toBe('Long-horizon agent management not available');

    const subscription = JSON.parse(
      (
        await handlers.subscribe_agent_event({
          agent_id: 'no-db-agent',
          topic_pattern: 'github/*',
        })
      ).content[0].text
    );
    expect(subscription.success).toBe(false);
    expect(subscription.error).toBe('Long-horizon agent management not available');
  });

  test('creates a long-horizon agent from a long-horizon template and seeds subscriptions/reminders', async () => {
    const handlers = makeHandlers(ctx);
    const result = JSON.parse(
      (await handlers.create_agent_from_template({ template_name: 'marketing.default' })).content[0]
        .text
    );
    expect(result.success).toBe(true);
    const agent = result.agent;
    expect(agent.status).toBe('active');
    expect(agent.templateKey).toBe('marketing.default');
    expect(agent.handle).toBe('marketing');
    expect(agent.autonomyLevel).toBe(2);

    const template = getLongHorizonAgentTemplate('marketing.default');
    expect(agent.instructions).toBe(template?.instructions);
    expect(agent.toolPermissions).toEqual(template?.toolPermissions);

    // The space subscription uses a registered source and is seeded live.
    expect(result.seeded_subscriptions.map((s: { topic: string }) => s.topic)).toEqual([
      'goal.done',
    ]);
    const subscriptions = JSON.parse(
      (await handlers.list_agent_event_subscriptions({ agent_id: agent.id })).content[0].text
    );
    expect(subscriptions.subscriptions.map((s: { topic: string }) => s.topic)).toEqual([
      'goal.done',
    ]);
    const live = ctx.runtime['topicTrie'].lookup('space/goal.done');
    expect(
      live.some(
        (target: { kind: string; agentId?: string }) =>
          target.kind === 'long_horizon_agent' && target.agentId === agent.id
      )
    ).toBe(true);

    // The github/release.published suggestion is skipped (only pull_request is
    // wired today) — not fatal; the create still succeeds and reports it.
    expect(result.skipped_subscriptions).toEqual([
      expect.objectContaining({ source: 'github', topic: 'release.published' }),
    ]);
    expect(result.skipped_subscriptions[0].reason).toContain('release');

    // The marketing reminder default is seeded as an active cron reminder.
    expect(result.seeded_reminders).toEqual([{ title: 'Review marketing opportunities' }]);
    expect(result.skipped_reminders).toEqual([]);
    const reminders = JSON.parse(
      (await handlers.list_agent_reminders({ agent_id: agent.id, status: 'active' })).content[0]
        .text
    );
    expect(reminders.reminders).toHaveLength(1);
    expect(reminders.reminders[0].triggerType).toBe('cron');
    expect(reminders.reminders[0].cronExpression).toBe('0 15 * * 1');
    // The first cron occurrence is seeded as nextRunAt (remind_at) so the
    // reminder is due-eligible immediately, not inert until a daemon restart.
    expect(reminders.reminders[0].remind_at).toBeGreaterThan(Date.now());
  });

  test('reminder seeding is best-effort: a thrown insert does not abort the create', async () => {
    const handlers = makeHandlers(ctx);
    const repo = ctx.longHorizonAgentRepo;
    const originalCreateReminder = repo.createReminder;
    // Force every reminder insert to throw — simulates a store failure on the
    // first (and only) reminder of the template.
    repo.createReminder = () => {
      throw new Error('reminder store down');
    };
    try {
      const result = JSON.parse(
        (await handlers.create_agent_from_template({ template_name: 'marketing.default' }))
          .content[0].text
      );
      // The create still succeeds — the agent row and subscriptions are committed.
      expect(result.success).toBe(true);
      expect(result.agent.templateKey).toBe('marketing.default');
      expect(result.seeded_subscriptions.map((s: { topic: string }) => s.topic)).toEqual([
        'goal.done',
      ]);
      // The failed reminder is reported, not raised.
      expect(result.seeded_reminders).toEqual([]);
      expect(result.skipped_reminders).toEqual([
        { title: 'Review marketing opportunities', reason: 'reminder store down' },
      ]);
    } finally {
      repo.createReminder = originalCreateReminder;
    }
  });

  test('subscription seeding is best-effort: a thrown insert does not abort the create', async () => {
    const handlers = makeHandlers(ctx);
    const repo = ctx.longHorizonAgentRepo;
    const originalUpsertSubscription = repo.upsertSubscription;
    // Force every subscription insert to throw — both marketing suggestions
    // (github/release.published, space/goal.done) hit this path.
    repo.upsertSubscription = () => {
      throw new Error('subscription store down');
    };
    try {
      const result = JSON.parse(
        (await handlers.create_agent_from_template({ template_name: 'marketing.default' }))
          .content[0].text
      );
      // The create still succeeds and the agent row + reminder are committed.
      expect(result.success).toBe(true);
      expect(result.agent.templateKey).toBe('marketing.default');
      expect(result.seeded_subscriptions).toEqual([]);
      const skippedSources = result.skipped_subscriptions.map((s: { source: string }) => s.source);
      expect([...skippedSources].sort()).toEqual(['github', 'space']);
      for (const skipped of result.skipped_subscriptions) {
        expect(skipped.reason).toBe('subscription store down');
      }
      // The reminder still seeds despite the subscription failures.
      expect(result.seeded_reminders).toEqual([{ title: 'Review marketing opportunities' }]);
      const reminders = JSON.parse(
        (await handlers.list_agent_reminders({ agent_id: result.agent.id, status: 'active' }))
          .content[0].text
      );
      expect(reminders.reminders).toHaveLength(1);
    } finally {
      repo.upsertSubscription = originalUpsertSubscription;
    }
  });

  test('validateTemplateReminder skips invalid or missing cron expressions', () => {
    const base = {
      title: 'Review plan',
      body: '...',
      triggerType: 'cron' as const,
      timezone: 'UTC',
    };
    expect(validateTemplateReminder({ ...base, cronExpression: '0 15 * * 1' })).toEqual({
      ok: true,
    });
    expect(validateTemplateReminder({ ...base, cronExpression: 'not a cron' })).toEqual({
      ok: false,
      reason: 'invalid cron expression "not a cron"',
    });
    expect(validateTemplateReminder({ ...base, cronExpression: null })).toEqual({
      ok: false,
      reason: 'cron reminder is missing cronExpression',
    });
    // 'at' triggers carry no cron and are not cron-validated here.
    expect(
      validateTemplateReminder({ ...base, triggerType: 'at' as const, cronExpression: null })
    ).toEqual({ ok: true });
  });

  test('caps LH template autonomy at the calling agent ceiling', async () => {
    // A level-1 long-horizon caller must not mint a more-trusted child.
    const caller = ctx.longHorizonAgentRepo.create({
      spaceId: ctx.spaceId,
      handle: 'level-one-caller',
      displayName: 'Level One Caller',
      autonomyLevel: 1,
    });
    const cappedHandlers = makeHandlers(ctx, { myAgentId: caller.id });
    // marketing.default suggests level 2; caller ceiling 1 → child capped to 1.
    const capped = JSON.parse(
      (await cappedHandlers.create_agent_from_template({ template_name: 'marketing.default' }))
        .content[0].text
    );
    expect(capped.success).toBe(true);
    expect(capped.agent.templateKey).toBe('marketing.default');
    expect(capped.agent.autonomyLevel).toBe(1);

    // An uncapped caller (no myAgentId — worker-agent session / direct call)
    // keeps the template's full suggested level.
    const uncapped = JSON.parse(
      (await makeHandlers(ctx).create_agent_from_template({ template_name: 'marketing.default' }))
        .content[0].text
    );
    expect(uncapped.success).toBe(true);
    expect(uncapped.agent.autonomyLevel).toBe(2);
  });

  test('rejects the reserved coordinator singleton instead of creating a duplicate', async () => {
    const handlers = makeHandlers(ctx);
    const result = JSON.parse(
      (await handlers.create_agent_from_template({ template_name: 'coordinator.default' }))
        .content[0].text
    );
    expect(result.success).toBe(false);
    expect(result.error).toContain('reserved');
    expect(result.error).toContain('coordinator');
    // No suffixed duplicate coordinator was created.
    const agents = JSON.parse((await handlers.list_agents({})).content[0].text);
    const handles = agents.agents.map((agent: { handle: string }) => agent.handle);
    expect(handles).not.toContain('coordinator-2');
    expect(handles).not.toContain('coordinator');
  });

  test('skips unknown-source template subscriptions gracefully instead of failing', async () => {
    const handlers = makeHandlers(ctx);
    // sales.default suggests crm + calendar sources that have no extension yet.
    const result = JSON.parse(
      (await handlers.create_agent_from_template({ template_name: 'sales.default' })).content[0]
        .text
    );
    expect(result.success).toBe(true);
    expect(result.seeded_subscriptions).toEqual([]);
    const skippedSources = result.skipped_subscriptions.map((s: { source: string }) => s.source);
    expect([...skippedSources].sort()).toEqual(['calendar', 'crm']);
    for (const skipped of result.skipped_subscriptions) {
      expect(typeof skipped.reason).toBe('string');
      expect(skipped.reason.length).toBeGreaterThan(0);
    }
    // The agent is still active with the sales instructions/autonomy.
    expect(result.agent.status).toBe('active');
    expect(result.agent.templateKey).toBe('sales.default');
    expect(result.agent.handle).toBe('sales');
    expect(result.agent.autonomyLevel).toBe(2);
    expect(result.seeded_reminders).toEqual([{ title: 'Review sales follow-ups' }]);
    // No inert subscription rows were left behind.
    const stored = JSON.parse(
      (await handlers.list_agent_event_subscriptions({ agent_id: result.agent.id })).content[0].text
    );
    expect(stored.subscriptions).toEqual([]);
  });

  test('list_agent_templates exposes worker presets and long-horizon templates', async () => {
    const handlers = makeHandlers(ctx);
    const listed = JSON.parse((await handlers.list_agent_templates()).content[0].text);
    expect(listed.success).toBe(true);
    const presetNames = listed.presets.map((p: { template_name: string }) => p.template_name);
    expect(presetNames).toContain('Coder');
    expect(presetNames).toContain('Reviewer');
    const lhKeys = listed.long_horizon_templates.map(
      (t: { template_name: string }) => t.template_name
    );
    expect(lhKeys).toContain('marketing.default');
    expect(lhKeys).toContain('security-auditor.default');
    // Reserved-handle templates (coordinator is a per-space singleton that the
    // create path rejects) are excluded from the creatable catalog.
    expect(lhKeys).not.toContain('coordinator.default');
    const marketing = listed.long_horizon_templates.find(
      (t: { template_name: string }) => t.template_name === 'marketing.default'
    );
    expect(marketing.handle).toBe('marketing');
    expect(marketing.suggested_autonomy_level).toBe(2);
  });

  test('create_agent_from_template still routes worker presets by name and LH templates by key', async () => {
    const handlers = makeHandlers(ctx);
    // Preset name keeps the legacy path (no subscription/reminder seeding).
    const preset = JSON.parse(
      (await handlers.create_agent_from_template({ template_name: 'Reviewer' })).content[0].text
    );
    expect(preset.success).toBe(true);
    expect(preset.agent.templateKey).toBe('Reviewer');
    expect(preset.seeded_subscriptions).toBeUndefined();
    expect(preset.seeded_reminders).toBeUndefined();

    // LH key lookup is case-insensitive and distinct from preset names.
    const lh = JSON.parse(
      (await handlers.create_agent_from_template({ template_name: 'RESEARCH.DEFAULT' })).content[0]
        .text
    );
    expect(lh.success).toBe(true);
    expect(lh.agent.templateKey).toBe('research.default');
    expect(lh.agent.handle).toBe('research');
    expect(lh.seeded_reminders).toEqual([{ title: 'Weekly research digest' }]);

    // Unknown template points the caller at the listing tool.
    const missing = JSON.parse(
      (await handlers.create_agent_from_template({ template_name: 'nope.default' })).content[0].text
    );
    expect(missing.success).toBe(false);
    expect(missing.error).toContain('list_agent_templates');

    // Empty template_name is rejected up front.
    const blank = JSON.parse(
      (await handlers.create_agent_from_template({ template_name: '   ' })).content[0].text
    );
    expect(blank.success).toBe(false);
    expect(blank.error).toBe('template_name is required');
  });
});

describe('createSpaceAgentToolHandlers — goal tools', () => {
  let ctx: TestCtx;
  beforeEach(() => {
    ctx = makeCtx();
  });
  afterEach(() => {
    ctx.db.close();
  });

  test('creates, lists, updates, pauses, resumes, triggers, and lists goal tasks', async () => {
    const handlers = makeHandlers(ctx);

    const createdOut = await handlers.create_goal({
      title: 'Improve onboarding',
      description: 'Make first run smoother',
      type: 'recurring',
      priority: 'high',
      labels: ['product'],
      summary: 'Initial state',
      progress: 10,
      next_steps: ['Audit current flow'],
    });
    const created = JSON.parse(createdOut.content[0].text);
    expect(created.success).toBe(true);
    expect(created.goal.title).toBe('Improve onboarding');

    const listOut = await handlers.list_goals({ status: 'active' });
    const listed = JSON.parse(listOut.content[0].text);
    expect(listed.goals.map((goal: { id: string }) => goal.id)).toContain(created.goal.id);

    const updatedOut = await handlers.update_goal({
      goal_id: created.goal.id,
      summary: 'Audit finished',
      progress: 40,
      metrics: { activated: 12 },
      next_steps: ['Ship improvements'],
    });
    const updated = JSON.parse(updatedOut.content[0].text);
    expect(updated.success).toBe(true);
    expect(updated.goal.summary).toBe('Audit finished');
    expect(updated.goal.progress).toBe(10);
    expect(updated.goal.nextSteps).toEqual(['Ship improvements']);

    const paused = JSON.parse(
      (await handlers.pause_goal({ goal_id: created.goal.id })).content[0].text
    );
    expect(paused.goal.status).toBe('paused');
    const resumed = JSON.parse(
      (await handlers.resume_goal({ goal_id: created.goal.id })).content[0].text
    );
    expect(resumed.goal.status).toBe('active');

    const triggered = JSON.parse(
      (await handlers.trigger_goal_task({ goal_id: created.goal.id })).content[0].text
    );
    expect(triggered.success).toBe(true);
    expect(triggered.task.goalId).toBe(created.goal.id);

    const tasks = JSON.parse(
      (await handlers.list_goal_tasks({ goal_id: created.goal.id })).content[0].text
    );
    expect(tasks.total).toBe(1);
    expect(tasks.tasks[0].id).toBe(triggered.task.id);

    ctx.taskRepo.archiveTask(triggered.task.id);
    const archivedTasks = JSON.parse(
      (
        await handlers.list_goal_tasks({
          goal_id: created.goal.id,
          status: 'archived',
        })
      ).content[0].text
    );
    expect(archivedTasks.total).toBe(1);
    expect(archivedTasks.tasks[0].id).toBe(triggered.task.id);

    const events = JSON.parse(
      (await handlers.list_goal_events({ goal_id: created.goal.id })).content[0].text
    );
    expect(events.success).toBe(true);
    expect(events.total).toBeGreaterThanOrEqual(5);
    expect(events.events.map((event: { eventType: string }) => event.eventType)).toContain(
      'created'
    );
    expect(events.events.map((event: { eventType: string }) => event.eventType)).toContain(
      'updated'
    );
    expect(events.events.map((event: { eventType: string }) => event.eventType)).toContain(
      'status_changed'
    );
    expect(events.events.map((event: { eventType: string }) => event.eventType)).toContain(
      'task_triggered'
    );
  });

  test('rejects cross-space goal access', async () => {
    const otherGoal = ctx.goalService.createGoal({
      spaceId: ctx.spaceId,
      title: 'Other-space goal',
    });
    const otherSpaceId = 'other-space-tools-test';
    seedSpaceRow(ctx.db, otherSpaceId, '/tmp/other-workspace');
    ctx.db
      .prepare(`UPDATE space_goals SET space_id = ? WHERE id = ?`)
      .run(otherSpaceId, otherGoal.id);

    const handlers = makeHandlers(ctx);
    const out = await handlers.get_goal({ goal_id: otherGoal.id });
    const parsed = JSON.parse(out.content[0].text);
    expect(parsed.success).toBe(false);
    expect(parsed.error).toContain('Goal not found');

    const eventsOut = await handlers.list_goal_events({ goal_id: otherGoal.id });
    const events = JSON.parse(eventsOut.content[0].text);
    expect(events.success).toBe(false);
    expect(events.error).toContain('Goal not found');
  });

  test('updates a recurring goal schedule cadence in place via update_goal', async () => {
    const handlers = makeHandlers(ctx);
    const created = JSON.parse(
      (
        await handlers.create_goal({
          title: 'Scheduled',
          type: 'recurring',
          check_in_cron_expression: '0 0,12 * * *',
          check_in_timezone: 'UTC',
        })
      ).content[0].text
    ).goal;
    const scheduleId = created.taskScheduleId;
    expect(scheduleId).toBeString();

    const updated = JSON.parse(
      (
        await handlers.update_goal({
          goal_id: created.id,
          check_in_cron_expression: '0 * * * *',
        })
      ).content[0].text
    ).goal;

    // Identity + linkage preserved, cadence changed in place.
    expect(updated.id).toBe(created.id);
    expect(updated.taskScheduleId).toBe(scheduleId);
    const scheduleRow = ctx.db
      .prepare('SELECT cron_expression FROM task_schedules WHERE id = ?')
      .get(scheduleId) as { cron_expression: string };
    expect(scheduleRow.cron_expression).toBe('0 * * * *');
    // Exactly one pending fire job registered for the schedule.
    const jobCount = (
      ctx.db
        .prepare(
          `SELECT COUNT(*) as n FROM job_queue
            WHERE queue = 'taskSchedule.fire' AND status = 'pending'
              AND json_extract(payload, '$.scheduleId') = ?`
        )
        .get(scheduleId) as { n: number }
    ).n;
    expect(jobCount).toBe(1);
  });

  test('removes a recurring goal schedule via update_goal with null cron', async () => {
    const handlers = makeHandlers(ctx);
    const created = JSON.parse(
      (
        await handlers.create_goal({
          title: 'Will remove',
          type: 'recurring',
          check_in_cron_expression: '0 9 * * 1',
        })
      ).content[0].text
    ).goal;

    const updated = JSON.parse(
      (await handlers.update_goal({ goal_id: created.id, check_in_cron_expression: null }))
        .content[0].text
    ).goal;

    expect(updated.taskScheduleId).toBeNull();
    expect(
      ctx.db.prepare('SELECT id FROM task_schedules WHERE id = ?').get(created.taskScheduleId)
    ).toBeFalsy();
  });

  test('rejects cross-space schedule edits via update_goal', async () => {
    const handlers = makeHandlers(ctx);
    const otherGoal = ctx.goalService.createGoal({
      spaceId: ctx.spaceId,
      title: 'Other-space scheduled',
      checkInCronExpression: '0 9 * * 1',
    });
    const otherSpaceId = 'other-space-schedule-test';
    seedSpaceRow(ctx.db, otherSpaceId, '/tmp/other-ws');
    ctx.db
      .prepare(`UPDATE space_goals SET space_id = ? WHERE id = ?`)
      .run(otherSpaceId, otherGoal.id);

    const out = await handlers.update_goal({
      goal_id: otherGoal.id,
      check_in_cron_expression: '0 * * * *',
    });
    const parsed = JSON.parse(out.content[0].text);
    expect(parsed.success).toBe(false);
    expect(parsed.error).toContain('Goal not found');
  });
});

// ---------------------------------------------------------------------------
// Forge tools
// ---------------------------------------------------------------------------

describe('createSpaceAgentToolHandlers — Forge tools', () => {
  let ctx: TestCtx;
  beforeEach(() => {
    ctx = makeCtx();
  });
  afterEach(() => {
    ctx.db.close();
  });

  test('runs dogfood path with scope, evidence, episode, lesson, proposal task, and rollup', async () => {
    const handlers = makeHandlers(ctx);
    const goal = JSON.parse(
      (
        await handlers.create_goal({
          title: 'Forge dogfood',
          type: 'recurring',
          progress: 5,
          next_steps: ['Collect evidence'],
        })
      ).content[0].text
    ).goal;

    const scope = JSON.parse(
      (
        await handlers.create_forge_scope_from_goal({
          goal_id: goal.id,
          policy: { cadence: 'weekly', episodeJudgeModel: 'claude-sonnet-4-5' },
        })
      ).content[0].text
    ).scope;
    expect(scope.spaceGoalId).toBe(goal.id);

    const updatedScope = JSON.parse(
      (
        await handlers.update_forge_scope({
          scope_id: scope.id,
          episode_judge_model: 'claude-opus-4-5',
        })
      ).content[0].text
    ).scope;
    expect(updatedScope.policy.episodeJudgeModel).toBe('claude-opus-4-5');

    const note = JSON.parse(
      (
        await handlers.add_forge_manual_note({
          scope_id: scope.id,
          summary: 'Manual dogfood note',
          metadata: { source: 'test' },
        })
      ).content[0].text
    ).evidence;
    const snapshot = JSON.parse(
      (
        await handlers.add_forge_metric_snapshot({
          scope_id: scope.id,
          values: { friction: 2 },
          source: 'manual',
          note: 'Less friction',
        })
      ).content[0].text
    );
    expect(snapshot.evidence.kind).toBe('metric_snapshot');

    const episodeResult = JSON.parse(
      (
        await handlers.create_forge_episode({
          scope_id: scope.id,
          evidence_ids: [note.id, snapshot.evidence.id],
          confirm_low_confidence: true,
        })
      ).content[0].text
    );
    expect(episodeResult.success).toBe(true);
    expect(episodeResult.lessons).toHaveLength(1);
    expect(episodeResult.proposals).toHaveLength(1);

    const lesson = JSON.parse(
      (
        await handlers.update_forge_lesson({
          lesson_id: episodeResult.lessons[0].id,
          status: 'active',
        })
      ).content[0].text
    ).lesson;
    expect(lesson.status).toBe('active');

    const taskResult = JSON.parse(
      (
        await handlers.create_task_from_forge_proposal({
          proposal_id: episodeResult.proposals[0].id,
        })
      ).content[0].text
    );
    expect(taskResult.task.goalId).toBe(goal.id);
    expect(taskResult.task.evolutionScopeId).toBe(scope.id);

    const rollup = JSON.parse(
      (
        await handlers.apply_forge_rollup({
          episode_id: episodeResult.episode.id,
          goal_update: {
            summary: 'Dogfood path complete',
            progress: 42,
            next_steps: ['Use proposal task'],
            metrics: { friction: 2 },
          },
        })
      ).content[0].text
    );
    expect(rollup.episode.status).toBe('accepted');
    expect(rollup.goal.summary).toBe('Dogfood path complete');
    expect(rollup.goal.progress).toBe(5);
  });

  test('update_forge_scope deep-merges policy via policy_patch (UI parity)', async () => {
    const handlers = makeHandlers(ctx);
    const scope = JSON.parse(
      (
        await handlers.create_forge_scope({
          kind: 'custom',
          name: 'Policy scope',
          objective: 'Test policy merge',
          policy: {
            episodeJudgeModel: 'claude-sonnet-4-5',
            episodeJudgeProvider: 'anthropic',
            automation: { completedTaskAutomationEnabled: false, completedTaskThreshold: 3 },
          },
        })
      ).content[0].text
    ).scope;

    // Deep-merge automation without clobbering the judge model/provider — the
    // capability the UI has via policyPatch that MCP previously lacked.
    const patched = JSON.parse(
      (
        await handlers.update_forge_scope({
          scope_id: scope.id,
          policy_patch: {
            automation: { completedTaskThreshold: 5 },
            cadence: 'weekly',
          },
        })
      ).content[0].text
    ).scope;

    expect(patched.policy.episodeJudgeModel).toBe('claude-sonnet-4-5');
    expect(patched.policy.episodeJudgeProvider).toBe('anthropic');
    // automation is nested-merged: threshold updated, sibling preserved.
    expect(patched.policy.automation.completedTaskThreshold).toBe(5);
    expect(patched.policy.automation.completedTaskAutomationEnabled).toBe(false);
    expect(patched.policy.cadence).toBe('weekly');
  });

  test('update_forge_scope sets episode judge provider alongside model', async () => {
    const handlers = makeHandlers(ctx);
    const scope = JSON.parse(
      (
        await handlers.create_forge_scope({
          kind: 'custom',
          name: 'Judge provider',
          objective: 'Pair model + provider',
        })
      ).content[0].text
    ).scope;

    const updated = JSON.parse(
      (
        await handlers.update_forge_scope({
          scope_id: scope.id,
          episode_judge_model: 'glm-4.6',
          episode_judge_provider: 'zai',
        })
      ).content[0].text
    ).scope;

    expect(updated.policy.episodeJudgeModel).toBe('glm-4.6');
    expect(updated.policy.episodeJudgeProvider).toBe('zai');
  });

  test('update_forge_scope rejects invalid automation policy via policy_patch (validation parity)', async () => {
    const handlers = makeHandlers(ctx);
    const scope = JSON.parse(
      (
        await handlers.create_forge_scope({
          kind: 'custom',
          name: 'Validate',
          objective: 'Automation validation',
        })
      ).content[0].text
    ).scope;

    // Invalid threshold (must be a positive integer) — same gate as RPC/UI.
    const rejectedThreshold = JSON.parse(
      (
        await handlers.update_forge_scope({
          scope_id: scope.id,
          policy_patch: { automation: { completedTaskThreshold: 0 } },
        })
      ).content[0].text
    );
    expect(rejectedThreshold.success).toBe(false);
    expect(rejectedThreshold.error).toContain('positive integer');

    // Non-boolean enabled is also rejected.
    const rejectedEnabled = JSON.parse(
      (
        await handlers.update_forge_scope({
          scope_id: scope.id,
          policy_patch: { automation: { completedTaskAutomationEnabled: 'yes' } },
        })
      ).content[0].text
    );
    expect(rejectedEnabled.success).toBe(false);
    expect(rejectedEnabled.error).toContain('boolean');

    // Validation runs before persist, so the scope policy is unchanged.
    const refreshed = JSON.parse(
      (await handlers.get_forge_scope({ scope_id: scope.id })).content[0].text
    ).scope;
    expect(refreshed.policy.automation?.completedTaskThreshold).toBeUndefined();
  });

  test('update_forge_scope rejects a non-string self-nag timezone before normalization', async () => {
    const handlers = makeHandlers(ctx);
    const scope = JSON.parse(
      (
        await handlers.create_forge_scope({
          kind: 'custom',
          name: 'Raw tz type',
          objective: 'x',
          policy: { automation: { selfNagCronExpression: '0 9 * * 1', selfNagTimezone: 'UTC' } },
        })
      ).content[0].text
    ).scope;

    // A non-string selfNagTimezone must be rejected before normalization,
    // instead of being normalized away and silently falling back to UTC.
    const rejected = JSON.parse(
      (
        await handlers.update_forge_scope({
          scope_id: scope.id,
          policy_patch: { automation: { selfNagTimezone: 42 as never } },
        })
      ).content[0].text
    );
    expect(rejected.success).toBe(false);
    expect(rejected.error).toContain('selfNagTimezone must be a string');
  });

  test('create_forge_scope rejects an invalid automation policy', async () => {
    const handlers = makeHandlers(ctx);
    const rejected = JSON.parse(
      (
        await handlers.create_forge_scope({
          kind: 'custom',
          name: 'Bad create',
          objective: 'x',
          policy: { automation: { completedTaskThreshold: 0 } },
        })
      ).content[0].text
    );
    expect(rejected.success).toBe(false);
    expect(rejected.error).toContain('positive integer');
  });

  test('update_forge_scope validates the effective policy on a metadata-only edit', async () => {
    const handlers = makeHandlers(ctx);
    const scope = JSON.parse(
      (await handlers.create_forge_scope({ kind: 'custom', name: 'Scope', objective: 'x' }))
        .content[0].text
    ).scope;
    // Smuggle in an invalid automation policy out-of-band (e.g. an older code
    // path). A metadata-only update must still reject it, mirroring the RPC
    // beforeScopeUpdate hook that validates the existing effective policy.
    ctx.evolutionRepo.updateScope(scope.id, {
      policy: { automation: { completedTaskThreshold: 0 } },
    });

    const rejected = JSON.parse(
      (await handlers.update_forge_scope({ scope_id: scope.id, name: 'Renamed' })).content[0].text
    );
    expect(rejected.success).toBe(false);
    expect(rejected.error).toContain('positive integer');
  });

  test('update_forge_scope treats an explicit empty policy_patch as precedence over a full policy', async () => {
    const handlers = makeHandlers(ctx);
    const scope = JSON.parse(
      (
        await handlers.create_forge_scope({
          kind: 'custom',
          name: 'Empty patch',
          objective: 'x',
          policy: {
            episodeJudgeModel: 'claude-sonnet-4-5',
            automation: { completedTaskThreshold: 5 },
          },
        })
      ).content[0].text
    ).scope;

    // An explicitly supplied (even empty) policy_patch takes precedence over a
    // full `policy` per the contract — the existing policy is retained and the
    // full policy ignored, instead of falling through to a full replacement.
    const updated = JSON.parse(
      (
        await handlers.update_forge_scope({
          scope_id: scope.id,
          policy: { episodeJudgeModel: 'claude-opus-4-5' },
          policy_patch: {},
        })
      ).content[0].text
    ).scope;

    expect(updated.success !== false).toBe(true);
    expect(updated.policy.episodeJudgeModel).toBe('claude-sonnet-4-5');
    expect(updated.policy.automation.completedTaskThreshold).toBe(5);
  });

  test('update_forge_scope policy_patch clears nested automation keys via null', async () => {
    const handlers = makeHandlers(ctx);
    const scope = JSON.parse(
      (
        await handlers.create_forge_scope({
          kind: 'custom',
          name: 'Null clear',
          objective: 'Nested null clear',
          policy: {
            episodeJudgeModel: 'claude-sonnet-4-5',
            automation: { completedTaskThreshold: 5, completedTaskAutomationEnabled: true },
          },
        })
      ).content[0].text
    ).scope;

    // A null nested value clears the key (documented contract) rather than
    // being retained and rejected by validation.
    const updated = JSON.parse(
      (
        await handlers.update_forge_scope({
          scope_id: scope.id,
          policy_patch: { automation: { completedTaskThreshold: null } },
        })
      ).content[0].text
    ).scope;

    expect(updated.success !== false).toBe(true);
    expect(updated.policy.automation.completedTaskThreshold).toBeUndefined();
    // Sibling automation key and unrelated policy keys are preserved.
    expect(updated.policy.automation.completedTaskAutomationEnabled).toBe(true);
    expect(updated.policy.episodeJudgeModel).toBe('claude-sonnet-4-5');
  });

  test('update_forge_scope policy_patch clears automation via a null automation patch', async () => {
    const handlers = makeHandlers(ctx);
    const scope = JSON.parse(
      (
        await handlers.create_forge_scope({
          kind: 'custom',
          name: 'Null automation',
          objective: 'Automation null clear',
          policy: {
            episodeJudgeModel: 'claude-sonnet-4-5',
            automation: { completedTaskThreshold: 5 },
          },
        })
      ).content[0].text
    ).scope;

    // { automation: null } clears the automation key entirely (documented
    // null-clear contract), rather than reinstating null and being rejected.
    const updated = JSON.parse(
      (
        await handlers.update_forge_scope({
          scope_id: scope.id,
          policy_patch: { automation: null },
        })
      ).content[0].text
    ).scope;

    expect(updated.success !== false).toBe(true);
    expect(updated.policy.automation).toBeUndefined();
    // Unrelated policy key preserved.
    expect(updated.policy.episodeJudgeModel).toBe('claude-sonnet-4-5');
  });

  test('update_forge_scope reconciles the self-nag schedule when automation is cleared', async () => {
    const handlers = makeHandlers(ctx);
    const goal = JSON.parse(
      (await handlers.create_goal({ title: 'Self-nag goal', type: 'recurring' })).content[0].text
    ).goal;
    const scope = JSON.parse(
      (
        await handlers.create_forge_scope({
          kind: 'custom',
          name: 'Self-nag scope',
          objective: 'Reconcile',
          goal_id: goal.id,
          policy: {
            automation: { selfNagCronExpression: '0 9 * * 1', selfNagTimezone: 'UTC' },
          },
        })
      ).content[0].text
    ).scope;

    // Simulate a prior reconciliation having created an active self-nag schedule
    // for this scope + goal.
    const schedule = ctx.scheduleService.createGoalSchedule({
      spaceId: ctx.spaceId,
      goalId: goal.id,
      title: `Forge self-nag: ${goal.title}`,
      description: 'Run Forge automation',
      triggerType: 'cron',
      cronExpression: '0 9 * * 1',
      timezone: 'UTC',
      labels: ['forge', 'automation', `goal:${goal.id}`, `scope:${scope.id}`],
      metadata: { goalAutomationKind: 'self_nag', goalAutomationScopeId: scope.id },
      createdByAgent: 'goal-automation-service',
    });
    expect(schedule.status).toBe('active');

    // Clearing automation via MCP must reconcile (pause) the now-unconfigured
    // self-nag schedule, mirroring the RPC onScopeSaved hook.
    const result = JSON.parse(
      (
        await handlers.update_forge_scope({
          scope_id: scope.id,
          policy_patch: { automation: null },
        })
      ).content[0].text
    );
    expect(result.success !== false).toBe(true);

    expect(ctx.scheduleService.getSchedule(schedule.id)?.status).toBe('paused');
  });

  test('create_forge_scope reconciles the self-nag schedule on creation', async () => {
    const handlers = makeHandlers(ctx);
    const goal = JSON.parse(
      (await handlers.create_goal({ title: 'Self-nag create', type: 'recurring' })).content[0].text
    ).goal;

    // Creating a scope linked to an active goal with a self-nag cadence must
    // create the fire schedule immediately (mirroring the RPC onScopeSaved
    // hook), not leave it dormant until a later update.
    const created = JSON.parse(
      (
        await handlers.create_forge_scope({
          kind: 'custom',
          name: 'Self-nag on create',
          objective: 'Reconcile on create',
          goal_id: goal.id,
          policy: { automation: { selfNagCronExpression: '0 9 * * 1', selfNagTimezone: 'UTC' } },
        })
      ).content[0].text
    ).scope;
    expect(created.success !== false).toBe(true);

    const schedules = ctx.scheduleService
      .listSchedules(ctx.spaceId)
      .filter((s) => s.createdByAgent === 'goal-automation-service' && s.goalId === goal.id);
    expect(schedules).toHaveLength(1);
    expect(schedules[0]!.status).toBe('active');
    expect(schedules[0]!.cronExpression).toBe('0 9 * * 1');
  });

  test('update_forge_scope surfaces a schedule reconciliation failure', async () => {
    const handlers = makeHandlers(ctx);
    const goal = JSON.parse(
      (await handlers.create_goal({ title: 'Reconcile fail', type: 'recurring' })).content[0].text
    ).goal;
    const scope = JSON.parse(
      (
        await handlers.create_forge_scope({
          kind: 'custom',
          name: 'rf',
          objective: 'rf',
          goal_id: goal.id,
          policy: { automation: { selfNagCronExpression: '0 9 * * 1' } },
        })
      ).content[0].text
    ).scope;

    // A reconciliation failure (e.g. the schedule enqueue throws) must
    // propagate as a failed result — not be swallowed into success: true.
    const spy = spyOn(ctx.scheduleService, 'listSchedules').mockImplementation(() => {
      throw new Error('reconcile boom');
    });
    try {
      const parsed = JSON.parse(
        (
          await handlers.update_forge_scope({
            scope_id: scope.id,
            policy_patch: { cadence: 'weekly' },
          })
        ).content[0].text
      );
      expect(parsed.success).toBe(false);
      expect(parsed.error).toContain('reconcile boom');
    } finally {
      spy.mockRestore();
    }
  });

  test('update_forge_scope fails when reconciliation loses a pause CAS on a stale schedule', async () => {
    const handlers = makeHandlers(ctx);
    const goal = JSON.parse(
      (await handlers.create_goal({ title: 'CAS relink', type: 'recurring' })).content[0].text
    ).goal;
    const scope = JSON.parse(
      (
        await handlers.create_forge_scope({
          kind: 'custom',
          name: 'cas',
          objective: 'cas',
          goal_id: goal.id,
          policy: { automation: { selfNagCronExpression: '0 9 * * 1' } },
        })
      ).content[0].text
    ).scope;
    // Active self-nag schedule for the scope+goal (created by prior reconcile).
    const schedule = ctx.scheduleService.createGoalSchedule({
      spaceId: ctx.spaceId,
      goalId: goal.id,
      title: 'Forge self-nag: CAS',
      description: 'x',
      triggerType: 'cron',
      cronExpression: '0 9 * * 1',
      timezone: 'UTC',
      labels: ['forge', 'automation', `goal:${goal.id}`, `scope:${scope.id}`],
      metadata: { goalAutomationKind: 'self_nag', goalAutomationScopeId: scope.id },
      createdByAgent: 'goal-automation-service',
    });

    // Simulate pauseSchedule losing its pending-job CAS (returns still-active).
    const spy = spyOn(ctx.scheduleService, 'pauseSchedule').mockImplementation(
      () => ({ ...schedule, status: 'active' }) as never
    );
    try {
      // Unlinking the scope forces the no-goal reconciliation to pause the
      // stale schedule; a lost CAS must surface as a failed result rather than
      // leave the old schedule firing.
      const parsed = JSON.parse(
        (await handlers.update_forge_scope({ scope_id: scope.id, goal_id: null })).content[0].text
      );
      expect(parsed.success).toBe(false);
      expect(parsed.error).toContain('Could not pause Forge self-nag schedule');
    } finally {
      spy.mockRestore();
    }
  });

  test('covers untested Forge read tools', async () => {
    const handlers = makeHandlers(ctx);
    const created = JSON.parse(
      (
        await handlers.create_forge_scope({
          kind: 'custom',
          name: 'Read tools scope',
          objective: 'Exercise read tools',
        })
      ).content[0].text
    ).scope;
    const note = JSON.parse(
      (
        await handlers.add_forge_manual_note({
          scope_id: created.id,
          summary: 'Read note',
        })
      ).content[0].text
    ).evidence;
    const snapshot = JSON.parse(
      (
        await handlers.add_forge_metric_snapshot({
          scope_id: created.id,
          values: { quality: 7 },
          source: 'manual',
          note: 'Quality snapshot',
        })
      ).content[0].text
    );

    const listed = JSON.parse((await handlers.list_forge_scopes({})).content[0].text);
    expect(listed.success).toBe(true);
    expect(listed.scopes.some((scope: { id: string }) => scope.id === created.id)).toBe(true);

    const fetched = JSON.parse(
      (await handlers.get_forge_scope({ scope_id: created.id })).content[0].text
    );
    expect(fetched.success).toBe(true);
    expect(fetched.scope.id).toBe(created.id);

    const timeline = JSON.parse(
      (await handlers.get_forge_timeline({ scope_id: created.id })).content[0].text
    );
    expect(timeline.success).toBe(true);
    expect(timeline.scope.id).toBe(created.id);
    expect(timeline.evidence).toHaveLength(2);
    expect(timeline.metricSnapshots).toHaveLength(1);

    const evidence = JSON.parse(
      (await handlers.list_forge_evidence({ scope_id: created.id })).content[0].text
    );
    expect(evidence.success).toBe(true);
    expect(evidence.evidence.map((item: { id: string }) => item.id)).toContain(note.id);
    expect(evidence.evidence.map((item: { id: string }) => item.id)).toContain(
      snapshot.evidence.id
    );

    const snapshots = JSON.parse(
      (await handlers.list_forge_metric_snapshots({ scope_id: created.id })).content[0].text
    );
    expect(snapshots.success).toBe(true);
    expect(snapshots.snapshots).toHaveLength(1);
    expect(snapshots.snapshots[0].values.quality).toBe(7);
  });

  test('attaches workflow run evidence', async () => {
    const handlers = makeHandlers(ctx);
    const scope = JSON.parse(
      (
        await handlers.create_forge_scope({
          kind: 'custom',
          name: 'Workflow evidence scope',
          objective: 'Attach workflow evidence',
        })
      ).content[0].text
    ).scope;
    const wf = buildSingleStepWorkflow(
      ctx.spaceId,
      ctx.workflowManager,
      ctx.agentId,
      'Forge workflow evidence'
    );
    const run = ctx.workflowRunRepo.createRun({
      spaceId: ctx.spaceId,
      workflowId: wf.id,
      title: 'Evidence run',
    });

    const attached = JSON.parse(
      (
        await handlers.attach_forge_workflow_run_evidence({
          scope_id: scope.id,
          workflow_run_id: run.id,
          summary: 'Workflow run evidence',
        })
      ).content[0].text
    );
    expect(attached.success).toBe(true);
    expect(attached.evidence.sourceId).toBe(run.id);

    const evidence = JSON.parse(
      (await handlers.list_forge_evidence({ scope_id: scope.id })).content[0].text
    );
    expect(evidence.success).toBe(true);
    expect(evidence.evidence[0].id).toBe(attached.evidence.id);
  });

  test('rejects reopening terminal Forge episodes', async () => {
    const handlers = makeHandlers(ctx);
    const scope = JSON.parse(
      (
        await handlers.create_forge_scope({
          kind: 'custom',
          name: 'Terminal episode scope',
          objective: 'Guard episode status',
        })
      ).content[0].text
    ).scope;
    const evidence = JSON.parse(
      (
        await handlers.add_forge_manual_note({
          scope_id: scope.id,
          summary: 'Terminal episode evidence',
        })
      ).content[0].text
    ).evidence;
    const episode = JSON.parse(
      (
        await handlers.create_forge_episode({
          scope_id: scope.id,
          evidence_ids: [evidence.id],
          confirm_low_confidence: true,
        })
      ).content[0].text
    ).episode;

    const accepted = JSON.parse(
      (
        await handlers.update_forge_episode({
          episode_id: episode.id,
          status: 'accepted',
        })
      ).content[0].text
    );
    expect(accepted.success).toBe(true);
    expect(accepted.episode.status).toBe('accepted');

    const reopen = JSON.parse(
      (
        await handlers.update_forge_episode({
          episode_id: episode.id,
          status: 'draft',
        })
      ).content[0].text
    );
    expect(reopen.success).toBe(false);
    expect(reopen.error).toContain('Terminal Forge episodes cannot be reopened');

    const afterReopenAttempt = JSON.parse(
      (await handlers.list_forge_review_bundle({ scope_id: scope.id })).content[0].text
    ).episodes[0];
    expect(afterReopenAttempt.status).toBe('accepted');
  });

  test('lists Forge lessons with optional status filter', async () => {
    const handlers = makeHandlers(ctx);
    const scope = JSON.parse(
      (
        await handlers.create_forge_scope({
          kind: 'custom',
          name: 'Lesson scope',
          objective: 'List lessons',
        })
      ).content[0].text
    ).scope;
    const evidence = JSON.parse(
      (
        await handlers.add_forge_manual_note({
          scope_id: scope.id,
          summary: 'Lesson evidence',
        })
      ).content[0].text
    ).evidence;
    const episodeResult = JSON.parse(
      (
        await handlers.create_forge_episode({
          scope_id: scope.id,
          evidence_ids: [evidence.id],
          confirm_low_confidence: true,
        })
      ).content[0].text
    );

    const candidateLessons = JSON.parse(
      (await handlers.list_forge_lessons({ scope_id: scope.id })).content[0].text
    );
    expect(candidateLessons.success).toBe(true);
    expect(candidateLessons.lessons).toHaveLength(1);
    expect(candidateLessons.lessons[0].status).toBe('candidate');

    await handlers.update_forge_lesson({
      lesson_id: episodeResult.lessons[0].id,
      status: 'active',
    });
    const activeLessons = JSON.parse(
      (await handlers.list_forge_lessons({ scope_id: scope.id, status: 'active' })).content[0].text
    );
    expect(activeLessons.success).toBe(true);
    expect(activeLessons.lessons).toHaveLength(1);
    expect(activeLessons.lessons[0].id).toBe(episodeResult.lessons[0].id);

    const remainingCandidates = JSON.parse(
      (await handlers.list_forge_lessons({ scope_id: scope.id, status: 'candidate' })).content[0]
        .text
    );
    expect(remainingCandidates.lessons).toHaveLength(0);
  });

  test('lists Forge proposals with optional status filter', async () => {
    const handlers = makeHandlers(ctx);
    const scope = JSON.parse(
      (
        await handlers.create_forge_scope({
          kind: 'custom',
          name: 'Proposal list scope',
          objective: 'List proposals',
        })
      ).content[0].text
    ).scope;
    const proposal = JSON.parse(
      (
        await handlers.create_forge_task_proposal({
          scope_id: scope.id,
          title: 'Manual proposal',
          description: 'Do thing',
          reason: 'Need thing',
        })
      ).content[0].text
    ).proposal;

    const proposals = JSON.parse(
      (await handlers.list_forge_proposals({ scope_id: scope.id })).content[0].text
    );
    expect(proposals.success).toBe(true);
    expect(proposals.proposals).toHaveLength(1);
    expect(proposals.proposals[0].id).toBe(proposal.id);

    const proposed = JSON.parse(
      (await handlers.list_forge_proposals({ scope_id: scope.id, status: 'proposed' })).content[0]
        .text
    );
    expect(proposed.success).toBe(true);
    expect(proposed.proposals).toHaveLength(1);
    expect(proposed.proposals[0].status).toBe('proposed');

    const accepted = JSON.parse(
      (await handlers.list_forge_proposals({ scope_id: scope.id, status: 'accepted' })).content[0]
        .text
    );
    expect(accepted.proposals).toHaveLength(0);
  });

  test('resolves Forge scope by goal or task', async () => {
    const handlers = makeHandlers(ctx);
    const goal = JSON.parse(
      (
        await handlers.create_goal({
          title: 'Resolve goal',
          type: 'recurring',
        })
      ).content[0].text
    ).goal;
    const scope = JSON.parse(
      (await handlers.create_forge_scope_from_goal({ goal_id: goal.id })).content[0].text
    ).scope;

    const byGoal = JSON.parse(
      (await handlers.resolve_forge_scope({ goal_id: goal.id })).content[0].text
    );
    expect(byGoal.success).toBe(true);
    expect(byGoal.scope.id).toBe(scope.id);

    const task = ctx.taskRepo.createTask({
      spaceId: ctx.spaceId,
      title: 'Scoped task',
      description: 'Has scope',
      goalId: goal.id,
      evolutionScopeId: scope.id,
    });
    const byTask = JSON.parse(
      (await handlers.resolve_forge_scope({ task_id: task.id })).content[0].text
    );
    expect(byTask.success).toBe(true);
    expect(byTask.scope.id).toBe(scope.id);

    const unlinkedGoal = JSON.parse(
      (
        await handlers.create_goal({
          title: 'Unlinked goal',
          type: 'recurring',
        })
      ).content[0].text
    ).goal;
    const missing = JSON.parse(
      (await handlers.resolve_forge_scope({ goal_id: unlinkedGoal.id })).content[0].text
    );
    expect(missing.success).toBe(false);
    expect(missing.error).toBe('No scope found');

    const noArgs = JSON.parse((await handlers.resolve_forge_scope({})).content[0].text);
    expect(noArgs.success).toBe(false);
    expect(noArgs.error).toContain('Provide goal_id or task_id');
  });

  test('rejects mismatched proposal evidence episodes', async () => {
    const handlers = makeHandlers(ctx);
    const scopeA = JSON.parse(
      (
        await handlers.create_forge_scope({
          kind: 'custom',
          name: 'Scope A',
          objective: 'First scope',
        })
      ).content[0].text
    ).scope;
    const scopeB = JSON.parse(
      (
        await handlers.create_forge_scope({
          kind: 'custom',
          name: 'Scope B',
          objective: 'Second scope',
        })
      ).content[0].text
    ).scope;
    const evidenceB = JSON.parse(
      (
        await handlers.add_forge_manual_note({
          scope_id: scopeB.id,
          summary: 'Scope B evidence',
        })
      ).content[0].text
    ).evidence;
    const episodeB = JSON.parse(
      (
        await handlers.create_forge_episode({
          scope_id: scopeB.id,
          evidence_ids: [evidenceB.id],
          confirm_low_confidence: true,
        })
      ).content[0].text
    ).episode;

    const result = JSON.parse(
      (
        await handlers.create_forge_task_proposal({
          scope_id: scopeA.id,
          title: 'Wrong scope proposal',
          description: 'Should fail',
          reason: 'Episode belongs elsewhere',
          evidence_episode_ids: [episodeB.id],
        })
      ).content[0].text
    );
    expect(result.success).toBe(false);
    expect(result.error).toContain('EvolutionEpisode not found in scope');
  });

  test('rejects reactivating dismissed lessons', async () => {
    const handlers = makeHandlers(ctx);
    const scope = JSON.parse(
      (
        await handlers.create_forge_scope({
          kind: 'custom',
          name: 'Dismissed lesson scope',
          objective: 'Guard lesson status',
        })
      ).content[0].text
    ).scope;
    const evidence = JSON.parse(
      (
        await handlers.add_forge_manual_note({
          scope_id: scope.id,
          summary: 'Lesson status evidence',
        })
      ).content[0].text
    ).evidence;
    const episodeResult = JSON.parse(
      (
        await handlers.create_forge_episode({
          scope_id: scope.id,
          evidence_ids: [evidence.id],
          confirm_low_confidence: true,
        })
      ).content[0].text
    );

    const dismissed = JSON.parse(
      (
        await handlers.update_forge_lesson({
          lesson_id: episodeResult.lessons[0].id,
          status: 'dismissed',
        })
      ).content[0].text
    );
    expect(dismissed.success).toBe(true);

    const reactivated = JSON.parse(
      (
        await handlers.update_forge_lesson({
          lesson_id: episodeResult.lessons[0].id,
          status: 'active',
        })
      ).content[0].text
    );
    expect(reactivated.success).toBe(false);
    expect(reactivated.error).toContain('Dismissed lessons cannot be reactivated');
  });

  test('creates proposal task with unmet dependencies before runtime can launch it', async () => {
    const handlers = makeHandlers(ctx);
    buildSingleStepWorkflow(ctx.spaceId, ctx.workflowManager, ctx.agentId, 'Coding workflow');
    const dependency = await ctx.taskManager.createTask({
      title: 'Dependency task',
      description: 'Finish first',
    });
    const scope = JSON.parse(
      (
        await handlers.create_forge_scope({
          kind: 'custom',
          name: 'Dependent proposal scope',
          objective: 'Create dependent task',
        })
      ).content[0].text
    ).scope;
    const proposal = JSON.parse(
      (
        await handlers.create_forge_task_proposal({
          scope_id: scope.id,
          title: 'Dependent proposal',
          description: 'Wait for dependency',
          reason: 'Prevent premature launch',
        })
      ).content[0].text
    ).proposal;

    const taskResult = JSON.parse(
      (
        await handlers.create_task_from_forge_proposal({
          proposal_id: proposal.id,
          depends_on: [dependency.id],
        })
      ).content[0].text
    );
    expect(taskResult.success).toBe(true);
    expect(taskResult.task.dependsOn).toEqual([dependency.id]);
    expect(taskResult.task.status).toBe('open');
    expect(taskResult.task.workflowRunId).toBeUndefined();

    await ctx.runtime.executeTick();

    const taskAfterTick = ctx.taskRepo.getTask(taskResult.task.id);
    expect(taskAfterTick?.dependsOn).toEqual([dependency.id]);
    expect(taskAfterTick?.status).toBe('open');
    expect(taskAfterTick?.workflowRunId).toBeUndefined();
  });

  test('rejects unsafe proposal status updates', async () => {
    const handlers = makeHandlers(ctx);
    const scope = JSON.parse(
      (
        await handlers.create_forge_scope({
          kind: 'custom',
          name: 'Proposal scope',
          objective: 'Guard proposal status',
        })
      ).content[0].text
    ).scope;
    const proposal = JSON.parse(
      (
        await handlers.create_forge_task_proposal({
          scope_id: scope.id,
          title: 'Proposal',
          description: 'Create task later',
          reason: 'Need task',
        })
      ).content[0].text
    ).proposal;

    const manualCreated = JSON.parse(
      (
        await handlers.update_forge_task_proposal({
          proposal_id: proposal.id,
          status: 'created',
        })
      ).content[0].text
    );
    expect(manualCreated.success).toBe(false);
    expect(manualCreated.error).toContain('create_task_from_forge_proposal');

    const taskResult = JSON.parse(
      (await handlers.create_task_from_forge_proposal({ proposal_id: proposal.id })).content[0].text
    );
    expect(taskResult.success).toBe(true);

    const reopen = JSON.parse(
      (
        await handlers.update_forge_task_proposal({
          proposal_id: proposal.id,
          status: 'accepted',
        })
      ).content[0].text
    );
    expect(reopen.success).toBe(false);
    expect(reopen.error).toContain('cannot be reopened');

    const idempotent = JSON.parse(
      (await handlers.create_task_from_forge_proposal({ proposal_id: proposal.id })).content[0].text
    );
    expect(idempotent.success).toBe(true);
    expect(idempotent.task.id).toBe(taskResult.task.id);
  });

  test('rejects reopening dismissed proposals', async () => {
    const handlers = makeHandlers(ctx);
    const scope = JSON.parse(
      (
        await handlers.create_forge_scope({
          kind: 'custom',
          name: 'Dismissed proposal scope',
          objective: 'Guard proposal status',
        })
      ).content[0].text
    ).scope;
    const proposal = JSON.parse(
      (
        await handlers.create_forge_task_proposal({
          scope_id: scope.id,
          title: 'Dismissible proposal',
          description: 'Can dismiss',
          reason: 'Test guard',
        })
      ).content[0].text
    ).proposal;

    const dismissed = JSON.parse(
      (
        await handlers.update_forge_task_proposal({
          proposal_id: proposal.id,
          status: 'dismissed',
        })
      ).content[0].text
    );
    expect(dismissed.success).toBe(true);

    const accepted = JSON.parse(
      (
        await handlers.update_forge_task_proposal({
          proposal_id: proposal.id,
          status: 'accepted',
        })
      ).content[0].text
    );
    expect(accepted.success).toBe(false);
    expect(accepted.error).toContain('Dismissed proposals cannot be reopened');
  });

  test('rejects cross-space scope and task evidence access', async () => {
    const otherSpaceId = 'other-forge-space';
    seedSpaceRow(ctx.db, otherSpaceId, '/tmp/other-forge');
    const otherScope = ctx.evolutionScopeService.createScope({
      spaceId: otherSpaceId,
      kind: 'custom',
      name: 'Other scope',
      objective: 'Other objective',
    });
    const otherTask = ctx.taskRepo.createTask({
      spaceId: otherSpaceId,
      title: 'Other task',
      description: 'Outside this space',
    });
    const handlers = makeHandlers(ctx);

    const scopeOut = JSON.parse(
      (await handlers.get_forge_scope({ scope_id: otherScope.id })).content[0].text
    );
    expect(scopeOut.success).toBe(false);
    expect(scopeOut.error).toContain('EvolutionScope not found');

    const evidenceOut = JSON.parse(
      (
        await handlers.attach_forge_task_evidence({
          scope_id: otherScope.id,
          task_id: otherTask.id,
        })
      ).content[0].text
    );
    expect(evidenceOut.success).toBe(false);
    expect(evidenceOut.error).toContain('Task not found');
  });
});

// ---------------------------------------------------------------------------
// list_workflows
// ---------------------------------------------------------------------------

describe('createSpaceAgentToolHandlers — list_workflows', () => {
  let ctx: TestCtx;
  beforeEach(() => {
    ctx = makeCtx();
  });
  afterEach(() => {
    ctx.db.close();
  });

  test('returns empty list when no workflows exist', async () => {
    const result = await makeHandlers(ctx).list_workflows();
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.success).toBe(true);
    expect(parsed.workflows).toEqual([]);
  });

  test('returns all workflows for the space', async () => {
    buildSingleStepWorkflow(ctx.spaceId, ctx.workflowManager, ctx.agentId, 'WF Alpha');
    buildSingleStepWorkflow(ctx.spaceId, ctx.workflowManager, ctx.agentId, 'WF Beta');

    const result = await makeHandlers(ctx).list_workflows();
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.success).toBe(true);
    expect(parsed.workflows).toHaveLength(2);
  });
});

// ---------------------------------------------------------------------------
// get_workflow_run
// ---------------------------------------------------------------------------

describe('createSpaceAgentToolHandlers — get_workflow_run', () => {
  let ctx: TestCtx;
  beforeEach(() => {
    ctx = makeCtx();
  });
  afterEach(() => {
    ctx.db.close();
  });

  test('returns run with executions', async () => {
    const wf = buildSingleStepWorkflow(ctx.spaceId, ctx.workflowManager, ctx.agentId, 'Get WF');

    const startResult = await startWorkflowRun(ctx, {
      workflow_id: wf.id,
      title: 'my run',
    });
    const runId = JSON.parse(startResult.content[0].text).run.id;

    const result = await makeHandlers(ctx).get_workflow_run({ run_id: runId });
    const parsed = JSON.parse(result.content[0].text);

    expect(parsed.success).toBe(true);
    expect(parsed.run.id).toBe(runId);
    expect(parsed.run.status).toBe('in_progress');
    // startWorkflowRun() now creates a node_execution record for the start node
    expect(parsed.executions).toHaveLength(1);
    expect(parsed.executions[0].status).toBe('pending');
  });

  test('returns error when run not found', async () => {
    const result = await makeHandlers(ctx).get_workflow_run({ run_id: 'run-missing' });
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.success).toBe(false);
    expect(parsed.error).toContain('run-missing');
  });

  test('rejects cross-space workflow run access', async () => {
    const otherSpaceId = 'other-run-space';
    seedSpaceRow(ctx.db, otherSpaceId, '/tmp/other-run-space');
    const wf = buildSingleStepWorkflow(
      ctx.spaceId,
      ctx.workflowManager,
      ctx.agentId,
      'Other Run WF'
    );
    const rawRun = ctx.workflowRunRepo.createRun({
      spaceId: otherSpaceId,
      workflowId: wf.id,
      title: 'other-space run',
    });

    const result = await makeHandlers(ctx).get_workflow_run({ run_id: rawRun.id });
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.success).toBe(false);
    expect(parsed.error).toContain(rawRun.id);
  });

  test('returns run with empty tasks when no tasks have been created', async () => {
    const wf = buildSingleStepWorkflow(ctx.spaceId, ctx.workflowManager, ctx.agentId, 'NoStep WF');
    const rawRun = ctx.workflowRunRepo.createRun({
      spaceId: ctx.spaceId,
      workflowId: wf.id,
      title: 'no-step run',
    });

    const result = await makeHandlers(ctx).get_workflow_run({ run_id: rawRun.id });
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.success).toBe(true);
    expect(parsed.executions).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// change_plan
// ---------------------------------------------------------------------------

describe('createSpaceAgentToolHandlers — change_plan', () => {
  let ctx: TestCtx;
  beforeEach(() => {
    ctx = makeCtx();
  });
  afterEach(() => {
    ctx.db.close();
  });

  test('updates description of an in-progress run', async () => {
    const wf = buildSingleStepWorkflow(ctx.spaceId, ctx.workflowManager, ctx.agentId, 'Desc WF');
    const startResult = await startWorkflowRun(ctx, {
      workflow_id: wf.id,
      title: 'run',
      description: 'original desc',
    });
    const runId = JSON.parse(startResult.content[0].text).run.id;

    const result = await makeHandlers(ctx).change_plan({
      run_id: runId,
      description: 'updated desc',
    });
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.success).toBe(true);
    expect(parsed.run.description).toBe('updated desc');
  });

  test('switches workflow: cancels current run and starts new one', async () => {
    const wf1 = buildSingleStepWorkflow(ctx.spaceId, ctx.workflowManager, ctx.agentId, 'WF One');
    const wf2 = buildSingleStepWorkflow(ctx.spaceId, ctx.workflowManager, ctx.agentId, 'WF Two');

    const startResult = await startWorkflowRun(ctx, {
      workflow_id: wf1.id,
      title: 'switch test',
    });
    const runId = JSON.parse(startResult.content[0].text).run.id;

    const result = await makeHandlers(ctx).change_plan({
      run_id: runId,
      workflow_id: wf2.id,
    });
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.success).toBe(true);
    expect(parsed.previousRunId).toBe(runId);
    expect(parsed.run.workflowId).toBe(wf2.id);
    expect(parsed.run.title).toBe('switch test');

    // Old run should be cancelled
    const oldRun = ctx.workflowRunRepo.getRun(runId);
    expect(oldRun?.status).toBe('cancelled');
  });

  test('returns error when run not found', async () => {
    const result = await makeHandlers(ctx).change_plan({ run_id: 'run-missing' });
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.success).toBe(false);
  });

  test('rejects cross-space workflow run plan changes', async () => {
    const otherSpaceId = 'other-plan-space';
    seedSpaceRow(ctx.db, otherSpaceId, '/tmp/other-plan-space');
    const wf = buildSingleStepWorkflow(
      ctx.spaceId,
      ctx.workflowManager,
      ctx.agentId,
      'Other Plan WF'
    );
    const rawRun = ctx.workflowRunRepo.createRun({
      spaceId: otherSpaceId,
      workflowId: wf.id,
      title: 'other-space plan',
    });

    const result = await makeHandlers(ctx).change_plan({
      run_id: rawRun.id,
      description: 'should not update',
    });
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.success).toBe(false);
    expect(parsed.error).toContain(rawRun.id);
  });

  test('returns error when trying to change plan on succeeded run', async () => {
    const wf = buildSingleStepWorkflow(ctx.spaceId, ctx.workflowManager, ctx.agentId, 'Done WF');
    const startResult = await startWorkflowRun(ctx, {
      workflow_id: wf.id,
      title: 'succeeded run',
    });
    const runId = JSON.parse(startResult.content[0].text).run.id;

    // Mark as a succeeded execution attempt.
    ctx.workflowRunRepo.transitionStatus(runId, 'done');

    const result = await makeHandlers(ctx).change_plan({
      run_id: runId,
      description: 'new desc',
    });
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.success).toBe(false);
    expect(parsed.error).toContain('succeeded run');
  });

  test('returns error when neither description nor workflow_id provided', async () => {
    const wf = buildSingleStepWorkflow(ctx.spaceId, ctx.workflowManager, ctx.agentId, 'Empty WF');
    const startResult = await startWorkflowRun(ctx, {
      workflow_id: wf.id,
      title: 'run',
    });
    const runId = JSON.parse(startResult.content[0].text).run.id;

    const result = await makeHandlers(ctx).change_plan({ run_id: runId });
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.success).toBe(false);
  });

  test('does not cancel the original run when target workflow_id is invalid', async () => {
    const wf = buildSingleStepWorkflow(
      ctx.spaceId,
      ctx.workflowManager,
      ctx.agentId,
      'Original WF'
    );
    const startResult = await startWorkflowRun(ctx, {
      workflow_id: wf.id,
      title: 'run to keep',
    });
    const runId = JSON.parse(startResult.content[0].text).run.id;

    // Attempt to switch to a non-existent workflow
    const result = await makeHandlers(ctx).change_plan({
      run_id: runId,
      workflow_id: 'wf-does-not-exist',
    });

    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.success).toBe(false);

    // Original run must still be in_progress — not cancelled
    const originalRun = ctx.workflowRunRepo.getRun(runId);
    expect(originalRun?.status).toBe('in_progress');
  });

  test('returns error when target workflow is disabled', async () => {
    const wf = buildSingleStepWorkflow(ctx.spaceId, ctx.workflowManager, ctx.agentId, 'WF to keep');
    const disabledWf = buildSingleStepWorkflow(
      ctx.spaceId,
      ctx.workflowManager,
      ctx.agentId,
      'Disabled WF',
      [],
      '',
      true
    );
    const startResult = await startWorkflowRun(ctx, {
      workflow_id: wf.id,
      title: 'run to keep',
    });
    const runId = JSON.parse(startResult.content[0].text).run.id;

    const result = await makeHandlers(ctx).change_plan({
      run_id: runId,
      workflow_id: disabledWf.id,
    });

    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.success).toBe(false);
    expect(parsed.error).toContain('disabled');

    // Original run must still be in_progress — not cancelled
    const originalRun = ctx.workflowRunRepo.getRun(runId);
    expect(originalRun?.status).toBe('in_progress');
  });

  test('switches workflow by handle instead of id', async () => {
    const wf1 = buildSingleStepWorkflow(ctx.spaceId, ctx.workflowManager, ctx.agentId, 'WF One');
    const wf2 = buildSingleStepWorkflow(ctx.spaceId, ctx.workflowManager, ctx.agentId, 'WF Two');
    expect(wf2.handle).toBeDefined();

    const startResult = await startWorkflowRun(ctx, {
      workflow_id: wf1.id,
      title: 'switch test',
    });
    const runId = JSON.parse(startResult.content[0].text).run.id;

    const result = await makeHandlers(ctx).change_plan({
      run_id: runId,
      workflow_handle: wf2.handle,
    });
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.success).toBe(true);
    expect(parsed.previousRunId).toBe(runId);
    expect(parsed.run.workflowId).toBe(wf2.id);

    // Old run should be cancelled
    const oldRun = ctx.workflowRunRepo.getRun(runId);
    expect(oldRun?.status).toBe('cancelled');
  });

  test('returns error when workflow_handle does not exist', async () => {
    const wf = buildSingleStepWorkflow(ctx.spaceId, ctx.workflowManager, ctx.agentId, 'WF');
    const startResult = await startWorkflowRun(ctx, {
      workflow_id: wf.id,
      title: 'run',
    });
    const runId = JSON.parse(startResult.content[0].text).run.id;

    const result = await makeHandlers(ctx).change_plan({
      run_id: runId,
      workflow_handle: 'nonexistent-handle',
    });
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.success).toBe(false);
    expect(parsed.error).toContain('nonexistent-handle');

    // Original run must still be in_progress
    const originalRun = ctx.workflowRunRepo.getRun(runId);
    expect(originalRun?.status).toBe('in_progress');
  });

  test('falls back to workflow_handle when workflow_id is stale', async () => {
    const wf1 = buildSingleStepWorkflow(
      ctx.spaceId,
      ctx.workflowManager,
      ctx.agentId,
      'Switch Source WF'
    );
    const wf2 = buildSingleStepWorkflow(
      ctx.spaceId,
      ctx.workflowManager,
      ctx.agentId,
      'Switch Target WF'
    );
    const startResult = await startWorkflowRun(ctx, {
      workflow_id: wf1.id,
      title: 'stale-id run',
    });
    const runId = JSON.parse(startResult.content[0].text).run.id;

    const result = await makeHandlers(ctx).change_plan({
      run_id: runId,
      workflow_id: 'stale-uuid-for-wf2',
      workflow_handle: wf2.handle,
    });
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.success).toBe(true);
    expect(parsed.run.workflowId).toBe(wf2.id);
  });

  test('falls back to workflow_handle when workflow_id is disabled', async () => {
    const wfSource = buildSingleStepWorkflow(
      ctx.spaceId,
      ctx.workflowManager,
      ctx.agentId,
      'Source WF disabled fallback'
    );
    const disabledWf = buildSingleStepWorkflow(
      ctx.spaceId,
      ctx.workflowManager,
      ctx.agentId,
      'Disabled WF for fallback',
      [],
      '',
      true
    );
    const wfTarget = buildSingleStepWorkflow(
      ctx.spaceId,
      ctx.workflowManager,
      ctx.agentId,
      'Target WF via handle'
    );
    const startResult = await startWorkflowRun(ctx, {
      workflow_id: wfSource.id,
      title: 'disabled-id run',
    });
    const runId = JSON.parse(startResult.content[0].text).run.id;

    // Pass the disabled ID but also provide the target's handle
    const result = await makeHandlers(ctx).change_plan({
      run_id: runId,
      workflow_id: disabledWf.id,
      workflow_handle: wfTarget.handle,
    });
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.success).toBe(true);
    expect(parsed.run.workflowId).toBe(wfTarget.id);
  });

  test('falls back to workflow_handle when workflow_id belongs to a different space', async () => {
    // wf-source is used to start the run; wf-other is in a different space;
    // wf-target is the intended switch target, referenced by handle.
    const wfSource = buildSingleStepWorkflow(
      ctx.spaceId,
      ctx.workflowManager,
      ctx.agentId,
      'Source WF'
    );
    // Seed the other space so FK constraints pass, then create a workflow there.
    const otherSpaceId = 'other-space-for-change-plan';
    seedSpaceRow(ctx.db, otherSpaceId);
    const wfOther = buildSingleStepWorkflow(
      otherSpaceId,
      ctx.workflowManager,
      ctx.agentId,
      'Other Space WF'
    );
    const wfTarget = buildSingleStepWorkflow(
      ctx.spaceId,
      ctx.workflowManager,
      ctx.agentId,
      'Target WF'
    );
    const startResult = await startWorkflowRun(ctx, {
      workflow_id: wfSource.id,
      title: 'cross-space switch run',
    });
    const runId = JSON.parse(startResult.content[0].text).run.id;

    // Pass the cross-space ID but also provide the target's handle
    const result = await makeHandlers(ctx).change_plan({
      run_id: runId,
      workflow_id: wfOther.id,
      workflow_handle: wfTarget.handle,
    });
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.success).toBe(true);
    expect(parsed.run.workflowId).toBe(wfTarget.id);
  });

  test('rejects cross-space workflow_id when handle fallback also fails', async () => {
    const wfSource = buildSingleStepWorkflow(
      ctx.spaceId,
      ctx.workflowManager,
      ctx.agentId,
      'Source WF'
    );
    // Create a workflow in another space
    const otherSpaceId = 'other-space-stale-handle';
    seedSpaceRow(ctx.db, otherSpaceId);
    const wfOther = buildSingleStepWorkflow(
      otherSpaceId,
      ctx.workflowManager,
      ctx.agentId,
      'Other Space WF'
    );
    const startResult = await startWorkflowRun(ctx, {
      workflow_id: wfSource.id,
      title: 'stale-handle run',
    });
    const runId = JSON.parse(startResult.content[0].text).run.id;

    // Pass cross-space ID + a handle that doesn't resolve to anything
    const result = await makeHandlers(ctx).change_plan({
      run_id: runId,
      workflow_id: wfOther.id,
      workflow_handle: 'nonexistent-handle',
    });
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.success).toBe(false);
    expect(parsed.error).toContain('Workflow not found');
  });
});

// ---------------------------------------------------------------------------
// list_tasks
// ---------------------------------------------------------------------------

describe('createSpaceAgentToolHandlers — list_tasks', () => {
  let ctx: TestCtx;
  beforeEach(() => {
    ctx = makeCtx();
  });
  afterEach(() => {
    ctx.db.close();
  });

  test('returns all tasks when no filter applied', async () => {
    const wf = buildSingleStepWorkflow(ctx.spaceId, ctx.workflowManager, ctx.agentId, 'List WF');
    await startWorkflowRun(ctx, { workflow_id: wf.id, title: 'run 1' });
    await startWorkflowRun(ctx, { workflow_id: wf.id, title: 'run 2' });

    const result = await makeHandlers(ctx).list_tasks({});
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.success).toBe(true);
    expect(parsed.tasks).toHaveLength(2);
  });

  test('filters tasks by workflow_run_id', async () => {
    const wf = buildSingleStepWorkflow(ctx.spaceId, ctx.workflowManager, ctx.agentId, 'Filter WF');

    const r1 = await startWorkflowRun(ctx, { workflow_id: wf.id, title: 'run A' });
    const runId = JSON.parse(r1.content[0].text).run.id;

    await startWorkflowRun(ctx, { workflow_id: wf.id, title: 'run B' });

    const result = await makeHandlers(ctx).list_tasks({ workflow_run_id: runId });
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.success).toBe(true);
    expect(parsed.tasks).toHaveLength(1);
    expect(parsed.tasks[0].workflowRunId).toBe(runId);
  });

  test('rejects cross-space workflow_run_id task filter', async () => {
    const otherSpaceId = 'other-task-filter-space';
    seedSpaceRow(ctx.db, otherSpaceId, '/tmp/other-task-filter-space');
    const wf = buildSingleStepWorkflow(
      ctx.spaceId,
      ctx.workflowManager,
      ctx.agentId,
      'Other Task WF'
    );
    const rawRun = ctx.workflowRunRepo.createRun({
      spaceId: otherSpaceId,
      workflowId: wf.id,
      title: 'other-space task filter',
    });

    const result = await makeHandlers(ctx).list_tasks({ workflow_run_id: rawRun.id });
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.success).toBe(false);
    expect(parsed.error).toContain(rawRun.id);
  });

  test('filters tasks by status', async () => {
    const wf = buildSingleStepWorkflow(ctx.spaceId, ctx.workflowManager, ctx.agentId, 'Status WF');

    const r1 = await startWorkflowRun(ctx, { workflow_id: wf.id, title: 'run 1' });
    const taskId = JSON.parse(r1.content[0].text).tasks[0].id;

    await startWorkflowRun(ctx, { workflow_id: wf.id, title: 'run 2' });

    // Mark first task as completed
    ctx.taskRepo.updateTask(taskId, { status: 'done', completedAt: Date.now() });

    const result = await makeHandlers(ctx).list_tasks({ status: 'open' });
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.success).toBe(true);
    expect(parsed.tasks).toHaveLength(1);
    expect(parsed.tasks[0].status).toBe('open');
  });

  test('returns empty list when no tasks exist', async () => {
    const result = await makeHandlers(ctx).list_tasks({});
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.success).toBe(true);
    expect(parsed.tasks).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// get_workflow_detail
// ---------------------------------------------------------------------------

describe('createSpaceAgentToolHandlers — get_workflow_detail', () => {
  let ctx: TestCtx;
  beforeEach(() => {
    ctx = makeCtx();
  });
  afterEach(() => {
    ctx.db.close();
  });

  test('returns full workflow definition including steps and rules', async () => {
    const wf = buildSingleStepWorkflow(
      ctx.spaceId,
      ctx.workflowManager,
      ctx.agentId,
      'Detail WF',
      ['tag1'],
      'Detailed description'
    );

    const result = await makeHandlers(ctx).get_workflow_detail({ workflow_id: wf.id });
    const parsed = JSON.parse(result.content[0].text);

    expect(parsed.success).toBe(true);
    expect(parsed.workflow.id).toBe(wf.id);
    expect(parsed.workflow.name).toBe('Detail WF');
    expect(parsed.workflow.description).toBe('Detailed description');
    expect(parsed.workflow.nodes).toHaveLength(1);
    expect(parsed.workflow.nodes[0].agents[0].agentId).toBe(ctx.agentId);
    // rules field removed from SpaceWorkflow — verify nodes exist instead
    expect(parsed.workflow.nodes[0].agents).toHaveLength(1);
  });

  test('returns error when workflow_id not found', async () => {
    const result = await makeHandlers(ctx).get_workflow_detail({
      workflow_id: 'wf-does-not-exist',
    });
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.success).toBe(false);
    expect(parsed.error).toContain('wf-does-not-exist');
  });

  test('returns workflow with tags', async () => {
    const wf = buildSingleStepWorkflow(ctx.spaceId, ctx.workflowManager, ctx.agentId, 'Tagged WF', [
      'alpha',
      'beta',
    ]);

    const result = await makeHandlers(ctx).get_workflow_detail({ workflow_id: wf.id });
    const parsed = JSON.parse(result.content[0].text);

    expect(parsed.success).toBe(true);
    expect(parsed.workflow.tags).toContain('alpha');
    expect(parsed.workflow.tags).toContain('beta');
  });

  test('resolves workflow by handle when workflow_handle is provided', async () => {
    const wf = buildSingleStepWorkflow(
      ctx.spaceId,
      ctx.workflowManager,
      ctx.agentId,
      'Handle Lookup WF',
      [],
      'Look me up by handle'
    );
    // The workflow was auto-generated with a handle from its name
    expect(wf.handle).toBeDefined();

    const result = await makeHandlers(ctx).get_workflow_detail({
      workflow_handle: wf.handle,
    });
    const parsed = JSON.parse(result.content[0].text);

    expect(parsed.success).toBe(true);
    expect(parsed.workflow.id).toBe(wf.id);
    expect(parsed.workflow.name).toBe('Handle Lookup WF');
  });

  test('returns error when workflow_handle does not exist', async () => {
    const result = await makeHandlers(ctx).get_workflow_detail({
      workflow_handle: 'nonexistent-handle',
    });
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.success).toBe(false);
    expect(parsed.error).toContain('nonexistent-handle');
  });

  test('returns error when neither workflow_id nor workflow_handle is provided', async () => {
    const result = await makeHandlers(ctx).get_workflow_detail({});
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.success).toBe(false);
    expect(parsed.error).toMatch(/workflow_id or workflow_handle/);
  });

  test('falls back to workflow_handle when workflow_id is stale', async () => {
    const wf = buildSingleStepWorkflow(
      ctx.spaceId,
      ctx.workflowManager,
      ctx.agentId,
      'Stale ID Fallback WF'
    );
    expect(wf.handle).toBeDefined();

    const result = await makeHandlers(ctx).get_workflow_detail({
      workflow_id: 'stale-uuid-for-get-detail',
      workflow_handle: wf.handle,
    });
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.success).toBe(true);
    expect(parsed.workflow.id).toBe(wf.id);
  });

  test('falls back to workflow_handle when workflow_id belongs to a different space', async () => {
    // wf-other exists in the DB but belongs to a different space.
    // wf-target is the workflow we actually want, identified by handle.
    const otherSpaceId = 'other-space-for-detail';
    seedSpaceRow(ctx.db, otherSpaceId);
    const wfOther = buildSingleStepWorkflow(
      otherSpaceId,
      ctx.workflowManager,
      ctx.agentId,
      'Other Space Detail WF'
    );
    const wfTarget = buildSingleStepWorkflow(
      ctx.spaceId,
      ctx.workflowManager,
      ctx.agentId,
      'Target Detail WF'
    );
    expect(wfTarget.handle).toBeDefined();

    const result = await makeHandlers(ctx).get_workflow_detail({
      workflow_id: wfOther.id,
      workflow_handle: wfTarget.handle,
    });
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.success).toBe(true);
    expect(parsed.workflow.id).toBe(wfTarget.id);
  });

  test('falls back to workflow_handle when workflow_id is disabled', async () => {
    const disabledWf = buildSingleStepWorkflow(
      ctx.spaceId,
      ctx.workflowManager,
      ctx.agentId,
      'Disabled WF get-detail',
      [],
      '',
      true
    );
    const targetWf = buildSingleStepWorkflow(
      ctx.spaceId,
      ctx.workflowManager,
      ctx.agentId,
      'Target WF get-detail'
    );
    expect(targetWf.handle).toBeDefined();

    const result = await makeHandlers(ctx).get_workflow_detail({
      workflow_id: disabledWf.id,
      workflow_handle: targetWf.handle,
    });
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.success).toBe(true);
    expect(parsed.workflow.id).toBe(targetWf.id);
  });

  test('preserves disabled workflow when handle is stale', async () => {
    const disabledWf = buildSingleStepWorkflow(
      ctx.spaceId,
      ctx.workflowManager,
      ctx.agentId,
      'Disabled WF stale handle',
      [],
      '',
      true
    );

    // Pass the disabled ID + a stale handle that doesn't resolve
    const result = await makeHandlers(ctx).get_workflow_detail({
      workflow_id: disabledWf.id,
      workflow_handle: 'nonexistent-stale-handle',
    });
    const parsed = JSON.parse(result.content[0].text);
    // Should return the disabled workflow, NOT "not found"
    expect(parsed.success).toBe(true);
    expect(parsed.workflow.id).toBe(disabledWf.id);
  });
});

// ---------------------------------------------------------------------------
// suggest_workflow
// ---------------------------------------------------------------------------

describe('createSpaceAgentToolHandlers — suggest_workflow', () => {
  let ctx: TestCtx;
  beforeEach(() => {
    ctx = makeCtx();
  });
  afterEach(() => {
    ctx.db.close();
  });

  test('returns empty list with message when no workflows exist', async () => {
    const result = await makeHandlers(ctx).suggest_workflow({
      description: 'implement a new feature',
    });
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.success).toBe(true);
    expect(parsed.workflows).toEqual([]);
  });

  test('returns every workflow unranked so the Space Agent LLM can pick', async () => {
    // suggest_workflow no longer keyword-ranks: it just surfaces the
    // catalogue so the caller's LLM can reason without bias.
    buildSingleStepWorkflow(
      ctx.spaceId,
      ctx.workflowManager,
      ctx.agentId,
      'Coding Workflow',
      [],
      'For writing code'
    );
    buildSingleStepWorkflow(
      ctx.spaceId,
      ctx.workflowManager,
      ctx.agentId,
      'Research Workflow',
      [],
      'For research tasks'
    );

    const result = await makeHandlers(ctx).suggest_workflow({
      description: 'write coding implementation',
    });
    const parsed = JSON.parse(result.content[0].text);

    expect(parsed.success).toBe(true);
    expect(parsed.workflows).toHaveLength(2);
    const names = parsed.workflows.map((w: { name: string }) => w.name).sort();
    expect(names).toEqual(['Coding Workflow', 'Research Workflow']);
  });

  test('does not keyword-rank — "review" tag no longer hijacks top spot', async () => {
    // Regression guard for the P0 bug that prompted switching to LLM-driven
    // selection: a task description containing "review feedback" used to
    // push the keyword-matching workflow (Review Flow) in front of the
    // workflow whose name/description actually fit the work (Coding Flow).
    const coding = buildSingleStepWorkflow(
      ctx.spaceId,
      ctx.workflowManager,
      ctx.agentId,
      'Coding Flow',
      ['coding'],
      'Write code and open a PR'
    );
    const review = buildSingleStepWorkflow(
      ctx.spaceId,
      ctx.workflowManager,
      ctx.agentId,
      'Review Flow',
      ['review'],
      'Review a pull request'
    );

    const result = await makeHandlers(ctx).suggest_workflow({
      description: 'address review feedback and re-run the coding loop',
    });
    const parsed = JSON.parse(result.content[0].text);

    expect(parsed.success).toBe(true);
    expect(parsed.workflows).toHaveLength(2);
    // Order is creation order (insertion order) — never keyword rank.
    expect(parsed.workflows.map((w: { id: string }) => w.id)).toEqual([coding.id, review.id]);
  });

  test('returns all workflows for empty description', async () => {
    buildSingleStepWorkflow(ctx.spaceId, ctx.workflowManager, ctx.agentId, 'My WF');

    const result = await makeHandlers(ctx).suggest_workflow({ description: '' });
    const parsed = JSON.parse(result.content[0].text);

    expect(parsed.success).toBe(true);
    expect(parsed.workflows).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// create_standalone_task
// ---------------------------------------------------------------------------

describe('createSpaceAgentToolHandlers — create_standalone_task', () => {
  let ctx: TestCtx;
  beforeEach(() => {
    ctx = makeCtx();
  });
  afterEach(() => {
    ctx.db.close();
  });

  test('creates a task with required fields only', async () => {
    const result = await makeHandlers(ctx).create_standalone_task({
      title: 'My task',
      description: 'Do something',
    });
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.success).toBe(true);
    expect(parsed.task.title).toBe('My task');
    expect(parsed.task.description).toBe('Do something');
    expect(parsed.task.workflowRunId ?? null).toBeNull();
    expect(parsed.task.workflowNodeId ?? null).toBeNull();
    expect(parsed.task.spaceId).toBe(ctx.spaceId);
  });

  test('creates a task with all optional fields', async () => {
    const result = await makeHandlers(ctx).create_standalone_task({
      title: 'Full task',
      description: 'Detailed description',
      priority: 'high',
    });
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.success).toBe(true);
    expect(parsed.task.priority).toBe('high');
    expect(parsed.task.title).toBe('Full task');
  });

  test('custom_agent_id field removed in M71 — task still creates without error', async () => {
    // custom_agent_id is no longer validated in create_standalone_task post-M71
    const result = await makeHandlers(ctx).create_standalone_task({
      title: 'Task',
      description: 'Desc',
    });
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.success).toBe(true);
    expect(parsed.task.id).toBeDefined();
  });

  test('task is retrievable from repo after creation', async () => {
    const result = await makeHandlers(ctx).create_standalone_task({
      title: 'Stored task',
      description: 'Check storage',
    });
    const taskId = JSON.parse(result.content[0].text).task.id;
    const stored = ctx.taskRepo.getTask(taskId);
    expect(stored).not.toBeNull();
    expect(stored?.title).toBe('Stored task');
  });

  test('persists preferredWorkflowId when workflow_id is provided', async () => {
    const wf = buildSingleStepWorkflow(ctx.spaceId, ctx.workflowManager, ctx.agentId, 'Coding QA');
    const result = await makeHandlers(ctx).create_standalone_task({
      title: 'Fix auth bug',
      description: 'Authentication fails for international users',
      workflow_id: wf.id,
    });
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.success).toBe(true);
    const stored = ctx.taskRepo.getTask(parsed.task.id);
    expect(stored).not.toBeNull();
    expect(stored?.preferredWorkflowId).toBe(wf.id);
  });

  test('preferredWorkflowId is null when workflow_id not provided', async () => {
    const result = await makeHandlers(ctx).create_standalone_task({
      title: 'Generic task',
      description: 'No explicit workflow',
    });
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.success).toBe(true);
    const stored = ctx.taskRepo.getTask(parsed.task.id);
    expect(stored?.preferredWorkflowId ?? null).toBeNull();
  });

  test('depends_on: [] succeeds and persists an empty dependency list', async () => {
    const result = await makeHandlers(ctx).create_standalone_task({
      title: 'No deps',
      description: 'Task with no prerequisites',
      depends_on: [],
    });
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.success).toBe(true);
    expect(parsed.task.dependsOn).toEqual([]);
    const stored = ctx.taskRepo.getTask(parsed.task.id);
    expect(stored?.dependsOn).toEqual([]);
  });

  test('depends_on with one valid task ID persists the dependency', async () => {
    const parentResult = await makeHandlers(ctx).create_standalone_task({
      title: 'Parent task',
      description: 'Bottom of the stack',
    });
    const parentId = JSON.parse(parentResult.content[0].text).task.id;

    const childResult = await makeHandlers(ctx).create_standalone_task({
      title: 'Child task',
      description: 'Depends on parent',
      depends_on: [parentId],
    });
    const parsed = JSON.parse(childResult.content[0].text);
    expect(parsed.success).toBe(true);
    expect(parsed.task.dependsOn).toEqual([parentId]);

    const stored = ctx.taskRepo.getTask(parsed.task.id);
    expect(stored?.dependsOn).toEqual([parentId]);
  });

  test('depends_on with multiple valid task IDs persists all dependencies', async () => {
    const depAResult = await makeHandlers(ctx).create_standalone_task({
      title: 'Dep A',
      description: 'First dep',
    });
    const depAId = JSON.parse(depAResult.content[0].text).task.id;

    const depBResult = await makeHandlers(ctx).create_standalone_task({
      title: 'Dep B',
      description: 'Second dep',
    });
    const depBId = JSON.parse(depBResult.content[0].text).task.id;

    const childResult = await makeHandlers(ctx).create_standalone_task({
      title: 'Child task',
      description: 'Depends on A and B',
      depends_on: [depAId, depBId],
    });
    const parsed = JSON.parse(childResult.content[0].text);
    expect(parsed.success).toBe(true);
    expect(parsed.task.dependsOn).toEqual([depAId, depBId]);
  });

  test('depends_on with a non-existent task ID fails with a descriptive error', async () => {
    const result = await makeHandlers(ctx).create_standalone_task({
      title: 'Orphan child',
      description: 'References a missing task',
      depends_on: ['task-does-not-exist'],
    });
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.success).toBe(false);
    expect(parsed.error).toContain('task-does-not-exist');
    expect(parsed.error).toMatch(/not found|dependency/i);
  });

  test('depends_on with a task from a different space fails (cross-space rejected)', async () => {
    // Seed a second space and create a task there via its own task manager.
    const otherSpaceId = 'space-other';
    seedSpaceRow(ctx.db, otherSpaceId, '/tmp/other-workspace');
    const otherTaskManager = new SpaceTaskManager(ctx.db, otherSpaceId);
    const otherTask = await otherTaskManager.createTask({
      title: 'Other-space task',
      description: 'Belongs to a different space',
    });

    const result = await makeHandlers(ctx).create_standalone_task({
      title: 'Cross-space child',
      description: 'Tries to depend on another space',
      depends_on: [otherTask.id],
    });
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.success).toBe(false);
    expect(parsed.error).toContain(otherTask.id);
    expect(parsed.error).toMatch(/not found|dependency/i);
  });

  test('depends_on rejects a cycle when a dependency chain would loop back', async () => {
    // Create three tasks: A, B, C, linked A → B → C (C depends on B, B depends on A).
    const aResult = await makeHandlers(ctx).create_standalone_task({
      title: 'A',
      description: 'root',
    });
    const aId = JSON.parse(aResult.content[0].text).task.id;

    const bResult = await makeHandlers(ctx).create_standalone_task({
      title: 'B',
      description: 'depends on A',
      depends_on: [aId],
    });
    const bId = JSON.parse(bResult.content[0].text).task.id;

    const cResult = await makeHandlers(ctx).create_standalone_task({
      title: 'C',
      description: 'depends on B',
      depends_on: [bId],
    });
    expect(JSON.parse(cResult.content[0].text).success).toBe(true);
    const cId = JSON.parse(cResult.content[0].text).task.id;

    // Now attempt to update A to depend on C — this would form a cycle
    // A → C → B → A. Cycle detection happens on updates via the manager.
    await expect(ctx.taskManager.updateTask(aId, { dependsOn: [cId] })).rejects.toThrow(
      /circular|cycle/i
    );
  });

  test('persists preferredWorkflowId when workflow_handle is provided', async () => {
    const wf = buildSingleStepWorkflow(ctx.spaceId, ctx.workflowManager, ctx.agentId, 'Coding QA');
    expect(wf.handle).toBeDefined();

    const result = await makeHandlers(ctx).create_standalone_task({
      title: 'Fix auth bug',
      description: 'Authentication fails for international users',
      workflow_handle: wf.handle,
    });
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.success).toBe(true);
    const stored = ctx.taskRepo.getTask(parsed.task.id);
    expect(stored).not.toBeNull();
    expect(stored?.preferredWorkflowId).toBe(wf.id);
  });

  test('returns error when workflow_handle does not exist', async () => {
    const result = await makeHandlers(ctx).create_standalone_task({
      title: 'Task',
      description: 'Desc',
      workflow_handle: 'nonexistent-handle',
    });
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.success).toBe(false);
    expect(parsed.error).toContain('nonexistent-handle');
  });

  test('returns error when workflow_handle resolves to a disabled workflow (handle-only path)', async () => {
    const disabled = buildSingleStepWorkflow(
      ctx.spaceId,
      ctx.workflowManager,
      ctx.agentId,
      'Disabled Handle WF'
    );
    expect(disabled.handle).toBeDefined();
    ctx.db.prepare(`UPDATE space_workflows SET disabled = 1 WHERE id = ?`).run(disabled.id);

    const result = await makeHandlers(ctx).create_standalone_task({
      title: 'Task',
      description: 'Handle-only disabled',
      workflow_handle: disabled.handle,
    });
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.success).toBe(false);
    expect(parsed.error).toContain('disabled');
  });

  test('workflow_id takes precedence over workflow_handle when both provided and both valid', async () => {
    const wf1 = buildSingleStepWorkflow(ctx.spaceId, ctx.workflowManager, ctx.agentId, 'WF One');
    const wf2 = buildSingleStepWorkflow(ctx.spaceId, ctx.workflowManager, ctx.agentId, 'WF Two');
    expect(wf1.handle).toBeDefined();
    expect(wf2.handle).toBeDefined();

    const result = await makeHandlers(ctx).create_standalone_task({
      title: 'Task',
      description: 'Desc',
      workflow_id: wf1.id,
      workflow_handle: wf2.handle,
    });
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.success).toBe(true);
    const stored = ctx.taskRepo.getTask(parsed.task.id);
    expect(stored?.preferredWorkflowId).toBe(wf1.id);
  });

  test('falls back to workflow_handle when workflow_id is stale/invalid', async () => {
    const wf = buildSingleStepWorkflow(
      ctx.spaceId,
      ctx.workflowManager,
      ctx.agentId,
      'Fallback WF'
    );
    expect(wf.handle).toBeDefined();

    const result = await makeHandlers(ctx).create_standalone_task({
      title: 'Task with stale id',
      description: 'Should resolve via handle',
      workflow_id: 'stale-uuid-that-does-not-exist',
      workflow_handle: wf.handle,
    });
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.success).toBe(true);
    const stored = ctx.taskRepo.getTask(parsed.task.id);
    // Stale workflow_id was replaced with the id resolved from the handle.
    expect(stored?.preferredWorkflowId).toBe(wf.id);
  });

  test('stale workflow_id with no handle falls through to automatic selection', async () => {
    const result = await makeHandlers(ctx).create_standalone_task({
      title: 'Task with only stale id',
      description: 'No handle fallback available',
      workflow_id: 'stale-uuid-no-handle',
    });
    const parsed = JSON.parse(result.content[0].text);
    // Task is created successfully — the stale id is kept as preferredWorkflowId
    // and the runtime will fall back to automatic workflow selection.
    expect(parsed.success).toBe(true);
    const stored = ctx.taskRepo.getTask(parsed.task.id);
    expect(stored?.preferredWorkflowId).toBe('stale-uuid-no-handle');
  });

  test('falls back to handle when workflow_id resolves to a disabled workflow', async () => {
    const disabled = buildSingleStepWorkflow(
      ctx.spaceId,
      ctx.workflowManager,
      ctx.agentId,
      'Disabled WF'
    );
    const active = buildSingleStepWorkflow(
      ctx.spaceId,
      ctx.workflowManager,
      ctx.agentId,
      'Active WF'
    );
    // Disable the first workflow via DB update.
    ctx.db.prepare(`UPDATE space_workflows SET disabled = 1 WHERE id = ?`).run(disabled.id);

    const result = await makeHandlers(ctx).create_standalone_task({
      title: 'Task',
      description: 'Disabled id, valid handle',
      workflow_id: disabled.id,
      workflow_handle: active.handle,
    });
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.success).toBe(true);
    const stored = ctx.taskRepo.getTask(parsed.task.id);
    expect(stored?.preferredWorkflowId).toBe(active.id);
  });

  test('errors when both workflow_id (unusable) and workflow_handle are provided but handle not found', async () => {
    const result = await makeHandlers(ctx).create_standalone_task({
      title: 'Task',
      description: 'Both identifiers fail',
      workflow_id: 'stale-uuid',
      workflow_handle: 'also-nonexistent-handle',
    });
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.success).toBe(false);
    expect(parsed.error).toMatch(/not found/i);
  });

  test('errors when workflow_id is unusable and workflow_handle resolves to a disabled workflow (mixed selector)', async () => {
    const disabled = buildSingleStepWorkflow(
      ctx.spaceId,
      ctx.workflowManager,
      ctx.agentId,
      'Disabled Fallback WF'
    );
    expect(disabled.handle).toBeDefined();
    ctx.db.prepare(`UPDATE space_workflows SET disabled = 1 WHERE id = ?`).run(disabled.id);

    const result = await makeHandlers(ctx).create_standalone_task({
      title: 'Task',
      description: 'Stale ID + disabled handle',
      workflow_id: 'stale-uuid-mixed',
      workflow_handle: disabled.handle,
    });
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.success).toBe(false);
    expect(parsed.error).toContain('disabled');
  });
});

// ---------------------------------------------------------------------------
// get_task_detail
// ---------------------------------------------------------------------------

describe('createSpaceAgentToolHandlers — get_task_detail', () => {
  let ctx: TestCtx;
  beforeEach(() => {
    ctx = makeCtx();
  });
  afterEach(() => {
    ctx.db.close();
  });

  test('returns full task record by ID', async () => {
    const createResult = await makeHandlers(ctx).create_standalone_task({
      title: 'Detail task',
      description: 'Some work',
    });
    const taskId = JSON.parse(createResult.content[0].text).task.id;

    const result = await makeHandlers(ctx).get_task_detail({ task_id: taskId });
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.success).toBe(true);
    expect(parsed.task.id).toBe(taskId);
    expect(parsed.task.title).toBe('Detail task');
  });

  test('returns error when task not found', async () => {
    const result = await makeHandlers(ctx).get_task_detail({ task_id: 'task-missing' });
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.success).toBe(false);
    expect(parsed.error).toContain('task-missing');
  });

  test('returns task with blocked status after failure', async () => {
    const createResult = await makeHandlers(ctx).create_standalone_task({
      title: 'Failed task',
      description: 'Will fail',
    });
    const taskId = JSON.parse(createResult.content[0].text).task.id;

    // Start and then fail the task
    await ctx.taskManager.startTask(taskId);
    await ctx.taskManager.failTask(taskId, 'Something went wrong');

    const result = await makeHandlers(ctx).get_task_detail({ task_id: taskId });
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.success).toBe(true);
    expect(parsed.task.status).toBe('blocked');
    // error field was removed in M71; check task is blocked
  });
});

// ---------------------------------------------------------------------------
// retry_task
// ---------------------------------------------------------------------------

describe('createSpaceAgentToolHandlers — retry_task', () => {
  let ctx: TestCtx;
  beforeEach(() => {
    ctx = makeCtx();
  });
  afterEach(() => {
    ctx.db.close();
  });

  test('resets a needs_attention task to pending', async () => {
    const createResult = await makeHandlers(ctx).create_standalone_task({
      title: 'Retry task',
      description: 'Will be retried',
    });
    const taskId = JSON.parse(createResult.content[0].text).task.id;
    await ctx.taskManager.startTask(taskId);
    await ctx.taskManager.failTask(taskId, 'Error');

    const result = await makeHandlers(ctx).retry_task({ task_id: taskId });
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.success).toBe(true);
    expect(parsed.task.status).toBe('open');
    expect(parsed.task.error ?? null).toBeNull();
  });

  test('resets a cancelled task to in_progress (reactivation)', async () => {
    const createResult = await makeHandlers(ctx).create_standalone_task({
      title: 'Cancelled task',
      description: 'Will be retried',
    });
    const taskId = JSON.parse(createResult.content[0].text).task.id;
    await ctx.taskManager.cancelTask(taskId);

    const result = await makeHandlers(ctx).retry_task({ task_id: taskId });
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.success).toBe(true);
    expect(parsed.task.status).toBe('in_progress');
  });

  test('updates description on retry when provided', async () => {
    const createResult = await makeHandlers(ctx).create_standalone_task({
      title: 'Task with desc update',
      description: 'Original description',
    });
    const taskId = JSON.parse(createResult.content[0].text).task.id;
    await ctx.taskManager.startTask(taskId);
    await ctx.taskManager.failTask(taskId, 'Error');

    const result = await makeHandlers(ctx).retry_task({
      task_id: taskId,
      description: 'Updated description',
    });
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.success).toBe(true);
    expect(parsed.task.description).toBe('Updated description');
  });

  test('returns error for in_progress task', async () => {
    const createResult = await makeHandlers(ctx).create_standalone_task({
      title: 'Active task',
      description: 'Currently running',
    });
    const taskId = JSON.parse(createResult.content[0].text).task.id;
    await ctx.taskManager.startTask(taskId);

    const result = await makeHandlers(ctx).retry_task({ task_id: taskId });
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.success).toBe(false);
    expect(parsed.error).toContain('in_progress');
  });

  test('returns error when task not found', async () => {
    const result = await makeHandlers(ctx).retry_task({ task_id: 'task-missing' });
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.success).toBe(false);
    expect(parsed.error).toContain('task-missing');
  });

  test('rejects a workflow-backed task belonging to another space', async () => {
    const otherSpaceId = 'other-retry-space';
    seedSpaceRow(ctx.db, otherSpaceId, '/tmp/other-retry-space');
    const otherTask = ctx.taskRepo.createTask({
      spaceId: otherSpaceId,
      title: 'Other space task',
      description: 'Done in another space',
    });
    ctx.taskRepo.updateTask(otherTask.id, { status: 'done' });

    const result = await makeHandlers(ctx).retry_task({ task_id: otherTask.id });
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.success).toBe(false);
    expect(parsed.error).toContain('does not belong to this space');
    // The other space's task must not have been recovered.
    expect(ctx.taskRepo.getTask(otherTask.id)?.status).toBe('done');
  });

  test('rejects an active workflow-backed task without recovering it', async () => {
    const wf = buildSingleStepWorkflow(ctx.spaceId, ctx.workflowManager, ctx.agentId, 'Retry WF');
    const started = await startWorkflowRun(ctx, { workflow_id: wf.id, title: 'retry run' });
    const taskId = JSON.parse(started.content[0].text).tasks[0].id;
    const before = ctx.taskRepo.getTask(taskId)!;
    expect(before.workflowRunId).toBeTruthy();
    // Force an active status that is not retryable.
    ctx.taskRepo.updateTask(taskId, { status: 'in_progress' });

    const result = await makeHandlers(ctx).retry_task({ task_id: taskId });
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.success).toBe(false);
    expect(parsed.error).toContain('in_progress');
    // The task must not have been recovered (status unchanged, no destructive
    // nulling of post-approval fields).
    const after = ctx.taskRepo.getTask(taskId)!;
    expect(after.status).toBe('in_progress');
  });
});

// ---------------------------------------------------------------------------
// cancel_task
// ---------------------------------------------------------------------------

describe('createSpaceAgentToolHandlers — cancel_task', () => {
  let ctx: TestCtx;
  beforeEach(() => {
    ctx = makeCtx();
  });
  afterEach(() => {
    ctx.db.close();
  });

  test('cancels a pending task', async () => {
    const createResult = await makeHandlers(ctx).create_standalone_task({
      title: 'Cancel me',
      description: 'Will be cancelled',
    });
    const taskId = JSON.parse(createResult.content[0].text).task.id;

    const result = await makeHandlers(ctx).cancel_task({ task_id: taskId });
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.success).toBe(true);
    expect(parsed.task.status).toBe('cancelled');
  });

  test('cancels dependent tasks in cascade', async () => {
    // Create two tasks where second depends on first
    const t1 = await ctx.taskManager.createTask({ title: 'T1', description: 'First' });
    const t2 = await ctx.taskManager.createTask({
      title: 'T2',
      description: 'Depends on T1',
      dependsOn: [t1.id],
    });

    const result = await makeHandlers(ctx).cancel_task({ task_id: t1.id });
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.success).toBe(true);
    expect(parsed.task.id).toBe(t1.id);
    expect(parsed.task.status).toBe('cancelled');

    // Dependent task should also be cancelled
    const t2Updated = ctx.taskRepo.getTask(t2.id);
    expect(t2Updated?.status).toBe('cancelled');
  });

  test('cancels the workflow run when cancel_workflow_run is true', async () => {
    const wf = buildSingleStepWorkflow(ctx.spaceId, ctx.workflowManager, ctx.agentId, 'Cancel WF');
    const startResult = await startWorkflowRun(ctx, {
      workflow_id: wf.id,
      title: 'Run to cancel',
    });
    const { run, tasks } = JSON.parse(startResult.content[0].text);
    const taskId = tasks[0].id;
    const runId = run.id;

    const result = await makeHandlers(ctx).cancel_task({
      task_id: taskId,
      cancel_workflow_run: true,
    });
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.success).toBe(true);
    expect(parsed.workflowRunCancelled).toBe(true);
    expect(parsed.workflowRunId).toBe(runId);

    const updatedRun = ctx.workflowRunRepo.getRun(runId);
    expect(updatedRun?.status).toBe('cancelled');
  });

  test('does not cancel workflow run when cancel_workflow_run is false', async () => {
    const wf = buildSingleStepWorkflow(
      ctx.spaceId,
      ctx.workflowManager,
      ctx.agentId,
      'Keep Run WF'
    );
    const startResult = await startWorkflowRun(ctx, {
      workflow_id: wf.id,
      title: 'Run to keep',
    });
    const { run, tasks } = JSON.parse(startResult.content[0].text);
    const taskId = tasks[0].id;
    const runId = run.id;

    await makeHandlers(ctx).cancel_task({
      task_id: taskId,
      cancel_workflow_run: false,
    });

    const updatedRun = ctx.workflowRunRepo.getRun(runId);
    expect(updatedRun?.status).toBe('in_progress');
  });

  test('returns error when task not found', async () => {
    const result = await makeHandlers(ctx).cancel_task({ task_id: 'task-missing' });
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.success).toBe(false);
    expect(parsed.error).toContain('task-missing');
  });

  test('returns error when cancelling a completed task', async () => {
    const t = await ctx.taskManager.createTask({ title: 'T', description: 'Done' });
    await ctx.taskManager.startTask(t.id);
    await ctx.taskManager.completeTask(t.id, 'done');

    const result = await makeHandlers(ctx).cancel_task({ task_id: t.id });
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.success).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// reassign_task
// ---------------------------------------------------------------------------

describe('createSpaceAgentToolHandlers — reassign_task', () => {
  let ctx: TestCtx;
  beforeEach(() => {
    ctx = makeCtx();
  });
  afterEach(() => {
    ctx.db.close();
  });

  test('reassigns a pending task (custom_agent_id is accepted, field removed in M71)', async () => {
    const createResult = await makeHandlers(ctx).create_standalone_task({
      title: 'Reassign me',
      description: 'Will be reassigned',
    });
    const taskId = JSON.parse(createResult.content[0].text).task.id;

    const result = await makeHandlers(ctx).reassign_task({
      task_id: taskId,
      custom_agent_id: ctx.agentId,
    });
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.success).toBe(true);
    expect(parsed.task.id).toBe(taskId);
  });

  test('reassigns by changing assigned_agent type (field removed in M71)', async () => {
    const createResult = await makeHandlers(ctx).create_standalone_task({
      title: 'Agent type change',
      description: 'Change agent type',
    });
    const taskId = JSON.parse(createResult.content[0].text).task.id;

    const result = await makeHandlers(ctx).reassign_task({
      task_id: taskId,
      assigned_agent: 'general',
    });
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.success).toBe(true);
    expect(parsed.task.id).toBe(taskId);
  });

  test('does not error when reassigning open task', async () => {
    const createResult = await makeHandlers(ctx).create_standalone_task({
      title: 'Has worker agent',
      description: 'Worker agent must be preserved',
    });
    const taskId = JSON.parse(createResult.content[0].text).task.id;

    const result = await makeHandlers(ctx).reassign_task({
      task_id: taskId,
      assigned_agent: 'general',
    });
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.success).toBe(true);
    expect(parsed.task.id).toBe(taskId);
  });

  test('clears worker agent when custom_agent_id is null (field removed in M71)', async () => {
    const createResult = await makeHandlers(ctx).create_standalone_task({
      title: 'Clear agent',
      description: 'Remove worker agent',
    });
    const taskId = JSON.parse(createResult.content[0].text).task.id;

    const result = await makeHandlers(ctx).reassign_task({
      task_id: taskId,
      custom_agent_id: null,
    });
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.success).toBe(true);
    expect(parsed.task.id).toBe(taskId);
  });

  test('returns error when custom_agent_id does not exist', async () => {
    const createResult = await makeHandlers(ctx).create_standalone_task({
      title: 'Task',
      description: 'Desc',
    });
    const taskId = JSON.parse(createResult.content[0].text).task.id;

    const result = await makeHandlers(ctx).reassign_task({
      task_id: taskId,
      custom_agent_id: 'agent-does-not-exist',
    });
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.success).toBe(false);
    expect(parsed.error).toContain('agent-does-not-exist');
  });

  test('returns error when task is in_progress', async () => {
    const createResult = await makeHandlers(ctx).create_standalone_task({
      title: 'Active task',
      description: 'Currently running',
    });
    const taskId = JSON.parse(createResult.content[0].text).task.id;
    await ctx.taskManager.startTask(taskId);

    const result = await makeHandlers(ctx).reassign_task({
      task_id: taskId,
      assigned_agent: 'general',
    });
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.success).toBe(false);
    expect(parsed.error).toContain('in_progress');
  });

  test('returns error when task not found', async () => {
    const result = await makeHandlers(ctx).reassign_task({
      task_id: 'task-missing',
      assigned_agent: 'general',
    });
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.success).toBe(false);
    expect(parsed.error).toContain('task-missing');
  });

  test('reassigns a needs_attention task successfully', async () => {
    const createResult = await makeHandlers(ctx).create_standalone_task({
      title: 'Failed task',
      description: 'Failed and reassign',
    });
    const taskId = JSON.parse(createResult.content[0].text).task.id;
    await ctx.taskManager.startTask(taskId);
    await ctx.taskManager.failTask(taskId, 'Error');

    const result = await makeHandlers(ctx).reassign_task({
      task_id: taskId,
      custom_agent_id: ctx.agentId,
    });
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.success).toBe(true);
    expect(parsed.task.id).toBe(taskId);
  });
});

// ---------------------------------------------------------------------------
// M5.3 — Task creation and workflow activation
// ---------------------------------------------------------------------------

describe('createSpaceAgentToolHandlers — task creation and planning node activation (M5.3)', () => {
  let ctx: TestCtx;
  beforeEach(() => {
    ctx = makeCtx();
  });
  afterEach(() => {
    ctx.db.close();
  });

  test('create_standalone_task creates task with pending status (clear request)', async () => {
    const result = await makeHandlers(ctx).create_standalone_task({
      title: 'Fix the login bug where international users cannot authenticate',
      description: 'Fix authentication failure for international card payments',
    });
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.success).toBe(true);
    expect(parsed.task.status).toBe('open');
    expect(parsed.task.workflowRunId ?? null).toBeNull();
  });

  test('create_standalone_task task persists to DB and is retrievable', async () => {
    const result = await makeHandlers(ctx).create_standalone_task({
      title: 'Add JWT auth',
      description: 'Implement user authentication with JWT tokens',
    });
    const taskId = JSON.parse(result.content[0].text).task.id;
    const stored = ctx.taskRepo.getTask(taskId);
    expect(stored).not.toBeNull();
    expect(stored?.title).toBe('Add JWT auth');
    expect(stored?.status).toBe('open');
  });

  test('start_workflow_run with planning start node creates task with planning taskType', async () => {
    // Seed a planner agent for the planning step
    seedAgentRow(ctx.db, 'agent-planner-1', ctx.spaceId, 'Planner');

    const stepId = 'planning-step-1';
    const wf = ctx.workflowManager.createWorkflow({
      spaceId: ctx.spaceId,
      name: 'Plan-first Workflow',
      description: 'Workflow with planning start node',
      nodes: [{ id: stepId, name: 'Planning', agentId: 'agent-planner-1' }],
      transitions: [],
      startNodeId: stepId,
      rules: [],
      tags: ['coding', 'v2'],
      completionAutonomyLevel: 3,
    });

    const result = await startWorkflowRun(ctx, {
      workflow_id: wf.id,
      title: 'Implement payment system',
      description: 'Build a secure payment processing module',
    });
    const parsed = JSON.parse(result.content[0].text);

    expect(parsed.success).toBe(true);
    expect(parsed.tasks).toHaveLength(1);
    // taskType and workflowNodeId removed in M71 — verify task is created and has open status
    expect(parsed.tasks[0].status).toBe('open');
  });

  test('start_workflow_run with V2 planning workflow stores run in DB', async () => {
    seedAgentRow(ctx.db, 'agent-planner-2', ctx.spaceId, 'Planner');

    const stepId = 'v2-planning-step';
    const wf = ctx.workflowManager.createWorkflow({
      spaceId: ctx.spaceId,
      name: 'Planning Workflow',
      description: 'Planning workflow with parallel plan review',
      nodes: [{ id: stepId, name: 'Planning', agentId: 'agent-planner-2' }],
      transitions: [],
      startNodeId: stepId,
      rules: [],
      tags: ['planning', 'decomposition'],
      completionAutonomyLevel: 3,
    });

    await startWorkflowRun(ctx, {
      workflow_id: wf.id,
      title: 'Implement authentication system',
    });

    const runs = ctx.workflowRunRepo.listBySpace(ctx.spaceId);
    expect(runs).toHaveLength(1);
    expect(runs[0].status).toBe('in_progress');

    const tasks = ctx.taskRepo.listByWorkflowRun(runs[0].id);
    expect(tasks).toHaveLength(1);
    // taskType removed in M71 — verify task is created
    expect(tasks[0].status).toBe('open');
  });

  test('suggest_workflow surfaces every workflow so the LLM can choose', async () => {
    // Post-refactor behavior: suggest_workflow no longer keyword-ranks.
    // The whole catalogue is returned in creation order so the caller's
    // LLM is not biased by substring overlap with the task description.
    buildSingleStepWorkflow(
      ctx.spaceId,
      ctx.workflowManager,
      ctx.agentId,
      'Coding Workflow',
      ['coding', 'default'],
      'For writing code'
    );
    buildSingleStepWorkflow(
      ctx.spaceId,
      ctx.workflowManager,
      ctx.agentId,
      'Planning Workflow',
      ['planning', 'decomposition'],
      'Planning with parallel plan review and task fan-out'
    );

    const result = await makeHandlers(ctx).suggest_workflow({
      description: 'implement authentication system with JWT tokens',
    });
    const parsed = JSON.parse(result.content[0].text);

    expect(parsed.success).toBe(true);
    expect(parsed.workflows).toHaveLength(2);
    const names = parsed.workflows.map((w: { name: string }) => w.name).sort();
    expect(names).toEqual(['Coding Workflow', 'Planning Workflow']);
  });
});

// ---------------------------------------------------------------------------
// list_tasks — search, pagination, compact mode, total
// ---------------------------------------------------------------------------

describe('createSpaceAgentToolHandlers — list_tasks search/pagination/compact', () => {
  let ctx: TestCtx;
  beforeEach(() => {
    ctx = makeCtx();
  });
  afterEach(() => {
    ctx.db.close();
  });

  test('returns total count in response', async () => {
    const wf = buildSingleStepWorkflow(ctx.spaceId, ctx.workflowManager, ctx.agentId, 'WF');
    await startWorkflowRun(ctx, { workflow_id: wf.id, title: 'run 1' });
    await startWorkflowRun(ctx, { workflow_id: wf.id, title: 'run 2' });

    const result = await makeHandlers(ctx).list_tasks({});
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.success).toBe(true);
    expect(parsed.total).toBe(2);
    expect(parsed.tasks).toHaveLength(2);
  });

  test('filters tasks by search substring', async () => {
    const wf = buildSingleStepWorkflow(ctx.spaceId, ctx.workflowManager, ctx.agentId, 'WF');
    const r1 = await startWorkflowRun(ctx, { workflow_id: wf.id, title: 'run 1' });
    const r2 = await startWorkflowRun(ctx, { workflow_id: wf.id, title: 'run 2' });
    const task1Id = JSON.parse(r1.content[0].text).tasks[0].id;
    const task2Id = JSON.parse(r2.content[0].text).tasks[0].id;

    // Rename one task to have a unique searchable title
    ctx.taskRepo.updateTask(task1Id, { title: 'Review PR #42' });
    ctx.taskRepo.updateTask(task2Id, { title: 'Deploy service' });

    const result = await makeHandlers(ctx).list_tasks({ search: 'Review' });
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.success).toBe(true);
    expect(parsed.total).toBe(1);
    expect(parsed.tasks).toHaveLength(1);
    expect(parsed.tasks[0].title).toBe('Review PR #42');
  });

  test('paginates with limit and offset', async () => {
    const wf = buildSingleStepWorkflow(ctx.spaceId, ctx.workflowManager, ctx.agentId, 'WF');
    for (let i = 0; i < 4; i++) {
      await startWorkflowRun(ctx, { workflow_id: wf.id, title: `run ${i + 1}` });
    }

    const page1 = JSON.parse(
      (await makeHandlers(ctx).list_tasks({ limit: 2, offset: 0 })).content[0].text
    );
    expect(page1.total).toBe(4);
    expect(page1.tasks).toHaveLength(2);

    const page2 = JSON.parse(
      (await makeHandlers(ctx).list_tasks({ limit: 2, offset: 2 })).content[0].text
    );
    expect(page2.total).toBe(4);
    expect(page2.tasks).toHaveLength(2);
  });

  test('returns compact fields when compact:true', async () => {
    const wf = buildSingleStepWorkflow(ctx.spaceId, ctx.workflowManager, ctx.agentId, 'WF');
    await startWorkflowRun(ctx, { workflow_id: wf.id, title: 'run 1' });

    const result = await makeHandlers(ctx).list_tasks({ compact: true });
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.success).toBe(true);
    expect(parsed.total).toBe(1);
    const task = parsed.tasks[0] as Record<string, unknown>;
    // Compact fields present
    expect(task.id).toBeDefined();
    expect(task.title).toBeDefined();
    expect(task.status).toBeDefined();
    expect(task.priority).toBeDefined();
    expect(task.createdAt).toBeDefined();
    // Large fields excluded
    expect(task.workflowRunId).toBeUndefined();
    expect(task.description).toBeUndefined();
  });

  test('total reflects post-filter count before pagination', async () => {
    const wf = buildSingleStepWorkflow(ctx.spaceId, ctx.workflowManager, ctx.agentId, 'WF');
    for (let i = 0; i < 4; i++) {
      const r = await startWorkflowRun(ctx, {
        workflow_id: wf.id,
        title: `run ${i + 1}`,
      });
      const taskId = JSON.parse(r.content[0].text).tasks[0].id;
      if (i < 2) {
        ctx.taskRepo.updateTask(taskId, { title: `Match task ${i}` });
      } else {
        ctx.taskRepo.updateTask(taskId, { title: `Other task ${i}` });
      }
    }

    const result = await makeHandlers(ctx).list_tasks({ search: 'Match', limit: 1, offset: 0 });
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.total).toBe(2); // 2 match, even though only 1 returned
    expect(parsed.tasks).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// approve_task — plain review→done / review→approved path
// ---------------------------------------------------------------------------
//
// The completion-action approval MCP tool was deleted in PR 4/5 together with
// the completion-action runtime pipeline. PR 5/5 (migration M104) further
// rewrote any residual stuck rows into `task_completion` and tightened the
// `pendingCheckpointType` CHECK constraint, so the legacy variant no longer
// round-trips through the MCP surface.

describe('createSpaceAgentToolHandlers — approve_task plain path', () => {
  let ctx: TestCtx;
  beforeEach(() => {
    ctx = makeCtx();
  });
  afterEach(() => {
    ctx.db.close();
  });

  test('allows plain review→done approvals with sufficient autonomy', async () => {
    await ctx.spaceManager.updateSpace(ctx.spaceId, { autonomyLevel: 5 });
    const createResult = await makeHandlers(ctx).create_standalone_task({
      title: 'plain review task',
      description: 'no pending action',
    });
    const taskId = JSON.parse(createResult.content[0].text).task.id;
    // Plain review (pendingCheckpointType is null) — approve_task proceeds.
    ctx.taskRepo.updateTask(taskId, { status: 'review' });

    const result = await makeHandlers(ctx).approve_task({
      task_id: taskId,
      reason: 'looks good',
    });
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.success).toBe(true);
    expect(parsed.task.status).toBe('done');
  });

  test('falls back to reported summary when review approval result is generic', async () => {
    await ctx.spaceManager.updateSpace(ctx.spaceId, { autonomyLevel: 5 });
    const createResult = await makeHandlers(ctx).create_standalone_task({
      title: 'plain review task',
      description: 'no pending action',
    });
    const taskId = JSON.parse(createResult.content[0].text).task.id;
    ctx.taskRepo.updateTask(taskId, {
      status: 'review',
      result:
        'An unexpected error occurred. Please try again or contact support if the issue persists.',
      reportedSummary: 'PR #2007 merged to dev via squash merge.',
    });

    const result = await makeHandlers(ctx).approve_task({
      task_id: taskId,
      reason: 'looks good',
    });

    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.success).toBe(true);
    expect(parsed.task.status).toBe('done');
    expect(parsed.task.result).toBe('PR #2007 merged to dev via squash merge.');
    expect(ctx.taskRepo.getTask(taskId)?.result).toBe('PR #2007 merged to dev via squash merge.');
  });

  test('publishes space.task.updated for cascaded dependent tasks', async () => {
    await ctx.spaceManager.updateSpace(ctx.spaceId, { autonomyLevel: 5 });
    const task = await ctx.taskManager.createTask({
      title: 'plain review task',
      description: 'no pending action',
    });
    ctx.taskRepo.updateTask(task.id, { status: 'review' });
    const cascadedTask: SpaceTask = {
      ...task,
      id: 'dependent-task',
      status: 'open',
      dependsOn: [task.id],
    };
    const updatedTask: SpaceTask = { ...task, status: 'done' };
    const emitted: Array<Record<string, unknown>> = [];
    const mockBus = {
      publish: mock(async (event: string, payload: Record<string, unknown>) => {
        if (event === 'space.task.updated') emitted.push(payload);
      }),
    };
    const setTaskStatus = mock(async (_taskId, _status, options) => {
      await options?.onCascadedTasks?.([cascadedTask]);
      return updatedTask;
    });
    const handlers = createSpaceAgentToolHandlers({
      spaceId: ctx.spaceId,
      runtime: ctx.runtime,
      workflowManager: ctx.workflowManager,
      taskRepo: ctx.taskRepo,
      workflowRunRepo: ctx.workflowRunRepo,
      taskManager: {
        setTaskStatus,
      } as unknown as SpaceTaskManager,
      spaceAgentManager: ctx.agentManager,
      nodeExecutionRepo: ctx.nodeExecutionRepo,
      spaceManager: ctx.spaceManager,
      internalEventBus:
        mockBus as unknown as import('../../../../src/lib/internal-event-bus').InternalEventBus<
          import('../../../../src/lib/internal-event-bus').DaemonInternalEventMap
        >,
    });

    await handlers.approve_task({ task_id: task.id, reason: 'looks good' });

    expect(emitted.map((payload) => payload.taskId)).toEqual([cascadedTask.id, task.id]);
    expect(setTaskStatus).toHaveBeenCalledWith(
      task.id,
      'done',
      expect.objectContaining({ onCascadedTasks: expect.any(Function) })
    );
  });
});

// ---------------------------------------------------------------------------
// approve_pending_completion — human-approval path (coordinator / task-agent)
// ---------------------------------------------------------------------------
//
// MCP surface for the coordinator to trigger the human-approval path that the
// UI "Approve" banner fires via the `spaceTask.approvePendingCompletion` RPC.
// Restricted to coordinator / task-agent callers; worker node agents self-close
// via approve_task. NOT autonomy-gated — it routes an explicit human decision.

describe('createSpaceAgentToolHandlers — approve_pending_completion', () => {
  let ctx: TestCtx;
  beforeEach(() => {
    ctx = makeCtx();
  });
  afterEach(() => {
    ctx.db.close();
  });

  /** Create a task and submit it for review (status=review, checkpoint=task_completion). */
  async function createReviewTask(title = 'pending completion task'): Promise<string> {
    const task = await ctx.taskManager.createTask({
      title,
      description: 'awaiting human sign-off',
    });
    await ctx.taskManager.submitTaskForReview(task.id, {
      submittedByNodeId: null,
      reason: 'ready for review',
    });
    return task.id;
  }

  test('approve: transitions review → approved and dispatches post-approval with the human source', async () => {
    const taskId = await createReviewTask();

    const dispatchCalls: Array<{ taskId: string; source: unknown; extras: unknown }> = [];
    const dispatchSpy = spyOn(ctx.runtime, 'dispatchPostApproval').mockImplementation(
      async (id: string, source, extras) => {
        dispatchCalls.push({ taskId: id, source, extras });
        // Simulate the runtime's review → approved transition (stamps the
        // approval metadata the real dispatchPostApproval writes).
        ctx.taskRepo.updateTask(id, {
          status: 'approved',
          approvalSource: 'human',
          approvalReason: (extras as { approvalReason?: string | null })?.approvalReason ?? null,
          pendingCheckpointType: null,
        });
      }
    );

    const result = await makeHandlers(ctx, {
      callerRole: 'coordinator',
    }).approve_pending_completion({ task_id: taskId, approved: true, reason: 'ship it' });
    dispatchSpy.mockRestore();

    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.success).toBe(true);
    expect(parsed.task.status).toBe('approved');
    expect(parsed.task.approvalSource).toBe('human');
    expect(parsed.task.approvalReason).toBe('ship it');
    expect(dispatchCalls).toEqual([
      { taskId, source: 'human', extras: { approvalReason: 'ship it' } },
    ]);
  });

  test('approve: Layer C — a post-dispatch throw after the status commit is captured, not propagated', async () => {
    const taskId = await createReviewTask();

    const dispatchSpy = spyOn(ctx.runtime, 'dispatchPostApproval').mockImplementation(
      async (id: string) => {
        // Status commits inside dispatch, THEN the post-approval step throws.
        ctx.taskRepo.updateTask(id, { status: 'approved' });
        throw new Error('user interrupted');
      }
    );

    const result = await makeHandlers(ctx, {
      callerRole: 'coordinator',
    }).approve_pending_completion({ task_id: taskId, approved: true });
    dispatchSpy.mockRestore();

    const parsed = JSON.parse(result.content[0].text);
    // The approval is durable — success, status approved — and the raw
    // "user interrupted" is mapped to a recovery-oriented blocked reason.
    expect(parsed.success).toBe(true);
    expect(parsed.task.status).toBe('approved');
    expect(parsed.task.postApprovalBlockedReason).toContain('Approval recorded');
    expect(parsed.task.postApprovalBlockedReason).toContain('interrupted');
    expect(ctx.taskRepo.getTask(taskId)?.postApprovalBlockedReason).toContain('Approval recorded');
  });

  test('approve: a dispatch failure before the status commit is propagated as an error', async () => {
    const taskId = await createReviewTask();

    const dispatchSpy = spyOn(ctx.runtime, 'dispatchPostApproval').mockImplementation(async () => {
      // Transition never happens — the raw error must surface.
      throw new Error('transition rejected');
    });

    const result = await makeHandlers(ctx, {
      callerRole: 'coordinator',
    }).approve_pending_completion({ task_id: taskId, approved: true });
    dispatchSpy.mockRestore();

    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.success).toBe(false);
    expect(parsed.error).toContain('transition rejected');
    expect(ctx.taskRepo.getTask(taskId)?.status).toBe('review');
  });

  test('reject: transitions review → in_progress, stamps approvalReason, does NOT dispatch', async () => {
    const taskId = await createReviewTask();

    const dispatchSpy = spyOn(ctx.runtime, 'dispatchPostApproval').mockResolvedValue({
      mode: 'skipped',
      reason: 'must not be called on reject',
    });

    const result = await makeHandlers(ctx, {
      callerRole: 'coordinator',
    }).approve_pending_completion({ task_id: taskId, approved: false, reason: 'needs rework' });
    dispatchSpy.mockRestore();

    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.success).toBe(true);
    expect(parsed.task.status).toBe('in_progress');
    expect(parsed.task.approvalReason).toBe('needs rework');
    // Rejecting clears the pending-completion checkpoint (exit-review cleanup).
    expect(parsed.task.pendingCheckpointType).toBeNull();
    expect(dispatchSpy).not.toHaveBeenCalled();
  });

  test('reject without a reason stamps null approvalReason', async () => {
    const taskId = await createReviewTask();
    const dispatchSpy = spyOn(ctx.runtime, 'dispatchPostApproval');

    const result = await makeHandlers(ctx, {
      callerRole: 'coordinator',
    }).approve_pending_completion({ task_id: taskId, approved: false });
    dispatchSpy.mockRestore();

    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.success).toBe(true);
    expect(parsed.task.status).toBe('in_progress');
    expect(parsed.task.approvalReason).toBeNull();
    expect(dispatchSpy).not.toHaveBeenCalled();
  });

  test('wrong checkpoint: refuses a task not paused at task_completion', async () => {
    const task = await ctx.taskManager.createTask({
      title: 'plain review',
      description: 'no checkpoint',
    });
    // review with no pending checkpoint (pendingCheckpointType is null).
    ctx.taskRepo.updateTask(task.id, { status: 'review' });

    const dispatchSpy = spyOn(ctx.runtime, 'dispatchPostApproval');
    const result = await makeHandlers(ctx, {
      callerRole: 'coordinator',
    }).approve_pending_completion({ task_id: task.id, approved: true });
    dispatchSpy.mockRestore();

    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.success).toBe(false);
    expect(parsed.error).toContain('not awaiting submit_for_approval review');
    expect(parsed.error).toContain(task.id);
    expect(dispatchSpy).not.toHaveBeenCalled();
  });

  test('wrong status: refuses a task_completion task that is not in review', async () => {
    const task = await ctx.taskManager.createTask({
      title: 'still in progress',
      description: 'checkpoint but not review',
    });
    // Stamp the checkpoint without flipping to review — the status guard fires.
    ctx.taskRepo.updateTask(task.id, {
      status: 'in_progress',
      pendingCheckpointType: 'task_completion',
    });

    const dispatchSpy = spyOn(ctx.runtime, 'dispatchPostApproval');
    const result = await makeHandlers(ctx, {
      callerRole: 'coordinator',
    }).approve_pending_completion({ task_id: task.id, approved: true });
    dispatchSpy.mockRestore();

    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.success).toBe(false);
    expect(parsed.error).toContain("not in 'review' status");
    expect(parsed.error).toContain('in_progress');
    expect(dispatchSpy).not.toHaveBeenCalled();
  });

  test('worker node agent is rejected and pointed to approve_task', async () => {
    const taskId = await createReviewTask();
    const dispatchSpy = spyOn(ctx.runtime, 'dispatchPostApproval');

    const result = await makeHandlers(ctx, {
      callerRole: 'workflow_worker',
    }).approve_pending_completion({ task_id: taskId, approved: true });
    dispatchSpy.mockRestore();

    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.success).toBe(false);
    expect(parsed.error).toContain('approve_task');
    expect(dispatchSpy).not.toHaveBeenCalled();
  });

  test('omitted callerRole (default) is rejected', async () => {
    const taskId = await createReviewTask();
    const dispatchSpy = spyOn(ctx.runtime, 'dispatchPostApproval');

    // No callerRole override → undefined → rejected. Only coordinator /
    // legacy_task_agent may call; members and long-term agents may not.
    const result = await makeHandlers(ctx).approve_pending_completion({
      task_id: taskId,
      approved: true,
    });
    dispatchSpy.mockRestore();

    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.success).toBe(false);
    expect(parsed.error).toContain('approve_task');
  });

  test('task-agent caller role is allowed', async () => {
    const taskId = await createReviewTask();
    const dispatchSpy = spyOn(ctx.runtime, 'dispatchPostApproval').mockImplementation(
      async (id: string) => {
        ctx.taskRepo.updateTask(id, { status: 'approved', approvalSource: 'human' });
      }
    );

    const result = await makeHandlers(ctx, {
      callerRole: 'legacy_task_agent',
    }).approve_pending_completion({ task_id: taskId, approved: true });
    dispatchSpy.mockRestore();

    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.success).toBe(true);
    expect(parsed.task.status).toBe('approved');
  });

  test('task belonging to another space is refused', async () => {
    const taskId = await createReviewTask();
    const dispatchSpy = spyOn(ctx.runtime, 'dispatchPostApproval');

    const result = await makeHandlers(ctx, {
      callerRole: 'coordinator',
      spaceId: 'other-space',
    }).approve_pending_completion({ task_id: taskId, approved: true });
    dispatchSpy.mockRestore();

    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.success).toBe(false);
    expect(parsed.error).toContain('does not belong');
  });
});

// ---------------------------------------------------------------------------
// complete_validation_task — validation-only (no-PR) completion path
// ---------------------------------------------------------------------------
//
// The agent-reachable equivalent of the UI's direct status→done transition for
// a no-code task. Mirrors approve_task's autonomy framing but is the explicit
// no-PR path: it captures the validation outcome as task.result and transitions
// review/in_progress → done without requiring a pr_url. Complements
// approve_task (PR-oriented, review-only) and approve_pending_completion
// (human-approval path) — neither of which is reachable for a Forge review /
// automation task that never produced a PR.

describe('createSpaceAgentToolHandlers — complete_validation_task', () => {
  let ctx: TestCtx;
  beforeEach(() => {
    ctx = makeCtx();
  });
  afterEach(() => {
    ctx.db.close();
  });

  async function createTask(status: 'review' | 'in_progress'): Promise<string> {
    await ctx.spaceManager.updateSpace(ctx.spaceId, { autonomyLevel: 5 });
    const createResult = await makeHandlers(ctx).create_standalone_task({
      title: 'Forge review task',
      description: 'no-code validation task',
    });
    const taskId = JSON.parse(createResult.content[0].text).task.id;
    ctx.taskRepo.updateTask(taskId, { status });
    return taskId;
  }

  // Build a task whose workflow run declares a completion autonomy level, so
  // the gate is exercised against a real workflow (mirrors the approve_task
  // autonomy tests).
  function createWorkflowTask(
    requiredLevel: number,
    overrides: { status?: 'review' | 'in_progress' } = {}
  ): SpaceTask {
    const nodeId = `node-${Math.random().toString(36).slice(2)}`;
    const workflow = ctx.workflowManager.createWorkflow({
      spaceId: ctx.spaceId,
      name: `Validation gated workflow ${requiredLevel}`,
      description: '',
      nodes: [{ id: nodeId, name: 'Review', agentId: ctx.agentId }],
      transitions: [],
      startNodeId: nodeId,
      endNodeId: nodeId,
      rules: [],
      completionAutonomyLevel: requiredLevel,
    });
    const run = ctx.workflowRunRepo.createRun({
      spaceId: ctx.spaceId,
      workflowId: workflow.id,
      title: 'Validation gated run',
      description: '',
    });
    return ctx.taskRepo.createTask({
      spaceId: ctx.spaceId,
      title: 'Validation task',
      description: '',
      status: overrides.status ?? 'in_progress',
      workflowRunId: run.id,
    });
  }

  test('completes a no-PR task in review → done and captures the validation outcome', async () => {
    const taskId = await createTask('review');

    const result = await makeHandlers(ctx).complete_validation_task({
      task_id: taskId,
      validation_outcome: 'Reviewed 3 episodes; all evidence scoped correctly.',
      reason: 'weekly self_nag',
    });
    const parsed = JSON.parse(result.content[0].text);

    expect(parsed.success).toBe(true);
    expect(parsed.task.status).toBe('done');
    expect(parsed.task.result).toBe('Reviewed 3 episodes; all evidence scoped correctly.');
    // review → done stamps approvalSource 'agent'.
    expect(parsed.task.approvalSource).toBe('agent');
    expect(ctx.taskRepo.getTask(taskId)?.result).toBe(
      'Reviewed 3 episodes; all evidence scoped correctly.'
    );
  });

  test('completes a no-PR task in_progress → done', async () => {
    const taskId = await createTask('in_progress');

    const result = await makeHandlers(ctx).complete_validation_task({
      task_id: taskId,
      validation_outcome: 'Diagnostic: no regression found in CI shard 4.',
    });
    const parsed = JSON.parse(result.content[0].text);

    expect(parsed.success).toBe(true);
    expect(parsed.task.status).toBe('done');
    expect(parsed.task.result).toBe('Diagnostic: no regression found in CI shard 4.');
    expect(ctx.taskRepo.getTask(taskId)?.status).toBe('done');
  });

  test('rejects when space autonomy is below workflow completionAutonomyLevel', async () => {
    await ctx.spaceManager.updateSpace(ctx.spaceId, { autonomyLevel: 3 });
    const task = createWorkflowTask(5);

    const result = await makeHandlers(ctx).complete_validation_task({
      task_id: task.id,
      validation_outcome: 'validated',
    });
    const parsed = JSON.parse(result.content[0].text);

    expect(parsed.success).toBe(false);
    expect(parsed.error).toContain('complete_validation_task not permitted');
    expect(parsed.error).toContain('space autonomy level 3 < workflow completionAutonomyLevel 5');
    // Task is unchanged.
    expect(ctx.taskRepo.getTask(task.id)?.status).toBe('in_progress');
  });

  test('allows completion when space autonomy meets workflow completionAutonomyLevel', async () => {
    await ctx.spaceManager.updateSpace(ctx.spaceId, { autonomyLevel: 5 });
    const task = createWorkflowTask(5);

    const result = await makeHandlers(ctx).complete_validation_task({
      task_id: task.id,
      validation_outcome: 'Validation passed; no code change required.',
    });
    const parsed = JSON.parse(result.content[0].text);

    expect(parsed.success).toBe(true);
    expect(parsed.task.status).toBe('done');
    expect(parsed.task.result).toBe('Validation passed; no code change required.');
  });

  test('rejects a task whose workflow run already has a PR', async () => {
    await ctx.spaceManager.updateSpace(ctx.spaceId, { autonomyLevel: 5 });
    const task = createWorkflowTask(5, { status: 'review' });
    // The run records a primary link (PR) — the task is PR-bound.
    const prSpy = spyOn(ctx.runtime, 'getApprovedPrUrlForRun').mockReturnValue(
      'https://github.com/owner/repo/pull/123'
    );

    const result = await makeHandlers(ctx).complete_validation_task({
      task_id: task.id,
      validation_outcome: 'should not reach here',
    });
    prSpy.mockRestore();

    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.success).toBe(false);
    expect(parsed.error).toContain('has a PR');
    expect(parsed.error).toContain('https://github.com/owner/repo/pull/123');
    expect(ctx.taskRepo.getTask(task.id)?.status).toBe('review');
  });

  test('rejects tasks in ineligible statuses', async () => {
    await ctx.spaceManager.updateSpace(ctx.spaceId, { autonomyLevel: 5 });
    const createResult = await makeHandlers(ctx).create_standalone_task({
      title: 'open task',
      description: 'not started',
    });
    const taskId = JSON.parse(createResult.content[0].text).task.id;
    // Newly created task is `open`.
    expect(ctx.taskRepo.getTask(taskId)?.status).toBe('open');

    const result = await makeHandlers(ctx).complete_validation_task({
      task_id: taskId,
      validation_outcome: 'validated',
    });
    const parsed = JSON.parse(result.content[0].text);

    expect(parsed.success).toBe(false);
    expect(parsed.error).toContain("'open' status");
  });

  test('rejects an empty validation outcome', async () => {
    const taskId = await createTask('in_progress');

    const result = await makeHandlers(ctx).complete_validation_task({
      task_id: taskId,
      validation_outcome: '   ',
    });
    const parsed = JSON.parse(result.content[0].text);

    expect(parsed.success).toBe(false);
    expect(parsed.error).toContain('validation_outcome is required');
    expect(ctx.taskRepo.getTask(taskId)?.status).toBe('in_progress');
  });

  test('rejects a task that does not belong to this space', async () => {
    const taskId = await createTask('in_progress');

    const result = await makeHandlers(ctx, { spaceId: 'other-space' }).complete_validation_task({
      task_id: taskId,
      validation_outcome: 'validated',
    });
    const parsed = JSON.parse(result.content[0].text);

    expect(parsed.success).toBe(false);
    expect(parsed.error).toContain('does not belong');
  });

  test('rejects an unknown task id', async () => {
    const result = await makeHandlers(ctx).complete_validation_task({
      task_id: 'nonexistent-task',
      validation_outcome: 'validated',
    });
    const parsed = JSON.parse(result.content[0].text);

    expect(parsed.success).toBe(false);
    expect(parsed.error).toContain('Task not found');
  });
});

// ---------------------------------------------------------------------------
// send_message_to_task — node targeting, auto-spawn, task_number resolution
// ---------------------------------------------------------------------------

interface FakeTaskAgentManager {
  manager: TaskAgentManager;
  subSessionInjects: Array<{
    sessionId: string;
    message: string;
    isSyntheticMessage?: boolean;
    sdkMessageId: string;
  }>;
  /** Session IDs that should throw `Sub-session not found` on inject. */
  deadSessionIds: Set<string>;
  /** Hook invoked before ensureTaskAgentSession resolves. Allows simulating
   *  side-effects such as assigning a taskAgentSessionId. */
  onEnsure?: (taskId: string) => Promise<void> | void;
}

function makeFakeTaskAgentManager(ctx: TestCtx): FakeTaskAgentManager {
  const state: Omit<FakeTaskAgentManager, 'manager'> = {
    subSessionInjects: [],
    deadSessionIds: new Set(),
  };
  const manager = {
    async injectSubSessionMessage(
      sessionId: string,
      message: string,
      isSyntheticMessage?: boolean
    ): Promise<string> {
      if (state.deadSessionIds.has(sessionId)) {
        throw new Error(`Sub-session not found: ${sessionId}`);
      }
      const sdkMessageId = `sdk-message-${state.subSessionInjects.length}`;
      state.subSessionInjects.push({ sessionId, message, isSyntheticMessage, sdkMessageId });
      return sdkMessageId;
    },
  } as unknown as TaskAgentManager;
  return { manager, ...state };
}

describe('createSpaceAgentToolHandlers — send_message_to_task', () => {
  let ctx: TestCtx;
  beforeEach(() => {
    ctx = makeCtx();
  });
  afterEach(() => {
    ctx.db.close();
  });

  async function createTask(title = 'Test Task'): Promise<SpaceTask> {
    const created = await ctx.taskManager.createTask({
      title,
      description: 'desc',
      priority: 'normal',
    });
    return created;
  }

  function spaceAgentToNodeEnvelope(
    task: SpaceTask,
    message: string,
    nodeId?: string | null
  ): string {
    return formatAgentMessage({
      fromLevel: 'space-agent',
      fromAgentName: 'space-agent',
      toLevel: 'node-agent',
      body: message,
      taskId: task.id,
      taskNumber: task.taskNumber,
      nodeId,
    });
  }

  interface FakePendingMessageQueue {
    enqueued: Array<{
      workflowRunId: string;
      spaceId: string;
      taskId?: string | null;
      sourceAgentName?: string;
      targetKind: 'node_agent' | 'space_agent';
      targetAgentName: string;
      message: string;
      idempotencyKey?: string | null;
    }>;
  }

  function makeFakePendingMessageQueue(): FakePendingMessageQueue {
    return { enqueued: [] };
  }

  function parseAuditSummaries(auditLogRepo: McpAuditLogRepository, taskId: string) {
    return auditLogRepo
      .listByTask(taskId)
      .map((entry) => JSON.parse(entry.paramsSummary ?? '{}') as Record<string, unknown>);
  }

  function makeHandlersWith(
    tam: FakeTaskAgentManager,
    opts: {
      activateNode?: (runId: string, nodeId: string) => Promise<void>;
      pendingMessageQueue?: FakePendingMessageQueue;
      myAgentName?: string;
      myAgentNameAliases?: string[];
      mySessionId?: string;
      auditLogRepo?: McpAuditLogRepository;
      messageResolver?: Parameters<typeof createSpaceAgentToolHandlers>[0]['messageResolver'];
      longTermAgentDelivery?: Parameters<
        typeof createSpaceAgentToolHandlers
      >[0]['longTermAgentDelivery'];
    } = {}
  ) {
    const fakeQueue = opts.pendingMessageQueue;
    return createSpaceAgentToolHandlers({
      spaceId: ctx.spaceId,
      runtime: ctx.runtime,
      workflowManager: ctx.workflowManager,
      taskRepo: ctx.taskRepo,
      workflowRunRepo: ctx.workflowRunRepo,
      taskManager: ctx.taskManager,
      spaceAgentManager: ctx.agentManager,
      nodeExecutionRepo: ctx.nodeExecutionRepo,
      longHorizonAgentRepo: ctx.longHorizonAgentRepo,
      taskAgentManager: tam.manager,
      activateNode: opts.activateNode,
      myAgentName: opts.myAgentName,
      myAgentNameAliases: opts.myAgentNameAliases,
      mySessionId: opts.mySessionId,
      auditLogRepo: opts.auditLogRepo,
      messageResolver: opts.messageResolver,
      longTermAgentDelivery: opts.longTermAgentDelivery,
      pendingMessageQueue: fakeQueue
        ? {
            enqueue(input) {
              const index = fakeQueue.enqueued.length;
              fakeQueue.enqueued.push(input);
              return {
                record: { id: `pending-message-${index}` },
                deduped: false,
              };
            },
          }
        : undefined,
      messageResolver: opts.messageResolver,
      longTermAgentDelivery: opts.longTermAgentDelivery,
    });
  }

  test('returns an error when the task agent manager is unavailable', async () => {
    const handlers = createSpaceAgentToolHandlers({
      spaceId: ctx.spaceId,
      runtime: ctx.runtime,
      workflowManager: ctx.workflowManager,
      taskRepo: ctx.taskRepo,
      workflowRunRepo: ctx.workflowRunRepo,
      taskManager: ctx.taskManager,
      spaceAgentManager: ctx.agentManager,
      nodeExecutionRepo: ctx.nodeExecutionRepo,
      // intentionally omitting taskAgentManager
    });
    const task = await createTask();
    const result = await handlers.send_message_to_task({
      task_id: task.id,
      message: 'hi',
    });
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.success).toBe(false);
    expect(parsed.error).toContain('Task agent communication');
  });

  test('returns an error when neither task_id nor task_number is provided', async () => {
    const tam = makeFakeTaskAgentManager(ctx);
    const result = await makeHandlersWith(tam).send_message_to_task({ message: 'hi' });
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.success).toBe(false);
    expect(parsed.error).toMatch(/task_id or task_number/);
  });

  test('returns error when no node_id is provided (task-agent removed)', async () => {
    const task = await createTask('Auto-spawn task');

    const tam = makeFakeTaskAgentManager(ctx);
    const result = await makeHandlersWith(tam).send_message_to_task({
      task_id: task.id,
      message: 'kick off work',
    });
    const parsed = JSON.parse(result.content[0].text);

    expect(parsed.success).toBe(false);
    expect(parsed.error).toMatch(/target agent is required/i);
  });
  test('returns error for done tasks when no node_id (task-agent removed)', async () => {
    const task = await createTask('Reopen task');
    ctx.taskRepo.updateTask(task.id, { status: 'done' });

    const tam = makeFakeTaskAgentManager(ctx);
    const result = await makeHandlersWith(tam).send_message_to_task({
      task_id: task.id,
      message: 'please revisit',
    });
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.success).toBe(false);
    expect(parsed.error).toMatch(/target agent is required/i);
  });

  test('returns an error when the task is archived', async () => {
    const task = await createTask('Archived task');
    ctx.taskRepo.updateTask(task.id, { status: 'archived' });

    const tam = makeFakeTaskAgentManager(ctx);

    const resultNoNode = await makeHandlersWith(tam).send_message_to_task({
      task_id: task.id,
      message: 'hello',
    });
    const parsedNoNode = JSON.parse(resultNoNode.content[0].text);
    expect(parsedNoNode.success).toBe(false);
    expect(parsedNoNode.error).toMatch(/archived/);

    const resultWithNode = await makeHandlersWith(tam).send_message_to_task({
      task_id: task.id,
      node_id: 'coder',
      message: 'hello',
    });
    const parsedWithNode = JSON.parse(resultWithNode.content[0].text);
    expect(parsedWithNode.success).toBe(false);
    expect(parsedWithNode.error).toMatch(/archived/);

    // Neither path should have touched the task agent.
    expect(tam.subSessionInjects).toHaveLength(0);
  });

  test('resolves task_number and returns error without node_id', async () => {
    const taskA = await createTask('task A');
    const taskB = await createTask('task B');
    expect(taskA.taskNumber).not.toBe(taskB.taskNumber);

    const tam = makeFakeTaskAgentManager(ctx);
    const result = await makeHandlersWith(tam).send_message_to_task({
      task_number: taskB.taskNumber,
      message: 'hi B',
    });
    const parsed = JSON.parse(result.content[0].text);
    // Resolves task_number to task_id but returns error because no node_id
    expect(parsed.success).toBe(false);
    expect(parsed.error).toMatch(/target agent is required/i);
  });

  test('returns an error when task_number does not match any task in this space', async () => {
    const tam = makeFakeTaskAgentManager(ctx);
    const result = await makeHandlersWith(tam).send_message_to_task({
      task_number: 99_999,
      message: 'hi',
    });
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.success).toBe(false);
    expect(parsed.error).toContain('99999');
  });

  test('ad-hoc sender uses routable session target in reply instructions', async () => {
    const wf = buildSingleStepWorkflow(ctx.spaceId, ctx.workflowManager, ctx.agentId, 'WF Session');
    const { tasks } = await ctx.runtime.startWorkflowRun(ctx.spaceId, wf.id, 'Session target');
    const task = tasks[0];
    ctx.nodeExecutionRepo.createOrIgnore({
      workflowRunId: task.workflowRunId,
      workflowNodeId: wf.startNodeId,
      agentName: 'coder',
      agentSessionId: 'coder-session-live',
      status: 'idle',
    });

    const tam = makeFakeTaskAgentManager(ctx);
    const handlers = makeHandlersWith(tam, {
      activateNode: async () => {},
      mySessionId: 'member-session-42',
    });

    await handlers.send_message_to_task({
      task_id: task.id,
      node_id: 'coder',
      message: 'ad-hoc question',
    });

    expect(tam.subSessionInjects[0]?.message).toContain('─── Message from space-member ───');
    expect(tam.subSessionInjects[0]?.message).toContain(
      'To reply, use: send_message with target "@session:member-session-42"'
    );
  });

  test('coordinator sender falls back to coordinator handle when no alias exists', async () => {
    const wf = buildSingleStepWorkflow(
      ctx.spaceId,
      ctx.workflowManager,
      ctx.agentId,
      'WF Coordinator'
    );
    const { tasks } = await ctx.runtime.startWorkflowRun(ctx.spaceId, wf.id, 'Coordinator target');
    const task = tasks[0];
    ctx.nodeExecutionRepo.createOrIgnore({
      workflowRunId: task.workflowRunId,
      workflowNodeId: wf.startNodeId,
      agentName: 'coder',
      agentSessionId: 'coder-session-live',
      status: 'idle',
    });

    const tam = makeFakeTaskAgentManager(ctx);
    const handlers = makeHandlersWith(tam, {
      activateNode: async () => {},
      myAgentName: 'space-agent',
    });

    await handlers.send_message_to_task({
      task_id: task.id,
      node_id: 'coder',
      message: 'check coordinator fallback',
    });

    expect(tam.subSessionInjects[0]?.message).toContain('─── Message from space-agent ───');
    expect(tam.subSessionInjects[0]?.message).toContain(
      'To reply, use: send_message with target "@coordinator"'
    );
    expect(tam.subSessionInjects[0]?.message).not.toContain('target "@space-agent"');
  });

  test('long-horizon sender uses canonical handle alias without double prefix', async () => {
    const wf = buildSingleStepWorkflow(ctx.spaceId, ctx.workflowManager, ctx.agentId, 'WF Handle');
    const { tasks } = await ctx.runtime.startWorkflowRun(ctx.spaceId, wf.id, 'Handle target');
    const task = tasks[0];
    ctx.nodeExecutionRepo.createOrIgnore({
      workflowRunId: task.workflowRunId,
      workflowNodeId: wf.startNodeId,
      agentName: 'coder',
      agentSessionId: 'coder-session-live',
      status: 'idle',
    });

    const tam = makeFakeTaskAgentManager(ctx);
    const handlers = makeHandlersWith(tam, {
      activateNode: async () => {},
      myAgentName: 'Coder',
      myAgentNameAliases: ['@coder-2'],
    });

    await handlers.send_message_to_task({
      task_id: task.id,
      node_id: 'coder',
      message: 'check routing',
    });

    expect(tam.subSessionInjects[0]?.message).toContain('─── Message from Coder ───');
    expect(tam.subSessionInjects[0]?.message).toContain(
      'To reply, use: send_message with target "@coder-2"'
    );
    expect(tam.subSessionInjects[0]?.message).not.toContain('@@coder-2');
    expect(tam.subSessionInjects[0]?.message).not.toContain('target "@coder"');
  });

  test('long-horizon sender falls back to display-name handle only when no alias exists', async () => {
    const wf = buildSingleStepWorkflow(ctx.spaceId, ctx.workflowManager, ctx.agentId, 'WF Slug');
    const { tasks } = await ctx.runtime.startWorkflowRun(ctx.spaceId, wf.id, 'Slug target');
    const task = tasks[0];
    ctx.nodeExecutionRepo.createOrIgnore({
      workflowRunId: task.workflowRunId,
      workflowNodeId: wf.startNodeId,
      agentName: 'coder',
      agentSessionId: 'coder-session-live',
      status: 'idle',
    });

    const tam = makeFakeTaskAgentManager(ctx);
    const handlers = makeHandlersWith(tam, {
      activateNode: async () => {},
      myAgentName: 'Plan Reviewer',
    });

    await handlers.send_message_to_task({
      task_id: task.id,
      node_id: 'coder',
      message: 'check slug',
    });

    expect(tam.subSessionInjects[0]?.message).toContain('─── Message from Plan Reviewer ───');
    expect(tam.subSessionInjects[0]?.message).toContain(
      'To reply, use: send_message with target "@plan-reviewer"'
    );
  });

  test('long-horizon sender omits invalid fallback when name slug is empty', async () => {
    const wf = buildSingleStepWorkflow(
      ctx.spaceId,
      ctx.workflowManager,
      ctx.agentId,
      'WF Empty Slug'
    );
    const { tasks } = await ctx.runtime.startWorkflowRun(ctx.spaceId, wf.id, 'Empty slug target');
    const task = tasks[0];
    ctx.nodeExecutionRepo.createOrIgnore({
      workflowRunId: task.workflowRunId,
      workflowNodeId: wf.startNodeId,
      agentName: 'coder',
      agentSessionId: 'coder-session-live',
      status: 'idle',
    });

    const tam = makeFakeTaskAgentManager(ctx);
    const handlers = makeHandlersWith(tam, {
      activateNode: async () => {},
      myAgentName: '!!!',
    });

    await handlers.send_message_to_task({
      task_id: task.id,
      node_id: 'coder',
      message: 'check empty slug',
    });

    expect(tam.subSessionInjects[0]?.message).toContain('─── Message from !!! ───');
    expect(tam.subSessionInjects[0]?.message).toContain(
      'To reply, use: send_message with target "@!!!"'
    );
    expect(tam.subSessionInjects[0]?.message).not.toContain('target "@space-agent"');
  });

  test('writes one audit entry for worker-node success', async () => {
    const wf = buildSingleStepWorkflow(ctx.spaceId, ctx.workflowManager, ctx.agentId, 'WF Audit');
    const { run, tasks } = await ctx.runtime.startWorkflowRun(ctx.spaceId, wf.id, 'Audit run');
    const task = tasks[0];
    const exec = ctx.nodeExecutionRepo.createOrIgnore({
      workflowRunId: run.id,
      workflowNodeId: wf.startNodeId,
      agentName: 'coder',
      agentSessionId: 'coder-session-live',
      status: 'idle',
    });
    const auditLogRepo = new McpAuditLogRepository(ctx.db);
    const tam = makeFakeTaskAgentManager(ctx);
    const handlers = makeHandlersWith(tam, { auditLogRepo, activateNode: async () => {} });

    const result = await handlers.send_message_to_task({
      task_id: task.id,
      node_id: 'coder',
      message: 'audit worker delivery',
    });
    const parsed = JSON.parse(result.content[0].text);
    const auditSummaries = parseAuditSummaries(auditLogRepo, task.id);

    expect(parsed.success).toBe(true);
    expect(auditSummaries).toHaveLength(1);
    expect(auditSummaries[0]).toMatchObject({
      task_id: task.id,
      outcome: 'delivered',
      target: 'node',
      node_id: exec.id,
      agent_name: 'coder',
      node_execution_id: exec.id,
    });
  });

  test('writes one audit entry for long-term-agent handle success', async () => {
    const wf = buildSingleStepWorkflow(
      ctx.spaceId,
      ctx.workflowManager,
      ctx.agentId,
      'WF Handle Audit'
    );
    const { tasks } = await ctx.runtime.startWorkflowRun(ctx.spaceId, wf.id, 'Handle audit run');
    const task = tasks[0];
    const auditLogRepo = new McpAuditLogRepository(ctx.db);
    const tam = makeFakeTaskAgentManager(ctx);
    const handlers = makeHandlersWith(tam, {
      auditLogRepo,
      messageResolver: {
        async resolveTargets(message) {
          return {
            resolved: [
              {
                targetRef: message.targets[0],
                address: { kind: 'handle', handle: 'coder' },
                actor: {
                  actorId: 'agent:coder',
                  kind: 'agent',
                  spaceId: ctx.spaceId,
                  handle: '@coder',
                  status: 'active',
                },
              },
            ],
            unresolved: [],
          };
        },
      },
      longTermAgentDelivery: {
        deliverToSession: async () => 'coder-long-term-session',
        queueForActivation: async () => null,
      },
    });

    const result = await handlers.send_message_to_task({
      task_id: task.id,
      target: '@coder',
      message: 'audit handle delivery',
    });
    const parsed = JSON.parse(result.content[0].text);
    const auditSummaries = parseAuditSummaries(auditLogRepo, task.id);

    expect(parsed.success).toBe(true);
    expect(auditSummaries).toHaveLength(1);
    expect(auditSummaries[0]).toMatchObject({
      task_id: task.id,
      outcome: 'delivered',
      target: 'space-agent',
      agent_name: '@coder',
    });
  });

  test('writes one audit entry for node-not-found error', async () => {
    const wf = buildSingleStepWorkflow(
      ctx.spaceId,
      ctx.workflowManager,
      ctx.agentId,
      'WF Audit Missing'
    );
    const { tasks } = await ctx.runtime.startWorkflowRun(ctx.spaceId, wf.id, 'Audit missing run');
    const task = tasks[0];
    const auditLogRepo = new McpAuditLogRepository(ctx.db);
    const tam = makeFakeTaskAgentManager(ctx);
    const handlers = makeHandlersWith(tam, { auditLogRepo, activateNode: async () => {} });

    const result = await handlers.send_message_to_task({
      task_id: task.id,
      node_id: 'missing-node',
      message: 'audit missing node',
    });
    const parsed = JSON.parse(result.content[0].text);
    const auditSummaries = parseAuditSummaries(auditLogRepo, task.id);

    expect(parsed.success).toBe(false);
    expect(auditSummaries).toHaveLength(1);
    expect(auditSummaries[0]).toMatchObject({
      task_id: task.id,
      outcome: 'failed',
      target: 'missing-node',
      node_id: 'missing-node',
      reason: 'node_not_found',
    });
  });

  test('writes audit entry for malformed target', async () => {
    const wf = buildSingleStepWorkflow(
      ctx.spaceId,
      ctx.workflowManager,
      ctx.agentId,
      'WF Audit Malformed'
    );
    const { tasks } = await ctx.runtime.startWorkflowRun(
      ctx.spaceId,
      wf.id,
      'Audit malformed target'
    );
    const task = tasks[0];
    const auditLogRepo = new McpAuditLogRepository(ctx.db);
    const tam = makeFakeTaskAgentManager(ctx);
    const handlers = makeHandlersWith(tam, { auditLogRepo, activateNode: async () => {} });

    const result = await handlers.send_message_to_task({
      task_id: task.id,
      target: 'coder',
      message: 'audit malformed',
    });
    const parsed = JSON.parse(result.content[0].text);
    const auditSummaries = parseAuditSummaries(auditLogRepo, task.id);

    expect(parsed.success).toBe(false);
    expect(auditSummaries).toHaveLength(1);
    expect(auditSummaries[0]).toMatchObject({
      task_id: task.id,
      outcome: 'failed',
      target: 'coder',
      reason: 'malformed_target',
    });
  });

  test('writes audit entry for target and node_id disagreement', async () => {
    const wf = buildSingleStepWorkflow(
      ctx.spaceId,
      ctx.workflowManager,
      ctx.agentId,
      'WF Audit Disagree'
    );
    const { run, tasks } = await ctx.runtime.startWorkflowRun(ctx.spaceId, wf.id, 'Audit disagree');
    const task = tasks[0];
    ctx.nodeExecutionRepo.createOrIgnore({
      workflowRunId: run.id,
      workflowNodeId: wf.startNodeId,
      agentName: 'coder',
      agentSessionId: 'coder-disagree-session',
      status: 'in_progress',
    });
    ctx.nodeExecutionRepo.createOrIgnore({
      workflowRunId: run.id,
      workflowNodeId: 'review-node',
      agentName: 'reviewer',
      agentSessionId: 'reviewer-disagree-session',
      status: 'in_progress',
    });
    const auditLogRepo = new McpAuditLogRepository(ctx.db);
    const tam = makeFakeTaskAgentManager(ctx);
    const handlers = makeHandlersWith(tam, { auditLogRepo, activateNode: async () => {} });

    const result = await handlers.send_message_to_task({
      task_id: task.id,
      target: '@coder',
      node_id: 'reviewer',
      message: 'audit disagree',
    });
    const parsed = JSON.parse(result.content[0].text);
    const auditSummaries = parseAuditSummaries(auditLogRepo, task.id);

    expect(parsed.success).toBe(false);
    expect(auditSummaries).toHaveLength(1);
    expect(auditSummaries[0]).toMatchObject({
      task_id: task.id,
      outcome: 'failed',
      target: '@coder',
      node_id: 'reviewer',
      reason: 'target_node_id_disagree',
    });
  });

  test('writes audit entry for ambiguous long-horizon target', async () => {
    const wf = buildSingleStepWorkflow(
      ctx.spaceId,
      ctx.workflowManager,
      ctx.agentId,
      'WF Audit Ambiguous LH'
    );
    const { tasks } = await ctx.runtime.startWorkflowRun(
      ctx.spaceId,
      wf.id,
      'Audit ambiguous long horizon'
    );
    const task = tasks[0];
    ctx.longHorizonAgentRepo.create({
      id: '3bffb20e',
      spaceId: ctx.spaceId,
      handle: 'reviewer',
      displayName: 'Reviewer',
    });
    const auditLogRepo = new McpAuditLogRepository(ctx.db);
    const tam = makeFakeTaskAgentManager(ctx);
    const handlers = makeHandlersWith(tam, {
      auditLogRepo,
      messageResolver: resolverForActors([{ actorId: 'agent:3bffb20e', handle: '@reviewer' }]),
    });

    const result = await handlers.send_message_to_task({
      task_id: task.id,
      target: '@reviewer',
      message: 'audit ambiguous long horizon',
    });
    const parsed = JSON.parse(result.content[0].text);
    const auditSummaries = parseAuditSummaries(auditLogRepo, task.id);

    expect(parsed.success).toBe(false);
    expect(auditSummaries).toHaveLength(1);
    expect(auditSummaries[0]).toMatchObject({
      task_id: task.id,
      outcome: 'failed',
      target: '@reviewer',
      reason: 'ambiguous_long_horizon_target',
    });
  });

  test('node_id by agent name routes directly to the live sub-session', async () => {
    const wf = buildSingleStepWorkflow(ctx.spaceId, ctx.workflowManager, ctx.agentId, 'WF Coder');
    const { run, tasks } = await ctx.runtime.startWorkflowRun(
      ctx.spaceId,
      wf.id,
      'Node target run'
    );
    const task = tasks[0];
    // Seed two executions: a terminated Coder with a live session + a fresh Reviewer.
    const coderExec = ctx.nodeExecutionRepo.createOrIgnore({
      workflowRunId: run.id,
      workflowNodeId: wf.startNodeId,
      agentName: 'coder',
      agentSessionId: 'coder-session-live',
      status: 'idle',
    });

    const tam = makeFakeTaskAgentManager(ctx);
    const activateCalls: Array<[string, string]> = [];
    const handlers = makeHandlersWith(tam, {
      activateNode: async (r, n) => {
        activateCalls.push([r, n]);
      },
    });

    const result = await handlers.send_message_to_task({
      task_id: task.id,
      node_id: 'coder',
      message: 'refactor the parser',
    });
    const parsed = JSON.parse(result.content[0].text);

    expect(parsed.success).toBe(true);
    expect(parsed.target).toBe('node');
    expect(parsed.node_execution_id).toBe(coderExec.id);
    expect(parsed.agent_name).toBe('coder');
    expect(parsed.delivered_session_id).toBe('coder-session-live');
    expect(parsed.sdk_message_id).toBe('sdk-message-0');
    expect(parsed.activated).toBe(false);
    // Direct-injection path must skip activateNode.
    expect(activateCalls).toHaveLength(0);
    expect(tam.subSessionInjects).toEqual([
      {
        sessionId: 'coder-session-live',
        message: spaceAgentToNodeEnvelope(task, 'refactor the parser', 'coder'),
        isSyntheticMessage: true,
        sdkMessageId: 'sdk-message-0',
      },
    ]);
    // The Task Agent path was not touched.
  });

  test('node_id by execution UUID targets that specific execution', async () => {
    const wf = buildSingleStepWorkflow(ctx.spaceId, ctx.workflowManager, ctx.agentId, 'WF UUID');
    const { run, tasks } = await ctx.runtime.startWorkflowRun(ctx.spaceId, wf.id, 'UUID target');
    const task = tasks[0];
    // Two executions for the same agent name — UUID targeting must disambiguate.
    const reviewerA = ctx.nodeExecutionRepo.createOrIgnore({
      workflowRunId: run.id,
      workflowNodeId: wf.startNodeId,
      agentName: 'reviewer',
      agentSessionId: 'reviewer-a-session',
      status: 'idle',
    });
    const reviewerB = ctx.nodeExecutionRepo.createOrIgnore({
      workflowRunId: run.id,
      workflowNodeId: wf.startNodeId,
      agentName: 'reviewer-2',
      agentSessionId: 'reviewer-b-session',
      status: 'in_progress',
    });

    const tam = makeFakeTaskAgentManager(ctx);
    const handlers = makeHandlersWith(tam, { activateNode: async () => {} });

    const result = await handlers.send_message_to_task({
      task_id: task.id,
      node_id: reviewerB.id,
      message: 'please re-review',
    });
    const parsed = JSON.parse(result.content[0].text);

    expect(parsed.success).toBe(true);
    expect(parsed.node_execution_id).toBe(reviewerB.id);
    expect(tam.subSessionInjects).toEqual([
      {
        sessionId: 'reviewer-b-session',
        message: spaceAgentToNodeEnvelope(task, 'please re-review', 'reviewer-2'),
        isSyntheticMessage: true,
        sdkMessageId: 'sdk-message-0',
      },
    ]);
    // Ensure the other reviewer was never touched.
    expect(tam.subSessionInjects.some((r) => r.sessionId === reviewerA.agentSessionId)).toBe(false);
  });

  test('auto-activates and injects when the targeted node has no live session', async () => {
    const wf = buildSingleStepWorkflow(ctx.spaceId, ctx.workflowManager, ctx.agentId, 'WF Lazy');
    const { run, tasks } = await ctx.runtime.startWorkflowRun(ctx.spaceId, wf.id, 'Lazy activate');
    const task = tasks[0];
    // Seed execution with NO agentSessionId — simulating a never-spawned node.
    const exec = ctx.nodeExecutionRepo.createOrIgnore({
      workflowRunId: run.id,
      workflowNodeId: wf.startNodeId,
      agentName: 'reviewer',
      status: 'pending',
    });

    const tam = makeFakeTaskAgentManager(ctx);
    const activateCalls: Array<[string, string]> = [];
    const handlers = makeHandlersWith(tam, {
      activateNode: async (runId, nodeId) => {
        activateCalls.push([runId, nodeId]);
        // Simulate ChannelRouter.activateNode() restoring a reusable session id.
        ctx.nodeExecutionRepo.update(exec.id, {
          status: 'in_progress',
          agentSessionId: 'reviewer-session-newly-restored',
        });
      },
    });

    const result = await handlers.send_message_to_task({
      task_id: task.id,
      node_id: 'reviewer',
      message: 'please re-review',
    });
    const parsed = JSON.parse(result.content[0].text);

    expect(parsed.success).toBe(true);
    expect(parsed.activated).toBe(true);
    expect(parsed.delivered_session_id).toBe('reviewer-session-newly-restored');
    expect(parsed.sdk_message_id).toBe('sdk-message-0');
    expect(parsed.node_execution_id).toBe(exec.id);
    expect(activateCalls).toEqual([[run.id, wf.startNodeId]]);
    expect(tam.subSessionInjects).toEqual([
      {
        sessionId: 'reviewer-session-newly-restored',
        message: spaceAgentToNodeEnvelope(task, 'please re-review', 'reviewer'),
        isSyntheticMessage: true,
        sdkMessageId: 'sdk-message-0',
      },
    ]);
  });

  test('reports deferred delivery when activation creates no live session', async () => {
    const wf = buildSingleStepWorkflow(
      ctx.spaceId,
      ctx.workflowManager,
      ctx.agentId,
      'WF Deferred'
    );
    const { run, tasks } = await ctx.runtime.startWorkflowRun(ctx.spaceId, wf.id, 'Deferred');
    const task = tasks[0];
    const exec = ctx.nodeExecutionRepo.createOrIgnore({
      workflowRunId: run.id,
      workflowNodeId: wf.startNodeId,
      agentName: 'reviewer',
      status: 'pending',
    });

    const tam = makeFakeTaskAgentManager(ctx);
    const handlers = makeHandlersWith(tam, {
      activateNode: async () => {
        // Activation succeeded but did not attach a live session id — the tick
        // loop will spawn one later. The handler surfaces `delivered: false`.
      },
    });

    const result = await handlers.send_message_to_task({
      task_id: task.id,
      node_id: 'reviewer',
      message: 'queued reminder',
    });
    const parsed = JSON.parse(result.content[0].text);

    expect(parsed.success).toBe(true);
    expect(parsed.activated).toBe(true);
    expect(parsed.delivered).toBe(false);
    expect(parsed.queued).toBe(false);
    expect(parsed.queuedMessageId).toBeUndefined();
    expect(parsed.queued_message_id).toBeUndefined();
    expect(parsed.delivered_session_id).toBeNull();
    expect(parsed.sdk_message_id).toBeNull();
    expect(parsed.node_execution_id).toBe(exec.id);
    expect(tam.subSessionInjects).toHaveLength(0);
  });

  test('queues the message when activation creates no live session and a pending queue is configured', async () => {
    const wf = buildSingleStepWorkflow(ctx.spaceId, ctx.workflowManager, ctx.agentId, 'WF Queued');
    const { run, tasks } = await ctx.runtime.startWorkflowRun(ctx.spaceId, wf.id, 'Queued');
    const task = tasks[0];
    const exec = ctx.nodeExecutionRepo.createOrIgnore({
      workflowRunId: run.id,
      workflowNodeId: wf.startNodeId,
      agentName: 'reviewer',
      status: 'pending',
    });

    const tam = makeFakeTaskAgentManager(ctx);
    const fakeQueue = makeFakePendingMessageQueue();
    const handlers = makeHandlersWith(tam, {
      activateNode: async () => {
        // Activation succeeded but the tick loop has not spawned the session yet.
      },
      pendingMessageQueue: fakeQueue,
    });

    const result = await handlers.send_message_to_task({
      task_id: task.id,
      node_id: 'reviewer',
      message: 'please review this PR',
    });
    const parsed = JSON.parse(result.content[0].text);

    expect(parsed.success).toBe(true);
    expect(parsed.activated).toBe(true);
    expect(parsed.delivered).toBe(false);
    expect(parsed.queued).toBe(true);
    expect(parsed.queuedMessageId).toBeUndefined();
    expect(parsed.queued_message_id).toBe('pending-message-0');
    expect(parsed.delivered_session_id).toBeNull();
    expect(parsed.sdk_message_id).toBeNull();
    expect(parsed.node_execution_id).toBe(exec.id);
    expect(tam.subSessionInjects).toHaveLength(0);

    expect(fakeQueue.enqueued).toEqual([
      {
        workflowRunId: run.id,
        spaceId: ctx.spaceId,
        taskId: task.id,
        sourceAgentName: 'space-agent',
        targetKind: 'node_agent',
        targetAgentName: 'reviewer',
        message: spaceAgentToNodeEnvelope(task, 'please review this PR', 'reviewer'),
      },
    ]);
  });

  test('queued task-agent messages preserve task-agent sender identity', async () => {
    const wf = buildSingleStepWorkflow(
      ctx.spaceId,
      ctx.workflowManager,
      ctx.agentId,
      'WF Task Agent Queued'
    );
    const { run, tasks } = await ctx.runtime.startWorkflowRun(ctx.spaceId, wf.id, 'Queued');
    const task = tasks[0];
    ctx.nodeExecutionRepo.createOrIgnore({
      workflowRunId: run.id,
      workflowNodeId: wf.startNodeId,
      agentName: 'reviewer',
      status: 'pending',
    });

    const tam = makeFakeTaskAgentManager(ctx);
    const fakeQueue = makeFakePendingMessageQueue();
    const handlers = createSpaceAgentToolHandlers({
      spaceId: ctx.spaceId,
      runtime: ctx.runtime,
      workflowManager: ctx.workflowManager,
      taskRepo: ctx.taskRepo,
      workflowRunRepo: ctx.workflowRunRepo,
      taskManager: ctx.taskManager,
      spaceAgentManager: ctx.agentManager,
      nodeExecutionRepo: ctx.nodeExecutionRepo,
      taskAgentManager: tam.manager,
      myAgentName: 'task-agent',
      activateNode: async () => {},
      pendingMessageQueue: {
        enqueue(input) {
          fakeQueue.enqueued.push(input);
          return { record: { id: 'pending-message-task-agent' }, deduped: false };
        },
      },
    });

    const result = await handlers.send_message_to_task({
      task_id: task.id,
      node_id: 'reviewer',
      message: 'task agent queued reminder',
    });
    const parsed = JSON.parse(result.content[0].text);

    expect(parsed.success).toBe(true);
    expect(fakeQueue.enqueued).toEqual([
      {
        workflowRunId: run.id,
        spaceId: ctx.spaceId,
        taskId: task.id,
        sourceAgentName: 'task-agent',
        targetKind: 'node_agent',
        targetAgentName: 'reviewer',
        message: formatAgentMessage({
          fromLevel: 'task-agent',
          fromAgentName: 'task-agent',
          toLevel: 'node-agent',
          body: 'task agent queued reminder',
          taskId: task.id,
          taskNumber: task.taskNumber,
          nodeId: 'reviewer',
        }),
      },
    ]);
  });

  test('generic @worker target resolves by workflow node name and injects live session', async () => {
    const wf = buildSingleStepWorkflow(
      ctx.spaceId,
      ctx.workflowManager,
      ctx.agentId,
      'WF Generic Worker'
    );
    const { run, tasks } = await ctx.runtime.startWorkflowRun(
      ctx.spaceId,
      wf.id,
      'Generic worker target'
    );
    const task = tasks[0];
    const exec = ctx.nodeExecutionRepo.createOrIgnore({
      workflowRunId: run.id,
      workflowNodeId: wf.startNodeId,
      agentName: 'reviewer',
      agentSessionId: 'reviewer-generic-session',
      status: 'in_progress',
    });

    const tam = makeFakeTaskAgentManager(ctx);
    const handlers = makeHandlersWith(tam, { activateNode: async () => {} });
    const result = await handlers.send_message_to_task({
      task_id: task.id,
      target: `@worker:${encodeURIComponent(run.id)}/Work/reviewer`,
      message: 'review generic worker',
    });
    const parsed = JSON.parse(result.content[0].text);

    expect(parsed.success).toBe(true);
    expect(parsed.node_execution_id).toBe(exec.id);
    expect(parsed.agent_name).toBe('reviewer');
    expect(tam.subSessionInjects).toEqual([
      {
        sessionId: 'reviewer-generic-session',
        message: spaceAgentToNodeEnvelope(task, 'review generic worker', 'reviewer'),
        isSyntheticMessage: true,
        sdkMessageId: 'sdk-message-0',
      },
    ]);
  });

  function countSdkMessages(): number {
    return (ctx.db.prepare('SELECT COUNT(*) AS count FROM sdk_messages').get() as { count: number })
      .count;
  }

  function resolverForActors(
    actors: Array<{ actorId: string; handle: string; status?: 'active' | 'inactive' }>
  ) {
    return {
      async resolveTargets() {
        return {
          resolved: actors.map((actor) => ({
            targetRef: actor.handle,
            address: { kind: 'handle' as const, handle: actor.handle.slice(1) },
            actor: {
              kind: 'agent' as const,
              spaceId: ctx.spaceId,
              status: actor.status ?? 'active',
              ...actor,
            },
          })),
          unresolved: [],
        };
      },
    };
  }

  test('task_id + bare handle errors when it only matches a long-horizon agent', async () => {
    const wf = buildSingleStepWorkflow(
      ctx.spaceId,
      ctx.workflowManager,
      ctx.agentId,
      'WF Handle Ambiguous'
    );
    const { tasks } = await ctx.runtime.startWorkflowRun(ctx.spaceId, wf.id, 'Handle ambiguous');
    const task = tasks[0];
    ctx.longHorizonAgentRepo.create({
      id: '3bffb20e',
      spaceId: ctx.spaceId,
      handle: 'reviewer',
      displayName: 'Reviewer',
    });
    const before = countSdkMessages();

    const tam = makeFakeTaskAgentManager(ctx);
    const result = await makeHandlersWith(tam, {
      messageResolver: resolverForActors([{ actorId: 'agent:3bffb20e', handle: '@reviewer' }]),
    }).send_message_to_task({ task_id: task.id, target: '@reviewer', message: 'hello' });
    const parsed = JSON.parse(result.content[0].text);

    expect(parsed.success).toBe(false);
    expect(parsed.error).toContain('Ambiguous target');
    expect(parsed.error).toContain('workflow reviewer node');
    expect(parsed.error).toContain('node_id');
    expect(parsed.error).toContain('@worker:');
    expect(countSdkMessages()).toBe(before);
    expect(tam.subSessionInjects).toHaveLength(0);
  });

  test('task_id + bare handle returns a tool error for malformed targets', async () => {
    const wf = buildSingleStepWorkflow(
      ctx.spaceId,
      ctx.workflowManager,
      ctx.agentId,
      'WF Malformed Handle'
    );
    const { tasks } = await ctx.runtime.startWorkflowRun(ctx.spaceId, wf.id, 'Malformed handle');
    const task = tasks[0];

    const tam = makeFakeTaskAgentManager(ctx);
    const result = await makeHandlersWith(tam, {
      activateNode: async () => {},
    }).send_message_to_task({
      task_id: task.id,
      target: 'coder',
      message: 'hello malformed',
    });
    const parsed = JSON.parse(result.content[0].text);

    expect(parsed.success).toBe(false);
    expect(parsed.error).toContain('Address must start with @ or #');
  });

  test('task_id + bare handle succeeds when it matches a task worker only', async () => {
    const wf = buildSingleStepWorkflow(
      ctx.spaceId,
      ctx.workflowManager,
      ctx.agentId,
      'WF Handle Worker'
    );
    const { run, tasks } = await ctx.runtime.startWorkflowRun(ctx.spaceId, wf.id, 'Handle worker');
    const task = tasks[0];
    const exec = ctx.nodeExecutionRepo.createOrIgnore({
      workflowRunId: run.id,
      workflowNodeId: wf.startNodeId,
      agentName: 'coder',
      agentSessionId: 'coder-worker-session',
      status: 'in_progress',
    });

    const tam = makeFakeTaskAgentManager(ctx);
    const result = await makeHandlersWith(tam, {
      activateNode: async () => {},
    }).send_message_to_task({
      task_id: task.id,
      target: '@coder',
      message: 'hello worker',
    });
    const parsed = JSON.parse(result.content[0].text);

    expect(parsed.success).toBe(true);
    expect(parsed.node_execution_id).toBe(exec.id);
    expect(tam.subSessionInjects[0]?.sessionId).toBe('coder-worker-session');
  });

  test('task_id + bare handle succeeds when it matches both worker and long-horizon agent but node_id disambiguates', async () => {
    const wf = buildSingleStepWorkflow(
      ctx.spaceId,
      ctx.workflowManager,
      ctx.agentId,
      'WF Handle Both'
    );
    const { run, tasks } = await ctx.runtime.startWorkflowRun(ctx.spaceId, wf.id, 'Handle both');
    const task = tasks[0];
    const exec = ctx.nodeExecutionRepo.createOrIgnore({
      workflowRunId: run.id,
      workflowNodeId: wf.startNodeId,
      agentName: 'coder',
      agentSessionId: 'coder-worker-session',
      status: 'in_progress',
    });
    ctx.longHorizonAgentRepo.create({
      id: '3bffb20e',
      spaceId: ctx.spaceId,
      handle: 'coder',
      displayName: 'Coder',
    });

    const tam = makeFakeTaskAgentManager(ctx);
    const result = await makeHandlersWith(tam, {
      activateNode: async () => {},
      messageResolver: resolverForActors([{ actorId: 'agent:3bffb20e', handle: '@coder' }]),
    }).send_message_to_task({
      task_id: task.id,
      target: '@coder',
      node_id: 'coder',
      message: 'hello both disambiguated',
    });
    const parsed = JSON.parse(result.content[0].text);

    expect(parsed.success).toBe(true);
    expect(parsed.node_execution_id).toBe(exec.id);
    expect(tam.subSessionInjects[0]?.sessionId).toBe('coder-worker-session');
  });

  test('node_id exact UUID disambiguates duplicate handle workers from a long-horizon conflict', async () => {
    const wf = buildSingleStepWorkflow(
      ctx.spaceId,
      ctx.workflowManager,
      ctx.agentId,
      'WF Duplicate Handle LH'
    );
    const { run, tasks } = await ctx.runtime.startWorkflowRun(
      ctx.spaceId,
      wf.id,
      'Duplicate handle with LH'
    );
    const task = tasks[0];
    const olderExec = ctx.nodeExecutionRepo.createOrIgnore({
      workflowRunId: run.id,
      workflowNodeId: 'old-node',
      agentName: 'coder',
      agentSessionId: 'coder-old-session',
      status: 'in_progress',
    });
    // Ensure deterministic ordering: listByWorkflowRun orders by created_at ASC
    // then id ASC. A 2ms gap guarantees distinct timestamps across platforms.
    await new Promise((resolve) => setTimeout(resolve, 2));
    ctx.nodeExecutionRepo.createOrIgnore({
      workflowRunId: run.id,
      workflowNodeId: 'latest-node',
      agentName: 'coder',
      agentSessionId: 'coder-latest-session',
      status: 'in_progress',
    });
    ctx.longHorizonAgentRepo.create({
      id: '3bffb20e',
      spaceId: ctx.spaceId,
      handle: 'coder',
      displayName: 'Coder',
    });

    const tam = makeFakeTaskAgentManager(ctx);
    const result = await makeHandlersWith(tam, {
      activateNode: async () => {},
      messageResolver: resolverForActors([{ actorId: 'agent:3bffb20e', handle: '@coder' }]),
    }).send_message_to_task({
      task_id: task.id,
      target: '@coder',
      node_id: olderExec.id,
      message: 'hello older worker',
    });
    const parsed = JSON.parse(result.content[0].text);

    expect(parsed.success).toBe(true);
    expect(parsed.node_execution_id).toBe(olderExec.id);
    expect(tam.subSessionInjects[0]?.sessionId).toBe('coder-old-session');
  });

  test('task_id + bare handle errors when it conflicts with a long-horizon agent and node_id is absent', async () => {
    const wf = buildSingleStepWorkflow(
      ctx.spaceId,
      ctx.workflowManager,
      ctx.agentId,
      'WF Handle Both No Node'
    );
    const { run, tasks } = await ctx.runtime.startWorkflowRun(
      ctx.spaceId,
      wf.id,
      'Handle both no node'
    );
    const task = tasks[0];
    ctx.nodeExecutionRepo.createOrIgnore({
      workflowRunId: run.id,
      workflowNodeId: wf.startNodeId,
      agentName: 'coder',
      agentSessionId: 'coder-worker-session',
      status: 'in_progress',
    });
    ctx.longHorizonAgentRepo.create({
      id: '3bffb20e',
      spaceId: ctx.spaceId,
      handle: 'coder',
      displayName: 'Coder',
    });
    const before = countSdkMessages();

    const tam = makeFakeTaskAgentManager(ctx);
    const result = await makeHandlersWith(tam, {
      messageResolver: resolverForActors([{ actorId: 'agent:3bffb20e', handle: '@coder' }]),
    }).send_message_to_task({ task_id: task.id, target: '@coder', message: 'hello both' });
    const parsed = JSON.parse(result.content[0].text);

    expect(parsed.success).toBe(false);
    expect(parsed.error).toContain('Ambiguous target');
    expect(parsed.error).toContain('agent:3bffb20e');
    expect(parsed.error).toContain('workflow node "coder"');
    expect(countSdkMessages()).toBe(before);
  });

  test('task_id + bare handle errors when it conflicts with a long-horizon agent and node_id disagrees', async () => {
    const wf = buildSingleStepWorkflow(
      ctx.spaceId,
      ctx.workflowManager,
      ctx.agentId,
      'WF Handle Both Disagree'
    );
    const { run, tasks } = await ctx.runtime.startWorkflowRun(
      ctx.spaceId,
      wf.id,
      'Handle both disagree'
    );
    const task = tasks[0];
    ctx.longHorizonAgentRepo.create({
      id: '3bffb20e',
      spaceId: ctx.spaceId,
      handle: 'coder',
      displayName: 'Coder',
    });
    ctx.nodeExecutionRepo.createOrIgnore({
      workflowRunId: run.id,
      workflowNodeId: 'review-node',
      agentName: 'reviewer',
      agentSessionId: 'reviewer-disagree-session',
      status: 'in_progress',
    });
    const before = countSdkMessages();

    const tam = makeFakeTaskAgentManager(ctx);
    const result = await makeHandlersWith(tam, {
      messageResolver: resolverForActors([{ actorId: 'agent:3bffb20e', handle: '@coder' }]),
    }).send_message_to_task({
      task_id: task.id,
      target: '@coder',
      node_id: 'reviewer',
      message: 'hello disagree long horizon',
    });
    const parsed = JSON.parse(result.content[0].text);

    expect(parsed.success).toBe(false);
    expect(parsed.error).toContain('disagree');
    expect(parsed.error).toContain('@coder');
    expect(parsed.error).toContain('reviewer');
    expect(countSdkMessages()).toBe(before);
  });

  test('@coordinator does not route to a workflow worker named coordinator', async () => {
    const wf = buildSingleStepWorkflow(
      ctx.spaceId,
      ctx.workflowManager,
      ctx.agentId,
      'WF Coordinator Worker'
    );
    const { run, tasks } = await ctx.runtime.startWorkflowRun(
      ctx.spaceId,
      wf.id,
      'Coordinator worker collision'
    );
    const task = tasks[0];
    ctx.nodeExecutionRepo.createOrIgnore({
      workflowRunId: run.id,
      workflowNodeId: wf.startNodeId,
      agentName: 'coordinator',
      agentSessionId: 'coordinator-worker-session',
      status: 'in_progress',
    });
    const before = countSdkMessages();

    const tam = makeFakeTaskAgentManager(ctx);
    const result = await makeHandlersWith(tam, {
      messageResolver: resolverForActors([
        { actorId: `agent:coordinator:${ctx.spaceId}`, handle: '@coordinator' },
      ]),
    }).send_message_to_task({
      task_id: task.id,
      target: '@coordinator',
      message: 'hello coordinator',
    });
    const parsed = JSON.parse(result.content[0].text);

    expect(parsed.success).toBe(false);
    expect(parsed.error).toContain('Ambiguous target');
    expect(parsed.error).toContain('@coordinator');
    expect(parsed.error).toContain('workflow node "coordinator"');
    expect(countSdkMessages()).toBe(before);
  });

  test('@coordinator routes to the Space coordinator when no workflow worker collides', async () => {
    const wf = buildSingleStepWorkflow(
      ctx.spaceId,
      ctx.workflowManager,
      ctx.agentId,
      'WF Coordinator No Collision'
    );
    const { tasks } = await ctx.runtime.startWorkflowRun(
      ctx.spaceId,
      wf.id,
      'Coordinator no collision'
    );
    const task = tasks[0];
    const auditLogRepo = new McpAuditLogRepository(ctx.db);

    const tam = makeFakeTaskAgentManager(ctx);
    const result = await makeHandlersWith(tam, {
      auditLogRepo,
      activateNode: async () => {},
      messageResolver: {
        async resolveTargets(message) {
          return {
            resolved: [
              {
                targetRef: message.targets[0],
                address: { kind: 'handle', handle: 'coordinator' },
                actor: {
                  actorId: `agent:coordinator:${ctx.spaceId}`,
                  kind: 'agent',
                  spaceId: ctx.spaceId,
                  handle: '@coordinator',
                  status: 'active',
                },
              },
            ],
            unresolved: [],
          };
        },
      },
      longTermAgentDelivery: {
        deliverToSession: async () => 'coordinator-session',
        queueForActivation: async () => null,
      },
    }).send_message_to_task({
      task_id: task.id,
      target: '@coordinator',
      message: 'hello coordinator',
    });
    const parsed = JSON.parse(result.content[0].text);
    const auditSummaries = parseAuditSummaries(auditLogRepo, task.id);

    expect(parsed.success).toBe(true);
    expect(auditSummaries).toHaveLength(1);
    expect(auditSummaries[0]).toMatchObject({
      task_id: task.id,
      outcome: 'delivered',
      target: 'space-agent',
      agent_name: '@coordinator',
    });
  });

  test('target trimming is preserved for bare handle routing', async () => {
    const wf = buildSingleStepWorkflow(
      ctx.spaceId,
      ctx.workflowManager,
      ctx.agentId,
      'WF Trim Target'
    );
    const { run, tasks } = await ctx.runtime.startWorkflowRun(ctx.spaceId, wf.id, 'Trim target');
    const task = tasks[0];
    const exec = ctx.nodeExecutionRepo.createOrIgnore({
      workflowRunId: run.id,
      workflowNodeId: wf.startNodeId,
      agentName: 'coder',
      agentSessionId: 'coder-trim-session',
      status: 'in_progress',
    });

    const tam = makeFakeTaskAgentManager(ctx);
    const result = await makeHandlersWith(tam, {
      activateNode: async () => {},
    }).send_message_to_task({
      task_id: task.id,
      target: '  @coder  ',
      message: 'hello trimmed',
    });
    const parsed = JSON.parse(result.content[0].text);

    expect(parsed.success).toBe(true);
    expect(parsed.node_execution_id).toBe(exec.id);
  });

  test('whitespace target falls back to node_id', async () => {
    const wf = buildSingleStepWorkflow(
      ctx.spaceId,
      ctx.workflowManager,
      ctx.agentId,
      'WF Blank Target Fallback'
    );
    const { run, tasks } = await ctx.runtime.startWorkflowRun(
      ctx.spaceId,
      wf.id,
      'Blank target fallback'
    );
    const task = tasks[0];
    const exec = ctx.nodeExecutionRepo.createOrIgnore({
      workflowRunId: run.id,
      workflowNodeId: wf.startNodeId,
      agentName: 'coder',
      agentSessionId: 'coder-blank-session',
      status: 'in_progress',
    });

    const tam = makeFakeTaskAgentManager(ctx);
    const result = await makeHandlersWith(tam, {
      activateNode: async () => {},
    }).send_message_to_task({
      task_id: task.id,
      target: '   ',
      node_id: 'coder',
      message: 'hello blank fallback',
    });
    const parsed = JSON.parse(result.content[0].text);

    expect(parsed.success).toBe(true);
    expect(parsed.node_execution_id).toBe(exec.id);
    expect(tam.subSessionInjects[0]?.sessionId).toBe('coder-blank-session');
  });

  test('case-insensitive handle still detects long-horizon conflict', async () => {
    const wf = buildSingleStepWorkflow(
      ctx.spaceId,
      ctx.workflowManager,
      ctx.agentId,
      'WF Case Conflict'
    );
    const { run, tasks } = await ctx.runtime.startWorkflowRun(ctx.spaceId, wf.id, 'Case conflict');
    const task = tasks[0];
    ctx.nodeExecutionRepo.createOrIgnore({
      workflowRunId: run.id,
      workflowNodeId: wf.startNodeId,
      agentName: 'coder',
      agentSessionId: 'coder-case-session',
      status: 'in_progress',
    });
    ctx.longHorizonAgentRepo.create({
      id: '3bffb20e',
      spaceId: ctx.spaceId,
      handle: 'coder',
      displayName: 'Coder',
    });
    const before = countSdkMessages();

    const tam = makeFakeTaskAgentManager(ctx);
    const result = await makeHandlersWith(tam, {
      messageResolver: resolverForActors([{ actorId: 'agent:3bffb20e', handle: '@coder' }]),
    }).send_message_to_task({
      task_id: task.id,
      target: '@Coder',
      message: 'hello case conflict',
    });
    const parsed = JSON.parse(result.content[0].text);

    expect(parsed.success).toBe(false);
    expect(parsed.error).toContain('Ambiguous target');
    expect(parsed.error).toContain('@Coder');
    expect(countSdkMessages()).toBe(before);
  });

  test('case-mismatched handle probes resolver with canonical casing', async () => {
    const wf = buildSingleStepWorkflow(
      ctx.spaceId,
      ctx.workflowManager,
      ctx.agentId,
      'WF Case Probe'
    );
    const { run, tasks } = await ctx.runtime.startWorkflowRun(ctx.spaceId, wf.id, 'Case probe');
    const task = tasks[0];
    ctx.nodeExecutionRepo.createOrIgnore({
      workflowRunId: run.id,
      workflowNodeId: wf.startNodeId,
      agentName: 'coder',
      agentSessionId: 'coder-case-probe-session',
      status: 'in_progress',
    });
    ctx.longHorizonAgentRepo.create({
      id: '3bffb20e',
      spaceId: ctx.spaceId,
      handle: 'coder',
      displayName: 'Coder',
    });
    const before = countSdkMessages();

    const tam = makeFakeTaskAgentManager(ctx);
    const result = await makeHandlersWith(tam, {
      messageResolver: {
        async resolveTargets(message) {
          // Simulate a real resolver that only matches the canonical lowercase handle.
          if (message.targets[0] === '@coder') {
            return {
              message,
              resolved: [
                {
                  targetRef: '@coder',
                  address: { kind: 'handle' as const, handle: 'coder' },
                  actor: {
                    kind: 'agent' as const,
                    actorId: 'agent:3bffb20e',
                    handle: '@coder',
                    spaceId: ctx.spaceId,
                    status: 'active',
                  },
                },
              ],
              unresolved: [],
            };
          }
          return {
            message,
            resolved: [],
            unresolved: message.targets.map((targetRef) => ({ targetRef, reason: 'not found' })),
          };
        },
      },
    }).send_message_to_task({
      task_id: task.id,
      target: '@Coder',
      message: 'hello case probe',
    });
    const parsed = JSON.parse(result.content[0].text);

    expect(parsed.success).toBe(false);
    expect(parsed.error).toContain('Ambiguous target');
    expect(parsed.error).toContain('@Coder');
    expect(countSdkMessages()).toBe(before);
  });

  test('system handle is treated as a reserved conflict', async () => {
    const wf = buildSingleStepWorkflow(
      ctx.spaceId,
      ctx.workflowManager,
      ctx.agentId,
      'WF System Handle'
    );
    const { run, tasks } = await ctx.runtime.startWorkflowRun(
      ctx.spaceId,
      wf.id,
      'System handle conflict'
    );
    const task = tasks[0];
    ctx.nodeExecutionRepo.createOrIgnore({
      workflowRunId: run.id,
      workflowNodeId: wf.startNodeId,
      agentName: 'system-runtime',
      agentSessionId: 'system-runtime-session',
      status: 'in_progress',
    });
    const before = countSdkMessages();

    const tam = makeFakeTaskAgentManager(ctx);
    const result = await makeHandlersWith(tam, {
      messageResolver: resolverForActors([
        { actorId: 'system:runtime', handle: '@system-runtime' },
      ]),
    }).send_message_to_task({
      task_id: task.id,
      target: '@system-runtime',
      message: 'hello system handle',
    });
    const parsed = JSON.parse(result.content[0].text);

    expect(parsed.success).toBe(false);
    expect(parsed.error).toContain('Ambiguous target');
    expect(parsed.error).toContain('@system-runtime');
    expect(countSdkMessages()).toBe(before);
  });

  test('task worker handle ignores matching worker profile actor', async () => {
    const wf = buildSingleStepWorkflow(
      ctx.spaceId,
      ctx.workflowManager,
      ctx.agentId,
      'WF Worker Profile'
    );
    const { run, tasks } = await ctx.runtime.startWorkflowRun(ctx.spaceId, wf.id, 'Worker profile');
    const task = tasks[0];
    const exec = ctx.nodeExecutionRepo.createOrIgnore({
      workflowRunId: run.id,
      workflowNodeId: wf.startNodeId,
      agentName: 'coder',
      agentSessionId: 'coder-profile-session',
      status: 'in_progress',
    });

    const tam = makeFakeTaskAgentManager(ctx);
    const result = await makeHandlersWith(tam, {
      activateNode: async () => {},
      messageResolver: resolverForActors([{ actorId: `agent:${ctx.agentId}`, handle: '@coder' }]),
    }).send_message_to_task({
      task_id: task.id,
      target: '@coder',
      message: 'hello profile',
    });
    const parsed = JSON.parse(result.content[0].text);

    expect(parsed.success).toBe(true);
    expect(parsed.node_execution_id).toBe(exec.id);
    expect(tam.subSessionInjects[0]?.sessionId).toBe('coder-profile-session');
  });

  test('bare handle worker resolution picks the most recent matching execution', async () => {
    const wf = buildSingleStepWorkflow(
      ctx.spaceId,
      ctx.workflowManager,
      ctx.agentId,
      'WF Duplicate'
    );
    const { run, tasks } = await ctx.runtime.startWorkflowRun(ctx.spaceId, wf.id, 'Duplicate');
    const task = tasks[0];
    ctx.nodeExecutionRepo.createOrIgnore({
      workflowRunId: run.id,
      workflowNodeId: 'old-node',
      agentName: 'coder',
      agentSessionId: 'coder-old-session',
      status: 'in_progress',
    });
    // Ensure deterministic ordering: listByWorkflowRun orders by created_at ASC
    // then id ASC. A 2ms gap guarantees distinct timestamps across platforms.
    await new Promise((resolve) => setTimeout(resolve, 2));
    const latest = ctx.nodeExecutionRepo.createOrIgnore({
      workflowRunId: run.id,
      workflowNodeId: 'latest-node',
      agentName: 'coder',
      agentSessionId: 'coder-latest-session',
      status: 'in_progress',
    });

    const tam = makeFakeTaskAgentManager(ctx);
    const result = await makeHandlersWith(tam, {
      activateNode: async () => {},
    }).send_message_to_task({
      task_id: task.id,
      target: '@coder',
      message: 'hello latest',
    });
    const parsed = JSON.parse(result.content[0].text);

    expect(parsed.success).toBe(true);
    expect(parsed.node_execution_id).toBe(latest.id);
    expect(tam.subSessionInjects[0]?.sessionId).toBe('coder-latest-session');
  });

  test('target and node_id may agree on the same execution', async () => {
    const wf = buildSingleStepWorkflow(ctx.spaceId, ctx.workflowManager, ctx.agentId, 'WF Agree');
    const { run, tasks } = await ctx.runtime.startWorkflowRun(ctx.spaceId, wf.id, 'Agree');
    const task = tasks[0];
    const exec = ctx.nodeExecutionRepo.createOrIgnore({
      workflowRunId: run.id,
      workflowNodeId: wf.startNodeId,
      agentName: 'coder',
      agentSessionId: 'coder-agree-session',
      status: 'in_progress',
    });

    const tam = makeFakeTaskAgentManager(ctx);
    const result = await makeHandlersWith(tam, {
      activateNode: async () => {},
    }).send_message_to_task({
      task_id: task.id,
      target: '@coder',
      node_id: 'coder',
      message: 'hello agree',
    });
    const parsed = JSON.parse(result.content[0].text);

    expect(parsed.success).toBe(true);
    expect(parsed.node_execution_id).toBe(exec.id);
  });

  test('target and node_id disagree errors before message persistence', async () => {
    const wf = buildSingleStepWorkflow(
      ctx.spaceId,
      ctx.workflowManager,
      ctx.agentId,
      'WF Disagree'
    );
    const { run, tasks } = await ctx.runtime.startWorkflowRun(ctx.spaceId, wf.id, 'Disagree');
    const task = tasks[0];
    ctx.nodeExecutionRepo.createOrIgnore({
      workflowRunId: run.id,
      workflowNodeId: wf.startNodeId,
      agentName: 'coder',
      agentSessionId: 'coder-disagree-session',
      status: 'in_progress',
    });
    ctx.nodeExecutionRepo.createOrIgnore({
      workflowRunId: run.id,
      workflowNodeId: 'review-node',
      agentName: 'reviewer',
      agentSessionId: 'reviewer-disagree-session',
      status: 'in_progress',
    });
    const before = countSdkMessages();

    const tam = makeFakeTaskAgentManager(ctx);
    const result = await makeHandlersWith(tam, {
      activateNode: async () => {},
    }).send_message_to_task({
      task_id: task.id,
      target: '@coder',
      node_id: 'reviewer',
      message: 'hello disagree',
    });
    const parsed = JSON.parse(result.content[0].text);

    expect(parsed.success).toBe(false);
    expect(parsed.error).toContain('disagree');
    expect(countSdkMessages()).toBe(before);
    expect(tam.subSessionInjects).toHaveLength(0);
  });

  test('generic @session target resolves by task agent session id', async () => {
    const wf = buildSingleStepWorkflow(
      ctx.spaceId,
      ctx.workflowManager,
      ctx.agentId,
      'WF Generic Session'
    );
    const { run, tasks } = await ctx.runtime.startWorkflowRun(
      ctx.spaceId,
      wf.id,
      'Generic session target'
    );
    const task = tasks[0];
    const exec = ctx.nodeExecutionRepo.createOrIgnore({
      workflowRunId: run.id,
      workflowNodeId: wf.startNodeId,
      agentName: 'coder',
      agentSessionId: 'coder-generic-session',
      status: 'in_progress',
    });

    const tam = makeFakeTaskAgentManager(ctx);
    const handlers = makeHandlersWith(tam, { activateNode: async () => {} });
    const result = await handlers.send_message_to_task({
      task_id: task.id,
      target: '@session:coder-generic-session',
      message: 'session direct',
    });
    const parsed = JSON.parse(result.content[0].text);

    expect(parsed.success).toBe(true);
    expect(parsed.node_execution_id).toBe(exec.id);
    expect(tam.subSessionInjects).toEqual([
      {
        sessionId: 'coder-generic-session',
        message: spaceAgentToNodeEnvelope(task, 'session direct', 'coder'),
        isSyntheticMessage: true,
        sdkMessageId: 'sdk-message-0',
      },
    ]);
  });

  test('bare @handle matching only a long-horizon agent is rejected with task_id', async () => {
    const wf = buildSingleStepWorkflow(
      ctx.spaceId,
      ctx.workflowManager,
      ctx.agentId,
      'WF Handle DM'
    );
    const { tasks } = await ctx.runtime.startWorkflowRun(ctx.spaceId, wf.id, 'Handle DM target');
    const task = tasks[0];

    const tam = makeFakeTaskAgentManager(ctx);
    const handlers = createSpaceAgentToolHandlers({
      spaceId: ctx.spaceId,
      runtime: ctx.runtime,
      workflowManager: ctx.workflowManager,
      taskRepo: ctx.taskRepo,
      workflowRunRepo: ctx.workflowRunRepo,
      taskManager: ctx.taskManager,
      spaceAgentManager: ctx.agentManager,
      nodeExecutionRepo: ctx.nodeExecutionRepo,
      taskAgentManager: tam.manager,
      messageResolver: {
        async resolveTargets(message) {
          return {
            message,
            resolved: [
              {
                targetRef: '@reviewer',
                actor: {
                  actorId: 'agent:reviewer',
                  handle: '@reviewer',
                  displayName: 'Reviewer',
                  status: 'active',
                  sessionId: 'reviewer-session-old',
                },
              },
            ],
            unresolved: [],
          };
        },
      },
      longTermAgentDelivery: {
        async deliverToSession() {
          return 'reviewer-session-delivered';
        },
      },
    });

    const result = await handlers.send_message_to_task({
      task_id: task.id,
      target: '@reviewer',
      message: 'please review',
    });
    const parsed = JSON.parse(result.content[0].text);

    expect(parsed.success).toBe(false);
    expect(parsed.error).toContain('Ambiguous target');
    expect(parsed.error).toContain('@reviewer');
  });

  test('generic unsupported target kind returns an error', async () => {
    const wf = buildSingleStepWorkflow(
      ctx.spaceId,
      ctx.workflowManager,
      ctx.agentId,
      'WF Unsupported Generic'
    );
    const { tasks } = await ctx.runtime.startWorkflowRun(
      ctx.spaceId,
      wf.id,
      'Unsupported generic target'
    );
    const task = tasks[0];

    const tam = makeFakeTaskAgentManager(ctx);
    const result = await makeHandlersWith(tam).send_message_to_task({
      task_id: task.id,
      target: '@role:reviewer',
      message: 'bad target',
    });
    const parsed = JSON.parse(result.content[0].text);

    expect(parsed.success).toBe(false);
    expect(parsed.error).toContain('Long-term agent messaging is not available in this context.');
    expect(tam.subSessionInjects).toHaveLength(0);
  });

  test('generic unsupported target kind is rejected before node_id fallback', async () => {
    const wf = buildSingleStepWorkflow(
      ctx.spaceId,
      ctx.workflowManager,
      ctx.agentId,
      'WF Unsupported With Node'
    );
    const { run, tasks } = await ctx.runtime.startWorkflowRun(
      ctx.spaceId,
      wf.id,
      'Unsupported generic target with node id'
    );
    const task = tasks[0];
    ctx.nodeExecutionRepo.createOrIgnore({
      workflowRunId: run.id,
      workflowNodeId: wf.startNodeId,
      agentName: 'coder',
      agentSessionId: 'coder-valid-session',
      status: 'in_progress',
    });

    const tam = makeFakeTaskAgentManager(ctx);
    const result = await makeHandlersWith(tam).send_message_to_task({
      task_id: task.id,
      node_id: 'coder',
      target: '@role:reviewer',
      message: 'bad target wins',
    });
    const parsed = JSON.parse(result.content[0].text);

    expect(parsed.success).toBe(false);
    expect(parsed.error).toContain('Long-term agent messaging is not available in this context.');
    expect(tam.subSessionInjects).toHaveLength(0);
  });

  test('returns an error when node_id does not match any execution', async () => {
    const wf = buildSingleStepWorkflow(
      ctx.spaceId,
      ctx.workflowManager,
      ctx.agentId,
      'WF NotFound'
    );
    const { tasks } = await ctx.runtime.startWorkflowRun(ctx.spaceId, wf.id, 'run');
    const task = tasks[0];

    const tam = makeFakeTaskAgentManager(ctx);
    const handlers = makeHandlersWith(tam, { activateNode: async () => {} });
    const result = await handlers.send_message_to_task({
      task_id: task.id,
      node_id: 'nonexistent-agent',
      message: 'hi',
    });
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.success).toBe(false);
    expect(parsed.error).toContain('Node not found');
  });

  test('returns an error when node_id is provided but the task has no workflow run', async () => {
    const task = await createTask('No workflow task');
    expect(task.workflowRunId).toBeFalsy();

    const tam = makeFakeTaskAgentManager(ctx);
    const handlers = makeHandlersWith(tam, { activateNode: async () => {} });
    const result = await handlers.send_message_to_task({
      task_id: task.id,
      node_id: 'coder',
      message: 'hi',
    });
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.success).toBe(false);
    expect(parsed.error).toContain('no workflow run');
  });

  test('agent-name resolution is case-insensitive', async () => {
    const wf = buildSingleStepWorkflow(ctx.spaceId, ctx.workflowManager, ctx.agentId, 'WF Case');
    const { run, tasks } = await ctx.runtime.startWorkflowRun(ctx.spaceId, wf.id, 'Case run');
    const task = tasks[0];

    const exec = ctx.nodeExecutionRepo.createOrIgnore({
      workflowRunId: run.id,
      workflowNodeId: wf.startNodeId,
      agentName: 'Reviewer',
      agentSessionId: 'reviewer-session-1',
      status: 'in_progress',
    });

    const tam = makeFakeTaskAgentManager(ctx);
    const handlers = makeHandlersWith(tam, { activateNode: async () => {} });
    const result = await handlers.send_message_to_task({
      task_id: task.id,
      node_id: 'REVIEWER',
      message: 'please look again',
    });
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.success).toBe(true);
    expect(parsed.node_execution_id).toBe(exec.id);
    expect(tam.subSessionInjects).toEqual([
      {
        sessionId: 'reviewer-session-1',
        message: spaceAgentToNodeEnvelope(task, 'please look again', 'Reviewer'),
        isSyntheticMessage: true,
        sdkMessageId: 'sdk-message-0',
      },
    ]);
  });

  test('task_id takes precedence over task_number (returns error without node_id)', async () => {
    const taskA = await createTask('task A');
    const taskB = await createTask('task B');

    const tam = makeFakeTaskAgentManager(ctx);
    const result = await makeHandlersWith(tam).send_message_to_task({
      task_id: taskA.id,
      task_number: taskB.taskNumber,
      message: 'target A',
    });
    const parsed = JSON.parse(result.content[0].text);
    // task_id takes precedence but returns error because no node_id
    expect(parsed.success).toBe(false);
    expect(parsed.error).toMatch(/target agent is required/i);
  });

  test('falls back to activateNode when a previously-live session rejects injection', async () => {
    // Execution has an agentSessionId but the sub-session is dead (e.g. daemon
    // restart cleaned it up). First injection throws; handler must fall through
    // to activateNode, which revives the execution with a fresh session id.
    const wf = buildSingleStepWorkflow(ctx.spaceId, ctx.workflowManager, ctx.agentId, 'WF Dead');
    const { run, tasks } = await ctx.runtime.startWorkflowRun(ctx.spaceId, wf.id, 'Dead session');
    const task = tasks[0];
    const exec = ctx.nodeExecutionRepo.createOrIgnore({
      workflowRunId: run.id,
      workflowNodeId: wf.startNodeId,
      agentName: 'coder',
      agentSessionId: 'coder-dead',
      status: 'idle',
    });

    const tam = makeFakeTaskAgentManager(ctx);
    tam.deadSessionIds.add('coder-dead');
    const activateCalls: Array<[string, string]> = [];
    const handlers = makeHandlersWith(tam, {
      activateNode: async (runId, nodeId) => {
        activateCalls.push([runId, nodeId]);
        ctx.nodeExecutionRepo.update(exec.id, {
          status: 'in_progress',
          agentSessionId: 'coder-new',
        });
      },
    });

    const result = await handlers.send_message_to_task({
      task_id: task.id,
      node_id: 'coder',
      message: 'retry',
    });
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.success).toBe(true);
    expect(parsed.activated).toBe(true);
    expect(activateCalls).toEqual([[run.id, wf.startNodeId]]);
    expect(tam.subSessionInjects).toEqual([
      {
        sessionId: 'coder-new',
        message: spaceAgentToNodeEnvelope(task, 'retry', 'coder'),
        isSyntheticMessage: true,
        sdkMessageId: 'sdk-message-0',
      },
    ]);
  });

  test('returns an error when the target task belongs to a different space', async () => {
    const otherSpaceId = 'space-other-owner';
    seedSpaceRow(ctx.db, otherSpaceId, '/tmp/other-workspace');
    const foreignTaskId = `task-foreign-${Math.random().toString(36).slice(2)}`;
    ctx.db
      .prepare(
        `INSERT INTO space_tasks (id, space_id, task_number, title, description,
					status, priority, depends_on, created_at, updated_at)
				 VALUES (?, ?, 1, 'Foreign task', '', 'open', 'normal', '[]', ?, ?)`
      )
      .run(foreignTaskId, otherSpaceId, Date.now(), Date.now());

    const tam = makeFakeTaskAgentManager(ctx);
    const result = await makeHandlersWith(tam).send_message_to_task({
      task_id: foreignTaskId,
      message: 'hi',
    });
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.success).toBe(false);
    expect(parsed.error).toContain('does not belong to this space');
  });

  // -------------------------------------------------------------------------
  // Delivery traceability contract: every successful delivery must echo the
  // same delivered_session_id + sdk_message_id in BOTH the tool response and
  // the audit log, and ambiguous @handle + task_id routing must be rejected
  // with actionable, audited errors. See tasks #722/#723/#724 (PRs #2231–2233).
  // -------------------------------------------------------------------------
  describe('delivery traceability contract', () => {
    async function makeTracedTask(label: string) {
      const wf = buildSingleStepWorkflow(ctx.spaceId, ctx.workflowManager, ctx.agentId, label);
      const { run, tasks } = await ctx.runtime.startWorkflowRun(ctx.spaceId, wf.id, label);
      return { wf, run, task: tasks[0] };
    }

    test('live worker-node delivery echoes matching delivered_session_id and sdk_message_id in response and audit', async () => {
      const { wf, run, task } = await makeTracedTask('Trace live');
      ctx.nodeExecutionRepo.createOrIgnore({
        workflowRunId: run.id,
        workflowNodeId: wf.startNodeId,
        agentName: 'coder',
        agentSessionId: 'coder-live-trace',
        status: 'idle',
      });
      const auditLogRepo = new McpAuditLogRepository(ctx.db);
      const tam = makeFakeTaskAgentManager(ctx);
      const handlers = makeHandlersWith(tam, { auditLogRepo, activateNode: async () => {} });

      const result = await handlers.send_message_to_task({
        task_id: task.id,
        node_id: 'coder',
        message: 'trace me',
      });
      const parsed = JSON.parse(result.content[0].text);
      const audit = parseAuditSummaries(auditLogRepo, task.id);

      expect(parsed.success).toBe(true);
      expect(parsed.target).toBe('node');
      expect(parsed.delivered_session_id).toBe('coder-live-trace');
      expect(parsed.sdk_message_id).toBe('sdk-message-0');
      expect(audit).toHaveLength(1);
      expect(audit[0]).toMatchObject({ outcome: 'delivered', target: 'node' });
      // Traceability parity: the audit must point at the same session + SDK message.
      expect(audit[0].delivered_session_id).toBe(parsed.delivered_session_id);
      expect(audit[0].sdk_message_id).toBe(parsed.sdk_message_id);
    });

    test('activated worker-node delivery echoes matching identifiers in response and audit', async () => {
      const { wf, run, task } = await makeTracedTask('Trace activate');
      const exec = ctx.nodeExecutionRepo.createOrIgnore({
        workflowRunId: run.id,
        workflowNodeId: wf.startNodeId,
        agentName: 'reviewer',
        status: 'pending',
      });
      const auditLogRepo = new McpAuditLogRepository(ctx.db);
      const tam = makeFakeTaskAgentManager(ctx);
      const handlers = makeHandlersWith(tam, {
        auditLogRepo,
        activateNode: async () => {
          ctx.nodeExecutionRepo.update(exec.id, {
            status: 'in_progress',
            agentSessionId: 'reviewer-restored-trace',
          });
        },
      });

      const result = await handlers.send_message_to_task({
        task_id: task.id,
        node_id: 'reviewer',
        message: 'trace after activate',
      });
      const parsed = JSON.parse(result.content[0].text);
      const audit = parseAuditSummaries(auditLogRepo, task.id);

      expect(parsed.success).toBe(true);
      expect(parsed.activated).toBe(true);
      expect(parsed.delivered_session_id).toBe('reviewer-restored-trace');
      expect(parsed.sdk_message_id).toBe('sdk-message-0');
      expect(audit).toHaveLength(1);
      expect(audit[0]).toMatchObject({ outcome: 'delivered' });
      expect(audit[0].delivered_session_id).toBe(parsed.delivered_session_id);
      expect(audit[0].sdk_message_id).toBe(parsed.sdk_message_id);
    });

    test('space-coordinator handle delivery echoes matching delivered_session_id in response and audit', async () => {
      // @coordinator is the canonical handle→facade delivery path: it resolves
      // to the Space coordinator (no workflow worker collides), so it is the
      // one handle that is delivered rather than rejected as ambiguous.
      const { task } = await makeTracedTask('Trace coordinator');
      const auditLogRepo = new McpAuditLogRepository(ctx.db);
      const tam = makeFakeTaskAgentManager(ctx);
      const handlers = makeHandlersWith(tam, {
        auditLogRepo,
        activateNode: async () => {},
        messageResolver: {
          async resolveTargets(message) {
            return {
              resolved: [
                {
                  targetRef: message.targets[0],
                  address: { kind: 'handle', handle: 'coordinator' },
                  actor: {
                    actorId: `agent:coordinator:${ctx.spaceId}`,
                    kind: 'agent',
                    spaceId: ctx.spaceId,
                    handle: '@coordinator',
                    status: 'active',
                  },
                },
              ],
              unresolved: [],
            };
          },
        },
        longTermAgentDelivery: {
          deliverToSession: async () => 'coordinator-trace-session',
          queueForActivation: async () => null,
        },
      });

      const result = await handlers.send_message_to_task({
        task_id: task.id,
        target: '@coordinator',
        message: 'trace coordinator',
      });
      const parsed = JSON.parse(result.content[0].text);
      const audit = parseAuditSummaries(auditLogRepo, task.id);

      expect(parsed.success).toBe(true);
      expect(parsed.target).toBe('space-agent');
      expect(parsed.delivered_session_id).toBe('coordinator-trace-session');
      // Handle delivery routes through the facade, not SDK sub-session inject,
      // so it carries delivered_session_id but no sdk_message_id.
      expect(parsed.sdk_message_id).toBeUndefined();
      expect(audit).toHaveLength(1);
      expect(audit[0]).toMatchObject({ outcome: 'delivered', target: 'space-agent' });
      expect(audit[0].delivered_session_id).toBe(parsed.delivered_session_id);
      expect(audit[0].sdk_message_id).toBeUndefined();
    });

    test('single-worker @handle is delivered and audited, proving the ambiguity guard is precise', async () => {
      const { wf, run, task } = await makeTracedTask('Trace handle worker');
      ctx.nodeExecutionRepo.createOrIgnore({
        workflowRunId: run.id,
        workflowNodeId: wf.startNodeId,
        agentName: 'coder',
        agentSessionId: 'coder-handle-trace',
        status: 'in_progress',
      });
      const auditLogRepo = new McpAuditLogRepository(ctx.db);
      const tam = makeFakeTaskAgentManager(ctx);
      const handlers = makeHandlersWith(tam, { auditLogRepo, activateNode: async () => {} });

      const result = await handlers.send_message_to_task({
        task_id: task.id,
        target: '@coder',
        message: 'trace handle worker',
      });
      const parsed = JSON.parse(result.content[0].text);
      const audit = parseAuditSummaries(auditLogRepo, task.id);

      expect(parsed.success).toBe(true);
      expect(parsed.delivered_session_id).toBe('coder-handle-trace');
      expect(parsed.sdk_message_id).toBe('sdk-message-0');
      expect(audit).toHaveLength(1);
      expect(audit[0]).toMatchObject({ outcome: 'delivered' });
      expect(audit[0].delivered_session_id).toBe(parsed.delivered_session_id);
      expect(audit[0].sdk_message_id).toBe(parsed.sdk_message_id);
    });

    test('deferred (queued) delivery reports null identifiers and a non-delivered audit outcome', async () => {
      const { wf, run, task } = await makeTracedTask('Trace deferred');
      ctx.nodeExecutionRepo.createOrIgnore({
        workflowRunId: run.id,
        workflowNodeId: wf.startNodeId,
        agentName: 'reviewer',
        status: 'pending',
      });
      const auditLogRepo = new McpAuditLogRepository(ctx.db);
      const tam = makeFakeTaskAgentManager(ctx);
      const handlers = makeHandlersWith(tam, {
        auditLogRepo,
        activateNode: async () => {
          // Activation accepted but no live session yet — message is queued.
        },
        pendingMessageQueue: makeFakePendingMessageQueue(),
      });

      const result = await handlers.send_message_to_task({
        task_id: task.id,
        node_id: 'reviewer',
        message: 'trace deferred',
      });
      const parsed = JSON.parse(result.content[0].text);
      const audit = parseAuditSummaries(auditLogRepo, task.id);

      expect(parsed.success).toBe(true);
      expect(parsed.delivered_session_id).toBeNull();
      expect(parsed.sdk_message_id).toBeNull();
      expect(parsed.queued).toBe(true);
      expect(audit).toHaveLength(1);
      // Nothing was delivered, so the audit outcome must not claim a delivery.
      expect(audit[0].outcome).not.toBe('delivered');
      expect(audit[0]).toMatchObject({ outcome: 'queued' });
    });

    test('ambiguous @handle + task_id (long-horizon only) is rejected with actionable, audited error', async () => {
      const { task } = await makeTracedTask('Trace ambiguous LH');
      ctx.longHorizonAgentRepo.create({
        id: 'trace-reviewer-lh',
        spaceId: ctx.spaceId,
        handle: 'reviewer',
        displayName: 'Reviewer',
      });
      const before = countSdkMessages();
      const auditLogRepo = new McpAuditLogRepository(ctx.db);
      const tam = makeFakeTaskAgentManager(ctx);
      const result = await makeHandlersWith(tam, {
        auditLogRepo,
        messageResolver: resolverForActors([
          { actorId: 'agent:trace-reviewer-lh', handle: '@reviewer' },
        ]),
      }).send_message_to_task({ task_id: task.id, target: '@reviewer', message: 'which one' });
      const parsed = JSON.parse(result.content[0].text);
      const audit = parseAuditSummaries(auditLogRepo, task.id);

      expect(parsed.success).toBe(false);
      // Actionable: tells the caller exactly how to disambiguate.
      expect(parsed.error).toContain('Ambiguous target');
      expect(parsed.error).toContain('node_id');
      expect(parsed.error).toContain('@worker:');
      expect(parsed.error).toContain('send_session_message');
      expect(countSdkMessages()).toBe(before);
      expect(tam.subSessionInjects).toHaveLength(0);
      // Audited with a stable, machine-readable reason.
      expect(audit).toHaveLength(1);
      expect(audit[0]).toMatchObject({
        outcome: 'failed',
        reason: 'ambiguous_long_horizon_target',
        target: '@reviewer',
      });
    });

    test('ambiguous @handle + task_id (worker + long-horizon collision, no node_id) is rejected listing matched actors', async () => {
      const { wf, run, task } = await makeTracedTask('Trace ambiguous collision');
      ctx.nodeExecutionRepo.createOrIgnore({
        workflowRunId: run.id,
        workflowNodeId: wf.startNodeId,
        agentName: 'coder',
        agentSessionId: 'coder-collision',
        status: 'in_progress',
      });
      ctx.longHorizonAgentRepo.create({
        id: 'trace-coder-lh',
        spaceId: ctx.spaceId,
        handle: 'coder',
        displayName: 'Coder',
      });
      const before = countSdkMessages();
      const auditLogRepo = new McpAuditLogRepository(ctx.db);
      const tam = makeFakeTaskAgentManager(ctx);
      const result = await makeHandlersWith(tam, {
        auditLogRepo,
        messageResolver: resolverForActors([{ actorId: 'agent:trace-coder-lh', handle: '@coder' }]),
      }).send_message_to_task({ task_id: task.id, target: '@coder', message: 'which coder' });
      const parsed = JSON.parse(result.content[0].text);
      const audit = parseAuditSummaries(auditLogRepo, task.id);

      expect(parsed.success).toBe(false);
      expect(parsed.error).toContain('Ambiguous target');
      // Actionable: enumerates every matched recipient so the caller can pick one.
      expect(parsed.error).toContain('agent:trace-coder-lh');
      expect(parsed.error).toContain('workflow node "coder"');
      expect(countSdkMessages()).toBe(before);
      expect(tam.subSessionInjects).toHaveLength(0);
      expect(audit).toHaveLength(1);
      expect(audit[0]).toMatchObject({
        outcome: 'failed',
        reason: 'ambiguous_target',
        target: '@coder',
      });
    });
  });
});

// ---------------------------------------------------------------------------
// update_task
// ---------------------------------------------------------------------------

describe('createSpaceAgentToolHandlers — update_task', () => {
  let ctx: TestCtx;
  beforeEach(() => {
    ctx = makeCtx();
  });
  afterEach(() => {
    ctx.db.close();
  });

  test('updates title only', async () => {
    const created = await ctx.taskManager.createTask({
      title: 'Original title',
      description: 'Original desc',
    });
    const result = await makeHandlers(ctx).update_task({
      task_id: created.id,
      title: 'Updated title',
    });
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.success).toBe(true);
    expect(parsed.task.title).toBe('Updated title');
    expect(parsed.task.description).toBe('Original desc');
  });

  test('updates description only', async () => {
    const created = await ctx.taskManager.createTask({
      title: 'Task',
      description: 'Original desc',
    });
    const result = await makeHandlers(ctx).update_task({
      task_id: created.id,
      description: 'Updated desc',
    });
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.success).toBe(true);
    expect(parsed.task.description).toBe('Updated desc');
    expect(parsed.task.title).toBe('Task');
  });

  test('updates priority', async () => {
    const created = await ctx.taskManager.createTask({
      title: 'Task',
      description: 'Desc',
      priority: 'normal',
    });
    const result = await makeHandlers(ctx).update_task({
      task_id: created.id,
      priority: 'high',
    });
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.success).toBe(true);
    expect(parsed.task.priority).toBe('high');
  });

  test('updates dependencies', async () => {
    const dep = await ctx.taskManager.createTask({ title: 'Dep', description: '' });
    const created = await ctx.taskManager.createTask({
      title: 'Task',
      description: 'Desc',
    });
    const result = await makeHandlers(ctx).update_task({
      task_id: created.id,
      depends_on: [dep.id],
    });
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.success).toBe(true);
    expect(parsed.task.dependsOn).toEqual([dep.id]);
  });

  test('updates multiple fields at once', async () => {
    const created = await ctx.taskManager.createTask({
      title: 'Task',
      description: 'Desc',
      priority: 'normal',
    });
    const result = await makeHandlers(ctx).update_task({
      task_id: created.id,
      title: 'New title',
      description: 'New desc',
      priority: 'urgent',
    });
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.success).toBe(true);
    expect(parsed.task.title).toBe('New title');
    expect(parsed.task.description).toBe('New desc');
    expect(parsed.task.priority).toBe('urgent');
  });

  test('returns error when task not found', async () => {
    const result = await makeHandlers(ctx).update_task({
      task_id: 'task-missing',
      title: 'New title',
    });
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.success).toBe(false);
    expect(parsed.error).toContain('task-missing');
  });

  test('returns error when task belongs to a different space', async () => {
    const otherSpaceId = 'space-other';
    seedSpaceRow(ctx.db, otherSpaceId, '/tmp/other-workspace');
    const otherTaskManager = new SpaceTaskManager(ctx.db, otherSpaceId);
    const otherTask = await otherTaskManager.createTask({
      title: 'Foreign task',
      description: 'Belongs to a different space',
    });

    const result = await makeHandlers(ctx).update_task({
      task_id: otherTask.id,
      title: 'New title',
    });
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.success).toBe(false);
    expect(parsed.error).toContain('does not belong to this space');
  });

  test('rejects update when no fields are provided', async () => {
    const created = await ctx.taskManager.createTask({
      title: 'Task',
      description: 'Desc',
    });
    const result = await makeHandlers(ctx).update_task({
      task_id: created.id,
    });
    const parsed = JSON.parse(result.content[0].text);

    expect(parsed.success).toBe(false);
    expect(parsed.error).toContain('No fields to update');
  });

  test('publishes space.task.updated event via InternalEventBus', async () => {
    const emitted: Array<Record<string, unknown>> = [];
    const mockBus = {
      async publish(event: string, payload: Record<string, unknown>) {
        if (event === 'space.task.updated') {
          emitted.push(payload);
        }
      },
    };

    const created = await ctx.taskManager.createTask({
      title: 'Task',
      description: 'Desc',
    });
    const handlers = createSpaceAgentToolHandlers({
      spaceId: ctx.spaceId,
      runtime: ctx.runtime,
      workflowManager: ctx.workflowManager,
      taskRepo: ctx.taskRepo,
      workflowRunRepo: ctx.workflowRunRepo,
      taskManager: ctx.taskManager,
      spaceAgentManager: ctx.agentManager,
      nodeExecutionRepo: ctx.nodeExecutionRepo,
      internalEventBus:
        mockBus as unknown as import('../../../../src/lib/internal-event-bus').InternalEventBus<
          import('../../../../src/lib/internal-event-bus').DaemonInternalEventMap
        >,
    });

    await handlers.update_task({
      task_id: created.id,
      title: 'Updated title',
    });

    expect(emitted).toHaveLength(1);
    expect(emitted[0].spaceId).toBe(ctx.spaceId);
    expect(emitted[0].taskId).toBe(created.id);
    expect((emitted[0].task as { title: string }).title).toBe('Updated title');
  });

  test('publishes space.task.updated for cascaded dependency updates', async () => {
    const emitted: Array<Record<string, unknown>> = [];
    const mockBus = {
      publish: mock(async (event: string, payload: Record<string, unknown>) => {
        if (event === 'space.task.updated') emitted.push(payload);
      }),
    };

    const created = await ctx.taskManager.createTask({
      title: 'Task',
      description: 'Desc',
    });
    const cascadedTask: SpaceTask = {
      ...created,
      id: 'dependent-task',
      status: 'blocked',
      dependsOn: [created.id],
    };
    const updatedTask: SpaceTask = { ...created, title: 'Updated title' };
    const updateTask = mock(async (_taskId, _params, options) => {
      await options?.onCascadedTasks?.([cascadedTask]);
      return updatedTask;
    });
    const handlers = createSpaceAgentToolHandlers({
      spaceId: ctx.spaceId,
      runtime: ctx.runtime,
      workflowManager: ctx.workflowManager,
      taskRepo: ctx.taskRepo,
      workflowRunRepo: ctx.workflowRunRepo,
      taskManager: {
        updateTask,
      } as unknown as SpaceTaskManager,
      spaceAgentManager: ctx.agentManager,
      nodeExecutionRepo: ctx.nodeExecutionRepo,
      internalEventBus:
        mockBus as unknown as import('../../../../src/lib/internal-event-bus').InternalEventBus<
          import('../../../../src/lib/internal-event-bus').DaemonInternalEventMap
        >,
    });

    await handlers.update_task({
      task_id: created.id,
      title: 'Updated title',
    });

    expect(emitted.map((payload) => payload.taskId)).toEqual([cascadedTask.id, created.id]);
    expect(updateTask).toHaveBeenCalledWith(
      created.id,
      expect.objectContaining({ title: 'Updated title' }),
      expect.objectContaining({ onCascadedTasks: expect.any(Function) })
    );
  });

  test('registers update_task in createSpaceAgentMcpServer', () => {
    const server = createSpaceAgentMcpServer({
      spaceId: ctx.spaceId,
      runtime: ctx.runtime,
      workflowManager: ctx.workflowManager,
      taskRepo: ctx.taskRepo,
      nodeExecutionRepo: ctx.nodeExecutionRepo,
      workflowRunRepo: ctx.workflowRunRepo,
      taskManager: ctx.taskManager,
      spaceAgentManager: ctx.agentManager,
    });

    const names = getRegisteredToolNames(server);
    expect(names).toContain('update_task');
  });
});

// ---------------------------------------------------------------------------
// publish_task
// ---------------------------------------------------------------------------

describe('createSpaceAgentToolHandlers — publish_task', () => {
  let ctx: TestCtx;
  beforeEach(() => {
    ctx = makeCtx();
  });
  afterEach(() => {
    ctx.db.close();
  });

  test('publishes a draft task to open', async () => {
    const createResult = await makeHandlers(ctx).create_standalone_task({
      title: 'Draft task',
      description: 'Created as draft',
      draft: true,
    });
    const parsed = JSON.parse(createResult.content[0].text);
    expect(parsed.success).toBe(true);
    expect(parsed.task.status).toBe('draft');
    const taskId = parsed.task.id;

    const result = await makeHandlers(ctx).publish_task({ task_id: taskId });
    const publishParsed = JSON.parse(result.content[0].text);
    expect(publishParsed.success).toBe(true);
    expect(publishParsed.task.status).toBe('open');
    expect(publishParsed.task.id).toBe(taskId);
  });

  test('returns error when task is not in draft status', async () => {
    const createResult = await makeHandlers(ctx).create_standalone_task({
      title: 'Open task',
      description: 'Created as open',
    });
    const taskId = JSON.parse(createResult.content[0].text).task.id;

    const result = await makeHandlers(ctx).publish_task({ task_id: taskId });
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.success).toBe(false);
    expect(parsed.error).toContain("not 'draft'");
  });

  test('returns error when task not found', async () => {
    const result = await makeHandlers(ctx).publish_task({ task_id: 'task-nonexistent' });
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.success).toBe(false);
    expect(parsed.error).toContain('not found');
  });

  test('returns error when task belongs to different space', async () => {
    // Create task in current space
    const createResult = await makeHandlers(ctx).create_standalone_task({
      title: 'Draft',
      description: 'Test',
      draft: true,
    });
    const taskId = JSON.parse(createResult.content[0].text).task.id;

    // Create handlers for a different space
    const otherSpaceId = 'space-other';
    seedSpaceRow(ctx.db, otherSpaceId);
    const otherTaskManager = new SpaceTaskManager(ctx.db, otherSpaceId);
    const otherHandlers = createSpaceAgentToolHandlers({
      spaceId: otherSpaceId,
      runtime: ctx.runtime,
      workflowManager: ctx.workflowManager,
      taskRepo: ctx.taskRepo,
      workflowRunRepo: ctx.workflowRunRepo,
      taskManager: otherTaskManager,
      spaceAgentManager: ctx.agentManager,
      nodeExecutionRepo: ctx.nodeExecutionRepo,
    });

    const result = await otherHandlers.publish_task({ task_id: taskId });
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.success).toBe(false);
    expect(parsed.error).toContain('does not belong');
  });
});

// ---------------------------------------------------------------------------
// archive_task
// ---------------------------------------------------------------------------

describe('createSpaceAgentToolHandlers — archive_task', () => {
  let ctx: TestCtx;
  beforeEach(() => {
    ctx = makeCtx();
  });
  afterEach(() => {
    ctx.db.close();
  });

  test('archives a draft task', async () => {
    const createResult = await makeHandlers(ctx).create_standalone_task({
      title: 'Draft task',
      description: 'Will archive',
      draft: true,
    });
    const taskId = JSON.parse(createResult.content[0].text).task.id;

    const result = await makeHandlers(ctx).archive_task({ task_id: taskId });
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.success).toBe(true);
    expect(parsed.task.status).toBe('archived');
    expect(parsed.task.archivedAt).toBeTruthy();
  });

  test('archives a done task', async () => {
    const t = await ctx.taskManager.createTask({ title: 'T', description: 'Done' });
    await ctx.taskManager.startTask(t.id);
    await ctx.taskManager.completeTask(t.id, 'done');

    const result = await makeHandlers(ctx).archive_task({ task_id: t.id });
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.success).toBe(true);
    expect(parsed.task.status).toBe('archived');
  });

  test('archives a cancelled task', async () => {
    const createResult = await makeHandlers(ctx).create_standalone_task({
      title: 'Cancel then archive',
      description: 'Will cancel and archive',
    });
    const taskId = JSON.parse(createResult.content[0].text).task.id;

    // Cancel first
    await makeHandlers(ctx).cancel_task({ task_id: taskId });

    const result = await makeHandlers(ctx).archive_task({ task_id: taskId });
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.success).toBe(true);
    expect(parsed.task.status).toBe('archived');
  });

  test('returns error when task not found', async () => {
    const result = await makeHandlers(ctx).archive_task({ task_id: 'task-nonexistent' });
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.success).toBe(false);
    expect(parsed.error).toContain('not found');
  });

  test('returns error when task belongs to different space', async () => {
    const createResult = await makeHandlers(ctx).create_standalone_task({
      title: 'Draft',
      description: 'Test',
      draft: true,
    });
    const taskId = JSON.parse(createResult.content[0].text).task.id;

    const otherSpaceId = 'space-other-2';
    seedSpaceRow(ctx.db, otherSpaceId);
    const otherTaskManager = new SpaceTaskManager(ctx.db, otherSpaceId);
    const otherHandlers = createSpaceAgentToolHandlers({
      spaceId: otherSpaceId,
      runtime: ctx.runtime,
      workflowManager: ctx.workflowManager,
      taskRepo: ctx.taskRepo,
      workflowRunRepo: ctx.workflowRunRepo,
      taskManager: otherTaskManager,
      spaceAgentManager: ctx.agentManager,
      nodeExecutionRepo: ctx.nodeExecutionRepo,
    });

    const result = await otherHandlers.archive_task({ task_id: taskId });
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.success).toBe(false);
    expect(parsed.error).toContain('does not belong');
  });

  test('clears pending-completion fields when archiving from review', async () => {
    const createResult = await makeHandlers(ctx).create_standalone_task({
      title: 'Review task',
      description: 'Will archive from review',
    });
    const taskId = JSON.parse(createResult.content[0].text).task.id;

    // Submit for review to set pendingCheckpointType
    await ctx.taskManager.submitTaskForReview(taskId, {
      submittedByNodeId: null,
      reason: 'Test submission',
    });
    const reviewTask = ctx.taskRepo.getTask(taskId);
    expect(reviewTask?.pendingCheckpointType).toBe('task_completion');

    const result = await makeHandlers(ctx).archive_task({ task_id: taskId });
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.success).toBe(true);
    expect(parsed.task.status).toBe('archived');
    // setTaskStatus cleanup should have cleared pending-completion fields
    expect(parsed.task.pendingCheckpointType).toBeNull();
    expect(parsed.task.pendingCompletionSubmittedByNodeId).toBeNull();
    expect(parsed.task.pendingCompletionReason).toBeNull();
  });

  test('clears post-approval fields when archiving from approved', async () => {
    const createResult = await makeHandlers(ctx).create_standalone_task({
      title: 'Approved task',
      description: 'Will archive from approved',
    });
    const taskId = JSON.parse(createResult.content[0].text).task.id;

    // Transition to in_progress then approved (via setTaskStatus)
    await ctx.taskManager.startTask(taskId);
    await ctx.taskManager.setTaskStatus(taskId, 'approved', {
      approvalSource: 'human',
      approvalReason: 'LGTM',
    });

    const result = await makeHandlers(ctx).archive_task({ task_id: taskId });
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.success).toBe(true);
    expect(parsed.task.status).toBe('archived');
  });
});

// ---------------------------------------------------------------------------
// cancel_task on draft (verifies error message consistency)
// ---------------------------------------------------------------------------

describe('cancel_task on draft — error message consistency', () => {
  let ctx: TestCtx;
  beforeEach(() => {
    ctx = makeCtx();
  });
  afterEach(() => {
    ctx.db.close();
  });

  test('cancel_task on draft returns error with allowed transitions', async () => {
    const createResult = await makeHandlers(ctx).create_standalone_task({
      title: 'Draft task',
      description: 'Cannot cancel',
      draft: true,
    });
    const taskId = JSON.parse(createResult.content[0].text).task.id;

    const result = await makeHandlers(ctx).cancel_task({ task_id: taskId });
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.success).toBe(false);
    expect(parsed.error).toContain("'draft'");
    expect(parsed.error).toContain("'cancelled'");
    // Should mention what transitions ARE allowed from draft
    expect(parsed.error).toContain('open');
    expect(parsed.error).toContain('archived');
  });
});

// ---------------------------------------------------------------------------
// get_external_event (LH-agent / space-agent surface)
// ---------------------------------------------------------------------------

function makeGitHubExternalEvent(overrides: Partial<ExternalEvent> = {}): ExternalEvent {
  return {
    id: crypto.randomUUID(),
    spaceId: 'space-tools-test',
    source: 'github',
    topic: 'github/owner/repo/pull_request/42.closed',
    occurredAt: Date.now(),
    ingestedAt: Date.now(),
    summary: 'PR #42 closed',
    dedupeKey: `dedupe-${Math.random().toString(36).slice(2)}`,
    externalUrl: 'https://github.com/owner/repo/pull/42',
    payload: {
      eventType: 'pull_request',
      action: 'closed',
      actor: 'octocat',
      actorType: 'User',
      body: 'merging this',
      prNumber: 42,
      prUrl: 'https://github.com/owner/repo/pull/42',
      entityId: '42',
      repoOwner: 'owner',
      repoName: 'repo',
      deliveryId: 'delivery-1',
      externalId: 'ext-1',
      source: 'webhook',
      rawPayload: {
        pull_request: {
          id: 1,
          node_id: 'PR_node1',
          number: 42,
          html_url: 'https://github.com/owner/repo/pull/42',
          merged: true,
          state: 'closed',
        },
      },
    },
    ...overrides,
  };
}

describe('space-agent-tools: get_external_event', () => {
  let ctx: TestCtx;
  beforeEach(() => {
    ctx = makeCtx();
  });
  afterEach(() => {
    ctx.db.close();
  });

  test('returns the full record (incl. rawPayload) for a known eventId', async () => {
    const store = new ExternalEventStore(ctx.db);
    const event = makeGitHubExternalEvent({ spaceId: ctx.spaceId });
    store.store(event);

    const handlers = makeHandlers(ctx, { externalEventStore: store });
    const result = await handlers.get_external_event({ eventId: event.id });
    const data = JSON.parse(result.content[0].text);

    expect(data.success).toBe(true);
    expect(data.event.id).toBe(event.id);
    expect(data.event.payload.body).toBe('merging this');
    expect(data.event.payload.rawPayload.pull_request.node_id).toBe('PR_node1');
    expect(data.event.payload.actor).toBe('octocat');
    expect(data.event.payload.eventType).toBe('pull_request');
  });

  test('returns a not-found result for an unknown eventId', async () => {
    const store = new ExternalEventStore(ctx.db);
    const handlers = makeHandlers(ctx, { externalEventStore: store });
    const result = await handlers.get_external_event({ eventId: 'nope' });
    const data = JSON.parse(result.content[0].text);

    expect(data.success).toBe(false);
    expect(data.error).toContain('not found');
  });

  test('treats an event in another space as not-found (no cross-space leak)', async () => {
    const store = new ExternalEventStore(ctx.db);
    // Seed the foreign-space row so the event FK is satisfied; the lookup must
    // still reject it because the caller's space differs. Use a distinct
    // workspace_path — the column is UNIQUE.
    seedSpaceRow(ctx.db, 'space-other', '/tmp/space-other');
    const event = makeGitHubExternalEvent({ spaceId: 'space-other' });
    store.store(event);

    const handlers = makeHandlers(ctx, { externalEventStore: store });
    const result = await handlers.get_external_event({ eventId: event.id });
    const data = JSON.parse(result.content[0].text);

    expect(data.success).toBe(false);
    expect(data.error).toContain('not found');
  });

  test('createSpaceAgentMcpServer registers get_external_event only when the store is wired', () => {
    const store = new ExternalEventStore(ctx.db);

    const withoutStore = createSpaceAgentMcpServer({
      spaceId: ctx.spaceId,
      runtime: ctx.runtime,
      workflowManager: ctx.workflowManager,
      taskRepo: ctx.taskRepo,
      nodeExecutionRepo: ctx.nodeExecutionRepo,
      workflowRunRepo: ctx.workflowRunRepo,
      taskManager: ctx.taskManager,
      spaceAgentManager: ctx.agentManager,
    });
    expect(getRegisteredToolNames(withoutStore)).not.toContain('get_external_event');

    const withStore = createSpaceAgentMcpServer({
      spaceId: ctx.spaceId,
      runtime: ctx.runtime,
      workflowManager: ctx.workflowManager,
      taskRepo: ctx.taskRepo,
      nodeExecutionRepo: ctx.nodeExecutionRepo,
      workflowRunRepo: ctx.workflowRunRepo,
      taskManager: ctx.taskManager,
      spaceAgentManager: ctx.agentManager,
      externalEventStore: store,
    });
    expect(getRegisteredToolNames(withStore)).toContain('get_external_event');
  });
});

// ---------------------------------------------------------------------------
// Agent-level autonomy ceiling — min(space.autonomyLevel, agent.autonomyLevel)
//
// A long-term Space agent's `autonomyLevel` caps its effective autonomy for its
// own space-agent-tools calls. The ceiling only binds for `long_term_agent`
// role sessions (here: `myAgentId` resolves to a SpaceLongHorizonAgent in this
// space with a non-null level). Coordinators and ad-hoc members are uncapped.
// ---------------------------------------------------------------------------

describe('createSpaceAgentToolHandlers — agent-level autonomy ceiling', () => {
  let ctx: TestCtx;
  beforeEach(() => {
    ctx = makeCtx();
  });
  afterEach(() => {
    ctx.db.close();
  });

  function seedLongHorizonAgent(level: 1 | 2 | 3 | 4 | 5 | null, handle?: string): string {
    return ctx.longHorizonAgentRepo.create({
      spaceId: ctx.spaceId,
      handle: handle ?? `lh-l${level ?? 'null'}-${Math.random().toString(36).slice(2, 6)}`,
      displayName: `LH Agent L${level ?? '∅'}`,
      autonomyLevel: level,
    }).id;
  }

  function seedTargetSession(id: string): void {
    ctx.db
      .prepare(
        `INSERT INTO sessions (
          id, title, workspace_path, created_at, last_active_at, status, config, metadata,
          is_worktree, git_branch, processing_state, type, session_context
        ) VALUES (?, ?, ?, ?, ?, 'active', '{}', '{}', 1, 'feature/x', ?, 'worker', ?)`
      )
      .run(
        id,
        `Session ${id}`,
        '/tmp/session-workspace',
        new Date(0).toISOString(),
        new Date().toISOString(),
        JSON.stringify({ status: 'idle' }),
        JSON.stringify({ spaceId: ctx.spaceId })
      );
  }

  function createReviewTaskWithCompletionLevel(requiredLevel: 1 | 2 | 3 | 4 | 5): string {
    const nodeId = `node-${Math.random().toString(36).slice(2)}`;
    const workflow = ctx.workflowManager.createWorkflow({
      spaceId: ctx.spaceId,
      name: `Completion ${requiredLevel} WF`,
      description: '',
      nodes: [{ id: nodeId, name: 'Work', agentId: ctx.agentId }],
      transitions: [],
      startNodeId: nodeId,
      endNodeId: nodeId,
      rules: [],
      completionAutonomyLevel: requiredLevel,
    });
    const run = ctx.workflowRunRepo.createRun({
      spaceId: ctx.spaceId,
      workflowId: workflow.id,
      title: 'completion run',
      description: '',
    });
    const task = ctx.taskRepo.createTask({
      spaceId: ctx.spaceId,
      title: 'Review task',
      description: '',
      status: 'review',
      workflowRunId: run.id,
    });
    return task.id;
  }

  test('level-1 long-horizon agent is blocked from session-write at space level 5', async () => {
    await ctx.spaceManager.updateSpace(ctx.spaceId, { autonomyLevel: 5 });
    const agentId = seedLongHorizonAgent(1);
    seedTargetSession('ceiling-target-blocked');
    const handlers = makeHandlers(ctx, {
      myAgentId: agentId,
      mySessionId: 'caller-session',
      getSpaceAutonomyLevel: async () => 5,
      getRuntimeSession: () => ({ startQueryAndEnqueue: async () => {} }) as never,
    });

    const parsed = parseResult(
      await handlers.send_session_message({
        session_id: 'ceiling-target-blocked',
        message: 'proceed',
      })
    );

    expect(parsed.success).toBe(false);
    expect(String(parsed.error)).toContain('agent autonomy ceiling 1');
    expect(String(parsed.error)).toContain('space 5');
  });

  test('level-5 long-horizon agent is unaffected by the ceiling at space level 5', async () => {
    await ctx.spaceManager.updateSpace(ctx.spaceId, { autonomyLevel: 5 });
    const agentId = seedLongHorizonAgent(5);
    seedTargetSession('ceiling-target-ok');
    const handlers = makeHandlers(ctx, {
      myAgentId: agentId,
      mySessionId: 'caller-session',
      getSpaceAutonomyLevel: async () => 5,
      getRuntimeSession: () => ({ startQueryAndEnqueue: async () => {} }) as never,
    });

    const parsed = parseResult(
      await handlers.send_session_message({
        session_id: 'ceiling-target-ok',
        message: 'proceed',
      })
    );

    expect(parsed.success).toBe(true);
  });

  test('ceiling is min(space, agent): level-3 agent at space 5 still cannot session-write (needs 4)', async () => {
    await ctx.spaceManager.updateSpace(ctx.spaceId, { autonomyLevel: 5 });
    const agentId = seedLongHorizonAgent(3);
    seedTargetSession('ceiling-target-min');
    const handlers = makeHandlers(ctx, {
      myAgentId: agentId,
      mySessionId: 'caller-session',
      getSpaceAutonomyLevel: async () => 5,
      getRuntimeSession: () => ({ startQueryAndEnqueue: async () => {} }) as never,
    });

    const parsed = parseResult(
      await handlers.send_session_message({
        session_id: 'ceiling-target-min',
        message: 'proceed',
      })
    );

    expect(parsed.success).toBe(false);
    expect(String(parsed.error)).toContain('agent autonomy ceiling 3');
  });

  test('long-horizon agent with no autonomyLevel is uncapped — space level governs', async () => {
    await ctx.spaceManager.updateSpace(ctx.spaceId, { autonomyLevel: 3 });
    const agentId = seedLongHorizonAgent(null);
    seedTargetSession('ceiling-target-uncapped');
    const handlers = makeHandlers(ctx, {
      myAgentId: agentId,
      mySessionId: 'caller-session',
      getSpaceAutonomyLevel: async () => 3,
      getRuntimeSession: () => ({ startQueryAndEnqueue: async () => {} }) as never,
    });

    const parsed = parseResult(
      await handlers.send_session_message({
        session_id: 'ceiling-target-uncapped',
        message: 'proceed',
      })
    );

    expect(parsed.success).toBe(false);
    const error = String(parsed.error);
    expect(error).toContain('space autonomy level 3');
    expect(error).not.toContain('agent autonomy ceiling');
  });

  test('approve_task: level-1 agent is blocked at space level 5 (completion level 5)', async () => {
    await ctx.spaceManager.updateSpace(ctx.spaceId, { autonomyLevel: 5 });
    const agentId = seedLongHorizonAgent(1);
    const taskId = createReviewTaskWithCompletionLevel(5);
    const handlers = makeHandlers(ctx, { myAgentId: agentId, mySessionId: 'caller-session' });

    const parsed = parseResult(await handlers.approve_task({ task_id: taskId }));
    expect(parsed.success).toBe(false);
    expect(String(parsed.error)).toContain('agent autonomy ceiling 1');
    expect(ctx.taskRepo.getTask(taskId)?.status).toBe('review');
  });

  test('approve_task: min() boundary — level-3 agent at space 5 with completion 3 succeeds', async () => {
    await ctx.spaceManager.updateSpace(ctx.spaceId, { autonomyLevel: 5 });
    const agentId = seedLongHorizonAgent(3);
    const taskId = createReviewTaskWithCompletionLevel(3);
    const handlers = makeHandlers(ctx, { myAgentId: agentId, mySessionId: 'caller-session' });

    const parsed = parseResult(await handlers.approve_task({ task_id: taskId, reason: 'ok' }));
    expect(parsed.success).toBe(true);
    expect(ctx.taskRepo.getTask(taskId)?.status).toBe('done');
  });

  test('ceiling-blocked session-write denial is recorded in the audit log', async () => {
    await ctx.spaceManager.updateSpace(ctx.spaceId, { autonomyLevel: 5 });
    const agentId = seedLongHorizonAgent(1);
    const auditLogRepo = new McpAuditLogRepository(ctx.db);
    seedTargetSession('ceiling-target-audit');
    const handlers = makeHandlers(ctx, {
      myAgentId: agentId,
      mySessionId: 'caller-session',
      getSpaceAutonomyLevel: async () => 5,
      auditLogRepo,
      getRuntimeSession: () => ({ startQueryAndEnqueue: async () => {} }) as never,
    });

    await handlers.send_session_message({
      session_id: 'ceiling-target-audit',
      message: 'proceed',
    });

    const denial = auditLogRepo
      .listBySpace(ctx.spaceId)
      .find((entry) => entry.toolName === 'send_session_message');
    expect(denial).toBeDefined();
    const summary = JSON.parse(denial?.paramsSummary ?? '{}') as Record<string, unknown>;
    expect(summary.blocked).toBe(true);
    expect(summary.reason).toBe('agent_autonomy_ceiling');
    expect(summary.agentLevel).toBe(1);
  });

  // -------------------------------------------------------------------------
  // Cross-space guard: myAgentId pointing at an LH agent in another space is
  // treated as "not this space's agent" → uncapped, space level governs.
  // -------------------------------------------------------------------------

  test('myAgentId resolving to an agent in another space is uncapped', async () => {
    await ctx.spaceManager.updateSpace(ctx.spaceId, { autonomyLevel: 3 });
    // Agent lives in a different space.
    const otherSpaceId = 'space-ceiling-other';
    seedSpaceRow(ctx.db, otherSpaceId, '/tmp/other');
    const otherAgentId = ctx.longHorizonAgentRepo.create({
      spaceId: otherSpaceId,
      handle: `lh-other-${Math.random().toString(36).slice(2, 6)}`,
      displayName: 'Other-space Agent',
      autonomyLevel: 1,
    }).id;
    seedTargetSession('ceiling-target-cross-space');
    const handlers = makeHandlers(ctx, {
      myAgentId: otherAgentId,
      mySessionId: 'caller-session',
      getSpaceAutonomyLevel: async () => 3,
      getRuntimeSession: () => ({ startQueryAndEnqueue: async () => {} }) as never,
    });

    const parsed = parseResult(
      await handlers.send_session_message({
        session_id: 'ceiling-target-cross-space',
        message: 'proceed',
      })
    );

    // Space level 3 < 4 blocks the call, but via the SPACE constraint — the
    // foreign agent contributes no ceiling.
    expect(parsed.success).toBe(false);
    const error = String(parsed.error);
    expect(error).toContain('space autonomy level 3');
    expect(error).not.toContain('agent autonomy ceiling');
  });

  // -------------------------------------------------------------------------
  // Boundary: exactly agentLevel 4 meets the session-write requirement (4).
  // -------------------------------------------------------------------------

  test('session-write boundary: level-4 agent at space 5 is permitted (effective 4 >= 4)', async () => {
    await ctx.spaceManager.updateSpace(ctx.spaceId, { autonomyLevel: 5 });
    const agentId = seedLongHorizonAgent(4);
    seedTargetSession('ceiling-target-boundary');
    const handlers = makeHandlers(ctx, {
      myAgentId: agentId,
      mySessionId: 'caller-session',
      getSpaceAutonomyLevel: async () => 5,
      getRuntimeSession: () => ({ startQueryAndEnqueue: async () => {} }) as never,
    });

    const parsed = parseResult(
      await handlers.send_session_message({
        session_id: 'ceiling-target-boundary',
        message: 'proceed',
      })
    );

    expect(parsed.success).toBe(true);
  });

  // -------------------------------------------------------------------------
  // Audit: ceiling denial is recorded for an approve path, not just
  // send_session_message.
  // -------------------------------------------------------------------------

  test('ceiling-blocked approve_task denial is recorded in the audit log', async () => {
    await ctx.spaceManager.updateSpace(ctx.spaceId, { autonomyLevel: 5 });
    const agentId = seedLongHorizonAgent(1);
    const taskId = createReviewTaskWithCompletionLevel(5);
    const auditLogRepo = new McpAuditLogRepository(ctx.db);
    const handlers = makeHandlers(ctx, {
      myAgentId: agentId,
      mySessionId: 'caller-session',
      auditLogRepo,
    });

    await handlers.approve_task({ task_id: taskId });

    const denial = auditLogRepo
      .listByTask(taskId)
      .find((entry) => entry.toolName === 'approve_task');
    expect(denial).toBeDefined();
    expect(denial?.taskId).toBe(taskId);
    const summary = JSON.parse(denial?.paramsSummary ?? '{}') as Record<string, unknown>;
    expect(summary.blocked).toBe(true);
    expect(summary.reason).toBe('agent_autonomy_ceiling');
    expect(summary.agentLevel).toBe(1);
  });

  // -------------------------------------------------------------------------
  // Bypass hardening: the ceiling must not be evadable by renaming the agent
  // to a coordinator-like name. The coordinator exemption only applies to the
  // real space coordinator (no calling agent id).
  // -------------------------------------------------------------------------

  test('send_session_message: a level-1 agent named "space-agent" is still ceiling-gated', async () => {
    await ctx.spaceManager.updateSpace(ctx.spaceId, { autonomyLevel: 5 });
    const agentId = seedLongHorizonAgent(1);
    seedTargetSession('ceiling-target-coordinator-name');
    const handlers = makeHandlers(ctx, {
      myAgentId: agentId,
      myAgentName: 'space-agent',
      mySessionId: 'caller-session',
      getSpaceAutonomyLevel: async () => 5,
      getRuntimeSession: () => ({ startQueryAndEnqueue: async () => {} }) as never,
    });

    const parsed = parseResult(
      await handlers.send_session_message({
        session_id: 'ceiling-target-coordinator-name',
        message: 'proceed',
      })
    );

    expect(parsed.success).toBe(false);
    expect(String(parsed.error)).toContain('agent autonomy ceiling 1');
  });

  // -------------------------------------------------------------------------
  // Fail closed: a long-horizon agent whose record was deleted while its
  // session is still live must not silently become uncapped.
  // -------------------------------------------------------------------------

  test('a deleted long-horizon agent record fails closed at level 1', async () => {
    await ctx.spaceManager.updateSpace(ctx.spaceId, { autonomyLevel: 5 });
    const agentId = seedLongHorizonAgent(1);
    // Simulate the agent being deleted while the session stays live.
    ctx.db.prepare('DELETE FROM space_long_horizon_agents WHERE id = ?').run(agentId);
    seedTargetSession('ceiling-target-deleted');
    const handlers = makeHandlers(ctx, {
      myAgentId: agentId,
      mySessionId: 'caller-session',
      getSpaceAutonomyLevel: async () => 5,
      getRuntimeSession: () => ({ startQueryAndEnqueue: async () => {} }) as never,
    });

    const parsed = parseResult(
      await handlers.send_session_message({
        session_id: 'ceiling-target-deleted',
        message: 'proceed',
      })
    );

    expect(parsed.success).toBe(false);
    expect(String(parsed.error)).toContain('agent autonomy ceiling 1');
  });

  // -------------------------------------------------------------------------
  // Child ceiling inheritance: a restricted caller cannot spawn an uncapped
  // child to bypass its own ceiling.
  // -------------------------------------------------------------------------

  test('create_agent: child inherits the level-1 caller ceiling (cannot bypass)', async () => {
    await ctx.spaceManager.updateSpace(ctx.spaceId, { autonomyLevel: 5 });
    const agentId = seedLongHorizonAgent(1);
    const handlers = makeHandlers(ctx, {
      myAgentId: agentId,
      mySessionId: 'caller-session',
      getSpaceAutonomyLevel: async () => 5,
    });

    const parsed = parseResult(await handlers.create_agent({ name: 'Child Agent' }));

    expect(parsed.success).toBe(true);
    expect((parsed.agent as { autonomyLevel: number | null }).autonomyLevel).toBe(1);
  });

  test('create_agent: an uncapped caller spawns an uncapped (null) child', async () => {
    const handlers = makeHandlers(ctx, { mySessionId: 'caller-session' });

    const parsed = parseResult(await handlers.create_agent({ name: 'Free Child' }));

    expect(parsed.success).toBe(true);
    expect((parsed.agent as { autonomyLevel: number | null }).autonomyLevel).toBeNull();
  });
});
