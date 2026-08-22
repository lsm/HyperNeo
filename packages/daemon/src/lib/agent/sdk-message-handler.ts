import type { UUID } from 'crypto';
import type { QueryLike } from './query-like';
import { signalDeliveryConsumed } from './message-delivery';
import type { ContextInfo, MessageHub, Session } from '@hyperneo/shared';
import { generateUUID } from '@hyperneo/shared';
import type { DaemonInternalEventMap, InternalEventBus } from '../internal-event-bus';
import type { SDKMessage, SDKUserMessage } from '@hyperneo/shared/sdk';
import {
  isSDKAPIRetryMessage,
  isSDKAssistantMessage,
  flattenSDKSlashCommands,
  isSDKBackgroundTasksChangedMessage,
  isSDKCommandLifecycleMessage,
  isSDKCommandsChangedMessage,
  isSDKCompactBoundary,
  isSDKControlRequestProgressMessage,
  isSDKConversationResetMessage,
  isSDKActiveGoalMessage,
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

const CONTEXT_REFRESH_EVENT_INTERVAL = 5;

export interface SDKMessageHandlerContext {
  readonly session: Session;
  readonly db: Database;
  readonly messageHub: MessageHub;
  readonly internalEventBus: InternalEventBus<DaemonInternalEventMap>;
  readonly stateManager: ProcessingStateManager;
  readonly contextTracker: ContextTracker;
  readonly messageQueue: MessageQueue;

  readonly errorManager: ErrorManager;
  readonly lifecycleManager: QueryLifecycleManager;

  queryObject: QueryLike | null;
  queryPromise: Promise<void> | null;

  onInitSlashCommands: (commands: string[]) => Promise<void>;

  onCommandsChanged: (commands: string[]) => Promise<void>;

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
  private suppressIdleOnNextResult: boolean = false;
  private suppressedResultWaiter: {
    resolve: (confirmed: boolean) => void;
    timer: ReturnType<typeof setTimeout>;
  } | null = null;

  private eventsSinceContextRefresh: number = 0;

  private pendingContextRefresh: Promise<void> | null = null;

  private currentThinkingTokensEstimate: number | null = null;
  private lastStampedThinkingTokensEstimate: number = 0;

  private terminalCommands: Set<string> = new Set();

  private repeatedToolErrorGuardrail: RepeatedToolErrorGuardrail;

  constructor(private ctx: SDKMessageHandlerContext) {
    const { session } = ctx;
    this.logger = new Logger(`SDKMessageHandler ${session.id}`);
    this.contextFetcher = new ContextFetcher(session.id);
    this.circuitBreaker = new ApiErrorCircuitBreaker(session.id);

    this.circuitBreaker.setOnTripCallback(async (reason, _errorCount) => {
      const userMessage = this.circuitBreaker.getTripMessage();
      await this.handleCircuitBreakerTrip(reason, userMessage);
    });

    ctx.messageQueue.onMessageYielded = (messageId: string, consumedAt: number) => {
      this.handleMessageYielded(messageId, consumedAt);
    };

    this.repeatedToolErrorGuardrail = new RepeatedToolErrorGuardrail({
      getTaskForSession: () => {
        try {
          const repo = this.ctx.db?.getSpaceTaskRepo();
          if (!repo) return null;

          const task = repo.getTaskBySessionId(this.ctx.session.id);
          if (task) return task;

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
        void this.ctx.messageQueue.enqueue(text).catch((err) => {
          this.logger.warn('Failed to enqueue repeated tool error recovery message:', err);
        });
      },
    });
  }

  resetCircuitBreaker(): void {
    this.circuitBreaker.reset();
  }

  suppressIdleForNextResult(): void {
    this.suppressIdleOnNextResult = true;
  }

  waitForSuppressedResult(timeoutMs: number): Promise<boolean> {
    this.settleSuppressedResultWaiter(false);
    return new Promise<boolean>((resolve) => {
      const timer = setTimeout(() => this.settleSuppressedResultWaiter(false), timeoutMs);
      if (typeof timer.unref === 'function') {
        timer.unref();
      }
      this.suppressedResultWaiter = { resolve, timer };
    });
  }

  clearIdleSuppression(): void {
    this.suppressIdleOnNextResult = false;
    this.settleSuppressedResultWaiter(false);
  }

  private settleSuppressedResultWaiter(confirmed: boolean): void {
    const waiter = this.suppressedResultWaiter;
    if (!waiter) return;
    this.suppressedResultWaiter = null;
    clearTimeout(waiter.timer);
    waiter.resolve(confirmed);
  }

  markApiSuccess(): void {
    this.circuitBreaker.markSuccess();
  }

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
      messageQueue.clear();
      this.resetCircuitBreaker();
      await internalEventBus.publish('session.errorClear', {
        sessionId: session.id,
      });

      if (this.ctx.queryObject || this.ctx.queryPromise) {
        await lifecycleManager.stop({ catchQueryErrors: true });
      }

      await stateManager.setIdle();

      await this.displayErrorAsAssistantMessage(
        `⚠️ **Session Stopped: Error Loop Detected**\n\n${userMessage}\n\n` +
          `The agent has been automatically stopped to prevent further errors.`
      );

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

    await internalEventBus.publish('sdk.message', {
      sessionId: session.id,
      message: sdkReplayMessage,
    });
    await this.publishToolResultConsumedEvents(sdkReplayMessage);
  }

  private async acknowledgeOldestQueuedUserOnTurnEnd(
    activeMessageId: string | null,
    resultUuid: string
  ): Promise<void> {
    const { session, db, internalEventBus, messageHub, messageQueue } = this.ctx;
    const durableOwned =
      db.getJobQueueRepo?.()?.activeDeliveryMessageUuids(session.id) ?? new Set();
    const { messages: enqueuedUsers } = db.getUserMessagesByStatus(session.id, 'enqueued');
    const consumedUsers = enqueuedUsers.filter((enqueued) => {
      const uuid = enqueued.uuid ?? '';
      const activeYielded = uuid === activeMessageId && messageQueue.hasYielded(uuid);
      return (!durableOwned.has(uuid) || activeYielded) && !messageQueue.hasPendingOrClaimed(uuid);
    });

    let lastConsumedAt = 0;
    for (const enqueuedUser of consumedUsers) {
      let consumedAt = Date.now();
      if (consumedAt <= lastConsumedAt) consumedAt = lastConsumedAt + 1;
      lastConsumedAt = consumedAt;
      const messageId = enqueuedUser.uuid ?? '';
      const batchUuids = messageQueue.hasYielded(messageId)
        ? db.getJobQueueRepo?.()?.getActiveDeliveryBatchUuids?.(session.id, messageId)
        : null;
      const deliveryUuids = batchUuids?.includes(messageId)
        ? [messageId, ...batchUuids.filter((uuid) => uuid !== messageId)]
        : [messageId];
      const consumed = db
        .getSDKMessageRepo()
        .markDeliveriesConsumedAtTurnEnd(session.id, deliveryUuids, resultUuid);
      const consumedId = consumed.ids[0];
      if (!consumedId) continue;
      if (messageQueue.acknowledgeYielded(messageId)) {
        for (const uuid of consumed.uuids) {
          signalDeliveryConsumed(session.id, uuid);
        }
      }
      db.updateMessageTimestamp(consumedId, consumedAt);
      await internalEventBus.publish('messages.statusChanged', {
        sessionId: session.id,
        messageIds: consumed.ids,
        status: 'consumed',
      });

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
    try {
      this.handleMessageYielded(messageId, Date.now());
    } catch {}
    const consumed = this.ctx.db.getMessageByStatusAndUuid(
      this.ctx.session.id,
      'consumed',
      messageId
    );
    if (consumed) {
      this.completeDeliveryAcceptance(messageId);
    }
  }

  private completeDeliveryAcceptance(messageId: string): void {
    signalDeliveryConsumed(this.ctx.session.id, messageId);
    this.consumeBatchMembersAtAcceptance(messageId);
  }

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

  private handleMessageYielded(messageId: string, consumedAt: number): void {
    const { session, db, internalEventBus, messageHub } = this.ctx;

    const enqueuedMessage =
      db.getMessageByStatusAndUuid(session.id, 'enqueued', messageId) ??
      db.getMessageByStatusAndUuid(session.id, 'submitted', messageId);
    if (!enqueuedMessage) {
      const deferredMessage = db.getMessageByStatusAndUuid(session.id, 'deferred', messageId);
      if (!deferredMessage) {
        return;
      }
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
          message: { ...sdkMessage, timestamp: consumedAt } as unknown as SDKMessage,
        })
        .catch(() => {});
      this.publishToolResultConsumedEvents({
        ...sdkMessage,
        timestamp: consumedAt,
      } as unknown as SDKMessage).catch(() => {});
      return;
    }

    this.withDbChangeBatch(() => {
      db.updateMessageStatus([enqueuedMessage.dbId], 'consumed');
      db.updateMessageTimestamp(enqueuedMessage.dbId, consumedAt);
    });

    internalEventBus
      .publish('messages.statusChanged', {
        sessionId: session.id,
        messageIds: [enqueuedMessage.dbId],
        status: 'consumed',
      })
      .catch(() => {});

    this.acknowledgedPersistedUserThisTurn = true;

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

    internalEventBus
      .publish('sdk.message', {
        sessionId: session.id,
        message: { ...sdkMessage, timestamp: consumedAt } as unknown as SDKMessage,
      })
      .catch(() => {});
    this.publishToolResultConsumedEvents({
      ...sdkMessage,
      timestamp: consumedAt,
    } as unknown as SDKMessage).catch(() => {});
  }

  async handleMessage(message: SDKMessage): Promise<void> {
    const { session, db, messageHub, stateManager } = this.ctx;

    this.ctx.bumpDeliveryTurnActivity?.();
    this.ctx.reportFirstDeliverySDKResponse?.(message.type);

    if (isSDKStreamEvent(message)) {
      await stateManager.detectPhaseFromMessage(message);
      return;
    }

    if (isSDKCommandLifecycleMessage(message)) {
      return;
    }

    if (isSDKConversationResetMessage(message)) {
      if (session.metadata.titleSetBy !== 'user') {
        const metadata = { ...session.metadata, titleGenerated: false };
        session.metadata = metadata;
        db.updateSession(session.id, { metadata, title: 'New Session' });
      }
      return;
    }

    if (isSDKActiveGoalMessage(message)) {
      return;
    }

    if (
      isSDKBackgroundTasksChangedMessage(message) ||
      isSDKControlRequestProgressMessage(message)
    ) {
      return;
    }

    const circuitBreakerTripped = await this.circuitBreaker.checkMessage(message);
    if (circuitBreakerTripped) {
      return;
    }

    if (isSDKAPIRetryMessage(message)) {
      this.logger.warn(
        `API retry: attempt ${message.attempt}/${message.max_retries}, ` +
          `delay ${message.retry_delay_ms}ms, status ${message.error_status ?? 'n/a'}, ` +
          `error ${message.error}`
      );
      await this.ctx.internalEventBus.publish('session.retryAttempt', {
        sessionId: session.id,
        attempt: message.attempt,
        max_retries: message.max_retries,
        delay_ms: message.retry_delay_ms,
        error_status: message.error_status,
        error: message.error,
      });
    }

    if (isSDKThinkingTokensMessage(message)) {
      const estimate = message.estimated_tokens;
      if (
        this.lastStampedThinkingTokensEstimate > 0 &&
        estimate < this.lastStampedThinkingTokensEstimate
      ) {
        this.lastStampedThinkingTokensEstimate = 0;
      }
      this.currentThinkingTokensEstimate = estimate;
      return;
    }

    await stateManager.detectPhaseFromMessage(message);

    if (await this.acknowledgePersistedUserMessage(message)) {
      this.maybeRefreshContextOnEvent(message);
      return;
    }

    if (message.type === 'user') {
      (message as SDKUserMessage & { isSynthetic: boolean }).isSynthetic = true;
    }

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

    const parentToolUseId = (message as SDKMessage & { parent_tool_use_id?: string | null })
      .parent_tool_use_id;
    const isTopLevelResult =
      isSDKResultMessage(message) && (parentToolUseId === null || parentToolUseId === undefined);

    const deferredSuccessfully = this.withDbChangeBatch(() =>
      db.saveSDKMessage(session.id, message)
    );

    if (!deferredSuccessfully) {
      this.logger.warn(`Failed to save message to DB (type: ${message.type})`);
      if (isTopLevelResult && this.suppressIdleOnNextResult) {
        this.clearIdleSuppression();
      }
      return;
    }

    if (isTopLevelResult && this.suppressIdleOnNextResult) {
      if (isSDKResultSuccess(message)) {
        this.settleSuppressedResultWaiter(true);
      } else {
        this.clearIdleSuppression();
      }
    }

    const processingState = stateManager.getState();
    const activeMessageId =
      isTopLevelResult && processingState.status === 'processing'
        ? processingState.messageId
        : null;
    if (isTopLevelResult && !this.suppressIdleOnNextResult) {
      stateManager.beginTerminalIdle();
    }

    messageHub.event(
      'state.sdkMessages.delta',
      {
        added: [message],
        timestamp: Date.now(),
        version: ++this.sdkMessageDeltaVersion,
      },
      { channel: `session:${session.id}` }
    );

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

    if (isTopLevelResult && !this.usesSessionStateChangedTurnEnd) {
      if (!this.suppressIdleOnNextResult) {
        await stateManager.setIdle();
      }
    }

    if (isTopLevelResult) {
      this.lastResultWasSuccess = isSDKResultSuccess(message);
      this.resetThinkingTokenTracking();
    }

    if (isSDKUserMessage(message)) {
      await this.handleUserMessage(message);
    }

    if (isSDKSystemMessage(message)) {
      await this.handleSystemMessage(message);
    }

    if (isTopLevelResult && isSDKResultSuccess(message)) {
      await this.handleResultMessage(message, activeMessageId);
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

    if (isSDKResultMessage(message)) {
      void this.refreshContextUsage('turn-end');
      return;
    }

    this.maybeRefreshContextOnEvent(message);
  }

  private async handleSystemMessage(message: SDKMessage): Promise<void> {
    const { session, db, internalEventBus } = this.ctx;

    if (!isSDKSystemMessage(message)) return;

    if (isSDKSystemInit(message)) {
      this.resetThinkingTokenTracking();
    }

    if (
      isSDKSystemInit(message) &&
      message.session_id &&
      session.sdkSessionId !== message.session_id
    ) {
      session.sdkSessionId = message.session_id;

      const sdkOriginPath = session.worktree?.worktreePath ?? session.workspacePath ?? undefined;
      session.sdkOriginPath = sdkOriginPath;

      db.updateSession(session.id, {
        sdkSessionId: message.session_id,
        sdkOriginPath,
      });

      await internalEventBus.publish('session.updated', {
        sessionId: session.id,
        source: 'sdk-session',
        session: { sdkSessionId: message.session_id, sdkOriginPath },
      });
    }

    if (isSDKSystemInit(message) && message.slash_commands?.length > 0) {
      this.terminalCommands = new Set(message.terminal_slash_commands ?? []);
      const browserCommands = message.slash_commands.filter(
        (cmd) => !this.terminalCommands.has(cmd)
      );
      await this.ctx.onInitSlashCommands(browserCommands);
    }

    if (isSDKCommandsChangedMessage(message)) {
      const browserRecords = message.commands.filter((cmd) => !this.terminalCommands.has(cmd.name));
      await this.ctx.onCommandsChanged(flattenSDKSlashCommands(browserRecords));
    }
  }

  private async handleResultMessage(
    message: SDKMessage,
    activeMessageId: string | null
  ): Promise<void> {
    const { session, db, internalEventBus } = this.ctx;

    if (!isSDKResultSuccess(message)) return;

    const usage = message.usage ?? {
      input_tokens: 0,
      output_tokens: 0,
      cache_creation_input_tokens: 0,
      cache_read_input_tokens: 0,
    };
    const totalTokens = usage.input_tokens + usage.output_tokens;

    const sdkCost = message.total_cost_usd || 0;
    const lastSdkCost = session.metadata?.lastSdkCost || 0;
    const costBaseline = session.metadata?.costBaseline || 0;

    let newCostBaseline = costBaseline;
    if (sdkCost < lastSdkCost && lastSdkCost > 0) {
      newCostBaseline = costBaseline + lastSdkCost;
    }

    const totalCost = newCostBaseline + sdkCost;

    session.lastActiveAt = new Date().toISOString();
    session.metadata = {
      ...session.metadata,
      messageCount: (session.metadata?.messageCount || 0) + 1,
      totalTokens: (session.metadata?.totalTokens || 0) + totalTokens,
      inputTokens: (session.metadata?.inputTokens || 0) + usage.input_tokens,
      outputTokens: (session.metadata?.outputTokens || 0) + usage.output_tokens,
      totalCost,
      toolCallCount: session.metadata?.toolCallCount || 0,
      lastSdkCost: sdkCost,
      costBaseline: newCostBaseline,
    };

    db.updateSession(session.id, {
      lastActiveAt: session.lastActiveAt,
      metadata: session.metadata,
    });

    await internalEventBus.publish('session.updated', {
      sessionId: session.id,
      source: 'metadata',
      session: {
        lastActiveAt: session.lastActiveAt,
        metadata: session.metadata,
      },
    });

    if (usage.input_tokens > 0 || usage.output_tokens > 0) {
      this.circuitBreaker.markSuccess();
    }

    if (!this.acknowledgedPersistedUserThisTurn) {
      await this.acknowledgeOldestQueuedUserOnTurnEnd(activeMessageId, message.uuid ?? '');
    }
    this.acknowledgedPersistedUserThisTurn = false;

    await internalEventBus.publish('session.errorClear', {
      sessionId: session.id,
    });

    if (this.suppressIdleOnNextResult) {
      this.suppressIdleOnNextResult = false;
    } else if (!this.usesSessionStateChangedTurnEnd && !this.expectsSessionStateIdleAfterResult) {
      await this.finishTurn();
    }
  }

  private async finishTurn(allowQueueReplay = true): Promise<void> {
    const { session, internalEventBus, stateManager } = this.ctx;

    await stateManager.setIdle();

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
      this.resetThinkingTokenTracking();
      const allowQueueReplay = this.lastResultWasSuccess !== false;
      await this.finishTurn(allowQueueReplay);
      this.usesSessionStateChangedTurnEnd = false;
      this.expectsSessionStateIdleAfterResult = false;
      this.lastResultWasSuccess = null;
    }
  }

  private resetThinkingTokenTracking(): void {
    this.currentThinkingTokensEstimate = null;
    this.lastStampedThinkingTokensEstimate = 0;
  }

  private async handleModelRefusalFallbackMessage(message: SDKMessage): Promise<void> {
    const { session, db, internalEventBus } = this.ctx;
    if (!isSDKModelRefusalFallbackMessage(message) || message.direction !== 'retry') return;
    if (message.scope === 'local') return;
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
        sessionId: this.ctx.session.id,
        toolUseId: block.tool_use_id,
        timestamp: Date.now(),
      });
    }
  }

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

      await internalEventBus.publish('session.updated', {
        sessionId: session.id,
        source: 'metadata',
        session: { metadata: session.metadata },
      });
    }
  }

  private async handleStatusMessage(message: SDKMessage): Promise<void> {
    const { stateManager } = this.ctx;

    if (!isSDKStatusMessage(message)) return;

    const statusMsg = message as { status: string | null };
    if (statusMsg.status === 'compacting') {
      await stateManager.setCompacting(true);
    }
  }

  private async handleCompactBoundary(message: SDKMessage): Promise<void> {
    const { stateManager } = this.ctx;

    if (!isSDKCompactBoundary(message)) return;

    await stateManager.setCompacting(false);

    void this.refreshContextUsage('compact-boundary');
  }

  private maybeRefreshContextOnEvent(_message: SDKMessage): void {
    this.eventsSinceContextRefresh += 1;
    if (this.eventsSinceContextRefresh >= CONTEXT_REFRESH_EVENT_INTERVAL) {
      void this.refreshContextUsage('event-tick');
    }
  }

  private refreshContextUsage(
    reason: 'event-tick' | 'turn-end' | 'compact-boundary'
  ): Promise<void> {
    this.eventsSinceContextRefresh = 0;

    if (this.pendingContextRefresh) {
      return this.pendingContextRefresh;
    }

    const { session, internalEventBus, contextTracker, queryObject } = this.ctx;
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
            void this.ctx.messageQueue.enqueue('/compact', true).catch((error) => {
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
