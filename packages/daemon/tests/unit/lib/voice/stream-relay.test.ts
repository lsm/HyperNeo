import { vi } from 'vitest';
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import type { VoiceSettings } from '@hyperneo/shared';
import { WebSocketServer, type WebSocket } from 'ws';
import {
  VoiceStream,
  asrText,
  mergeAsrWindow,
  pcm16Wav,
  voiceMode,
  voiceStreamTls,
  voiceStreamUrl,
  type VoiceStreamText,
} from '../../../../src/lib/voice/stream-relay';
import type { VoiceTranscribeOutcome } from '../../../../src/lib/voice/transcribe-pipeline';

describe('voice stream settings', () => {
  const voice: VoiceSettings = {
    enabled: true,
    endpoint: 'https://ai0:8090/v1/audio/transcriptions',
    model: 'qwen3-asr-06b',
  };

  test('voiceMode defaults to auto', () => {
    expect(voiceMode(voice)).toBe('auto');
    expect(voiceMode({ ...voice, mode: 'batch' })).toBe('batch');
    expect(voiceMode({ ...voice, mode: 'streaming' })).toBe('streaming');
  });

  test('voiceStreamUrl derives the streaming route beside the batch endpoint', () => {
    expect(voiceStreamUrl(voice)?.toString()).toBe(
      'wss://ai0:8090/v1/audio/streaming_transcriptions?model=qwen3-asr-06b'
    );
    expect(
      voiceStreamUrl({ ...voice, endpoint: 'http://h/v1/audio/transcriptions' })?.protocol
    ).toBe('ws:');
    expect(voiceStreamUrl({ ...voice, endpoint: 'https://h/v1/other' })).toBeNull();
  });

  test('voiceStreamTls pins a configured CA and never turns verification off by default', () => {
    expect(voiceStreamTls(voice)).toEqual({ rejectUnauthorized: true });
    expect(voiceStreamTls({ ...voice, tlsCaPem: ' PEM ' })).toEqual({
      ca: 'PEM',
      rejectUnauthorized: true,
    });
  });

  test('asrText reads gateway messages and ignores anything else', () => {
    expect(asrText('{"text":"hi","is_final":false}')).toEqual({ text: 'hi', isFinal: false });
    expect(asrText('{"text":"hi","is_final":true}')).toEqual({ text: 'hi', isFinal: true });
    expect(asrText('nope')).toBeNull();
  });

  test('mergeAsrWindow keeps the head a sliding window drops (ai0, three sentences, 4 s pauses)', () => {
    const windows = [
      'Please check the bill.',
      'Please check the build status of the voice pull request.',
      'Please check the build status of the voice pull request. Then merge it if the review bot.',
      'Please check the build status of the voice pull request. Then merge it if the review bot approved.',
      'The build status of the voice pull request. Then merge it if the review bot approved.',
      'Then merge it if the review bot approved. Finally install.',
      'Then merge it if the review bot approved. Finally, install the app on my phone tonight.',
      'The review bot approved. Finally, install the app on my phone tonight.',
    ];
    expect(windows.reduce(mergeAsrWindow, '')).toBe(
      'Please check the build status of the voice pull request. Then merge it if the review bot approved. Finally, install the app on my phone tonight.'
    );
  });

  test('mergeAsrWindow revises the tail, skips a cut-off first word, and appends a window with nothing in common', () => {
    expect(mergeAsrWindow('Please check the bill.', 'Please check the build')).toBe(
      'Please check the build'
    );
    expect(mergeAsrWindow('we ship the build today', 'e build today and merge')).toBe(
      'we ship the build today and merge'
    );
    expect(mergeAsrWindow('first part.', 'second part')).toBe('first part. second part');
    expect(mergeAsrWindow('', 'hello')).toBe('hello');
    expect(mergeAsrWindow('hello', '')).toBe('hello');
    expect(mergeAsrWindow('hello', 'hello')).toBe('hello');
  });

  test('mergeAsrWindow lines up on the longest overlap when a phrase repeats inside the window', () => {
    expect(
      mergeAsrWindow(
        'alpha bravo ok deploy it charlie delta ok deploy it echo',
        'ok deploy it charlie delta ok deploy it echo'
      )
    ).toBe('alpha bravo ok deploy it charlie delta ok deploy it echo');
  });

  test('mergeAsrWindow lines up past a word the window revised inside the overlap', () => {
    expect(mergeAsrWindow('a b c d e f g h', 'c d x f g h i')).toBe('a b c d e f g h i');
  });

  test('mergeAsrWindow lowercases only a title-case window head, never an acronym', () => {
    expect(mergeAsrWindow('we call the api now', 'The api now works')).toBe(
      'we call the api now works'
    );
    expect(mergeAsrWindow('we call the api now', 'API now works')).toBe(
      'we call the API now works'
    );
  });

  test('pcm16Wav wraps PCM in a 16 kHz mono WAV header', () => {
    const wav = pcm16Wav(new Uint8Array([1, 2, 3, 4]));
    expect(Buffer.from(wav.subarray(0, 4)).toString()).toBe('RIFF');
    expect(new DataView(wav.buffer).getUint32(24, true)).toBe(16_000);
    expect([...wav.subarray(44)]).toEqual([1, 2, 3, 4]);
  });
});

describe('VoiceStream against a stub ASR server', () => {
  let server: WebSocketServer;
  let port: number;
  let received: number;
  let onAudio: (socket: WebSocket, bytes: number) => void;
  let pushed: VoiceStreamText[];
  let batches: string[];

  beforeEach(async () => {
    received = 0;
    pushed = [];
    batches = [];
    onAudio = (socket, bytes) =>
      socket.send(JSON.stringify({ text: `heard ${bytes}`, is_final: false }));
    server = new WebSocketServer({ port: 0 });
    await new Promise((resolve) => server.once('listening', resolve));
    port = (server.address() as { port: number }).port;
    server.on('connection', (socket, request) => {
      expect(request.url).toBe('/v1/audio/streaming_transcriptions?model=m');
      socket.on('message', (data: Buffer) => {
        received += data.length;
        onAudio(socket, received);
      });
    });
  });

  afterEach(() => new Promise((resolve) => server.close(resolve)));

  const deps = (overrides: Partial<VoiceSettings> = {}) => ({
    voice: (): VoiceSettings => ({
      enabled: true,
      endpoint: `http://127.0.0.1:${port}/v1/audio/transcriptions`,
      model: 'm',
      allowPrivateNetwork: true,
      ...overrides,
    }),
    transcribeWav: async (wav: string): Promise<VoiceTranscribeOutcome> => {
      batches.push(wav);
      return { action: 'transcribed', text: 'batch text' };
    },
    push: (text: VoiceStreamText) => pushed.push(text),
  });

  const start = async (overrides: Partial<VoiceSettings> = {}) => {
    const started = await VoiceStream.start('s1', deps(overrides));
    if ('error' in started) throw new Error(started.error);
    return started;
  };

  test('relays chunks and pushes partial then final text', async () => {
    const { stream, via } = await start();
    expect(via).toBe('streaming');
    expect(stream.write(new Uint8Array(3200))).toBeNull();
    expect(stream.write(new Uint8Array(3200))).toBeNull();
    expect(await stream.stop()).toEqual({ text: 'heard 6400', via: 'streaming' });
    expect(pushed.at(-1)).toEqual({ streamId: 's1', text: 'heard 6400', isFinal: true });
    expect(pushed.some((text) => !text.isFinal)).toBe(true);
    expect(batches).toEqual([]);
  });

  test('a second stop while one is running joins it instead of finishing twice', async () => {
    const { stream } = await start();
    stream.write(new Uint8Array(3200));
    const [first, second] = await Promise.all([stream.stop(), stream.stop()]);
    expect(first).toEqual({ text: 'heard 3200', via: 'streaming' });
    expect(second).toEqual(first);
    expect(pushed.filter((text) => text.isFinal)).toHaveLength(1);
    expect(batches).toEqual([]);
  });

  test('a start whose connection takes too long falls back to batch in auto mode', async () => {
    let release: (value: null) => void = () => {};
    const endpoint = `http://127.0.0.1:${port}/v1/audio/transcriptions`;
    vi.useFakeTimers();
    try {
      const starting = VoiceStream.start('s1', {
        ...deps({ apiKeyEndpoint: endpoint }),
        credentialManager: {
          getCredentials: () =>
            new Promise<null>((resolve) => {
              release = resolve;
            }),
        },
      });
      await vi.advanceTimersByTimeAsync(8_001);
      expect(await starting).toMatchObject({
        via: 'batch',
        fallback: expect.stringContaining('8000 ms'),
      });
    } finally {
      vi.useRealTimers();
      release(null);
    }
  });

  test('a sliding-window gateway keeps every sentence in the stop text', async () => {
    const windows = ['one two three four', 'three four five six', 'five six seven eight'];
    onAudio = (socket, bytes) =>
      socket.send(JSON.stringify({ text: windows[bytes / 2 - 1], is_final: false }));
    const { stream } = await start();
    for (let i = 0; i < windows.length; i++) {
      stream.write(new Uint8Array(2));
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    expect(await stream.stop()).toEqual({
      text: 'one two three four five six seven eight',
      via: 'streaming',
    });
  });

  test('joins final segments with the trailing partial', async () => {
    onAudio = (socket, bytes) =>
      socket.send(
        JSON.stringify(
          bytes === 2 ? { text: 'first.', is_final: true } : { text: 'second', is_final: false }
        )
      );
    const { stream } = await start();
    stream.write(new Uint8Array(2));
    await new Promise((resolve) => setTimeout(resolve, 50));
    stream.write(new Uint8Array(2));
    expect(await stream.stop()).toEqual({ text: 'first. second', via: 'streaming' });
  });

  test('auto falls back to batch with the whole buffered audio when the ASR is unreachable', async () => {
    const { stream, via } = await start({ endpoint: 'http://127.0.0.1:1/v1/audio/transcriptions' });
    expect(via).toBe('batch');
    stream.write(new Uint8Array([1, 0, 2, 0]));
    expect(await stream.stop()).toEqual({ text: 'batch text', via: 'batch' });
    expect([...Buffer.from(batches[0], 'base64').subarray(44)]).toEqual([1, 0, 2, 0]);
    expect(pushed).toEqual([{ streamId: 's1', text: 'batch text', isFinal: true }]);
  });

  test('a stream that never heard any text falls back to batch with the buffered audio', async () => {
    onAudio = () => {};
    const { stream, via } = await start();
    expect(via).toBe('streaming');
    stream.write(new Uint8Array([1, 0, 2, 0]));
    expect(await stream.stop()).toEqual({ text: 'batch text', via: 'batch' });
    expect([...Buffer.from(batches[0], 'base64').subarray(44)]).toEqual([1, 0, 2, 0]);
  });

  test('a cancel during a stop that heard no text ends it without the batch fallback', async () => {
    onAudio = () => {};
    const { stream } = await start();
    stream.write(new Uint8Array([1, 0, 2, 0]));
    const stopping = stream.stop();
    stream.cancel();
    expect(await stopping).toEqual({ error: 'Audio data is empty' });
    expect(batches).toEqual([]);
    expect(pushed.some((text) => text.isFinal)).toBe(false);
  });

  test('a cancel during a batch transcription already running drops its result', async () => {
    const { stream } = await start({ mode: 'batch' });
    stream.write(new Uint8Array([1, 0]));
    const stopping = stream.stop();
    stream.cancel();
    expect(await stopping).toEqual({ error: 'Voice stream cancelled' });
    expect(batches).toHaveLength(1);
    expect(pushed).toEqual([]);
  });

  test('a mid-stream drop falls back to batch without losing audio sent before or after it', async () => {
    onAudio = (socket) => socket.terminate();
    const { stream } = await start();
    stream.write(new Uint8Array([1, 0]));
    await new Promise((resolve) => setTimeout(resolve, 100));
    stream.write(new Uint8Array([2, 0]));
    expect(await stream.stop()).toEqual({ text: 'batch text', via: 'batch' });
    expect([...Buffer.from(batches[0], 'base64').subarray(44)]).toEqual([1, 0, 2, 0]);
  });

  test('a denied batch fallback keeps the audio so a retried stop transcribes all of it', async () => {
    const outcomes: VoiceTranscribeOutcome[] = [
      { action: 'denied', message: 'Voice transcription rate limit exceeded' },
      { action: 'transcribed', text: 'batch text' },
    ];
    const started = await VoiceStream.start('s1', {
      ...deps({ mode: 'batch' }),
      transcribeWav: async (wav: string) => {
        batches.push(wav);
        return outcomes.shift()!;
      },
    });
    if ('error' in started) throw new Error(started.error);
    started.stream.write(new Uint8Array([1, 0, 2, 0]));
    expect(await started.stream.stop()).toEqual({
      error: 'Voice transcription rate limit exceeded',
      retryable: true,
    });
    expect(await started.stream.stop()).toEqual({ text: 'batch text', via: 'batch' });
    expect(batches[1]).toBe(batches[0]);
  });

  test('batch mode never opens the stream', async () => {
    const { stream, via } = await start({ mode: 'batch' });
    expect(via).toBe('batch');
    stream.write(new Uint8Array(4));
    await stream.stop();
    expect(received).toBe(0);
    expect(batches).toHaveLength(1);
  });

  test('streaming mode refuses to start when the ASR is unreachable', async () => {
    const started = await VoiceStream.start(
      's1',
      deps({ mode: 'streaming', endpoint: 'http://127.0.0.1:1/v1/audio/transcriptions' })
    );
    expect(started).toMatchObject({ error: expect.stringContaining('unavailable') });
  });

  test('refuses odd byte counts and disabled voice', async () => {
    const { stream } = await start({ mode: 'batch' });
    expect(stream.write(new Uint8Array(3))).toContain('16-bit');
    expect(await VoiceStream.start('s2', deps({ enabled: false }))).toEqual({
      error: 'Voice input is disabled',
    });
  });
});
