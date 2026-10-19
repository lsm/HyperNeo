import { VOICE_MAX_AUDIO_BYTES, type VoiceMode, type VoiceSettings } from '@hyperneo/shared';
import superpipe, { type PipelineAPI } from 'superpipe';
import WebSocket from 'ws';
import type { ProviderCredentialManager } from '../credentials/provider-credential-manager.ts';
import { withVoiceCredentialLock } from '../rpc-handlers/voice-credential-lock.ts';
import { resolveTranscriptionEndpoint, withTimeout } from './transcribe-fetch.ts';
import { resolveApiKey, type VoiceTranscribeOutcome } from './transcribe-pipeline.ts';

const STREAM_SAMPLE_RATE = 16_000;
const CONNECT_TIMEOUT_MS = 5_000;
const START_TIMEOUT_MS = 8_000;
const CREDENTIAL_LOOKUP_TIMEOUT_MS = 16_000;
const SETTLE_QUIET_MS = 700;
const SETTLE_MAX_MS = 3_000;
const STREAM_PATH = /\/audio\/transcriptions\/?$/;

export interface VoiceStreamText {
  streamId: string;
  text: string;
  isFinal: boolean;
}

export interface VoiceStreamDeps {
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

export function voiceStreamUrl(voice: VoiceSettings): URL | null {
  let url: URL;
  try {
    url = new URL(voice.endpoint);
  } catch {
    return null;
  }
  if ((url.protocol !== 'https:' && url.protocol !== 'http:') || !STREAM_PATH.test(url.pathname))
    return null;
  url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
  url.pathname = url.pathname.replace(STREAM_PATH, '/audio/streaming_transcriptions');
  url.search = '';
  url.searchParams.set('model', voice.model.trim());
  return url;
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

export function asrText(raw: string): { text: string; isFinal: boolean } | null {
  try {
    const message = JSON.parse(raw) as { text?: unknown; is_final?: unknown };
    return typeof message.text === 'string'
      ? { text: message.text, isFinal: message.is_final === true }
      : null;
  } catch {
    return null;
  }
}

export function mergeAsrWindow(previous: string, next: string): string {
  const old = previous.split(/\s+/).filter(Boolean);
  const fresh = next.split(/\s+/).filter(Boolean);
  if (!old.length || !fresh.length) return (fresh.length ? fresh : old).join(' ');
  const key = (word: string) => word.toLowerCase().replace(/[^\p{L}\p{N}']/gu, '');
  const oldKeys = old.map(key);
  const freshKeys = fresh.map(key);
  for (let skip = 0; skip < fresh.length; skip++) {
    if (!freshKeys[skip]) continue;
    let best: { at: number; run: number } | null = null;
    for (let at = 0; at < oldKeys.length; at++) {
      let run = 0;
      while (
        at + run < oldKeys.length &&
        skip + run < freshKeys.length &&
        oldKeys[at + run] === freshKeys[skip + run]
      )
        run++;
      const toEnd = at + run === oldKeys.length;
      const wholeWindow = skip === 0 && run === freshKeys.length;
      const revised = at === 0 && skip === 0 && run >= 1 && freshKeys.length >= oldKeys.length;
      const fits = run >= 3 || revised || (toEnd && (run >= 2 || wholeWindow));
      if (fits && (!best || run >= best.run)) best = { at, run };
    }
    if (best) {
      const head = fresh[skip];
      const titleCase = /^\p{Lu}[^\p{Lu}]*$/u.test(head);
      const kept =
        best.at > 0 && titleCase && /^\p{Ll}/u.test(old[best.at]) ? head.toLowerCase() : head;
      return [...old.slice(0, best.at), kept, ...fresh.slice(skip + 1)].join(' ');
    }
  }
  return [...old, ...fresh].join(' ');
}

async function openAsrSocket(
  voice: VoiceSettings,
  url: URL,
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
    target.hostname = resolved.hostname;
    const pinned = target.hostname !== url.hostname;
    const tls = { ...voiceStreamTls(voice), ...(pinned ? { servername: url.hostname } : {}) };
    const socket = new WebSocket(target, {
      ...tls,
      tls: { ...tls, ...(pinned ? { serverName: url.hostname } : {}) },
      headers: {
        ...(pinned ? { Host: url.host } : {}),
        ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}),
      },
      handshakeTimeout: CONNECT_TIMEOUT_MS,
    } as WebSocket.ClientOptions);
    return await new Promise((resolve) => {
      socket.on('error', (error) => resolve({ reason: error?.message || 'connection failed' }));
      socket.once('open', () => resolve({ value: socket }));
    });
  } catch (error) {
    return { reason: error instanceof Error ? error.message : String(error) };
  }
}

async function openAsrSocketWithin(
  voice: VoiceSettings,
  url: URL,
  deps: VoiceStreamDeps
): Promise<Gate<WebSocket>> {
  const opening = openAsrSocket(voice, url, deps);
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
      if ('value' in late) late.value.close(1000);
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
      url: voiceMode(admitted) === 'batch' ? null : voiceStreamUrl(admitted),
    }),
    'plan',
    'plan'
  )
  .end('plan') as (
  voice: VoiceSettings | undefined
) => { voice: VoiceSettings; mode: VoiceMode; url: URL | null } | string;

export class VoiceStream {
  private readonly chunks: Uint8Array[] = [];
  private bytes = 0;
  private socket: WebSocket | null = null;
  private finals: string[] = [];
  private partial = '';
  private lastMessageAt = 0;
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
    if (typeof plan === 'string') return { error: plan };
    const stream = new VoiceStream(id, deps);
    if (!plan.url) {
      return plan.mode === 'streaming'
        ? { error: 'The voice endpoint has no streaming transcription route' }
        : {
            stream,
            via: 'batch',
            ...(plan.mode === 'auto' ? { fallback: 'no streaming route' } : {}),
          };
    }
    const opened = await openAsrSocketWithin(plan.voice, plan.url, deps);
    if ('reason' in opened)
      return plan.mode === 'streaming'
        ? { error: `Streaming transcription is unavailable: ${opened.reason}` }
        : { stream, via: 'batch', fallback: opened.reason };
    stream.attach(opened.value);
    return { stream, via: 'streaming' };
  }

  private attach(socket: WebSocket): void {
    this.socket = socket;
    socket.on('message', (data, isBinary) => {
      const parsed = isBinary ? null : asrText(data.toString());
      if (!parsed) return;
      this.lastMessageAt = Date.now();
      if (parsed.isFinal) {
        if (parsed.text.trim()) this.finals.push(parsed.text.trim());
        this.partial = '';
      } else this.partial = mergeAsrWindow(this.partial, parsed.text.trim());
      this.deps.push({ streamId: this.id, text: this.text(), isFinal: false });
    });
    socket.on('close', () => {
      if (this.socket === socket) this.socket = null;
    });
    socket.on('error', () => {
      if (this.socket === socket) this.socket = null;
    });
  }

  private text(): string {
    return [...this.finals, this.partial].filter(Boolean).join(' ');
  }

  write(pcm: Uint8Array): string | null {
    if (pcm.byteLength % 2 !== 0) return 'Voice chunks must be whole 16-bit samples';
    if (this.bytes + pcm.byteLength > VOICE_MAX_AUDIO_BYTES - 44)
      return 'Audio data exceeds the 10 MB voice input limit';
    this.chunks.push(pcm);
    this.bytes += pcm.byteLength;
    if (this.socket?.readyState === WebSocket.OPEN) this.socket.send(pcm);
    return null;
  }

  stop(): Promise<
    { text: string; via: 'streaming' | 'batch' } | { error: string; retryable?: true }
  > {
    this.stopping ??= this.finish().finally(() => {
      this.stopping = null;
    });
    return this.stopping;
  }

  private async finish(): Promise<
    { text: string; via: 'streaming' | 'batch' } | { error: string; retryable?: true }
  > {
    if (this.socket) {
      const started = Date.now();
      this.lastMessageAt = Math.max(this.lastMessageAt, started);
      while (
        this.socket &&
        Date.now() - this.lastMessageAt < SETTLE_QUIET_MS &&
        Date.now() - started < SETTLE_MAX_MS
      )
        await new Promise((resolve) => setTimeout(resolve, 50));
      if (this.socket) {
        const text = this.text();
        this.close();
        if (text || this.bytes === 0) {
          this.deps.push({ streamId: this.id, text, isFinal: true });
          return { text, via: 'streaming' };
        }
      }
    }
    if (this.bytes === 0) return { error: 'Audio data is empty' };
    const pcm = new Uint8Array(this.bytes);
    let offset = 0;
    for (const chunk of this.chunks) {
      pcm.set(chunk, offset);
      offset += chunk.byteLength;
    }
    const outcome = await this.deps.transcribeWav(Buffer.from(pcm16Wav(pcm)).toString('base64'));
    if (outcome.action !== 'transcribed')
      return {
        error: outcome.action === 'denied' ? outcome.message : outcome.error,
        retryable: true,
      };
    this.deps.push({ streamId: this.id, text: outcome.text, isFinal: true });
    return { text: outcome.text, via: 'batch' };
  }

  close(): void {
    const socket = this.socket;
    this.socket = null;
    socket?.close(1000);
  }
}
