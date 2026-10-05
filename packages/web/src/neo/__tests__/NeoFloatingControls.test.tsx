import { readFileSync } from 'node:fs';
import type { NeoSnapshot } from '@hyperneo/shared/types/neo-snapshot';
import { signal } from '@preact/signals';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/preact';
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
  vi.doMock('../NeoSessionPane.tsx', () => ({
    NeoSessionPane: ({ sessionId }: { sessionId: string }) => (
      <div data-testid="neo-chat-panel" data-session-id={sessionId} />
    ),
  }));
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

const banner = () => screen.getByRole('banner');

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('Neo floating controls', () => {
  it('keeps the banner landmark but drops the masthead content and its layout row', () => {
    renderLive();
    expect(banner().className).toBe('neo-float-dock');
    expect(banner().className).not.toContain('w-full');
    expect(banner().className).not.toContain('shrink-0');
    expect(screen.queryByText('MVP')).toBeNull();
    expect(banner().querySelector('h1')).toBeNull();
    expect(screen.getByText('Conversation body')).toBeTruthy();
    expect(screen.queryByRole('button', { name: /Your concerns/ })).toBeNull();
  });

  it('keeps the root logo actionable as the actual Back to Neo control', () => {
    const { open } = renderLive();
    const logo = within(banner()).getByRole('button', { name: 'Back to Neo' });
    fireEvent.click(logo);
    expect(open).toHaveBeenCalledWith();
  });

  it('keeps draft and the work card intact while the controls are used', () => {
    renderLive();
    fireEvent.input(screen.getByLabelText('Draft'), { target: { value: 'hold this' } });
    const card = screen.getByRole('article', { name: 'Title w' });
    fireEvent.click(within(card).getByText('Handed to HyperNeo'));
    expect(screen.getByTestId('neo-chat-panel').dataset.sessionId).toBe('w-session');
    expect(screen.getByRole('article', { name: 'Title w', hidden: true })).toBe(card);
    expect((screen.getByLabelText('Draft') as HTMLTextAreaElement).value).toBe('hold this');
    expect(screen.getByText('Conversation body')).toBeTruthy();
  });

  it('still accepts a dropped file on the preserved banner', async () => {
    renderLive();
    const event = new Event('drop', { bubbles: true, cancelable: true });
    Object.defineProperty(event, 'dataTransfer', {
      value: { types: ['Files'], files: [new File(['x'], 'drop.txt', { type: 'text/plain' })] },
    });
    fireEvent(banner(), event);
    await waitFor(() => expect(event.defaultPrevented).toBe(true));
  });

  it('styles the dock from theme tokens with bounded blur, solid fallback and a 44px target', () => {
    const css = readFileSync('src/neo/neo.css', 'utf8');
    expect(css).toContain('color-mix(in srgb, var(--surface-raised) 82%, transparent)');
    expect(css).toContain('backdrop-filter: blur(8px)');
    expect(css).toContain('@supports not (backdrop-filter: blur(1px))');
    expect(css).toContain('outline: 2px solid var(--focus-ring)');
    expect(css).toMatch(/\.neo-float-link\s*\{[^}]*min-height: 44px;\s*min-width: 44px;/);
    expect(css).toContain('padding-top: 68px');
  });
});
