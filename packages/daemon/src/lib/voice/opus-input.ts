import { MessageHubHandlerError } from '@hyperneo/shared';
import { runtimeWorkerUrl } from '../runtime-worker-url.ts';

export interface OpusDecoded {
  pcm: Uint8Array;
  partial: boolean;
}
export interface OpusInput {
  decode(audio: Uint8Array): Promise<OpusDecoded>;
  close(): void;
}
export const opusInputDefaults = { create: createThreadedOpusInput };

type Awaiting = {
  resolve(value: OpusDecoded): void;
  reject(error: Error): void;
  timer: ReturnType<typeof setTimeout>;
};

async function createThreadedOpusInput(): Promise<OpusInput> {
  const worker = new Worker(
    runtimeWorkerUrl(
      './opus-input-worker.ts',
      './daemon/src/lib/voice/opus-input-worker.ts',
      import.meta.url
    ).toString(),
    { type: 'module' }
  );
  const pending = new Map<number, Awaiting>();
  let sequence = 0;
  let closed = false;
  const close = () => {
    if (closed) return;
    closed = true;
    for (const entry of pending.values()) {
      clearTimeout(entry.timer);
      entry.reject(
        new MessageHubHandlerError('Opus decoder closed', 'VOICE_STREAM_DECODER_FAILED')
      );
    }
    pending.clear();
    worker.terminate();
  };
  worker.onmessage = ({ data }) => {
    const entry = pending.get(data.id);
    if (!entry) return;
    pending.delete(data.id);
    clearTimeout(entry.timer);
    if (data.error) entry.reject(new MessageHubHandlerError(data.error, data.code));
    else entry.resolve(data.value);
  };
  worker.onerror = close;
  (worker as Worker & { onexit?: () => void }).onexit = close;
  const request = (audio?: Uint8Array) =>
    new Promise<OpusDecoded>((resolve, reject) => {
      if (closed)
        throw new MessageHubHandlerError('Opus decoder closed', 'VOICE_STREAM_DECODER_FAILED');
      const id = ++sequence;
      pending.set(id, { resolve, reject, timer: setTimeout(close, 8000) });
      worker.postMessage({ id, audio });
    });
  await request().catch((error) => {
    close();
    throw error;
  });
  return { decode: request, close };
}
