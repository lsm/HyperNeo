import { createOpusPackets } from './opus-packets.ts';

const worker = globalThis as unknown as {
  onmessage(event: { data: { id: number; audio?: Uint8Array } }): void;
  postMessage(value: unknown): void;
};
const ready = createOpusPackets();
worker.onmessage = async ({ data }) => {
  try {
    const codec = await ready;
    const value = data.audio
      ? await codec.decode(data.audio)
      : { pcm: new Uint8Array(0), partial: false };
    worker.postMessage({ id: data.id, value });
  } catch (error) {
    worker.postMessage({
      id: data.id,
      error: error instanceof Error ? error.message : String(error),
      code: data.audio ? 'VOICE_STREAM_INVALID_OPUS' : 'VOICE_STREAM_DECODER_FAILED',
    });
  }
};
