// @ts-nocheck

import { signal } from '@preact/signals';
import { act, cleanup, fireEvent, render, waitFor } from '@testing-library/preact';
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

let mockReferenceShowAutocomplete = false;
const mockReferenceHandleKeyDown = vi.fn(() => false);

let mockCommandShowAutocomplete = false;
const mockCommandHandleKeyDown = vi.fn(() => false);

vi.mock('../../lib/state.ts', () => ({
  globalSettings: { value: { voice: { enabled: false } } },
  connectionState: { value: 'connected' },
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
    showAutocomplete: mockCommandShowAutocomplete,
    filteredCommands: [],
    selectedIndex: 0,
    handleSelect: vi.fn(() => {}),
    close: vi.fn(() => {}),
    handleKeyDown: mockCommandHandleKeyDown,
  }),
  useReferenceAutocomplete: () => ({
    showAutocomplete: mockReferenceShowAutocomplete,
    results: [],
    selectedIndex: 0,
    searchQuery: '',
    handleSelect: vi.fn(() => {}),
    close: vi.fn(() => {}),
    handleKeyDown: mockReferenceHandleKeyDown,
  }),
  extractActiveAtQuery: vi.fn(() => null),
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
    getHubIfConnected: () => ({ request: mockRequest, onEvent: vi.fn(() => vi.fn()) }),
  },
}));

import MessageInput from '../MessageInput';

describe('MessageInput submit race condition', () => {
  beforeEach(() => {
    cleanup();
    mockDraftContent = '';
    mockAgentWorking.value = false;
    mockSetContent.mockClear();
    mockClearDraft.mockClear();
    mockHoldDraftAdoption.mockClear();
    mockClearAttachments.mockClear();
    mockRestoreAttachments.mockClear();
    mockGetImagesForSend.mockClear();
    mockGetImagesForSend.mockReturnValue(undefined);
    mockRequest.mockClear();
    mockReferenceShowAutocomplete = false;
    mockReferenceHandleKeyDown.mockReturnValue(false);
    mockReferenceHandleKeyDown.mockClear();
    mockCommandShowAutocomplete = false;
    mockCommandHandleKeyDown.mockReturnValue(false);
    mockCommandHandleKeyDown.mockClear();
    document.querySelectorAll('[data-messages-container]').forEach((node) => node.remove());
    document.querySelectorAll('.chat-footer').forEach((node) => node.remove());

    Object.defineProperty(window, 'matchMedia', {
      writable: true,
      value: vi.fn(() => ({ matches: false })),
    });
  });

  afterEach(() => {
    cleanup();
    document.querySelectorAll('[data-messages-container]').forEach((node) => node.remove());
    document.querySelectorAll('.chat-footer').forEach((node) => node.remove());
  });

  function renderInput(onSend = vi.fn(async () => {})) {
    return render(<MessageInput sessionId="test-session" onSend={onSend} />);
  }

  describe('submittingRef guard', () => {
    it('blocks stale onInput events while submit is in flight', async () => {
      mockDraftContent = 'hello';

      let resolveSend: (value: boolean | void) => void;
      const onSend = vi.fn(async () => {
        return new Promise((resolve) => {
          resolveSend = resolve;
        });
      });

      const { container } = renderInput(onSend);
      const textarea = container.querySelector('textarea') as HTMLTextAreaElement;

      fireEvent.keyDown(textarea, { key: 'Enter', shiftKey: false });

      await waitFor(() => expect(onSend).toHaveBeenCalledOnce());

      fireEvent.input(textarea, { target: { value: 'hello' } });

      expect(mockSetContent).not.toHaveBeenCalledWith('hello');

      resolveSend(true);
      await waitFor(() => expect(onSend).toHaveReturned());

      expect(mockSetContent).not.toHaveBeenCalledWith('hello');
    });

    it('allows new onInput events after submit completes', async () => {
      mockDraftContent = 'hello';
      const onSend = vi.fn(async () => {});

      const { container } = renderInput(onSend);
      const textarea = container.querySelector('textarea') as HTMLTextAreaElement;

      fireEvent.keyDown(textarea, { key: 'Enter', shiftKey: false });
      await waitFor(() => expect(onSend).toHaveBeenCalledOnce());

      fireEvent.input(textarea, { target: { value: 'new text' } });

      expect(mockSetContent).toHaveBeenCalledWith('new text');
    });
  });

  describe('direct DOM clear', () => {
    it('clears textarea.value immediately on submit', async () => {
      mockDraftContent = 'hello';
      const onSend = vi.fn(async () => {});

      const { container } = renderInput(onSend);
      const textarea = container.querySelector('textarea') as HTMLTextAreaElement;

      expect(textarea.value).toBe('hello');

      fireEvent.keyDown(textarea, { key: 'Enter', shiftKey: false });

      expect(textarea.value).toBe('');

      await waitFor(() => expect(onSend).toHaveBeenCalledOnce());
    });
  });

  describe('send failure restoration', () => {
    it('restores draft and attachments when onSend returns false', async () => {
      mockDraftContent = 'hello world';
      const onSend = vi.fn(async () => false);

      const { container } = renderInput(onSend);
      const textarea = container.querySelector('textarea') as HTMLTextAreaElement;

      fireEvent.keyDown(textarea, { key: 'Enter', shiftKey: false });
      await waitFor(() => expect(onSend).toHaveBeenCalledOnce());

      expect(mockSetContent).toHaveBeenCalledWith('hello world');
    });

    it('does not restore draft when onSend succeeds', async () => {
      mockDraftContent = 'hello world';
      const onSend = vi.fn(async () => true);

      const { container } = renderInput(onSend);
      const textarea = container.querySelector('textarea') as HTMLTextAreaElement;

      fireEvent.keyDown(textarea, { key: 'Enter', shiftKey: false });
      await waitFor(() => expect(onSend).toHaveBeenCalledOnce());

      expect(mockSetContent).not.toHaveBeenCalledWith('hello world');
    });

    it('does not restore draft when onSend returns void', async () => {
      mockDraftContent = 'hello world';
      const onSend = vi.fn(async () => {});

      const { container } = renderInput(onSend);
      const textarea = container.querySelector('textarea') as HTMLTextAreaElement;

      fireEvent.keyDown(textarea, { key: 'Enter', shiftKey: false });
      await waitFor(() => expect(onSend).toHaveBeenCalledOnce());

      expect(mockSetContent).not.toHaveBeenCalledWith('hello world');
    });

    it('resets submittingRef so textarea stays functional when onSend throws', async () => {
      mockDraftContent = 'hello world';
      const onSend = vi.fn(async () => {
        throw new Error('network failure');
      });

      const unhandledHandler = (reason: unknown) => {
        if (reason instanceof Error && reason.message === 'network failure') {
          // swallowed
        } else {
          process.removeListener('unhandledRejection', unhandledHandler);
          throw reason;
        }
      };
      process.on('unhandledRejection', unhandledHandler);

      const { container } = renderInput(onSend);
      const textarea = container.querySelector('textarea') as HTMLTextAreaElement;

      fireEvent.keyDown(textarea, { key: 'Enter', shiftKey: false });
      await waitFor(() => expect(onSend).toHaveBeenCalledOnce());

      await new Promise((resolve) => setTimeout(resolve, 10));

      mockSetContent.mockClear();
      fireEvent.input(textarea, { target: { value: 'typed after error' } });
      expect(mockSetContent).toHaveBeenCalledWith('typed after error');

      process.removeListener('unhandledRejection', unhandledHandler);
    });
  });

  describe('send called with correct arguments', () => {
    it('calls onSend with trimmed content and images', async () => {
      mockDraftContent = '  hello  ';
      mockGetImagesForSend.mockReturnValue([
        { data: 'base64data', media_type: 'image/png', name: 'test.png' },
      ]);

      const onSend = vi.fn(async () => {});
      const { container } = renderInput(onSend);
      const textarea = container.querySelector('textarea') as HTMLTextAreaElement;

      fireEvent.keyDown(textarea, { key: 'Enter', shiftKey: false });
      await waitFor(() => expect(onSend).toHaveBeenCalledOnce());

      expect(onSend).toHaveBeenCalledWith(
        'hello',
        [{ data: 'base64data', media_type: 'image/png', name: 'test.png' }],
        'immediate'
      );
    });
  });

  describe('draft-adoption hold wiring', () => {
    it("runs the optimistic clear, the send, and a failed send's restore INSIDE holdDraftAdoption", async () => {
      mockDraftContent = 'hello';
      const order: string[] = [];
      mockHoldDraftAdoption.mockImplementationOnce(async (fn: () => Promise<unknown>) => {
        order.push('hold-start');
        await fn();
        order.push('hold-end');
      });
      mockSetContent.mockImplementation(() => {
        order.push('restore');
      });
      const onSend = vi.fn(async () => {
        order.push('send');
        return false;
      });

      const { container } = renderInput(onSend);
      const textarea = container.querySelector('textarea') as HTMLTextAreaElement;
      fireEvent.keyDown(textarea, { key: 'Enter', shiftKey: false });

      await waitFor(() => expect(onSend).toHaveBeenCalledOnce());
      await waitFor(() => expect(order).toEqual(['hold-start', 'send', 'restore', 'hold-end']));
      expect(mockHoldDraftAdoption).toHaveBeenCalledTimes(1);
      mockSetContent.mockImplementation(() => {});
    });
  });
});
