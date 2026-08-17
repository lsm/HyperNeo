// @ts-nocheck
/**
 * Tests for MessageInput submit/clear race condition fix.
 *
 * ROOT CAUSE:
 * The textarea is uncontrolled (no value={content} prop). Content is synced to
 * the DOM via useLayoutEffect in InputTextarea. When handleSubmit fires:
 *
 *   1. clearDraft() sets contentSignal.value = ''
 *   2. textarea.value still has old content (useLayoutEffect hasn't flushed)
 *   3. await onSend(...) yields; Preact flushes; useLayoutEffect syncs ''
 *
 * Between steps 1 and 3, a browser onInput event can read the stale
 * textarea.value and call handleContentChange → setContent, restoring the old
 * content into the signal. The "single letter" is the last keystroke already
 * inserted into textarea.value before the keydown handler ran.
 *
 * FIX:
 *   1. submittingRef guard — set true before clear, checked in
 *      handleContentChange to ignore stale onInput events
 *   2. Direct DOM clear — set textarea.value = '' immediately in handleSubmit
 *      instead of waiting for batched useLayoutEffect
 */

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
    getHubIfConnected: () => ({ request: mockRequest }),
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

      // Simulate pressing Enter to submit
      fireEvent.keyDown(textarea, { key: 'Enter', shiftKey: false });

      await waitFor(() => expect(onSend).toHaveBeenCalledOnce());

      // Simulate stale onInput firing while onSend is still pending
      // (textarea.value still has old content because useLayoutEffect hasn't flushed)
      fireEvent.input(textarea, { target: { value: 'hello' } });

      // setContent should NOT have been called with the stale value
      expect(mockSetContent).not.toHaveBeenCalledWith('hello');

      // Resolve the pending send
      resolveSend(true);
      await waitFor(() => expect(onSend).toHaveReturned());

      // Even after completion, the stale input should have been dropped
      expect(mockSetContent).not.toHaveBeenCalledWith('hello');
    });

    it('allows new onInput events after submit completes', async () => {
      mockDraftContent = 'hello';
      const onSend = vi.fn(async () => {});

      const { container } = renderInput(onSend);
      const textarea = container.querySelector('textarea') as HTMLTextAreaElement;

      fireEvent.keyDown(textarea, { key: 'Enter', shiftKey: false });
      await waitFor(() => expect(onSend).toHaveBeenCalledOnce());

      // After submit completes, typing should work normally
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

      // Before submit, textarea should reflect the draft content
      expect(textarea.value).toBe('hello');

      fireEvent.keyDown(textarea, { key: 'Enter', shiftKey: false });

      // Textarea should be cleared immediately, not waiting for useLayoutEffect
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

      // Draft should be restored
      expect(mockSetContent).toHaveBeenCalledWith('hello world');
    });

    it('does not restore draft when onSend succeeds', async () => {
      mockDraftContent = 'hello world';
      const onSend = vi.fn(async () => true);

      const { container } = renderInput(onSend);
      const textarea = container.querySelector('textarea') as HTMLTextAreaElement;

      fireEvent.keyDown(textarea, { key: 'Enter', shiftKey: false });
      await waitFor(() => expect(onSend).toHaveBeenCalledOnce());

      // Should NOT restore the draft on success
      expect(mockSetContent).not.toHaveBeenCalledWith('hello world');
    });

    it('does not restore draft when onSend returns void', async () => {
      mockDraftContent = 'hello world';
      const onSend = vi.fn(async () => {});

      const { container } = renderInput(onSend);
      const textarea = container.querySelector('textarea') as HTMLTextAreaElement;

      fireEvent.keyDown(textarea, { key: 'Enter', shiftKey: false });
      await waitFor(() => expect(onSend).toHaveBeenCalledOnce());

      // Void return = success; should NOT restore
      expect(mockSetContent).not.toHaveBeenCalledWith('hello world');
    });

    it('resets submittingRef so textarea stays functional when onSend throws', async () => {
      mockDraftContent = 'hello world';
      const onSend = vi.fn(async () => {
        throw new Error('network failure');
      });

      // Swallow unhandled rejection from fire-and-forget async submit
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

      // Give the unhandled rejection a tick to surface
      await new Promise((resolve) => setTimeout(resolve, 10));

      // Textarea must remain functional — submittingRef should have reset
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

      // Content should be trimmed
      expect(onSend).toHaveBeenCalledWith(
        'hello',
        [{ data: 'base64data', media_type: 'image/png', name: 'test.png' }],
        'immediate'
      );
    });
  });

  describe('draft-adoption hold wiring', () => {
    it("runs the optimistic clear, the send, and a failed send's restore INSIDE holdDraftAdoption", async () => {
      // A failed send restores the draft with setContent. That restore must
      // happen while the hook\'s holdDraftAdoption is still active: the
      // optimistic clear empties the composer, and an armed voice landing
      // surfacing into that transient emptiness would consume its staging
      // server-side only for the restore to stomp it (see useInputDraft).
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
