// @ts-nocheck
import { signal } from '@preact/signals';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/preact';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mockAgentWorking = signal(false);

const draft = signal('');
const recorderState = { isRecording: true };
const voiceStop = vi.fn(async () => {
  recorderState.isRecording = false;
  return { audioBase64: 'aGk=', mimeType: 'audio/wav' };
});
const voiceCancel = vi.fn(async () => {
  recorderState.isRecording = false;
});
const transcribeRequest = vi.fn(async () => ({ text: 'hello world' }));
const hubRequest = vi.fn(async (method: string, ...rest: unknown[]) => {
  if (method === 'voice.transcribe') return transcribeRequest(method, ...rest);
  return {};
});

vi.mock('../../lib/state.ts', () => ({
  globalSettings: {
    value: { voice: { enabled: true, endpoint: 'https://asr.example.com/v1', model: 'whisper-1' } },
  },
  connectionState: { value: 'connected' },
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
  useVoiceRecorder: () => ({
    get isRecording() {
      return recorderState.isRecording;
    },
    isStarting: false,
    durationLimitHit: false,
    start: vi.fn(async () => {}),
    stop: voiceStop,
    cancel: voiceCancel,
    setRecordingCursor: vi.fn(),
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
  connectionManager: {
    getHubIfConnected: vi.fn(() => ({ request: hubRequest, onEvent: vi.fn(() => vi.fn()) })),
  },
}));

const enqueueTranscript = vi.hoisted(() => vi.fn());
const isPermanentAppendRefusal = vi.hoisted(() => vi.fn(() => false));
vi.mock('../../lib/voice/voice-transcript-outbox.ts', () => ({
  enqueueTranscript,
  isPermanentAppendRefusal,
}));

import { toast } from '../../lib/toast.ts';
import { connectionManager } from '../../lib/connection-manager.ts';
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
    hubRequest.mockReset().mockImplementation(async (method: string, ...rest: unknown[]) => {
      if (method === 'voice.transcribe') return transcribeRequest(method, ...rest);
      return {};
    });
    enqueueTranscript.mockReset().mockReturnValue(true);
    vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) =>
      setTimeout(() => cb(0), 0)
    );
    vi.stubGlobal('cancelAnimationFrame', (id: ReturnType<typeof setTimeout>) => clearTimeout(id));
    vi.mocked(connectionManager.getHubIfConnected)
      .mockReset()
      .mockImplementation(() => ({ request: hubRequest, onEvent: vi.fn(() => vi.fn()) }));
    Object.defineProperty(window, 'matchMedia', {
      writable: true,
      value: vi.fn().mockReturnValue({ matches: false }),
    });
  });

  afterEach(async () => {
    cleanup();
    await new Promise((resolve) => setTimeout(resolve, 0));
    vi.unstubAllGlobals();
  });

  it('shows the waveform body with Cancel, Stop and Send while recording', () => {
    const { container } = render(<MessageInput sessionId="s1" onSend={vi.fn()} />);

    expect(container.querySelector('[data-testid="voice-recording-panel"]')).toBeTruthy();
    expect(container.querySelector('textarea')).toBeNull();

    expect(screen.getByLabelText('Cancel recording')).toBeTruthy();
    expect(screen.getByLabelText('Stop recording and transcribe')).toBeTruthy();
    expect(screen.getByLabelText('Stop, transcribe and send')).toBeTruthy();
    expect(screen.queryByTestId('send-button')).toBeNull();
  });

  it('Send stops, transcribes and auto-submits the transcript', async () => {
    const onSend = vi.fn(async () => {});
    const { container } = render(<MessageInput sessionId="s1" onSend={onSend} />);

    fireEvent.click(screen.getByLabelText('Stop, transcribe and send'));

    await waitFor(() => expect(voiceStop).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(transcribeRequest).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(onSend).toHaveBeenCalledWith('hello world', undefined, 'immediate'));
  });

  it('delivers the transcript as a sent message (send) when the composer unmounts mid-transcription', async () => {
    let resolveTranscribe!: (value: { text: string }) => void;
    transcribeRequest.mockReturnValueOnce(
      new Promise<{ text: string }>((resolve) => {
        resolveTranscribe = resolve;
      })
    );

    const onSend = vi.fn(async () => true);
    draft.value = 'note:';
    const { unmount } = render(<MessageInput sessionId="s1" onSend={onSend} />);

    fireEvent.click(screen.getByLabelText('Stop, transcribe and send'));
    await waitFor(() => expect(transcribeRequest).toHaveBeenCalledTimes(1));
    unmount();
    await new Promise((resolve) => setTimeout(resolve, 0));
    resolveTranscribe({ text: 'hello world' });

    await waitFor(() =>
      expect(onSend).toHaveBeenCalledWith('hello world note:', undefined, 'immediate')
    );
    await waitFor(() => {
      const clearCall = hubRequest.mock.calls.find(([m]) => m === 'session.clearInputDraftIf');
      expect(clearCall).toBeTruthy();
      expect(clearCall[1]).toEqual({ sessionId: 's1', expected: 'note:' });
    });
    await waitFor(() => expect(toast.info).toHaveBeenCalledWith('Voice transcript sent'));
  });

  it('retains the transcript in the pending draft instead of sending when the composer is at the character limit', async () => {
    let resolveTranscribe!: (value: { text: string }) => void;
    transcribeRequest.mockReturnValueOnce(
      new Promise<{ text: string }>((resolve) => {
        resolveTranscribe = resolve;
      })
    );

    const onSend = vi.fn(async () => true);
    draft.value = 'x'.repeat(100_000);
    const { unmount } = render(<MessageInput sessionId="s1" onSend={onSend} />);

    fireEvent.click(screen.getByLabelText('Stop, transcribe and send'));
    await waitFor(() => expect(transcribeRequest).toHaveBeenCalledTimes(1));
    unmount();
    await new Promise((resolve) => setTimeout(resolve, 0));
    resolveTranscribe({ text: 'hello world' });

    await waitFor(() =>
      expect(toast.info).toHaveBeenCalledWith(
        'Composer draft is full — voice transcript saved to the session draft'
      )
    );
    const stageCall = hubRequest.mock.calls.find(([m]) => m === 'session.appendVoiceDraft');
    expect(stageCall).toBeTruthy();
    expect(stageCall[1]).toEqual(expect.objectContaining({ sessionId: 's1', text: 'hello world' }));
    expect(onSend).not.toHaveBeenCalled();
  });

  it('stages the transcript (stay) into the pending draft field when the composer unmounts mid-transcription', async () => {
    let resolveTranscribe!: (value: { text: string }) => void;
    transcribeRequest.mockReturnValueOnce(
      new Promise<{ text: string }>((resolve) => {
        resolveTranscribe = resolve;
      })
    );

    const onSend = vi.fn(async () => {});
    const { unmount } = render(<MessageInput sessionId="s1" onSend={onSend} />);

    fireEvent.click(screen.getByLabelText('Stop recording and transcribe'));
    await waitFor(() => expect(transcribeRequest).toHaveBeenCalledTimes(1));
    unmount();
    await new Promise((resolve) => setTimeout(resolve, 0));
    resolveTranscribe({ text: 'hello world' });

    await waitFor(() => {
      const stageCall = hubRequest.mock.calls.find(([m]) => m === 'session.appendVoiceDraft');
      expect(stageCall).toBeTruthy();
      expect(stageCall[1]).toEqual(
        expect.objectContaining({ sessionId: 's1', text: 'hello world' })
      );
    });
    await waitFor(() =>
      expect(toast.info).toHaveBeenCalledWith('Voice transcript saved to the session draft')
    );
    expect(onSend).not.toHaveBeenCalled();
  });

  it('parks the transcript in the durable outbox when staging needs a dead socket', async () => {
    let resolveTranscribe!: (value: { text: string }) => void;
    transcribeRequest.mockReturnValueOnce(
      new Promise<{ text: string }>((resolve) => {
        resolveTranscribe = resolve;
      })
    );

    const onSend = vi.fn(async () => true);
    const { unmount } = render(<MessageInput sessionId="s1" onSend={onSend} />);

    fireEvent.click(screen.getByLabelText('Stop recording and transcribe'));
    await waitFor(() => expect(transcribeRequest).toHaveBeenCalledTimes(1));
    unmount();
    await new Promise((resolve) => setTimeout(resolve, 0));
    vi.mocked(connectionManager.getHubIfConnected).mockReturnValue(null);
    resolveTranscribe({ text: 'hello world' });

    await waitFor(() =>
      expect(enqueueTranscript).toHaveBeenCalledWith('s1', 'hello world', expect.any(String))
    );
    await waitFor(() =>
      expect(toast.info).toHaveBeenCalledWith(
        'Voice transcript saved — will be delivered when reconnected'
      )
    );
    expect(hubRequest.mock.calls.find(([m]) => m === 'session.appendVoiceDraft')).toBeFalsy();
    expect(onSend).not.toHaveBeenCalled();
  });

  it('warns honestly when the outbox could only keep the transcript in memory', async () => {
    let resolveTranscribe!: (value: { text: string }) => void;
    transcribeRequest.mockReturnValueOnce(
      new Promise<{ text: string }>((resolve) => {
        resolveTranscribe = resolve;
      })
    );
    enqueueTranscript.mockReturnValue(false);

    const onSend = vi.fn(async () => true);
    const { unmount } = render(<MessageInput sessionId="s1" onSend={onSend} />);

    fireEvent.click(screen.getByLabelText('Stop recording and transcribe'));
    await waitFor(() => expect(transcribeRequest).toHaveBeenCalledTimes(1));
    unmount();
    await new Promise((resolve) => setTimeout(resolve, 0));
    vi.mocked(connectionManager.getHubIfConnected).mockReturnValue(null);
    resolveTranscribe({ text: 'hello world' });

    await waitFor(() =>
      expect(toast.info).toHaveBeenCalledWith(
        'Voice transcript kept in this tab — reconnect before closing it'
      )
    );
  });

  it('enqueues an AMBIGUOUS staging timeout (append may have committed) even while reconnected', async () => {
    let resolveTranscribe!: (value: { text: string }) => void;
    transcribeRequest.mockReturnValueOnce(
      new Promise<{ text: string }>((resolve) => {
        resolveTranscribe = resolve;
      })
    );

    const onSend = vi.fn(async () => true);
    const { unmount } = render(<MessageInput sessionId="s1" onSend={onSend} />);

    fireEvent.click(screen.getByLabelText('Stop recording and transcribe'));
    await waitFor(() => expect(transcribeRequest).toHaveBeenCalledTimes(1));
    unmount();
    await new Promise((resolve) => setTimeout(resolve, 0));
    hubRequest.mockImplementation(async (method: string) => {
      if (method === 'voice.transcribe') return transcribeRequest(method);
      throw new Error('Request timeout: session.appendVoiceDraft (10000ms)');
    });
    resolveTranscribe({ text: 'hello world' });

    await waitFor(() =>
      expect(enqueueTranscript).toHaveBeenCalledWith('s1', 'hello world', expect.any(String))
    );
    await waitFor(() =>
      expect(toast.info).toHaveBeenCalledWith(
        'Voice transcript saved — will be delivered when reconnected'
      )
    );
  });

  it('surfaces a failure toast (not a false "sent") when the unmounted delivery fails', async () => {
    let resolveTranscribe!: (value: { text: string }) => void;
    transcribeRequest.mockReturnValueOnce(
      new Promise<{ text: string }>((resolve) => {
        resolveTranscribe = resolve;
      })
    );
    const onSend = vi.fn(async () => {
      throw new Error('boom');
    });
    const { unmount } = render(<MessageInput sessionId="s1" onSend={onSend} />);

    fireEvent.click(screen.getByLabelText('Stop, transcribe and send'));
    await waitFor(() => expect(transcribeRequest).toHaveBeenCalledTimes(1));
    unmount();
    await new Promise((resolve) => setTimeout(resolve, 0));
    resolveTranscribe({ text: 'hello world' });

    await waitFor(() =>
      expect(toast.info).toHaveBeenCalledWith(
        'Voice send failed — transcript saved to the session draft'
      )
    );
    const stageCall = hubRequest.mock.calls.find(([m]) => m === 'session.appendVoiceDraft');
    expect(stageCall).toBeTruthy();
    expect(stageCall[1]).toEqual(expect.objectContaining({ sessionId: 's1', text: 'hello world' }));
    const clearCall = hubRequest.mock.calls.find(([m]) => m === 'session.clearInputDraftIf');
    expect(clearCall).toBeFalsy();
  });

  it('still delivers through the captured onSend when the hub is disconnected', async () => {
    let resolveTranscribe!: (value: { text: string }) => void;
    transcribeRequest.mockReturnValueOnce(
      new Promise<{ text: string }>((resolve) => {
        resolveTranscribe = resolve;
      })
    );

    const onSend = vi.fn(async () => true);
    const { unmount } = render(<MessageInput sessionId="s1" onSend={onSend} />);

    fireEvent.click(screen.getByLabelText('Stop, transcribe and send'));
    await waitFor(() => expect(transcribeRequest).toHaveBeenCalledTimes(1));
    unmount();
    await new Promise((resolve) => setTimeout(resolve, 0));
    vi.mocked(connectionManager.getHubIfConnected).mockReturnValue(null);
    resolveTranscribe({ text: 'hello world' });

    await waitFor(() => expect(onSend).toHaveBeenCalledWith('hello world', undefined, 'immediate'));
    await waitFor(() => expect(toast.info).toHaveBeenCalledWith('Voice transcript sent'));
    expect(hubRequest.mock.calls.find(([m]) => m === 'session.clearInputDraftIf')).toBeFalsy();
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

  describe('stop-and-transcribe outcome branches', () => {
    it('discards the recording with an error toast when the hub is disconnected at stop', async () => {
      vi.mocked(connectionManager.getHubIfConnected).mockReturnValue(null);
      const onSend = vi.fn(async () => true);
      render(<MessageInput sessionId="s1" onSend={onSend} />);

      fireEvent.click(screen.getByLabelText('Stop, transcribe and send'));

      await waitFor(() => expect(voiceCancel).toHaveBeenCalledTimes(1));
      await waitFor(() => expect(toast.error).toHaveBeenCalledWith('Not connected'));
      expect(voiceStop).toHaveBeenCalledTimes(1);
      expect(transcribeRequest).not.toHaveBeenCalled();
      expect(hubRequest.mock.calls.find(([m]) => m === 'session.appendVoiceDraft')).toBeFalsy();
      expect(enqueueTranscript).not.toHaveBeenCalled();
      expect(onSend).not.toHaveBeenCalled();
    });

    it('cancels the recorder without retrying when the transcribe RPC fails', async () => {
      transcribeRequest.mockRejectedValueOnce(new Error('ASR unavailable'));
      const onSend = vi.fn(async () => true);
      render(<MessageInput sessionId="s1" onSend={onSend} />);

      vi.useFakeTimers();
      try {
        fireEvent.click(screen.getByLabelText('Stop, transcribe and send'));
        await vi.waitFor(() => {
          expect(voiceCancel).toHaveBeenCalledTimes(1);
          expect(toast.error).toHaveBeenCalledWith('ASR unavailable');
        });
        expect(transcribeRequest).toHaveBeenCalledTimes(1);
        await vi.advanceTimersByTimeAsync(130_000);
        expect(transcribeRequest).toHaveBeenCalledTimes(1);
        expect(onSend).not.toHaveBeenCalled();
        expect(enqueueTranscript).not.toHaveBeenCalled();
        expect(hubRequest.mock.calls.find(([m]) => m === 'session.appendVoiceDraft')).toBeFalsy();
      } finally {
        vi.useRealTimers();
      }
      await waitFor(() => expect(screen.getByTestId('send-button')).toBeTruthy());
    });

    it('discards silent audio (peakLevel below 0.001) without transcribing', async () => {
      voiceStop.mockResolvedValueOnce({
        audioBase64: 'aGk=',
        mimeType: 'audio/wav',
        peakLevel: 0.0004,
      });
      const onSend = vi.fn(async () => true);
      render(<MessageInput sessionId="s1" onSend={onSend} />);

      fireEvent.click(screen.getByLabelText('Stop, transcribe and send'));

      await waitFor(() =>
        expect(toast.error).toHaveBeenCalledWith(
          'No microphone signal detected — check your mic or input device'
        )
      );
      expect(transcribeRequest).not.toHaveBeenCalled();
      expect(voiceCancel).not.toHaveBeenCalled();
      expect(onSend).not.toHaveBeenCalled();
      expect(enqueueTranscript).not.toHaveBeenCalled();
      expect(draft.value).toBe('');
    });

    it('discards a successful transcript when the session changes during transcription', async () => {
      let resolveTranscribe!: (value: { text: string }) => void;
      transcribeRequest.mockReturnValueOnce(
        new Promise<{ text: string }>((resolve) => {
          resolveTranscribe = resolve;
        })
      );

      const onSend = vi.fn(async () => true);
      const { rerender } = render(<MessageInput sessionId="s1" onSend={onSend} />);

      fireEvent.click(screen.getByLabelText('Stop, transcribe and send'));
      await waitFor(() => expect(transcribeRequest).toHaveBeenCalledTimes(1));
      rerender(<MessageInput sessionId="s2" onSend={onSend} />);
      await new Promise((resolve) => setTimeout(resolve, 0));
      resolveTranscribe({ text: 'hello world' });

      await waitFor(() =>
        expect(toast.info).toHaveBeenCalledWith('Recording target changed — transcript discarded')
      );
      expect(draft.value).toBe('');
      expect(onSend).not.toHaveBeenCalled();
      expect(voiceCancel).not.toHaveBeenCalled();
      expect(hubRequest.mock.calls.find(([m]) => m === 'session.appendVoiceDraft')).toBeFalsy();
      expect(enqueueTranscript).not.toHaveBeenCalled();
    });

    it('parks an unmounted send in the durable outbox when draft staging is refused', async () => {
      let resolveTranscribe!: (value: { text: string }) => void;
      transcribeRequest.mockReturnValueOnce(
        new Promise<{ text: string }>((resolve) => {
          resolveTranscribe = resolve;
        })
      );

      const onSend = vi.fn(async () => false);
      const { unmount } = render(<MessageInput sessionId="s1" onSend={onSend} />);

      fireEvent.click(screen.getByLabelText('Stop, transcribe and send'));
      await waitFor(() => expect(transcribeRequest).toHaveBeenCalledTimes(1));
      unmount();
      await new Promise((resolve) => setTimeout(resolve, 0));
      hubRequest.mockImplementation(async (method: string) => {
        if (method === 'voice.transcribe') return transcribeRequest(method);
        throw new Error('socket closed mid-request');
      });
      resolveTranscribe({ text: 'hello world' });

      await waitFor(() =>
        expect(enqueueTranscript).toHaveBeenCalledWith('s1', 'hello world', expect.any(String))
      );
      await waitFor(() =>
        expect(toast.info).toHaveBeenCalledWith(
          'Voice transcript saved — will be delivered when reconnected'
        )
      );
      const stageCall = hubRequest.mock.calls.find(([m]) => m === 'session.appendVoiceDraft');
      expect(stageCall).toBeTruthy();
      const outboxId = enqueueTranscript.mock.calls[0]?.[2];
      expect(outboxId).toEqual(expect.any(String));
      expect(stageCall[1]).toEqual(
        expect.objectContaining({
          sessionId: 's1',
          text: 'hello world',
          dedupId: outboxId,
        })
      );
      expect(hubRequest.mock.calls.find(([m]) => m === 'session.clearInputDraftIf')).toBeFalsy();
    });

    it('keeps an unmounted send only in this tab when the outbox write is not durable', async () => {
      let resolveTranscribe!: (value: { text: string }) => void;
      transcribeRequest.mockReturnValueOnce(
        new Promise<{ text: string }>((resolve) => {
          resolveTranscribe = resolve;
        })
      );
      enqueueTranscript.mockReturnValue(false);

      const onSend = vi.fn(async () => false);
      const { unmount } = render(<MessageInput sessionId="s1" onSend={onSend} />);

      fireEvent.click(screen.getByLabelText('Stop, transcribe and send'));
      await waitFor(() => expect(transcribeRequest).toHaveBeenCalledTimes(1));
      unmount();
      await new Promise((resolve) => setTimeout(resolve, 0));
      hubRequest.mockImplementation(async (method: string) => {
        if (method === 'voice.transcribe') return transcribeRequest(method);
        throw new Error('socket closed mid-request');
      });
      resolveTranscribe({ text: 'hello world' });

      await waitFor(() =>
        expect(toast.info).toHaveBeenCalledWith(
          'Voice transcript kept in this tab — reconnect before closing it'
        )
      );
      expect(enqueueTranscript).toHaveBeenCalledWith('s1', 'hello world', expect.any(String));
      expect(hubRequest.mock.calls.find(([m]) => m === 'session.appendVoiceDraft')).toBeTruthy();
    });

    it('reports the transcript as lost when draft staging is permanently refused', async () => {
      let resolveTranscribe!: (value: { text: string }) => void;
      transcribeRequest.mockReturnValueOnce(
        new Promise<{ text: string }>((resolve) => {
          resolveTranscribe = resolve;
        })
      );

      const onSend = vi.fn(async () => true);
      const { unmount } = render(<MessageInput sessionId="s1" onSend={onSend} />);

      fireEvent.click(screen.getByLabelText('Stop recording and transcribe'));
      await waitFor(() => expect(transcribeRequest).toHaveBeenCalledTimes(1));
      unmount();
      await new Promise((resolve) => setTimeout(resolve, 0));
      isPermanentAppendRefusal.mockReturnValueOnce(true);
      hubRequest.mockImplementation(async (method: string) => {
        if (method === 'voice.transcribe') return transcribeRequest(method);
        throw new Error('Session not found: s1');
      });
      resolveTranscribe({ text: 'hello world' });

      await waitFor(() =>
        expect(toast.error).toHaveBeenCalledWith(
          'Voice transcript could not be delivered — it was lost'
        )
      );
      expect(hubRequest.mock.calls.find(([m]) => m === 'session.appendVoiceDraft')).toBeTruthy();
      expect(enqueueTranscript).not.toHaveBeenCalled();
    });
  });
});
