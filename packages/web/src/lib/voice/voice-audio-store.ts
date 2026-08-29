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

function isVoiceRecordEntry(value: unknown): value is VoiceRecordEntry {
  if (!value || typeof value !== 'object') return false;
  const entry = value as Record<string, unknown>;
  return (
    typeof entry.id === 'string' &&
    typeof entry.sessionId === 'string' &&
    typeof entry.audioBase64 === 'string' &&
    typeof entry.mimeType === 'string' &&
    (entry.hitDurationLimit === undefined || typeof entry.hitDurationLimit === 'boolean') &&
    typeof entry.peakLevel === 'number' &&
    Number.isFinite(entry.peakLevel) &&
    typeof entry.createdAt === 'number' &&
    Number.isFinite(entry.createdAt)
  );
}

interface DoomPlan {
  keys: IDBValidKey[];
  ids: Set<string>;
  merged: VoiceRecordEntry[];
  pending: VoiceRecordEntry[];
}

function planDoom(rows: unknown[]): DoomPlan {
  const keys: IDBValidKey[] = [];
  const ids = new Set<string>();
  const valid = new Map<string, VoiceRecordEntry>();
  for (const row of rows) {
    const key = (row as { id?: IDBValidKey } | null)?.id;
    if (key === undefined || key === null) continue;
    if (isVoiceRecordEntry(row) && !tombstones.has(key as string)) {
      valid.set(key as string, row);
    } else {
      keys.push(key);
    }
  }
  const pending: VoiceRecordEntry[] = [];
  const durableIds = new Set(rows.map((row) => (row as { id?: unknown } | null)?.id));
  for (const entry of mirror.values()) {
    if (!isVoiceRecordEntry(entry)) continue;
    valid.set(entry.id, entry);
    if (!durableIds.has(entry.id)) pending.push(entry);
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
  return { keys, ids, merged, pending: pending.filter((entry) => !ids.has(entry.id)) };
}

function pruneMirrorOnly(): void {
  for (const id of planDoom([]).ids) mirror.delete(id);
}

async function writeTx(
  body: (store: IDBObjectStore, plan: DoomPlan) => void
): Promise<DoomPlan | null> {
  let plan: DoomPlan | null = null;
  const committed = await runTx('readwrite', (store) => {
    const request = store.getAll();
    request.onsuccess = () => {
      plan = planDoom(request.result ?? []);
      for (const key of plan.keys) store.delete(key);
      for (const entry of plan.pending) store.put(entry);
      body(store, plan);
    };
    return request;
  });
  if (!committed) pruneMirrorOnly();
  return committed ? plan : null;
}

let mutationQueue: Promise<unknown> = Promise.resolve();

function serializeMutation<T>(op: () => Promise<T>): Promise<T> {
  const run = mutationQueue.then(op);
  mutationQueue = run.catch(() => {});
  return run;
}

export function putVoiceRecord(entry: VoiceRecordEntry): Promise<boolean> {
  return serializeMutation(async () => {
    mirror.set(entry.id, entry);
    tombstones.delete(entry.id);
    const plan = await writeTx((store, doomed) => {
      if (!doomed.ids.has(entry.id)) store.put(entry);
    });
    if (!plan) return false;
    for (const id of plan.ids) mirror.delete(id);
    for (const key of plan.keys) {
      if (typeof key === 'string') tombstones.delete(key);
    }
    for (const persisted of plan.pending) mirror.delete(persisted.id);
    const stored = !plan.ids.has(entry.id);
    if (stored) mirror.delete(entry.id);
    return stored;
  });
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
  const rows = (await readStore((store) => store.getAll())) ?? [];
  return planDoom(rows).merged.filter((entry) => now - entry.createdAt < MAX_AGE_MS);
}

export function deleteVoiceRecord(id: string): Promise<void> {
  return serializeMutation(async () => {
    mirror.delete(id);
    tombstones.add(id);
    const removed = await runTx('readwrite', (store) => store.delete(id));
    if (removed) tombstones.delete(id);
  });
}

export function pruneVoiceRecords(): Promise<void> {
  return serializeMutation(async () => {
    const plan = await writeTx(() => {});
    if (!plan) return;
    for (const id of plan.ids) mirror.delete(id);
    for (const key of plan.keys) {
      if (typeof key === 'string') tombstones.delete(key);
    }
    for (const persisted of plan.pending) mirror.delete(persisted.id);
  });
}

export function resetVoiceAudioStore(): void {
  mirror.clear();
  tombstones.clear();
  dbPromise = null;
}
