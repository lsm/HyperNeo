import { Database } from './sqlite-compat.ts';
import { selectSdkBodyWriteMode, type SdkBodyWriteMode } from './sdk-message-body-admission.ts';

const worker = globalThis as unknown as {
  onmessage: ((event: MessageEvent<{ dbPath: string }>) => Promise<void>) | null;
  postMessage(mode: SdkBodyWriteMode): void;
};

worker.onmessage = async ({ data }) => {
  let db: Database | undefined;
  let mode: SdkBodyWriteMode;
  try {
    db = new Database(data.dbPath, { readonly: true });
    db.exec('PRAGMA query_only=ON; PRAGMA busy_timeout=5000');
    mode = await selectSdkBodyWriteMode(db);
  } catch {
    mode = { mode: 'dual-write', reason: 'coverage_worker_failed' };
  } finally {
    db?.close();
  }
  worker.postMessage(mode);
};
