import type { Session } from '@hyperneo/shared';
import type { SDKMessage } from '@hyperneo/shared/sdk';
import { isSDKUserMessage } from '@hyperneo/shared/sdk/type-guards';
import type { Database } from '../../storage/database.ts';
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
  type MessageDeliveryOrigin,
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

  ensureQueryStarted(): Promise<void>;
}

export class QueryModeHandler {
  constructor(private ctx: QueryModeHandlerContext) {}

  async handleQueryTrigger(options?: {
    deliverIndividually?: boolean;
    excludeMessageUuid?: string;
    skipContextReset?: boolean;
    pendingTaskInput?: boolean;
  }): Promise<{
    success: boolean;
    messageCount: number;
    error?: string;
  }> {
    const { session, db, internalEventBus, logger } = this.ctx;

    const runFlush = async (): Promise<number> => {
      type DigestRowFilter = ((row: { uuid: string; taskId?: string }) => boolean) | null;
      let digestRowFilter: DigestRowFilter = null;
      const admittedTaskId = session.context?.taskId;
      const taskScoped = (row: { uuid: string; taskId?: string }): boolean =>
        admittedTaskId === undefined || (row.taskId !== undefined && row.taskId === admittedTaskId);
      try {
        const renderDigest = this.ctx.renderPendingDigest;
        const outcome = renderDigest
          ? await renderDigest(session.id, session.context?.taskId)
          : null;
        if (outcome == null) {
          if (renderDigest) {
            logger.warn(
              `turn-end digest pull for session ${session.id} was unavailable ` +
                `(runtime stopped or digest pipeline missing) — flushing without the digest`
            );
          }
        } else if (outcome.action === 'delivered') {
          digestRowFilter = (row) => row.uuid === outcome.uuid;
        } else if (outcome.action === 'skip') {
          if (outcome.heldDigestInFlight) {
            logger.warn(
              `turn-end digest pull for session ${session.id} held a digest already in ` +
                `flight — flushing without the digest`
            );
          } else if (
            outcome.reason === 'session_interrupted' ||
            outcome.reason === 'session_not_current' ||
            outcome.reason === 'task_not_admissible' ||
            outcome.reason === 'space_paused' ||
            outcome.reason === 'no_execution'
          ) {
            logger.warn(
              `turn-end digest pull for session ${session.id} skipped ` +
                `(reason=${outcome.reason}) — flushing without the digest`
            );
          } else {
            digestRowFilter = taskScoped;
          }
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
      } catch (error) {
        logger.warn(
          `turn-end digest pull failed for session ${session.id}: ` +
            `${error instanceof Error ? error.message : String(error)} — flushing without the digest`
        );
      }
      const { messages: allDeferred } = db.getUserMessagesByStatus(session.id, 'deferred');
      const backlogBase = options?.excludeMessageUuid
        ? allDeferred.filter((m) => m.uuid !== options.excludeMessageUuid)
        : allDeferred;
      const backlog = backlogBase.filter((m) => {
        const uuid = String(m.uuid);
        if (!uuid.startsWith(DETERMINISTIC_DIGEST_UUID_PREFIX)) return true;
        const rowTaskId = (m as { externalEventTaskId?: unknown }).externalEventTaskId;
        return (
          digestRowFilter !== null &&
          digestRowFilter({ uuid, taskId: typeof rowTaskId === 'string' ? rowTaskId : undefined })
        );
      });

      if (backlog.length === 0) {
        return 0;
      }

      const dbIds = backlog.map((m) => m.dbId);
      db.updateMessageStatus(dbIds, 'enqueued');
      const flushMessages = this.toFlushMessages(backlog);

      let reDeferredDbIds: string[] = [];
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

      const admittedDbIds = dbIds.filter((id) => !reDeferredDbIds.includes(id));
      if (admittedDbIds.length > 0) {
        await internalEventBus.publish('messages.statusChanged', {
          sessionId: session.id,
          messageIds: admittedDbIds,
          status: 'enqueued',
        });
      }

      return backlog.length;
    };

    try {
      const messageCount = await runFlush();
      return { success: true, messageCount };
    } catch (error) {
      if (error instanceof ClearConversationCancelledError) throw error;
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      logger.error('Failed to trigger query:', error);
      return { success: false, messageCount: 0, error: errorMessage };
    }
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

  async sendEnqueuedMessagesOnTurnEnd(options?: { pendingTaskInput?: boolean }): Promise<{
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

      const v2 = await this.deliverFlushUnderV2(this.toFlushMessages(pendingMessages), 'recovery', {
        pendingTaskInput: options?.pendingTaskInput,
      });
      clearedContext = v2.clearedContext;
    };

    try {
      await runReplay();
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
}
