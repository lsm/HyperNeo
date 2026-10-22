import type { StructuredLogEvent } from '@hyperneo/shared';
import { emitStructuredLogEvent } from '../logger.ts';
import type { SQLiteQueryObservabilityOptions } from '../../storage/sqlite-query-observability.ts';
import type { IngestExternalEventOutcome } from './ingest-external-event-pipeline.ts';
import type { ExternalEvent } from './types.ts';

export type SessionEventWriteRequest = {
  id: number;
  epoch: number;
  dbPath: string;
  sentAt: number;
  event: ExternalEvent | null;
  queryObservability?: SQLiteQueryObservabilityOptions;
};
export type SessionEventWriteReply =
  | { ready: true }
  | { log: StructuredLogEvent }
  | {
      id: number;
      epoch: number;
      outcome?: IngestExternalEventOutcome;
      error?: string;
      finishedAt: number;
      workerMs: number;
      queueMs: number;
    };

export class SessionEventWriter {
  private worker: Worker | null = null;
  private readonly ready = new WeakSet<Worker>();
  private queue: Promise<unknown> = Promise.resolve();
  private waiting = 0;
  private epoch = 0;
  private id = 0;
  private closing: Promise<void> | null = null;

  constructor(
    private readonly dbPath: string,
    private readonly createWorker = () =>
      new Worker(new URL('./session-event-writer-worker.ts', import.meta.url).href, {
        type: 'module',
      }),
    private readonly timeoutMs = 30000,
    private readonly queryObservability?: SQLiteQueryObservabilityOptions
  ) {}

  ingest(event: ExternalEvent): Promise<IngestExternalEventOutcome> {
    if (this.closing) return Promise.reject(new Error('Session event writer closed'));
    if (this.waiting >= 16) return Promise.reject(new Error('Session event writer queue full'));
    this.waiting++;
    const epoch = this.epoch,
      queuedAt = performance.now();
    const result = this.queue.then(() => {
      if (epoch !== this.epoch)
        throw new Error('Session event writer generation failed before dispatch');
      return this.exchange(event, queuedAt) as Promise<IngestExternalEventOutcome>;
    });
    this.queue = result
      .catch(() => {})
      .finally(() => {
        this.waiting--;
      });
    return result;
  }

  close(): Promise<void> {
    return (this.closing ??= this.queue
      .then(async () => {
        if (this.worker) await this.exchange(null, performance.now());
      })
      .finally(() => {
        this.worker?.terminate();
        this.worker = null;
      }));
  }

  private exchange(
    event: ExternalEvent | null,
    queuedAt: number
  ): Promise<IngestExternalEventOutcome | undefined> {
    const worker = (this.worker ??= this.createWorker()),
      id = ++this.id,
      epoch = this.epoch,
      started = performance.now();
    return new Promise((resolve, reject) => {
      let settled = false,
        sent = false;
      const finish = (
        error?: Error,
        reply?: Exclude<SessionEventWriteReply, { log: StructuredLogEvent } | { ready: true }>,
        unknown = false
      ) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        emitStructuredLogEvent({
          level: error || performance.now() - queuedAt >= 250 ? 'warn' : 'info',
          source: 'logger',
          module: 'hyperneo:daemon:sqlite.worker',
          args: ['sqlite.worker.request'],
          metadata: {
            operation: event ? 'session-event-ingest' : 'session-event-close',
            id,
            epoch,
            outcome: error ? (unknown ? 'unknown' : 'error') : 'ok',
            totalMs: performance.now() - queuedAt,
            queueMs: started - queuedAt,
            workerMs: reply?.workerMs ?? null,
            workerQueueMs: reply?.queueMs ?? null,
            replyMs: reply ? Date.now() - reply.finishedAt : null,
          },
        });
        if (error) {
          this.worker = null;
          this.epoch++;
          worker.terminate();
          reject(
            unknown
              ? new Error(
                  `Session event writer outcome unknown for ${event!.id}: ${error.message}; not replayed`
                )
              : error
          );
        } else resolve(reply?.outcome);
      };
      const timer = setTimeout(
        () => finish(new Error('Session event writer timeout'), undefined, sent && event !== null),
        this.timeoutMs
      );
      worker.onerror = (error) => {
        error.preventDefault?.();
        if (this.worker !== worker) return;
        if (settled) {
          this.worker = null;
          this.epoch++;
          worker.terminate();
        } else finish(new Error(error.message), undefined, sent && event !== null);
      };
      worker.onmessage = ({ data }: MessageEvent<SessionEventWriteReply>) => {
        if (this.worker !== worker) return;
        if ('ready' in data) {
          this.ready.add(worker);
          send();
          return;
        }
        if ('log' in data) {
          emitStructuredLogEvent({
            ...data.log,
            args: [data.log.message],
            metadata: { ...data.log.metadata, workerKind: 'session-event-writer' },
          });
          return;
        }
        if (data.id !== id || data.epoch !== epoch) return;
        finish(data.error ? new Error(data.error) : undefined, data);
      };
      const send = () => {
        if (sent || settled) return;
        try {
          worker.postMessage({
            id,
            epoch,
            dbPath: this.dbPath,
            sentAt: Date.now(),
            event,
            queryObservability: this.queryObservability,
          } satisfies SessionEventWriteRequest);
          sent = true;
        } catch (error) {
          finish(error instanceof Error ? error : new Error(String(error)));
        }
      };
      if (this.ready.has(worker)) send();
    });
  }
}
