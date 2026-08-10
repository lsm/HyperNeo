/**
 * ProcessingStateManager - Agent processing state machine
 *
 * Manages the state transitions:
 * idle → queued → processing (phases: initializing/thinking/streaming/finalizing) → idle | interrupted
 *
 * Enhanced with streaming phase tracking for fine-grained progress updates.
 * Now persists state to database for recovery after restarts.
 */

import type { AgentProcessingState, PendingUserQuestion } from '@hyperneo/shared';
import type { DaemonInternalEventMap, InternalEventBus } from '../internal-event-bus';
import type { SDKAssistantMessage, SDKMessage } from '@hyperneo/shared/sdk';
import { isToolUseBlock } from '@hyperneo/shared/sdk/type-guards';
import type { Database } from '../../storage/database';
import { Logger } from '../logger';

type StreamingPhase = 'initializing' | 'thinking' | 'streaming' | 'finalizing';

export class ProcessingStateManager {
  private processingState: AgentProcessingState = { status: 'idle' };
  private streamingPhase: StreamingPhase = 'initializing';
  private streamingStartedAt: number | null = null;
  private isCompacting = false;
  private logger: Logger;
  private onIdleCallback?: () => Promise<void>;
  /**
   * Resolvers awaiting the next terminal idle transition (the message-delivery
   * bridge awaiting a turn's end), keyed by arm id so a caller can cancel its
   * own waiter (failure/park paths) without leaking or accumulating across
   * reclaims. Drained in {@link setIdle}.
   */
  private idleWaiters: Map<number, () => void> = new Map();
  private nextIdleWaiterId = 0;

  constructor(
    private sessionId: string,
    private internalEventBus: InternalEventBus<DaemonInternalEventMap>,
    private db: Database
  ) {
    this.logger = new Logger(`ProcessingStateManager ${sessionId}`);
  }

  /**
   * Set callback to execute when state transitions to idle
   * Used for deferred restarts and other idle-triggered actions
   */
  setOnIdleCallback(callback: () => Promise<void>): void {
    this.onIdleCallback = callback;
  }

  /**
   * Arm a wait for the next TERMINAL idle transition. The message-delivery
   * bridge (`driveDeliveryTurn`) awaits `promise` to complete a durable job at
   * turn-end — awaiting `queryPromise` instead is wrong in streaming-input mode
   * (it resolves only on query-CLOSE, never at turn-end, so the job would hang).
   * Returns a handle: call `cancel()` from failure/park paths so the waiter is
   * removed (not left to accumulate across reclaims); the `promise` resolves on
   * the next non-suppressed {@link setIdle} or never (if cancelled, it is
   * abandoned — nobody awaits it). Arm BEFORE the turn starts so a fast turn's
   * idle cannot be missed.
   */
  waitForIdleTransition(): { promise: Promise<void>; cancel: () => void } {
    let resolve!: () => void;
    const promise = new Promise<void>((r) => {
      resolve = r;
    });
    const id = this.nextIdleWaiterId++;
    this.idleWaiters.set(id, resolve);
    return {
      promise,
      cancel: () => {
        this.idleWaiters.delete(id);
      },
    };
  }

  /**
   * Resolve + clear ALL idle waiters. Used when a rate-limit retry is superseded
   * (the durable turn it would have re-driven is abandoned): resolves the waiter
   * — rather than cancelling it — so an awaiting driveDeliveryTurn completes its
   * job instead of hanging `processing`.
   */
  releaseIdleWaiters(): void {
    const waiters = [...this.idleWaiters.values()];
    this.idleWaiters.clear();
    for (const resolve of waiters) resolve();
  }

  /**
   * Restore processing state from database
   * Called on session initialization to recover state after restart
   */
  restoreFromDatabase(): void {
    const session = this.db.getSession(this.sessionId);
    if (!session?.processingState) {
      return;
    }

    try {
      const restoredState = JSON.parse(session.processingState) as AgentProcessingState;

      // Handle different states appropriately after restart
      if (restoredState.status === 'processing' || restoredState.status === 'queued') {
        // Active processing states should reset to idle after restart
        // The SDK query will need to be restarted anyway
        this.processingState = { status: 'idle' };
      } else if (restoredState.status === 'rate_limit_cooldown') {
        // Cooldown timers are not persisted; reset to idle so the user
        // can manually retry or send a new message.
        this.processingState = { status: 'idle' };
      } else if (restoredState.status === 'waiting_for_input') {
        // IMPORTANT: Preserve waiting_for_input state across restarts
        // The user's pending question should still be answerable after page refresh
        this.processingState = restoredState;
      } else {
        this.processingState = restoredState;
      }
    } catch (error) {
      this.logger.error('Failed to parse persisted processing state:', error);
      this.processingState = { status: 'idle' };
    }
  }

  /**
   * Persist current processing state to database
   * DB-first pattern: save to DB, then broadcast via EventBus
   */
  private persistToDatabase(): void {
    try {
      const serialized = JSON.stringify(this.processingState);
      this.db.updateSession(this.sessionId, {
        processingState: serialized,
      });
    } catch (error) {
      this.logger.error('Failed to persist processing state to database:', error);
    }
  }

  /**
   * Get current processing state
   */
  getState(): AgentProcessingState {
    return this.processingState;
  }

  /**
   * Check if currently processing
   */
  isProcessing(): boolean {
    return this.processingState.status === 'processing';
  }

  /**
   * Check if idle
   */
  isIdle(): boolean {
    return this.processingState.status === 'idle';
  }

  /**
   * Set state to idle. Pass `{ suppressDeliveryWaiters: true }` on a
   * NON-terminal idle — one that is immediately followed by a query re-start
   * (e.g. QueryRunner's startup-timeout / message-not-found / transient-
   * connection auto-retries call setIdle before recursing into runQuery).
   * Resolving the delivery waiters on such a retry idle would let
   * driveDeliveryTurn complete the durable job while the same prompt is still
   * being retried, freeing the active-turn slot for a competing turn.
   */
  async setIdle(opts?: { suppressDeliveryWaiters?: boolean }): Promise<void> {
    // setState persists the idle state BEFORE publishing it, so drain the
    // turn-end waiters in a finally — the state IS idle even if the event
    // publication throws, and a waiting delivery job must not hang on a
    // publish failure. Only on a TERMINAL idle (suppress on retry mid-points).
    try {
      await this.setState({ status: 'idle' });
    } finally {
      if (!opts?.suppressDeliveryWaiters) {
        const waiters = [...this.idleWaiters.values()];
        this.idleWaiters.clear();
        for (const resolve of waiters) resolve();
      }
    }

    // Execute idle callback if set (e.g., for deferred restarts)
    if (this.onIdleCallback) {
      try {
        await this.onIdleCallback();
      } catch (error) {
        this.logger.error('Error in onIdle callback:', error);
        // Don't re-throw - callback errors shouldn't break state transitions
      }
    }
  }

  /**
   * Set state to queued
   */
  async setQueued(messageId: string): Promise<void> {
    await this.setState({ status: 'queued', messageId });
  }

  /**
   * Set state to queued only when the session is still idle AT SET TIME.
   * The v2 pre-claim marker uses this instead of trusting a stale isAgentBusy
   * snapshot taken before persistence/event-bus awaits: two concurrent
   * immediate sends can both observe idle before either reaches the set, so
   * the check must happen here — the first writer wins and a concurrent
   * steer never owns the queued marker (removing/deferring that steer then
   * can't clear the real turn's queued state back to idle). Returns true
   * when this call set the marker. See Codex (#3743968035).
   */
  async setQueuedIfIdle(messageId: string): Promise<boolean> {
    if (this.processingState.status !== 'idle') return false;
    await this.setQueued(messageId);
    return true;
  }

  /**
   * Return to idle only when the queued marker still belongs to `messageId`.
   * Delivery cancellation/skip paths use this compare-and-set so they cannot
   * clear a newer message's queued/processing state.
   */
  async clearQueuedIfOwnedBy(messageId: string): Promise<boolean> {
    const current = this.processingState;
    if (current.status !== 'queued' || current.messageId !== messageId) {
      return false;
    }
    await this.setIdle();
    return true;
  }

  /**
   * Set state to processing
   */
  async setProcessing(messageId: string, phase: StreamingPhase = 'initializing'): Promise<void> {
    this.streamingPhase = phase;
    if (phase === 'streaming' && !this.streamingStartedAt) {
      this.streamingStartedAt = Date.now();
    }

    await this.setState({
      status: 'processing',
      messageId,
      phase: this.streamingPhase,
      streamingStartedAt: this.streamingStartedAt ?? undefined,
      isCompacting: this.isCompacting,
    });
  }

  /**
   * Set state to interrupted
   */
  async setInterrupted(): Promise<void> {
    await this.setState({ status: 'interrupted' });
  }

  /**
   * Set state to waiting_for_input
   * Called when agent uses AskUserQuestion tool and needs user response
   */
  async setWaitingForInput(pendingQuestion: PendingUserQuestion): Promise<void> {
    await this.setState({ status: 'waiting_for_input', pendingQuestion });
  }

  /**
   * Set state to rate_limit_cooldown
   * Called when 429 retry exhaustion is detected and auto-retry is scheduled
   */
  async setRateLimitCooldown(state: {
    retryCount: number;
    maxRetries: number;
    retryAt: number;
  }): Promise<void> {
    await this.setState({
      status: 'rate_limit_cooldown',
      retryCount: state.retryCount,
      maxRetries: state.maxRetries,
      retryAt: state.retryAt,
    });
  }

  /**
   * Check if currently waiting for user input
   */
  isWaitingForInput(): boolean {
    return this.processingState.status === 'waiting_for_input';
  }

  /**
   * Get pending question if in waiting_for_input state
   */
  getPendingQuestion(): PendingUserQuestion | null {
    if (this.processingState.status === 'waiting_for_input') {
      return this.processingState.pendingQuestion;
    }
    return null;
  }

  /**
   * Update draft responses for pending question (for saving partial input)
   */
  async updateQuestionDraft(draftResponses: PendingUserQuestion['draftResponses']): Promise<void> {
    if (this.processingState.status !== 'waiting_for_input') {
      this.logger.warn('Cannot update draft - not in waiting_for_input state');
      return;
    }

    this.processingState = {
      ...this.processingState,
      pendingQuestion: {
        ...this.processingState.pendingQuestion,
        draftResponses,
      },
    };

    // Persist and broadcast
    this.persistToDatabase();
    await this.internalEventBus.publish('session.updated', {
      sessionId: this.sessionId,
      source: 'processing-state',
      processingState: this.processingState,
    });
  }

  /**
   * Set compacting state
   * Folded into unified state.session via isCompacting field
   */
  async setCompacting(isCompacting: boolean): Promise<void> {
    this.isCompacting = isCompacting;

    // Only relevant when processing
    if (this.processingState.status === 'processing') {
      this.processingState = {
        ...this.processingState,
        isCompacting,
      };

      // Persist and broadcast
      this.persistToDatabase();
      await this.internalEventBus.publish('session.updated', {
        sessionId: this.sessionId,
        source: 'processing-state',
        processingState: this.processingState,
      });
    }
  }

  /**
   * Check if currently compacting
   */
  getIsCompacting(): boolean {
    return this.isCompacting;
  }

  /**
   * Update the streaming phase (only valid during processing)
   */
  async updatePhase(phase: StreamingPhase): Promise<void> {
    if (this.processingState.status !== 'processing') {
      this.logger.warn(`Cannot update phase to ${phase} - not in processing state`);
      return;
    }

    this.streamingPhase = phase;

    // Track when streaming actually started
    if (phase === 'streaming' && !this.streamingStartedAt) {
      this.streamingStartedAt = Date.now();
    }

    this.processingState = {
      status: 'processing',
      messageId: this.processingState.messageId,
      phase: this.streamingPhase,
      streamingStartedAt: this.streamingStartedAt ?? undefined,
      isCompacting: this.isCompacting,
    };

    // DB-first: Persist to database before broadcasting
    this.persistToDatabase();

    // Broadcast updated state via unified session.updated event
    // Include processingState so StateManager can cache it (decoupled)
    await this.internalEventBus.publish('session.updated', {
      sessionId: this.sessionId,
      source: 'processing-state',
      processingState: this.processingState,
    });
  }

  /**
   * Auto-detect phase from SDK message type
   * Called during SDK message processing to automatically update phase
   */
  async detectPhaseFromMessage(message: SDKMessage): Promise<void> {
    if (this.processingState.status !== 'processing') {
      return; // Only detect during processing
    }

    if (message.type === 'stream_event') {
      // We're actively streaming content deltas
      if (this.streamingPhase !== 'streaming') {
        await this.updatePhase('streaming');
      }
    } else if (message.type === 'assistant') {
      // Assistant message indicates thinking/tool use phase
      const content = (message as SDKAssistantMessage).message.content;
      const hasToolUse = content.some(isToolUseBlock);

      if (hasToolUse && this.streamingPhase === 'initializing') {
        // Transition from initializing to thinking when we see tool use
        await this.updatePhase('thinking');
      } else if (
        !hasToolUse &&
        this.streamingPhase === 'initializing' &&
        content.some(
          (block: unknown) =>
            typeof block === 'object' && block !== null && 'type' in block && block.type === 'text'
        )
      ) {
        // If we get a text response without tool use, we're likely about to stream
        await this.updatePhase('thinking');
      }
    } else if (message.type === 'result') {
      // Final result - move to finalizing phase briefly before idle
      if (this.streamingPhase !== 'finalizing') {
        await this.updatePhase('finalizing');
      }
    }
  }

  /**
   * Internal state setter with event emission
   * DB-first pattern: save to DB, then broadcast via EventBus
   */
  private async setState(newState: AgentProcessingState): Promise<void> {
    // If transitioning to idle or interrupted, reset phase tracking
    if (newState.status === 'idle' || newState.status === 'interrupted') {
      this.streamingPhase = 'initializing';
      this.streamingStartedAt = null;
      this.isCompacting = false; // Reset compacting on idle/interrupted
    }

    this.processingState = newState;

    // DB-first: Persist to database before broadcasting
    this.persistToDatabase();

    // Emit event via InternalEventBus<DaemonInternalEventMap> (StateManager caches processingState)
    // Include data so StateManager doesn't need to fetch from us (decoupled)
    await this.internalEventBus.publish('session.updated', {
      sessionId: this.sessionId,
      source: 'processing-state',
      processingState: newState,
    });
  }
}
