// @ts-nocheck
import { signal } from '@preact/signals';
import { act, cleanup, fireEvent, render } from '@testing-library/preact';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mockAgentWorking = signal(false);
let mockDraftContent = '';

const mockSetContent = vi.fn(() => {});
const mockClearDraft = vi.fn(() => {});
const mockHoldDraftAdoption = vi.fn(async (fn: () => Promise<unknown>) => fn());
const mockClearAttachments = vi.fn(() => {});
const mockRestoreAttachments = vi.fn(() => {});
const mockGetImagesForSend = vi.fn(() => undefined);
const mockRequest = vi.fn(async () => ({ messages: [] }));

function setQueueResponses({
  enqueued = [],
  deferred = [],
}: {
  enqueued?: Array<Record<string, unknown>>;
  deferred?: Array<Record<string, unknown>>;
}) {
  mockRequest.mockImplementation(async (_method: string, payload: { status?: string }) => {
    if (payload?.status === 'enqueued') {
      return { messages: enqueued };
    }
    if (payload?.status === 'deferred') {
      return { messages: deferred };
    }
    return { messages: [] };
  });
}

vi.mock('../../lib/state.ts', () => ({
  globalSettings: { value: { voice: { enabled: false } } },
  get isAgentWorking() {
    return {
      get value() {
        return mockAgentWorking.value;
      },
    };
  },
}));

vi.mock('../../hooks', () => ({
  isVoiceRecordingSupported: () => false,
  useVoiceRecorder: () => ({
    isRecording: false,
    durationLimitHit: false,
    start: vi.fn(async () => {}),
    stop: vi.fn(async () => ({ audioBase64: '', mimeType: 'audio/wav' })),
    cancel: vi.fn(async () => {}),
  }),
  useInputDraft: () => ({
    content: mockDraftContent,
    setContent: mockSetContent,
    clear: mockClearDraft,
    holdDraftAdoption: mockHoldDraftAdoption,
  }),
  useModelSwitcher: () => ({
    currentModel: 'mock-model',
    currentModelInfo: null,
    availableModels: [],
    switching: false,
    loading: false,
    switchModel: vi.fn(async () => {}),
  }),
  useModal: () => ({
    isOpen: false,
    toggle: vi.fn(() => {}),
    close: vi.fn(() => {}),
  }),
  useCommandAutocomplete: () => ({
    showAutocomplete: false,
    filteredCommands: [],
    selectedIndex: 0,
    handleSelect: vi.fn(() => {}),
    close: vi.fn(() => {}),
    handleKeyDown: vi.fn(() => false),
  }),
  useReferenceAutocomplete: () => ({
    showAutocomplete: false,
    results: [],
    selectedIndex: 0,
    searchQuery: '',
    handleSelect: vi.fn(() => {}),
    close: vi.fn(() => {}),
    handleKeyDown: vi.fn(() => false),
  }),
  useFileAttachments: () => ({
    attachments: [],
    fileInputRef: { current: null },
    handleFileSelect: vi.fn(() => {}),
    handleFileDrop: vi.fn(async () => {}),
    handleRemove: vi.fn(() => {}),
    clear: mockClearAttachments,
    restore: mockRestoreAttachments,
    openFilePicker: vi.fn(() => {}),
    getImagesForSend: mockGetImagesForSend,
    handlePaste: vi.fn(() => {}),
  }),
  useInterrupt: () => ({
    interrupting: false,
    handleInterrupt: vi.fn(async () => {}),
  }),
}));

vi.mock('../../lib/connection-manager', () => ({
  connectionManager: {
    getHubIfConnected: () => ({ request: mockRequest }),
  },
}));

import MessageInput from '../MessageInput';

describe('MessageInput queue mode', () => {
  beforeEach(() => {
    cleanup();
    mockDraftContent = '';
    mockAgentWorking.value = false;
    mockSetContent.mockClear();
    mockClearDraft.mockClear();
    mockClearAttachments.mockClear();
    mockRestoreAttachments.mockClear();
    mockGetImagesForSend.mockClear();
    mockGetImagesForSend.mockReturnValue(undefined);
    mockRequest.mockClear();
    setQueueResponses({});

    Object.defineProperty(window, 'matchMedia', {
      writable: true,
      value: vi.fn().mockReturnValue({
        matches: false,
        media: '(pointer: coarse)',
        onchange: null,
        addListener: vi.fn(),
        removeListener: vi.fn(),
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
        dispatchEvent: vi.fn(),
      }),
    });
  });

  afterEach(() => {
    cleanup();
  });

  it('sends deferred delivery mode with Tab while agent is working', async () => {
    mockDraftContent = 'follow-up for next turn';
    mockAgentWorking.value = true;
    const onSend = vi.fn(async () => true);

    const { container } = render(<MessageInput sessionId="session-1" onSend={onSend} />);
    const textarea = container.querySelector('textarea') as HTMLTextAreaElement;

    await act(async () => {
      fireEvent.keyDown(textarea, { key: 'Tab' });
    });

    expect(onSend).toHaveBeenCalledTimes(1);
    expect(onSend).toHaveBeenCalledWith('follow-up for next turn', undefined, 'defer');
  });

  it('sends deferred delivery mode from the queue button', async () => {
    mockDraftContent = 'queue this';
    mockAgentWorking.value = true;
    const onSend = vi.fn(async () => true);

    const { container } = render(<MessageInput sessionId="session-1" onSend={onSend} />);
    const queueButton = container.querySelector('[data-testid="queue-button"]')!;

    await act(async () => {
      fireEvent.click(queueButton);
    });

    expect(onSend).toHaveBeenCalledTimes(1);
    expect(onSend).toHaveBeenCalledWith('queue this', undefined, 'defer');
  });

  it('renders the Queue button only when supportsQueueDelivery is true', async () => {
    // Regression guard for the task-agent composer wiring gap: the overlay
    // and inline task composers used to hard-code supportsQueueDelivery=false,
    // hiding the Queue ("next turn") button so a human could only Steer. The
    // gate that controls the button is supportsQueueDelivery → onQueue.
    mockDraftContent = 'defer me';
    mockAgentWorking.value = true;
    const onSend = vi.fn(async () => true);

    // supportsQueueDelivery defaults to true → Queue button present.
    const { container, unmount } = render(<MessageInput sessionId="session-1" onSend={onSend} />);
    expect(container.querySelector('[data-testid="queue-button"]')).toBeTruthy();
    unmount();

    // supportsQueueDelivery=false → Queue button hidden.
    const { container: gated } = render(
      <MessageInput sessionId="session-1" onSend={onSend} supportsQueueDelivery={false} />
    );
    expect(gated.querySelector('[data-testid="queue-button"]')).toBeNull();
  });

  it('sends immediate delivery mode with Enter while agent is working', async () => {
    mockDraftContent = 'inject now';
    mockAgentWorking.value = true;
    const onSend = vi.fn(async () => true);

    const { container } = render(<MessageInput sessionId="session-1" onSend={onSend} />);
    const textarea = container.querySelector('textarea') as HTMLTextAreaElement;

    await act(async () => {
      fireEvent.keyDown(textarea, { key: 'Enter' });
    });

    expect(onSend).toHaveBeenCalledTimes(1);
    expect(onSend).toHaveBeenCalledWith('inject now', undefined, 'immediate');
  });

  it('renders pending current-turn and next-turn queue overlays', async () => {
    setQueueResponses({
      enqueued: [
        {
          dbId: 'db-enqueued',
          uuid: 'uuid-enqueued',
          timestamp: 1,
          status: 'enqueued',
          text: 'steer now',
        },
      ],
      deferred: [
        {
          dbId: 'db-deferred',
          uuid: 'uuid-deferred',
          timestamp: 2,
          status: 'deferred',
          text: 'send next',
        },
      ],
    });

    const { container } = render(<MessageInput sessionId="session-1" onSend={vi.fn()} />);
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(container.querySelector('[data-testid="queue-overlay"]')).toBeTruthy();
    expect(
      container.querySelector('[data-testid="queued-current-turn-bubble"]')?.textContent
    ).toContain('steer now');
    expect(
      container.querySelector('[data-testid="queued-next-turn-bubble"]')?.textContent
    ).toContain('send next');
  });

  it('removes a pending queued message', async () => {
    setQueueResponses({
      enqueued: [
        {
          dbId: 'db-enqueued',
          uuid: 'uuid-enqueued',
          timestamp: 1,
          status: 'enqueued',
          text: 'remove me',
        },
      ],
    });

    const { container } = render(<MessageInput sessionId="session-1" onSend={vi.fn()} />);
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    const removeButton = container.querySelector('[data-testid="remove-queued-message"]')!;
    await act(async () => {
      fireEvent.click(removeButton);
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(mockRequest).toHaveBeenCalledWith('session.messages.removePending', {
      sessionId: 'session-1',
      messageDbId: 'db-enqueued',
    });
  });

  it('promotes a deferred message to steer', async () => {
    setQueueResponses({
      deferred: [
        {
          dbId: 'db-deferred',
          uuid: 'uuid-deferred',
          timestamp: 1,
          status: 'deferred',
          text: 'promote me',
        },
      ],
    });

    const { container } = render(<MessageInput sessionId="session-1" onSend={vi.fn()} />);
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    const promoteButton = container.querySelector('[data-testid="promote-queued-message"]')!;
    await act(async () => {
      fireEvent.click(promoteButton);
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(mockRequest).toHaveBeenCalledWith('session.messages.promotePending', {
      sessionId: 'session-1',
      messageDbId: 'db-deferred',
    });
  });

  it('defers an enqueued message to next', async () => {
    setQueueResponses({
      enqueued: [
        {
          dbId: 'db-enqueued',
          uuid: 'uuid-enqueued',
          timestamp: 1,
          status: 'enqueued',
          text: 'defer me',
        },
      ],
    });

    const { container } = render(<MessageInput sessionId="session-1" onSend={vi.fn()} />);
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    const deferButton = container.querySelector('[data-testid="defer-queued-message"]')!;
    await act(async () => {
      fireEvent.click(deferButton);
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(mockRequest).toHaveBeenCalledWith('session.messages.deferPending', {
      sessionId: 'session-1',
      messageDbId: 'db-enqueued',
    });
  });

  it('renders all queue rows without an overflow toggle', async () => {
    setQueueResponses({
      deferred: [
        {
          dbId: 'db-deferred-1',
          uuid: 'uuid-deferred-1',
          timestamp: 1,
          status: 'deferred',
          text: 'first',
        },
        {
          dbId: 'db-deferred-2',
          uuid: 'uuid-deferred-2',
          timestamp: 2,
          status: 'deferred',
          text: 'second',
        },
        {
          dbId: 'db-deferred-3',
          uuid: 'uuid-deferred-3',
          timestamp: 3,
          status: 'deferred',
          text: 'third',
        },
      ],
    });

    const { container } = render(<MessageInput sessionId="session-1" onSend={vi.fn()} />);
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(container.textContent).toContain('first');
    expect(container.textContent).toContain('second');
    expect(container.textContent).toContain('third');
    expect(container.textContent).not.toContain('Show 1 more');
    expect(container.textContent).not.toContain('Show less');
  });

  it('clears the queue trays when the targeted session changes (task-composer target switch)', async () => {
    // Regression for enabling Queue delivery on the task composer: switching
    // targets (e.g. to a not-yet-started agent whose sessionId is '') must not
    // leave the previous agent's queue tray visible. Model the failure case —
    // the new session's byStatus refresh rejects — and assert the trays reset
    // anyway (the clear-on-sessionId-change effect), instead of leaving the
    // prior agent's queue with actions bound to the now-empty session id.
    setQueueResponses({
      deferred: [
        {
          dbId: 'db-deferred',
          uuid: 'uuid-deferred',
          timestamp: 1,
          status: 'deferred',
          text: 'send next',
        },
      ],
    });

    const { container, rerender } = render(<MessageInput sessionId="session-1" onSend={vi.fn()} />);
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(container.querySelector('[data-testid="queue-overlay"]')).toBeTruthy();
    expect(
      container.querySelector('[data-testid="queued-next-turn-bubble"]')?.textContent
    ).toContain('send next');

    // Switch to a new target whose queue refresh fails.
    mockRequest.mockImplementation(async () => {
      throw new Error('session not found');
    });
    rerender(<MessageInput sessionId="session-2" onSend={vi.fn()} />);
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(container.querySelector('[data-testid="queue-overlay"]')).toBeNull();
  });

  it('discards a stale queue refresh that resolves after the target switches', async () => {
    // Race guard: a previous session's in-flight byStatus must NOT repopulate
    // the trays after the composer switches targets — otherwise the stale
    // queue shows under the new target and its actions bind to the empty id.
    let resolveSession1Refresh: (value: { messages: Array<Record<string, unknown>> }) => void;
    const session1Pending = new Promise<{ messages: Array<Record<string, unknown>> }>((resolve) => {
      resolveSession1Refresh = resolve;
    });
    mockRequest.mockImplementation(async (_method: string, payload: { sessionId?: string }) => {
      if (payload?.sessionId === 'session-1') return session1Pending;
      return { messages: [] }; // session-2 has no queued messages
    });

    const { container, rerender } = render(<MessageInput sessionId="session-1" onSend={vi.fn()} />);
    // Let the session-1 refresh dispatch (it stays pending).
    await act(async () => {
      await Promise.resolve();
    });

    // Switch targets before session-1's refresh resolves.
    rerender(<MessageInput sessionId="session-2" onSend={vi.fn()} />);
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    // Now the stale session-1 refresh resolves with a deferred message.
    await act(async () => {
      resolveSession1Refresh!({
        messages: [
          { dbId: 'stale', uuid: 'u', timestamp: 1, status: 'deferred', text: 'stale next' },
        ],
      });
      await Promise.resolve();
      await Promise.resolve();
    });

    // The stale session-1 queue must NOT surface under session-2.
    expect(container.querySelector('[data-testid="queue-overlay"]')).toBeNull();
  });
});
