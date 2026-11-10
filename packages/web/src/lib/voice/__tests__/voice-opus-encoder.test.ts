import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  createVoiceOpusEncoder,
  selectVoiceEncoding,
  supportsVoiceOpus,
} from '../voice-opus-encoder.ts';

afterEach(() => vi.unstubAllGlobals());

describe('voice Opus encoding', () => {
  it('selects Opus only when the browser reports the required configuration', () => {
    expect(selectVoiceEncoding(true, true)).toBe('opus');
    expect(selectVoiceEncoding(false, false)).toBe('pcm16');
    expect(selectVoiceEncoding(true, false)).toBe('pcm16');
  });

  it('rejects support reports that omit the raw packet or frame-duration contract', () => {
    const config = {
      codec: 'opus',
      sampleRate: 16_000,
      numberOfChannels: 1,
      opus: { format: 'opus' as const, frameDuration: 20_000 },
    };
    expect(supportsVoiceOpus({ supported: true, config })).toBe(true);
    expect(supportsVoiceOpus({ supported: true, config: { ...config, opus: undefined } })).toBe(
      false
    );
    expect(supportsVoiceOpus({ supported: true, config: { ...config, sampleRate: 48_000 } })).toBe(
      false
    );
  });

  it('returns an explicit unavailable result when WebCodecs is absent', async () => {
    vi.stubGlobal('AudioEncoder', undefined);
    expect(await createVoiceOpusEncoder(vi.fn(), vi.fn())).toBeNull();
  });

  it('frames packets and flushes a partial frame plus encoder lookahead', async () => {
    const frames: number[][] = [];
    let closeCount = 0;
    class FakeAudioData {
      data: Float32Array;
      constructor(init: { data: Float32Array }) {
        this.data = init.data;
      }
      close() {}
    }
    class FakeAudioEncoder {
      static async isConfigSupported(config: AudioEncoderConfig) {
        return { supported: true, config };
      }
      state = 'configured';
      encodeQueueSize = 0;
      constructor(
        private init: { output(chunk: { byteLength: number; copyTo(out: Uint8Array): void }): void }
      ) {}
      configure() {}
      encode(data: FakeAudioData) {
        frames.push(Array.from(data.data));
        this.init.output({ byteLength: 3, copyTo: (out) => out.set([0xf8, 0xff, 0xfe]) });
      }
      async flush() {}
      close() {
        this.state = 'closed';
        closeCount++;
      }
    }
    vi.stubGlobal('AudioData', FakeAudioData);
    vi.stubGlobal('AudioEncoder', FakeAudioEncoder);
    const packets: Uint8Array[] = [];
    const encoder = await createVoiceOpusEncoder((packet) => packets.push(packet), vi.fn());
    expect(encoder).not.toBeNull();
    encoder!.push(new Float32Array(400).fill(0.5));
    await encoder!.finish();
    expect(frames.map((frame) => frame.length)).toEqual([320, 320, 320]);
    expect(frames[1].slice(0, 80)).toEqual(Array(80).fill(0.5));
    expect(frames[1].slice(80)).toEqual(Array(240).fill(0));
    expect(frames[2]).toEqual(Array(320).fill(0));
    expect(packets.map((packet) => [...packet])).toEqual(Array(3).fill([3, 0, 0xf8, 0xff, 0xfe]));
    expect(closeCount).toBe(1);
  });

  it('does not convert a codec initialization error into fallback', async () => {
    class BrokenAudioEncoder {
      static async isConfigSupported() {
        throw new Error('codec probe failed');
      }
    }
    vi.stubGlobal('AudioData', class {});
    vi.stubGlobal('AudioEncoder', BrokenAudioEncoder);
    await expect(createVoiceOpusEncoder(vi.fn(), vi.fn())).rejects.toThrow('codec probe failed');
  });

  it('reports an asynchronous encoder error and rejects finish', async () => {
    let reportError: (error: Error) => void = () => {};
    class FakeAudioEncoder {
      static async isConfigSupported(config: AudioEncoderConfig) {
        return { supported: true, config };
      }
      state = 'configured';
      constructor(init: { error(error: Error): void }) {
        reportError = init.error;
      }
      configure() {}
      close() {
        this.state = 'closed';
      }
    }
    vi.stubGlobal('AudioData', class {});
    vi.stubGlobal('AudioEncoder', FakeAudioEncoder);
    const onError = vi.fn();
    const encoder = await createVoiceOpusEncoder(vi.fn(), onError);
    reportError(new Error('codec failed'));
    expect(onError).toHaveBeenCalledWith(expect.objectContaining({ message: 'codec failed' }));
    await expect(encoder!.finish()).rejects.toThrow('codec failed');
  });
});
