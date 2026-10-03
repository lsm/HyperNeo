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
const toggle = () => screen.getByRole('button', { name: /Your concerns/ });
const concernsList = () => screen.getByRole('complementary', { name: 'Your concerns' });

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

  it('drives the real concerns toggle, selection, dismissal and focus return', () => {
    const { open } = renderLive();
    expect(concernsList().className).not.toContain('is-open');
    const trigger = toggle();
    fireEvent.click(trigger);
    const list = concernsList();
    expect(list.className).toContain('is-open');
    expect(within(list).getByText('Concern a')).toBeTruthy();
    fireEvent.click(within(list).getByRole('button', { name: /Concern a/ }));
    expect(open).toHaveBeenCalledWith('a');
    fireEvent.click(toggle());
    fireEvent.click(within(concernsList()).getByRole('button', { name: 'Close concerns' }));
    expect(concernsList().className).not.toContain('is-open');
    expect(document.activeElement).toBe(toggle());
  });

  it('keeps the Open HyperNeo native link attributes', () => {
    renderLive();
    const link = screen.getByRole('link', { name: 'Open HyperNeo' });
    expect([link.getAttribute('href'), link.getAttribute('target')]).toEqual(['/', '_blank']);
    expect(link.getAttribute('rel')).toBe('noreferrer');
  });

  it('keeps draft and the work card intact while the controls are used', () => {
    renderLive();
    const opened = vi.spyOn(window, 'open').mockReturnValue(null);
    fireEvent.input(screen.getByLabelText('Draft'), { target: { value: 'hold this' } });
    const card = screen.getByRole('article', { name: 'Title w' });
    fireEvent.click(within(card).getByText('Handed to HyperNeo'));
    expect(opened).toHaveBeenCalledExactlyOnceWith('/session/w-session', '_blank', 'noopener');
    fireEvent.click(toggle());
    fireEvent.click(screen.getByRole('button', { name: 'Close concerns' }));
    expect(document.activeElement).toBe(toggle());
    expect(screen.getByRole('article', { name: 'Title w' })).toBe(card);
    expect((screen.getByLabelText('Draft') as HTMLTextAreaElement).value).toBe('hold this');
    expect(screen.getByText('Conversation body')).toBeTruthy();
    opened.mockRestore();
  });

  it('keeps one work card through a real concerns round trip', () => {
    renderLive();
    const card = screen.getByRole('article', { name: 'Title w' });
    fireEvent.click(toggle());
    expect(within(concernsList()).getByText('Concern a')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Close concerns' }));
    expect(document.activeElement).toBe(toggle());
    expect(screen.getByRole('article', { name: 'Title w' })).toBe(card);
    expect(screen.getAllByRole('article', { name: 'Title w' })).toHaveLength(1);
    expect(card.getAttribute('data-scene-open')).toBe('w-queued');
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
    expect(css).toMatch(
      /\.neo-float-actions > \.neo-concerns > \.neo-concerns-trigger\s*\{\s*min-height: 44px;\s*min-width: 44px;/
    );
    expect(css).toMatch(/\.neo-concerns-card\s*\{[^}]*top: 64px;[^}]*right: 8px;/);
    const wideCss = css.slice(css.indexOf('@media (min-width: 1180px)'));
    expect(wideCss).toMatch(
      /\.neo-concerns-card\s*\{[^}]*top: 88px;[^}]*right: calc\(max\(24px, calc\(\(100vw - 1160px\) \/ 2\)\) - 12px\);/
    );
    expect(css).toContain('padding-top: 68px');
    expect(css).toContain('.neo-float-actions > .neo-concerns > .neo-concerns-trigger:not(:hover)');
    expect(css).not.toMatch(/\.neo-concerns-card[^{]*\{[^}]*backdrop-filter/);
  });
});
