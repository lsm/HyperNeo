import { cleanup, fireEvent, render, screen, within } from '@testing-library/preact';
import { signal } from '@preact/signals';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ChatMessage } from '@hyperneo/shared';
import type { NeoSnapshot } from '@hyperneo/shared/types/neo-snapshot';

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

const mount = (originMessageId: string | null) => {
  const snapshot: NeoSnapshot = {
    ok: true,
    sessionId: 'root',
    concerns: [
      {
        id: 'a',
        title: 'Concern A',
        summary: 'Summary',
        context: 'Context',
        revision: 1,
        createdAt: 1,
        updatedAt: 1,
      },
    ],
    consultations: [],
    work: [
      {
        id: 'work',
        requestKey: 'work',
        concernId: 'a',
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
    selectedId: null,
    snapshot,
    viewSnapshot: snapshot,
    store,
    error: null,
    setError: vi.fn(),
    open: vi.fn(),
    act,
    busyWork: null,
  });
  render(<NeoLive />);
  return { act };
};

describe('original work surface reconciled with the live scenes', () => {
  it.each(['ask', null, 'unloaded'])('keeps one native card for origin %s', (origin) => {
    const { act } = mount(origin);
    expect(screen.getByText('Plan our offsite')).toBeTruthy();
    expect(document.querySelectorAll('[id^="inline-work-"]')).toHaveLength(0);
    expect(screen.queryByRole('region', { name: 'Work without a message here' })).toBeNull();
    expect(screen.getAllByRole('article', { name: 'Draft the agenda' })).toHaveLength(1);
    expect(screen.getAllByRole('button', { name: 'Start work' })).toHaveLength(1);
    fireEvent.click(screen.getByRole('button', { name: /Your concerns/ }));
    const panel = screen.getByRole('complementary', { name: 'Your concerns' });
    expect(within(panel).queryByRole('button', { name: 'Draft the agenda' })).toBeNull();
    expect(screen.getAllByRole('button', { name: 'Start work' })).toHaveLength(1);
    fireEvent.click(screen.getByRole('button', { name: 'Start work' }));
    expect(act).toHaveBeenCalledExactlyOnceWith('work', 'start');
  });

  it('opens full detail without firing a native action and preserves the composer on Back', () => {
    const { act } = mount('ask');
    fireEvent.input(screen.getByRole('textbox', { name: 'Draft' }), {
      target: { value: 'Keep my draft' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Draft the agenda' }));
    expect(act).not.toHaveBeenCalled();
    const detail = screen.getByRole('region', { name: 'Selected work' });
    expect(within(detail).getByText('Eight people, Sunday.')).toBeTruthy();
    const inspect = within(detail).getByRole('link', { name: /Inspect execution/ });
    expect(inspect.getAttribute('href')).toBe('/session/worker');
    expect(inspect.getAttribute('target')).toBe('_blank');
    fireEvent.click(screen.getByRole('button', { name: 'Back to scenes' }));
    expect(screen.queryByRole('region', { name: 'Selected work' })).toBeNull();
    expect(screen.getAllByRole('article', { name: 'Draft the agenda' })).toHaveLength(1);
    expect((screen.getByRole('textbox', { name: 'Draft' }) as HTMLTextAreaElement).value).toBe(
      'Keep my draft'
    );
    expect(act).not.toHaveBeenCalled();
  });
});
