// @ts-nocheck

import { signal } from '@preact/signals';
import { act, cleanup, fireEvent, render, waitFor } from '@testing-library/preact';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { composerAttachmentsSignal } from '../../lib/composer-attachment-store.ts';
import {
  extractImagesFromClipboard,
  fileToBase64,
  validateImageFile,
} from '../../lib/file-utils.ts';
import { ATTACHMENT_LIGHTBOX_TEST_ID } from '../AttachmentPreview.tsx';

const mockAgentWorking = signal(false);
let mockDraftContent = '';
const mockRequest = vi.fn(async () => ({ messages: [] }));

vi.mock('../../lib/state.ts', () => ({
  globalSettings: { value: { voice: { enabled: false } } },
  connectionState: { value: 'connected', subscribe: vi.fn(() => vi.fn()) },
  get isAgentWorking() {
    return {
      get value() {
        return mockAgentWorking.value;
      },
    };
  },
}));

vi.mock('../../hooks', async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    isVoiceRecordingSupported: () => false,
    useVoiceRecorder: () => ({
      isRecording: false,
      isStarting: false,
      durationLimitHit: false,
      recordingSessionId: null,
      recordingCursor: null,
      recordingStartedAt: null,
      getLevel: () => 0,
      start: vi.fn(async () => {}),
      stop: vi.fn(async () => ({ audioBase64: '', mimeType: 'audio/wav' })),
      cancel: vi.fn(async () => {}),
    }),
    useInputDraft: () => ({
      content: mockDraftContent,
      setContent: vi.fn(() => {}),
      clear: vi.fn(() => {}),
      holdDraftAdoption: vi.fn(async (fn: () => Promise<unknown>) => fn()),
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
    useInterrupt: () => ({
      interrupting: false,
      handleInterrupt: vi.fn(async () => {}),
    }),
  };
});

vi.mock('../../lib/connection-manager', () => ({
  connectionManager: {
    getHubIfConnected: () => ({ request: mockRequest, onEvent: vi.fn(() => vi.fn()) }),
  },
}));

vi.mock('../../lib/file-utils.ts', () => ({
  validateImageFile: vi.fn(() => null),
  fileToBase64: vi.fn(async (file: File) => `b64:${file.name}`),
  extractImagesFromClipboard: vi.fn(() => []),
  formatFileSize: (bytes: number) => `${bytes} B`,
}));

vi.mock('../../lib/toast.ts', () => ({
  toastsSignal: { value: [], subscribe: vi.fn(() => vi.fn()) },
  dismissToast: vi.fn(),
  toast: {
    error: vi.fn(),
    info: vi.fn(),
    success: vi.fn(),
    warning: vi.fn(),
  },
}));

import MessageInput from '../MessageInput';

function renderComposer(onSend = vi.fn(async () => {}), sessionId = 'test-session') {
  return render(<MessageInput sessionId={sessionId} onSend={onSend} />);
}

function pasteImage(container: Element, name = 'pasted.png') {
  const file = new File(['image-bytes'], name, { type: 'image/png' });
  vi.mocked(extractImagesFromClipboard).mockReturnValueOnce([file]);
  const textarea = container.querySelector('textarea');
  const event = new Event('paste', { bubbles: true, cancelable: true });
  Object.defineProperty(event, 'clipboardData', {
    value: { items: [{ kind: 'file', type: file.type }] },
  });
  fireEvent(textarea, event);
}

function previewTile(container: Element, name = 'pasted.png') {
  return container.querySelector(`img[alt="${name}"]`)?.parentElement ?? null;
}

describe('MessageInput pending attachment persistence', () => {
  beforeEach(() => {
    cleanup();
    composerAttachmentsSignal.value = {};
    mockDraftContent = '';
    mockAgentWorking.value = false;
    mockRequest.mockClear();
    vi.mocked(validateImageFile).mockReturnValue(null);
    vi.mocked(fileToBase64).mockImplementation(async (file: File) => `b64:${file.name}`);
    vi.mocked(extractImagesFromClipboard).mockReturnValue([]);
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

  it('renders a preview for a pasted image', async () => {
    const view = renderComposer();

    await act(async () => {
      pasteImage(view.container);
    });

    expect(view.container.querySelector('img[alt="pasted.png"]')).toBeTruthy();
  });

  it('opens the full-size image when the preview is clicked', async () => {
    const view = renderComposer();

    await act(async () => {
      pasteImage(view.container);
    });

    fireEvent.click(previewTile(view.container));

    const lightbox = document.querySelector(`[data-testid="${ATTACHMENT_LIGHTBOX_TEST_ID}"]`);
    expect(lightbox).toBeTruthy();
    expect(lightbox?.querySelector('img')?.src).toBe('data:image/png;base64,b64:pasted.png');
  });

  it('restores pasted attachments after the composer unmounts and remounts', async () => {
    const first = renderComposer();

    await act(async () => {
      pasteImage(first.container);
    });
    expect(first.container.querySelector('img[alt="pasted.png"]')).toBeTruthy();

    first.unmount();

    const second = renderComposer();
    expect(second.container.querySelector('img[alt="pasted.png"]')).toBeTruthy();
  });

  it('keeps attachments isolated per session', async () => {
    const first = renderComposer();

    await act(async () => {
      pasteImage(first.container);
    });
    first.unmount();

    const other = renderComposer(
      vi.fn(async () => {}),
      'other-session'
    );
    expect(other.container.querySelector('img[alt="pasted.png"]')).toBeNull();

    const restored = renderComposer();
    expect(restored.container.querySelector('img[alt="pasted.png"]')).toBeTruthy();
  });

  it('removes a preview on click and keeps it removed after a remount', async () => {
    const first = renderComposer();

    await act(async () => {
      pasteImage(first.container);
    });
    fireEvent.click(first.container.querySelector('[aria-label="Remove attachment"]'));

    await waitFor(() => {
      expect(first.container.querySelector('img[alt="pasted.png"]')).toBeNull();
    });
    first.unmount();

    const second = renderComposer();
    expect(second.container.querySelector('img[alt="pasted.png"]')).toBeNull();
  });

  it('sends restored attachments with the message and clears the pending set', async () => {
    mockDraftContent = 'hello';
    const onSend = vi.fn(async () => {});
    const first = renderComposer(onSend);

    await act(async () => {
      pasteImage(first.container);
    });
    first.unmount();

    const second = renderComposer(onSend);
    const textarea = second.container.querySelector('textarea') as HTMLTextAreaElement;

    fireEvent.keyDown(textarea, { key: 'Enter', shiftKey: false });

    await waitFor(() => expect(onSend).toHaveBeenCalledOnce());
    expect(onSend.mock.calls[0][0]).toBe('hello');
    expect(onSend.mock.calls[0][1]).toEqual([{ data: 'b64:pasted.png', media_type: 'image/png' }]);

    await waitFor(() => {
      expect(second.container.querySelector('img[alt="pasted.png"]')).toBeNull();
    });
    second.unmount();

    const third = renderComposer();
    expect(third.container.querySelector('img[alt="pasted.png"]')).toBeNull();
  });

  it('restores attachments when the send fails and keeps them persisted', async () => {
    mockDraftContent = 'hello';
    const onSend = vi.fn(async () => false);
    const view = renderComposer(onSend);

    await act(async () => {
      pasteImage(view.container);
    });
    const textarea = view.container.querySelector('textarea') as HTMLTextAreaElement;

    fireEvent.keyDown(textarea, { key: 'Enter', shiftKey: false });

    await waitFor(() => expect(onSend).toHaveBeenCalledOnce());
    await waitFor(() => {
      expect(view.container.querySelector('img[alt="pasted.png"]')).toBeTruthy();
    });
    view.unmount();

    const after = renderComposer();
    expect(after.container.querySelector('img[alt="pasted.png"]')).toBeTruthy();
  });
});
