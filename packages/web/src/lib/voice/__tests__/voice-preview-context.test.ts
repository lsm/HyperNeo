import type { MessageHub } from '@hyperneo/shared';
import type { NeoPreviewReference } from '@hyperneo/shared/types/neo-preview-context';
import { IDBFactory } from 'fake-indexeddb';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  flushPendingVoiceAudio,
  resetVoiceAudioOutbox,
  submitVoiceSendIntent,
} from '../voice-audio-outbox.ts';
import {
  deleteVoiceRecord,
  getVoiceRecord,
  putVoiceRecord,
  listVoiceRecords,
  pruneVoiceRecords,
  resetVoiceAudioStore,
  type VoiceRecordEntry,
} from '../voice-audio-store.ts';
import { runVoiceSubmit } from '../voice-submit-pipeline.ts';
import { getPendingTranscripts } from '../voice-transcript-outbox.ts';

const io = vi.hoisted(() => ({ hub: null as MessageHub | null }));
vi.mock('../../connection-manager.ts', () => ({
  connectionManager: { getHubIfConnected: () => io.hub },
}));
const reference: NeoPreviewReference = {
  artifactId: 'registered-report',
  snapshot: 'a'.repeat(64),
  displayName: 'Synthetic report',
  state: 'available',
};
const id = '20000000-0000-4000-8000-000000000001';
type MutableReference = { -readonly [K in keyof NeoPreviewReference]: NeoPreviewReference[K] };
function record(): Omit<VoiceRecordEntry, 'previewContext'> & { previewContext: MutableReference } {
  return {
    id,
    sessionId: 'neo:root',
    audioBase64: 'aGk=',
    mimeType: 'audio/wav',
    peakLevel: 0.5,
    createdAt: Date.now(),
    intent: 'send',
    sendDraft: 'Typed first',
    previewContext: { ...reference },
  };
}
type Payload = {
  requestId: string;
  content: string;
  previewContext?: { artifactId: string; snapshot: string };
};
const accepted = (input: Payload) => ({
  ok: true,
  requestId: input.requestId,
  messageId: input.requestId,
  created: true,
  ...(input.previewContext ? { previewContext: { ...reference, ...input.previewContext } } : {}),
});
beforeEach(() => {
  vi.stubGlobal('indexedDB', new IDBFactory());
  resetVoiceAudioStore();
  resetVoiceAudioOutbox();
  localStorage.clear();
});
afterEach(() => {
  resetVoiceAudioOutbox();
  resetVoiceAudioStore();
  io.hub = null;
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('durable voice Preview context', () => {
  it('keeps a held reference and audio past the ordinary 24-hour prune boundary until explicit deletion', async () => {
    const held = { ...record(), sendText: 'Frozen text', sendRefusal: 'Preview unavailable' };
    expect(await putVoiceRecord(held)).toBe(true);
    vi.spyOn(Date, 'now').mockReturnValue(held.createdAt + 25 * 60 * 60 * 1000);
    expect(await getVoiceRecord(id)).toMatchObject({
      previewContext: reference,
      sendRefusal: held.sendRefusal,
    });
    expect((await listVoiceRecords()).map((entry) => entry.id)).toContain(id);
    await pruneVoiceRecords();
    resetVoiceAudioStore();
    expect(await getVoiceRecord(id)).toMatchObject({
      audioBase64: held.audioBase64,
      previewContext: reference,
    });
    await deleteVoiceRecord(id);
    expect(await getVoiceRecord(id)).toBeNull();
  });
  it('evicts ordinary audio before an older held reference at capacity', async () => {
    await putVoiceRecord({
      ...record(),
      createdAt: Date.now() - 7200000,
      sendText: 'Frozen',
      sendRefusal: 'Preview unavailable',
    });
    for (let index = 0; index < 5; index++) {
      const plain = {
        ...record(),
        id: `plain-${index}`,
        createdAt: Date.now() + index,
        previewContext: undefined,
      };
      expect(await putVoiceRecord(plain)).toBe(true);
    }
    resetVoiceAudioStore();
    expect(await getVoiceRecord(id)).toMatchObject({ previewContext: reference });
    expect(await getVoiceRecord('plain-0')).toBeNull();
    expect(await listVoiceRecords()).toHaveLength(5);
  });
  it('refuses a new ordinary record rather than silently deleting any of five held references', async () => {
    for (let index = 0; index < 5; index++)
      expect(
        await putVoiceRecord({
          ...record(),
          id: `held-${index}`,
          sendText: 'Frozen',
          sendRefusal: 'Preview unavailable',
        })
      ).toBe(true);
    expect(await putVoiceRecord({ ...record(), id: 'new-record', previewContext: undefined })).toBe(
      false
    );
    resetVoiceAudioStore();
    expect((await listVoiceRecords()).map((entry) => entry.id)).toEqual([
      'held-0',
      'held-1',
      'held-2',
      'held-3',
      'held-4',
    ]);
  });
  it('does not admit a sixth new held reference while preserving the original five', async () => {
    for (let index = 0; index < 5; index++)
      await putVoiceRecord({
        ...record(),
        id: `held-${index}`,
        sendText: 'Frozen',
        sendRefusal: 'Preview unavailable',
      });
    expect(
      await putVoiceRecord({
        ...record(),
        id: 'sixth-held',
        sendText: 'Frozen',
        sendRefusal: 'Preview unavailable',
      })
    ).toBe(false);
    resetVoiceAudioStore();
    expect(await listVoiceRecords()).toHaveLength(5);
    expect(await getVoiceRecord('held-0')).not.toBeNull();
    expect(await getVoiceRecord('sixth-held')).toBeNull();
  });
  it('keeps overflow audio in memory but cannot send it before durable space is available', async () => {
    for (let index = 0; index < 5; index++)
      await putVoiceRecord({
        ...record(),
        id: `held-${index}`,
        sendText: 'Frozen',
        sendRefusal: 'Preview unavailable',
      });
    expect(await putVoiceRecord({ ...record(), id: 'overflow' })).toBe(false);
    const buffered = await getVoiceRecord('overflow');
    expect(buffered).not.toBeNull();
    const request = vi.fn(async (_method: string, { input }: { input: Payload }) =>
      accepted(input)
    );
    const hub = { request } as unknown as MessageHub;
    expect(await submitVoiceSendIntent(hub, buffered!, 'Spoken overflow')).toEqual({
      kind: 'unconfirmed',
    });
    const settled = await getVoiceRecord('overflow');
    expect(settled?.sendText).toBe('Spoken overflow');
    expect(await submitVoiceSendIntent(hub, settled!, 'Spoken overflow')).toEqual({
      kind: 'unconfirmed',
    });
    expect(request).not.toHaveBeenCalled();
    await deleteVoiceRecord('held-0');
    expect(await submitVoiceSendIntent(hub, settled!, 'Spoken overflow')).toEqual({
      kind: 'accepted',
    });
    expect(request).toHaveBeenCalledOnce();
    resetVoiceAudioStore();
    expect(await getVoiceRecord('overflow')).toMatchObject({
      sendText: 'Spoken overflow',
      previewContext: reference,
    });
  });
  it('captures the exact reference before stopping/encoding audio', async () => {
    let stop!: () => void;
    const stopped = new Promise<void>((done) => {
      stop = done;
    });
    const input = {
      sessionId: 'neo:root',
      intent: 'send' as const,
      sendDraft: 'Typed first',
      previewContext: { ...reference },
    };
    const flight = runVoiceSubmit(input, {
      generateId: () => id,
      isMounted: () => true,
      currentSessionId: () => 'neo:root',
      stopRecording: async () => {
        await stopped;
        return { audioBase64: 'aGk=', mimeType: 'audio/wav', peakLevel: 0.5 };
      },
      transcribe: async () => ({ text: 'spoken' }),
    });
    input.previewContext.snapshot = 'b'.repeat(64);
    input.sendDraft = 'Later draft';
    stop();
    expect(await flight).toHaveProperty('kind', 'routed');
    expect(await getVoiceRecord(id)).toMatchObject({
      previewContext: reference,
      sendDraft: 'Typed first',
    });
  });
  it('detaches context before an asynchronous IndexedDB mutation and retains it after reload', async () => {
    const entry = record();
    const saved = putVoiceRecord(entry);
    entry.previewContext.snapshot = 'b'.repeat(64);
    expect(await saved).toBe(true);
    resetVoiceAudioStore();
    expect(await getVoiceRecord(id)).toMatchObject({ previewContext: reference });
  });
  it.each([
    null,
    { ...reference, snapshot: '../file' },
    { ...reference, sourcePath: '/synthetic/private/report.md' },
  ])('refuses malformed persisted context %j', async (context) => {
    expect(await putVoiceRecord({ ...record(), previewContext: context } as VoiceRecordEntry)).toBe(
      false
    );
    expect(await getVoiceRecord(id)).toBeNull();
  });
  it('captures record identity/context before waiting for the durable send intent', async () => {
    const request = vi.fn(async (_method: string, { input }: { input: Payload }) =>
      accepted(input)
    );
    const entry = record();
    const flight = submitVoiceSendIntent(
      { request } as unknown as MessageHub,
      entry,
      'Typed first\nspoken'
    );
    entry.id = '20000000-0000-4000-8000-000000000002';
    entry.previewContext.snapshot = 'b'.repeat(64);
    expect(await flight).toEqual({ kind: 'accepted' });
    expect(request.mock.calls[0][1].input).toMatchObject({
      requestId: id,
      previewContext: { artifactId: reference.artifactId, snapshot: reference.snapshot },
    });
  });
  it('reloads a settled send and retries the exact same ID/hash/text without transcribing again', async () => {
    await putVoiceRecord({ ...record(), sendText: 'Frozen spoken text' });
    const request = vi.fn(async (_method: string, { input }: { input: Payload }) =>
      accepted(input)
    );
    request.mockRejectedValueOnce(new Error('Disconnected'));
    io.hub = { request } as unknown as MessageHub;
    await flushPendingVoiceAudio();
    expect(await getVoiceRecord(id)).toMatchObject({
      previewContext: reference,
      sendText: 'Frozen spoken text',
    });
    resetVoiceAudioOutbox();
    resetVoiceAudioStore();
    await flushPendingVoiceAudio();
    expect(request).toHaveBeenCalledTimes(2);
    expect(request.mock.calls[1]).toEqual(request.mock.calls[0]);
    expect(request.mock.calls[1][1].input.previewContext).toEqual({
      artifactId: reference.artifactId,
      snapshot: reference.snapshot,
    });
    expect(await getVoiceRecord(id)).toBeNull();
  });
  it('holds a refused bound recording without unbound text fallback or automatic replay', async () => {
    await putVoiceRecord({ ...record(), sendText: 'Frozen spoken text' });
    const request = vi.fn(
      async (_method: string, { input }: { input: Payload }): Promise<unknown> => accepted(input)
    );
    request.mockResolvedValueOnce({ ok: false, reason: 'Preview unavailable' });
    io.hub = { request } as unknown as MessageHub;
    await flushPendingVoiceAudio();
    const retained = await getVoiceRecord(id);
    expect(retained).toMatchObject({
      previewContext: reference,
      sendText: 'Frozen spoken text',
      sendRefusal: 'Preview unavailable',
    });
    expect(getPendingTranscripts()).toEqual([]);
    resetVoiceAudioStore();
    await flushPendingVoiceAudio();
    expect(request).toHaveBeenCalledTimes(1);
    expect(await submitVoiceSendIntent(io.hub!, retained!, 'Frozen spoken text')).toEqual({
      kind: 'accepted',
    });
    expect(request.mock.calls[1]).toEqual(request.mock.calls[0]);
    await deleteVoiceRecord(id);
  });
});
