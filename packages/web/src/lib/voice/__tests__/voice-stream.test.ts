import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { MessageHub } from '@hyperneo/shared';
import { openVoiceStream, VOICE_STREAM_STOP_TIMEOUT_MS } from '../voice-stream.ts';
import { setVoiceLanguage } from '../voice-language.ts';

beforeEach(() => {
  const stored = new Map<string, string>();
  vi.mocked(localStorage.getItem).mockImplementation((key) => stored.get(key) ?? null);
  vi.mocked(localStorage.setItem).mockImplementation((key, value) => {
    stored.set(key, value);
  });
});

type Handler = (data: unknown) => void;

function fakeHub(
  respond: (method: string, data: Record<string, unknown>) => unknown | Promise<unknown>
) {
  const handlers = new Map<string, Set<Handler>>();
  const request = vi.fn(async (method: string, data: Record<string, unknown>) =>
    respond(method, data)
  );
  const hub = {
    request,
    onEvent: (method: string, handler: Handler) => {
      const set = handlers.get(method) ?? new Set<Handler>();
      set.add(handler);
      handlers.set(method, set);
      return () => set.delete(handler);
    },
  };
  const emit = (method: string, data: unknown) => {
    for (const handler of handlers.get(method) ?? []) handler(data);
  };
  return { hub: hub as unknown as MessageHub, request, emit };
}

const streaming = (method: string) =>
  method === 'voice.stream.start'
    ? { streamId: 'stream-1', via: 'streaming' }
    : method === 'voice.stream.stop'
      ? { text: 'hello neo', via: 'streaming' }
      : { ok: true };

function calls(request: ReturnType<typeof vi.fn>, method: string) {
  return request.mock.calls.filter(([name]) => name === method);
}

describe('openVoiceStream', () => {
  it.each(['auto', 'zh', 'en'] as const)(
    'sends the %s choice on every new connection',
    async (language) => {
      setVoiceLanguage(language);
      const { hub, request } = fakeHub(streaming);
      for (let index = 0; index < 2; index++) {
        const live = openVoiceStream(hub, vi.fn());
        await live.finish();
        live.close();
      }
      expect(calls(request, 'voice.stream.start')).toEqual(
        Array(2).fill([
          'voice.stream.start',
          { encoding: 'pcm16', sampleRate: 16_000, ...(language === 'auto' ? {} : { language }) },
        ])
      );
    }
  );

  it('keeps the active connection unchanged and applies a new choice to the next one', async () => {
    const { hub, request } = fakeHub(streaming);
    const first = openVoiceStream(hub, vi.fn());
    setVoiceLanguage('zh');
    expect(calls(request, 'voice.stream.start')).toEqual([
      ['voice.stream.start', { encoding: 'pcm16', sampleRate: 16_000 }],
    ]);
    await first.finish();
    first.close();
    const next = openVoiceStream(hub, vi.fn());
    await next.finish();
    expect(calls(request, 'voice.stream.start')[1]).toEqual([
      'voice.stream.start',
      { encoding: 'pcm16', sampleRate: 16_000, language: 'zh' },
    ]);
    next.close();
  });

  it('streams PCM16 at 16 kHz and stops with the extended timeout', async () => {
    const { hub, request } = fakeHub(streaming);
    const live = openVoiceStream(hub, vi.fn());
    live.push(new Float32Array(1_600).fill(0.5), 16_000);
    expect(await live.finish()).toBe('hello neo');
    expect(request).toHaveBeenCalledWith('voice.stream.start', {
      encoding: 'pcm16',
      sampleRate: 16_000,
    });
    const chunks = calls(request, 'voice.stream.chunk');
    expect(chunks).toHaveLength(1);
    const bytes = atob((chunks[0][1] as { audioBase64: string }).audioBase64);
    expect(bytes.length).toBe(3_200);
    expect(request).toHaveBeenLastCalledWith(
      'voice.stream.stop',
      { streamId: 'stream-1' },
      { timeout: VOICE_STREAM_STOP_TIMEOUT_MS }
    );
  });

  it('downsamples 48 kHz capture before sending', async () => {
    const { hub, request } = fakeHub(streaming);
    const live = openVoiceStream(hub, vi.fn());
    live.push(new Float32Array(4_800), 48_000);
    await live.finish();
    const [, data] = calls(request, 'voice.stream.chunk')[0];
    expect(atob((data as { audioBase64: string }).audioBase64).length).toBe(3_200);
  });

  it('forwards only its own stream text until closed', async () => {
    const { hub, emit } = fakeHub(streaming);
    const onText = vi.fn();
    const live = openVoiceStream(hub, onText);
    await Promise.resolve();
    await Promise.resolve();
    emit('voice.stream.text', { streamId: 'other', text: 'nope', isFinal: false });
    emit('voice.stream.text', { streamId: 'stream-1', text: 'hel', isFinal: false });
    live.close();
    emit('voice.stream.text', { streamId: 'stream-1', text: 'hello', isFinal: false });
    expect(onText.mock.calls).toEqual([['hel']]);
  });

  it('leaves batch mode to the existing transcription', async () => {
    const { hub, request } = fakeHub((method) =>
      method === 'voice.stream.start' ? { streamId: 's', via: 'batch', fallback: 'off' } : null
    );
    const live = openVoiceStream(hub, vi.fn());
    live.push(new Float32Array(16_000), 16_000);
    expect(await live.finish()).toBeNull();
    expect(request.mock.calls.map(([name]) => name)).toEqual(['voice.stream.start']);
  });

  it('falls back when the stream cannot start or a chunk is lost', async () => {
    const refused = fakeHub(() => {
      throw new Error('Voice stream rate limit exceeded');
    });
    expect(await openVoiceStream(refused.hub, vi.fn()).finish()).toBeNull();

    const lossy = fakeHub((method) => {
      if (method === 'voice.stream.chunk') throw new Error('gone');
      return streaming(method);
    });
    const live = openVoiceStream(lossy.hub, vi.fn());
    live.push(new Float32Array(1_600), 16_000);
    expect(await live.finish()).toBeNull();
    expect(calls(lossy.request, 'voice.stream.stop')).toHaveLength(0);
  });

  it('cancels an abandoned stream on close without stopping it, but not one already stopped', async () => {
    const abandoned = fakeHub(streaming);
    const live = openVoiceStream(abandoned.hub, vi.fn());
    live.push(new Float32Array(1_600), 16_000);
    live.close();
    live.close();
    await vi.waitFor(() =>
      expect(calls(abandoned.request, 'voice.stream.cancel')).toEqual([
        ['voice.stream.cancel', { streamId: 'stream-1' }],
      ])
    );
    expect(calls(abandoned.request, 'voice.stream.stop')).toHaveLength(0);

    const finished = fakeHub(streaming);
    const done = openVoiceStream(finished.hub, vi.fn());
    await done.finish();
    done.close();
    await Promise.resolve();
    await Promise.resolve();
    expect(calls(finished.request, 'voice.stream.stop')).toHaveLength(1);
    expect(calls(finished.request, 'voice.stream.cancel')).toHaveLength(0);
  });

  it('retries stop without resending audio, and falls back once the stream is gone', async () => {
    let stops = 0;
    const { hub, request } = fakeHub((method) => {
      if (method !== 'voice.stream.stop') return streaming(method);
      stops += 1;
      if (stops === 1) throw new Error('Voice transcription rate limit exceeded');
      throw new Error('Unknown voice stream');
    });
    const live = openVoiceStream(hub, vi.fn());
    live.push(new Float32Array(1_600), 16_000);
    await expect(live.finish()).rejects.toThrow('rate limit');
    expect(await live.finish()).toBeNull();
    expect(calls(request, 'voice.stream.chunk')).toHaveLength(1);
    expect(stops).toBe(2);
  });
});
