import { describe, expect, test } from 'bun:test';
import { createWorkVerbOperations } from '../../../../src/lib/drivers/work-operations.ts';
import type { WorkAdapter } from '../../../../src/lib/drivers/types.ts';
import { invokeOperation } from '../../../../src/lib/operations/invoke.ts';
import {
  createOperationRegistry,
  type OperationCaller,
} from '../../../../src/lib/operations/registry.ts';

const ref = { adapter: 'codex-desktop', id: '019f2a4e-worker' };
const neo: OperationCaller = { source: 'internal', role: 'neo', sessionId: 'root' };
const human: OperationCaller = { source: 'rpc' };

function fixture(status: string) {
  const reached: string[] = [];
  const held: unknown[] = [];
  const steer = async (_ref: unknown, message: string) => {
    reached.push(message);
    return {
      ok: true as const,
      value: { delivered: true, steeredIntoTurnId: '019f2a51-running-turn' },
    };
  };
  const adapter = {
    id: 'codex-desktop',
    capabilities: ['find', 'send', 'steer', 'queue', 'status'],
    find: () => [],
    send: steer,
    steer,
    queue: steer,
    status: async () => ({ ok: true, value: { ref, status, lastActivityAt: 1 } }),
  } as unknown as WorkAdapter;
  const registry = createOperationRegistry(
    createWorkVerbOperations({
      adapters: () => [adapter],
      remote: { list: () => [], invoke: async () => ({}) },
      daemonName: 'fixture',
      heldSends: { hold: async (send: unknown) => void held.push(send) },
    } as never)
  );
  return { registry, reached, held };
}

describe('a todo send to a busy worker waits in HyperNeo', () => {
  test.each([
    ['work.send', {}, 'running'],
    ['work.send', { mode: 'steer' }, 'running'],
    ['work.send', {}, 'queued'],
    ['work.queue', {}, 'running'],
  ] as const)('%s %j to a %s worker is held, not sent', async (name, extra, status) => {
    const { registry, reached, held } = fixture(status);
    const reply = await invokeOperation(
      registry,
      name,
      { ref, message: 'Next task', todoId: 'todo-b', idempotencyKey: 'answer-1', ...extra },
      neo
    );
    expect(reply).toMatchObject({
      kind: 'completed',
      value: { ok: true, value: { delivered: false, held: true } },
    });
    expect(reached).toEqual([]);
    expect(held).toEqual([{ key: 'answer-1', todoId: 'todo-b', ref, message: 'Next task' }]);
  });

  test.each([
    ['an idle worker', { todoId: 'todo-b' }, neo, 'done'],
    ['a notice', { notice: true }, neo, 'running'],
    ['a person', {}, human, 'running'],
  ] as const)('%s is not held', async (_name, purpose, caller, status) => {
    const { registry, reached, held } = fixture(status);
    const reply = await invokeOperation(
      registry,
      'work.send',
      { ref, message: 'Hello', ...purpose },
      caller
    );
    expect(reply).toMatchObject({ kind: 'completed', value: { ok: true } });
    expect(reached).toHaveLength(1);
    expect(reached[0]).toStartWith('Hello');
    expect(held).toEqual([]);
  });
});
