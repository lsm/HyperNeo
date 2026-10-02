import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/preact';
import { signal } from '@preact/signals';
import { readFileSync } from 'node:fs';
import { URL as NodeURL } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { NeoWork } from '@hyperneo/shared/types/neo-context';
import { connectionState } from '../../lib/state.ts';
import { NeoLive } from '../NeoLive.tsx';

const useNeoMock = vi.hoisted(() => vi.fn());
vi.mock('../useNeo.ts', () => ({ useNeo: useNeoMock }));
vi.mock('../NeoComposer.tsx', () => ({
  NeoComposer: (props: { draft: string; onDraft: (value: string) => void }) => (
    <textarea
      aria-label="Draft"
      value={props.draft}
      onInput={(e) => props.onDraft(e.currentTarget.value)}
    />
  ),
}));
vi.mock('../NeoConversation.tsx', () => ({
  NeoConversation: () => <p>Fictional durable answer</p>,
}));
vi.mock('../../islands/ToastContainer.tsx', () => ({ default: () => null }));

beforeEach(() => {
  connectionState.value = 'connected';
  vi.stubGlobal('innerWidth', 390);
  vi.stubGlobal('matchMedia', () => ({ matches: window.innerWidth >= 1120 }));
  vi.stubGlobal(
    'ResizeObserver',
    class {
      observe() {}
      disconnect() {}
    }
  );
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

function mount(publicMode = true) {
  const sessionId = 'neo:550e8400-e29b-41d4-a716-446655440000';
  const makeWork = (id: string): NeoWork => ({
    id,
    requestKey: id,
    concernId: null,
    originSessionId: sessionId,
    originMessageId: `ask-${id}`,
    title: `Fictional ${id}`,
    instruction: `Brief ${id}`,
    sessionId: null,
    targetSessionId: null,
    report: null,
    status: 'proposed',
    createdAt: 1,
    updatedAt: 1,
  });
  const snapshot = {
    ok: true,
    sessionId,
    concerns: [],
    work: [makeWork('one'), makeWork('two')],
    consultations: [],
  };
  const model = signal({
    sessionId,
    selectedId: null as string | null,
    snapshot,
    viewSnapshot: snapshot,
    viewPublicConversation: publicMode
      ? {
          conversationId: sessionId.slice(4),
          status: 'ready',
          entries: [] as { key: string }[],
          hasEarlier: false,
          hasMore: false,
        }
      : undefined,
    store: {
      sessionInfo: signal({ metadata: {} }),
      sdkMessages: signal([]),
      messagesLoaded: signal(true),
      activeSessionId: signal(sessionId),
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

describe('Neo mobile work detail', () => {
  it.each([
    [1120, true],
    [390, false],
  ])(
    'retains conversation auto-follow when detail opens at width %i in public mode %s',
    (width, publicMode) => {
      vi.stubGlobal('innerWidth', width);
      const { container, model } = mount(publicMode);
      const reader = container.querySelector<HTMLElement>(publicMode ? '.neo-chat-rail' : 'main')!;
      Object.defineProperty(reader, 'scrollHeight', { configurable: true, value: 2200 });
      Object.defineProperty(reader, 'clientHeight', { configurable: true, value: 800 });
      fireEvent.click(screen.getByRole('button', { name: 'Fictional one' }));
      const append = (key: string) =>
        act(() => {
          const current = model.value;
          if (current.viewPublicConversation)
            model.value = {
              ...current,
              viewPublicConversation: {
                ...current.viewPublicConversation,
                entries: [...current.viewPublicConversation.entries, { key }],
              },
            };
          else
            current.store.sdkMessages.value = [
              ...current.store.sdkMessages.value,
              { uuid: key },
            ] as never[];
        });
      append('first-reply');
      expect(reader.scrollTop).toBe(2200);
      fireEvent.click(screen.getByRole('button', { name: 'Back to scenes' }));
      Object.defineProperty(reader, 'scrollHeight', { configurable: true, value: 2500 });
      append('second-reply');
      expect(reader.scrollTop).toBe(2500);
    }
  );

  it('pushes only the visible detail while retaining the conversation, reader, draft and native actions', () => {
    const { container, model } = mount();
    const chat = container.querySelector('.neo-chat-rail')!;
    const main = container.querySelector('main')!;
    const list = screen.getByRole('region', { name: 'Work scenes' });
    const draft = screen.getByRole('textbox', { name: 'Draft' }) as HTMLTextAreaElement;
    const pane = container.querySelector('.neo-mobile-detail')!;
    const opener = screen.getByRole('button', { name: 'Fictional one' });
    main.scrollTop = 143;
    fireEvent.input(draft, { target: { value: 'Fictional unsent draft' } });
    fireEvent.click(opener);
    const detail = screen.getByRole('region', { name: 'Selected work' });
    expect(detail).toBe(pane);
    expect(container.querySelector('.neo-chat-rail')).toBe(chat);
    for (const element of [
      chat,
      list,
      draft.closest('footer')!,
      container.querySelector('header')!,
    ]) {
      expect(element.hasAttribute('inert')).toBe(true);
      expect(element.getAttribute('inert')).toBe('');
    }
    expect(main.scrollTop).toBe(143);
    main.scrollTop = 0;
    fireEvent.scroll(main);
    expect(detail.querySelector('button')).toBe(document.activeElement);
    expect(model.value.act).not.toHaveBeenCalled();
    fireEvent.click(within(detail).getByRole('button', { name: 'Start work' }));
    expect(model.value.act).toHaveBeenCalledExactlyOnceWith('one', 'start');
    fireEvent.click(within(detail).getByRole('button', { name: 'Back to scenes' }));
    expect(screen.queryByRole('region', { name: 'Selected work' })).toBeNull();
    expect(container.querySelector('.neo-mobile-detail')).toBe(pane);
    expect(pane.hasAttribute('inert')).toBe(true);
    expect(pane.classList.contains('neo-scene-detail')).toBe(false);
    expect(screen.getByRole('textbox', { name: 'Draft' })).toBe(draft);
    expect(draft.value).toBe('Fictional unsent draft');
    expect(main.scrollTop).toBe(143);
    expect(chat.hasAttribute('inert')).toBe(false);
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Fictional one' }));
  });

  it('releases background controls at the real desktop boundary without remounting the selected card', () => {
    const { container } = mount();
    fireEvent.click(screen.getByRole('button', { name: 'Fictional one' }));
    const card = within(screen.getByRole('region', { name: 'Selected work' })).getByRole('article');
    const chat = container.querySelector('.neo-chat-rail')!;
    vi.stubGlobal('innerWidth', 1120);
    act(() => {
      window.dispatchEvent(new Event('resize'));
    });
    expect(chat.hasAttribute('inert')).toBe(false);
    expect(within(screen.getByRole('region', { name: 'Selected work' })).getByRole('article')).toBe(
      card
    );
    vi.stubGlobal('innerWidth', 1119);
    act(() => {
      window.dispatchEvent(new Event('resize'));
    });
    expect(chat.hasAttribute('inert')).toBe(true);
    expect(within(screen.getByRole('region', { name: 'Selected work' })).getByRole('article')).toBe(
      card
    );
  });

  it('clears an obsolete detail and restores reachable controls when the conversation scope changes', () => {
    const { container, model } = mount();
    fireEvent.click(screen.getByRole('button', { name: 'Fictional one' }));
    act(() => {
      model.value = { ...model.value, selectedId: 'another-context' };
    });
    expect(screen.queryByRole('region', { name: 'Selected work' })).toBeNull();
    expect(container.querySelector('.neo-chat-rail')!.hasAttribute('inert')).toBe(false);
    expect(screen.getByRole('textbox', { name: 'Draft' })).toBeTruthy();
  });

  it('keeps narrow motion, own detail scrolling and reduced-motion behavior separate from desktop panes', () => {
    const css = readFileSync(new NodeURL('../neo.css', import.meta.url), 'utf8');
    const narrow = css.split('@media (max-width: 1119px) {')[1]!.split('@media')[0]!;
    expect(narrow).toMatch(
      /\.neo-public-layout \.neo-mobile-detail \{[^}]*position: absolute;[^}]*inset: 0;[^}]*overflow-y: auto;[^}]*transform: translateX\(100%\);[^}]*visibility: hidden;/
    );
    expect(narrow).toMatch(
      /\.neo-detail-open \.neo-mobile-detail \{[^}]*transform: translateX\(0\);[^}]*visibility: visible;/
    );
    expect(narrow).toContain('.neo-detail-open .neo-chat-rail,');
    expect(narrow).toContain('.neo-detail-open .neo-scene-list,');
    expect(narrow).toMatch(
      /\.neo-detail-open \.neo-composer-dock \{[^}]*transform: translateX\(-100%\);/
    );
    expect(narrow).not.toContain('transition:');
    expect(css).toContain('@media (max-width: 1119px) and (prefers-reduced-motion: no-preference)');
    expect(css).not.toContain('pointer: coarse');
  });
});
