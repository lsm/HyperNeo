vi.mock('../NeoGoals.tsx', () => ({ NeoGoals: () => null }));
import { readFileSync } from 'node:fs';
import { URL as NodeURL } from 'node:url';
import { signal } from '@preact/signals';
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/preact';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { connectionState } from '../../lib/state.ts';
import { NeoLive } from '../NeoLive.tsx';
import { testAskEntry, testTodo } from './neo-test-views.ts';
import { locale } from '../../lib/i18n/index.ts';

const useNeoMock = vi.hoisted(() => vi.fn());
vi.mock('../../components/SessionSchedules.tsx', () => ({ SessionSchedules: () => null }));
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
vi.mock('../NeoSessionPane.tsx', () => ({
  NeoSessionPane: ({ sessionId, onClose }: { sessionId: string; onClose: () => void }) => (
    <div data-testid="neo-chat-panel" data-session-id={sessionId}>
      <button type="button" onClick={onClose}>
        Close chat
      </button>
    </div>
  ),
}));

beforeEach(() => {
  locale.value = 'zh-Hans';
});

afterEach(() => {
  locale.value = 'en';
});

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
function mount(publicMode = true, status = 'ready') {
  const snapshot = {
    ok: true,
    sessionId: root,
    projects: [],
    work: [],
    todoAsks: [
      testAskEntry('proposal', 'Fictional proposal'),
      testAskEntry('failure', 'Fictional failure', { state: 'dropped' }),
      testAskEntry('result', 'Fictional result', { state: 'done' }),
    ],
  };
  const publicView = {
    conversationId: root.slice(4),
    status,
    entries: [] as { key: string }[],
    hasEarlier: false,
    hasMore: false,
  };
  const model = signal({
    sessionId: root,
    snapshot,
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
    setError: vi.fn(),
    open: vi.fn(),
    send: vi.fn(),
    retry: vi.fn(),
    asks: { retry: vi.fn() },
    publications: { refresh: vi.fn() },
  });
  useNeoMock.mockImplementation(() => model.value);
  return { ...render(<NeoLive />), model };
}

describe('Neo desktop panes', () => {
  it('paints expanded Work above the opaque preview frame', () => {
    vi.stubGlobal('matchMedia', () => ({ matches: true }));
    const style = document.createElement('style');
    style.textContent = readFileSync(new NodeURL('../neo.css', import.meta.url), 'utf8');
    document.head.append(style);
    try {
      const { container } = render(
        <div class="neo-shell neo-preview-focus neo-preview-work neo-preview-expanded">
          <main class="neo-scroll">
            <div class="neo-scene-list" />
          </main>
          <div class="artifact-preview-panel" />
        </div>
      );
      const work = getComputedStyle(container.querySelector('.neo-scene-list')!);
      const frame = getComputedStyle(container.querySelector('.artifact-preview-panel')!);
      const rank = (index: string) => (!index || index === 'auto' ? 0 : Number(index));
      expect(work.position).toBe('absolute');
      expect(frame.position).toBe('absolute');
      expect(rank(work.zIndex)).toBeGreaterThan(rank(frame.zIndex));
    } finally {
      style.remove();
    }
  });

  it('keeps the list beside the same chat and composer when a scene opens its work chat', () => {
    const { container, model } = mount();
    act(() => {
      model.value = {
        ...model.value,
        snapshot: {
          ...model.value.snapshot,
          todoAsks: [
            testAskEntry('proposal', 'Fictional proposal'),
            testAskEntry('result', 'Fictional result', {
              state: 'done',
              todos: [testTodo('result', { state: 'done', link: '/session/result-session' })],
            }),
          ],
        },
      };
    });
    const main = container.querySelector('main')!;
    const chat = container.querySelector('.neo-chat-rail')!;
    const list = screen.getByRole('region', { name: '工作场景' });
    expect(chat.parentElement).toBe(main);
    expect(list.parentElement).toBe(main);
    const draft = screen.getByRole('textbox', {
      name: 'Draft',
    }) as HTMLTextAreaElement;
    fireEvent.input(draft, { target: { value: 'Keep my fictional draft' } });
    fireEvent.click(screen.getByRole('button', { name: '打开 Todo result' }));
    expect(screen.getByTestId('neo-chat-panel').dataset.sessionId).toBe('result-session');
    expect(screen.queryByRole('region', { name: 'Selected work' })).toBeNull();
    expect(container.querySelector('.neo-chat-rail')).toBe(chat);
    expect(screen.getByRole('textbox', { name: 'Draft' })).toBe(draft);
    expect(draft.value).toBe('Keep my fictional draft');
    expect(list.inert).toBe(true);
    expect(within(list).queryByRole('article', { name: 'Fictional proposal' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Close chat' }));
    expect(screen.queryByTestId('neo-chat-panel')).toBeNull();
    expect(screen.getByRole('region', { name: '工作场景' })).toBe(list);
    expect(within(list).getByRole('article', { name: 'Fictional proposal' })).toBeTruthy();
  });

  it('uses the chat scroll owner only at the actual desktop boundary and preserves a reader position', () => {
    const { container, model } = mount();
    const main = container.querySelector('main')!;
    const chat = container.querySelector('.neo-chat-rail')!;
    Object.defineProperties(chat, {
      scrollHeight: { value: 1200 },
      clientHeight: { value: 400 },
    });
    Object.defineProperties(main, {
      scrollHeight: { value: 2000 },
      clientHeight: { value: 500 },
    });
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
    vi.stubGlobal('innerWidth', 1119);
    act(() => {
      window.dispatchEvent(new Event('resize'));
    });
    main.scrollTop = 2000;
    fireEvent.scroll(main);
    act(() => {
      model.value = {
        ...model.value,
        viewPublicConversation: {
          ...model.value.viewPublicConversation!,
          entries: [{ key: 'fictional' }, { key: 'next' }],
        },
      };
    });
    expect(main.scrollTop).toBe(2000);
    expect(chat.scrollTop).toBe(50);
  });

  it('does not enable the new layout for legacy SDK conversations', () => {
    const { container } = mount(false);
    expect(container.querySelector('.neo-public-layout')).toBeNull();
    expect(container.querySelector('.neo-has-scenes')).toBeNull();
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

  it('scopes the independent scroll panes and joint motion to 1120px desktop public mode', () => {
    const css = readFileSync(new NodeURL('../neo.css', import.meta.url), 'utf8');
    const desktop = css.split('@media (min-width: 1120px) {')[1]?.split('@media')[0];
    expect(desktop).toBeTruthy();
    expect(desktop).toContain('grid-template-rows: minmax(0, 1fr);');
    for (const selector of ['.neo-chat-rail', '.neo-scene-list'])
      expect(desktop).toContain(`.neo-public-layout.neo-has-scenes ${selector}`);
    expect(desktop).toMatch(/\.neo-chat-rail \{[^}]*overflow-y: auto;/);
    expect(desktop).toMatch(/\.neo-scene-list \{[^}]*overflow-y: auto;/);
    expect(desktop).toMatch(/\.neo-scene-list \{[^}]*grid-column: 2;/);
    expect(desktop).toMatch(/\.neo-composer-dock \{[^}]*width: var\(--neo-chat-width\);/);
    expect(css).toContain('@media (min-width: 1120px) and (prefers-reduced-motion: no-preference)');
    const desktopQueries = [...css.matchAll(/@media([^{}]*)/g)]
      .map((match) => match[1])
      .filter((query) => query.includes('1120px'));
    expect(desktopQueries.every((query) => !query.includes('pointer:'))).toBe(true);
  });

  it('retains composer clearance for the narrow scene list', () => {
    const css = readFileSync(new NodeURL('../neo.css', import.meta.url), 'utf8');
    const shared = css.split('@media (min-width: 1120px) {')[0];
    expect(shared).toMatch(
      /\.neo-scene-list \{[^}]*padding: 0 20px calc\(var\(--neo-composer-height, 190px\) \+ 32px\);/
    );
    expect(shared).not.toMatch(/\.neo-scene-list \{[^}]*padding-bottom: 0;/);
    expect(css.split('@media (min-width: 1120px) {')[1]).toContain('padding: 68px 16px 32px;');
  });

  it('removes intermediate chat clearance only when real scene cards follow', () => {
    const css = readFileSync(new NodeURL('../neo.css', import.meta.url), 'utf8');
    const shared = css.split('@media (min-width: 1120px) {')[0];
    expect(shared).toMatch(
      /\.neo-chat-rail:has\(~ \.neo-scene-list \[data-scene-group\]\) \{\s*padding-bottom: 0;\s*\}/
    );
    expect(shared).toMatch(
      /\.neo-chat-rail:has\(~ \.neo-scene-list\.neo-scene-sheet\) \{\s*padding-bottom: calc\(var\(--neo-composer-height, 190px\) \+ 32px\);\s*\}/
    );
    expect(shared).toMatch(/\.neo-chat-rail \{[^}]*padding-bottom: calc\(/);
    expect(css.split('@media (min-width: 1120px) {')[1]).toMatch(
      /\.neo-chat-rail \{[^}]*padding: 68px 24px calc\(/
    );
  });

  it('keeps the reader position when work empties and transfers it only across viewport changes', () => {
    const { container, model } = mount();
    const main = container.querySelector('main')!;
    const chat = container.querySelector('.neo-chat-rail')!;
    Object.defineProperties(chat, {
      scrollHeight: { value: 1200 },
      clientHeight: { value: 400 },
    });
    Object.defineProperties(main, {
      scrollHeight: { value: 2000 },
      clientHeight: { value: 500 },
    });
    act(() => void window.dispatchEvent(new Event('resize')));
    const view = model.value.snapshot;
    chat.scrollTop = 200;
    fireEvent.scroll(chat);
    act(() => {
      model.value = { ...model.value, snapshot: { ...view, todoAsks: [] } };
    });
    expect(chat.scrollTop).toBe(200);
    expect(main.scrollTop).toBe(0);
    act(() => {
      model.value = { ...model.value, snapshot: view };
    });
    expect(chat.scrollTop).toBe(200);
    vi.stubGlobal('innerWidth', 1119);
    act(() => {
      window.dispatchEvent(new Event('resize'));
    });
    expect(main.scrollTop).toBe(375);
    vi.stubGlobal('innerWidth', 1120);
    act(() => {
      window.dispatchEvent(new Event('resize'));
    });
    expect(chat.scrollTop).toBe(200);
    act(() => {
      model.value = { ...model.value, snapshot: { ...view, todoAsks: [] } };
    });
    expect(chat.scrollTop).toBe(200);
    expect(main.scrollTop).toBe(375);
  });
});
