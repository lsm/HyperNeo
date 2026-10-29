import { createEventMessage, type MessageHub } from '@hyperneo/shared';
import superpipe, { type PipelineAPI } from 'superpipe';
import { z } from 'zod';
import type { RunDbOp } from '../../storage/db-gateway/db-op.ts';
import { recordOperationRefusal } from '../../storage/repositories/operation-refusal-repository.ts';
import { defineOperation, type OperationCaller } from '../operations/registry.ts';
import { Logger } from '../logger.ts';
import { NeoSpeechAudio } from './speech-audio.ts';
import { neoDerivedId } from './derived-id.ts';

const Result = z.object({
  ok: z.boolean(),
  id: z.string().optional(),
  state: z.enum(['queued', 'playing', 'played', 'cancelled', 'failed']).optional(),
  created: z.boolean().optional(),
  reason: z.string().optional(),
});
const Listen = z.object({
  sessionId: z.string().min(1).max(160),
  enabled: z.boolean(),
  audio: z.boolean().optional(),
  voice: z
    .string()
    .regex(/^[a-zA-Z0-9_-]{1,80}$/)
    .optional(),
});
const Preview = z.object({ sessionId: z.string().min(1).max(160), requestId: z.uuid() });
const Say = z.object({
  requestId: z.string().min(1).max(160),
  text: z.string().trim().min(1).max(500),
});
const Ack = z.object({
  sessionId: z.string().min(1).max(160),
  id: z.uuid(),
  state: z.enum(['playing', 'played', 'cancelled', 'failed']),
});
type Input =
  | z.infer<typeof Listen>
  | z.infer<typeof Say>
  | z.infer<typeof Ack>
  | z.infer<typeof Preview>;
type SpeechState = 'queued' | 'playing' | 'played' | 'cancelled' | 'failed';
type SpeechReceipt = {
  ok: boolean;
  id?: string;
  state?: SpeechState;
  created?: boolean;
  reason?: string;
};
type Entry = { id: string; sessionId: string; clientId: string; text: string; state: SpeechState };
type Listener = { clientId: string; pending: Set<string>; audio: boolean; voice: string };

export class NeoSpeech {
  private readonly receipts = new Map<string, Entry>();
  private readonly listeners = new Map<string, Listener>();
  readonly operations;
  private readonly audio: NeoSpeechAudio;
  private readonly unsubscribe: () => void;
  private serial: Promise<unknown> = Promise.resolve();

  constructor(
    private readonly hub: MessageHub,
    private readonly write: RunDbOp,
    private readonly isNeo: (sessionId: string) => boolean,
    audioBase?: string,
    audioRequest?: typeof fetch
  ) {
    this.audio = new NeoSpeechAudio(
      (client, data) => this.send(client, data),
      (target) =>
        this.enqueue(
          'ack',
          target.sessionId,
          { sessionId: target.sessionId, id: target.id, state: 'failed' },
          { source: 'rpc', principal: 'local', clientId: target.clientId }
        ),
      audioBase,
      audioRequest
    );
    this.unsubscribe =
      hub.onClientDisconnect?.((id) => {
        const result = this.serial.then(() => this.disconnect(id));
        this.serial = result.catch(() =>
          new Logger('NeoSpeech').warn('Playback disconnect record failed')
        );
      }) ?? (() => {});
    const route = (action: 'listen' | 'say' | 'ack' | 'preview') =>
      (superpipe({})(`neo.speech.${action}`) as PipelineAPI)
        .input(['input', 'caller'])
        .pipe(
          (input: Input, caller: OperationCaller) => {
            const sessionId = 'sessionId' in input ? input.sessionId : caller.sessionId;
            const admitted =
              action === 'say'
                ? caller.source === 'mcp' && caller.role === 'neo'
                : caller.source === 'rpc' && caller.principal === 'local' && !!caller.clientId;
            return admitted && sessionId && this.isNeo(sessionId)
              ? { value: sessionId }
              : { reason: { ok: false, reason: 'neo_speech_not_available' } };
          },
          ['input', 'caller'],
          'result:receipt'
        )
        .pipe(
          (sessionId: string, input: Input, caller: OperationCaller) =>
            this.enqueue(action, sessionId, input, caller),
          ['receipt', 'input', 'caller'],
          'receipt'
        )
        .endAsync('receipt') as (input: Input, caller: OperationCaller) => Promise<SpeechReceipt>;
    this.operations = [
      defineOperation({
        name: 'neo.speech.listen',
        description:
          'Enable live spoken replies on this connected human client. No history replay.',
        inputSchema: Listen,
        resultSchema: Result,
        policy: { safetyClass: 'human_only', caller: 'local_user' },
        execute: route('listen'),
      }),
      defineOperation({
        name: 'neo.speech.say',
        description:
          'Speak a short natural utterance independently of chat publications when the human enabled voice replies. Reuse requestId on retries. Acceptance is delivery, not proof of playback. No listener means no speech.',
        inputSchema: Say,
        resultSchema: Result,
        policy: { safetyClass: 'mutate', roles: ['neo'] },
        execute: route('say'),
      }),
      defineOperation({
        name: 'neo.speech.preview',
        description: 'Preview the selected voice through this server.',
        inputSchema: Preview,
        resultSchema: Result,
        policy: { safetyClass: 'human_only', caller: 'local_user' },
        execute: route('preview'),
      }),
      defineOperation({
        name: 'neo.speech.catalog',
        description: 'List the voices available through this server.',
        inputSchema: z.object({}),
        resultSchema: z.object({
          ok: z.boolean(),
          catalog: z.unknown().optional(),
          reason: z.string().optional(),
        }),
        policy: { safetyClass: 'human_only', caller: 'local_user' },
        execute: (superpipe({})('neo.speech.catalog') as PipelineAPI)
          .pipe(() => this.audio.catalog(), undefined, 'result')
          .endAsync('result') as () => ReturnType<NeoSpeechAudio['catalog']>,
      }),
      defineOperation({
        name: 'neo.speech.ack',
        description: 'Record playback state for speech delivered to this exact client.',
        inputSchema: Ack,
        resultSchema: Result,
        policy: { safetyClass: 'human_only', caller: 'local_user' },
        execute: route('ack'),
      }),
    ];
  }

  async dispose(): Promise<void> {
    this.unsubscribe();
    await this.serial;
    await Promise.all([...this.listeners.values()].map((item) => this.disconnect(item.clientId)));
    await this.audio.dispose();
  }

  private enqueue(
    action: string,
    sessionId: string,
    input: Input,
    caller: OperationCaller
  ): Promise<SpeechReceipt> {
    const result = this.serial.then(() => this.dispatch(action, sessionId, input, caller));
    this.serial = result.catch(() => {});
    return result;
  }

  private send(clientId: string, data: unknown): boolean {
    return (
      this.hub
        .getRouter()
        ?.sendToClient(
          clientId,
          createEventMessage({ method: 'neo.speech', data, sessionId: 'global' })
        ) ?? false
    );
  }

  private async record(input: Entry & { action: 'reserve' | 'ack' }): Promise<SpeechReceipt> {
    const old = this.receipts.get(input.id);
    if (input.action === 'reserve' && old)
      return old.text === input.text && old.sessionId === input.sessionId
        ? { ok: true, id: old.id, state: old.state, created: false }
        : { ok: false, reason: 'speech_receipt_mismatch' };
    if (
      input.action === 'ack' &&
      (!old || old.clientId !== input.clientId || old.sessionId !== input.sessionId)
    )
      return { ok: false, reason: 'speech_receipt_mismatch' };
    if (old && old.state !== 'queued' && old.state !== 'playing')
      return { ok: true, id: old.id, state: old.state };
    const row: Entry = {
      id: input.id,
      sessionId: input.sessionId,
      clientId: input.clientId,
      text: old?.text ?? input.text,
      state: input.state,
    };
    await this.write(recordOperationRefusal, {
      refusal: { operation: 'neo.speech', reason: JSON.stringify(row), accepted: true },
      sessionId: input.sessionId,
      at: Date.now(),
    });
    this.receipts.set(row.id, row);
    if (row.state !== 'queued' && row.state !== 'playing') this.audio.cancel(row.id);
    if (this.receipts.size > 1024) {
      const terminal = [...this.receipts.values()].find(
        (item) => !['queued', 'playing'].includes(item.state)
      );
      if (terminal) this.receipts.delete(terminal.id);
    }
    return { ok: true, id: row.id, state: row.state, created: input.action === 'reserve' };
  }

  private async disconnect(clientId: string, sessionId?: string): Promise<void> {
    for (const [session, listener] of this.listeners)
      if (listener.clientId === clientId && (!sessionId || session === sessionId))
        this.listeners.delete(session);
    for (const row of [...this.receipts.values()])
      if (
        row.clientId === clientId &&
        (!sessionId || row.sessionId === sessionId) &&
        (row.state === 'queued' || row.state === 'playing')
      )
        await this.record({ ...row, action: 'ack', state: 'cancelled' });
  }

  private async dispatch(
    action: string,
    sessionId: string,
    input: Input,
    caller: OperationCaller
  ): Promise<SpeechReceipt> {
    const clientId = caller.clientId ?? '';
    if (action === 'listen' && 'enabled' in input) {
      const prior = this.listeners.get(sessionId);
      if (prior && (prior.clientId === clientId || input.enabled)) {
        this.send(prior.clientId, { type: 'stop', sessionId });
        await this.disconnect(prior.clientId, sessionId);
      }
      if (input.enabled && this.hub.getRouter()?.getClientById(clientId))
        this.listeners.set(sessionId, {
          clientId,
          pending: new Set(),
          audio: input.audio ?? false,
          voice: input.voice ?? 'vivian',
        });
      return { ok: true };
    }
    if (action === 'ack' && 'state' in input) {
      const result = await this.record({
        action: 'ack',
        sessionId,
        clientId,
        id: input.id,
        text: '',
        state: input.state,
      });
      if (result.ok && input.state !== 'playing')
        this.listeners.get(sessionId)?.pending.delete(input.id);
      return result;
    }
    if (action === 'preview' && 'requestId' in input) {
      const target = this.listeners.get(sessionId);
      if (target?.clientId !== clientId) return { ok: false, reason: 'voice_replies_off' };
      input = {
        requestId: input.requestId,
        text: ['ryan', 'aiden'].includes(target.voice)
          ? 'Hello. This is Neo speaking.'
          : '你好，这是 Neo 的语音试听。',
      };
    }
    if (!('text' in input)) return { ok: false, reason: 'invalid_speech' };
    const target = this.listeners.get(sessionId);
    if (!target) return { ok: false, reason: 'voice_replies_off' };
    const id = neoDerivedId(`speech:${sessionId}:${input.requestId}`);
    if (!this.receipts.has(id) && target.pending.size >= 4)
      return { ok: false, reason: 'speech_queue_full' };
    const saved = await this.record({
      action: 'reserve',
      id,
      sessionId,
      clientId: target.clientId,
      text: input.text,
      state: 'queued',
    });
    if (!saved.ok || !saved.created) return saved;
    target.pending.add(id);
    if (
      this.listeners.get(sessionId) === target &&
      this.send(target.clientId, {
        type: 'say',
        id,
        sessionId,
        text: input.text,
        ...(target.audio ? { format: 'pcm16', sampleRate: 24000 } : {}),
      })
    ) {
      if (target.audio)
        this.audio.start(
          { id, sessionId, clientId: target.clientId, text: input.text },
          target.voice
        );
      return saved;
    }
    target.pending.delete(id);
    await this.record({
      action: 'ack',
      id,
      sessionId,
      clientId: target.clientId,
      text: '',
      state: 'failed',
    });
    return { ok: false, reason: 'speech_client_disconnected' };
  }
}
