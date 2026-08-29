import { effect, signal } from '@preact/signals';
import { connectionManager } from '../connection-manager';
import { connectionState } from '../state';
import {
  deleteVoiceRecord,
  getVoiceRecord,
  listVoiceRecords,
  type VoiceRecordEntry,
} from './voice-audio-store.ts';
import { type VoiceRecording, voiceRecorderStore } from './voice-recorder-store.ts';
import { runVoiceSubmit } from './voice-submit-pipeline.ts';
import { enqueueTranscript, isPermanentAppendRefusal } from './voice-transcript-outbox.ts';

const AUDIO_INTRINSIC_REFUSAL =
  /requires audio\/wav input|Audio data is (required|empty)|must be valid base64|exceeds the 10 MB/;

export function isAudioIntrinsicVoiceRefusal(message: string): boolean {
  return AUDIO_INTRINSIC_REFUSAL.test(message);
}

export function recordingFromEntry(entry: VoiceRecordEntry): VoiceRecording {
  return {
    audioBase64: entry.audioBase64,
    mimeType: entry.mimeType as VoiceRecording['mimeType'],
    hitDurationLimit: entry.hitDurationLimit,
    peakLevel: entry.peakLevel,
  };
}

export const pendingVoiceAudioRecords = signal<VoiceRecordEntry[]>([]);

const busyRecords = new Set<string>();

const FLUSH_DELAY_MS = 500;
const RETRY_DELAY_MS = 5_000;
const MAX_RETRY_DELAY_MS = 60_000;

export function markVoiceAudioBusy(id: string): void {
  busyRecords.add(id);
}

export function unmarkVoiceAudioBusy(id: string): void {
  busyRecords.delete(id);
}

export function isVoiceAudioBusy(id: string): boolean {
  return busyRecords.has(id);
}

let interactiveSubmits = 0;

export function beginInteractiveVoiceSubmit(): void {
  interactiveSubmits += 1;
}

export function endInteractiveVoiceSubmit(): void {
  interactiveSubmits = Math.max(0, interactiveSubmits - 1);
}

function hasInteractiveVoiceActivity(): boolean {
  return (
    interactiveSubmits > 0 ||
    voiceRecorderStore.isRecording.value ||
    voiceRecorderStore.isStarting.value
  );
}

export async function refreshPendingVoiceAudio(): Promise<void> {
  pendingVoiceAudioRecords.value = await listVoiceRecords();
}

let flushInProgress = false;
let retryTimer: ReturnType<typeof setTimeout> | null = null;
let retryDelayMs = RETRY_DELAY_MS;

function clearRetryTimer(): void {
  if (retryTimer) {
    clearTimeout(retryTimer);
    retryTimer = null;
  }
  retryDelayMs = RETRY_DELAY_MS;
}

function scheduleFollowUpFlush(): void {
  if (retryTimer) return;
  retryTimer = setTimeout(() => {
    retryTimer = null;
    void flushPendingVoiceAudio();
  }, retryDelayMs);
  retryDelayMs = Math.min(retryDelayMs * 2, MAX_RETRY_DELAY_MS);
}

export async function flushPendingVoiceAudio(): Promise<void> {
  if (flushInProgress) return;
  const hub = connectionManager.getHubIfConnected();
  if (!hub) return;
  if (hasInteractiveVoiceActivity()) {
    scheduleFollowUpFlush();
    return;
  }
  flushInProgress = true;
  const deferredSessions = new Set<string>();
  let delivered = 0;
  let needsRetry = false;
  const defer = (sessionId: string) => {
    deferredSessions.add(sessionId);
    needsRetry = true;
  };
  const parkTranscript = async (
    entry: VoiceRecordEntry,
    transcript: string,
    error: unknown
  ): Promise<void> => {
    if (!isPermanentAppendRefusal(error)) {
      enqueueTranscript(entry.sessionId, transcript, entry.id);
    }
    await deleteVoiceRecord(entry.id);
  };
  try {
    const pending = (await listVoiceRecords()).filter((entry) => !isVoiceAudioBusy(entry.id));
    if (pending.length === 0) {
      await refreshPendingVoiceAudio();
      return;
    }
    for (const entry of pending) {
      if (!connectionManager.getHubIfConnected()) break;
      if (deferredSessions.has(entry.sessionId)) continue;
      if (hasInteractiveVoiceActivity() || isVoiceAudioBusy(entry.id)) {
        needsRetry = true;
        continue;
      }
      markVoiceAudioBusy(entry.id);
      try {
        const result = await runVoiceSubmit(
          { sessionId: entry.sessionId },
          {
            stopRecording: async () => recordingFromEntry(entry),
            putRecord: async () => true,
            deleteRecord: async () => true,
            generateId: () => entry.id,
            isMounted: () => false,
            currentSessionId: () => entry.sessionId,
          }
        );
        if (result.kind === 'routed') {
          const outcome = result.outcome;
          if (outcome.kind === 'deliver-unmounted') {
            if (!(await getVoiceRecord(entry.id))) continue;
            try {
              await hub.request('session.appendVoiceDraft', {
                sessionId: entry.sessionId,
                text: outcome.transcript,
                dedupId: entry.id,
              });
            } catch (error) {
              await parkTranscript(entry, outcome.transcript, error);
              continue;
            }
            await deleteVoiceRecord(entry.id);
            delivered += 1;
          } else if (outcome.kind === 'discard-with-reason') {
            await deleteVoiceRecord(entry.id);
          } else {
            defer(entry.sessionId);
          }
        } else if (result.kind === 'transcribe-failed') {
          if (!result.dequeued) defer(entry.sessionId);
          else if (isAudioIntrinsicVoiceRefusal(result.message)) {
            await deleteVoiceRecord(entry.id);
          }
        }
      } catch {
        if (!connectionManager.getHubIfConnected()) break;
        defer(entry.sessionId);
      } finally {
        unmarkVoiceAudioBusy(entry.id);
      }
    }
  } finally {
    flushInProgress = false;
    await refreshPendingVoiceAudio();
  }
  if (delivered > 0) retryDelayMs = RETRY_DELAY_MS;
  if (needsRetry && connectionManager.getHubIfConnected()) {
    scheduleFollowUpFlush();
  } else {
    clearRetryTimer();
  }
}

let cleanupAutoFlush: (() => void) | null = null;

export function startVoiceAudioOutboxFlush(): void {
  if (cleanupAutoFlush) return;
  void refreshPendingVoiceAudio();
  cleanupAutoFlush = effect(() => {
    if (connectionState.value === 'connected') {
      setTimeout(() => void flushPendingVoiceAudio(), FLUSH_DELAY_MS);
    }
  });
}

export function stopVoiceAudioOutboxFlush(): void {
  clearRetryTimer();
  if (cleanupAutoFlush) {
    cleanupAutoFlush();
    cleanupAutoFlush = null;
  }
}

if (import.meta.hot) {
  import.meta.hot.dispose(() => {
    if (cleanupAutoFlush) {
      cleanupAutoFlush();
      cleanupAutoFlush = null;
    }
    clearRetryTimer();
  });
}

export function resetVoiceAudioOutbox(): void {
  flushInProgress = false;
  clearRetryTimer();
  busyRecords.clear();
  interactiveSubmits = 0;
  pendingVoiceAudioRecords.value = [];
}
