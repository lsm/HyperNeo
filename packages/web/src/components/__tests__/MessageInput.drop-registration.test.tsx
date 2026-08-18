// @ts-nocheck
import { signal } from '@preact/signals';
import { cleanup, render } from '@testing-library/preact';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mockAgentWorking = signal(false);

const handleFileDrop = vi.fn(async () => {});

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
  useModal: () => ({ isOpen: false, toggle: vi.fn(), close: vi.fn() }),
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
    openFilePicker: vi.fn(),
    getImagesForSend: vi.fn(() => undefined),
    handlePaste: vi.fn(),
  }),
  useInterrupt: () => ({ interrupting: false, handleInterrupt: vi.fn(async () => {}) }),
}));

vi.mock('../../lib/connection-manager', () => ({
  connectionManager: { getHubIfConnected: () => ({ request: vi.fn(async () => ({})) }) },
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
});
