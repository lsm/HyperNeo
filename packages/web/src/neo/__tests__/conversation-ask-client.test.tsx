import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/preact';
import type { MessageHub } from '@hyperneo/shared';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  presentConversationAskPage,
  readNeoConversationAsks,
  type ConversationAskRead,
} from '../conversation-ask-client.ts';
import { useNeo } from '../useNeo.ts';

const hookRequest = vi.hoisted(() => vi.fn());
vi.mock('../../lib/connection-manager.ts', () => ({
  connectionManager: {
    getHub: async () => ({
      request: hookRequest,
      onEvent: () => () => {},
      onConnection: () => () => {},
    }),
  },
}));
vi.mock('../../lib/session-store.ts', () => ({
  SessionStore: class {
    async select() {}
    async destroy() {}
  },
}));
afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

const conversationId = '10000000-0000-4000-8000-000000000001';
const foreignId = '10000000-0000-4000-8000-000000000002';
const page = { conversationId, after: 0, limit: 50 };
const current = () => true;
const denied = { state: 'unavailable' };
const image = (source: unknown) => [{ type: 'image', source }];
function ask(sequence = 1, content: unknown = [{ type: 'text', text: '请对照资料，不要发布。' }]) {
  const requestId = `20000000-0000-4000-8000-${String(sequence).padStart(12, '0')}`;
  return {
    conversationId,
    requestId,
    askOrigin: { sessionId: `neo:${conversationId}`, messageId: requestId },
    content,
    sequence,
    createdAt: '2026-09-30T08:00:00.000Z',
  } as Record<string, unknown>;
}
function response(items: Record<string, unknown>[] = [ask()], nextAfter?: number) {
  return {
    ok: true,
    conversationId,
    items,
    nextAfter: nextAfter ?? Number(items.at(-1)?.sequence ?? 0),
  };
}
function transport(value: unknown = response()) {
  const request = vi.fn(async () => value);
  const hub = { request } as unknown as MessageHub;
  const getHub = vi.fn(async () => hub);
  return { request, hub, getHub };
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

describe('durable conversation ask client', () => {
  it('calls only the bounded ask read and preserves canonical content, whitespace and photo bytes', async () => {
    const items = [
      ask(1, [{ type: 'text', text: '   ' }]),
      ask(2, [{ type: 'text', text: '**draft**\n\n  attachment: fictional.txt  ' }]),
      ask(3, image({ type: 'base64', media_type: 'image/png', data: 'aGVsbG8=' })),
    ];
    const io = transport(response(items));
    const ready = { state: 'ready', items, nextAfter: 3 };
    expect(await readNeoConversationAsks({ conversationId, after: 0 }, io.getHub, current)).toEqual(
      ready
    );
    expect(io.request).toHaveBeenCalledExactlyOnceWith('operation.invoke', {
      name: 'neo.conversation.asks.read',
      input: page,
    });
  });

  it('presents admitted pages and refusals through the pure result gate', () => {
    const ready = { value: { state: 'ready', items: [ask(), ask(2)], nextAfter: 2 } };
    expect(presentConversationAskPage(response([ask(), ask(2)]), page)).toEqual(ready);
    expect(presentConversationAskPage({ ok: false }, page)).toEqual({ reason: denied });
  });

  it.each([
    { conversationId: 'legacy-root', after: 0 },
    { conversationId, after: -1 },
    { conversationId, after: 0.5 },
    { conversationId, after: Number.MAX_SAFE_INTEGER + 1 },
    { conversationId, after: 0, limit: 0 },
    { conversationId, after: 0, limit: 101 },
    { conversationId, after: 0, limit: 1.5 },
  ])('rejects invalid cursor %o before connecting', async (input) => {
    const io = transport();
    expect(await readNeoConversationAsks(input, io.getHub, current)).toEqual(denied);
    expect(io.getHub).not.toHaveBeenCalled();
    expect(io.request).not.toHaveBeenCalled();
  });

  it('does not connect for an expired lifetime', async () => {
    const io = transport();
    expect(await readNeoConversationAsks(page, io.getHub, () => false)).toEqual({ state: 'stale' });
    expect(io.getHub).not.toHaveBeenCalled();
  });

  it('rechecks lifetime after connection and before invocation', async () => {
    const io = transport();
    const connection = deferred<MessageHub>();
    let alive = true;
    const lifetime = () => alive;
    const flight = readNeoConversationAsks(page, () => connection.promise, lifetime);
    alive = false;
    connection.resolve(io.hub);
    expect(await flight).toEqual({ state: 'stale' });
    expect(io.request).not.toHaveBeenCalled();
  });

  it.each(['resolve', 'reject'] as const)(
    'ignores a late %s after a view generation changes',
    async (finish) => {
      const pending = deferred<unknown>();
      const io = transport();
      io.request.mockImplementation(() => pending.promise);
      let generation = 1;
      const flight = readNeoConversationAsks(page, io.getHub, () => generation === 1);
      await waitFor(() => expect(io.request).toHaveBeenCalledTimes(1));
      generation = 2;
      if (finish === 'resolve') pending.resolve(response());
      else pending.reject(new Error('old transport'));
      expect(await flight).toEqual({ state: 'stale' });
    }
  );

  it('copies the cursor before awaits and deep copies returned canonical content', async () => {
    const content = image({ type: 'base64', media_type: 'image/webp', data: 'aGVsbG8=' });
    const io = transport(response([ask(1, content)]));
    const connection = deferred<MessageHub>();
    const mutable = { ...page };
    const flight = readNeoConversationAsks(mutable, () => connection.promise, current);
    mutable.conversationId = foreignId;
    mutable.after = 99;
    connection.resolve(io.hub);
    const read = (await flight) as Extract<ConversationAskRead, { state: 'ready' }>;
    expect(read).toEqual({ state: 'ready', items: [ask(1, content)], nextAfter: 1 });
    expect(io.request).toHaveBeenCalledWith('operation.invoke', {
      name: 'neo.conversation.asks.read',
      input: page,
    });
    expect(mutable.after).toBe(99);
    expect(read.items[0].content).not.toBe(content);
    (content[0] as { source: { data: string } }).source.data = 'dGFtcGVyZWQ=';
    expect(read.items[0].content).toEqual(
      image({ type: 'base64', media_type: 'image/webp', data: 'aGVsbG8=' })
    );
  });

  it.each([
    null,
    {},
    { ok: false, reason: 'human_only' },
    { ok: false, reason: 'conversation_not_found' },
    { ...response(), ok: false },
    'raw SDK text',
    { ...response(), conversationId: foreignId },
    { ...response(), items: null },
    response(Array.from({ length: 51 }, (_, i) => ask(i + 1))),
    response([ask()], 2),
    response([ask(2), ask(1)]),
    response([
      ask(1),
      ask(2),
      { ...ask(3), requestId: ask(1).requestId, askOrigin: ask(1).askOrigin },
    ]),
  ])('fails closed on invalid or refused page %o', async (value) => {
    const io = transport(value);
    expect(await readNeoConversationAsks(page, io.getHub, current)).toEqual(denied);
  });

  it.each([
    { conversationId: foreignId },
    { requestId: 'raw-ask-id' },
    { askOrigin: { sessionId: `neo:${conversationId}`, messageId: foreignId } },
    { askOrigin: { sessionId: `neo:${conversationId}`, messageId: 'raw-ask-id' } },
    { askOrigin: { sessionId: '', messageId: ask(1).requestId } },
    { askOrigin: { sessionId: 'x'.repeat(161), messageId: ask(1).requestId } },
    { askOrigin: null },
    { sequence: 0 },
    { sequence: 0.5 },
    { createdAt: '2026-09-30' },
    { createdAt: 'bad-date' },
    { content: '请对照资料，不要发布。' },
    { content: [] },
    { content: [{ type: 'text', text: '' }] },
    { content: [{ type: 'text', text: 7 }] },
    { content: [{ type: 'image' }] },
    { content: image({ type: 'url', media_type: 'image/png', data: 'aGk=' }) },
    { content: image({ type: 'base64', media_type: 'image/bmp', data: 'aGk=' }) },
    { content: image({ type: 'base64', media_type: 'image/png', data: '' }) },
    { content: [{ type: 'tool_result', tool_use_id: 'x', content: 'y' }] },
  ])('refuses a malformed ask row %o', async (patch) => {
    const io = transport(response([{ ...ask(), ...patch }]));
    expect(await readNeoConversationAsks(page, io.getHub, current)).toEqual(denied);
  });

  it('keeps the empty-tail cursor stable and bounds pages without auto-fetching', async () => {
    const empty = transport(response([], 25));
    expect(await readNeoConversationAsks({ ...page, after: 25 }, empty.getHub, current)).toEqual({
      state: 'ready',
      items: [],
      nextAfter: 25,
    });
    const behind = transport(response([ask(1)]));
    expect(await readNeoConversationAsks({ ...page, after: 1 }, behind.getHub, current)).toEqual(
      denied
    );
    const items = Array.from({ length: 100 }, (_, i) => ask(i + 1));
    const io = transport(response(items));
    expect(await readNeoConversationAsks({ ...page, limit: 100 }, io.getHub, current)).toEqual({
      state: 'ready',
      items,
      nextAfter: 100,
    });
    expect(io.request).toHaveBeenCalledTimes(1);
    expect(await readNeoConversationAsks({ ...page, limit: 1 }, io.getHub, current)).toEqual(
      denied
    );
  });

  it('leaves transport failure retryable without treating failure as empty history', async () => {
    const io = transport();
    io.request.mockRejectedValueOnce(new Error('disconnect'));
    expect(await readNeoConversationAsks(page, io.getHub, current)).toEqual(denied);
    expect(await readNeoConversationAsks(page, io.getHub, current)).toEqual({
      state: 'ready',
      items: [ask()],
      nextAfter: 1,
    });
    expect(io.request).toHaveBeenCalledTimes(2);
  });

  it('ignores a connection failure after unmount but reports a current failure', async () => {
    const connection = deferred<MessageHub>();
    let alive = true;
    const lifetime = () => alive;
    const flight = readNeoConversationAsks(page, () => connection.promise, lifetime);
    alive = false;
    connection.reject(new Error('old connect'));
    expect(await flight).toEqual({ state: 'stale' });
    const now = () => Promise.reject(new Error('connect'));
    expect(await readNeoConversationAsks(page, now, current)).toEqual(denied);
  });
});

function Probe() {
  const neo = useNeo();
  return (
    <button
      onClick={async () => {
        const read = await neo.readAsks(page, transport().getHub, () => false);
        hookRequest('read-result', read.state);
      }}
    >
      Read asks
    </button>
  );
}
describe('useNeo ask client build reachability', () => {
  it('exposes the callable ask reader while the consumer owns automatic ask reads', async () => {
    hookRequest.mockImplementation(async (_method: string, payload: { name?: string }) =>
      payload?.name === 'neo.publication.read'
        ? response()
        : { ok: true, sessionId: `neo:${conversationId}`, concerns: [], work: [] }
    );
    render(<Probe />);
    await waitFor(() =>
      expect(hookRequest.mock.calls.some((call) => call[1]?.name === 'neo.publication.read')).toBe(
        true
      )
    );
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Read asks' }));
    });
    await waitFor(() => expect(hookRequest).toHaveBeenCalledWith('read-result', 'stale'));
    await waitFor(() =>
      expect(
        hookRequest.mock.calls.filter((call) => call[1]?.name === 'neo.conversation.asks.read')
          .length
      ).toBeGreaterThan(0)
    );
  });
});
