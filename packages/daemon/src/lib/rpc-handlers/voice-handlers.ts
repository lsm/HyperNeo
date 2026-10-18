import { createEventMessage, type CallContext, type MessageHub } from '@hyperneo/shared';
import type { ProviderCredentialManager } from '../credentials/provider-credential-manager.ts';
import type { SettingsManager } from '../settings-manager.ts';
import { VoiceStream, type VoiceStreamText } from '../voice/stream-relay.ts';
import { createVoiceTranscribeLimiters, runVoiceTranscribe } from '../voice/transcribe-pipeline.ts';

interface VoiceTranscribeRequest {
  audioBase64: string;
  mimeType: 'audio/wav';
}

interface VoiceTranscribeResponse {
  text: string;
}

const transcriptionLimiters = createVoiceTranscribeLimiters();
const voiceStreams = new Map<string, { stream: VoiceStream; clientId: string }>();
const voiceStreamStarts = new Map<string, number[]>();
const startingStreams = { count: 0 };
const STREAM_STARTS_PER_MINUTE = 10;
const MAX_VOICE_STREAMS = 8;

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

export function resetVoiceTranscriptionLimitsForTests(): void {
  transcriptionLimiters.activeByClient.clear();
  transcriptionLimiters.rateWindowsByClient.clear();
  transcriptionLimiters.daemonActive.count = 0;
  transcriptionLimiters.daemonRateWindow = { windowStartedAt: 0, count: 0 };
  voiceStreams.clear();
  voiceStreamStarts.clear();
  startingStreams.count = 0;
}

export function registerVoiceHandlers(
  messageHub: MessageHub,
  settingsManager: SettingsManager,
  credentialManager?: ProviderCredentialManager
): void {
  messageHub.onRequest<VoiceTranscribeRequest, VoiceTranscribeResponse>(
    'voice.transcribe',
    (data, context) => transcribeViaPipeline(settingsManager, credentialManager, data, context)
  );

  messageHub.onRequest<{ encoding?: string; sampleRate?: number }>(
    'voice.stream.start',
    async (data, context) => {
      if (data?.encoding !== 'pcm16' || data.sampleRate !== 16_000)
        throw new Error('Voice streams take pcm16 audio at 16000 Hz');
      const clientId = context?.clientId ?? context?.sessionId ?? 'global';
      const replaced = [...voiceStreams].filter(([, owned]) => owned.clientId === clientId);
      const admitted = admitVoiceStreamStart(
        voiceStreamStarts.get(clientId) ?? [],
        voiceStreams.size - replaced.length + startingStreams.count,
        Date.now()
      );
      if ('reason' in admitted) throw new Error(admitted.reason);
      for (const [id, owned] of replaced) {
        owned.stream.close();
        voiceStreams.delete(id);
      }
      voiceStreamStarts.set(clientId, admitted.value);
      startingStreams.count += 1;
      try {
        const streamId = crypto.randomUUID();
        const started = await VoiceStream.start(streamId, {
          voice: () => settingsManager.getGlobalSettings().voice,
          credentialManager,
          transcribeWav: (audioBase64) =>
            runVoiceTranscribe({
              data: { audioBase64, mimeType: 'audio/wav' },
              context,
              deps: { settingsManager, credentialManager, limiters: transcriptionLimiters },
            }),
          push: (text: VoiceStreamText) =>
            messageHub
              .getRouter()
              ?.sendToClient(
                clientId,
                createEventMessage({ method: 'voice.stream.text', data: text, sessionId: 'global' })
              ),
        });
        if ('error' in started) throw new Error(started.error);
        const router = messageHub.getRouter?.();
        if (context?.clientId && router && !router.getClientById(context.clientId)) {
          started.stream.close();
          throw new Error('The client disconnected while the voice stream was starting');
        }
        voiceStreams.set(streamId, { stream: started.stream, clientId });
        return {
          streamId,
          via: started.via,
          ...('fallback' in started && started.fallback ? { fallback: started.fallback } : {}),
        };
      } finally {
        startingStreams.count -= 1;
      }
    }
  );

  messageHub.onRequest<{ streamId: string; audioBase64: string }>(
    'voice.stream.chunk',
    async (data, context) => {
      const stream = ownedStream(data?.streamId, context);
      const refused = stream.write(Buffer.from(data.audioBase64 ?? '', 'base64'));
      if (refused) throw new Error(refused);
      return { ok: true };
    }
  );

  messageHub.onRequest<{ streamId: string }>('voice.stream.stop', async (data, context) => {
    const stream = ownedStream(data?.streamId, context);
    const result = await stream.stop();
    if (!('error' in result) || !result.retryable) voiceStreams.delete(data.streamId);
    if ('error' in result) throw new Error(result.error);
    return result;
  });

  messageHub.onClientDisconnect?.((clientId) => {
    voiceStreamStarts.delete(clientId);
    for (const [id, owned] of voiceStreams)
      if (owned.clientId === clientId) {
        owned.stream.close();
        voiceStreams.delete(id);
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
  return owned.stream;
}

async function transcribeViaPipeline(
  settingsManager: SettingsManager,
  credentialManager: ProviderCredentialManager | undefined,
  data: VoiceTranscribeRequest,
  context: CallContext | undefined
): Promise<VoiceTranscribeResponse> {
  const outcome = await runVoiceTranscribe({
    data,
    context,
    deps: { settingsManager, credentialManager, limiters: transcriptionLimiters },
  });
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
