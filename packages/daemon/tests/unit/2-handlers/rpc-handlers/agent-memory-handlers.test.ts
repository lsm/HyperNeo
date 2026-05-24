import { describe, test, expect } from 'bun:test';
import { setupAgentMemoryHandlers } from '../../../../src/lib/rpc-handlers/agent-memory-handlers.ts';

function createMessageHubStub() {
  const handlers = new Map<string, (payload: unknown) => Promise<unknown>>();
  return {
    messageHub: {
      onRequest(name: string, handler: (payload: unknown) => Promise<unknown>) {
        handlers.set(name, handler);
      },
    },
    handlers,
  };
}

describe('agent memory RPC handlers', () => {
  test('rejects non-finite numeric params', async () => {
    const { messageHub, handlers } = createMessageHubStub();
    setupAgentMemoryHandlers(messageHub as never, {
      memoryRepo: {
        list: () => [],
      } as never,
    });

    await expect(
      handlers.get('agentMemory.list')?.({ spaceId: 'space-a', offset: Infinity })
    ).rejects.toThrow('offset must be a finite number.');
  });

  test('rejects offsets outside safe integer range', async () => {
    const { messageHub, handlers } = createMessageHubStub();
    setupAgentMemoryHandlers(messageHub as never, {
      memoryRepo: {
        list: () => [],
      } as never,
    });

    await expect(
      handlers.get('agentMemory.list')?.({ spaceId: 'space-a', offset: 1e308 })
    ).rejects.toThrow('offset must be a safe integer.');
  });

  test('write preserves tags when payload omits them', async () => {
    const { messageHub, handlers } = createMessageHubStub();
    const writes: Array<Record<string, unknown>> = [];
    setupAgentMemoryHandlers(messageHub as never, {
      memoryRepo: {
        write: (params: Record<string, unknown>) => {
          writes.push(params);
          return params;
        },
      } as never,
    });

    await handlers.get('agentMemory.write')?.({
      spaceId: 'space-a',
      key: 'conventions.api',
      content: 'Content only.',
    });

    expect(writes[0]?.tags).toBeUndefined();
  });

  test('write ignores caller-supplied createdBySession', async () => {
    const { messageHub, handlers } = createMessageHubStub();
    const writes: Array<Record<string, unknown>> = [];
    setupAgentMemoryHandlers(messageHub as never, {
      memoryRepo: {
        write: (params: Record<string, unknown>) => {
          writes.push(params);
          return params;
        },
      } as never,
    });

    await handlers.get('agentMemory.write')?.({
      spaceId: 'space-a',
      key: 'conventions.api',
      content: 'Body',
      createdBySession: 'forged-session',
    });

    expect(writes[0]?.createdBySession).toBeNull();
  });
});
