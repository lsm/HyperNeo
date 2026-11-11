import { describe, expect, test } from 'bun:test';
import type { WorkAdapter } from '../../../../src/lib/drivers/types.ts';
import { createWorkVerbOperations } from '../../../../src/lib/drivers/work-operations.ts';
import { invokeOperation } from '../../../../src/lib/operations/invoke.ts';
import {
  createOperationRegistry,
  type OperationCaller,
} from '../../../../src/lib/operations/registry.ts';

const ref = { adapter: 'codex-desktop', id: 'synthetic-worker' };
const neo: OperationCaller = { source: 'internal', role: 'neo', sessionId: 'synthetic-neo' };

function fixture(status: string, adapterId = ref.adapter) {
  const reached: string[] = [];
  const saved: string[] = [];
  const send = async (_ref: unknown, message: string) => {
    reached.push(message);
    return { ok: true as const, value: { delivered: true } };
  };
  const adapter = {
    id: adapterId,
    capabilities: ['send', 'steer', 'queue', 'status'],
    find: () => [],
    send,
    steer: send,
    queue: send,
    status: async () => ({ ok: true, value: { ref, status, lastActivityAt: 1 } }),
  } as unknown as WorkAdapter;
  const registry = createOperationRegistry(
    createWorkVerbOperations({
      adapters: () => [adapter],
      remote: { list: () => [], invoke: async () => ({}) },
      daemonName: 'synthetic',
      queueInput: async (input) => {
        saved.push(input.message);
        return 'synthetic-input';
      },
    })
  );
  return { registry, reached, saved };
}

describe('local Neo follow-up admission', () => {
  test.each([
    ['work.send', 'running'],
    ['work.send', 'queued'],
    ['work.queue', 'running'],
  ])('%s retains the exact message for a %s worker', async (name, status) => {
    const h = fixture(status);
    const reply = await invokeOperation(
      h.registry,
      name,
      { ref, message: 'A distinct follow-up', todoId: 'synthetic-todo' },
      neo
    );
    expect(reply).toMatchObject({
      kind: 'completed',
      value: { ok: true, value: { delivered: false, inputId: 'synthetic-input' } },
    });
    expect(h.reached).toEqual([]);
    expect(h.saved).toEqual(['A distinct follow-up']);
  });

  test('a notice is retained while the worker is busy', async () => {
    const h = fixture('running');
    await invokeOperation(
      h.registry,
      'work.send',
      { ref, message: 'Retain this notice', notice: true },
      neo
    );
    expect(h.reached).toEqual([]);
    expect(h.saved).toEqual(['Retain this notice']);
  });

  test('explicit steering reaches the current turn immediately', async () => {
    const h = fixture('running');
    await invokeOperation(
      h.registry,
      'work.send',
      { ref, message: 'Correct now', todoId: 'synthetic-todo', mode: 'steer' },
      neo
    );
    expect(h.reached).toHaveLength(1);
    expect(h.saved).toEqual([]);
  });

  test('a human send reaches the existing adapter path', async () => {
    const h = fixture('running');
    await invokeOperation(
      h.registry,
      'work.send',
      { ref, message: 'Human input' },
      { source: 'rpc' }
    );
    expect(h.reached).toHaveLength(1);
    expect(h.saved).toEqual([]);
  });

  test('a Space task uses its existing send path', async () => {
    const h = fixture('running', 'space');
    await invokeOperation(
      h.registry,
      'work.send',
      { ref: { adapter: 'space', id: 'synthetic-task' }, message: 'Task input', notice: true },
      neo
    );
    expect(h.reached).toHaveLength(1);
    expect(h.saved).toEqual([]);
  });
});
