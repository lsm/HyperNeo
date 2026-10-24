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
    capabilities: ['find', 'start', 'send'],
    find: () => [],
    start: async (input) => {
      delivered.push(input.message);
      return {
        ok: true,
        value: { ref, title: input.title, place, status: 'running', lastActivityAt: 1 },
      };
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
    isOpenTodo: (id: string) => id === 'open-todo',
  };
  const registry = createOperationRegistry(createWorkVerbOperations(deps));
  return { delivered, registry };
}

describe('Neo work todo reference', () => {
  for (const name of ['work.start', 'work.send'] as const) {
    const input =
      name === 'work.start'
        ? { adapter: 'fixture', place, title: 'Synthetic', message: 'New work' }
        : { ref, message: 'New work' };

    test(`${name} refuses Neo MCP work without an explicit todo before delivery`, async () => {
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
        ok: false,
        reason: 'todo_required',
      });
      expect(delivered).toEqual([]);
    });

    test(`${name} refuses an unknown or closed-ask todo`, async () => {
      for (const todoId of ['missing-todo', 'closed-ask-todo']) {
        const { registry, delivered } = fixture();
        const reply = await invokeOperation(registry, name, { ...input, todoId }, neo);
        expect(reply).toMatchObject({
          kind: 'completed',
          value: { ok: false, reason: 'todo_required' },
        });
        expect(delivered).toEqual([]);
      }
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
    });
  }
});
