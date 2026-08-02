import { describe, expect, it } from 'vitest';
import { bytesToBase64, downsampleMono, encodeWav } from '../wav.ts';

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

  it('converts bytes to base64', () => {
    expect(bytesToBase64(new Uint8Array([104, 105]))).toBe('aGk=');
  });
});
