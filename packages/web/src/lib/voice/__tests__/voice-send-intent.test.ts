import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

type IntakeInvocation = {
  name: string;
  input: { sessionId: string; requestId: string; content: unknown };
};

const hubRequest = vi.fn(
  async (method: string, payload?: unknown): Promise<Record<string, unknown>> => {
    if (method === 'operation.invoke') {
      const invocation = payload as IntakeInvocation;
      if (invocation.name !== 'neo.message.send')
        throw new Error(`Unknown operation: ${invocation.name}`);
      const { requestId } = invocation.input;
      return { ok: true, requestId, messageId: requestId, created: true };
    }
    if (method === 'voice.transcribe') return { text: 'hello world' };
    if (method === 'session.appendVoiceDraft') return { success: true };
    if (method === 'message.send') return { messageId: 'm1' };
    throw new Error(`No handler for method: ${method}`);
  }
);

vi.mock('../../connection-manager', () => ({
  connectionManager: { getHubIfConnected: vi.fn(() => ({ request: hubRequest })) },
}));

const store = vi.hoisted(() => ({ records: [] as Array<Record<string, unknown>> }));

vi.mock('../voice-audio-store.ts', () => ({
  listVoiceRecords: async () => store.records.map((r) => ({ ...r })),
  getVoiceRecord: async (id: string) => store.records.find((r) => r.id === id) ?? null,
  deleteVoiceRecord: async (id: string) => {
    store.records = store.records.filter((r) => r.id !== id);
    return true;
  },
  putVoiceRecord: async (entry: Record<string, unknown>) => {
    store.records = [...store.records.filter((r) => r.id !== entry.id), { ...entry }];
    return true;
  },
}));

const enqueueTranscript = vi.hoisted(() => vi.fn(() => true));
vi.mock('../voice-transcript-outbox.ts', async (importOriginal) => ({
  ...(await importOriginal()),
  enqueueTranscript,
}));

import type { VoiceRecordEntry } from '../voice-audio-store.ts';
import { connectionManager } from '../../connection-manager.ts';
import {
  flushPendingVoiceAudio,
  resetVoiceAudioOutbox,
  queuePendingVoiceSend,
  submitVoiceSendIntent,
} from '../voice-audio-outbox.ts';

function seedEntry(overrides: Record<string, unknown> = {}) {
  const entry = {
    id: 'rec-1',
    sessionId: 's1',
    audioBase64: 'aGk=',
    mimeType: 'audio/wav',
    peakLevel: 0.5,
    createdAt: 1_726_000_000_000,
    ...overrides,
  };
  store.records.push(entry);
  return entry;
}

const intakes = () =>
  hubRequest.mock.calls.filter(([method]) => method === 'operation.invoke') as Array<
    [string, IntakeInvocation]
  >;
const asks = () => intakes().filter(([, invocation]) => invocation.name === 'neo.message.send');
const rawMethods = () => hubRequest.mock.calls.map(([method]) => method);

describe('voice send-intent recovery', () => {
  beforeEach(() => {
    resetVoiceAudioOutbox();
    store.records = [];
    hubRequest.mockReset().mockImplementation(hubRequest.getMockImplementation()!);
    enqueueTranscript.mockReset().mockReturnValue(true);
    vi.mocked(connectionManager.getHubIfConnected)
      .mockReset()
      .mockReturnValue({ request: hubRequest } as never);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('sends through the operation door with the record id as the requestId', async () => {
    seedEntry({ intent: 'send' });
    await flushPendingVoiceAudio();

    expect(asks()).toHaveLength(1);
    expect(asks()[0]?.[1].input).toEqual({
      sessionId: 's1',
      requestId: 'rec-1',
      content: 'hello world',
    });
    expect(store.records).toHaveLength(0);
    expect(rawMethods()).not.toContain('neo.message.send');
  });

  it('sends a session pane recording to its session through message.send', async () => {
    seedEntry({ intent: 'send', door: 'session' });
    await flushPendingVoiceAudio();

    expect(asks()).toHaveLength(0);
    expect(hubRequest).toHaveBeenCalledWith('message.send', {
      sessionId: 's1',
      content: 'hello world',
    });
    expect(store.records).toHaveLength(0);
  });

  it('parks an unconfirmed session send in the draft instead of replaying it', async () => {
    seedEntry({ intent: 'send', door: 'session' });
    hubRequest.mockImplementation(async (method: string) => {
      if (method === 'voice.transcribe') return { text: 'hello world' };
      if (method === 'message.send') throw new Error('Request timeout');
      return { success: true };
    });
    await flushPendingVoiceAudio();
    await flushPendingVoiceAudio();

    expect(rawMethods().filter((method) => method === 'message.send')).toHaveLength(1);
    expect(enqueueTranscript).toHaveBeenCalledWith('s1', 'hello world', 'rec-1');
  });

  it('never re-sends after the record is durably consumed, across repeated flushes', async () => {
    seedEntry({ intent: 'send' });
    await flushPendingVoiceAudio();
    await flushPendingVoiceAudio();
    await flushPendingVoiceAudio();

    expect(asks()).toHaveLength(1);
  });

  it('replays the persisted payload with the same requestId when a send is unconfirmed', async () => {
    seedEntry({ intent: 'send' });
    const working = hubRequest.getMockImplementation()!;
    hubRequest.mockImplementation(async (method: string, payload?: unknown) => {
      if (method === 'operation.invoke') throw new Error('Request timeout');
      return working(method, payload);
    });
    await flushPendingVoiceAudio();
    expect(store.records).toHaveLength(1);
    expect(store.records[0]?.sendText).toBe('hello world');

    hubRequest.mockImplementation(working);
    await flushPendingVoiceAudio();

    const sends = asks().map(([, invocation]) => invocation.input);
    expect(sends).toEqual([
      { sessionId: 's1', requestId: 'rec-1', content: 'hello world' },
      { sessionId: 's1', requestId: 'rec-1', content: 'hello world' },
    ]);
    expect(store.records).toHaveLength(0);
  });

  it('preserves the recording when the receipt cannot be read', async () => {
    seedEntry({ intent: 'send' });
    const working = hubRequest.getMockImplementation()!;
    hubRequest.mockImplementation(async (method: string, payload?: unknown) => {
      if (method === 'operation.invoke') return { ok: true, requestId: 'someone-else' };
      return working(method, payload);
    });
    await flushPendingVoiceAudio();

    expect(asks()).toHaveLength(1);
    expect(store.records).toHaveLength(1);
    expect(enqueueTranscript).not.toHaveBeenCalled();
  });

  it('parks the transcript and never re-sends after a permanent refusal', async () => {
    seedEntry({ intent: 'send' });
    const working = hubRequest.getMockImplementation()!;
    hubRequest.mockImplementation(async (method: string, payload?: unknown) => {
      if (method === 'operation.invoke')
        return { ok: false, reason: 'This Neo conversation is no longer available.' };
      return working(method, payload);
    });
    await flushPendingVoiceAudio();
    await flushPendingVoiceAudio();

    expect(asks()).toHaveLength(1);
    expect(enqueueTranscript).toHaveBeenCalledWith('s1', 'hello world', 'rec-1');
    expect(store.records).toHaveLength(0);
  });

  it('discards an empty transcript instead of rescheduling forever', async () => {
    seedEntry({ intent: 'send' });
    const working = hubRequest.getMockImplementation()!;
    hubRequest.mockImplementation(async (method: string, payload?: unknown) => {
      if (method === 'voice.transcribe') return {};
      return working(method, payload);
    });
    await flushPendingVoiceAudio();
    await flushPendingVoiceAudio();

    expect(asks()).toHaveLength(0);
    expect(store.records).toHaveLength(0);
  });

  it('recovers the typed draft persisted at send-intent creation', async () => {
    seedEntry({ intent: 'send', sendDraft: 'typed first' });
    await flushPendingVoiceAudio();

    expect(asks()[0]?.[1].input.content).toBe('typed first\nhello world');
  });

  it('sends a recovered transcript alone when no draft was pending', async () => {
    seedEntry({ intent: 'send' });
    await flushPendingVoiceAudio();

    expect(asks()[0]?.[1].input.content).toBe('hello world');
  });

  it('draft-intent records never send — they stage as an editable draft', async () => {
    seedEntry({ intent: 'draft' });
    await flushPendingVoiceAudio();

    expect(asks()).toHaveLength(0);
    const staged = hubRequest.mock.calls.find(([method]) => method === 'session.appendVoiceDraft');
    expect(staged).toBeTruthy();
    expect(store.records).toHaveLength(0);
  });

  it('legacy records without intent behave as drafts', async () => {
    seedEntry();
    await flushPendingVoiceAudio();

    expect(asks()).toHaveLength(0);
    expect(
      hubRequest.mock.calls.filter(([method]) => method === 'session.appendVoiceDraft')
    ).toHaveLength(1);
  });

  it('keeps the send-intent audio for retry when transcription itself fails retryably', async () => {
    vi.useFakeTimers();
    seedEntry({ intent: 'send' });
    hubRequest.mockImplementation(async (method: string) => {
      if (method === 'voice.transcribe') throw new Error('timed out');
      return { text: 'hello world' };
    });
    const flush = flushPendingVoiceAudio();
    await vi.advanceTimersByTimeAsync(200_000);
    await flush;
    expect(store.records).toHaveLength(1);
    expect(asks()).toHaveLength(0);
  });

  it('recovers an upgraded pending Send with its original quote, photo and file suffix', async () => {
    seedEntry({ intent: 'draft' });
    const quote = {
      author: 'Neo' as const,
      text: 'original quote',
      anchor: 'original',
      replyTo: { kind: 'message' as const, id: 'original', excerpt: 'original quote' },
    };
    expect(
      await queuePendingVoiceSend('rec-1', {
        sendDraft: 'accepted typed words',
        sendContext: {
          suffix: 'original attachment',
          images: [{ data: 'aGk=', media_type: 'image/png' }],
          quote,
          attachmentIds: ['photo1'],
        },
      })
    ).toBe(true);
    resetVoiceAudioOutbox();
    await flushPendingVoiceAudio();
    expect(asks()).toHaveLength(1);
    const input = asks()[0][1].input;
    expect(input.requestId).toBe('rec-1');
    expect(JSON.stringify(input.content)).toContain('original attachment');
    expect(JSON.stringify(input.content)).toContain('aGk=');
    expect(input).toHaveProperty('replyTo', quote.replyTo);
    expect(store.records).toHaveLength(0);
  });
  it('refuses missing or already accepted pending Send records', async () => {
    expect(await queuePendingVoiceSend('missing', {})).toBe(false);
    seedEntry({ intent: 'send' });
    expect(await queuePendingVoiceSend('rec-1', {})).toBe(false);
  });
  it('replays the accepted session receipt after a lost response without another delivery', async () => {
    const record = seedEntry({
      intent: 'send',
      door: 'session',
      sendContext: {
        suffix: 'saved file words',
        attachmentIds: [],
        images: [{ data: 'aGk=', media_type: 'image/png' }],
      },
    }) as VoiceRecordEntry;
    const receipts = new Map<string, Record<string, unknown>>();
    let deliveries = 0;
    let dropResponse = true;
    hubRequest.mockImplementation(async (method, payload) => {
      const invocation = payload as { name?: string; input?: { idempotencyKey?: string } };
      if (
        method !== 'message.send' &&
        !(method === 'operation.invoke' && invocation.name === 'message.send')
      )
        throw new Error('Unexpected route');
      const key = method === 'operation.invoke' ? invocation.input?.idempotencyKey : undefined;
      let receipt = key ? receipts.get(key) : undefined;
      if (!receipt) {
        deliveries++;
        receipt = {
          kind: 'accepted',
          mailboxId: 'mailbox-' + deliveries,
          messageId: 'message-' + deliveries,
        };
        if (key) receipts.set(key, receipt);
      }
      if (dropResponse) {
        dropResponse = false;
        throw new Error('Response lost after acceptance');
      }
      return receipt;
    });
    const hub = { request: hubRequest } as never;
    expect(
      (
        await submitVoiceSendIntent(
          hub,
          record,
          'typed words\nfinal transcript\n\nsaved file words'
        )
      ).kind
    ).not.toBe('accepted');
    expect(deliveries).toBe(1);
    const saved = store.records.find(
      (entry) => entry.id === record.id
    ) as unknown as VoiceRecordEntry;
    expect(saved.sendContext).toEqual(record.sendContext);
    expect(
      await submitVoiceSendIntent({ request: hubRequest } as never, saved, saved.sendText!)
    ).toEqual({ kind: 'accepted' });
    expect(deliveries).toBe(1);
    expect(rawMethods()).not.toContain('message.send');
    expect(hubRequest.mock.calls[0][1]).toEqual(hubRequest.mock.calls[1][1]);
    expect(hubRequest.mock.calls[1][1]).toMatchObject({
      name: 'message.send',
      input: { idempotencyKey: 'voice:rec-1', sessionId: 's1' },
    });
  });
});
