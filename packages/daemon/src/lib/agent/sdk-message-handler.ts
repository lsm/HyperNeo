/**
 * SDKMessageHandler - Process incoming SDK messages
 *
 * Extracted from AgentSession to reduce complexity.
 * Takes AgentSession instance directly - handlers are internal parts of AgentSession.
 *
 * Handles:
 * - Message persistence to DB
 * - Broadcasting to clients via MessageHub
 * - Metadata updates (tokens, costs, tool calls)
 * - Compaction event detection and emission
 * - Title generation trigger
 * - Automatic phase detection for state tracking
 * - Circuit breaker trip handling (error loop detection)
 * - Context usage refresh via the SDK's native `query.getContextUsage()`
 *   (runs every N stream events, at every turn end, and after compaction)
 */

import type { UUID } from 'crypto';
import type { QueryLike } from './query-like';
import type { ContextInfo, MessageHub, Session } from '@hyperneo/shared';
import { generateUUID } from '@hyperneo/shared';
import type { DaemonInternalEventMap, InternalEventBus } from '../internal-event-bus';
import type { SDKMessage, SDKUserMessage } from '@hyperneo/shared/sdk';
import {
  isSDKAPIRetryMessage,
  isSDKAssistantMessage,
  flattenSDKSlashCommands,
  isSDKCommandsChangedMessage,
  isSDKCompactBoundary,
  isSDKModelRefusalFallbackMessage,
  isSDKResultMessage,
  isSDKResultSuccess,
  isSDKSessionStateChangedMessage,
  isSDKStatusMessage,
  isSDKSystemInit,
  isSDKSystemMessage,
  isSDKThinkingTokensMessage,
  isSDKUserMessage,
  isToolUseBlock,
} from '@hyperneo/shared/sdk/type-guards';
import type { Database } from '../../storage/database';
import { extractSdkUuid } from '../../storage/repositories/sdk-message-repository';
import type { MessageDeliveryStage } from '../../storage/repositories/message-delivery-lifecycle-repository';
import { Logger } from '../logger';
import { ErrorCategory, type ErrorManager } from '../error-manager';
import { getProviderContextManager } from '../providers/factory';
import type { ProcessingStateManager } from './processing-state-manager';
import type { ContextTracker } from './context-tracker';
import { ContextFetcher } from './context-fetcher';
import { ApiErrorCircuitBreaker } from './api-error-circuit-breaker';
import type { MessageQueue } from './message-queue';
import type { QueryLifecycleManager } from './query-lifecycle-manager';
import { RepeatedToolErrorGuardrail } from './repeated-tool-error-guardrail';
import { getSessionModelInfo } from '../model-service';
import { shouldUseHyperNeoCompactFallback } from './query-options-builder.js';
import { reserveBasedThreshold } from './context-tracker.js';

/**
 * Number of SDK stream events between automatic context-usage refreshes.
 * A refresh also happens at every turn end (result/error) and after
 * compaction, so short turns still update context at least once.
 */
const CONTEXT_REFRESH_EVENT_INTERVAL = 5;

/**
 * Context interface - what SDKMessageHandler needs from AgentSession
 * Using interface instead of importing AgentSession to avoid circular deps
 */
export interface SDKMessageHandlerContext {
  readonly session: Session;
  readonly db: Database;
  readonly messageHub: MessageHub;
  readonly internalEventBus: InternalEventBus<DaemonInternalEventMap>;
  readonly stateManager: ProcessingStateManager;
  readonly contextTracker: ContextTracker;
  readonly messageQueue: MessageQueue;

  // Dependencies for circuit breaker trip handling
  readonly errorManager: ErrorManager;
  readonly lifecycleManager: QueryLifecycleManager;

  // Mutable query state (needed to check if query is running and to call getContextUsage())
  queryObject: QueryLike | null;
  queryPromise: Promise<void> | null;

  // Called when the SDK init message provides the full slash commands list
  onInitSlashCommands: (commands: string[]) => Promise<void>;

  // Called when the SDK pushes a mid-session slash command replacement list
  onCommandsChanged: (commands: string[]) => Promise<void>;
}

type PersistedUserMessage = SDKMessage & { dbId: string; timestamp: number };

export class SDKMessageHandler {
  private sdkMessageDeltaVersion: number = 0;
  private logger: Logger;
  private contextFetcher: ContextFetcher;
  private circuitBreaker: ApiErrorCircuitBreaker;
  private acknowledgedPersistedUserThisTurn: boolean = false;
  // Delivery-lifecycle: the consumed message UUIDs that have already received
  // first_progress in this turn. Tracked per ID (not a batch boolean) so a
  // post-progress steer — a later message consumed after the first assistant
  // output — records first_progress only for the NEWLY consumed message, and
  // does not append a duplicate first_progress for messages that already got it.
  // Cleared at terminal. See task #859 (8506 + round-5 P2).
  private deliveryFirstProgressIds: Set<string> = new Set();
  // Delivery-lifecycle: every message UUID consumed since the last terminal
  // result. A single SDK turn can consume several steered messages before one
  // terminal result ends it; the terminal event (completed/failed) must be
  // attributed to ALL of them, not just the latest activeMessageId, or the
  // earlier ones show as stale forever. Cleared on terminal. See task #859 F2.
  private deliveryTurnConsumedIds: Set<string> = new Set();
  private usesSessionStateChangedTurnEnd: boolean = false;
  private expectsSessionStateIdleAfterResult: boolean = false;
  private lastResultWasSuccess: boolean | null = null;
  // Set by AgentSession.clearConversationContext before issuing an in-stream
  // /clear. That turn never sets processing (the generator skips setProcessing
  // for internal messages), so its result would otherwise publish a spurious
  // idle→idle and fire the one-shot node-agent completion callback before the
  // cleared handoff is reviewed. Consume on the next result to make that
  // setIdle a no-op; the handoff's own genuine processing→idle completes the
  // turn.
  private suppressIdleOnNextResult: boolean = false;

  // Count of SDK stream events seen since the last context-usage refresh.
  // Resets whenever we call refreshContextUsage() (on 5-event tick, turn end,
  // or compaction) so that back-to-back triggers don't double-fetch.
  private eventsSinceContextRefresh: number = 0;

  // In-flight context refresh (deduped across event/turn-end/compact triggers)
  private pendingContextRefresh: Promise<void> | null = null;

  // Latest turn-level thinking tokens estimate from the SDK. For providers that
  // emit a cumulative running total, this is the cumulative value, NOT a
  // per-block count.
  private currentThinkingTokensEstimate: number | null = null;
  // Cumulative amount already attributed to persisted assistant thinking blocks
  // in the current turn. The delta between current and last stamped is what we
  // persist on each new thinking block.
  private lastStampedThinkingTokensEstimate: number = 0;

  /** Guardrail that breaks repeated identical tool-use errors in Forge task sessions. */
  private repeatedToolErrorGuardrail: RepeatedToolErrorGuardrail;

  constructor(private ctx: SDKMessageHandlerContext) {
    const { session } = ctx;
    this.logger = new Logger(`SDKMessageHandler ${session.id}`);
    this.contextFetcher = new ContextFetcher(session.id);
    this.circuitBreaker = new ApiErrorCircuitBreaker(session.id);

    // Set up circuit breaker callback - fully internalized
    this.circuitBreaker.setOnTripCallback(async (reason, _errorCount) => {
      const userMessage = this.circuitBreaker.getTripMessage();
      await this.handleCircuitBreakerTrip(reason, userMessage);
    });

    // Set up message yield callback - fires when generator yields to SDK
    // This is the CORRECT moment to broadcast steered messages to UI
    // and update their DB timestamp (T_consumed, not T_end)
    ctx.messageQueue.onMessageYielded = (messageId: string, consumedAt: number) => {
      this.handleMessageYielded(messageId, consumedAt);
    };

    // Delivery-lifecycle: a message entering the in-memory queue is "accepted"
    // (the daemon has claimed responsibility for delivering it). Internal
    // messages (recovery/tool-result echoes) are not tracked. The ACP runner
    // wraps this callback and forwards to it, so this fires for both runners.
    ctx.messageQueue.onMessageEnqueued = (
      messageId: string,
      _queuedAt: number,
      internal: boolean
    ) => {
      if (internal) return;
      this.recordDelivery(messageId, 'accepted');
    };

    // Delivery-lifecycle: clear() fires on interrupt/reset/stop (and the
    // circuit-breaker trip, whose set F5 already cleared). Any message consumed
    // this turn that never reached a terminal result is failed as interrupted
    // and the turn's consumed set is cleared, so it cannot leak into the next
    // turn's completion. See task #859 N4.
    ctx.messageQueue.onClear = (reason) => {
      // A retry-pending teardown (rate-limit cooldown the watchdog re-enqueues)
      // is not a terminal for the turn — leave the consumed set intact so the
      // retried delivery can still record first_progress/completed (round-5 P2).
      if (reason === 'retry_pending') return;
      this.recordDeliveryTerminal('failed', { reason: 'interrupted' });
    };

    this.repeatedToolErrorGuardrail = new RepeatedToolErrorGuardrail({
      getTaskForSession: () => {
        try {
          const repo = this.ctx.db?.getSpaceTaskRepo();
          if (!repo) return null;

          // Legacy task-agent sessions store the task directly on the session row.
          const task = repo.getTaskBySessionId(this.ctx.session.id);
          if (task) return task;

          // Worker/node-agent sessions carry the task id in session context.
          const taskId = this.ctx.session.context?.taskId;
          if (taskId) return repo.getTask(taskId);

          return null;
        } catch (err) {
          this.logger.warn('Failed to resolve task for repeated-tool-error guardrail:', err);
          return null;
        }
      },
      emitEvidence: (params) => {
        try {
          const repo = this.ctx.db?.getSpaceTaskRepo();
          if (!repo) return undefined;

          const task =
            repo.getTaskBySessionId(this.ctx.session.id) ??
            (this.ctx.session.context?.taskId
              ? repo.getTask(this.ctx.session.context.taskId)
              : null);
          if (!task) return undefined;

          return this.ctx.db?.evolution.createEvidence({
            scopeId: params.scopeId,
            kind: 'conversation_friction',
            sourceId: task.id,
            summary: params.summary,
            metadata: params.metadata,
          });
        } catch (err) {
          this.logger.warn('Failed to create conversation_friction evidence:', err);
          return undefined;
        }
      },
      routeRecoveryMessage: (text) => {
        // Route the recovery through the active message queue so the running SDK
        // turn actually receives the instruction, instead of only displaying a
        // synthetic assistant frame in the UI. internal:true — this is a daemon
        // recovery instruction, not a tracked user-message delivery (N8).
        void this.ctx.messageQueue.enqueue(text, true).catch((err) => {
          this.logger.warn('Failed to enqueue repeated tool error recovery message:', err);
        });
      },
    });
  }

  /**
   * Reset the circuit breaker (after manual reset or successful recovery)
   */
  resetCircuitBreaker(): void {
    this.circuitBreaker.reset();
  }

  /**
   * Arm idle suppression for the next result message. Used by
   * `AgentSession.clearConversationContext()` so the in-stream `/clear` turn's
   * result does not publish a spurious idle (see `suppressIdleOnNextResult`).
   */
  suppressIdleForNextResult(): void {
    this.suppressIdleOnNextResult = true;
  }

  /**
   * Release an armed suppression without consuming it — for the enqueue-failure
   * path, where no `/clear` turn actually ran.
   */
  clearIdleSuppression(): void {
    this.suppressIdleOnNextResult = false;
  }

  /**
   * Mark successful API interaction (resets error tracking)
   */
  markApiSuccess(): void {
    this.circuitBreaker.markSuccess();
  }

  /**
   * Handle circuit breaker trip (error loop detected)
   *
   * This is called when the circuit breaker detects repeated API errors.
   * It stops the session and displays an error message to the user.
   * Unlike normal reset, this does NOT:
   * - Preserve cost tracking
   * - Restart the query
   * - Publish session.reset notification
   */
  private async handleCircuitBreakerTrip(reason: string, userMessage: string): Promise<void> {
    const {
      session,
      stateManager,
      messageQueue,
      internalEventBus,
      errorManager,
      lifecycleManager,
    } = this.ctx;

    try {
      // Delivery-lifecycle: record the circuit-breaker terminal for every
      // consumed message BEFORE clearing the queue. clear() fires onClear
      // (which records 'interrupted' + clears the set); recording here first
      // attributes the correct reason to all shared-turn IDs and avoids the
      // onClear path double-recording. See task #859 round-4 (8509).
      this.recordDeliveryTerminal('failed', { reason: 'circuit_breaker_trip' });
      // Clear state before stopping
      messageQueue.clear();
      this.resetCircuitBreaker();
      await internalEventBus.publish('session.errorClear', {
        sessionId: session.id,
      });

      // Stop the query (if running)
      if (this.ctx.queryObject || this.ctx.queryPromise) {
        await lifecycleManager.stop({ catchQueryErrors: true });
      }

      // Reset to idle state
      await stateManager.setIdle();

      // Display error message as assistant message
      await this.displayErrorAsAssistantMessage(
        `⚠️ **Session Stopped: Error Loop Detected**\n\n${userMessage}\n\n` +
          `The agent has been automatically stopped to prevent further errors.`
      );

      // Report to error manager
      await errorManager.handleError(
        session.id,
        new Error(`Circuit breaker tripped: ${reason}`),
        ErrorCategory.SYSTEM,
        userMessage,
        stateManager.getState(),
        { circuitBreakerReason: reason }
      );
    } catch (error) {
      this.logger.error('Error handling circuit breaker trip:', error);
      await stateManager.setIdle();
    }
  }

  /**
   * Display error as synthetic assistant message
   *
   * Creates and persists an assistant message to show errors in the chat UI.
   */
  private async displayErrorAsAssistantMessage(text: string): Promise<void> {
    const { session, db, messageHub } = this.ctx;

    const assistantMessage = {
      type: 'assistant' as const,
      uuid: generateUUID() as UUID,
      session_id: session.id,
      parent_tool_use_id: null,
      message: {
        role: 'assistant' as const,
        content: [{ type: 'text' as const, text, citations: null }],
      },
    } as unknown as SDKMessage;

    db.saveSDKMessage(session.id, assistantMessage);

    messageHub.event(
      'state.sdkMessages.delta',
      { added: [assistantMessage], timestamp: Date.now() },
      { channel: `session:${session.id}` }
    );
  }

  private withDbChangeBatch<T>(operation: () => T): T {
    const { db } = this.ctx;
    if (!db.beginTransaction || !db.commitTransaction || !db.abortTransaction) {
      return operation();
    }

    db.beginTransaction();
    try {
      const result = operation();
      db.commitTransaction();
      return result;
    } catch (error) {
      db.abortTransaction();
      throw error;
    }
  }

  /**
   * Acknowledge a persisted user message when SDK replays it.
   *
   * For user messages already persisted in sdk_messages with send_status
   * (enqueued/deferred), we should:
   * 1) transition send_status -> consumed
   * 2) publish the user message to transcript
   * 3) avoid inserting a duplicate SDK message row
   */
  private async acknowledgePersistedUserMessage(message: SDKMessage): Promise<boolean> {
    const { session, db } = this.ctx;
    if (message.type !== 'user' || !message.uuid) {
      return false;
    }

    const enqueuedMessage = db.getMessageByStatusAndUuid(session.id, 'enqueued', message.uuid);
    if (enqueuedMessage) {
      await this.consumePersistedUserMessage(enqueuedMessage, message);
      return true;
    }

    const deferredMessage = db.getMessageByStatusAndUuid(session.id, 'deferred', message.uuid);
    if (deferredMessage) {
      await this.consumePersistedUserMessage(deferredMessage, message);
      return true;
    }

    const consumedMessage = db.getMessageByStatusAndUuid(session.id, 'consumed', message.uuid);
    if (consumedMessage) {
      // Retry re-delivery of an already-consumed message: re-register it as
      // consumed so the retry turn can record first_progress/completed. Without
      // this, a replayed already-'consumed' row would be attributed to no turn
      // and stall at accepted. Class-level fix (task #859 round-6 P2).
      this.recordDeliveryConsumed(message.uuid);
      this.acknowledgedPersistedUserThisTurn = true;
      return true;
    }

    return false;
  }

  private async consumePersistedUserMessage(
    persistedMessage: PersistedUserMessage,
    sdkReplayMessage: SDKMessage
  ): Promise<void> {
    const { session, db, internalEventBus, messageHub } = this.ctx;

    this.recordDeliveryConsumed(extractSdkUuid(persistedMessage));
    this.withDbChangeBatch(() => {
      db.updateMessageStatus([persistedMessage.dbId], 'consumed');
      // Update DB timestamp to now so the message's position in the DB matches
      // where the SDK placed it in the conversation (after already-streamed
      // assistant messages), not when the user originally typed it.
      db.updateMessageTimestamp(persistedMessage.dbId);
    });

    await internalEventBus.publish('messages.statusChanged', {
      sessionId: session.id,
      messageIds: [persistedMessage.dbId],
      status: 'consumed',
    });
    this.acknowledgedPersistedUserThisTurn = true;

    messageHub.event(
      'state.sdkMessages.delta',
      {
        added: [sdkReplayMessage],
        timestamp: Date.now(),
        version: ++this.sdkMessageDeltaVersion,
      },
      { channel: `session:${session.id}` }
    );

    // Emit on InternalEventBus<DaemonInternalEventMap> for server-side listeners (e.g. group message mirroring)
    // so pre-persisted user messages appear in the group timeline.
    await internalEventBus.publish('sdk.message', {
      sessionId: session.id,
      message: sdkReplayMessage,
    });
    await this.publishToolResultConsumedEvents(sdkReplayMessage);
  }

  /**
   * Fallback acknowledgment when SDK doesn't replay user messages.
   * Marks ALL remaining enqueued user messages as consumed at turn end.
   *
   * This is a safety net — ideally handleMessageYielded already handled
   * these at yield time. But if the generator didn't fire the callback
   * (e.g., internal messages, edge cases), this ensures messages don't
   * stay stuck in 'enqueued' status forever.
   */
  private async acknowledgeOldestQueuedUserOnTurnEnd(): Promise<void> {
    const { session, db, internalEventBus, messageHub } = this.ctx;
    const enqueuedUsers = db
      .getMessagesByStatus(session.id, 'enqueued')
      .filter((enqueued) => isSDKUserMessage(enqueued));

    // Strictly-increasing consumedAt across the loop so two prompts consumed in
    // the same millisecond don't share a timestamp — rewind checkpoints are
    // identified by timestamp, so a tie would let a rewind to the later prompt
    // also delete the earlier one (#2338).
    let lastConsumedAt = 0;
    for (const enqueuedUser of enqueuedUsers) {
      let consumedAt = Date.now();
      if (consumedAt <= lastConsumedAt) consumedAt = lastConsumedAt + 1;
      lastConsumedAt = consumedAt;
      db.updateMessageStatus([enqueuedUser.dbId], 'consumed');
      // #2338: updateMessageStatus reassigns this message a fresh conversation
      // turn (MAX+1) on consume. Align the timestamp to the consume time so the
      // compact feed's createdAt ordering agrees with the new turn order —
      // otherwise the row keeps its original typed time (mid prior turn) but a
      // future turn index, rendering before the result that closed the prior
      // turn. Mirrors the normal SDK-replay consume path's
      // updateMessageTimestamp(consumedAt).
      db.updateMessageTimestamp(enqueuedUser.dbId, consumedAt);
      await internalEventBus.publish('messages.statusChanged', {
        sessionId: session.id,
        messageIds: [enqueuedUser.dbId],
        status: 'consumed',
      });
      this.recordDeliveryConsumed(extractSdkUuid(enqueuedUser));

      // Broadcast the replayed message at consumedAt (not the original typed
      // time captured on enqueuedUser) so the live session-store delta places
      // it at its new turn position, matching the persisted timestamp and the
      // compact feed — otherwise it stays at its mid-run spot until a DB reload
      // (#2338).
      const { dbId: _dbId, timestamp: _oldTs, ...sdkUserMessage } = enqueuedUser;
      const replayedMessage = {
        ...sdkUserMessage,
        timestamp: new Date(consumedAt).toISOString(),
      } as SDKMessage;
      messageHub.event(
        'state.sdkMessages.delta',
        {
          added: [replayedMessage],
          timestamp: Date.now(),
          version: ++this.sdkMessageDeltaVersion,
        },
        { channel: `session:${session.id}` }
      );
      await this.publishToolResultConsumedEvents(replayedMessage);
    }

    // These fallback-acknowledged messages were delivered this turn (the SDK
    // consumed them via the generator without replaying). The turn's main
    // `completed` block already ran and cleared the consumed set, so the set
    // now holds exactly these fallback IDs — terminalize them so their latest
    // stage isn't `consumed` (which would read as stale). See task #859 N1.
    if (enqueuedUsers.length > 0) {
      this.recordDeliveryTerminal('completed', { success: true });
    }
  }

  /**
   * Record a delivery-lifecycle stage. Defensive: a missing repo (e.g. in tests
   * with a partial mock DB) or empty messageId is a silent no-op — observability
   * must never break message handling. The repo's own record() is also
   * best-effort (swallows DB errors).
   */
  private recordDelivery(
    messageId: string | null | undefined,
    stage: MessageDeliveryStage,
    detail?: Record<string, unknown>
  ): void {
    if (!messageId) return;
    const repo = this.ctx.db?.messageDeliveryLifecycle;
    if (!repo) return;
    repo.record(this.ctx.session.id, messageId, stage, detail);
  }

  /**
   * Record the `consumed` delivery-lifecycle stage (SDK accepted the message),
   * add it to the current turn's consumed set, and reset the per-turn
   * first-progress guard so each turn records its own first_progress.
   * Idempotent-safe: append-only ledger tolerates repeats.
   */
  private recordDeliveryConsumed(messageId: string | null | undefined): void {
    this.recordDelivery(messageId, 'consumed');
    if (messageId) {
      this.deliveryTurnConsumedIds.add(messageId);
    }
  }

  /**
   * Record a terminal lifecycle stage for every message consumed in the current
   * turn (plus the active message), then clear the turn's consumed set. A shared
   * SDK turn can consume multiple steered messages before one terminal result,
   * so attributing completion/failure to only the latest would leave the others
   * looking stale. See task #859 F2/F5.
   */
  private recordDeliveryTerminal(
    stage: 'completed' | 'failed',
    detail?: Record<string, unknown>
  ): void {
    // Terminalize only IDs actually consumed this turn (the set). We do NOT add
    // activeMessageId: for an AskUserQuestion turn the processing messageId is a
    // tool-use ID, not a tracked delivery, and would create a phantom timeline.
    // See task #859 round-4 (8503).
    for (const id of this.deliveryTurnConsumedIds) {
      this.recordDelivery(id, stage, detail);
    }
    this.deliveryTurnConsumedIds.clear();
    this.deliveryFirstProgressIds.clear();
  }

  /**
   * Handle message yielded by the generator to the SDK.
   *
   * This fires at the EXACT moment the SDK receives a enqueued user message
   * (T_consumed). We update the DB and broadcast to UI here, so the message
   * appears at the correct position in the conversation — after any assistant
   * messages that were already streamed, and before the assistant's response
   * to the steering.
   */
  private handleMessageYielded(messageId: string, consumedAt: number): void {
    const { session, db, internalEventBus, messageHub } = this.ctx;

    // Find the persisted message in DB by UUID without scanning every queued row.
    const enqueuedMessage = db.getMessageByStatusAndUuid(session.id, 'enqueued', messageId);
    if (!enqueuedMessage) {
      // Could be a 'deferred' message being replayed
      const deferredMessage = db.getMessageByStatusAndUuid(session.id, 'deferred', messageId);
      if (!deferredMessage) {
        // A retry re-yields a message whose DB status is already 'consumed'
        // (the timeout/cooldown clear didn't flip it). Re-register so the retry
        // turn can record first_progress/completed — otherwise nothing is
        // attributed to it and it stalls at accepted. Class-level fix: re-register
        // on every re-delivery, closing rate-limit + queue-timeout + future
        // retry paths at once (task #859 round-6 P2).
        const consumedRetry = db.getMessageByStatusAndUuid(session.id, 'consumed', messageId);
        if (consumedRetry) {
          this.recordDeliveryConsumed(messageId);
          this.acknowledgedPersistedUserThisTurn = true;
        }
        return; // Not a persisted user message being delivered
      }
      // Handle deferred message the same way
      this.recordDeliveryConsumed(messageId);
      this.withDbChangeBatch(() => {
        db.updateMessageStatus([deferredMessage.dbId], 'consumed');
        db.updateMessageTimestamp(deferredMessage.dbId, consumedAt);
      });
      internalEventBus
        .publish('messages.statusChanged', {
          sessionId: session.id,
          messageIds: [deferredMessage.dbId],
          status: 'consumed',
        })
        .catch(() => {});
      this.acknowledgedPersistedUserThisTurn = true;

      const { dbId: _dbId, timestamp: _timestamp, ...sdkMessage } = deferredMessage;
      messageHub.event(
        'state.sdkMessages.delta',
        {
          added: [{ ...sdkMessage, timestamp: consumedAt }],
          timestamp: consumedAt,
          version: ++this.sdkMessageDeltaVersion,
        },
        { channel: `session:${session.id}` }
      );
      internalEventBus
        .publish('sdk.message', {
          sessionId: session.id,
          // Cast needed: DB injects epoch-ms timestamp while SDK uses ISO string on user msgs
          message: { ...sdkMessage, timestamp: consumedAt } as unknown as SDKMessage,
        })
        .catch(() => {});
      this.publishToolResultConsumedEvents({
        ...sdkMessage,
        timestamp: consumedAt,
      } as unknown as SDKMessage).catch(() => {});
      return;
    }

    // Update status and timestamp in DB
    this.recordDeliveryConsumed(messageId);
    this.withDbChangeBatch(() => {
      db.updateMessageStatus([enqueuedMessage.dbId], 'consumed');
      db.updateMessageTimestamp(enqueuedMessage.dbId, consumedAt);
    });

    // Emit status change event (for queue overlay polling)
    internalEventBus
      .publish('messages.statusChanged', {
        sessionId: session.id,
        messageIds: [enqueuedMessage.dbId],
        status: 'consumed',
      })
      .catch(() => {});

    // Mark as acknowledged so fallback path doesn't fire again
    this.acknowledgedPersistedUserThisTurn = true;

    // Broadcast to UI with the correct timestamp
    // Strip DB-only fields before broadcasting
    const { dbId: _dbId, timestamp: _timestamp, ...sdkMessage } = enqueuedMessage;
    messageHub.event(
      'state.sdkMessages.delta',
      {
        added: [{ ...sdkMessage, timestamp: consumedAt }],
        timestamp: consumedAt,
        version: ++this.sdkMessageDeltaVersion,
      },
      { channel: `session:${session.id}` }
    );

    // Emit on InternalEventBus<DaemonInternalEventMap> for server-side listeners (e.g. group message mirroring)
    // so injected user messages (like leader envelope) appear in the group timeline.
    internalEventBus
      .publish('sdk.message', {
        sessionId: session.id,
        // Cast needed: DB injects epoch-ms timestamp while SDK uses ISO string on user msgs
        message: { ...sdkMessage, timestamp: consumedAt } as unknown as SDKMessage,
      })
      .catch(() => {});
    this.publishToolResultConsumedEvents({
      ...sdkMessage,
      timestamp: consumedAt,
    } as unknown as SDKMessage).catch(() => {});
  }

  /**
   * Main entry point - handle incoming SDK message
   *
   * NOTE: Stream events removed - the SDK's query() with AsyncGenerator yields
   * complete messages, not incremental stream_event tokens.
   */
  async handleMessage(message: SDKMessage): Promise<void> {
    const { session, db, messageHub, stateManager } = this.ctx;

    // Check for API error patterns that indicate an infinite loop
    // This MUST happen BEFORE any other processing to catch errors early
    const circuitBreakerTripped = await this.circuitBreaker.checkMessage(message);
    if (circuitBreakerTripped) {
      // Circuit breaker tripped - skip normal processing. The trip callback
      // (handleCircuitBreakerTrip) records the failed terminal for the turn's
      // consumed IDs before clearing the queue. See task #859 round-4 (8509).
      return;
    }

    // Handle API retry messages: emit event for UI to display retry progress
    // These carry operational metadata (attempt count, delay, error) that is useful for
    // debugging and user feedback.
    if (isSDKAPIRetryMessage(message)) {
      this.logger.warn(
        `API retry: attempt ${message.attempt}/${message.max_retries}, ` +
          `delay ${message.retry_delay_ms}ms, status ${message.error_status ?? 'n/a'}, ` +
          `error ${message.error}`
      );
      // Emit event for UI to show retry progress
      await this.ctx.internalEventBus.publish('session.retryAttempt', {
        sessionId: session.id,
        attempt: message.attempt,
        max_retries: message.max_retries,
        delay_ms: message.retry_delay_ms,
        error_status: message.error_status,
        error: message.error,
      });
      // DO NOT return - let it fall through to persistence and rendering
    }

    // Handle thinking tokens messages: stash the latest cumulative estimate for
    // the current turn, but do not persist or broadcast the event itself.
    // These fire frequently during the redacted thinking phase and would bloat
    // the DB if persisted. The per-block delta is computed and stamped when an
    // assistant message containing a thinking block arrives.
    if (isSDKThinkingTokensMessage(message)) {
      const estimate = message.estimated_tokens;
      // Heuristic: treat a drop in the cumulative estimate as a new thinking-block
      // boundary. Non-decreasing values are treated as the same stream so the
      // delta since the last stamped block is attributed correctly. This handles
      // both the stuck-cumulative task-agent case (e.g. #614) and per-block resets
      // where the next block starts lower than the previous block's final total.
      if (
        this.lastStampedThinkingTokensEstimate > 0 &&
        estimate < this.lastStampedThinkingTokensEstimate
      ) {
        this.lastStampedThinkingTokensEstimate = 0;
      }
      this.currentThinkingTokensEstimate = estimate;
      return; // Skip persistence and broadcast - this is internal tracking only
    }

    // Delivery-lifecycle: record progress/completion ON RECEIPT, before any of
    // the fallible paths below (detectPhaseFromMessage's session.updated publish,
    // saveSDKMessage, message publish). Otherwise a received result whose
    // phase publish rejects or whose saveSDKMessage returns false (e.g. late FTS
    // failure) would exit early and leave the turn stuck at `consumed`, which the
    // query error path then mis-reports as `failed`/`interrupted` — despite the
    // turn actually having been delivered (N11 + round-5 P2). This block only
    // acts on assistant/result messages, so persisting it ahead of phase
    // detection is safe.
    if (isSDKAssistantMessage(message) && this.deliveryTurnConsumedIds.size > 0) {
      // Attribute first progress to every consumed message in the shared turn
      // that hasn't already received it — not just the latest (otherwise an
      // earlier steered message lacks first_progress and drops out of the
      // acceptToFirstProgress latency, 8506), and NOT again to messages that
      // already got first_progress before a post-progress steer (round-5 P2).
      for (const id of this.deliveryTurnConsumedIds) {
        if (!this.deliveryFirstProgressIds.has(id)) {
          this.recordDelivery(id, 'first_progress');
          this.deliveryFirstProgressIds.add(id);
        }
      }
    }
    if (isSDKResultMessage(message)) {
      this.recordDeliveryTerminal('completed', {
        success: isSDKResultSuccess(message),
      });
    }

    // Automatically update phase based on message type
    await stateManager.detectPhaseFromMessage(message);

    // For persisted user messages, mark consumed + publish now and skip duplicate DB inserts.
    if (await this.acknowledgePersistedUserMessage(message)) {
      this.maybeRefreshContextOnEvent(message);
      return;
    }

    // Mark unmatched SDK user messages as synthetic.
    if (message.type === 'user') {
      (message as SDKUserMessage & { isSynthetic: boolean }).isSynthetic = true;
    }

    // Ensure messages with a nested BetaMessage have a usage object to
    // prevent SDK crashes. The Claude Agent SDK's internal functions
    // access message.usage.input_tokens without null-checking. When the
    // SDK subprocess is restarted and reloads conversation history from
    // the daemon, messages without usage cause:
    //   "undefined is not an object (evaluating 'K.input_tokens')"
    if (
      'message' in message &&
      message.message &&
      !(message.message as unknown as Record<string, unknown>).usage
    ) {
      (message.message as unknown as Record<string, unknown>).usage = {
        input_tokens: 0,
        output_tokens: 0,
        cache_creation_input_tokens: 0,
        cache_read_input_tokens: 0,
      };
    }

    // Stamp the per-block thinking tokens delta onto assistant messages that
    // contain a thinking block. The SDK emits a cumulative turn-level estimate,
    // which can be split across many assistant messages in task-agent sessions.
    // Persisting the delta since the last stamped block avoids repeating the
    // same cumulative count on every block. If the delta is not positive
    // (stale/zero/negative), omit the field so the UI falls back to character
    // counts only.
    if (isSDKAssistantMessage(message) && this.currentThinkingTokensEstimate !== null) {
      const hasThinkingBlock = message.message.content.some(
        (block: unknown) => (block as Record<string, unknown>).type === 'thinking'
      );
      if (hasThinkingBlock) {
        const delta = this.currentThinkingTokensEstimate - this.lastStampedThinkingTokensEstimate;
        if (delta > 0) {
          (message as Record<string, unknown>).estimated_thinking_tokens = delta;
          this.lastStampedThinkingTokensEstimate = this.currentThinkingTokensEstimate;
        }
      }
    }

    // Save to DB FIRST before broadcasting to clients
    // This ensures we only broadcast messages that are successfully persisted
    const deferredSuccessfully = this.withDbChangeBatch(() =>
      db.saveSDKMessage(session.id, message)
    );

    if (!deferredSuccessfully) {
      // Log warning but continue - message is already in SDK's memory
      this.logger.warn(`Failed to save message to DB (type: ${message.type})`);
      // Don't broadcast to clients if DB save failed
      return;
    }

    // Broadcast SDK message delta to frontend clients
    messageHub.event(
      'state.sdkMessages.delta',
      {
        added: [message],
        timestamp: Date.now(),
        version: ++this.sdkMessageDeltaVersion,
      },
      { channel: `session:${session.id}` }
    );

    // Emit on InternalEventBus<DaemonInternalEventMap> for server-side listeners (e.g. conversation session mirroring)
    await this.ctx.internalEventBus.publish('sdk.message', {
      sessionId: session.id,
      message,
    });

    if (isSDKSessionStateChangedMessage(message)) {
      this.usesSessionStateChangedTurnEnd = true;
      if (message.state !== 'idle') {
        this.expectsSessionStateIdleAfterResult = true;
      }
    }

    // Delivery-lifecycle: first assistant output + terminal completion are
    // recorded on receipt above (before saveSDKMessage/publish), so a fallible
    // save/publish can't strand a turn at `consumed`. See N11.

    // Terminal messages end the turn even when they represent errors.
    // Clear stale waiting_for_input state before type-specific handling so
    // interrupted AskUserQuestion turns cannot keep the composer locked.
    if (isSDKResultMessage(message) && !this.usesSessionStateChangedTurnEnd) {
      if (!this.suppressIdleOnNextResult) {
        await stateManager.setIdle();
      }
      // When armed (in-stream /clear), skip setIdle here AND finishTurn below
      // — that turn never set processing (internal message), so an idle publish
      // would fire the one-shot node-agent completion callback before the
      // cleared handoff is reviewed. The flag is consumed at finishTurn.
    }

    if (isSDKResultMessage(message)) {
      this.lastResultWasSuccess = isSDKResultSuccess(message);
      // Reset turn-level thinking token tracking now, before any turn-end
      // handler can trigger an immediate queued turn replay.
      this.resetThinkingTokenTracking();
    }

    // Handle specific message types
    if (isSDKUserMessage(message)) {
      await this.handleUserMessage(message);
    }

    if (isSDKSystemMessage(message)) {
      await this.handleSystemMessage(message);
    }

    if (isSDKResultSuccess(message)) {
      await this.handleResultMessage(message);
    }

    if (isSDKAssistantMessage(message)) {
      await this.handleAssistantMessage(message);
    }

    if (isSDKStatusMessage(message)) {
      await this.handleStatusMessage(message);
    }

    if (isSDKModelRefusalFallbackMessage(message)) {
      await this.handleModelRefusalFallbackMessage(message);
    }

    if (isSDKSessionStateChangedMessage(message)) {
      await this.handleSessionStateChangedMessage(message);
    }

    if (isSDKCompactBoundary(message)) {
      await this.handleCompactBoundary(message);
    }

    // Turn-end context refresh: any result message (success or error
    // termination — error_during_execution, error_max_turns, etc.)
    // triggers a fetch, so short turns still update context once.
    // The 5-event tick below is deduped via pendingContextRefresh.
    if (isSDKResultMessage(message)) {
      void this.refreshContextUsage('turn-end');
      return;
    }

    // Stream-event cadence for context refresh: every N events we've seen
    // in this session (user/assistant/tool-use/tool-result etc.).
    this.maybeRefreshContextOnEvent(message);
  }

  /**
   * Handle system message (capture SDK session ID and slash commands)
   */
  private async handleSystemMessage(message: SDKMessage): Promise<void> {
    const { session, db, internalEventBus } = this.ctx;

    if (!isSDKSystemMessage(message)) return;

    // A new SDK query/session starts with an init message. Reset any stale
    // turn-level thinking counters left over from a previously interrupted or
    // stopped turn so they cannot undercount the new query's first block.
    if (isSDKSystemInit(message)) {
      this.resetThinkingTokenTracking();
    }

    // Capture the SDK's internal session id whenever an init reports a different
    // one than we hold. The SDK rotates to a fresh session on `/clear`
    // (resetContextPerTurn "fresh eyes") and on model-switch/error restarts, and
    // emits a new init with the new id — capturing it keeps daemon-restart resume
    // pointing at the live conversation instead of a stale, pre-clear one. Guard
    // on isSDKSystemInit so other system subtypes (api_retry, status, …) that
    // also carry session_id cannot overwrite this field.
    if (
      isSDKSystemInit(message) &&
      message.session_id &&
      session.sdkSessionId !== message.session_id
    ) {
      // Update in-memory session
      session.sdkSessionId = message.session_id;

      // Record the workspace path used as CWD when this SDK session was created.
      // The SDK stores conversation files at:
      //   ~/.claude/projects/{encoded-cwd}/{sdkSessionId}.jsonl
      // Persisting this "origin path" allows the daemon to locate and migrate the
      // session file on resume even when the effective CWD changes (e.g. a worktree
      // is added or removed between daemon restarts).
      const sdkOriginPath = session.worktree?.worktreePath ?? session.workspacePath ?? undefined;
      session.sdkOriginPath = sdkOriginPath;

      // Persist to database
      db.updateSession(session.id, {
        sdkSessionId: message.session_id,
        sdkOriginPath,
      });

      // Emit session.updated event so StateManager broadcasts the change
      // Include data for decoupled state management
      await internalEventBus.publish('session.updated', {
        sessionId: session.id,
        source: 'sdk-session',
        session: { sdkSessionId: message.session_id, sdkOriginPath },
      });
    }

    // Capture the full slash commands list from the init message.
    // This is the authoritative source — it includes all SDK built-ins plus
    // any custom skills, and fires immediately when a query starts.
    // Use isSDKSystemInit which narrows specifically to SDKSystemMessage (subtype: 'init').
    if (isSDKSystemInit(message) && message.slash_commands?.length > 0) {
      await this.ctx.onInitSlashCommands(message.slash_commands);
    }

    if (isSDKCommandsChangedMessage(message)) {
      await this.ctx.onCommandsChanged(flattenSDKSlashCommands(message.commands));
    }
  }

  /**
   * Handle result message (end of turn)
   */
  private async handleResultMessage(message: SDKMessage): Promise<void> {
    const { session, db, internalEventBus } = this.ctx;

    // Type guard to ensure this is a successful result
    if (!isSDKResultSuccess(message)) return;

    // Update session metadata with token usage and costs
    // Guard: SDK may produce result messages without usage (e.g. bridge providers
    // like anthropic-copilot where the upstream SDK fails to populate usage).
    const usage = message.usage ?? {
      input_tokens: 0,
      output_tokens: 0,
      cache_creation_input_tokens: 0,
      cache_read_input_tokens: 0,
    };
    const totalTokens = usage.input_tokens + usage.output_tokens;

    // SDK's total_cost_usd is CUMULATIVE within a single run, but RESETS when agent restarts
    // (e.g., after errors or manual reset). We detect resets by comparing to lastSdkCost.
    // Example sequence: 0.42 -> 0.73 -> 1.1 (cumulative) -> RESET -> 0.25 -> 0.50 (cumulative again)
    const sdkCost = message.total_cost_usd || 0;
    const lastSdkCost = session.metadata?.lastSdkCost || 0;
    const costBaseline = session.metadata?.costBaseline || 0;

    // Detect SDK reset: if current cost < last cost, SDK was restarted
    // Save previous cumulative cost as new baseline
    let newCostBaseline = costBaseline;
    if (sdkCost < lastSdkCost && lastSdkCost > 0) {
      // SDK reset detected - add previous SDK cost to baseline
      newCostBaseline = costBaseline + lastSdkCost;
    }

    // Total cost = baseline (from previous runs) + current SDK cost (cumulative within this run)
    const totalCost = newCostBaseline + sdkCost;

    session.lastActiveAt = new Date().toISOString();
    session.metadata = {
      ...session.metadata,
      messageCount: (session.metadata?.messageCount || 0) + 1,
      totalTokens: (session.metadata?.totalTokens || 0) + totalTokens,
      inputTokens: (session.metadata?.inputTokens || 0) + usage.input_tokens,
      outputTokens: (session.metadata?.outputTokens || 0) + usage.output_tokens,
      // Total cost across all runs (baseline + current SDK cumulative)
      totalCost,
      toolCallCount: session.metadata?.toolCallCount || 0,
      // Track SDK state for reset detection
      lastSdkCost: sdkCost,
      costBaseline: newCostBaseline,
    };

    db.updateSession(session.id, {
      lastActiveAt: session.lastActiveAt,
      metadata: session.metadata,
    });

    // Emit session.updated event so StateManager broadcasts the change
    // Include data for decoupled state management
    await internalEventBus.publish('session.updated', {
      sessionId: session.id,
      source: 'metadata',
      session: {
        lastActiveAt: session.lastActiveAt,
        metadata: session.metadata,
      },
    });

    // NOTE: Turn-end context refresh is triggered for all `result`
    // messages (success + error) at the end of handleMessage(), before
    // this success-only branch runs. No need to re-fetch here.

    // Mark successful API interaction - resets circuit breaker error tracking
    // Only reset when actual tokens were consumed (indicating a real API call)
    // Zero-token results happen when SDK processes synthetic error messages without
    // making an API call - these should NOT reset the circuit breaker
    if (usage.input_tokens > 0 || usage.output_tokens > 0) {
      this.circuitBreaker.markSuccess();
    }

    // If SDK didn't replay the enqueued user message this turn, acknowledge one
    // enqueued user message at turn end to keep status and transcript in sync.
    if (!this.acknowledgedPersistedUserThisTurn) {
      await this.acknowledgeOldestQueuedUserOnTurnEnd();
    }
    this.acknowledgedPersistedUserThisTurn = false;

    // Clear any session errors since we successfully completed a turn
    // This resolves persistent error banners that weren't being cleared
    await internalEventBus.publish('session.errorClear', {
      sessionId: session.id,
    });

    if (this.suppressIdleOnNextResult) {
      // In-stream /clear result: never set processing this turn, so an idle
      // publish here would fire the one-shot node-agent completion callback
      // before the cleared handoff is reviewed. Skip finishTurn (no idle, no
      // deferred replay); the cleared handoff's own genuine processing→idle
      // completes the turn.
      this.suppressIdleOnNextResult = false;
    } else if (!this.usesSessionStateChangedTurnEnd && !this.expectsSessionStateIdleAfterResult) {
      await this.finishTurn();
    }
  }

  private async finishTurn(allowQueueReplay = true): Promise<void> {
    const { session, internalEventBus, stateManager } = this.ctx;

    // Set state back to idle
    // Note: Title generation now handled by TitleGenerationQueue (decoupled via EventBus)
    await stateManager.setIdle();

    // Auto-dispatch deferred messages in immediate mode (next-turn queue replay)
    if (allowQueueReplay && session.config.queryMode !== 'manual') {
      try {
        await internalEventBus.publish('query.trigger', { sessionId: session.id });
      } catch (error) {
        this.logger.warn('Failed to dispatch deferred messages on turn end:', error);
      }
    }
  }

  private async handleSessionStateChangedMessage(message: SDKMessage): Promise<void> {
    if (!isSDKSessionStateChangedMessage(message)) return;

    this.usesSessionStateChangedTurnEnd = true;
    if (message.state === 'idle') {
      // Reset turn-scoped thinking tokens tracking before replaying queued
      // turns, so the next turn cannot inherit a stale baseline.
      this.resetThinkingTokenTracking();
      const allowQueueReplay = this.lastResultWasSuccess !== false;
      await this.finishTurn(allowQueueReplay);
      this.usesSessionStateChangedTurnEnd = false;
      this.expectsSessionStateIdleAfterResult = false;
      this.lastResultWasSuccess = null;
    }
  }

  /**
   * Reset turn-level thinking token tracking.
   *
   * Called at turn end (result messages and session_state_changed idle) so
   * cumulative estimates from one turn cannot be attributed to blocks in the
   * next turn.
   */
  private resetThinkingTokenTracking(): void {
    this.currentThinkingTokensEstimate = null;
    this.lastStampedThinkingTokensEstimate = 0;
  }

  private async handleModelRefusalFallbackMessage(message: SDKMessage): Promise<void> {
    const { session, db, internalEventBus } = this.ctx;
    if (!isSDKModelRefusalFallbackMessage(message) || message.direction !== 'retry') return;
    const fallbackModel = this.resolveConfiguredFallbackModel(message.fallback_model);
    if (!fallbackModel || session.config.model === fallbackModel) return;

    session.config = {
      ...session.config,
      model: fallbackModel,
    };
    db.updateSession(session.id, { config: session.config });
    await internalEventBus.publish('session.updated', {
      sessionId: session.id,
      source: 'model-refusal-fallback',
      session: { config: session.config },
    });
  }

  private resolveConfiguredFallbackModel(sdkFallbackModel: string | undefined): string | undefined {
    const configuredFallbackModel = this.ctx.session.config.fallbackModel;
    if (!sdkFallbackModel || !configuredFallbackModel) return sdkFallbackModel;

    const fallbackSession = {
      ...this.ctx.session,
      config: {
        ...this.ctx.session.config,
        model: configuredFallbackModel,
      },
    };
    const fallbackSdkModel = getProviderContextManager()
      .createContext(fallbackSession)
      .getSdkModelId();
    return fallbackSdkModel === sdkFallbackModel ? configuredFallbackModel : sdkFallbackModel;
  }

  private async handleUserMessage(message: SDKMessage): Promise<void> {
    await this.publishToolResultConsumedEvents(message);
    await this.repeatedToolErrorGuardrail.observeToolResultErrors(message as unknown);
  }

  private async publishToolResultConsumedEvents(message: SDKMessage): Promise<void> {
    const { internalEventBus } = this.ctx;

    if (!isSDKUserMessage(message)) return;
    const content = Array.isArray(message.message.content) ? message.message.content : [];
    for (const block of content) {
      if (block.type !== 'tool_result') continue;
      await internalEventBus.publish('sdk.toolUse.consumed', {
        sessionId: message.session_id ?? this.ctx.session.id,
        toolUseId: block.tool_use_id,
        timestamp: Date.now(),
      });
    }
  }

  /**
   * Handle assistant message (track tool calls)
   *
   * NOTE: AskUserQuestion is now handled via the canUseTool callback in
   * AskUserQuestionHandler, not here. The SDK intercepts it BEFORE execution.
   */
  private async handleAssistantMessage(message: SDKMessage): Promise<void> {
    const { session, db, internalEventBus } = this.ctx;

    if (!isSDKAssistantMessage(message)) return;

    const toolCalls = (message.message.content as unknown[]).filter(isToolUseBlock);
    for (const toolCall of toolCalls) {
      await internalEventBus.publish('sdk.toolUse.created', {
        sessionId: session.id,
        toolUseId: toolCall.id,
        toolName: toolCall.name,
        timestamp: Date.now(),
      });
      this.repeatedToolErrorGuardrail.recordToolUse(toolCall.id, toolCall.name);
    }
    if (toolCalls.length > 0) {
      session.metadata = {
        ...session.metadata,
        toolCallCount: (session.metadata?.toolCallCount || 0) + toolCalls.length,
      };
      db.updateSession(session.id, {
        metadata: session.metadata,
      });

      // Emit session.updated event so StateManager broadcasts the change
      // Include data for decoupled state management
      await internalEventBus.publish('session.updated', {
        sessionId: session.id,
        source: 'metadata',
        session: { metadata: session.metadata },
      });
    }
  }

  /**
   * Handle status message (detect compaction start)
   */
  private async handleStatusMessage(message: SDKMessage): Promise<void> {
    const { stateManager } = this.ctx;

    if (!isSDKStatusMessage(message)) return;

    const statusMsg = message as { status: string | null };
    if (statusMsg.status === 'compacting') {
      // Set isCompacting flag on processing state (flows through state.session)
      await stateManager.setCompacting(true);
    }
  }

  /**
   * Handle compact boundary message (compaction completed)
   */
  private async handleCompactBoundary(message: SDKMessage): Promise<void> {
    const { stateManager } = this.ctx;

    if (!isSDKCompactBoundary(message)) return;

    // Clear isCompacting flag on processing state (flows through state.session)
    await stateManager.setCompacting(false);

    // Immediately refresh context usage after compaction so the UI reflects
    // the new post-compact numbers without waiting for the next turn.
    void this.refreshContextUsage('compact-boundary');
  }

  /**
   * Stream-event cadence: refresh context usage every
   * `CONTEXT_REFRESH_EVENT_INTERVAL` SDK stream events. We count every
   * processed message (user replays, assistant turns, tool uses, tool results),
   * skipping only purely-internal events (api_retry, which returns early
   * before this is ever called).
   */
  private maybeRefreshContextOnEvent(_message: SDKMessage): void {
    this.eventsSinceContextRefresh += 1;
    if (this.eventsSinceContextRefresh >= CONTEXT_REFRESH_EVENT_INTERVAL) {
      void this.refreshContextUsage('event-tick');
    }
  }

  /**
   * Refresh context usage via the SDK's `query.getContextUsage()`.
   *
   * Dedupes via `pendingContextRefresh`, so multiple triggers (5-event tick,
   * turn end, compaction) collapse to a single in-flight fetch. Resets the
   * event counter so a turn-end refresh also zeroes the stream tick.
   */
  private refreshContextUsage(
    reason: 'event-tick' | 'turn-end' | 'compact-boundary'
  ): Promise<void> {
    // Reset the event counter regardless of whether we actually fetch —
    // a dedup-skipped refresh still represents the same informational
    // moment for the tick window.
    this.eventsSinceContextRefresh = 0;

    if (this.pendingContextRefresh) {
      return this.pendingContextRefresh;
    }

    const { session, internalEventBus, contextTracker, queryObject } = this.ctx;
    // If there's no live query yet (or anymore), skip silently — context
    // info is a best-effort side effect.
    if (!queryObject) return Promise.resolve();

    const promise = (async () => {
      try {
        const modelInfo = await getSessionModelInfo(session);
        const contextInfo: ContextInfo | null = await this.contextFetcher.fetch(
          queryObject,
          modelInfo
        );
        if (!contextInfo) return;
        contextTracker.updateWithDetailedBreakdown(contextInfo);
        await internalEventBus.publish('context.updated', {
          sessionId: session.id,
          contextInfo,
        });

        // HyperNeo-level compaction fallback.
        //
        // Scoped to providers/model routes where SDK auto-compact uses the
        // wrong capacity. For these routes, SDK auto-compact is disabled via
        // Options.settings; HyperNeo is the sole compaction path and fires at a
        // provider-aware reserve threshold (33k default, 45k for Kimi — see
        // `reserveBasedThreshold`).
        //
        // For all other providers (Anthropic native, GLM, Codex, OpenRouter,
        // Ollama, custom endpoints) we trust the SDK's own auto-compact.
        // Installing HyperNeo as a competing trigger would either race with the
        // SDK (same threshold) or preempt it (lower threshold, cutting off
        // advertised context). The context-fetcher capacity-mismatch warning
        // surfaces any regression in SDK behaviour for those providers.
        //
        // The HyperNeo-only cooldown (60s) prevents back-to-back `/compact`
        // enqueues while a previous compaction is still in flight.
        const providerId = session.config.provider;
        if (!providerId) {
          return;
        }
        const shouldUseFallback = shouldUseHyperNeoCompactFallback(providerId);
        const actualContextWindow = modelInfo?.contextWindow;
        if (shouldUseFallback && actualContextWindow && actualContextWindow > 0) {
          const hyperNeoCompactThreshold = reserveBasedThreshold(actualContextWindow, providerId);
          if (
            contextInfo.totalUsed >= hyperNeoCompactThreshold &&
            contextTracker.shouldCompactAt(hyperNeoCompactThreshold)
          ) {
            contextTracker.markCompactionTriggered();
            this.logger.info(
              `Triggering HyperNeo compaction fallback for session ${session.id} ` +
                `(provider=${providerId}, ${contextInfo.totalUsed} >= ${hyperNeoCompactThreshold} ` +
                `of ${actualContextWindow} tokens)`
            );
            void this.ctx.messageQueue.enqueue('/compact', /* internal */ true).catch((error) => {
              this.logger.warn(`compaction enqueue failed for session ${session.id}:`, error);
            });
          }
        }
      } catch (error) {
        this.logger.warn(`context refresh (${reason}) failed:`, error);
      } finally {
        this.pendingContextRefresh = null;
      }
    })();
    this.pendingContextRefresh = promise;
    return promise;
  }
}
