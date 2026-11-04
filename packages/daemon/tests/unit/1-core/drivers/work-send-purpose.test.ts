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

function fixture(sendInputs?: unknown) {
  const delivered: string[] = [];
  const deliver = async (_ref: unknown, message: string) => {
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
      sendInputs,
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
    [{ todoId: 'any-todo' }, neo],
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

  test('a daemon send is recorded with its todo and its delivery outcome', async () => {
    const accepted: unknown[] = [];
    const outcomes: unknown[] = [];
    const { registry } = fixture({
      accept: async (input: { todoId?: string }) => {
        accepted.push(input.todoId ?? null);
        return `input-${accepted.length}`;
      },
      recordOutcome: async (id: string, _ref: unknown, outcome: { ok: boolean }) => {
        outcomes.push([id, outcome.ok]);
      },
    });
    await invokeOperation(registry, 'work.send', { ref, message: 'Nudge', todoId: 't' }, daemon);
    await invokeOperation(registry, 'work.send', { ref, message: 'FYI', notice: true }, daemon);
    await invokeOperation(registry, 'work.send', { ref, message: 'Typed' }, { source: 'rpc' });
    await invokeOperation(
      registry,
      'work.send',
      { ref, message: 'Dispatched' },
      { ...daemon, inputRecorded: true }
    );
    expect(accepted).toEqual(['t', null]);
    expect(outcomes).toEqual([
      ['input-1', true],
      ['input-2', true],
    ]);
  });
});
