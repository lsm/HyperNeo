import { describe, expect, test } from 'bun:test';
import { createWorkVerbOperations } from '../../../../src/lib/drivers/work-operations.ts';
import type { WorkAdapter } from '../../../../src/lib/drivers/types.ts';
import { invokeOperation } from '../../../../src/lib/operations/invoke.ts';
import {
  createOperationRegistry,
  type OperationCaller,
} from '../../../../src/lib/operations/registry.ts';

const neo: OperationCaller = {
  source: 'internal',
  role: 'neo',
  sessionId: 'root',
};
const triple = { provider: 'openai', model: 'gpt-x', effort: 'high' };

function fixture(options: { configurable?: boolean; runningTodo?: boolean } = {}) {
  const configurable = options.configurable ?? true;
  const ref = {
    adapter: configurable ? 'codex-desktop' : 'claude-desktop',
    id: 'worker',
  };
  const delivered: string[] = [];
  const deliver = async (_ref: unknown, message: string) => {
    delivered.push(message);
    return { ok: true as const, value: { delivered: true } };
  };
  const adapter = {
    id: ref.adapter,
    capabilities: ['find', 'send', 'queue', 'status'],
    identity: { fixedProvider: 'openai', configurable },
    find: () => [],
    send: deliver,
    queue: deliver,
    status: async () => ({
      ok: true,
      value: {
        ref,
        status: 'done',
        lastActivityAt: 1,
        ...(configurable ? { model: 'gpt-x', effort: 'high' } : {}),
      },
    }),
  } as unknown as WorkAdapter;
  const registry = createOperationRegistry(
    createWorkVerbOperations({
      adapters: () => [adapter],
      remote: { list: () => [], invoke: async () => ({}) },
      daemonName: 'fixture',
      acceptedTodo: () => true,
      isOpenTodo: () => true,
      noticeReply: () => true,
      startedIdentity: async () => (configurable ? null : triple),
      todoWorker: {
        on: () => options.runningTodo ?? false,
        wait: async () => 'none',
      },
    } as never)
  );
  const send = (name: string, extra: object) =>
    invokeOperation(registry, name, { ref, message: 'Do it', ...extra }, neo);
  return { delivered, send };
}

describe('work.send and work.queue new todo identity', () => {
  test.each(['work.send', 'work.queue'])(
    '%s refuses new todo work without the triple and sends nothing',
    async (name) => {
      const h = fixture();
      expect(await h.send(name, { todoId: 'todo' })).toMatchObject({
        kind: 'completed',
        value: {
          ok: false,
          reason: 'identity_required',
          detail: expect.stringContaining('missing: model, effort'),
          notSent: true,
        },
      });
      expect(h.delivered).toEqual([]);
    }
  );

  test.each(['work.send', 'work.queue'])(
    '%s delivers new todo work when the worker runs the requested triple',
    async (name) => {
      const h = fixture();
      expect(await h.send(name, { todoId: 'todo', ...triple })).toMatchObject({
        kind: 'completed',
        value: { ok: true },
      });
      expect(h.delivered).toHaveLength(1);
    }
  );

  test('refuses a worker that runs another effort', async () => {
    const h = fixture();
    expect(await h.send('work.send', { todoId: 'todo', ...triple, effort: 'low' })).toMatchObject({
      kind: 'completed',
      value: {
        ok: false,
        reason: 'identity_required',
        detail: expect.stringContaining('start a fresh worker'),
        notSent: true,
      },
    });
    expect(h.delivered).toEqual([]);
  });

  test('matches a non-configurable worker on its recorded requested triple', async () => {
    const h = fixture({ configurable: false });
    expect(await h.send('work.send', { todoId: 'todo', ...triple })).toMatchObject({
      kind: 'completed',
      value: { ok: true },
    });
    expect(await h.send('work.send', { todoId: 'todo', ...triple, model: 'other' })).toMatchObject({
      kind: 'completed',
      value: { ok: false, reason: 'identity_required' },
    });
    expect(h.delivered).toHaveLength(1);
  });

  test('a continuation of the todo the worker already runs needs no triple', async () => {
    const h = fixture({ runningTodo: true });
    expect(await h.send('work.send', { todoId: 'todo' })).toMatchObject({
      kind: 'completed',
      value: { ok: true },
    });
    expect(h.delivered).toHaveLength(1);
  });

  test('a notice reply needs no triple', async () => {
    const h = fixture();
    expect(await h.send('work.send', { notice: true })).toMatchObject({
      kind: 'completed',
      value: { ok: true },
    });
    expect(h.delivered).toHaveLength(1);
  });
});
