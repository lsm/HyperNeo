import { expect, test } from 'bun:test';
import { createMemoryOperations } from '../../../../src/lib/neo/memory-operations.ts';
import { invokeOperation } from '../../../../src/lib/operations/invoke.ts';
import {
  createOperationRegistry,
  type OperationCaller,
} from '../../../../src/lib/operations/registry.ts';
import { NeoMemoryRepository } from '../../../../src/storage/repositories/neo-memory-repository.ts';
import { runMigration542 } from '../../../../src/storage/schema/m542-neo-memories.ts';
import { runMigration543 } from '../../../../src/storage/schema/m543-neo-memory-vectors.ts';
import { Database } from '../../../../src/storage/sqlite-compat.ts';
import { gatewayFor } from '../../../../src/storage/db-gateway/db-gateway.ts';

test('allows Neo and denies MCP/RPC workers via invokeOperation', async () => {
  const db = new Database(':memory:');
  runMigration542(db);
  runMigration543(db);
  const registry = createOperationRegistry(
    createMemoryOperations(
      new NeoMemoryRepository(gatewayFor(db)),
      (sessionId) => sessionId === 'neo:root'
    )
  );
  const call = (name: string, input: unknown, caller: OperationCaller) =>
    invokeOperation(registry, `memory.${name}`, input, caller);
  const neo: OperationCaller = { source: 'mcp', role: 'neo', sessionId: 'neo:root' };
  const human: OperationCaller = { source: 'rpc', principal: 'local' };
  const workers: OperationCaller[] = [
    { source: 'mcp', role: 'direct_task_worker', sessionId: 'worker-1' },
    { source: 'mcp', role: 'neo', sessionId: 'worker-1' },
    { source: 'mcp', role: 'universal_read', sessionId: 'worker-1' },
    { source: 'rpc', principal: 'agent', sessionId: 'worker-1' },
  ];
  const saved = { key: 'tz', content: 'Tell the human times in US Eastern.' };
  const denied = {
    kind: 'completed',
    value: { ok: false, reason: 'memory_not_authorized' },
  } as const;

  expect(await call('save', saved, neo)).toEqual({
    kind: 'completed',
    value: { ok: true, key: 'tz' },
  });
  expect(
    await call('save', saved, { source: 'internal', role: 'neo', sessionId: 'neo:root' })
  ).toMatchObject({ value: { ok: true } });
  for (const caller of [neo, human]) {
    expect(await call('search', { query: 'eastern times' }, caller)).toMatchObject({
      value: { ok: true, memories: [{ key: 'tz', content: saved.content }] },
    });
    expect(await call('read', { key: 'tz' }, caller)).toMatchObject({
      value: { ok: true, memory: { key: 'tz', content: saved.content } },
    });
  }
  expect(await call('save', saved, human)).toEqual(denied);
  expect(await call('delete', { key: 'tz' }, human)).toEqual(denied);
  for (const caller of workers) {
    expect(await call('save', { key: 'w', content: 'worker note' }, caller)).toEqual(denied);
    expect(await call('search', { query: 'eastern' }, caller)).toEqual(denied);
    expect(await call('read', { key: 'tz' }, caller)).toEqual(denied);
    expect(await call('delete', { key: 'tz' }, caller)).toEqual(denied);
  }
  expect(await call('delete', { key: 'tz' }, neo)).toEqual({
    kind: 'completed',
    value: { ok: true, deleted: true },
  });
  expect(await call('read', { key: 'tz' }, neo)).toEqual({
    kind: 'completed',
    value: { ok: true, memory: null },
  });
});
