import type { MessageHub } from '@hyperneo/shared';
import { invokeOperation } from '../operations.ts';

type SpeechEvent =
  | { type: 'say'; id: string; sessionId: string; format?: 'pcm16'; sampleRate?: number }
  | { type: 'audio'; id: string; sessionId: string; seq: number; pcm: string }
  | { type: 'end'; id: string; sessionId: string; seq: number }
  | { type: 'failed'; id: string; sessionId: string }
  | { type: 'stop'; sessionId: string };

interface Utterance {
  id: string;
  sampleRate: number;
  chunks: Map<number, Uint8Array>;
  next: number;
  end: number | null;
  carry: Uint8Array;
  sources: Set<AudioBufferSourceNode>;
  started: boolean;
}

export interface NeoSpeechPlayer {
  interrupt(): void;
  close(): void;
}

interface NeoSpeechPlayerOptions {
  createContext?: () => AudioContext;
}

const decode = (base64: string) => Uint8Array.from(atob(base64), (char) => char.charCodeAt(0));

export function openNeoSpeechPlayer(
  hub: MessageHub,
  sessionId: string,
  options: NeoSpeechPlayerOptions = {}
): NeoSpeechPlayer {
  const context = (options.createContext ?? (() => new AudioContext()))();
  let queue: Utterance[] = [];
  let playhead = 0;
  let audible = true;

  const ack = (id: string, state: 'playing' | 'played' | 'cancelled' | 'failed') => {
    invokeOperation(hub, 'neo.speech.ack', { sessionId, id, state }).catch(() => {});
  };

  const silence = (utterance: Utterance) => {
    for (const source of utterance.sources) {
      source.onended = null;
      source.stop();
    }
    utterance.sources.clear();
    playhead = context.currentTime;
  };

  const schedule = (utterance: Utterance, bytes: Uint8Array) => {
    const count = bytes.length >> 1;
    if (!count) return;
    const view = new DataView(bytes.buffer, bytes.byteOffset, count * 2);
    const buffer = context.createBuffer(1, count, utterance.sampleRate);
    const samples = buffer.getChannelData(0);
    for (let index = 0; index < count; index++)
      samples[index] = view.getInt16(index * 2, true) / 32768;
    const source = context.createBufferSource();
    source.buffer = buffer;
    source.connect(context.destination);
    const at = Math.max(context.currentTime, playhead);
    source.start(at);
    playhead = at + buffer.duration;
    utterance.sources.add(source);
    source.onended = () => {
      utterance.sources.delete(source);
      pump();
    };
    if (!utterance.started) {
      utterance.started = true;
      ack(utterance.id, 'playing');
    }
  };

  const finish = (utterance: Utterance, state?: 'played') => {
    queue = queue.filter((item) => item !== utterance);
    silence(utterance);
    if (state) ack(utterance.id, state);
    pump();
  };

  const pump = () => {
    const utterance = queue[0];
    if (!utterance) return;
    for (let chunk = utterance.chunks.get(utterance.next); chunk; ) {
      utterance.chunks.delete(utterance.next++);
      const bytes = new Uint8Array(utterance.carry.length + chunk.length);
      bytes.set(utterance.carry);
      bytes.set(chunk, utterance.carry.length);
      utterance.carry = bytes.subarray(bytes.length & ~1);
      schedule(utterance, bytes);
      chunk = utterance.chunks.get(utterance.next);
    }
    if (utterance.end !== null && utterance.next >= utterance.end && !utterance.sources.size)
      finish(utterance, 'played');
  };

  const drop = () => {
    queue.forEach(silence);
    queue = [];
  };
  const unwatch = hub.onConnection((state) => {
    if (state !== 'connected') drop();
  });

  context.resume().catch(() => {
    audible = false;
    for (const utterance of queue.splice(0)) ack(utterance.id, 'failed');
  });

  const unsubscribe = hub.onEvent<SpeechEvent>('neo.speech', (event) => {
    if (event?.sessionId !== sessionId) return;
    if (event.type === 'stop') return drop();
    const utterance = queue.find((item) => item.id === event.id);
    if (event.type === 'say') {
      if (event.format !== 'pcm16' || utterance) return;
      if (!audible) return ack(event.id, 'failed');
      queue.push({
        id: event.id,
        sampleRate: event.sampleRate ?? 24000,
        chunks: new Map(),
        next: 0,
        end: null,
        carry: new Uint8Array(0),
        sources: new Set(),
        started: false,
      });
    } else if (!utterance) return;
    else if (event.type === 'failed') return finish(utterance);
    else if (event.type === 'audio') utterance.chunks.set(event.seq, decode(event.pcm));
    else utterance.end = event.seq;
    pump();
  });

  const interrupt = () => {
    const cancelled = queue;
    queue = [];
    for (const utterance of cancelled) {
      silence(utterance);
      ack(utterance.id, 'cancelled');
    }
  };

  return {
    interrupt,
    close() {
      interrupt();
      unsubscribe();
      unwatch();
      context.close().catch(() => {});
    },
  };
}
