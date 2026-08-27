import type { ContextInfo, MessageHub, Session } from '@hyperneo/shared';
import { generateUUID } from '@hyperneo/shared';
import type {
  SDKMessage,
  SDKRateLimitInfo,
  SDKResultMessage,
  SDKUserMessage,
} from '@hyperneo/shared/sdk';
import {
  flattenSDKSlashCommands,
  isSDKActiveGoalMessage,
  isSDKAPIRetryMessage,
  isSDKAssistantMessage,
  isSDKBackgroundTasksChangedMessage,
  isSDKCommandLifecycleMessage,
  isSDKCommandsChangedMessage,
  isSDKCompactBoundary,
  isSDKControlRequestProgressMessage,
  isSDKConversationResetMessage,
  isSDKModelRefusalFallbackMessage,
  isSDKModelRefusalNoFallbackMessage,
  isSDKRateLimitEvent,
  isSDKResultError,
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
import type { UUID } from 'crypto';
import type { Database } from '../../storage/database.ts';
import { ErrorCategory, type ErrorManager } from '../error-manager.ts';
import type { DaemonInternalEventMap, InternalEventBus } from '../internal-event-bus.ts';
import { Logger } from '../logger.ts';
import { getProviderCatalogEpoch, getSessionModelInfo } from '../model-service.ts';
import { getProviderContextManager } from '../providers/factory.ts';
import { ApiErrorCircuitBreaker } from './api-error-circuit-breaker.ts';
import { contextBudgetThreshold } from './context-budget-decision.ts';
import { enforceContextBudget } from './context-budget-enforcement.ts';
import { ContextFetcher } from './context-fetcher.ts';
import type { ContextTracker } from './context-tracker.ts';
import { decideFallbackModelCuration } from './fallback-model-curation.ts';
import type { IdleOwnerScope } from './idle-waiter-admission-pipeline.ts';
import { assessLimitError, type LimitRetryHint } from './limit-error-classifier.ts';
import { signalDeliveryConsumed } from './message-delivery.ts';
import type { MessageQueue } from './message-queue.ts';
import type { ProcessingStateManager } from './processing-state-manager.ts';
import type { QueryLifecycleManager } from './query-lifecycle-manager.ts';
import type { QueryLike } from './query-like.ts';
import {
  getBuiltFallbackIdentity,
  NATIVE_CONTEXT_WINDOW_PROVIDER_IDS,
} from './query-options-builder.js';
import { RepeatedToolErrorGuardrail } from './repeated-tool-error-guardrail.ts';

const CONTEXT_REFRESH_EVENT_INTERVAL = 5;

const DELIVERY_GATE_WINDOW_MS = 5000;

function boundedDeliveryGate(gate: Promise<void>, deadlineAt?: number): Promise<void> {
  const windowMs =
    deadlineAt === undefined ? DELIVERY_GATE_WINDOW_MS : Math.max(0, deadlineAt - Date.now());
  let timer: ReturnType<typeof setTimeout> | undefined;
  const bounded = new Promise<void>((resolve) => {
    timer = setTimeout(() => resolve(), windowMs);
    if (typeof timer.unref === 'function') {
      timer.unref();
    }
  });
  void gate.then(
    () => {
      if (timer) clearTimeout(timer);
    },
    () => {
      if (timer) clearTimeout(timer);
    }
  );
  return Promise.race([gate, bounded]);
}

export type SuppressedResultOutcome = 'confirmed' | 'reset' | 'cancelled';

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

  onResultLimitError?(
    errorText: string,
    hint: LimitRetryHint,
    userMessageUuid?: string
  ): Promise<boolean>;

  isLimitRecoveryPending?(): boolean;

  getQueryGeneration?(): number;

  resetTaskNotificationRequery?(): void;

  bumpDeliveryTurnActivity?(): void;
  reportFirstDeliverySDKResponse?(responseType: string): void;
  onDeliveryTurnAccepted?(): void;
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
  private lastRateLimitInfo: SDKRateLimitInfo | null = null;
  private lastSdkErrorTag: string | null = null;
  private clearAwaitingTrailingIdle: boolean = false;
  private clearMessageInFlight: boolean = false;
  private suppressedResultWaiter: {
    resolve: (outcome: SuppressedResultOutcome) => void;
    timer: ReturnType<typeof setTimeout> | undefined;
    timeoutMs: number;
    expectedUserMessageUuid?: string;
  } | null = null;

  private eventsSinceContextRefresh: number = 0;

  private pendingContextRefresh: Promise<void> | null = null;

  private trailingIdleGateRelease: (() => void) | null = null;

  private compactionEnqueuedMidTurnGeneration: number | null | undefined = undefined;

  private currentThinkingTokensEstimate: number | null = null;
  private lastStampedThinkingTokensEstimate: number = 0;

  private terminalCommands: Set<string> = new Set();

  private sdkCapabilities: ReadonlySet<string> = new Set();

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

    ctx.messageQueue.onInternalCompactionsAborted = () => {
      this.ctx.contextTracker.clearCompactionCooldown();
      this.compactionEnqueuedMidTurnGeneration = undefined;
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
    this.lastRateLimitInfo = null;
    this.lastSdkErrorTag = null;
  }

  suppressIdleForNextResult(): void {
    this.suppressIdleOnNextResult = true;
  }

  markClearMessageSent(): void {
    if (!this.suppressedResultWaiter) return;
    this.clearMessageInFlight = true;
  }

  armSuppressedResultWait(expectedUserMessageUuid?: string): Promise<SuppressedResultOutcome> {
    this.settleSuppressedResultWaiter('reset');
    return new Promise<SuppressedResultOutcome>((resolve) => {
      this.suppressedResultWaiter = {
        resolve,
        timer: undefined,
        timeoutMs: 0,
        expectedUserMessageUuid,
      };
    });
  }

  startSuppressedResultTimer(timeoutMs: number): void {
    const waiter = this.suppressedResultWaiter;
    if (!waiter) return;
    clearTimeout(waiter.timer);
    const timer = setTimeout(() => this.settleSuppressedResultWaiter('reset'), timeoutMs);
    if (typeof timer.unref === 'function') {
      timer.unref();
    }
    waiter.timer = timer;
    waiter.timeoutMs = timeoutMs;
  }

  waitForSuppressedResult(
    timeoutMs: number,
    expectedUserMessageUuid?: string
  ): Promise<SuppressedResultOutcome> {
    const wait = this.armSuppressedResultWait(expectedUserMessageUuid);
    this.startSuppressedResultTimer(timeoutMs);
    return wait;
  }

  clearIdleSuppression(): void {
    this.abandonClearTurnBookkeeping();
    this.settleSuppressedResultWaiter('reset');
  }

  cancelSuppressedResultWait(): void {
    this.abandonClearTurnBookkeeping();
    this.settleSuppressedResultWaiter('cancelled');
  }

  private abandonClearTurnBookkeeping(): void {
    this.suppressIdleOnNextResult = false;
    this.clearAwaitingTrailingIdle = false;
    this.clearMessageInFlight = false;
    this.usesSessionStateChangedTurnEnd = false;
    this.expectsSessionStateIdleAfterResult = false;
    this.lastResultWasSuccess = null;
    this.releaseTrailingIdleDeliveryGate();
  }

  private cancelSuppressedResultTimer(): void {
    const waiter = this.suppressedResultWaiter;
    if (!waiter) return;
    clearTimeout(waiter.timer);
  }

  private rearmSuppressedResultTimer(): void {
    const waiter = this.suppressedResultWaiter;
    if (!waiter || waiter.timeoutMs <= 0) return;
    clearTimeout(waiter.timer);
    const timer = setTimeout(() => this.settleSuppressedResultWaiter('reset'), waiter.timeoutMs);
    if (typeof timer.unref === 'function') {
      timer.unref();
    }
    waiter.timer = timer;
  }

  private matchesArmedClearResult(message: SDKMessage): boolean {
    if (!this.suppressIdleOnNextResult || !isSDKResultMessage(message)) {
      return false;
    }
    const parentToolUseId = (message as SDKMessage & { parent_tool_use_id?: string | null })
      .parent_tool_use_id;
    if (parentToolUseId !== null && parentToolUseId !== undefined) {
      return false;
    }
    const expected = this.suppressedResultWaiter?.expectedUserMessageUuid;
    if (!isSDKResultSuccess(message)) {
      return this.clearMessageInFlight;
    }
    if (expected === undefined) {
      return true;
    }
    return (message as { user_message_uuid?: string }).user_message_uuid === expected;
  }

  private settleSuppressedResultWaiter(outcome: SuppressedResultOutcome): void {
    const waiter = this.suppressedResultWaiter;
    if (!waiter) return;
    this.suppressedResultWaiter = null;
    clearTimeout(waiter.timer);
    waiter.resolve(outcome);
  }

  markApiSuccess(): void {
    this.circuitBreaker.markSuccess();
  }

  getSdkCapabilities(): ReadonlySet<string> {
    return this.sdkCapabilities;
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
      this.ctx.resetTaskNotificationRequery?.();
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
      this.ctx.onDeliveryTurnAccepted?.();
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

  async handleMessage(message: SDKMessage, runnerGeneration?: number): Promise<void> {
    const { session, db, messageHub, stateManager } = this.ctx;
    const invocationGeneration = runnerGeneration ?? this.ctx.getQueryGeneration?.() ?? null;

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

    if (isSDKRateLimitEvent(message)) {
      const info = message.rate_limit_info;
      this.lastRateLimitInfo =
        info.status === 'rejected' || info.overageStatus === 'rejected' ? info : null;
    }

    if (
      isSDKAssistantMessage(message) &&
      message.error &&
      (message.parent_tool_use_id === null || message.parent_tool_use_id === undefined)
    ) {
      this.lastSdkErrorTag = message.error;
    }

    if (await this.acknowledgePersistedUserMessage(message)) {
      this.maybeRefreshContextOnEvent(message, invocationGeneration);
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

    let releaseTurnEndGate: (() => void) | null = null;
    if (isTopLevelResult) {
      let release!: () => void;
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      this.ctx.messageQueue.setDeliveryGate(boundedDeliveryGate(gate));
      releaseTurnEndGate = release;
    }

    let deferredSuccessfully: boolean;
    try {
      deferredSuccessfully = this.withDbChangeBatch(() => db.saveSDKMessage(session.id, message));
    } catch (error) {
      releaseTurnEndGate?.();
      releaseTurnEndGate = null;
      throw error;
    }

    if (!deferredSuccessfully) {
      this.logger.warn(`Failed to save message to DB (type: ${message.type})`);
      releaseTurnEndGate?.();
      releaseTurnEndGate = null;
      if (this.matchesArmedClearResult(message)) {
        this.clearIdleSuppression();
      }
      return;
    }

    const observesArmedClearResult = this.matchesArmedClearResult(message);
    const settlesArmedClearError = observesArmedClearResult && !isSDKResultSuccess(message);
    if (observesArmedClearResult) {
      this.cancelSuppressedResultTimer();
    }

    const processingState = stateManager.getState();
    const activeMessageId =
      isTopLevelResult && processingState.status === 'processing'
        ? processingState.messageId
        : null;

    let limitEngaged = false;
    let limitBillingTerminal = false;
    if (isTopLevelResult) {
      this.resetThinkingTokenTracking();
      const limitError = this.assessResultLimitError(message);
      if (limitError) {
        limitBillingTerminal = limitError.hint.billingTerminal === true;
        limitEngaged =
          (await this.ctx.onResultLimitError?.(
            limitError.errorText,
            limitError.hint,
            limitError.userMessageUuid
          )) ?? false;
      }
      this.lastResultWasSuccess = limitError === null && isSDKResultSuccess(message);
      this.lastRateLimitInfo = null;
      this.lastSdkErrorTag = null;
    }

    if (isTopLevelResult && !limitEngaged && !this.suppressIdleOnNextResult) {
      stateManager.beginTerminalIdle(this.invocationIdleOwner(invocationGeneration));
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

    try {
      await this.ctx.internalEventBus.publish('sdk.message', {
        sessionId: session.id,
        message,
      });
    } catch (error) {
      releaseTurnEndGate?.();
      releaseTurnEndGate = null;
      if (observesArmedClearResult) {
        this.clearIdleSuppression();
      }
      throw error;
    }

    if (limitEngaged) {
      const resultUuid = (message as SDKResultMessage).uuid;
      if (resultUuid) {
        try {
          db.getSDKMessageRepo()?.markResultRecoveryIntercepted(
            session.id,
            resultUuid,
            limitBillingTerminal
          );
        } catch (error) {
          this.logger.warn('Failed to mark intercepted limit result:', error);
        }
      }
      await this.recordResultUsageMetadata(message as SDKResultMessage);
      const compactingClear = this.clearStaleCompacting();
      await this.refreshContextUsage('turn-end', undefined, invocationGeneration);
      await compactingClear;
      releaseTurnEndGate?.();
      releaseTurnEndGate = null;
      return;
    }

    if (isSDKSessionStateChangedMessage(message)) {
      if (!this.isInvocationStale(invocationGeneration)) {
        this.usesSessionStateChangedTurnEnd = true;
        if (message.state !== 'idle') {
          this.expectsSessionStateIdleAfterResult = true;
        }
      }
    }

    let enforcedTurnEnd = false;
    if (isTopLevelResult && !this.usesSessionStateChangedTurnEnd) {
      if (!this.suppressIdleOnNextResult && !settlesArmedClearError) {
        const compactingClear = this.clearStaleCompacting();
        await this.refreshContextUsage('turn-end', undefined, invocationGeneration);
        enforcedTurnEnd = true;
        await compactingClear;
        await this.settleIdleForInvocation(invocationGeneration);
      }
    }

    if (isSDKUserMessage(message)) {
      await this.handleUserMessage(message);
    }

    if (isSDKSystemMessage(message)) {
      await this.handleSystemMessage(message);
    }

    if (isTopLevelResult && isSDKResultSuccess(message)) {
      await this.handleResultMessage(message, activeMessageId, invocationGeneration);
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

    if (isSDKModelRefusalNoFallbackMessage(message)) {
      await this.recordRefusalRewindTarget(message.refused_user_message_uuid);
    }

    if (isSDKSessionStateChangedMessage(message)) {
      await this.handleSessionStateChangedMessage(message, invocationGeneration);
    }

    if (isSDKCompactBoundary(message)) {
      await this.handleCompactBoundary(message, invocationGeneration);
    }

    if (isSDKResultMessage(message)) {
      const compactingClear = isTopLevelResult ? this.clearStaleCompacting() : null;
      if (isTopLevelResult && !enforcedTurnEnd) {
        if (this.expectsSessionStateIdleAfterResult) {
          this.armTrailingIdleDeliveryGate();
        }
        await this.refreshContextUsage('turn-end', undefined, invocationGeneration);
      }
      await compactingClear;
      releaseTurnEndGate?.();
      releaseTurnEndGate = null;
    }

    if (isTopLevelResult && isSDKResultMessage(message)) {
      if (settlesArmedClearError) {
        this.clearIdleSuppression();
      }
      return;
    }

    this.maybeRefreshContextOnEvent(message, invocationGeneration);
  }

  private async handleSystemMessage(message: SDKMessage): Promise<void> {
    const { session, db, internalEventBus } = this.ctx;

    if (!isSDKSystemMessage(message)) return;

    if (isSDKSystemInit(message)) {
      this.resetThinkingTokenTracking();
      this.sdkCapabilities = new Set(message.capabilities ?? []);
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

  private async recordRefusalRewindTarget(refusedUserMessageUuid: string | null | undefined) {
    const { session, db, internalEventBus } = this.ctx;
    if (!refusedUserMessageUuid) return;
    if (session.metadata?.refusalRewindTargetUuid === refusedUserMessageUuid) return;

    session.metadata = {
      ...session.metadata,
      refusalRewindTargetUuid: refusedUserMessageUuid,
    };
    db.updateSession(session.id, { metadata: session.metadata });
    await internalEventBus.publish('session.updated', {
      sessionId: session.id,
      source: 'metadata',
      session: { metadata: session.metadata },
    });
  }

  private async recordResultUsageMetadata(message: SDKResultMessage): Promise<void> {
    const { session, db, internalEventBus } = this.ctx;

    const usage = message.usage ?? {
      input_tokens: 0,
      output_tokens: 0,
      cache_creation_input_tokens: 0,
      cache_read_input_tokens: 0,
    };
    const inputTokens = usage.input_tokens ?? 0;
    const outputTokens = usage.output_tokens ?? 0;
    const totalTokens = inputTokens + outputTokens;

    const sdkCost = message.total_cost_usd || 0;
    const lastSdkCost = session.metadata?.lastSdkCost || 0;
    const costBaseline = session.metadata?.costBaseline || 0;

    let newCostBaseline = costBaseline;
    if (sdkCost < lastSdkCost && lastSdkCost > 0) {
      newCostBaseline = costBaseline + lastSdkCost;
    }

    const totalCost = newCostBaseline + sdkCost;

    session.lastActiveAt = new Date().toISOString();
    const hadRefusalRewindTarget = session.metadata?.refusalRewindTargetUuid != null;
    const { refusalRewindTargetUuid: _clearedRefusalRewindTargetUuid, ...restMetadata } =
      session.metadata ?? {};
    session.metadata = {
      ...restMetadata,
      messageCount: (session.metadata?.messageCount || 0) + 1,
      totalTokens: (session.metadata?.totalTokens || 0) + totalTokens,
      inputTokens: (session.metadata?.inputTokens || 0) + inputTokens,
      outputTokens: (session.metadata?.outputTokens || 0) + outputTokens,
      totalCost,
      toolCallCount: session.metadata?.toolCallCount || 0,
      lastSdkCost: sdkCost,
      costBaseline: newCostBaseline,
    };

    db.updateSession(session.id, {
      lastActiveAt: session.lastActiveAt,
      metadata: hadRefusalRewindTarget
        ? { ...session.metadata, refusalRewindTargetUuid: null }
        : session.metadata,
    });

    await internalEventBus.publish('session.updated', {
      sessionId: session.id,
      source: 'metadata',
      session: {
        lastActiveAt: session.lastActiveAt,
        metadata: session.metadata,
      },
    });
  }

  private async handleResultMessage(
    message: SDKMessage,
    activeMessageId: string | null,
    invocationGeneration: number | null
  ): Promise<void> {
    if (!isSDKResultSuccess(message)) return;

    const confirmsArmedClear = this.matchesArmedClearResult(message);

    try {
      await this.processResultMessage(
        message,
        activeMessageId,
        confirmsArmedClear,
        invocationGeneration
      );
    } catch (error) {
      if (confirmsArmedClear) {
        this.clearIdleSuppression();
      }
      throw error;
    }
  }

  private async processResultMessage(
    message: SDKMessage,
    activeMessageId: string | null,
    confirmsArmedClear: boolean,
    invocationGeneration: number | null
  ): Promise<void> {
    if (!isSDKResultSuccess(message)) return;

    const { session, internalEventBus } = this.ctx;

    this.lastRateLimitInfo = null;
    this.lastSdkErrorTag = null;

    await this.recordResultUsageMetadata(message);

    const usage = message.usage ?? {
      input_tokens: 0,
      output_tokens: 0,
      cache_creation_input_tokens: 0,
      cache_read_input_tokens: 0,
    };

    if (usage.input_tokens > 0 || usage.output_tokens > 0) {
      this.circuitBreaker.markSuccess();
    }

    if (!this.acknowledgedPersistedUserThisTurn && !this.suppressIdleOnNextResult) {
      await this.acknowledgeOldestQueuedUserOnTurnEnd(activeMessageId, message.uuid ?? '');
    }
    this.acknowledgedPersistedUserThisTurn = false;

    await internalEventBus.publish('session.errorClear', {
      sessionId: session.id,
    });

    if (confirmsArmedClear) {
      this.suppressIdleOnNextResult = false;
    } else if (
      !this.suppressIdleOnNextResult &&
      !this.usesSessionStateChangedTurnEnd &&
      !this.expectsSessionStateIdleAfterResult
    ) {
      await this.finishTurn(this.lastResultWasSuccess !== false, invocationGeneration);
    }
    if (confirmsArmedClear) {
      if (this.usesSessionStateChangedTurnEnd && this.expectsSessionStateIdleAfterResult) {
        this.clearAwaitingTrailingIdle = true;
        this.rearmSuppressedResultTimer();
      } else {
        this.clearMessageInFlight = false;
        this.settleSuppressedResultWaiter('confirmed');
      }
    }
  }

  private assessResultLimitError(
    message: SDKMessage
  ): { errorText: string; hint: LimitRetryHint; userMessageUuid?: string } | null {
    let errorText = '';
    let terminalReason: string | undefined;
    let apiErrorStatus: number | null | undefined;
    let userMessageUuid: string | undefined;

    if (isSDKResultSuccess(message)) {
      const result = message;
      if (result.is_error !== true) return null;
      terminalReason = result.terminal_reason;
      apiErrorStatus = result.api_error_status;
      userMessageUuid = result.user_message_uuid;
      errorText = typeof result.result === 'string' ? result.result : '';
      const isApiErrorTerminal =
        terminalReason === 'blocking_limit' ||
        terminalReason === 'api_error' ||
        terminalReason === 'rapid_refill_breaker' ||
        typeof apiErrorStatus === 'number';
      if (!isApiErrorTerminal) return null;
    } else if (isSDKResultError(message)) {
      errorText = Array.isArray(message.errors) ? message.errors.join('\n') : '';
      terminalReason = message.terminal_reason;
    } else {
      return null;
    }

    const assessment = assessLimitError({
      rawText: errorText,
      httpStatus: typeof apiErrorStatus === 'number' ? apiErrorStatus : undefined,
      sdkErrorTag: this.lastSdkErrorTag ?? undefined,
      terminalReason,
      rateLimitInfo: this.lastRateLimitInfo ?? undefined,
    });
    if (!assessment.isLimit) return null;
    return {
      errorText,
      hint: {
        resetAtMs: assessment.resetAtMs,
        kind: assessment.kind,
        billingTerminal: assessment.billingTerminal,
      },
      userMessageUuid,
    };
  }

  private isInvocationStale(invocationGeneration: number | null): boolean {
    return (
      invocationGeneration != null &&
      this.ctx.getQueryGeneration != null &&
      this.ctx.getQueryGeneration() !== invocationGeneration
    );
  }

  private invocationIdleOwner(invocationGeneration: number | null): IdleOwnerScope | undefined {
    if (invocationGeneration === null) return undefined;
    return this.ctx.stateManager.idleOwnerForQuery(invocationGeneration);
  }

  private async settleIdleForInvocation(
    invocationGeneration: number | null,
    opts?: {
      suppressDeliveryWaiters?: boolean;
      suppressIdlePublish?: boolean;
      suppressIdleCallback?: boolean;
    }
  ): Promise<void> {
    const owner = this.invocationIdleOwner(invocationGeneration);
    if (owner) {
      await this.ctx.stateManager.setIdle({ ...opts, owner });
    } else if (opts) {
      await this.ctx.stateManager.setIdle(opts);
    } else {
      await this.ctx.stateManager.setIdle();
    }
  }

  private async finishTurn(
    allowQueueReplay = true,
    invocationGeneration: number | null = null
  ): Promise<void> {
    const { session, internalEventBus, stateManager } = this.ctx;

    if (stateManager.getState().status === 'rate_limit_cooldown') {
      this.logger.info('Skipping turn-end idle and replay: rate limit cooldown is armed.');
      return;
    }

    if (this.ctx.isLimitRecoveryPending?.() ?? false) {
      this.logger.info('Skipping turn-end idle and replay: limit fallback recovery is pending.');
      return;
    }

    await this.settleIdleForInvocation(invocationGeneration);

    if (allowQueueReplay && session.config.queryMode !== 'manual') {
      if (this.isInvocationStale(invocationGeneration)) {
        this.logger.info(
          'Skipping deferred replay dispatch: the turn was superseded at the idle settle.'
        );
        return;
      }
      try {
        await internalEventBus.publish('query.trigger', { sessionId: session.id });
      } catch (error) {
        this.logger.warn('Failed to dispatch deferred messages on turn end:', error);
      }
    }
  }

  private async handleSessionStateChangedMessage(
    message: SDKMessage,
    invocationGeneration: number | null
  ): Promise<void> {
    if (!isSDKSessionStateChangedMessage(message)) return;
    if (this.isInvocationStale(invocationGeneration)) {
      this.logger.warn('Ignoring session-state event from a replaced query.');
      const staleOwner = this.invocationIdleOwner(invocationGeneration);
      if (staleOwner) {
        this.ctx.stateManager.cancelTerminalIdleArm(staleOwner);
      }
      return;
    }

    this.usesSessionStateChangedTurnEnd = true;
    if (message.state === 'idle') {
      this.resetThinkingTokenTracking();
      const clearTurnPending = this.clearAwaitingTrailingIdle || this.suppressIdleOnNextResult;
      if (clearTurnPending) {
        await this.settleIdleForInvocation(invocationGeneration, {
          suppressDeliveryWaiters: true,
          suppressIdlePublish: true,
          suppressIdleCallback: true,
        });
      } else {
        const allowQueueReplay = this.lastResultWasSuccess !== false;
        await this.finishTurn(allowQueueReplay, invocationGeneration);
        if (this.isInvocationStale(invocationGeneration)) return;
        this.usesSessionStateChangedTurnEnd = false;
        this.expectsSessionStateIdleAfterResult = false;
        this.lastResultWasSuccess = null;
      }
      if (this.clearAwaitingTrailingIdle) {
        this.clearAwaitingTrailingIdle = false;
        this.clearMessageInFlight = false;
        this.usesSessionStateChangedTurnEnd = false;
        this.expectsSessionStateIdleAfterResult = false;
        this.lastResultWasSuccess = null;
        this.settleSuppressedResultWaiter('confirmed');
      } else if (clearTurnPending) {
        this.usesSessionStateChangedTurnEnd = false;
        this.expectsSessionStateIdleAfterResult = false;
        this.lastResultWasSuccess = null;
      }
      this.releaseTrailingIdleDeliveryGate();
    }
  }

  private armTrailingIdleDeliveryGate(): void {
    if (this.trailingIdleGateRelease) return;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    this.trailingIdleGateRelease = release;
    const bounded = boundedDeliveryGate(gate);
    this.ctx.messageQueue.setDeliveryGate(bounded);
    void bounded.then(() => {
      if (this.trailingIdleGateRelease === release) {
        this.trailingIdleGateRelease = null;
      }
    });
  }

  private releaseTrailingIdleDeliveryGate(): void {
    this.trailingIdleGateRelease?.();
    this.trailingIdleGateRelease = null;
  }

  private resetThinkingTokenTracking(): void {
    this.currentThinkingTokensEstimate = null;
    this.lastStampedThinkingTokensEstimate = 0;
  }

  private async handleModelRefusalFallbackMessage(message: SDKMessage): Promise<void> {
    const { session, db, internalEventBus } = this.ctx;
    if (!isSDKModelRefusalFallbackMessage(message)) return;
    await this.recordRefusalRewindTarget(message.refused_user_message_uuid);
    if (message.direction !== 'retry') return;
    if (message.scope === 'local') return;
    const providerId = session.config.provider ?? 'anthropic';
    const builtIdentity = getBuiltFallbackIdentity(session);
    if (
      !builtIdentity ||
      builtIdentity.providerId !== providerId ||
      builtIdentity.primaryModel !== session.config.model ||
      builtIdentity.fallbackModel !== session.config.fallbackModel ||
      builtIdentity.scopedApiKey !== session.config.providerConfig?.apiKey ||
      builtIdentity.scopedBaseUrl !== session.config.providerConfig?.baseUrl ||
      builtIdentity.scopedRegion !==
        (typeof session.config.providerConfig?.region === 'string'
          ? session.config.providerConfig.region
          : undefined) ||
      (builtIdentity.providerEpoch !== undefined &&
        builtIdentity.providerEpoch !== getProviderCatalogEpoch(providerId))
    ) {
      return;
    }
    const fallbackModelBeforeResolve = this.ctx.session.config.fallbackModel;
    let fallbackModel: string | undefined;
    try {
      fallbackModel = await this.resolveConfiguredFallbackModel(message.fallback_model);
    } catch {
      this.logger.warn(
        '[SDKMessageHandler] Fallback resolution failed for a stale or removed provider, ignoring retry'
      );
      return;
    }
    if (!fallbackModel || session.config.model === fallbackModel) return;
    if (
      fallbackModelBeforeResolve !== fallbackModel ||
      fallbackModelBeforeResolve !== builtIdentity.fallbackModel ||
      this.ctx.session.config.fallbackModel !== fallbackModel
    ) {
      return;
    }
    const guardsIntact = () => {
      const liveConfig = this.ctx.session.config;
      return (
        (liveConfig.provider ?? 'anthropic') === providerId &&
        liveConfig.fallbackModel === fallbackModel &&
        liveConfig.model === builtIdentity.primaryModel &&
        liveConfig.providerConfig?.apiKey === builtIdentity.scopedApiKey &&
        liveConfig.providerConfig?.baseUrl === builtIdentity.scopedBaseUrl &&
        liveConfig.providerConfig?.region ===
          (typeof builtIdentity.scopedRegion === 'string'
            ? builtIdentity.scopedRegion
            : undefined) &&
        (builtIdentity.providerEpoch === undefined ||
          builtIdentity.providerEpoch === getProviderCatalogEpoch(providerId))
      );
    };
    const outcome = await decideFallbackModelCuration({
      providerId,
      fallbackModel,
      cacheKey: session.id,
      providerConfig: session.config.providerConfig ?? {},
      sessionScopedProvider: Boolean(
        builtIdentity.scopedApiKey || builtIdentity.scopedBaseUrl || builtIdentity.scopedRegion
      ),
      signalAborted: false,
      guardsIntact,
    });
    if (outcome !== 'allowed') {
      if (outcome === 'cancelled') {
        this.logger.warn(
          `[SDKMessageHandler] Session config changed during fallback validation, skipping persistence`
        );
      }
      return;
    }

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

  private async resolveConfiguredFallbackModel(
    sdkFallbackModel: string | undefined
  ): Promise<string | undefined> {
    const configuredFallbackModel = this.ctx.session.config.fallbackModel;
    if (!sdkFallbackModel || !configuredFallbackModel) return undefined;

    const fallbackSession = {
      ...this.ctx.session,
      config: {
        ...this.ctx.session.config,
        model: configuredFallbackModel,
      },
    };
    const contextManager = getProviderContextManager();
    await contextManager.ensureContextReady(fallbackSession);
    const fallbackSdkModel = contextManager.createContext(fallbackSession).getSdkModelId();
    return fallbackSdkModel === sdkFallbackModel ? configuredFallbackModel : undefined;
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

  private async handleCompactBoundary(
    message: SDKMessage,
    invocationGeneration: number | null
  ): Promise<void> {
    const { stateManager, contextTracker } = this.ctx;

    if (!isSDKCompactBoundary(message)) return;
    if (this.isInvocationStale(invocationGeneration)) return;

    this.ctx.messageQueue.acknowledgeCompactionsAwaitingBoundary();
    const boundaryInfo = contextTracker.getContextInfo();
    const boundaryCapacity =
      boundaryInfo && boundaryInfo.totalCapacity > 0 ? boundaryInfo.totalCapacity : undefined;
    contextTracker.markCompactionTriggered(
      boundaryCapacity === undefined
        ? undefined
        : contextBudgetThreshold(boundaryCapacity, boundaryInfo?.autoCompactPercent)
    );
    await stateManager.setCompacting(false);
    this.ctx.messageQueue.clearNonCompactionSentSinceBoundary();

    void this.refreshContextUsage('compact-boundary', undefined, invocationGeneration);
  }

  private maybeRefreshContextOnEvent(
    _message: SDKMessage,
    invocationGeneration?: number | null
  ): void {
    this.eventsSinceContextRefresh += 1;
    if (this.eventsSinceContextRefresh >= CONTEXT_REFRESH_EVENT_INTERVAL) {
      void this.refreshContextUsage('event-tick', undefined, invocationGeneration);
    }
  }

  private isContextRefreshStale(
    queryObject: QueryLike,
    model: string | undefined,
    provider: string | undefined,
    invocationGeneration?: number | null
  ): boolean {
    return (
      this.isInvocationStale(invocationGeneration ?? null) ||
      this.ctx.queryObject !== queryObject ||
      this.ctx.session.config.model !== model ||
      this.ctx.session.config.provider !== provider
    );
  }

  private clearStaleCompacting(): Promise<void> {
    if (!this.ctx.stateManager.getIsCompacting()) return Promise.resolve();
    return this.ctx.stateManager.setCompacting(false).catch((error) => {
      this.logger.warn('Failed to clear compacting state:', error);
    });
  }

  private isDaemonCompactionPending(): boolean {
    const { session, messageQueue, stateManager } = this.ctx;
    const providerId = session.config.provider;
    if (!providerId || providerId === 'acp') return false;
    if (NATIVE_CONTEXT_WINDOW_PROVIDER_IDS.includes(providerId)) return false;
    return messageQueue.hasOutstandingInternalCompaction() || stateManager.getIsCompacting();
  }

  private refreshContextUsage(
    reason: 'event-tick' | 'turn-end' | 'compact-boundary',
    deadlineAt?: number,
    invocationGeneration?: number | null
  ): Promise<void> {
    this.eventsSinceContextRefresh = 0;

    if (this.isInvocationStale(invocationGeneration ?? null)) return Promise.resolve();

    if (this.pendingContextRefresh) {
      if (reason === 'event-tick') {
        return this.pendingContextRefresh;
      }
      const chainDeadline = deadlineAt ?? Date.now() + DELIVERY_GATE_WINDOW_MS;
      const pending = this.pendingContextRefresh;
      this.pendingContextRefresh = pending.then(() =>
        this.refreshContextUsage(reason, chainDeadline, invocationGeneration)
      );
      this.ctx.messageQueue.setDeliveryGate(
        boundedDeliveryGate(
          this.pendingContextRefresh.catch(() => {}),
          chainDeadline
        )
      );
      return this.pendingContextRefresh;
    }

    const { session, internalEventBus, contextTracker, queryObject } = this.ctx;
    if (!queryObject) return Promise.resolve();
    const fenceModel = session.config.model;
    const gateDeadline = deadlineAt ?? Date.now() + DELIVERY_GATE_WINDOW_MS;
    const fenceProvider = session.config.provider;

    const promise = (async () => {
      let clearedDeadCompaction = false;
      try {
        const deadDeliveredCompaction =
          reason === 'turn-end' &&
          this.ctx.messageQueue.hasCompactionsAwaitingBoundary() &&
          !this.ctx.messageQueue.hasQueuedInternalCompaction() &&
          !this.ctx.messageQueue.hasInFlightInternalCompaction() &&
          !this.ctx.stateManager.getIsCompacting();
        if (this.compactionEnqueuedMidTurnGeneration !== undefined) {
          const deferralOwnsThisTurn =
            this.compactionEnqueuedMidTurnGeneration === (invocationGeneration ?? null);
          this.compactionEnqueuedMidTurnGeneration = undefined;
          if (deferralOwnsThisTurn) {
            clearedDeadCompaction = false;
          } else if (deadDeliveredCompaction) {
            this.ctx.messageQueue.acknowledgeCompactionsAwaitingBoundary();
            contextTracker.clearCompactionCooldown();
            this.logger.info(
              `clearing stale compaction cooldown for session ${session.id} after a ` +
                `delivered /compact ended without a compact boundary`
            );
            clearedDeadCompaction = true;
          }
        } else if (deadDeliveredCompaction) {
          this.ctx.messageQueue.acknowledgeCompactionsAwaitingBoundary();
          contextTracker.clearCompactionCooldown();
          this.logger.info(
            `clearing stale compaction cooldown for session ${session.id} after a ` +
              `delivered /compact ended without a compact boundary`
          );
          clearedDeadCompaction = true;
        }
        const modelInfo = await getSessionModelInfo(session);
        if (
          this.isContextRefreshStale(queryObject, fenceModel, fenceProvider, invocationGeneration)
        )
          return;
        const contextInfo: ContextInfo | null = await this.contextFetcher.fetch(
          queryObject,
          modelInfo
        );
        if (
          this.isContextRefreshStale(queryObject, fenceModel, fenceProvider, invocationGeneration)
        )
          return;
        if (!contextInfo) return;
        contextTracker.updateWithDetailedBreakdown(contextInfo);
        const publishProjection = internalEventBus
          .publish('context.updated', {
            sessionId: session.id,
            contextInfo,
          })
          .catch((error) => {
            this.logger.warn(
              `context.updated publication failed for session ${session.id}:`,
              error
            );
          });
        if (
          !this.isContextRefreshStale(queryObject, fenceModel, fenceProvider, invocationGeneration)
        ) {
          const outcome = enforceContextBudget({
            sessionId: session.id,
            providerId: session.config.provider,
            reason,
            contextInfo,
            fallbackContextWindow: modelInfo?.contextWindow,
            clearedDeadCompaction,
            limitRecoveryPending: this.ctx.isLimitRecoveryPending?.() ?? false,
            contextTracker,
            messageQueue: this.ctx.messageQueue,
            stateManager: this.ctx.stateManager,
            logger: this.logger,
            onCompactionAbandoned: () => {
              this.compactionEnqueuedMidTurnGeneration = undefined;
            },
          });
          if (
            outcome.compactionEnqueued &&
            reason === 'event-tick' &&
            this.ctx.stateManager.getState().status === 'processing'
          ) {
            this.compactionEnqueuedMidTurnGeneration = invocationGeneration ?? null;
          }
        }
        await boundedDeliveryGate(
          publishProjection.then(() => undefined),
          gateDeadline
        );
      } catch (error) {
        this.logger.warn(`context refresh (${reason}) failed:`, error);
      } finally {
        this.pendingContextRefresh = null;
        if (reason === 'turn-end' && !this.isDaemonCompactionPending()) {
          this.ctx.messageQueue.pruneSentPrompts();
        }
      }
    })();
    this.pendingContextRefresh = promise;
    const enforcesBudget =
      !!session.config.provider &&
      session.config.provider !== 'acp' &&
      !NATIVE_CONTEXT_WINDOW_PROVIDER_IDS.includes(session.config.provider);
    if (reason !== 'event-tick' || enforcesBudget) {
      this.ctx.messageQueue.setDeliveryGate(
        boundedDeliveryGate(
          promise.catch(() => {}),
          gateDeadline
        )
      );
    }
    return promise;
  }
}
