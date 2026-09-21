import { describe, expect, test } from 'bun:test';
import type {
  NodeExecution,
  Session,
  SpaceWorkflow,
  SpaceWorkflowRun,
  WorkflowRunStatus,
} from '@hyperneo/shared';
import { invokeOperation } from '../../../../src/lib/operations/invoke.ts';
import {
  createOperationRegistry,
  type OperationCaller,
  type OperationCallerRole,
} from '../../../../src/lib/operations/registry.ts';
import { FAIL_CLOSED_LONG_HORIZON_AGENT_REPO } from '../../../../src/lib/space/runtime/space-mcp-session-policy.ts';
import {
  createWorkflowRunOperations,
  type WorkflowRunDependencies,
} from '../../../../src/lib/workflows/workflow-run-operations.ts';
import { createTestSession } from '../../../helpers/database.ts';

const SPACE_ID = 'space-workflow-runs';
const SESSION_ID = 'session-1';

function run(overrides: Partial<SpaceWorkflowRun> = {}): SpaceWorkflowRun {
  return {
    id: 'run-1',
    spaceId: SPACE_ID,
    workflowId: 'wf-1',
    definitionVersion: null,
    title: 'Ship it',
    description: 'original',
    status: 'in_progress' as WorkflowRunStatus,
    blockedRetryCount: 0,
    createdAt: 1,
    startedAt: 2,
    updatedAt: 3,
    completedAt: null,
    ...overrides,
  };
}

function execution(overrides: Partial<NodeExecution> = {}): NodeExecution {
  return {
    id: 'exec-1',
    workflowRunId: 'run-1',
    workflowNodeId: 'node-1',
    agentName: 'coder',
    agentId: null,
    agentSessionId: null,
    status: 'in_progress',
    result: null,
    data: null,
    createdAt: 1,
    startedAt: 2,
    completedAt: null,
    updatedAt: 3,
    lastActivityAt: null,
    ...overrides,
  };
}

function workflow(overrides: Partial<SpaceWorkflow> = {}): SpaceWorkflow {
  return {
    id: 'wf-2',
    spaceId: SPACE_ID,
    name: 'Other plan',
    nodes: [{ id: 'node-1', name: 'implement', agents: [{ agentId: 'a-1', name: 'coder' }] }],
    startNodeId: 'node-1',
    tags: [],
    createdAt: 1,
    updatedAt: 2,
    completionAutonomyLevel: 3,
    ...overrides,
  };
}

function activeSession(status: Session['status'] = 'active', spaceId = SPACE_ID): Session {
  return { ...createTestSession(SESSION_ID), status, context: { spaceId } };
}

function deps(overrides: Partial<WorkflowRunDependencies> = {}): WorkflowRunDependencies {
  return {
    getSession: () => activeSession(),
    longHorizonAgentRepo: FAIL_CLOSED_LONG_HORIZON_AGENT_REPO,
    getRun: () => run(),
    updateRunDescription: (_runId, description) => run({ description }),
    listRunExecutions: () => [execution()],
    getWorkflow: () => workflow(),
    getWorkflowByHandle: () => null,
    cancelWorkflowRun: async () => run({ status: 'cancelled' }),
    startWorkflowRun: async () => ({ run: run({ id: 'run-2', workflowId: 'wf-2' }), tasks: [] }),
    ...overrides,
  };
}

function mcpCaller(role: OperationCallerRole, spaceId: string | null = SPACE_ID) {
  return {
    source: 'mcp',
    sessionId: SESSION_ID,
    spaceId: spaceId ?? undefined,
    role,
  } satisfies OperationCaller;
}

function outcomeOf(
  dependencies: WorkflowRunDependencies,
  name: string,
  input: unknown,
  caller: OperationCaller
) {
  const registry = createOperationRegistry(createWorkflowRunOperations(dependencies));
  return invokeOperation(registry, name, input, caller);
}

async function invoke(
  dependencies: WorkflowRunDependencies,
  name: string,
  input: unknown,
  caller: OperationCaller
) {
  const outcome = await outcomeOf(dependencies, name, input, caller);
  if (outcome.kind !== 'completed') throw new Error(`${outcome.code}: ${outcome.message}`);
  return outcome.value;
}

describe('workflow run read operation', () => {
  test('workflow.run.get returns the run with its node executions', async () => {
    const value = await invoke(
      deps(),
      'workflow.run.get',
      { runId: 'run-1' },
      mcpCaller('workflow_worker')
    );
    expect(value).toEqual({ run: run(), executions: [execution()] });
  });

  test('workflow.run.get hides a run owned by another Space', async () => {
    const value = await invoke(
      deps({ getRun: () => run({ spaceId: 'other-space' }) }),
      'workflow.run.get',
      { runId: 'run-1' },
      mcpCaller('ad_hoc_member')
    );
    expect(value).toBe('run_not_found');
  });

  test('workflow.run.get admits a direct_task_worker scoped to the Space', async () => {
    const outcome = await outcomeOf(
      deps(),
      'workflow.run.get',
      { runId: 'run-1' },
      mcpCaller('direct_task_worker')
    );
    expect(outcome).toMatchObject({
      kind: 'completed',
      value: { run: run(), executions: [execution()] },
    });
  });

  test('workflow.run.get refuses a direct_task_worker that carries no Space', async () => {
    const outcome = await outcomeOf(
      deps(),
      'workflow.run.get',
      { runId: 'run-1' },
      mcpCaller('direct_task_worker', null)
    );
    expect(outcome).toMatchObject({ kind: 'completed', value: 'space_not_resolved' });
  });
});

describe('workflow plan change operation', () => {
  test('workflow.changePlan rewords an active run in place', async () => {
    const written: string[] = [];
    let cancelled = 0;
    const value = await invoke(
      deps({
        updateRunDescription: (_runId, description) => {
          written.push(description);
          return run({ description });
        },
        cancelWorkflowRun: async () => {
          cancelled += 1;
          return run({ status: 'cancelled' });
        },
      }),
      'workflow.changePlan',
      { runId: 'run-1', description: 'reworded' },
      mcpCaller('ad_hoc_member')
    );
    expect(written).toEqual(['reworded']);
    expect(cancelled).toBe(0);
    expect(value).toEqual({ outcome: 'described', run: run({ description: 'reworded' }) });
  });

  test('workflow.changePlan cancels the old run and starts the target workflow', async () => {
    const calls: string[] = [];
    const value = await invoke(
      deps({
        cancelWorkflowRun: async (_spaceId, runId) => {
          calls.push(`cancel:${runId}`);
          return run({ status: 'cancelled' });
        },
        startWorkflowRun: async (_spaceId, workflowId, title, description) => {
          calls.push(`start:${workflowId}:${title}:${description}`);
          return { run: run({ id: 'run-2', workflowId }), tasks: [] };
        },
      }),
      'workflow.changePlan',
      { runId: 'run-1', workflowId: 'wf-2' },
      mcpCaller('long_term_agent')
    );
    expect(calls).toEqual(['cancel:run-1', 'start:wf-2:Ship it:original']);
    expect(value).toEqual({
      outcome: 'switched',
      previousRunId: 'run-1',
      run: run({ id: 'run-2', workflowId: 'wf-2' }),
      tasks: [],
    });
  });

  test('workflow.changePlan reports switch_failed when the replacement cannot start', async () => {
    const value = await invoke(
      deps({
        startWorkflowRun: async () => {
          throw new Error('missing endNodeId');
        },
      }),
      'workflow.changePlan',
      { runId: 'run-1', workflowId: 'wf-2' },
      mcpCaller('ad_hoc_member')
    );
    expect(value).toEqual({
      outcome: 'switch_failed',
      previousRunId: 'run-1',
      error: 'missing endNodeId',
    });
  });

  test('workflow.changePlan refuses a run that already finished', async () => {
    const value = await invoke(
      deps({ getRun: () => run({ status: 'done' }) }),
      'workflow.changePlan',
      { runId: 'run-1', description: 'reworded' },
      mcpCaller('ad_hoc_member')
    );
    expect(value).toBe('run_finished');
  });

  test('workflow.changePlan refuses a target workflow owned by another Space', async () => {
    const value = await invoke(
      deps({ getWorkflow: () => workflow({ spaceId: 'other-space' }) }),
      'workflow.changePlan',
      { runId: 'run-1', workflowId: 'wf-2' },
      mcpCaller('ad_hoc_member')
    );
    expect(value).toBe('workflow_not_found');
  });

  test('workflow.changePlan refuses a disabled target workflow', async () => {
    const value = await invoke(
      deps({
        getWorkflow: () => workflow({ disabled: true }),
        getWorkflowByHandle: () => workflow({ disabled: true }),
      }),
      'workflow.changePlan',
      { runId: 'run-1', workflowId: 'wf-2' },
      mcpCaller('ad_hoc_member')
    );
    expect(value).toBe('workflow_disabled');
  });

  test('workflow.changePlan refuses an archived session in the owning Space and changes nothing', async () => {
    const calls: string[] = [];
    const value = await invoke(
      deps({
        getSession: () => activeSession('archived'),
        updateRunDescription: (_runId, description) => {
          calls.push(`update:${description}`);
          return run({ description });
        },
        cancelWorkflowRun: async () => {
          calls.push('cancel');
          return run({ status: 'cancelled' });
        },
      }),
      'workflow.changePlan',
      { runId: 'run-1', description: 'reworded' },
      mcpCaller('ad_hoc_member')
    );
    expect(value).toBe('caller_not_admitted');
    expect(calls).toEqual([]);
  });

  test('workflow.changePlan refuses an active session belonging to another Space', async () => {
    const value = await invoke(
      deps({ getSession: () => activeSession('active', 'other-space') }),
      'workflow.changePlan',
      { runId: 'run-1', description: 'reworded' },
      mcpCaller('ad_hoc_member')
    );
    expect(value).toBe('caller_not_admitted');
  });

  test('workflow.changePlan admits a workflow_worker whose session is active in the Space', async () => {
    const written: string[] = [];
    const outcome = await outcomeOf(
      deps({
        updateRunDescription: (_runId, description) => {
          written.push(description);
          return run({ description });
        },
      }),
      'workflow.changePlan',
      { runId: 'run-1', description: 'reworded' },
      mcpCaller('workflow_worker')
    );
    expect(outcome).toMatchObject({
      kind: 'completed',
      value: { outcome: 'described', run: run({ description: 'reworded' }) },
    });
    expect(written).toEqual(['reworded']);
  });

  test('workflow.changePlan rejects a call that names no change', async () => {
    const outcome = await outcomeOf(
      deps(),
      'workflow.changePlan',
      { runId: 'run-1' },
      mcpCaller('ad_hoc_member')
    );
    expect(outcome).toMatchObject({ kind: 'failed', code: 'invalid_input' });
  });
});

describe('workflow run optional Space scope', () => {
  test('RPC and internal reads and plan changes inherit the caller Space', async () => {
    for (const source of ['rpc', 'internal'] as const) {
      const caller = { source, spaceId: SPACE_ID };
      expect(await invoke(deps(), 'workflow.run.get', { runId: 'run-1' }, caller)).toMatchObject({
        run: { id: 'run-1', spaceId: SPACE_ID },
      });
      expect(
        await invoke(
          deps(),
          'workflow.changePlan',
          { runId: 'run-1', description: 'Reworded' },
          caller
        )
      ).toMatchObject({
        outcome: 'described',
        run: { spaceId: SPACE_ID, description: 'Reworded' },
      });
      expect(
        await invoke(
          deps({ getRun: () => run({ spaceId: 'other' }) }),
          'workflow.run.get',
          { runId: 'run-1' },
          caller
        )
      ).toBe('run_not_found');
    }
  });
});
