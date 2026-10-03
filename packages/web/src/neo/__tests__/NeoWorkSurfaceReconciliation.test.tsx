import type { ChatMessage } from '@hyperneo/shared';
import type { NeoSnapshot } from '@hyperneo/shared/types/neo-snapshot';
import { signal } from '@preact/signals';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/preact';
import { render as renderRoot } from 'preact';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const useNeoMock = vi.hoisted(() => vi.fn());
let NeoLive: typeof import('../NeoLive.tsx').NeoLive;

beforeEach(async () => {
  vi.resetModules();
  vi.doMock('../useNeo.ts', () => ({ useNeo: useNeoMock }));
  vi.doMock('../../lib/state.ts', () => ({
    connectionState: { value: 'connected', subscribe: () => () => {} },
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

const mount = (originMessageId: string | null, hasConcern = true, live = true) => {
  const snapshot: NeoSnapshot = {
    ok: true,
    sessionId: 'root',
    concerns: hasConcern
      ? [
          {
            id: 'a',
            title: 'Concern A',
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
        concernId: hasConcern ? 'a' : null,
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
  useNeoMock.mockReturnValue({
    sessionId: 'root',
    snapshot,
    store,
    error: null,
    setError: vi.fn(),
    open: vi.fn(),
    act,
    busyWork: null,
  });
  if (live) render(<NeoLive />);
  return { act };
};

describe('original work surface reconciled with the live scenes', () => {
  it.each(['ask', null, 'unloaded'])('keeps one native card for origin %s', (origin) => {
    const { act } = mount(origin);
    expect(document.querySelectorAll('[id^="inline-work-"]')).toHaveLength(0);
    expect(screen.queryByRole('region', { name: 'Work without a message here' })).toBeNull();
    expect(screen.getAllByRole('article', { name: 'Draft the agenda', hidden: true })).toHaveLength(
      1
    );
    expect(screen.getAllByRole('button', { name: 'Start work' })).toHaveLength(1);
    fireEvent.click(screen.getByRole('button', { name: 'Start work' }));
    expect(act).toHaveBeenCalledExactlyOnceWith('work', 'start');
  });

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

  it('keeps orphan decisions on their actionable scene, not an empty concerns panel', () => {
    const { act } = mount('ask', false);
    expect(screen.queryByRole('button', { name: /Work in flight|Your concerns/ })).toBeNull();
    expect(screen.queryByRole('complementary', { name: 'Your concerns' })).toBeNull();
    const attention = screen.getByRole('region', { name: 'Needs your attention' });
    expect(within(attention).getByRole('article', { name: 'Draft the agenda' })).toBeTruthy();
    fireEvent.click(within(attention).getByRole('button', { name: 'Decline' }));
    expect(act).toHaveBeenCalledExactlyOnceWith('work', 'cancel');
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
      expect(add).toHaveBeenCalledTimes(1);
      expect(document.documentElement.classList.contains('keyboard-open')).toBe(true);
      viewport.height = 380;
      viewport.dispatchEvent(new Event('resize'));
      expect(document.documentElement.style.getPropertyValue('--safe-height')).toBe('380px');
      expect(root.querySelectorAll('.neo-shell')).toHaveLength(1);
    } finally {
      renderRoot(null, root);
      root.remove();
    }
    expect(remove).toHaveBeenCalledTimes(1);
    expect(remove.mock.calls[0]).toEqual(add.mock.calls[0]);
    expect(document.documentElement.style.getPropertyValue('--safe-height')).toBe('');
    expect(document.documentElement.classList.contains('keyboard-open')).toBe(false);
  });
});
