import type { UUID } from 'crypto';
import type { MessageContent, ToolResultContent } from '@hyperneo/shared';
import type { SDKUserMessage } from '@hyperneo/shared/sdk';
import { generateUUID } from '@hyperneo/shared';
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

export class MessageQueue {
  private queue: QueuedMessage[] = [];
  private waiters: Array<() => void> = [];
  private running: boolean = false;
  private timeoutMs: number = MESSAGE_QUEUE_TIMEOUT_MS;

  overrideTimeoutMsForTest(ms: number): void {
    this.timeoutMs = ms;
  }

  private claimed: Set<QueuedMessage> = new Set();

  private yielded: Set<QueuedMessage> = new Set();

  private generation: number = 0;

  private clearEpoch: number = 0;

  onMessageYielded?: (messageId: string, sentAt: number) => void;

  onMessageEnqueued?: (messageId: string, queuedAt: number) => void;

  private wakeWaiters(): void {
    this.waiters.forEach((waiter) => waiter());
    this.waiters = [];
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
    for (const msg of this.yielded) {
      if (msg.timeoutId) {
        clearTimeout(msg.timeoutId);
      }
      msg.resolve(msg.id);
    }
    this.yielded.clear();
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
    this.wakeWaiters();
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
            queuedMessage.resolve(queuedMessage.id);
          }
        },
      };
    }
  }

  private async waitForNextMessage(): Promise<QueuedMessage | null> {
    while (this.running && this.queue.length === 0) {
      await new Promise<void>((resolve) => {
        this.waiters.push(resolve);
      });

      if (!this.running) return null;
    }

    const message = this.queue.shift() || null;
    if (message) {
      this.claimed.add(message);
    }
    return message;
  }
}
