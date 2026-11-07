import { generateUUID } from '@hyperneo/shared';
import type { SDKMessage, SDKUserMessage, RewindFilesResult } from '@hyperneo/shared/sdk';
import type { QueryLike } from '../agent/query-like.ts';
import { isDefiniteOapRefusal, type OapHubRequestError } from './oap-hub-client.ts';
import { mapUserInputRequest } from './oap-permission-map.ts';
import { initialOapTranslatorState, translateOapEvent } from './oap-sdk-translator.ts';
export { createOapQueryHub } from './oap-query-hub.ts';
export { createOapRuntime } from './oap-runtime.ts';

type OapEvent = { type: string; [key: string]: unknown };

export type OapQueryHub = {
  submit(
    sessionId: string,
    message: SDKUserMessage,
    owner?: symbol,
    isLive?: () => boolean
  ): Promise<{ runId: string }>;
  events(sessionId: string, runId: string, signal: AbortSignal): AsyncIterable<OapEvent>;
  cancel(sessionId: string, runId: string): Promise<void>;
  release?(owner?: symbol): void;
};

type OapQueryTranslator = {
  beginRun?(): void;
  translate(event: OapEvent): SDKMessage[];
  flush?(): SDKMessage[];
};

type OapQueryOptions = {
  sessionId: string;
  prompt: AsyncIterable<SDKUserMessage>;
  hub: OapQueryHub;
  translator: OapQueryTranslator;
  isLive?: () => boolean;
  maySettleInterrupted?: () => boolean;
  onSubmitted?: (message: SDKUserMessage) => Promise<void>;
  onAccepted?: (message: SDKUserMessage, runId: string) => Promise<void>;
  onRefused?: (message: SDKUserMessage, error: OapHubRequestError) => Promise<void>;
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
  private readonly isLive: () => boolean;
  private readonly maySettleInterrupted: () => boolean;
  private readonly onSubmitted?: OapQueryOptions['onSubmitted'];
  private readonly onAccepted?: OapQueryOptions['onAccepted'];
  private readonly onRefused?: OapQueryOptions['onRefused'];
  private activeRun: string | undefined;
  private pendingRun: Promise<string> | undefined;
  private cancelPromise: Promise<void> | undefined;
  private runSettled: Promise<void> | undefined;
  private interrupted = false;
  private closed = false;
  private started = false;
  private readonly closeSignal = new AbortController();
  private readonly owner = Symbol();

  constructor(options: OapQueryOptions) {
    this.sessionId = options.sessionId;
    this.prompt = options.prompt;
    this.hub = options.hub;
    this.translator = options.translator;
    this.isLive = options.isLive ?? (() => true);
    this.maySettleInterrupted = options.maySettleInterrupted ?? (() => false);
    this.onSubmitted = options.onSubmitted;
    this.onAccepted = options.onAccepted;
    this.onRefused = options.onRefused;
  }

  async *[Symbol.asyncIterator](): AsyncGenerator<SDKMessage> {
    if (this.started) throw new Error('OAP query can only be iterated once');
    this.started = true;
    for await (const message of untilClosed(this.prompt, this.closeSignal.signal)) {
      if (this.closed || this.interrupted || !this.isLive()) return;
      await this.onSubmitted?.(message);
      if (this.closed || this.interrupted || !this.isLive()) return;
      let settle!: () => void;
      const settled = new Promise<void>((resolve) => {
        settle = resolve;
      });
      this.runSettled = settled;
      const finish = () => {
        settle();
        if (this.runSettled === settled) this.runSettled = undefined;
      };
      this.pendingRun = this.hub
        .submit(
          this.sessionId,
          message,
          this.owner,
          () => !this.closed && !this.interrupted && this.isLive()
        )
        .then(({ runId }) => {
          this.activeRun = runId;
          return runId;
        })
        .catch(async (error: unknown) => {
          finish();
          if (isDefiniteOapRefusal(error) && this.isLive()) {
            await this.onRefused?.(message, error);
          }
          throw error;
        });
      const runId = await this.pendingRun;
      this.pendingRun = undefined;
      try {
        this.translator.beginRun?.();
        if (this.closed || this.interrupted || !this.isLive()) {
          await this.cancelActive();
          if (this.closed || (!this.isLive() && !this.canSettleInterrupted())) {
            finish();
            return;
          }
        }
        if (this.isLive()) await this.onAccepted?.(message, runId);
      } catch (error) {
        try {
          await this.cancelActive();
        } finally {
          finish();
        }
        throw error;
      }
      if (this.closed || (!this.isLive() && !this.canSettleInterrupted())) {
        try {
          await this.cancelActive();
        } finally {
          finish();
        }
        return;
      }
      let terminal = false;
      try {
        for await (const event of untilClosed(
          this.hub.events(this.sessionId, runId, this.closeSignal.signal),
          this.closeSignal.signal
        )) {
          if (!this.isLive() && !this.canSettleInterrupted()) {
            await this.cancelActive();
            return;
          }
          if (this.interrupted && !isTerminal(event)) continue;
          const unsupported = unsupportedInteraction(event);
          if (unsupported) {
            try {
              await this.cancelActive();
            } catch (cause) {
              throw new Error(`OAP ${unsupported}; cancellation failed`, { cause });
            }
            throw new Error(`OAP ${unsupported}; run cancelled`);
          }
          let translated: SDKMessage[];
          try {
            translated = this.translator.translate(event);
          } catch (error) {
            try {
              await this.cancelActive();
            } catch (cause) {
              throw new Error(`${String(error)}; cancellation failed`, { cause });
            }
            throw error;
          }
          if (isTerminal(event)) {
            terminal = true;
            this.activeRun = undefined;
          }
          for (const message of translated) {
            if (!this.isLive() && !this.canSettleInterrupted()) return;
            yield message;
          }
          if (terminal) break;
        }
        if (!terminal && !this.closed)
          throw new Error('OAP event stream ended before run terminal');
      } catch (error) {
        if (!this.closed && (this.isLive() || this.canSettleInterrupted())) {
          for (const message of this.translator.flush?.() ?? []) {
            if (!this.isLive() && !this.canSettleInterrupted()) break;
            yield message;
          }
        }
        throw error;
      } finally {
        this.activeRun = undefined;
        finish();
      }
      if (this.closed || this.interrupted) return;
    }
  }

  prepareInterrupt(): void {
    this.interrupted = true;
  }

  wasInterrupted(): boolean {
    return this.interrupted;
  }

  async interrupt(): Promise<undefined> {
    if (this.closed) return undefined;
    this.prepareInterrupt();
    if (this.pendingRun) await this.pendingRun;
    await this.cancelActive();
    if (this.runSettled) await this.runSettled;
    return undefined;
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.closeSignal.abort();
    this.hub.release?.(this.owner);
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

  private canSettleInterrupted(): boolean {
    return this.interrupted && this.maySettleInterrupted();
  }
}

export function createOapQuery(options: Omit<OapQueryOptions, 'translator'>): OapQuery {
  let state = initialOapTranslatorState(options.sessionId);
  let runScope = '';
  return new OapQuery({
    ...options,
    translator: {
      beginRun: () => {
        state = initialOapTranslatorState(options.sessionId);
        runScope = generateUUID();
      },
      flush: () => {
        const result = translateOapEvent(state, {
          type: 'stream.flush',
          id: runScope,
          payload: {},
        });
        state = result.state;
        return result.messages;
      },
      translate: (event) => {
        if (
          typeof event.id !== 'string' ||
          !event.id ||
          !event.payload ||
          typeof event.payload !== 'object' ||
          Array.isArray(event.payload)
        ) {
          throw new Error('Invalid OAP event');
        }
        const result = translateOapEvent(state, {
          type: event.type,
          id: `${runScope}:${event.id}`,
          payload: event.payload as Record<string, unknown>,
        });
        state = result.state;
        return result.messages;
      },
    },
  });
}
