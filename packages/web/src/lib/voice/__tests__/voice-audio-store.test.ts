// @ts-nocheck
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  deleteVoiceRecord,
  getVoiceRecord,
  listVoiceRecords,
  putVoiceRecord,
  resetVoiceAudioStore,
} from '../voice-audio-store.ts';

function makeRequest(result: unknown, error: unknown = null) {
  const request = { result, error, onsuccess: null, onerror: null };
  queueMicrotask(() => (error ? request.onerror?.() : request.onsuccess?.()));
  return request;
}

function createFakeIdb({
  failOpen = false,
  failPuts = false,
  failDeletes = false,
  failCommit = false,
} = {}) {
  const data = new Map();
  const ops: string[] = [];
  let closed = false;
  const db = {
    onversionchange: null,
    onclose: null,
    objectStoreNames: { contains: (name: string) => data.has(name) },
    createObjectStore: (name: string) => {
      data.set(name, new Map());
    },
    close: () => {
      closed = true;
    },
    transaction: () => {
      if (closed) throw new Error('connection closed');
      let failed = false;
      const tx = {
        oncomplete: null,
        onabort: null,
        onerror: null,
        objectStore: (name: string) => {
          const store = data.get(name) ?? new Map();
          return {
            put: (value: unknown) => {
              ops.push('put');
              if (failPuts) {
                failed = true;
                return makeRequest(undefined, new Error('quota'));
              }
              store.set(value.id, value);
              return makeRequest(value.id);
            },
            get: (id: string) => makeRequest(store.get(id)),
            getAll: () => makeRequest([...store.values()]),
            delete: (id: string) => {
              ops.push('delete');
              if (failDeletes) {
                failed = true;
                return makeRequest(undefined, new Error('locked'));
              }
              store.delete(id);
              return makeRequest(undefined);
            },
          };
        },
      };
      queueMicrotask(() =>
        queueMicrotask(() => {
          if (failCommit || failed) tx.onabort?.();
          else tx.oncomplete?.();
        })
      );
      return tx;
    },
  };
  return {
    ops,
    open: () => {
      if (failOpen) return makeRequest(undefined, new Error('blocked'));
      closed = false;
      const request = {
        result: null,
        error: null,
        onsuccess: null,
        onerror: null,
        onupgradeneeded: null,
      };
      queueMicrotask(() => {
        request.result = db;
        if (!data.has('records')) request.onupgradeneeded?.();
        request.onsuccess?.();
      });
      return request;
    },
    seed: (id: string, value: unknown) => {
      if (!data.has('records')) data.set('records', new Map());
      data.get('records').set(id, value);
    },
    simulateVersionChange: () => db.onversionchange?.(),
  };
}

const originalIdb = globalThis.indexedDB;
const NOW = Date.now();
const DAY_MS = 24 * 60 * 60 * 1000;

function makeEntry(id: string, createdAt: number, sessionId = 's1') {
  return {
    id,
    sessionId,
    audioBase64: `wav-bytes-${id}`,
    mimeType: 'audio/wav',
    hitDurationLimit: false,
    peakLevel: 0.42,
    createdAt,
  };
}

describe('voice audio record store', () => {
  beforeEach(() => {
    resetVoiceAudioStore();
  });

  afterEach(() => {
    globalThis.indexedDB = originalIdb;
  });

  it('persists a finished recording durably and reads it back after a reload', async () => {
    globalThis.indexedDB = createFakeIdb();
    await putVoiceRecord(makeEntry('r1', NOW));
    resetVoiceAudioStore();
    const entry = await getVoiceRecord('r1');
    expect(entry?.audioBase64).toBe('wav-bytes-r1');
    expect(entry?.sessionId).toBe('s1');
    expect(entry?.mimeType).toBe('audio/wav');
    expect(await listVoiceRecords()).toHaveLength(1);
  });

  it('lists records sorted by createdAt ascending regardless of put order', async () => {
    globalThis.indexedDB = createFakeIdb();
    await putVoiceRecord(makeEntry('newer', NOW + 5_000));
    await putVoiceRecord(makeEntry('older', NOW));
    expect((await listVoiceRecords()).map((e) => e.id)).toEqual(['older', 'newer']);
  });

  it('prunes to the count cap keeping the newest records, durably', async () => {
    globalThis.indexedDB = createFakeIdb();
    for (let i = 0; i < 7; i++) await putVoiceRecord(makeEntry(`r${i}`, NOW + i));
    expect((await listVoiceRecords()).map((e) => e.id)).toEqual(['r2', 'r3', 'r4', 'r5', 'r6']);
    resetVoiceAudioStore();
    expect((await listVoiceRecords()).map((e) => e.id)).toEqual(['r2', 'r3', 'r4', 'r5', 'r6']);
  });

  it('prunes expired records durably', async () => {
    globalThis.indexedDB = createFakeIdb();
    await putVoiceRecord(makeEntry('stale', NOW - DAY_MS - 1_000));
    await putVoiceRecord(makeEntry('fresh', NOW));
    expect((await listVoiceRecords()).map((e) => e.id)).toEqual(['fresh']);
    resetVoiceAudioStore();
    expect(await getVoiceRecord('stale')).toBeNull();
  });

  it('frees durable capacity before writing when the store is at the cap', async () => {
    const idb = createFakeIdb();
    globalThis.indexedDB = idb;
    for (let i = 0; i < 5; i++) idb.seed(`seed${i}`, makeEntry(`seed${i}`, NOW + i));
    idb.ops.length = 0;
    await putVoiceRecord(makeEntry('r5', NOW + 5));
    expect(idb.ops).toEqual(['delete', 'put']);
    expect((await listVoiceRecords()).map((e) => e.id)).toEqual([
      'seed1',
      'seed2',
      'seed3',
      'seed4',
      'r5',
    ]);
  });

  it('deletes a record from both the mirror and durable storage', async () => {
    globalThis.indexedDB = createFakeIdb();
    await putVoiceRecord(makeEntry('r1', NOW));
    await deleteVoiceRecord('r1');
    expect(await getVoiceRecord('r1')).toBeNull();
    expect(await listVoiceRecords()).toHaveLength(0);
    resetVoiceAudioStore();
    expect(await getVoiceRecord('r1')).toBeNull();
  });

  it('keeps a deleted record suppressed when the durable removal fails', async () => {
    globalThis.indexedDB = createFakeIdb({ failDeletes: true });
    await putVoiceRecord(makeEntry('r1', NOW));
    await deleteVoiceRecord('r1');
    expect(await getVoiceRecord('r1')).toBeNull();
    expect(await listVoiceRecords()).toHaveLength(0);
  });

  it('drops the cached connection when a version upgrade is requested elsewhere', async () => {
    const idb = createFakeIdb();
    globalThis.indexedDB = idb;
    await putVoiceRecord(makeEntry('r1', NOW));
    idb.simulateVersionChange();
    expect((await getVoiceRecord('r1'))?.audioBase64).toBe('wav-bytes-r1');
  });

  it('degrades to in-memory-only when opening the database fails', async () => {
    globalThis.indexedDB = createFakeIdb({ failOpen: true });
    expect(await putVoiceRecord(makeEntry('r1', NOW))).toBe(false);
    expect((await listVoiceRecords()).map((e) => e.id)).toEqual(['r1']);
    expect((await getVoiceRecord('r1'))?.audioBase64).toBe('wav-bytes-r1');
    resetVoiceAudioStore();
    expect(await getVoiceRecord('r1')).toBeNull();
    globalThis.indexedDB = undefined;
    expect(await putVoiceRecord(makeEntry('r2', NOW))).toBe(false);
    expect((await listVoiceRecords()).map((e) => e.id)).toEqual(['r2']);
  });

  it('reports a put as non-durable when persistence rejects or the commit aborts', async () => {
    globalThis.indexedDB = createFakeIdb({ failPuts: true });
    expect(await putVoiceRecord(makeEntry('r1', NOW))).toBe(false);
    globalThis.indexedDB = createFakeIdb({ failCommit: true });
    expect(await putVoiceRecord(makeEntry('r2', NOW))).toBe(false);
    expect((await listVoiceRecords()).map((e) => e.id)).toEqual(['r1', 'r2']);
  });

  it('skips malformed and expired entries found in durable storage', async () => {
    const idb = createFakeIdb();
    globalThis.indexedDB = idb;
    await putVoiceRecord(makeEntry('ok', NOW));
    idb.seed('junk', { nope: 1 });
    idb.seed('junk2', null);
    idb.seed('partial', { id: 'partial', sessionId: 's1', audioBase64: 'x' });
    idb.seed('stale', makeEntry('stale', NOW - DAY_MS - 1_000));
    expect((await listVoiceRecords()).map((e) => e.id)).toEqual(['ok']);
    expect(await getVoiceRecord('stale')).toBeNull();
    expect(await getVoiceRecord('partial')).toBeNull();
  });
});
