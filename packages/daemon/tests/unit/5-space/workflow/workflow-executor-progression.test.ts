/**
 * Workflow Executor Node Progression Tests
 *
 * Covers uncovered behaviors identified in task 3.2:
 *
 * A) WorkflowExecutor edge cases not covered by workflow-executor.test.ts:
 *    - isComplete() with blocked / in_progress / pending statuses
 *    - condition type: whitespace-only expression
 *    - condition type: runner throws exception
 *    - condition type: stderr snippet in error reason
 *
 * B) Linear node progression (A→B→C):
 *    - All transitions pass (always condition)
 *    - Stops at human gate when approval missing
 *    - Resumes after human approves
 *    - task_result condition drives progression
 *    - condition shell expression gates progression
 *
 * C) Parallel branch execution (CompletionDetector):
 *    - Two parallel agents: both done → complete
 *    - Two parallel agents: one still running → not complete
 *    - Three parallel agents: all must finish before complete
 *    - Parallel + sequential: parallel branch done, next sequential step not started → false
 *
 * D) Gated channel evaluation (isChannelOpen + evaluateGate):
 *    - Gateless channel: always open
 *    - Gated channel: gate passes → open
 *    - Gated channel: gate fails → closed
 *    - Gated channel: gate not found → closed (misconfiguration)
 *    - Gate with script pre-check that passes → fields evaluated
 *    - Gate with script pre-check that fails → gate closed immediately
 *    - evaluateGate with no fields and no script → open
 *    - Combined WorkflowExecutor condition + channel gate check
 */

import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { Database as BunDatabase } from 'bun:sqlite';
import { runMigrations } from '../../../../src/storage/schema/index.ts';
import { SpaceWorkflowRepository } from '../../../../src/storage/repositories/space-workflow-repository.ts';
import { SpaceWorkflowRunRepository } from '../../../../src/storage/repositories/space-workflow-run-repository.ts';
import { WorkflowExecutor } from '../../../../src/lib/space/runtime/workflow-executor.ts';
import type {
  CommandRunner,
  ConditionContext,
} from '../../../../src/lib/space/runtime/workflow-executor.ts';
import {
  isChannelOpen,
  evaluateGate,
  evaluateFields,
} from '../../../../src/lib/space/runtime/gate-evaluator.ts';
import type { GateScriptExecutorFn } from '../../../../src/lib/space/runtime/gate-evaluator.ts';
import type { SpaceWorkflow, SpaceWorkflowRun, Gate, GateField, Channel } from '@hyperneo/shared';

// ---------------------------------------------------------------------------
// DB helpers
// ---------------------------------------------------------------------------

function makeDb(): BunDatabase {
  // Use in-memory SQLite — faster than file-based DB and avoids filesystem
  // I/O contention that caused beforeEach hook timeouts in CI.
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

// ---------------------------------------------------------------------------
// Mock command runners
// ---------------------------------------------------------------------------

function makeOkRunner(): CommandRunner {
  return async () => ({ exitCode: 0 });
}

function makeFailRunner(exitCode = 1, stderr = ''): CommandRunner {
  return async () => ({ exitCode, stderr });
}

function makeThrowingRunner(message: string): CommandRunner {
  return async () => {
    throw new Error(message);
  };
}

// ---------------------------------------------------------------------------
// Workflow builder helpers
// ---------------------------------------------------------------------------

let db: BunDatabase;
let workflowRepo: SpaceWorkflowRepository;
let runRepo: SpaceWorkflowRunRepository;

const SPACE_ID = 'space-1';
const WORKSPACE = '/tmp/ws-1';

beforeEach(() => {
  db = makeDb();
  seedSpace(db, SPACE_ID, WORKSPACE);
  seedAgent(db, 'agent-a', SPACE_ID, 'Agent A');
  seedAgent(db, 'agent-b', SPACE_ID, 'Agent B');
  seedAgent(db, 'agent-c', SPACE_ID, 'Agent C');
  workflowRepo = new SpaceWorkflowRepository(db);
  runRepo = new SpaceWorkflowRunRepository(db);
});

afterEach(() => {
  try {
    db.close();
  } catch {
    /* ignore */
  }
});

function makeLinearWorkflow(steps: Array<{ id: string; agentId: string }>): {
  workflow: SpaceWorkflow;
  run: SpaceWorkflowRun;
} {
  const workflow = workflowRepo.createWorkflow({
    spaceId: SPACE_ID,
    name: `linear-${Date.now()}`,
    nodes: steps.map((s) => ({ id: s.id, name: s.id, agentId: s.agentId })),
    transitions: steps.slice(1).map((s, i) => ({
      from: steps[i].id,
      to: s.id,
      order: 0,
    })),
    startNodeId: steps[0].id,
    completionAutonomyLevel: 3,
  });
  const run = runRepo.createRun({ spaceId: SPACE_ID, workflowId: workflow.id, title: 'Test' });
  return { workflow, run };
}

// ===========================================================================
// A) WorkflowExecutor edge cases
// ===========================================================================

describe('WorkflowExecutor — isComplete() edge cases', () => {
  test('blocked status → isComplete returns false', () => {
    const { workflow, run } = makeLinearWorkflow([{ id: 'node-a', agentId: 'agent-a' }]);
    const blockedRun: SpaceWorkflowRun = { ...run, status: 'blocked' };
    const executor = new WorkflowExecutor(workflow, blockedRun);
    expect(executor.isComplete()).toBe(false);
  });

  test('in_progress status → isComplete returns false', () => {
    const { workflow, run } = makeLinearWorkflow([{ id: 'node-a', agentId: 'agent-a' }]);
    const inProgressRun: SpaceWorkflowRun = { ...run, status: 'in_progress' };
    const executor = new WorkflowExecutor(workflow, inProgressRun);
    expect(executor.isComplete()).toBe(false);
  });

  test('pending status → isComplete returns false', () => {
    const { workflow, run } = makeLinearWorkflow([{ id: 'node-a', agentId: 'agent-a' }]);
    const pendingRun: SpaceWorkflowRun = { ...run, status: 'pending' };
    const executor = new WorkflowExecutor(workflow, pendingRun);
    expect(executor.isComplete()).toBe(false);
  });

  test('done status → isComplete returns true', () => {
    const { workflow, run } = makeLinearWorkflow([{ id: 'node-a', agentId: 'agent-a' }]);
    const doneRun: SpaceWorkflowRun = { ...run, status: 'done' };
    const executor = new WorkflowExecutor(workflow, doneRun);
    expect(executor.isComplete()).toBe(true);
  });

  test('cancelled status → isComplete returns true', () => {
    const { workflow, run } = makeLinearWorkflow([{ id: 'node-a', agentId: 'agent-a' }]);
    const cancelledRun: SpaceWorkflowRun = { ...run, status: 'cancelled' };
    const executor = new WorkflowExecutor(workflow, cancelledRun);
    expect(executor.isComplete()).toBe(true);
  });
});

describe('WorkflowExecutor — evaluateCondition edge cases', () => {
  test('condition type: whitespace-only expression fails with "non-empty expression"', async () => {
    const { workflow, run } = makeLinearWorkflow([{ id: 'node-a', agentId: 'agent-a' }]);
    const executor = new WorkflowExecutor(workflow, run);
    const ctx: ConditionContext = { workspacePath: WORKSPACE };
    const result = await executor.evaluateCondition({ type: 'condition', expression: '   ' }, ctx);
    expect(result.passed).toBe(false);
    expect(result.reason).toContain('non-empty expression');
  });

  test('condition type: runner throws exception → fails with error message', async () => {
    const { workflow, run } = makeLinearWorkflow([{ id: 'node-a', agentId: 'agent-a' }]);
    const executor = new WorkflowExecutor(workflow, run, makeThrowingRunner('spawn failed'));
    const ctx: ConditionContext = { workspacePath: WORKSPACE };
    const result = await executor.evaluateCondition(
      { type: 'condition', expression: 'echo test' },
      ctx
    );
    expect(result.passed).toBe(false);
    expect(result.reason).toContain('spawn failed');
  });

  test('condition type: stderr snippet included in error reason', async () => {
    const { workflow, run } = makeLinearWorkflow([{ id: 'node-a', agentId: 'agent-a' }]);
    const runner = makeFailRunner(1, 'permission denied: /tmp/secret');
    const executor = new WorkflowExecutor(workflow, run, runner);
    const ctx: ConditionContext = { workspacePath: WORKSPACE };
    const result = await executor.evaluateCondition(
      { type: 'condition', expression: 'cat /tmp/secret' },
      ctx
    );
    expect(result.passed).toBe(false);
    expect(result.reason).toContain('permission denied');
  });

  test('task_result type: whitespace-only expression fails', async () => {
    const { workflow, run } = makeLinearWorkflow([{ id: 'node-a', agentId: 'agent-a' }]);
    const executor = new WorkflowExecutor(workflow, run);
    const ctx: ConditionContext = { workspacePath: WORKSPACE, taskResult: 'passed' };
    const result = await executor.evaluateCondition(
      { type: 'task_result', expression: '   ' },
      ctx
    );
    expect(result.passed).toBe(false);
    expect(result.reason).toContain('non-empty expression');
  });
});

// ===========================================================================
// B) Linear node progression (A→B→C)
// ===========================================================================

describe('Linear node progression — condition evaluation sequence', () => {
  test('3-step linear workflow: all always conditions pass in sequence', async () => {
    const { workflow, run } = makeLinearWorkflow([
      { id: 'node-a', agentId: 'agent-a' },
      { id: 'node-b', agentId: 'agent-b' },
      { id: 'node-c', agentId: 'agent-c' },
    ]);
    const executor = new WorkflowExecutor(workflow, run);
    const ctx: ConditionContext = { workspacePath: WORKSPACE };

    // Simulate A→B transition
    const r1 = await executor.evaluateCondition({ type: 'always' }, ctx);
    expect(r1.passed).toBe(true);

    // Simulate B→C transition
    const r2 = await executor.evaluateCondition({ type: 'always' }, ctx);
    expect(r2.passed).toBe(true);
  });

  test('3-step: human condition blocks B→C when approval absent', async () => {
    const { workflow, run } = makeLinearWorkflow([
      { id: 'node-a', agentId: 'agent-a' },
      { id: 'node-b', agentId: 'agent-b' },
      { id: 'node-c', agentId: 'agent-c' },
    ]);
    const executor = new WorkflowExecutor(workflow, run);

    // A→B passes
    const r1 = await executor.evaluateCondition({ type: 'always' }, { workspacePath: WORKSPACE });
    expect(r1.passed).toBe(true);

    // B→C blocked: no human approval
    const r2 = await executor.evaluateCondition({ type: 'human' }, { workspacePath: WORKSPACE });
    expect(r2.passed).toBe(false);
    expect(r2.reason).toContain('human approval');
  });

  test('3-step: human condition unblocks B→C after approval', async () => {
    const { workflow, run } = makeLinearWorkflow([
      { id: 'node-a', agentId: 'agent-a' },
      { id: 'node-b', agentId: 'agent-b' },
      { id: 'node-c', agentId: 'agent-c' },
    ]);
    const executor = new WorkflowExecutor(workflow, run);

    // First attempt: not approved
    const blocked = await executor.evaluateCondition(
      { type: 'human' },
      { workspacePath: WORKSPACE, humanApproved: false }
    );
    expect(blocked.passed).toBe(false);

    // After approval: passes
    const approved = await executor.evaluateCondition(
      { type: 'human' },
      { workspacePath: WORKSPACE, humanApproved: true }
    );
    expect(approved.passed).toBe(true);
  });

  test('3-step: task_result condition gates B→C based on node A result', async () => {
    const { workflow, run } = makeLinearWorkflow([
      { id: 'node-a', agentId: 'agent-a' },
      { id: 'node-b', agentId: 'agent-b' },
      { id: 'node-c', agentId: 'agent-c' },
    ]);
    const executor = new WorkflowExecutor(workflow, run);

    // A→B always passes
    const r1 = await executor.evaluateCondition({ type: 'always' }, { workspacePath: WORKSPACE });
    expect(r1.passed).toBe(true);

    // B→C: task result matches
    const r2Pass = await executor.evaluateCondition(
      { type: 'task_result', expression: 'passed' },
      { workspacePath: WORKSPACE, taskResult: 'passed: all tests green' }
    );
    expect(r2Pass.passed).toBe(true);

    // B→C: task result mismatch blocks progression
    const r2Fail = await executor.evaluateCondition(
      { type: 'task_result', expression: 'passed' },
      { workspacePath: WORKSPACE, taskResult: 'failed: 3 tests broken' }
    );
    expect(r2Fail.passed).toBe(false);
    expect(r2Fail.reason).toContain('does not match');
  });

  test('3-step: condition shell expression gates B→C (pass)', async () => {
    const { workflow, run } = makeLinearWorkflow([
      { id: 'node-a', agentId: 'agent-a' },
      { id: 'node-b', agentId: 'agent-b' },
      { id: 'node-c', agentId: 'agent-c' },
    ]);
    const executor = new WorkflowExecutor(workflow, run, makeOkRunner());

    // A→B: always
    const r1 = await executor.evaluateCondition({ type: 'always' }, { workspacePath: WORKSPACE });
    expect(r1.passed).toBe(true);

    // B→C: shell condition passes (exit 0)
    const r2 = await executor.evaluateCondition(
      { type: 'condition', expression: 'bun test' },
      { workspacePath: WORKSPACE }
    );
    expect(r2.passed).toBe(true);
  });

  test('3-step: condition shell expression blocks B→C (fail)', async () => {
    const { workflow, run } = makeLinearWorkflow([
      { id: 'node-a', agentId: 'agent-a' },
      { id: 'node-b', agentId: 'agent-b' },
      { id: 'node-c', agentId: 'agent-c' },
    ]);
    const executor = new WorkflowExecutor(workflow, run, makeFailRunner(1));

    // A→B: always
    const r1 = await executor.evaluateCondition({ type: 'always' }, { workspacePath: WORKSPACE });
    expect(r1.passed).toBe(true);

    // B→C: shell condition fails → progression blocked
    const r2 = await executor.evaluateCondition(
      { type: 'condition', expression: 'bun test' },
      { workspacePath: WORKSPACE }
    );
    expect(r2.passed).toBe(false);
    expect(r2.reason).toContain('code 1');
  });

  test('run stays incomplete during linear progression', () => {
    const { workflow, run } = makeLinearWorkflow([
      { id: 'node-a', agentId: 'agent-a' },
      { id: 'node-b', agentId: 'agent-b' },
    ]);
    const executor = new WorkflowExecutor(workflow, run);
    // Run is pending at start
    expect(executor.isComplete()).toBe(false);
    // Even after condition evaluation, run stays incomplete (no state mutation)
    expect(executor.isComplete()).toBe(false);
  });
});

// ===========================================================================
// C) Parallel branch execution — see completion-detector.test.ts
// ===========================================================================
// CompletionDetector now reads the canonical SpaceTask (status / reportedStatus)
// rather than node_executions. Comprehensive coverage lives in
// `tests/unit/5-space/workflow/completion-detector.test.ts`. The old
// node-execution-based block has been removed because its assumptions no
// longer match the runtime contract.

// ===========================================================================
// D) Gated channel evaluation
// ===========================================================================

describe('Gated channel evaluation — isChannelOpen()', () => {
  test('channel without gateId is always open', () => {
    const channel: Channel = {
      id: 'ch-1',
      from: 'agent-a',
      to: ['agent-b'],
      direction: 'one_way',
    };
    const result = isChannelOpen(channel, {});
    expect(result.open).toBe(true);
  });

  test('channel with gateId: gate not found → closed (misconfiguration)', () => {
    const channel: Channel = {
      id: 'ch-1',
      from: 'agent-a',
      to: ['agent-b'],
      direction: 'one_way',
      gateId: 'gate-missing',
    };
    const result = isChannelOpen(channel, {});
    expect(result.open).toBe(false);
    expect(result.reason).toContain('gate-missing');
    expect(result.reason).toContain('not found');
  });

  test('channel with gateId: gate field passes → channel open', () => {
    const gate: Gate = {
      id: 'gate-approval',
      fields: [
        {
          name: 'approved',
          type: 'boolean',
          writers: ['*'],
          check: { op: '==', value: true },
        } as GateField,
      ],
    };
    const channel: Channel = {
      id: 'ch-1',
      from: 'agent-a',
      to: ['agent-b'],
      direction: 'one_way',
      gateId: 'gate-approval',
    };
    const gates = { 'gate-approval': gate };
    const gateData = { 'gate-approval': { approved: true } };
    const result = isChannelOpen(channel, gates, gateData);
    expect(result.open).toBe(true);
  });

  test('channel with gateId: gate field fails → channel closed', () => {
    const gate: Gate = {
      id: 'gate-approval',
      fields: [
        {
          name: 'approved',
          type: 'boolean',
          writers: ['*'],
          check: { op: '==', value: true },
        } as GateField,
      ],
    };
    const channel: Channel = {
      id: 'ch-1',
      from: 'agent-a',
      to: ['agent-b'],
      direction: 'one_way',
      gateId: 'gate-approval',
    };
    const gates = { 'gate-approval': gate };
    // approved = false → gate field check fails
    const gateData = { 'gate-approval': { approved: false } };
    const result = isChannelOpen(channel, gates, gateData);
    expect(result.open).toBe(false);
    expect(result.reason).toContain('approved');
  });

  test('channel with gateId: no gate data → gate field fails (field missing)', () => {
    const gate: Gate = {
      id: 'gate-review',
      fields: [
        {
          name: 'review_done',
          type: 'boolean',
          writers: ['*'],
          check: { op: 'exists' },
        } as GateField,
      ],
    };
    const channel: Channel = {
      id: 'ch-1',
      from: 'agent-a',
      to: ['agent-b'],
      direction: 'one_way',
      gateId: 'gate-review',
    };
    // No gateData provided — field will be missing
    const result = isChannelOpen(channel, { 'gate-review': gate });
    expect(result.open).toBe(false);
    expect(result.reason).toContain('review_done');
  });

  test('channel with multiple field gate: all fields must pass', () => {
    const gate: Gate = {
      id: 'gate-multi',
      fields: [
        {
          name: 'tests_passed',
          type: 'boolean',
          writers: ['*'],
          check: { op: '==', value: true },
        } as GateField,
        {
          name: 'review_done',
          type: 'boolean',
          writers: ['*'],
          check: { op: '==', value: true },
        } as GateField,
      ],
    };
    const channel: Channel = {
      id: 'ch-1',
      from: 'agent-a',
      to: ['agent-b'],
      direction: 'one_way',
      gateId: 'gate-multi',
    };
    const gates = { 'gate-multi': gate };

    // Only first field passes
    const partial = isChannelOpen(channel, gates, {
      'gate-multi': { tests_passed: true, review_done: false },
    });
    expect(partial.open).toBe(false);

    // Both fields pass
    const both = isChannelOpen(channel, gates, {
      'gate-multi': { tests_passed: true, review_done: true },
    });
    expect(both.open).toBe(true);
  });
});

describe('Gated workflow progression — evaluateGate()', () => {
  test('gate with no fields and no script → always open', async () => {
    const gate: Gate = { id: 'gate-empty', fields: [] };
    const result = await evaluateGate(gate, {});
    expect(result.open).toBe(true);
  });

  test('gate with passing field → open', async () => {
    const gate: Gate = {
      id: 'gate-1',
      fields: [
        {
          name: 'status',
          type: 'string',
          writers: ['*'],
          check: { op: '==', value: 'approved' },
        } as GateField,
      ],
    };
    const result = await evaluateGate(gate, { status: 'approved' });
    expect(result.open).toBe(true);
  });

  test('gate with failing field → closed with reason', async () => {
    const gate: Gate = {
      id: 'gate-1',
      fields: [
        {
          name: 'status',
          type: 'string',
          writers: ['*'],
          check: { op: '==', value: 'approved' },
        } as GateField,
      ],
    };
    const result = await evaluateGate(gate, { status: 'pending' });
    expect(result.open).toBe(false);
    expect(result.reason).toContain('status');
  });

  test('gate with script pre-check that passes → fields evaluated afterward', async () => {
    const gate: Gate = {
      id: 'gate-script',
      script: { interpreter: 'bash', source: 'echo ok' },
      fields: [
        {
          name: 'verified',
          type: 'boolean',
          writers: ['*'],
          check: { op: '==', value: true },
        } as GateField,
      ],
    };
    // Mock script executor: succeeds and injects verified=true into gate data
    const mockScript: GateScriptExecutorFn = async () => ({
      success: true,
      data: { verified: true },
    });
    const result = await evaluateGate(gate, {}, mockScript, {
      workspaceDir: WORKSPACE,
      gateId: 'gate-script',
      workflowRunId: 'run-1',
    });
    expect(result.open).toBe(true);
  });

  test('gate with script pre-check that fails → gate closed immediately', async () => {
    const gate: Gate = {
      id: 'gate-script',
      script: { interpreter: 'bash', source: 'exit 1' },
      fields: [
        {
          name: 'verified',
          type: 'boolean',
          writers: ['*'],
          check: { op: '==', value: true },
        } as GateField,
      ],
    };
    // Mock script executor: fails
    const mockScript: GateScriptExecutorFn = async () => ({
      success: false,
      error: 'script exited with code 1',
    });
    const result = await evaluateGate(gate, {}, mockScript, {
      workspaceDir: WORKSPACE,
      gateId: 'gate-script',
      workflowRunId: 'run-1',
    });
    expect(result.open).toBe(false);
    expect(result.reason).toContain('Script check failed');
    expect(result.reason).toContain('script exited with code 1');
  });

  test('gate with script but no executor provided → falls through to field evaluation', async () => {
    const gate: Gate = {
      id: 'gate-script',
      script: { interpreter: 'bash', source: 'echo ok' },
      fields: [
        {
          name: 'status',
          type: 'string',
          writers: ['*'],
          check: { op: '==', value: 'done' },
        } as GateField,
      ],
    };
    // No scriptExecutor provided — script is skipped, fields evaluated directly
    const result = await evaluateGate(gate, { status: 'done' });
    expect(result.open).toBe(true);
  });
});

// ===========================================================================
// E) Combined: WorkflowExecutor condition + channel gate as dual-check
// ===========================================================================

describe('Combined: WorkflowExecutor condition + channel gate (full node transition guard)', () => {
  test('both condition and gate must pass for progression to proceed', async () => {
    const { workflow, run } = makeLinearWorkflow([
      { id: 'node-a', agentId: 'agent-a' },
      { id: 'node-b', agentId: 'agent-b' },
    ]);
    const executor = new WorkflowExecutor(workflow, run);

    const gate: Gate = {
      id: 'gate-qa',
      fields: [
        {
          name: 'qa_passed',
          type: 'boolean',
          writers: ['*'],
          check: { op: '==', value: true },
        } as GateField,
      ],
    };
    const channel: Channel = {
      id: 'ch-a-to-b',
      from: 'agent-a',
      to: ['agent-b'],
      direction: 'one_way',
      gateId: 'gate-qa',
    };
    const gates = { 'gate-qa': gate };

    // Condition passes but gate fails → transition blocked
    const condResult = await executor.evaluateCondition(
      { type: 'always' },
      { workspacePath: WORKSPACE }
    );
    expect(condResult.passed).toBe(true);

    const gateResult = isChannelOpen(channel, gates, { 'gate-qa': { qa_passed: false } });
    expect(gateResult.open).toBe(false);

    // After gate data is updated, gate passes → transition allowed
    const gateResultPass = isChannelOpen(channel, gates, { 'gate-qa': { qa_passed: true } });
    expect(gateResultPass.open).toBe(true);
  });

  test('condition fails → progression blocked regardless of gate state', async () => {
    const { workflow, run } = makeLinearWorkflow([
      { id: 'node-a', agentId: 'agent-a' },
      { id: 'node-b', agentId: 'agent-b' },
    ]);
    const executor = new WorkflowExecutor(workflow, run);

    const gate: Gate = {
      id: 'gate-qa',
      fields: [
        {
          name: 'qa_passed',
          type: 'boolean',
          writers: ['*'],
          check: { op: '==', value: true },
        } as GateField,
      ],
    };
    const channel: Channel = {
      id: 'ch-a-to-b',
      from: 'agent-a',
      to: ['agent-b'],
      direction: 'one_way',
      gateId: 'gate-qa',
    };
    const gates = { 'gate-qa': gate };

    // Condition fails (human not approved)
    const condResult = await executor.evaluateCondition(
      { type: 'human' },
      { workspacePath: WORKSPACE, humanApproved: false }
    );
    expect(condResult.passed).toBe(false);

    // Even if gate is open, condition failure blocks progression
    const gateResult = isChannelOpen(channel, gates, { 'gate-qa': { qa_passed: true } });
    expect(gateResult.open).toBe(true); // gate is open but condition failed

    // Both must pass — since condResult.passed is false, transition is blocked
    const canProgress = condResult.passed && gateResult.open;
    expect(canProgress).toBe(false);
  });
});
