// @ts-nocheck
import { signal } from '@preact/signals';
import { cleanup, fireEvent, render } from '@testing-library/preact';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mockAgentWorking = signal(false);

const handleFileDrop = vi.fn(async () => {});
const handlePaste = vi.fn();
const openFilePicker = vi.fn();
let menuOpen = false;

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
    content: '',
    setContent: vi.fn(),
    clear: vi.fn(),
    holdDraftAdoption: async (fn: () => Promise<unknown>) => fn(),
  }),
  useModelSwitcher: () => ({
    currentModel: 'mock-model',
    currentModelInfo: null,
    availableModels: [],
    switching: false,
    loading: false,
    switchModel: vi.fn(async () => {}),
  }),
  useModal: () => ({ isOpen: menuOpen, toggle: vi.fn(), close: vi.fn() }),
  useCommandAutocomplete: () => ({
    showAutocomplete: false,
    filteredCommands: [],
    selectedIndex: 0,
    handleSelect: vi.fn(),
    close: vi.fn(),
    handleKeyDown: vi.fn(() => false),
  }),
  useReferenceAutocomplete: () => ({
    showAutocomplete: false,
    results: [],
    selectedIndex: 0,
    searchQuery: '',
    handleSelect: vi.fn(),
    close: vi.fn(),
    handleKeyDown: vi.fn(() => false),
  }),
  useFileAttachments: () => ({
    attachments: [],
    fileInputRef: { current: null },
    handleFileSelect: vi.fn(),
    handleFileDrop,
    handleRemove: vi.fn(),
    clear: vi.fn(),
    restore: vi.fn(),
    openFilePicker,
    getImagesForSend: vi.fn(() => undefined),
    handlePaste,
  }),
  useInterrupt: () => ({ interrupting: false, handleInterrupt: vi.fn(async () => {}) }),
}));

vi.mock('../../lib/connection-manager', () => ({
  connectionManager: {
    getHubIfConnected: () => ({ request: vi.fn(async () => ({})), onEvent: vi.fn(() => vi.fn()) }),
  },
}));

import MessageInput from '../MessageInput';

function makeFileList(files: File[]): FileList {
  return {
    length: files.length,
    item: (index: number) => files[index] ?? null,
    [Symbol.iterator]: function* () {
      for (const file of files) yield file;
    },
  } as FileList;
}

describe('MessageInput registerDropTarget', () => {
  beforeEach(() => {
    cleanup();
    handleFileDrop.mockClear();
    handlePaste.mockClear();
    openFilePicker.mockClear();
    menuOpen = false;
    mockAgentWorking.value = false;
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

  afterEach(() => cleanup());

  it('registers a drop handler on mount and clears it on unmount', () => {
    let latest: ((files: FileList) => void) | null = 'unset';
    const registerDropTarget = vi.fn((fn) => {
      latest = fn;
    });

    const { unmount } = render(
      <MessageInput sessionId="s1" onSend={vi.fn()} registerDropTarget={registerDropTarget} />
    );

    expect(registerDropTarget).toHaveBeenCalledTimes(1);
    expect(typeof latest).toBe('function');

    unmount();

    expect(registerDropTarget).toHaveBeenCalledWith(null);
    expect(latest).toBeNull();
  });

  it('forwards dropped files to handleFileDrop when enabled', async () => {
    let latest: ((files: FileList) => void) | null = null;
    const registerDropTarget = vi.fn((fn) => {
      latest = fn;
    });

    render(
      <MessageInput sessionId="s1" onSend={vi.fn()} registerDropTarget={registerDropTarget} />
    );

    const file = new File(['x'], 'a.png', { type: 'image/png' });
    const files = makeFileList([file]);
    latest!(files);
    await Promise.resolve();
    await Promise.resolve();

    expect(handleFileDrop).toHaveBeenCalledTimes(1);
    expect(handleFileDrop).toHaveBeenCalledWith(files);
  });

  it('is a no-op (does not forward) while disabled', async () => {
    let latest: ((files: FileList) => void) | null = null;
    const registerDropTarget = vi.fn((fn) => {
      latest = fn;
    });

    render(
      <MessageInput
        sessionId="s1"
        onSend={vi.fn()}
        disabled
        registerDropTarget={registerDropTarget}
      />
    );

    expect(typeof latest).toBe('function');
    const file = new File(['x'], 'a.png', { type: 'image/png' });
    latest!(makeFileList([file]));
    await Promise.resolve();
    await Promise.resolve();

    expect(handleFileDrop).not.toHaveBeenCalled();
  });
  it('disables image attach with a reason for a text-only harness', () => {
    menuOpen = true;
    const { getByRole } = render(
      <MessageInput sessionId="s1" onSend={vi.fn()} harness="oxap-codex" />
    );
    const button = getByRole('button', { name: 'Attach image' });
    expect(button.disabled).toBe(true);
    expect(button.title).toContain('text only');
    fireEvent.click(button);
    expect(openFilePicker).not.toHaveBeenCalled();
  });

  it('prevents pasted images in a text-only harness', () => {
    const { getByRole, getByText } = render(
      <MessageInput sessionId="s1" onSend={vi.fn()} harness="oxap-codex" />
    );
    const event = new Event('paste', { bubbles: true, cancelable: true });
    Object.defineProperty(event, 'clipboardData', {
      value: { files: [new File(['x'], 'a.png', { type: 'image/png' })] },
    });
    fireEvent(getByRole('textbox'), event);
    expect(event.defaultPrevented).toBe(true);
    expect(handlePaste).not.toHaveBeenCalled();
    expect(getByText(/accepts text only/)).toBeTruthy();
  });

  it('does not accept dropped images in a text-only harness', () => {
    let target: ((files: FileList) => void) | null = null;
    render(
      <MessageInput
        sessionId="s1"
        onSend={vi.fn()}
        harness="oxap-codex"
        registerDropTarget={(fn) => {
          target = fn;
        }}
      />
    );
    target!(makeFileList([new File(['x'], 'a.png', { type: 'image/png' })]));
    expect(handleFileDrop).not.toHaveBeenCalled();
  });
});
