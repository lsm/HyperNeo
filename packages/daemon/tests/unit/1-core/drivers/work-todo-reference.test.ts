import { describe, expect, test } from 'bun:test';
import { createWorkVerbOperations } from '../../../../src/lib/drivers/work-operations.ts';
import type { WorkAdapter } from '../../../../src/lib/drivers/types.ts';
import { createOperationMcpHandler } from '../../../../src/lib/operations/mcp-adapter.ts';
import { invokeOperation } from '../../../../src/lib/operations/invoke.ts';
import {
  createOperationRegistry,
  type OperationCaller,
} from '../../../../src/lib/operations/registry.ts';

const place = { machine: 'fixture', folder: '/synthetic', name: 'Synthetic' };
const ref = { adapter: 'fixture', id: 'worker' };
const neo: OperationCaller = { source: 'mcp', role: 'neo', sessionId: 'root' };

function fixture() {
  const delivered: string[] = [];
  const adapter: WorkAdapter = {
    id: 'fixture',
    capabilities: ['find', 'start', 'send', 'queue'],
    find: () => [],
    start: async (input) => {
      delivered.push(input.message);
      return {
        ok: true,
        value: { ref, title: input.title, place, status: 'running', lastActivityAt: 1 },
      };
    },
    queue: async (_ref, message) => {
      delivered.push(message);
      return { ok: true, value: { delivered: true } };
    },
    send: async (_ref, message) => {
      delivered.push(message);
      return { ok: true, value: { delivered: true } };
    },
  };
  const deps = {
    adapters: () => [adapter],
    remote: { list: () => [], invoke: async () => ({}) },
    daemonName: 'fixture',
    isOpenTodo: (id: string, owner?: string) =>
      ['open-todo', 'foreign-todo'].includes(id) &&
      (!owner || owner === (id === 'open-todo' ? 'root' : 'another-root')),
  };
  const registry = createOperationRegistry(createWorkVerbOperations(deps));
  return { delivered, registry, adapter, deps };
}

describe('Neo work todo reference', () => {
  for (const name of ['work.start', 'work.send', 'work.queue'] as const) {
    const input =
      name === 'work.start'
        ? { adapter: 'fixture', place, title: 'Synthetic', message: 'New work' }
        : { ref, message: 'New work' };

    test(`${name} records a missing Neo MCP todo reference without blocking delivery`, async () => {
      const { registry, delivered } = fixture();
      const call = createOperationMcpHandler(registry, () => neo);
      const reply = await call({
        name,
        input: {
          ...input,
          message: 'todoId open-todo in prose is not a reference',
          source: 'internal',
        },
      });
      expect(JSON.parse(reply.content[0].text)).toMatchObject({
        ok: true,
        records: [expect.stringContaining('todo_required:')],
      });
      expect(reply.content[0].text).not.toContain('neo.todo.start');
      expect(delivered).toHaveLength(1);
    });

    test(`${name} records an unknown, closed-ask or foreign todo`, async () => {
      for (const todoId of ['missing-todo', 'closed-ask-todo', 'foreign-todo']) {
        const { registry, delivered } = fixture();
        const reply = await invokeOperation(registry, name, { ...input, todoId }, neo);
        expect(reply).toMatchObject({
          kind: 'completed',
          value: { ok: true, records: [expect.stringContaining('todo_required:')] },
        });
        expect(delivered).toHaveLength(1);
      }
    });

    test(`${name} records a missing todo on a Neo RPC call`, async () => {
      const { registry, delivered } = fixture();
      expect(await invokeOperation(registry, name, input, { ...neo, source: 'rpc' })).toMatchObject(
        {
          kind: 'completed',
          value: { ok: true, records: [expect.stringContaining('todo_required:')] },
        }
      );
      expect(delivered).toHaveLength(1);
    });

    test(`${name} accepts an open-ask reference and trusted internal dispatch`, async () => {
      const { registry, delivered } = fixture();
      for (const [caller, request] of [
        [neo, { ...input, todoId: 'open-todo' }],
        [{ ...neo, source: 'internal' }, input],
        [{ source: 'rpc' }, input],
      ] as const) {
        expect(await invokeOperation(registry, name, request, caller)).toMatchObject({
          kind: 'completed',
          value: { ok: true },
        });
      }
      expect(delivered).toHaveLength(3);
      const tracked = await invokeOperation(registry, name, { ...input, todoId: 'open-todo' }, neo);
      expect(tracked.kind === 'completed' && tracked.value).not.toHaveProperty('records');
    });
  }
  test.each(['steer', 'queue'] as const)(
    'work.send mode %s records a missing todo',
    async (mode) => {
      const { registry, adapter, delivered } = fixture();
      adapter.capabilities.push('steer');
      adapter.steer = adapter.send;
      const reply = await invokeOperation(
        registry,
        'work.send',
        { ref, message: 'Follow-up', mode },
        neo
      );
      expect(reply).toMatchObject({
        kind: 'completed',
        value: { ok: true, records: [expect.stringContaining('todo_required:')] },
      });
      expect(delivered).toEqual(['Follow-up']);
    }
  );

  test('a missing todo does not hide an unsupported delivery route', async () => {
    const { registry, delivered } = fixture();
    const reply = await invokeOperation(
      registry,
      'work.send',
      { ref, message: 'Follow-up', mode: 'steer' },
      neo
    );
    expect(reply).toMatchObject({ kind: 'completed', value: { ok: false, reason: 'unsupported' } });
    expect(delivered).toEqual([]);
  });

  test('remote records survive forwarding alongside the local bookkeeping record', async () => {
    const { deps } = fixture();
    const registry = createOperationRegistry(
      createWorkVerbOperations({
        ...deps,
        remote: {
          list: () => [],
          invoke: async () => ({
            ok: true,
            value: { delivered: false, queuedSubmissionId: 'queued' },
            records: ['remote_note: retained'],
          }),
        },
      })
    );
    const reply = await invokeOperation(
      registry,
      'work.send',
      { ref: { ...ref, daemon: 'remote' }, message: 'Follow-up' },
      neo
    );
    expect(reply).toMatchObject({
      kind: 'completed',
      value: {
        ok: true,
        value: { delivered: false, queuedSubmissionId: 'queued' },
        records: ['remote_note: retained', expect.stringContaining('todo_required:')],
      },
    });
  });
});
