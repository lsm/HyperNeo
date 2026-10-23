import type { MessageContent, ToolResultContent } from '@hyperneo/shared';
import { generateUUID } from '@hyperneo/shared';
import type { SDKUserMessage } from '@hyperneo/shared/sdk';
import type { UUID } from 'crypto';
import { buildQueueTimeoutError, resolveQueueTimeout } from './message-queue-timeout-policy.ts';
import {
  evictedYieldKey,
  ownsLastYield as ownsLastYieldGate,
  ownsYieldedGeneration as ownsYieldedGenerationGate,
  type YieldedRowSnapshot,
  type YieldGenerationStamp,
} from './yield-ownership-gates.ts';

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

function isUserCompactCommand(content: string | MessageContent[]): boolean {
  const text =
    typeof content === 'string'
      ? content
      : (content.find((block) => block.type === 'text')?.text ?? '');
  if (typeof text !== 'string' || text.length === 0) return false;
  const command = text.trim().split(/\s+/)[0];
  return command === '/compact';
}

const MESSAGE_QUEUE_TIMEOUT_MS = 30_000;

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
  yieldAttempt?: unknown;
  yieldQueryGeneration?: number;
}

export class MessageQueue {
  private queue: QueuedMessage[] = [];
  private waiters: Array<() => void> = [];
  private running: boolean = false;
  private timeoutMs: number = MESSAGE_QUEUE_TIMEOUT_MS;
  private deliveryGate: Promise<void> | null = null;
  private stopEpoch: number = 0;
  private userInterruptEpoch: number = 0;
  private lastYieldGenerations: Map<string, YieldGenerationStamp> = new Map();
  private evictedYieldEpochs: Set<string> = new Set();

  private internalCompactionDeliveryHolds: number = 0;
  private internalCompactionsAwaitingBoundary: number = 0;
  private internalCompactionIdsAwaitingBoundary: Set<string> = new Set();
  private internalCompactionResultAttributionArmed: boolean = false;
  private outstandingCompactionBoundaries: Array<{ kind: 'daemon' | 'user'; id?: string }> = [];
  private unboundedCompactOutcome: boolean = false;
  private internalCompactionBuffered: boolean = false;
  private daemonFrontTerminalResult: boolean = false;

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
      this.internalCompactionResultAttributionArmed = false;
      this.internalCompactionsAwaitingBoundary += 1;
      this.internalCompactionIdsAwaitingBoundary.add(message.id);
      this.internalCompactionBuffered = this.outstandingCompactionBoundaries.length > 0;
      this.outstandingCompactionBoundaries.push({ kind: 'daemon', id: message.id });
    } else {
      if (isUserCompactCommand(message.content)) {
        this.outstandingCompactionBoundaries.push({ kind: 'user' });
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

  acknowledgeCompactionsAwaitingBoundary(): void {
    if (this.internalCompactionsAwaitingBoundary > 0) {
      this.internalCompactionsAwaitingBoundary -= 1;
      const acknowledged = this.internalCompactionIdsAwaitingBoundary.values().next().value;
      if (acknowledged !== undefined) {
        this.internalCompactionIdsAwaitingBoundary.delete(acknowledged);
      }
      this.outstandingCompactionBoundaries.shift();
      this.unboundedCompactOutcome = false;
      if (this.internalCompactionsAwaitingBoundary === 0) {
        this.internalCompactionBuffered = false;
      }
    }
    this.daemonFrontTerminalResult = false;
    this.removePendingInternalCompactions();
    this.wakeWaiters();
  }

  armInternalCompactionResultAttribution(): void {
    this.internalCompactionResultAttributionArmed = true;
  }

  consumeInternalCompactionResultAttribution(): boolean {
    const armed = this.internalCompactionResultAttributionArmed;
    this.internalCompactionResultAttributionArmed = false;
    return armed;
  }

  nextCompactionBoundaryIsDaemon(): boolean {
    return this.outstandingCompactionBoundaries[0]?.kind === 'daemon';
  }

  consumeCompactionBoundary(): void {
    this.outstandingCompactionBoundaries.shift();
    this.unboundedCompactOutcome = false;
  }

  noteCompactOutcome(): void {
    this.unboundedCompactOutcome = true;
  }

  resetCompactOutcome(): void {
    this.unboundedCompactOutcome = false;
  }

  expireUserCompactionMarkerAtResult(numTurns: number): void {
    if (
      this.outstandingCompactionBoundaries[0]?.kind === 'user' &&
      this.unboundedCompactOutcome &&
      numTurns === 0
    ) {
      this.outstandingCompactionBoundaries.shift();
      this.unboundedCompactOutcome = false;
    }
  }

  hasBufferedInternalCompaction(): boolean {
    return this.internalCompactionBuffered;
  }

  noteResultForCompactionRecovery(numTurns: number): void {
    if (
      numTurns === 0 &&
      this.outstandingCompactionBoundaries[0]?.kind === 'daemon' &&
      this.unboundedCompactOutcome
    ) {
      this.daemonFrontTerminalResult = true;
    }
    this.unboundedCompactOutcome = false;
  }

  canRecoverBufferedCompaction(): boolean {
    return this.daemonFrontTerminalResult;
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
    const markerIndex = this.outstandingCompactionBoundaries.findIndex(
      (entry) => entry.kind === 'daemon' && entry.id === messageId
    );
    if (markerIndex !== -1) {
      this.outstandingCompactionBoundaries.splice(markerIndex, 1);
    }
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
    this.stopEpoch += 1;
    this.clearEpoch += 1;
    const deliveredCompactions = this.internalCompactionsAwaitingBoundary > 0;
    const rejectedCompactions =
      this.queue.some((message) => this.isInternalCompaction(message)) ||
      [...this.claimed].some((message) => this.isInternalCompaction(message));
    this.internalCompactionsAwaitingBoundary = 0;
    this.internalCompactionIdsAwaitingBoundary.clear();
    this.internalCompactionResultAttributionArmed = false;
    this.outstandingCompactionBoundaries = [];
    this.unboundedCompactOutcome = false;
    this.daemonFrontTerminalResult = false;
    this.internalCompactionBuffered = false;
    this.deliveryGate = null;
    this.internalCompactionDeliveryHolds = 0;
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
      if (msg.durable === true && !msg.internal) {
        msg.reject(new Error('Interrupted by user'));
      } else {
        msg.resolve(msg.id);
      }
    }
    this.yielded.clear();
    if (deliveredCompactions || yieldedCompactions.length > 0 || rejectedCompactions) {
      this.onInternalCompactionsAborted?.();
    }
  }

  getUserInterruptEpoch(): number {
    return this.userInterruptEpoch;
  }

  getClearEpoch(): number {
    return this.clearEpoch;
  }

  noteUserInterrupt(): void {
    this.userInterruptEpoch += 1;
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

  pruneYielded(predicate: (messageId: string) => boolean): string[] {
    const removed: string[] = [];
    const settled: QueuedMessage[] = [];
    for (const message of this.yielded) {
      if (predicate(message.id)) {
        removed.push(message.id);
        settled.push(message);
        if (message.timeoutId) {
          clearTimeout(message.timeoutId);
          message.timeoutId = undefined;
        }
      }
    }
    this.yielded = new Set([...this.yielded].filter((message) => !removed.includes(message.id)));
    for (const message of settled) {
      message.resolve(message.id);
    }
    return removed;
  }

  ownsYieldedGeneration(messageId: string, generation: number | null | undefined): boolean {
    return ownsYieldedGenerationGate({
      yielded: [...this.yielded].map(
        (message): YieldedRowSnapshot => ({
          id: message.id,
          yieldQueryGeneration: message.yieldQueryGeneration,
        })
      ),
      lastYieldGenerations: this.lastYieldGenerations,
      messageId,
      generation,
    });
  }

  ownsLastYield(messageId: string, generation: number | null | undefined): boolean {
    return ownsLastYieldGate({
      lastYieldGenerations: this.lastYieldGenerations,
      evictedYieldEpochs: this.evictedYieldEpochs,
      messageId,
      generation,
      stopEpoch: this.stopEpoch,
    });
  }

  private isTrackedMessageId(messageId: string): boolean {
    return (
      this.queue.some((message) => message.id === messageId) ||
      [...this.claimed].some((message) => message.id === messageId) ||
      [...this.yielded].some((message) => message.id === messageId)
    );
  }

  private recordEvictedYieldEpoch(stamp: YieldGenerationStamp): void {
    const evictedKey = evictedYieldKey(stamp.generation, stamp.stopEpoch);
    if (this.evictedYieldEpochs.has(evictedKey)) return;
    this.evictedYieldEpochs.add(evictedKey);
    if (this.evictedYieldEpochs.size > 256) {
      const oldestEpoch = this.evictedYieldEpochs.values().next().value;
      if (oldestEpoch !== undefined) {
        this.evictedYieldEpochs.delete(oldestEpoch);
      }
    }
  }

  acknowledgeYielded(messageId: string, fromQueryGeneration?: number): boolean {
    if (!this.ownsYieldedGeneration(messageId, fromQueryGeneration ?? null)) return false;
    for (const message of this.yielded) {
      if (message.id !== messageId) continue;
      this.yielded.delete(message);
      this.noteInternalCompactionSent(message);
      message.resolve(message.id);
      return true;
    }
    return false;
  }

  requeueYielded(messageId: string, options?: { durable?: boolean }): boolean {
    for (const message of this.yielded) {
      if (message.id !== messageId) continue;
      this.yielded.delete(message);
      message.yieldAttempt = undefined;
      if (options?.durable) {
        message.durable = true;
      }
      if (message.timeoutId) {
        clearTimeout(message.timeoutId);
        message.timeoutId = undefined;
      }
      this.queue.unshift(message);
      this.wakeWaiters();
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
    this.stopEpoch += 1;
    this.running = false;
    const deliveredCompactions = this.internalCompactionsAwaitingBoundary > 0;
    const rejectedCompactions =
      this.queue.some((message) => this.isInternalCompaction(message)) ||
      [...this.claimed].some((message) => this.isInternalCompaction(message)) ||
      [...this.yielded].some((message) => this.isInternalCompaction(message));
    this.internalCompactionsAwaitingBoundary = 0;
    this.internalCompactionIdsAwaitingBoundary.clear();
    this.internalCompactionResultAttributionArmed = false;
    this.outstandingCompactionBoundaries = [];
    this.unboundedCompactOutcome = false;
    this.daemonFrontTerminalResult = false;
    this.internalCompactionBuffered = false;
    this.cancelInternalCompactionEntries(true, true);
    this.yielded = new Set(
      [...this.yielded].filter((msg) => {
        if (msg.durable === true && !msg.internal) {
          if (msg.timeoutId) {
            clearTimeout(msg.timeoutId);
          }
          msg.reject(new Error('Interrupted by user'));
          return false;
        }
        return true;
      })
    );
    this.deliveryGate = null;
    this.internalCompactionDeliveryHolds = 0;
    this.wakeWaiters();
    if (deliveredCompactions || rejectedCompactions) {
      this.onInternalCompactionsAborted?.();
    }
  }

  isRunning(): boolean {
    return this.running;
  }

  async *messageGenerator(
    sessionId: string,
    options?: {
      suppressPreYieldCallback?: boolean;
      queryGeneration?: number;
    }
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
      const yieldAttempt: unknown = {};
      queuedMessage.yieldAttempt = yieldAttempt;
      queuedMessage.yieldQueryGeneration = options?.queryGeneration;
      if (options?.queryGeneration !== undefined) {
        this.lastYieldGenerations.set(queuedMessage.id, {
          generation: options.queryGeneration,
          stopEpoch: this.stopEpoch,
        });
        if (this.lastYieldGenerations.size > 64) {
          const retainedIds = [...this.lastYieldGenerations.keys()];
          for (const retainedId of retainedIds) {
            if (this.lastYieldGenerations.size <= 64) break;
            if (this.isTrackedMessageId(retainedId)) continue;
            const retainedStamp = this.lastYieldGenerations.get(retainedId);
            if (retainedStamp && retainedStamp.stopEpoch !== this.stopEpoch) continue;
            if (retainedStamp) {
              this.recordEvictedYieldEpoch(retainedStamp);
            }
            this.lastYieldGenerations.delete(retainedId);
          }
          for (const retainedId of retainedIds) {
            if (this.lastYieldGenerations.size <= 256) break;
            const evictedStamp = this.lastYieldGenerations.get(retainedId);
            if (evictedStamp) {
              this.recordEvictedYieldEpoch(evictedStamp);
            }
            this.lastYieldGenerations.delete(retainedId);
          }
        }
      }
      yield {
        message: sdkUserMessage,
        onSent: () => {
          if (queuedMessage.yieldAttempt !== yieldAttempt) return;
          if (this.yielded.delete(queuedMessage)) {
            this.noteInternalCompactionSent(queuedMessage);
            queuedMessage.resolve(queuedMessage.id);
          }
        },
      };
    }
  }

  holdInternalCompactionDelivery(): void {
    this.internalCompactionDeliveryHolds += 1;
  }

  releaseInternalCompactionDelivery(): void {
    if (this.internalCompactionDeliveryHolds > 0) {
      this.internalCompactionDeliveryHolds -= 1;
    }
    if (this.internalCompactionDeliveryHolds === 0) {
      this.wakeWaiters();
    }
  }

  private gatedBypassIndex(): number {
    const compactionsHeld = this.internalCompactionDeliveryHolds > 0;
    const toolResultIndex = this.queue.findIndex(
      (message) =>
        typeof message.content !== 'string' &&
        message.content.some((block) => isToolResultContent(block))
    );
    if (toolResultIndex !== -1) return toolResultIndex;
    if (compactionsHeld) return -1;
    return this.queue.findIndex((message) => this.isInternalCompaction(message));
  }

  private async waitForNextMessage(): Promise<QueuedMessage | null> {
    const generation = this.generation;
    while (this.running && this.generation === generation) {
      while (this.queue.length === 0) {
        if (!this.running || this.generation !== generation) return null;
        await new Promise<void>((resolve) => {
          this.waiters.push(resolve);
        });
        if (!this.running || this.generation !== generation) return null;
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

      if (!this.running || this.generation !== generation) return null;

      const message = this.queue.splice(bypassIndex, 1)[0];
      if (message) {
        this.claimed.add(message);
        return message;
      }
    }
    return null;
  }
}
