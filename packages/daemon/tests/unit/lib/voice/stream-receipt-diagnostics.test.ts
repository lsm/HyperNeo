import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { type StructuredLogEvent, subscribeToStructuredLogs } from '@hyperneo/shared';
import { VoiceStream } from '../../../../src/lib/voice/stream-relay.ts';
import { opusInputDefaults } from '../../../../src/lib/voice/opus-input.ts';

describe('VoiceStream receipt diagnostics', () => {
  let logs: StructuredLogEvent[];
  let unsubscribe: () => void;
  let stream: VoiceStream;

  beforeEach(async () => {
    logs = [];
    unsubscribe = subscribeToStructuredLogs((event) => {
      if (event.module === 'hyperneo:daemon:voice') logs.push(event);
    });
    const started = await VoiceStream.start('receipt-fixture', {
      voice: () => ({ enabled: true, endpoint: 'http://127.0.0.1:1/asr', model: 'fixture' }),
      transcribeWav: async () => ({ action: 'transcribed', text: 'PRIVATE_TRANSCRIPT' }),
      push: () => {},
    });
    if ('error' in started) throw new Error(started.error);
    stream = started.stream;
  });

  afterEach(() => {
    stream.close();
    unsubscribe();
    vi.restoreAllMocks();
  });

  test('stream close record carries received chunk count and bytes', async () => {
    const now = vi.spyOn(Date, 'now').mockReturnValue(1000);
    await stream.writeInput(() => new Uint8Array(4), 4, true);
    now.mockReturnValue(1200);
    await stream.writeInput(() => new Uint8Array(2), 2, true);
    stream.close();
    expect(logs.find((event) => event.message === 'voice.stream.close')?.metadata).toMatchObject({
      receivedChunks: 2,
      receivedBytes: 6,
      lastChunkAt: 1200,
    });
  });

  test('receipt totals count replay bytes without changing the resume offset', async () => {
    await stream.writeInput(() => new Uint8Array(4), 4, true);
    await stream.writeInput(() => new Uint8Array(), 4, false);
    stream.close();
    expect(stream.receivedBytes).toBe(4);
    expect(logs.find((event) => event.message === 'voice.stream.close')?.metadata).toMatchObject({
      receivedChunks: 2,
      receivedBytes: 8,
      audioBytes: 4,
    });
  });

  test('wire byte ranges correlate arrivals across a dropped attempt and replay', async () => {
    const now = vi.spyOn(Date, 'now').mockReturnValue(1000);
    const attempts = [
      { attempt: 1, offset: 0, bytes: 4, delivered: true },
      { attempt: 2, offset: 4, bytes: 6, delivered: false },
      { attempt: 3, offset: 4, bytes: 6, delivered: true },
      { attempt: 4, offset: 0, bytes: 4, delivered: true },
    ];
    for (const attempt of attempts.filter((entry) => entry.delivered)) {
      await stream.writeInput(() => new Uint8Array(attempt.bytes), attempt.bytes, false, {
        startedAt: Date.now(),
        decodeMs: 0,
        offset: attempt.offset,
      });
      now.mockReturnValue(Date.now() + 1001);
    }
    const decoded = logs.filter((event) => event.message === 'voice.stream.chunk.decode');
    expect(decoded.map((event) => event.metadata?.chunkSeq)).toEqual([1, 2, 3]);
    expect(decoded.map((event) => [event.metadata?.offset, event.metadata?.bytes])).toEqual([
      [0, 4],
      [4, 6],
      [0, 4],
    ]);
    expect(
      logs
        .filter((event) => event.message === 'voice.stream.chunk.late')
        .map((event) => [event.metadata?.offset, event.metadata?.bytes])
    ).toEqual([
      [4, 6],
      [0, 4],
    ]);
  });

  test('legacy and invalid wire offsets stay out of numeric diagnostics', async () => {
    for (const offset of [undefined, -1, 0.5, NaN, Infinity]) {
      await stream.writeInput(() => new Uint8Array(2), 2, true, {
        startedAt: Date.now(),
        decodeMs: 0,
        offset,
      });
    }
    const decoded = logs.filter((event) => event.message === 'voice.stream.chunk.decode');
    expect(decoded).toHaveLength(5);
    for (const event of decoded) {
      expect(event.metadata).not.toHaveProperty('offset');
      expect(event.metadata).toHaveProperty('bytes', 2);
    }
  });

  test('cancel logs bytes received before clearing', async () => {
    await stream.writeInput(() => new Uint8Array(4), 4, true);
    await stream.cancel();
    expect(logs.find((event) => event.message === 'voice.stream.close')?.metadata).toMatchObject({
      audioBytes: 4,
      receivedChunks: 1,
      receivedBytes: 4,
    });
    expect(stream.receivedBytes).toBe(0);
  });

  test('only gaps over one second produce a late chunk line', async () => {
    const now = vi.spyOn(Date, 'now').mockReturnValue(1000);
    await stream.writeInput(() => new Uint8Array(2), 2, true);
    now.mockReturnValue(2000);
    await stream.writeInput(() => new Uint8Array(2), 2, true);
    expect(logs.filter((event) => event.message === 'voice.stream.chunk.late')).toHaveLength(0);
    now.mockReturnValue(3001);
    await stream.writeInput(() => new Uint8Array(2), 2, true);
    const late = logs.filter((event) => event.message === 'voice.stream.chunk.late');
    expect(late).toHaveLength(1);
    expect(late[0].metadata).toMatchObject({ chunkSeq: 3, gapMs: 1001 });
  });

  test('Opus decode timing uses numeric metadata without payloads', async () => {
    let clock = 10;
    vi.spyOn(performance, 'now').mockImplementation(() => clock);
    vi.spyOn(opusInputDefaults, 'create').mockResolvedValue({
      decode: async () => {
        clock += 7;
        return { pcm: new Uint8Array(8), partial: false };
      },
      close: () => {},
    });
    await stream.enableOpus();
    await stream.writeInput(() => new Uint8Array([1, 2, 3, 4]), 4, true);
    await stream.stop();
    stream.close();
    const decoded = logs.find((event) => event.message === 'voice.stream.chunk.decode');
    expect(decoded?.metadata).toMatchObject({ chunkSeq: 1, codec: 1, decodeMs: 7 });
    expect(logs.find((event) => event.message === 'voice.stream.close')?.metadata).toMatchObject({
      receivedChunks: 1,
      receivedBytes: 4,
    });
    for (const [key, value] of Object.entries(decoded?.metadata ?? {})) {
      if (key !== 'streamId' && key !== 'argTypes') expect(typeof value).toBe('number');
    }
    const serialized = JSON.stringify(logs);
    expect(serialized).not.toContain('PRIVATE_TRANSCRIPT');
    expect(serialized).not.toContain('AQIDBA==');
    expect(serialized).not.toContain('://');
  });
});
