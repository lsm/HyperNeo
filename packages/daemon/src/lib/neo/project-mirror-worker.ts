import { getConfig } from '../../config.ts';
import {
  publishSQLiteWorkerLogs,
  type SQLiteWorkerLog,
} from '../../storage/sqlite-worker-observability.ts';
import { Database } from '../../storage/sqlite-compat.ts';
import type { PlaceGroup } from '../drivers/types.ts';
import { mirrorNeoWorkspaceProjects } from './project-mirror.ts';

const worker = globalThis as unknown as {
  onmessage: (
    event: MessageEvent<{ dbPath: string; groups: PlaceGroup[]; requestId?: string }>
  ) => void;
  postMessage(result: { changed: boolean } | { error: string } | SQLiteWorkerLog): void;
};

let workerRequestId: string | undefined;
publishSQLiteWorkerLogs(
  (message) => worker.postMessage(message),
  () => ({ workerOperation: 'project_mirror', workerRequestId })
);

worker.onmessage = ({ data }) => {
  workerRequestId = data.requestId;
  let db: Database | undefined;
  let result: { changed: boolean } | { error: string };
  try {
    db = new Database(data.dbPath, { queryObservability: getConfig().sqlQueryObservability });
    db.exec('PRAGMA foreign_keys=ON');
    db.exec('PRAGMA busy_timeout=5000');
    db.exec('PRAGMA synchronous=NORMAL');
    result = { changed: mirrorNeoWorkspaceProjects(db, data.groups) };
  } catch (error) {
    result = { error: error instanceof Error ? error.message : String(error) };
  } finally {
    db?.close();
  }
  worker.postMessage(result);
};
