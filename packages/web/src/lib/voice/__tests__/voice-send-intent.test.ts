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

import { connectionManager } from '../../connection-manager.ts';
import { flushPendingVoiceAudio, resetVoiceAudioOutbox } from '../voice-audio-outbox.ts';

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
});
