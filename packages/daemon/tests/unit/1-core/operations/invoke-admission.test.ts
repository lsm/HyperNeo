import { describe, expect, mock, test } from 'bun:test';
import { z } from 'zod';
import { admitOperationCaller, invokeOperation } from '../../../../src/lib/operations/invoke';
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

describe('admitOperationCaller', () => {
  test('carries the prepared operation through when the caller is admitted', () => {
    const { operation } = fixture({ safetyClass: 'read' });
    const prepared = { operation, input: { content: 'hello' } };
    expect(admitOperationCaller(prepared, mcpCaller('workflow_worker'))).toEqual({
      value: prepared,
    });
  });

  test('names the rejected operation in the forbidden reason', () => {
    const { operation } = fixture({ safetyClass: 'human_only' });
    expect(admitOperationCaller({ operation, input: {} }, mcpCaller('ad_hoc_member'))).toEqual({
      reason: {
        kind: 'failed',
        code: 'forbidden',
        message: 'Operation task.act is not available to this caller',
      },
    });
  });
});

describe('invokeOperation caller admission', () => {
  test('rpc callers pass every policy, including human_only and role lists', async () => {
    const rpc: OperationCaller = { source: 'rpc' };
    for (const policy of [
      { safetyClass: 'human_only' } as const,
      { safetyClass: 'destructive', roles: ['long_term_agent'] } as const,
      { safetyClass: 'mutate' } as const,
    ]) {
      const { outcome, execute } = await invoke(policy, rpc);
      expect(outcome).toEqual({ kind: 'completed', value: { accepted: 'hello' } });
      expect(execute).toHaveBeenCalledTimes(1);
    }
  });

  test('internal callers pass a human_only policy', async () => {
    const { outcome } = await invoke({ safetyClass: 'human_only' }, { source: 'internal' });
    expect(outcome).toEqual({ kind: 'completed', value: { accepted: 'hello' } });
  });

  test('an operation without a policy is admitted for every mcp role', async () => {
    for (const role of MCP_ROLES) {
      const { outcome, execute } = await invoke(undefined, mcpCaller(role));
      expect(outcome).toEqual({ kind: 'completed', value: { accepted: 'hello' } });
      expect(execute).toHaveBeenCalledTimes(1);
    }
  });

  test('a roles list admits the listed role and denies workflow_worker', async () => {
    const policy = { safetyClass: 'mutate', roles: ['ad_hoc_member', 'long_term_agent'] } as const;
    const allowed = await invoke(policy, mcpCaller('ad_hoc_member'));
    expect(allowed.outcome).toEqual({ kind: 'completed', value: { accepted: 'hello' } });
    const denied = await invoke(policy, mcpCaller('workflow_worker'));
    expect(denied.outcome).toEqual({
      kind: 'failed',
      code: 'forbidden',
      message: 'Operation task.act is not available to this caller',
    });
    expect(denied.execute).not.toHaveBeenCalled();
  });

  test('a roles list denies an mcp caller carrying no role at all', async () => {
    const { outcome, execute } = await invoke(
      { safetyClass: 'read', roles: ['workflow_worker'] },
      mcpCaller()
    );
    expect(outcome).toMatchObject({ kind: 'failed', code: 'forbidden' });
    expect(execute).not.toHaveBeenCalled();
  });

  test('universal_read is denied a mutate policy and admitted a read policy', async () => {
    const denied = await invoke({ safetyClass: 'mutate' }, mcpCaller('universal_read'));
    expect(denied.outcome).toMatchObject({ kind: 'failed', code: 'forbidden' });
    expect(denied.execute).not.toHaveBeenCalled();
    const admitted = await invoke({ safetyClass: 'read' }, mcpCaller('universal_read'));
    expect(admitted.outcome).toEqual({ kind: 'completed', value: { accepted: 'hello' } });
    expect(admitted.execute).toHaveBeenCalledTimes(1);
  });

  test.each(['destructive', 'human_only'] as const)(
    'universal_read is denied a %s policy',
    async (safetyClass) => {
      const { outcome, execute } = await invoke({ safetyClass }, mcpCaller('universal_read'));
      expect(outcome).toMatchObject({ kind: 'failed', code: 'forbidden' });
      expect(execute).not.toHaveBeenCalled();
    }
  );

  test('human_only is denied for every mcp role even when the role is listed', async () => {
    for (const role of MCP_ROLES) {
      const { outcome, execute } = await invoke(
        { safetyClass: 'human_only', roles: [role] },
        mcpCaller(role)
      );
      expect(outcome).toEqual({
        kind: 'failed',
        code: 'forbidden',
        message: 'Operation task.act is not available to this caller',
      });
      expect(execute).not.toHaveBeenCalled();
    }
  });

  test('admission runs after input parsing, so bad input still reports invalid_input', async () => {
    const { registry, execute } = fixture({ safetyClass: 'human_only' });
    expect(
      await invokeOperation(registry, 'task.act', { content: '' }, mcpCaller('ad_hoc_member'))
    ).toMatchObject({ kind: 'failed', code: 'invalid_input' });
    expect(execute).not.toHaveBeenCalled();
  });
});
