import { describe, expect, test } from 'bun:test';
import type { SpaceWorkflow, SpaceWorkflowSummary } from '@hyperneo/shared';
import { invokeOperation } from '../../../../src/lib/operations/invoke.ts';
import {
  createOperationRegistry,
  type OperationCaller,
  type OperationCallerRole,
} from '../../../../src/lib/operations/registry.ts';
import {
  createWorkflowReadOperations,
  type WorkflowReadDependencies,
} from '../../../../src/lib/workflows/workflow-read-operations.ts';

const SPACE_ID = 'space-workflow-reads';

function summary(overrides: Partial<SpaceWorkflowSummary> = {}): SpaceWorkflowSummary {
  return {
    id: 'wf-1',
    spaceId: SPACE_ID,
    name: 'Ship it',
    description: 'A coding workflow',
    tags: ['coding'],
    nodeCount: 2,
    completionAutonomyLevel: 3,
    createdAt: 1,
    updatedAt: 2,
    ...overrides,
  };
}

function workflow(overrides: Partial<SpaceWorkflow> = {}): SpaceWorkflow {
  return {
    id: 'wf-1',
    spaceId: SPACE_ID,
    name: 'Ship it',
    nodes: [
      {
        id: 'node-1',
        name: 'implement',
        agents: [{ agentId: 'agent-1', name: 'coder' }],
        transitions: [{ id: 't-1', target: 'review' }],
      },
    ],
    startNodeId: 'node-1',
    tags: ['coding'],
    createdAt: 1,
    updatedAt: 2,
    completionAutonomyLevel: 3,
    handle: 'ship-it',
    ...overrides,
  };
}

function deps(overrides: Partial<WorkflowReadDependencies> = {}): WorkflowReadDependencies {
  return {
    listWorkflowSummaries: () => [summary()],
    getWorkflow: () => workflow(),
    getWorkflowByHandle: () => null,
    ...overrides,
  };
}

function mcpCaller(role: OperationCallerRole, spaceId: string | null = SPACE_ID) {
  return {
    source: 'mcp',
    sessionId: 'session-1',
    spaceId: spaceId ?? undefined,
    role,
  } satisfies OperationCaller;
}

function outcomeOf(
  dependencies: WorkflowReadDependencies,
  name: string,
  input: unknown,
  caller: OperationCaller
) {
  const registry = createOperationRegistry(createWorkflowReadOperations(dependencies));
  return invokeOperation(registry, name, input, caller);
}

async function invoke(
  dependencies: WorkflowReadDependencies,
  name: string,
  input: unknown,
  caller: OperationCaller
) {
  const outcome = await outcomeOf(dependencies, name, input, caller);
  if (outcome.kind !== 'completed') throw new Error(`${outcome.code}: ${outcome.message}`);
  return outcome.value;
}

function operation(dependencies: WorkflowReadDependencies, name: string) {
  const found = createWorkflowReadOperations(dependencies).find((entry) => entry.name === name);
  if (!found) throw new Error(`no operation named ${name}`);
  return found;
}

describe('workflow catalog read operations', () => {
  test('workflow.list scopes an MCP caller to its own Space and keeps disabled workflows', async () => {
    const seen: string[] = [];
    const value = await invoke(
      deps({
        listWorkflowSummaries: (spaceId) => {
          seen.push(spaceId);
          return [summary(), summary({ id: 'wf-2', disabled: true })];
        },
      }),
      'workflow.list',
      {},
      mcpCaller('ad_hoc_member')
    );
    expect(seen).toEqual([SPACE_ID]);
    expect(value).toEqual({
      scope: { spaceId: SPACE_ID },
      workflows: [summary(), summary({ id: 'wf-2', disabled: true })],
    });
  });

  test('workflow.list admits a workflow_worker', async () => {
    const worker = await invoke(deps(), 'workflow.list', {}, mcpCaller('workflow_worker'));
    expect(worker).toEqual({ scope: { spaceId: SPACE_ID }, workflows: [summary()] });
  });

  test('workflow.list admits a direct_task_worker scoped to the Space', async () => {
    const caller = mcpCaller('direct_task_worker');
    const outcome = await outcomeOf(deps(), 'workflow.list', {}, caller);
    expect(outcome).toMatchObject({ kind: 'completed', value: { workflows: [summary()] } });
  });

  test('workflow.list still reports space_not_resolved for a direct_task_worker with no Space', async () => {
    const value = await invoke(deps(), 'workflow.list', {}, mcpCaller('direct_task_worker', null));
    expect(value).toBe('space_not_resolved');
  });

  test('workflow.list rejects an MCP caller asking for another Space', async () => {
    const value = await invoke(
      deps(),
      'workflow.list',
      { spaceId: 'other-space' },
      mcpCaller('ad_hoc_member')
    );
    expect(value).toBe('caller_not_admitted');
  });

  test('workflow.list reports space_not_resolved for a universal_read caller with no Space', async () => {
    const value = await invoke(deps(), 'workflow.list', {}, mcpCaller('universal_read', null));
    expect(value).toBe('space_not_resolved');
  });

  test('workflow.list reads the Space an RPC caller names and rejects an unscoped one', async () => {
    const seen: string[] = [];
    const scoped = await invoke(
      deps({
        listWorkflowSummaries: (spaceId) => {
          seen.push(spaceId);
          return [summary()];
        },
      }),
      'workflow.list',
      { spaceId: 'human-space' },
      { source: 'rpc' }
    );
    expect(seen).toEqual(['human-space']);
    expect(scoped).toEqual({ scope: { spaceId: 'human-space' }, workflows: [summary()] });
    expect(await invoke(deps(), 'workflow.list', {}, { source: 'rpc' })).toBe('space_not_resolved');
  });

  test('workflow.list drops disabled workflows when enabled is true', async () => {
    const value = await invoke(
      deps({
        listWorkflowSummaries: () => [summary(), summary({ id: 'wf-2', disabled: true })],
      }),
      'workflow.list',
      { enabled: true },
      mcpCaller('long_term_agent')
    );
    expect(value).toEqual({ scope: { spaceId: SPACE_ID }, workflows: [summary()] });
  });

  test('workflow.list keeps disabled workflows when enabled is omitted', async () => {
    const disabled = summary({ id: 'wf-2', disabled: true });
    const value = await invoke(
      deps({ listWorkflowSummaries: () => [summary(), disabled] }),
      'workflow.list',
      {},
      mcpCaller('long_term_agent')
    );
    expect(value).toEqual({ scope: { spaceId: SPACE_ID }, workflows: [summary(), disabled] });
  });

  test('workflow.list admits a legacy_task_agent caller scoped to the Space', async () => {
    const outcome = await outcomeOf(
      deps(),
      'workflow.list',
      { enabled: true },
      mcpCaller('legacy_task_agent')
    );
    expect(outcome).toMatchObject({ kind: 'completed', value: { workflows: [summary()] } });
  });

  test('workflow.get returns the workflow named by workflowId', async () => {
    const value = await invoke(
      deps(),
      'workflow.get',
      { workflowId: 'wf-1' },
      mcpCaller('ad_hoc_member')
    );
    expect(value).toEqual(workflow());
  });

  test('workflow.get keeps every nested field of the workflow record', async () => {
    const rich = workflow({
      instructions: 'Follow the plan',
      channels: [{ id: 'c-1', from: 'implement', to: ['review'], maxCycles: 2 }],
      hooks: [
        {
          id: 'h-1',
          enabled: true,
          sourceNode: 'implement',
          method: 'save_artifact',
          validator: { kind: 'built_in', id: 'pr_open' },
          templateData: { shape: 'link' },
          retry: { maxAttempts: 2, delayMs: 100 },
        },
      ],
      layout: { 'node-1': { x: 10, y: 20 } },
      postApproval: { targetAgent: 'coder', instructions: 'merge it' },
    });
    const value = await invoke(
      deps({ getWorkflow: () => rich }),
      'workflow.get',
      { workflowId: 'wf-1' },
      mcpCaller('workflow_worker')
    );
    expect(value).toEqual(rich);
  });

  test('workflow.get falls back to workflowHandle when the id names a disabled workflow', async () => {
    const byHandle = workflow({ id: 'wf-2', handle: 'other' });
    const value = await invoke(
      deps({
        getWorkflow: () => workflow({ disabled: true }),
        getWorkflowByHandle: (_spaceId, handle) => (handle === 'other' ? byHandle : null),
      }),
      'workflow.get',
      { workflowId: 'wf-1', workflowHandle: 'other' },
      mcpCaller('ad_hoc_member')
    );
    expect(value).toEqual(byHandle);
  });

  test('workflow.get keeps a disabled in-Space workflow when no handle resolves', async () => {
    const disabled = workflow({ disabled: true });
    const value = await invoke(
      deps({ getWorkflow: () => disabled }),
      'workflow.get',
      { workflowId: 'wf-1' },
      mcpCaller('ad_hoc_member')
    );
    expect(value).toEqual(disabled);
  });

  test('workflow.get hides a workflow owned by another Space', async () => {
    const value = await invoke(
      deps({ getWorkflow: () => workflow({ spaceId: 'other-space' }) }),
      'workflow.get',
      { workflowId: 'wf-1' },
      mcpCaller('ad_hoc_member')
    );
    expect(value).toBe('workflow_not_found');
  });

  test('workflow.get reads nothing for an outside_space caller that carries no Space', async () => {
    let reads = 0;
    const dependencies = deps({
      getWorkflow: () => {
        reads += 1;
        return workflow();
      },
    });
    const caller = mcpCaller('outside_space', null);
    const outcome = await outcomeOf(dependencies, 'workflow.get', { workflowId: 'wf-1' }, caller);
    expect(outcome).toMatchObject({ kind: 'completed', value: 'space_not_resolved' });
    expect(
      await operation(dependencies, 'workflow.get').execute({ workflowId: 'wf-1' }, caller)
    ).toBe('space_not_resolved');
    expect(reads).toBe(0);
  });

  test('workflow.get rejects a call naming neither a workflowId nor a workflowHandle', async () => {
    const registry = createOperationRegistry(createWorkflowReadOperations(deps()));
    const outcome = await invokeOperation(registry, 'workflow.get', {}, mcpCaller('ad_hoc_member'));
    expect(outcome.kind).toBe('failed');
  });
});

describe('workflow optional Space scope', () => {
  for (const source of ['rpc', 'internal', 'mcp'] as const) {
    test(`${source} lists only the trusted caller Space when input omits it`, async () => {
      const seen: string[] = [];
      const dependencies = deps({
        listWorkflowSummaries: (spaceId) => {
          seen.push(spaceId);
          return [];
        },
      });
      const caller: OperationCaller = { source, spaceId: SPACE_ID, role: 'ad_hoc_member' };
      for (const input of [{}, { enabled: true }]) {
        expect(await invoke(dependencies, 'workflow.list', input, caller)).toEqual({
          workflows: [],
          scope: { spaceId: SPACE_ID },
        });
      }
      expect(seen).toEqual([SPACE_ID, SPACE_ID]);
      expect(await invoke(deps(), 'workflow.get', { workflowId: 'wf-1' }, caller)).toEqual(
        workflow()
      );
    });
  }

  test('an explicit RPC Space overrides the caller default but payload identity is rejected', async () => {
    const caller: OperationCaller = { source: 'rpc', spaceId: SPACE_ID };
    expect(
      await invoke(
        deps({ listWorkflowSummaries: () => [] }),
        'workflow.list',
        { spaceId: 'other' },
        caller
      )
    ).toEqual({ workflows: [], scope: { spaceId: 'other' } });
    expect(
      await outcomeOf(deps(), 'workflow.list', { caller: { spaceId: 'other' } }, caller)
    ).toMatchObject({ kind: 'failed' });
  });
});
