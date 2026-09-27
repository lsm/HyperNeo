import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/preact';
import { signal } from '@preact/signals';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { NeoLive } from '../NeoLive.tsx';

const useNeoMock = vi.hoisted(() => vi.fn());
vi.mock('../useNeo.ts', () => ({ useNeo: useNeoMock }));
vi.mock('../../lib/state.ts', () => ({ connectionState: { value: 'connected' } }));
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
      error: null,
      setError: vi.fn(),
      open,
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
    act(() => {
      neoState.value = {
        ...model,
        snapshot: {
          ...snapshot,
          consultations: [{ ...snapshot.consultations[0], status: 'reported' }],
        },
      };
    });
    await waitFor(() => expect(screen.queryByRole('status')).toBeNull());
    act(() => {
      neoState.value = { ...model, selectedId: 'different' };
    });
    await waitFor(() => expect(screen.queryByRole('status')).toBeNull());
  });
});
