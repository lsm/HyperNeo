import { Database as BunDatabase } from '../../storage/sqlite-compat.ts';
import { runScopedQuery, type ScopedDbQueryResult } from './scoped-query.ts';
import type { DbScopeType } from './scope-config.ts';

type DbQueryWorkerRequest = {
  id: string;
  dbPath: string;
  scopeType: DbScopeType;
  scopeValue: string;
  sql: string;
  params?: unknown[];
  limit?: number;
};

type DbQueryWorkerResponse =
  | { id: string; started: true }
  | { id: string; result: ScopedDbQueryResult }
  | { id: string; error: string };

type WorkerGlobal = {
  onmessage: ((event: { data: DbQueryWorkerRequest }) => void | Promise<void>) | null;
  postMessage(message: DbQueryWorkerResponse): void;
};

const worker = globalThis as unknown as WorkerGlobal;

let db: BunDatabase | null = null;
let openDbPath: string | null = null;

function getDatabase(dbPath: string): BunDatabase {
  if (db !== null && openDbPath === dbPath) return db;
  db?.close();
  db = new BunDatabase(dbPath, { readonly: true });
  db.exec(`PRAGMA query_only = ON`);
  db.exec(`PRAGMA busy_timeout = 5000`);
  db.exec(`PRAGMA case_sensitive_like = ON`);
  openDbPath = dbPath;
  return db;
}

worker.onmessage = (event) => {
  const { id, dbPath, scopeType, scopeValue, sql, params, limit } = event.data;
  worker.postMessage({ id, started: true });
  try {
    const result = runScopedQuery(getDatabase(dbPath), scopeType, scopeValue, {
      sql,
      params,
      limit,
    });
    worker.postMessage({ id, result });
  } catch (error) {
    worker.postMessage({ id, error: error instanceof Error ? error.message : String(error) });
  }
};
