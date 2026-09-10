import { beforeEach, describe, expect, test } from 'bun:test';
import { z } from 'zod';
import { createDiscoveryOperations } from '../../../../src/lib/operations/discovery';
import { createOperationMcpServer } from '../../../../src/lib/operations/mcp-server';
import {
  createOperationRegistry,
  defineOperation,
  type OperationCaller,
  type OperationRegistry,
} from '../../../../src/lib/operations/registry';

describe('operation MCP server', () => {
  let server: ReturnType<typeof createOperationMcpServer>;
  let calls: { input: string; caller: OperationCaller }[];

  beforeEach(() => {
    calls = [];
    let registry: OperationRegistry;
    registry = createOperationRegistry([
      defineOperation({
        name: 'example.echo',
        description: 'Echo text',
        inputSchema: z.string().min(1),
        resultSchema: z.string(),
        execute: async (input, caller) => {
          calls.push({ input, caller });
          return input;
        },
      }),
      ...createDiscoveryOperations(() => registry),
    ]);
    server = createOperationMcpServer(registry, () => ({ sessionId: 'trusted-session' }));
  });

  function call(args: { name: string; input?: unknown; caller?: unknown }) {
    return server.tools[0].handler(args, {});
  }

  test('discovers operations and schemas through one generic SDK tool', async () => {
    const { tools } = server;
    expect(server.type).toBe('sdk');
    expect(server.name).toBe('operations');
    expect(tools.map(({ name }) => name)).toEqual(['invoke']);
    expect(tools[0].inputSchema).toHaveProperty('name');
    const listed = await call({ name: 'operations.list' });
    expect(listed.isError).not.toBe(true);
    expect(listed.content).toEqual([
      {
        type: 'text',
        text: JSON.stringify([
          { name: 'example.echo', description: 'Echo text' },
          { name: 'operations.list', description: 'List operations available in this catalog.' },
          {
            name: 'operations.describe',
            description: 'Describe an operation and its input and result schemas.',
          },
        ]),
      },
    ]);
    const described = await call({ name: 'operations.describe', input: { name: 'example.echo' } });
    expect(described.isError).not.toBe(true);
    expect(described.content).toEqual([
      expect.objectContaining({ type: 'text', text: expect.stringContaining('"type":"string"') }),
    ]);
    expect(calls).toEqual([]);
  });

  test('invokes the canonical implementation with a server-bound caller', async () => {
    const result = await call({
      name: 'example.echo',
      input: 'hello',
      caller: { source: 'rpc', sessionId: 'spoofed' },
    });
    expect(result.isError).not.toBe(true);
    expect(result.content).toEqual([{ type: 'text', text: '"hello"' }]);
    expect(calls).toEqual([
      { input: 'hello', caller: { source: 'mcp', sessionId: 'trusted-session' } },
    ]);
  });

  test('returns operation failures through MCP without executing the operation', async () => {
    for (const args of [{ name: 'missing' }, { name: 'example.echo', input: '' }]) {
      const result = await call(args);
      expect(result.isError).toBe(true);
    }
    expect(calls).toEqual([]);
  });
});
