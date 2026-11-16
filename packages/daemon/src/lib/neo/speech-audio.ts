import { Buffer } from 'node:buffer';
import { setTimeout as sleep } from 'node:timers/promises';
import superpipe, { type PipelineAPI } from 'superpipe';
import { Logger } from '../logger.ts';
import { voiceDiagnostic } from '../voice/diagnostics.ts';
import type { ClientEventData } from '../operations/client-event-schemas.ts';
type Target = { id: string; sessionId: string; clientId: string; text: string };
type SpeechRetry = { retryInMs: number } | { giveUp: string };
const SPEECH_DEADLINE_MS = 180_000;
const OPENAI_VOICES = [
  'alloy',
  'ash',
  'ballad',
  'coral',
  'echo',
  'fable',
  'nova',
  'onyx',
  'sage',
  'shimmer',
  'verse',
  'marin',
  'cedar',
];

export type SpeechPart = {
  provider?: 'openai' | 'deepgram';
  endpoint: string;
  model?: string;
  voice?: string;
  key?: string;
};
type SpeechBackend = { base?: string; part?: SpeechPart };

const retryAfterMs = (header: string | null, now: number): number | null => {
  if (header === null) return null;
  const seconds = Number(header);
  if (header.trim() && Number.isFinite(seconds)) return seconds * 1000;
  const date = Date.parse(header);
  return Number.isNaN(date) ? null : date - now;
};

export const planSpeechRetry = (superpipe({})('neo.speech.retry') as PipelineAPI)
  .input(['status', 'retryAfter', 'attempt', 'elapsedMs', 'now'])
  .pipe(
    (status: number) =>
      status === 503 || status === 429
        ? { value: status }
        : { reason: { giveUp: `upstream_http_${status}` } },
    'status',
    'result:plan'
  )
  .pipe(
    (retryAfter: string | null, attempt: number, now: number) =>
      Math.max(250, retryAfterMs(retryAfter, now) ?? Math.min(1000 * 2 ** attempt, 10_000)),
    ['retryAfter', 'attempt', 'now'],
    'delay'
  )
  .pipe(
    (delay: number, elapsedMs: number): SpeechRetry =>
      elapsedMs + delay < SPEECH_DEADLINE_MS
        ? { retryInMs: delay }
        : { giveUp: 'deadline_exceeded' },
    ['delay', 'elapsedMs'],
    'plan'
  )
  .end('plan') as (
  status: number,
  retryAfter: string | null,
  attempt: number,
  elapsedMs: number,
  now: number
) => SpeechRetry;

const authorization = (part?: SpeechPart): Record<string, string> =>
  part?.key
    ? { Authorization: `${part.provider === 'deepgram' ? 'Token' : 'Bearer'} ${part.key}` }
    : {};
const isDeepgram = (backend: SpeechBackend) => backend.part?.provider === 'deepgram';

export class NeoSpeechAudio {
  private readonly jobs = new Map<string, AbortController>();
  private serial: Promise<unknown> = Promise.resolve();

  constructor(
    private readonly send: (client: string, data: ClientEventData<'neo.speech'>) => boolean,
    private readonly failed: (target: Target) => Promise<unknown>,
    private readonly base = process.env.HYPERNEO_SPEECH_URL,
    private readonly request: typeof fetch = fetch,
    private readonly speechPart: () => Promise<SpeechPart | undefined> = async () => undefined
  ) {}

  private async backend(): Promise<SpeechBackend> {
    const part = await this.speechPart();
    return part ? { base: part.endpoint, part } : { base: this.base };
  }

  private url({ base, part }: SpeechBackend, path: string): URL {
    if (!base) throw new Error('speech_backend_not_configured');
    const address = base.replace(/\/$/, '') + path;
    const url = URL.canParse(address) ? new URL(address) : null;
    if (
      !url ||
      url.username ||
      url.password ||
      url.search ||
      url.hash ||
      !(
        url.protocol === 'https:' ||
        (url.protocol === 'http:' &&
          !part?.key &&
          ['localhost', '127.0.0.1'].includes(url.hostname))
      )
    )
      throw new Error('invalid_speech_backend');
    return url;
  }

  private speechRequest(backend: SpeechBackend, text: string, voice: string | undefined) {
    const part = backend.part;
    if (part?.provider === 'deepgram') {
      const url = this.url(backend, '/v1/speak');
      const model = voice ?? part.voice ?? part.model;
      if (model) url.searchParams.set('model', model);
      url.searchParams.set('encoding', 'linear16');
      url.searchParams.set('sample_rate', '24000');
      url.searchParams.set('container', 'none');
      return { url, body: { text } };
    }
    const spoken = voice ?? (part ? part.voice : 'vivian');
    return {
      url: this.url(backend, '/v1/audio/speech'),
      body: part
        ? {
            ...(part.model ? { model: part.model } : {}),
            input: text,
            ...(spoken ? { voice: spoken } : {}),
            response_format: 'pcm',
          }
        : { input: text, voice: spoken, language: 'auto', response_format: 'pcm' },
    };
  }

  async catalog(): Promise<{ ok: true; catalog: unknown } | { ok: false; reason: string }> {
    const signal = AbortSignal.timeout(10_000);
    try {
      const backend = await this.backend();
      const path = isDeepgram(backend) ? '/v1/models' : '/v1/audio/voices';
      const response = await this.request(this.url(backend, path), {
        signal,
        redirect: 'error',
        headers: authorization(backend.part),
      }).catch((error) => {
        if (backend.part && !isDeepgram(backend)) return null;
        if (
          error instanceof TypeError ||
          (error instanceof DOMException && ['TimeoutError', 'AbortError'].includes(error.name))
        )
          throw new Error('speech_backend_unavailable');
        throw error;
      });
      if (backend.part && !isDeepgram(backend) && !response?.ok)
        return { ok: true, catalog: { data: OPENAI_VOICES.map((id) => ({ id })) } };
      if (!response?.ok) throw new Error('speech_backend_unavailable');
      if (!isDeepgram(backend)) return { ok: true, catalog: await response.json() };
      const models = (await response.json()) as { tts?: { canonical_name?: string }[] };
      const data = (models.tts ?? []).flatMap((m) =>
        m.canonical_name ? [{ id: m.canonical_name }] : []
      );
      return { ok: true, catalog: { data } };
    } catch (error) {
      if (signal.aborted) return { ok: false, reason: 'speech_backend_unavailable' };
      if (
        error instanceof Error &&
        [
          'speech_backend_not_configured',
          'speech_backend_unavailable',
          'invalid_speech_backend',
        ].includes(error.message)
      )
        return { ok: false, reason: error.message };
      throw error;
    }
  }

  start(target: Target, voice: string | undefined): void {
    const timing = { speechId: target.id, sessionId: target.sessionId, clientId: target.clientId };
    voiceDiagnostic('voice.tts.queued', { ...timing, atMs: Date.now() });
    const controller = new AbortController();
    this.jobs.set(target.id, controller);
    const queuedAt = Date.now();
    const fault = { reason: 'upstream_or_audio_error', status: null as number | null };
    const expires = setTimeout(() => controller.abort(), SPEECH_DEADLINE_MS);
    const job = this.serial
      .then(async () => {
        controller.signal.throwIfAborted();
        voiceDiagnostic('voice.tts.request_started', { ...timing, atMs: Date.now() });
        const backend = await this.backend();
        const speech = this.speechRequest(backend, target.text, voice);
        const synthesize = () =>
          this.request(speech.url, {
            method: 'POST',
            signal: controller.signal,
            redirect: 'error',
            headers: { 'Content-Type': 'application/json', ...authorization(backend.part) },
            body: JSON.stringify(speech.body),
          });
        let response = await synthesize();
        for (let attempt = 0; !response.ok; attempt++) {
          fault.status = response.status;
          await response.body?.cancel().catch(() => {});
          const plan = planSpeechRetry(
            response.status,
            response.headers.get('retry-after'),
            attempt,
            Date.now() - queuedAt,
            Date.now()
          );
          if ('giveUp' in plan) throw new Error((fault.reason = plan.giveUp));
          voiceDiagnostic('voice.tts.retry', { ...timing, status: fault.status, ...plan, attempt });
          await sleep(plan.retryInMs, undefined, { signal: controller.signal });
          response = await synthesize();
        }
        fault.status = response.status;
        const type = response.headers.get('content-type') ?? '';
        if (
          !response.ok ||
          !type.startsWith(isDeepgram(backend) ? 'audio/l16' : 'audio/pcm') ||
          !response.body
        )
          throw new Error('speech_backend_unavailable');
        const reader = response.body.getReader();
        let bytes = 0,
          seq = 0;
        let head: Uint8Array | null = new Uint8Array(0);
        try {
          while (true) {
            const read = await reader.read();
            if (!read.done) controller.signal.throwIfAborted();
            let value: Uint8Array = read.value ?? new Uint8Array(0);
            if (head) {
              value = Buffer.concat([head, value]);
              if (value.byteLength < 4 && !read.done) {
                head = value;
                continue;
              }
              head = null;
              if (Buffer.from(value.subarray(0, 4)).toString('latin1') === 'RIFF')
                throw new Error('invalid_speech_audio');
            }
            if (!value.byteLength) {
              if (read.done) break;
              continue;
            }
            if (!bytes) voiceDiagnostic('voice.tts.first_chunk', { ...timing, atMs: Date.now() });
            bytes += value.byteLength;
            if (bytes > 5_760_000) throw new Error('speech_audio_too_long');
            for (let offset = 0; offset < value.length; offset += 3840) {
              if (
                !this.send(target.clientId, {
                  type: 'audio',
                  id: target.id,
                  sessionId: target.sessionId,
                  seq: seq++,
                  pcm: Buffer.from(value.subarray(offset, offset + 3840)).toString('base64'),
                })
              )
                throw new Error('speech_client_disconnected');
              if (seq === 1)
                voiceDiagnostic('voice.tts.first_chunk_sent', { ...timing, atMs: Date.now() });
            }
            if (read.done) break;
          }
          if (!bytes || bytes % 2) throw new Error('invalid_speech_audio');
          if (
            !this.send(target.clientId, {
              type: 'end',
              id: target.id,
              sessionId: target.sessionId,
              seq,
            })
          )
            throw new Error('speech_client_disconnected');
          voiceDiagnostic('voice.tts.finished', { ...timing, atMs: Date.now() });
        } finally {
          await reader.cancel().catch(() => {});
        }
      })
      .catch(async () => {
        if (!this.jobs.has(target.id)) return;
        if (controller.signal.aborted) fault.reason = 'deadline_exceeded';
        voiceDiagnostic('voice.tts.failed', { ...timing, ...fault, atMs: Date.now() });
        new Logger('NeoSpeechAudio').warn('Speech synthesis failed', { id: target.id, ...fault });
        this.send(target.clientId, { type: 'failed', id: target.id, sessionId: target.sessionId });
        await this.failed(target);
      })
      .finally(() => {
        clearTimeout(expires);
        this.jobs.delete(target.id);
      });
    this.serial = job.catch(() => {});
  }

  cancel(id: string): void {
    this.jobs.get(id)?.abort();
    this.jobs.delete(id);
  }

  async dispose(): Promise<void> {
    for (const id of this.jobs.keys()) this.cancel(id);
    await this.serial;
  }
}
