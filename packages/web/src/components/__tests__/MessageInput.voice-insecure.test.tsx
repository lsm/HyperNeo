// @ts-nocheck
/**
 * Tests for the composer mic button in non-secure (insecure) browser contexts.
 *
 * ROOT CAUSE:
 * The mic button was `disabled` whenever `isVoiceRecordingSupported()` returned
 * false (any non-secure context: not HTTPS / localhost / 127.0.0.1). A disabled
 * button swallows clicks silently in a real browser, so the explanatory toast
 * inside `handleVoiceClick` was unreachable dead code:
 *
 *   disabled={(disabled && !voiceRecorder.isRecording) || isTranscribing || !voiceSupported}
 *
 * FIX:
 * Stop disabling the button on `!voiceSupported` so the click reaches
 * `handleVoiceClick`, which already guards the unsupported case and surfaces the
 * toast. The button keeps its "Voice input requires HTTPS or localhost" tooltip.
 */
import { signal } from '@preact/signals';
import { cleanup, fireEvent, render, waitFor } from '@testing-library/preact';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mockAgentWorking = signal(false);

// Toggle per test: whether the browser context supports voice recording.
let mockVoiceSupported = false;

const toastError = vi.fn();
const toastInfo = vi.fn();
const voiceStart = vi.fn(async () => {});
const voiceStop = vi.fn(async () => ({ audioBase64: '', mimeType: 'audio/wav' }));
const voiceCancel = vi.fn(async () => {});

vi.mock('../../lib/state.ts', () => ({
  // Voice enabled + configured so the mic button is rendered (voiceControlVisible).
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
  // Forward via arrow bodies so the spies (declared below) are resolved lazily
  // at call time, not when this hoisted factory is evaluated. Rest-args passthrough
  // preserves the exact call signature for toHaveBeenCalledWith assertions.
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
  // When not recording, the button is labelled "Start voice input".
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
    // This is the crux of the fix: the button must NOT be disabled, otherwise a
    // real browser swallows the click and the user gets no feedback.
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
    // The unsupported branch short-circuits before touching the recorder.
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
