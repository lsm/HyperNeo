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
  on = false,
  adapterId = 'codex-desktop',
  queued: string = 'message'
) {
  const reached: string[] = [];
  const waiting: unknown[] = [];
  const steer = async (_ref: unknown, message: string) => {
    reached.push(message);
    return {
      ok: true as const,
      value: { delivered: true, steeredIntoTurnId: '019f2a51-running-turn' },
    };
  };
  const adapter = {
    id: adapterId,
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
      todoWorker: {
        on: () => on,
        wait: async (...args: unknown[]) => {
          waiting.push(args);
          return queued;
        },
      },
    } as never)
  );
  return { registry, reached, waiting };
}

describe('a Neo send for another todo to a busy worker', () => {
  test.each([
    ['work.send', {}, 'running'],
    ['work.send', { mode: 'steer' }, 'running'],
    ['work.send', {}, 'queued'],
    ['work.queue', {}, 'running'],
  ] as const)('%s %j to a %s worker joins the queue, unsent', async (name, extra, status) => {
    const { registry, reached, waiting } = fixture(status);
    const reply = await invokeOperation(
      registry,
      name,
      { ref, message: 'Next task', todoId: 'todo-b', ...extra },
      neo
    );
    expect(reply).toMatchObject({
      kind: 'completed',
      value: { ok: false, reason: 'worker_busy', notSent: true },
    });
    expect(reached).toEqual([]);
    expect(waiting).toEqual([['todo-b', ref, 'Next task']]);
  });

  test.each([
    ['message', 'this message goes when the worker is free; do not send it again'],
    [
      'instruction',
      'its existing instruction goes when the worker is free. Your message text was not kept',
    ],
    ['none', 'Nothing was queued or sent'],
  ])('the reply says what happened to a %s send', async (queued, detail) => {
    const { registry } = fixture('running', false, undefined, queued);
    const reply = await invokeOperation(
      registry,
      'work.send',
      { ref, message: 'Next task', todoId: 'todo-b' },
      neo
    );
    expect(JSON.stringify(reply)).toContain(detail);
    expect(reply).toMatchObject({ value: { reason: 'worker_busy', notSent: true } });
  });

  test.each([
    ['an idle worker', { todoId: 'todo-b' }, neo, 'done', false],
    ['a worker waiting for an answer', { todoId: 'todo-b' }, neo, 'needs_you', false],
    ['the todo the worker is on', { todoId: 'todo-b' }, neo, 'running', true],
    ['a notice', { notice: true }, neo, 'running', false],
    ['a person', {}, human, 'running', false],
  ] as const)('%s goes as before', async (_name, purpose, caller, status, on) => {
    const { registry, reached, waiting } = fixture(status, on);
    await invokeOperation(registry, 'work.send', { ref, message: 'Hi', ...purpose }, caller);
    expect(reached).toHaveLength(1);
    expect(waiting).toEqual([]);
  });

  test('a running Space task has no turns, so it takes the send', async () => {
    const { registry, reached } = fixture('running', false, 'space');
    await invokeOperation(
      registry,
      'work.send',
      { ref: { adapter: 'space', id: 'task-1' }, message: 'Hi', todoId: 'todo-b' },
      neo
    );
    expect(reached).toHaveLength(1);
  });
});
