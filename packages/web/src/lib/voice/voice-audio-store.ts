export interface VoiceRecordEntry {
  id: string;
  sessionId: string;
  audioBase64: string;
  mimeType: string;
  hitDurationLimit?: boolean;
  peakLevel: number;
  createdAt: number;
}

const DB_NAME = 'hyperneo-voice-audio';
const DB_VERSION = 1;
const STORE_NAME = 'records';
const MAX_AUDIO_RECORDS = 5;
const MAX_AGE_MS = 24 * 60 * 60 * 1000;

const mirror = new Map<string, VoiceRecordEntry>();
const tombstones = new Set<string>();
let dbPromise: Promise<IDBDatabase | null> | null = null;

function openDatabase(): Promise<IDBDatabase | null> {
  if (!dbPromise) {
    dbPromise = new Promise<IDBDatabase | null>((resolve) => {
      let request: IDBOpenDBRequest;
      try {
        if (!globalThis.indexedDB) {
          resolve(null);
          return;
        }
        request = globalThis.indexedDB.open(DB_NAME, DB_VERSION);
      } catch {
        resolve(null);
        return;
      }
      request.onupgradeneeded = () => {
        const db = request.result;
        if (!db.objectStoreNames.contains(STORE_NAME)) {
          db.createObjectStore(STORE_NAME, { keyPath: 'id' });
        }
      };
      request.onsuccess = () => {
        const db = request.result;
        db.onversionchange = () => {
          db.close();
          dbPromise = null;
        };
        db.onclose = () => {
          dbPromise = null;
        };
        resolve(db);
      };
      request.onerror = () => resolve(null);
      request.onblocked = () => resolve(null);
    });
    void dbPromise.then((db) => {
      if (!db) dbPromise = null;
    });
  }
  return dbPromise;
}

function runStoreOp<T>(
  mode: IDBTransactionMode,
  op: (store: IDBObjectStore) => IDBRequest<T>
): Promise<{ ok: boolean; value: T | null }> {
  return openDatabase().then(
    (db) =>
      new Promise((resolve) => {
        if (!db) {
          resolve({ ok: false, value: null });
          return;
        }
        let tx: IDBTransaction;
        let request: IDBRequest<T>;
        try {
          tx = db.transaction(STORE_NAME, mode);
          request = op(tx.objectStore(STORE_NAME));
        } catch {
          resolve({ ok: false, value: null });
          return;
        }
        let value: T | null = null;
        request.onsuccess = () => {
          value = request.result ?? null;
        };
        request.onerror = () => {};
        tx.oncomplete = () => resolve({ ok: true, value });
        tx.onabort = () => resolve({ ok: false, value: null });
        tx.onerror = () => resolve({ ok: false, value: null });
      })
  );
}

function isVoiceRecordEntry(value: unknown): value is VoiceRecordEntry {
  if (!value || typeof value !== 'object') return false;
  const entry = value as Record<string, unknown>;
  return (
    typeof entry.id === 'string' &&
    typeof entry.sessionId === 'string' &&
    typeof entry.audioBase64 === 'string' &&
    typeof entry.mimeType === 'string' &&
    typeof entry.peakLevel === 'number' &&
    Number.isFinite(entry.peakLevel) &&
    typeof entry.createdAt === 'number' &&
    Number.isFinite(entry.createdAt)
  );
}

async function readMerged(): Promise<VoiceRecordEntry[]> {
  const stored = (await runStoreOp('readonly', (store) => store.getAll())).value ?? [];
  const merged = new Map<string, VoiceRecordEntry>();
  for (const entry of stored) {
    if (isVoiceRecordEntry(entry) && !tombstones.has(entry.id)) merged.set(entry.id, entry);
  }
  for (const [id, entry] of mirror) merged.set(id, entry);
  return [...merged.values()].sort((a, b) => a.createdAt - b.createdAt);
}

export async function putVoiceRecord(entry: VoiceRecordEntry): Promise<boolean> {
  mirror.set(entry.id, entry);
  tombstones.delete(entry.id);
  await pruneVoiceRecords();
  if (!mirror.has(entry.id)) return false;
  const result = await runStoreOp('readwrite', (store) => store.put(entry));
  return result.ok;
}

export async function getVoiceRecord(id: string): Promise<VoiceRecordEntry | null> {
  const mirrored = mirror.get(id);
  if (mirrored && Date.now() - mirrored.createdAt < MAX_AGE_MS) return mirrored;
  const stored = (await runStoreOp('readonly', (store) => store.get(id))).value;
  if (!isVoiceRecordEntry(stored) || tombstones.has(stored.id)) return null;
  return Date.now() - stored.createdAt < MAX_AGE_MS ? stored : null;
}

export async function listVoiceRecords(): Promise<VoiceRecordEntry[]> {
  const now = Date.now();
  return (await readMerged()).filter((entry) => now - entry.createdAt < MAX_AGE_MS);
}

export async function deleteVoiceRecord(id: string): Promise<void> {
  mirror.delete(id);
  tombstones.add(id);
  const result = await runStoreOp('readwrite', (store) => store.delete(id));
  if (result.ok) tombstones.delete(id);
}

export async function pruneVoiceRecords(): Promise<void> {
  const merged = await readMerged();
  const now = Date.now();
  const doomed = new Set<string>();
  for (const entry of merged) {
    if (now - entry.createdAt >= MAX_AGE_MS) doomed.add(entry.id);
  }
  const live = merged.filter((entry) => now - entry.createdAt < MAX_AGE_MS);
  if (live.length > MAX_AUDIO_RECORDS) {
    for (const entry of live.slice(0, live.length - MAX_AUDIO_RECORDS)) doomed.add(entry.id);
  }
  for (const id of doomed) await deleteVoiceRecord(id);
}

export function resetVoiceAudioStore(): void {
  mirror.clear();
  tombstones.clear();
  dbPromise = null;
}
