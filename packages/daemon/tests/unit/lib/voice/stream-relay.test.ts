import { vi } from 'vitest';
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import {
  subscribeToStructuredLogs,
  type StructuredLogEvent,
  type VoiceSettings,
} from '@hyperneo/shared';
import { WebSocketServer, type WebSocket } from 'ws';
import {
  VoiceStream,
  pcm16Wav,
  voiceMode,
  voiceStreamRoute,
  voiceStreamTls,
  type VoiceStreamText,
} from '../../../../src/lib/voice/stream-relay';
import { deepgram, joinFinals } from '../../../../src/lib/voice/stream-protocols';
import { voicePeerReasonBytes } from '../../../../src/lib/voice/diagnostics';
import type { VoiceTranscribeOutcome } from '../../../../src/lib/voice/transcribe-pipeline';
import recorded from './fixtures/wlk-deepgram.json';

const results = (transcript: string, isFinal: boolean) =>
  JSON.stringify({
    type: 'Results',
    is_final: isFinal,
    channel: { alternatives: [{ transcript }] },
  });

const finalsOf = (messages: readonly unknown[]) =>
  joinFinals(
    messages
      .map((message) => deepgram.parse(JSON.stringify(message)))
      .filter((parsed) => parsed?.isFinal && parsed.text)
      .map((parsed) => parsed!.text)
  );

describe('voice stream settings', () => {
  const voice: VoiceSettings = {
    enabled: true,
    endpoint: 'https://ai0:8011/v1/audio/transcriptions',
    model: 'qwen3-asr-06b',
    streamEndpoint: 'wss://ai0:8011/v1/listen?language=zh',
  };

  test('voiceMode defaults to auto', () => {
    expect(voiceMode(voice)).toBe('auto');
    expect(voiceMode({ ...voice, mode: 'batch' })).toBe('batch');
    expect(voiceMode({ ...voice, mode: 'streaming' })).toBe('streaming');
  });

  test('voiceStreamRoute adds the Deepgram parameters and keeps the ones configured', () => {
    expect(voiceStreamRoute(voice)?.url.toString()).toBe(
      'wss://ai0:8011/v1/listen?language=zh&encoding=linear16&sample_rate=16000&channels=1&interim_results=true&endpointing=700'
    );
    expect(
      voiceStreamRoute({
        ...voice,
        streamEndpoint: 'ws://h/v1/listen?endpointing=300',
      })?.url.searchParams.get('endpointing')
    ).toBe('300');
  });

  test('voiceStreamRoute needs a ws or wss endpoint and a supported protocol', () => {
    expect(voiceStreamRoute({ ...voice, streamEndpoint: undefined })).toBeNull();
    expect(voiceStreamRoute({ ...voice, streamEndpoint: 'https://ai0:8011/v1/listen' })).toBeNull();
    expect(voiceStreamRoute({ ...voice, streamProtocol: 'openai-realtime' })).toBeNull();
  });

  test('voiceStreamTls pins a configured CA and never turns verification off by default', () => {
    expect(voiceStreamTls(voice)).toEqual({ rejectUnauthorized: true });
    expect(voiceStreamTls({ ...voice, tlsCaPem: ' PEM ' })).toEqual({
      ca: 'PEM',
      rejectUnauthorized: true,
    });
  });

  test('deepgram reads Results and ignores other frames', () => {
    expect(deepgram.parse(results(' hi ', false))).toEqual({ text: 'hi', isFinal: false });
    expect(deepgram.parse(results('hi', true))).toEqual({ text: 'hi', isFinal: true });
    expect(deepgram.parse('{"type":"Metadata"}')).toBeNull();
    expect(deepgram.parse('nope')).toBeNull();
    expect(deepgram.finish()).toBe('{"type":"CloseStream"}');
    expect(deepgram.authorization('k')).toBe('Token k');
  });

  test('joinFinals spaces Latin text and runs CJK text together', () => {
    expect(joinFinals(['First.', 'Second.', ''])).toBe('First. Second.');
    expect(joinFinals(['请帮我检查。', '如果批准了。'])).toBe('请帮我检查。如果批准了。');
  });

  test('WLK finals, as recorded, hold every sentence once', () => {
    expect(finalsOf(recorded.three)).toBe(
      'Please check the build status of the voice pull request. Then merge it if the review bot approved. Finally, install the app on my phone tonight.'
    );
    const monologue = finalsOf(recorded.mono);
    expect(monologue.startsWith('Yesterday, I spent most of the afternoon')).toBe(true);
    expect(monologue.endsWith('without hurting accuracy.')).toBe(true);
    expect(monologue.match(/Tomorrow/g)).toHaveLength(1);
    expect(finalsOf(recorded.zh).startsWith('请帮我检查一下')).toBe(true);
    expect(finalsOf(recorded.zh).endsWith('iPhone上。')).toBe(true);
  });

  test('voicePeerReasonBytes counts reason bytes whether the runtime passes a Buffer or a string', () => {
    expect(voicePeerReasonBytes(Buffer.from('PRIVATE'))).toBe(7);
    expect(voicePeerReasonBytes('PRIVATE')).toBe(7);
    expect(voicePeerReasonBytes('请')).toBe(3);
    expect(voicePeerReasonBytes(undefined)).toBe(0);
  });

  test('pcm16Wav wraps PCM in a 16 kHz mono WAV header', () => {
    const wav = pcm16Wav(new Uint8Array([1, 2, 3, 4]));
    expect(Buffer.from(wav.subarray(0, 4)).toString()).toBe('RIFF');
    expect(new DataView(wav.buffer).getUint32(24, true)).toBe(16_000);
    expect([...wav.subarray(44)]).toEqual([1, 2, 3, 4]);
  });
});

describe('VoiceStream against a stub Deepgram server', () => {
  let server: WebSocketServer;
  let port: number;
  let received: number;
  let onAudio: (socket: WebSocket, bytes: number) => void;
  let onCloseStream: (socket: WebSocket) => void;
  let pushed: VoiceStreamText[];
  let batches: string[];
  let logs: StructuredLogEvent[];
  let unsubscribe: () => void;
  let connections: URL[];

  beforeEach(async () => {
    logs = [];
    unsubscribe = subscribeToStructuredLogs((event) => {
      if (event.module === 'hyperneo:daemon:voice') logs.push(event);
    });
    received = 0;
    pushed = [];
    batches = [];
    connections = [];
    onAudio = (socket, bytes) => socket.send(results(`heard ${bytes}`, false));
    onCloseStream = (socket) => {
      socket.send(results(`heard ${received}`, true));
      socket.send('{"type":"Metadata"}');
      socket.close(1000);
    };
    server = new WebSocketServer({ port: 0 });
    await new Promise((resolve) => server.once('listening', resolve));
    port = (server.address() as { port: number }).port;
    server.on('connection', (socket, request) => {
      const url = new URL(request.url!, 'http://stub');
      connections.push(url);
      expect(url.pathname).toBe('/v1/listen');
      expect(url.searchParams.get('sample_rate')).toBe('16000');
      socket.on('message', (data: Buffer, isBinary: boolean) => {
        if (!isBinary) {
          if (JSON.parse(data.toString()).type === 'CloseStream') onCloseStream(socket);
          return;
        }
        received += data.length;
        onAudio(socket, received);
      });
    });
  });

  afterEach(() => {
    unsubscribe();
    return new Promise((resolve) => server.close(resolve));
  });

  const deps = (overrides: Partial<VoiceSettings> = {}) => ({
    voice: (): VoiceSettings => ({
      enabled: true,
      endpoint: `http://127.0.0.1:${port}/v1/audio/transcriptions`,
      model: 'm',
      streamEndpoint: `ws://127.0.0.1:${port}/v1/listen`,
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

  test.each([undefined, 'zh', 'en'] as const)(
    'sends language %s on the ASR connection request',
    async (language) => {
      const started = await VoiceStream.start('language', { ...deps(), language });
      if ('error' in started) throw new Error(started.error);
      try {
        expect(started.via).toBe('streaming');
        expect(connections[0].searchParams.getAll('language')).toEqual(language ? [language] : []);
      } finally {
        started.stream.close();
      }
    }
  );

  test('relays chunks, pushes interim text, and returns the finals the server flushes on CloseStream', async () => {
    const { stream, via } = await start();
    expect(via).toBe('streaming');
    expect(stream.write(new Uint8Array(3200))).toBeNull();
    expect(stream.write(new Uint8Array(3200))).toBeNull();
    expect(await stream.stop()).toEqual({ text: 'heard 6400', via: 'streaming' });
    expect(pushed.at(-1)).toEqual({ streamId: 's1', text: 'heard 6400', isFinal: true });
    expect(pushed.some((text) => !text.isFinal)).toBe(true);
    expect(batches).toEqual([]);
    expect(logs.find((event) => event.message === 'voice.stream.open')?.metadata).toMatchObject({
      streamId: 's1',
      via: 'streaming',
      route: 'deepgram',
      status: 'started',
    });
    expect(logs.find((event) => event.message === 'voice.stream.stop')?.metadata).toMatchObject({
      streamId: 's1',
      via: 'streaming',
      status: 'completed',
      audioBytes: 6400,
      audioDurationMs: 200,
    });
    expect(JSON.stringify(logs)).not.toContain('heard 6400');
  });

  test('a recorded WLK session arrives whole after stop', async () => {
    onAudio = () => {};
    onCloseStream = (socket) => {
      for (const message of recorded.three) socket.send(JSON.stringify(message));
      socket.close(1000);
    };
    const { stream } = await start();
    stream.write(new Uint8Array(3200));
    expect(await stream.stop()).toEqual({ text: finalsOf(recorded.three), via: 'streaming' });
  });

  test('interim text covers only the tail after the last final', async () => {
    onAudio = (socket, bytes) =>
      socket.send(bytes === 2 ? results('First.', true) : results('second', false));
    const { stream } = await start();
    stream.write(new Uint8Array(2));
    await new Promise((resolve) => setTimeout(resolve, 50));
    stream.write(new Uint8Array(2));
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(pushed.at(-1)?.text).toBe('First. second');
    stream.close();
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

  test('a server that never closes after CloseStream falls back to batch', async () => {
    onCloseStream = (socket) => socket.send(results('partial only', true));
    const { stream } = await start();
    stream.write(new Uint8Array([1, 0, 2, 0]));
    expect(await stream.stop()).toEqual({ text: 'batch text', via: 'batch' });
  }, 8_000);

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

  test('a socket that opens after the startup timeout still logs a relay-closed stream end', async () => {
    let release: (value: null) => void = () => {};
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      const starting = VoiceStream.start('s1', {
        ...deps({ apiKeyEndpoint: `http://127.0.0.1:${port}/v1/audio/transcriptions` }),
        credentialManager: {
          getCredentials: () =>
            new Promise<null>((resolve) => {
              release = resolve;
            }),
        },
      });
      await vi.advanceTimersByTimeAsync(8_001);
      expect(await starting).toMatchObject({ via: 'batch' });
    } finally {
      vi.useRealTimers();
    }
    release(null);
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(logs.find((event) => event.message === 'voice.stream.end')?.metadata).toMatchObject({
      streamId: 's1',
      closedBy: 'relay',
      code: 1000,
      reason: 'normal_closure',
    });
  });

  test('without a streaming endpoint auto mode goes to batch', async () => {
    const { via } = await start({ streamEndpoint: undefined });
    expect(via).toBe('batch');
  });

  test('auto falls back to batch with the whole buffered audio when the ASR is unreachable', async () => {
    const { stream, via } = await start({ streamEndpoint: 'ws://127.0.0.1:1/v1/listen' });
    expect(via).toBe('batch');
    stream.write(new Uint8Array([1, 0, 2, 0]));
    expect(await stream.stop()).toEqual({ text: 'batch text', via: 'batch' });
    expect([...Buffer.from(batches[0], 'base64').subarray(44)]).toEqual([1, 0, 2, 0]);
    expect(pushed).toEqual([{ streamId: 's1', text: 'batch text', isFinal: true }]);
  });

  test('close reasons and endpoint query values cannot leak transcript or credentials into logs', async () => {
    onAudio = (socket) => socket.close(1011, 'PRIVATE_TRANSCRIPT_TEXT');
    const { stream } = await start({
      streamEndpoint: `ws://127.0.0.1:${port}/v1/listen?token=PRIVATE_TOKEN`,
    });
    stream.write(new Uint8Array(2));
    await new Promise((resolve) => setTimeout(resolve, 100));
    await stream.stop();
    const close = logs.find((event) => event.message === 'voice.asr.close');
    expect(close?.metadata).toMatchObject({
      code: 1011,
      reason: 'server_error',
      peerReasonBytes: 23,
    });
    expect(JSON.stringify(logs)).not.toContain('PRIVATE_');
  });

  test('a server 1011 close logs who closed, the code, and stream timing without the peer reason', async () => {
    onAudio = (socket) => {
      socket.send(results('PRIVATE_TRANSCRIPT', false));
      socket.close(1011, 'PRIVATE_CLOSE_REASON');
    };
    const { stream } = await start();
    stream.write(new Uint8Array(3200));
    await new Promise((resolve) => setTimeout(resolve, 100));
    const end = logs.find((event) => event.message === 'voice.stream.end');
    expect(end?.metadata).toMatchObject({
      streamId: 's1',
      closedBy: 'server',
      code: 1011,
      reason: 'server_error',
      peerReasonBytes: Buffer.byteLength('PRIVATE_CLOSE_REASON'),
    });
    expect(typeof end?.metadata?.durationMs).toBe('number');
    expect(typeof end?.metadata?.sinceLastAudioMs).toBe('number');
    expect(typeof end?.metadata?.sinceLastResultMs).toBe('number');
    expect(JSON.stringify(logs)).not.toContain('PRIVATE_');
    expect(await stream.stop()).toEqual({ text: 'batch text', via: 'batch' });
  });

  test('a client cancel logs the end as client-closed with the normal close code', async () => {
    const { stream } = await start();
    stream.write(new Uint8Array(3200));
    await new Promise((resolve) => setTimeout(resolve, 50));
    stream.cancel();
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(logs.find((event) => event.message === 'voice.stream.end')?.metadata).toMatchObject({
      closedBy: 'client',
      code: 1000,
      reason: 'normal_closure',
    });
  });

  test('a relay-initiated close logs the end as relay-closed', async () => {
    const { stream } = await start();
    stream.write(new Uint8Array(3200));
    stream.close('idle_timeout');
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(logs.find((event) => event.message === 'voice.stream.end')?.metadata).toMatchObject({
      closedBy: 'relay',
      code: 1000,
    });
  });

  test('a server keepalive ping shows up in the end log timing', async () => {
    onAudio = (socket) => {
      socket.ping();
      socket.send(results('hi', false));
    };
    onCloseStream = (socket) => socket.close(1000);
    const { stream } = await start();
    stream.write(new Uint8Array(3200));
    await new Promise((resolve) => setTimeout(resolve, 50));
    await stream.stop();
    const end = logs.find((event) => event.message === 'voice.stream.end');
    expect(end?.metadata?.closedBy).toBe('server');
    expect(typeof end?.metadata?.sinceLastPingMs).toBe('number');
  });

  test('a stream that never heard any text falls back to batch with the buffered audio', async () => {
    onAudio = () => {};
    onCloseStream = (socket) => socket.close(1000);
    const { stream, via } = await start();
    expect(via).toBe('streaming');
    stream.write(new Uint8Array([1, 0, 2, 0]));
    expect(await stream.stop()).toEqual({ text: 'batch text', via: 'batch' });
    expect([...Buffer.from(batches[0], 'base64').subarray(44)]).toEqual([1, 0, 2, 0]);
  });

  test('a cancel during a stop drops the finals the server flushes and skips the batch fallback', async () => {
    onAudio = () => {};
    const { stream } = await start();
    stream.write(new Uint8Array([1, 0, 2, 0]));
    const stopping = stream.stop();
    stream.cancel();
    expect(await stopping).toEqual({ error: 'Voice stream cancelled' });
    expect(batches).toEqual([]);
    expect(pushed).toEqual([]);
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
    expect(logs.find((event) => event.message === 'voice.asr.close')?.metadata).toMatchObject({
      streamId: 's1',
      code: 1006,
      reason: 'abnormal_closure',
    });
    expect(logs.find((event) => event.message === 'voice.stream.stop')?.metadata).toMatchObject({
      via: 'batch',
      audioBytes: 4,
      fallbackReason: 'asr_disconnected',
      status: 'completed',
    });
    expect(JSON.stringify(logs)).not.toContain('batch text');
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
      deps({ mode: 'streaming', streamEndpoint: 'ws://127.0.0.1:1/v1/listen' })
    );
    expect(started).toMatchObject({ error: expect.stringContaining('unavailable') });
    expect(logs.find((event) => event.message === 'voice.asr.error')?.metadata).toMatchObject({
      streamId: 's1',
      reason: 'socket_error',
    });
    expect(logs.find((event) => event.message === 'voice.stream.open')?.metadata).toMatchObject({
      streamId: 's1',
      status: 'refused',
      fallbackReason: 'asr_unavailable',
    });
  });

  test('refuses odd byte counts and disabled voice', async () => {
    const { stream } = await start({ mode: 'batch' });
    expect(stream.write(new Uint8Array(3))).toContain('16-bit');
    expect(await VoiceStream.start('s2', deps({ enabled: false }))).toEqual({
      error: 'Voice input is disabled',
    });
  });
});
