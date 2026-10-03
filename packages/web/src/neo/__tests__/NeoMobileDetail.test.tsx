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

  it('opens detail inside the work surface while retaining the conversation, draft and native actions', () => {
    const { container, model } = mount();
    const chat = container.querySelector('.neo-chat-rail')!;
    const draft = screen.getByRole('textbox', { name: 'Draft' }) as HTMLTextAreaElement;
    const surface = screen.getByRole('complementary', { name: 'Work surface' });
    const opener = screen.getByRole('button', { name: 'Fictional one' });
    fireEvent.input(draft, { target: { value: 'Fictional unsent draft' } });
    fireEvent.click(opener);
    const detail = screen.getByRole('region', { name: 'Selected work' });
    expect(surface.contains(detail)).toBe(true);
    expect(container.querySelector('.neo-chat-rail')).toBe(chat);
    expect(chat.hasAttribute('inert')).toBe(true);
    expect(model.value.act).not.toHaveBeenCalled();
    fireEvent.click(within(detail).getByRole('button', { name: 'Start work' }));
    expect(model.value.act).toHaveBeenCalledExactlyOnceWith('one', 'start');
    fireEvent.click(within(detail).getByRole('button', { name: 'Back to scenes' }));
    expect(screen.queryByRole('region', { name: 'Selected work' })).toBeNull();
    expect(screen.getByRole('textbox', { name: 'Draft' })).toBe(draft);
    expect(draft.value).toBe('Fictional unsent draft');
    expect(document.activeElement).toBe(opener);
  });

  it('reveals the work surface by swipe from the right edge and hides it on rightward swipe', () => {
    const { container } = mount();
    const shell = container.querySelector('.neo-shell')!;
    const chat = container.querySelector('.neo-chat-rail')!;
    const surface = screen.getByRole('complementary', { name: 'Work surface' });
    expect(container.querySelector('.neo-shell')!.classList.contains('neo-surface-open')).toBe(
      false
    );
    const touch = (type: 'touchstart' | 'touchend', x: number, y: number) => {
      const event = new Event(type, { bubbles: true });
      Object.defineProperty(event, type === 'touchstart' ? 'touches' : 'changedTouches', {
        value: [{ clientX: x, clientY: y }],
      });
      return event;
    };
    expect(chat.hasAttribute('inert')).toBe(false);
    fireEvent(shell, touch('touchstart', 388, 400));
    fireEvent(shell, touch('touchend', 340, 400));
    expect(container.querySelector('.neo-shell')!.classList.contains('neo-surface-open')).toBe(true);
    expect(surface.getAttribute('aria-label')).toBe('Work surface');
    expect(chat.hasAttribute('inert')).toBe(true);
    fireEvent(shell, touch('touchstart', 120, 400));
    fireEvent(shell, touch('touchend', 240, 400));
    expect(container.querySelector('.neo-shell')!.classList.contains('neo-surface-open')).toBe(
      false
    );
    expect(chat.hasAttribute('inert')).toBe(false);
  });

  it('keeps the top-right trigger with an attention badge at mobile widths', () => {
    mount();
    const trigger = screen.getByRole('button', { name: /Work surface/ });
    expect(trigger.getAttribute('aria-expanded')).toBe('false');
    fireEvent.click(trigger);
    expect(trigger.getAttribute('aria-expanded')).toBe('true');
  });

  it('positions the work surface as a right-edge view with reduced-motion support', () => {
    const css = readFileSync(new NodeURL('../neo.css', import.meta.url), 'utf8');
    expect(css).toMatch(
      /\.neo-work-surface \{[^}]*position: absolute;[^}]*right: 0;[^}]*translateX\(100%\);[^}]*visibility: hidden;/s
    );
    expect(css).toMatch(/@media \(max-width: 1119px\) \{[^}]*\.neo-surface-open \.neo-work-surface/s);
    expect(css).not.toContain('neo-mobile-detail');
    expect(css).not.toContain('neo-concerns-card');
  });
});
