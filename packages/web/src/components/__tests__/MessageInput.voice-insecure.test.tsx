// @ts-nocheck
import { signal } from '@preact/signals';
import { cleanup, fireEvent, render, waitFor } from '@testing-library/preact';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mockAgentWorking = signal(false);

let mockVoiceSupported = false;

const toastError = vi.fn();
const toastInfo = vi.fn();
const voiceStart = vi.fn(async () => {});
const voiceStop = vi.fn(async () => ({ audioBase64: '', mimeType: 'audio/wav' }));
const voiceCancel = vi.fn(async () => {});

vi.mock('../../lib/state.ts', () => ({
  globalSettings: {
    value: { voice: { enabled: true, endpoint: 'https://asr.example.com/v1', model: 'whisper-1' } },
  },
  get isAgentWorking() {
    return {
      get value() {
        return mockAgentWorking.value;
      },
    };
  },
}));

vi.mock('../../lib/toast.ts', () => ({
  toast: {
    error: (...args: unknown[]) => toastError(...args),
    info: (...args: unknown[]) => toastInfo(...args),
  },
}));

vi.mock('../../hooks', () => ({
  isVoiceRecordingSupported: () => mockVoiceSupported,
  useVoiceRecorder: () => ({
    isRecording: false,
    isStarting: false,
    durationLimitHit: false,
    start: voiceStart,
    stop: voiceStop,
    cancel: voiceCancel,
    setRecordingCursor: vi.fn(),
  }),
  useInputDraft: () => ({ content: '', setContent: vi.fn(), clear: vi.fn() }),
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
    handleFileDrop: vi.fn(async () => {}),
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

function micButton(container: HTMLElement): HTMLButtonElement {
  const btn = container.querySelector<HTMLButtonElement>('button[aria-label="Start voice input"]');
  if (!btn) throw new Error('mic button not rendered');
  return btn;
}

describe('MessageInput voice mic button — insecure context', () => {
  beforeEach(() => {
    cleanup();
    mockAgentWorking.value = false;
    mockVoiceSupported = false;
    toastError.mockClear();
    toastInfo.mockClear();
    voiceStart.mockClear();
    voiceStop.mockClear();
    voiceCancel.mockClear();
    Object.defineProperty(window, 'matchMedia', {
      writable: true,
      value: vi.fn().mockReturnValue({ matches: false }),
    });
  });

  afterEach(() => cleanup());

  it('renders the mic button enabled (not silently disabled) when recording is unsupported', () => {
    mockVoiceSupported = false;
    const { container } = render(<MessageInput sessionId="s1" onSend={vi.fn()} />);

    const button = micButton(container);
    expect(button.disabled).toBe(false);
    expect(button.title).toBe('Voice input requires HTTPS or localhost');
  });

  it('surfaces the HTTPS toast on click instead of a silent no-op when unsupported', async () => {
    mockVoiceSupported = false;
    const { container } = render(<MessageInput sessionId="s1" onSend={vi.fn()} />);

    const button = micButton(container);
    fireEvent.click(button);

    await waitFor(() =>
      expect(toastError).toHaveBeenCalledWith(
        'Voice input requires HTTPS or localhost browser access'
      )
    );
    expect(voiceStart).not.toHaveBeenCalled();
  });

  it('starts recording on click when recording IS supported (no regression)', async () => {
    mockVoiceSupported = true;
    const { container } = render(<MessageInput sessionId="s1" onSend={vi.fn()} />);

    const button = micButton(container);
    expect(button.disabled).toBe(false);
    fireEvent.click(button);

    await waitFor(() => expect(voiceStart).toHaveBeenCalledTimes(1));
    expect(toastError).not.toHaveBeenCalled();
  });
});
