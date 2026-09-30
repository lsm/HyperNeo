import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/preact';
import type { MessageHub } from '@hyperneo/shared';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  admitPublicationCursor,
  admitPublicationLifetime,
  presentPublicationPage,
  readNeoPublications,
  type PublicationPage,
} from '../publication-client.ts';
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
function item(sequence = 1) {
  return {
    conversationId,
    publicationId: `20000000-0000-4000-8000-${String(sequence).padStart(12, '0')}`,
    sequence,
    createdAt: '2026-09-30T08:00:00.000Z',
    askOrigin: { sessionId: `neo:${conversationId}`, messageId: 'original-ask' },
    producerInput: { sessionId: 'holder:research', messageId: 'return-input' },
    shortText: 'Two differences are worth checking.',
    fullText: '**Full details**\n\nKeep as a draft.',
    links: [{ kind: 'concern', id: 'research', label: '查看对照 ↗' }],
  };
}
function response(items = [item()], nextAfter = items.at(-1)?.sequence ?? 0) {
  return { ok: true, conversationId, items, nextAfter };
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

describe('authored publication client', () => {
  it('pins pure cursor and lifetime gates', () => {
    expect(admitPublicationCursor(page)).toEqual({ value: page });
    expect(admitPublicationLifetime(true)).toEqual({ value: true });
    expect(admitPublicationLifetime(false)).toEqual({ reason: { state: 'stale' } });
    expect(presentPublicationPage(response(), page)).toEqual({
      value: { state: 'ready', items: [item()], nextAfter: 1 },
    });
  });

  it('calls only the bounded authored operation and preserves all authored bytes and attribution', async () => {
    const io = transport();
    expect(await readNeoPublications({ conversationId, after: 0 }, io.getHub, current)).toEqual({
      state: 'ready',
      items: [item()],
      nextAfter: 1,
    });
    expect(io.request).toHaveBeenCalledExactlyOnceWith('operation.invoke', {
      name: 'neo.publication.read',
      input: page,
    });
    expect(io.request.mock.calls).toHaveLength(1);
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
    expect(await readNeoPublications(input, io.getHub, current)).toEqual({ state: 'unavailable' });
    expect(io.getHub).not.toHaveBeenCalled();
    expect(io.request).not.toHaveBeenCalled();
  });

  it('does not connect for an expired lifetime', async () => {
    const io = transport();
    expect(await readNeoPublications(page, io.getHub, () => false)).toEqual({ state: 'stale' });
    expect(io.getHub).not.toHaveBeenCalled();
  });

  it('rechecks lifetime after connection and before invocation', async () => {
    const io = transport();
    const connection = deferred<MessageHub>();
    let alive = true;
    const flight = readNeoPublications(
      page,
      () => connection.promise,
      () => alive
    );
    alive = false;
    connection.resolve(io.hub);
    expect(await flight).toEqual({ state: 'stale' });
    expect(io.request).not.toHaveBeenCalled();
  });

  it.each(['resolve', 'reject'] as const)(
    'ignores late %s after a view generation changes',
    async (finish) => {
      const pending = deferred<unknown>();
      const io = transport();
      io.request.mockImplementation(() => pending.promise);
      let generation = 1;
      const flight = readNeoPublications(page, io.getHub, () => generation === 1);
      await waitFor(() => expect(io.request).toHaveBeenCalledTimes(1));
      generation = 2;
      if (finish === 'resolve') pending.resolve(response());
      else pending.reject(new Error('old transport'));
      expect(await flight).toEqual({ state: 'stale' });
    }
  );

  it('captures the cursor before awaits without mutating the caller input', async () => {
    const io = transport();
    const connection = deferred<MessageHub>();
    const mutable = { ...page };
    const flight = readNeoPublications(mutable, () => connection.promise, current);
    mutable.conversationId = foreignId;
    mutable.after = 99;
    connection.resolve(io.hub);
    expect(await flight).toEqual({ state: 'ready', items: [item()], nextAfter: 1 });
    expect(io.request).toHaveBeenCalledWith('operation.invoke', {
      name: 'neo.publication.read',
      input: page,
    });
    expect(mutable.after).toBe(99);
  });

  it.each([
    null,
    {},
    { ok: false, reason: 'conversation_not_found' },
    'raw SDK text',
    { ...response(), conversationId: foreignId },
    { ...response(), items: null },
    response([], 1),
    response([item()], 2),
    response([item(2), item(1)], 1),
    response([item(), item(2), { ...item(3), publicationId: item().publicationId }], 3),
  ])('fails closed on invalid or refused page %o', async (value) => {
    const io = transport(value);
    expect(await readNeoPublications(page, io.getHub, current)).toEqual({ state: 'unavailable' });
  });

  it.each([
    { conversationId: foreignId },
    { publicationId: 'raw-transcript-id' },
    { sequence: 0 },
    { createdAt: 'bad-date' },
    { shortText: '' },
    { fullText: 'x'.repeat(16001) },
    { askOrigin: { sessionId: 'holder', messageId: '' } },
    { producerInput: null },
    { links: [{ kind: 'url', id: 'https://example.invalid', label: 'unsafe' }] },
    { links: [{ kind: 'work', id: 'work', label: '' }] },
    { links: Array(17).fill(item().links[0]) },
  ])('refuses malformed authored metadata %o', async (patch) => {
    const io = transport(response([{ ...item(), ...patch } as ReturnType<typeof item>]));
    expect(await readNeoPublications(page, io.getHub, current)).toEqual({ state: 'unavailable' });
  });

  it('keeps empty-tail cursor stable and accepts maximum bounded pages without auto-fetching', async () => {
    const empty = transport(response([], 25));
    expect(await readNeoPublications({ ...page, after: 25 }, empty.getHub, current)).toEqual({
      state: 'ready',
      items: [],
      nextAfter: 25,
    });
    const items = Array.from({ length: 100 }, (_, i) => item(i + 1));
    const io = transport(response(items));
    expect(await readNeoPublications({ ...page, limit: 100 }, io.getHub, current)).toEqual({
      state: 'ready',
      items,
      nextAfter: 100,
    });
    expect(io.request).toHaveBeenCalledTimes(1);
    expect(await readNeoPublications({ ...page, limit: 99 }, io.getHub, current)).toEqual({
      state: 'unavailable',
    });
  });

  it('leaves transport failure retryable without treating failure as empty history', async () => {
    const io = transport();
    io.request.mockRejectedValueOnce(new Error('disconnect'));
    expect(await readNeoPublications(page, io.getHub, current)).toEqual({ state: 'unavailable' });
    expect(await readNeoPublications(page, io.getHub, current)).toEqual({
      state: 'ready',
      items: [item()],
      nextAfter: 1,
    });
    expect(io.request).toHaveBeenCalledTimes(2);
  });

  it('ignores a connection failure after unmount but reports a current failure', async () => {
    const connection = deferred<MessageHub>();
    let alive = true;
    const flight = readNeoPublications(
      page,
      () => connection.promise,
      () => alive
    );
    alive = false;
    connection.reject(new Error('old connect'));
    expect(await flight).toEqual({ state: 'stale' });
    expect(
      await readNeoPublications(
        page,
        async () => {
          throw new Error('connect');
        },
        current
      )
    ).toEqual({ state: 'unavailable' });
  });
});

function Probe() {
  const neo = useNeo();
  return (
    <button
      onClick={() =>
        void neo
          .readPublications(page, transport().getHub, () => false)
          .then((read) => {
            hookRequest('read-result', read.state);
          })
      }
    >
      Read publications
    </button>
  );
}
describe('useNeo client build reachability', () => {
  it('retains the reusable reader while the consumer starts bounded publication reads', async () => {
    hookRequest.mockResolvedValue({
      ok: true,
      sessionId: `neo:${conversationId}`,
      concerns: [],
      work: [],
    });
    render(<Probe />);
    await waitFor(() => expect(hookRequest).toHaveBeenCalled());
    await waitFor(() =>
      expect(hookRequest.mock.calls.some((call) => call[1]?.name === 'neo.publication.read')).toBe(
        true
      )
    );
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Read publications' }));
    });
    await waitFor(() => expect(hookRequest).toHaveBeenCalledWith('read-result', 'stale'));
  });
});
