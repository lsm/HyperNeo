import { describe, expect, mock, test } from 'bun:test';
import { z } from 'zod';
import { createOperationRpcHandler } from '../../../../src/lib/operations/rpc-adapter';
import { createOperationMcpHandler } from '../../../../src/lib/operations/mcp-adapter';
import {
  createDiscoveryOperations,
  findDescribedOperation,
} from '../../../../src/lib/operations/discovery';
import { invokeOperation } from '../../../../src/lib/operations/invoke';
import {
  createOperationRegistry,
  defineOperation,
  type OperationRegistry,
} from '../../../../src/lib/operations/registry';

const caller = { source: 'internal' as const };
function fixture() {
  let registry: OperationRegistry;
  const execute = mock(async (input: string) => ({ value: input }));
  const discovery = createDiscoveryOperations(() => registry);
  registry = createOperationRegistry([
    defineOperation({
      name: 'example',
      description: 'An example',
      inputSchema: z.string().min(1),
      resultSchema: z.object({ value: z.string() }),
      execute,
    }),
    ...discovery,
  ]);
  return { registry, execute };
}

describe('shared operation discovery', () => {
  test('lists the same catalog including discovery operations without executing business actions', async () => {
    const { registry, execute } = fixture();
    expect(await invokeOperation(registry, 'operations.list', {}, caller)).toEqual({
      kind: 'completed',
      value: [
        { name: 'example', description: 'An example' },
        { name: 'operations.list', description: 'List operations available in this catalog.' },
        {
          name: 'operations.describe',
          description: 'Describe an operation and its input and result schemas.',
        },
      ],
    });
    expect(execute).not.toHaveBeenCalled();
  });
  test('describes input and result structure from the registered schemas', async () => {
    const { registry, execute } = fixture();
    expect(
      await invokeOperation(registry, 'operations.describe', { name: 'example' }, caller)
    ).toMatchObject({
      kind: 'completed',
      value: {
        found: true,
        name: 'example',
        description: 'An example',
        inputSchema: { type: 'string', minLength: 1 },
        resultSchema: { type: 'object', properties: { value: { type: 'string' } } },
      },
    });
    expect(execute).not.toHaveBeenCalled();
  });
  test('returns an explicit missing result without throwing', async () => {
    const { registry } = fixture();
    expect(findDescribedOperation(registry, 'missing')).toEqual({
      reason: { found: false, name: 'missing' },
    });
    expect(
      await invokeOperation(registry, 'operations.describe', { name: 'missing' }, caller)
    ).toEqual({ kind: 'completed', value: { found: false, name: 'missing' } });
  });
  test('can describe its own operation without recursive expansion', async () => {
    const { registry } = fixture();
    expect(
      await invokeOperation(
        registry,
        'operations.describe',
        { name: 'operations.describe' },
        caller
      )
    ).toMatchObject({ kind: 'completed', value: { found: true, inputSchema: { type: 'object' } } });
  });
  test('schema conversion failure is normalized by invocation', async () => {
    let registry: OperationRegistry;
    registry = createOperationRegistry([
      defineOperation({
        name: 'unrepresentable',
        description: 'Transformed output',
        inputSchema: z.string(),
        resultSchema: z.string().transform((text) => text.length),
        execute: async () => 1,
      }),
      ...createDiscoveryOperations(() => registry),
    ]);
    expect(
      await invokeOperation(registry, 'operations.describe', { name: 'unrepresentable' }, caller)
    ).toMatchObject({ kind: 'failed', code: 'execution_failed' });
  });
  test('accepts no-input discovery requests through RPC and MCP', async () => {
    const { registry, execute } = fixture();
    const rpc = createOperationRpcHandler(registry, () => ({}));
    const mcp = createOperationMcpHandler(registry, () => ({}));
    const expected = registry.entries.map(({ name, description }) => ({ name, description }));
    expect(
      await rpc(
        { name: 'operations.list' },
        {
          messageId: 'request-1',
          sessionId: 'global',
          method: 'operation.invoke',
          timestamp: 'now',
        }
      )
    ).toEqual(expected);
    const result = await mcp({ name: 'operations.list' });
    expect(result.isError).toBeUndefined();
    expect(JSON.parse(result.content[0].text)).toEqual(expected);
    expect(execute).not.toHaveBeenCalled();
  });
});
