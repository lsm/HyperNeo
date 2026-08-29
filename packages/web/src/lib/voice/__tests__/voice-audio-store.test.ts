// @ts-nocheck
import { IDBFactory } from 'fake-indexeddb';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  deleteVoiceRecord,
  getVoiceRecord,
  listVoiceRecords,
  pruneVoiceRecords,
  putVoiceRecord,
  resetVoiceAudioStore,
} from '../voice-audio-store.ts';

function createFactory({
  abortReadWriteAfter,
  abortReadWriteAt,
  abortAfterRead,
  abortAfterReadFrom = 1,
}: {
  abortReadWriteAfter?: number;
  abortReadWriteAt?: number;
  abortAfterRead?: boolean;
  abortAfterReadFrom?: number;
} = {}) {
  const factory = new IDBFactory();
  const txModes: string[] = [];
  let writeTxs = 0;
  const open = factory.open.bind(factory);
  factory.open = (...args) => {
    const request = open(...args);
    request.addEventListener('success', () => {
      const db = request.result;
      const transaction = db.transaction.bind(db);
      db.transaction = (...targs) => {
        const tx = transaction(...targs);
        txModes.push(targs[1]);
        if (targs[1] === 'readwrite') {
          writeTxs += 1;
          if (abortReadWriteAfter !== undefined && writeTxs > abortReadWriteAfter) {
            queueMicrotask(() => tx.abort());
          }
          if (abortReadWriteAt === writeTxs) {
            queueMicrotask(() => tx.abort());
          }
          if (abortAfterRead && writeTxs >= abortAfterReadFrom) {
            const objectStore = tx.objectStore.bind(tx);
            tx.objectStore = (name) => {
              const store = objectStore(name);
              const getAll = store.getAll.bind(store);
              store.getAll = () => {
                const request = getAll();
                request.addEventListener('success', () => queueMicrotask(() => tx.abort()));
                return request;
              };
              return store;
            };
          }
        }
        return tx;
      };
    });
    return request;
  };
  factory.txModes = txModes;
  return factory;
}

function createFailingOpenFactory() {
  return {
    open: () => {
      const request = { onsuccess: null, onerror: null, onupgradeneeded: null, onblocked: null };
      queueMicrotask(() => request.onerror?.());
      return request;
    },
  };
}

async function readDurableIds(factory): Promise<string[]> {
  const db = await new Promise((resolve) => {
    const request = factory.open('hyperneo-voice-audio');
    request.onsuccess = () => resolve(request.result);
  });
  const rows = await new Promise((resolve) => {
    const tx = db.transaction('records', 'readonly');
    const request = tx.objectStore('records').getAll();
    request.onsuccess = () => resolve(request.result);
    tx.oncomplete = () => db.close();
  });
  return rows.map((row) => row.id).sort();
}

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
    globalThis.indexedDB = createFactory();
  });

  afterEach(() => {
    globalThis.indexedDB = undefined;
  });

  it('persists a finished recording durably and reads it back after a reload', async () => {
    await putVoiceRecord(makeEntry('r1', NOW));
    resetVoiceAudioStore();
    const entry = await getVoiceRecord('r1');
    expect(entry?.audioBase64).toBe('wav-bytes-r1');
    expect(entry?.sessionId).toBe('s1');
    expect(entry?.mimeType).toBe('audio/wav');
    expect(await listVoiceRecords()).toHaveLength(1);
  });

  it('lists records sorted by createdAt ascending regardless of put order', async () => {
    await putVoiceRecord(makeEntry('newer', NOW + 5_000));
    await putVoiceRecord(makeEntry('older', NOW));
    expect((await listVoiceRecords()).map((e) => e.id)).toEqual(['older', 'newer']);
  });

  it('prunes to the count cap keeping the newest records, durably', async () => {
    for (let i = 0; i < 7; i++) await putVoiceRecord(makeEntry(`r${i}`, NOW + i));
    expect((await listVoiceRecords()).map((e) => e.id)).toEqual(['r2', 'r3', 'r4', 'r5', 'r6']);
    resetVoiceAudioStore();
    expect((await listVoiceRecords()).map((e) => e.id)).toEqual(['r2', 'r3', 'r4', 'r5', 'r6']);
  });

  it('drops a put whose record is already expired', async () => {
    expect(await putVoiceRecord(makeEntry('stale', NOW - DAY_MS - 1_000))).toBe(false);
    await putVoiceRecord(makeEntry('fresh', NOW));
    expect((await listVoiceRecords()).map((e) => e.id)).toEqual(['fresh']);
    resetVoiceAudioStore();
    expect(await getVoiceRecord('stale')).toBeNull();
  });

  it('rolls back eviction when the replacement write aborts at commit', async () => {
    globalThis.indexedDB = createFactory({ abortAfterRead: true, abortAfterReadFrom: 6 });
    for (let i = 0; i < 6; i++) await putVoiceRecord(makeEntry(`r${i}`, NOW + i));
    expect((await listVoiceRecords()).map((e) => e.id)).toEqual([
      'r0',
      'r1',
      'r2',
      'r3',
      'r4',
      'r5',
    ]);
    resetVoiceAudioStore();
    expect((await listVoiceRecords()).map((e) => e.id)).toEqual(['r0', 'r1', 'r2', 'r3', 'r4']);
  });

  it('leaves no tombstones and caps the mirror when transactions abort after their read', async () => {
    const factory = createFactory({ abortAfterRead: true });
    globalThis.indexedDB = factory;
    for (let i = 0; i < 6; i++)
      expect(await putVoiceRecord(makeEntry(`r${i}`, NOW + i))).toBe(false);
    expect((await listVoiceRecords()).map((e) => e.id)).toEqual(['r1', 'r2', 'r3', 'r4', 'r5']);
    expect(await readDurableIds(factory)).toEqual([]);
  });

  it('serializes overlapping puts against shared eviction state', async () => {
    const factory = createFactory();
    globalThis.indexedDB = factory;
    for (let i = 0; i < 5; i++) await putVoiceRecord(makeEntry(`r${i}`, NOW + i));
    const results = await Promise.all([
      putVoiceRecord(makeEntry('a', NOW + 10)),
      putVoiceRecord(makeEntry('b', NOW + 11)),
    ]);
    expect(results).toEqual([true, true]);
    resetVoiceAudioStore();
    expect((await listVoiceRecords()).map((e) => e.id)).toEqual(['r2', 'r3', 'r4', 'a', 'b']);
  });

  it('persists a pending memory-only record on the next successful write', async () => {
    const factory = createFactory({ abortReadWriteAt: 1 });
    globalThis.indexedDB = factory;
    expect(await putVoiceRecord(makeEntry('x', NOW))).toBe(false);
    expect(await getVoiceRecord('x')).not.toBeNull();
    expect(await putVoiceRecord(makeEntry('y', NOW + 1))).toBe(true);
    resetVoiceAudioStore();
    expect((await listVoiceRecords()).map((e) => e.id)).toEqual(['x', 'y']);
  });

  it('persists the newest copy when an overwrite aborts', async () => {
    const factory = createFactory({ abortReadWriteAt: 2 });
    globalThis.indexedDB = factory;
    await putVoiceRecord(makeEntry('x', NOW));
    const revised = makeEntry('x', NOW);
    revised.audioBase64 = 'wav-bytes-revised';
    expect(await putVoiceRecord(revised)).toBe(false);
    await putVoiceRecord(makeEntry('y', NOW + 1));
    resetVoiceAudioStore();
    expect((await getVoiceRecord('x'))?.audioBase64).toBe('wav-bytes-revised');
  });

  it('deletes a record from both the mirror and durable storage', async () => {
    await putVoiceRecord(makeEntry('r1', NOW));
    await deleteVoiceRecord('r1');
    expect(await getVoiceRecord('r1')).toBeNull();
    expect(await listVoiceRecords()).toHaveLength(0);
    resetVoiceAudioStore();
    expect(await getVoiceRecord('r1')).toBeNull();
  });

  it('keeps a deleted record suppressed when the durable removal fails', async () => {
    globalThis.indexedDB = createFactory({ abortReadWriteAfter: 0 });
    await putVoiceRecord(makeEntry('r1', NOW));
    await deleteVoiceRecord('r1');
    expect(await getVoiceRecord('r1')).toBeNull();
    expect(await listVoiceRecords()).toHaveLength(0);
  });

  it('releases the connection on version upgrade and the mirror after durable commits', async () => {
    const factory = createFactory();
    globalThis.indexedDB = factory;
    await putVoiceRecord(makeEntry('r1', NOW));
    const upgrade = factory.open('hyperneo-voice-audio', 2);
    await new Promise((resolve) => {
      upgrade.onsuccess = () => resolve(null);
      upgrade.onerror = () => resolve(null);
    });
    expect(await getVoiceRecord('r1')).toBeNull();
  });

  it('degrades to in-memory-only when opening the database fails', async () => {
    globalThis.indexedDB = createFailingOpenFactory();
    expect(await putVoiceRecord(makeEntry('r1', NOW))).toBe(false);
    expect((await listVoiceRecords()).map((e) => e.id)).toEqual(['r1']);
    expect((await getVoiceRecord('r1'))?.audioBase64).toBe('wav-bytes-r1');
    resetVoiceAudioStore();
    expect(await getVoiceRecord('r1')).toBeNull();
    globalThis.indexedDB = undefined;
    expect(await putVoiceRecord(makeEntry('r2', NOW))).toBe(false);
    expect((await listVoiceRecords()).map((e) => e.id)).toEqual(['r2']);
  });

  it('caps the in-memory mirror while durable storage is unavailable', async () => {
    globalThis.indexedDB = createFailingOpenFactory();
    for (let i = 0; i < 7; i++)
      expect(await putVoiceRecord(makeEntry(`r${i}`, NOW + i))).toBe(false);
    expect((await listVoiceRecords()).map((e) => e.id)).toEqual(['r2', 'r3', 'r4', 'r5', 'r6']);
  });

  it('lets a valid put replace a malformed durable row with the same id', async () => {
    const factory = createFactory();
    globalThis.indexedDB = factory;
    await putVoiceRecord({ id: 'x', sessionId: 's1', audioBase64: 'junk' });
    expect(await putVoiceRecord(makeEntry('x', NOW))).toBe(true);
    resetVoiceAudioStore();
    expect((await getVoiceRecord('x'))?.audioBase64).toBe('wav-bytes-x');
  });

  it('reports a put as non-durable when the transaction aborts but keeps the entry', async () => {
    globalThis.indexedDB = createFactory({ abortReadWriteAfter: 0 });
    expect(await putVoiceRecord(makeEntry('r1', NOW))).toBe(false);
    expect((await listVoiceRecords()).map((e) => e.id)).toEqual(['r1']);
    resetVoiceAudioStore();
    expect(await getVoiceRecord('r1')).toBeNull();
  });

  it('reads and evicts inside a single write transaction on put', async () => {
    const factory = createFactory();
    globalThis.indexedDB = factory;
    factory.txModes.length = 0;
    await putVoiceRecord(makeEntry('r1', NOW));
    expect(factory.txModes).toEqual(['readwrite']);
  });

  it('skips malformed durable rows and sweeps them on prune', async () => {
    const factory = createFactory();
    globalThis.indexedDB = factory;
    await putVoiceRecord(makeEntry('ok', NOW));
    await putVoiceRecord({ id: 'junk', sessionId: 's1', audioBase64: 'x' });
    await putVoiceRecord({
      id: 'flag',
      sessionId: 's1',
      audioBase64: 'x',
      mimeType: 'audio/wav',
      peakLevel: 0.5,
      createdAt: NOW,
      hitDurationLimit: 'false',
    });
    expect((await listVoiceRecords()).map((e) => e.id)).toEqual(['ok']);
    await pruneVoiceRecords();
    expect(await readDurableIds(factory)).toEqual(['ok']);
  });
});
