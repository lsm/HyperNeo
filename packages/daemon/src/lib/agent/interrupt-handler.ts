/**
 * InterruptHandler - Handles query interruption
 *
 * Extracted from AgentSession to reduce complexity.
 * Takes AgentSession instance directly - handlers are internal parts of AgentSession.
 *
 * Handles:
 * - Interrupt state management
 * - Abort controller signaling
 * - SDK interrupt() integration
 * - Queue cleanup
 * - State transitions during interrupt
 */

import type { Session, MessageHub } from '@hyperneo/shared';
import type { QueryLike } from './query-like';
import type { Logger } from '../logger';
import type { MessageQueue } from './message-queue';
import type { ProcessingStateManager } from './processing-state-manager';

/**
 * Context interface - what InterruptHandler needs from AgentSession
 * Using interface instead of importing AgentSession to avoid circular deps
 */
export interface InterruptHandlerContext {
  readonly session: Session;
  readonly messageHub: MessageHub;
  readonly messageQueue: MessageQueue;
  readonly stateManager: ProcessingStateManager;
  readonly logger: Logger;

  // Mutable query state
  queryObject: QueryLike | null;
  queryPromise: Promise<void> | null;
  queryAbortController: AbortController | null;
}

/**
 * Handles interrupt operations for AgentSession
 */
export class InterruptHandler {
  // Interrupt completion tracking
  private interruptPromise: Promise<void> | null = null;
  private interruptResolve: (() => void) | null = null;

  constructor(private ctx: InterruptHandlerContext) {}

  /**
   * Get the current interrupt promise (for waiting in ensureQueryStarted)
   */
  getInterruptPromise(): Promise<void> | null {
    return this.interruptPromise;
  }

  /**
   * Handle interrupt request
   * Uses official SDK interrupt() method
   */
  async handleInterrupt(): Promise<void> {
    const { session, messageHub, messageQueue, stateManager, logger } = this.ctx;

    const currentState = stateManager.getState();

    // Edge case: already idle or interrupted
    if (currentState.status === 'idle' || currentState.status === 'interrupted') {
      return;
    }

    // Create interrupt completion promise
    const interruptCompletePromise = new Promise<void>((resolve) => {
      this.interruptResolve = resolve;
    });
    this.interruptPromise = interruptCompletePromise;

    try {
      // Set state to 'interrupted' immediately
      await stateManager.setInterrupted();

      // Clear pending messages in queue. clear() is a no-op on an empty queue
      // and ALWAYS fires the delivery-lifecycle onClear hook, so an interrupt
      // during processing (queue already consumed) still records the turn's
      // consumed IDs as failed and clears the set — otherwise they'd survive and
      // be marked completed by the next turn's result. See task #859 (8498).
      messageQueue.clear();

      // STEP 1: Abort the query to break the for-await loop
      if (this.ctx.queryAbortController) {
        this.ctx.queryAbortController.abort();
        this.ctx.queryAbortController = null;
      }

      // Capture snapshot before any await so interrupt() always targets the
      // right object even if ctx.queryObject changes during async operations.
      const queryObjectSnapshot = this.ctx.queryObject;

      // STEP 2: Call SDK interrupt()
      if (queryObjectSnapshot && typeof queryObjectSnapshot.interrupt === 'function') {
        try {
          await queryObjectSnapshot.interrupt();
        } catch (error) {
          const errorMessage = error instanceof Error ? error.message : String(error);
          logger.warn('SDK interrupt() failed (may be expected):', errorMessage);
        }
      }

      // STEP 3: Wait for old query to finish
      if (this.ctx.queryPromise) {
        try {
          await Promise.race([
            this.ctx.queryPromise,
            new Promise((resolve) => setTimeout(resolve, 200)),
          ]);
        } catch (error) {
          logger.warn('Error waiting for old query:', error);
        }
      }

      // STEP 4: Close query — use live reference to avoid double-close.
      // If runQuery()'s finally block ran during the STEP 3 await, it already
      // called close() and nulled ctx.queryObject; skip close() in that case.
      // Only close when the promise timed out and the subprocess is still alive.
      if (this.ctx.queryObject) {
        try {
          this.ctx.queryObject.close();
        } catch (error) {
          const errorMessage = error instanceof Error ? error.message : String(error);
          logger.warn('SDK close() failed (may be expected):', errorMessage);
        }
      }

      // STEP 5: Clear queryObject
      this.ctx.queryObject = null;

      // STEP 6: Stop the message queue
      messageQueue.stop();

      // Publish interrupt event
      messageHub.event('session.interrupted', {}, { channel: `session:${session.id}` });

      // Set state back to idle
      await stateManager.setIdle();
    } finally {
      // Always resolve the interrupt promise
      if (this.interruptResolve) {
        this.interruptResolve();
        this.interruptResolve = null;
      }
      this.interruptPromise = null;
    }
  }
}
