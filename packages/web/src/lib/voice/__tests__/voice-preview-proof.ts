import assert from 'node:assert/strict';
import { IDBFactory } from 'fake-indexeddb';
import type { MessageHub } from '@hyperneo/shared';
import type { NeoPreviewReference } from '@hyperneo/shared/types/neo-preview-context';

export async function createVoicePreviewProof(
  sessionId: string,
  previewContext: NeoPreviewReference
) {
  globalThis.indexedDB = new IDBFactory();
  if (typeof navigator !== 'undefined' && !navigator.languages)
    Object.defineProperty(navigator, 'languages', { value: ['en'] });
  const { submitVoiceSendIntent, resetVoiceAudioOutbox } = await import('../voice-audio-outbox.ts');
  const { runVoiceSubmit } = await import('../voice-submit-pipeline.ts');
  const { getVoiceRecord, deleteVoiceRecord, resetVoiceAudioStore } = await import(
    '../voice-audio-store.ts'
  );
  const id = '20000000-0000-4000-8000-000000000004';
  const refusedId = '20000000-0000-4000-8000-000000000005';
  async function capture(recordId: string) {
    const result = await runVoiceSubmit(
      { sessionId, intent: 'send', sendDraft: 'Discuss Preview by voice', previewContext },
      {
        generateId: () => recordId,
        isMounted: () => true,
        currentSessionId: () => sessionId,
        stopRecording: async () => ({ audioBase64: 'aGk=', mimeType: 'audio/wav', peakLevel: 0.5 }),
        transcribe: async () => ({ text: 'Synthetic transcript' }),
      }
    );
    assert.equal(result.kind, 'routed');
    const record = await getVoiceRecord(recordId);
    assert(record);
    assert.deepEqual(record.previewContext, previewContext);
    return record;
  }
  const first = await capture(id);
  const text = 'Discuss Preview by voice\nSynthetic transcript';
  return {
    id,
    async send(hub: MessageHub) {
      assert.deepEqual(await submitVoiceSendIntent(hub, first, text), { kind: 'accepted' });
      resetVoiceAudioStore();
      const stored = await getVoiceRecord(id);
      assert(stored);
      assert.equal(stored.sendText, text);
      assert.deepEqual(stored.previewContext, previewContext);
    },
    async retry(hub: MessageHub) {
      resetVoiceAudioStore();
      const stored = await getVoiceRecord(id);
      assert(stored);
      assert.deepEqual(await submitVoiceSendIntent(hub, stored, text), { kind: 'accepted' });
    },
    async refuse(hub: MessageHub) {
      const record = await capture(refusedId);
      const result = await submitVoiceSendIntent(hub, record, text);
      assert(result.kind === 'refused' && result.retained);
      const retained = await getVoiceRecord(refusedId);
      assert(retained);
      assert.deepEqual(retained.previewContext, previewContext);
      assert.equal(retained.sendText, text);
      assert.equal(retained.sendRefusal, result.reason);
    },
    async cleanup() {
      resetVoiceAudioOutbox();
      await deleteVoiceRecord(id);
      await deleteVoiceRecord(refusedId);
      resetVoiceAudioStore();
    },
  };
}
