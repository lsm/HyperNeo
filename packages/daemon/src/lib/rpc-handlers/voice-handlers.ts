import type { BeforeVoiceDispatch } from '../voice/transcribe-fetch.ts';
import type { Database } from '../../storage/sqlite-compat.ts';
import { VoiceRecordingRepository } from '../../storage/repositories/voice-recording-repository.ts';
import type { UpgradeIdentity } from '../pairing/upgrade-auth.ts';
import { VoiceRecordingTranscription, runRecordedVoice } from '../voice/recording-transcription.ts';
import {
  createEventMessage,
  MessageHubHandlerError,
  type CallContext,
  type MessageHub,
  VOICE_MAX_AUDIO_BYTES,
} from '@hyperneo/shared';
import superpipe, { type PipelineAPI } from 'superpipe';
import type { ProviderCredentialManager } from '../credentials/provider-credential-manager.ts';
import type { SettingsManager } from '../settings-manager.ts';
import { VoiceStream, type VoiceStreamText } from '../voice/stream-relay.ts';
import { createVoiceTranscribeLimiters, runVoiceTranscribe } from '../voice/transcribe-pipeline.ts';

interface VoiceTranscribeRequest {
  recordingId?: string;
  audioBase64: string;
  mimeType: 'audio/wav';
}

interface VoiceTranscribeResponse {
  text: string;
}

const transcriptionLimiters = createVoiceTranscribeLimiters();
interface OwnedVoiceStream {
  stream: VoiceStream;
  clientId: string | null;
  owner: string;
  touchedAt: number;
  disconnectedAt?: number;
  disconnectTimer?: ReturnType<typeof setTimeout>;
}
const voiceStreams = new Map<string, OwnedVoiceStream>();
const voiceStreamStarts = new Map<string, number[]>();
const startingStreams = { count: 0 };
const STREAM_STARTS_PER_MINUTE = 10;
const MAX_VOICE_STREAMS = 8;
const VOICE_STREAM_IDLE_MS = 3 * 60_000;
const VOICE_STREAM_DISCONNECT_MS = 2 * 60_000;
const MAX_CHUNK_BASE64_LENGTH = Math.ceil((VOICE_MAX_AUDIO_BYTES - 44) / 3) * 4;

export function admitVoiceChunkOffset(
  offset: unknown,
  received: number
): { value: number } | { reason: string } {
  if (offset === undefined) return { value: received };
  if (typeof offset !== 'number' || !Number.isSafeInteger(offset) || offset < 0)
    return { reason: 'VOICE_STREAM_INVALID_OFFSET' };
  if (offset > received) return { reason: 'VOICE_STREAM_OFFSET_GAP' };
  return { value: offset };
}

const voiceChunkTail = (superpipe({})('voice-stream-chunk') as PipelineAPI)
  .input(['audio', 'offset', 'received'])
  .pipe(admitVoiceChunkOffset, ['offset', 'received'], 'result:tail')
  .pipe(
    (offset: number, audio: Uint8Array, received: number) =>
      new Uint8Array(audio.subarray(Math.min(received - offset, audio.byteLength))),
    ['tail', 'audio', 'received'],
    'tail'
  )
  .end('tail') as (audio: Uint8Array, offset: unknown, received: number) => Uint8Array | string;

function admitVoiceStreamOwner(
  stream: OwnedVoiceStream | undefined,
  owner: string
): { value: OwnedVoiceStream } | { reason: string } {
  return !stream || stream.owner !== owner
    ? { reason: 'VOICE_STREAM_NOT_FOUND' }
    : { value: stream };
}

const voiceStreamResume = (superpipe({})('voice-stream-resume') as PipelineAPI)
  .input(['stream', 'owner'])
  .pipe(admitVoiceStreamOwner, ['stream', 'owner'], 'result:resume')
  .end('resume') as (
  stream: OwnedVoiceStream | undefined,
  owner: string
) => OwnedVoiceStream | string;

function deleteVoiceStream(id: string): void {
  clearTimeout(voiceStreams.get(id)?.disconnectTimer);
  voiceStreams.delete(id);
}

export function admitVoiceStreamStart(
  starts: readonly number[],
  open: number,
  now: number
): { value: number[] } | { reason: string } {
  const recent = starts.filter((at) => now - at < 60_000);
  if (recent.length >= STREAM_STARTS_PER_MINUTE)
    return { reason: 'Voice stream rate limit exceeded; please wait before trying again' };
  if (open >= MAX_VOICE_STREAMS) return { reason: 'Too many voice streams are already open' };
  return { value: [...recent, now] };
}

export function expireIdleVoiceStreams(now: number): void {
  for (const [id, owned] of voiceStreams)
    if (
      owned.disconnectedAt === undefined
        ? now - owned.touchedAt > VOICE_STREAM_IDLE_MS
        : now - owned.disconnectedAt >= VOICE_STREAM_DISCONNECT_MS
    ) {
      owned.stream.close(
        owned.disconnectedAt === undefined ? 'idle_timeout' : 'disconnect_timeout'
      );
      deleteVoiceStream(id);
    }
}

export function resetVoiceTranscriptionLimitsForTests(): void {
  transcriptionLimiters.activeByClient.clear();
  transcriptionLimiters.rateWindowsByClient.clear();
  transcriptionLimiters.daemonActive.count = 0;
  transcriptionLimiters.daemonRateWindow = { windowStartedAt: 0, count: 0 };
  for (const [id, owned] of voiceStreams) {
    owned.stream.close();
    deleteVoiceStream(id);
  }
  voiceStreamStarts.clear();
  startingStreams.count = 0;
}

export function registerVoiceHandlers(
  messageHub: MessageHub,
  settingsManager: SettingsManager,
  credentialManager?: ProviderCredentialManager,
  recording?: { db: Database; deviceOf: (clientId: string) => UpgradeIdentity | null }
): void {
  const ownerOf = (clientId: string) => recording?.deviceOf(clientId)?.deviceId ?? 'local';
  const recordings = recording
    ? new VoiceRecordingTranscription(new VoiceRecordingRepository(recording.db))
    : undefined;
  messageHub.onRequest<VoiceTranscribeRequest, VoiceTranscribeResponse>(
    'voice.transcribe',
    (data, context) =>
      transcribeViaPipeline(
        settingsManager,
        credentialManager,
        data,
        context,
        recordings,
        context?.clientId ? (recording?.deviceOf(context.clientId)?.deviceId ?? 'local') : 'local'
      )
  );

  messageHub.onRequest<{ encoding?: string; sampleRate?: number; language?: string }>(
    'voice.stream.start',
    async (data, context) => {
      if (data?.encoding !== 'pcm16' || data.sampleRate !== 16_000)
        throw new Error('Voice streams take pcm16 audio at 16000 Hz');
      const clientId = context?.clientId ?? context?.sessionId ?? 'global';
      const owner = ownerOf(clientId);
      expireIdleVoiceStreams(Date.now());
      const replaces = (owned: OwnedVoiceStream) =>
        owned.clientId === clientId || (owned.clientId === null && owned.owner === owner);
      const replaced = [...voiceStreams].filter(([, owned]) => replaces(owned));
      const admitted = admitVoiceStreamStart(
        voiceStreamStarts.get(clientId) ?? [],
        voiceStreams.size - replaced.length + startingStreams.count,
        Date.now()
      );
      if ('reason' in admitted) throw new Error(admitted.reason);
      voiceStreamStarts.set(clientId, admitted.value);
      startingStreams.count += 1;
      try {
        const streamId = crypto.randomUUID();
        const started = await VoiceStream.start(streamId, {
          clientId,
          language: data.language === 'zh' || data.language === 'en' ? data.language : undefined,
          voice: () => settingsManager.getGlobalSettings().voice,
          credentialManager,
          transcribeWav: (audioBase64) =>
            runVoiceTranscribe({
              data: { audioBase64, mimeType: 'audio/wav' },
              context,
              deps: { settingsManager, credentialManager, limiters: transcriptionLimiters },
            }),
          push: (text: VoiceStreamText) => {
            const recipient = voiceStreams.get(streamId)?.clientId;
            if (recipient)
              messageHub.getRouter()?.sendToClient(
                recipient,
                createEventMessage({
                  method: 'voice.stream.text',
                  data: text,
                  sessionId: 'global',
                })
              );
          },
        });
        if ('error' in started) throw new Error(started.error);
        const router = messageHub.getRouter?.();
        if (context?.clientId && router && !router.getClientById(context.clientId)) {
          started.stream.close('client_disconnected');
          throw new Error('The client disconnected while the voice stream was starting');
        }
        if (
          [...voiceStreams.values()].filter((owned) => !replaces(owned)).length >= MAX_VOICE_STREAMS
        ) {
          started.stream.close('capacity_changed');
          throw new Error('Too many voice streams are already open');
        }
        for (const [id, owned] of voiceStreams)
          if (replaces(owned)) {
            owned.stream.close('replaced');
            deleteVoiceStream(id);
          }
        voiceStreams.set(streamId, {
          stream: started.stream,
          clientId,
          owner,
          touchedAt: Date.now(),
        });
        return {
          streamId,
          via: started.via,
          resumable: true,
          ...('fallback' in started && started.fallback ? { fallback: started.fallback } : {}),
        };
      } finally {
        startingStreams.count -= 1;
      }
    }
  );

  messageHub.onRequest<{ streamId: string }>('voice.stream.resume', (data, context) => {
    expireIdleVoiceStreams(Date.now());
    const clientId = context?.clientId ?? context?.sessionId ?? 'global';
    const owned = voiceStreamResume(
      data?.streamId ? voiceStreams.get(data.streamId) : undefined,
      ownerOf(clientId)
    );
    if (typeof owned === 'string') throw new MessageHubHandlerError('Unknown voice stream', owned);
    clearTimeout(owned.disconnectTimer);
    owned.disconnectTimer = undefined;
    owned.disconnectedAt = undefined;
    owned.clientId = clientId;
    owned.touchedAt = Date.now();
    return { ok: true, receivedBytes: owned.stream.receivedBytes };
  });

  messageHub.onRequest<{ streamId: string; audioBase64: string; offset?: number }>(
    'voice.stream.chunk',
    async (data, context) => {
      const stream = ownedStream(data?.streamId, context);
      if ((data.audioBase64 ?? '').length > MAX_CHUNK_BASE64_LENGTH)
        throw new Error('Audio data exceeds the 10 MB voice input limit');
      const tail = voiceChunkTail(
        Buffer.from(data.audioBase64 ?? '', 'base64'),
        data.offset,
        stream.receivedBytes
      );
      if (typeof tail === 'string')
        throw new MessageHubHandlerError('Invalid voice chunk offset: ' + tail, tail);
      const refused = tail.byteLength || data.offset === undefined ? stream.write(tail) : null;
      if (refused) throw new Error(refused);
      return { ok: true };
    }
  );

  messageHub.onRequest<{ streamId: string }>('voice.stream.stop', async (data, context) => {
    const stream = ownedStream(data?.streamId, context);
    const result = await stream.stop();
    const owned = voiceStreams.get(data.streamId);
    if (owned) owned.touchedAt = Date.now();
    if (!('error' in result) || !result.retryable) deleteVoiceStream(data.streamId);
    if ('error' in result) throw new Error(result.error);
    return result;
  });

  messageHub.onRequest<{ streamId: string }>('voice.stream.cancel', async (data, context) => {
    const owned = data?.streamId ? voiceStreams.get(data.streamId) : undefined;
    if (owned?.clientId === (context?.clientId ?? context?.sessionId ?? 'global')) {
      owned.stream.cancel();
      deleteVoiceStream(data.streamId);
    }
    return { ok: true };
  });

  messageHub.onClientDisconnect?.((clientId) => {
    voiceStreamStarts.delete(clientId);
    for (const owned of voiceStreams.values())
      if (owned.clientId === clientId) {
        owned.clientId = null;
        owned.disconnectedAt = Date.now();
        owned.disconnectTimer = setTimeout(
          () => expireIdleVoiceStreams(Date.now()),
          VOICE_STREAM_DISCONNECT_MS
        );
        owned.disconnectTimer.unref?.();
      }
  });

  messageHub.onRequest('voice.testConnection', async (_data, context) =>
    transcribeViaPipeline(
      settingsManager,
      credentialManager,
      createTestConnectionRequest(),
      context
    )
  );
}

function ownedStream(streamId: string | undefined, context: CallContext | undefined): VoiceStream {
  const owned = streamId ? voiceStreams.get(streamId) : undefined;
  if (!owned || owned.clientId !== (context?.clientId ?? context?.sessionId ?? 'global'))
    throw new Error('Unknown voice stream');
  owned.touchedAt = Date.now();
  return owned.stream;
}

async function transcribeViaPipeline(
  settingsManager: SettingsManager,
  credentialManager: ProviderCredentialManager | undefined,
  data: VoiceTranscribeRequest,
  context: CallContext | undefined,
  recordings?: VoiceRecordingTranscription,
  owner = 'local'
): Promise<VoiceTranscribeResponse> {
  const submit = (beforeDispatch?: BeforeVoiceDispatch) =>
    runVoiceTranscribe({
      data,
      context,
      deps: { settingsManager, credentialManager, limiters: transcriptionLimiters, beforeDispatch },
    });
  const outcome =
    data?.recordingId === undefined
      ? await submit()
      : await runRecordedVoice(data, owner, recordings, submit);
  if (outcome.action === 'transcribed') return { text: outcome.text };
  throw new Error(outcome.action === 'denied' ? outcome.message : outcome.error);
}

function createTestConnectionRequest(): VoiceTranscribeRequest {
  return {
    audioBase64: Buffer.from(createSilentWav()).toString('base64'),
    mimeType: 'audio/wav',
  };
}

function createSilentWav(): Uint8Array {
  const sampleRate = 16_000;
  const samples = sampleRate / 10;
  const dataSize = samples * 2;
  const buffer = new ArrayBuffer(44 + dataSize);
  const view = new DataView(buffer);
  writeAscii(view, 0, 'RIFF');
  view.setUint32(4, 36 + dataSize, true);
  writeAscii(view, 8, 'WAVE');
  writeAscii(view, 12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  writeAscii(view, 36, 'data');
  view.setUint32(40, dataSize, true);
  return new Uint8Array(buffer);
}

function writeAscii(view: DataView, offset: number, value: string): void {
  for (let index = 0; index < value.length; index++) {
    view.setUint8(offset + index, value.charCodeAt(index));
  }
}
