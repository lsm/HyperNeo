const SAMPLE_RATE = 16_000;
const FRAME_SAMPLES = 320;
const FRAME_DURATION_US = 20_000;
const MAX_PACKET_BYTES = 1_275;
const MAX_QUEUE_FRAMES = 250;

const OPUS_CONFIG: AudioEncoderConfig = {
  codec: 'opus',
  sampleRate: SAMPLE_RATE,
  numberOfChannels: 1,
  bitrate: 24_000,
  bitrateMode: 'constant',
  opus: { format: 'opus', frameDuration: FRAME_DURATION_US },
};

export type VoiceEncoding = 'opus' | 'pcm16';

export function selectVoiceEncoding(
  encoderAvailable: boolean,
  configSupported: boolean
): VoiceEncoding {
  return encoderAvailable && configSupported ? 'opus' : 'pcm16';
}

export function supportsVoiceOpus(support: AudioEncoderSupport): boolean {
  const config = support.config;
  return (
    support.supported === true &&
    config?.codec === 'opus' &&
    config.sampleRate === SAMPLE_RATE &&
    config.numberOfChannels === 1 &&
    config.opus?.format === 'opus' &&
    config.opus.frameDuration === FRAME_DURATION_US
  );
}

export interface VoiceOpusEncoder {
  push(samples: Float32Array): void;
  finish(): Promise<void>;
  close(): void;
}

export async function createVoiceOpusEncoder(
  onPacket: (packet: Uint8Array) => void,
  onError: (error: Error) => void
): Promise<VoiceOpusEncoder | null> {
  const available = typeof AudioEncoder !== 'undefined' && typeof AudioData !== 'undefined';
  if (!available) return null;
  const support = await AudioEncoder.isConfigSupported(OPUS_CONFIG);
  if (selectVoiceEncoding(available, supportsVoiceOpus(support)) === 'pcm16') return null;

  let pending = new Float32Array(FRAME_SAMPLES);
  let filled = 0;
  let frameCount = 0;
  let closed = false;
  let failure: Error | null = null;
  let finishing: Promise<void> | null = null;
  const fail = (cause: unknown) => {
    if (failure || closed) return;
    failure = cause instanceof Error ? cause : new Error(String(cause));
    onError(failure);
  };
  const encoder = new AudioEncoder({
    output(chunk) {
      if (closed || failure) return;
      try {
        if (chunk.byteLength < 1 || chunk.byteLength > MAX_PACKET_BYTES)
          throw new Error('Invalid Opus packet length');
        const packet = new Uint8Array(chunk.byteLength + 2);
        new DataView(packet.buffer).setUint16(0, chunk.byteLength, true);
        chunk.copyTo(packet.subarray(2));
        onPacket(packet);
      } catch (error) {
        fail(error);
      }
    },
    error: fail,
  });
  try {
    encoder.configure(OPUS_CONFIG);
  } catch (error) {
    encoder.close();
    throw error;
  }

  const close = () => {
    if (closed) return;
    closed = true;
    if (encoder.state !== 'closed') encoder.close();
  };
  const assertOpen = () => {
    if (failure) throw failure;
    if (closed) throw new Error('Opus encoder is closed');
  };
  const encodeFrame = () => {
    assertOpen();
    if (encoder.encodeQueueSize >= MAX_QUEUE_FRAMES) throw new Error('Opus encoder queue is full');
    const data = new AudioData({
      format: 'f32-planar',
      sampleRate: SAMPLE_RATE,
      numberOfFrames: FRAME_SAMPLES,
      numberOfChannels: 1,
      timestamp: frameCount * FRAME_DURATION_US,
      data: pending,
    });
    try {
      encoder.encode(data);
    } finally {
      data.close();
    }
    frameCount++;
    pending = new Float32Array(FRAME_SAMPLES);
    filled = 0;
  };

  return {
    push(samples) {
      assertOpen();
      if (finishing) throw new Error('Opus encoder is finishing');
      let offset = 0;
      while (offset < samples.length) {
        const count = Math.min(FRAME_SAMPLES - filled, samples.length - offset);
        pending.set(samples.subarray(offset, offset + count), filled);
        filled += count;
        offset += count;
        if (filled === FRAME_SAMPLES) encodeFrame();
      }
    },
    finish() {
      finishing ??= (async () => {
        try {
          assertOpen();
          if (filled) encodeFrame();
          if (frameCount) encodeFrame();
          await encoder.flush();
          if (failure) throw failure;
        } finally {
          close();
        }
      })();
      return finishing;
    },
    close,
  };
}
