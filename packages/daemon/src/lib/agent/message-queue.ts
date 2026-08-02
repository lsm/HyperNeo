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
}

export class MessageQueue {
  private queue: QueuedMessage[] = [];
  private waiters: Array<() => void> = [];
  private running: boolean = false;

  // Messages shifted out of `queue` and yielded to the SDK, but whose
  // enqueueWithId() promise has not yet resolved (onSent not called). clear()
  // must reject these too — otherwise, if an interrupt lands in the gap between
  // the generator's shift and the SDK's onSent, neither clear() (the message is
  // no longer in `queue`) nor the stuck-message timeout (same check) can settle
  // the promise, so `await enqueueWithId()` hangs forever.
  private inFlight: Set<QueuedMessage> = new Set();

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
   * MESSAGE_QUEUE_TIMEOUT_MS, the promise is rejected with a timeout error.
   * This prevents the session from getting stuck in 'queued' state indefinitely.
   */
  async enqueueWithId(
    messageId: string,
    content: string | MessageContent[],
    internal: boolean = false
  ): Promise<void> {
    return new Promise((resolve, reject) => {
      const queuedMessage: QueuedMessage = {
        id: messageId,
        content,
        timestamp: new Date().toISOString(),
        queuedAt: Date.now(),
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
          `Message queue timeout: SDK did not consume message ${messageId} within ${MESSAGE_QUEUE_TIMEOUT_MS / 1000}s. ` +
            `This usually indicates an SDK internal error. Please try again or create a new session.`
        );
        timeoutError.name = 'MessageQueueTimeoutError';
        const index = this.queue.indexOf(queuedMessage);
        if (index !== -1) {
          this.queue.splice(index, 1);
          queuedMessage.reject(timeoutError);
          return;
        }
        if (this.inFlight.delete(queuedMessage)) {
          queuedMessage.reject(timeoutError);
        }
      }, MESSAGE_QUEUE_TIMEOUT_MS);

      this.queue.push(queuedMessage);
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
    // Also reject messages already shifted out of the queue and yielded to the
    // SDK whose onSent callback never ran (interrupt landed in that gap).
    for (const msg of this.inFlight) {
      if (msg.timeoutId) {
        clearTimeout(msg.timeoutId);
      }
      msg.reject(new Error('Interrupted by user'));
    }
    this.inFlight.clear();
  }

  /**
   * Remove a single pending message before the SDK consumes it.
   *
   * Returns false when the message is already gone from the in-memory queue
   * (usually because it was consumed, timed out, or was only persisted for replay).
   */
  remove(messageId: string): boolean {
    const index = this.queue.findIndex((msg) => msg.id === messageId);
    if (index === -1) {
      return false;
    }

    const [msg] = this.queue.splice(index, 1);
    if (msg.timeoutId) {
      clearTimeout(msg.timeoutId);
    }
    msg.resolve(messageId);
    return true;
  }

  /**
   * Get pending message count (for monitoring + interrupt gating).
   *
   * Includes messages already shifted out and yielded to the SDK (inFlight) —
   * InterruptHandler.handleInterrupt clears only when `size() > 0`, so a
   * kickoff that has been yielded (and is therefore only in `inFlight`) must
   * still count here or `clear()` would be skipped and its enqueue promise would
   * never settle.
   */
  size(): number {
    return this.queue.length + this.inFlight.size;
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
    sessionId: string
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

      // Double-check generation after waiting (in case it changed while we were waiting)
      if (this.generation !== myGeneration) {
        // Generation changed while waiting - put message back and exit
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

      // Track the shifted-but-unresolved message BEFORE firing the yield
      // callback, so a synchronous throw from onMessageYielded (DB/event
      // delivery) doesn't orphan it in neither `queue` nor `inFlight` — which
      // would leave clear()/timeout unable to settle the enqueue promise.
      //
      // Residual: there is a microtask-boundary gap between waitForNextMessage()'s
      // synchronous queue.shift() and this inFlight.add (they straddle the await
      // boundary), so a clear() that lands in that window finds the message in
      // neither collection. The enqueue promise then settles via the 30s timeout
      // (self-healing), and the "cancelled coder receives the kickoff" sub-race is
      // effectively unreachable because queryAbortController.abort() fires during
      // the same await boundary, before the generator resumes to yield. Fully
      // closing it (make shift+add atomic, or bump generation in stop()) interacts
      // with the generation-check unshift path — tracked for the cancellation-token
      // pass's atomic generator abort.
      this.inFlight.add(queuedMessage);

      // Fire callback at yield time for non-internal messages
      // This is T_consumed - when the SDK actually receives the message
      if (!queuedMessage.internal && this.onMessageYielded) {
        this.onMessageYielded(queuedMessage.id, Date.now());
      }
      // Yield message with callback
      yield {
        message: sdkUserMessage,
        onSent: () => {
          this.inFlight.delete(queuedMessage);
          queuedMessage.resolve(queuedMessage.id);
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

    return this.queue.shift() || null;
  }
}
