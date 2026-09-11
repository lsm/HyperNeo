import { expect, test } from 'bun:test';
import type { CallContext } from '@hyperneo/shared';
import { z } from 'zod';
import { createDiscoveryOperations } from '../../../../src/lib/operations/discovery';
import { createOperationMcpHandler } from '../../../../src/lib/operations/mcp-adapter';
import { createOperationRpcHandler } from '../../../../src/lib/operations/rpc-adapter';
import {
  createOperationRegistry,
  defineOperation,
  resolveOperationRegistry,
} from '../../../../src/lib/operations/registry';

function catalog(name: string) {
  const registry = createOperationRegistry([
    defineOperation({
      name,
      description: name,
      inputSchema: z.unknown(),
      resultSchema: z.unknown(),
      execute: async (_input, caller) => caller,
    }),
    ...createDiscoveryOperations(() => registry),
  ]);
  return registry;
}

test('cached transport handlers resolve current registry for discovery and invocation', async () => {
  let current = catalog('first');
  const provider = () => current;
  expect(resolveOperationRegistry(current)).toBe(current);
  expect(resolveOperationRegistry(provider)).toBe(current);
  const caller = () => ({ sessionId: 'trusted', source: 'internal' as const });
  const mcp = createOperationMcpHandler(provider, caller);
  const rpc = createOperationRpcHandler(provider, caller);
  const context = {
    messageId: 'id',
    sessionId: 'global',
    method: 'operation.invoke',
    timestamp: 'now',
  } as CallContext;
  const mcpValue = async (args: unknown) => JSON.parse((await mcp(args)).content[0].text);
  expect(await mcpValue({ name: 'operations.list' })).toContainEqual({
    name: 'first',
    description: 'first',
  });
  current = catalog('second');
  expect(await rpc({ name: 'operations.list' }, context)).toContainEqual({
    name: 'second',
    description: 'second',
  });
  expect(await mcpValue({ name: 'operations.describe', input: { name: 'second' } })).toMatchObject({
    found: true,
    name: 'second',
  });
  expect(await mcpValue({ name: 'first' })).toMatchObject({ code: 'unknown_operation' });
  expect(await mcpValue({ name: 'second' })).toEqual({ source: 'mcp', sessionId: 'trusted' });
  expect(await rpc({ name: 'second' }, context)).toEqual({ source: 'rpc', sessionId: 'trusted' });
});
