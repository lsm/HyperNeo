import { Database } from '../../../packages/daemon/src/storage/sqlite-compat.ts';

const worker = globalThis as unknown as {
  onmessage: ((event: MessageEvent<{ dbPath: string; barrier: SharedArrayBuffer }>) => void) | null;
  postMessage(data: unknown): void;
};
worker.onmessage = ({ data }) => {
  const db = new Database(data.dbPath);
  const state = new Int32Array(data.barrier);
  let result: { committed: true } | { error: string };
  try {
    db.exec('PRAGMA busy_timeout=5000');
    worker.postMessage({ ready: true });
    Atomics.wait(state, 0, 0);
    db.prepare('UPDATE synthetic_writer SET value=value+1').run();
    Atomics.store(state, 1, 1);
    Atomics.notify(state, 1);
    result = { committed: true };
  } catch (error) {
    result = { error: String(error) };
  } finally {
    db.close();
  }
  worker.postMessage(result);
};
