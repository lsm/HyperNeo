import { describe, expect, it, vi } from 'vitest';
import type { MessageHub } from '@hyperneo/shared';
import { openNeoSpeechPlayer } from '../neo-speech-player.ts';

type Handler = (data: unknown) => void;

const ID_A = '00000000-0000-4000-8000-00000000000a';
const ID_B = '00000000-0000-4000-8000-00000000000b';

function fakeHub() {
  const handlers = new Set<Handler>();
  const request = vi.fn(async () => ({ ok: true }));
  const hub = {
    request,
    onEvent: (method: string, handler: Handler) => {
      if (method === 'neo.speech') handlers.add(handler);
      return () => handlers.delete(handler);
    },
  } as unknown as MessageHub;
  const emit = (data: unknown) => {
    for (const handler of [...handlers]) handler(data);
  };
  const acks = () =>
    request.mock.calls
      .filter((call) => (call as unknown[])[0] === 'operation.invoke')
      .map((call) => (call as unknown[])[1] as { name: string; input: Record<string, unknown> })
      .filter((call) => call.name === 'neo.speech.ack')
      .map((call) => `${call.input.id === ID_A ? 'A' : 'B'}:${call.input.state}`);
  return { hub, emit, acks, listeners: () => handlers.size };
}

interface FakeSource {
  samples: number[];
  when: number;
  stopped: boolean;
  onended: (() => void) | null;
}

function fakeAudio() {
  const sources: FakeSource[] = [];
  let closed = false;
  const context = {
    currentTime: 0,
    destination: {},
    resume: vi.fn(async () => {}),
    close: vi.fn(async () => {
      closed = true;
    }),
    createBuffer: (_channels: number, length: number, sampleRate: number) => {
      const data = new Float32Array(length);
      return { duration: length / sampleRate, getChannelData: () => data };
    },
    createBufferSource: () => {
      let entry: FakeSource | null = null;
      const source = {
        buffer: null as { getChannelData: () => Float32Array } | null,
        onended: null as (() => void) | null,
        connect: vi.fn(),
        start(when: number) {
          entry = {
            samples: Array.from(this.buffer?.getChannelData() ?? []),
            when,
            stopped: false,
            onended: () => this.onended?.(),
          };
          sources.push(entry);
        },
        stop() {
          if (entry) entry.stopped = true;
        },
      };
      return source;
    },
  };
  const finish = (index: number) => sources[index]?.onended?.();
  return {
    create: () => context as unknown as AudioContext,
    sources,
    finish,
    closed: () => closed,
  };
}

const pcm = (...values: number[]) => {
  const bytes = new Uint8Array(values.length * 2);
  const view = new DataView(bytes.buffer);
  values.forEach((value, index) => view.setInt16(index * 2, value, true));
  return bytes;
};
const b64 = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes));
const say = (id: string, sessionId = 'neo') => ({
  type: 'say',
  id,
  sessionId,
  text: 'hello',
  format: 'pcm16',
  sampleRate: 24000,
});
const audio = (id: string, seq: number, bytes: Uint8Array, sessionId = 'neo') => ({
  type: 'audio',
  id,
  sessionId,
  seq,
  pcm: b64(bytes),
});
const end = (id: string, seq: number) => ({ type: 'end', id, sessionId: 'neo', seq });

describe('openNeoSpeechPlayer', () => {
  it('plays chunks in sequence order and acknowledges playing then played', async () => {
    const { hub, emit, acks } = fakeHub();
    const sound = fakeAudio();
    openNeoSpeechPlayer(hub, 'neo', { createContext: sound.create });
    emit(say(ID_A));
    emit(audio(ID_A, 1, pcm(-16384)));
    expect(sound.sources).toHaveLength(0);
    emit(audio(ID_A, 0, pcm(16384)));
    emit(end(ID_A, 2));
    expect(sound.sources.map((source) => source.samples)).toEqual([[0.5], [-0.5]]);
    expect(sound.sources[1].when).toBeGreaterThan(sound.sources[0].when);
    await vi.waitFor(() => expect(acks()).toEqual(['A:playing']));
    sound.finish(0);
    sound.finish(1);
    await vi.waitFor(() => expect(acks()).toEqual(['A:playing', 'A:played']));
  });

  it('keeps a sample that is split across two chunks', () => {
    const { hub, emit } = fakeHub();
    const sound = fakeAudio();
    openNeoSpeechPlayer(hub, 'neo', { createContext: sound.create });
    const bytes = pcm(8192, -8192);
    emit(say(ID_A));
    emit(audio(ID_A, 0, bytes.subarray(0, 3)));
    emit(audio(ID_A, 1, bytes.subarray(3)));
    expect(sound.sources.flatMap((source) => source.samples)).toEqual([0.25, -0.25]);
  });

  it('ignores speech for another session', () => {
    const { hub, emit, acks } = fakeHub();
    const sound = fakeAudio();
    openNeoSpeechPlayer(hub, 'neo', { createContext: sound.create });
    emit(say(ID_A, 'other'));
    emit(audio(ID_A, 0, pcm(1000), 'other'));
    expect(sound.sources).toHaveLength(0);
    expect(acks()).toEqual([]);
  });

  it('starts the next reply only after the current one has played', async () => {
    const { hub, emit, acks } = fakeHub();
    const sound = fakeAudio();
    openNeoSpeechPlayer(hub, 'neo', { createContext: sound.create });
    emit(say(ID_A));
    emit(say(ID_B));
    emit(audio(ID_B, 0, pcm(-16384)));
    emit(end(ID_B, 1));
    emit(audio(ID_A, 0, pcm(16384)));
    emit(end(ID_A, 1));
    expect(sound.sources.map((source) => source.samples)).toEqual([[0.5]]);
    sound.finish(0);
    await vi.waitFor(() => expect(sound.sources.map((source) => source.samples)).toHaveLength(2));
    expect(sound.sources[1].samples).toEqual([-0.5]);
    sound.finish(1);
    await vi.waitFor(() =>
      expect(acks()).toEqual(['A:playing', 'A:played', 'B:playing', 'B:played'])
    );
  });

  it('drops a reply whose synthesis failed and moves to the next one', async () => {
    const { hub, emit, acks } = fakeHub();
    const sound = fakeAudio();
    openNeoSpeechPlayer(hub, 'neo', { createContext: sound.create });
    emit(say(ID_A));
    emit(say(ID_B));
    emit(audio(ID_A, 0, pcm(16384)));
    emit({ type: 'failed', id: ID_A, sessionId: 'neo' });
    expect(sound.sources[0].stopped).toBe(true);
    emit(audio(ID_B, 0, pcm(-16384)));
    expect(sound.sources.map((source) => source.samples)).toEqual([[0.5], [-0.5]]);
    await vi.waitFor(() => expect(acks()).toEqual(['A:playing', 'B:playing']));
  });

  it('cancels playing and queued replies when the listener interrupts', async () => {
    const { hub, emit, acks } = fakeHub();
    const sound = fakeAudio();
    const player = openNeoSpeechPlayer(hub, 'neo', { createContext: sound.create });
    emit(say(ID_A));
    emit(say(ID_B));
    emit(audio(ID_A, 0, pcm(16384)));
    player.interrupt();
    expect(sound.sources[0].stopped).toBe(true);
    emit(audio(ID_B, 0, pcm(-16384)));
    expect(sound.sources).toHaveLength(1);
    await vi.waitFor(() => expect(acks()).toEqual(['A:playing', 'A:cancelled', 'B:cancelled']));
  });

  it('clears everything without receipts when the daemon stops speech', async () => {
    const { hub, emit, acks } = fakeHub();
    const sound = fakeAudio();
    openNeoSpeechPlayer(hub, 'neo', { createContext: sound.create });
    emit(say(ID_A));
    emit(audio(ID_A, 0, pcm(16384)));
    emit({ type: 'stop', sessionId: 'neo' });
    expect(sound.sources[0].stopped).toBe(true);
    emit(audio(ID_A, 1, pcm(16384)));
    expect(sound.sources).toHaveLength(1);
    await vi.waitFor(() => expect(acks()).toEqual(['A:playing']));
  });

  it('stops listening for speech and releases audio on close', async () => {
    const { hub, emit, acks, listeners } = fakeHub();
    const sound = fakeAudio();
    const player = openNeoSpeechPlayer(hub, 'neo', { createContext: sound.create });
    emit(say(ID_A));
    emit(audio(ID_A, 0, pcm(16384)));
    player.close();
    expect(listeners()).toBe(0);
    expect(sound.closed()).toBe(true);
    await vi.waitFor(() => expect(acks()).toEqual(['A:playing', 'A:cancelled']));
  });
});
