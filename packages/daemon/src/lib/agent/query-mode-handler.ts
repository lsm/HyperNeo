import type { MessageContent, Session } from '@hyperneo/shared';
import type { SDKMessage, SDKUserMessage } from '@hyperneo/shared/sdk';
import { isSDKUserMessage } from '@hyperneo/shared/sdk/type-guards';
import type { Database } from '../../storage/database.ts';
import {
  DEFERRED_FOLD_UUID_PREFIX,
  foldDeferredExternalEventsAtFlush,
} from '../external-events/deferred-event-digest.ts';
import { isExternalEventDeliveryV2Enabled } from '../external-events/external-event-service.ts';
import {
  DETERMINISTIC_DIGEST_UUID_PREFIX,
  type RenderPendingDigestOutcome,
} from '../space/runtime/render-pending-digest-pipeline.ts';
import type { DaemonInternalEventMap, InternalEventBus } from '../internal-event-bus.ts';
import type { Logger } from '../logger.ts';
import { ClearConversationCancelledError } from './agent-session.ts';
import {
  deliverAndMarkQueued,
  deliverBatchAndMarkQueued,
  flattenDeliveryText,
  isMessageDeliveryV2Enabled,
  type MessageDeliveryOrigin,
  withSessionResetCoordination,
} from './message-delivery.ts';
import { decideTurnEndFlush, type TurnEndFlushPlan } from './message-delivery-pipeline.ts';
import { type FlushMessage, isTaskFlushInput } from './message-ownership-gates.ts';
import type { MessageQueue } from './message-queue.ts';

export interface QueryModeHandlerContext {
  readonly session: Session;
  readonly db: Database;
  readonly internalEventBus: InternalEventBus<DaemonInternalEventMap>;
  readonly messageQueue: MessageQueue;
  readonly logger: Logger;
  readonly stateManager?: {
    setQueuedIfIdle(messageId: string): Promise<boolean>;
    getState(): { status: string };
  };
  slotResetsContext?(): boolean;
  clearConversationContext?(): Promise<void>;
  renderPendingDigest?(
    sessionId: string,
    taskId?: string
  ): Promise<RenderPendingDigestOutcome | null>;
  reconcilePersistedDigestRows?(sessionId: string, taskId?: string): void;

  ensureQueryStarted(): Promise<void>;
}

export class QueryModeHandler {
  constructor(private ctx: QueryModeHandlerContext) {}

  async handleQueryTrigger(options?: {
    deliverIndividually?: boolean;
    excludeMessageUuid?: string;
    skipContextReset?: boolean;
    skipResetCoordination?: boolean;
    pendingTaskInput?: boolean;
  }): Promise<{
    success: boolean;
    messageCount: number;
    error?: string;
  }> {
    const { session, db, internalEventBus, logger } = this.ctx;

    const runFlush = async (): Promise<number> => {
      let excludeDigestRows = false;
      if (isExternalEventDeliveryV2Enabled()) {
        try {
          const outcome = await this.ctx.renderPendingDigest?.(session.id, session.context?.taskId);
          if (outcome && (outcome.action === 'failed' || outcome.action === 'held')) {
            if (
              outcome.action === 'failed' &&
              (outcome.stage === 'digestCleanup' || outcome.stage === 'digestSupersede')
            ) {
              logger.warn(
                `turn-end digest ${outcome.stage} failed for session ${session.id} — ` +
                  `excluding digest rows from this flush so stale or duplicate digests are not delivered`
              );
              excludeDigestRows = true;
            } else {
              logger.warn(
                `turn-end digest pull for session ${session.id} did not deliver ` +
                  `(action=${outcome.action}${
                    outcome.action === 'failed'
                      ? `, stage=${outcome.stage}`
                      : `, reason=${outcome.reason}`
                  }) — flushing without the digest`
              );
            }
          }
        } catch (error) {
          logger.warn(
            `turn-end digest pull failed for session ${session.id}: ` +
              `${error instanceof Error ? error.message : String(error)} — flushing without the digest`
          );
        }
      } else if (this.ctx.reconcilePersistedDigestRows) {
        try {
          this.ctx.reconcilePersistedDigestRows(session.id, session.context?.taskId);
        } catch (error) {
          logger.warn(
            `flag-off digest reconcile failed for session ${session.id}: ` +
              `${error instanceof Error ? error.message : String(error)} — excluding digest rows ` +
              `from this flush so the digest and the original events are not both delivered`
          );
          excludeDigestRows = true;
        }
      } else {
        excludeDigestRows = true;
      }

      const { messages: allDeferred } = db.getUserMessagesByStatus(session.id, 'deferred');
      const backlogBase = options?.excludeMessageUuid
        ? allDeferred.filter((m) => m.uuid !== options.excludeMessageUuid)
        : allDeferred;
      const backlog = excludeDigestRows
        ? backlogBase.filter((m) => !String(m.uuid).startsWith(DETERMINISTIC_DIGEST_UUID_PREFIX))
        : backlogBase;

      if (backlog.length === 0) {
        return 0;
      }

      const deferredMessages = await this.foldDeferredExternalEvents(backlog);

      const dbIds = deferredMessages.map((m) => m.dbId);
      db.updateMessageStatus(dbIds, 'enqueued');
      const flushMessages = this.toFlushMessages(deferredMessages);

      let reDeferredDbIds: string[] = [];
      if (isMessageDeliveryV2Enabled()) {
        try {
          const v2 = await this.deliverFlushUnderV2(flushMessages, 'recovery', options);
          reDeferredDbIds = v2.reDeferredDbIds;
        } catch (error) {
          await internalEventBus.publish('messages.statusChanged', {
            sessionId: session.id,
            messageIds: dbIds.filter((id) => !reDeferredDbIds.includes(id)),
            status: 'enqueued',
          });
          throw error;
        }
      }

      const admittedDbIds = dbIds.filter((id) => !reDeferredDbIds.includes(id));
      if (admittedDbIds.length > 0) {
        await internalEventBus.publish('messages.statusChanged', {
          sessionId: session.id,
          messageIds: admittedDbIds,
          status: 'enqueued',
        });
      }

      if (!isMessageDeliveryV2Enabled()) {
        await this.deliverRowsViaMemoryQueue(deferredMessages, flushMessages, options);
      }

      return deferredMessages.length;
    };

    try {
      const messageCount = options?.skipResetCoordination
        ? await runFlush()
        : await withSessionResetCoordination(session.id, runFlush);
      return { success: true, messageCount };
    } catch (error) {
      if (error instanceof ClearConversationCancelledError) throw error;
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      logger.error('Failed to trigger query:', error);
      return { success: false, messageCount: 0, error: errorMessage };
    }
  }

  private async foldDeferredExternalEvents(
    rows: Array<SDKUserMessage & { dbId: string; timestamp: number }>
  ): Promise<Array<SDKUserMessage & { dbId: string; timestamp: number }>> {
    const sessionId = this.ctx.session.id;
    const result = await foldDeferredExternalEventsAtFlush({
      sessionId,
      rows,
      ops: {
        findByUuid: async (uuid) => {
          const repo = this.ctx.db.getSDKMessageRepo();
          return (
            repo.getMessageByStatusAndUuid(sessionId, 'enqueued', uuid) ??
            repo.getMessageByStatusAndUuid(sessionId, 'deferred', uuid)
          );
        },
        supersedeStaleFolds: async (keepUuid) => {
          const { messages } = this.ctx.db.getUserMessagesByStatus(sessionId, 'enqueued');
          const staleDbIds = messages
            .filter(
              (message) =>
                typeof message.uuid === 'string' &&
                message.uuid.startsWith(DEFERRED_FOLD_UUID_PREFIX) &&
                message.uuid !== keepUuid
            )
            .map((message) => message.dbId);
          if (staleDbIds.length === 0) return;
          this.ctx.db.updateMessageStatus(staleDbIds, 'consumed');
          await this.ctx.internalEventBus
            .publish('messages.statusChanged', {
              sessionId,
              messageIds: staleDbIds,
              status: 'consumed',
            })
            .catch(() => {});
        },
        saveRow: async (message, sendStatus) => {
          const dbId = this.ctx.db.saveUserMessage(sessionId, message, sendStatus);
          await this.ctx.internalEventBus
            .publish('messages.statusChanged', {
              sessionId,
              messageIds: [dbId],
              status: sendStatus,
            })
            .catch(() => {});
          return dbId;
        },
        markSuperseded: async (dbIds) => {
          this.ctx.db.updateMessageStatus(dbIds, 'consumed');
          await this.ctx.internalEventBus
            .publish('messages.statusChanged', {
              sessionId,
              messageIds: dbIds,
              status: 'consumed',
            })
            .catch(() => {});
        },
      },
    });
    if (!result.digestRow) return rows;
    this.ctx.logger.info(
      `turn-end flush folded ${result.foldedCount} deferred external events into one digest ` +
        `for session ${sessionId}`
    );
    return [...result.remainder, result.digestRow];
  }

  private flushClearBlockedByLiveWork(): boolean {
    if (this.ctx.messageQueue.size() > 0) return true;
    const status = this.ctx.stateManager?.getState().status;
    return status !== undefined && status !== 'idle';
  }

  private async deliverRowsViaMemoryQueue(
    messages: Array<SDKUserMessage & { dbId: string; timestamp: number }>,
    flushMessages: FlushMessage[],
    options?: { skipContextReset?: boolean; pendingTaskInput?: boolean }
  ): Promise<boolean> {
    const session = this.ctx.session;
    const v2Owned =
      this.ctx.db.getJobQueueRepo?.()?.activeDeliveryMessageUuids?.(session.id) ??
      new Set<string>();
    const taskUuids = new Set(
      flushMessages.filter((message) => message.isTaskInput).map((message) => message.uuid)
    );
    const plan = this.planFlush(flushMessages, options);
    const deferForActiveJob =
      plan.action !== 'noop' &&
      plan.contextReset.action === 'flush_without_clear' &&
      plan.contextReset.reason === 'active_delivery_job';
    await this.ctx.ensureQueryStarted();
    let clearAttempted = false;
    let clearedContext = false;
    const clearAheadOfTask = async (): Promise<void> => {
      clearAttempted = true;
      clearedContext = await this.clearContextAheadOfFlush(flushMessages, options);
    };
    for (const msg of messages) {
      if (typeof msg.uuid !== 'string' || msg.uuid.length === 0) continue;
      if (v2Owned.has(msg.uuid)) continue;
      const replayContent = this.toReplayContent(msg.message.content);
      if (!replayContent) continue;
      if (!clearAttempted && taskUuids.has(msg.uuid)) {
        if (this.flushClearBlockedByLiveWork() || deferForActiveJob) {
          await this.deferRemainingRows(messages, v2Owned, msg.uuid);
          return clearedContext;
        }
        await clearAheadOfTask();
      }
      await this.ctx.messageQueue.enqueueWithId(msg.uuid, replayContent);
    }
    if (
      !clearAttempted &&
      options?.pendingTaskInput === true &&
      !this.flushClearBlockedByLiveWork()
    ) {
      await clearAheadOfTask();
    }
    return clearedContext;
  }

  private async deferRemainingRows(
    messages: Array<SDKUserMessage & { dbId: string; timestamp: number }>,
    v2Owned: ReadonlySet<string>,
    fromUuid: string
  ): Promise<void> {
    const dbIds: string[] = [];
    let delaying = false;
    for (const msg of messages) {
      if (!delaying && msg.uuid !== fromUuid) continue;
      delaying = true;
      if (typeof msg.uuid !== 'string' || msg.uuid.length === 0) continue;
      if (v2Owned.has(msg.uuid)) continue;
      dbIds.push(msg.dbId);
    }
    if (dbIds.length === 0) return;
    this.ctx.db.updateMessageStatus(dbIds, 'deferred');
    await this.ctx.internalEventBus.publish('messages.statusChanged', {
      sessionId: this.ctx.session.id,
      messageIds: dbIds,
      status: 'deferred',
    });
  }

  private toFlushMessages(
    messages: Array<SDKMessage & { dbId: string; timestamp: number }>
  ): FlushMessage[] {
    return messages
      .filter((msg) => typeof msg.uuid === 'string' && msg.uuid.length > 0)
      .map((msg) => {
        const isUserMessage = isSDKUserMessage(msg);
        return {
          uuid: msg.uuid as string,
          dbId: msg.dbId,
          isUserMessage,
          isTaskInput: isTaskFlushInput(msg as { isSynthetic?: boolean; inputKind?: string }),
          flattenedText: isUserMessage ? flattenDeliveryText(msg.message.content ?? '') : null,
        };
      });
  }

  private planFlush(
    flushMessages: FlushMessage[],
    options?: { pendingTaskInput?: boolean }
  ): TurnEndFlushPlan {
    const jobQueue = this.ctx.db.getJobQueueRepo?.();
    return decideTurnEndFlush({
      messages: flushMessages,
      activeInJobQueue:
        jobQueue?.activeDeliveryMessageUuids?.(this.ctx.session.id) ?? new Set<string>(),
      pendingInMemoryUuids: new Set<string>(),
      activeTurnInJobQueue: jobQueue?.hasActiveTurnDeliveryJob?.(this.ctx.session.id) ?? false,
      slotResetsContext: this.ctx.slotResetsContext?.() ?? false,
      hasPriorContext: !!(this.ctx.session.sdkSessionId || this.ctx.session.acpSessionId),
      pendingTaskInput: options?.pendingTaskInput === true,
    });
  }

  private async clearContextAheadOfFlush(
    flushMessages: FlushMessage[],
    options?: { skipContextReset?: boolean; pendingTaskInput?: boolean }
  ): Promise<boolean> {
    if (options?.skipContextReset) return false;
    if (!this.ctx.clearConversationContext) return false;
    const plan = this.planFlush(flushMessages, options);
    if (plan.action === 'noop') return false;
    if (plan.contextReset.action !== 'clear_then_flush') return false;
    try {
      await this.ctx.clearConversationContext();
    } catch (error) {
      if (error instanceof ClearConversationCancelledError) throw error;
      this.ctx.logger.warn(
        `turn-end flush clear failed for session ${this.ctx.session.id}: ` +
          `${error instanceof Error ? error.message : String(error)} — flushing without clear`
      );
      return false;
    }
    return true;
  }

  private async deferTaskDeliverables(
    flushMessages: FlushMessage[],
    deliverables: ReadonlySet<string>
  ): Promise<string[]> {
    const dbIds = flushMessages
      .filter((message) => message.isTaskInput && deliverables.has(message.uuid))
      .map((message) => message.dbId);
    if (dbIds.length === 0) return [];
    this.ctx.db.updateMessageStatus(dbIds, 'deferred');
    await this.ctx.internalEventBus.publish('messages.statusChanged', {
      sessionId: this.ctx.session.id,
      messageIds: dbIds,
      status: 'deferred',
    });
    return dbIds;
  }

  private async deliverFlushUnderV2(
    flushMessages: FlushMessage[],
    origin: MessageDeliveryOrigin,
    options?: {
      deliverIndividually?: boolean;
      skipContextReset?: boolean;
      pendingTaskInput?: boolean;
    }
  ): Promise<{ clearedContext: boolean; reDeferredDbIds: string[] }> {
    const jobQueue = this.ctx.db.getJobQueueRepo();
    const plan = this.planFlush(flushMessages, options);
    if (plan.action === 'noop') return { clearedContext: false, reDeferredDbIds: [] };
    let clearedContext = false;
    let reDeferredDbIds: string[] = [];
    let deliverables = plan.action === 'batch' ? plan.uuids : plan.deliver;
    if (plan.contextReset.action === 'clear_then_flush') {
      clearedContext = await this.clearContextAheadOfFlush(flushMessages, options);
    } else if (plan.contextReset.reason === 'active_delivery_job') {
      const deliverableSet = new Set(deliverables);
      reDeferredDbIds = await this.deferTaskDeliverables(flushMessages, deliverableSet);
      deliverables = deliverables.filter((uuid) => {
        const message = flushMessages.find((entry) => entry.uuid === uuid);
        return message !== undefined && !message.isTaskInput;
      });
      if (deliverables.length === 0) return { clearedContext, reDeferredDbIds };
    }
    if (plan.action === 'batch' && !options?.deliverIndividually) {
      const batched = await deliverBatchAndMarkQueued({
        jobQueue,
        stateManager: this.ctx.stateManager,
        sessionId: this.ctx.session.id,
        messageUuids: deliverables,
        origin,
      });
      if (batched) return { clearedContext, reDeferredDbIds };
    }
    for (const uuid of deliverables) {
      await deliverAndMarkQueued({
        jobQueue,
        stateManager: this.ctx.stateManager,
        sessionId: this.ctx.session.id,
        messageUuid: uuid,
        origin,
      });
    }
    return { clearedContext, reDeferredDbIds };
  }

  async sendEnqueuedMessagesOnTurnEnd(options?: {
    pendingTaskInput?: boolean;
    skipResetCoordination?: boolean;
  }): Promise<{
    replayedWork: boolean;
    clearedContext: boolean;
    replayFailed: boolean;
  }> {
    const { session, db, messageQueue, logger } = this.ctx;
    let replayedWork = false;
    let clearedContext = false;
    let replayFailed = false;

    const runReplay = async (): Promise<void> => {
      const { messages: queuedMessages } = db.getUserMessagesByStatus(session.id, 'enqueued');
      const pendingMessages = queuedMessages.filter(
        (msg) => typeof msg.uuid === 'string' && !messageQueue.hasPendingOrInFlight(msg.uuid)
      );

      if (pendingMessages.length === 0) {
        return;
      }
      replayedWork = true;

      if (isMessageDeliveryV2Enabled()) {
        const v2 = await this.deliverFlushUnderV2(
          this.toFlushMessages(pendingMessages),
          'recovery',
          { pendingTaskInput: options?.pendingTaskInput }
        );
        clearedContext = v2.clearedContext;
      } else {
        clearedContext = await this.deliverRowsViaMemoryQueue(
          pendingMessages,
          this.toFlushMessages(pendingMessages),
          { pendingTaskInput: options?.pendingTaskInput }
        );
      }
    };

    try {
      if (options?.skipResetCoordination) {
        await runReplay();
      } else {
        await withSessionResetCoordination(session.id, runReplay);
      }
    } catch (error) {
      if (error instanceof ClearConversationCancelledError) throw error;
      replayFailed = true;
      logger.error('Failed to send enqueued messages on turn end:', error);
    }
    return { replayedWork, clearedContext, replayFailed };
  }

  async replayPendingMessagesForAutomaticTurnEnd(): Promise<void> {
    if (this.ctx.session.config.queryMode === 'manual') return;
    if (this.ctx.stateManager?.getState().status === 'waiting_for_input') return;
    await this.replayPendingMessagesForImmediateMode();
  }

  async replayPendingMessagesForImmediateMode(): Promise<void> {
    const { clearedContext, replayFailed } = await this.sendEnqueuedMessagesOnTurnEnd();
    if (replayFailed) return;
    if (!clearedContext) {
      const jobQueue = this.ctx.db.getJobQueueRepo?.();
      if (jobQueue?.activeDeliveryMessageUuids?.(this.ctx.session.id).size) {
        this.schedulePostSettlementFlush();
        return;
      }
    }
    await this.handleQueryTrigger({ skipContextReset: clearedContext });
  }

  private postSettlementFlushScheduled = false;

  private schedulePostSettlementFlush(): void {
    if (this.postSettlementFlushScheduled) return;
    this.postSettlementFlushScheduled = true;
    void (async () => {
      try {
        const jobQueue = this.ctx.db.getJobQueueRepo?.();
        for (let i = 0; i < 240; i++) {
          await new Promise((resolve) => setTimeout(resolve, 500));
          if (!jobQueue?.activeDeliveryMessageUuids?.(this.ctx.session.id).size) break;
        }
        await this.handleQueryTrigger();
      } catch (error) {
        this.ctx.logger.warn(
          `post-settlement deferred flush failed for session ${this.ctx.session.id}:`,
          error
        );
      } finally {
        this.postSettlementFlushScheduled = false;
      }
    })();
  }

  private toReplayContent(
    content: string | Array<{ type: string; text?: string }>
  ): string | MessageContent[] | null {
    if (typeof content === 'string') {
      return content || null;
    }

    if (Array.isArray(content)) {
      if (content.some((block) => block.type !== 'text')) {
        return content as MessageContent[];
      }

      const textContent = content
        .filter((c): c is { type: 'text'; text: string } => c.type === 'text' && !!c.text)
        .map((c) => c.text)
        .join('\n');
      return textContent || null;
    }

    return null;
  }
}
