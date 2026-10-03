import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/preact';
import { signal } from '@preact/signals';
import { readFileSync } from 'node:fs';
import { URL as NodeURL } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NeoLive } from '../NeoLive.tsx';
import type { NeoWork } from '@hyperneo/shared/types/neo-context';
import { connectionState } from '../../lib/state.ts';

const useNeoMock = vi.hoisted(() => vi.fn());
vi.mock('../useNeo.ts', () => ({ useNeo: useNeoMock }));
vi.mock('../NeoComposer.tsx', () => ({
  NeoComposer: (props: { draft: string; onDraft: (value: string) => void }) => (
    <textarea
      aria-label="Draft"
      value={props.draft}
      onInput={(event) => props.onDraft(event.currentTarget.value)}
    />
  ),
}));
vi.mock('../NeoConversation.tsx', () => ({
  NeoConversation: () => <p>Durable fictional conversation</p>,
}));
vi.mock('../../islands/ToastContainer.tsx', () => ({ default: () => null }));

beforeEach(() => {
  connectionState.value = 'connected';
  vi.stubGlobal(
    'ResizeObserver',
    class {
      observe() {}
      disconnect() {}
    }
  );
  vi.stubGlobal('innerWidth', 1120);
  vi.stubGlobal('matchMedia', (query: string) => ({
    matches: query === '(min-width: 1120px)' && window.innerWidth >= 1120,
  }));
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const root = 'neo:550e8400-e29b-41d4-a716-446655440000';
const work = (id: string, status: NeoWork['status']): NeoWork => ({
  id,
  status,
  requestKey: id,
  concernId: 'a',
  originSessionId: root,
  originMessageId: `ask-${id}`,
  title: `Fictional ${id}`,
  instruction: `Brief ${id}`,
  sessionId: null,
  targetSessionId: null,
  report: status === 'reported' ? '**Fictional report**' : null,
  createdAt: 1,
  updatedAt: 1,
});
function mount(publicMode = true) {
  const snapshot = {
    ok: true,
    sessionId: root,
    concerns: [],
    work: [work('proposal', 'proposed'), work('failure', 'failed'), work('result', 'reported')],
    consultations: [],
  };
  const publicView = {
    conversationId: root.slice(4),
    status: 'ready',
    entries: [] as { key: string }[],
    hasEarlier: false,
    hasMore: false,
  };
  const model = signal({
    sessionId: root,
    selectedId: null,
    snapshot,
    viewSnapshot: snapshot,
    viewPublicConversation: publicMode ? publicView : undefined,
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
    busyWork: null,
    error: null,
    publicAuthors: new Set<string>(),
    setError: vi.fn(),
    open: vi.fn(),
    act: vi.fn(),
    send: vi.fn(),
    retry: vi.fn(),
    asks: { retry: vi.fn() },
    publications: { refresh: vi.fn() },
  });
  useNeoMock.mockImplementation(() => model.value);
  return { ...render(<NeoLive />), model };
}

describe('Neo desktop panes', () => {
  it('keeps the chat and the open scene detail in separate panes through a full open/back cycle', async () => {
    const { container, model } = mount();
    const main = container.querySelector('main')!;
    const chat = container.querySelector('.neo-chat-rail')!;
    const surface = screen.getByRole('complementary', { name: 'Work surface' });
    const list = screen.getByRole('region', { name: 'Work scenes' });
    expect(chat.parentElement).toBe(main);
    expect(surface.contains(list)).toBe(true);
    const draft = screen.getByRole('textbox', { name: 'Draft' }) as HTMLTextAreaElement;
    fireEvent.input(draft, { target: { value: 'Keep my fictional draft' } });
    const opener = screen.getByRole('button', { name: 'View details for Fictional result' });
    fireEvent.click(opener);
    const detail = screen.getByRole('region', { name: 'Selected work' });
    expect(surface.contains(detail)).toBe(true);
    expect(container.querySelector('.neo-chat-rail')).toBe(chat);
    expect(screen.getByRole('textbox', { name: 'Draft' })).toBe(draft);
    expect(draft.value).toBe('Keep my fictional draft');
    expect(within(list).getByRole('article', { name: 'Fictional proposal' })).toBeTruthy();
    expect(within(list).getByRole('article', { name: 'Fictional failure' })).toBeTruthy();
    expect(
      within(list).queryByRole('button', { name: 'View details for Fictional result' })
    ).toBeNull();
    await waitFor(() =>
      expect(detail.querySelector('strong')?.textContent).toBe('Fictional report')
    );
    fireEvent.click(within(list).getByRole('button', { name: 'Start work' }));
    expect(model.value.act).toHaveBeenCalledExactlyOnceWith('proposal', 'start');
    fireEvent.click(screen.getByRole('button', { name: 'Back to scenes' }));
    expect(screen.queryByRole('region', { name: 'Selected work' })).toBeNull();
    expect(container.querySelector('.neo-chat-rail')).toBe(chat);
    expect(draft.value).toBe('Keep my fictional draft');
    expect(document.activeElement).toBe(
      screen.getByRole('button', { name: 'View details for Fictional result' })
    );
  });

  it('keeps the chat scroll owner at the desktop boundary regardless of scene count', () => {
    const { container, model } = mount();
    const main = container.querySelector('main')!;
    const chat = container.querySelector('.neo-chat-rail')!;
    Object.defineProperties(chat, { scrollHeight: { value: 1200 }, clientHeight: { value: 400 } });
    Object.defineProperties(main, { scrollHeight: { value: 2000 }, clientHeight: { value: 500 } });
    act(() => {
      window.dispatchEvent(new Event('resize'));
    });
    expect(chat.scrollTop).toBe(1200);
    chat.scrollTop = 50;
    fireEvent.scroll(chat);
    act(() => {
      model.value = {
        ...model.value,
        viewPublicConversation: {
          ...model.value.viewPublicConversation!,
          entries: [{ key: 'fictional' }],
        },
      };
    });
    expect(chat.scrollTop).toBe(50);
  });

  it('keeps the work-surface sections out of the chat flow on desktop', () => {
    const { container } = mount();
    const chat = container.querySelector('.neo-chat-rail')!;
    for (const name of ['Needs your attention', 'In progress', 'Recent outcomes']) {
      expect(chat.contains(screen.getByRole('region', { name }))).toBe(false);
    }
    expect(chat.textContent).not.toContain('Needs your attention');
    expect(chat.textContent).not.toContain('Recent outcomes');
  });

  it('uses the CSS media match when scrollbars disagree with innerWidth', () => {
    vi.stubGlobal('innerWidth', 1128);
    vi.stubGlobal('matchMedia', () => ({ matches: false }));
    const { container } = mount();
    const main = container.querySelector('main')!;
    Object.defineProperty(main, 'scrollHeight', { value: 1600 });
    act(() => void window.dispatchEvent(new Event('resize')));
    expect(main.scrollTop).toBe(1600);
    expect(container.querySelector('.neo-chat-rail')!.scrollTop).toBe(0);
  });

  it('keeps the list pane meaningful when its only scene is open in detail', () => {
    const { model } = mount();
    act(() => {
      model.value = {
        ...model.value,
        viewSnapshot: { ...model.value.viewSnapshot, work: [work('result', 'reported')] },
      };
    });
    fireEvent.click(screen.getByRole('button', { name: 'View details for Fictional result' }));
    expect(
      within(screen.getByRole('region', { name: 'Work scenes' })).getByText(
        'No other scenes right now.'
      )
    ).toBeTruthy();
  });

  it('keeps the work surface pinned at desktop widths and off to the right on mobile', () => {
    const css = readFileSync(new NodeURL('../neo.css', import.meta.url), 'utf8');
    const desktop = css.split('@media (min-width: 1120px) {')[1]?.split('@media')[0];
    expect(desktop).toBeTruthy();
    expect(desktop).toContain('.neo-surface-trigger');
    expect(desktop).toMatch(/\.neo-work-surface \{[^}]*translateX\(0\);/s);
    expect(desktop).toMatch(
      /\.neo-chat-rail,\s*\.neo-composer-rail \{[^}]*width: calc\(100% - 340px\);/s
    );
    const narrow = css.split('@media (max-width: 1119px) {')[1]?.split('@media')[0];
    expect(narrow).toBeTruthy();
    expect(narrow).toMatch(/\.neo-surface-open \.neo-work-surface \{[^}]*translateX\(0\);/s);
    expect(css).not.toContain('neo-mobile-detail');
  });

  it('retains composer clearance for the chat rail and the work surface body', () => {
    const css = readFileSync(new NodeURL('../neo.css', import.meta.url), 'utf8');
    const shared = css.split('@media (min-width: 1120px) {')[0];
    expect(shared).toMatch(/\.neo-chat-rail \{[^}]*padding-bottom: calc\(/s);
    expect(shared).toMatch(
      /\.neo-work-surface-body \{[^}]*padding: 12px 16px calc\(var\(--neo-composer-height, 190px\) \+ 24px\);/s
    );
    expect(css.split('@media (min-width: 1120px) {')[1]).toContain('padding: 68px 24px calc(');
  });

  it('keeps the work surface and backdrop from using an unsupported blur', () => {
    const css = readFileSync(new NodeURL('../neo.css', import.meta.url), 'utf8');
    expect(css).not.toContain('neo-concerns-card');
    expect(css).not.toMatch(/\.neo-work-surface \{[^}]*backdrop-filter/);
    expect(css).toContain('@supports not (backdrop-filter: blur(1px))');
    expect(css).toContain('.neo-work-surface-backdrop');
  });

  it('keeps the chat as the scroll owner on both sides of the desktop boundary', () => {
    const { container } = mount();
    const main = container.querySelector('main')!;
    const surface = container.querySelector<HTMLElement>('.neo-work-surface-body')!;
    Object.defineProperties(main, { scrollHeight: { value: 2000 }, clientHeight: { value: 500 } });
    Object.defineProperties(surface, {
      scrollHeight: { value: 1200 },
      clientHeight: { value: 400 },
    });
    vi.stubGlobal('innerWidth', 1119);
    act(() => {
      window.dispatchEvent(new Event('resize'));
    });
    main.scrollTop = 750;
    fireEvent.scroll(main);
    vi.stubGlobal('innerWidth', 1120);
    act(() => {
      window.dispatchEvent(new Event('resize'));
    });
    expect(surface.scrollTop).toBe(0);
    expect(main.scrollTop).toBe(750);
  });
});
