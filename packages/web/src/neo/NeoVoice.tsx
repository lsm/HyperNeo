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
  type VoiceSendOutcome,
} from '../lib/voice/voice-audio-outbox.ts';
import { VoiceWaveform } from '../components/voice/VoiceWaveform.tsx';
import { PendingVoiceAudioTray } from '../components/voice/PendingVoiceAudioTray.tsx';
import { Button } from '../components/ui/Button.tsx';
import { NeoIcon } from './NeoIcon.tsx';
import { useNeoVoiceSettings } from './useNeoVoiceSettings.ts';

export type VoicePhase = 'idle' | 'recording' | 'working' | 'sending' | 'drafting';

export function NeoVoice({
  sessionId,
  connected,
  draftText,
  onTranscript,
  onSendVoice,
  onSendHandle,
  onError,
  onPhase,
}: {
  sessionId: string;
  connected: boolean;
  draftText: string;
  onTranscript: (text: string) => void;
  onSendVoice: (text: string, recordId: string) => Promise<VoiceSendOutcome>;
  onSendHandle: (finish: ((intent: 'draft' | 'send') => void) | null) => void;
  onError: (message: string) => void;
  onPhase: (phase: VoicePhase) => void;
}) {
  const enabled = useNeoVoiceSettings();
  const [transcribing, setTranscribing] = useState<string | null>(null);
  const [transcribeIntent, setTranscribeIntent] = useState<'draft' | 'send'>('draft');
  const running = useRef(false);
  const mounted = useRef(true);
  const recorder = useVoiceRecorder(sessionId, { autoAdopt: false });
  const latest = useRef(recorder);
  latest.current = recorder;
  const active =
    recorder.isRecording || recorder.isStarting || recorder.durationLimitHit || !!transcribing;
  const phase: VoicePhase = recorder.isRecording
    ? 'recording'
    : transcribing
      ? transcribeIntent === 'send'
        ? 'sending'
        : 'drafting'
      : active
        ? 'working'
        : 'idle';
  const records = pendingVoiceAudioRecords.value.filter((entry) => entry.sessionId === sessionId);
  const finishFromComposer = useRef<(intent: 'draft' | 'send') => void>(() => {});
  useEffect(() => {
    void refreshPendingVoiceAudio();
  }, []);
  useEffect(() => {
    onPhase(phase);
  }, [phase, onPhase]);
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

  async function deliverSendIntent(recordId: string, text: string) {
    const outcome = await onSendVoice(text, recordId);
    if (outcome.kind === 'refused') onError(outcome.reason);
    else if (outcome.kind === 'unconfirmed') {
      onError('Could not send that recording. It is saved below so you can retry.');
      return;
    }
    await deleteVoiceRecord(recordId);
  }

  async function transcribe(intent: 'draft' | 'send' = 'draft', entry?: VoiceRecordEntry) {
    if (running.current || (entry && isVoiceAudioBusy(entry.id))) return;
    running.current = true;
    const id = entry?.id ?? generateUUID();
    setTranscribing(id);
    setTranscribeIntent(intent);
    markVoiceAudioBusy(id);
    beginInteractiveVoiceSubmit();
    try {
      if (intent === 'send' && entry?.sendText) {
        await deliverSendIntent(entry.id, entry.sendText);
        return;
      }
      const result = await runVoiceSubmit(
        { sessionId, mode: 'stay', retrySilent: !!entry, intent, sendDraft: draftText },
        {
          stopRecording: entry ? async () => recordingFromEntry(entry) : recorder.stop,
          generateId: () => id,
          isMounted: () => mounted.current,
          currentSessionId: () => sessionId,
        }
      );
      if (result.kind === 'routed') {
        if ('transcript' in result.outcome) {
          if (intent === 'send') {
            await deliverSendIntent(result.recordId, result.outcome.transcript);
          } else {
            onTranscript(result.outcome.transcript);
            await deleteVoiceRecord(result.recordId);
          }
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
    if (recorder.durationLimitHit) void transcribe('draft');
  }, [recorder.durationLimitHit]);

  finishFromComposer.current = (intent) => {
    void transcribe(intent);
  };
  useEffect(() => {
    onSendHandle((intent) => finishFromComposer.current(intent));
    return () => onSendHandle(null);
  }, [onSendHandle]);

  if (!enabled && !active && !records.length) return null;
  return (
    <>
      {records.length > 0 && (
        <div class="absolute bottom-full left-0 right-0 mb-2">
          <PendingVoiceAudioTray
            records={records}
            resendingId={transcribing}
            isBusy={(id) => !connected || active || isVoiceAudioBusy(id)}
            onResend={(entry) => void transcribe(entry.intent ?? 'draft', entry)}
            onDelete={(entry) => {
              void deleteVoiceRecord(entry.id).then(refreshPendingVoiceAudio);
            }}
          />
        </div>
      )}
      {active ? (
        <div class="flex min-w-0 flex-1 items-center gap-2">
          <div class="min-w-0 flex-1">
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
            variant="danger"
            disabled={!!transcribing || recorder.isStarting}
            onClick={() => void transcribe('draft')}
            aria-label="Stop recording and keep the text as a draft"
            title="Stop — transcribe into an editable draft, never send"
          >
            <NeoIcon name="stop" />
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
