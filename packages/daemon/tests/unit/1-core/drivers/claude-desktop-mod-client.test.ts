import { describe, expect, test } from 'bun:test';
import { register } from '../../../../claude-desktop-bridge/hooks/register';

type On = Parameters<typeof register>[0];
type Hook = Parameters<On>[1];
type API = Parameters<Hook>[0];
type Data = Record<string, unknown>;
const flush = async () => {
  for (let i = 0; i < 20; i++) await Promise.resolve();
};

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

function host(options: Data = { enabled: true, connectionFile: '/private/bridge.json' }) {
  const hooks = new Map<string, Hook>();
  const requests: Data[] = [];
  const aborts: string[] = [];
  const submissions: string[] = [];
  let sessionId = 'session-a';
  let tick: () => void = () => {};
  let cancellations = 0;
  let reads = 0;
  let config = JSON.stringify({ socketPath: '/private/bridge.sock', token: 'x'.repeat(32) });
  let reply: (body: Data) => Promise<{ ok: boolean; text: string }> = async () => ({
    ok: true,
    text: '{"ack":0}',
  });
  let submit: () => Promise<unknown> = async () => ({});
  let abort: () => Promise<unknown> = async () => ({});
  const api: API = {
    fs: {
      read: async (path) => {
        expect(path).toBe('/private/bridge.json');
        reads++;
        return config;
      },
    },
    session: { id: async () => sessionId },
    clock: {
      now: async () => 1234,
      every: (ms, fn) => {
        expect(ms).toBe(250);
        tick = fn;
        return { cancel: () => cancellations++ };
      },
    },
    http: {
      fetch: async (url, init) => {
        expect(url).toBe('http://hyperneo/bridge/exchange');
        expect(init.socketPath).toBe('/private/bridge.sock');
        expect(init.method).toBe('POST');
        expect(init.headers.authorization).toBe(`Bearer ${'x'.repeat(32)}`);
        const body = JSON.parse(init.body) as Data;
        requests.push(body);
        return reply(body);
      },
    },
    turn: {
      abort: async ({ turnId }) => {
        aborts.push(turnId);
        return abort();
      },
    },
    prompt: {
      submit: async (args) => {
        expect(Object.keys(args)).toEqual(['text']);
        submissions.push(args.text);
        return submit();
      },
    },
  };
  register((event, hook) => void hooks.set(event, hook), options);
  const emit = async (kind: string, event: Data = {}) => {
    let passed = false;
    await hooks.get(kind)?.(api, event, async (value) => {
      expect(value).toBe(event);
      passed = true;
    });
    if (hooks.has(kind)) expect(passed).toBe(true);
  };
  return {
    hooks,
    requests,
    aborts,
    submissions,
    emit,
    tick: async () => {
      tick();
      await flush();
    },
    config: (value: string) => {
      config = value;
    },
    session: (id: string) => {
      sessionId = id;
    },
    reply: (fn: typeof reply) => {
      reply = fn;
    },
    submit: (fn: typeof submit) => {
      submit = fn;
    },
    abort: (fn: typeof abort) => {
      abort = fn;
    },
    reads: () => reads,
    cancellations: () => cancellations,
  };
}

function commandReply(body: Data, command: Data, ack = 0) {
  return {
    ok: true,
    text: JSON.stringify({ ack, command: { instanceId: body.instanceId, ...command } }),
  };
}

describe('Claude Desktop mods client', () => {
  test.each([
    {},
    { enabled: false },
    { enabled: 'true' },
    { enabled: true },
    { enabled: true, connectionFile: 'relative' },
  ])('does nothing without explicit opt-in and an absolute config path: %j', async (options) => {
    const h = host(options);
    await h.emit('session.start');
    await h.tick();
    expect(h.hooks.size).toBe(0);
    expect(h.reads()).toBe(0);
    expect(h.requests).toEqual([]);
  });

  test.each([
    'null',
    '{}',
    '{',
    JSON.stringify({ socketPath: 'http://host', token: 'x'.repeat(32) }),
    JSON.stringify({ socketPath: '/private/bridge.sock', token: 'short' }),
  ])('passes session startup through without connecting on invalid config: %s', async (config) => {
    const h = host();
    h.config(config);
    await h.emit('session.start');
    await h.tick();
    expect(h.reads()).toBe(2);
    expect(h.requests).toEqual([]);
  });

  test('recovers from missing startup configuration without losing observed turns', async () => {
    const h = host();
    h.config('{}');
    await h.emit('session.start');
    await h.emit('turn.start', { turnId: 'observed-while-offline' });
    h.config(JSON.stringify({ socketPath: '/private/bridge.sock', token: 'x'.repeat(32) }));
    await h.tick();
    expect(h.requests.at(-1)!.events).toEqual([
      { sequence: 1, kind: 'session.start' },
      { sequence: 2, kind: 'turn.start', turnId: 'observed-while-offline' },
    ]);
  });

  test.each(['http', 'network'])(
    'rereads connection after %s failure while retaining dedup and unacked receipts',
    async (failure) => {
      const h = host();
      const command = { id: 'input-1', kind: 'submit', from: 'peer', text: 'once' };
      h.reply(async (body) => commandReply(body, command, 1));
      await h.emit('session.start');
      await flush();
      const instance = h.requests[0].instanceId;
      h.reply(async () => {
        if (failure === 'network') throw new Error('daemon stopped');
        return { ok: false, text: '' };
      });
      await h.tick();
      const retained = h.requests.at(-1)!.events;
      h.config('{}');
      const attempts = h.requests.length;
      await h.tick();
      expect(h.requests).toHaveLength(attempts);
      h.config(JSON.stringify({ socketPath: '/private/bridge.sock', token: 'x'.repeat(32) }));
      h.reply(async (body) => commandReply(body, command, 1));
      await h.tick();
      expect(h.requests.at(-1)!.instanceId).toBe(instance);
      expect(h.requests.at(-1)!.events).toEqual(retained);
      expect(h.submissions).toHaveLength(1);
      expect(h.reads()).toBe(3);
    }
  );

  test('retains session and turn facts until the server acknowledges the sent sequence', async () => {
    const h = host();
    await h.emit('session.start');
    await h.emit('turn.start', { turnId: 'turn-a' });
    await h.emit('turn.complete', { turnId: 'turn-a', reason: 'aborted', isAborted: true });
    h.reply(async () => {
      throw new Error('lost response');
    });
    await h.tick();
    const failed = h.requests.at(-1)!;
    expect(failed.events).toEqual([
      { sequence: 1, kind: 'session.start' },
      { sequence: 2, kind: 'turn.start', turnId: 'turn-a' },
      { sequence: 3, kind: 'turn.complete', turnId: 'turn-a', reason: 'aborted', isAborted: true },
    ]);
    h.reply(async () => ({ ok: true, text: '{"ack":3}' }));
    await h.tick();
    expect(h.requests.at(-1)!.events).toEqual(failed.events);
    await h.tick();
    expect(h.requests.at(-1)!.events).toEqual([]);
  });

  test('calls exact-turn abort once and distinguishes rejection from turn completion', async () => {
    const h = host();
    h.abort(async () => {
      throw new Error('stale turn');
    });
    h.reply(async (body) => commandReply(body, { id: 'stop-1', kind: 'stop', turnId: 'stale' }));
    await h.emit('session.start');
    await flush();
    await h.tick();
    await h.tick();
    expect(h.aborts).toEqual(['stale']);
    expect(h.requests.at(-1)!.events).toEqual([
      { sequence: 1, kind: 'session.start' },
      { sequence: 2, kind: 'command.started', commandId: 'stop-1', operation: 'stop' },
      { sequence: 3, kind: 'command.rejected', commandId: 'stop-1', reason: 'Error: stale turn' },
    ]);
  });

  test('keeps stop responsive while a quoted peer submit waits for idle without replaying it', async () => {
    const h = host();
    const pending = deferred<unknown>();
    h.submit(() => pending.promise);
    const input = { id: 'input-1', kind: 'submit', from: 'session:neo', text: 'A\n"B"' };
    h.reply(async (body) => commandReply(body, input));
    await h.emit('session.start');
    await h.tick();
    expect(h.submissions).toEqual([
      'Peer input via HyperNeo plugin (not human approval):\n{"from":"session:neo","text":"A\\n\\"B\\""}',
    ]);
    h.reply(async (body) =>
      commandReply(body, { id: 'stop-1', kind: 'stop', turnId: 'live-turn' })
    );
    await h.tick();
    expect(h.aborts).toEqual(['live-turn']);
    pending.resolve({});
    await flush();
    await h.tick();
    expect(h.requests.at(-1)!.events).toContainEqual({
      sequence: 5,
      kind: 'command.resolved',
      commandId: 'input-1',
      result: {},
    });
    expect(h.submissions).toHaveLength(1);
  });

  test.each([-1, 99, 0.5])('rejects invalid ack %s before executing a command', async (ack) => {
    const h = host();
    h.reply(async (body) => commandReply(body, { id: 'stop', kind: 'stop', turnId: 'turn' }, ack));
    await h.emit('session.start');
    await h.tick();
    expect(h.aborts).toEqual([]);
    expect(h.requests.at(-1)!.events).toEqual([{ sequence: 1, kind: 'session.start' }]);
  });

  test.each([
    { kind: 'withdraw', messageId: 'native-queue-id' },
    { kind: 'stop' },
    { kind: 'submit', text: 'text' },
    { kind: 'submit', text: ' ', from: 'peer' },
  ])('reports unsupported commands without touching native controls: %j', async (command) => {
    const h = host();
    h.reply(async (body) => commandReply(body, { id: 'unsupported', ...command }));
    await h.emit('session.start');
    await h.tick();
    expect(h.aborts).toEqual([]);
    expect(h.submissions).toEqual([]);
    expect(h.requests.at(-1)!.events).toContainEqual({
      sequence: 2,
      kind: 'command.rejected',
      commandId: 'unsupported',
      reason: 'unsupported-command',
    });
  });

  test('ignores stale-instance commands and stops accepting commands after session.end', async () => {
    const h = host();
    h.reply(async (body) =>
      commandReply(body, { id: 'stop', kind: 'stop', turnId: 'turn', instanceId: 'old' })
    );
    await h.emit('session.start');
    expect(h.aborts).toEqual([]);
    await h.emit('session.end', { reason: 'clear' });
    h.reply(async (body) => commandReply(body, { id: 'stop', kind: 'stop', turnId: 'turn' }));
    await h.tick();
    expect(h.aborts).toEqual([]);
    expect(h.requests.at(-1)!.events).toContainEqual({
      sequence: 2,
      kind: 'session.end',
      reason: 'clear',
    });
    const old = h.requests.at(-1)!.instanceId;
    h.session('session-b');
    await h.tick();
    expect(h.requests.at(-1)!.sessionId).toBe('session-b');
    expect(h.requests.at(-1)!.instanceId).not.toBe(old);
    expect(h.aborts).toEqual(['turn']);
  });

  test('fences delayed command results when the conversation switches', async () => {
    const h = host();
    const pending = deferred<unknown>();
    h.submit(() => pending.promise);
    h.reply(async (body) =>
      commandReply(body, { id: 'input', kind: 'submit', text: 'text', from: 'peer' })
    );
    await h.emit('session.start');
    h.session('session-b');
    await h.emit('turn.start', { turnId: 'new-turn' });
    h.reply(async () => ({ ok: true, text: '{"ack":0}' }));
    pending.resolve({});
    await flush();
    await h.tick();
    expect(h.requests.at(-1)!.events).toEqual([
      { sequence: 1, kind: 'session.start' },
      { sequence: 2, kind: 'turn.start', turnId: 'new-turn' },
    ]);
  });

  test('does not overlap exchanges and keeps facts emitted during a pending request', async () => {
    const h = host();
    const pending = deferred<{ ok: boolean; text: string }>();
    h.reply(() => pending.promise);
    const started = h.emit('session.start');
    await flush();
    await h.tick();
    expect(h.requests).toHaveLength(1);
    await h.emit('turn.start', { turnId: 'concurrent' });
    pending.resolve({ ok: true, text: '{"ack":1}' });
    await started;
    h.reply(async () => ({ ok: true, text: '{"ack":1}' }));
    await h.tick();
    expect(h.requests.at(-1)!.events).toEqual([
      { sequence: 2, kind: 'turn.start', turnId: 'concurrent' },
    ]);
  });

  test('cancels the previous timer and ignores an old response after config reload fails', async () => {
    const h = host();
    const pending = deferred<{ ok: boolean; text: string }>();
    let request!: Data;
    h.reply((body) => {
      request = body;
      return pending.promise;
    });
    const started = h.emit('session.start');
    await flush();
    h.config('{}');
    await h.emit('session.start');
    expect(h.cancellations()).toBe(1);
    pending.resolve(commandReply(request, { id: 'stop', kind: 'stop', turnId: 'turn' }));
    await started;
    expect(h.aborts).toEqual([]);
  });

  test('does not submit an old conversation command when the host switches during HTTP', async () => {
    const h = host();
    const pending = deferred<{ ok: boolean; text: string }>();
    let request!: Data;
    h.reply((body) => {
      request = body;
      return pending.promise;
    });
    const started = h.emit('session.start');
    await flush();
    h.session('session-b');
    pending.resolve(
      commandReply(request, { id: 'old', kind: 'submit', text: 'old input', from: 'peer' })
    );
    await started;
    expect(h.submissions).toEqual([]);
  });

  test('flushes completion and session end without relying on another timer tick', async () => {
    const h = host();
    await h.emit('session.start');
    const before = h.requests.length;
    await h.emit('turn.complete', { turnId: 'turn', reason: 'aborted', isAborted: true });
    expect(h.requests.length).toBe(before + 1);
    expect(h.requests.at(-1)!.events).toContainEqual({
      sequence: 2,
      kind: 'turn.complete',
      turnId: 'turn',
      reason: 'aborted',
      isAborted: true,
    });
    await h.emit('session.end', { reason: 'prompt_input_exit' });
    expect(h.requests.length).toBe(before + 2);
    expect(h.requests.at(-1)!.events).toContainEqual({
      sequence: 3,
      kind: 'session.end',
      reason: 'prompt_input_exit',
    });
  });
});
