import { generateUUID } from '@hyperneo/shared';
import type { DbScopeType } from './scope-config.ts';
import type { ScopedDbQuery, ScopedDbQueryResult } from './scoped-query.ts';

const DEFAULT_DB_QUERY_TIMEOUT_MS = 10_000;

export type DbQueryRequest = ScopedDbQuery & {
  scopeType: DbScopeType;
  scopeValue: string;
};

type ActiveDbQuery = {
  timer: ReturnType<typeof setTimeout>;
  resolve: (result: ScopedDbQueryResult) => void;
  reject: (error: Error) => void;
};

type DbQueryWorkerMessage =
  | { id: string; result: ScopedDbQueryResult }
  | { id: string; error: string };

export class DbQueryWorkerService {
  private worker: Worker | null = null;
  private activeById = new Map<string, ActiveDbQuery>();
  private closed = false;

  constructor(
    private dbPath: string,
    private timeoutMs: number = DEFAULT_DB_QUERY_TIMEOUT_MS,
    private spawnWorker: () => Worker = () =>
      new Worker(new URL('./db-query-worker.ts', import.meta.url).href, {
        type: 'module',
      })
  ) {}

  query(request: DbQueryRequest): Promise<ScopedDbQueryResult> {
    if (this.closed) {
      return Promise.reject(new Error('Query cancelled'));
    }
    let worker: Worker;
    try {
      worker = this.ensureWorker();
    } catch (error) {
      return Promise.reject(error instanceof Error ? error : new Error(String(error)));
    }
    const id = generateUUID();
    return new Promise<ScopedDbQueryResult>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.failAll(new Error('Query timed out'));
      }, this.timeoutMs);
      this.activeById.set(id, { timer, resolve, reject });
      try {
        worker.postMessage({
          id,
          dbPath: this.dbPath,
          scopeType: request.scopeType,
          scopeValue: request.scopeValue,
          sql: request.sql,
          params: request.params,
          limit: request.limit,
        });
      } catch (error) {
        this.activeById.delete(id);
        clearTimeout(timer);
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    });
  }

  close(): void {
    this.closed = true;
    this.failAll(new Error('Query cancelled'));
  }

  private ensureWorker(): Worker {
    if (this.worker) return this.worker;
    const worker = this.spawnWorker();
    worker.onmessage = (event: MessageEvent<DbQueryWorkerMessage>) => {
      const message = event.data;
      const active = this.activeById.get(message.id);
      if (!active) return;
      this.activeById.delete(message.id);
      clearTimeout(active.timer);
      if ('result' in message) {
        active.resolve(message.result);
      } else {
        active.reject(new Error(message.error));
      }
    };
    worker.onerror = () => {
      this.failAll(new Error('db_query worker failed'));
    };
    this.worker = worker;
    return worker;
  }

  private failAll(error: Error): void {
    this.worker?.terminate();
    this.worker = null;
    const activeRequests = [...this.activeById.values()];
    this.activeById.clear();
    for (const active of activeRequests) {
      clearTimeout(active.timer);
      active.reject(error);
    }
  }
}
