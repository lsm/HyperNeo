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
      request.onsuccess = () => resolve(request.result);
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
): Promise<T | null> {
  return openDatabase().then(
    (db) =>
      new Promise<T | null>((resolve) => {
        if (!db) {
          resolve(null);
          return;
        }
        let tx: IDBTransaction;
        let request: IDBRequest<T>;
        try {
          tx = db.transaction(STORE_NAME, mode);
          request = op(tx.objectStore(STORE_NAME));
        } catch {
          resolve(null);
          return;
        }
        let value: T | null = null;
        request.onsuccess = () => {
          value = request.result ?? null;
        };
        request.onerror = () => {};
        tx.oncomplete = () => resolve(value);
        tx.onabort = () => resolve(null);
        tx.onerror = () => resolve(null);
      })
  );
}

function isVoiceRecordEntry(value: unknown): value is VoiceRecordEntry {
  if (!value || typeof value !== 'object') return false;
  const entry = value as Record<string, unknown>;
  return (
    typeof entry.id === 'string' &&
    typeof entry.sessionId === 'string' &&
    typeof entry.audioBase64 === 'string'
  );
}

async function readMerged(): Promise<VoiceRecordEntry[]> {
  const stored = (await runStoreOp('readonly', (store) => store.getAll())) ?? [];
  const merged = new Map<string, VoiceRecordEntry>();
  for (const entry of stored) {
    if (isVoiceRecordEntry(entry)) merged.set(entry.id, entry);
  }
  for (const [id, entry] of mirror) merged.set(id, entry);
  return [...merged.values()].sort((a, b) => a.createdAt - b.createdAt);
}

export async function putVoiceRecord(entry: VoiceRecordEntry): Promise<boolean> {
  mirror.set(entry.id, entry);
  const key = await runStoreOp('readwrite', (store) => store.put(entry));
  await pruneVoiceRecords();
  return key !== null;
}

export async function getVoiceRecord(id: string): Promise<VoiceRecordEntry | null> {
  const mirrored = mirror.get(id);
  if (mirrored && Date.now() - mirrored.createdAt < MAX_AGE_MS) return mirrored;
  const stored = await runStoreOp('readonly', (store) => store.get(id));
  if (!isVoiceRecordEntry(stored)) return null;
  return Date.now() - stored.createdAt < MAX_AGE_MS ? stored : null;
}

export async function listVoiceRecords(): Promise<VoiceRecordEntry[]> {
  const now = Date.now();
  return (await readMerged()).filter((entry) => now - entry.createdAt < MAX_AGE_MS);
}

export async function deleteVoiceRecord(id: string): Promise<void> {
  mirror.delete(id);
  await runStoreOp('readwrite', (store) => store.delete(id));
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
  dbPromise = null;
}
