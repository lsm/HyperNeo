import { locale } from '../../lib/i18n/index.ts';
import type { NeoQuestionEntry } from '@hyperneo/shared/types/neo-ask';
import type { NeoPublication } from '@hyperneo/shared/types/neo-publication';
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
});

const root = 'neo:550e8400-e29b-41d4-a716-446655440000';
function mount(publicMode = true, empty = false) {
  const snapshot = {
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

describe('Neo public work scenes', () => {
  it.each([true, false])('keeps an empty Work surface accessible on desktop=%s', (desktop) => {
    vi.stubGlobal('matchMedia', () => ({ matches: desktop }));
    const { container } = mount(true, true);
    expect(container.querySelector('.neo-shell')?.classList.contains('neo-has-scenes')).toBe(true);
    const work = screen.getByRole('region', { name: 'Work scenes' });
    expect(within(work).getByRole('status').textContent).toBe('No work yet.');
    expect(work.querySelectorAll('[data-scene-group]')).toHaveLength(0);
    if (!desktop) {
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

  it('keeps the empty legacy scene list collapsed without a public Work placeholder', () => {
    const { container } = mount(false, true);
    expect(screen.queryByText('No work yet.')).toBeNull();
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
    ).toBe('No work yet.');
    act(() => {
      model.value = { ...model.value, snapshot: { ...model.value.snapshot, todoAsks: entries } };
    });
    expect(screen.queryByText('No work yet.')).toBeNull();
    expect(screen.getByRole('region', { name: 'Needs your attention' })).toBeTruthy();
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
    startTodos: null,
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
        params.name === 'neo.ask.read' ? read() : Promise.resolve({ schedules: [] })
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
    [1500, false],
    [1500, true],
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
        expect(work.hidden).toBe(width < 1440);
        fireEvent.click(screen.getByRole('button', { name: /I replied · View card/ }));
        await waitFor(() => expect(document.activeElement?.id).toBe('neo-ref-question-q1'));
        expect(work.hidden).toBe(false);
        if (reference || width >= 1440)
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
