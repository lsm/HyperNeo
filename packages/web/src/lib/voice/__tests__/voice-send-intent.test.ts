import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const hubRequest = vi.fn(
  async (method: string, _payload?: unknown): Promise<Record<string, unknown>> => ({
    text: 'hello world',
    method,
  })
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
  putVoiceRecord: async () => true,
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

describe('voice send-intent recovery', () => {
  beforeEach(() => {
    resetVoiceAudioOutbox();
    store.records = [];
    hubRequest.mockReset().mockImplementation(async () => ({ text: 'hello world' }));
    enqueueTranscript.mockReset().mockReturnValue(true);
    vi.mocked(connectionManager.getHubIfConnected)
      .mockReset()
      .mockReturnValue({ request: hubRequest } as never);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('completes a send-intent record through the idempotent intake and deletes the audio', async () => {
    seedEntry({ intent: 'send' });
    await flushPendingVoiceAudio();

    const send = hubRequest.mock.calls.find(([method]) => method === 'neo.message.send');
    expect(send).toBeTruthy();
    expect(send?.[1]).toMatchObject({ sessionId: 's1', requestId: 'rec-1', text: 'hello world' });
    expect(store.records).toHaveLength(0);
    expect(
      hubRequest.mock.calls.filter(([method]) => method === 'session.appendVoiceDraft')
    ).toHaveLength(0);
  });

  it('never re-sends after the record is durably consumed, across repeated flushes', async () => {
    seedEntry({ intent: 'send' });
    await flushPendingVoiceAudio();
    await flushPendingVoiceAudio();
    await flushPendingVoiceAudio();

    expect(hubRequest.mock.calls.filter(([method]) => method === 'neo.message.send')).toHaveLength(
      1
    );
  });

  it('retries with the SAME requestId when the send fails, so the daemon dedupes', async () => {
    seedEntry({ intent: 'send' });
    hubRequest.mockImplementation(async (method: string) => {
      if (method === 'neo.message.send') throw new Error('timed out');
      return { text: 'hello world' };
    });
    await flushPendingVoiceAudio();
    expect(store.records).toHaveLength(1);

    hubRequest.mockImplementation(async () => ({ text: 'hello world' }));
    await flushPendingVoiceAudio();
    const sends = hubRequest.mock.calls.filter(([method]) => method === 'neo.message.send');
    expect(sends.map((call) => (call[1] as { requestId: string }).requestId)).toEqual([
      'rec-1',
      'rec-1',
    ]);
    expect(store.records).toHaveLength(0);
  });

  it('draft-intent records never send — they stage as an editable draft', async () => {
    seedEntry({ intent: 'draft' });
    await flushPendingVoiceAudio();

    expect(hubRequest.mock.calls.filter(([method]) => method === 'neo.message.send')).toHaveLength(
      0
    );
    const staged = hubRequest.mock.calls.find(([method]) => method === 'session.appendVoiceDraft');
    expect(staged).toBeTruthy();
    expect(store.records).toHaveLength(0);
  });

  it('legacy records without intent behave as drafts', async () => {
    seedEntry();
    await flushPendingVoiceAudio();
    expect(hubRequest.mock.calls.filter(([method]) => method === 'neo.message.send')).toHaveLength(
      0
    );
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
    expect(hubRequest.mock.calls.filter(([method]) => method === 'neo.message.send')).toHaveLength(
      0
    );
  });
});
