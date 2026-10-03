import type {
  NeoConsultation,
  NeoConsultationWaiter,
  NeoWork,
} from '@hyperneo/shared/types/neo-context';
import { signal } from '@preact/signals';
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/preact';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
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
  const view = render(<NeoLive />);
  const toggle = view.container.querySelector('[data-scene-toggle]');
  if (toggle) fireEvent.click(toggle);
  return { ...view, model };
}

const openCheck = (container: Element, id: string) => {
  const opener = container.querySelector<HTMLButtonElement>(`[data-consultation-open="${id}"]`)!;
  expect(opener).toBeTruthy();
  fireEvent.click(opener);
};

describe('Neo public mixed consultation scenes', () => {
  it('names concurrent summary checks by their holder and never shows failed checks', () => {
    const { container, model } = mount();
    const running = screen.getByRole('region', { name: 'In progress' });
    for (const holder of ['a', 'b']) {
      const name = new RegExp(`^View details for Context check for Fictional holder ${holder}$`);
      expect(within(running).getByRole('button', { name })).toBeTruthy();
    }
    act(() => {
      model.value = {
        ...model.value,
        viewSnapshot: {
          ...model.value.viewSnapshot,
          consultations: [
            ...model.value.viewSnapshot.consultations,
            { ...consultation('failed-b', 'failed'), concernId: 'b' },
          ],
        },
      };
    });
    expect(container.querySelector('[data-consultation-open="failed"]')).toBeNull();
    expect(container.querySelector('[data-consultation-open="failed-b"]')).toBeNull();
    expect(
      screen.queryByRole('region', { name: 'Needs your attention' })?.textContent ?? ''
    ).not.toContain('Context check');
    openCheck(container, 'pending');
    expect(model.value.open).toHaveBeenCalledExactlyOnceWith('a');
  });

  it('hides failed context checks and shows the other statuses with truthful counts and non-actionable running/outcome summaries', () => {
    const { container, model } = mount();
    for (const [name, count] of [
      ['Needs your attention', 1],
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

  it.each([false, true])(
    'opens the holder context for a pending check in narrow=%s without an action or draft loss',
    (narrow) => {
      vi.stubGlobal('matchMedia', () => ({ matches: !narrow }));
      const { container, model } = mount();
      const draft = screen.getByRole('textbox', { name: 'Draft' }) as HTMLTextAreaElement;
      fireEvent.input(draft, { target: { value: 'Fictional draft survives context detail' } });
      openCheck(container, 'pending');
      expect(model.value.open).toHaveBeenCalledExactlyOnceWith('a');
      expect(screen.queryByRole('region', { name: 'Selected context check' })).toBeNull();
      expect(container.querySelector('.neo-chat-rail')?.hasAttribute('inert')).toBe(false);
      expect(model.value.act).not.toHaveBeenCalled();
      expect(screen.getByRole('textbox', { name: 'Draft' })).toBe(draft);
      expect(draft.value).toBe('Fictional draft survives context detail');
    }
  );

  it('keeps a colliding work ID distinct from its context-check counterpart', () => {
    const { container, model } = mount();
    openCheck(container, 'pending');
    expect(model.value.open).toHaveBeenCalledExactlyOnceWith('a');
    const list = screen.getByRole('region', { name: 'Neo scenes' });
    expect(
      within(list).getByRole('article', { name: 'Fictional execution proposal' })
    ).toBeTruthy();
    expect(list.querySelector('[data-consultation-open="pending"]')).toBeTruthy();
    fireEvent.click(within(list).getByRole('button', { name: 'Start work' }));
    expect(model.value.act).toHaveBeenCalledExactlyOnceWith('pending', 'start');
    expect(model.value.open).toHaveBeenCalledTimes(1);
  });

  it('opens a reported context response through its holder', () => {
    const { container, model } = mount();
    openCheck(container, 'reported');
    expect(model.value.open).toHaveBeenCalledExactlyOnceWith('a');
    expect(model.value.act).not.toHaveBeenCalled();
  });

  it('preserves the single pending banner and work-only scene groups in legacy mode', () => {
    const { container, model } = mount(false);
    expect(screen.getByRole('region', { name: 'Work scenes' })).toBeTruthy();
    expect(container.textContent?.match(/Checking with/g)).toHaveLength(1);
    expect(container.querySelectorAll('[data-consultation-open]')).toHaveLength(0);
    expect(screen.queryByRole('region', { name: 'Recent outcomes' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Stop waiting' }));
    expect(model.value.act).toHaveBeenCalledExactlyOnceWith('pending', 'stop-waiting');
  });

  it('drops context-check scenes if the durable public presentation is no longer supplied', () => {
    const { container, model } = mount();
    expect(container.querySelector('[data-consultation-open]')).toBeTruthy();
    act(() => {
      model.value = { ...model.value, viewPublicConversation: undefined };
    });
    expect(screen.getAllByRole('button', { name: 'Stop waiting' })).toHaveLength(1);
    expect(container.querySelector('[data-consultation-open]')).toBeNull();
    expect(model.value.act).not.toHaveBeenCalled();
  });
});
