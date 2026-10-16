import type { ChatMessage } from '@hyperneo/shared';
import type { NeoAsk, NeoSnapshot } from '@hyperneo/shared/types/neo-snapshot';
import { signal } from '@preact/signals';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/preact';
import { render as renderRoot } from 'preact';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { testAskView, testCard, withNeoViews } from './neo-test-views.ts';

const useNeoMock = vi.hoisted(() => vi.fn());
let NeoLive: typeof import('../NeoLive.tsx').NeoLive;

beforeEach(async () => {
  vi.resetModules();
  vi.doMock('../useNeo.ts', () => ({ useNeo: useNeoMock }));
  vi.doMock('../../lib/state.ts', () => ({
    connectionState: { value: 'connected', subscribe: () => () => {} },
    reconnectAttemptCount: { value: 0, subscribe: () => () => {} },
  }));
  vi.doMock('../../components/chat/MarkdownRenderer.tsx', () => ({
    default: ({ content }: { content: string }) => <p>{content}</p>,
  }));
  vi.doMock('../NeoComposer.tsx', () => ({
    NeoComposer: (props: { draft: string; onDraft: (text: string) => void }) => (
      <textarea
        aria-label="Draft"
        value={props.draft}
        onInput={(event) => props.onDraft(event.currentTarget.value)}
      />
    ),
  }));
  vi.doMock('../../islands/ToastContainer.tsx', () => ({ default: () => null }));
  vi.doMock('../NeoSessionPane.tsx', () => ({
    NeoSessionPane: ({ sessionId }: { sessionId: string }) => (
      <div data-testid="neo-chat-panel" data-session-id={sessionId} />
    ),
  }));
  vi.doMock('../../lib/connection-manager.ts', () => ({
    connectionManager: { getHubIfConnected: () => null },
  }));
  vi.stubGlobal(
    'ResizeObserver',
    class {
      observe() {}
      disconnect() {}
    }
  );
  ({ NeoLive } = await import('../NeoLive.tsx'));
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const mount = (
  originMessageId: string | null,
  hasProject = true,
  live = true,
  question = false
) => {
  const snapshot: NeoSnapshot = {
    ok: true,
    cards: [],
    askViews: [],
    sessionId: 'root',
    projects: hasProject
      ? [
          {
            id: 'a',
            title: 'Project A',
            summary: 'Summary',
            context: 'Context',
            revision: 1,
            createdAt: 1,
            updatedAt: 1,
          },
        ]
      : [],
    consultations: [],
    work: [
      {
        id: 'work',
        requestKey: 'work',
        projectId: hasProject ? 'a' : null,
        originSessionId: 'root',
        originMessageId,
        title: 'Draft the agenda',
        instruction: 'Eight people, Sunday.',
        sessionId: 'worker',
        targetSessionId: null,
        status: 'proposed',
        report: null,
        createdAt: 2,
        updatedAt: 2,
      },
    ],
  };
  const store = {
    sessionInfo: signal({ metadata: {} }),
    sdkMessages: signal([
      {
        type: 'user',
        uuid: 'ask',
        message: { role: 'user', content: 'Plan our offsite' },
      } as unknown as ChatMessage,
    ]),
    messagesLoaded: signal(true),
    activeSessionId: signal('root'),
    loadErrorKind: signal(null),
    agentState: signal({ status: 'idle' }),
    error: signal(null),
    hasMoreMessages: signal(false),
    isWorking: signal(false),
    refresh: vi.fn(),
    destroy: vi.fn(),
  };
  const act = vi.fn();
  const answerAskItem = vi.fn();
  if (question) {
    snapshot.work[0].sessionId = null;
    const ask: NeoAsk = {
      id: 'legacy-ask',
      requestKey: 'legacy-ask',
      projectId: snapshot.work[0].projectId,
      originSessionId: 'root',
      originMessageId: null,
      title: 'Draft the agenda',
      ask: 'Existing proposal',
      doneWhen: 'Agenda drafted',
      doneSource: 'proposal',
      status: 'waiting',
      outcome: '开始这 1 步？',
      evidence: null,
      workIds: ['work'],
      createdAt: 1,
      updatedAt: 2,
      settledAt: null,
    };
    snapshot.asks = [ask];
    snapshot.cards = [testCard(snapshot.work[0])];
    snapshot.askViews = [
      testAskView(ask, {
        needsYou: true,
        humanActions: [
          {
            kind: 'question',
            itemId: 'start-question',
            question: '开始这 1 步？',
            options: ['先不做', '开始'],
          },
        ],
      }),
    ];
  }
  useNeoMock.mockReturnValue(
    withNeoViews({
      sessionId: 'root',
      snapshot,
      store,
      error: null,
      setError: vi.fn(),
      open: vi.fn(),
      act,
      answerAskItem,
      askDetailFailed: () => false,
      busyWork: null,
    })
  );
  if (live) render(<NeoLive />);
  return { act, answerAskItem };
};

describe('original work surface reconciled with the live scenes', () => {
  it.each(['ask', null, 'unloaded'])('keeps one native card for origin %s', (origin) => {
    const { act } = mount(origin);
    expect(document.querySelectorAll('[id^="inline-work-"]')).toHaveLength(0);
    expect(screen.queryByRole('region', { name: 'Work without a message here' })).toBeNull();
    expect(screen.getAllByRole('article', { name: 'Draft the agenda', hidden: true })).toHaveLength(
      1
    );
    expect(screen.getAllByRole('button', { name: 'Open chat' })).toHaveLength(1);
    expect(screen.queryByRole('button', { name: 'Start work' })).toBeNull();
    expect(act).not.toHaveBeenCalled();
  });

  it.each(['先不做', '开始'])(
    'routes %s through the owning question for recovered work without a session',
    (choice) => {
      const { act, answerAskItem } = mount(null, true, true, true);
      const buttons = ['先不做', '开始'].map((name) =>
        screen.getByRole('button', { name: `Answer 开始这 1 步？: ${name}` })
      );
      expect(
        buttons[0].compareDocumentPosition(buttons[1]) & Node.DOCUMENT_POSITION_FOLLOWING
      ).toBeTruthy();
      expect(screen.queryByRole('button', { name: 'Start work' })).toBeNull();
      expect(screen.queryByRole('button', { name: 'Decline' })).toBeNull();
      fireEvent.click(screen.getByRole('button', { name: `Answer 开始这 1 步？: ${choice}` }));
      expect(answerAskItem).toHaveBeenCalledExactlyOnceWith('legacy-ask', 'start-question', choice);
      expect(act).not.toHaveBeenCalled();
    }
  );

  it('opens the work chat without firing a native action and preserves the composer', () => {
    const { act } = mount('ask');
    fireEvent.input(screen.getByRole('textbox', { name: 'Draft' }), {
      target: { value: 'Keep my draft' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Open chat' }));
    expect(act).not.toHaveBeenCalled();
    expect(screen.getByTestId('neo-chat-panel').dataset.sessionId).toBe('worker');
    expect(screen.queryByRole('region', { name: 'Selected work' })).toBeNull();
    expect(screen.getAllByRole('article', { name: 'Draft the agenda', hidden: true })).toHaveLength(
      1
    );
    expect((screen.getByRole('textbox', { name: 'Draft' }) as HTMLTextAreaElement).value).toBe(
      'Keep my draft'
    );
  });

  it('keeps orphan work on its scene with a session opener', () => {
    const { act } = mount('ask', false);
    expect(screen.queryByRole('button', { name: /Work in flight|Your projects/ })).toBeNull();
    expect(screen.queryByRole('complementary', { name: 'Your projects' })).toBeNull();
    const attention = screen.getByRole('region', { name: 'Needs your attention' });
    expect(within(attention).getByRole('article', { name: 'Draft the agenda' })).toBeTruthy();
    expect(within(attention).getByRole('button', { name: 'Open chat' })).toBeTruthy();
    expect(within(attention).queryByRole('button', { name: 'Decline' })).toBeNull();
    expect(act).not.toHaveBeenCalled();
  });

  it('the real Neo entry owns one viewport hook through keyboard resize and cleanup', async () => {
    mount('ask', true, false);
    const viewport = Object.assign(new EventTarget(), { height: 420, offsetTop: 0, scale: 1 });
    const add = vi.spyOn(viewport, 'addEventListener');
    const remove = vi.spyOn(viewport, 'removeEventListener');
    vi.stubGlobal('visualViewport', viewport);
    vi.stubGlobal('innerHeight', 800);
    const root = document.createElement('div');
    root.id = 'root';
    document.body.append(root);
    try {
      await import('../client.tsx');
      await waitFor(() =>
        expect(document.documentElement.style.getPropertyValue('--safe-height')).toBe('420px')
      );
      expect(add.mock.calls.filter(([type]) => type === 'resize')).toHaveLength(1);
      expect(document.documentElement.classList.contains('keyboard-open')).toBe(true);
      viewport.height = 380;
      viewport.dispatchEvent(new Event('resize'));
      expect(document.documentElement.style.getPropertyValue('--safe-height')).toBe('380px');
      expect(root.querySelectorAll('.neo-shell')).toHaveLength(1);
    } finally {
      renderRoot(null, root);
      root.remove();
    }
    expect(remove.mock.calls).toEqual(add.mock.calls);
    expect(document.documentElement.style.getPropertyValue('--safe-height')).toBe('');
    expect(document.documentElement.classList.contains('keyboard-open')).toBe(false);
  });
});
