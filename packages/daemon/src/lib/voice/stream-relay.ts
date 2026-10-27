import { VOICE_MAX_AUDIO_BYTES, type VoiceMode, type VoiceSettings } from '@hyperneo/shared';
import superpipe, { type PipelineAPI } from 'superpipe';
import WebSocket from 'ws';
import type { ProviderCredentialManager } from '../credentials/provider-credential-manager.ts';
import { withVoiceCredentialLock } from '../rpc-handlers/voice-credential-lock.ts';
import {
  voiceDiagnostic,
  voicePeerReasonBytes,
  voiceSocketErrorCode,
  voiceSocketReason,
} from './diagnostics.ts';
import {
  BATCH_TRANSCRIPTIONS_PATH,
  joinFinals,
  type StreamProtocol,
  streamProtocol,
} from './stream-protocols.ts';
import { resolveTranscriptionEndpoint, withTimeout } from './transcribe-fetch.ts';
import { resolveApiKey, type VoiceTranscribeOutcome } from './transcribe-pipeline.ts';

const STREAM_SAMPLE_RATE = 16_000;
const CONNECT_TIMEOUT_MS = 5_000;
const START_TIMEOUT_MS = 8_000;
const CREDENTIAL_LOOKUP_TIMEOUT_MS = 16_000;
const CLOSE_TIMEOUT_MS = 5_000;

export interface VoiceStreamText {
  streamId: string;
  text: string;
  isFinal: boolean;
}

export interface VoiceStreamDeps {
  clientId?: string;
  language?: 'zh' | 'en';
  voice: () => VoiceSettings | undefined;
  credentialManager?: Pick<ProviderCredentialManager, 'getCredentials'>;
  transcribeWav: (wavBase64: string) => Promise<VoiceTranscribeOutcome>;
  push: (text: VoiceStreamText) => void;
}

type Gate<T> = { value: T } | { reason: string };

export function voiceMode(voice: VoiceSettings | undefined): VoiceMode {
  return voice?.mode === 'batch' || voice?.mode === 'streaming' ? voice.mode : 'auto';
}

export function admitVoiceStream(voice: VoiceSettings | undefined): Gate<VoiceSettings> {
  if (!voice?.enabled) return { reason: 'Voice input is disabled' };
  if (!voice.endpoint?.trim() || !voice.model?.trim())
    return { reason: 'Voice transcription endpoint and model are required' };
  return { value: voice };
}

function derivedStreamUrl(batchEndpoint: string): string | undefined {
  try {
    const url = new URL(batchEndpoint);
    if (url.protocol !== 'https:' && url.protocol !== 'http:') return undefined;
    const pathname = url.pathname.replace(/\/+$/, '');
    const base = pathname.endsWith(BATCH_TRANSCRIPTIONS_PATH)
      ? pathname.slice(0, -BATCH_TRANSCRIPTIONS_PATH.length)
      : pathname;
    url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
    url.pathname = `${base}/listen`;
    url.search = '';
    return url.toString();
  } catch {
    return undefined;
  }
}

export function voiceStreamRoute(
  voice: VoiceSettings
): { url: URL; protocol: StreamProtocol } | null {
  const protocol = streamProtocol(voice.streamProtocol);
  const endpoint = voice.streamEndpoint?.trim() || derivedStreamUrl(voice.endpoint);
  if (!protocol || !endpoint) return null;
  let url: URL;
  try {
    url = new URL(endpoint);
  } catch {
    return null;
  }
  if (url.protocol !== 'wss:' && url.protocol !== 'ws:') return null;
  return { url: protocol.url(url, STREAM_SAMPLE_RATE), protocol };
}

export function voiceStreamTls(voice: VoiceSettings): { ca?: string; rejectUnauthorized: boolean } {
  const ca = voice.tlsCaPem?.trim();
  return { ...(ca ? { ca } : {}), rejectUnauthorized: !voice.allowInsecureTls };
}

export function pcm16Wav(pcm: Uint8Array): Uint8Array {
  const wav = new Uint8Array(44 + pcm.byteLength);
  const view = new DataView(wav.buffer);
  const ascii = (offset: number, text: string) =>
    [...text].forEach((char, index) => view.setUint8(offset + index, char.charCodeAt(0)));
  ascii(0, 'RIFF');
  view.setUint32(4, 36 + pcm.byteLength, true);
  ascii(8, 'WAVE');
  ascii(12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, STREAM_SAMPLE_RATE, true);
  view.setUint32(28, STREAM_SAMPLE_RATE * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  ascii(36, 'data');
  view.setUint32(40, pcm.byteLength, true);
  wav.set(pcm, 44);
  return wav;
}

async function openAsrSocket(
  streamId: string,
  voice: VoiceSettings,
  url: URL,
  protocol: StreamProtocol,
  deps: VoiceStreamDeps
): Promise<Gate<WebSocket>> {
  try {
    const http = new URL(url);
    http.protocol = url.protocol === 'wss:' ? 'https:' : 'http:';
    const [resolved] = await resolveTranscriptionEndpoint(
      http,
      voice.allowPrivateNetwork ?? false,
      voice.allowInsecureTls ?? false
    );
    const endpoint = new URL(voice.endpoint);
    const apiKey = await withVoiceCredentialLock(() =>
      withTimeout(
        resolveApiKey(voice.apiKey, voice.apiKeyEndpoint, endpoint, deps.credentialManager),
        CREDENTIAL_LOOKUP_TIMEOUT_MS,
        'Voice transcription credential lookup timed out'
      )
    );
    if (apiKey && url.protocol !== 'wss:')
      return { reason: 'Voice API keys are only sent over TLS' };
    const target = new URL(url);
    if (deps.language) target.searchParams.set('language', deps.language);
    target.hostname = resolved.hostname;
    const pinned = target.hostname !== url.hostname;
    const tls = { ...voiceStreamTls(voice), ...(pinned ? { servername: url.hostname } : {}) };
    const socket = new WebSocket(target, {
      ...tls,
      tls: { ...tls, ...(pinned ? { serverName: url.hostname } : {}) },
      headers: {
        ...(pinned ? { Host: url.host } : {}),
        ...(apiKey ? { Authorization: protocol.authorization(apiKey) } : {}),
      },
      handshakeTimeout: CONNECT_TIMEOUT_MS,
    } as WebSocket.ClientOptions);
    return await new Promise((resolve) => {
      socket.on('error', (error) => {
        voiceDiagnostic('voice.asr.error', {
          streamId,
          clientId: deps.clientId,
          reason: 'socket_error',
          code: voiceSocketErrorCode(error),
        });
        resolve({ reason: error?.message || 'connection failed' });
      });
      socket.on('close', (code, reason) =>
        voiceDiagnostic('voice.asr.close', {
          streamId,
          clientId: deps.clientId,
          code,
          reason: voiceSocketReason(code),
          peerReasonBytes: voicePeerReasonBytes(reason),
        })
      );
      socket.once('open', () => {
        for (const message of protocol.opening()) socket.send(message);
        resolve({ value: socket });
      });
    });
  } catch (error) {
    return { reason: error instanceof Error ? error.message : String(error) };
  }
}

async function openAsrSocketWithin(
  streamId: string,
  voice: VoiceSettings,
  url: URL,
  protocol: StreamProtocol,
  deps: VoiceStreamDeps
): Promise<Gate<WebSocket>> {
  const startedAt = Date.now();
  const opening = openAsrSocket(streamId, voice, url, protocol, deps);
  let timer: ReturnType<typeof setTimeout> | undefined;
  const expired = new Promise<Gate<WebSocket>>((resolve) => {
    timer = setTimeout(
      () => resolve({ reason: `no connection within ${START_TIMEOUT_MS} ms` }),
      START_TIMEOUT_MS
    );
  });
  const opened = await Promise.race([opening, expired]);
  clearTimeout(timer);
  if ('reason' in opened)
    void opening.then((late) => {
      if (!('value' in late)) return;
      late.value.once('close', (code, reason) =>
        voiceDiagnostic('voice.stream.end', {
          streamId,
          clientId: deps.clientId,
          closedBy: 'relay',
          code,
          reason: voiceSocketReason(code),
          peerReasonBytes: voicePeerReasonBytes(reason),
          durationMs: Date.now() - startedAt,
        })
      );
      late.value.close(1000);
    });
  return opened;
}

export const planVoiceStream = (superpipe({})('voice-stream-start') as PipelineAPI)
  .input(['voice'])
  .pipe(admitVoiceStream, 'voice', 'result:plan')
  .pipe(
    (admitted: VoiceSettings) => ({
      voice: admitted,
      mode: voiceMode(admitted),
      route: voiceMode(admitted) === 'batch' ? null : voiceStreamRoute(admitted),
    }),
    'plan',
    'plan'
  )
  .end('plan') as (voice: VoiceSettings | undefined) =>
  | {
      voice: VoiceSettings;
      mode: VoiceMode;
      route: { url: URL; protocol: StreamProtocol } | null;
    }
  | string;

export class VoiceStream {
  private readonly startedAt = Date.now();
  private via: 'streaming' | 'batch' = 'batch';
  private fallbackReason: string | undefined;
  private chunks: Uint8Array[] = [];
  private cancelled = false;
  private bytes = 0;
  private socket: WebSocket | null = null;
  private protocol: StreamProtocol | null = null;
  private finals: string[] = [];
  private partial = '';
  private closeInitiator: 'client' | 'relay' | null = null;
  private lastAudioSentAt: number | null = null;
  private lastResultAt: number | null = null;
  private lastPingAt: number | null = null;
  private lastPongAt: number | null = null;
  private stopping: Promise<
    { text: string; via: 'streaming' | 'batch' } | { error: string; retryable?: true }
  > | null = null;

  private constructor(
    readonly id: string,
    private readonly deps: VoiceStreamDeps
  ) {}

  static async start(
    id: string,
    deps: VoiceStreamDeps
  ): Promise<
    { stream: VoiceStream; via: 'streaming' | 'batch'; fallback?: string } | { error: string }
  > {
    const plan = planVoiceStream(deps.voice());
    if (typeof plan === 'string') {
      voiceDiagnostic('voice.stream.open', {
        streamId: id,
        clientId: deps.clientId,
        status: 'refused',
        fallbackReason: 'invalid_configuration',
      });
      return { error: plan };
    }
    const openedLog = (status: string, via?: string, fallbackReason?: string) =>
      voiceDiagnostic('voice.stream.open', {
        streamId: id,
        clientId: deps.clientId,
        status,
        via,
        mode: plan.mode,
        route: plan.route ? (plan.voice.streamProtocol ?? 'deepgram') : 'batch',
        streamOrigin: plan.route?.url.origin,
        fallbackReason,
      });
    const stream = new VoiceStream(id, deps);
    if (!plan.route) {
      stream.fallbackReason = plan.mode === 'batch' ? undefined : 'no_streaming_route';
      openedLog(plan.mode === 'streaming' ? 'refused' : 'started', 'batch', stream.fallbackReason);
      return plan.mode === 'streaming'
        ? { error: 'The voice endpoint has no streaming transcription route' }
        : {
            stream,
            via: 'batch',
            ...(plan.mode === 'auto' ? { fallback: 'no streaming route' } : {}),
          };
    }
    const opened = await openAsrSocketWithin(
      id,
      plan.voice,
      plan.route.url,
      plan.route.protocol,
      deps
    );
    if ('reason' in opened) {
      stream.fallbackReason = 'asr_unavailable';
      openedLog(plan.mode === 'streaming' ? 'refused' : 'started', 'batch', stream.fallbackReason);
      return plan.mode === 'streaming'
        ? { error: `Streaming transcription is unavailable: ${opened.reason}` }
        : { stream, via: 'batch', fallback: opened.reason };
    }
    stream.via = 'streaming';
    openedLog('started', 'streaming');
    stream.attach(opened.value, plan.route.protocol);
    return { stream, via: 'streaming' };
  }

  private attach(socket: WebSocket, protocol: StreamProtocol): void {
    this.socket = socket;
    this.protocol = protocol;
    socket.on('message', (data, isBinary) => {
      const parsed = isBinary || this.cancelled ? null : protocol.parse(data.toString());
      if (!parsed) return;
      this.lastResultAt = Date.now();
      if (parsed.isFinal) {
        if (parsed.text) this.finals.push(parsed.text);
        this.partial = '';
      } else this.partial = parsed.text;
      this.deps.push({ streamId: this.id, text: this.text(), isFinal: false });
    });
    socket.on('ping', () => {
      this.lastPingAt = Date.now();
    });
    socket.on('pong', () => {
      this.lastPongAt = Date.now();
    });
    socket.on('close', (code, reason) => {
      if (this.socket === socket) this.socket = null;
      this.logEnd(code, reason);
    });
    socket.on('error', () => {
      if (this.socket === socket) this.socket = null;
    });
  }

  private logEnd(code: number, peerReason: unknown): void {
    const now = Date.now();
    const since = (at: number | null) => (at === null ? null : now - at);
    voiceDiagnostic('voice.stream.end', {
      streamId: this.id,
      clientId: this.deps.clientId,
      closedBy: this.closeInitiator ?? 'server',
      code,
      reason: voiceSocketReason(code),
      peerReasonBytes: voicePeerReasonBytes(peerReason),
      durationMs: now - this.startedAt,
      sinceLastAudioMs: since(this.lastAudioSentAt),
      sinceLastResultMs: since(this.lastResultAt),
      sinceLastPingMs: since(this.lastPingAt),
      sinceLastPongMs: since(this.lastPongAt),
    });
  }

  private text(): string {
    return joinFinals([...this.finals, this.partial]);
  }

  write(pcm: Uint8Array): string | null {
    if (pcm.byteLength % 2 !== 0) return 'Voice chunks must be whole 16-bit samples';
    if (this.bytes + pcm.byteLength > VOICE_MAX_AUDIO_BYTES - 44)
      return 'Audio data exceeds the 10 MB voice input limit';
    this.chunks.push(pcm);
    this.bytes += pcm.byteLength;
    if (this.socket?.readyState === WebSocket.OPEN && this.protocol) {
      this.socket.send(this.protocol.audio(pcm));
      this.lastAudioSentAt = Date.now();
    }
    return null;
  }

  stop(): Promise<
    { text: string; via: 'streaming' | 'batch' } | { error: string; retryable?: true }
  > {
    if (!this.stopping) {
      const stoppingAt = Date.now();
      const audioBytes = this.bytes;
      const record = (status: string, retryable = false) =>
        voiceDiagnostic('voice.stream.stop', {
          streamId: this.id,
          clientId: this.deps.clientId,
          via: this.via,
          status,
          retryable,
          audioBytes,
          audioDurationMs: (audioBytes / (STREAM_SAMPLE_RATE * 2)) * 1000,
          durationMs: Date.now() - this.startedAt,
          stopDurationMs: Date.now() - stoppingAt,
          fallbackReason: this.fallbackReason,
        });
      this.stopping = this.finish()
        .then(
          (result) => {
            record(
              'error' in result ? 'failed' : 'completed',
              'error' in result && result.retryable === true
            );
            return result;
          },
          (error: unknown) => {
            record('failed');
            throw error;
          }
        )
        .finally(() => {
          this.stopping = null;
        });
    }
    return this.stopping;
  }

  private async finish(): Promise<
    { text: string; via: 'streaming' | 'batch' } | { error: string; retryable?: true }
  > {
    const socket = this.socket;
    if (socket && this.protocol) {
      const closed = new Promise<boolean>((resolve) => {
        const timer = setTimeout(() => resolve(false), CLOSE_TIMEOUT_MS);
        socket.once('close', () => {
          clearTimeout(timer);
          resolve(true);
        });
      });
      socket.send(this.protocol.finish());
      const finished = await closed;
      this.close();
      if (this.cancelled) return { error: 'Voice stream cancelled' };
      const text = this.text();
      if (finished && (text || this.bytes === 0)) {
        this.deps.push({ streamId: this.id, text, isFinal: true });
        return { text, via: 'streaming' };
      }
    }
    if (this.via === 'streaming')
      this.fallbackReason = socket ? 'asr_incomplete' : 'asr_disconnected';
    this.via = 'batch';
    if (this.bytes === 0) return { error: 'Audio data is empty' };
    const pcm = new Uint8Array(this.bytes);
    let offset = 0;
    for (const chunk of this.chunks) {
      pcm.set(chunk, offset);
      offset += chunk.byteLength;
    }
    const outcome = await this.deps.transcribeWav(Buffer.from(pcm16Wav(pcm)).toString('base64'));
    if (this.cancelled) return { error: 'Voice stream cancelled' };
    if (outcome.action !== 'transcribed')
      return {
        error: outcome.action === 'denied' ? outcome.message : outcome.error,
        retryable: true,
      };
    this.deps.push({ streamId: this.id, text: outcome.text, isFinal: true });
    return { text: outcome.text, via: 'batch' };
  }

  cancel(): void {
    this.cancelled = true;
    if (!this.closeInitiator) this.closeInitiator = 'client';
    this.chunks = [];
    this.bytes = 0;
    this.close();
  }

  close(reason = 'closed'): void {
    if (!this.closeInitiator)
      this.closeInitiator = reason === 'client_disconnected' ? 'client' : 'relay';
    voiceDiagnostic('voice.stream.close', {
      streamId: this.id,
      clientId: this.deps.clientId,
      reason,
      via: this.via,
      audioBytes: this.bytes,
      audioDurationMs: (this.bytes / (STREAM_SAMPLE_RATE * 2)) * 1000,
      durationMs: Date.now() - this.startedAt,
    });
    const socket = this.socket;
    this.socket = null;
    socket?.close(1000);
  }
}
