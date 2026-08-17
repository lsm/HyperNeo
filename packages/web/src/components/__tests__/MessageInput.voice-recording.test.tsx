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
  connectionManager: { getHubIfConnected: vi.fn(() => ({ request: hubRequest })) },
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
    // mockReset (not clear) so a per-test mockImplementation (e.g. a staging
    // timeout) cannot leak into the next test as its first hubRequest call.
    hubRequest.mockReset().mockImplementation(async (method: string, ...rest: unknown[]) => {
      if (method === 'voice.transcribe') return transcribeRequest(method, ...rest);
      return {};
    });
    enqueueTranscript.mockReset().mockReturnValue(true);
    // mockReset (not clear): a previous test's per-test return (e.g. the
    // memory-backed false) must not leak into the next.
    // Timer-backed rAF so deferred hook work actually runs and can be drained
    // before the stubs are removed. A no-op stub leaves Preact cleanup pending
    // until after unstubAllGlobals, where cancelAnimationFrame no longer exists
    // — an unhandled ReferenceError that blocks CI even with green tests.
    vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) =>
      setTimeout(() => cb(0), 0)
    );
    vi.stubGlobal('cancelAnimationFrame', (id: ReturnType<typeof setTimeout>) => clearTimeout(id));
    // Default: hub connected. Individual tests may override (e.g. disconnect);
    // mockReset drops any leaked override from a previous test.
    vi.mocked(connectionManager.getHubIfConnected)
      .mockReset()
      .mockImplementation(() => ({ request: hubRequest }));
    Object.defineProperty(window, 'matchMedia', {
      writable: true,
      value: vi.fn().mockReturnValue({ matches: false }),
    });
  });

  afterEach(async () => {
    cleanup();
    // Drain rAF-backed timers while the stubs are still installed so pending
    // hook cleanups settle before unstubAllGlobals removes cancelAnimationFrame.
    await new Promise((resolve) => setTimeout(resolve, 0));
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

  it('delivers the transcript as a sent message (send) when the composer unmounts mid-transcription', async () => {
    // Slow transcription: resolve only after the composer has unmounted, so the
    // completion runs against mountedRef === false (the keyed ChatContainer is
    // gone), mirroring a user who clicks Send then navigates to another session.
    let resolveTranscribe!: (value: { text: string }) => void;
    transcribeRequest.mockReturnValueOnce(
      new Promise<{ text: string }>((resolve) => {
        resolveTranscribe = resolve;
      })
    );

    const onSend = vi.fn(async () => true);
    // The user already typed some draft text before voice-Sending.
    draft.value = 'note:';
    const { unmount } = render(<MessageInput sessionId="s1" onSend={onSend} />);

    fireEvent.click(screen.getByLabelText('Stop, transcribe and send'));
    // Stop + transcribe fire while the composer is still mounted...
    await waitFor(() => expect(transcribeRequest).toHaveBeenCalledTimes(1));
    // ...then the user navigates away BEFORE the slow transcription resolves.
    unmount();
    await new Promise((resolve) => setTimeout(resolve, 0));
    resolveTranscribe({ text: 'hello world' });

    // send mode delivers the FULL click-time payload (draft + transcript
    // spliced at the captured caret) through the composer's OWN captured
    // onSend — so worktree-choice setup and task-composer routing apply, not a
    // bare message.send RPC. This harness never captures a caret (no input
    // events fire), so the insertion point defaults to the start of the draft.
    await waitFor(() =>
      expect(onSend).toHaveBeenCalledWith('hello world note:', undefined, 'immediate')
    );
    // The consumed click-time draft is cleared ATOMICALLY server-side, only if
    // the persisted draft still matches the complete click-time snapshot — so
    // reopening doesn't re-send it, and newer edits elsewhere win.
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
    // Draft already at the composer's 100k character limit.
    draft.value = 'x'.repeat(100_000);
    const { unmount } = render(<MessageInput sessionId="s1" onSend={onSend} />);

    fireEvent.click(screen.getByLabelText('Stop, transcribe and send'));
    await waitFor(() => expect(transcribeRequest).toHaveBeenCalledTimes(1));
    unmount();
    await new Promise((resolve) => setTimeout(resolve, 0));
    resolveTranscribe({ text: 'hello world' });

    // Nothing fits — do not silently send an incomplete payload; retain the
    // transcript in the pending draft field and say so.
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

    // 'Stop' (not Send) — the user wanted to edit before sending.
    fireEvent.click(screen.getByLabelText('Stop recording and transcribe'));
    await waitFor(() => expect(transcribeRequest).toHaveBeenCalledTimes(1));
    unmount();
    await new Promise((resolve) => setTimeout(resolve, 0));
    resolveTranscribe({ text: 'hello world' });

    // stay stages into the pending field; the daemon merges it into the draft
    // atomically on the next session.get.
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
    // The socket is down when the transcript completes — the appendVoiceDraft
    // staging RPC cannot reach the daemon. The transcript must be parked in
    // the durable outbox (not lost) and replayed on reconnect.
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
    // No staging RPC was attempted (the socket is dead), and nothing was sent.
    expect(hubRequest.mock.calls.find(([m]) => m === 'session.appendVoiceDraft')).toBeFalsy();
    expect(onSend).not.toHaveBeenCalled();
  });

  it('warns honestly when the outbox could only keep the transcript in memory', async () => {
    // localStorage refused the write (disabled / quota): the transcript is
    // mirror-only — delivered on reconnect, but a reload loses it. The toast
    // must not promise durable preservation.
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
    // The socket reconnects BEFORE the staging RPC reaches its timeout: the
    // append may have committed with a lost ack, or never arrived. Enqueue the
    // transcript (reusing the shared outbox id) instead of dropping the only
    // copy — the daemon's dedup skips it if the original append did land.
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
    // The composer's own send path fails (e.g. a task composer declining while
    // its target agent is still starting) — the transcript must be PRESERVED
    // via the staging fallback rather than destroyed.
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
    // The only copy was staged into the pending field, not lost.
    const stageCall = hubRequest.mock.calls.find(([m]) => m === 'session.appendVoiceDraft');
    expect(stageCall).toBeTruthy();
    expect(stageCall[1]).toEqual(expect.objectContaining({ sessionId: 's1', text: 'hello world' }));
    // The draft is NOT cleared when the send failed — the text is still staged.
    const clearCall = hubRequest.mock.calls.find(([m]) => m === 'session.clearInputDraftIf');
    expect(clearCall).toBeFalsy();
  });

  it('still delivers through the captured onSend when the hub is disconnected', async () => {
    // The socket drops AFTER the transcription response arrives but BEFORE
    // delivery runs — the captured onSend owns offline queueing
    // (useSendMessage), so delivery must still be attempted rather than
    // reported as lost.
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
    // Disconnect only now — transcription already completed over the wire.
    vi.mocked(connectionManager.getHubIfConnected).mockReturnValue(null);
    resolveTranscribe({ text: 'hello world' });

    await waitFor(() => expect(onSend).toHaveBeenCalledWith('hello world', undefined, 'immediate'));
    await waitFor(() => expect(toast.info).toHaveBeenCalledWith('Voice transcript sent'));
    // No draft to consume (snapshot was empty) and no hub anyway — no clear RPC.
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
