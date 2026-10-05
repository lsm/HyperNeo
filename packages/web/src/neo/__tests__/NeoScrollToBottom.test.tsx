import type { NeoSnapshot } from '@hyperneo/shared/types/neo-snapshot';
import { signal } from '@preact/signals';
import { cleanup, fireEvent, render, screen } from '@testing-library/preact';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const useNeoMock = vi.hoisted(() => vi.fn());
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
    NeoConversation: () => <p>Conversation body</p>,
  }));
  vi.doMock('../../islands/ToastContainer.tsx', () => ({ default: () => null }));
  ({ NeoLive } = await import('../NeoLive.tsx'));
});

const concern = (id: string) => ({
  id,
  title: `Concern ${id}`,
  summary: `Summary ${id}`,
  context: `Context ${id}`,
  revision: 1,
  createdAt: 1,
  updatedAt: 2,
});
const snapshot: NeoSnapshot = {
  ok: true,
  sessionId: 'root',
  concerns: [concern('a'), concern('b')],
  work: [
    {
      id: 'w-queued',
      requestKey: 'w',
      concernId: 'a',
      originSessionId: 'root',
      originMessageId: 'ask-w',
      title: 'Title w',
      instruction: 'Instruction w',
      targetSessionId: null,
      sessionId: 'w-session',
      status: 'queued',
      report: null,
      createdAt: 20,
      updatedAt: 21,
    },
  ],
};

const renderLive = () => {
  vi.stubGlobal(
    'ResizeObserver',
    class {
      observe() {}
      disconnect() {}
    }
  );
  const open = vi.fn();
  const store = {
    sessionInfo: signal({ metadata: {} }),
    sdkMessages: signal([]),
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
  const model = {
    sessionId: 'neo' as string | null,
    snapshot,
    error: null,
    setError: vi.fn(),
    open,
    act: vi.fn(),
    busyWork: null as string | null,
    store,
  };
  const state = signal(model);
  useNeoMock.mockImplementation(() => state.value);
  const result = render(<NeoLive />);
  return { ...result, state, model, open };
};

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

function placeScroll(element: HTMLElement, scrollTop: number) {
  Object.defineProperty(element, 'scrollHeight', { value: 2000, configurable: true });
  Object.defineProperty(element, 'clientHeight', { value: 500, configurable: true });
  element.scrollTop = scrollTop;
  fireEvent.scroll(element);
}

describe('Neo scroll to bottom', () => {
  it('appears away from the bottom, jumps back down, and hides at the bottom', () => {
    renderLive();
    const main = screen.getByRole('main');
    const scrollTo = vi.fn();
    main.scrollTo = scrollTo as unknown as typeof main.scrollTo;
    placeScroll(main, 1500);
    expect(screen.queryByRole('button', { name: 'Scroll to bottom' })).toBeNull();
    placeScroll(main, 200);
    const button = screen.getByRole('button', { name: 'Scroll to bottom' });
    expect(button.closest('.neo-composer-rail')?.classList.contains('relative')).toBe(true);
    fireEvent.click(button);
    expect(scrollTo).toHaveBeenCalledWith({ top: 2000, behavior: 'smooth' });
    expect(screen.queryByRole('button', { name: 'Scroll to bottom' })).toBeNull();
  });
});
