/**
 * MessageQueue - Async message queue for SDK streaming input
 *
 * Provides AsyncGenerator interface for Claude SDK's streaming input mode.
 * Messages are queued and yielded to the SDK as they arrive.
 *
 * Includes stuck state detection: if a message stays queued for too long
 * without being consumed by the SDK, it will be rejected with a timeout error.
 */

import type { UUID } from 'crypto';
import type { MessageContent, ToolResultContent } from '@hyperneo/shared';
import type { SDKUserMessage } from '@hyperneo/shared/sdk';
import { generateUUID } from '@hyperneo/shared';

/**
 * Check if content is a tool_result content block
 */
function isToolResultContent(content: MessageContent): content is ToolResultContent {
  return content.type === 'tool_result' && 'tool_use_id' in content;
}

/**
 * Extract the parent_tool_use_id from message content
 * Returns the tool_use_id from a tool_result block if present, otherwise null
 */
function extractParentToolUseId(content: string | MessageContent[]): string | null {
  if (typeof content === 'string') {
    return null;
  }

  // Look for a tool_result block in the content
  const toolResult = content.find(isToolResultContent);
  return toolResult?.tool_use_id ?? null;
}

/**
 * Default timeout for queued messages (30 seconds)
 * If SDK doesn't consume a message within this time, it's considered stuck
 */
const MESSAGE_QUEUE_TIMEOUT_MS = 30_000;

/**
 * Queued message waiting to be sent to Claude
 */
interface QueuedMessage {
  id: string;
  content: string | MessageContent[];
  timestamp: string;
  queuedAt: number; // Timestamp when message was queued (for timeout detection)
  resolve: (messageId: string) => void;
  reject: (error: Error) => void;
  internal?: boolean; // If true, don't save to DB or emit to client
  timeoutId?: ReturnType<typeof setTimeout>; // Timeout handle for cleanup
  durable?: boolean;
}

export class MessageQueue {
  private queue: QueuedMessage[] = [];
  private waiters: Array<() => void> = [];
  private running: boolean = false;
  private timeoutMs: number = MESSAGE_QUEUE_TIMEOUT_MS;

  /** Test-only: shorten timeout to exercise delivery-state branches. */
  overrideTimeoutMsForTest(ms: number): void {
    this.timeoutMs = ms;
  }

  // Messages atomically removed from `queue` by a generator, but not yet yielded.
  private claimed: Set<QueuedMessage> = new Set();

  // Messages actually yielded to the SDK, but not yet acknowledged by onSent.
  private yielded: Set<QueuedMessage> = new Set();

  // Generation counter to detect stale queries
  // When incrementing, old generators will skip yielding messages
  private generation: number = 0;

  /**
   * Callback fired when the generator yields a message to the SDK.
   * Used to broadcast the message to UI and update DB timestamp at yield time
   * (the moment the SDK actually receives the message in the conversation).
   */
  onMessageYielded?: (messageId: string, sentAt: number) => void;

  /**
   * Callback fired when a message enters the queue.
   * Used by runners that need to arm startup protection before the generator can yield.
   */
  onMessageEnqueued?: (messageId: string, queuedAt: number) => void;

  private wakeWaiters(): void {
    this.waiters.forEach((waiter) => waiter());
    this.waiters = [];
  }

  /**
   * Enqueue a message to be sent to Claude via the streaming query
   */
  async enqueue(content: string | MessageContent[], internal: boolean = false): Promise<string> {
    const messageId = generateUUID();
    await this.enqueueWithId(messageId, content, internal);
    return messageId;
  }

  /**
   * Enqueue a message with a pre-generated ID
   * Used when caller needs the ID before the message is processed (e.g., for state tracking)
   *
   * Includes timeout detection: if the SDK doesn't consume the message within
   * this.timeoutMs, the promise is rejected with a timeout error.
   * This prevents the session from getting stuck in 'queued' state indefinitely.
   */
  async enqueueWithId(
    messageId: string,
    content: string | MessageContent[],
    internal: boolean = false,
    options?: { durable?: boolean; prepend?: boolean }
  ): Promise<void> {
    return this.admitWithId(messageId, content, internal, options);
  }

  /**
   * Synchronously admit a message and return its eventual delivery acknowledgment.
   */
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
          // Clear timeout when message is successfully consumed
          if (queuedMessage.timeoutId) {
            clearTimeout(queuedMessage.timeoutId);
          }
          resolve();
        },
        reject: (error: Error) => {
          // Clear timeout on rejection
          if (queuedMessage.timeoutId) {
            clearTimeout(queuedMessage.timeoutId);
          }
          reject(error);
        },
        internal,
      };

      // Set up timeout to detect stuck messages
      // If the SDK neither consumes nor acknowledges the message in time, reject
      // with a timeout error. Covers both cases: still in `queue` (never
      // consumed) OR already shifted out and yielded but `onSent` never ran
      // (iterator terminated mid-flight) — otherwise the enqueue promise would
      // hang and the inFlight Set/size() would leak/overcount it indefinitely.
      queuedMessage.timeoutId = setTimeout(() => {
        const timeoutError = new Error(
          `Message queue timeout: SDK did not consume message ${messageId} within ${this.timeoutMs / 1000}s. ` +
            `This usually indicates an SDK internal error. Please try again or create a new session.`
        );
        timeoutError.name = 'MessageQueueTimeoutError';
        const index = this.queue.indexOf(queuedMessage);
        if (index !== -1) {
          this.queue.splice(index, 1);
          queuedMessage.reject(timeoutError);
          return;
        }
        if (this.claimed.delete(queuedMessage)) {
          queuedMessage.reject(timeoutError);
          return;
        }
        if (this.yielded.delete(queuedMessage)) {
          if (queuedMessage.durable) {
            queuedMessage.resolve(queuedMessage.id);
          } else {
            queuedMessage.reject(timeoutError);
          }
        }
      }, this.timeoutMs);

      if (options?.prepend) {
        this.queue.unshift(queuedMessage);
      } else {
        this.queue.push(queuedMessage);
      }
      this.onMessageEnqueued?.(queuedMessage.id, queuedMessage.queuedAt);

      // Wake up any waiting message generators
      this.wakeWaiters();
    });
  }

  /**
   * Clear all pending messages (used during interrupt)
   * Also cleans up any pending timeouts
   */
  clear(): void {
    // Clear timeouts and reject all pending messages
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

  /**
   * Remove a single pending message before the SDK consumes it.
   *
   * Returns false when the message is already gone from the in-memory queue
   * (usually because it was consumed, timed out, or was only persisted for replay).
   */
  remove(messageId: string): boolean {
    const index = this.queue.findIndex((msg) => msg.id === messageId);
    if (index !== -1) {
      const [msg] = this.queue.splice(index, 1);
      if (msg.timeoutId) clearTimeout(msg.timeoutId);
      msg.resolve(messageId);
      return true;
    }

    // A generator may have atomically claimed the message but not reached the
    // actual yield yet. Revocation still wins in that state: remove it from the
    // claimed set and settle the admission. messageGenerator rechecks ownership
    // after its await and skips a revoked claim. Once in `yielded`, provider
    // ownership has won and removal correctly returns false.
    const claimed = [...this.claimed].find((msg) => msg.id === messageId);
    if (!claimed) return false;
    this.claimed.delete(claimed);
    if (claimed.timeoutId) clearTimeout(claimed.timeoutId);
    claimed.resolve(messageId);
    return true;
  }

  /**
   * Get pending message count (for monitoring + interrupt gating).
   *
   * Includes messages claimed by a generator or actually yielded to the SDK —
   * InterruptHandler.handleInterrupt clears only when `size() > 0`, so a
   * kickoff that has been yielded (and is therefore only in `inFlight`) must
   * still count here or `clear()` would be skipped and its enqueue promise would
   * never settle.
   */
  size(): number {
    return this.queue.length + this.claimed.size + this.yielded.size;
  }

  /**
   * True when `messageId` is currently in the queue, claimed by a generator, or
   * yielded to the SDK but not yet acknowledged — i.e. it was admitted and is
   * still in flight. Used by the ACP steer path to avoid re-admitting (and thus
   * duplicating) a steer that is already pending subprocess acceptance:
   * {@link MessageQueue.admitWithId} is NOT idempotent (each call pushes a fresh
   * message), so a parked re-run must not feed twice.
   */
  hasPendingOrInFlight(messageId: string): boolean {
    if (this.queue.some((message) => message.id === messageId)) return true;
    for (const message of this.claimed) {
      if (message.id === messageId) return true;
    }
    for (const message of this.yielded) {
      if (message.id === messageId) return true;
    }
    return false;
  }

  /**
   * Start the message queue (allows messages to be yielded)
   * Increments generation to invalidate old generators
   */
  start(): void {
    this.running = true;
    // Increment generation when starting - this invalidates any old generators
    this.generation++;
    this.wakeWaiters();
  }

  /**
   * Get the current generation counter
   * Generators should check this to detect if they're stale
   */
  getGeneration(): number {
    return this.generation;
  }

  /**
   * Stop the message queue (prevents new messages from being yielded)
   */
  stop(): void {
    this.running = false;
    // Wake up any waiting generators so they can exit
    this.wakeWaiters();
  }

  /**
   * Check if queue is running
   */
  isRunning(): boolean {
    return this.running;
  }

  /**
   * AsyncGenerator that yields messages continuously from the queue
   * This is the heart of streaming input mode!
   *
   * Returns an object with the message and a callback to mark it as sent.
   * The callback resolves the promise returned by enqueue().
   *
   * IMPORTANT: This generator checks the generation counter to detect stale queries.
   * When the queue is stopped and restarted, the generation increments and old
   * generators will exit early instead of consuming messages meant for the new query.
   */
  async *messageGenerator(
    sessionId: string,
    options?: { suppressPreYieldCallback?: boolean }
  ): AsyncGenerator<{ message: SDKUserMessage; onSent: () => void }> {
    // Capture the generation at the time this generator was created
    const myGeneration = this.generation;

    while (this.running) {
      // CRITICAL: Check if this generator is stale (generation has changed)
      // This prevents old query generators from consuming messages after interrupt
      if (this.generation !== myGeneration) {
        // This generator is stale - exit without consuming any more messages
        break;
      }

      const queuedMessage = await this.waitForNextMessage();

      if (!queuedMessage) {
        break;
      }

      // Ownership may have been revoked after waitForNextMessage claimed the
      // entry but before this continuation resumed. A successful remove/defer
      // wins before actual yield, so skip the revoked claim entirely.
      if (!this.claimed.has(queuedMessage)) {
        continue;
      }

      // Double-check generation after waiting (in case it changed while we were waiting)
      if (this.generation !== myGeneration) {
        // Generation changed while waiting - put message back and exit
        this.claimed.delete(queuedMessage);
        this.queue.unshift(queuedMessage);
        break;
      }

      // Extract parent_tool_use_id from tool_result content blocks
      // This is required when responding to AskUserQuestion and other tool calls
      const parentToolUseId = extractParentToolUseId(queuedMessage.content);

      // Prepare the SDK user message
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

      // Fire callback immediately before the actual yield. A failure means the
      // message was claimed but never yielded, so reject its acknowledgment.
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

  /**
   * Wait for the next message to be enqueued
   */
  private async waitForNextMessage(): Promise<QueuedMessage | null> {
    while (this.running && this.queue.length === 0) {
      // Wait for message to be enqueued
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
