import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { Database as BunDatabase } from '../../../../src/storage/sqlite-compat';
import { runMigrations } from '../../../../src/storage/schema/index.ts';
import { SpaceWorkflowRepository } from '../../../../src/storage/repositories/space-workflow-repository.ts';
import { SpaceWorkflowRunRepository } from '../../../../src/storage/repositories/space-workflow-run-repository.ts';
import { WorkflowExecutor } from '../../../../src/lib/space/runtime/workflow-executor.ts';
import type {
  CommandRunner,
  ConditionContext,
} from '../../../../src/lib/space/runtime/workflow-executor.ts';
import type { SpaceWorkflow, SpaceWorkflowRun, WorkflowCondition } from '@hyperneo/shared';

function makeDb(): BunDatabase {
  const db = new BunDatabase(':memory:');
  db.exec('PRAGMA foreign_keys = ON');
  runMigrations(db, () => {});
  return db;
}

function seedSpace(db: BunDatabase, spaceId = 'space-1', workspacePath = '/tmp/ws-1'): void {
  db.prepare(
    `INSERT INTO spaces (id, workspace_path, name, description, background_context, instructions,
     allowed_models, session_ids, slug, status, created_at, updated_at)
     VALUES (?, ?, ?, '', '', '', '[]', '[]', ?, 'active', ?, ?)`
  ).run(spaceId, workspacePath, `Space ${spaceId}`, spaceId, Date.now(), Date.now());
}

function seedAgent(db: BunDatabase, agentId: string, spaceId: string, name: string): void {
  db.prepare(
    `INSERT INTO space_agents (id, space_id, name, description, model, tools, system_prompt, created_at, updated_at)
     VALUES (?, ?, ?, '', null, '[]', '', ?, ?)`
  ).run(agentId, spaceId, name, Date.now(), Date.now());
}

function makeOkRunner(): CommandRunner {
  return async () => ({ exitCode: 0 });
}

function makeFailRunner(exitCode = 1): CommandRunner {
  return async () => ({ exitCode });
}

function makeTimeoutRunner(): CommandRunner {
  return async () => ({ exitCode: null, timedOut: true });
}

describe('WorkflowExecutor', () => {
  let db: BunDatabase;
  let workflowRepo: SpaceWorkflowRepository;
  let runRepo: SpaceWorkflowRunRepository;

  const SPACE_ID = 'space-1';
  const WORKSPACE = '/tmp/ws-1';
  const AGENT_A = 'agent-a';
  const AGENT_B = 'agent-b';

  const STEP_A = 'step-a';
  const STEP_B = 'step-b';

  beforeEach(() => {
    db = makeDb();
    seedSpace(db, SPACE_ID, WORKSPACE);
    seedAgent(db, AGENT_A, SPACE_ID, 'Agent A');
    seedAgent(db, AGENT_B, SPACE_ID, 'Agent B');

    workflowRepo = new SpaceWorkflowRepository(db);
    runRepo = new SpaceWorkflowRunRepository(db);
  });

  afterEach(() => {
    try {
      db.close();
    } catch {}
  });

  function makeExecutor(
    workflow: SpaceWorkflow,
    run: SpaceWorkflowRun,
    runner?: CommandRunner
  ): WorkflowExecutor {
    return new WorkflowExecutor(workflow, run, runner);
  }

  function createLinearWorkflow(
    stepsSpec: Array<{
      id: string;
      name: string;
      agentId: string;
      instructions?: string;
      incomingCondition?: WorkflowCondition;
    }>
  ): { workflow: SpaceWorkflow; run: SpaceWorkflowRun } {
    const nodes = stepsSpec.map((s) => ({
      id: s.id,
      name: s.name,
      agentId: s.agentId,
      instructions: s.instructions,
    }));

    const transitions = stepsSpec.slice(1).map((s, i) => ({
      from: stepsSpec[i].id,
      to: s.id,
      condition: s.incomingCondition,
      order: 0,
    }));

    const workflow = workflowRepo.createWorkflow({
      spaceId: SPACE_ID,
      name: `WF-${Date.now()}`,
      nodes,
      transitions,
      startNodeId: stepsSpec[0].id,
      completionAutonomyLevel: 3,
    });

    const run = runRepo.createRun({
      spaceId: SPACE_ID,
      workflowId: workflow.id,
      title: 'Test Run',
    });

    return { workflow, run };
  }

  describe('isComplete', () => {
    test('isComplete returns false at start of workflow', () => {
      const { workflow, run } = createLinearWorkflow([
        { id: STEP_A, name: 'Step A', agentId: AGENT_A },
        { id: STEP_B, name: 'Step B', agentId: AGENT_B },
      ]);
      const executor = makeExecutor(workflow, run);
      expect(executor.isComplete()).toBe(false);
    });

    test('isComplete returns true when status is completed', () => {
      const { workflow, run } = createLinearWorkflow([
        { id: STEP_A, name: 'Step A', agentId: AGENT_A },
      ]);
      const completedRun = { ...run, status: 'done' as const };
      expect(makeExecutor(workflow, completedRun).isComplete()).toBe(true);
    });

    test('isComplete returns true when status is cancelled', () => {
      const { workflow, run } = createLinearWorkflow([
        { id: STEP_A, name: 'Step A', agentId: AGENT_A },
      ]);
      const cancelledRun = { ...run, status: 'cancelled' as const };
      expect(makeExecutor(workflow, cancelledRun).isComplete()).toBe(true);
    });
  });

  describe('evaluateCondition: always', () => {
    test('always always passes', async () => {
      const { workflow, run } = createLinearWorkflow([
        { id: STEP_A, name: 'Step A', agentId: AGENT_A },
      ]);
      const executor = makeExecutor(workflow, run);
      const ctx: ConditionContext = { workspacePath: WORKSPACE };
      const result = await executor.evaluateCondition({ type: 'always' }, ctx);
      expect(result.passed).toBe(true);
    });
  });

  describe('evaluateCondition: human', () => {
    test('passes when humanApproved is true', async () => {
      const { workflow, run } = createLinearWorkflow([
        { id: STEP_A, name: 'Step A', agentId: AGENT_A },
      ]);
      const executor = makeExecutor(workflow, run);
      const ctx: ConditionContext = { workspacePath: WORKSPACE, humanApproved: true };
      const result = await executor.evaluateCondition({ type: 'human' }, ctx);
      expect(result.passed).toBe(true);
    });

    test('fails when humanApproved is false', async () => {
      const { workflow, run } = createLinearWorkflow([
        { id: STEP_A, name: 'Step A', agentId: AGENT_A },
      ]);
      const executor = makeExecutor(workflow, run);
      const ctx: ConditionContext = { workspacePath: WORKSPACE, humanApproved: false };
      const result = await executor.evaluateCondition({ type: 'human' }, ctx);
      expect(result.passed).toBe(false);
      expect(result.reason).toContain('human approval');
    });

    test('fails when humanApproved is absent', async () => {
      const { workflow, run } = createLinearWorkflow([
        { id: STEP_A, name: 'Step A', agentId: AGENT_A },
      ]);
      const executor = makeExecutor(workflow, run);
      const ctx: ConditionContext = { workspacePath: WORKSPACE };
      const result = await executor.evaluateCondition({ type: 'human' }, ctx);
      expect(result.passed).toBe(false);
    });
  });

  describe('evaluateCondition: condition', () => {
    test('passes when expression exits 0', async () => {
      const { workflow, run } = createLinearWorkflow([
        { id: STEP_A, name: 'Step A', agentId: AGENT_A },
      ]);
      const executor = makeExecutor(workflow, run, makeOkRunner());
      const ctx: ConditionContext = { workspacePath: WORKSPACE };
      const result = await executor.evaluateCondition(
        { type: 'condition', expression: 'bun test' },
        ctx
      );
      expect(result.passed).toBe(true);
    });

    test('fails when expression exits non-zero', async () => {
      const { workflow, run } = createLinearWorkflow([
        { id: STEP_A, name: 'Step A', agentId: AGENT_A },
      ]);
      const executor = makeExecutor(workflow, run, makeFailRunner(1));
      const ctx: ConditionContext = { workspacePath: WORKSPACE };
      const result = await executor.evaluateCondition(
        { type: 'condition', expression: 'bun test' },
        ctx
      );
      expect(result.passed).toBe(false);
      expect(result.reason).toContain('code 1');
    });

    test('fails when expression is empty', async () => {
      const { workflow, run } = createLinearWorkflow([
        { id: STEP_A, name: 'Step A', agentId: AGENT_A },
      ]);
      const executor = makeExecutor(workflow, run);
      const ctx: ConditionContext = { workspacePath: WORKSPACE };
      const result = await executor.evaluateCondition({ type: 'condition', expression: '' }, ctx);
      expect(result.passed).toBe(false);
      expect(result.reason).toContain('non-empty expression');
    });

    test('fails when expression times out', async () => {
      const { workflow, run } = createLinearWorkflow([
        { id: STEP_A, name: 'Step A', agentId: AGENT_A },
      ]);
      const executor = makeExecutor(workflow, run, makeTimeoutRunner());
      const ctx: ConditionContext = { workspacePath: WORKSPACE };
      const result = await executor.evaluateCondition(
        { type: 'condition', expression: 'bun test', timeoutMs: 5000 },
        ctx
      );
      expect(result.passed).toBe(false);
      expect(result.reason).toContain('timed out');
    });
  });

  describe('evaluateCondition: task_result', () => {
    test('passes when taskResult starts with expression', async () => {
      const { workflow, run } = createLinearWorkflow([
        { id: STEP_A, name: 'Step A', agentId: AGENT_A },
      ]);
      const executor = makeExecutor(workflow, run);
      const ctx: ConditionContext = {
        workspacePath: WORKSPACE,
        taskResult: 'passed',
      };
      const result = await executor.evaluateCondition(
        { type: 'task_result', expression: 'passed' },
        ctx
      );
      expect(result.passed).toBe(true);
    });

    test('passes with prefix match (failed: tests broken)', async () => {
      const { workflow, run } = createLinearWorkflow([
        { id: STEP_A, name: 'Step A', agentId: AGENT_A },
      ]);
      const executor = makeExecutor(workflow, run);
      const ctx: ConditionContext = {
        workspacePath: WORKSPACE,
        taskResult: 'failed: tests broken',
      };
      const result = await executor.evaluateCondition(
        { type: 'task_result', expression: 'failed' },
        ctx
      );
      expect(result.passed).toBe(true);
    });

    test('fails when taskResult does not match expression', async () => {
      const { workflow, run } = createLinearWorkflow([
        { id: STEP_A, name: 'Step A', agentId: AGENT_A },
      ]);
      const executor = makeExecutor(workflow, run);
      const ctx: ConditionContext = {
        workspacePath: WORKSPACE,
        taskResult: 'failed: tests broken',
      };
      const result = await executor.evaluateCondition(
        { type: 'task_result', expression: 'passed' },
        ctx
      );
      expect(result.passed).toBe(false);
      expect(result.reason).toContain('does not match');
      expect(result.reason).toContain('failed: tests broken');
      expect(result.reason).toContain('passed');
    });

    test('fails when expression is empty', async () => {
      const { workflow, run } = createLinearWorkflow([
        { id: STEP_A, name: 'Step A', agentId: AGENT_A },
      ]);
      const executor = makeExecutor(workflow, run);
      const ctx: ConditionContext = {
        workspacePath: WORKSPACE,
        taskResult: 'passed',
      };
      const result = await executor.evaluateCondition({ type: 'task_result', expression: '' }, ctx);
      expect(result.passed).toBe(false);
      expect(result.reason).toContain('non-empty expression');
    });

    test('fails when expression is undefined', async () => {
      const { workflow, run } = createLinearWorkflow([
        { id: STEP_A, name: 'Step A', agentId: AGENT_A },
      ]);
      const executor = makeExecutor(workflow, run);
      const ctx: ConditionContext = {
        workspacePath: WORKSPACE,
        taskResult: 'passed',
      };
      const result = await executor.evaluateCondition({ type: 'task_result' }, ctx);
      expect(result.passed).toBe(false);
      expect(result.reason).toContain('non-empty expression');
    });

    test('fails when taskResult is undefined', async () => {
      const { workflow, run } = createLinearWorkflow([
        { id: STEP_A, name: 'Step A', agentId: AGENT_A },
      ]);
      const executor = makeExecutor(workflow, run);
      const ctx: ConditionContext = { workspacePath: WORKSPACE };
      const result = await executor.evaluateCondition(
        { type: 'task_result', expression: 'passed' },
        ctx
      );
      expect(result.passed).toBe(false);
      expect(result.reason).toContain('No task result available');
    });
  });
});
