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
import { signalDeliveryConsumed } from './message-delivery';
import { emitStructuredLogEvent } from '../logger';
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
  isSDKStreamEvent,
  isSDKSystemInit,
  isSDKSystemMessage,
  isSDKThinkingTokensMessage,
  isSDKUserMessage,
  isToolUseBlock,
} from '@hyperneo/shared/sdk/type-guards';
import type { Database } from '../../storage/database';
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

  /**
   * Notify the delivery layer that the SDK produced activity (any incoming
   * message). Resets the no-progress stall watchdog for the in-flight delivery
   * turn so a live, actively-streaming turn is never mistaken for a stall.
   * Optional — a no-op when no delivery turn is in flight. See
   * AgentSession.bumpDeliveryTurnActivity.
   */
  bumpDeliveryTurnActivity?(): void;
  reportFirstDeliverySDKResponse?(responseType: string): void;
}

type PersistedUserMessage = SDKMessage & { dbId: string; timestamp: number };

export class SDKMessageHandler {
  private sdkMessageDeltaVersion: number = 0;
  private logger: Logger;
  private contextFetcher: ContextFetcher;
  private circuitBreaker: ApiErrorCircuitBreaker;
  private acknowledgedPersistedUserThisTurn: boolean = false;
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
        // synthetic assistant frame in the UI.
        void this.ctx.messageQueue.enqueue(text).catch((err) => {
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

    const submittedMessage = db.getMessageByStatusAndUuid(session.id, 'submitted', message.uuid);
    if (submittedMessage) {
      await this.consumePersistedUserMessage(submittedMessage, message);
      return true;
    }

    const consumedMessage = db.getMessageByStatusAndUuid(session.id, 'consumed', message.uuid);
    if (consumedMessage) {
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
    const durableOwned =
      db.getJobQueueRepo?.()?.activeDeliveryMessageUuids(session.id) ?? new Set();
    const enqueuedUsers = db
      .getMessagesByStatus(session.id, 'enqueued')
      .filter((enqueued) => isSDKUserMessage(enqueued) && !durableOwned.has(enqueued.uuid ?? ''));

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
  }

  markMessageSubmitted(messageId: string): boolean {
    const persisted = this.transitionPersistedMessage(messageId, 'enqueued', 'submitted');
    if (persisted) {
      this.submitBatchMembersWithKickoff(messageId);
    }
    return persisted;
  }

  /**
   * Batched queue flush on an ACP session: the kickoff's submission writes the
   * COMBINED prompt to the subprocess — the admitted members' text is already
   * in flight, so they must leave `enqueued` (mutable in the queue UI) at the
   * same moment. Otherwise ACP's potentially minutes-long
   * submission→acceptance window lets a member be deleted/deferred in the UI,
   * an operation that cannot retract text already written to the subprocess.
   * Membership comes from the durable (narrowed-to-admitted) job payload.
   * Best-effort: a member that fails to transition is still consumed at
   * acceptance (see consumeBatchMembersAtAcceptance) or settled by the
   * reconciler.
   */
  private submitBatchMembersWithKickoff(kickoffUuid: string): void {
    try {
      const jobQueue = this.ctx.db.getJobQueueRepo?.();
      if (!jobQueue?.getActiveDeliveryBatchUuids) return;
      const members = jobQueue.getActiveDeliveryBatchUuids(this.ctx.session.id, kickoffUuid);
      if (!members) return;
      for (const uuid of members) {
        if (uuid === kickoffUuid) continue;
        const row = this.ctx.db.getMessageByStatusAndUuid(this.ctx.session.id, 'enqueued', uuid);
        if (row) {
          this.transitionPersistedMessage(row.dbId, 'enqueued', 'submitted');
        }
      }
    } catch (err) {
      this.logger.warn('Failed to submit batch members with the kickoff:', err);
    }
  }

  markMessageAccepted(messageId: string): void {
    // ACP acceptance is the provider-specific consume boundary. Reuse the same
    // projection path as a normal SDK yield so status, timestamp, transcript
    // delta, and server-side events stay consistent.
    try {
      this.handleMessageYielded(messageId, Date.now());
    } catch {
      // The consumed-status transition commits BEFORE the fallible post-commit
      // search-index work; a throw there must NOT prevent the delivery-waiter
      // signal below — else LTA/task-agent callers time out despite a durably
      // consumed prompt + a fresh caller retries the work twice. (Codex review.)
    }
    // Signal delivery waiters (LTA / task-agent consumption-await) ONLY when the
    // acceptance actually took — the row is now `consumed`. If a racing
    // interrupt/error already flipped it `failed` (markACPDeliveryFailed),
    // handleMessageYielded is a no-op and we must NOT signal.
    const consumed = this.ctx.db.getMessageByStatusAndUuid(
      this.ctx.session.id,
      'consumed',
      messageId
    );
    if (consumed) {
      signalDeliveryConsumed(this.ctx.session.id, messageId);
      this.consumeBatchMembersAtAcceptance(messageId);
    }
  }

  /**
   * Batched queue flush on an ACP session: the kickoff's prompt folded the
   * members in, and ACP's consume boundary is acceptance (here) — not onSent.
   * Flip the members with the kickoff or their rows stay `enqueued` and the
   * orphan reconciler re-delivers them individually, repeating already-executed
   * prompts. The membership is read from the durable job payload
   * (`getActiveDeliveryBatchUuids`), so a crash + reclaim between admission and
   * acceptance resolves the same batch. Best-effort: a throw here must not
   * break the kickoff's acceptance path (the members are then picked up by the
   * reconciler after the job settles).
   */
  private consumeBatchMembersAtAcceptance(kickoffUuid: string): void {
    try {
      const jobQueue = this.ctx.db.getJobQueueRepo?.();
      const repo = this.ctx.db.getSDKMessageRepo();
      if (!jobQueue || !repo) return;
      const members = jobQueue.getActiveDeliveryBatchUuids?.(this.ctx.session.id, kickoffUuid);
      if (!members) return;
      const uuids = members.filter((uuid) => uuid !== kickoffUuid);
      if (uuids.length === 0) return;
      const flippedIds = repo.markDeliveryConsumedByUuids(this.ctx.session.id, uuids);
      if (flippedIds.length > 0) {
        void this.ctx.internalEventBus
          .publish('messages.statusChanged', {
            sessionId: this.ctx.session.id,
            messageIds: flippedIds,
            status: 'consumed',
          })
          .catch(() => {});
      }
      for (const uuid of uuids) {
        signalDeliveryConsumed(this.ctx.session.id, uuid);
      }
    } catch (err) {
      this.logger.warn('Failed to consume batch members at ACP acceptance:', err);
    }
  }

  /**
   * Terminalize an ACP prompt that was submitted to the subprocess but whose
   * run ended (interrupt / error / adapter close) before any acceptance
   * signal. Submitted rows are hidden from transcript queries, so without an
   * explicit settle they stay invisible and nonterminal until restart
   * recovery. Fail-ambiguous: the row is never auto-replayed. See Codex
   * (#3743968032).
   */
  markMessageSubmissionFailed(messageId: string): void {
    const { session, db, internalEventBus } = this.ctx;
    const message = db.getMessageByStatusAndUuid(session.id, 'submitted', messageId);
    if (!message) return;
    db.updateMessageStatus([message.dbId], 'failed');
    internalEventBus
      .publish('messages.statusChanged', {
        sessionId: session.id,
        messageIds: [message.dbId],
        status: 'failed',
      })
      .catch(() => {});
  }

  /**
   * Fail-ambiguous terminalization for an ACP prompt that may have reached the
   * subprocess but never got a definitive acceptance. Covers BOTH enqueued (the
   * enqueued→submitted transition threw, or remove/defer won) AND submitted (the
   * run ended before acceptance). The row becomes visible-failed and is never
   * auto-replayed. See Codex (#3743968032, #3744886836).
   */
  markACPDeliveryFailed(messageId: string): void {
    const { session, db, internalEventBus } = this.ctx;
    const flipped = db.getSDKMessageRepo().markDeliveryFailedByUuid(session.id, messageId);
    if (!flipped) return;
    internalEventBus
      .publish('messages.statusChanged', {
        sessionId: session.id,
        messageIds: [flipped],
        status: 'failed',
      })
      .catch(() => {});
  }

  private transitionPersistedMessage(
    messageId: string,
    fromStatus: 'enqueued',
    toStatus: 'submitted'
  ): boolean {
    const { session, db, internalEventBus } = this.ctx;
    const message = db.getMessageByStatusAndUuid(session.id, fromStatus, messageId);
    if (!message) return false;
    db.updateMessageStatus([message.dbId], toStatus);
    internalEventBus
      .publish('messages.statusChanged', {
        sessionId: session.id,
        messageIds: [message.dbId],
        status: toStatus,
      })
      .catch(() => {});
    return true;
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
    const enqueuedMessage =
      db.getMessageByStatusAndUuid(session.id, 'enqueued', messageId) ??
      db.getMessageByStatusAndUuid(session.id, 'submitted', messageId);
    if (!enqueuedMessage) {
      // Could be a 'deferred' message being replayed
      const deferredMessage = db.getMessageByStatusAndUuid(session.id, 'deferred', messageId);
      if (!deferredMessage) {
        return; // Not a persisted user message (e.g., already consumed)
      }
      // Handle deferred message the same way
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
   * Main entry point - handle incoming SDK message.
   *
   * The SDK's query() AsyncGenerator yields complete messages (assistant, user,
   * result, …); when `includePartialMessages` is on it ALSO yields incremental
   * `stream_event` token deltas. Those partials are intercepted below as a
   * LIVENESS heartbeat for the delivery-turn stall watchdog and are never
   * persisted or broadcast — only complete messages reach the DB / clients.
   */
  async handleMessage(message: SDKMessage): Promise<void> {
    const { session, db, messageHub, stateManager } = this.ctx;

    // TEMP DIAGNOSTIC (PR #2499 CI investigation): record every SDK message the
    // daemon handles so the structured log narrates each query's event flow.
    // Revert once the features-b steer hang is diagnosed.
    emitStructuredLogEvent({
      level: 'info',
      args: [
        `sdk.message ${message.type}${'subtype' in message && message.subtype ? `/${message.subtype}` : ''}`,
      ],
      source: 'process',
      module: 'daemon:sdk-message-handler',
      metadata: { sessionId: session.id },
    });

    // Any incoming SDK message is "activity" — reset the delivery turn's no-
    // progress stall watchdog so an actively-streaming turn (even a multi-hour
    // one) is never mistaken for a stall. No-op when no delivery turn is active.
    this.ctx.bumpDeliveryTurnActivity?.();
    this.ctx.reportFirstDeliverySDKResponse?.(message.type);

    // Partial/streaming token deltas (`stream_event`) are a LIVENESS heartbeat
    // only. They prove the model is actively generating or extended-thinking
    // during a long quiet generation that would otherwise exceed the stall
    // watchdog's no-activity window and look like a hang — the bump above reset
    // it. Update the streaming phase, but NEVER persist or broadcast partials:
    // a single assistant turn can yield hundreds of token deltas, and persisting
    // each would bloat the DB. The complete `assistant` message is still emitted
    // and handled normally below, so persistence/rendering are unaffected.
    if (isSDKStreamEvent(message)) {
      await stateManager.detectPhaseFromMessage(message);
      return;
    }

    // Check for API error patterns that indicate an infinite loop
    // This MUST happen BEFORE any other processing to catch errors early
    const circuitBreakerTripped = await this.circuitBreaker.checkMessage(message);
    if (circuitBreakerTripped) {
      // Circuit breaker tripped - skip normal processing
      // The callback will handle stopping the query and notifying the user
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

    // A persisted terminal result proves this turn ended. Start the completion
    // fence before publication or type-specific awaited work; the corresponding
    // immediate/session-state idle consumes it after finalization. In-stream
    // /clear results are internal and intentionally suppress that idle.
    const parentToolUseId = (message as SDKMessage & { parent_tool_use_id?: string | null })
      .parent_tool_use_id;
    const isTopLevelResult =
      isSDKResultMessage(message) && (parentToolUseId === null || parentToolUseId === undefined);
    if (isTopLevelResult && !this.suppressIdleOnNextResult) {
      stateManager.beginTerminalIdle();
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

    // Terminal messages end the turn even when they represent errors.
    // Clear stale waiting_for_input state before type-specific handling so
    // interrupted AskUserQuestion turns cannot keep the composer locked.
    if (isTopLevelResult && !this.usesSessionStateChangedTurnEnd) {
      if (!this.suppressIdleOnNextResult) {
        await stateManager.setIdle();
      }
      // When armed (in-stream /clear), skip setIdle here AND finishTurn below
      // — that turn never set processing (internal message), so an idle publish
      // would fire the one-shot node-agent completion callback before the
      // cleared handoff is reviewed. The flag is consumed at finishTurn.
    }

    if (isTopLevelResult) {
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

    if (isTopLevelResult && isSDKResultSuccess(message)) {
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
        // Use the application session.id (as sdk.toolUse.created does), NOT
        // message.session_id (the SDK conversation ID, a.k.a. session.sdkSessionId):
        // node_executions.agent_session_id stores the app id, so consumers that
        // resolve the event to an execution (e.g. lastActivityAt tracking) would
        // otherwise miss every tool-result event.
        sessionId: this.ctx.session.id,
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
