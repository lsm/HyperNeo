import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { opusInputDefaults } from '../../../../src/lib/voice/opus-input.ts';
import { createOpusPackets } from '../../../../src/lib/voice/opus-packets.ts';
import { opusFixture } from '../../../helpers/opus-fixture.ts';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CallContext, MessageHub } from '@hyperneo/shared';
import { VoiceStream } from '../../../../src/lib/voice/stream-relay.ts';
import type { SettingsManager } from '../../../../src/lib/settings-manager.ts';
import type { Database } from '../../../../src/storage/sqlite-compat.ts';
import {
  registerVoiceHandlers,
  resetVoiceTranscriptionLimitsForTests,
} from '../../../../src/lib/rpc-handlers/voice-handlers.ts';

type Handler = (data: object, context: CallContext) => unknown;
const context = (clientId: string): CallContext => ({
  clientId,
  sessionId: 'global',
  messageId: crypto.randomUUID(),
  method: 'voice',
  timestamp: new Date().toISOString(),
});

describe('resumable voice stream RPC', () => {
  let handlers: Map<string, Handler>;
  let disconnect: (clientId: string) => void;
  let events: Array<{ clientId: string; message: { data: unknown } }>;
  const originalFetch = globalThis.fetch;
  const pcm = (values: number[]) => Buffer.from(new Int16Array(values).buffer).toString('base64');
  const call = (method: string, data: object, clientId = 'first') =>
    Promise.resolve().then(() => {
      const handler = handlers.get(method);
      expect(handler, method).toBeDefined();
      return handler!(data, context(clientId));
    });
  const start = async (clientId = 'first') =>
    (await call('voice.stream.start', { encoding: 'pcm16', sampleRate: 16_000 }, clientId)) as {
      streamId: string;
      resumable?: boolean;
    };

  beforeEach(() => {
    vi.spyOn(opusInputDefaults, 'create').mockImplementation(createOpusPackets);
    resetVoiceTranscriptionLimitsForTests();
    handlers = new Map();
    events = [];
    const hub = {
      onRequest: (method: string, handler: Handler) => {
        handlers.set(method, handler);
      },
      onClientDisconnect: (handler: typeof disconnect) => {
        disconnect = handler;
      },
      getRouter: () => ({
        getClientById: () => ({}),
        sendToClient: (clientId: string, message: { data: unknown }) => {
          events.push({ clientId, message });
        },
      }),
    } as unknown as MessageHub;
    const settings = {
      getGlobalSettings: () => ({
        voice: {
          enabled: true,
          endpoint: 'https://93.184.216.34/v1/transcriptions',
          model: 'synthetic',
          mode: 'batch',
        },
      }),
    } as unknown as SettingsManager;
    globalThis.fetch = vi.fn(async (_url: unknown, init?: RequestInit) => {
      const file = (init!.body as FormData).get('file') as File;
      const wav = Buffer.from(await file.arrayBuffer());
      const samples = [];
      for (let i = 44; i < wav.length; i += 2) samples.push(wav.readInt16LE(i));
      return Response.json({ text: samples.join(',') });
    }) as unknown as typeof fetch;
    registerVoiceHandlers(hub, settings, undefined, {
      db: {} as Database,
      deviceOf: (id) =>
        id.startsWith('unpaired-')
          ? null
          : { deviceId: id === 'foreign' ? 'device-b' : 'device-a', kind: 'human' },
    });
  });

  afterEach(() => {
    resetVoiceTranscriptionLimitsForTests();
    vi.clearAllTimers();
    vi.useRealTimers();
    vi.restoreAllMocks();
    globalThis.fetch = originalFetch;
  });

  it('resumes after disconnect, deduplicates overlap, and emits one complete final to the new client', async () => {
    const { streamId, resumable } = await start();
    await call('voice.stream.chunk', { streamId, audioBase64: pcm([1, 2, 3]), offset: 0 });
    disconnect('first');
    expect(await call('voice.stream.resume', { streamId }, 'second')).toEqual({
      ok: true,
      receivedBytes: 6,
    });
    expect(resumable).toBe(true);
    await expect(call('voice.stream.chunk', { streamId, audioBase64: pcm([99]) })).rejects.toThrow(
      'Unknown voice stream'
    );
    await call(
      'voice.stream.chunk',
      { streamId, audioBase64: pcm([1, 2, 3]), offset: 0 },
      'second'
    );
    await call(
      'voice.stream.chunk',
      { streamId, audioBase64: pcm([3, 4, 5]), offset: 4 },
      'second'
    );
    expect(await call('voice.stream.resume', { streamId }, 'second')).toEqual({
      ok: true,
      receivedBytes: 10,
    });
    expect(await call('voice.stream.stop', { streamId }, 'second')).toEqual({
      text: '1,2,3,4,5',
      via: 'batch',
    });
    expect(events.filter((event) => (event.message.data as { isFinal?: boolean }).isFinal)).toEqual(
      [
        {
          clientId: 'second',
          message: expect.objectContaining({
            data: { streamId, text: '1,2,3,4,5', isFinal: true },
          }),
        },
      ]
    );
  });

  it('keeps old clients without offset or resume unchanged', async () => {
    const { streamId } = await start();
    expect(await call('voice.stream.chunk', { streamId, audioBase64: pcm([7, 8]) })).toEqual({
      ok: true,
    });
    await call('voice.stream.chunk', { streamId, audioBase64: pcm([9]) });
    expect(await call('voice.stream.stop', { streamId })).toEqual({ text: '7,8,9', via: 'batch' });
  });

  it('expires a disconnected stream at two minutes and clears the old deadline on resume', async () => {
    vi.useFakeTimers();
    const { streamId } = await start();
    await call('voice.stream.chunk', { streamId, audioBase64: pcm([1]) });
    disconnect('first');
    await vi.advanceTimersByTimeAsync(119_999);
    await call('voice.stream.resume', { streamId }, 'second');
    await vi.advanceTimersByTimeAsync(2);
    await call('voice.stream.chunk', { streamId, audioBase64: pcm([2]), offset: 2 }, 'second');
    disconnect('second');
    await vi.advanceTimersByTimeAsync(120_000);
    await expect(call('voice.stream.resume', { streamId }, 'third')).rejects.toMatchObject({
      code: 'VOICE_STREAM_NOT_FOUND',
    });
  });

  it('gives the full disconnect grace even near the connected idle deadline', async () => {
    vi.useFakeTimers();
    const { streamId } = await start();
    await vi.advanceTimersByTimeAsync(150_000);
    disconnect('first');
    await vi.advanceTimersByTimeAsync(60_000);
    expect(await call('voice.stream.resume', { streamId }, 'second')).toEqual({
      ok: true,
      receivedBytes: 0,
    });
  });

  it('refuses unknown, cancelled and other-device streams with the fallback code', async () => {
    const { streamId } = await start();
    await expect(call('voice.stream.resume', { streamId }, 'foreign')).rejects.toMatchObject({
      code: 'VOICE_STREAM_NOT_FOUND',
    });
    await call('voice.stream.cancel', { streamId });
    for (const id of [streamId, 'missing'])
      await expect(call('voice.stream.resume', { streamId: id }, 'second')).rejects.toMatchObject({
        code: 'VOICE_STREAM_NOT_FOUND',
      });
  });

  it.each([-1, 0.5, '0', null, Number.MAX_SAFE_INTEGER + 1])(
    'refuses invalid offset %s without consuming bytes',
    async (offset) => {
      const { streamId } = await start();
      await expect(
        call('voice.stream.chunk', { streamId, audioBase64: pcm([1]), offset })
      ).rejects.toMatchObject({ code: 'VOICE_STREAM_INVALID_OFFSET' });
      expect(await call('voice.stream.resume', { streamId })).toEqual({
        ok: true,
        receivedBytes: 0,
      });
    }
  );

  it('refuses a gap, permits byte-level overlap, and preserves the sample-size limit', async () => {
    const { streamId } = await start();
    await expect(
      call('voice.stream.chunk', { streamId, audioBase64: pcm([1]), offset: 2 })
    ).rejects.toMatchObject({ code: 'VOICE_STREAM_OFFSET_GAP' });
    await call('voice.stream.chunk', { streamId, audioBase64: pcm([1, 2]), offset: 0 });
    await call('voice.stream.chunk', {
      streamId,
      audioBase64: Buffer.from([0, 2, 0, 3, 0]).toString('base64'),
      offset: 1,
    });
    await expect(
      call('voice.stream.chunk', { streamId, audioBase64: 'AA==', offset: 6 })
    ).rejects.toThrow('whole 16-bit');
    expect(await call('voice.stream.stop', { streamId })).toEqual({ text: '1,2,3', via: 'batch' });
  });

  it.each(['paired', 'unpaired'])(
    'keeps legacy reconnects working for %s clients',
    async (kind) => {
      let latest = '';
      for (let index = 0; index < 9; index++) {
        const client = `${kind}-reconnect-${index}`;
        latest = (await start(client)).streamId;
        await call('voice.stream.chunk', { streamId: latest, audioBase64: pcm([index]) }, client);
        if (index < 8) disconnect(client);
      }
      expect(await call('voice.stream.stop', { streamId: latest }, `${kind}-reconnect-8`)).toEqual({
        text: '8',
        via: 'batch',
      });
    }
  );

  it('preserves live and other-device streams, and keeps detached audio when replacement fails', async () => {
    const streams = [];
    for (let index = 0; index < 8; index++) streams.push(await start(`client-${index}`));
    await expect(start('extra')).rejects.toThrow('Too many voice streams');
    for (let index = 0; index < 8; index++) disconnect(`client-${index}`);
    await expect(start('foreign')).rejects.toThrow('Too many voice streams');
    vi.spyOn(VoiceStream, 'start').mockResolvedValueOnce({ error: 'synthetic opening failed' });
    await expect(start('replacement')).rejects.toThrow('synthetic opening failed');
    for (const { streamId } of streams)
      expect(await call('voice.stream.resume', { streamId }, 'recovered')).toEqual({
        ok: true,
        receivedBytes: 0,
      });
  });

  it('rechecks capacity when detached streams resume while a replacement opens', async () => {
    const streams = [];
    for (let index = 0; index < 8; index++) {
      streams.push(await start(`client-${index}`));
    }
    for (let index = 0; index < 8; index++) disconnect(`client-${index}`);
    let entered!: () => void;
    let release!: () => void;
    const opening = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const nativeStart = VoiceStream.start;
    vi.spyOn(VoiceStream, 'start').mockImplementationOnce(async (...args) => {
      const result = await nativeStart(...args);
      entered();
      await gate;
      return result;
    });
    const pending = start('replacement');
    const outcome = pending.then(
      () => 'started',
      (error: Error) => error.message
    );
    try {
      await Promise.race([opening, pending]);
      for (let index = 0; index < 8; index++)
        await call('voice.stream.resume', streams[index], `rebound-${index}`);
    } finally {
      release();
    }
    expect(await outcome).toContain('Too many voice streams');
    await expect(start('foreign')).rejects.toThrow('Too many voice streams');
  });

  it('isolates unpaired clients and does not advertise reconnect recovery without identity', async () => {
    const client = 'unpaired-first';
    const { streamId, resumable } = await start(client);
    await call('voice.stream.chunk', { streamId, audioBase64: pcm([42]) }, client);
    await expect(
      call('voice.stream.resume', { streamId }, 'unpaired-second')
    ).rejects.toMatchObject({ code: 'VOICE_STREAM_NOT_FOUND' });
    disconnect(client);
    await expect(
      call('voice.stream.resume', { streamId }, 'unpaired-second')
    ).rejects.toMatchObject({ code: 'VOICE_STREAM_NOT_FOUND' });
    expect(resumable).toBe(false);
  });

  it('cancels a detached recording from its paired owner while preserving foreign and live streams', async () => {
    const { streamId } = await start();
    await call('voice.stream.chunk', { streamId, audioBase64: pcm([77]) });
    for (const client of ['second', 'foreign', 'unpaired-stranger'])
      await call('voice.stream.cancel', { streamId }, client);
    disconnect('first');
    for (const client of ['foreign', 'unpaired-stranger'])
      await call('voice.stream.cancel', { streamId }, client);
    expect(await call('voice.stream.resume', { streamId }, 'second')).toEqual({
      ok: true,
      receivedBytes: 2,
    });
    expect(await call('voice.stream.stop', { streamId }, 'second')).toEqual({
      text: '77',
      via: 'batch',
    });
    const abandoned = await start('second');
    await call(
      'voice.stream.chunk',
      { streamId: abandoned.streamId, audioBase64: pcm([88]) },
      'second'
    );
    disconnect('second');
    expect(await call('voice.stream.cancel', abandoned, 'third')).toEqual({ ok: true });
    await expect(call('voice.stream.resume', abandoned, 'fourth')).rejects.toMatchObject({
      code: 'VOICE_STREAM_NOT_FOUND',
    });
  });

  it('defaults to PCM16 and advertises both input formats', async () => {
    expect(await call('voice.stream.start', { sampleRate: 16_000 })).toMatchObject({
      formats: ['pcm16', 'opus'],
    });
  });

  it('resumes an Opus packet split across reconnect and overlapping encoded offsets', async () => {
    const fixture = await opusFixture(3);
    const { streamId } = (await call('voice.stream.start', {
      encoding: 'opus',
      sampleRate: 16_000,
    })) as { streamId: string };
    const cut = fixture.boundaries[1] + 1;
    await call('voice.stream.chunk', {
      streamId,
      audioBase64: fixture.encoded.subarray(0, cut).toString('base64'),
      offset: 0,
    });
    disconnect('first');
    expect(await call('voice.stream.resume', { streamId }, 'second')).toEqual({
      ok: true,
      receivedBytes: cut,
    });
    await call(
      'voice.stream.chunk',
      { streamId, audioBase64: fixture.encoded.subarray(0, cut).toString('base64'), offset: 0 },
      'second'
    );
    await call(
      'voice.stream.chunk',
      {
        streamId,
        audioBase64: fixture.encoded.subarray(cut - 1).toString('base64'),
        offset: cut - 1,
      },
      'second'
    );
    const samples = [];
    for (let index = 0; index < fixture.pcm.length; index += 2)
      samples.push(fixture.pcm.readInt16LE(index));
    expect(await call('voice.stream.stop', { streamId }, 'second')).toEqual({
      text: samples.join(','),
      via: 'batch',
    });
    expect(
      events.filter(({ message }) => (message.data as { isFinal: boolean }).isFinal)
    ).toHaveLength(1);
  });

  it.each([1, 61])('keeps an incomplete Opus packet retryable at byte %i', async (cut) => {
    const fixture = await opusFixture(1);
    const { streamId } = (await call('voice.stream.start', { encoding: 'opus' })) as {
      streamId: string;
    };
    await call('voice.stream.chunk', {
      streamId,
      audioBase64: fixture.encoded.subarray(0, cut).toString('base64'),
    });
    await expect(call('voice.stream.stop', { streamId })).rejects.toMatchObject({
      code: 'VOICE_STREAM_INCOMPLETE_OPUS',
    });
    expect(await call('voice.stream.resume', { streamId })).toEqual({
      ok: true,
      receivedBytes: cut,
    });
    await call('voice.stream.chunk', {
      streamId,
      audioBase64: fixture.encoded.subarray(cut).toString('base64'),
      offset: cut,
    });
    expect(await call('voice.stream.stop', { streamId })).toEqual({
      text: Array.from({ length: fixture.pcm.length / 2 }, (_, i) =>
        fixture.pcm.readInt16LE(i * 2)
      ).join(','),
      via: 'batch',
    });
  });

  it.each([
    [0, 0],
    [0, 5],
    [1, 0, 255],
  ])('rejects malformed Opus %j and retires the stream', async (...bytes) => {
    const { streamId } = (await call('voice.stream.start', { encoding: 'opus' })) as {
      streamId: string;
    };
    await expect(
      call('voice.stream.chunk', { streamId, audioBase64: Buffer.from(bytes).toString('base64') })
    ).rejects.toMatchObject({ code: 'VOICE_STREAM_INVALID_OPUS' });
    await expect(call('voice.stream.resume', { streamId })).rejects.toMatchObject({
      code: 'VOICE_STREAM_NOT_FOUND',
    });
  });

  it.each([
    [160, 1],
    [320, 2],
  ] as const)('rejects %i-sample/%i-channel Opus', async (frameSize, channels) => {
    const fixture = await opusFixture(1, frameSize, channels);
    const { streamId } = (await call('voice.stream.start', { encoding: 'opus' })) as {
      streamId: string;
    };
    await expect(
      call('voice.stream.chunk', { streamId, audioBase64: fixture.encoded.toString('base64') })
    ).rejects.toMatchObject({ code: 'VOICE_STREAM_INVALID_OPUS' });
  });

  it('serializes pipelined Opus offsets and drains them before stop', async () => {
    const fixture = await opusFixture(3);
    const { streamId } = (await call('voice.stream.start', { encoding: 'opus' })) as {
      streamId: string;
    };
    const cut = fixture.boundaries[1];
    const first = call('voice.stream.chunk', {
      streamId,
      audioBase64: fixture.encoded.subarray(0, cut).toString('base64'),
      offset: 0,
    });
    const second = call('voice.stream.chunk', {
      streamId,
      audioBase64: fixture.encoded.subarray(cut).toString('base64'),
      offset: cut,
    });
    const stopped = call('voice.stream.stop', { streamId });
    expect(await first).toEqual({ ok: true });
    expect(await second).toEqual({ ok: true });
    const expected = Array.from({ length: fixture.pcm.length / 2 }, (_, i) =>
      fixture.pcm.readInt16LE(i * 2)
    ).join(',');
    expect(await stopped).toEqual({ text: expected, via: 'batch' });
  });

  it('preserves the previous recording if decoder startup fails', async () => {
    const previous = await start();
    await call('voice.stream.chunk', { ...previous, audioBase64: pcm([77]) });
    vi.mocked(opusInputDefaults.create).mockRejectedValueOnce(
      new Error('Synthetic decoder startup failure')
    );
    await expect(call('voice.stream.start', { encoding: 'opus' })).rejects.toMatchObject({
      code: 'VOICE_STREAM_DECODER_FAILED',
    });
    expect(await call('voice.stream.resume', previous)).toEqual({ ok: true, receivedBytes: 2 });
    expect(await call('voice.stream.stop', previous)).toEqual({ text: '77', via: 'batch' });
  });

  it('bounds pending Opus requests without accepting bytes on overload', async () => {
    const fixture = await opusFixture(1);
    const { streamId } = (await call('voice.stream.start', { encoding: 'opus' })) as {
      streamId: string;
    };
    const responses = await Promise.allSettled(
      Array.from({ length: 129 }, () =>
        call('voice.stream.chunk', { streamId, audioBase64: '', offset: 0 })
      )
    );
    const refused = responses.filter((result) => result.status === 'rejected');
    expect(refused).toHaveLength(1);
    expect((refused[0] as PromiseRejectedResult).reason.message).toContain(
      'Voice input queue is full'
    );
    expect(await call('voice.stream.resume', { streamId })).toEqual({ ok: true, receivedBytes: 0 });
    await call('voice.stream.chunk', {
      streamId,
      audioBase64: fixture.encoded.toString('base64'),
      offset: 0,
    });
    expect(await call('voice.stream.stop', { streamId })).toMatchObject({ via: 'batch' });
  });

  it('enforces the decoded audio limit on compressed input', async () => {
    const fixture = await opusFixture(1);
    const { streamId } = (await call('voice.stream.start', { encoding: 'opus' })) as {
      streamId: string;
    };
    const audio = Buffer.concat(
      Array(Math.floor((10 * 1024 * 1024 - 44) / 640) + 1).fill(fixture.encoded)
    );
    await expect(
      call('voice.stream.chunk', { streamId, audioBase64: audio.toString('base64') })
    ).rejects.toMatchObject({
      code: 'VOICE_STREAM_INVALID_OPUS',
      message: expect.stringContaining('10 MB'),
    });
    await expect(call('voice.stream.resume', { streamId })).rejects.toMatchObject({
      code: 'VOICE_STREAM_NOT_FOUND',
    });
  });

  it('releases Opus batch workers so an isolated caller exits naturally', () => {
    const run = mkdtempSync(join(tmpdir(), 'opus-worker-exit-'));
    for (const part of ['home', 'tmp', 'data']) mkdirSync(join(run, part));
    try {
      const fixture = fileURLToPath(
        new URL('../../../helpers/opus-worker-exit.ts', import.meta.url)
      );
      const result = spawnSync('bun', [fixture], {
        env: {
          PATH: process.env.PATH,
          NODE_ENV: 'test',
          HOME: join(run, 'home'),
          HYPERNEO_DATA_DIR: join(run, 'data'),
          TMPDIR: join(run, 'tmp'),
          SystemRoot: process.env.SystemRoot,
        },
        timeout: 10_000,
        killSignal: 'SIGKILL',
        encoding: 'utf8',
      });
      expect(result.stdout).toContain('batch-stop-complete');
      expect(result.error).toBeUndefined();
      expect(result.status).toBe(0);
      expect(result.signal).toBeNull();
    } finally {
      rmSync(run, { recursive: true, force: true });
    }
  }, 15_000);
});
