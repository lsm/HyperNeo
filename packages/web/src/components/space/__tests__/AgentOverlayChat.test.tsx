// @ts-nocheck
/**
 * Unit tests for AgentOverlayChat
 *
 * The overlay no longer renders its own header — the embedded `ChatContainer`
 * owns the single header, with its left-slot back button (opted in via
 * `onBack`) acting as the dismiss control. These tests verify:
 * - The outer wrapper dialog renders with `data-testid="agent-overlay-chat"`.
 * - The aria-label reflects `agentName` (or falls back to "Agent chat") so
 *   screen readers identify which agent is open.
 * - `ChatContainer` receives both `sessionId` and an `onBack` callback.
 * - Clicking the back button surfaced by ChatContainer invokes `onClose`.
 * - Escape key press invokes `onClose` (only once, only on Escape).
 * - Backdrop click invokes `onClose`.
 * - Escape listener is removed on unmount.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render } from '@testing-library/preact';

const mockSendTaskMessage = vi.hoisted(() => vi.fn());

// Captures the `store` prop forwarded to the mocked ChatContainer so tests can
// assert the overlay owns a dedicated SessionStore instance (not the singleton)
// and tears it down on unmount.
const captured = vi.hoisted(() => ({ current: null as unknown, history: [] as unknown[] }));

// Mock ChatContainer — it relies on WebSocket/stores not available in unit
// tests. Expose `onBack` via a data-attribute so tests can assert it was
// forwarded, and render a button that invokes it so the dismiss path through
// ChatContainer's header is covered end-to-end.
vi.mock('../../../islands/ChatContainer', () => ({
  default: ({
    sessionId,
    onBack,
    onSendOverride,
    store,
  }: {
    sessionId: string;
    onBack?: () => void;
    onSendOverride?: (message: string, images?: unknown) => Promise<boolean>;
    store?: unknown;
  }) => {
    captured.current = store;
    captured.history.push(store);
    return (
      <div
        data-testid="mock-chat-container"
        data-has-on-back={onBack ? '1' : '0'}
        data-has-send-override={onSendOverride ? '1' : '0'}
        data-has-store={store ? '1' : '0'}
      >
        <button type="button" data-testid="mock-chat-header-back" onClick={onBack}>
          back
        </button>
        {onSendOverride ? (
          <>
            <button
              type="button"
              data-testid="mock-chat-send-override"
              onClick={() => void onSendOverride(' hello node ')}
            >
              send
            </button>
            <button
              type="button"
              data-testid="mock-chat-send-override-with-images"
              onClick={() =>
                void onSendOverride(' hello with screenshot ', [
                  { media_type: 'image/png', data: 'AAAAB' },
                ])
              }
            >
              send-with-images
            </button>
          </>
        ) : null}
        {sessionId}
      </div>
    );
  },
}));

vi.mock('../../../lib/space-store', () => ({
  spaceStore: {
    sendTaskMessage: mockSendTaskMessage,
  },
}));

// Mock cn utility
vi.mock('../../../lib/utils', () => ({
  cn: (...args: unknown[]) => args.filter(Boolean).join(' '),
}));

import { AgentOverlayChat } from '../AgentOverlayChat';
import { SessionStore, sessionStore } from '../../../lib/session-store';

const SESSION_ID = 'abcdef12-0000-0000-0000-000000000000';
const OTHER_SESSION_ID = 'fedcba98-0000-0000-0000-000000000000';

describe('AgentOverlayChat', () => {
  let onClose: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    cleanup();
    mockSendTaskMessage.mockReset();
    mockSendTaskMessage.mockResolvedValue({ delivered: true });
    onClose = vi.fn();
    captured.current = null;
    captured.history = [];
  });

  afterEach(() => {
    cleanup();
  });

  it('renders the overlay wrapper with correct data-testid', () => {
    const { getByTestId } = render(<AgentOverlayChat sessionId={SESSION_ID} onClose={onClose} />);
    expect(getByTestId('agent-overlay-chat')).toBeTruthy();
  });

  it('reflects agentName in the dialog aria-label for screen readers', () => {
    const { getByTestId } = render(
      <AgentOverlayChat sessionId={SESSION_ID} agentName="My Agent" onClose={onClose} />
    );
    expect(getByTestId('agent-overlay-chat').getAttribute('aria-label')).toBe('My Agent chat');
  });

  it('falls back to a generic "Agent chat" aria-label when agentName is not provided', () => {
    const { getByTestId } = render(<AgentOverlayChat sessionId={SESSION_ID} onClose={onClose} />);
    expect(getByTestId('agent-overlay-chat').getAttribute('aria-label')).toBe('Agent chat');
  });

  it('forwards onBack to ChatContainer so its header back button dismisses the overlay', () => {
    const { getByTestId } = render(<AgentOverlayChat sessionId={SESSION_ID} onClose={onClose} />);
    expect(getByTestId('mock-chat-container').getAttribute('data-has-on-back')).toBe('1');
    fireEvent.click(getByTestId('mock-chat-header-back'));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('routes task-context sends with the exact node execution id', async () => {
    const { getByTestId } = render(
      <AgentOverlayChat
        sessionId={SESSION_ID}
        onClose={onClose}
        taskContext={{
          taskId: 'task-1',
          agentName: 'coder',
          nodeExecutionId: 'exec-coder-1',
        }}
      />
    );
    expect(getByTestId('mock-chat-container').getAttribute('data-has-send-override')).toBe('1');

    fireEvent.click(getByTestId('mock-chat-send-override'));
    await vi.waitFor(() => {
      expect(mockSendTaskMessage).toHaveBeenCalledWith(
        'task-1',
        'hello node',
        {
          kind: 'node_agent',
          agentName: 'coder',
          nodeExecutionId: 'exec-coder-1',
        },
        undefined
      );
    });
  });

  it('forwards image attachments through onSendOverride to spaceStore.sendTaskMessage', async () => {
    const { getByTestId } = render(
      <AgentOverlayChat
        sessionId={SESSION_ID}
        onClose={onClose}
        taskContext={{
          taskId: 'task-1',
          agentName: 'coder',
          nodeExecutionId: 'exec-coder-1',
        }}
      />
    );

    fireEvent.click(getByTestId('mock-chat-send-override-with-images'));

    await vi.waitFor(() => {
      expect(mockSendTaskMessage).toHaveBeenCalledWith(
        'task-1',
        'hello with screenshot',
        {
          kind: 'node_agent',
          agentName: 'coder',
          nodeExecutionId: 'exec-coder-1',
        },
        [{ media_type: 'image/png', data: 'AAAAB' }]
      );
    });
  });

  it('calls onClose when Escape key is pressed', () => {
    render(<AgentOverlayChat sessionId={SESSION_ID} onClose={onClose} />);
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('does not call onClose for non-Escape key presses', () => {
    render(<AgentOverlayChat sessionId={SESSION_ID} onClose={onClose} />);
    fireEvent.keyDown(document, { key: 'Enter' });
    fireEvent.keyDown(document, { key: 'a' });
    expect(onClose).not.toHaveBeenCalled();
  });

  it('calls onClose when backdrop is clicked', () => {
    const { getByTestId } = render(<AgentOverlayChat sessionId={SESSION_ID} onClose={onClose} />);
    // The backdrop is the first child of the overlay wrapper (aria-hidden div)
    const overlay = getByTestId('agent-overlay-chat');
    const backdrop = overlay.querySelector('[aria-hidden="true"]');
    expect(backdrop).toBeTruthy();
    fireEvent.click(backdrop!);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('renders the mock ChatContainer with the provided sessionId', () => {
    const { getByTestId } = render(<AgentOverlayChat sessionId={SESSION_ID} onClose={onClose} />);
    const chatContainer = getByTestId('mock-chat-container');
    expect(chatContainer).toBeTruthy();
    expect(chatContainer.textContent).toContain(SESSION_ID);
  });

  it('removes Escape key listener on unmount', () => {
    const { unmount } = render(<AgentOverlayChat sessionId={SESSION_ID} onClose={onClose} />);
    unmount();
    // After unmount, pressing Escape should not call onClose
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(onClose).not.toHaveBeenCalled();
  });

  describe('dedicated SessionStore ownership', () => {
    it('passes a dedicated SessionStore to ChatContainer — not the singleton', () => {
      render(<AgentOverlayChat sessionId={SESSION_ID} onClose={onClose} />);
      expect(getStoreFromMock()).toBeTruthy();
      // The overlay must NOT share the process-wide singleton — that is the
      // bug that lets an overlay clobber the base chat's state.
      expect(getStoreFromMock()).not.toBe(sessionStore);
      expect(getStoreFromMock()).toBeInstanceOf(SessionStore);
    });

    it('reuses the same store across a B→C sessionId switch (no per-switch churn)', () => {
      const { rerender } = render(<AgentOverlayChat sessionId={SESSION_ID} onClose={onClose} />);
      const firstStore = getStoreFromMock();

      rerender(<AgentOverlayChat sessionId={OTHER_SESSION_ID} onClose={onClose} />);

      // The overlay owns ONE store for its lifetime; switching the displayed
      // session must reuse it (the embedded ChatContainer's key handles the
      // internal select(null)→select(C) transition).
      expect(getStoreFromMock()).toBe(firstStore);
    });

    it('destroys the dedicated store on unmount, releasing only the overlay resources', async () => {
      const { unmount } = render(<AgentOverlayChat sessionId={SESSION_ID} onClose={onClose} />);
      const store = getStoreFromMock();
      expect(store).toBeInstanceOf(SessionStore);
      const destroySpy = vi.spyOn(store as SessionStore, 'destroy').mockResolvedValue(undefined);

      unmount();
      await vi.waitFor(() => {
        expect(destroySpy).toHaveBeenCalledTimes(1);
      });
    });
  });
});

/** Reads the store captured by the mocked ChatContainer on its latest render. */
function getStoreFromMock(): SessionStore {
  return captured.current as SessionStore;
}
