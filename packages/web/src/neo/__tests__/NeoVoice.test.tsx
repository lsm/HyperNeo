import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/preact';
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
}));
vi.mock('../useNeoVoiceSettings.ts', () => ({ useNeoVoiceSettings: () => voice.enabled }));
vi.mock('../../hooks/useVoiceRecorder.ts', () => ({
  isVoiceRecordingSupported: () => true,
  useVoiceRecorder: () => ({
    isRecording: voice.recording,
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
  VOICE_SUBMIT_SILENCE_PEAK_LEVEL: 0.001,
}));
vi.mock('../../lib/voice/voice-audio-store.ts', () => ({ deleteVoiceRecord: voice.deleteRecord }));
vi.mock('../../lib/voice/voice-audio-outbox.ts', () => ({
  pendingVoiceAudioRecords: signal([]),
  refreshPendingVoiceAudio: vi.fn(),
  beginInteractiveVoiceSubmit: vi.fn(),
  endInteractiveVoiceSubmit: vi.fn(),
  markVoiceAudioBusy: vi.fn(),
  unmarkVoiceAudioBusy: vi.fn(),
  isVoiceAudioBusy: () => false,
  recordingFromEntry: vi.fn(),
}));
vi.mock('../../components/voice/VoiceWaveform.tsx', () => ({
  VoiceWaveform: ({ onCancel }: { onCancel: () => void }) => (
    <button type="button" onClick={onCancel}>
      Cancel recording
    </button>
  ),
}));
beforeEach(() => {
  vi.clearAllMocks();
  voice.enabled = false;
  voice.recording = false;
  voice.starting = false;
});
afterEach(cleanup);

describe('Neo voice', () => {
  it('only offers the microphone when configured and disables it offline', () => {
    const props = {
      sessionId: 'neo:root',
      connected: true,
      onTranscript: vi.fn(),
      onError: vi.fn(),
      onBusy: vi.fn(),
    };
    const view = render(<NeoVoice {...props} />);
    expect(screen.queryByRole('button', { name: 'Start voice input' })).toBeNull();
    voice.enabled = true;
    view.rerender(<NeoVoice {...props} onBusy={vi.fn()} />);
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
        onTranscript={onTranscript}
        onError={vi.fn()}
        onBusy={vi.fn()}
      />
    );
    fireEvent.click(screen.getByRole('button', { name: 'Finish voice input' }));
    await waitFor(() => expect(onTranscript).toHaveBeenCalledWith('Remember Sunday'));
    expect(voice.submit).toHaveBeenCalledWith(
      { sessionId: 'neo:club', mode: 'stay', retrySilent: false },
      expect.objectContaining({ stopRecording: voice.stop })
    );
    expect(voice.deleteRecord).toHaveBeenCalledWith('recording');
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
        onTranscript={originalDraft}
        onError={vi.fn()}
        onBusy={vi.fn()}
      />
    );
    fireEvent.click(screen.getByRole('button', { name: 'Finish voice input' }));
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
      onTranscript: vi.fn(),
      onError,
      onBusy: vi.fn(),
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
    view.rerender(<NeoVoice {...props} onBusy={vi.fn()} />);
    fireEvent.click(screen.getByRole('button', { name: 'Finish voice input' }));
    await waitFor(() =>
      expect(onError).toHaveBeenCalledWith(
        'Disconnected. Your recording is saved below. You can retry.'
      )
    );
    expect(voice.deleteRecord).not.toHaveBeenCalled();
  });
});
