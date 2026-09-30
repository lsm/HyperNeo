import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/preact';
import { waitFor } from '@testing-library/preact';
import { signal } from '@preact/signals';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { NeoWork } from '@hyperneo/shared/types/neo-context';
import type { SessionStore } from '../../lib/session-store.ts';

const useNeoMock = vi.hoisted(() => vi.fn());
const seen = vi.hoisted(() => ({ workIds: [] as string[] }));
type Handler = (value: unknown, context: { channel: string }) => void;
const ctl = vi.hoisted(() => ({
  hold: false,
  hub: null as unknown,
  open: [] as (() => void)[],
  handlers: new Map<string, Set<Handler>>(),
  connections: new Set<(state: string) => void>(),
  stores: [] as unknown[],
  inflight: [] as Promise<void>[],
}));
let NeoLive: typeof import('../NeoLive.tsx').NeoLive;
let calls = { live: 0, started: 0, destroys: 0, peak: 0 };

beforeEach(async () => {
  vi.resetModules();
  calls = { live: 0, started: 0, destroys: 0, peak: 0 };
  ctl.hold = false;
  ctl.hub = null;
  ctl.open = [];
  ctl.handlers = new Map();
  ctl.connections = new Set();
  ctl.stores = [];
  ctl.inflight = [];
  vi.doMock('../useNeo.ts', () => ({ useNeo: useNeoMock }));
  vi.doMock('../../lib/state.ts', () => ({
    connectionState: { value: 'connected', subscribe: () => () => {} },
  }));
  vi.doMock('../NeoComposer.tsx', () => ({
    NeoComposer: (props: { draft: string; onDraft: (value: string) => void }) => (
      <textarea
        aria-label="Draft"
        value={props.draft}
        onInput={(event) => props.onDraft(event.currentTarget.value)}
      />
    ),
  }));
  vi.doMock('../NeoConversation.tsx', () => ({
    NeoConversation: (props: { works: { id: string }[] }) => {
      seen.workIds = props.works.map((item) => item.id);
      return <p data-testid="conversation">{seen.workIds.join(',')}</p>;
    },
  }));
  vi.doMock('../../islands/ToastContainer.tsx', () => ({ default: () => null }));
  vi.doMock('../../lib/connection-manager.ts', () => ({
    connectionManager: {
      getHub: async () => {
        const hub = {
          joinChannel: vi.fn(),
          leaveChannel: vi.fn(),
          request: async () => ({ success: true }),
          onEvent: (method: string, handler: Handler) => {
            const set = ctl.handlers.get(method) ?? new Set<Handler>();
            set.add(handler);
            ctl.handlers.set(method, set);
            return () => set.delete(handler);
          },
          onConnection: (handler: (state: string) => void) => {
            ctl.connections.add(handler);
            return () => ctl.connections.delete(handler);
          },
        };
        ctl.hub = hub;
        if (ctl.hold) await new Promise<void>((resolve) => ctl.open.push(resolve));
        return hub;
      },
      getHubIfConnected: () => ctl.hub,
    },
  }));
  const stores = await import('../../lib/session-store.ts');
  const select = stores.SessionStore.prototype.select;
  const destroy = stores.SessionStore.prototype.destroy;
  vi.spyOn(stores.SessionStore.prototype, 'select').mockImplementation(function (
    this: SessionStore,
    id: string | null
  ) {
    calls.started += 1;
    calls.live += 1;
    calls.peak = Math.max(calls.peak, calls.live);
    ctl.stores.push(this);
    const running = select.call(this, id);
    ctl.inflight.push(running);
    return running;
  });
  vi.spyOn(stores.SessionStore.prototype, 'destroy').mockImplementation(function (
    this: SessionStore
  ) {
    calls.destroys += 1;
    calls.live -= 1;
    const running = destroy.call(this);
    ctl.inflight.push(running);
    return running;
  });
  ({ NeoLive } = await import('../NeoLive.tsx'));
});

const work = (
  id: string,
  status: NeoWork['status'],
  createdAt: number,
  concernId: string | null = 'a',
  extra: Partial<NeoWork> = {}
): NeoWork => ({
  id,
  requestKey: id,
  concernId,
  originSessionId: 'root',
  originMessageId: `ask-${id}`,
  title: `Title ${id}`,
  instruction: `Instruction ${id}`,
  targetSessionId: null,
  sessionId: status === 'proposed' ? null : `${id}-session`,
  status,
  report: status === 'reported' ? `Report ${id}` : null,
  createdAt,
  updatedAt: createdAt + 1,
  ...extra,
});

const snapshot = (workItems: NeoWork[]) => ({
  ok: true as const,
  sessionId: 'root',
  concerns: [
    {
      id: 'a',
      title: 'Concern A',
      summary: 'S',
      context: 'C',
      revision: 1,
      createdAt: 1,
      updatedAt: 2,
    },
    {
      id: 'b',
      title: 'Concern B',
      summary: 'S',
      context: 'C',
      revision: 1,
      createdAt: 1,
      updatedAt: 2,
    },
  ],
  work: workItems,
  consultations: [],
});

const base = () => [
  work('a-proposed', 'proposed', 20, 'a'),
  work('a-queued', 'queued', 30, 'a'),
  work('a-reported', 'reported', 40, 'a'),
  work('b-failed', 'failed', 50, 'b'),
];

const renderLive = (over: Record<string, unknown> = {}) => {
  const store = {
    sessionInfo: signal({ metadata: {} }),
    sdkMessages: signal([{ type: 'user', uuid: 'ask-1' }]),
    messagesLoaded: signal(true),
    activeSessionId: signal('neo'),
    loadErrorKind: signal(null),
    agentState: signal({ status: 'idle' }),
    error: signal(null),
    hasMoreMessages: signal(false),
    isWorking: signal(false),
    refresh: vi.fn(),
    destroy: vi.fn(),
  };
  const view = snapshot(base());
  const model = {
    sessionId: 'neo' as string | null,
    selectedId: null as string | null,
    error: null,
    setError: vi.fn(),
    open: vi.fn(),
    act: vi.fn(),
    busyWork: null as string | null,
    store,
  };
  const state = signal({ ...model, snapshot: view, viewSnapshot: view, ...over });
  useNeoMock.mockImplementation(() => state.value);
  return { ...render(<NeoLive />), state, model, store };
};
const set = (state: { value: unknown }, next: Record<string, unknown>) =>
  act(() => {
    state.value = { ...(state.value as object), ...next };
  });
const group = (name: string) => screen.getByRole('region', { name });
const cards = (name: string) =>
  within(group(name))
    .getAllByRole('article')
    .map((node) => node.getAttribute('aria-label'));
const openScene = (title: string) =>
  fireEvent.click(screen.getByRole('button', { name: `Title ${title.replace('Title ', '')}` }));
const detail = () => screen.getByRole('region', { name: 'Selected work' });
const detailCards = () =>
  within(detail())
    .getAllByRole('article')
    .map((n) => n.getAttribute('aria-label'));

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  seen.workIds = [];
});

describe('NeoLive work scene detail', () => {
  it('opens attention, running and outcome scenes as one native card with a Back control', () => {
    const { model } = renderLive();
    openScene('a-proposed');
    expect(detailCards()).toEqual(['Title a-proposed']);
    expect(screen.queryByRole('region', { name: 'Needs your attention' })).toBeNull();
    fireEvent.click(within(detail()).getByRole('button', { name: 'Start work' }));
    expect(model.act).toHaveBeenCalledWith('a-proposed', 'start');
    fireEvent.click(screen.getByRole('button', { name: 'Back to scenes' }));
    openScene('a-queued');
    expect(within(detail()).getByText('Handed to HyperNeo')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Back to scenes' }));
    openScene('a-reported');
    expect(within(detail()).getByText('Response ready')).toBeTruthy();
    expect(within(detail()).queryByRole('button', { name: 'Start work' })).toBeNull();
    expect(within(detail()).queryByRole('button', { name: 'Title a-reported' })).toBeNull();
  });

  it('keeps the grouped list order and counts unchanged across a round trip', () => {
    renderLive();
    const before = {
      attention: cards('Needs your attention'),
      running: cards('In progress'),
      outcomes: cards('Recent outcomes'),
    };
    expect(before).toEqual({
      attention: ['Title b-failed', 'Title a-proposed'],
      running: ['Title a-queued'],
      outcomes: ['Title a-reported'],
    });
    openScene('a-queued');
    fireEvent.click(screen.getByRole('button', { name: 'Back to scenes' }));
    expect({
      attention: cards('Needs your attention'),
      running: cards('In progress'),
      outcomes: cards('Recent outcomes'),
    }).toEqual(before);
  });

  it('keeps the same ref visible in the board yet never shows a stale detail', () => {
    const { state } = renderLive();
    set(state, { selectedId: 'a' });
    openScene('a-proposed');
    expect(detail()).toBeTruthy();
    set(state, { sessionId: 'holder' });
    expect(cards('Needs your attention')).toContain('Title a-proposed');
    expect(screen.queryByRole('region', { name: 'Selected work' })).toBeNull();
    set(state, { sessionId: 'neo' });
    expect(cards('Needs your attention')).toContain('Title a-proposed');
    expect(screen.queryByRole('region', { name: 'Selected work' })).toBeNull();
  });

  it('makes a pending session unselectable and survives rapid committed scope changes', () => {
    const { state } = renderLive();
    set(state, { sessionId: null });
    openScene('a-proposed');
    expect(screen.queryByRole('region', { name: 'Selected work' })).toBeNull();
    set(state, { sessionId: 'neo', selectedId: 'a' });
    openScene('a-proposed');
    expect(detail()).toBeTruthy();
    set(state, { sessionId: 'holder' });
    expect(screen.queryByRole('region', { name: 'Selected work' })).toBeNull();
    set(state, { sessionId: 'neo' });
    expect(cards('Needs your attention')).toContain('Title a-proposed');
    expect(screen.queryByRole('region', { name: 'Selected work' })).toBeNull();
  });

  it('closes honestly when the scene leaves the board and does not auto-reopen', () => {
    const { state } = renderLive();
    const view = snapshot(base());
    openScene('a-proposed');
    const without = snapshot(base().filter((item) => item.id !== 'a-proposed'));
    set(state, { snapshot: without, viewSnapshot: without });
    expect(screen.queryByRole('region', { name: 'Selected work' })).toBeNull();
    set(state, { snapshot: view, viewSnapshot: view });
    expect(screen.queryByRole('region', { name: 'Selected work' })).toBeNull();
    set(state, { viewSnapshot: null });
    expect(screen.queryByRole('region', { name: 'Selected work' })).toBeNull();
  });

  it('keeps the selected scene when a newer same-scope receipt arrives', () => {
    const { state } = renderLive();
    openScene('a-reported');
    const newer = snapshot([work('a-newest', 'proposed', 900, 'a'), ...base()]);
    set(state, { snapshot: newer, viewSnapshot: newer });
    expect(detailCards()).toEqual(['Title a-reported']);
  });

  it('preserves the scoped work correlation and the composer draft around detail', () => {
    const { state } = renderLive();
    fireEvent.input(screen.getByLabelText('Draft'), { target: { value: 'keep me' } });
    expect(seen.workIds).toEqual(['a-proposed', 'a-queued', 'a-reported', 'b-failed']);
    openScene('a-proposed');
    set(state, { selectedId: 'b' });
    expect(seen.workIds).toEqual(['b-failed']);
    set(state, { selectedId: null });
    expect((screen.getByLabelText('Draft') as HTMLTextAreaElement).value).toBe('keep me');
  });

  it('keeps peak ownership at one and balances select with destroy through unmount', () => {
    const { state, unmount } = renderLive();
    expect([calls.live, calls.started, calls.destroys]).toEqual([1, 1, 0]);
    openScene('a-queued');
    expect([calls.live, calls.started, calls.destroys, calls.peak]).toEqual([1, 2, 1, 1]);
    fireEvent.click(screen.getByRole('button', { name: 'Back to scenes' }));
    expect([calls.live, calls.started, calls.destroys]).toEqual([1, 3, 2]);
    set(state, { selectedId: 'b' });
    expect([calls.live, calls.destroys]).toEqual([0, 3]);
    set(state, { selectedId: null });
    expect([calls.live, calls.started, calls.destroys, calls.peak]).toEqual([1, 4, 3, 1]);
    unmount();
    expect([calls.live, calls.started, calls.destroys, calls.peak]).toEqual([0, 4, 4, 1]);
  });

  it('does not revive a real store whose deferred hub resolves after its owner left', async () => {
    ctl.hold = true;
    const { unmount } = renderLive();
    await waitFor(() => expect(ctl.open.length).toBe(1));
    const store = ctl.stores[0] as SessionStore;
    unmount();
    for (const release of ctl.open) release();
    await act(async () => {
      await Promise.all(ctl.inflight);
    });
    expect([calls.live, calls.started, calls.destroys]).toEqual([0, 1, 1]);
    expect([store.sessionState.value, store.activeSessionId.value]).toEqual([null, null]);
    expect([...ctl.handlers.values()].every((set) => set.size === 0)).toBe(true);
    expect(ctl.connections.size).toBe(0);
    expect(screen.queryByText('A quick choice')).toBeNull();
  });

  it('keeps composer focus when a queued scene settles to reported under the same id', () => {
    const { state } = renderLive();
    const draft = screen.getByLabelText('Draft');
    draft.focus();
    const settled = snapshot(
      base().map((item) => (item.id === 'a-queued' ? work('a-queued', 'reported', 30) : item))
    );
    set(state, { snapshot: settled, viewSnapshot: settled });
    expect(cards('Recent outcomes')).toContain('Title a-queued');
    expect(document.activeElement).toBe(draft);
  });

  it('moves focus to Back on open and restores only within the originating scope', () => {
    const { state } = renderLive();
    const opener = screen.getByRole('button', { name: 'Title a-proposed' });
    opener.focus();
    fireEvent.click(opener);
    expect(document.activeElement?.textContent).toContain('Back to scenes');
    fireEvent.click(screen.getByRole('button', { name: 'Back to scenes' }));
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Title a-proposed' }));
    set(state, { sessionId: 'holder' });
    expect(document.activeElement?.textContent).not.toContain('Back to scenes');
  });

  it('does not restore focus when Back commits together with a scope change', () => {
    const { state } = renderLive();
    fireEvent.click(screen.getByRole('button', { name: 'Title a-queued' }));
    expect(document.activeElement?.textContent).toContain('Back to scenes');
    act(() => {
      fireEvent.click(screen.getByRole('button', { name: 'Back to scenes' }));
      state.value = { ...(state.value as object), sessionId: 'holder' } as typeof state.value;
    });
    expect(screen.queryByRole('region', { name: 'Selected work' })).toBeNull();
    expect(document.activeElement).not.toBe(screen.getByRole('button', { name: 'Title a-queued' }));
  });
});
