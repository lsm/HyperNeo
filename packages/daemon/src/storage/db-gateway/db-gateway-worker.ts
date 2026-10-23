import { subscribeToStructuredLogs } from '../../lib/logger.ts';
import { Database } from '../sqlite-compat.ts';
import { DB_OPS } from './db-ops.ts';
import type { DbGatewayReply, DbGatewayRequest } from './db-gateway.ts';

const worker = globalThis as unknown as {
  onmessage: (event: { data: DbGatewayRequest }) => void;
  postMessage(reply: DbGatewayReply): void;
};
let db: Database | null = null;
let workerOperation = 'db-gateway';
subscribeToStructuredLogs((log) => {
  if (log.module === 'hyperneo:daemon:sqlite.query')
    worker.postMessage({
      log: {
        ...log,
        metadata:
          log.metadata.event === 'summary' ? log.metadata : { ...log.metadata, workerOperation },
      },
    });
});

worker.onmessage = ({ data }) => {
  const { id, lane, op: name } = data;
  if (name === null) {
    db?.close();
    db = null;
    worker.postMessage({ id, result: null });
    return;
  }
  workerOperation = name;
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
    const result = open.transaction(
      () => op.run(open, data.args as never),
      lane === 'write' ? 'immediate' : 'deferred'
    )();
    worker.postMessage({ id, result });
  } catch (error) {
    worker.postMessage({ id, error: error instanceof Error ? error.message : String(error) });
  }
};

worker.postMessage({ ready: true });
