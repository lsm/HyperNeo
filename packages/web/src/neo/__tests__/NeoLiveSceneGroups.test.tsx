import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/preact';
import { signal } from '@preact/signals';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { NeoWork } from '@hyperneo/shared/types/neo-context';

const useNeoMock = vi.hoisted(() => vi.fn());
const seen = vi.hoisted(() => ({ workIds: [] as string[] }));
let NeoLive: typeof import('../NeoLive.tsx').NeoLive;

beforeEach(async () => {
  vi.resetModules();
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
  vi.stubGlobal('matchMedia', (query: string) => ({
    matches: query === '(min-width: 1120px)',
  }));
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

const live = () => ({
  sessionId: 'neo',
  selectedId: null as string | null,
  error: null,
  setError: vi.fn(),
  open: vi.fn(),
  act: vi.fn(),
  busyWork: null as string | null,
  store: {
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
  },
});

const snapshot = () => ({
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
  work: [
    work('a-proposed', 'proposed', 20, 'a'),
    work('a-queued', 'queued', 30, 'a'),
    work('a-reported', 'reported', 40, 'a'),
    work('a-failed', 'failed', 50, 'a'),
    work('a-cancelled', 'cancelled', 60, 'a'),
    work('b-queued', 'queued', 70, 'b'),
  ],
  consultations: [{ id: 'consult-one', concernId: 'a', status: 'pending' as const }],
});

const renderLive = (over: Record<string, unknown> = {}) => {
  const model = live();
  const view = snapshot();
  const state = signal({ ...model, snapshot: view, viewSnapshot: view, ...over });
  useNeoMock.mockImplementation(() => state.value);
  const result = render(<NeoLive />);
  return { ...result, state, model };
};

const set = (state: ReturnType<typeof renderLive>['state'], next: Record<string, unknown>) => {
  act(() => {
    state.value = { ...state.value, ...next };
  });
};

const group = (name: string) => screen.getByRole('region', { name });
const cards = (name: string) =>
  within(group(name))
    .getAllByRole('article')
    .map((node) => node.getAttribute('aria-label'));

afterEach(() => {
  cleanup();
  seen.workIds = [];
});

describe('NeoLive work scene groups', () => {
  it('places every work status under a truthful heading and counts the rows it renders', () => {
    renderLive();
    expect(cards('Needs your attention')).toEqual(['Title a-failed', 'Title a-proposed']);
    expect(cards('In progress')).toEqual(['Title b-queued', 'Title a-queued']);
    expect(cards('Recent outcomes')).toEqual(['Title a-cancelled', 'Title a-reported']);
    for (const name of ['Needs your attention', 'In progress', 'Recent outcomes'])
      expect(group(name).textContent).toContain(`${name} · ${cards(name).length}`);
    expect(screen.queryByRole('region', { name: 'Delegated work' })).toBeNull();
    expect(screen.queryByRole('button', { name: /recent work/ })).toBeNull();
  });

  it('labels handed-off work truthfully and keeps reported work unaccepted', () => {
    renderLive();
    expect(within(group('In progress')).getAllByText('Handed to HyperNeo')).toHaveLength(2);
    expect(within(group('In progress')).queryByText('Work underway')).toBeNull();
    const reported = within(group('Recent outcomes')).getByRole('article', {
      name: 'Title a-reported',
    });
    expect(within(reported).getByText('Response ready')).toBeTruthy();
    expect(within(reported).getByText(/Read the execution/)).toBeTruthy();
    expect(within(reported).queryByRole('button', { name: 'Start work' })).toBeNull();
    expect(reported.textContent).not.toMatch(/verified|accepted/i);
  });

  it('keeps native attention actions wired and single-flight busy', () => {
    const { state, model } = renderLive();
    const card = within(group('Needs your attention')).getByRole('article', {
      name: 'Title a-proposed',
    });
    const start = within(card).getByRole('button', { name: 'Start work' });
    const later = within(card).getByRole('button', { name: 'Not now' });
    fireEvent.click(start);
    expect(model.act).toHaveBeenCalledWith('a-proposed', 'start');
    fireEvent.click(later);
    expect(model.act).toHaveBeenCalledWith('a-proposed', 'cancel');
    set(state, { busyWork: 'a-proposed' });
    const busy = within(group('Needs your attention')).getByRole('article', {
      name: 'Title a-proposed',
    });
    const starting = within(busy).getByRole('button', { name: 'Starting…' });
    expect((starting as HTMLButtonElement).disabled).toBe(true);
    expect(model.act).toHaveBeenCalledTimes(2);
  });

  it('keeps the execution link and the shared-chat stop semantics intact', () => {
    const shared = snapshot();
    shared.work = [work('shared', 'queued', 80, 'a', { targetSessionId: 'project-chat' })];
    const { state, model } = renderLive({ snapshot: shared, viewSnapshot: shared });
    const card = within(group('In progress')).getByRole('article', { name: 'Title shared' });
    expect(within(card).queryByRole('button', { name: 'Stop work' })).toBeNull();
    const stop = within(card).getByRole('button', { name: 'Stop waiting' });
    fireEvent.click(stop);
    expect(model.act).toHaveBeenCalledWith('shared', 'cancel');
    expect(
      within(card)
        .getByRole('link', { name: /Inspect execution/ })
        .getAttribute('href')
    ).toBe('/session/shared-session');
    const cleared = { ...shared, work: [] };
    set(state, { snapshot: cleared, viewSnapshot: cleared });
    expect(screen.queryByRole('region', { name: 'In progress' })).toBeNull();
  });

  it('isolates the selected concern and stays honest when the scoped view is null', () => {
    const { state } = renderLive();
    set(state, { selectedId: 'b' });
    expect(cards('In progress')).toEqual(['Title b-queued']);
    expect(screen.queryByRole('article', { name: 'Title a-queued' })).toBeNull();
    set(state, { viewSnapshot: null });
    expect(screen.queryByRole('region', { name: 'Needs your attention' })).toBeNull();
    expect(screen.queryByRole('region', { name: 'In progress' })).toBeNull();
    expect(screen.queryByRole('region', { name: 'Recent outcomes' })).toBeNull();
  });

  it('keeps a pending context check in the work surface only, never in the chat flow', () => {
    const view = snapshot();
    view.work = [work('a-queued', 'queued', 30, 'a')];
    const { container } = renderLive({ snapshot: view, viewSnapshot: view });
    expect(container.textContent).not.toContain('Checking with');
    expect(screen.queryByRole('status')).toBeNull();
    const running = group('In progress');
    expect(running.textContent).toContain('Checking context');
    expect(within(running).queryByRole('button', { name: 'Stop waiting' })).toBeNull();
  });

  it('keeps a long group complete and truthful while the conversation is loading', () => {
    const many = snapshot();
    many.work = Array.from({ length: 12 }, (_, i) => work(`w-${i}`, 'proposed', 200 - i, 'a'));
    const loading = { ...live().store, messagesLoaded: signal(false) };
    const { state } = renderLive({ snapshot: many, viewSnapshot: many, store: loading });
    expect(screen.getByText('Opening your conversation…')).toBeTruthy();
    expect(cards('Needs your attention')).toEqual(
      Array.from({ length: 12 }, (_, i) => `Title w-${i}`)
    );
    expect(group('Needs your attention').textContent).toContain('Needs your attention · 12');
    set(state, { store: { ...state.value.store, messagesLoaded: signal(true) } });
    expect(screen.queryByText('Opening your conversation…')).toBeNull();
  });

  it('still hands the scoped work input to the conversation for reply correlation', () => {
    const { state } = renderLive();
    expect(seen.workIds).toContain('a-proposed');
    set(state, { selectedId: 'b' });
    expect(seen.workIds).toEqual(['b-queued']);
  });

  it('keeps each draft across a selection change that regroups the scenes', () => {
    const { state } = renderLive();
    fireEvent.input(screen.getByLabelText('Draft'), { target: { value: 'root note' } });
    set(state, { selectedId: 'a' });
    expect((screen.getByLabelText('Draft') as HTMLTextAreaElement).value).toBe('');
    expect(cards('Needs your attention')).toEqual(['Title a-failed', 'Title a-proposed']);
    set(state, { selectedId: null });
    expect((screen.getByLabelText('Draft') as HTMLTextAreaElement).value).toBe('root note');
  });
});
