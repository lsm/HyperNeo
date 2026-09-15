import { afterEach, describe, expect, test } from 'bun:test';
import { InProcessTransport, MessageHub } from '@hyperneo/shared';
import { z } from 'zod';
import type { CallerScopeResolver } from '../../../../src/lib/operations/caller';
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
  agentName: z.string().optional(),
});

async function hubPair(resolveScope: CallerScopeResolver) {
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
  const unregister = setupOperationHandlers(server, registry, resolveScope);
  await Promise.all(transports.map((transport) => transport.initialize()));
  const close = async () => {
    unregister();
    client.cleanup();
    server.cleanup();
    await Promise.all(transports.map((transport) => transport.close()));
  };
  return { client, close };
}

describe('operation.invoke caller scope', () => {
  let close: (() => Promise<void>) | undefined;
  afterEach(async () => {
    await close?.();
    close = undefined;
  });

  test('a transport session without scope invokes as a bare rpc caller', async () => {
    const seen: string[] = [];
    const pair = await hubPair((sessionId) => {
      seen.push(sessionId);
      return null;
    });
    close = pair.close;
    const caller = await pair.client.request('operation.invoke', {
      name: 'caller.echo',
      input: { sessionId: 'spoofed', role: 'long_term_agent' },
    });
    expect(caller).toEqual({ source: 'rpc' });
    expect(seen).toHaveLength(1);
  });

  test('a transport session with scope carries that scope and nothing from the payload', async () => {
    const pair = await hubPair(() => ({
      spaceId: 'space-1',
      role: 'ad_hoc_member',
      agentName: 'operator',
    }));
    close = pair.close;
    const caller = await pair.client.request<z.infer<typeof CallerSchema>>('operation.invoke', {
      name: 'caller.echo',
      input: { spaceId: 'spoofed-space', role: 'long_term_agent' },
      caller: { source: 'internal' },
    });
    expect(caller).toMatchObject({
      source: 'rpc',
      spaceId: 'space-1',
      role: 'ad_hoc_member',
      agentName: 'operator',
    });
    expect(typeof caller.sessionId).toBe('string');
  });
});
