import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/preact';
import { signal } from '@preact/signals';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { NeoLive } from '../NeoLive.tsx';

const useNeoMock = vi.hoisted(() => vi.fn());
vi.mock('../useNeo.ts', () => ({ useNeo: useNeoMock }));
vi.mock('../../lib/state.ts', () => ({
  connectionState: { value: 'connected', subscribe: () => () => {} },
}));
vi.mock('../NeoComposer.tsx', () => ({ NeoComposer: () => null }));
vi.mock('../NeoConversation.tsx', () => ({ NeoConversation: () => <p>Latest conversation</p> }));
vi.mock('../../islands/ToastContainer.tsx', () => ({ default: () => null }));
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('NeoLive consultation status', () => {
  it('shows the pending holder below the transcript, opens it, and clears the status after a reply', async () => {
    vi.stubGlobal(
      'ResizeObserver',
      class {
        observe() {}
        disconnect() {}
      }
    );
    const open = vi.fn();
    const snapshot = {
      concerns: [{ id: 'club', title: 'Book club', summary: 'Sunday', context: 'Eight people' }],
      work: [],
      consultations: [{ id: 'consult-one', concernId: 'club', status: 'pending' }],
    };
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
    render(<NeoLive />);
    const status = screen.getByRole('status');
    expect(status.textContent).toContain('Checking with Book club');
    expect(
      screen.getByText('Latest conversation').compareDocumentPosition(status) &
        Node.DOCUMENT_POSITION_FOLLOWING
    ).toBeTruthy();
    fireEvent.click(status.querySelector('button')!);
    expect(open).toHaveBeenCalledWith('club');
    fireEvent.click(screen.getByRole('button', { name: 'Stop waiting' }));
    expect(model.act).toHaveBeenCalledWith('consult-one', 'stop-waiting');
    act(() => {
      neoState.value = { ...model, busyWork: 'consult-one' };
    });
    expect(screen.getByRole('button', { name: 'Closing…' }).hasAttribute('disabled')).toBe(true);
    const reported = {
      ...snapshot,
      consultations: [{ ...snapshot.consultations[0], status: 'reported' }],
    };
    act(() => {
      neoState.value = { ...model, snapshot: reported, viewSnapshot: reported };
    });
    await waitFor(() => expect(screen.queryByRole('status')).toBeNull());
    act(() => {
      neoState.value = { ...model, selectedId: 'different' };
    });
    await waitFor(() => expect(screen.queryByRole('status')).toBeNull());
    act(() => {
      neoState.value = {
        ...model,
        selectedId: 'club',
        snapshot: { ...snapshot, consultations: [] },
        viewSnapshot: snapshot,
      };
    });
    await waitFor(() =>
      expect(screen.getByRole('status').textContent).toContain('Checking with Book club')
    );
    act(() => {
      neoState.value = { ...model, selectedId: 'club', viewSnapshot: null };
    });
    await waitFor(() => expect(screen.queryByRole('status')).toBeNull());
  });
});
