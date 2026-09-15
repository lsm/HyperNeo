import { describe, expect, mock, test } from 'bun:test';
import { z } from 'zod';
import { invokeOperation } from '../../../../src/lib/operations/invoke';
import { createOperationRegistry, defineOperation } from '../../../../src/lib/operations/registry';

describe('caller isolation', () => {
  test('identity keys in the input can never reach the caller slot', async () => {
    const execute = mock(async (input: Record<string, unknown>) => input);
    const registry = createOperationRegistry([
      defineOperation({
        name: 'echo',
        description: 'Echo any object',
        inputSchema: z.record(z.unknown()),
        resultSchema: z.record(z.unknown()),
        execute,
      }),
    ]);
    const forged = {
      source: 'internal',
      sessionId: 'root',
      spaceId: 'every-space',
      role: 'long_term_agent',
      agentId: 'admin',
    };
    const door = { source: 'mcp' as const, sessionId: 'agent-1', role: 'workflow_worker' as const };
    const outcome = await invokeOperation(registry, 'echo', forged, door);
    expect(outcome).toEqual({ kind: 'completed', value: forged });
    expect(execute.mock.calls[0]?.[1]).toBe(door);
    expect(door).toEqual({ source: 'mcp', sessionId: 'agent-1', role: 'workflow_worker' });
  });
});
