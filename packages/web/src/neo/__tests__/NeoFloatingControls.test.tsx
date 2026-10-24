import { readFileSync } from 'node:fs';
import type { NeoSnapshot } from '@hyperneo/shared/types/neo-snapshot';
import { signal } from '@preact/signals';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/preact';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { testAskEntry, testTodo } from './neo-test-views.ts';

const useNeoMock = vi.hoisted(() => vi.fn());
let NeoLive: typeof import('../NeoLive.tsx').NeoLive;

beforeEach(async () => {
  vi.resetModules();
  vi.doMock('../NeoGoals.tsx', () => ({ NeoGoals: () => null }));
  vi.doMock('../../components/SessionSchedules.tsx', () => ({ SessionSchedules: () => null }));
  vi.doMock('../useNeo.ts', () => ({ useNeo: useNeoMock }));
  vi.doMock('../../lib/state.ts', () => ({
    connectionState: { value: 'connected', subscribe: () => () => {} },
    reconnectAttemptCount: { value: 0, subscribe: () => () => {} },
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
  (await import('../../lib/i18n/index.ts')).locale.value = 'zh-Hans';
});

const project = (id: string) => ({
  id,
  title: `Project ${id}`,
  summary: `Summary ${id}`,
  context: `Context ${id}`,
  revision: 1,
  createdAt: 1,
  updatedAt: 2,
});
const snapshot: NeoSnapshot = {
  ok: true,
  sessionId: 'root',
  projects: [project('a'), project('b')],
  todoAsks: [
    testAskEntry('ask-w', 'Title w', {
      state: 'doing',
      todos: [testTodo('w', { state: 'doing', status: '在做', link: '/session/w-session' })],
    }),
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
    expect(screen.queryByRole('button', { name: /Your projects/ })).toBeNull();
  });

  it('opens the settings drawer with connection controls and no project management', () => {
    const { open } = renderLive();
    expect(within(banner()).queryByRole('button', { name: 'Projects' })).toBeNull();
    const logo = within(banner()).getByRole('button', { name: '设置和连接' });
    fireEvent.click(logo);
    const drawer = screen.getByRole('dialog', { name: 'Settings and connection' });
    expect(within(drawer).getByText('Connected')).toBeTruthy();
    expect(within(drawer).queryByText('Projects')).toBeNull();
    expect(within(drawer).queryByRole('combobox')).toBeNull();
    expect(within(drawer).getByRole('button', { name: 'Reconnect' })).toBeTruthy();
    expect(logo.getAttribute('aria-expanded')).toBe('true');
    fireEvent.click(within(drawer).getByRole('button', { name: 'Refresh Neo' }));
    expect(open).toHaveBeenCalledWith();
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('closes the drawer on Escape, a backdrop click and a drag to the left, returning focus to the mark', async () => {
    renderLive();
    const logo = within(banner()).getByRole('button', { name: '设置和连接' });
    logo.focus();
    fireEvent.click(logo);
    expect(document.activeElement).toBe(
      screen.getByRole('dialog', { name: 'Settings and connection' })
    );
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(screen.queryByRole('dialog')).toBeNull();
    await waitFor(() => expect(document.activeElement).toBe(logo));
    fireEvent.click(logo);
    fireEvent.click(screen.getByTestId('neo-drawer-backdrop'));
    expect(screen.queryByRole('dialog')).toBeNull();
    fireEvent.click(logo);
    const drawer = screen.getByRole('dialog', { name: 'Settings and connection' });
    fireEvent.pointerDown(drawer, { clientX: 300 });
    fireEvent.pointerMove(drawer, { clientX: 260 });
    fireEvent.pointerUp(drawer, { clientX: 290 });
    expect(screen.getByRole('dialog')).toBeTruthy();
    fireEvent.pointerDown(drawer, { clientX: 300 });
    fireEvent.pointerUp(drawer, { clientX: 200 });
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('keeps draft and the work card intact while the controls are used', () => {
    renderLive();
    fireEvent.input(screen.getByLabelText('Draft'), { target: { value: 'hold this' } });
    const card = screen.getByRole('article', { name: 'Title w' });
    fireEvent.click(within(card).getByRole('button', { name: '打开 Todo w' }));
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

  it('draws the logo and work buttons as 44px round glass with a press state in both themes', () => {
    renderLive();
    const logo = within(banner()).getByRole('button', { name: '设置和连接' });
    expect(logo.className).toContain('neo-glass-button');
    const css = readFileSync('src/neo/neo.css', 'utf8');
    const glass = css.match(/\.neo-glass-button\s*\{([^}]*)\}/)?.[1] ?? '';
    expect(glass).toContain('width: 44px');
    expect(glass).toContain('border-radius: 9999px');
    expect(glass).toContain('backdrop-filter: blur(20px) saturate(180%)');
    expect(glass).toMatch(/--neo-glass-fill: light-dark\(/);
    expect(css).toMatch(/\.neo-glass-button:active\s*\{[^}]*transform: scale\(0\.94\)/);
    expect(css).toMatch(
      /@supports not \(backdrop-filter: blur\(1px\)\)\s*\{[^}]*\.neo-glass-button/
    );
  });
});
