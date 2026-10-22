import type { MessageFeedArgs } from './sdk-message-feed-read.ts';
import type { LiveQueryEvaluation } from './live-query.ts';
import { capSdkMessage } from '../lib/rpc-handlers/message-output-cap.ts';
import { emitStructuredLogEvent } from '../lib/logger.ts';
import type { StructuredLogEvent } from '@hyperneo/shared';
import type { SDKMessageRepository, SendStatus } from './repositories/sdk-message-repository.ts';
import type { SQLiteQueryObservabilityOptions } from './sqlite-query-observability.ts';
import type { WorkChatKind, WorkChatMatch } from './work-chat-search.ts';

export type SDKStatusArgs = { sessionId: string; status: SendStatus; limit: number };
export type SDKStatusPage = {
  messages: { dbId: string; uuid: string; timestamp: number; status: SendStatus; text: string }[];
  total: number;
};
export type SDKPageParams = {
  limit?: number;
  before?: number;
  since?: number;
  beforeRowid?: number;
  sinceRowid?: number;
};
export type SDKPageArgs = { sessionId: string; page: SDKPageParams };
export type SDKMessagePage = {
  sdkMessages: ReturnType<SDKMessageRepository['getSDKMessages']>['messages'];
  hasMore: boolean;
  backgroundTaskMessages: ReturnType<SDKMessageRepository['getBackgroundTaskMessages']>;
};
export type WorkSearchArgs = {
  query: string;
  limit: number;
  semantic?: { vector: number[]; model: string };
  kinds?: readonly WorkChatKind[];
};
type SDKReadArgs = SDKStatusArgs | SDKPageArgs | WorkSearchArgs | MessageFeedArgs;
export type SDKReadResult = SDKStatusPage | SDKMessagePage | WorkChatMatch[] | LiveQueryEvaluation;
export type SDKStatusRequest = {
  id: number;
  epoch: number;
  dbPath: string;
  sentAt: number;
  args: SDKReadArgs | null;
  queryObservability?: SQLiteQueryObservabilityOptions;
};
export type SDKStatusReply =
  | { log: StructuredLogEvent }
  | {
      id: number;
      epoch: number;
      result?: SDKReadResult | null;
      error?: string;
      finishedAt: number;
      workerMs: number;
      queueMs: number;
    };

function extractMessageText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .map((block) => {
      if (typeof block !== 'object' || block === null) return '';
      const record = block as Record<string, unknown>;
      return record.type === 'text' && typeof record.text === 'string' ? record.text : '';
    })
    .filter(Boolean)
    .join('\n');
}

export function projectSDKStatusPage(
  page: ReturnType<SDKMessageRepository['getUserMessagesByStatus']>,
  status: SendStatus
): SDKStatusPage {
  return {
    total: page.total,
    messages: page.messages.map((message) => ({
      dbId: message.dbId,
      uuid: message.uuid ?? '',
      timestamp: message.timestamp,
      status,
      text: extractMessageText(message.message.content),
    })),
  };
}

export function projectSDKStatusMessage(
  message: ReturnType<SDKMessageRepository['getUserMessagesByStatus']>['messages'][number]
) {
  return {
    ...message,
    message: { ...message.message, content: extractMessageText(message.message.content) },
  };
}

export function readSDKMessagePage(
  repository: SDKMessageRepository,
  { sessionId, page }: SDKPageArgs
): SDKMessagePage {
  const selected = repository.getSDKMessages(
    sessionId,
    page.limit,
    page.before,
    page.since,
    page.beforeRowid,
    page.sinceRowid,
    capSdkMessage
  );
  return {
    sdkMessages: selected.messages,
    hasMore: selected.hasMore,
    backgroundTaskMessages: repository.getBackgroundTaskMessages(sessionId).map(capSdkMessage),
  };
}

export function sdkReadLogMetadata(metadata: Record<string, unknown>, workerOperation: string) {
  return {
    ...metadata,
    ...(metadata.event === 'summary' ? {} : { workerOperation }),
  };
}

export class SDKStatusReader {
  private worker: Worker | null = null;
  private queue: Promise<unknown> = Promise.resolve();
  private waiting = 0;
  private searches = 0;
  private running = false;
  private pending: { search: boolean; run: () => Promise<void> }[] = [];
  private epoch = 0;
  private id = 0;
  private closing: Promise<void> | null = null;
  private rejectActive: ((error: Error) => void) | null = null;

  constructor(
    private readonly dbPath: string,
    private readonly createWorker = () =>
      new Worker(new URL('./sdk-status-worker.ts', import.meta.url).href, { type: 'module' }),
    private readonly timeoutMs = 30_000,
    private readonly queryObservability?: SQLiteQueryObservabilityOptions
  ) {}

  read(args: SDKStatusArgs): Promise<SDKStatusPage> {
    return this.enqueue(args) as Promise<SDKStatusPage>;
  }

  readMessages(args: SDKPageArgs): Promise<SDKMessagePage> {
    return this.enqueue(args) as Promise<SDKMessagePage>;
  }

  readWorkChats(args: WorkSearchArgs): Promise<WorkChatMatch[]> {
    return this.enqueue(args) as Promise<WorkChatMatch[]>;
  }

  readMessageFeed(args: MessageFeedArgs): Promise<LiveQueryEvaluation> {
    return this.enqueue(args) as Promise<LiveQueryEvaluation>;
  }

  private enqueue(args: SDKReadArgs): Promise<SDKReadResult> {
    if (this.closing) return Promise.reject(new Error('SDK reader closed'));
    const search = 'query' in args;
    if ((search ? this.searches : this.waiting) >= (search ? 3 : 16))
      return Promise.reject(new Error('SDK reader queue full'));
    const epoch = this.epoch,
      queuedAt = performance.now();
    if (search) this.searches++;
    else this.waiting++;
    return new Promise((resolve, reject) => {
      this.pending.push({
        search,
        run: async () => {
          try {
            if (epoch !== this.epoch) throw new Error('SDK reader generation failed');
            resolve((await this.exchange(args, queuedAt)) as SDKReadResult);
          } catch (error) {
            reject(error);
          } finally {
            if (search) this.searches--;
            else this.waiting--;
          }
        },
      });
      if (!this.running) {
        this.running = true;
        this.queue = this.drain();
      }
    });
  }

  private async drain() {
    while (this.pending.length) {
      const next = this.pending.findIndex((entry) => !entry.search);
      await this.pending.splice(Math.max(0, next), 1)[0].run();
    }
    this.running = false;
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

  private exchange(args: SDKReadArgs | null, queuedAt: number): Promise<SDKReadResult | null> {
    if (this.dbPath === ':memory:')
      return Promise.reject(new Error('SDK reader needs a file-backed DB'));
    const worker = (this.worker ??= this.createWorker());
    const id = ++this.id,
      epoch = this.epoch,
      started = performance.now();
    return new Promise((resolve, reject) => {
      let settled = false;
      const finish = (
        error?: Error,
        result?: SDKReadResult | null,
        timing?: { workerMs: number; queueMs: number; finishedAt: number }
      ) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        this.rejectActive = null;
        const totalMs = performance.now() - queuedAt;
        emitStructuredLogEvent({
          level: error || totalMs >= 250 ? 'warn' : 'info',
          source: 'logger',
          module: 'hyperneo:daemon:sqlite.worker',
          args: ['sqlite.worker.request'],
          metadata: {
            operation: args
              ? 'query' in args
                ? 'work-search'
                : 'feed' in args
                  ? 'message-feed'
                  : 'page' in args
                    ? 'sdk-page'
                    : 'sdk-status'
              : 'close',
            id,
            epoch,
            outcome: error ? 'error' : 'ok',
            totalMs,
            queueMs: started - queuedAt,
            workerMs: timing?.workerMs ?? null,
            workerQueueMs: timing?.queueMs ?? null,
            replyMs: timing ? Date.now() - timing.finishedAt : null,
          },
        });
        if (error) {
          this.worker = null;
          this.epoch++;
          worker.terminate();
          reject(error);
        } else resolve(result ?? null);
      };
      this.rejectActive = (error) => finish(error);
      const timer = setTimeout(() => finish(new Error('SDK reader timeout')), this.timeoutMs);
      worker.onerror = (event) => {
        event.preventDefault?.();
        if (this.worker !== worker) return;
        if (this.rejectActive) this.rejectActive(new Error(`SDK reader failed: ${event.message}`));
        else {
          this.worker = null;
          this.epoch++;
          worker.terminate();
        }
      };
      worker.onmessage = ({ data }: MessageEvent<SDKStatusReply>) => {
        if (this.worker !== worker) return;
        if ('log' in data) {
          emitStructuredLogEvent({
            ...data.log,
            args: [data.log.message],
            metadata: { ...data.log.metadata, workerKind: 'sdk-status' },
          });
          return;
        }
        if (data.id !== id || data.epoch !== epoch) return;
        finish(data.error ? new Error(data.error) : undefined, data.result, data);
      };
      try {
        worker.postMessage({
          id,
          epoch,
          dbPath: this.dbPath,
          sentAt: Date.now(),
          args,
          queryObservability: this.queryObservability,
        } satisfies SDKStatusRequest);
      } catch (error) {
        finish(error instanceof Error ? error : new Error(String(error)));
      }
    });
  }
}
