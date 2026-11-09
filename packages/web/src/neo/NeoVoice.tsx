import { generateUUID } from '@hyperneo/shared';
import type { NeoPreviewReference } from '@hyperneo/shared/types/neo-preview-context';
import { useEffect, useLayoutEffect, useRef, useState } from 'preact/hooks';
import { useVoiceRecorder, isVoiceRecordingSupported } from '../hooks/useVoiceRecorder.ts';
import { requestVoiceTranscription, runVoiceSubmit } from '../lib/voice/voice-submit-pipeline.ts';
import { openVoiceStream, type VoiceLiveStream } from '../lib/voice/voice-stream.ts';
import { voiceRecorderStore } from '../lib/voice/voice-recorder-store.ts';
import { connectionManager } from '../lib/connection-manager.ts';
import {
  deleteVoiceRecord,
  putVoiceRecord,
  type VoiceRecordEntry,
} from '../lib/voice/voice-audio-store.ts';
import {
  beginInteractiveVoiceSubmit,
  endInteractiveVoiceSubmit,
  markVoiceAudioBusy,
  unmarkVoiceAudioBusy,
  isVoiceAudioBusy,
  pendingVoiceAudioRecords,
  recordingFromEntry,
  queuePendingVoiceSend,
  refreshPendingVoiceAudio,
  type VoiceSendOutcome,
} from '../lib/voice/voice-audio-outbox.ts';
import { VoiceWaveform } from '../components/voice/VoiceWaveform.tsx';
import { Spinner } from '../components/ui/Spinner.tsx';
import { PendingVoiceAudioTray } from '../components/voice/PendingVoiceAudioTray.tsx';
import { Button } from '../components/ui/Button.tsx';
import { NeoIcon } from './NeoIcon.tsx';
import { useNeoVoiceSettings } from './useNeoVoiceSettings.ts';

export type VoicePhase = 'idle' | 'recording' | 'working' | 'sending' | 'drafting';
type VoiceSendSnapshot = Pick<VoiceRecordEntry, 'sendDraft' | 'sendContext' | 'previewContext'>;

export function NeoVoice({
  sessionId,
  connected,
  draftText,
  onTranscript,
  onInterim,
  onSendVoice,
  onPrepareSend,
  onSendHandle,
  onError,
  onPhase,
  door,
  previewContext,
  onPreviewCapture,
}: {
  previewContext?: NeoPreviewReference;
  onPreviewCapture?: () => void;
  door?: 'session';
  sessionId: string;
  connected: boolean;
  draftText: string;
  onTranscript: (text: string) => void;
  onInterim?: (text: string) => void;
  onPrepareSend?: () => VoiceSendSnapshot;
  onSendVoice: (text: string, recordId: string) => Promise<VoiceSendOutcome>;
  onSendHandle: (finish: ((intent: 'draft' | 'send') => void) | null) => void;
  onError: (message: string) => void;
  onPhase: (phase: VoicePhase) => void;
}) {
  const enabled = useNeoVoiceSettings();
  const [transcribing, setTranscribing] = useState<string | null>(null);
  const [delivering, setDelivering] = useState(false);
  const [transcribeIntent, setTranscribeIntent] = useState<'draft' | 'send'>('draft');
  const [streamFormat, setStreamFormat] = useState<'opus' | 'pcm16' | 'batch' | null>(null);
  const running = useRef(false);
  const delivery = useRef({ onSendVoice, onPrepareSend });
  delivery.current = { onSendVoice, onPrepareSend };
  const pending = useRef<{
    id: string;
    intent: 'draft' | 'send';
    persisted: Promise<void>;
    upgrade?: Promise<boolean>;
    cancelled: boolean;
    delivering: boolean;
    live: VoiceLiveStream | null;
  } | null>(null);
  const mounted = useRef(true);
  const recorder = useVoiceRecorder(sessionId, { autoAdopt: false });
  const latest = useRef(recorder);
  latest.current = recorder;
  const liveStream = useRef<VoiceLiveStream | null>(null);
  const interim = useRef(onInterim);
  const recordingDraft = useRef<VoiceSendSnapshot | null>(null);
  const captureDraft = (): VoiceSendSnapshot => ({
    sendDraft: draftText,
    ...(previewContext && door !== 'session' ? { previewContext: { ...previewContext } } : {}),
  });
  interim.current = onInterim;
  function takeLiveStream(): VoiceLiveStream | null {
    const live = liveStream.current;
    liveStream.current = null;
    return live;
  }
  function dropLiveStream() {
    takeLiveStream()?.close();
    interim.current?.('');
  }
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
      dropLiveStream();
      void latest.current.cancel();
    };
  }, []);

  async function start() {
    setStreamFormat(null);
    recordingDraft.current = captureDraft();
    onPreviewCapture?.();
    try {
      await recorder.start();
      const hub = connectionManager.getHubIfConnected();
      if (!hub || !latest.current.isRecording) return;
      dropLiveStream();
      const live = openVoiceStream(hub, (text) => interim.current?.(text), {
        onFormat: (format) => {
          if (mounted.current) setStreamFormat(format);
        },
        onError: (error) => {
          if (mounted.current)
            onError(
              `Live transcription failed: ${error.message}. The recording will use batch transcription.`
            );
        },
      });
      liveStream.current = live;
      voiceRecorderStore.setPcmTap(live.push);
    } catch (error) {
      onError(error instanceof Error ? error.message : 'Could not open the microphone.');
    }
  }

  async function deliverSendIntent(task: { delivering: boolean }, recordId: string, text: string) {
    task.delivering = true;
    if (mounted.current) setDelivering(true);
    const outcome = await delivery.current.onSendVoice(text, recordId);
    if (outcome.kind === 'refused') {
      onError(outcome.reason);
      if (outcome.retained) return;
    } else if (outcome.kind === 'unconfirmed') {
      onError('Could not send that recording. It is saved below so you can retry.');
      return;
    }
    await deleteVoiceRecord(recordId);
  }

  async function transcribe(intent: 'draft' | 'send' = 'draft', entry?: VoiceRecordEntry) {
    if (running.current || (entry && isVoiceAudioBusy(entry.id))) return;
    running.current = true;
    const id = entry?.id ?? generateUUID();
    const live = entry ? null : takeLiveStream();
    let persisted: () => void = () => {};
    const task = {
      id,
      intent,
      live,
      cancelled: false,
      delivering: false,
      persisted: new Promise<void>((resolve) => {
        persisted = resolve;
      }),
      upgrade: undefined as Promise<boolean> | undefined,
    };
    pending.current = task;
    setTranscribing(id);
    setTranscribeIntent(intent);
    markVoiceAudioBusy(id);
    beginInteractiveVoiceSubmit();
    const captured: VoiceSendSnapshot =
      entry ??
      (intent === 'send'
        ? (delivery.current.onPrepareSend?.() ?? recordingDraft.current ?? captureDraft())
        : (recordingDraft.current ?? captureDraft()));
    try {
      if (intent === 'send' && entry?.sendText) {
        await deliverSendIntent(task, entry.id, entry.sendText);
        return;
      }
      const result = await runVoiceSubmit(
        {
          sessionId,
          mode: 'stay',
          retrySilent: !!entry,
          intent,
          sendDraft: captured.sendDraft ?? '',
          ...(captured.sendContext ? { sendContext: captured.sendContext } : {}),
          door,
          ...(captured.previewContext ? { previewContext: captured.previewContext } : {}),
        },
        {
          putRecord: async (record) => {
            try {
              return await putVoiceRecord(record);
            } finally {
              persisted();
            }
          },
          stopRecording: entry ? async () => recordingFromEntry(entry) : recorder.stop,
          transcribe: async (recording) => {
            if (task.cancelled) return { text: '' };
            try {
              const text = live ? await live.finish() : null;
              if (task.cancelled) return { text: '' };
              const result =
                text === null ? await requestVoiceTranscription(recording, id) : { text };
              return task.cancelled ? { text: '' } : result;
            } catch (error) {
              if (task.cancelled) return { text: '' };
              throw error;
            }
          },
          generateId: () => id,
          isMounted: () => mounted.current,
          currentSessionId: () => sessionId,
        }
      );
      if (task.cancelled) return;
      if (result.kind === 'routed') {
        if ('transcript' in result.outcome) {
          const upgraded = task.upgrade ? await task.upgrade : true;
          if (task.cancelled) return;
          if (!upgraded) {
            onError('Could not save the send request. Your recording is kept so you can retry.');
            return;
          }
          if (task.intent === 'send') {
            await deliverSendIntent(task, result.recordId, result.outcome.transcript);
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
      if (!task.cancelled)
        onError(error instanceof Error ? error.message : 'Could not transcribe the recording.');
    } finally {
      live?.close();
      persisted();
      if (!task.cancelled) {
        if (pending.current === task) {
          pending.current = null;
          running.current = false;
          if (live) interim.current?.('');
          if (mounted.current) {
            setTranscribing(null);
            setDelivering(false);
          }
        }
        endInteractiveVoiceSubmit();
        unmarkVoiceAudioBusy(id);
      }
      void refreshPendingVoiceAudio();
    }
  }

  async function cancel() {
    const task = pending.current;
    if (!task) {
      dropLiveStream();
      await recorder.cancel();
      return;
    }
    if (task.cancelled || task.delivering) return;
    task.cancelled = true;
    const closing = task.live?.close();
    interim.current?.('');
    try {
      await task.persisted;
      if (task.upgrade) await task.upgrade;
      await deleteVoiceRecord(task.id);
      try {
        await closing;
        const hub = connectionManager.getHubIfConnected();
        if (hub) await hub.request('voice.transcribe.cancel', { transcriptionId: task.id });
      } catch (error) {
        if (mounted.current)
          onError(error instanceof Error ? error.message : 'Could not stop server transcription.');
      }
    } finally {
      if (pending.current === task) {
        pending.current = null;
        running.current = false;
        if (mounted.current) {
          setTranscribing(null);
          setDelivering(false);
        }
      }
      endInteractiveVoiceSubmit();
      unmarkVoiceAudioBusy(task.id);
      void refreshPendingVoiceAudio();
    }
  }

  useEffect(() => {
    if (recorder.durationLimitHit) void transcribe('draft');
  }, [recorder.durationLimitHit]);

  finishFromComposer.current = (intent) => {
    const task = pending.current;
    if (task?.cancelled) return;
    if (task && intent === 'send') {
      if (task.intent === 'send') return;
      task.intent = 'send';
      setTranscribeIntent('send');
      const snapshot = delivery.current.onPrepareSend?.() ?? captureDraft();
      task.upgrade = task.persisted
        .then(() => queuePendingVoiceSend(task.id, snapshot))
        .catch(() => false);
      return;
    }
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
              appearance="neo"
              canCancel={!delivering}
              getLevel={recorder.getLevel}
              isRecording={recorder.isRecording}
              isStarting={recorder.isStarting}
              isTranscribing={!!transcribing}
              startedAt={recorder.recordingStartedAt}
              onCancel={() => void cancel()}
            />
          </div>
          {recorder.isRecording && streamFormat && streamFormat !== 'opus' && (
            <span
              role="status"
              class="shrink-0 text-xs text-fg-muted"
              title={
                streamFormat === 'pcm16'
                  ? 'Opus unavailable; using PCM16'
                  : 'Using batch transcription'
              }
            >
              {streamFormat === 'pcm16' ? 'PCM16' : 'Batch'}
            </span>
          )}
          <button
            type="button"
            class={`neo-composer-turn-control group grid h-11 w-11 shrink-0 place-items-center focus-visible:outline-none ${
              transcribing && transcribeIntent === 'send' ? 'opacity-50' : ''
            }`}
            disabled={!!transcribing || recorder.isStarting}
            aria-busy={!!transcribing && transcribeIntent === 'draft'}
            onClick={() => void transcribe('draft')}
            aria-label="Stop recording and keep the text as a draft"
            title="Stop — transcribe into an editable draft, never send"
          >
            <span class="grid h-8 w-10 place-items-center rounded-control bg-danger text-recording-control-fg transition group-focus-visible:ring-2 group-focus-visible:ring-accent group-focus-visible:ring-offset-2 group-focus-visible:ring-offset-bg">
              {transcribing && transcribeIntent === 'draft' ? (
                <Spinner size="sm" color="border-current" />
              ) : (
                <NeoIcon name="stop" class="!h-3.5 !w-3.5" />
              )}
            </span>
          </button>
        </div>
      ) : (
        enabled && (
          <Button
            size="sm"
            class="h-11 w-11 min-w-11 shrink-0 px-0 !rounded-full"
            variant="ghost"
            disabled={!connected || !isVoiceRecordingSupported()}
            title={
              isVoiceRecordingSupported() ? 'Dictate a draft' : 'Voice needs HTTPS or localhost'
            }
            onClick={() => void start()}
            aria-label="Start voice input"
          >
            <NeoIcon name="mic" class="!h-6 !w-6" />
          </Button>
        )
      )}
    </>
  );
}
