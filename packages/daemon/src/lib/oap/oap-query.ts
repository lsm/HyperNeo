import type { SDKMessage, SDKUserMessage, RewindFilesResult } from '@hyperneo/shared/sdk';
import type { QueryLike } from '../agent/query-like.ts';
import { mapUserInputRequest } from './oap-permission-map.ts';

type OapEvent = { type: string; [key: string]: unknown };

type OapQueryHub = {
  submit(sessionId: string, message: SDKUserMessage): Promise<{ runId: string }>;
  events(sessionId: string, runId: string, signal: AbortSignal): AsyncIterable<OapEvent>;
  cancel(sessionId: string, runId: string): Promise<void>;
};

type OapQueryTranslator = {
  translate(event: OapEvent): SDKMessage[];
};

type OapQueryOptions = {
  sessionId: string;
  prompt: AsyncIterable<SDKUserMessage>;
  hub: OapQueryHub;
  translator: OapQueryTranslator;
};

function isTerminal(event: OapEvent): boolean {
  return (
    event.type === 'run.completed' || event.type === 'run.failed' || event.type === 'run.cancelled'
  );
}

function unsupportedInteraction(event: OapEvent): string | undefined {
  if (event.type === 'action.permission.requested') return 'permission requests are not supported';
  if (event.type !== 'user.input.requested') return undefined;
  try {
    const mapped = mapUserInputRequest(event.payload);
    return 'kind' in mapped ? mapped.reason : 'user questions are not supported';
  } catch {
    return 'invalid user input request is not supported';
  }
}

async function* untilClosed<T>(source: AsyncIterable<T>, signal: AbortSignal): AsyncGenerator<T> {
  const iterator = source[Symbol.asyncIterator]();
  let abort!: () => void;
  const closed = new Promise<undefined>((resolve) => {
    abort = () => resolve(undefined);
    signal.addEventListener('abort', abort, { once: true });
    if (signal.aborted) abort();
  });
  try {
    while (!signal.aborted) {
      const next = await Promise.race([iterator.next(), closed]);
      if (!next || next.done) return;
      yield next.value;
    }
  } finally {
    signal.removeEventListener('abort', abort);
    if (iterator.return)
      void Promise.resolve()
        .then(() => iterator.return?.())
        .catch(() => {});
  }
}

export class OapQuery implements QueryLike {
  readonly sessionId: string;
  private readonly prompt: AsyncIterable<SDKUserMessage>;
  private readonly hub: OapQueryHub;
  private readonly translator: OapQueryTranslator;
  private activeRun: string | undefined;
  private pendingRun: Promise<string> | undefined;
  private cancelPromise: Promise<void> | undefined;
  private interrupted = false;
  private closed = false;
  private started = false;
  private readonly closeSignal = new AbortController();

  constructor(options: OapQueryOptions) {
    this.sessionId = options.sessionId;
    this.prompt = options.prompt;
    this.hub = options.hub;
    this.translator = options.translator;
  }

  async *[Symbol.asyncIterator](): AsyncGenerator<SDKMessage> {
    if (this.started) throw new Error('OAP query can only be iterated once');
    this.started = true;
    for await (const message of untilClosed(this.prompt, this.closeSignal.signal)) {
      if (this.closed || this.interrupted) return;
      this.pendingRun = this.hub.submit(this.sessionId, message).then(({ runId }) => {
        this.activeRun = runId;
        return runId;
      });
      const runId = await this.pendingRun;
      this.pendingRun = undefined;
      if (this.closed || this.interrupted) {
        await this.cancelActive();
        if (this.closed) return;
      }
      let terminal = false;
      try {
        for await (const event of untilClosed(
          this.hub.events(this.sessionId, runId, this.closeSignal.signal),
          this.closeSignal.signal
        )) {
          const unsupported = unsupportedInteraction(event);
          if (unsupported) {
            try {
              await this.cancelActive();
            } catch (cause) {
              throw new Error(`OAP ${unsupported}; cancellation failed`, { cause });
            }
            throw new Error(`OAP ${unsupported}; run cancelled`);
          }
          for (const translated of this.translator.translate(event)) yield translated;
          if (isTerminal(event)) {
            terminal = true;
            break;
          }
        }
      } finally {
        this.activeRun = undefined;
      }
      if (!terminal && !this.closed) throw new Error('OAP event stream ended before run terminal');
      if (this.closed || this.interrupted) return;
    }
  }

  async interrupt(): Promise<undefined> {
    if (this.closed) return undefined;
    this.interrupted = true;
    if (this.pendingRun) await this.pendingRun;
    await this.cancelActive();
    return undefined;
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.closeSignal.abort();
    void this.cancelActive().catch(() => {});
  }

  rewindFiles(): Promise<RewindFilesResult> {
    return Promise.resolve({ canRewind: false, error: 'OAP sessions do not support file rewind.' });
  }

  private cancelActive(): Promise<void> {
    if (!this.activeRun) return Promise.resolve();
    this.cancelPromise ??= this.hub.cancel(this.sessionId, this.activeRun);
    return this.cancelPromise;
  }
}
