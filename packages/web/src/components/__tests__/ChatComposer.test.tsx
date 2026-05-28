import { cleanup, render } from '@testing-library/preact';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ChatComposerProps } from '../ChatComposer';

vi.mock('../MessageInput.tsx', () => ({
  default: (props: { disabled?: boolean; placeholder?: string; isProcessing?: boolean }) => (
    <div
      data-testid="mock-message-input"
      data-disabled={String(props.disabled)}
      data-placeholder={props.placeholder}
      data-is-processing={String(props.isProcessing)}
    />
  ),
}));

vi.mock('../SessionStatusBar.tsx', () => ({
  default: () => <div data-testid="mock-session-status-bar">Ready</div>,
}));

import { CHAT_COMPOSER_READABILITY_SCRIM_TEST_ID, ChatComposer } from '../ChatComposer';

function baseProps(overrides: Partial<ChatComposerProps> = {}): ChatComposerProps {
  return {
    sessionId: 'session-1',
    readonly: false,
    isProcessing: false,
    features: {
      coordinator: false,
      worktree: false,
      rewind: false,
      archive: false,
      sessionInfo: false,
    },
    currentModel: 'claude-sonnet-4-6',
    currentModelInfo: null,
    availableModels: [],
    modelSwitching: false,
    modelLoading: false,
    autoScroll: true,
    coordinatorMode: false,
    coordinatorSwitching: false,
    sandboxEnabled: false,
    sandboxSwitching: false,
    isWaitingForInput: false,
    isConnected: true,
    onModelSwitch: vi.fn(),
    onAutoScrollChange: vi.fn(),
    onCoordinatorModeChange: vi.fn(),
    onSandboxModeChange: vi.fn(),
    onSend: vi.fn(async () => true),
    onOpenTools: vi.fn(),
    ...overrides,
  };
}

describe('ChatComposer', () => {
  afterEach(() => {
    cleanup();
  });

  it('renders the shared progressive readability scrim behind every composer', () => {
    const { container, getByTestId } = render(<ChatComposer {...baseProps()} />);

    const root = container.querySelector('.chat-footer');
    expect(root?.className).toContain('absolute bottom-0 left-0 right-0');
    expect(root?.className).toContain('isolate');

    const scrim = getByTestId(CHAT_COMPOSER_READABILITY_SCRIM_TEST_ID);
    expect(scrim.className).toContain('pointer-events-none');
    expect(scrim.className).toContain('h-24');
    expect(scrim.getAttribute('aria-hidden')).toBe('true');
    expect(container.querySelector('.bg-gradient-to-t')).toBeTruthy();
    expect(container.querySelector('.backdrop-blur-\\[1px\\]')).toBeTruthy();
  });

  it('keeps status and input above the scrim layer', () => {
    const { getByTestId } = render(<ChatComposer {...baseProps()} />);

    const contentLayer = getByTestId('mock-session-status-bar').parentElement;
    expect(contentLayer?.className).toContain('relative');
    expect(contentLayer?.className).toContain('z-10');
    expect(getByTestId('mock-message-input')).toBeTruthy();
  });

  it('shows the shared scrim even when the session is archived', () => {
    const { getByTestId, queryByTestId } = render(
      <ChatComposer {...baseProps({ sessionStatus: 'archived' })} />
    );

    expect(getByTestId(CHAT_COMPOSER_READABILITY_SCRIM_TEST_ID)).toBeTruthy();
    expect(queryByTestId('mock-message-input')).toBeNull();
    expect(getByTestId('mock-session-status-bar')).toBeTruthy();
  });

  it('passes processing state to MessageInput so the stop button can render', () => {
    const { getByTestId } = render(<ChatComposer {...baseProps({ isProcessing: true })} />);

    expect(getByTestId('mock-message-input').dataset.isProcessing).toBe('true');
  });
});
