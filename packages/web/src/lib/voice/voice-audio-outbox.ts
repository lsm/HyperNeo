import { type MessageHub, MessageHubResponseError } from '@hyperneo/shared';
import superpipe, { type PipelineAPI } from 'superpipe';
import { effect, signal } from '@preact/signals';
import { connectionManager } from '../connection-manager';
import { NEO_UNCONFIRMED_RECEIPT, submitNeoDraft } from '../../neo/neo-intake.ts';
import { connectionState } from '../state';
import { invokeOperation } from '../operations.ts';
import { t } from '../i18n/index.ts';
import {
  deleteVoiceRecord,
  getVoiceRecord,
  listVoiceRecords,
  putVoiceRecord,
  type VoiceRecordEntry,
} from './voice-audio-store.ts';
import { type VoiceRecording, voiceRecorderStore } from './voice-recorder-store.ts';
import { runVoiceSubmit } from './voice-submit-pipeline.ts';
import {
  enqueueTranscript,
  isPermanentAppendRefusal,
  removePendingTranscript,
} from './voice-transcript-outbox.ts';

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

export type VoiceSendOutcome =
  | { kind: 'accepted' }
  | { kind: 'refused'; reason: string; retained?: boolean }
  | { kind: 'unconfirmed' };

export function combineVoiceSubmission(draft: string, transcript: string, suffix = ''): string {
  const text = [draft.trim(), transcript].filter(Boolean).join('\n');
  return [text, suffix].filter(Boolean).join('\n\n');
}

export const queuePendingVoiceSend = (superpipe({})('voice.queue-pending-send') as PipelineAPI)
  .input(['id', 'snapshot'])
  .pipe(
    async (id: string) => {
      const record = await getVoiceRecord(id);
      return record && record.intent !== 'send' && record.sendText === undefined
        ? { value: record }
        : { reason: false };
    },
    'id',
    'result:stored'
  )
  .pipe(
    (record: VoiceRecordEntry, snapshot: Partial<VoiceRecordEntry>) => ({
      ...record,
      ...snapshot,
      intent: 'send' as const,
    }),
    ['stored', 'snapshot'],
    'record'
  )
  .pipe(putVoiceRecord, 'record', 'stored')
  .endAsync('stored') as (id: string, snapshot: Partial<VoiceRecordEntry>) => Promise<boolean>;

async function sendSessionVoice(
  hub: MessageHub,
  sessionId: string,
  text: string,
  record: VoiceRecordEntry
): Promise<{ ok: true } | { ok: false; reason: string }> {
  try {
    const images = record.sendContext?.images ?? [];
    const receipt = await invokeOperation<{ kind: string; messageId?: string; reason?: string }>(
      hub,
      'message.send',
      {
        sessionId,
        idempotencyKey: `voice:${record.id}`,
        message: {
          type: 'user',
          inputKind: 'human',
          parent_tool_use_id: null,
          message: {
            role: 'user',
            content: images.length
              ? [
                  { type: 'text', text },
                  ...images.map((image) => ({
                    type: 'image',
                    source: { type: 'base64', data: image.data, media_type: image.media_type },
                  })),
                ]
              : text,
          },
        },
      }
    );
    return receipt?.kind === 'accepted' &&
      typeof receipt.messageId === 'string' &&
      receipt.messageId
      ? { ok: true }
      : { ok: false, reason: receipt?.reason ?? t('session.voiceUnconfirmed') };
  } catch (cause) {
    return {
      ok: false,
      reason:
        cause instanceof MessageHubResponseError ? cause.message : t('session.voiceUnconfirmed'),
    };
  }
}

export async function submitVoiceSendIntent(
  hub: MessageHub,
  record: VoiceRecordEntry,
  text: string
): Promise<VoiceSendOutcome> {
  record = {
    ...record,
    ...(record.previewContext ? { previewContext: { ...record.previewContext } } : {}),
  };
  if (!text.trim()) return { kind: 'unconfirmed' };
  const settled = record.sendText ?? text;
  if (record.sendText !== undefined && record.sendText !== text)
    return refuseVoiceSend(
      record,
      settled,
      'That recording already has a different message queued.'
    );
  const stored = await putVoiceRecord({ ...record, sendText: settled });
  if (!stored) return { kind: 'unconfirmed' };
  let receipt: { ok: true } | { ok: false; reason: string };
  try {
    receipt =
      record.door !== 'session'
        ? await submitNeoDraft(
            {
              sessionId: record.sessionId,
              requestId: record.id,
              text: settled,
              ...(record.sendContext?.images ? { images: record.sendContext.images } : {}),
              ...(record.sendContext?.quote ? { quote: record.sendContext.quote } : {}),
              ...(record.previewContext ? { previewContext: record.previewContext } : {}),
            },
            async () => hub
          )
        : await sendSessionVoice(hub, record.sessionId, settled, record);
  } catch {
    return { kind: 'unconfirmed' };
  }
  if (receipt.ok) return { kind: 'accepted' };
  if (receipt.reason === NEO_UNCONFIRMED_RECEIPT) return { kind: 'unconfirmed' };
  return refuseVoiceSend(record, settled, receipt.reason);
}

async function refuseVoiceSend(
  record: VoiceRecordEntry,
  text: string,
  reason: string
): Promise<VoiceSendOutcome> {
  if (record.previewContext || record.sendContext) {
    const retained = await putVoiceRecord({ ...record, sendText: text, sendRefusal: reason });
    return retained ? { kind: 'refused', reason, retained: true } : { kind: 'unconfirmed' };
  }
  if (!enqueueTranscript(record.sessionId, text, record.id)) {
    removePendingTranscript(record.id);
    return { kind: 'unconfirmed' };
  }
  return { kind: 'refused', reason };
}

type VoiceSendCompletion = 'sent' | 'parked' | 'discarded' | 'retry' | 'held';

async function completeSendIntent(
  hub: MessageHub,
  entry: VoiceRecordEntry
): Promise<VoiceSendCompletion> {
  let text = entry.sendText;
  if (text === undefined) {
    let result: Awaited<ReturnType<typeof runVoiceSubmit>>;
    try {
      result = await runVoiceSubmit(
        { sessionId: entry.sessionId, intent: 'send' },
        {
          stopRecording: async () => recordingFromEntry(entry),
          putRecord: async () => true,
          deleteRecord: async () => true,
          generateId: () => entry.id,
          isMounted: () => false,
          currentSessionId: () => entry.sessionId,
        }
      );
    } catch {
      return 'retry';
    }
    if (result.kind === 'silent-recording') return 'discarded';
    if (result.kind === 'transcribe-failed') return result.dequeued ? 'discarded' : 'retry';
    if (!('transcript' in result.outcome)) return 'discarded';
    text = combineVoiceSubmission(
      entry.sendDraft ?? '',
      result.outcome.transcript,
      entry.sendContext?.suffix
    );
  }
  if (!text.trim()) return 'discarded';
  const outcome = await submitVoiceSendIntent(hub, entry, text);
  if (outcome.kind === 'accepted') return 'sent';
  if (outcome.kind === 'refused') return outcome.retained ? 'held' : 'parked';
  return 'retry';
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
    if (isPermanentAppendRefusal(error)) {
      await deleteVoiceRecord(entry.id);
      return;
    }
    if (enqueueTranscript(entry.sessionId, transcript, entry.id)) {
      await deleteVoiceRecord(entry.id);
    } else {
      removePendingTranscript(entry.id);
      defer(entry.sessionId);
    }
  };
  try {
    const pending = (await listVoiceRecords()).filter((entry) => !isVoiceAudioBusy(entry.id));
    if (pending.length === 0) {
      await refreshPendingVoiceAudio();
      return;
    }
    for (const entry of pending) {
      if (!connectionManager.getHubIfConnected()) break;
      if (entry.sendRefusal !== undefined) continue;
      if (deferredSessions.has(entry.sessionId)) continue;
      if (hasInteractiveVoiceActivity() || isVoiceAudioBusy(entry.id)) {
        needsRetry = true;
        continue;
      }
      markVoiceAudioBusy(entry.id);
      try {
        if (entry.intent === 'send') {
          const completion = await completeSendIntent(hub, entry);
          if (completion === 'held') continue;
          if (completion === 'retry') {
            defer(entry.sessionId);
            continue;
          }
          await deleteVoiceRecord(entry.id);
          delivered += 1;
          continue;
        }
        const result = await runVoiceSubmit(
          { sessionId: entry.sessionId, intent: 'draft' },
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
