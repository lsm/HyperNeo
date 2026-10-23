import type { StructuredLogEvent } from '@hyperneo/shared';
import { emitStructuredLogEvent } from '../../lib/logger.ts';
import type { Database } from '../sqlite-compat.ts';
import type { SQLiteQueryObservabilityOptions } from '../sqlite-query-observability.ts';
import type { DbOp } from './db-op.ts';

type Lane = DbOp<unknown, unknown>['mode'];

export type DbGatewayRequest = {
  id: number;
  dbPath: string;
  lane: Lane;
  op: string | null;
  args?: unknown;
  queryObservability?: SQLiteQueryObservabilityOptions;
};
export type DbGatewayReply =
  | { ready: true }
  | { log: StructuredLogEvent }
  | { id: number; result?: unknown; error?: string };

const MAX_PENDING = 1024;

class WorkerLane {
  private worker: Worker | null = null;
  private ready: Promise<Worker> | null = null;
  private id = 0;
  private readonly pending = new Map<
    number,
    { resolve: (result: unknown) => void; reject: (error: Error) => void }
  >();

  constructor(
    private readonly lane: Lane,
    private readonly dbPath: string,
    private readonly createWorker: () => Worker,
    private readonly queryObservability?: SQLiteQueryObservabilityOptions
  ) {}

  send(op: string | null, args?: unknown): Promise<unknown> {
    if (op !== null && this.pending.size >= MAX_PENDING)
      return Promise.reject(new Error(`DB gateway ${this.lane} queue full`));
    const id = ++this.id;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      void this.open().then((worker) =>
        worker.postMessage({
          id,
          dbPath: this.dbPath,
          lane: this.lane,
          op,
          args,
          queryObservability: this.queryObservability,
        } satisfies DbGatewayRequest)
      );
    });
  }

  close(): Promise<void> {
    if (!this.worker) return Promise.resolve();
    return this.send(null)
      .catch(() => {})
      .then(() => this.stop());
  }

  private open(): Promise<Worker> {
    return (this.ready ??= new Promise((resolve) => {
      let worker: Worker;
      try {
        worker = this.worker = this.createWorker();
      } catch (error) {
        queueMicrotask(() => this.stop(error instanceof Error ? error : new Error(String(error))));
        return;
      }
      worker.onmessage = ({ data }: MessageEvent<DbGatewayReply>) => {
        if ('ready' in data) resolve(worker);
        else if ('log' in data)
          emitStructuredLogEvent({
            ...data.log,
            args: [data.log.message],
            metadata: { ...data.log.metadata, workerKind: `db-gateway-${this.lane}` },
          });
        else {
          const waiter = this.pending.get(data.id);
          this.pending.delete(data.id);
          if (data.error === undefined) waiter?.resolve(data.result);
          else waiter?.reject(new Error(data.error));
        }
      };
      worker.onerror = (event) => {
        event.preventDefault?.();
        this.stop(new Error(event.message || `DB gateway ${this.lane} worker failed`));
      };
    }));
  }

  private stop(error = new Error(`DB gateway ${this.lane} worker closed`)): void {
    this.worker?.terminate();
    this.worker = null;
    this.ready = null;
    for (const waiter of this.pending.values()) waiter.reject(error);
    this.pending.clear();
  }
}

export class DbGateway {
  private readonly lanes: Record<Lane, WorkerLane>;

  constructor(
    dbPath: string,
    private readonly inline: Database | null,
    queryObservability?: SQLiteQueryObservabilityOptions,
    createWorker = () =>
      new Worker(new URL('./db-gateway-worker.ts', import.meta.url).href, { type: 'module' })
  ) {
    this.lanes = {
      read: new WorkerLane('read', dbPath, createWorker, queryObservability),
      write: new WorkerLane('write', dbPath, createWorker, queryObservability),
    };
  }

  run<A, R>(op: DbOp<A, R>, args: A): Promise<R> {
    const db = this.inline;
    if (db)
      return Promise.resolve().then(() =>
        db.transaction(() => op.run(db, args), op.mode === 'write' ? 'immediate' : 'deferred')()
      );
    return this.lanes[op.mode].send(op.name, args) as Promise<R>;
  }

  close(): Promise<void> {
    return Promise.all([this.lanes.read.close(), this.lanes.write.close()]).then(() => {});
  }
}
