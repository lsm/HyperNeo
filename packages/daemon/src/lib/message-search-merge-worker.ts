import { Database as BunDatabase } from '../storage/sqlite-compat';

type MergeWorkerRequest = {
  dbPath: string;
};

type MergeWorkerResponse = {
  ok: boolean;
  error?: string;
};

type WorkerGlobal = {
  onmessage: ((event: { data: MergeWorkerRequest }) => void | Promise<void>) | null;
  postMessage(message: MergeWorkerResponse): void;
};

const worker = globalThis as unknown as WorkerGlobal;

worker.onmessage = (event) => {
  const { dbPath } = event.data;
  let db: BunDatabase | null = null;
  try {
    db = new BunDatabase(dbPath);
    db.exec(`PRAGMA busy_timeout = 5000`);
    db.exec(`INSERT INTO message_search_fts(message_search_fts, rank) VALUES('merge', 4096)`);
    worker.postMessage({ ok: true });
  } catch (error) {
    worker.postMessage({
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    });
  } finally {
    db?.close();
  }
};
