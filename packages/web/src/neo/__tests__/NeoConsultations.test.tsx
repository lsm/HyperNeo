import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/preact';
import { signal } from '@preact/signals';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NeoLive } from '../NeoLive.tsx';

const useNeoMock = vi.hoisted(() => vi.fn());
vi.mock('../useNeo.ts', () => ({ useNeo: useNeoMock }));
vi.mock('../../lib/state.ts', () => ({
  connectionState: { value: 'connected', subscribe: () => () => {} },
}));
vi.mock('../NeoComposer.tsx', () => ({ NeoComposer: () => null }));
vi.mock('../NeoConversation.tsx', () => ({ NeoConversation: () => <p>Latest conversation</p> }));
vi.mock('../../islands/ToastContainer.tsx', () => ({ default: () => null }));

beforeEach(() => {
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

const snapshot = {
  concerns: [{ id: 'club', title: 'Book club', summary: 'Sunday', context: 'Eight people' }],
  work: [],
  consultations: [{ id: 'consult-one', concernId: 'club', status: 'pending' }],
};

function mount() {
  const open = vi.fn();
  const model = {
    sessionId: 'neo',
    selectedId: null as string | null,
    snapshot,
    viewSnapshot: snapshot as typeof snapshot | null,
    error: null,
    setError: vi.fn(),
    open,
    act: vi.fn(),
    busyWork: null as string | null,
    store: {
      sessionInfo: signal({ metadata: {} }),
      sdkMessages: signal([{ type: 'user' }]),
      messagesLoaded: signal(true),
      activeSessionId: signal('neo'),
      loadErrorKind: signal(null),
      agentState: signal({ status: 'idle' }),
      error: signal(null),
      hasMoreMessages: signal(false),
      isWorking: signal(false),
    },
  };
  const neoState = signal(model);
  useNeoMock.mockImplementation(() => neoState.value);
  const result = render(<NeoLive />);
  return { ...result, model, neoState, open };
}

describe('NeoLive consultation status', () => {
  it('keeps a pending context check out of the chat flow and inside the work surface', async () => {
    const { container, model, neoState, open } = mount();
    expect(container.textContent).not.toContain('Checking with');
    expect(screen.queryByRole('status')).toBeNull();

    const running = screen.getByRole('region', { name: 'In progress' });
    expect(running.textContent).toContain('Checking context');
    const concerns = screen.getByRole('region', { name: 'Your concerns' });
    fireEvent.click(within(concerns).getByRole('button', { name: /Book club/ }));
    expect(open).toHaveBeenCalledWith('club');

    fireEvent.click(
      within(running).getByRole('button', { name: 'View details for Context check for Book club' })
    );
    const selected = screen.getByRole('region', { name: 'Selected context check' });
    fireEvent.click(within(selected).getByRole('button', { name: 'Stop waiting' }));
    expect(model.act).toHaveBeenCalledWith('consult-one', 'stop-waiting');

    act(() => {
      neoState.value = { ...model, busyWork: 'consult-one' };
    });
    expect(screen.getByRole('button', { name: 'Closing…' }).hasAttribute('disabled')).toBe(true);

    fireEvent.click(screen.getByRole('button', { name: 'Back to scenes' }));
    expect(screen.queryByRole('region', { name: 'Selected context check' })).toBeNull();

    const reported = {
      ...snapshot,
      consultations: [{ ...snapshot.consultations[0], status: 'reported' as const }],
    };
    act(() => {
      neoState.value = { ...model, snapshot: reported, viewSnapshot: reported };
    });
    await waitFor(() =>
      expect(screen.getByRole('region', { name: 'Recent outcomes' }).textContent).toContain(
        'Response ready'
      )
    );
    expect(screen.queryByRole('region', { name: 'In progress' })).toBeNull();
    expect(container.textContent).not.toContain('Checking with');
  });
});
