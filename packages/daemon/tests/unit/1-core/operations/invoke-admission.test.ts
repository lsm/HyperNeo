import { describe, expect, mock, test } from 'bun:test';
import { z } from 'zod';
import {
  admitOperationCaller,
  invokeOperation,
  isOperationAdmitted,
} from '../../../../src/lib/operations/invoke';
import {
  createOperationRegistry,
  defineOperation,
  type OperationCaller,
  type OperationCallerRole,
  type OperationPolicy,
} from '../../../../src/lib/operations/registry';

const MCP_ROLES: readonly OperationCallerRole[] = [
  'ad_hoc_member',
  'workflow_worker',
  'direct_task_worker',
  'long_term_agent',
  'universal_read',
  'legacy_task_agent',
  'outside_space',
];

function fixture(policy?: OperationPolicy) {
  const execute = mock(async (input: { content: string }) => ({ accepted: input.content }));
  const operation = defineOperation({
    name: 'task.act',
    description: 'Act on a task',
    inputSchema: z.object({ content: z.string().min(1) }),
    resultSchema: z.object({ accepted: z.string() }),
    policy,
    execute,
  });
  return { execute, operation, registry: createOperationRegistry([operation]) };
}

function mcpCaller(role?: OperationCallerRole): OperationCaller {
  return { source: 'mcp', sessionId: 'agent-session', spaceId: 'space-1', role };
}

async function invoke(policy: OperationPolicy | undefined, caller: OperationCaller) {
  const { registry, execute } = fixture(policy);
  const outcome = await invokeOperation(registry, 'task.act', { content: 'hello' }, caller);
  return { outcome, execute };
}

describe('isOperationAdmitted', () => {
  test('admits every caller regardless of policy, role, or source; capability gating is removed', () => {
    const policies: (OperationPolicy | undefined)[] = [
      undefined,
      { safetyClass: 'read' },
      { safetyClass: 'mutate' },
      { safetyClass: 'destructive' },
      { safetyClass: 'human_only' },
      { safetyClass: 'mutate', roles: ['long_term_agent'] },
    ];
    for (const policy of policies) {
      const { operation } = fixture(policy);
      expect(isOperationAdmitted(operation, { source: 'rpc' })).toBe(true);
      expect(isOperationAdmitted(operation, { source: 'internal' })).toBe(true);
      for (const role of [...MCP_ROLES, undefined]) {
        expect(isOperationAdmitted(operation, mcpCaller(role))).toBe(true);
      }
    }
  });
});

describe('admitOperationCaller', () => {
  test('carries the prepared operation through for every caller, including one a human_only policy used to reject', () => {
    const { operation } = fixture({ safetyClass: 'human_only' });
    const prepared = { operation, input: { content: 'hello' } };
    expect(admitOperationCaller(prepared, mcpCaller('ad_hoc_member'))).toEqual({
      value: prepared,
    });
  });
});

describe('invokeOperation caller admission', () => {
  test('every caller and policy combination reaches execution now that the generic door is removed', async () => {
    const policies: (OperationPolicy | undefined)[] = [
      undefined,
      { safetyClass: 'read' },
      { safetyClass: 'mutate' },
      { safetyClass: 'destructive', roles: ['long_term_agent'] },
      { safetyClass: 'human_only' },
      { safetyClass: 'read', roles: ['workflow_worker'] },
    ];
    const callers: OperationCaller[] = [
      { source: 'rpc' },
      { source: 'internal' },
      ...MCP_ROLES.map((role) => mcpCaller(role)),
      mcpCaller(undefined),
    ];
    for (const policy of policies) {
      for (const caller of callers) {
        const { outcome, execute } = await invoke(policy, caller);
        expect(outcome).toEqual({ kind: 'completed', value: { accepted: 'hello' } });
        expect(execute).toHaveBeenCalledTimes(1);
      }
    }
  });

  test('admission no longer runs before input parsing; bad input still reports invalid_input', async () => {
    const { registry, execute } = fixture({ safetyClass: 'human_only' });
    expect(
      await invokeOperation(registry, 'task.act', { content: '' }, mcpCaller('ad_hoc_member'))
    ).toMatchObject({ kind: 'failed', code: 'invalid_input' });
    expect(execute).not.toHaveBeenCalled();
  });
});
