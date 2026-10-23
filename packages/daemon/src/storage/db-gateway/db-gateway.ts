import type { StructuredLogEvent } from '@hyperneo/shared';
import { emitStructuredLogEvent, Logger } from '../../lib/logger.ts';
import type { Database } from '../sqlite-compat.ts';
import type { SQLiteQueryObservabilityOptions } from '../sqlite-query-observability.ts';
import {
  ChangeRecorder,
  type DbOp,
  type Method,
  type RepositoryOp,
  type TableChange,
} from './db-op.ts';

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
  | { id: number; result?: unknown; changes?: TableChange[]; error?: string };

const log = new Logger('db-gateway');
const MAX_PENDING = 1024;
const REPLY_TIMEOUT_MS = 30_000;

class WorkerLane {
  private worker: Worker | null = null;
  private ready: Promise<Worker> | null = null;
  private closed = false;
  private watchdog: ReturnType<typeof setTimeout> | null = null;
  private id = 0;
  private readonly pending = new Map<
    number,
    { resolve: (result: unknown) => void; reject: (error: Error) => void }
  >();

  constructor(
    private readonly lane: Lane,
    private readonly dbPath: string,
    private readonly createWorker: () => Worker,
    private readonly replyTimeoutMs: number,
    private readonly replay: (changes: TableChange[]) => void,
    private readonly queryObservability?: SQLiteQueryObservabilityOptions
  ) {}

  send(op: string | null, args?: unknown): Promise<unknown> {
    if (op !== null && this.closed)
      return Promise.reject(new Error(`DB gateway ${this.lane} closed`));
    if (op !== null && this.pending.size >= MAX_PENDING)
      return Promise.reject(new Error(`DB gateway ${this.lane} queue full`));
    const id = ++this.id;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.watchdog ??= this.armWatchdog();
      void this.open().then((worker) => {
        try {
          worker.postMessage({
            id,
            dbPath: this.dbPath,
            lane: this.lane,
            op,
            args,
            queryObservability: this.queryObservability,
          } satisfies DbGatewayRequest);
        } catch (error) {
          const waiter = this.pending.get(id);
          this.pending.delete(id);
          this.rearmWatchdog();
          waiter?.reject(error instanceof Error ? error : new Error(String(error)));
        }
      });
    });
  }

  close(): Promise<void> {
    this.closed = true;
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
          this.rearmWatchdog();
          if (data.error !== undefined) waiter?.reject(new Error(data.error));
          else {
            if (data.changes?.length) this.replay(data.changes);
            waiter?.resolve(data.result);
          }
        }
      };
      worker.onerror = (event) => {
        event.preventDefault?.();
        this.stop(new Error(event.message || `DB gateway ${this.lane} worker failed`));
      };
    }));
  }

  private armWatchdog(): ReturnType<typeof setTimeout> {
    return setTimeout(
      () =>
        this.stop(
          new Error(
            `DB gateway ${this.lane} worker gave no reply for ${this.replyTimeoutMs} ms; outcome unknown`
          )
        ),
      this.replyTimeoutMs
    );
  }

  private rearmWatchdog(): void {
    if (this.watchdog) clearTimeout(this.watchdog);
    this.watchdog = this.pending.size > 0 ? this.armWatchdog() : null;
  }

  private stop(error = new Error(`DB gateway ${this.lane} worker closed`)): void {
    this.worker?.terminate();
    this.worker = null;
    this.ready = null;
    if (this.watchdog) clearTimeout(this.watchdog);
    this.watchdog = null;
    for (const waiter of this.pending.values()) waiter.reject(error);
    this.pending.clear();
  }
}

export class DbGateway {
  private readonly lanes: Record<Lane, WorkerLane>;
  onChanges: (changes: TableChange[]) => void = () => {};

  constructor(
    dbPath: string,
    private readonly inline: Database | null,
    queryObservability?: SQLiteQueryObservabilityOptions,
    createWorker = () =>
      new Worker(new URL('./db-gateway-worker.ts', import.meta.url).href, { type: 'module' }),
    replyTimeoutMs = REPLY_TIMEOUT_MS
  ) {
    this.lanes = {
      read: new WorkerLane(
        'read',
        dbPath,
        createWorker,
        replyTimeoutMs,
        this.replay,
        queryObservability
      ),
      write: new WorkerLane(
        'write',
        dbPath,
        createWorker,
        replyTimeoutMs,
        this.replay,
        queryObservability
      ),
    };
  }

  run<A, R>(op: DbOp<A, R>, args: A): Promise<R> {
    const db = this.inline;
    if (db)
      return Promise.resolve().then(() => {
        const recorder = new ChangeRecorder();
        const result = db.transaction(
          () => op.run(db, args, recorder),
          op.mode === 'write' ? 'immediate' : 'deferred'
        )();
        if (recorder.changes.length) this.replay(recorder.changes);
        return result;
      });
    return this.lanes[op.mode].send(op.name, args) as Promise<R>;
  }

  call<R, M extends Method<R>, K extends M>(
    op: RepositoryOp<R, M>,
    method: K,
    ...args: R[K] extends (...args: infer P) => unknown ? P : never
  ): Promise<R[K] extends (...args: never[]) => infer T ? Awaited<T> : never> {
    return this.run(op, { method, args }) as never;
  }

  close(): Promise<void> {
    return Promise.all([this.lanes.read.close(), this.lanes.write.close()]).then(() => {});
  }

  private readonly replay = (changes: TableChange[]) => {
    try {
      this.onChanges(changes);
    } catch (error) {
      log.error('could not announce committed table changes:', error);
    }
  };
}

const gateways = new WeakMap<Database, DbGateway>();

export function bindGateway(db: Database, gateway: DbGateway): void {
  gateways.set(db, gateway);
}

export function gatewayFor(db: Database): DbGateway {
  let gateway = gateways.get(db);
  if (gateway) return gateway;
  const unbound = new DbGateway(':memory:', db);
  let warned = false;
  unbound.onChanges = (changes) => {
    if (warned) return;
    warned = true;
    log.warn(
      `changes to ${[...new Set(changes.map((change) => change.table))].join(', ')} ran on a connection with no bound gateway, so nothing announced them`
    );
  };
  gateways.set(db, unbound);
  return unbound;
}
