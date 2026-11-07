import { Buffer } from 'node:buffer';
import { setTimeout as sleep } from 'node:timers/promises';
import superpipe, { type PipelineAPI } from 'superpipe';
import { Logger } from '../logger.ts';
import { voiceDiagnostic } from '../voice/diagnostics.ts';
import type { ClientEventData } from '../operations/client-event-schemas.ts';
type Target = { id: string; sessionId: string; clientId: string; text: string };
type SpeechRetry = { retryInMs: number } | { giveUp: string };
const SPEECH_DEADLINE_MS = 180_000;

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

export class NeoSpeechAudio {
  private readonly jobs = new Map<string, AbortController>();
  private serial: Promise<unknown> = Promise.resolve();

  constructor(
    private readonly send: (client: string, data: ClientEventData<'neo.speech'>) => boolean,
    private readonly failed: (target: Target) => Promise<unknown>,
    private readonly base = process.env.HYPERNEO_SPEECH_URL,
    private readonly request: typeof fetch = fetch
  ) {}

  private url(path: string): URL {
    if (!this.base) throw new Error('speech_backend_not_configured');
    const address = this.base.replace(/\/$/, '') + path;
    const url = URL.canParse(address) ? new URL(address) : null;
    if (
      !url ||
      url.username ||
      url.password ||
      url.search ||
      url.hash ||
      !(
        url.protocol === 'https:' ||
        (url.protocol === 'http:' && ['localhost', '127.0.0.1'].includes(url.hostname))
      )
    )
      throw new Error('invalid_speech_backend');
    return url;
  }

  async catalog(): Promise<{ ok: true; catalog: unknown } | { ok: false; reason: string }> {
    const signal = AbortSignal.timeout(10_000);
    try {
      const response = await this.request(this.url('/v1/audio/voices'), {
        signal,
        redirect: 'error',
      }).catch((error) => {
        if (
          error instanceof TypeError ||
          (error instanceof DOMException && ['TimeoutError', 'AbortError'].includes(error.name))
        )
          throw new Error('speech_backend_unavailable');
        throw error;
      });
      if (!response.ok) throw new Error('speech_backend_unavailable');
      return { ok: true, catalog: await response.json() };
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

  start(target: Target, voice: string): void {
    const timing = { speechId: target.id, sessionId: target.sessionId, clientId: target.clientId };
    voiceDiagnostic('voice.tts.queued', { ...timing, atMs: Date.now() });
    const controller = new AbortController();
    this.jobs.set(target.id, controller);
    const queuedAt = Date.now();
    const failure = { reason: 'upstream_or_audio_error', status: null as number | null };
    const expires = setTimeout(() => controller.abort(), SPEECH_DEADLINE_MS);
    const job = this.serial
      .then(async () => {
        controller.signal.throwIfAborted();
        voiceDiagnostic('voice.tts.request_started', { ...timing, atMs: Date.now() });
        const synthesize = () =>
          this.request(this.url('/v1/audio/speech'), {
            method: 'POST',
            signal: controller.signal,
            redirect: 'error',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              input: target.text,
              voice,
              language: 'auto',
              response_format: 'pcm',
            }),
          });
        let response = await synthesize();
        for (let attempt = 0; !response.ok; attempt++) {
          failure.status = response.status;
          await response.body?.cancel().catch(() => {});
          const plan = planSpeechRetry(
            response.status,
            response.headers.get('retry-after'),
            attempt,
            Date.now() - queuedAt,
            Date.now()
          );
          if ('giveUp' in plan) throw new Error((failure.reason = plan.giveUp));
          await sleep(plan.retryInMs, undefined, { signal: controller.signal });
          response = await synthesize();
        }
        failure.status = response.status;
        if (
          !response.ok ||
          !response.headers.get('content-type')?.startsWith('audio/pcm') ||
          !response.body
        )
          throw new Error('speech_backend_unavailable');
        const reader = response.body.getReader();
        let bytes = 0,
          seq = 0;
        try {
          while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            controller.signal.throwIfAborted();
            if (!bytes && value.byteLength)
              voiceDiagnostic('voice.tts.first_chunk', { ...timing, atMs: Date.now() });
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
        const reason = controller.signal.aborted ? 'deadline_exceeded' : failure.reason;
        voiceDiagnostic('voice.tts.failed', { ...timing, ...failure, reason, atMs: Date.now() });
        new Logger('NeoSpeechAudio').warn('Speech synthesis failed', {
          id: target.id,
          ...failure,
          reason,
        });
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
