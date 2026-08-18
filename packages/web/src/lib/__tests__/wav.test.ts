import { describe, expect, it } from 'vitest';
import { bytesToBase64, downsampleChunks, downsampleMono, encodeWav } from '../wav.ts';

describe('wav utilities', () => {
  it('encodes mono pcm samples as a 16-bit wav', () => {
    const wav = encodeWav({ sampleRate: 16_000, samples: new Float32Array([-1, 0, 1]) });
    const view = new DataView(wav.buffer);

    expect(String.fromCharCode(...wav.slice(0, 4))).toBe('RIFF');
    expect(String.fromCharCode(...wav.slice(8, 12))).toBe('WAVE');
    expect(view.getUint16(22, true)).toBe(1);
    expect(view.getUint32(24, true)).toBe(16_000);
    expect(view.getUint16(34, true)).toBe(16);
    expect(view.getUint32(40, true)).toBe(6);
    expect(view.getInt16(44, true)).toBe(-32768);
    expect(view.getInt16(46, true)).toBe(0);
    expect(view.getInt16(48, true)).toBe(32767);
  });

  it('downsamples mono audio by averaging source samples', () => {
    const output = downsampleMono(new Float32Array([1, 3, 5, 7]), 4, 2);

    expect([...output]).toEqual([2, 6]);
  });

  it('downsampleChunks matches downsampleMono on the concatenated signal', () => {
    const total = 10_000;
    const full = new Float32Array(total);
    for (let i = 0; i < total; i++) full[i] = Math.sin(i / 7) * 0.8;
    const sizes = [1, 3, 1024, 17, 4096, 2, 1000, 857, 3000];
    const chunks: Float32Array[] = [];
    let offset = 0;
    for (const size of sizes) {
      chunks.push(full.subarray(offset, Math.min(offset + size, total)).slice());
      offset += size;
      if (offset >= total) break;
    }
    if (offset < total) chunks.push(full.subarray(offset).slice());
    const joined = chunks.reduce((n, c) => n + c.length, 0);
    expect(joined).toBe(total);

    for (const [from, to] of [
      [48_000, 16_000],
      [44_100, 16_000],
      [16_000, 16_000],
    ] as const) {
      const expected = downsampleMono(full, from, to);
      const actual = downsampleChunks(chunks, total, from, to);
      expect(actual.length).toBe(expected.length);
      for (let i = 0; i < expected.length; i++) {
        expect(Math.abs(actual[i] - expected[i])).toBeLessThan(1e-6);
      }
    }
  });

  it('converts bytes to base64', () => {
    expect(bytesToBase64(new Uint8Array([104, 105]))).toBe('aGk=');
  });

  it('encodes multi-chunk payloads as valid base64 (no mid-string padding)', () => {
    const input = new Uint8Array(40_000);
    for (let i = 0; i < input.length; i++) input[i] = (i * 7 + 3) % 251;
    const encoded = bytesToBase64(input);
    expect(/^[A-Za-z0-9+/]*={0,2}$/.test(encoded)).toBe(true);
    expect(encoded.length % 4).toBe(0);
    const decoded = Uint8Array.from(atob(encoded), (c) => c.charCodeAt(0));
    expect(decoded.length).toBe(input.length);
    expect(decoded.every((b, i) => b === input[i])).toBe(true);
  });
});
