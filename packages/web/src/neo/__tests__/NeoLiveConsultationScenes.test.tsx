import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/preact';
import { signal } from '@preact/signals';
import { readFileSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  NeoConsultation,
  NeoConsultationWaiter,
  NeoWork,
} from '@hyperneo/shared/types/neo-context';
import { connectionState } from '../../lib/state.ts';
import { NeoLive } from '../NeoLive.tsx';

const useNeoMock = vi.hoisted(() => vi.fn());
vi.mock('../useNeo.ts', () => ({ useNeo: useNeoMock }));
vi.mock('../NeoComposer.tsx', () => ({
  NeoComposer: (props: { draft: string; onDraft: (text: string) => void }) => (
    <textarea
      aria-label="Draft"
      value={props.draft}
      onInput={(event) => props.onDraft(event.currentTarget.value)}
    />
  ),
}));
vi.mock('../NeoConversation.tsx', () => ({
  NeoConversation: () => <p>Durable fictional answer</p>,
}));
vi.mock('../../islands/ToastContainer.tsx', () => ({ default: () => null }));

beforeEach(() => {
  connectionState.value = 'connected';
  vi.stubGlobal('matchMedia', () => ({ matches: true }));
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

const root = 'neo:550e8400-e29b-41d4-a716-446655440000';
const consultation = (id: string, status: NeoConsultation['status']): NeoConsultation => ({
  id,
  status,
  requestKey: id,
  concernId: 'a',
  originSessionId: root,
  originMessageId: `ask-${id}`,
  sessionId: 'holder-a',
  question: `Full fictional question ${id}\nKeep its second line.`,
  answer: status === 'reported' ? '**Fictional context response**' : null,
  createdAt: 1,
});
const waiting = (): NeoConsultationWaiter => ({
  id: 'queued',
  requestKey: 'queued',
  concernId: 'b',
  originSessionId: root,
  originMessageId: 'ask-queued',
  sessionId: 'holder-b',
  question: 'Full queued fictional context question',
  status: 'queued',
  createdAt: 2,
});
const work: NeoWork = {
  id: 'pending',
  requestKey: 'work-pending',
  concernId: null,
  originSessionId: root,
  originMessageId: 'work-ask',
  title: 'Fictional execution proposal',
  instruction: 'Fictional work brief',
  status: 'proposed',
  sessionId: null,
  targetSessionId: null,
  report: null,
  createdAt: 3,
  updatedAt: 3,
};

function mount(publicMode = true) {
  const snapshot = {
    sessionId: root,
    concerns: ['a', 'b'].map((id) => ({
      id,
      title: `Fictional holder ${id}`,
      summary: 'Fictional context',
      context: 'Three fictional flowers',
      revision: 1,
      createdAt: 1,
      updatedAt: 1,
    })),
    work: [work],
    consultations: [
      consultation('pending', 'pending'),
      consultation('reported', 'reported'),
      consultation('failed', 'failed'),
    ],
    consultationWaiters: [waiting()],
  };
  const model = signal({
    sessionId: root,
    selectedId: null as string | null,
    snapshot,
    viewSnapshot: snapshot,
    viewPublicConversation: publicMode
      ? {
          conversationId: root.slice(4),
          status: 'ready',
          entries: [],
          hasEarlier: false,
          hasMore: false,
        }
      : undefined,
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
    busyWork: null as string | null,
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

const openCheck = (container: Element, id: string) => {
  const opener = container.querySelector<HTMLButtonElement>(`[data-consultation-open="${id}"]`)!;
  expect(opener).toBeTruthy();
  fireEvent.click(opener);
  return screen.getByRole('region', { name: 'Selected context check' });
};

describe('Neo public mixed consultation scenes', () => {
  it('keeps the empty-scene notice visible when the only receipt is in full detail', () => {
    const { container, model } = mount();
    act(() => {
      model.value = {
        ...model.value,
        viewSnapshot: {
          ...model.value.viewSnapshot,
          work: [],
          consultations: [consultation('reported', 'reported')],
          consultationWaiters: [],
        },
      };
    });
    openCheck(container, 'reported');
    const list = screen.getByRole('region', { name: 'Work scenes' });
    expect(list.querySelector('[data-scene-group]')).toBeNull();
    expect(list.textContent).toBe('No other scenes right now.');
    const css = readFileSync('src/neo/neo.css', 'utf8');
    const rule = css.match(/\.neo-scene-list:empty\s*\{[^}]*display:\s*none;[^}]*\}/)?.[0];
    expect(rule).toBeTruthy();
    const style = document.createElement('style');
    style.textContent = rule!;
    document.head.append(style);
    expect(getComputedStyle(list).display).not.toBe('none');
    list.replaceChildren();
    expect(getComputedStyle(list).display).toBe('none');
    style.remove();
  });

  it('shows all four context-check statuses with truthful counts and non-actionable running/outcome summaries', () => {
    const { container, model } = mount();
    for (const [name, count] of [
      ['Needs your attention', 2],
      ['In progress', 2],
      ['Recent outcomes', 1],
    ] as const)
      expect(screen.getByRole('region', { name }).textContent).toContain(`${name} · ${count}`);
    const running = screen.getByRole('region', { name: 'In progress' });
    const outcomes = screen.getByRole('region', { name: 'Recent outcomes' });
    expect(running.textContent).toContain('Checking context');
    expect(running.textContent).toContain('Waiting for context');
    expect(outcomes.textContent).toContain('Response ready');
    expect(running.querySelector('article, details, input, textarea, a')).toBeNull();
    expect(outcomes.querySelector('article, details, input, textarea, a')).toBeNull();
    expect(screen.queryByRole('button', { name: 'Stop waiting' })).toBeNull();
    expect(container.textContent).not.toContain('Checking with');
    expect(model.value.act).not.toHaveBeenCalled();
  });

  it.each(['pending', 'queued'])(
    'opens full %s detail without invoking an action and closes only its exact wait',
    (id) => {
      const { container, model } = mount();
      const draft = screen.getByRole('textbox', { name: 'Draft' }) as HTMLTextAreaElement;
      fireEvent.input(draft, { target: { value: 'Fictional draft survives context detail' } });
      const detail = openCheck(container, id);
      expect(detail.querySelector('button')).toBe(document.activeElement);
      expect(detail.querySelector('details p')?.textContent).toBe(
        id === 'queued' ? waiting().question : consultation(id, 'pending').question
      );
      expect(within(detail).queryByRole('button', { name: 'Start work' })).toBeNull();
      expect(within(detail).queryByRole('link', { name: /Inspect/ })).toBeNull();
      expect(model.value.act).not.toHaveBeenCalled();
      fireEvent.click(within(detail).getByRole('button', { name: 'Stop waiting' }));
      expect(model.value.act).toHaveBeenCalledExactlyOnceWith(id, 'stop-waiting');
      fireEvent.click(within(detail).getByRole('button', { name: 'Back to scenes' }));
      expect(screen.queryByRole('region', { name: 'Selected context check' })).toBeNull();
      expect(screen.getByRole('textbox', { name: 'Draft' })).toBe(draft);
      expect(draft.value).toBe('Fictional draft survives context detail');
      expect(document.activeElement).toBe(
        container.querySelector(`[data-consultation-open="${id}"]`)
      );
    }
  );

  it('keeps a colliding work ID visible when selecting its context-check counterpart', () => {
    const { container, model } = mount();
    openCheck(container, 'pending');
    const list = screen.getByRole('region', { name: 'Work scenes' });
    expect(
      within(list).getByRole('article', { name: 'Fictional execution proposal' })
    ).toBeTruthy();
    expect(list.querySelector('[data-consultation-open="pending"]')).toBeNull();
    fireEvent.click(within(list).getByRole('button', { name: 'Start work' }));
    expect(model.value.act).toHaveBeenCalledExactlyOnceWith('pending', 'start');
    fireEvent.click(within(list).getByRole('button', { name: 'Fictional execution proposal' }));
    expect(screen.getByRole('region', { name: 'Selected work' })).toBeTruthy();
    expect(screen.queryByRole('region', { name: 'Selected context check' })).toBeNull();
    expect(list.querySelector('[data-consultation-open="pending"]')).toBeTruthy();
  });

  it('updates full detail to the reported Markdown response and removes closure without claiming verified completion', async () => {
    const { container, model } = mount();
    const detail = openCheck(container, 'pending');
    act(() => {
      model.value = {
        ...model.value,
        viewSnapshot: {
          ...model.value.viewSnapshot,
          consultations: [consultation('pending', 'reported')],
        },
      };
    });
    expect(screen.getByRole('region', { name: 'Selected context check' })).toBe(detail);
    expect(within(detail).queryByRole('button', { name: 'Stop waiting' })).toBeNull();
    await waitFor(() =>
      expect(detail.querySelector('strong')?.textContent).toBe('Fictional context response')
    );
    expect(within(detail).getByRole('button', { name: 'Copy context response' })).toBeTruthy();
    expect(detail.textContent).toContain('not verified completion');
    expect(model.value.act).not.toHaveBeenCalled();
    fireEvent.click(within(detail).getByRole('button', { name: 'Fictional holder a' }));
    expect(model.value.open).toHaveBeenCalledExactlyOnceWith('a');
  });

  it.each(['removal', 'scope'])(
    'clears an obsolete context detail on %s without invoking a native action',
    (change) => {
      const { container, model } = mount();
      openCheck(container, 'pending');
      act(() => {
        model.value =
          change === 'scope'
            ? { ...model.value, selectedId: 'b' }
            : { ...model.value, viewSnapshot: { ...model.value.viewSnapshot, consultations: [] } };
      });
      expect(screen.queryByRole('region', { name: 'Selected context check' })).toBeNull();
      expect(screen.getByRole('textbox', { name: 'Draft' })).toBeTruthy();
      expect(model.value.act).not.toHaveBeenCalled();
    }
  );

  it('preserves the single pending banner and work-only scene groups in legacy mode', () => {
    const { container, model } = mount(false);
    expect(container.textContent?.match(/Checking with/g)).toHaveLength(1);
    expect(container.querySelectorAll('[data-consultation-open]')).toHaveLength(0);
    expect(screen.queryByRole('region', { name: 'Recent outcomes' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Stop waiting' }));
    expect(model.value.act).toHaveBeenCalledExactlyOnceWith('pending', 'stop-waiting');
  });

  it('clears context detail if the durable public presentation is no longer supplied', () => {
    const { container, model } = mount();
    openCheck(container, 'pending');
    act(() => {
      model.value = { ...model.value, viewPublicConversation: undefined };
    });
    expect(screen.queryByRole('region', { name: 'Selected context check' })).toBeNull();
    expect(screen.getAllByRole('button', { name: 'Stop waiting' })).toHaveLength(1);
    expect(container.querySelector('[data-consultation-open]')).toBeNull();
    expect(model.value.act).not.toHaveBeenCalled();
  });
});
