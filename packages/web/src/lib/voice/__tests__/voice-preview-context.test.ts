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
});

describe('durable voice Preview context', () => {
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
