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

// Mock ChatContainer — it relies on WebSocket/stores not available in unit
// tests. Expose `onBack` via a data-attribute so tests can assert it was
// forwarded, and render a button that invokes it so the dismiss path through
// ChatContainer's header is covered end-to-end.
vi.mock('../../../islands/ChatContainer', () => ({
  default: ({
    sessionId,
    onBack,
    onSendOverride,
  }: {
    sessionId: string;
    onBack?: () => void;
    onSendOverride?: (message: string, images?: unknown) => Promise<boolean>;
  }) => (
    <div
      data-testid="mock-chat-container"
      data-has-on-back={onBack ? '1' : '0'}
      data-has-send-override={onSendOverride ? '1' : '0'}
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
  ),
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

const SESSION_ID = 'abcdef12-0000-0000-0000-000000000000';

describe('AgentOverlayChat', () => {
  let onClose: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    cleanup();
    mockSendTaskMessage.mockReset();
    mockSendTaskMessage.mockResolvedValue({ delivered: true });
    onClose = vi.fn();
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
});
