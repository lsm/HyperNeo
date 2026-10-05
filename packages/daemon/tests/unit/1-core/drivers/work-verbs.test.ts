import { describe, expect, test } from 'bun:test';
import { createWorkVerbOperations } from '../../../../src/lib/drivers/work-operations';
import type { WorkAdapter, WorkSummary } from '../../../../src/lib/drivers/types';
import {
  createOperationRegistry,
  type OperationCaller,
} from '../../../../src/lib/operations/registry';
import { invokeOperation } from '../../../../src/lib/operations/invoke';

const place = { machine: 'imac', folder: '/focus/dolmen', name: 'dolmen' };

function summary(adapter: string, id: string): WorkSummary {
  return {
    ref: { adapter, id },
    title: 'loader',
    place,
    status: 'running',
    lastActivityAt: 1,
  };
}

let origin = 'chat';

const hyperneo: WorkAdapter = {
  id: 'hyperneo',
  capabilities: ['find', 'start', 'send', 'status', 'stop'],
  find: () => [],
  start: async (request) => ({
    ok: true,
    value: { ...summary('hyperneo', 's1'), title: request.title },
  }),
  send: async (ref, _message, context) =>
    ref.id === 'gone' || context.from !== origin
      ? { ok: false, reason: 'not_open', detail: 'archived' }
      : { ok: true, value: { delivered: true } },
  status: async (ref) => ({
    ok: true,
    value: { ...summary('hyperneo', ref.id), lastReply: 'done' },
  }),
  stop: async () => ({ ok: true, value: { stopped: true } }),
};

const desktop: WorkAdapter = {
  id: 'claude-desktop',
  capabilities: ['find', 'send'],
  find: () => [],
  send: async () => ({ ok: true, value: { delivered: false } }),
};

type Invoke = (daemonId: string, name: string, input: unknown) => Promise<unknown>;

async function call(
  name: string,
  input: unknown,
  invoke: Invoke = async () => ({}),
  caller: OperationCaller = { source: 'rpc' }
) {
  const registry = createOperationRegistry(
    createWorkVerbOperations({
      adapters: () => [hyperneo, desktop],
      remote: { list: () => [{ daemonId: 'laptop' }], invoke },
    })
  );
  const outcome = await invokeOperation(registry, name, input, caller);
  if (outcome.kind !== 'completed') throw new Error(outcome.message);
  return outcome.value;
}

describe('work verb operations', () => {
  test('runs each verb on the adapter named by the ref', async () => {
    expect(
      await call('work.send', { ref: { adapter: 'hyperneo', id: 's1' }, message: 'hi' })
    ).toEqual({
      ok: true,
      value: { delivered: true },
    });
    expect(await call('work.status', { ref: { adapter: 'hyperneo', id: 's1' } })).toMatchObject({
      ok: true,
      value: { ref: { id: 's1' }, lastReply: 'done' },
    });
    expect(await call('work.stop', { ref: { adapter: 'hyperneo', id: 's1' } })).toEqual({
      ok: true,
      value: { stopped: true },
    });
    expect(
      await call('work.start', { adapter: 'hyperneo', place, title: 'font size', message: 'go' })
    ).toMatchObject({ ok: true, value: { title: 'font size' } });
  });

  test('tells the adapter who is sending', async () => {
    origin = 'session:neo%3Aroot';
    expect(
      await call(
        'work.send',
        { ref: { adapter: 'hyperneo', id: 's1' }, message: 'hi' },
        undefined,
        { source: 'mcp', sessionId: 'neo:root' }
      )
    ).toEqual({ ok: true, value: { delivered: true } });
    origin = 'chat';
  });

  test('passes the adapter rejection through', async () => {
    expect(
      await call('work.send', { ref: { adapter: 'hyperneo', id: 'gone' }, message: 'hi' })
    ).toEqual({ ok: false, reason: 'not_open', detail: 'archived' });
  });

  test('rejects an adapter that is not registered or does not declare the verb', async () => {
    expect(await call('work.status', { ref: { adapter: 'oap', id: 'x' } })).toMatchObject({
      ok: false,
      reason: 'unknown_adapter',
    });
    expect(await call('work.stop', { ref: { adapter: 'claude-desktop', id: 'x' } })).toMatchObject({
      ok: false,
      reason: 'unsupported',
    });
  });

  test('forwards a ref with a daemon to that daemon and stamps what comes back', async () => {
    const calls: unknown[] = [];
    const result = await call(
      'work.status',
      { ref: { adapter: 'codex-desktop', daemon: 'laptop', id: 't1' } },
      async (daemonId, name, input) => {
        calls.push({ daemonId, name, input });
        return { ok: true, value: summary('codex-desktop', 't1') };
      }
    );
    expect(calls).toEqual([
      {
        daemonId: 'laptop',
        name: 'work.status',
        input: { ref: { adapter: 'codex-desktop', id: 't1' } },
      },
    ]);
    expect(result).toMatchObject({
      ok: true,
      value: { ref: { daemon: 'laptop' }, place: { daemon: 'laptop' } },
    });
  });

  test('starts work on the daemon that owns the place', async () => {
    const calls: unknown[] = [];
    await call(
      'work.start',
      { adapter: 'codex-desktop', place: { ...place, daemon: 'laptop' }, title: 't', message: 'm' },
      async (daemonId, name, input) => {
        calls.push({ daemonId, name, input });
        return { ok: true, value: summary('codex-desktop', 't2') };
      }
    );
    expect(calls).toEqual([
      {
        daemonId: 'laptop',
        name: 'work.start',
        input: { adapter: 'codex-desktop', place, title: 't', message: 'm' },
      },
    ]);
  });

  test('reports a daemon that fails or answers with something unusable as unreachable', async () => {
    const ref = { adapter: 'codex-desktop', daemon: 'laptop', id: 't1' };
    expect(
      await call('work.stop', { ref }, async () => {
        throw new Error('No attached daemon: laptop');
      })
    ).toEqual({ ok: false, reason: 'unreachable', detail: 'No attached daemon: laptop' });
    expect(await call('work.send', { ref, message: 'hi' }, async () => ({ nope: 1 }))).toEqual({
      ok: false,
      reason: 'unreachable',
      detail: 'laptop sent an unusable reply.',
    });
  });
});
