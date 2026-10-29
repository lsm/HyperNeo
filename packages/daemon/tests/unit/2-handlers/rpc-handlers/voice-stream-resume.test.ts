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
      deviceOf: (id) => ({ deviceId: id === 'foreign' ? 'device-b' : 'device-a', kind: 'human' }),
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

  it('lets legacy reconnects replace their detached recording without exhausting capacity', async () => {
    let latest = '';
    for (let index = 0; index < 9; index++) {
      const client = `reconnect-${index}`;
      latest = (await start(client)).streamId;
      await call('voice.stream.chunk', { streamId: latest, audioBase64: pcm([index]) }, client);
      if (index < 8) disconnect(client);
    }
    expect(await call('voice.stream.stop', { streamId: latest }, 'reconnect-8')).toEqual({
      text: '8',
      via: 'batch',
    });
  });

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
});
