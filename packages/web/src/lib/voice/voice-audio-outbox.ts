import { effect, signal } from '@preact/signals';
import { connectionManager } from '../connection-manager';
import { connectionState } from '../state';
import { deleteVoiceRecord, listVoiceRecords, type VoiceRecordEntry } from './voice-audio-store.ts';
import type { VoiceRecording } from './voice-recorder-store.ts';
import {
  requestVoiceTranscription,
  VOICE_SUBMIT_SILENCE_PEAK_LEVEL,
} from './voice-submit-pipeline.ts';
import { classifyVoiceSubmitError, routeVoiceOutcome } from './voice-submit-routing.ts';
import { isPermanentAppendRefusal } from './voice-transcript-outbox.ts';

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

function isFlushable(entry: VoiceRecordEntry): boolean {
  return !isVoiceAudioBusy(entry.id) && entry.peakLevel >= VOICE_SUBMIT_SILENCE_PEAK_LEVEL;
}

export async function flushPendingVoiceAudio(): Promise<void> {
  if (flushInProgress) return;
  const hub = connectionManager.getHubIfConnected();
  if (!hub) return;
  const flushable = (await listVoiceRecords()).filter(isFlushable);
  if (flushable.length === 0) {
    await refreshPendingVoiceAudio();
    return;
  }

  flushInProgress = true;
  let delivered = 0;
  try {
    for (const entry of flushable) {
      if (!connectionManager.getHubIfConnected()) break;
      try {
        const result = await requestVoiceTranscription(recordingFromEntry(entry));
        const outcome = routeVoiceOutcome({
          transcript: result.text?.trim() ?? '',
          mounted: false,
          sessionChanged: false,
          mode: 'stay',
        });
        if (outcome.kind === 'deliver-unmounted') {
          await hub.request('session.appendVoiceDraft', {
            sessionId: entry.sessionId,
            text: outcome.transcript,
            dedupId: entry.id,
          });
          await deleteVoiceRecord(entry.id);
          delivered += 1;
        } else if (outcome.kind === 'discard-with-reason') {
          await deleteVoiceRecord(entry.id);
        }
      } catch (error) {
        if (!connectionManager.getHubIfConnected()) break;
        if (
          isPermanentAppendRefusal(error) ||
          classifyVoiceSubmitError(error, 'transcribe') === 'discard'
        ) {
          await deleteVoiceRecord(entry.id);
        }
      }
    }
  } finally {
    flushInProgress = false;
    await refreshPendingVoiceAudio();
  }
  if (delivered > 0) retryDelayMs = RETRY_DELAY_MS;
  if ((await listVoiceRecords()).some(isFlushable) && connectionManager.getHubIfConnected()) {
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
  pendingVoiceAudioRecords.value = [];
}
