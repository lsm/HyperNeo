import { createDecoder, getPacketInfo, type OpusDecoderHandle } from 'libopus-wasm';
import { VOICE_MAX_AUDIO_BYTES } from '@hyperneo/shared';
import superpipe, { type PipelineAPI } from 'superpipe';
import type { OpusInput } from './opus-input.ts';

const decodePacket = (superpipe({})('voice-opus-packet') as PipelineAPI)
  .input(['packet', 'decoder', 'decodedBytes'])
  .pipe(
    async (packet: Uint8Array, decodedBytes: number) => {
      const info = await getPacketInfo(packet, { sampleRate: 16_000 });
      if (info.channels !== 1 || info.samples !== 320)
        return { reason: 'Opus packets must decode to 20 ms of mono audio' };
      if (decodedBytes + 640 > VOICE_MAX_AUDIO_BYTES - 44)
        return { reason: 'Audio data exceeds the 10 MB voice input limit' };
      return { value: packet };
    },
    ['packet', 'decodedBytes'],
    'result:packet'
  )
  .pipe(
    (packet: Uint8Array, decoder: OpusDecoderHandle) => decoder.decode(packet),
    ['packet', 'decoder'],
    'pcm'
  )
  .endAsync('pcm') as (
  packet: Uint8Array,
  decoder: OpusDecoderHandle,
  decodedBytes: number
) => Promise<Int16Array | string>;

export async function createOpusPackets(): Promise<OpusInput> {
  const decoder = await createDecoder({ sampleRate: 16_000, channels: 1, maxFrameSize: 320 });
  let pending = new Uint8Array(0);
  let decodedBytes = 0;
  return {
    decode: async (audio) => {
      const bytes = new Uint8Array(pending.length + audio.length);
      bytes.set(pending);
      bytes.set(audio, pending.length);
      const chunks: Uint8Array[] = [];
      let at = 0;
      let size = 0;
      while (at + 2 <= bytes.length) {
        const length = bytes[at] | (bytes[at + 1] << 8);
        if (!length || length > 1275)
          throw new Error('Opus packet length must be between 1 and 1275 bytes');
        if (at + 2 + length > bytes.length) break;
        const samples = await decodePacket(
          bytes.subarray(at + 2, at + 2 + length),
          decoder,
          decodedBytes
        );
        if (typeof samples === 'string') throw new Error(samples);
        const pcm = new Uint8Array(samples.byteLength);
        const view = new DataView(pcm.buffer);
        for (let index = 0; index < samples.length; index++)
          view.setInt16(index * 2, samples[index], true);
        chunks.push(pcm);
        size += pcm.length;
        decodedBytes += pcm.length;
        at += 2 + length;
      }
      pending = bytes.slice(at);
      const pcm = new Uint8Array(size);
      let offset = 0;
      for (const chunk of chunks) {
        pcm.set(chunk, offset);
        offset += chunk.length;
      }
      return { pcm, partial: pending.length > 0 };
    },
    close: () => decoder.free(),
  };
}
