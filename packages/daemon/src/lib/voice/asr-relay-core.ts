import WebSocket from 'ws';
import type { VoiceStreamProtocol } from '@hyperneo/shared';
import { joinFinals, streamProtocol, type StreamProtocol } from './stream-protocols.ts';
import { voiceSocketErrorCode, voiceSocketReason, voicePeerReasonBytes } from './diagnostics.ts';

export const ASR_CLOSE_TIMEOUT_MS = 5_000;

export interface AsrRelayOpen {
  streamId: string;
  clientId?: string;
  url: string;
  protocolName: VoiceStreamProtocol;
  wsOptions: Record<string, unknown>;
}

export type AsrRelayEvent =
  | { type: 'opened' }
  | { type: 'open_failed'; reason: string }
  | { type: 'text'; text: string }
  | { type: 'finished'; ok: boolean; text: string }
  | { type: 'dead' }
  | {
      type: 'diag';
      name: 'voice.asr.error' | 'voice.asr.close' | 'voice.stream.end';
      metadata: Record<string, unknown>;
    };

export interface AsrCore {
  audio(pcm: Uint8Array): void;
  finish(): void;
  close(initiator: 'client' | 'relay'): void;
  abortLateOpen(): void;
}

export function protocolFor(name: VoiceStreamProtocol): StreamProtocol | null {
  return streamProtocol(name);
}

export function startAsrCore(open: AsrRelayOpen, emit: (event: AsrRelayEvent) => void): AsrCore {
  const startedAt = Date.now();
  const protocol = protocolFor(open.protocolName);
  let socket: WebSocket | null = null;
  let opened = false;
  let lateAbort = false;
  let closeInitiator: 'client' | 'relay' | null = null;
  let cancelled = false;
  let finishWaiter: ((ok: boolean) => void) | null = null;
  let lastAudioSentAt: number | null = null;
  let lastResultAt: number | null = null;
  let lastPingAt: number | null = null;
  let lastPongAt: number | null = null;
  const finals: string[] = [];
  let partial = '';

  const text = () => joinFinals([...finals, partial]);
  const openSocket = () => {
    socket = new WebSocket(open.url, open.wsOptions as WebSocket.ClientOptions);
    const owned = socket;
    owned.on('error', (error) => {
      if (opened) {
        if (socket === owned) socket = null;
        emit({ type: 'dead' });
        return;
      }
      emit({
        type: 'diag',
        name: 'voice.asr.error',
        metadata: {
          streamId: open.streamId,
          clientId: open.clientId,
          reason: 'socket_error',
          code: voiceSocketErrorCode(error),
        },
      });
      emit({ type: 'open_failed', reason: error?.message || 'connection failed' });
    });
    owned.on('ping', () => {
      lastPingAt = Date.now();
    });
    owned.on('pong', () => {
      lastPongAt = Date.now();
    });
    owned.on('close', (code, reason) => {
      emit({
        type: 'diag',
        name: 'voice.asr.close',
        metadata: {
          streamId: open.streamId,
          clientId: open.clientId,
          code,
          reason: voiceSocketReason(code),
          peerReasonBytes: voicePeerReasonBytes(reason),
        },
      });
      if (!opened) return;
      if (socket === owned) socket = null;
      emit({
        type: 'diag',
        name: 'voice.stream.end',
        metadata: {
          streamId: open.streamId,
          clientId: open.clientId,
          closedBy: closeInitiator ?? 'server',
          code,
          reason: voiceSocketReason(code),
          peerReasonBytes: voicePeerReasonBytes(reason),
          durationMs: Date.now() - startedAt,
          sinceLastAudioMs: since(lastAudioSentAt),
          sinceLastResultMs: since(lastResultAt),
          sinceLastPingMs: since(lastPingAt),
          sinceLastPongMs: since(lastPongAt),
        },
      });
      finishWaiter?.(true);
      finishWaiter = null;
      emit({ type: 'dead' });
    });
    owned.once('open', () => {
      if (lateAbort) {
        owned.once('close', (code, reason) => {
          emit({
            type: 'diag',
            name: 'voice.stream.end',
            metadata: {
              streamId: open.streamId,
              clientId: open.clientId,
              closedBy: 'relay',
              code,
              reason: voiceSocketReason(code),
              peerReasonBytes: voicePeerReasonBytes(reason),
              durationMs: Date.now() - startedAt,
              sinceLastAudioMs: since(lastAudioSentAt),
              sinceLastResultMs: since(lastResultAt),
              sinceLastPingMs: since(lastPingAt),
              sinceLastPongMs: since(lastPongAt),
            },
          });
          emit({ type: 'dead' });
        });
        owned.close(1000);
        return;
      }
      for (const message of protocol?.opening() ?? []) owned.send(message);
      opened = true;
      socket = owned;
      emit({ type: 'opened' });
    });
    owned.on('message', (data, isBinary) => {
      const parsed = isBinary || cancelled ? null : protocol?.parse(data.toString());
      if (!parsed) return;
      lastResultAt = Date.now();
      if (parsed.isFinal) {
        if (parsed.text) finals.push(parsed.text);
        partial = '';
      } else partial = parsed.text;
      emit({ type: 'text', text: text() });
    });
  };
  const since = (at: number | null) => (at === null ? null : Date.now() - at);
  openSocket();

  return {
    audio(pcm) {
      if (socket?.readyState === WebSocket.OPEN) {
        socket.send(protocol?.audio(pcm) ?? pcm);
        lastAudioSentAt = Date.now();
      }
    },
    finish() {
      if (!socket || !protocol) {
        emit({ type: 'finished', ok: false, text: text() });
        return;
      }
      const timer = setTimeout(() => {
        finishWaiter = null;
        emit({ type: 'finished', ok: false, text: text() });
      }, ASR_CLOSE_TIMEOUT_MS);
      finishWaiter = (ok) => {
        clearTimeout(timer);
        finishWaiter = null;
        emit({ type: 'finished', ok, text: text() });
      };
      socket.send(protocol.finish());
    },
    close(initiator) {
      if (!closeInitiator) closeInitiator = initiator;
      if (initiator === 'client') cancelled = true;
      const owned = socket;
      socket = null;
      owned?.close(1000);
    },
    abortLateOpen() {
      lateAbort = true;
      if (!opened) return;
      if (!closeInitiator) closeInitiator = 'relay';
      const owned = socket;
      socket = null;
      owned?.close(1000);
    },
  };
}
