import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { Database as BunDatabase } from '../../../../src/storage/sqlite-compat';

import { buildSpaceChatSystemPrompt } from '../../../../src/lib/space/agents/space-chat-agent';
import { runMigrations } from '../../../../src/storage/schema/index.ts';
import { SpaceTaskRepository } from '../../../../src/storage/repositories/space-task-repository.ts';
import { SpaceWorkflowRepository } from '../../../../src/storage/repositories/space-workflow-repository.ts';
import { SpaceWorkflowRunRepository } from '../../../../src/storage/repositories/space-workflow-run-repository.ts';
import { SpaceAgentRepository } from '../../../../src/storage/repositories/space-agent-repository.ts';
import { NodeExecutionRepository } from '../../../../src/storage/repositories/node-execution-repository.ts';
import { SpaceAgentManager } from '../../../../src/lib/space/managers/space-agent-manager.ts';
import { SpaceWorkflowManager } from '../../../../src/lib/space/managers/space-workflow-manager.ts';
import { SpaceTaskManager } from '../../../../src/lib/space/managers/space-task-manager.ts';
import { SpaceManager } from '../../../../src/lib/space/managers/space-manager.ts';
import { SpaceRuntime } from '../../../../src/lib/space/runtime/space-runtime.ts';
import { createSpaceAgentToolHandlers } from '../../../../src/lib/space/tools/space-agent-tools.ts';
import type { SpaceAutonomyLevel } from '@hyperneo/shared/types/space';

function makeDb(): BunDatabase {
  const db = new BunDatabase(':memory:');
  db.exec('PRAGMA foreign_keys = ON');
  runMigrations(db, () => {});
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

interface TestCtx {
  db: BunDatabase;
  spaceId: string;
  agentId: string;
  workflowManager: SpaceWorkflowManager;
  workflowRunRepo: SpaceWorkflowRunRepository;
  taskRepo: SpaceTaskRepository;
  taskManager: SpaceTaskManager;
  agentManager: SpaceAgentManager;
  spaceManager: SpaceManager;
  runtime: SpaceRuntime;
  nodeExecutionRepo: NodeExecutionRepository;
}

function makeCtx(): TestCtx {
  const db = makeDb();
  const spaceId = 'space-autonomy-test';
  const workspacePath = '/tmp/test-workspace';

  seedSpaceRow(db, spaceId, workspacePath);

  const agentId = 'agent-coder-1';
  seedAgentRow(db, agentId, spaceId, 'Coder');

  const agentRepo = new SpaceAgentRepository(db);
  const agentManager = new SpaceAgentManager(agentRepo);

  const workflowRepo = new SpaceWorkflowRepository(db);
  const workflowManager = new SpaceWorkflowManager(workflowRepo);

  const workflowRunRepo = new SpaceWorkflowRunRepository(db);
  const taskRepo = new SpaceTaskRepository(db);
  const spaceManager = new SpaceManager(db);
  const nodeExecutionRepo = new NodeExecutionRepository(db);

  const runtime = new SpaceRuntime({
    db,
    spaceManager,
    spaceAgentManager: agentManager,
    spaceWorkflowManager: workflowManager,
    workflowRunRepo,
    taskRepo,
    nodeExecutionRepo,
  });

  const taskManager = new SpaceTaskManager(db, spaceId);

  return {
    db,
    spaceId,
    agentId,
    workflowManager,
    workflowRunRepo,
    taskRepo,
    taskManager,
    agentManager,
    spaceManager,
    runtime,
    nodeExecutionRepo,
  };
}

function makeHandlers(ctx: TestCtx) {
  return createSpaceAgentToolHandlers({
    spaceId: ctx.spaceId,
    runtime: ctx.runtime,
    workflowManager: ctx.workflowManager,
    spaceManager: ctx.spaceManager,
    taskRepo: ctx.taskRepo,
    nodeExecutionRepo: ctx.nodeExecutionRepo,
    workflowRunRepo: ctx.workflowRunRepo,
    taskManager: ctx.taskManager,
    spaceAgentManager: ctx.agentManager,
  });
}

describe('buildSpaceChatSystemPrompt — level 1 (supervised) autonomy', () => {
  test('explicitly labels the space at autonomy level 1', () => {
    const prompt = buildSpaceChatSystemPrompt({ autonomyLevel: 1 });
    expect(prompt).toContain('autonomy level **1**');
  });

  test('instructs agent to notify human of every TASK_EVENT', () => {
    const prompt = buildSpaceChatSystemPrompt({ autonomyLevel: 1 });
    expect(prompt).toContain('Do not retry');
    expect(prompt).toContain('without explicit human instruction');
    expect(prompt).toContain('[TASK_EVENT]');
  });

  test('instructs agent to wait for human approval before acting', () => {
    const prompt = buildSpaceChatSystemPrompt({ autonomyLevel: 1 });
    expect(prompt).toContain('Provide recommendation and wait');
  });

  test('instructs agent NOT to call retry without explicit instruction', () => {
    const prompt = buildSpaceChatSystemPrompt({ autonomyLevel: 1 });
    expect(prompt).toContain('retry');
    expect(prompt).toContain('without explicit human instruction');
  });

  test('instructs agent NOT to reassign or cancel without explicit instruction', () => {
    const prompt = buildSpaceChatSystemPrompt({ autonomyLevel: 1 });
    expect(prompt).toContain('reassign');
    expect(prompt).toContain('cancel');
  });

  test('does NOT include level >= 3 autonomous-action instructions', () => {
    const prompt = buildSpaceChatSystemPrompt({ autonomyLevel: 1 });
    expect(prompt).not.toContain('act without human approval');
  });
});

describe('buildSpaceChatSystemPrompt — level 3 (semi-autonomous) autonomy', () => {
  test('explicitly labels the space at autonomy level 3', () => {
    const prompt = buildSpaceChatSystemPrompt({ autonomyLevel: 3 });
    expect(prompt).toContain('autonomy level **3**');
  });

  test('allows retrying a failed task once without human approval', () => {
    const prompt = buildSpaceChatSystemPrompt({ autonomyLevel: 3 });
    expect(prompt).toContain('retry a failed task once');
    expect(prompt).toContain('retry');
  });

  test('allows reassigning a task without human approval', () => {
    const prompt = buildSpaceChatSystemPrompt({ autonomyLevel: 3 });
    expect(prompt).toContain('reassign');
  });

  test('instructs agent to escalate after one failed retry', () => {
    const prompt = buildSpaceChatSystemPrompt({ autonomyLevel: 3 });
    expect(prompt).toContain('one failed retry');
    expect(prompt).toMatch(/escalate/i);
  });

  test('workflow gates above configured level still require human approval', () => {
    const prompt = buildSpaceChatSystemPrompt({ autonomyLevel: 3 });
    expect(prompt).toContain('Never bypass gates');
  });

  test('does NOT include the level 1 "wait for human approval" restriction for all events', () => {
    const prompt = buildSpaceChatSystemPrompt({ autonomyLevel: 3 });
    expect(prompt).not.toContain('wait for human approval');
  });
});

describe('buildSpaceChatSystemPrompt — level 4 (act-first) autonomy', () => {
  test('explicitly labels the space at autonomy level 4', () => {
    const prompt = buildSpaceChatSystemPrompt({ autonomyLevel: 4 });
    expect(prompt).toContain('autonomy level **4**');
  });

  test('defaults to acting then reporting on reversible decisions', () => {
    const prompt = buildSpaceChatSystemPrompt({ autonomyLevel: 4 });
    expect(prompt).toContain('Default to acting');
    expect(prompt).toContain('do not ask permission first');
  });

  test('escalates only on irreversibility, not on plain uncertainty', () => {
    const prompt = buildSpaceChatSystemPrompt({ autonomyLevel: 4 });
    expect(prompt).not.toContain('or uncertainty');
    expect(prompt).toMatch(/irreversible/i);
  });

  test('graduates distinctly from level 3 and level 5', () => {
    const l3 = buildSpaceChatSystemPrompt({ autonomyLevel: 3 });
    const l4 = buildSpaceChatSystemPrompt({ autonomyLevel: 4 });
    const l5 = buildSpaceChatSystemPrompt({ autonomyLevel: 5 });
    expect(l4).not.toEqual(l3);
    expect(l4).not.toEqual(l5);
  });

  test('workflow gates above configured level still require human approval', () => {
    const prompt = buildSpaceChatSystemPrompt({ autonomyLevel: 4 });
    expect(prompt).toContain('Never bypass gates');
  });

  test('escalation at L4 does not hard-code a question into every escalation', () => {
    const prompt = buildSpaceChatSystemPrompt({ autonomyLevel: 4 });
    const escalation = prompt.split('## Escalation')[1]?.split('##')[0] ?? '';
    expect(escalation).toContain('Prefer acting and reporting');
    expect(escalation).not.toContain('and one direct question');
  });
});

describe('buildSpaceChatSystemPrompt — default autonomy level (level 1 fallback)', () => {
  test('omitting autonomyLevel defaults to level 1', () => {
    const prompt = buildSpaceChatSystemPrompt({});
    expect(prompt).toContain('autonomy level **1**');
  });

  test('calling with no arguments defaults to level 1', () => {
    const prompt = buildSpaceChatSystemPrompt();
    expect(prompt).toContain('autonomy level **1**');
  });

  test('no-arg prompt includes notify-human instruction', () => {
    const prompt = buildSpaceChatSystemPrompt();
    expect(prompt).toContain('Do not retry');
    expect(prompt).toContain('wait');
  });

  test('no-arg prompt does not include level >= 3 retry-autonomously instruction', () => {
    const prompt = buildSpaceChatSystemPrompt();
    expect(prompt).not.toContain('act without human approval');
  });

  test('default prompt and explicit level 1 prompt are identical', () => {
    const defaultPrompt = buildSpaceChatSystemPrompt();
    const level1Prompt = buildSpaceChatSystemPrompt({ autonomyLevel: 1 });
    expect(defaultPrompt).toBe(level1Prompt);
  });
});

describe('retry_task tool — autonomy level does not affect tool behavior', () => {
  let ctx: TestCtx;
  beforeEach(() => {
    ctx = makeCtx();
  });
  afterEach(() => {
    ctx.db.close();
  });

  function createNeedsAttentionTask(ctx: TestCtx): string {
    const taskId = `task-retry-${Math.random().toString(36).slice(2)}`;
    ctx.db
      .prepare(
        `INSERT INTO space_tasks
         (id, space_id, task_number, title, description, status, priority, created_at, updated_at)
         VALUES (?, ?, (SELECT COALESCE(MAX(task_number), 0) + 1 FROM space_tasks WHERE space_id = ?), ?, ?, 'blocked', 'normal', ?, ?)`
      )
      .run(
        taskId,
        ctx.spaceId,
        ctx.spaceId,
        'Failing task',
        'Task that needs attention',
        Date.now(),
        Date.now()
      );
    return taskId;
  }

  test('retry_task tool resets needs_attention task to pending — no autonomy gate in tool code', async () => {
    const taskId = createNeedsAttentionTask(ctx);
    const handlers = makeHandlers(ctx);

    const result = await handlers.retry_task({ task_id: taskId });
    const parsed = JSON.parse(result.content[0].text);

    expect(parsed.success).toBe(true);
    expect(parsed.task.id).toBe(taskId);
    expect(parsed.task.status).toBe('open');
  });

  test('retry_task with description update succeeds regardless of autonomy level', async () => {
    const taskId = createNeedsAttentionTask(ctx);
    const handlers = makeHandlers(ctx);

    const result = await handlers.retry_task({
      task_id: taskId,
      description: 'Updated description with root cause fix',
    });
    const parsed = JSON.parse(result.content[0].text);

    expect(parsed.success).toBe(true);
    expect(parsed.task.status).toBe('open');
    expect(parsed.task.description).toBe('Updated description with root cause fix');
  });

  test('retry_task returns error for non-existent task', async () => {
    const handlers = makeHandlers(ctx);

    const result = await handlers.retry_task({ task_id: 'non-existent-task' });
    const parsed = JSON.parse(result.content[0].text);

    expect(parsed.success).toBe(false);
    expect(typeof parsed.error).toBe('string');
  });

  test('tool succeeds but prompts differ — supervised restricts, semi_autonomous permits autonomous retry', async () => {
    const taskId = createNeedsAttentionTask(ctx);
    const result = await makeHandlers(ctx).retry_task({ task_id: taskId });
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.success).toBe(true);

    const supervisedPrompt = buildSpaceChatSystemPrompt({ autonomyLevel: 1 });
    const semiPrompt = buildSpaceChatSystemPrompt({ autonomyLevel: 3 });

    expect(supervisedPrompt).toContain('retry');
    expect(semiPrompt).toContain('retry');

    expect(supervisedPrompt).toContain('without explicit human instruction');
    expect(semiPrompt).toContain('retry a failed task once');
  });
});

describe('space-agent-tools approve_task — completion autonomy', () => {
  let ctx: TestCtx;

  beforeEach(() => {
    ctx = makeCtx();
  });

  afterEach(() => {
    ctx.db.close();
  });

  function createReviewTaskWithWorkflow(requiredLevel: SpaceAutonomyLevel) {
    const nodeId = `node-${Math.random().toString(36).slice(2)}`;
    const workflow = ctx.workflowManager.createWorkflow({
      spaceId: ctx.spaceId,
      name: `Approval gated workflow ${requiredLevel}`,
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
      title: 'Approval gated run',
      description: '',
    });
    return ctx.taskRepo.createTask({
      spaceId: ctx.spaceId,
      title: 'Review task',
      description: '',
      status: 'review',
      workflowRunId: run.id,
    });
  }

  test('rejects approve_task when space autonomy is below workflow completionAutonomyLevel', async () => {
    await ctx.spaceManager.updateSpace(ctx.spaceId, { autonomyLevel: 3 });
    const task = createReviewTaskWithWorkflow(5);

    const result = await makeHandlers(ctx).approve_task({ task_id: task.id });
    const parsed = JSON.parse(result.content[0].text);

    expect(parsed.success).toBe(false);
    expect(parsed.error).toContain('approve_task not permitted');
    expect(parsed.error).toContain('space autonomy level 3 < workflow completionAutonomyLevel 5');
    expect(ctx.taskRepo.getTask(task.id)?.status).toBe('review');
  });

  test('allows approve_task when space autonomy meets workflow completionAutonomyLevel', async () => {
    await ctx.spaceManager.updateSpace(ctx.spaceId, { autonomyLevel: 5 });
    const task = createReviewTaskWithWorkflow(5);

    const result = await makeHandlers(ctx).approve_task({ task_id: task.id, reason: 'looks good' });
    const parsed = JSON.parse(result.content[0].text);

    expect(parsed.success).toBe(true);
    expect(parsed.task.status).toBe('done');
    expect(parsed.task.approvalSource).toBe('agent');
  });
});

describe('buildSpaceChatSystemPrompt — sections always present regardless of autonomy level', () => {
  const levels: Array<SpaceAutonomyLevel | undefined> = [1, 3, 4, 5, undefined];

  for (const level of levels) {
    const label = level ?? 'undefined (default)';

    test(`Event Handling section is always present [autonomyLevel=${label}]`, () => {
      const prompt = buildSpaceChatSystemPrompt({ autonomyLevel: level });
      expect(prompt).toContain('## Event Handling');
      expect(prompt).toContain('[TASK_EVENT]');
    });

    test(`Escalation section is always present [autonomyLevel=${label}]`, () => {
      const prompt = buildSpaceChatSystemPrompt({ autonomyLevel: level });
      expect(prompt).toContain('## Escalation');
    });

    test(`Coordination Invariants section is always present [autonomyLevel=${label}]`, () => {
      const prompt = buildSpaceChatSystemPrompt({ autonomyLevel: level });
      expect(prompt).toContain('## Coordination Invariants');
    });

    test(`Autonomy Level section is always present [autonomyLevel=${label}]`, () => {
      const prompt = buildSpaceChatSystemPrompt({ autonomyLevel: level });
      expect(prompt).toContain('## Autonomy Level');
    });
  }
});
