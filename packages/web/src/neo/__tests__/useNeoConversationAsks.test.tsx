import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/preact';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  admitAskPage,
  appendAskWindow,
  useNeoConversationAsks,
  type NeoAskState,
} from '../useNeoConversationAsks.ts';
import { useNeo } from '../useNeo.ts';

const fake = vi.hoisted(() => ({
  calls: [] as { name: string; input: unknown }[],
  changed: [] as (() => void)[],
  connections: [] as ((state: string) => void)[],
  live: 0,
  online: false,
  connect: null as null | (() => Promise<unknown>),
  respond: (() => ({})) as (name: string, input: unknown) => unknown,
}));
vi.mock('../../lib/connection-manager.ts', () => ({
  connectionManager: {
    getHub: async () =>
      fake.online && fake.connect ? fake.connect() : Promise.reject(new Error('offline')),
  },
}));
vi.mock('../../lib/session-store.ts', () => ({
  SessionStore: class {
    async select() {}
    async destroy() {}
  },
}));

const hub = {
  request: async (_method: string, payload: { name: string; input: unknown }) => {
    fake.calls.push({ name: payload.name, input: payload.input });
    return Promise.resolve(fake.respond(payload.name, payload.input));
  },
  onEvent: (name: string, callback: () => void) => {
    if (name === 'neo.changed') fake.changed.push(callback);
    fake.live += 1;
    return () => {
      fake.live -= 1;
      fake.changed = fake.changed.filter((entry) => entry !== callback);
    };
  },
  onConnection: (callback: (state: string) => void) => {
    fake.connections.push(callback);
    fake.live += 1;
    return () => {
      fake.live -= 1;
      fake.connections = fake.connections.filter((entry) => entry !== callback);
    };
  },
};
const conversationId = '10000000-0000-4000-8000-000000000001';
const otherId = '10000000-0000-4000-8000-000000000002';
const root = `neo:${conversationId}`;
function ask(sequence = 1, target = conversationId) {
  const requestId = `20000000-0000-4000-8000-${String(sequence).padStart(12, '0')}`;
  return {
    conversationId: target,
    requestId,
    askOrigin: { sessionId: `neo:${target}`, messageId: requestId },
    content: [{ type: 'text', text: `ask ${sequence}` }],
    sequence,
    createdAt: '2026-09-30T08:00:00.000Z',
  };
}
function pageOf(items: unknown[], target = conversationId, nextAfter?: number) {
  const last = items.at(-1) as { sequence: number } | undefined;
  return { ok: true, conversationId: target, items, nextAfter: nextAfter ?? last?.sequence ?? 0 };
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}
function online() {
  fake.online = true;
  fake.connect = () => Promise.resolve(hub);
}
function serve(...pages: unknown[]) {
  const queue = [...pages];
  fake.respond = (name) =>
    name === 'neo.conversation.asks.read'
      ? Promise.resolve(queue.shift() ?? pageOf([]))
      : Promise.resolve({ ok: false, reason: 'conversation_not_found' });
}
function reads(first: unknown, rest: () => unknown) {
  return (name: string) =>
    name === 'neo.conversation.asks.read'
      ? readCount() === 1
        ? Promise.resolve(first)
        : rest()
      : Promise.resolve({});
}
function snapshot(sessionId = root) {
  return { ok: true, sessionId, concerns: [], work: [] };
}
function reset() {
  fake.calls = [];
  fake.changed = [];
  fake.connections = [];
  fake.live = 0;
  fake.online = false;
  fake.connect = null;
  fake.respond = () => ({});
}
afterEach(() => {
  cleanup();
  reset();
});

function Probe({ sessionId }: { sessionId: string | null }) {
  const asks = useNeoConversationAsks(sessionId);
  return (
    <>
      <p>Status: {asks.status}</p>
      <p>Rows: {asks.items.map((item) => item.requestId).join('|') || 'none'}</p>
      <p>Cursor: {asks.nextAfter}</p>
      <p>More: {String(asks.hasMore)}</p>
      <p>Earlier: {String(asks.hasEarlier)}</p>
      <button onClick={() => asks.nextPage()}>Next page</button>
      <button onClick={() => asks.retry()}>Retry</button>
    </>
  );
}
const texts = () => ({
  status: screen.getByText(/^Status: /).textContent,
  rows: screen.getByText(/^Rows: /).textContent,
  cursor: screen.getByText(/^Cursor: /).textContent,
  more: screen.getByText(/^More: /).textContent,
  earlier: screen.getByText(/^Earlier: /).textContent,
});
const readInput = () =>
  fake.calls.filter((call) => call.name === 'neo.conversation.asks.read').map((call) => call.input);
const readCount = () => readInput().length;
const connected = () => fake.connections.forEach((entry) => entry('connected'));
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));
const burst = (count = 3) => {
  for (let index = 0; index < count; index += 1)
    act(() => fake.changed.forEach((entry) => entry()));
};
const click = async (name: string) => {
  await act(async () => {
    fireEvent.click(screen.getByRole('button', { name }));
  });
};

describe('neo conversation ask window stages', () => {
  const state = (items: unknown[], nextAfter: number): NeoAskState => ({
    conversationId,
    status: 'ready',
    items: items as NeoAskState['items'],
    nextAfter,
    hasMore: false,
    hasEarlier: false,
  });
  const ready = { state: 'ready' as const, items: [ask(2)], nextAfter: 2 };

  it('admits fresh pages and refuses stale, refused and cross-page duplicate pages', () => {
    const held = state([ask(1)], 1);
    expect(admitAskPage(held, ready)).toEqual({ value: ready });
    expect(admitAskPage(held, { state: 'stale' })).toEqual({ reason: held });
    expect(admitAskPage(held, { state: 'unavailable' })).toEqual({
      reason: { ...held, status: 'unavailable' },
    });
    expect(admitAskPage(held, { state: 'ready', items: [ask(1)], nextAfter: 1 })).toEqual({
      reason: { ...held, status: 'unavailable' },
    });
  });

  it('windows at 500 rows with an honest earlier flag, full-page more flag and stable cursor', () => {
    const full = Array.from({ length: 50 }, (_, i) => ask(i + 1));
    const first = appendAskWindow(state([], 0), { state: 'ready', items: full, nextAfter: 50 });
    expect(first).toEqual({
      ...state(full, 50),
      status: 'ready',
      hasMore: true,
      hasEarlier: false,
    });
    const long = state(
      Array.from({ length: 480 }, (_, i) => ask(i + 1)),
      480
    );
    const next = full.map((_, index) => ask(index + 481));
    const grown = appendAskWindow(long, { state: 'ready', items: next, nextAfter: 530 });
    expect(grown.items).toHaveLength(500);
    expect(grown.items[0].sequence).toBe(31);
    expect(grown.hasEarlier).toBe(true);
    expect(grown.nextAfter).toBe(530);
    expect(
      appendAskWindow(state([ask(1)], 1), { state: 'ready', items: [], nextAfter: 1 })
    ).toEqual({
      ...state([ask(1)], 1),
      status: 'ready',
      hasMore: false,
    });
  });
});

describe('useNeoConversationAsks resource shell', () => {
  it('reads the global root once and pages only when asked', async () => {
    serve(pageOf([ask(1)]), pageOf([ask(2)]));
    online();
    render(<Probe sessionId={root} />);
    await waitFor(() => expect(texts().status).toBe('Status: ready'));
    expect(readInput()).toEqual([
      { conversationId, after: 0, before: Number.MAX_SAFE_INTEGER, limit: 50 },
    ]);
    expect(texts().rows).toContain(ask(1).requestId);
    expect(texts().cursor).toBe('Cursor: 1');
    expect(texts().more).toBe('More: false');
    expect(fake.live).toBe(2);
    await click('Next page');
    await waitFor(() => expect(texts().rows).toContain(ask(2).requestId));
    expect(readInput()[1]).toEqual({ conversationId, after: 1, limit: 50 });
    expect(readCount()).toBe(2);
  });

  it('ignores a non-Neo root, then re-reads when the global root changes', async () => {
    const gate = deferred<unknown>();
    fake.respond = reads(pageOf([ask(1)]), () => gate.promise);
    online();
    const view = render(<Probe sessionId={null} />);
    expect(texts().status).toBe('Status: idle');
    view.rerender(<Probe sessionId="neo:legacy-root" />);
    expect(texts().status).toBe('Status: idle');
    await settle();
    expect(readCount()).toBe(0);
    view.rerender(<Probe sessionId={root} />);
    await waitFor(() => expect(texts().status).toBe('Status: ready'));
    view.rerender(<Probe sessionId={`neo:${otherId}`} />);
    expect(texts().rows).toBe('Rows: none');
    await act(async () => gate.resolve(pageOf([ask(5, otherId)], otherId)));
    await waitFor(() => expect(texts().cursor).toBe('Cursor: 5'));
    expect(texts().rows).toContain(ask(5, otherId).requestId);
    expect(texts().rows).not.toContain(ask(1).requestId);
    expect(readInput()[1]).toEqual({
      conversationId: otherId,
      after: 0,
      before: Number.MAX_SAFE_INTEGER,
      limit: 50,
    });
  });

  it('coalesces a changed burst into one follow-up and never overlaps in-flight pages', async () => {
    const gate = deferred<unknown>();
    online();
    fake.respond = reads(gate.promise, () => Promise.resolve(pageOf([ask(2)])));
    render(<Probe sessionId={root} />);
    await waitFor(() => expect(readCount()).toBe(1));
    expect(texts().status).toBe('Status: loading');
    burst();
    expect(readCount()).toBe(1);
    await act(async () => gate.resolve(pageOf([ask(1)])));
    await waitFor(() => expect(texts().rows).toContain(ask(2).requestId));
    expect(readInput()[1]).toEqual({ conversationId, after: 1, limit: 50 });
    expect(readCount()).toBe(2);
  });

  it('reads the next page when the connection recovers', async () => {
    serve(pageOf([ask(1)]), pageOf([ask(2)]));
    online();
    render(<Probe sessionId={root} />);
    await waitFor(() => expect(texts().status).toBe('Status: ready'));
    connected();
    await waitFor(() => expect(texts().rows).toContain(ask(2).requestId));
    expect(readInput()[1]).toEqual({ conversationId, after: 1, limit: 50 });
    expect(readCount()).toBe(2);
  });

  it('never auto-retries a refused pending burst and keeps admitted rows and cursor', async () => {
    const gate = deferred<unknown>();
    online();
    fake.respond = reads(pageOf([ask(1)]), () => gate.promise);
    render(<Probe sessionId={root} />);
    await waitFor(() => expect(texts().status).toBe('Status: ready'));
    await click('Next page');
    await waitFor(() => expect(readCount()).toBe(2));
    burst();
    await act(async () => gate.resolve({ ok: false, reason: 'conversation_not_found' }));
    await waitFor(() => expect(texts().status).toBe('Status: unavailable'));
    expect(texts().rows).toContain(ask(1).requestId);
    expect(texts().cursor).toBe('Cursor: 1');
    await settle();
    expect(readCount()).toBe(2);
    fake.respond = (name) =>
      name === 'neo.conversation.asks.read'
        ? readCount() === 3
          ? Promise.resolve(pageOf([ask(2)]))
          : Promise.resolve({ ok: false, reason: 'conversation_not_found' })
        : Promise.resolve({});
    await click('Retry');
    await waitFor(() => expect(texts().status).toBe('Status: ready'));
    expect(readInput()[2]).toEqual({ conversationId, after: 1, limit: 50 });
    expect(texts().rows).toContain(ask(2).requestId);
  });

  it('refuses a cross-page duplicate without clearing admitted history', async () => {
    serve(pageOf([ask(1), ask(2)]), pageOf([ask(2), ask(3)]));
    online();
    render(<Probe sessionId={root} />);
    await waitFor(() => expect(texts().status).toBe('Status: ready'));
    await click('Next page');
    await waitFor(() => expect(texts().status).toBe('Status: unavailable'));
    expect(texts().rows).toContain(ask(1).requestId);
    expect(texts().rows).toContain(ask(2).requestId);
    expect(texts().cursor).toBe('Cursor: 2');
  });

  it('retries an initial connection failure explicitly and cleans up on unmount', async () => {
    render(<Probe sessionId={root} />);
    await waitFor(() => expect(texts().status).toBe('Status: unavailable'));
    expect(readCount()).toBe(0);
    expect(fake.live).toBe(0);
    serve(pageOf([ask(1)]));
    online();
    await click('Retry');
    await waitFor(() => expect(texts().status).toBe('Status: ready'));
    expect(readInput()).toEqual([
      { conversationId, after: 0, before: Number.MAX_SAFE_INTEGER, limit: 50 },
    ]);
    expect(fake.live).toBe(2);
    cleanup();
    expect(fake.live).toBe(0);
  });

  it('ignores a late connection that arrives after unmount', async () => {
    const late = deferred<unknown>();
    fake.online = true;
    fake.connect = () => late.promise;
    const view = render(<Probe sessionId={root} />);
    view.unmount();
    await act(async () => late.resolve(hub));
    await settle();
    expect(readCount()).toBe(0);
    expect(fake.live).toBe(0);
  });

  it.each(['resolve', 'reject'] as const)(
    'drops an in-flight page that settles %s after unmount',
    async (finish) => {
      const gate = deferred<unknown>();
      online();
      fake.respond = reads(gate.promise, () => ({}));
      const view = render(<Probe sessionId={root} />);
      await waitFor(() => expect(readCount()).toBe(1));
      view.unmount();
      await act(async () => {
        if (finish === 'resolve') gate.resolve(pageOf([ask(1)]));
        else gate.reject(new Error('late failure'));
      });
      await settle();
      expect(fake.live).toBe(0);
      expect(screen.queryByText(/^Status: /)).toBeNull();
    }
  );

  it('never lets a late response overwrite a new root', async () => {
    const gate = deferred<unknown>();
    online();
    fake.respond = reads(gate.promise, () => pageOf([ask(9, otherId)], otherId));
    const view = render(<Probe sessionId={root} />);
    await waitFor(() => expect(readCount()).toBe(1));
    view.rerender(<Probe sessionId={`neo:${otherId}`} />);
    await waitFor(() => expect(texts().cursor).toBe('Cursor: 9'));
    await act(async () => gate.resolve(pageOf([ask(1)])));
    await settle();
    expect(texts().rows).not.toContain(ask(1).requestId);
    expect(texts().cursor).toBe('Cursor: 9');
  });
});

function NeoProbe() {
  const neo = useNeo();
  return (
    <>
      <p>Ask status: {neo.asks.status}</p>
      <p>Ask rows: {neo.asks.items.map((item) => item.requestId).join('|') || 'none'}</p>
      <button onClick={() => void neo.open()}>Reopen Neo</button>
    </>
  );
}
describe('useNeo global ask consumer', () => {
  it('feeds the global root asks and keeps them through a reopen', async () => {
    online();
    fake.respond = (name) => {
      if (name === 'neo.conversation.asks.read') return pageOf([ask(1)]);
      return name === 'neo.open' || name === 'neo.snapshot' ? snapshot() : {};
    };
    render(<NeoProbe />);
    await waitFor(() => expect(screen.getByText('Ask status: ready')).toBeTruthy());
    expect(screen.getByText(`Ask rows: ${ask(1).requestId}`)).toBeTruthy();
    expect(readInput()).toEqual([
      { conversationId, after: 0, before: Number.MAX_SAFE_INTEGER, limit: 50 },
    ]);
    await click('Reopen Neo');
    expect(screen.getByText(`Ask rows: ${ask(1).requestId}`)).toBeTruthy();
    expect(screen.getByText('Ask status: ready')).toBeTruthy();
    expect(readCount()).toBe(1);
  });
});
