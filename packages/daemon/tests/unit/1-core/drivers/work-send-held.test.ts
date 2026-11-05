import { describe, expect, test } from 'bun:test';
import type { WorkAdapter } from '../../../../src/lib/drivers/types.ts';
import { createWorkVerbOperations } from '../../../../src/lib/drivers/work-operations.ts';
import { invokeOperation } from '../../../../src/lib/operations/invoke.ts';
import {
  createOperationRegistry,
  type OperationCaller,
} from '../../../../src/lib/operations/registry.ts';

const ref = { adapter: 'codex-desktop', id: '019f2a4e-worker' };
const neo: OperationCaller = { source: 'internal', role: 'neo', sessionId: 'root' };
const human: OperationCaller = { source: 'rpc' };

function fixture(
  status: string,
  statusReply?: unknown,
  adapterId = 'codex-desktop',
  capabilities = ['find', 'send', 'steer', 'queue', 'status', 'withdraw'],
  sending: Promise<void> = Promise.resolve()
) {
  const reached: string[] = [];
  let delivery: object = { delivered: true, steeredIntoTurnId: '019f2a51-running-turn' };
  let activity = 1;
  const held: unknown[] = [];
  const steer = async (_ref: unknown, message: string) => {
    reached.push(message);
    await sending;
    return {
      ok: true as const,
      value: delivery,
    };
  };
  const adapter = {
    id: adapterId,
    capabilities,
    find: () => [],
    send: steer,
    steer,
    queue: steer,
    status: async () =>
      statusReply ?? { ok: true, value: { ref, status, lastActivityAt: activity } },
    withdraw: async () => ({ ok: true, value: { queuedSubmissionId: 'q', withdrawn: true } }),
  } as unknown as WorkAdapter;
  const registry = createOperationRegistry(
    createWorkVerbOperations({
      adapters: () => [adapter],
      remote: { list: () => [], invoke: async () => ({}) },
      daemonName: 'fixture',
      heldSends: { hold: async (send: unknown) => void held.push(send) },
    } as never)
  );
  return {
    registry,
    reached,
    held,
    setDelivery: (value: object) => {
      delivery = value;
    },
    setActivity: (value: number) => {
      activity = value;
    },
  };
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

  test('a running Space task has no turns to wait for, so a todo send reaches it', async () => {
    const { registry, reached, held } = fixture('running', undefined, 'space');
    await invokeOperation(
      registry,
      'work.send',
      { ref: { adapter: 'space', id: 'task-1' }, message: 'Next task', todoId: 'todo-b' },
      neo
    );
    expect(reached).toHaveLength(1);
    expect(reached[0]).toStartWith('Next task');
    expect(held).toEqual([]);
  });

  test('a refused send to a busy worker stays refused, not held', async () => {
    const { registry, reached, held } = fixture('running');
    const reply = await invokeOperation(
      registry,
      'work.send',
      { ref, message: 'Next task', todoId: 'todo-b', notice: true },
      neo
    );
    expect(reply).toMatchObject({
      kind: 'completed',
      value: { ok: false, reason: 'todo_required', notSent: true },
    });
    expect(reached).toEqual([]);
    expect(held).toEqual([]);
  });

  test('an adapter with no status gets no todo send', async () => {
    const { registry, reached, held } = fixture('running', undefined, 'codex-desktop', ['send']);
    const reply = await invokeOperation(
      registry,
      'work.send',
      { ref, message: 'Next task', todoId: 'todo-b' },
      neo
    );
    expect(reply).toMatchObject({
      kind: 'completed',
      value: { ok: false, reason: 'unsupported', notSent: true },
    });
    expect(reached).toEqual([]);
    expect(held).toEqual([]);
  });

  test('a todo send in flight holds the next one to that worker', async () => {
    let finish = () => {};
    const sending = new Promise<void>((resolve) => {
      finish = resolve;
    });
    const { registry, reached, held } = fixture('done', undefined, undefined, undefined, sending);
    const send = (todoId: string) =>
      invokeOperation(registry, 'work.send', { ref, message: todoId, todoId }, neo);
    const first = send('todo-a');
    const second = await send('todo-b');
    finish();
    await first;
    expect(second).toMatchObject({ value: { ok: true, value: { held: true } } });
    expect(held).toHaveLength(1);
    await send('todo-c');
    expect(reached).toHaveLength(2);
    expect(reached[0]).toStartWith('todo-a');
    expect(reached[1]).toStartWith('todo-c');
  });

  test('a send the worker only queued fences it until the worker moves', async () => {
    const { registry, reached, held, setDelivery, setActivity } = fixture('done');
    const send = (todoId: string) =>
      invokeOperation(registry, 'work.send', { ref, message: todoId, todoId }, neo);
    setDelivery({ delivered: false, queuedSubmissionId: 'q' });
    await send('todo-a');
    expect(await send('todo-b')).toMatchObject({ value: { value: { held: true } } });
    expect(held).toHaveLength(1);
    setActivity(2);
    setDelivery({ delivered: true });
    await send('todo-c');
    expect(reached).toHaveLength(2);
    expect(reached[1]).toStartWith('todo-c');
  });

  test('withdrawing the queued send lifts the fence', async () => {
    const { registry, reached, setDelivery } = fixture('done');
    const send = (todoId: string) =>
      invokeOperation(registry, 'work.send', { ref, message: todoId, todoId }, neo);
    setDelivery({ delivered: false, queuedSubmissionId: 'q' });
    await send('todo-a');
    await invokeOperation(registry, 'work.withdraw', { ref, queuedSubmissionId: 'q' }, neo);
    setDelivery({ delivered: true });
    await send('todo-b');
    expect(reached).toHaveLength(2);
  });

  test('a worker whose status cannot be read gets no todo send', async () => {
    const { registry, reached, held } = fixture('running', {
      ok: false,
      reason: 'unreachable',
      detail: 'status timed out',
    });
    const reply = await invokeOperation(
      registry,
      'work.send',
      { ref, message: 'Next task', todoId: 'todo-b' },
      neo
    );
    expect(reply).toMatchObject({
      kind: 'completed',
      value: { ok: false, reason: 'unreachable', notSent: true },
    });
    expect(reached).toEqual([]);
    expect(held).toEqual([]);
  });

  test.each([
    ['an idle worker', { todoId: 'todo-b' }, neo, 'done'],
    ['a worker waiting for its answer', { todoId: 'todo-b' }, neo, 'needs_you'],
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
