import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { MessageHub } from '@hyperneo/shared';

const createEncoder = vi.hoisted(() => vi.fn());
vi.mock('../voice-opus-encoder.ts', () => ({ createVoiceOpusEncoder: createEncoder }));
import { openVoiceStream } from '../voice-stream.ts';

function hubFor(respond: (method: string, data: Record<string, unknown>) => unknown) {
  const request = vi.fn(async (method: string, data: Record<string, unknown>) =>
    respond(method, data)
  );
  return { request, hub: { request, onEvent: () => () => {} } as unknown as MessageHub };
}

const reply = (method: string) =>
  method === 'voice.stream.start'
    ? { streamId: 's', via: 'streaming', formats: ['pcm16', 'opus'] }
    : method === 'voice.stream.stop'
      ? { text: 'heard' }
      : { ok: true };

beforeEach(() => {
  createEncoder.mockReset();
});

describe('Opus live voice', () => {
  it('sends framed encoded bytes before stop and reports the selected format', async () => {
    const packet = new Uint8Array([3, 0, 0xf8, 0xff, 0xfe]);
    const codec = { push: vi.fn(), finish: vi.fn(async () => {}), close: vi.fn() };
    createEncoder.mockImplementation(async (onPacket) => {
      codec.push.mockImplementation(() => onPacket(packet));
      return codec;
    });
    const { hub, request } = hubFor(reply);
    const onFormat = vi.fn();
    const live = openVoiceStream(hub, vi.fn(), { onFormat });
    live.push(new Float32Array(3200).fill(0.2), 16_000);
    expect(await live.finish()).toBe('heard');
    expect(onFormat).toHaveBeenCalledWith('opus');
    expect(request).toHaveBeenCalledWith('voice.stream.start', {
      encoding: 'opus',
      sampleRate: 16_000,
    });
    expect(request).toHaveBeenCalledWith('voice.stream.chunk', {
      streamId: 's',
      audioBase64: btoa(String.fromCharCode(...packet)),
    });
    expect(codec.finish).toHaveBeenCalledOnce();
    expect(request.mock.calls.map(([method]) => method)).toEqual([
      'voice.stream.start',
      'voice.stream.chunk',
      'voice.stream.stop',
    ]);
    live.close();
  });

  it('batches 20 ms Opus packets to avoid an RPC for each frame', async () => {
    const packet = new Uint8Array([3, 0, 0xf8, 0xff, 0xfe]);
    createEncoder.mockImplementation(async (onPacket) => ({
      push: () => {
        for (let i = 0; i < 10; i++) onPacket(packet);
      },
      finish: async () => {},
      close: () => {},
    }));
    const { hub, request } = hubFor(reply);
    const live = openVoiceStream(hub, vi.fn());
    live.push(new Float32Array(3200), 16_000);
    await live.finish();
    const chunks = request.mock.calls.filter(([method]) => method === 'voice.stream.chunk');
    expect(chunks).toHaveLength(1);
    expect(atob((chunks[0][1] as { audioBase64: string }).audioBase64).length).toBe(50);
    live.close();
  });

  it('visibly selects PCM16 when the browser does not support Opus', async () => {
    createEncoder.mockResolvedValue(null);
    const { hub, request } = hubFor(reply);
    const onFormat = vi.fn();
    const live = openVoiceStream(hub, vi.fn(), { onFormat });
    live.push(new Float32Array(1600), 16_000);
    await live.finish();
    expect(onFormat).toHaveBeenCalledWith('pcm16');
    expect(request).toHaveBeenCalledWith('voice.stream.start', {
      encoding: 'pcm16',
      sampleRate: 16_000,
    });
    live.close();
  });

  it('visibly falls back when an older daemon explicitly rejects Opus', async () => {
    const codec = { push: vi.fn(), finish: vi.fn(async () => {}), close: vi.fn() };
    createEncoder.mockResolvedValue(codec);
    const { hub, request } = hubFor((method, data) => {
      if (method === 'voice.stream.start' && data.encoding === 'opus')
        throw new Error('Voice streams take pcm16 audio at 16000 Hz');
      return reply(method);
    });
    const onFormat = vi.fn();
    const live = openVoiceStream(hub, vi.fn(), { onFormat });
    live.push(new Float32Array(1600), 16_000);
    expect(await live.finish()).toBe('heard');
    expect(onFormat).toHaveBeenCalledWith('pcm16');
    expect(codec.close).toHaveBeenCalledOnce();
    expect(request).toHaveBeenCalledWith('voice.stream.start', {
      encoding: 'pcm16',
      sampleRate: 16_000,
    });
    live.close();
  });

  it('does not start a PCM replacement after recording is cancelled during negotiation', async () => {
    const codec = { push: vi.fn(), finish: vi.fn(async () => {}), close: vi.fn() };
    createEncoder.mockResolvedValue(codec);
    let release: (value: unknown) => void = () => {};
    const { hub, request } = hubFor((method) => {
      if (method === 'voice.stream.start')
        return new Promise((resolve) => {
          release = resolve;
        });
      return { ok: true };
    });
    const live = openVoiceStream(hub, vi.fn());
    await vi.waitFor(() => expect(request).toHaveBeenCalledOnce());
    live.close();
    release({ streamId: 's', via: 'streaming', formats: ['pcm16'] });
    await vi.waitFor(() =>
      expect(request).toHaveBeenCalledWith('voice.stream.cancel', { streamId: 's' })
    );
    expect(request.mock.calls.filter(([method]) => method === 'voice.stream.start')).toHaveLength(
      1
    );
    expect(codec.close).toHaveBeenCalledOnce();
  });

  it('surfaces encoder initialization errors instead of silently using PCM16', async () => {
    createEncoder.mockImplementation(() => {
      throw new Error('Opus startup failed');
    });
    const { hub, request } = hubFor(reply);
    const onError = vi.fn();
    const live = openVoiceStream(hub, vi.fn(), { onError });
    await expect(live.finish()).rejects.toThrow('Opus startup failed');
    expect(onError).toHaveBeenCalledWith(
      expect.objectContaining({ message: 'Opus startup failed' })
    );
    expect(request).not.toHaveBeenCalled();
    live.close();
  });

  it('surfaces a failed encoded chunk instead of claiming a transcript', async () => {
    const packet = new Uint8Array([3, 0, 0xf8, 0xff, 0xfe]);
    createEncoder.mockImplementation(async (onPacket) => ({
      push: () => onPacket(packet),
      finish: async () => {},
      close: () => {},
    }));
    const { hub, request } = hubFor((method) => {
      if (method === 'voice.stream.chunk') throw new Error('network lost');
      return reply(method);
    });
    const onError = vi.fn();
    const live = openVoiceStream(hub, vi.fn(), { onError });
    live.push(new Float32Array(3200), 16_000);
    await expect(live.finish()).rejects.toThrow('network lost');
    expect(onError).toHaveBeenCalledWith(expect.objectContaining({ message: 'network lost' }));
    expect(request.mock.calls.map(([method]) => method)).not.toContain('voice.stream.stop');
    live.close();
  });
});
