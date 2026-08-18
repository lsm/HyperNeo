export interface WavEncodingOptions {
  sampleRate: number;
  samples: Float32Array;
}

export function encodeWav({ sampleRate, samples }: WavEncodingOptions): Uint8Array {
  const dataSize = samples.length * 2;
  const buffer = new ArrayBuffer(44 + dataSize);
  const view = new DataView(buffer);

  writeAscii(view, 0, 'RIFF');
  view.setUint32(4, 36 + dataSize, true);
  writeAscii(view, 8, 'WAVE');
  writeAscii(view, 12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  writeAscii(view, 36, 'data');
  view.setUint32(40, dataSize, true);

  let offset = 44;
  for (const sample of samples) {
    const clamped = Math.max(-1, Math.min(1, sample));
    view.setInt16(offset, clamped < 0 ? clamped * 0x8000 : clamped * 0x7fff, true);
    offset += 2;
  }

  return new Uint8Array(buffer);
}

export function downsampleMono(
  input: Float32Array,
  inputRate: number,
  outputRate: number
): Float32Array {
  if (outputRate === inputRate) return input;
  if (outputRate > inputRate) throw new Error('Output sample rate must be <= input sample rate');

  const ratio = inputRate / outputRate;
  const outputLength = Math.floor(input.length / ratio);
  const output = new Float32Array(outputLength);

  for (let index = 0; index < outputLength; index++) {
    const start = Math.floor(index * ratio);
    const end = Math.min(Math.floor((index + 1) * ratio), input.length);
    let sum = 0;
    for (let inputIndex = start; inputIndex < end; inputIndex++) sum += input[inputIndex];
    output[index] = sum / Math.max(1, end - start);
  }

  return output;
}

export function downsampleChunks(
  chunks: Float32Array[],
  totalSamples: number,
  inputRate: number,
  outputRate: number
): Float32Array {
  if (outputRate > inputRate) throw new Error('Output sample rate must be <= input sample rate');
  if (chunks.length === 1) return downsampleMono(chunks[0], inputRate, outputRate);
  if (outputRate === inputRate) {
    const joined = new Float32Array(totalSamples);
    let offset = 0;
    for (const chunk of chunks) {
      joined.set(chunk, offset);
      offset += chunk.length;
    }
    return joined;
  }

  const ratio = inputRate / outputRate;
  const outputLength = Math.floor(totalSamples / ratio);
  const output = new Float32Array(outputLength);
  let chunkIndex = 0;
  let chunkBase = 0;
  let i = 0;

  for (let index = 0; index < outputLength; index++) {
    const end = Math.min(Math.floor((index + 1) * ratio), totalSamples);
    const start = i;
    let sum = 0;
    while (i < end) {
      while (chunkIndex < chunks.length - 1 && i >= chunkBase + chunks[chunkIndex].length) {
        chunkBase += chunks[chunkIndex].length;
        chunkIndex += 1;
      }
      const chunk = chunks[chunkIndex];
      const localStart = i - chunkBase;
      const take = Math.min(end - i, chunk.length - localStart);
      for (let k = localStart; k < localStart + take; k++) sum += chunk[k];
      i += take;
    }
    output[index] = sum / Math.max(1, end - start);
  }

  return output;
}

export function bytesToBase64(bytes: Uint8Array): string {
  const CHUNK = 0x8000;
  const parts: string[] = [];
  for (let i = 0; i < bytes.length; i += CHUNK) {
    const slice = bytes.subarray(i, Math.min(i + CHUNK, bytes.length));
    parts.push(String.fromCharCode(...slice));
  }
  return btoa(parts.join(''));
}

function writeAscii(view: DataView, offset: number, value: string): void {
  for (let index = 0; index < value.length; index++) {
    view.setUint8(offset + index, value.charCodeAt(index));
  }
}
