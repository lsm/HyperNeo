import { publishSQLiteWorkerLogs } from '../sqlite-worker-observability.ts';
import { Database } from '../sqlite-compat.ts';
import { ChangeRecorder } from './db-op.ts';
import { DB_OPS } from './db-ops.ts';
import type { DbGatewayReply, DbGatewayRequest } from './db-gateway.ts';

const worker = globalThis as unknown as {
  onmessage: (event: { data: DbGatewayRequest }) => void;
  postMessage(reply: DbGatewayReply): void;
};
let db: Database | null = null;
let identity: Record<string, unknown> = {};
publishSQLiteWorkerLogs(
  (message) => worker.postMessage(message),
  () => identity
);

worker.onmessage = ({ data }) => {
  const { id, lane, op: name } = data;
  identity = { workerOperation: name, workerRequestId: id };
  if (name === null) {
    db?.close();
    db = null;
    worker.postMessage({ id, result: null });
    return;
  }

  try {
    const op = DB_OPS.get(name);
    if (!op || op.mode !== lane) throw new Error(`Unknown ${lane} DB op: ${name}`);
    if (!db) {
      db = new Database(
        data.dbPath,
        lane === 'read'
          ? { readonly: true, queryObservability: data.queryObservability }
          : { queryObservability: data.queryObservability }
      );
      db.exec(
        lane === 'read'
          ? 'PRAGMA query_only=ON; PRAGMA busy_timeout=5000'
          : 'PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000; PRAGMA synchronous=NORMAL'
      );
    }
    const open = db;
    const recorder = new ChangeRecorder();
    const result = open.transaction(
      () => op.run(open, data.args as never, recorder),
      lane === 'write' ? 'immediate' : 'deferred'
    )();
    worker.postMessage({ id, result, changes: recorder.changes });
  } catch (error) {
    worker.postMessage({ id, error: error instanceof Error ? error.message : String(error) });
  }
};

worker.postMessage({ ready: true });
