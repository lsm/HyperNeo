import { Buffer } from 'node:buffer';
import { Logger } from '../logger.ts';
type Target = { id: string; sessionId: string; clientId: string; text: string };

export class NeoSpeechAudio {
  private readonly jobs = new Map<string, AbortController>();
  private serial: Promise<unknown> = Promise.resolve();

  constructor(
    private readonly send: (client: string, data: unknown) => boolean,
    private readonly failed: (target: Target) => Promise<unknown>,
    private readonly base = process.env.HYPERNEO_SPEECH_URL,
    private readonly request: typeof fetch = fetch
  ) {}

  private url(path: string): URL {
    if (!this.base) throw new Error('speech_backend_not_configured');
    const url = new URL(this.base.replace(/\/$/, '') + path);
    if (
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
    const controller = new AbortController();
    this.jobs.set(target.id, controller);
    const expires = setTimeout(() => controller.abort(), 180_000);
    const job = this.serial
      .then(async () => {
        controller.signal.throwIfAborted();
        const response = await this.request(this.url('/v1/audio/speech'), {
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
        } finally {
          await reader.cancel().catch(() => {});
        }
      })
      .catch(async () => {
        if (!this.jobs.has(target.id)) return;
        new Logger('NeoSpeechAudio').warn('Speech synthesis failed', {
          id: target.id,
          reason: controller.signal.aborted ? 'deadline_exceeded' : 'upstream_or_audio_error',
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
