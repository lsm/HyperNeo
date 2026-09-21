import { beforeEach, describe, expect, test } from 'bun:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { z } from 'zod';
import { createDiscoveryOperations } from '../../../../src/lib/operations/discovery';
import {
  createOperationMcpHandler,
  OperationMcpInvocationSchema,
} from '../../../../src/lib/operations/mcp-adapter';
import { createOperationMcpServer } from '../../../../src/lib/operations/mcp-server';
import {
  createOperationRegistry,
  defineOperation,
  type OperationCaller,
  type OperationRegistry,
} from '../../../../src/lib/operations/registry';

describe('operation MCP server', () => {
  let server: ReturnType<typeof createOperationMcpServer>;
  let calls: { input: { text: string }; caller: OperationCaller }[];

  beforeEach(() => {
    calls = [];
    let registry: OperationRegistry;
    registry = createOperationRegistry([
      defineOperation({
        name: 'example.echo',
        description: 'Echo text',
        inputSchema: z.object({ text: z.string().min(1) }),
        resultSchema: z.object({ text: z.string() }),
        execute: async (input, caller) => {
          calls.push({ input, caller });
          return { text: input.text };
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
    expect(server.name).toBe('hyperneo-operations');
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
      input: { text: 'hello' },
      caller: { source: 'rpc', sessionId: 'spoofed' },
    });
    expect(result.isError).not.toBe(true);
    expect(result.content).toEqual([{ type: 'text', text: '{"text":"hello"}' }]);
    expect(calls).toEqual([
      { input: { text: 'hello' }, caller: { source: 'mcp', sessionId: 'trusted-session' } },
    ]);
  });

  test('returns operation failures through MCP without executing the operation', async () => {
    for (const args of [{ name: 'missing' }, { name: 'example.echo', input: { text: '' } }]) {
      const result = await call(args);
      expect(result.isError).toBe(true);
    }
    expect(calls).toEqual([]);
  });

  test('advertises structured invoke inputs and round-trips them through the SDK boundary', async () => {
    const received: unknown[] = [];
    const registry = createOperationRegistry([
      defineOperation({
        name: 'structured.echo',
        description: 'Echo structured input',
        inputSchema: z.object({ payload: z.record(z.string(), z.unknown()) }),
        resultSchema: z.object({ payload: z.record(z.string(), z.unknown()) }),
        execute: async (input) => {
          received.push(input);
          return { payload: input.payload };
        },
      }),
    ]);
    const sdkUrl = new URL(
      '../../../../node_modules/@anthropic-ai/claude-agent-sdk/sdk.mjs',
      import.meta.url
    ).href;
    const { createSdkMcpServer, tool } = await import(sdkUrl);
    const bounded = createSdkMcpServer({
      name: 'operations',
      tools: [
        tool(
          'invoke',
          'Invoke a daemon operation by name.',
          OperationMcpInvocationSchema.shape,
          createOperationMcpHandler(registry, () => ({ sessionId: 'trusted-session' }))
        ),
      ],
    });
    const client = new Client({ name: 'regression', version: '1.0' });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await bounded.instance.connect(serverTransport);
    await client.connect(clientTransport);
    try {
      const advertised = (await client.listTools()).tools.find((entry) => entry.name === 'invoke');
      expect(advertised?.inputSchema).toMatchObject({
        type: 'object',
        properties: { input: { type: 'object' } },
      });
      const payload = { nested: { list: [1, 'two', true] } };
      const result = await client.callTool({
        name: 'invoke',
        arguments: { name: 'structured.echo', input: { payload } },
      });
      expect(result.isError).not.toBe(true);
      expect(result.content).toEqual([{ type: 'text', text: JSON.stringify({ payload }) }]);
      expect(received).toEqual([{ payload }]);
    } finally {
      await client.close();
      await bounded.instance.close();
    }
  });
});
