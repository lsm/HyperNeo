vi.mock('../NeoGoals.tsx', () => ({ NeoGoals: () => null }));
import { signal } from '@preact/signals';
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/preact';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { connectionState } from '../../lib/state.ts';
import { NeoLive } from '../NeoLive.tsx';
import { testAskEntry } from './neo-test-views.ts';

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
function mount(publicMode = true, empty = false) {
  const snapshot = {
    sessionId: root,
    projects: ['a', 'b'].map((id) => ({
      id,
      title: `Fictional holder ${id}`,
      summary: 'Fictional context',
      context: 'Three fictional flowers',
      revision: 1,
      createdAt: 1,
      updatedAt: 1,
    })),
    work: [],
    todoAsks: empty
      ? []
      : [testAskEntry('waiting', 'Fictional execution proposal', { state: 'waiting' })],
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

describe('Neo public work scenes', () => {
  it.each([true, false])('keeps an empty Work surface accessible on desktop=%s', (desktop) => {
    vi.stubGlobal('matchMedia', () => ({ matches: desktop }));
    const { container } = mount(true, true);
    expect(container.querySelector('.neo-shell')?.classList.contains('neo-has-scenes')).toBe(true);
    const work = screen.getByRole('region', { name: 'Work scenes' });
    expect(within(work).getByRole('status').textContent).toBe('No work yet.');
    expect(work.querySelectorAll('[data-scene-group]')).toHaveLength(0);
    if (!desktop) {
      fireEvent.click(screen.getByRole('button', { name: 'Close work list' }));
      expect(screen.queryByRole('region', { name: 'Work scenes' })).toBeNull();
      fireEvent.click(screen.getByRole('button', { name: 'Your work' }));
      expect(screen.getByRole('region', { name: 'Work scenes' })).toBeTruthy();
    }
  });

  it('keeps the empty legacy scene list collapsed without a public Work placeholder', () => {
    const { container } = mount(false, true);
    expect(screen.queryByText('No work yet.')).toBeNull();
    expect(container.querySelector('.neo-has-scenes')).toBeNull();
    expect(container.querySelector('.neo-scene-list')?.childElementCount).toBe(0);
  });

  it('keeps the Work column when the last ask disappears and reuses it for new work', () => {
    const { container, model } = mount();
    const entries = model.value.snapshot.todoAsks;
    act(() => {
      model.value = { ...model.value, snapshot: { ...model.value.snapshot, todoAsks: [] } };
    });
    expect(container.querySelector('.neo-shell')?.classList.contains('neo-has-scenes')).toBe(true);
    expect(
      within(screen.getByRole('region', { name: 'Work scenes' })).getByRole('status').textContent
    ).toBe('No work yet.');
    act(() => {
      model.value = { ...model.value, snapshot: { ...model.value.snapshot, todoAsks: entries } };
    });
    expect(screen.queryByText('No work yet.')).toBeNull();
    expect(screen.getByRole('region', { name: 'Needs your attention' })).toBeTruthy();
  });

  it('shows no pending check banner and only work scene groups in legacy mode', () => {
    const { container } = mount(false);
    expect(screen.getByRole('region', { name: 'Work scenes' })).toBeTruthy();
    expect(container.textContent).not.toContain('Checking with');
    expect(screen.queryByRole('button', { name: 'Stop waiting' })).toBeNull();
    expect(screen.queryByRole('region', { name: 'Recent outcomes' })).toBeNull();
  });
});
