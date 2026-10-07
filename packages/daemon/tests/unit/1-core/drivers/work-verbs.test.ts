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

type Invoke = (
  daemonId: string,
  name: string,
  input: unknown,
  options?: { timeoutMs?: number }
) => Promise<unknown>;

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
      daemonName: 'imac',
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

  test('carries the sender to another daemon and honors it only from the RPC door', async () => {
    const forwarded: unknown[] = [];
    await call(
      'work.send',
      { ref: { adapter: 'hyperneo', daemon: 'laptop', id: 's9' }, message: 'hi' },
      async (_daemonId, _name, input) => {
        forwarded.push(input);
        return { ok: true, value: { delivered: true } };
      },
      { source: 'mcp', sessionId: 'neo:root', role: 'neo' }
    );
    expect(forwarded).toEqual([
      {
        ref: { adapter: 'hyperneo', id: 's9' },
        message: 'hi',
        from: 'daemon:imac::session:neo%3Aroot',
      },
    ]);
    origin = 'session:neo%3Aroot';
    const relayed = { ref: { adapter: 'hyperneo', id: 's1' }, message: 'hi', from: origin };
    expect(await call('work.send', relayed)).toEqual({ ok: true, value: { delivered: true } });
    origin = 'chat';
    expect(await call('work.send', { ...relayed, from: 'not an address' })).toEqual({
      ok: true,
      value: { delivered: true },
    });
    expect(
      await call('work.send', { ...relayed, from: 'chat' }, undefined, {
        source: 'mcp',
        sessionId: 'agent-1',
      })
    ).toMatchObject({ ok: false, reason: 'not_open' });
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
        input: { adapter: 'codex-desktop', place, title: 't', message: 'm', from: 'chat' },
      },
    ]);
  });

  test('gives a remote start time to create its session and warns it may have started', async () => {
    const timeouts: unknown[] = [];
    const result = await call(
      'work.start',
      { adapter: 'hyperneo', place: { ...place, daemon: 'laptop' }, title: 't', message: 'm' },
      async (_daemonId, _name, _input, options) => {
        timeouts.push(options);
        throw new Error('Request timeout');
      }
    );
    expect(timeouts).toEqual([{ timeoutMs: 360_000 }]);
    expect(result).toMatchObject({ ok: false, reason: 'unreachable' });
    expect((result as { detail: string }).detail).toContain(
      'check work.find before starting it again'
    );
  });

  test('gives a remote send time to relay and warns it may have been delivered', async () => {
    const timeouts: unknown[] = [];
    const result = await call(
      'work.send',
      { ref: { adapter: 'claude-desktop', id: 's1', daemon: 'laptop' }, message: 'm' },
      async (_daemonId, _name, _input, options) => {
        timeouts.push(options);
        throw new Error('Request timeout');
      }
    );
    expect(timeouts).toEqual([{ timeoutMs: 180_000 }]);
    expect(result).toMatchObject({ ok: false, reason: 'unreachable' });
    expect((result as { detail: string }).detail).toContain(
      'check work.status before sending it again'
    );
  });

  test('lets only Neo or the user change work on another daemon', async () => {
    let forwarded = 0;
    const invoke = async () => {
      forwarded++;
      return { ok: true, value: { stopped: true } };
    };
    const ref = { adapter: 'space', daemon: 'laptop', id: 't1' };
    expect(
      await call('work.stop', { ref }, invoke, {
        source: 'mcp',
        sessionId: 'w1',
        role: 'workflow_worker',
      })
    ).toMatchObject({ ok: false, reason: 'unsupported' });
    expect(
      await call('work.stop', { ref }, invoke, {
        source: 'mcp',
        sessionId: 'neo:root',
        role: 'neo',
      })
    ).toEqual({ ok: true, value: { stopped: true } });
    expect(await call('work.stop', { ref }, invoke)).toEqual({
      ok: true,
      value: { stopped: true },
    });
    expect(forwarded).toBe(2);
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
      detail:
        'laptop sent an unusable reply. The message may still have been delivered; check work.status before sending it again.',
    });
  });
});
