import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/preact';
import { signal } from '@preact/signals';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NeoVoice } from '../NeoVoice.tsx';
import type { VoiceSubmitDeps } from '../../lib/voice/voice-submit-pipeline.ts';

const voice = vi.hoisted(() => ({
  enabled: false,
  recording: false,
  starting: false,
  start: vi.fn(),
  stop: vi.fn(),
  cancel: vi.fn(),
  submit: vi.fn(),
  deleteRecord: vi.fn(),
  batch: vi.fn(),
  hub: null as object | null,
  openStream: vi.fn(),
}));
vi.mock('../useNeoVoiceSettings.ts', () => ({ useNeoVoiceSettings: () => voice.enabled }));
vi.mock('../../hooks/useVoiceRecorder.ts', () => ({
  isVoiceRecordingSupported: () => true,
  useVoiceRecorder: () => ({
    get isRecording() {
      return voice.recording;
    },
    isStarting: voice.starting,
    durationLimitHit: false,
    start: voice.start,
    stop: voice.stop,
    cancel: voice.cancel,
    getLevel: () => 0,
    recordingStartedAt: null,
  }),
}));
vi.mock('../../lib/voice/voice-submit-pipeline.ts', () => ({
  runVoiceSubmit: voice.submit,
  requestVoiceTranscription: voice.batch,
  VOICE_SUBMIT_SILENCE_PEAK_LEVEL: 0.001,
}));
vi.mock('../../lib/voice/voice-stream.ts', () => ({ openVoiceStream: voice.openStream }));
vi.mock('../../lib/connection-manager.ts', () => ({
  connectionManager: { getHubIfConnected: () => voice.hub },
}));
vi.mock('../../lib/voice/voice-audio-store.ts', () => ({ deleteVoiceRecord: voice.deleteRecord }));
const pendingRecords = vi.hoisted(() => ({ set: (_records: unknown[]) => {} }));
vi.mock('../../lib/voice/voice-audio-outbox.ts', () => {
  const records = signal<unknown[]>([]);
  pendingRecords.set = (next: unknown[]) => {
    records.value = next;
  };
  return {
    pendingVoiceAudioRecords: records,
    refreshPendingVoiceAudio: vi.fn(),
    beginInteractiveVoiceSubmit: vi.fn(),
    endInteractiveVoiceSubmit: vi.fn(),
    markVoiceAudioBusy: vi.fn(),
    unmarkVoiceAudioBusy: vi.fn(),
    isVoiceAudioBusy: () => false,
    recordingFromEntry: vi.fn(),
  };
});
vi.mock('../../components/voice/VoiceWaveform.tsx', () => ({
  VoiceWaveform: ({ onCancel }: { onCancel: () => void }) => (
    <button type="button" onClick={onCancel}>
      Cancel recording
    </button>
  ),
}));
beforeEach(() => {
  vi.clearAllMocks();
  pendingRecords.set([]);
  voice.enabled = false;
  voice.recording = false;
  voice.starting = false;
  voice.hub = null;
});
afterEach(cleanup);

describe('Neo voice', () => {
  it('captures Preview and draft before microphone startup rather than after selection changes', async () => {
    voice.enabled = true;
    let started!: () => void;
    voice.start.mockImplementationOnce(
      () =>
        new Promise<void>((done) => {
          started = done;
        })
    );
    const original = {
      artifactId: 'report-a',
      snapshot: 'a'.repeat(64),
      displayName: 'Report A',
      state: 'available' as const,
    };
    const mutable = { ...original };
    const onSendHandle = vi.fn();
    const props = {
      sessionId: 'neo:root',
      connected: true,
      draftText: 'Typed first',
      previewContext: mutable,
      onTranscript: vi.fn(),
      onSendVoice: vi.fn(async () => ({ kind: 'accepted' }) as const),
      onError: vi.fn(),
      onPhase: vi.fn(),
      onSendHandle,
    };
    const view = render(<NeoVoice {...props} />);
    fireEvent.click(screen.getByRole('button', { name: 'Start voice input' }));
    mutable.snapshot = 'c'.repeat(64);
    voice.recording = true;
    view.rerender(
      <NeoVoice
        {...props}
        draftText="Later draft"
        previewContext={{ ...original, artifactId: 'report-b', snapshot: 'b'.repeat(64) }}
      />
    );
    voice.submit.mockResolvedValueOnce({
      kind: 'routed',
      recordId: 'recording',
      outcome: { kind: 'insert', transcript: 'spoken' },
    });
    await act(async () => {
      started();
    });
    await act(async () => {
      onSendHandle.mock.calls[0][0]('send');
    });
    await waitFor(() => expect(voice.submit).toHaveBeenCalledOnce());
    expect(voice.submit.mock.calls[0][0]).toMatchObject({
      previewContext: original,
      sendDraft: 'Typed first',
    });
  });
  it('only offers the microphone when configured and disables it offline', () => {
    const props = {
      sessionId: 'neo:root',
      connected: true,
      draftText: 'typed first',
      onTranscript: vi.fn(),
      onSendVoice: vi.fn(async () => ({ kind: 'accepted' }) as const),
      onError: vi.fn(),
      onPhase: vi.fn(),
      onSendHandle: vi.fn(),
    };
    const view = render(<NeoVoice {...props} />);
    expect(screen.queryByRole('button', { name: 'Start voice input' })).toBeNull();
    voice.enabled = true;
    view.rerender(<NeoVoice {...props} onPhase={vi.fn()} onSendHandle={vi.fn()} />);
    fireEvent.click(screen.getByRole('button', { name: 'Start voice input' }));
    expect(voice.start).toHaveBeenCalledOnce();
    view.rerender(<NeoVoice {...props} connected={false} />);
    expect(
      (screen.getByRole('button', { name: 'Start voice input' }) as HTMLButtonElement).disabled
    ).toBe(true);
  });
  it('transcribes through the existing pipeline into a draft without auto-sending', async () => {
    voice.recording = true;
    voice.submit.mockResolvedValue({
      kind: 'routed',
      outcome: { kind: 'insert', transcript: 'Remember Sunday', autoSend: false },
      recordId: 'recording',
    });
    const onTranscript = vi.fn();
    render(
      <NeoVoice
        sessionId="neo:club"
        connected
        draftText="typed first"
        onTranscript={onTranscript}
        onSendVoice={vi.fn(async () => ({ kind: 'accepted' }) as const)}
        onError={vi.fn()}
        onPhase={vi.fn()}
        onSendHandle={vi.fn()}
      />
    );
    fireEvent.click(
      screen.getByRole('button', { name: 'Stop recording and keep the text as a draft' })
    );
    await waitFor(() => expect(onTranscript).toHaveBeenCalledWith('Remember Sunday'));
    expect(voice.submit).toHaveBeenCalledWith(
      {
        sessionId: 'neo:club',
        mode: 'stay',
        retrySilent: false,
        intent: 'draft',
        sendDraft: 'typed first',
      },
      expect.objectContaining({ stopRecording: voice.stop })
    );
    expect(voice.deleteRecord).toHaveBeenCalledWith('recording');
  });
  it('the composer send handle stops, transcribes and sends exactly once', async () => {
    voice.recording = true;
    voice.submit.mockResolvedValue({
      kind: 'routed',
      outcome: { kind: 'insert', transcript: 'Send me now', autoSend: false },
      recordId: 'recording',
    });
    const onSendVoice = vi.fn(async () => ({ kind: 'accepted' }) as const);
    const onTranscript = vi.fn();
    let sendFromComposer: ((intent: 'draft' | 'send') => void) | undefined;
    const register = (send: ((intent: 'draft' | 'send') => void) | null) => {
      sendFromComposer = send ?? undefined;
    };
    render(
      <NeoVoice
        sessionId="neo:club"
        connected
        draftText="typed first"
        onTranscript={onTranscript}
        onSendVoice={onSendVoice}
        onSendHandle={register}
        onError={vi.fn()}
        onPhase={vi.fn()}
      />
    );
    expect(typeof sendFromComposer).toBe('function');
    expect(
      screen.queryByRole('button', { name: 'Stop recording and send the message' })
    ).toBeNull();
    (sendFromComposer as (intent: 'draft' | 'send') => void)('send');
    await waitFor(() => expect(onSendVoice).toHaveBeenCalledTimes(1));
    expect(onSendVoice).toHaveBeenCalledWith('Send me now', 'recording');
    expect(onTranscript).not.toHaveBeenCalled();
    expect(voice.submit).toHaveBeenCalledWith(
      {
        sessionId: 'neo:club',
        mode: 'stay',
        retrySilent: false,
        intent: 'send',
        sendDraft: 'typed first',
      },
      expect.objectContaining({})
    );
    await waitFor(() => expect(voice.deleteRecord).toHaveBeenCalledWith('recording'));
  });

  it('reports recording as a distinct phase and clears it when idle', async () => {
    voice.recording = true;
    const onPhase = vi.fn();
    const view = render(
      <NeoVoice
        sessionId="neo:club"
        connected
        draftText="typed first"
        onTranscript={vi.fn()}
        onSendVoice={vi.fn(async () => ({ kind: 'accepted' }) as const)}
        onSendHandle={vi.fn()}
        onError={vi.fn()}
        onPhase={onPhase}
      />
    );
    await waitFor(() => expect(onPhase).toHaveBeenCalledWith('recording'));
    voice.recording = false;
    view.rerender(
      <NeoVoice
        sessionId="neo:club"
        connected
        draftText="typed first"
        onTranscript={vi.fn()}
        onSendVoice={vi.fn(async () => ({ kind: 'accepted' }) as const)}
        onSendHandle={vi.fn()}
        onError={vi.fn()}
        onPhase={onPhase}
      />
    );
    await waitFor(() => expect(onPhase).toHaveBeenCalledWith('idle'));
  });

  it.each([
    ['Stop', 'drafting'],
    ['arrow', 'sending'],
  ] as const)(
    'reports where the transcript goes while transcribing after %s',
    async (via, phase) => {
      voice.recording = true;
      let finish: (value: unknown) => void = () => {};
      voice.submit.mockReturnValue(
        new Promise((resolve) => {
          finish = resolve;
        })
      );
      const onPhase = vi.fn();
      let sendFromComposer: ((intent: 'draft' | 'send') => void) | null = null;
      const props = {
        sessionId: 'neo:club',
        connected: true,
        draftText: 'typed first',
        onTranscript: vi.fn(),
        onSendVoice: vi.fn(async () => ({ kind: 'accepted' }) as const),
        onSendHandle: (send: ((intent: 'draft' | 'send') => void) | null) => {
          sendFromComposer = send;
        },
        onError: vi.fn(),
        onPhase,
      };
      render(<NeoVoice {...props} />);
      const stop = screen.getByRole('button', {
        name: 'Stop recording and keep the text as a draft',
      });
      voice.recording = false;
      if (via === 'Stop') fireEvent.click(stop);
      else (sendFromComposer as unknown as (intent: 'draft' | 'send') => void)('send');
      await waitFor(() => expect(onPhase).toHaveBeenLastCalledWith(phase));
      finish({ kind: 'silent-recording' });
      await waitFor(() => expect(onPhase).toHaveBeenLastCalledWith('idle'));
    }
  );

  it('keeps the recording when the send is not confirmed, so it can be retried', async () => {
    voice.recording = true;
    voice.submit.mockResolvedValue({
      kind: 'routed',
      outcome: { kind: 'insert', transcript: 'Send me now', autoSend: false },
      recordId: 'recording',
    });
    const onError = vi.fn();
    let sendFromComposer: ((intent: 'draft' | 'send') => void) | undefined;
    render(
      <NeoVoice
        sessionId="neo:club"
        connected
        draftText="typed first"
        onTranscript={vi.fn()}
        onSendVoice={vi.fn(async () => ({ kind: 'unconfirmed' }) as const)}
        onError={onError}
        onPhase={vi.fn()}
        onSendHandle={(send) => {
          sendFromComposer = send ?? undefined;
        }}
      />
    );
    (sendFromComposer as (intent: 'draft' | 'send') => void)('send');
    await waitFor(() => expect(onError).toHaveBeenCalled());
    expect(voice.deleteRecord).not.toHaveBeenCalled();
  });

  it('replays the persisted send payload on a resend instead of re-transcribing', async () => {
    const onSendVoice = vi.fn(async () => ({ kind: 'accepted' }) as const);
    pendingRecords.set([
      {
        id: 'rec-1',
        sessionId: 'neo:club',
        audioBase64: 'aGk=',
        mimeType: 'audio/wav',
        peakLevel: 0.5,
        createdAt: 1_726_000_000_000,
        intent: 'send',
        sendText: 'already queued',
      },
    ]);
    voice.enabled = true;
    render(
      <NeoVoice
        sessionId="neo:club"
        connected
        draftText="typed first"
        onTranscript={vi.fn()}
        onSendVoice={onSendVoice}
        onError={vi.fn()}
        onPhase={vi.fn()}
        onSendHandle={vi.fn()}
      />
    );
    fireEvent.click(await screen.findByTestId('resend-voice-audio'));
    await waitFor(() => expect(onSendVoice).toHaveBeenCalledWith('already queued', 'rec-1'));
    expect(voice.submit).not.toHaveBeenCalled();
  });

  it('Stop keeps the text as an editable draft and never sends', async () => {
    voice.recording = true;
    voice.submit.mockResolvedValue({
      kind: 'routed',
      outcome: { kind: 'insert', transcript: 'Keep as draft', autoSend: false },
      recordId: 'recording',
    });
    const onSendVoice = vi.fn(async () => ({ kind: 'accepted' }) as const);
    const onTranscript = vi.fn();
    render(
      <NeoVoice
        sessionId="neo:club"
        connected
        draftText="typed first"
        onTranscript={onTranscript}
        onSendVoice={onSendVoice}
        onError={vi.fn()}
        onPhase={vi.fn()}
        onSendHandle={vi.fn()}
      />
    );
    fireEvent.click(
      screen.getByRole('button', { name: 'Stop recording and keep the text as a draft' })
    );
    await waitFor(() => expect(onTranscript).toHaveBeenCalledWith('Keep as draft'));
    expect(onSendVoice).not.toHaveBeenCalled();
  });

  it('retains the original destination after switching context mid-transcription', async () => {
    voice.recording = true;
    let finish: (result: unknown) => void = () => {};
    let dependencies: VoiceSubmitDeps | undefined;
    voice.submit.mockImplementation((_input, deps) => {
      dependencies = deps;
      return new Promise((resolve) => {
        finish = resolve;
      });
    });
    const originalDraft = vi.fn();
    const view = render(
      <NeoVoice
        sessionId="neo:club"
        connected
        draftText="typed first"
        onTranscript={originalDraft}
        onSendVoice={vi.fn(async () => ({ kind: 'accepted' }) as const)}
        onError={vi.fn()}
        onPhase={vi.fn()}
        onSendHandle={vi.fn()}
      />
    );
    fireEvent.click(
      screen.getByRole('button', { name: 'Stop recording and keep the text as a draft' })
    );
    view.unmount();
    expect(dependencies?.isMounted()).toBe(false);
    expect(dependencies?.currentSessionId()).toBe('neo:club');
    expect(voice.cancel).toHaveBeenCalled();
    finish({
      kind: 'routed',
      outcome: { kind: 'deliver-unmounted', transcript: 'Eight people', mode: 'stay' },
      recordId: 'recording',
    });
    await waitFor(() => expect(originalDraft).toHaveBeenCalledWith('Eight people'));
  });
  it('surfaces saved recording failures and microphone refusal', async () => {
    voice.enabled = true;
    voice.start.mockRejectedValueOnce(new Error('Microphone permission denied'));
    const onError = vi.fn();
    const props = {
      sessionId: 'neo:root',
      connected: true,
      draftText: 'typed first',
      onTranscript: vi.fn(),
      onSendVoice: vi.fn(async () => ({ kind: 'accepted' }) as const),
      onError,
      onPhase: vi.fn(),
      onSendHandle: vi.fn(),
    };
    const view = render(<NeoVoice {...props} />);
    fireEvent.click(screen.getByRole('button', { name: 'Start voice input' }));
    await waitFor(() => expect(onError).toHaveBeenCalledWith('Microphone permission denied'));
    voice.recording = true;
    voice.submit.mockResolvedValue({
      kind: 'transcribe-failed',
      message: 'Disconnected.',
      persisted: true,
      dequeued: false,
    });
    view.rerender(<NeoVoice {...props} onPhase={vi.fn()} onSendHandle={vi.fn()} />);
    fireEvent.click(
      screen.getByRole('button', { name: 'Stop recording and keep the text as a draft' })
    );
    await waitFor(() =>
      expect(onError).toHaveBeenCalledWith(
        'Disconnected. Your recording is saved below. You can retry.'
      )
    );
    expect(voice.deleteRecord).not.toHaveBeenCalled();
  });

  it('streams while recording, shows interim text, and takes the streamed final text', async () => {
    voice.enabled = true;
    voice.hub = {};
    voice.start.mockImplementation(async () => {
      voice.recording = true;
    });
    let heard: (text: string) => void = () => {};
    const finish = vi.fn(async (): Promise<string | null> => 'hello neo');
    const close = vi.fn();
    voice.openStream.mockImplementation((_hub: unknown, onText: (text: string) => void) => {
      heard = onText;
      return { push: vi.fn(), finish, close };
    });
    voice.batch.mockResolvedValue({ text: 'batch text' });
    voice.submit.mockImplementation(
      async (_input: unknown, deps: Pick<VoiceSubmitDeps, 'transcribe'>) => {
        const recording = { audioBase64: 'wav', mimeType: 'audio/wav' as const, peakLevel: 1 };
        const first = await deps.transcribe(recording);
        finish.mockResolvedValueOnce(null);
        const second = await deps.transcribe(recording);
        return {
          kind: 'routed',
          outcome: { kind: 'insert', transcript: `${first.text}|${second.text}`, autoSend: false },
          recordId: 'recording',
        };
      }
    );
    const onInterim = vi.fn();
    const onTranscript = vi.fn();
    const props = {
      sessionId: 'neo:club',
      connected: true,
      draftText: '',
      onTranscript,
      onInterim,
      onSendVoice: vi.fn(async () => ({ kind: 'accepted' }) as const),
      onError: vi.fn(),
      onPhase: vi.fn(),
      onSendHandle: vi.fn(),
    };
    const view = render(<NeoVoice {...props} />);
    fireEvent.click(screen.getByRole('button', { name: 'Start voice input' }));
    await waitFor(() =>
      expect(voice.openStream).toHaveBeenCalledWith(voice.hub, expect.any(Function))
    );
    heard('hello ne');
    expect(onInterim).toHaveBeenLastCalledWith('hello ne');
    view.rerender(<NeoVoice {...props} draftText=" " />);
    fireEvent.click(
      screen.getByRole('button', { name: 'Stop recording and keep the text as a draft' })
    );
    await waitFor(() => expect(onTranscript).toHaveBeenCalledWith('hello neo|batch text'));
    expect(voice.batch).toHaveBeenCalledTimes(1);
    await waitFor(() => expect(close).toHaveBeenCalled());
    expect(onInterim).toHaveBeenLastCalledWith('');
  });

  it('keeps the batch path when no stream was opened', async () => {
    voice.recording = true;
    voice.submit.mockResolvedValue({
      kind: 'routed',
      outcome: { kind: 'insert', transcript: 'batch only', autoSend: false },
      recordId: 'recording',
    });
    const onTranscript = vi.fn();
    render(
      <NeoVoice
        sessionId="neo:club"
        connected
        draftText=""
        onTranscript={onTranscript}
        onSendVoice={vi.fn(async () => ({ kind: 'accepted' }) as const)}
        onError={vi.fn()}
        onPhase={vi.fn()}
        onSendHandle={vi.fn()}
      />
    );
    fireEvent.click(
      screen.getByRole('button', { name: 'Stop recording and keep the text as a draft' })
    );
    await waitFor(() => expect(onTranscript).toHaveBeenCalledWith('batch only'));
    expect(voice.submit.mock.calls[0][1]).not.toHaveProperty('transcribe');
  });
});
