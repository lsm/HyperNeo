import { Application, createDecoder, createEncoder } from 'libopus-wasm';

export async function opusFixture(frames = 50) {
  const encoder = await createEncoder({
    sampleRate: 16_000,
    channels: 1,
    frameSize: 320,
    bitrate: 24_000,
    vbr: false,
    application: Application.Voip,
  });
  const decoder = await createDecoder({ sampleRate: 16_000, channels: 1 });
  const encoded: Buffer[] = [];
  const decoded: Buffer[] = [];
  const boundaries = [0];
  try {
    for (let frame = 0; frame < frames; frame++) {
      const samples = Int16Array.from({ length: 320 }, (_, index) =>
        Math.round(9000 * Math.sin(((frame * 320 + index) * 2 * Math.PI * 440) / 16_000))
      );
      const packet = encoder.encode(samples);
      const prefix = Buffer.alloc(2);
      prefix.writeUInt16LE(packet.byteLength);
      encoded.push(prefix, Buffer.from(packet));
      boundaries.push(boundaries.at(-1)! + packet.byteLength + 2);
      decoded.push(Buffer.from(decoder.decode(packet).buffer));
    }
    return { encoded: Buffer.concat(encoded), pcm: Buffer.concat(decoded), boundaries };
  } finally {
    encoder.free();
    decoder.free();
  }
}
