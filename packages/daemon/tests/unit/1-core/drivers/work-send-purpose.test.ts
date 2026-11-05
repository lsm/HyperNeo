import { describe, expect, test } from 'bun:test';
import { createWorkVerbOperations } from '../../../../src/lib/drivers/work-operations.ts';
import type { WorkAdapter } from '../../../../src/lib/drivers/types.ts';
import { invokeOperation } from '../../../../src/lib/operations/invoke.ts';
import {
  createOperationRegistry,
  type OperationCaller,
} from '../../../../src/lib/operations/registry.ts';

const ref = { adapter: 'fixture', id: 'worker' };
const neo: OperationCaller = { source: 'mcp', role: 'neo', sessionId: 'root' };
const daemon: OperationCaller = { source: 'internal', role: 'neo' };

function fixture(workInputs?: unknown) {
  const delivered: string[] = [];
  const deliver = async (_ref: unknown, message: string) => {
    if (message === 'Throw') throw new Error('transport lost');
    delivered.push(message);
    return { ok: true as const, value: { delivered: true } };
  };
  const adapter = {
    id: 'fixture',
    capabilities: ['find', 'send', 'queue'],
    find: () => [],
    send: deliver,
    queue: deliver,
  } as unknown as WorkAdapter;
  const registry = createOperationRegistry(
    createWorkVerbOperations({
      adapters: () => [adapter],
      remote: { list: () => [], invoke: async () => ({}) },
      daemonName: 'fixture',
      workInputs,
      isOpenTodo: (id: string, owner: string) => id === 'open-todo' && owner === 'root',
    } as never)
  );
  return { delivered, registry };
}

describe('Neo and daemon sends say what they are', () => {
  test.each([
    ['work.send', neo],
    ['work.send', daemon],
    ['work.queue', neo],
  ] as const)('%s with neither a todo nor notice is refused unsent', async (name, caller) => {
    const { registry, delivered } = fixture();
    const reply = await invokeOperation(registry, name, { ref, message: 'Hello' }, caller);
    expect(reply).toMatchObject({
      kind: 'completed',
      value: { ok: false, reason: 'todo_required', notSent: true },
    });
    expect(delivered).toEqual([]);
  });

  test.each([
    [{ todoId: 'open-todo' }, neo],
    [{ todoId: 'any-todo' }, daemon],
    [{ notice: true }, neo],
    [{ notice: true }, daemon],
    [{}, { source: 'rpc' } as OperationCaller],
    [{}, { source: 'mcp', sessionId: 'worker' } as OperationCaller],
  ] as const)('%j from a caller is delivered', async (purpose, caller) => {
    const { registry, delivered } = fixture();
    const reply = await invokeOperation(
      registry,
      'work.send',
      { ref, message: 'Hello', ...purpose },
      caller
    );
    expect(reply).toMatchObject({ kind: 'completed', value: { ok: true } });
    expect(delivered).toEqual(['Hello']);
  });

  test.each([
    ['closed-or-unknown', neo],
    ['open-todo', { ...neo, sessionId: 'another-neo' }],
  ] as const)(
    'a Neo send naming %s from that session is refused unsent',
    async (todoId, caller) => {
      const { registry, delivered } = fixture();
      const reply = await invokeOperation(
        registry,
        'work.send',
        { ref, message: 'Hi', todoId },
        caller
      );
      expect(reply).toMatchObject({
        kind: 'completed',
        value: { ok: false, reason: 'todo_required', notSent: true },
      });
      expect(delivered).toEqual([]);
    }
  );

  test('a send cannot be both a notice and a todo', async () => {
    const { registry, delivered } = fixture();
    const reply = await invokeOperation(
      registry,
      'work.send',
      { ref, message: 'Hi', todoId: 'open-todo', notice: true },
      neo
    );
    expect(reply).toMatchObject({
      kind: 'completed',
      value: { ok: false, reason: 'todo_required', notSent: true },
    });
    expect(delivered).toEqual([]);
  });

  test('a refused record stops the send before it reaches the worker', async () => {
    const { delivered, registry } = fixture({
      accept: async () => {
        throw new Error('storage refused');
      },
    });
    const reply = await invokeOperation(
      registry,
      'work.send',
      { ref, message: 'Stopped', notice: true },
      daemon
    );
    expect(reply.kind).toBe('failed');
    expect(delivered).toEqual([]);
  });

  test('a Neo start is recorded with its todo and outcome', async () => {
    const recorded: unknown[] = [];
    const started = { ref, status: 'running', lastActivityAt: 1 };
    const adapter = {
      id: 'fixture',
      capabilities: ['start'],
      start: async () => ({ ok: true, value: started }),
    } as unknown as WorkAdapter;
    const registry = createOperationRegistry(
      createWorkVerbOperations({
        adapters: () => [adapter],
        remote: { list: () => [], invoke: async () => ({}) },
        daemonName: 'fixture',
        workInputs: {
          accept: async (todoId: string, _from: string, target: unknown) => {
            recorded.push(todoId, target);
            return 'input-1';
          },
          recordOutcome: async (id: string, _target: unknown, outcome: { ok: boolean }) => {
            recorded.push(id, outcome.ok);
          },
        },
      } as never)
    );
    const place = { machine: 'laptop', name: 'repo', folder: '/repo' };
    await invokeOperation(
      registry,
      'work.start',
      { adapter: 'fixture', place, title: 'Start', message: 'Go', todoId: 't' },
      daemon
    );
    expect(recorded).toEqual(['t', { verb: 'start', adapter: 'fixture', place }, 'input-1', true]);
  });

  test('an idempotency key reaches the driver and the remote daemon', async () => {
    const seen: unknown[] = [];
    const adapter = {
      id: 'fixture',
      capabilities: ['send'],
      send: async (_ref: unknown, _message: string, context: { idempotencyKey?: string }) => {
        seen.push(context.idempotencyKey);
        return { ok: true, value: { delivered: true } };
      },
    } as unknown as WorkAdapter;
    const registry = createOperationRegistry(
      createWorkVerbOperations({
        adapters: () => [adapter],
        remote: {
          list: () => [{ id: 'other' }],
          invoke: async (_daemon: string, _name: string, input: { idempotencyKey?: string }) => {
            seen.push(input.idempotencyKey);
            return { ok: true, value: { delivered: true } };
          },
        },
        daemonName: 'fixture',
      } as never)
    );
    const input = { message: 'Once', notice: true, idempotencyKey: 'key' };
    await invokeOperation(registry, 'work.send', { ...input, ref }, daemon);
    await invokeOperation(
      registry,
      'work.send',
      { ...input, ref: { ...ref, daemon: 'other' } },
      daemon
    );
    expect(seen).toEqual(['key', 'key']);
  });

  test.each(['work.send', 'work.queue'])('%s records a thrown delivery', async (name) => {
    const failed: unknown[] = [];
    const { registry } = fixture({
      accept: async () => 'input-1',
      recordOutcome: async () => {},
      recordFailure: async (id: string, error: unknown) => {
        failed.push([id, String(error)]);
      },
    });
    const reply = await invokeOperation(
      registry,
      name,
      { ref, message: 'Throw', notice: true },
      daemon
    );
    expect(reply.kind).toBe('failed');
    expect(failed).toEqual([['input-1', 'Error: transport lost']]);
  });

  test('a daemon send is recorded with its todo and its delivery outcome', async () => {
    const accepted: unknown[] = [];
    const outcomes: unknown[] = [];
    const { registry } = fixture({
      accept: async (todoId: string | null) => {
        accepted.push(todoId);
        return `input-${accepted.length}`;
      },
      recordOutcome: async (id: string, _ref: unknown, outcome: { ok: boolean }) => {
        outcomes.push([id, outcome.ok]);
      },
    });
    await invokeOperation(registry, 'work.send', { ref, message: 'Nudge', todoId: 't' }, daemon);
    await invokeOperation(registry, 'work.send', { ref, message: 'FYI', notice: true }, daemon);
    await invokeOperation(registry, 'work.send', { ref, message: 'Typed' }, { source: 'rpc' });
    expect(accepted).toEqual(['t', null]);
    expect(outcomes).toEqual([
      ['input-1', true],
      ['input-2', true],
    ]);
  });
});
