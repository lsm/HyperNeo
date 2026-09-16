import { describe, expect, test } from 'bun:test';
import type { SpaceWorkflowSummary } from '@hyperneo/shared';
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

function deps(overrides: Partial<WorkflowReadDependencies> = {}): WorkflowReadDependencies {
  return { listWorkflowSummaries: () => [summary()], ...overrides };
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
    expect(value).toEqual({ workflows: [summary(), summary({ id: 'wf-2', disabled: true })] });
  });

  test('workflow.list admits a workflow_worker', async () => {
    const worker = await invoke(deps(), 'workflow.list', {}, mcpCaller('workflow_worker'));
    expect(worker).toEqual({ workflows: [summary()] });
  });

  test('workflow.list is closed to a direct_task_worker at the door and in the operation', async () => {
    const caller = mcpCaller('direct_task_worker');
    const outcome = await outcomeOf(deps(), 'workflow.list', {}, caller);
    expect(outcome).toMatchObject({ kind: 'failed', code: 'forbidden' });
    expect(await operation(deps(), 'workflow.list').execute({}, caller)).toBe(
      'caller_not_admitted'
    );
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
    expect(scoped).toEqual({ workflows: [summary()] });
    expect(await invoke(deps(), 'workflow.list', {}, { source: 'rpc' })).toBe('space_not_resolved');
  });

  test('workflow.suggest drops disabled workflows', async () => {
    const value = await invoke(
      deps({
        listWorkflowSummaries: () => [summary(), summary({ id: 'wf-2', disabled: true })],
      }),
      'workflow.suggest',
      { description: 'fix a bug' },
      mcpCaller('long_term_agent')
    );
    expect(value).toEqual({ workflows: [summary()] });
  });

  test('workflow.suggest denies a legacy_task_agent caller', async () => {
    const outcome = await outcomeOf(
      deps(),
      'workflow.suggest',
      { description: 'fix a bug' },
      mcpCaller('legacy_task_agent')
    );
    expect(outcome).toMatchObject({ kind: 'failed', code: 'forbidden' });
  });
});
