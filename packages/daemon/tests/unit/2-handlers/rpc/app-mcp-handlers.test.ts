import { afterEach, beforeEach, expect, mock, test } from 'bun:test';
import type { AppMcpServer, MessageHub } from '@hyperneo/shared';
import { Database as BunDatabase } from '../../../../src/storage/sqlite-compat';
import { createTables } from '../../../../src/storage/schema';
import { AppMcpServerRepository } from '../../../../src/storage/repositories/app-mcp-server-repository';
import { registerAppMcpHandlers } from '../../../../src/lib/rpc-handlers/app-mcp-handlers';
import type { InternalEventBus } from '../../../../src/lib/internal-event-bus';
import { noOpReactiveDb } from '../../../helpers/reactive-database';

type RequestHandler = (data: unknown, context?: unknown) => unknown;

let db: BunDatabase;
let appMcpServers: AppMcpServerRepository;
let handlers: Map<string, RequestHandler>;

function createMockHub(): MessageHub {
  return {
    onRequest: mock((method: string, handler: RequestHandler) => {
      handlers.set(method, handler);
      return () => handlers.delete(method);
    }),
    onEvent: mock(() => () => {}),
    onClientDisconnect: mock(() => () => {}),
  } as unknown as MessageHub;
}

beforeEach(() => {
  db = new BunDatabase(':memory:');
  createTables(db);
  appMcpServers = new AppMcpServerRepository(db, noOpReactiveDb);
  handlers = new Map();
  registerAppMcpHandlers(createMockHub(), {
    db: { appMcpServers },
    internalEventBus: {
      publish: mock(async () => {}),
      subscribe: mock(() => () => {}),
    } as unknown as InternalEventBus<never>,
  });
});
afterEach(() => db.close());

function call(method: string, data: unknown) {
  const handler = handlers.get(method);
  if (!handler) throw new Error(`handler ${method} not registered`);
  return handler(data);
}

test.each(['agent-memory', 'db-query', 'hyperneo-operations'])(
  'mcp.registry.create refuses the reserved name %s',
  async (name) => {
    await expect(
      call('mcp.registry.create', { name, sourceType: 'stdio', command: 'node' })
    ).rejects.toThrow(`"${name}" is reserved`);
    expect(appMcpServers.list()).toEqual([]);
  }
);

test('mcp.registry.create refuses a reserved name that only padding hides', async () => {
  await expect(
    call('mcp.registry.create', { name: '  agent-memory  ', sourceType: 'stdio', command: 'node' })
  ).rejects.toThrow('reserved');
  expect(appMcpServers.list()).toEqual([]);
});

test('mcp.registry.update refuses a rename onto a reserved name', async () => {
  const { server } = (await call('mcp.registry.create', {
    name: 'my-server',
    sourceType: 'stdio',
    command: 'node',
  })) as { server: AppMcpServer };

  await expect(call('mcp.registry.update', { id: server.id, name: 'db-query' })).rejects.toThrow(
    '"db-query" is reserved'
  );
  expect(appMcpServers.list()[0]?.name).toBe('my-server');
});

test('an unreserved name still creates and renames', async () => {
  const { server } = (await call('mcp.registry.create', {
    name: 'agent-memory-notes',
    sourceType: 'stdio',
    command: 'node',
  })) as { server: AppMcpServer };
  expect(server.name).toBe('agent-memory-notes');

  await call('mcp.registry.update', { id: server.id, name: 'notes' });
  expect(appMcpServers.list()[0]?.name).toBe('notes');
});
