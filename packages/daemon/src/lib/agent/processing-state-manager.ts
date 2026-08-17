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
   * reclaims. Each carries an optional episode-generation tag so a narrowly-
   * scoped release (a superseded rate-limit retry) only resolves waiters from
   * that episode — not a newer turn's waiter armed after the generation bumped.
   * Drained in {@link setIdle} (terminal) / {@link releaseIdleWaiters}.
   */
  private idleWaiters: Map<
    number,
    {
      resolve: () => void;
      gen?: number;
      fireEnd: () => void;
      resolveOnce: () => void;
      endOnce: () => void;
    }
  > = new Map();
  private nextIdleWaiterId = 0;
  /**
   * True while the deferred-restart `onIdleCallback` is running. A reentrant
   * `setIdle` from the callback's own stop/start must NOT re-fire the callback
   * (double restart) NOR drain the waiters (the outer call owns the drain,
   * deferred until the restart completes so durable turn ownership survives the
   * restart). (Codex P1.)
   */
  private idleCallbackInFlight = false;
  /** Number of terminal transitions whose side effects have not settled. */
  private terminalIdleTransitions = 0;
  /** Pre-idle fences waiting to be consumed by their corresponding setIdle. */
  private pendingTerminalIdleTransitions = 0;

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
   *
   * `onEnd` fires on a GENUINE turn-end release — the terminal idle drain
   * ({@link setIdle}) or an explicit {@link releaseIdleWaiters} (a superseded
   * rate-limit retry / restart that abandons the durable turn as ended). It does
   * NOT fire on `cancel()`: cancel is a cleanup/abandon path (the delivery
   * bridge's `finally`, a rejected acknowledgment, a query-close with no idle),
   * NOT proof the turn ended — firing the marker there would let a consumed-but-
   * never-delivered prompt (e.g. a post-commit search-index throw that rejects
   * the acknowledgment) be marked ended, so the retried job completes without
   * delivering. The bridge derives the durable turn owner (kickoff UUID) from
   * the closure, not from mutable processing state. See Codex (PR #2463, P2).
   */
  waitForIdleTransition(
    episodeGen?: number,
    onEnd?: () => void
  ): { promise: Promise<void>; cancel: () => void } {
    let resolve!: () => void;
    const promise = new Promise<void>((r) => {
      resolve = r;
    });
    const id = this.nextIdleWaiterId++;
    let onEndFired = false;
    let resolved = false;
    // fireEnd persists the durable turn-completion state (the delivery_turn_end
    // marker) WITHOUT resolving the waiter; resolveOnce releases the awaiting
    // delivery job. Splitting the two lets setIdle write the marker
    // synchronously before the awaited idle side effects while deferring waiter
    // resolution to the finally. endOnce = fireEnd + resolve (releaseIdleWaiters
    // — a genuine abandon). cancel() uses resolveOnce ONLY (no marker — see the
    // doc above). Each is independently idempotent.
    const fireEnd = (): void => {
      if (onEndFired) return;
      onEndFired = true;
      onEnd?.();
    };
    const resolveOnce = (): void => {
      if (resolved) return;
      resolved = true;
      this.idleWaiters.delete(id);
      resolve();
    };
    const endOnce = (): void => {
      fireEnd();
      resolveOnce();
    };
    this.idleWaiters.set(id, { resolve, gen: episodeGen, fireEnd, resolveOnce, endOnce });
    return {
      promise,
      cancel: () => {
        // Cleanup/abandon, NOT a turn-end: release the awaiting job without
        // persisting the turn-completion marker. The marker fires only on the
        // genuine terminal paths (setIdle drain / releaseIdleWaiters).
        resolveOnce();
      },
    };
  }

  /**
   * Resolve + clear idle waiters. Used when a rate-limit retry is superseded
   * (the durable turn it would have re-driven is abandoned): resolves the waiter
   * — rather than cancelling it — so an awaiting driveDeliveryTurn completes its
   * job instead of hanging `processing`. Pass an `episodeGen` to resolve ONLY
   * waiters armed under that episode (a retry must not release a newer turn's
   * waiter armed after the generation bumped); omit it to resolve all.
   */
  releaseIdleWaiters(episodeGen?: number): void {
    const matching = [...this.idleWaiters.entries()].filter(
      ([, w]) => episodeGen === undefined || w.gen === episodeGen
    );
    for (const [, w] of matching) w.endOnce();
  }

  /**
   * Start a terminal-idle fence and persist turn-end markers without releasing
   * delivery jobs. The corresponding setIdle consumes this fence after its side
   * effects and waiter drain settle.
   */
  beginTerminalIdle(): void {
    this.terminalIdleTransitions += 1;
    this.pendingTerminalIdleTransitions += 1;
    for (const waiter of this.idleWaiters.values()) waiter.fireEnd();
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

  /** True while a terminal idle transition is still running its side effects. */
  isTerminalIdleInFlight(): boolean {
    return this.terminalIdleTransitions > 0;
  }

  /**
   * Set state to idle. Pass `{ suppressDeliveryWaiters: true }` on a
   * NON-terminal idle — one that is immediately followed by a query re-start
   * (e.g. QueryRunner's message-not-found / transient-connection auto-retries
   * call setIdle before recursing into runQuery; the startup-timeout retry
   * no longer idles — it backs off first and stays 'processing').
   * Resolving the delivery waiters on such a retry idle would let
   * driveDeliveryTurn complete the durable job while the same prompt is still
   * being retried, freeing the active-turn slot for a competing turn.
   */
  async setIdle(opts?: { suppressDeliveryWaiters?: boolean }): Promise<void> {
    // If a deferred-restart callback is in flight (a reentrant idle from its
    // stop/start), suppress the drain too — the outer call owns it, deferred
    // until the restart completes so durable turn ownership survives the restart.
    const suppressDrain = opts?.suppressDeliveryWaiters || this.idleCallbackInFlight;
    const consumesTerminalFence = this.pendingTerminalIdleTransitions > 0;
    const ownsTerminalTransition = !suppressDrain || consumesTerminalFence;
    if (consumesTerminalFence) {
      this.pendingTerminalIdleTransitions -= 1;
    } else if (!suppressDrain) {
      this.terminalIdleTransitions += 1;
    }
    // Persist the waiter-owned turn-completion markers SYNCHRONOUSLY, BEFORE any
    // await (the idle DB persist + session.updated publish, the deferred-restart
    // callback). A crash after the idle-state DB write but during those awaited
    // side effects would otherwise leave a result-less consumed turn without a
    // marker and re-drive it on recovery. Waiter RESOLUTION stays deferred to the
    // finally so the awaiting delivery job still observes the fully-processed
    // turn-end. See Codex (PR #2463, P2).
    if (!suppressDrain) {
      for (const w of this.idleWaiters.values()) w.fireEnd();
    }
    // setState persists the idle state BEFORE publishing it, so drain the
    // turn-end waiters in a finally — the state IS idle even if the event
    // publication throws, and a waiting delivery job must not hang on a
    // publish failure. Only on a TERMINAL idle (suppress on retry mid-points).
    try {
      await this.setState({ status: 'idle' });
      // Run the deferred-restart callback BEFORE releasing durable turn
      // ownership (draining the waiters). Resolving the waiters first would let
      // driveDeliveryTurn complete + free the active-turn slot while the callback
      // is still stopping/starting the query, so a message arriving in that
      // window could start a new turn concurrent with the restart. The reentrant
      // guard prevents a double restart from the callback's own idle transition.
      if (this.onIdleCallback && !this.idleCallbackInFlight) {
        this.idleCallbackInFlight = true;
        try {
          await this.onIdleCallback();
        } catch (error) {
          this.logger.error('Error in onIdle callback:', error);
          // Don't re-throw - callback errors shouldn't break state transitions
        } finally {
          this.idleCallbackInFlight = false;
        }
      }
    } finally {
      if (!suppressDrain) {
        // Waiters armed while setState/onIdleCallback was suspended missed the
        // initial fireEnd snapshot. Use the idempotent full end path so those late
        // waiters also persist their marker before their jobs are released.
        const waiters = [...this.idleWaiters.values()];
        this.idleWaiters.clear();
        for (const w of waiters) w.endOnce();
      }
      if (ownsTerminalTransition) {
        this.terminalIdleTransitions -= 1;
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
      // We're actively streaming — classify the RAW delta so an extended-
      // thinking generation (thinking_delta / content_block_start of a
      // thinking block) keeps the "Thinking" phase instead of flipping to
      // "Streaming" for its entire duration. Text deltas are the only frames
      // that prove visible output is being produced; other stream frames
      // (message_start, content_block_stop, message_delta, ping, …) carry no
      // phase signal and must not disturb the current phase. Heartbeat-only
      // consumers (the delivery stall watchdog) are unaffected either way —
      // they bump on the raw message, not the phase. (Codex review, #2476.)
      const event = (message as Extract<SDKMessage, { type: 'stream_event' }>).event as {
        type?: string;
        delta?: { type?: string };
        content_block?: { type?: string };
      };
      if (event?.type === 'content_block_delta' && event.delta?.type === 'text_delta') {
        if (this.streamingPhase !== 'streaming') {
          await this.updatePhase('streaming');
        }
      } else if (
        (event?.type === 'content_block_delta' && event.delta?.type === 'thinking_delta') ||
        (event?.type === 'content_block_start' && event.content_block?.type === 'thinking')
      ) {
        if (this.streamingPhase !== 'thinking') {
          await this.updatePhase('thinking');
        }
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
