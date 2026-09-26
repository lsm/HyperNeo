import { generateUUID } from '@hyperneo/shared';
import { useEffect, useLayoutEffect, useRef, useState } from 'preact/hooks';
import { useVoiceRecorder, isVoiceRecordingSupported } from '../hooks/useVoiceRecorder.ts';
import { runVoiceSubmit } from '../lib/voice/voice-submit-pipeline.ts';
import { deleteVoiceRecord, type VoiceRecordEntry } from '../lib/voice/voice-audio-store.ts';
import {
  beginInteractiveVoiceSubmit,
  endInteractiveVoiceSubmit,
  markVoiceAudioBusy,
  unmarkVoiceAudioBusy,
  isVoiceAudioBusy,
  pendingVoiceAudioRecords,
  recordingFromEntry,
  refreshPendingVoiceAudio,
} from '../lib/voice/voice-audio-outbox.ts';
import { VoiceWaveform } from '../components/voice/VoiceWaveform.tsx';
import { PendingVoiceAudioTray } from '../components/voice/PendingVoiceAudioTray.tsx';
import { Button } from '../components/ui/Button.tsx';
import { NeoIcon } from './NeoIcon.tsx';
import { useNeoVoiceSettings } from './useNeoVoiceSettings.ts';

export function NeoVoice({
  sessionId,
  connected,
  onTranscript,
  onError,
  onBusy,
}: {
  sessionId: string;
  connected: boolean;
  onTranscript: (text: string) => void;
  onError: (message: string) => void;
  onBusy: (busy: boolean) => void;
}) {
  const enabled = useNeoVoiceSettings();
  const [transcribing, setTranscribing] = useState<string | null>(null);
  const running = useRef(false);
  const mounted = useRef(true);
  const recorder = useVoiceRecorder(sessionId, { autoAdopt: false });
  const latest = useRef(recorder);
  latest.current = recorder;
  const active =
    recorder.isRecording || recorder.isStarting || recorder.durationLimitHit || !!transcribing;
  const records = pendingVoiceAudioRecords.value.filter((entry) => entry.sessionId === sessionId);
  useEffect(() => {
    void refreshPendingVoiceAudio();
  }, []);
  useEffect(() => {
    onBusy(active);
  }, [active, onBusy]);
  useLayoutEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      void latest.current.cancel();
    };
  }, []);

  async function start() {
    try {
      await recorder.start();
    } catch (error) {
      onError(error instanceof Error ? error.message : 'Could not open the microphone.');
    }
  }

  async function transcribe(entry?: VoiceRecordEntry) {
    if (running.current || (entry && isVoiceAudioBusy(entry.id))) return;
    running.current = true;
    const id = entry?.id ?? generateUUID();
    setTranscribing(id);
    markVoiceAudioBusy(id);
    beginInteractiveVoiceSubmit();
    try {
      const result = await runVoiceSubmit(
        { sessionId, mode: 'stay', retrySilent: !!entry },
        {
          stopRecording: entry ? async () => recordingFromEntry(entry) : recorder.stop,
          generateId: () => id,
          isMounted: () => mounted.current,
          currentSessionId: () => sessionId,
        }
      );
      if (result.kind === 'routed') {
        if ('transcript' in result.outcome) {
          onTranscript(result.outcome.transcript);
          await deleteVoiceRecord(result.recordId);
        } else if (result.outcome.reason) onError(result.outcome.reason);
      } else if (result.kind === 'silent-recording')
        onError('I didn’t hear anything. Try speaking closer to the microphone.');
      else
        onError(
          `${result.message}${result.persisted && !result.dequeued ? ' Your recording is saved below. You can retry.' : ''}`
        );
    } catch (error) {
      onError(error instanceof Error ? error.message : 'Could not transcribe the recording.');
    } finally {
      running.current = false;
      endInteractiveVoiceSubmit();
      unmarkVoiceAudioBusy(id);
      if (mounted.current) setTranscribing(null);
      void refreshPendingVoiceAudio();
    }
  }

  useEffect(() => {
    if (recorder.durationLimitHit) void transcribe();
  }, [recorder.durationLimitHit]);

  if (!enabled && !active && !records.length) return null;
  return (
    <>
      {records.length > 0 && (
        <div class="absolute bottom-full left-0 right-0 mb-2">
          <PendingVoiceAudioTray
            records={records}
            resendingId={transcribing}
            isBusy={(id) => !connected || active || isVoiceAudioBusy(id)}
            onResend={(entry) => void transcribe(entry)}
            onDelete={(entry) => {
              void deleteVoiceRecord(entry.id).then(refreshPendingVoiceAudio);
            }}
          />
        </div>
      )}
      {active ? (
        <div class="flex min-w-0 items-center gap-2">
          <div class="absolute inset-x-4 top-4 rounded-xl bg-surface-raised">
            <VoiceWaveform
              getLevel={recorder.getLevel}
              isRecording={recorder.isRecording}
              isStarting={recorder.isStarting}
              isTranscribing={!!transcribing}
              startedAt={recorder.recordingStartedAt}
              onCancel={() => {
                if (!running.current) void recorder.cancel();
              }}
            />
          </div>
          <Button
            size="sm"
            variant="ghost"
            disabled={!!transcribing || recorder.isStarting}
            onClick={() => void transcribe()}
            aria-label="Finish voice input"
          >
            <NeoIcon name="check" class="text-cat-teal" />
          </Button>
        </div>
      ) : (
        enabled && (
          <Button
            size="sm"
            variant="ghost"
            disabled={!connected || !isVoiceRecordingSupported()}
            title={
              isVoiceRecordingSupported() ? 'Dictate a draft' : 'Voice needs HTTPS or localhost'
            }
            onClick={() => void start()}
            aria-label="Start voice input"
          >
            <NeoIcon name="mic" />
          </Button>
        )
      )}
    </>
  );
}
