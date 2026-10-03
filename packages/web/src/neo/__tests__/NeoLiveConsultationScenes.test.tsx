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
    snapshot,
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
  const sheet = screen.queryByRole('button', { name: /^Your work/ });
  if (sheet) fireEvent.click(sheet);
  return { ...view, model };
}

describe('Neo public mixed consultation scenes', () => {
  it('lists no context check in any scene group, whatever its status', () => {
    const { container, model } = mount();
    expect(container.querySelector('[data-consultation-open]')).toBeNull();
    expect(screen.getByRole('region', { name: 'Needs your attention' }).textContent).toContain(
      'Needs your attention · 1'
    );
    expect(screen.queryByRole('region', { name: 'In progress' })).toBeNull();
    expect(screen.queryByRole('region', { name: 'Recent outcomes' })).toBeNull();
    expect(container.textContent).not.toContain('Context check');
    expect(container.textContent).not.toContain('Checking with');
    expect(model.value.act).not.toHaveBeenCalled();
  });

  it('shows no pending check banner and only work scene groups in legacy mode', () => {
    const { container, model } = mount(false);
    expect(screen.getByRole('region', { name: 'Work scenes' })).toBeTruthy();
    expect(container.textContent).not.toContain('Checking with');
    expect(screen.queryByRole('button', { name: 'Stop waiting' })).toBeNull();
    expect(screen.queryByRole('region', { name: 'Recent outcomes' })).toBeNull();
    expect(model.value.act).not.toHaveBeenCalled();
  });
});
