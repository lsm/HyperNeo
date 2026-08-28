import type { MessageContent, ToolResultContent } from '@hyperneo/shared';
import { generateUUID } from '@hyperneo/shared';
import type { SDKUserMessage } from '@hyperneo/shared/sdk';
import type { UUID } from 'crypto';
import type { Logger } from '../logger.ts';
import type {
  MidTurnInterruptDeadline,
  MidTurnInterruptReceipt,
  MidTurnSurvivorsDisposition,
} from './mid-turn-budget-pipeline.ts';
import { runMidTurnBudgetPipeline } from './mid-turn-budget-pipeline.ts';
import { buildQueueTimeoutError, resolveQueueTimeout } from './message-queue-timeout-policy.ts';

function isToolResultContent(content: MessageContent): content is ToolResultContent {
  return content.type === 'tool_result' && 'tool_use_id' in content;
}

function extractParentToolUseId(content: string | MessageContent[]): string | null {
  if (typeof content === 'string') {
    return null;
  }

  const toolResult = content.find(isToolResultContent);
  return toolResult?.tool_use_id ?? null;
}

const MESSAGE_QUEUE_TIMEOUT_MS = 30_000;

const MID_TURN_INTERRUPT_TIMEOUT_MS = 5_000;

interface QueuedMessage {
  id: string;
  content: string | MessageContent[];
  timestamp: string;
  queuedAt: number;
  resolve: (messageId: string) => void;
  reject: (error: Error) => void;
  internal?: boolean;
  timeoutId?: ReturnType<typeof setTimeout>;
  durable?: boolean;
  onResolved?: () => void;
  onRejected?: (error: Error) => void;
}

export interface MidTurnBudgetInterruptOptions {
  sessionId: string;
  providerId: string | undefined;
  budgetKey: number;
  logger: Logger;
  interrupt: () => Promise<MidTurnInterruptReceipt | undefined>;
  cancelAsyncMessage?: (uuid: string) => Promise<boolean>;
  restart: (options?: { beforeStart?: () => void | Promise<void> }) => Promise<void>;
  contextTracker: {
    markCompactionTriggered(budgetKey?: number): void;
    clearCompactionCooldown(): void;
  };
  onResumeArm: () => void;
  onResumeClear: () => void;
  onSurvivorRequeued?: (uuid: string) => void;
}

export interface MidTurnQueueSeam {
  armInterruptCycle(opts: MidTurnBudgetInterruptOptions): void;
  awaitInterruptDeadline(opts: MidTurnBudgetInterruptOptions): Promise<MidTurnInterruptDeadline>;
  standsDownFor(opts: MidTurnBudgetInterruptOptions): boolean;
  processInterruptSurvivors(
    opts: MidTurnBudgetInterruptOptions,
    receipt: MidTurnInterruptReceipt | undefined
  ): Promise<MidTurnSurvivorsDisposition>;
  requeueInterruptSurvivors(opts: MidTurnBudgetInterruptOptions, uuids: string[]): void;
  finishSurvivorTeardownWithRestart(opts: MidTurnBudgetInterruptOptions): Promise<void>;
  enqueueMidTurnCompaction(opts: MidTurnBudgetInterruptOptions, reason: string): void;
  registerLateReceipt(
    opts: MidTurnBudgetInterruptOptions,
    interrupt: {
      promise: Promise<MidTurnInterruptReceipt | undefined>;
      timedOut: boolean;
    } | null
  ): void;
}

export class MessageQueue {
  private queue: QueuedMessage[] = [];
  private waiters: Array<() => void> = [];
  private running: boolean = false;
  private timeoutMs: number = MESSAGE_QUEUE_TIMEOUT_MS;
  private deliveryGate: Promise<void> | null = null;
  private resolveEarlyDeliveryGate: (() => void) | undefined;
  private internalCompactionsAwaitingBoundary: number = 0;
  private internalCompactionIdsAwaitingBoundary: Set<string> = new Set();
  private nonCompactionSentSinceBoundary: boolean = false;
  private recentSentPrompts: Map<string, string | MessageContent[]> = new Map();

  overrideTimeoutMsForTest(ms: number): void {
    this.timeoutMs = ms;
  }

  private claimed: Set<QueuedMessage> = new Set();

  private yielded: Set<QueuedMessage> = new Set();

  private generation: number = 0;

  private clearEpoch: number = 0;

  onMessageYielded?: (messageId: string, sentAt: number) => void;

  onMessageEnqueued?: (messageId: string, queuedAt: number) => void;

  onInternalCompactionsAborted?: () => void;

  private wakeWaiters(): void {
    this.waiters.forEach((waiter) => waiter());
    this.waiters = [];
  }

  noteInternalCompactionSent(message: QueuedMessage): void {
    if (this.isInternalCompaction(message)) {
      this.internalCompactionsAwaitingBoundary += 1;
      this.internalCompactionIdsAwaitingBoundary.add(message.id);
    } else {
      this.nonCompactionSentSinceBoundary = true;
      this.recentSentPrompts.delete(message.id);
      this.recentSentPrompts.set(message.id, message.content);
      if (this.recentSentPrompts.size > 32) {
        const oldest = this.recentSentPrompts.keys().next().value;
        if (oldest !== undefined) {
          this.recentSentPrompts.delete(oldest);
        }
      }
    }
  }

  private isInternalCompaction(message: QueuedMessage): boolean {
    return (
      message.internal === true &&
      typeof message.content === 'string' &&
      message.content === '/compact'
    );
  }

  pruneSentPrompts(): void {
    this.recentSentPrompts.clear();
  }

  getSentPromptContent(messageId: string): string | MessageContent[] | undefined {
    return this.recentSentPrompts.get(messageId);
  }

  forgetSentPrompt(messageId: string): void {
    this.recentSentPrompts.delete(messageId);
  }

  acknowledgeCompactionsAwaitingBoundary(): void {
    if (this.internalCompactionsAwaitingBoundary > 0) {
      this.internalCompactionsAwaitingBoundary -= 1;
      const acknowledged = this.internalCompactionIdsAwaitingBoundary.values().next().value;
      if (acknowledged !== undefined) {
        this.internalCompactionIdsAwaitingBoundary.delete(acknowledged);
      }
    }
    this.removePendingInternalCompactions();
    this.recentSentPrompts.clear();
    this.wakeWaiters();
  }

  removePendingInternalCompactions(): number {
    return this.cancelInternalCompactionEntries(false, false);
  }

  revokeDeliveredCompaction(messageId: string): boolean {
    if (!this.internalCompactionIdsAwaitingBoundary.delete(messageId)) return false;
    this.internalCompactionsAwaitingBoundary = Math.max(
      0,
      this.internalCompactionsAwaitingBoundary - 1
    );
    return true;
  }

  private cancelInternalCompactionEntries(interrupted: boolean, includeYielded: boolean): number {
    let cancelled = 0;
    const settle = (message: QueuedMessage) => {
      if (interrupted) {
        message.reject(new Error('Interrupted by user'));
      } else {
        message.resolve(message.id);
      }
    };
    this.queue = this.queue.filter((message) => {
      if (!this.isInternalCompaction(message)) return true;
      settle(message);
      cancelled += 1;
      return false;
    });
    this.claimed = new Set(
      [...this.claimed].filter((message) => {
        if (!this.isInternalCompaction(message)) return true;
        settle(message);
        cancelled += 1;
        return false;
      })
    );
    if (includeYielded) {
      this.yielded = new Set(
        [...this.yielded].filter((message) => {
          if (!this.isInternalCompaction(message)) return true;
          settle(message);
          cancelled += 1;
          return false;
        })
      );
    }
    return cancelled;
  }

  hasCompactionsAwaitingBoundary(): boolean {
    return this.internalCompactionsAwaitingBoundary > 0;
  }

  clearNonCompactionSentSinceBoundary(): void {
    this.nonCompactionSentSinceBoundary = false;
  }

  hasQueuedInternalCompaction(): boolean {
    return this.queue.some((message) => this.isInternalCompaction(message));
  }

  hasInFlightInternalCompaction(): boolean {
    for (const message of this.claimed) {
      if (this.isInternalCompaction(message)) return true;
    }
    for (const message of this.yielded) {
      if (this.isInternalCompaction(message)) return true;
    }
    return false;
  }

  hasOutstandingInternalCompaction(): boolean {
    if (this.internalCompactionsAwaitingBoundary > 0) return true;
    return this.hasQueuedInternalCompaction() || this.hasInFlightInternalCompaction();
  }

  hasOutstandingNonCompactionMessages(): boolean {
    if (this.nonCompactionSentSinceBoundary) return true;
    if (this.queue.some((message) => !this.isInternalCompaction(message))) return true;
    for (const message of this.claimed) {
      if (!this.isInternalCompaction(message)) return true;
    }
    for (const message of this.yielded) {
      if (!this.isInternalCompaction(message)) return true;
    }
    return false;
  }

  setDeliveryGate(gate: Promise<void>): void {
    const previous = this.deliveryGate;
    const composed = previous
      ? previous.then(
          () => gate,
          () => gate
        )
      : gate;
    this.deliveryGate = composed;
    void composed.then(
      () => {
        if (this.deliveryGate === composed) {
          this.deliveryGate = null;
        }
      },
      () => {
        if (this.deliveryGate === composed) {
          this.deliveryGate = null;
        }
      }
    );
  }

  async enqueue(
    content: string | MessageContent[],
    internal: boolean = false,
    options?: { durable?: boolean; prepend?: boolean }
  ): Promise<string> {
    const messageId = generateUUID();
    await this.enqueueWithId(messageId, content, internal, options);
    return messageId;
  }

  async enqueueWithId(
    messageId: string,
    content: string | MessageContent[],
    internal: boolean = false,
    options?: { durable?: boolean; prepend?: boolean }
  ): Promise<void> {
    return this.admitWithId(messageId, content, internal, options);
  }

  admitWithId(
    messageId: string,
    content: string | MessageContent[],
    internal: boolean = false,
    options?: { durable?: boolean; prepend?: boolean }
  ): Promise<void> {
    return new Promise((resolve, reject) => {
      const queuedMessage: QueuedMessage = {
        id: messageId,
        content,
        timestamp: new Date().toISOString(),
        queuedAt: Date.now(),
        durable: options?.durable,
        resolve: () => {
          if (queuedMessage.timeoutId) {
            clearTimeout(queuedMessage.timeoutId);
          }
          queuedMessage.onResolved?.();
          resolve();
        },
        reject: (error: Error) => {
          if (queuedMessage.timeoutId) {
            clearTimeout(queuedMessage.timeoutId);
          }
          queuedMessage.onRejected?.(error);
          reject(error);
        },
        internal,
      };

      if (!options?.durable) {
        this.armQueueTimeout(queuedMessage);
      }

      if (options?.prepend) {
        this.queue.unshift(queuedMessage);
      } else {
        this.queue.push(queuedMessage);
      }
      this.onMessageEnqueued?.(queuedMessage.id, queuedMessage.queuedAt);

      this.wakeWaiters();
    });
  }

  private armQueueTimeout(queuedMessage: QueuedMessage): void {
    if (queuedMessage.timeoutId) {
      clearTimeout(queuedMessage.timeoutId);
    }
    queuedMessage.timeoutId = setTimeout(() => {
      const index = this.queue.indexOf(queuedMessage);
      const decision = resolveQueueTimeout({
        pending: index !== -1,
        claimed: this.claimed.has(queuedMessage),
        yielded: this.yielded.has(queuedMessage),
        durable: queuedMessage.durable === true,
      });
      if (decision.action === 'none') return;
      if (decision.removeFrom === 'pending') {
        this.queue.splice(index, 1);
      } else if (decision.removeFrom === 'claimed') {
        this.claimed.delete(queuedMessage);
      } else {
        this.yielded.delete(queuedMessage);
      }
      if (decision.action === 'resolve') {
        if (decision.removeFrom === 'yielded') {
          this.noteInternalCompactionSent(queuedMessage);
        }
        queuedMessage.resolve(queuedMessage.id);
        return;
      }
      queuedMessage.reject(
        buildQueueTimeoutError({ messageId: queuedMessage.id, timeoutMs: this.timeoutMs })
      );
    }, this.timeoutMs);
  }

  clear(): void {
    this.clearEpoch += 1;
    const deliveredCompactions = this.internalCompactionsAwaitingBoundary > 0;
    this.internalCompactionsAwaitingBoundary = 0;
    this.internalCompactionIdsAwaitingBoundary.clear();
    this.nonCompactionSentSinceBoundary = false;
    this.recentSentPrompts.clear();
    this.deliveryGate = null;
    for (const msg of this.queue) {
      if (msg.timeoutId) {
        clearTimeout(msg.timeoutId);
      }
      msg.reject(new Error('Interrupted by user'));
    }
    this.queue = [];
    for (const msg of this.claimed) {
      if (msg.timeoutId) {
        clearTimeout(msg.timeoutId);
      }
      msg.reject(new Error('Interrupted by user'));
    }
    this.claimed.clear();
    const yieldedCompactions = [...this.yielded].filter((msg) => this.isInternalCompaction(msg));
    for (const msg of this.yielded) {
      if (msg.timeoutId) {
        clearTimeout(msg.timeoutId);
      }
      msg.resolve(msg.id);
    }
    this.yielded.clear();
    if (deliveredCompactions || yieldedCompactions.length > 0) {
      this.onInternalCompactionsAborted?.();
    }
  }

  getClearEpoch(): number {
    return this.clearEpoch;
  }

  remove(messageId: string): boolean {
    const index = this.queue.findIndex((msg) => msg.id === messageId);
    if (index !== -1) {
      const [msg] = this.queue.splice(index, 1);
      if (msg.timeoutId) clearTimeout(msg.timeoutId);
      msg.resolve(messageId);
      return true;
    }

    const claimed = [...this.claimed].find((msg) => msg.id === messageId);
    if (!claimed) return false;
    this.claimed.delete(claimed);
    if (claimed.timeoutId) clearTimeout(claimed.timeoutId);
    claimed.resolve(messageId);
    return true;
  }

  size(): number {
    return this.queue.length + this.claimed.size + this.yielded.size;
  }

  getPendingOrInFlightContent(messageId: string): string | MessageContent[] | null {
    return this.findPendingOrInFlight(messageId)?.content ?? null;
  }

  hasPendingOrInFlight(messageId: string): boolean {
    return this.getPendingOrInFlightContent(messageId) !== null;
  }

  hasQueuedMessages(): boolean {
    return this.queue.length > 0;
  }

  hasPendingOrClaimed(messageId: string): boolean {
    if (this.queue.some((message) => message.id === messageId)) return true;
    for (const message of this.claimed) {
      if (message.id === messageId) return true;
    }
    return false;
  }

  hasYielded(messageId: string): boolean {
    for (const message of this.yielded) {
      if (message.id === messageId) return true;
    }
    return false;
  }

  acknowledgeYielded(messageId: string): boolean {
    for (const message of this.yielded) {
      if (message.id !== messageId) continue;
      this.yielded.delete(message);
      this.noteInternalCompactionSent(message);
      message.resolve(message.id);
      return true;
    }
    return false;
  }

  requeueYielded(messageId: string): boolean {
    for (const message of this.yielded) {
      if (message.id !== messageId) continue;
      this.yielded.delete(message);
      if (message.timeoutId) {
        clearTimeout(message.timeoutId);
        message.timeoutId = undefined;
      }
      this.queue.unshift(message);
      return true;
    }
    return false;
  }

  waitForPendingOrInFlight(
    messageId: string
  ): { acknowledgment: Promise<void>; content: string | MessageContent[] } | null {
    const message = this.findPendingOrInFlight(messageId);
    if (!message) return null;
    return {
      content: message.content,
      acknowledgment: new Promise<void>((resolve, reject) => {
        const previousResolved = message.onResolved;
        const previousRejected = message.onRejected;
        message.onResolved = () => {
          previousResolved?.();
          resolve();
        };
        message.onRejected = (error) => {
          previousRejected?.(error);
          reject(error);
        };
      }),
    };
  }

  private findPendingOrInFlight(messageId: string): QueuedMessage | null {
    const queued = this.queue.find((message) => message.id === messageId);
    if (queued) return queued;
    for (const message of this.claimed) {
      if (message.id === messageId) return message;
    }
    for (const message of this.yielded) {
      if (message.id === messageId) return message;
    }
    return null;
  }

  start(): void {
    this.running = true;
    this.generation++;
    this.wakeWaiters();
  }

  getGeneration(): number {
    return this.generation;
  }

  stop(): void {
    this.running = false;
    const deliveredCompactions = this.internalCompactionsAwaitingBoundary > 0;
    this.internalCompactionsAwaitingBoundary = 0;
    this.internalCompactionIdsAwaitingBoundary.clear();
    this.nonCompactionSentSinceBoundary = false;
    this.cancelInternalCompactionEntries(true, true);
    this.deliveryGate = null;
    this.wakeWaiters();
    if (deliveredCompactions) {
      this.onInternalCompactionsAborted?.();
    }
  }

  isRunning(): boolean {
    return this.running;
  }

  async *messageGenerator(
    sessionId: string,
    options?: { suppressPreYieldCallback?: boolean }
  ): AsyncGenerator<{ message: SDKUserMessage; onSent: () => void }> {
    const myGeneration = this.generation;

    while (this.running) {
      if (this.generation !== myGeneration) {
        break;
      }

      const queuedMessage = await this.waitForNextMessage();

      if (!queuedMessage) {
        break;
      }

      if (!this.claimed.has(queuedMessage)) {
        continue;
      }

      if (this.generation !== myGeneration) {
        this.claimed.delete(queuedMessage);
        this.queue.unshift(queuedMessage);
        break;
      }

      const parentToolUseId = extractParentToolUseId(queuedMessage.content);

      const sdkUserMessage: SDKUserMessage & { internal?: boolean } = {
        type: 'user' as const,
        uuid: queuedMessage.id as UUID,
        session_id: sessionId,
        parent_tool_use_id: parentToolUseId,
        message: {
          role: 'user' as const,
          content:
            typeof queuedMessage.content === 'string'
              ? [{ type: 'text' as const, text: queuedMessage.content }]
              : queuedMessage.content,
        },
        internal: queuedMessage.internal,
      };

      try {
        if (
          !options?.suppressPreYieldCallback &&
          !queuedMessage.internal &&
          this.onMessageYielded
        ) {
          this.onMessageYielded(queuedMessage.id, Date.now());
        }
      } catch (error) {
        this.claimed.delete(queuedMessage);
        queuedMessage.reject(error instanceof Error ? error : new Error(String(error)));
        throw error;
      }

      this.claimed.delete(queuedMessage);
      this.yielded.add(queuedMessage);
      if (!queuedMessage.timeoutId) {
        this.armQueueTimeout(queuedMessage);
      }
      yield {
        message: sdkUserMessage,
        onSent: () => {
          if (this.yielded.delete(queuedMessage)) {
            this.noteInternalCompactionSent(queuedMessage);
            queuedMessage.resolve(queuedMessage.id);
          }
        },
      };
    }
  }

  private gatedBypassIndex(): number {
    const toolResultIndex = this.queue.findIndex(
      (message) =>
        typeof message.content !== 'string' &&
        message.content.some((block) => isToolResultContent(block))
    );
    if (toolResultIndex !== -1) return toolResultIndex;
    return this.queue.findIndex((message) => this.isInternalCompaction(message));
  }

  private async waitForNextMessage(): Promise<QueuedMessage | null> {
    while (this.running) {
      while (this.queue.length === 0) {
        if (!this.running) return null;
        await new Promise<void>((resolve) => {
          this.waiters.push(resolve);
        });
        if (!this.running) return null;
      }

      const bypassIndex =
        this.deliveryGate || this.hasOutstandingInternalCompaction() ? this.gatedBypassIndex() : 0;

      if (bypassIndex === -1) {
        await Promise.race([
          ...(this.deliveryGate ? [this.deliveryGate.catch(() => {})] : []),
          new Promise<void>((resolve) => {
            this.waiters.push(resolve);
          }),
        ]);
        if (!this.running) return null;
        continue;
      }

      if (!this.running) return null;

      const message = this.queue.splice(bypassIndex, 1)[0];
      if (message) {
        this.claimed.add(message);
        return message;
      }
    }
    return null;
  }

  armInterruptCycle(opts: MidTurnBudgetInterruptOptions): void {
    opts.onResumeArm();
    this.clearNonCompactionSentSinceBoundary();
    opts.logger.info(
      `Daemon mid-turn context-budget interrupt for session ${opts.sessionId} ` +
        `(provider=${opts.providerId}, budget=${opts.budgetKey} tokens)`
    );
    const earlyDeliveryGate = new Promise<void>((resolve) => {
      this.resolveEarlyDeliveryGate = resolve;
    });
    this.setDeliveryGate(earlyDeliveryGate);
  }

  releaseEarlyDeliveryGate(): void {
    this.resolveEarlyDeliveryGate?.();
    this.resolveEarlyDeliveryGate = undefined;
  }

  async awaitInterruptDeadline(
    opts: MidTurnBudgetInterruptOptions
  ): Promise<MidTurnInterruptDeadline> {
    const interruptPromise = Promise.resolve().then(() => opts.interrupt());
    let receipt: MidTurnInterruptReceipt | undefined;
    let timedOut = false;
    let hardFailed = false;
    let interruptTimeoutTimer: ReturnType<typeof setTimeout> | undefined;
    try {
      receipt = (await Promise.race([
        interruptPromise,
        new Promise<never>((_, reject) => {
          interruptTimeoutTimer = setTimeout(() => {
            timedOut = true;
            reject(new Error('mid-turn context-budget interrupt not acknowledged in time'));
          }, MID_TURN_INTERRUPT_TIMEOUT_MS);
          if (typeof interruptTimeoutTimer.unref === 'function') {
            interruptTimeoutTimer.unref();
          }
        }),
      ])) as MidTurnInterruptReceipt | undefined;
    } catch (error) {
      if (timedOut) {
        opts.logger.warn(
          `mid-turn context-budget interrupt for session ${opts.sessionId} is slow to ` +
            `acknowledge; restarting the query to recover`
        );
        this.clearNonCompactionSentSinceBoundary();
      } else {
        hardFailed = true;
        opts.onResumeClear();
        opts.logger.warn(
          `mid-turn context-budget interrupt failed for session ${opts.sessionId}:`,
          error
        );
      }
    } finally {
      if (interruptTimeoutTimer) {
        clearTimeout(interruptTimeoutTimer);
      }
    }
    return { promise: interruptPromise, timedOut, hardFailed, receipt };
  }

  standsDownFor(_opts: MidTurnBudgetInterruptOptions): boolean {
    return !this.isRunning();
  }

  async runMidTurnBudgetInterrupt(opts: MidTurnBudgetInterruptOptions): Promise<void> {
    this.armInterruptCycle(opts);
    try {
      await runMidTurnBudgetPipeline({
        opts,
        queue: this,
        preArmed: true,
        checkEligibility: undefined,
        refreshUsage: undefined,
        decideCompaction: undefined,
      });
    } finally {
      this.releaseEarlyDeliveryGate();
    }
  }

  registerLateReceipt(
    opts: MidTurnBudgetInterruptOptions,
    interrupt: {
      promise: Promise<MidTurnInterruptReceipt | undefined>;
      timedOut: boolean;
    } | null
  ): void {
    if (!interrupt) return;
    void interrupt.promise.then(
      (lateReceipt) => {
        if (!interrupt.timedOut || !lateReceipt) return;
        void this.processLateInterruptReceipt(opts, lateReceipt).catch((error) => {
          opts.logger.warn(
            `late survivor cancellation after a slow mid-turn interrupt failed for ` +
              `session ${opts.sessionId}:`,
            error
          );
        });
      },
      (error) => {
        if (interrupt.timedOut) return;
        opts.logger.warn(
          `late mid-turn context-budget interrupt failure for session ${opts.sessionId}:`,
          error
        );
        opts.onResumeClear();
      }
    );
  }

  private async processLateInterruptReceipt(
    opts: MidTurnBudgetInterruptOptions,
    receipt: MidTurnInterruptReceipt
  ): Promise<void> {
    if (this.standsDownFor(opts)) {
      opts.onResumeClear();
      return;
    }
    let resolveLateGate: (() => void) | undefined;
    const lateGate = new Promise<void>((resolve) => {
      resolveLateGate = resolve;
    });
    this.setDeliveryGate(lateGate);
    try {
      const survivors = await this.processInterruptSurvivors(opts, receipt);
      this.requeueInterruptSurvivors(opts, survivors.toRequeue);
    } finally {
      resolveLateGate?.();
    }
  }

  async processInterruptSurvivors(
    opts: MidTurnBudgetInterruptOptions,
    receipt: MidTurnInterruptReceipt | undefined
  ): Promise<MidTurnSurvivorsDisposition> {
    const survivors = receipt?.still_queued ?? [];
    if (survivors.length === 0) return { toRequeue: [], needsRestart: false };
    if (typeof opts.cancelAsyncMessage !== 'function') {
      return { toRequeue: [...survivors], needsRestart: true };
    }
    const toRequeue: string[] = [];
    for (let index = 0; index < survivors.length; index++) {
      const uuid = survivors[index];
      let cancelFailed = false;
      let cancelled = false;
      try {
        cancelled = await Promise.race([
          Promise.resolve(opts.cancelAsyncMessage(uuid)),
          new Promise<boolean>((resolve) => {
            const timer = setTimeout(() => resolve(false), MID_TURN_INTERRUPT_TIMEOUT_MS);
            if (typeof timer.unref === 'function') {
              timer.unref();
            }
          }),
        ]);
      } catch (error) {
        cancelFailed = true;
        opts.logger.warn(
          `cancel_async_message failed for ${uuid} on session ${opts.sessionId}:`,
          error
        );
      }
      if (!cancelled) {
        if (!cancelFailed) {
          opts.logger.warn(
            `cancel_async_message did not confirm cancellation of ${uuid} for ` +
              `session ${opts.sessionId}; restarting the query so the survivor cannot ` +
              `run ahead of the pending compaction`
          );
        }
        toRequeue.push(...survivors.slice(index));
        return { toRequeue, needsRestart: true };
      }
      toRequeue.push(uuid);
    }
    return { toRequeue, needsRestart: false };
  }

  requeueInterruptSurvivors(opts: MidTurnBudgetInterruptOptions, uuids: string[]): void {
    for (let index = uuids.length - 1; index >= 0; index--) {
      this.requeueInterruptSurvivor(opts, uuids[index]);
    }
  }

  private requeueInterruptSurvivor(opts: MidTurnBudgetInterruptOptions, uuid: string): void {
    if (this.revokeDeliveredCompaction(uuid)) {
      opts.logger.info(
        `cancelled still-queued internal compaction ${uuid} for session ` +
          `${opts.sessionId}; a replacement compaction is enqueued after survivor ` +
          `processing`
      );
      return;
    }
    const content = this.getSentPromptContent(uuid);
    if (content === undefined) {
      opts.logger.warn(
        `cancelled survivor ${uuid} for session ${opts.sessionId} has no recoverable ` +
          `content in the sent-prompt cache; it cannot be requeued`
      );
      return;
    }
    this.forgetSentPrompt(uuid);
    void this.enqueueWithId(uuid, content, false, { durable: true, prepend: true }).catch(
      (error) => {
        opts.logger.warn(
          `requeue of cancelled survivor ${uuid} failed for session ${opts.sessionId}:`,
          error
        );
      }
    );
    try {
      opts.onSurvivorRequeued?.(uuid);
    } catch (error) {
      opts.logger.warn(
        `retryable-state update for requeued survivor ${uuid} failed for session ` +
          `${opts.sessionId}:`,
        error
      );
    }
    opts.logger.info(
      `requeued cancelled survivor ${uuid} for session ${opts.sessionId} ` +
        `to run after the pending compaction`
    );
  }

  async finishSurvivorTeardownWithRestart(opts: MidTurnBudgetInterruptOptions): Promise<void> {
    let resolveDeliveryGate: (() => void) | undefined;
    const deliveryGate = new Promise<void>((resolve) => {
      resolveDeliveryGate = resolve;
    });
    const beforeStart = () => {
      this.setDeliveryGate(deliveryGate);
      this.enqueueMidTurnCompaction(opts, 'mid-turn-restart');
    };
    const restart = opts.restart({ beforeStart }).catch((error) => {
      opts.logger.warn(
        `query restart after unconfirmed survivor cancellation failed for ` +
          `session ${opts.sessionId}:`,
        error
      );
      if (!this.hasOutstandingInternalCompaction()) {
        opts.contextTracker.clearCompactionCooldown();
        opts.onResumeClear();
      } else {
        opts.logger.info(
          `durable compaction remains queued for session ${opts.sessionId}; the pending ` +
            `resume stays armed until its boundary on the next query`
        );
      }
    });
    await Promise.race([
      restart,
      new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, MID_TURN_INTERRUPT_TIMEOUT_MS);
        if (typeof timer.unref === 'function') {
          timer.unref();
        }
      }),
    ]);
    resolveDeliveryGate?.();
  }

  enqueueMidTurnCompaction(opts: MidTurnBudgetInterruptOptions, reason: string): void {
    if (this.hasOutstandingInternalCompaction()) return;
    opts.contextTracker.markCompactionTriggered(opts.budgetKey);
    this.clearNonCompactionSentSinceBoundary();
    opts.logger.info(
      `Daemon context-budget compaction for session ${opts.sessionId} ` +
        `(provider=${opts.providerId}, reason=${reason}, ` +
        `budget=${opts.budgetKey} tokens)`
    );
    void this.enqueue('/compact', true, { durable: true, prepend: true }).catch((error) => {
      if (this.hasOutstandingInternalCompaction()) return;
      opts.logger.warn(`compaction enqueue failed for session ${opts.sessionId}:`, error);
      opts.contextTracker.clearCompactionCooldown();
      opts.onResumeClear();
    });
  }
}
