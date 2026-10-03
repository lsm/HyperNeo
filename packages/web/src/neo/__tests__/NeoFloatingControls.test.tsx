import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/preact';
import { signal } from '@preact/signals';
import { readFileSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { NeoSnapshot } from '@hyperneo/shared/types/neo-snapshot';

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
  vi.stubGlobal('matchMedia', (query: string) => ({
    matches: query === '(min-width: 1120px)',
  }));
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
    selectedId: null as string | null,
    snapshot,
    viewSnapshot: snapshot,
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
const surface = () => screen.getByRole('complementary', { name: 'Work surface' });
const concerns = () => screen.getByRole('region', { name: 'Your concerns' });

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
  });

  it('keeps the root logo actionable as the actual Back to Neo control', () => {
    const { open } = renderLive();
    const logo = within(banner()).getByRole('button', { name: 'Back to Neo' });
    fireEvent.click(logo);
    expect(open).toHaveBeenCalledWith(null);
  });

  it('reveals the work surface from the top-right trigger with its attention content', () => {
    const { open } = renderLive();
    expect(within(surface()).getByText('Concern a')).toBeTruthy();
    fireEvent.click(within(concerns()).getByRole('button', { name: /Concern a/ }));
    expect(open).toHaveBeenCalledWith('a');
  });

  it('keeps the Open HyperNeo native link attributes', () => {
    renderLive();
    const link = screen.getByRole('link', { name: 'Open HyperNeo' });
    expect([link.getAttribute('href'), link.getAttribute('target')]).toEqual(['/', '_blank']);
    expect(link.getAttribute('rel')).toBe('noreferrer');
  });

  it('keeps draft and selected work intact while the work surface is used', () => {
    renderLive();
    fireEvent.input(screen.getByLabelText('Draft'), { target: { value: 'hold this' } });
    fireEvent.click(screen.getByRole('button', { name: 'Title w' }));
    expect(screen.getByRole('region', { name: 'Selected work' })).toBeTruthy();
    expect(screen.queryByText('Conversation body')).toBeTruthy();
    expect((screen.getByLabelText('Draft') as HTMLTextAreaElement).value).toBe('hold this');
    fireEvent.click(screen.getByRole('button', { name: 'Back to scenes' }));
    expect((screen.getByLabelText('Draft') as HTMLTextAreaElement).value).toBe('hold this');
    expect(screen.getByText('Conversation body')).toBeTruthy();
  });

  it('keeps one selected card while the work surface shows its concerns', () => {
    renderLive();
    fireEvent.click(screen.getByRole('button', { name: 'Title w' }));
    const region = screen.getByRole('region', { name: 'Selected work' });
    const card = within(region).getByRole('article', { name: 'Title w' });
    expect(within(concerns()).getByText('Concern a')).toBeTruthy();
    expect(screen.getByRole('region', { name: 'Selected work' })).toBe(region);
    expect(within(region).getByRole('article', { name: 'Title w' })).toBe(card);
    expect(screen.getAllByRole('article', { name: 'Title w' })).toHaveLength(1);
    expect(screen.getByRole('button', { name: 'Stop work' })).toBeTruthy();
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

  it('styles the dock and work surface from theme tokens with bounded blur and a 44px target', () => {
    const css = readFileSync('src/neo/neo.css', 'utf8');
    expect(css).toContain('color-mix(in srgb, var(--surface-raised) 82%, transparent)');
    expect(css).toContain('backdrop-filter: blur(8px)');
    expect(css).toContain('@supports not (backdrop-filter: blur(1px))');
    expect(css).toContain('outline: 2px solid var(--focus-ring)');
    expect(css).toMatch(/\.neo-surface-trigger\s*\{[^}]*min-height: 44px;[^}]*min-width: 44px;/s);
    expect(css).toMatch(/\.neo-work-surface\s*\{[^}]*translateX\(100%\)/s);
    expect(css).toMatch(/\.neo-surface-open \.neo-work-surface\s*\{[^}]*translateX\(0\)/s);
    expect(css).toContain('padding-top: 68px');
    expect(css).not.toMatch(/\.neo-work-surface[^{]*\{[^}]*backdrop-filter/);
    expect(css).not.toContain('.neo-concerns-card');
  });
});
