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

function runTx<T>(
  mode: IDBTransactionMode,
  op: (store: IDBObjectStore) => IDBRequest<T> | null
): Promise<boolean> {
  return openDatabase().then(
    (db) =>
      new Promise<boolean>((resolve) => {
        if (!db) {
          resolve(false);
          return;
        }
        let tx: IDBTransaction;
        try {
          tx = db.transaction(STORE_NAME, mode);
          op(tx.objectStore(STORE_NAME));
        } catch {
          resolve(false);
          return;
        }
        tx.oncomplete = () => resolve(true);
        tx.onabort = () => resolve(false);
        tx.onerror = () => resolve(false);
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

function readStore<T>(read: (store: IDBObjectStore) => IDBRequest<T>): Promise<T | undefined> {
  const container = { value: undefined as T | undefined };
  return runTx('readonly', (store) => {
    const request = read(store);
    request.onsuccess = () => {
      container.value = request.result;
    };
    return request;
  }).then(() => container.value);
}

interface DoomPlan {
  keys: IDBValidKey[];
  ids: Set<string>;
  merged: VoiceRecordEntry[];
}

async function planDoom(): Promise<DoomPlan> {
  const keys: IDBValidKey[] = [];
  const ids = new Set<string>();
  const valid = new Map<string, VoiceRecordEntry>();
  const rows = (await readStore((store) => store.getAll())) ?? [];
  for (const row of rows) {
    const key = (row as { id?: IDBValidKey } | null)?.id;
    if (key === undefined || key === null) continue;
    if (isVoiceRecordEntry(row) && !tombstones.has(key as string)) {
      valid.set(key as string, row);
    } else {
      keys.push(key);
      ids.add(key as string);
    }
  }
  for (const entry of mirror.values()) {
    if (isVoiceRecordEntry(entry)) valid.set(entry.id, entry);
  }
  const merged = [...valid.values()].sort((a, b) => a.createdAt - b.createdAt);
  const now = Date.now();
  const doomed = merged.filter((entry) => now - entry.createdAt >= MAX_AGE_MS);
  const fresh = merged.filter((entry) => now - entry.createdAt < MAX_AGE_MS);
  if (fresh.length > MAX_AUDIO_RECORDS) {
    doomed.push(...fresh.slice(0, fresh.length - MAX_AUDIO_RECORDS));
  }
  for (const entry of doomed) {
    keys.push(entry.id);
    ids.add(entry.id);
  }
  return { keys, ids, merged };
}

export async function putVoiceRecord(entry: VoiceRecordEntry): Promise<boolean> {
  mirror.set(entry.id, entry);
  tombstones.delete(entry.id);
  const plan = await planDoom();
  const selfDoomed = plan.ids.has(entry.id);
  for (const id of plan.ids) {
    mirror.delete(id);
    tombstones.add(id);
  }
  const committed = await runTx('readwrite', (store) => {
    for (const key of plan.keys) store.delete(key);
    return selfDoomed ? null : store.put(entry);
  });
  if (!committed) return false;
  for (const id of plan.ids) tombstones.delete(id);
  if (!selfDoomed) mirror.delete(entry.id);
  return !selfDoomed;
}

export async function getVoiceRecord(id: string): Promise<VoiceRecordEntry | null> {
  const mirrored = mirror.get(id);
  if (mirrored && Date.now() - mirrored.createdAt < MAX_AGE_MS) return mirrored;
  const row = await readStore((store) => store.get(id));
  if (!isVoiceRecordEntry(row) || tombstones.has(id)) return null;
  return Date.now() - row.createdAt < MAX_AGE_MS ? row : null;
}

export async function listVoiceRecords(): Promise<VoiceRecordEntry[]> {
  const now = Date.now();
  return (await planDoom()).merged.filter((entry) => now - entry.createdAt < MAX_AGE_MS);
}

export async function deleteVoiceRecord(id: string): Promise<void> {
  mirror.delete(id);
  tombstones.add(id);
  const removed = await runTx('readwrite', (store) => store.delete(id));
  if (removed) tombstones.delete(id);
}

export async function pruneVoiceRecords(): Promise<void> {
  const plan = await planDoom();
  if (plan.keys.length === 0) return;
  for (const id of plan.ids) {
    mirror.delete(id);
    tombstones.add(id);
  }
  const swept = await runTx('readwrite', (store) => {
    for (const key of plan.keys) store.delete(key);
    return null;
  });
  if (swept) for (const id of plan.ids) tombstones.delete(id);
}

export function resetVoiceAudioStore(): void {
  mirror.clear();
  tombstones.clear();
  dbPromise = null;
}
