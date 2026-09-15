import { afterEach, describe, expect, test } from 'bun:test';
import { InProcessTransport, MessageHub } from '@hyperneo/shared';
import { z } from 'zod';
import {
  createOperationRegistry,
  defineOperation,
  type OperationCaller,
} from '../../../../src/lib/operations/registry';
import { setupOperationHandlers } from '../../../../src/lib/rpc-handlers/operation-handlers';

const CallerSchema = z.object({
  source: z.string(),
  sessionId: z.string().optional(),
  spaceId: z.string().optional(),
  role: z.string().optional(),
  agentId: z.string().optional(),
  agentName: z.string().optional(),
});

async function hubPair() {
  const client = new MessageHub();
  const server = new MessageHub();
  const transports = InProcessTransport.createPair();
  client.registerTransport(transports[0]);
  server.registerTransport(transports[1]);
  const registry = createOperationRegistry([
    defineOperation({
      name: 'caller.echo',
      description: 'Return the caller the door supplied',
      inputSchema: z.unknown(),
      resultSchema: CallerSchema,
      execute: async (_input, caller: OperationCaller) => caller,
    }),
  ]);
  const unregister = setupOperationHandlers(server, registry);
  await Promise.all(transports.map((transport) => transport.initialize()));
  const close = async () => {
    unregister();
    client.cleanup();
    server.cleanup();
    await Promise.all(transports.map((transport) => transport.close()));
  };
  return { client, close };
}

describe('the RPC door never derives identity from the wire session id', () => {
  let close: (() => Promise<void>) | undefined;
  afterEach(async () => {
    await close?.();
    close = undefined;
  });

  test.each([
    { label: 'identity keys in the input', input: { spaceId: 'space-1', role: 'long_term_agent' } },
    { label: 'a long-term agent session id', input: { sessionId: 'space:agent:space-1:agent-7' } },
    { label: 'nothing at all', input: {} },
  ])('yields a bare rpc caller for $label', async ({ input }) => {
    const pair = await hubPair();
    close = pair.close;
    expect(
      await pair.client.request('operation.invoke', {
        name: 'caller.echo',
        input,
        caller: { source: 'internal', sessionId: 'spoofed', role: 'long_term_agent' },
      })
    ).toEqual({ source: 'rpc' });
  });
});
