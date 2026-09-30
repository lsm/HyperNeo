import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/preact';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  admitPublicationUpdate,
  appendPublicationWindow,
  publicationConversationId,
  useNeoPublications,
  type NeoPublicationState,
} from '../useNeoPublications.ts';
import { useNeo } from '../useNeo.ts';

const io = vi.hoisted(() => ({
  request: vi.fn(),
  connect: vi.fn(),
  changed: new Set<() => void>(),
  connection: new Set<(state: string) => void>(),
}));
vi.mock('../../lib/connection-manager.ts', () => ({
  connectionManager: { getHub: () => io.connect() },
}));
vi.mock('../../lib/session-store.ts', () => ({
  SessionStore: class {
    async select() {}
    async destroy() {}
  },
}));
const id = '10000000-0000-4000-8000-000000000001';
const other = '10000000-0000-4000-8000-000000000002';
const hub = {
  request: io.request,
  onEvent: (_name: string, callback: () => void) => {
    io.changed.add(callback);
    return () => io.changed.delete(callback);
  },
  onConnection: (callback: (state: string) => void) => {
    io.connection.add(callback);
    return () => io.connection.delete(callback);
  },
};
function row(sequence: number, conversationId = id) {
  return {
    conversationId,
    publicationId: `20000000-0000-4000-8000-${String(sequence).padStart(12, '0')}`,
    sequence,
    createdAt: '2026-09-30T09:00:00.000Z',
    askOrigin: { sessionId: `neo:${conversationId}`, messageId: 'human-ask' },
    producerInput: { sessionId: 'holder:research', messageId: 'holder-return' },
    shortText: `Reply ${sequence}`,
    fullText: `**Full ${sequence}**`,
    links: [{ kind: 'work' as const, id: 'research', label: '查看对照' }],
  };
}
function page(after = 0, count = 1, conversationId = id) {
  return {
    ok: true,
    conversationId,
    items: Array.from({ length: count }, (_, index) => row(after + index + 1, conversationId)),
    nextAfter: after + count,
  };
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
function Probe({ root = `neo:${id}` }: { root?: string | null }) {
  const state = useNeoPublications(root);
  return (
    <>
      <p data-testid="state">
        {state.status}/{state.conversationId}/{state.nextAfter}/{String(state.hasMore)}/
        {String(state.hasEarlier)}
      </p>
      <p data-testid="items">{state.items.map((item) => item.shortText).join(',')}</p>
      <button onClick={state.refresh}>Refresh</button>
    </>
  );
}
const stateText = () => screen.getByTestId('state').textContent;
const requests = () =>
  io.request.mock.calls.filter((call) => call[1]?.name === 'neo.publication.read');
async function changed() {
  await act(async () => {
    io.changed.forEach((callback) => callback());
  });
}

beforeEach(() => {
  io.connect.mockResolvedValue(hub);
  io.request.mockResolvedValue(page());
});
afterEach(() => {
  cleanup();
  io.changed.clear();
  io.connection.clear();
  vi.resetAllMocks();
});

describe('Neo authored publication state', () => {
  it('pins root identity and pure application gates without mutating admitted bytes', () => {
    expect(publicationConversationId(`neo:${id}`)).toBe(id);
    for (const root of [null, id, 'holder:research', 'neo:legacy', `xneo:${id}`])
      expect(publicationConversationId(root)).toBeNull();
    const previous: NeoPublicationState = {
      conversationId: id,
      status: 'ready',
      items: [row(1)],
      nextAfter: 1,
      hasMore: false,
      hasEarlier: false,
    };
    expect(admitPublicationUpdate(previous, { state: 'stale' })).toEqual({ reason: previous });
    expect(admitPublicationUpdate(previous, { state: 'unavailable' })).toEqual({
      reason: { ...previous, status: 'unavailable' },
    });
    const ready = { state: 'ready' as const, items: [row(2)], nextAfter: 2 };
    expect(admitPublicationUpdate(previous, ready)).toEqual({ value: ready });
    expect(admitPublicationUpdate(previous, { ...ready, items: [row(1)] })).toEqual({
      reason: { ...previous, status: 'unavailable' },
    });
    const result = appendPublicationWindow(previous, ready);
    expect(result.items).toEqual([row(1), row(2)]);
    expect(previous.items).toEqual([row(1)]);
    expect(result.items[1].links[0].label).toBe('查看对照');
  });

  it('reads only the bounded authored operation and subscribes once', async () => {
    render(<Probe />);
    await waitFor(() => expect(stateText()).toBe(`ready/${id}/1/false/false`));
    expect(io.request).toHaveBeenCalledExactlyOnceWith('operation.invoke', {
      name: 'neo.publication.read',
      input: { conversationId: id, after: 0, limit: 50 },
    });
    expect(io.changed.size).toBe(1);
    expect(io.connection.size).toBe(1);
    expect(screen.getByTestId('items').textContent).toBe('Reply 1');
  });

  it.each([null, 'holder:research', 'neo:legacy'])('never reads a non-root %s', async (root) => {
    render(<Probe root={root} />);
    expect(stateText()).toBe('idle//0/false/false');
    expect(io.connect).not.toHaveBeenCalled();
    expect(io.request).not.toHaveBeenCalled();
  });

  it('uses explicit next-page reads without an automatic paging loop', async () => {
    io.request.mockImplementation(async (_method: string, { input }) =>
      page(input.after, input.after === 0 ? 50 : 2)
    );
    render(<Probe />);
    await waitFor(() => expect(stateText()).toBe(`ready/${id}/50/true/false`));
    expect(requests()).toHaveLength(1);
    fireEvent.click(screen.getByRole('button'));
    await waitFor(() => expect(stateText()).toBe(`ready/${id}/52/false/false`));
    expect(requests()[1][1].input).toEqual({ conversationId: id, after: 50, limit: 50 });
    expect(screen.getByTestId('items').textContent?.split(',')).toHaveLength(52);
  });

  it('coalesces event bursts during a read into one fresh cursor read', async () => {
    const pending = deferred<unknown>();
    io.request.mockReturnValueOnce(pending.promise).mockResolvedValue(page(1));
    render(<Probe />);
    await waitFor(() => expect(requests()).toHaveLength(1));
    await changed();
    await changed();
    await changed();
    expect(requests()).toHaveLength(1);
    await act(async () => {
      pending.resolve(page());
    });
    await waitFor(() => expect(stateText()).toBe(`ready/${id}/2/false/false`));
    expect(requests()).toHaveLength(2);
    expect(requests()[1][1].input.after).toBe(1);
    expect(screen.getByTestId('items').textContent).toBe('Reply 1,Reply 2');
  });

  it('refreshes on a connection event, never on disconnected states', async () => {
    render(<Probe />);
    await waitFor(() => expect(stateText()).toContain('ready/'));
    io.request.mockResolvedValue(page(1));
    await act(async () => {
      io.connection.forEach((callback) => callback('disconnected'));
    });
    expect(requests()).toHaveLength(1);
    await act(async () => {
      io.connection.forEach((callback) => callback('connected'));
    });
    await waitFor(() => expect(stateText()).toBe(`ready/${id}/2/false/false`));
    expect(requests()).toHaveLength(2);
  });

  it.each(['refusal', 'malformed', 'transport'])(
    'retains admitted history and cursor after %s until explicit retry',
    async (kind) => {
      render(<Probe />);
      await waitFor(() => expect(stateText()).toContain('ready/'));
      if (kind === 'transport') io.request.mockRejectedValueOnce(new Error('offline'));
      else
        io.request.mockResolvedValueOnce(
          kind === 'refusal' ? { ok: false } : { ...page(1), nextAfter: 99 }
        );
      await changed();
      await waitFor(() => expect(stateText()).toBe(`unavailable/${id}/1/false/false`));
      expect(screen.getByTestId('items').textContent).toBe('Reply 1');
      expect(requests()).toHaveLength(2);
      io.request.mockResolvedValue(page(1));
      fireEvent.click(screen.getByRole('button'));
      await waitFor(() => expect(stateText()).toBe(`ready/${id}/2/false/false`));
      expect(requests()[2][1].input.after).toBe(1);
    }
  );

  it('keeps an empty tail cursor and admitted history stable', async () => {
    render(<Probe />);
    await waitFor(() => expect(stateText()).toContain('ready/'));
    io.request.mockResolvedValue(page(1, 0));
    await changed();
    await waitFor(() => expect(requests()).toHaveLength(2));
    expect(stateText()).toBe(`ready/${id}/1/false/false`);
    expect(screen.getByTestId('items').textContent).toBe('Reply 1');
  });

  it('rejects a publication identity repeated across pages without advancing', async () => {
    render(<Probe />);
    await waitFor(() => expect(stateText()).toContain('ready/'));
    const repeated = page(1);
    repeated.items[0].publicationId = row(1).publicationId;
    io.request.mockResolvedValue(repeated);
    await changed();
    await waitFor(() => expect(stateText()).toContain('unavailable/'));
    expect(stateText()).toBe(`unavailable/${id}/1/false/false`);
    expect(screen.getByTestId('items').textContent).toBe('Reply 1');
  });

  it('does not retry a refused pending event burst automatically', async () => {
    const pending = deferred<unknown>();
    io.request.mockReturnValue(pending.promise);
    render(<Probe />);
    await waitFor(() => expect(requests()).toHaveLength(1));
    await changed();
    await changed();
    await act(async () => {
      pending.resolve({ ok: false });
    });
    await waitFor(() => expect(stateText()).toContain('unavailable/'));
    expect(requests()).toHaveLength(1);
  });

  it('retries initial connection failure explicitly', async () => {
    io.connect.mockRejectedValueOnce(new Error('offline'));
    render(<Probe />);
    await waitFor(() => expect(stateText()).toBe(`unavailable/${id}/0/false/false`));
    expect(io.connect).toHaveBeenCalledTimes(1);
    expect(io.request).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button'));
    await waitFor(() => expect(stateText()).toBe(`ready/${id}/1/false/false`));
    expect(io.connect).toHaveBeenCalledTimes(2);
  });

  it.each(['resolve', 'reject'])('ignores late %s from a previous root', async (finish) => {
    const pending = deferred<unknown>();
    io.request.mockReturnValueOnce(pending.promise).mockResolvedValue(page(0, 1, other));
    const view = render(<Probe />);
    await waitFor(() => expect(requests()).toHaveLength(1));
    view.rerender(<Probe root={`neo:${other}`} />);
    await waitFor(() => expect(stateText()).toBe(`ready/${other}/1/false/false`));
    await act(async () => {
      if (finish === 'resolve') pending.resolve(page());
      else pending.reject(new Error('old failure'));
    });
    expect(stateText()).toBe(`ready/${other}/1/false/false`);
    expect(io.changed.size).toBe(1);
    expect(io.connection.size).toBe(1);
  });

  it('ignores a connection arriving after root change or unmount', async () => {
    const pending = deferred<typeof hub>();
    io.connect.mockReturnValueOnce(pending.promise);
    const view = render(<Probe />);
    view.rerender(<Probe root={null} />);
    await act(async () => {
      pending.resolve(hub);
    });
    expect(io.request).not.toHaveBeenCalled();
    expect(io.changed.size).toBe(0);
    view.unmount();
    expect(io.connection.size).toBe(0);
  });

  it('unsubscribes and ignores an in-flight page after unmount', async () => {
    const pending = deferred<unknown>();
    io.request.mockReturnValueOnce(pending.promise);
    const view = render(<Probe />);
    await waitFor(() => expect(requests()).toHaveLength(1));
    await changed();
    view.unmount();
    await act(async () => {
      pending.resolve(page());
    });
    expect(requests()).toHaveLength(1);
    expect(io.changed.size).toBe(0);
    expect(io.connection.size).toBe(0);
  });

  it('retains at most 500 items and honestly marks omitted earlier history', async () => {
    io.request.mockImplementation(async (_method: string, { input }) => page(input.after, 50));
    render(<Probe />);
    await waitFor(() => expect(stateText()).toBe(`ready/${id}/50/true/false`));
    for (let index = 2; index <= 11; index++) {
      fireEvent.click(screen.getByRole('button'));
      await waitFor(() => expect(stateText()).toContain(`/${index * 50}/true/`));
    }
    expect(stateText()).toBe(`ready/${id}/550/true/true`);
    const texts = screen.getByTestId('items').textContent?.split(',');
    expect(texts).toHaveLength(500);
    expect(texts?.[0]).toBe('Reply 51');
    expect(texts?.at(-1)).toBe('Reply 550');
    expect(requests()).toHaveLength(11);
  });
});

function NeoProbe() {
  const neo = useNeo();
  return (
    <>
      <button onClick={() => void neo.open('research')}>Open holder</button>
      <p>
        {neo.publications.status}/{neo.publications.conversationId}/{neo.publications.items.length}
      </p>
    </>
  );
}
it('wires the consumer to the global root without querying SDK transcripts for publications', async () => {
  io.request.mockImplementation(async (_method: string, { name, input }) =>
    name === 'neo.publication.read'
      ? page()
      : {
          ok: true,
          sessionId: input?.concernId ? 'holder:research' : `neo:${id}`,
          concerns: [],
          work: [],
        }
  );
  render(<NeoProbe />);
  await waitFor(() => expect(screen.getByText(`ready/${id}/1`)).toBeTruthy());
  expect(requests()).toHaveLength(1);
  expect(io.request.mock.calls.every((call) => call[0] === 'operation.invoke')).toBe(true);
  fireEvent.click(screen.getByRole('button', { name: 'Open holder' }));
  await waitFor(() =>
    expect(io.request).toHaveBeenCalledWith('operation.invoke', {
      name: 'neo.snapshot',
      input: { concernId: 'research' },
    })
  );
  expect(screen.getByText(`ready/${id}/1`)).toBeTruthy();
  expect(requests()).toHaveLength(1);
});
