// @ts-nocheck
/**
 * Tests for the composer's in-input recording UI: while recording, the composer
 * shows the waveform body plus Cancel / Stop / Send controls (laid out in flow so
 * nothing overlaps), and clicking Send stops, transcribes, and auto-submits the
 * transcript.
 */
import { signal } from '@preact/signals';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/preact';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mockAgentWorking = signal(false);

// A working draft store so the transcript insert is visible to handleSubmit.
const draft = signal('');
// Recording state flips off when stop() is called, mirroring the real hook.
const recorderState = { isRecording: true };
const voiceStop = vi.fn(async () => {
  recorderState.isRecording = false;
  return { audioBase64: 'aGk=', mimeType: 'audio/wav' };
});
const voiceCancel = vi.fn(async () => {
  recorderState.isRecording = false;
});
const transcribeRequest = vi.fn(async () => ({ text: 'hello world' }));
// The hub carries other RPCs too (queue-preview queries); dispatch by method so
// only voice.transcribe hits the transcribe spy.
const hubRequest = vi.fn(async (method: string, ...rest: unknown[]) => {
  if (method === 'voice.transcribe') return transcribeRequest(method, ...rest);
  return {};
});

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
  toast: { error: vi.fn(), info: vi.fn() },
}));

vi.mock('../../hooks', () => ({
  isVoiceRecordingSupported: () => true,
  // Recording in progress: the composer must show the recording cluster.
  useVoiceRecorder: () => ({
    get isRecording() {
      return recorderState.isRecording;
    },
    isStarting: false,
    durationLimitHit: false,
    start: vi.fn(async () => {}),
    stop: voiceStop,
    cancel: voiceCancel,
    getLevel: () => 0,
  }),
  useInputDraft: () => ({
    content: draft.value,
    setContent: (v: string) => {
      draft.value = v;
    },
    clear: () => {
      draft.value = '';
    },
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
  connectionManager: { getHubIfConnected: () => ({ request: hubRequest }) },
}));

import { toast } from '../../lib/toast.ts';
import MessageInput from '../MessageInput';

describe('MessageInput — recording UI', () => {
  beforeEach(() => {
    cleanup();
    mockAgentWorking.value = false;
    draft.value = '';
    recorderState.isRecording = true;
    voiceStop.mockClear();
    voiceCancel.mockClear();
    transcribeRequest.mockClear();
    hubRequest.mockClear();
    vi.stubGlobal(
      'requestAnimationFrame',
      vi.fn(() => 0)
    );
    vi.stubGlobal('cancelAnimationFrame', vi.fn());
    Object.defineProperty(window, 'matchMedia', {
      writable: true,
      value: vi.fn().mockReturnValue({ matches: false }),
    });
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it('shows the waveform body with Cancel, Stop and Send while recording', () => {
    const { container } = render(<MessageInput sessionId="s1" onSend={vi.fn()} />);

    // Waveform replaces the textarea inside the same composer pill.
    expect(container.querySelector('[data-testid="voice-recording-panel"]')).toBeTruthy();
    expect(container.querySelector('textarea')).toBeNull();

    expect(screen.getByLabelText('Cancel recording')).toBeTruthy();
    expect(screen.getByLabelText('Stop recording and transcribe')).toBeTruthy();
    expect(screen.getByLabelText('Stop, transcribe and send')).toBeTruthy();
    // The plain (draft-only) send button is not shown while recording.
    expect(screen.queryByTestId('send-button')).toBeNull();
  });

  it('Send stops, transcribes and auto-submits the transcript', async () => {
    const onSend = vi.fn(async () => {});
    const { container } = render(<MessageInput sessionId="s1" onSend={onSend} />);

    fireEvent.click(screen.getByLabelText('Stop, transcribe and send'));

    await waitFor(() => expect(voiceStop).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(transcribeRequest).toHaveBeenCalledTimes(1));
    // The transcript ('hello world') is auto-submitted once transcription completes.
    await waitFor(() => expect(onSend).toHaveBeenCalledWith('hello world', undefined, 'immediate'));
  });

  it('persists the transcript to the session draft when the composer unmounts mid-transcription', async () => {
    // Slow transcription: resolve only after the composer has unmounted, so the
    // completion runs against mountedRef === false (the keyed ChatContainer is
    // gone), mirroring a user who clicks Send then navigates to another session.
    let resolveTranscribe!: (value: { text: string }) => void;
    const transcribePromise = new Promise<{ text: string }>((resolve) => {
      resolveTranscribe = resolve;
    });
    transcribeRequest.mockReturnValueOnce(transcribePromise);
    // The target session already has a draft — the transcript must be appended
    // to it, not replace it. Only voice.transcribe is deferred.
    hubRequest.mockImplementation(async (method: string, payload?: unknown) => {
      if (method === 'voice.transcribe') return transcribeRequest(method, payload);
      if (method === 'session.get')
        return { session: { metadata: { inputDraft: 'existing draft' } } };
      return {};
    });

    const onSend = vi.fn(async () => {});
    const { unmount } = render(<MessageInput sessionId="s1" onSend={onSend} />);

    fireEvent.click(screen.getByLabelText('Stop, transcribe and send'));
    // Stop + transcribe request fire while the composer is still mounted...
    await waitFor(() => expect(transcribeRequest).toHaveBeenCalledTimes(1));
    // ...then the user navigates away BEFORE the slow transcription resolves.
    unmount();
    await new Promise((resolve) => setTimeout(resolve, 0));
    resolveTranscribe({ text: 'hello world' });

    // The transcript is appended to s1's server-side draft — not silently lost.
    await waitFor(() => {
      const updateCall = hubRequest.mock.calls.find(([m]) => m === 'session.update');
      expect(updateCall).toBeTruthy();
      expect(updateCall[1]).toMatchObject({
        sessionId: 's1',
        metadata: { inputDraft: 'existing draft hello world' },
      });
    });
    // No mounted composer to auto-submit through, so it is preserved as a draft
    // rather than sent. (Background send delivery is a follow-up.)
    expect(onSend).not.toHaveBeenCalled();

    // Restore the default dispatch so later tests aren't affected.
    hubRequest.mockImplementation(async (method: string, ...rest: unknown[]) => {
      if (method === 'voice.transcribe') return transcribeRequest(method, ...rest);
      return {};
    });
  });

  it('Cancel discards the recording without transcribing', async () => {
    const onSend = vi.fn(async () => {});
    render(<MessageInput sessionId="s1" onSend={onSend} />);

    fireEvent.click(screen.getByLabelText('Cancel recording'));

    await waitFor(() => expect(voiceCancel).toHaveBeenCalledTimes(1));
    expect(voiceStop).not.toHaveBeenCalled();
    expect(transcribeRequest).not.toHaveBeenCalled();
    expect(onSend).not.toHaveBeenCalled();
  });

  it('agent running: Queue + Steer replace Send, and no agent stop button appears', () => {
    mockAgentWorking.value = true;
    render(<MessageInput sessionId="s1" onSend={vi.fn()} />);

    expect(screen.getByLabelText('Stop recording and transcribe')).toBeTruthy();
    expect(screen.getByLabelText('Stop, transcribe and queue')).toBeTruthy();
    expect(screen.getByLabelText('Stop, transcribe and steer')).toBeTruthy();
    // The idle-state blue voice send is hidden, and the agent's own stop button
    // is never shown next to the voice stop (no two-stop-buttons state).
    expect(screen.queryByLabelText('Stop, transcribe and send')).toBeNull();
    expect(screen.queryByLabelText('Stop generation')).toBeNull();
  });

  it('Queue stops, transcribes and defers the transcript to the next turn', async () => {
    mockAgentWorking.value = true;
    const onSend = vi.fn(async () => {});
    render(<MessageInput sessionId="s1" onSend={onSend} />);

    fireEvent.click(screen.getByLabelText('Stop, transcribe and queue'));

    await waitFor(() => expect(voiceStop).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(transcribeRequest).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(onSend).toHaveBeenCalledWith('hello world', undefined, 'defer'));
  });

  it('composers without deferred delivery hide Queue (voice and typed), keeping Steer', () => {
    mockAgentWorking.value = true;
    render(<MessageInput sessionId="s1" onSend={vi.fn()} supportsQueueDelivery={false} />);

    expect(screen.queryByLabelText('Stop, transcribe and queue')).toBeNull();
    expect(screen.getByLabelText('Stop, transcribe and steer')).toBeTruthy();
    expect(screen.queryByTestId('queue-button')).toBeNull();
  });

  it('whitespace-only transcripts show the no-speech toast and do not send', async () => {
    transcribeRequest.mockResolvedValueOnce({ text: '  \n ' });
    const onSend = vi.fn(async () => {});
    render(<MessageInput sessionId="s1" onSend={onSend} />);

    fireEvent.click(screen.getByLabelText('Stop, transcribe and send'));

    await waitFor(() => expect(transcribeRequest).toHaveBeenCalledTimes(1));
    await waitFor(() =>
      expect(toast.info).toHaveBeenCalledWith('No speech detected in that recording')
    );
    expect(onSend).not.toHaveBeenCalled();
    expect(draft.value).toBe('');
  });
});
