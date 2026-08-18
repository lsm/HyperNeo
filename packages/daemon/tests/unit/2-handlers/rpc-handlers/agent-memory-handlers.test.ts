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

  test('create delegates to the repository insert-only create', async () => {
    const { messageHub, handlers } = createMessageHubStub();
    const creates: Array<Record<string, unknown>> = [];
    setupAgentMemoryHandlers(messageHub as never, {
      memoryRepo: {
        create: (params: Record<string, unknown>) => {
          creates.push(params);
          return params;
        },
      } as never,
    });

    await handlers.get('agentMemory.create')?.({
      spaceId: 'space-a',
      key: 'k',
      content: 'c',
      tags: ['t'],
    });

    expect(creates[0]).toMatchObject({ spaceId: 'space-a', key: 'k', content: 'c', tags: ['t'] });
    expect(creates[0]?.createdBySession).toBeNull();
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

  test('list is a read-only management query (recordAccess: false)', async () => {
    const { messageHub, handlers } = createMessageHubStub();
    const calls: Array<Record<string, unknown>> = [];
    setupAgentMemoryHandlers(messageHub as never, {
      memoryRepo: {
        list: (_spaceId: string, options: Record<string, unknown>) => {
          calls.push(options);
          return [];
        },
      } as never,
    });

    await handlers.get('agentMemory.list')?.({ spaceId: 'space-a', query: 'conventions' });

    expect(calls[0]?.recordAccess).toBe(false);
  });

  test('read forwards recordAccess from the payload', async () => {
    const { messageHub, handlers } = createMessageHubStub();
    const calls: Array<{ recordAccess: boolean | undefined }> = [];
    setupAgentMemoryHandlers(messageHub as never, {
      memoryRepo: {
        read: (_spaceId: string, _key: string, options?: { recordAccess?: boolean }) => {
          calls.push({ recordAccess: options?.recordAccess });
          return null;
        },
      } as never,
    });

    await handlers.get('agentMemory.read')?.({ spaceId: 'space-a', key: 'k', recordAccess: false });
    await handlers.get('agentMemory.read')?.({ spaceId: 'space-a', key: 'k' });

    expect(calls[0]?.recordAccess).toBe(false);
    expect(calls[1]?.recordAccess).toBeUndefined();
  });
});
