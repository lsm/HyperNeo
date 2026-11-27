vi.mock('../../components/SessionSchedules.tsx', () => ({ SessionSchedules: () => null }));
import { locale } from '../../lib/i18n/index.ts';
import type { NeoQuestionEntry } from '@hyperneo/shared/types/neo-ask';
import type { NeoPublication } from '@hyperneo/shared/types/neo-publication';
import type { NeoSnapshot } from '@hyperneo/shared/types/neo-snapshot';
import { NeoPublicConversation } from '../NeoPublicConversation.tsx';
import type { NeoPublicEntry } from '../public-conversation.ts';
vi.mock('../NeoGoals.tsx', () => ({ NeoGoals: () => null }));
import { signal } from '@preact/signals';
import { act, cleanup, fireEvent, render, screen, within, waitFor } from '@testing-library/preact';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { connectionState } from '../../lib/state.ts';
import { connectionManager } from '../../lib/connection-manager.ts';
import {
  artifactPreviewStack,
  closeArtifactPreview,
  openArtifactPreview,
} from '../../lib/artifact-preview-store.ts';
import { NeoLive } from '../NeoLive.tsx';
import { testAskEntry, testTodo } from './neo-test-views.ts';

const useNeoMock = vi.hoisted(() => vi.fn());
vi.mock('../useNeo.ts', () => ({ useNeo: useNeoMock }));
vi.mock('../NeoComposer.tsx', () => ({
  NeoComposer: (props: { draft: string; onDraft: (text: string) => void }) => (
    <textarea
      aria-label="Draft"
      value={props.draft}
      onInput={(event) => props.onDraft(event.currentTarget.value)}
    />
  ),
}));
vi.mock('../NeoConversation.tsx', () => ({
  NeoConversation: (props: {
    publicConversation?: Parameters<typeof NeoPublicConversation>[0]['conversation'];
    onOpenWork?: Parameters<typeof NeoPublicConversation>[0]['onOpenWork'];
    replyLabels?: Parameters<typeof NeoPublicConversation>[0]['replyLabels'];
  }) =>
    props.publicConversation ? (
      <NeoPublicConversation
        conversation={props.publicConversation}
        onOpenWork={props.onOpenWork}
        replyLabels={props.replyLabels}
      />
    ) : (
      <p>Durable fictional answer</p>
    ),
}));
vi.mock('../../islands/ToastContainer.tsx', () => ({ default: () => null }));

beforeEach(() => {
  vi.spyOn(connectionManager, 'getHub').mockResolvedValue({
    request: vi.fn(async (_method: string, params: { name: string }) => {
      if (params.name === 'neo.ask.search') return { ok: true, results: [] };
      throw new Error('Synthetic unavailable');
    }),
  } as never);
  connectionState.value = 'connected';
  vi.stubGlobal('matchMedia', () => ({ matches: true }));
  vi.stubGlobal(
    'ResizeObserver',
    class {
      observe() {}
      disconnect() {}
    }
  );
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  localStorage.removeItem('neo:topic-filter');
});

const root = 'neo:550e8400-e29b-41d4-a716-446655440000';

describe('Work search input and retry', () => {
  it.each(['to do', 'ok?'])(
    'keeps short local query %s usable without a false server error',
    async (query) => {
      locale.value = 'en';
      const request = vi.fn(async (_method: string, params: { name: string }) => {
        if (params.name === 'neo.ask.search')
          throw Object.assign(new Error('query_too_short'), { code: 'INVALID_PARAMS' });
        return { schedules: [] };
      });
      vi.spyOn(connectionManager, 'getHub').mockResolvedValue({ request } as never);
      const { model } = mount();
      act(() => {
        model.value = {
          ...model.value,
          snapshot: { ...model.value.snapshot, todoAsks: [testAskEntry('short', query)] },
        };
      });
      fireEvent.click(screen.getByRole('button', { name: 'Search work', exact: true }));
      fireEvent.input(screen.getByRole('searchbox'), { target: { value: query } });
      await screen.findByRole('heading', { name: query, exact: true });
      await waitFor(() => expect(screen.queryByText('Searching work…')).toBeNull());
      expect(
        screen.queryByText('Could not search work. Close and reopen search to retry.')
      ).toBeNull();
    }
  );
  it('clears the search and filters when a card topic is tapped in the results', async () => {
    locale.value = 'en';
    const request = vi.fn(async (_method: string, params: { name: string }) => {
      if (params.name === 'neo.ask.search')
        throw Object.assign(new Error('query_too_short'), { code: 'INVALID_PARAMS' });
      return { schedules: [] };
    });
    vi.spyOn(connectionManager, 'getHub').mockResolvedValue({ request } as never);
    const protocol = testAskEntry('protocol', 'to do protocol');
    protocol.ask.topic = 'OAP';
    protocol.ask.topicKey = 'pick:oap';
    const inbox = testAskEntry('inbox', 'to do inbox');
    inbox.ask.topic = '邮件';
    inbox.ask.topicKey = 'pick:邮件';
    const { model, container } = mount();
    act(() => {
      model.value = {
        ...model.value,
        snapshot: { ...model.value.snapshot, todoAsks: [protocol, inbox] },
      };
    });
    fireEvent.click(screen.getByRole('button', { name: 'Search work', exact: true }));
    fireEvent.input(screen.getByRole('searchbox'), { target: { value: 'to do' } });
    await screen.findByRole('heading', { name: 'to do protocol', exact: true });
    expect(container.querySelector('[data-topic-chips]')).toBeNull();
    const card = container.querySelector('[data-ask="protocol"]') as HTMLElement;
    fireEvent.click(within(card).getByRole('button', { name: 'OAP' }));
    await waitFor(() => expect(container.querySelector('[data-topic-chips]')).toBeTruthy());
    expect((screen.getByRole('searchbox') as HTMLInputElement).value).toBe('');
    expect(screen.getByRole('button', { name: 'OAP 1' }).getAttribute('aria-pressed')).toBe('true');
    expect(
      [...container.querySelectorAll('[data-ask]')].map((node) => node.getAttribute('data-ask'))
    ).toEqual(['protocol']);
  });
  it('searches in the tab row and restores the tabs on close', async () => {
    locale.value = 'en';
    const protocol = testAskEntry('protocol', 'to do protocol');
    const { model, container } = mount();
    act(() => {
      model.value = {
        ...model.value,
        snapshot: { ...model.value.snapshot, todoAsks: [protocol] },
      };
    });
    fireEvent.click(screen.getByRole('button', { name: 'Search work', exact: true }));
    fireEvent.input(screen.getByRole('searchbox'), { target: { value: 'to do' } });
    await waitFor(() =>
      expect(container.querySelector('[data-scene-group="search"]')).toBeTruthy()
    );
    expect(screen.queryByRole('button', { name: 'Goals' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Close work search' }));
    expect(screen.queryByRole('searchbox')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Goals' }));
    fireEvent.click(screen.getByRole('button', { name: 'Inbox' }));
    expect(container.querySelector('[data-scene-group="search"]')).toBeNull();
    expect(container.querySelector('[data-ask="protocol"]')).toBeTruthy();
  });
  it('shows the topic of a result with no loaded card as disabled', async () => {
    locale.value = 'en';
    const remote = testAskEntry('remote', 'remote protocol', { state: 'done' });
    remote.ask.topic = 'OAP';
    remote.ask.topicKey = 'pick:oap';
    const request = vi.fn(async (_method: string, params: { name: string }) => {
      if (params.name === 'neo.ask.search')
        return { ok: true, results: [{ askId: remote.ask.id }], nextCursor: null };
      if (params.name === 'neo.ask.read') return { ok: true, entry: remote };
      return { schedules: [] };
    });
    vi.spyOn(connectionManager, 'getHub').mockResolvedValue({ request } as never);
    const { container } = mount();
    fireEvent.click(screen.getByRole('button', { name: 'Search work', exact: true }));
    fireEvent.input(screen.getByRole('searchbox'), { target: { value: 'remote protocol' } });
    await screen.findByRole('heading', { name: 'remote protocol', exact: true });
    const card = container.querySelector('[data-ask="remote"]') as HTMLElement;
    const topic = within(card).getByRole('button', { name: 'OAP' }) as HTMLButtonElement;
    expect(topic.disabled).toBe(true);
    fireEvent.click(topic);
    expect((screen.getByRole('searchbox') as HTMLInputElement).value).toBe('remote protocol');
    expect(container.querySelector('[data-ask="remote"]')).toBeTruthy();
    expect(localStorage.getItem('neo:topic-filter')).toBeNull();
  });
  it('finds an unloaded Chinese card beyond the first server page', async () => {
    locale.value = 'en';
    const old = testAskEntry('old-page-two', '网页修两处', { state: 'done' });
    const request = vi.fn(
      async (_method: string, params: { name: string; input: { cursor?: string } }) => {
        if (params.name === 'neo.ask.search')
          return params.input.cursor
            ? {
                ok: true,
                results: [{ askId: old.ask.id }, { askId: old.ask.id }],
                nextCursor: null,
              }
            : {
                ok: true,
                results: Array.from({ length: 50 }, () => ({ askId: 'waiting' })),
                nextCursor: '50',
              };
        if (params.name === 'neo.ask.read') return { ok: true, entry: old };
        return { schedules: [] };
      }
    );
    vi.spyOn(connectionManager, 'getHub').mockResolvedValue({ request } as never);
    const { container } = mount();
    expect(container.querySelector('[data-ask="old-page-two"]')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Search work', exact: true }));
    fireEvent.input(screen.getByRole('searchbox'), { target: { value: '网页修两处' } });
    fireEvent.click(
      await screen.findByRole('button', { name: 'Load more search results', exact: true })
    );
    await screen.findByRole('heading', { name: '网页修两处' });
    expect(container.querySelectorAll('[data-ask="old-page-two"]')).toHaveLength(1);
  });
  it.each([{ isComposing: true }, { keyCode: 229 }])(
    'keeps the CJK query when Escape dismisses composition: %j',
    (composition) => {
      locale.value = 'en';
      mount();
      fireEvent.click(screen.getByRole('button', { name: 'Search work', exact: true }));
      const input = screen.getByRole('searchbox', { name: 'Search work', exact: true });
      fireEvent.input(input, { target: { value: '数据' } });
      fireEvent.keyDown(input, { key: 'Escape', ...composition });
      expect(screen.getByRole('searchbox')).toHaveProperty('value', '数据');
      fireEvent.keyDown(input, { key: 'Escape' });
      expect(screen.queryByRole('searchbox')).toBeNull();
    }
  );

  it('shows searching instead of the previous error while retry reads are pending', async () => {
    locale.value = 'en';
    const full = testAskEntry('retry', 'Fictional retry work');
    let release!: (value: unknown) => void;
    const pending = new Promise((resolve) => {
      release = resolve;
    });
    const read = vi
      .fn()
      .mockRejectedValueOnce(new Error('Synthetic unavailable'))
      .mockReturnValue(pending);
    const request = vi.fn((_method: string, input: { name: string }) =>
      input.name === 'neo.ask.read'
        ? read()
        : Promise.resolve({ ok: true, results: [], schedules: [] })
    );
    const hub = vi.spyOn(connectionManager, 'getHub').mockResolvedValue({ request } as never);
    try {
      const { model } = mount(true, true);
      act(() => {
        model.value = {
          ...model.value,
          snapshot: {
            ...model.value.snapshot,
            todoAsks: [
              { ...full, summary: { todoCount: 0, questionCount: 0, openQuestionCount: 0 } },
            ],
          },
        };
      });
      fireEvent.click(screen.getByRole('button', { name: 'Search work', exact: true }));
      fireEvent.input(screen.getByRole('searchbox'), { target: { value: 'Fictional' } });
      await screen.findByText('Could not search work. Close and reopen search to retry.');
      fireEvent.click(screen.getByRole('button', { name: 'Close work search', exact: true }));
      fireEvent.click(screen.getByRole('button', { name: 'Search work', exact: true }));
      fireEvent.input(screen.getByRole('searchbox'), { target: { value: 'Fictional' } });
      await waitFor(() => expect(read).toHaveBeenCalledTimes(2));
      expect(screen.getByText('Searching work…')).toBeTruthy();
      expect(
        screen.queryByText('Could not search work. Close and reopen search to retry.')
      ).toBeNull();
      release({ ok: true, entry: full });
      await screen.findByRole('heading', { name: 'Fictional retry work' });
    } finally {
      release({ ok: true, entry: full });
      hub.mockRestore();
    }
  });
});

function mount(publicMode = true, empty = false) {
  const snapshot = {
    historyCursor: undefined as NeoSnapshot['historyCursor'],
    sessionId: root,
    projects: ['a', 'b'].map((id) => ({
      id,
      title: `Fictional holder ${id}`,
      summary: 'Fictional context',
      context: 'Three fictional flowers',
      revision: 1,
      createdAt: 1,
      updatedAt: 1,
    })),
    work: [],
    needsYou: empty ? 0 : 1,
    neoUnhandled: 0,
    todoAsks: empty
      ? []
      : [testAskEntry('waiting', 'Fictional execution proposal', { state: 'waiting' })],
  };
  const model = signal({
    sessionId: root,
    snapshot,
    viewPublicConversation: publicMode
      ? {
          conversationId: root.slice(4),
          status: 'ready',
          entries: [] as NeoPublicEntry[],
          hasEarlier: false,
          hasMore: false,
        }
      : undefined,
    store: {
      sessionInfo: signal({ metadata: {} }),
      sdkMessages: signal([]),
      messagesLoaded: signal(true),
      activeSessionId: signal(root),
      loadErrorKind: signal(null),
      agentState: signal({ status: 'idle' }),
      error: signal(null),
      hasMoreMessages: signal(false),
      isWorking: signal(false),
      refresh: vi.fn(),
      destroy: vi.fn(),
    },
    busyWork: null as string | null,
    error: null,
    setError: vi.fn(),
    open: vi.fn(),
    send: vi.fn(),
    retry: vi.fn(),
    asks: { retry: vi.fn() },
    publications: { refresh: vi.fn() },
  });
  useNeoMock.mockImplementation(() => model.value);
  const view = render(<NeoLive />);
  const sheet = screen.queryByRole('button', { name: /^Your work/ });
  if (sheet) fireEvent.click(sheet);
  return { ...view, model };
}

describe('Topic chips by topic key', () => {
  const topical = () =>
    (
      [
        ['shop-p', 'Shop', 'p'],
        ['shop-q', 'Shop', 'q'],
        ['lower', 'kids', 'pick:kids'],
        ['upper', 'Kids', 'pick:kids'],
      ] as const
    ).map(([id, topic, topicKey]) => {
      const entry = testAskEntry(id, `Work ${id}`);
      entry.ask.topic = topic;
      entry.ask.topicKey = topicKey;
      return entry;
    });
  const show = () => {
    const view = mount();
    act(() => {
      view.model.value = {
        ...view.model.value,
        snapshot: { ...view.model.value.snapshot, todoAsks: topical() },
      };
    });
    return view;
  };
  const listed = (container: Element) =>
    [...container.querySelectorAll('[data-ask]')].map((node) => node.getAttribute('data-ask'));

  it('keeps same-titled projects apart, folds picks, and agrees across reload and the card button', () => {
    locale.value = 'en';
    const { container } = show();
    expect(
      within(container.querySelector('[data-topic-chips]') as HTMLElement)
        .getAllByRole('button')
        .map((chip) => chip.textContent)
    ).toEqual(['All 4', 'kids 2', 'Shop 1', 'Shop 1']);
    const [first, second] = screen.getAllByRole('button', { name: 'Shop 1' });
    fireEvent.click(first);
    expect(listed(container)).toEqual(['shop-p']);
    fireEvent.click(second);
    expect(listed(container)).toEqual(['shop-q']);
    fireEvent.click(screen.getByRole('button', { name: 'kids 2' }));
    expect(listed(container).sort()).toEqual(['lower', 'upper']);
    expect(localStorage.setItem).toHaveBeenLastCalledWith('neo:topic-filter', 'pick:kids');

    cleanup();
    vi.spyOn(localStorage, 'getItem').mockImplementation((key) =>
      key === 'neo:topic-filter' ? 'pick:kids' : null
    );
    const reloaded = show().container;
    expect(screen.getByRole('button', { name: 'kids 2' }).getAttribute('aria-pressed')).toBe(
      'true'
    );
    expect(listed(reloaded).sort()).toEqual(['lower', 'upper']);

    fireEvent.click(screen.getByRole('button', { name: 'All 4' }));
    const card = reloaded.querySelector('[data-ask="shop-q"]') as HTMLElement;
    fireEvent.click(within(card).getByRole('button', { name: 'Shop' }));
    expect(listed(reloaded)).toEqual(['shop-q']);
    expect(
      screen
        .getAllByRole('button', { name: 'Shop 1' })
        .map((chip) => chip.getAttribute('aria-pressed'))
    ).toEqual(['false', 'true']);
  });
});

describe('Neo public work scenes', () => {
  it('loads older outcomes only on request and allows retry without dropping current work', async () => {
    const old = testAskEntry('older', 'Older completed work', { state: 'done' });
    old.ask.status = 'done';
    const history = vi
      .fn()
      .mockRejectedValueOnce(new Error('History unavailable'))
      .mockResolvedValue({ ok: true, entries: [old], nextCursor: null });
    const request = vi.fn((_method: string, input: { name: string }) =>
      input.name === 'neo.ask.history'
        ? history()
        : Promise.resolve({ ok: true, results: [], schedules: [] })
    );
    const hub = vi.spyOn(connectionManager, 'getHub').mockResolvedValue({ request } as never);
    try {
      const { model, container } = mount();
      const current = model.value.snapshot.todoAsks;
      act(() => {
        model.value = {
          ...model.value,
          snapshot: {
            ...model.value.snapshot,
            historyCursor: { updatedAt: 100, id: 'last-recent' },
          },
        };
      });
      expect(history).not.toHaveBeenCalled();
      fireEvent.click(screen.getByRole('button', { name: 'Show older outcomes' }));
      await waitFor(() => expect(model.value.setError).toHaveBeenCalledWith('History unavailable'));
      fireEvent.click(screen.getByRole('button', { name: 'Show older outcomes' }));
      await waitFor(() => expect(container.querySelector('[data-ask="older"]')).toBeTruthy());
      expect(container.querySelector(`[data-ask="${current[0].ask.id}"]`)).toBeTruthy();
      expect(screen.queryByRole('button', { name: 'Show older outcomes' })).toBeNull();
      expect(history).toHaveBeenCalledTimes(2);
      expect(request).toHaveBeenCalledWith(
        'operation.invoke',
        expect.objectContaining({
          name: 'neo.ask.history',
          input: { before: { updatedAt: 100, id: 'last-recent' } },
        })
      );
    } finally {
      hub.mockRestore();
    }
  });
  it.each([true, false])('keeps an empty Work surface accessible on desktop=%s', (desktop) => {
    vi.stubGlobal('matchMedia', () => ({ matches: desktop }));
    const { container } = mount(true, true);
    expect(container.querySelector('.neo-shell')?.classList.contains('neo-has-scenes')).toBe(true);
    const work = screen.getByRole('region', { name: 'Work scenes' });
    expect(within(work).getByRole('status').textContent).toContain('Your inbox is empty');
    expect(work.querySelectorAll('[data-scene-group]')).toHaveLength(0);
    if (!desktop) {
      expect(within(work).queryByRole('heading', { name: 'Your work' })).toBeNull();
      const tabRow = work.querySelector('[data-work-tabs]')?.parentElement;
      expect(
        within(tabRow as HTMLElement).getByRole('button', { name: 'Close work list' })
      ).toBeTruthy();
      expect(
        within(tabRow as HTMLElement).getByRole('button', { name: 'Search work' })
      ).toBeTruthy();
      fireEvent.click(screen.getByRole('button', { name: 'Close work list' }));
      expect(screen.queryByRole('region', { name: 'Work scenes' })).toBeNull();
      fireEvent.click(screen.getByRole('button', { name: 'Your work' }));
      expect(screen.getByRole('region', { name: 'Work scenes' })).toBeTruthy();
    }
  });

  it('keeps every waiting card first, newest first, across unrelated snapshot updates', () => {
    const { container, model } = mount(true, true);
    const card = (id: string, state: 'waiting' | 'doing' | 'todo' | 'done', createdAt: number) => {
      const entry = testAskEntry(id, id, { state });
      entry.ask.createdAt = createdAt;
      return entry;
    };
    const blocked = card('blocked', 'doing', 50);
    blocked.todos = [testTodo('blocked-step', { state: 'blocked' })];
    const old = card('waiting-old', 'waiting', 10);
    old.todos = [testTodo('waiting-step', { state: 'blocked' })];
    const a = card('waiting-a', 'waiting', 20);
    const b = card('waiting-b', 'waiting', 20);
    const running = card('running', 'doing', 60);
    const queued = card('queued', 'todo', 70);
    const done = card('done', 'done', 80);
    const setCards = (todoAsks: typeof model.value.snapshot.todoAsks) =>
      act(() => {
        model.value = { ...model.value, snapshot: { ...model.value.snapshot, todoAsks } };
      });
    const order = () =>
      [...container.querySelectorAll('[data-ask]')].map((node) => node.getAttribute('data-ask'));
    const expected = [
      'waiting-a',
      'waiting-b',
      'waiting-old',
      'blocked',
      'running',
      'queued',
      'done',
    ];
    setCards([blocked, old, b, running, a, queued, done]);
    expect(order()).toEqual(expected);
    setCards([
      { ...old, ask: { ...old.ask, updatedAt: 999 } },
      a,
      blocked,
      b,
      running,
      queued,
      done,
    ]);
    expect(order()).toEqual(expected);
    setCards([blocked, running, { ...b, state: 'doing' }, a, old, queued, done]);
    expect(order()).toEqual([
      'waiting-a',
      'waiting-old',
      'blocked',
      'running',
      'waiting-b',
      'queued',
      'done',
    ]);
  });

  const card = (id: string, askId: string, createdAt: number, heldAt: number | null = null) =>
    ({
      id,
      askId,
      text: `Card ${id}`,
      kind: 'reply',
      options: null,
      multiple: false,
      noLabel: null,
      yesLabel: null,
      todos: [],
      state: 'open',
      answer: null,
      answeredBy: null,
      answeredAt: null,
      retiredReason: null,
      replacedBy: null,
      createdAt,
      heldAt,
    }) satisfies NeoQuestionEntry;
  const renderedOrder = (container: Element) =>
    [...container.querySelectorAll('[id^="neo-ref-question-"], [data-ask-todo]')].map(
      (node) => node.getAttribute('data-ask-todo') ?? node.id.replace('neo-ref-question-', '')
    );

  it('lists held cards across asks after unanswered ones and before work', () => {
    const { container, model } = mount(true, true);
    const a = testAskEntry('ask-a', 'Ask A', {
      state: 'waiting',
      todos: [testTodo('a-step', { askId: 'ask-a', state: 'blocked' })],
      questions: [card('a100', 'ask-a', 100), card('a-held20', 'ask-a', 20, 21)],
    });
    const b = testAskEntry('ask-b', 'Ask B', {
      state: 'waiting',
      todos: [testTodo('b-step', { askId: 'ask-b', state: 'blocked' })],
      questions: [card('b80', 'ask-b', 80), card('b-held90', 'ask-b', 90, 91)],
    });
    act(() => {
      model.value = { ...model.value, snapshot: { ...model.value.snapshot, todoAsks: [a, b] } };
    });
    expect(renderedOrder(container)).toEqual([
      'a100',
      'b80',
      'b-held90',
      'a-held20',
      'a-step',
      'b-step',
    ]);
  });

  it('shows the full document of a promoted card once its ask is read', async () => {
    const { model } = mount(true, true);
    const preview = `${'x'.repeat(2000)}\n\n[Document preview truncated]`;
    const full = testAskEntry('ask-doc', 'Ask with a long report', {
      state: 'waiting',
      questions: [{ ...card('doc', 'ask-doc', 50), document: `${'x'.repeat(2000)}TAIL-OF-REPORT` }],
    });
    const hub = vi
      .spyOn(connectionManager, 'getHub')
      .mockResolvedValue({ request: vi.fn(async () => ({ ok: true, entry: full })) } as never);
    try {
      act(() => {
        model.value = {
          ...model.value,
          snapshot: {
            ...model.value.snapshot,
            todoAsks: [
              {
                ...full,
                questions: [{ ...full.questions[0], document: preview }],
                summary: {
                  todoCount: 0,
                  questionCount: 1,
                  openQuestionCount: 1,
                  questionRefs: [{ id: 'doc', replacedBy: null }],
                },
              },
            ],
          },
        };
      });
      const promoted = document.querySelector<HTMLElement>('[data-neo-cards]')!;
      await waitFor(() => {
        fireEvent.click(within(promoted).getByRole('button', { name: 'View full report' }));
        expect(screen.getByRole('dialog').textContent).toContain('TAIL-OF-REPORT');
      });
    } finally {
      hub.mockRestore();
    }
  });

  it('lists unanswered cards across asks newest first, before held cards and work', () => {
    const { container, model } = mount(true, true);
    const a = testAskEntry('ask-a', 'Ask A', {
      state: 'waiting',
      todos: [testTodo('a-step', { askId: 'ask-a', state: 'blocked' })],
      questions: [
        card('a100', 'ask-a', 100),
        card('a10', 'ask-a', 10),
        card('a-held', 'ask-a', 120, 121),
      ],
    });
    const b = testAskEntry('ask-b', 'Ask B', {
      state: 'waiting',
      questions: [card('b80', 'ask-b', 80)],
    });
    const running = testAskEntry('running', 'Running', {
      state: 'doing',
      todos: [testTodo('run-step', { askId: 'running', state: 'doing' })],
    });
    act(() => {
      model.value = {
        ...model.value,
        snapshot: { ...model.value.snapshot, todoAsks: [b, running, a] },
      };
    });
    const order = [...container.querySelectorAll('[id^="neo-ref-question-"], [data-ask-todo]')].map(
      (node) => node.getAttribute('data-ask-todo') ?? node.id.replace('neo-ref-question-', '')
    );
    expect(order).toEqual(['a100', 'b80', 'a10', 'a-held', 'a-step', 'run-step']);
  });

  const waits = (id: string, askId: string, held = false) => ({
    state: held ? ('held' as const) : ('waiting' as const),
    askId,
    questionId: id,
    text: `Card ${id}`,
    todos: [],
  });

  it('lists each ask once per state as its full card, in its newest-card order', () => {
    const { container, model } = mount(true, true);
    const a = testAskEntry('ask-a', 'Ask A', {
      state: 'waiting',
      todos: [testTodo('a-step', { askId: 'ask-a', state: 'blocked' })],
      questions: [
        card('a100', 'ask-a', 100),
        card('a10', 'ask-a', 10),
        card('a-held', 'ask-a', 120, 121),
      ],
    });
    const b = testAskEntry('ask-b', 'Ask B', {
      state: 'waiting',
      questions: [card('b80', 'ask-b', 80)],
    });
    const running = testAskEntry('running', 'Running', {
      state: 'doing',
      todos: [testTodo('run-step', { askId: 'running', state: 'doing' })],
    });
    act(() => {
      model.value = {
        ...model.value,
        snapshot: {
          ...model.value.snapshot,
          todoAsks: [b, running, a],
          humanQueue: {
            items: [
              waits('a100', 'ask-a'),
              waits('b80', 'ask-b'),
              waits('a10', 'ask-a'),
              waits('a-held', 'ask-a', true),
              { state: 'progress', askId: 'ask-a', todoId: 'a-step', title: 'A step', owner: null },
              {
                state: 'progress',
                askId: 'running',
                todoId: 'run-step',
                title: 'Run step',
                owner: null,
              },
            ],
            counts: {
              'ask-a': { waiting: 2, held: 1, progress: 1 },
              'ask-b': { waiting: 1, held: 0, progress: 0 },
              running: { waiting: 0, held: 0, progress: 1 },
            },
          },
        } as never,
      };
    });
    const queue = container.querySelector('[data-human-queue]') as HTMLElement;
    const seen: string[] = [];
    for (const name of [/^Waiting on you/, /^Held/, /^In progress/]) {
      fireEvent.click(within(queue).getByRole('button', { name }));
      seen.push(
        ...[...container.querySelectorAll('[id^="neo-ref-question-"], [data-ask-todo]')].map(
          (node) => node.getAttribute('data-ask-todo') ?? node.id.replace('neo-ref-question-', '')
        )
      );
    }
    expect(seen).toEqual([
      ...['a100', 'a10', 'a-held', 'a-step', 'b80'],
      ...['a100', 'a10', 'a-held', 'a-step'],
      ...['a100', 'a10', 'a-held', 'a-step', 'run-step'],
    ]);
  });

  it('shows the full document of a queued card once its ask is read', async () => {
    const { model } = mount(true, true);
    const preview = `${'x'.repeat(2000)}\n\n[Document preview truncated]`;
    const full = testAskEntry('ask-doc', 'Ask with a long report', {
      state: 'waiting',
      questions: [{ ...card('doc', 'ask-doc', 50), document: `${'x'.repeat(2000)}TAIL-OF-REPORT` }],
    });
    vi.spyOn(connectionManager, 'getHub').mockResolvedValue({
      request: vi.fn(async () => ({ ok: true, entry: full })),
    } as never);
    act(() => {
      model.value = {
        ...model.value,
        snapshot: {
          ...model.value.snapshot,
          todoAsks: [
            {
              ...full,
              questions: [{ ...full.questions[0], document: preview }],
              summary: {
                todoCount: 0,
                questionCount: 1,
                openQuestionCount: 1,
                questionRefs: [{ id: 'doc', replacedBy: null }],
              },
            },
          ],
          humanQueue: {
            items: [waits('doc', 'ask-doc')],
            counts: { 'ask-doc': { waiting: 1, held: 0, progress: 0 } },
          },
        } as never,
      };
    });
    const queue = document.querySelector('[data-human-queue]') as HTMLElement;
    await waitFor(() => {
      fireEvent.click(within(queue).getByRole('button', { name: 'View full report' }));
      expect(screen.getByRole('dialog').textContent).toContain('TAIL-OF-REPORT');
    });
    expect(document.querySelectorAll('[id="neo-ref-question-doc"]')).toHaveLength(1);
  });

  it('keeps the empty legacy scene list collapsed without a public Work placeholder', () => {
    const { container } = mount(false, true);
    expect(screen.queryByText('Your inbox is empty')).toBeNull();
    expect(container.querySelector('.neo-has-scenes')).toBeNull();
    expect(container.querySelector('.neo-scene-list')?.childElementCount).toBe(0);
  });

  it('keeps the Work column when the last ask disappears and reuses it for new work', () => {
    const { container, model } = mount();
    const entries = model.value.snapshot.todoAsks;
    act(() => {
      model.value = { ...model.value, snapshot: { ...model.value.snapshot, todoAsks: [] } };
    });
    expect(container.querySelector('.neo-shell')?.classList.contains('neo-has-scenes')).toBe(true);
    expect(
      within(screen.getByRole('region', { name: 'Work scenes' })).getByRole('status').textContent
    ).toContain('Your inbox is empty');
    act(() => {
      model.value = { ...model.value, snapshot: { ...model.value.snapshot, todoAsks: entries } };
    });
    expect(screen.queryByText('Your inbox is empty')).toBeNull();
    expect(screen.getByRole('region', { name: 'Needs your attention' })).toBeTruthy();
  });

  it('reads the daemon counts instead of judging the loaded asks', () => {
    vi.stubGlobal('matchMedia', () => ({ matches: false }));
    const { model } = mount();
    const set = (counts: { needsYou?: number; neoUnhandled?: number }) =>
      act(() => {
        model.value = { ...model.value, snapshot: { ...model.value.snapshot, ...counts } };
      });
    set({ needsYou: 4, neoUnhandled: 2 });
    expect(screen.getByRole('button', { name: /^Your work, 4 need/, hidden: true })).toBeTruthy();
    expect(screen.getByRole('heading', { name: 'Needs your attention · 4' })).toBeTruthy();
    expect(screen.queryByText(/Waiting on Neo/)).toBeNull();
  });

  it('keeps a blocked ask with no card out of the human list', () => {
    vi.stubGlobal('matchMedia', () => ({ matches: false }));
    const { model } = mount();
    act(() => {
      model.value = {
        ...model.value,
        snapshot: {
          ...model.value.snapshot,
          needsYou: 0,
          neoUnhandled: 1,
          todoAsks: [
            testAskEntry('blocked', 'Blocked work', {
              state: 'doing',
              todos: [testTodo('b', { state: 'blocked' })],
            }),
          ],
        },
      };
    });
    expect(screen.queryByRole('region', { name: 'Needs your attention' })).toBeNull();
    expect(screen.getByRole('button', { name: 'Your work', hidden: true })).toBeTruthy();
    expect(screen.queryByText(/Waiting on Neo to check or unblock/)).toBeNull();
  });

  it('shows no pending check banner and only work scene groups in legacy mode', () => {
    const { container } = mount(false);
    expect(screen.getByRole('region', { name: 'Work scenes' })).toBeTruthy();
    expect(container.textContent).not.toContain('Checking with');
    expect(screen.queryByRole('button', { name: 'Stop waiting' })).toBeNull();
    expect(screen.queryByRole('region', { name: 'Recent outcomes' })).toBeNull();
  });
});

function mountCard(state: NeoQuestionEntry['state'] = 'open', replacement = false) {
  const view = mount();
  const question: NeoQuestionEntry = {
    id: 'q1',
    askId: 'waiting',
    text: 'Choose a sign-off',
    kind: 'choice',
    options: ['Approve', 'Revise'],
    multiple: false,
    noLabel: null,
    yesLabel: null,
    todos: [],
    state,
    answer: state === 'answered' ? ['Approve'] : null,
    answeredBy: state === 'answered' ? 'button' : null,
    answeredAt: null,
    retiredReason: 'No longer needed',
    replacedBy: replacement ? 'q2' : null,
    createdAt: 1,
  };
  const publication: NeoPublication = {
    conversationId: root.slice(4),
    publicationId: '20000000-0000-4000-8000-000000000001',
    sequence: 1,
    createdAt: '2026-10-24T12:00:00Z',
    shortText: 'I replied · View card · Choose a sign-off',
    fullText: 'Do not copy these options into chat',
    links: [],
    cardReply: {
      sourceMessageIds: ['30000000-0000-4000-8000-000000000001'],
      askId: 'waiting',
      questionId: 'q1',
      mutationId: '40000000-0000-4000-8000-000000000001',
    },
  };
  const questions = [
    question,
    ...(replacement
      ? [
          {
            ...question,
            id: 'q2',
            text: 'Replacement sign-off',
            state: 'open' as const,
            replacedBy: null,
          },
        ]
      : []),
  ];
  act(() => {
    view.model.value = {
      ...view.model.value,
      snapshot: {
        ...view.model.value.snapshot,
        todoAsks: [testAskEntry('waiting', 'Sign-off card', { questions })],
      },
      viewPublicConversation: {
        ...view.model.value.viewPublicConversation!,
        entries: [{ kind: 'publication', key: 'card-reply', publication, replyTo: null }],
      },
    };
  });
  return view;
}

describe('card reply notice navigation', () => {
  it('clears a Work filter when opening a linked settled question', async () => {
    mountCard('answered');
    fireEvent.click(screen.getByRole('button', { name: 'Search work', exact: true }));
    fireEvent.input(screen.getByRole('searchbox'), { target: { value: 'missingword999' } });
    await screen.findByText('No matching work');
    fireEvent.click(screen.getByRole('button', { name: /I replied · View card/ }));
    const dialog = await screen.findByRole('dialog', { name: 'Sign-off card' });
    expect(await within(dialog).findByText('Choose a sign-off')).toBeTruthy();
    expect(screen.queryByRole('searchbox')).toBeNull();
  });

  it.each([true, false])('opens the exact paged done todo with owner loaded=%s', async (loaded) => {
    const { model } = mount();
    const todos = Array.from({ length: 25 }, (_, index) =>
      testTodo(`d${index + 1}`, { state: 'done' })
    );
    const full = testAskEntry('finished', 'Completed reference card', {
      state: 'done',
      todos,
      doneCount: 25,
    });
    const request = vi.fn(
      async (_method: string, params: { name: string; input: { offset?: number } }) => {
        if (params.name === 'neo.ask.read') return { ok: true, entry: full };
        if (params.name === 'neo.ask.doneTodos') {
          const offset = params.input.offset ?? 0;
          return {
            ok: true,
            todos: todos.slice(offset, offset + 20),
            doneCount: 25,
            nextOffset: offset === 0 ? 20 : null,
          };
        }
        return { ok: true, results: [], schedules: [] };
      }
    );
    const hub = vi.spyOn(connectionManager, 'getHub').mockResolvedValue({ request } as never);
    try {
      act(() => {
        model.value = {
          ...model.value,
          snapshot: {
            ...model.value.snapshot,
            todoAsks: loaded
              ? [
                  {
                    ...full,
                    todos: [],
                    summary: { todoCount: 25, questionCount: 0, openQuestionCount: 0 },
                  },
                ]
              : [],
          },
          viewPublicConversation: {
            ...model.value.viewPublicConversation!,
            entries: [
              {
                kind: 'ask',
                key: 'done-quote',
                ask: {
                  conversationId: root.slice(4),
                  requestId: '20000000-0000-4000-8000-000000000006',
                  askOrigin: { sessionId: root, messageId: 'quoted-done' },
                  content: 'Discuss this completed work',
                  replyTo: { kind: 'todo', id: 'd25', excerpt: 'Completed target quote' },
                  sequence: 1,
                  createdAt: '2026-10-24T12:00:00Z',
                },
              },
            ],
          },
        };
      });
      fireEvent.click(screen.getByRole('button', { name: /Completed target quote/ }));
      const dialog = await screen.findByRole('dialog', { name: 'Completed reference card' });
      await waitFor(() => expect(document.activeElement?.id).toBe('neo-ref-todo-d25'));
      expect(dialog.contains(document.activeElement)).toBe(true);
      expect(
        request.mock.calls
          .filter(([, params]) => params.name === 'neo.ask.doneTodos')
          .map(([, params]) => params.input.offset)
      ).toEqual([0, 20]);
    } finally {
      hub.mockRestore();
    }
  });

  it.each([
    ['an uncovered todo in progress', 'garage', 'In progress 1'],
    ['a finished todo of an open ask', 'oil', null],
  ])('opens a quoted reference to %s from the queue', async (_name, todoId, chip) => {
    const { model } = mount();
    const oil = testTodo('oil', { title: 'Fictional oil', state: 'done' });
    vi.spyOn(connectionManager, 'getHub').mockResolvedValue({
      request: vi.fn(async (_method: string, params: { name: string }) =>
        params.name === 'neo.ask.doneTodos'
          ? { ok: true, todos: [oil], doneCount: 1, nextOffset: null }
          : params.name === 'neo.ask.read'
            ? { ok: true, entry: testAskEntry('tax', 'Fictional tax', { state: 'waiting' }) }
            : { ok: true, results: [], schedules: [] }
      ),
    } as never);
    act(() => {
      model.value = {
        ...model.value,
        snapshot: {
          ...model.value.snapshot,
          todoAsks: [
            testAskEntry('car', 'Fictional car service', {
              state: 'doing',
              todos: [testTodo('garage', { title: 'Fictional garage', state: 'doing' }), oil],
              doneCount: 1,
            }),
          ],
          humanQueue: {
            items: [
              {
                state: 'waiting',
                askId: 'tax',
                questionId: 'qt',
                text: 'Fictional tax?',
                todos: [],
              },
              {
                state: 'progress',
                askId: 'car',
                todoId: 'garage',
                title: 'Fictional garage',
                owner: 'worker',
              },
            ],
            counts: {
              tax: { waiting: 1, held: 0, progress: 0 },
              car: { waiting: 0, held: 0, progress: 1 },
            },
          },
        } as never,
        viewPublicConversation: {
          ...model.value.viewPublicConversation!,
          entries: [
            {
              kind: 'ask',
              key: 'todo-quote',
              ask: {
                conversationId: root.slice(4),
                requestId: '20000000-0000-4000-8000-000000000007',
                askOrigin: { sessionId: root, messageId: 'quoted-todo' },
                content: 'About this step',
                replyTo: { kind: 'todo', id: todoId, excerpt: 'Quoted step target' },
                sequence: 1,
                createdAt: '2026-10-24T12:00:00Z',
              },
            },
          ],
        },
      };
    });
    fireEvent.click(screen.getByRole('button', { name: /Quoted step target/ }));
    await waitFor(() => expect(document.activeElement?.id).toBe(`neo-ref-todo-${todoId}`));
    if (chip)
      expect(screen.getByRole('button', { name: chip }).getAttribute('aria-pressed')).toBe('true');
    fireEvent.click(
      within(screen.getByRole('group', { name: 'State' })).getByRole('button', {
        name: 'In progress 1',
      })
    );
    for (const id of ['neo-ref-ask-car', 'neo-ref-todo-garage', `neo-ref-todo-${todoId}`])
      expect(document.querySelectorAll(`[id="${id}"]`)).toHaveLength(1);
  });

  it('counts only the reference card it lists under Needs your attention', async () => {
    const { model } = mount();
    const oil = testTodo('oil', { title: 'Fictional oil', state: 'done' });
    vi.spyOn(connectionManager, 'getHub').mockResolvedValue({
      request: vi.fn(async (_method: string, params: { name: string }) =>
        params.name === 'neo.ask.doneTodos'
          ? { ok: true, todos: [oil], doneCount: 1, nextOffset: null }
          : { ok: true, results: [], schedules: [] }
      ),
    } as never);
    act(() => {
      model.value = {
        ...model.value,
        snapshot: {
          ...model.value.snapshot,
          needsYou: 5,
          todoAsks: [
            testAskEntry('car', 'Fictional car service', {
              state: 'waiting',
              todos: [oil],
              doneCount: 1,
            }),
          ],
          humanQueue: {
            items: [{ state: 'waiting', askId: 'car', questionId: 'qc', text: 'Car?', todos: [] }],
            counts: { car: { waiting: 1, held: 0, progress: 0 } },
          },
        } as never,
        viewPublicConversation: {
          ...model.value.viewPublicConversation!,
          entries: [
            {
              kind: 'ask',
              key: 'oil-quote',
              ask: {
                conversationId: root.slice(4),
                requestId: '20000000-0000-4000-8000-000000000008',
                askOrigin: { sessionId: root, messageId: 'quoted-oil' },
                content: 'About the oil',
                replyTo: { kind: 'todo', id: 'oil', excerpt: 'Quoted oil target' },
                sequence: 1,
                createdAt: '2026-10-24T12:00:00Z',
              },
            },
          ],
        },
      };
    });
    fireEvent.click(screen.getByRole('button', { name: /Quoted oil target/ }));
    await waitFor(() => expect(document.activeElement?.id).toBe('neo-ref-todo-oil'));
    const group = screen.getByRole('region', { name: 'Needs your attention' });
    expect(group.querySelector('h2')?.textContent).toBe('Needs your attention · 1');
  });

  it.each(['topic', 'tab'] as const)('drops a %s that hides an opened reference', async (hider) => {
    const { model } = mount();
    const trip = testAskEntry('trip', 'Fictional trip', { state: 'doing' });
    trip.ask.topic = 'Travel';
    trip.ask.topicKey = 'Travel';
    const tax = testAskEntry('tax', 'Fictional tax', {
      state: 'doing',
      todos: [testTodo('tax-step', { title: 'tax step', state: 'doing' })],
    });
    tax.ask.topic = 'Money';
    tax.ask.topicKey = 'Money';
    const progress = (askId: string) => ({
      state: 'progress' as const,
      askId,
      todoId: `${askId}-step`,
      title: `${askId} step`,
      owner: 'worker' as const,
    });
    act(() => {
      model.value = {
        ...model.value,
        snapshot: {
          ...model.value.snapshot,
          todoAsks: [trip, tax],
          humanQueue:
            hider === 'topic'
              ? undefined
              : {
                  items: [progress('trip'), progress('tax')],
                  counts: {
                    trip: { waiting: 0, held: 0, progress: 1 },
                    tax: { waiting: 0, held: 0, progress: 1 },
                  },
                },
        } as never,
        viewPublicConversation: {
          ...model.value.viewPublicConversation!,
          entries: [
            {
              kind: 'ask',
              key: 'tax-quote',
              ask: {
                conversationId: root.slice(4),
                requestId: '20000000-0000-4000-8000-000000000009',
                askOrigin: { sessionId: root, messageId: 'quoted-tax' },
                content: 'About the tax step',
                replyTo: { kind: 'todo', id: 'tax-step', excerpt: 'Quoted tax target' },
                sequence: 1,
                createdAt: '2026-10-24T12:00:00Z',
              },
            },
          ],
        },
      };
    });
    const hide = hider === 'topic' ? 'Travel 1' : 'Goals';
    fireEvent.click(screen.getByRole('button', { name: hide }));
    fireEvent.click(screen.getByRole('button', { name: /Quoted tax target/ }));
    await waitFor(() => expect(document.activeElement?.id).toBe('neo-ref-todo-tax-step'));
    expect(screen.getByRole('button', { name: hide }).getAttribute('aria-pressed')).toBe('false');
  });

  it.each([
    [null, false],
    ['Money', false],
    ['Money', true],
    ['Travel', true],
  ])(
    'opens a child todo quote on its own full todo, saved topic %s, searching %s',
    async (topic, searching) => {
      vi.spyOn(localStorage, 'getItem').mockImplementation((key) =>
        key === 'neo:topic-filter' ? topic : null
      );
      const { model } = mount();
      const card = {
        id: 'qp',
        askId: 'trip',
        text: 'Parent card?',
        kind: 'yesno',
        options: null,
        multiple: false,
        noLabel: 'No',
        yesLabel: 'Agree',
        todos: ['hotel'],
        state: 'open',
        answer: null,
        answeredBy: null,
        answeredAt: null,
        retiredReason: null,
        replacedBy: null,
        createdAt: 1,
      };
      act(() => {
        model.value = {
          ...model.value,
          snapshot: {
            ...model.value.snapshot,
            todoAsks: [
              {
                ...testAskEntry('trip', 'Fictional trip', {
                  state: 'waiting',
                  questions: [card as never],
                }),
                ask: {
                  ...testAskEntry('trip', 'Fictional trip').ask,
                  topic: 'Travel',
                  topicKey: 'Travel',
                },
              },
              {
                ...testAskEntry('hotel-ask', 'Fictional hotel booking', {
                  state: 'doing',
                  todos: [testTodo('hotel', { title: 'Fictional hotel', state: 'doing' })],
                }),
                ask: {
                  ...testAskEntry('hotel-ask', 'Fictional hotel booking').ask,
                  topic: 'Money',
                  topicKey: 'Money',
                },
              },
            ],
            humanQueue: {
              items: [
                {
                  state: 'waiting',
                  askId: 'trip',
                  questionId: 'qp',
                  text: 'Parent card?',
                  todos: [{ id: 'hotel', title: 'Fictional hotel' }],
                },
              ],
              counts: { trip: { waiting: 1, held: 0, progress: 0 } },
            },
          } as never,
          viewPublicConversation: {
            ...model.value.viewPublicConversation!,
            entries: [
              {
                kind: 'ask',
                key: 'hotel-quote',
                ask: {
                  conversationId: root.slice(4),
                  requestId: '20000000-0000-4000-8000-000000000010',
                  askOrigin: { sessionId: root, messageId: 'quoted-hotel' },
                  content: 'About the hotel',
                  replyTo: { kind: 'todo', id: 'hotel', excerpt: 'Quoted hotel target' },
                  sequence: 1,
                  createdAt: '2026-10-24T12:00:00Z',
                },
              },
            ],
          },
        };
      });
      const child = document.querySelector('article[data-ask="hotel-ask"]') as HTMLElement;
      expect(
        within(child).getByRole('button', { name: 'Step actions: Fictional hotel' })
      ).toBeTruthy();
      if (searching) {
        fireEvent.click(screen.getByRole('button', { name: 'Search work', exact: true }));
        fireEvent.input(screen.getByRole('searchbox'), { target: { value: 'Fictional' } });
      }
      fireEvent.click(screen.getByRole('button', { name: /Quoted hotel target/ }));
      await waitFor(() => expect(document.activeElement?.id).toBe('neo-ref-todo-hotel'));
      expect(document.activeElement?.closest('[data-ask="hotel-ask"]')).toBeTruthy();
      expect(document.querySelectorAll('[id="neo-ref-todo-hotel"]')).toHaveLength(1);
    }
  );

  it('holds and takes back cards found by work search', async () => {
    const { model } = mount();
    const holdQuestion = vi.fn();
    const card = (id: string, text: string, heldAt: number | null) => ({
      id,
      askId: 'trip',
      text,
      kind: 'yesno',
      options: null,
      multiple: false,
      noLabel: 'No',
      yesLabel: 'Agree',
      todos: [],
      state: 'open',
      answer: null,
      answeredBy: null,
      answeredAt: null,
      retiredReason: null,
      replacedBy: null,
      createdAt: 1,
      ...(heldAt ? { heldAt } : {}),
    });
    act(() => {
      model.value = {
        ...model.value,
        holdQuestion,
        snapshot: {
          ...model.value.snapshot,
          todoAsks: [
            testAskEntry('trip', 'Fictional searchable trip', {
              state: 'waiting',
              questions: [
                card('qh', 'Held question?', 5),
                card('qw', 'Waiting question?', null),
              ] as never,
            }),
          ],
          humanQueue: {
            items: [
              { state: 'held', askId: 'trip', questionId: 'qh', text: 'Held question?', todos: [] },
              {
                state: 'waiting',
                askId: 'trip',
                questionId: 'qw',
                text: 'Waiting question?',
                todos: [],
              },
            ],
            counts: { trip: { waiting: 1, held: 1, progress: 0 } },
          },
        },
      } as never;
    });
    fireEvent.click(screen.getByRole('button', { name: 'Search work', exact: true }));
    fireEvent.input(screen.getByRole('searchbox'), { target: { value: 'searchable' } });
    const held = (await screen.findByText('Held question?')).closest('[data-ask-question]');
    expect(within(held as HTMLElement).getByText('On hold')).toBeTruthy();
    fireEvent.click(within(held as HTMLElement).getByRole('button', { name: 'Take back' }));
    expect(holdQuestion).toHaveBeenCalledWith('qh', false);
    const waiting = (await screen.findByText('Waiting question?')).closest('[data-ask-question]');
    fireEvent.click(within(waiting as HTMLElement).getByRole('button', { name: 'Hold' }));
    expect(holdQuestion).toHaveBeenCalledWith('qw', true);
  });

  it('reports a failed queue refresh after a stale card and retries on request', async () => {
    const { model } = mount();
    const refresh = vi
      .fn()
      .mockRejectedValueOnce(new Error('Snapshot offline'))
      .mockResolvedValue(undefined);
    const setError = vi.fn();
    const card = (state: string) => ({
      id: 'q1',
      askId: 'trip',
      text: 'Stale card?',
      kind: 'yesno',
      options: null,
      multiple: false,
      noLabel: 'No',
      yesLabel: 'Agree',
      todos: [],
      state,
      answer: null,
      answeredBy: null,
      answeredAt: null,
      retiredReason: null,
      replacedBy: null,
      createdAt: 1,
    });
    vi.spyOn(connectionManager, 'getHub').mockResolvedValue({
      request: vi.fn(async (_method: string, params: { name: string }) =>
        params.name === 'neo.ask.read'
          ? {
              ok: true,
              entry: testAskEntry('trip', 'Fictional trip', {
                state: 'waiting',
                questions: [card('answered') as never],
              }),
            }
          : { ok: true, results: [], schedules: [] }
      ),
    } as never);
    act(() => {
      model.value = {
        ...model.value,
        refresh,
        setError,
        snapshot: {
          ...model.value.snapshot,
          todoAsks: [
            {
              ...testAskEntry('trip', 'Fictional trip', {
                state: 'waiting',
                questions: [card('open') as never],
              }),
              summary: { todoCount: 0, questionCount: 1, openQuestionCount: 1 },
            },
          ],
          humanQueue: {
            items: [
              { state: 'waiting', askId: 'trip', questionId: 'q1', text: 'Stale card?', todos: [] },
            ],
            counts: { trip: { waiting: 1, held: 0, progress: 0 } },
          },
        },
      } as never;
    });
    await waitFor(() => expect(setError).toHaveBeenCalledWith('Snapshot offline'));
    const alert = await screen.findByText('Couldn’t refresh the queue.');
    fireEvent.click(
      within(alert.closest('[role="alert"]') as HTMLElement).getByRole('button', { name: 'Retry' })
    );
    await waitFor(() => expect(refresh).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(screen.queryByText('Couldn’t refresh the queue.')).toBeNull());
  });

  it('reaches the ask actions and todo controls from a queue group', () => {
    const { model } = mount();
    act(() => {
      model.value = {
        ...model.value,
        snapshot: {
          ...model.value.snapshot,
          todoAsks: [
            testAskEntry('trip', 'Fictional trip', {
              state: 'doing',
              todos: [testTodo('hotel', { title: 'Fictional hotel', state: 'doing' })],
            }),
          ],
          humanQueue: {
            items: [
              {
                state: 'progress',
                askId: 'trip',
                todoId: 'hotel',
                title: 'Fictional hotel',
                owner: 'worker',
              },
            ],
            counts: { trip: { waiting: 0, held: 0, progress: 1 } },
          },
        } as never,
      };
    });
    fireEvent.click(screen.getByRole('button', { name: 'In progress 1' }));
    const queue = screen.getByRole('region', { name: 'Fictional trip' });
    expect(within(queue).getByRole('button', { name: 'Ask actions' })).toBeTruthy();
    expect(
      within(queue).getByRole('button', { name: 'Step actions: Fictional hotel' })
    ).toBeTruthy();
  });

  it('keeps listing an open ask the queue holds nothing for', () => {
    const { model } = mount();
    act(() => {
      model.value = {
        ...model.value,
        snapshot: {
          ...model.value.snapshot,
          todoAsks: [
            testAskEntry('tax', 'Fictional tax', { state: 'doing' }),
            testAskEntry('empty', 'Fictional empty ask', { state: 'todo' }),
          ],
          humanQueue: {
            items: [
              {
                state: 'progress',
                askId: 'tax',
                todoId: 'tax-step',
                title: 'tax step',
                owner: 'worker',
              },
            ],
            counts: { tax: { waiting: 0, held: 0, progress: 1 } },
          },
        } as never,
      };
    });
    expect(document.querySelector('[data-ask="empty"]')).toBeTruthy();
    expect(document.querySelector('article[data-ask="tax"]')).toBeNull();
  });

  it('ignores a saved topic and makes topic badges read-only when queue filters are shown', () => {
    vi.spyOn(localStorage, 'getItem').mockImplementation((key) =>
      key === 'neo:topic-filter' ? 'Travel' : null
    );
    const { model, container } = mount();
    const trip = testAskEntry('trip', 'Fictional trip', { state: 'doing' });
    trip.ask.topic = 'Travel';
    trip.ask.topicKey = 'Travel';
    const tax = testAskEntry('tax', 'Fictional tax', { state: 'doing' });
    tax.ask.topic = 'Money';
    tax.ask.topicKey = 'Money';
    const progress = (askId: string) => ({
      state: 'progress' as const,
      askId,
      todoId: `${askId}-step`,
      title: `${askId} step`,
      owner: 'worker' as const,
    });
    act(() => {
      model.value = {
        ...model.value,
        snapshot: {
          ...model.value.snapshot,
          todoAsks: [trip, tax],
          humanQueue: {
            items: [progress('trip'), progress('tax')],
            counts: {
              trip: { waiting: 0, held: 0, progress: 1 },
              tax: { waiting: 0, held: 0, progress: 1 },
            },
          },
        } as never,
      };
    });
    expect(container.querySelector('[data-topic-chips]')).toBeNull();
    const states = within(screen.getByRole('group', { name: 'State' }));
    const asks = within(screen.getByRole('group', { name: 'Ask' }));
    fireEvent.click(states.getByRole('button', { name: 'In progress 2' }));
    const badge = screen.getByRole('button', { name: 'Travel', exact: true }) as HTMLButtonElement;
    expect(badge.disabled).toBe(true);
    expect(screen.getByRole('region', { name: 'Fictional tax' })).toBeTruthy();
    fireEvent.click(asks.getByRole('button', { name: 'Fictional trip 1' }));
    expect(screen.getByRole('region', { name: 'Fictional trip' })).toBeTruthy();
    expect(screen.queryByRole('region', { name: 'Fictional tax' })).toBeNull();
  });

  it.each(['answered', 'retired'] as const)(
    'loads an off-window %s question into All',
    async (state) => {
      const { model } = mountCard(state);
      const full = model.value.snapshot.todoAsks[0];
      const request = vi.fn(async () => ({ ok: true, entry: full }));
      const hub = vi.spyOn(connectionManager, 'getHub').mockResolvedValue({ request } as never);
      try {
        act(() => {
          model.value = { ...model.value, snapshot: { ...model.value.snapshot, todoAsks: [] } };
        });
        fireEvent.click(screen.getByRole('button', { name: /I replied · View card/ }));
        const dialog = await screen.findByRole('dialog', { name: 'Sign-off card' });
        await waitFor(() => expect(document.activeElement?.id).toBe('neo-ref-question-q1'));
        expect(dialog.contains(document.activeElement)).toBe(true);
        expect(screen.queryByRole('button', { name: /^A.*Approve/ })).toBeNull();
      } finally {
        hub.mockRestore();
      }
    }
  );

  it('does not open a late reference after returning to chat', async () => {
    const { model } = mountCard('answered');
    const full = model.value.snapshot.todoAsks[0];
    let finish!: (value: unknown) => void;
    const request = vi.fn((_method: string, params: { name: string }) =>
      params.name === 'neo.ask.read'
        ? new Promise((resolve) => {
            finish = resolve;
          })
        : Promise.resolve({ ok: true, results: [], schedules: [] })
    );
    const hub = vi.spyOn(connectionManager, 'getHub').mockResolvedValue({ request } as never);
    try {
      act(() => {
        model.value = { ...model.value, snapshot: { ...model.value.snapshot, todoAsks: [] } };
      });
      fireEvent.click(screen.getByRole('button', { name: /I replied · View card/ }));
      await screen.findByText('Opening work…');
      await waitFor(() => expect(finish).toBeTypeOf('function'));
      fireEvent.click(screen.getByRole('button', { name: 'Back to chat' }));
      await act(async () => finish({ ok: true, entry: full }));
      expect(screen.queryByRole('dialog', { name: 'Sign-off card' })).toBeNull();
      expect(screen.queryByRole('article', { name: 'Sign-off card' })).toBeNull();
    } finally {
      hub.mockRestore();
    }
  });

  it.each(['pending', 'failed'])(
    'keeps a %s card read stable while editing the draft',
    async (state) => {
      let resolve!: (value: unknown) => void;
      let reject!: (cause: Error) => void;
      const pending = new Promise((yes, no) => {
        resolve = yes;
        reject = no;
      });
      const read = vi.fn(() => pending);
      const request = vi.fn((_method: string, params: { name: string }) =>
        params.name === 'neo.ask.read'
          ? read()
          : Promise.resolve({ ok: true, results: [], schedules: [] })
      );
      const hub = vi.spyOn(connectionManager, 'getHub').mockResolvedValue({ request } as never);
      try {
        const { model, container } = mountCard('open');
        const full = model.value.snapshot.todoAsks[0];
        act(() => {
          model.value = {
            ...model.value,
            snapshot: {
              ...model.value.snapshot,
              todoAsks: [
                {
                  ...full,
                  questions: [],
                  summary: { todoCount: 0, questionCount: 1, openQuestionCount: 1 },
                },
              ],
            },
          };
        });
        fireEvent.click(container.querySelector('[data-ask="waiting"] [data-ask-details-toggle]')!);
        await waitFor(() => expect(read).toHaveBeenCalledTimes(1));
        if (state === 'failed') {
          await act(async () => reject(new Error('Full card unavailable')));
          expect(await screen.findByText('Full card unavailable')).toBeTruthy();
        }
        await act(async () => {
          fireEvent.input(screen.getByRole('textbox', { name: 'Draft' }), {
            target: { value: 'Unsent draft' },
          });
        });
        expect(read).toHaveBeenCalledTimes(1);
        if (state === 'pending') {
          await act(async () => resolve({ ok: true, entry: full }));
          expect(await screen.findByRole('button', { name: /Approve/ })).toBeTruthy();
        } else expect(screen.getByText('Full card unavailable')).toBeTruthy();
      } finally {
        hub.mockRestore();
      }
    }
  );
  it('keeps question reply quotes readable when their card is summarized', async () => {
    const { model } = mountCard('open');
    const full = model.value.snapshot.todoAsks[0];
    act(() => {
      model.value = {
        ...model.value,
        snapshot: {
          ...model.value.snapshot,
          todoAsks: [
            {
              ...full,
              questions: [],
              summary: {
                todoCount: 0,
                questionCount: 1,
                openQuestionCount: 1,
                questionRefs: [{ id: 'q1', replacedBy: null }],
              },
            },
          ],
        },
        viewPublicConversation: {
          ...model.value.viewPublicConversation!,
          entries: [
            {
              kind: 'ask',
              key: 'question-reply',
              ask: {
                conversationId: root.slice(4),
                requestId: 'reply',
                askOrigin: { sessionId: root, messageId: 'reply' },
                sequence: 1,
                createdAt: '2026-10-24T12:00:00Z',
                content: 'My sign-off reply',
                replyTo: { kind: 'question', id: 'q1' },
              },
            },
          ],
        },
      };
    });
    expect(await screen.findByRole('button', { name: 'Neo Sign-off card' })).toBeTruthy();
    expect(screen.queryByText('Original message unavailable')).toBeNull();
  });

  it('opens full question details from a wake link into a summarized card', async () => {
    const { model } = mountCard('open');
    const full = model.value.snapshot.todoAsks[0];
    const hub = vi
      .spyOn(connectionManager, 'getHub')
      .mockResolvedValue({ request: vi.fn(async () => ({ ok: true, entry: full })) } as never);
    try {
      act(() => {
        model.value = {
          ...model.value,
          snapshot: {
            ...model.value.snapshot,
            todoAsks: [
              {
                ...full,
                questions: [],
                summary: {
                  todoCount: 0,
                  questionCount: 1,
                  openQuestionCount: 1,
                  questionRefs: [{ id: 'q1', replacedBy: null }],
                },
              },
            ],
          },
          viewPublicConversation: {
            ...model.value.viewPublicConversation!,
            entries: [
              {
                kind: 'wake',
                key: 'question-wake',
                wake: {
                  scheduleId: 'schedule',
                  sourceKind: 'session',
                  sourceId: root,
                  title: 'Review sign-off',
                  firedAt: 1,
                  settledAt: 2,
                  summary: 'Question added',
                  additions: [{ kind: 'question', id: 'q1', label: 'Open sign-off question' }],
                },
              },
            ],
          },
        };
      });
      expect(screen.queryByText('Open sign-off question')).toBeNull();
      fireEvent.click(screen.getByRole('button', { name: 'Scheduled' }));
      fireEvent.click(screen.getByText('Open sign-off question'));
      await waitFor(() =>
        expect(document.querySelector('[data-card-reply-focus]')?.id).toBe('neo-ref-question-q1')
      );
      expect(screen.getByRole('button', { name: /Approve/ })).toBeTruthy();
    } finally {
      hub.mockRestore();
    }
  });
  it.each([
    [900, false],
    [900, true],
    [2600, false],
    [2600, true],
  ] as const)(
    'opens a card without discarding preview at %s reference=%s',
    async (width, reference) => {
      vi.stubGlobal('matchMedia', (media: string) => ({
        matches: width >= Number(media.match(/min-width:\s*(\d+)/)?.[1] ?? 99999),
      }));
      const hub = vi.spyOn(connectionManager, 'getHub').mockRejectedValue(new Error('offline'));
      try {
        const { container } = mountCard();
        const work = container.querySelector<HTMLElement>('.neo-scene-list')!;
        act(() =>
          openArtifactPreview(
            reference
              ? { kind: 'reference', source: { kind: 'todo', id: 'todo' }, reference: 'report.md' }
              : { kind: 'artifact', artifactId: 'synthetic' },
            'Document'
          )
        );
        const preview = screen.getByRole('dialog');
        expect(work.hidden).toBe(width < 2400);
        fireEvent.click(screen.getByRole('button', { name: /I replied · View card/ }));
        await waitFor(() => expect(document.activeElement?.id).toBe('neo-ref-question-q1'));
        expect(work.hidden).toBe(false);
        if (reference || width >= 2400)
          expect(artifactPreviewStack.value.at(-1)?.kind).toBe(
            reference ? 'reference' : 'artifact'
          );
        else
          expect(
            screen.getByRole('tab', { name: 'Your work · 1' }).getAttribute('aria-selected')
          ).toBe('true');
        expect(screen.getByRole('button', { name: /Approve/ })).toBeTruthy();
        fireEvent.click(screen.getByRole('button', { name: 'Back to chat' }));
        expect(container.querySelector('[data-card-reply-focus]')).toBeNull();
        expect(screen.getByRole('dialog')).toBe(preview);
      } finally {
        act(() => closeArtifactPreview());
        hub.mockRestore();
      }
    }
  );

  it.each([true, false])('opens and returns to chat position on desktop=%s', async (desktop) => {
    vi.stubGlobal('matchMedia', () => ({ matches: desktop }));
    const { container } = mountCard();
    if (!desktop) fireEvent.click(screen.getByRole('button', { name: 'Close work list' }));
    const rail = container.querySelector<HTMLElement>(desktop ? '.neo-chat-rail' : '.neo-scroll')!;
    rail.scrollTop = 175;
    const notice = screen.getByRole('button', { name: /I replied · View card/ });
    expect(notice.textContent).toContain('Choose a sign-off');
    expect(notice.textContent).not.toContain('Approve');
    fireEvent.click(notice);
    await waitFor(() => expect(document.activeElement?.id).toBe('neo-ref-question-q1'));
    expect(screen.getByRole('button', { name: /Approve/ })).toBeTruthy();
    expect(container.querySelector('[data-card-reply-focus]')).toBeTruthy();
    rail.scrollTop = 900;
    fireEvent.click(screen.getByRole('button', { name: 'Back to chat' }));
    await waitFor(() => expect(rail.scrollTop).toBe(175));
  });
  it('localizes a saved English notice into Chinese without copying options', () => {
    const previous = locale.value;
    try {
      locale.value = 'zh-Hans';
      mountCard();
      const notice = screen.getByRole('button', { name: /我给你回了 · 查看卡片/ });
      expect(notice.textContent).toContain('Choose a sign-off');
      expect(notice.textContent).not.toContain('Approve');
      expect(notice.textContent).not.toContain('I replied');
    } finally {
      locale.value = previous;
    }
  });

  it('re-focuses a repeated click and shows unavailable if an open target disappears', async () => {
    const { model } = mountCard();
    const notice = screen.getByRole('button', { name: /I replied · View card/ });
    fireEvent.click(notice);
    await waitFor(() => expect(document.activeElement?.id).toBe('neo-ref-question-q1'));
    notice.focus();
    fireEvent.click(notice);
    await waitFor(() => expect(document.activeElement?.id).toBe('neo-ref-question-q1'));
    act(() => {
      model.value = { ...model.value, snapshot: { ...model.value.snapshot, todoAsks: [] } };
    });
    expect(await screen.findByText('This card is no longer available.')).toBeTruthy();
  });

  it('resolves a retired question to its replacement', async () => {
    mountCard('retired', true);
    fireEvent.click(screen.getByRole('button', { name: /I replied · View card/ }));
    await waitFor(() => expect(document.activeElement?.id).toBe('neo-ref-question-q2'));
    expect(screen.getByRole('button', { name: /Approve/ })).toBeTruthy();
  });
  it.each(['answered', 'retired'] as const)(
    'opens %s details rather than asking again',
    async (state) => {
      mountCard(state);
      fireEvent.click(screen.getByRole('button', { name: /I replied · View card/ }));
      await waitFor(() => expect(document.activeElement?.id).toBe('neo-ref-question-q1'));
      expect(screen.queryByRole('button', { name: /^A.*Approve/ })).toBeNull();
      expect(
        within(document.activeElement as HTMLElement).getByText(
          state === 'answered' ? /Approve/ : /No longer needed/
        )
      ).toBeTruthy();
    }
  );
  it.each(['missing', 'cycle'])('shows unavailable for a %s replacement link', async (broken) => {
    const { model } = mountCard('retired', true);
    const entry = model.value.snapshot.todoAsks[0];
    act(() => {
      model.value = {
        ...model.value,
        snapshot: {
          ...model.value.snapshot,
          todoAsks: [
            {
              ...entry,
              questions: entry.questions.map((q) => ({
                ...q,
                replacedBy: q.id === 'q1' ? (broken === 'cycle' ? 'q2' : 'gone') : 'q1',
              })),
            },
          ],
        },
      };
    });
    fireEvent.click(screen.getByRole('button', { name: /I replied · View card/ }));
    expect(await screen.findByText('This card is no longer available.')).toBeTruthy();
  });

  it('shows an explicit unavailable state when the target is missing', async () => {
    const { model } = mountCard();
    act(() => {
      model.value = { ...model.value, snapshot: { ...model.value.snapshot, todoAsks: [] } };
    });
    fireEvent.click(screen.getByRole('button', { name: /I replied · View card/ }));
    expect(await screen.findByText('This card is no longer available.')).toBeTruthy();
  });
});
