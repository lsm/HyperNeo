import { describe, expect, mock, test } from 'bun:test';
import { z } from 'zod';
import { createOperationMcpHandler } from '../../../../src/lib/operations/mcp-adapter';
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
  'neo',
  'long_term_agent',
  'workflow_worker',
  'direct_task_worker',
  'universal_read',
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
  test('preserves non-Neo access and applies Neo policy', () => {
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
        expect(isOperationAdmitted(operation, mcpCaller(role))).toBe(
          role !== 'neo' ||
            (policy?.safetyClass !== 'human_only' &&
              (!policy?.roles || policy.roles.includes('neo')))
        );
      }
    }
  });
});

describe('admitOperationCaller', () => {
  test('carries the prepared operation through for every caller, including one a human_only policy used to reject', () => {
    const { operation } = fixture({ safetyClass: 'human_only' });
    expect(
      admitOperationCaller(
        operation,
        mcpCaller('long_term_agent'),
        createOperationRegistry([operation])
      )
    ).toEqual({
      value: operation,
    });
  });
});

describe('invokeOperation caller admission', () => {
  test('preserves legitimate callers and refuses denied Neo calls', async () => {
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
        if (
          caller.role === 'neo' &&
          (policy?.safetyClass === 'human_only' || (policy?.roles && !policy.roles.includes('neo')))
        ) {
          expect(outcome).toMatchObject({ code: 'forbidden' });
          expect(execute).not.toHaveBeenCalled();
        } else {
          expect(outcome).toEqual({ kind: 'completed', value: { accepted: 'hello' } });
          expect(execute).toHaveBeenCalledTimes(1);
        }
      }
    }
  });

  test.each([...MCP_ROLES, undefined])('bad input stops effects for role %s', async (role) => {
    const { registry, execute } = fixture({ safetyClass: 'human_only' });
    expect(
      await invokeOperation(registry, 'task.act', { content: '' }, mcpCaller(role))
    ).toMatchObject({ kind: 'failed', code: role === 'neo' ? 'forbidden' : 'invalid_input' });
    expect(execute).not.toHaveBeenCalled();
  });

  test.each(['neo:root', 'neo:holder'])(
    'the MCP adapter preserves trusted Neo identity for %s instead of impersonating RPC',
    async (sessionId) => {
      const { registry, execute } = fixture({ safetyClass: 'mutate', roles: ['long_term_agent'] });
      const caller: OperationCaller = { source: 'mcp', sessionId, role: 'neo' };
      const mcp = createOperationMcpHandler(registry, () => caller);
      const result = await mcp({
        name: 'task.act',
        input: { content: 'hello' },
        caller: { source: 'rpc', principal: 'local', role: 'long_term_agent' },
      });
      expect(result.isError).toBe(true);
      expect(execute).not.toHaveBeenCalled();
    }
  );
});
