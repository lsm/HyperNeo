import { opusInputDefaults, type OpusInput } from './opus-input.ts';
import {
  MessageHubHandlerError,
  VOICE_MAX_AUDIO_BYTES,
  type VoiceMode,
  type VoiceSettings,
} from '@hyperneo/shared';
import superpipe, { type PipelineAPI } from 'superpipe';
import type { ProviderCredentialManager } from '../credentials/provider-credential-manager.ts';
import { withVoiceCredentialLock } from '../rpc-handlers/voice-credential-lock.ts';
import {
  asrRelayDefaults,
  type AsrRelay,
  type AsrRelayEvent,
  type AsrRelayFactory,
} from './asr-relay.ts';
import { voiceDiagnostic } from './diagnostics.ts';
import { resolveTranscriptionEndpoint, withTimeout } from './transcribe-fetch.ts';
import { resolveApiKey, type VoiceTranscribeOutcome } from './transcribe-pipeline.ts';
import { streamProtocol, type StreamProtocol } from './stream-protocols.ts';

const STREAM_SAMPLE_RATE = 16_000;
const CONNECT_TIMEOUT_MS = 5_000;
const START_TIMEOUT_MS = 8_000;
const CREDENTIAL_LOOKUP_TIMEOUT_MS = 16_000;

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
  createRelay?: AsrRelayFactory;
}

type Gate<T> = { value: T } | { reason: string };

export function voiceMode(voice: VoiceSettings | undefined): VoiceMode {
  if (!voice?.streamEndpoint?.trim()) return 'batch';
  return voice?.mode === 'batch' || voice?.mode === 'streaming' ? voice.mode : 'auto';
}

export function admitVoiceStream(voice: VoiceSettings | undefined): Gate<VoiceSettings> {
  if (!voice?.enabled) return { reason: 'Voice input is disabled' };
  if (!voice.endpoint?.trim() || !voice.model?.trim())
    return { reason: 'Voice transcription endpoint and model are required' };
  return { value: voice };
}

export function voiceStreamRoute(
  voice: VoiceSettings
): { url: URL; protocol: StreamProtocol } | null {
  const protocol = streamProtocol(voice.streamProtocol);
  const endpoint = voice.streamEndpoint?.trim();
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

async function buildAsrRelayOpen(
  streamId: string,
  voice: VoiceSettings,
  url: URL,
  protocol: StreamProtocol,
  deps: VoiceStreamDeps
): Promise<Gate<import('./asr-relay-core.ts').AsrRelayOpen>> {
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
    return {
      value: {
        streamId,
        clientId: deps.clientId,
        url: target.toString(),
        protocolName: voice.streamProtocol ?? 'deepgram',
        wsOptions: {
          ...tls,
          tls: { ...tls, ...(pinned ? { serverName: url.hostname } : {}) },
          headers: {
            ...(pinned ? { Host: url.host } : {}),
            ...(apiKey ? { Authorization: protocol.authorization(apiKey) } : {}),
          },
          handshakeTimeout: CONNECT_TIMEOUT_MS,
        },
      },
    };
  } catch (error) {
    return { reason: error instanceof Error ? error.message : String(error) };
  }
}

async function openAsrRelayWithin(
  streamId: string,
  voice: VoiceSettings,
  url: URL,
  protocol: StreamProtocol,
  deps: VoiceStreamDeps,
  onEvent: (event: AsrRelayEvent) => void,
  onRelay: (relay: AsrRelay) => void
): Promise<Gate<AsrRelay> | { reason: string; relay: AsrRelay | null }> {
  let timedOut = false;
  let created: AsrRelay | null = null;
  const attempt = async (): Promise<
    Gate<AsrRelay> | { reason: string; relay: AsrRelay | null }
  > => {
    const spec = await buildAsrRelayOpen(streamId, voice, url, protocol, deps);
    if ('reason' in spec) return { ...spec, relay: null };
    const relay = (deps.createRelay ?? asrRelayDefaults.create)(spec.value);
    created = relay;
    onRelay(relay);
    const opened = new Promise<Gate<null>>((resolveOpened) => {
      relay.onMessage((event) => {
        if (event.type === 'opened') resolveOpened({ value: null });
        else if (event.type === 'open_failed') resolveOpened({ reason: event.reason });
        onEvent(event);
      });
    });
    if (timedOut) {
      relay.post({ type: 'abort-late-open' });
      return { reason: `no connection within ${START_TIMEOUT_MS} ms`, relay };
    }
    const outcome = await opened;
    return 'reason' in outcome ? { ...outcome, relay } : { value: relay };
  };
  let timer: ReturnType<typeof setTimeout> | undefined;
  const expired = new Promise<{ reason: string; relay: null }>((resolve) => {
    timer = setTimeout(() => {
      timedOut = true;
      created?.post({ type: 'abort-late-open' });
      resolve({ reason: `no connection within ${START_TIMEOUT_MS} ms`, relay: null });
    }, START_TIMEOUT_MS);
  });
  const outcome = await Promise.race([attempt(), expired]);
  clearTimeout(timer);
  return outcome;
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
  private codec: OpusInput | null = null;
  private encodedBytes = 0;
  private inputTail: Promise<void> = Promise.resolve();
  private partialOpus = false;
  private queued = { bytes: 0, count: 0 };
  private relay: AsrRelay | null = null;
  private relayAlive = false;
  private finishedWaiter: ((result: { ok: boolean; text: string }) => void) | null = null;
  private retireTimer: ReturnType<typeof setTimeout> | null = null;
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
    const opened = await openAsrRelayWithin(
      id,
      plan.voice,
      plan.route.url,
      plan.route.protocol,
      deps,
      (event) => stream.handleRelayEvent(event),
      (relay) => {
        stream.relay = relay;
      }
    );
    if ('value' in opened) stream.relay = opened.value;
    else if ('relay' in opened && opened.relay) stream.relay = opened.relay;
    if ('reason' in opened) {
      stream.fallbackReason = 'asr_unavailable';
      openedLog(plan.mode === 'streaming' ? 'refused' : 'started', 'batch', stream.fallbackReason);
      return plan.mode === 'streaming'
        ? { error: `Streaming transcription is unavailable: ${opened.reason}` }
        : { stream, via: 'batch', fallback: opened.reason };
    }
    stream.via = 'streaming';
    stream.relayAlive = true;
    openedLog('started', 'streaming');
    return { stream, via: 'streaming' };
  }

  private handleRelayEvent(event: AsrRelayEvent): void {
    if (event.type === 'diag') voiceDiagnostic(event.name, event.metadata);
    else if (event.type === 'text')
      this.deps.push({ streamId: this.id, text: event.text, isFinal: false });
    else if (event.type === 'finished') {
      const waiter = this.finishedWaiter;
      this.finishedWaiter = null;
      waiter?.({ ok: event.ok, text: event.text });
    } else if (event.type === 'dead') {
      this.relayAlive = false;
      const waiter = this.finishedWaiter;
      this.finishedWaiter = null;
      waiter?.({ ok: false, text: '' });
      this.retireRelay();
    } else if (event.type === 'open_failed') this.retireRelay();
  }

  private retireRelay(): void {
    if (this.retireTimer) return;
    this.retireTimer = setTimeout(() => {
      this.retireTimer = null;
      const waiter = this.finishedWaiter;
      this.finishedWaiter = null;
      waiter?.({ ok: false, text: '' });
      this.relay?.close();
      this.relay = null;
    }, 1_000);
  }

  async enableOpus(): Promise<void> {
    this.codec = await opusInputDefaults.create();
  }

  writeInput(select: () => Uint8Array, size: number, appendEmpty: boolean): Promise<string | null> {
    if (
      this.codec &&
      (this.queued.bytes + size > VOICE_MAX_AUDIO_BYTES || this.queued.count >= 128)
    )
      return Promise.resolve('Voice input queue is full; retry after pending chunks finish');
    this.queued.bytes += size;
    this.queued.count++;
    const accept = async () => {
      const audio = select();
      if (!audio.byteLength && !appendEmpty) return null;
      if (!this.codec) return this.write(audio);
      try {
        const decoded = await this.codec.decode(audio);
        const refused = decoded.pcm.byteLength ? this.write(decoded.pcm) : null;
        if (refused) throw new MessageHubHandlerError(refused, 'VOICE_STREAM_INVALID_OPUS');
        this.partialOpus = decoded.partial;
        this.encodedBytes += audio.byteLength;
        return null;
      } catch (error) {
        this.cancel();
        throw error instanceof MessageHubHandlerError
          ? error
          : new MessageHubHandlerError(
              error instanceof Error ? error.message : String(error),
              'VOICE_STREAM_INVALID_OPUS'
            );
      }
    };
    const result = (this.codec ? this.inputTail.then(accept) : accept()).finally(() => {
      this.queued.bytes -= size;
      this.queued.count--;
    });
    this.inputTail = result.then(
      () => {},
      () => {}
    );
    return result;
  }

  stop(): ReturnType<VoiceStream['stopReady']> {
    return this.codec
      ? this.inputTail.then(() =>
          this.partialOpus
            ? { error: 'Incomplete Opus packet', retryable: true as const }
            : this.stopReady()
        )
      : this.stopReady();
  }

  private stopReady(): Promise<
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
    const relay = this.relay;
    const wasAlive = this.relayAlive;
    if (relay && wasAlive) {
      const finished = new Promise<{ ok: boolean; text: string }>((resolve) => {
        this.finishedWaiter = resolve;
      });
      relay.post({ type: 'finish' });
      const result = await finished;
      this.close();
      if (this.cancelled) return { error: 'Voice stream cancelled' };
      if (result.ok && (result.text || this.bytes === 0)) {
        this.deps.push({ streamId: this.id, text: result.text, isFinal: true });
        return { text: result.text, via: 'streaming' };
      }
      if (this.via === 'streaming') this.fallbackReason = 'asr_incomplete';
    } else if (this.via === 'streaming') this.fallbackReason = 'asr_disconnected';
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

  get receivedBytes(): number {
    return this.codec ? this.encodedBytes : this.bytes;
  }

  write(pcm: Uint8Array): string | null {
    if (pcm.byteLength % 2 !== 0) return 'Voice chunks must be whole 16-bit samples';
    if (this.bytes + pcm.byteLength > VOICE_MAX_AUDIO_BYTES - 44)
      return 'Audio data exceeds the 10 MB voice input limit';
    this.chunks.push(pcm);
    this.bytes += pcm.byteLength;
    if (this.relayAlive) this.relay?.post({ type: 'audio', pcm });
    return null;
  }

  cancel(): void {
    this.cancelled = true;
    this.chunks = [];
    this.bytes = 0;
    this.close('client_disconnected');
  }

  close(reason = 'closed'): void {
    this.codec?.close();
    voiceDiagnostic('voice.stream.close', {
      streamId: this.id,
      clientId: this.deps.clientId,
      reason,
      via: this.via,
      audioBytes: this.bytes,
      audioDurationMs: (this.bytes / (STREAM_SAMPLE_RATE * 2)) * 1000,
      durationMs: Date.now() - this.startedAt,
    });
    this.relay?.post({
      type: 'close',
      initiator: reason === 'client_disconnected' ? 'client' : 'relay',
    });
    this.relayAlive = false;
    this.retireRelay();
  }
}
