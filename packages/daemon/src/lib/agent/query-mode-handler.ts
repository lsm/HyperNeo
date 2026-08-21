import type { MessageContent, Session } from '@hyperneo/shared';
import type { SDKMessage } from '@hyperneo/shared/sdk';
import { isSDKUserMessage } from '@hyperneo/shared/sdk/type-guards';
import type { Database } from '../../storage/database';
import type { DaemonInternalEventMap, InternalEventBus } from '../internal-event-bus';
import type { Logger } from '../logger';
import {
  deliverAndMarkQueued,
  deliverBatchAndMarkQueued,
  flattenDeliveryText,
  isMessageDeliveryV2Enabled,
  type MessageDeliveryOrigin,
} from './message-delivery';
import { decideTurnEndFlush } from './message-delivery-pipeline';
import type { MessageQueue } from './message-queue';

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

  ensureQueryStarted(): Promise<void>;
}

export class QueryModeHandler {
  constructor(private ctx: QueryModeHandlerContext) {}

  async handleQueryTrigger(options?: {
    deliverIndividually?: boolean;
    excludeMessageUuid?: string;
  }): Promise<{
    success: boolean;
    messageCount: number;
    error?: string;
  }> {
    const { session, db, internalEventBus, messageQueue, logger } = this.ctx;

    try {
      const { messages: allDeferred } = db.getUserMessagesByStatus(session.id, 'deferred');
      const deferredMessages = options?.excludeMessageUuid
        ? allDeferred.filter((m) => m.uuid !== options.excludeMessageUuid)
        : allDeferred;

      if (deferredMessages.length === 0) {
        return { success: true, messageCount: 0 };
      }

      const dbIds = deferredMessages.map((m) => m.dbId);
      db.updateMessageStatus(dbIds, 'enqueued');

      if (isMessageDeliveryV2Enabled()) {
        try {
          await this.deliverFlushUnderV2(deferredMessages, 'recovery', options);
        } catch (error) {
          await internalEventBus.publish('messages.statusChanged', {
            sessionId: session.id,
            messageIds: dbIds,
            status: 'enqueued',
          });
          throw error;
        }
      }

      await internalEventBus.publish('messages.statusChanged', {
        sessionId: session.id,
        messageIds: dbIds,
        status: 'enqueued',
      });

      if (!isMessageDeliveryV2Enabled()) {
        const v2Owned =
          db.getJobQueueRepo?.()?.activeDeliveryMessageUuids?.(session.id) ?? new Set<string>();
        await this.ctx.ensureQueryStarted();
        for (const msg of deferredMessages) {
          if (typeof msg.uuid !== 'string' || msg.uuid.length === 0) continue;
          if (v2Owned.has(msg.uuid)) continue;
          const replayContent = this.toReplayContent(msg.message.content);
          if (replayContent) {
            await messageQueue.enqueueWithId(msg.uuid, replayContent);
          }
        }
      }

      return { success: true, messageCount: deferredMessages.length };
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      logger.error('Failed to trigger query:', error);
      return { success: false, messageCount: 0, error: errorMessage };
    }
  }

  private async deliverFlushUnderV2(
    messages: Array<SDKMessage & { dbId: string; timestamp: number }>,
    origin: MessageDeliveryOrigin,
    options?: { deliverIndividually?: boolean }
  ): Promise<void> {
    const jobQueue = this.ctx.db.getJobQueueRepo();
    const flushMessages = messages
      .filter((msg) => typeof msg.uuid === 'string' && msg.uuid.length > 0)
      .map((msg) => {
        const isUserMessage = isSDKUserMessage(msg);
        return {
          uuid: msg.uuid as string,
          isUserMessage,
          flattenedText: isUserMessage ? flattenDeliveryText(msg.message.content ?? '') : null,
        };
      });
    const plan = decideTurnEndFlush({
      messages: flushMessages,
      activeInJobQueue: jobQueue.activeDeliveryMessageUuids(this.ctx.session.id),
      pendingInMemoryUuids: new Set(
        flushMessages
          .filter((msg) => this.ctx.messageQueue.hasPendingOrInFlight(msg.uuid))
          .map((msg) => msg.uuid)
      ),
      activeTurnInJobQueue: jobQueue.hasActiveTurnDelivery(this.ctx.session.id),
      slotResetsContext: false,
    });
    if (plan.action === 'noop') return;
    const deliverables = plan.action === 'batch' ? plan.uuids : plan.deliver;
    if (plan.action === 'batch' && !options?.deliverIndividually) {
      const batched = await deliverBatchAndMarkQueued({
        jobQueue,
        stateManager: this.ctx.stateManager,
        sessionId: this.ctx.session.id,
        messageUuids: deliverables,
        origin,
      });
      if (batched) return;
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
  }

  async sendEnqueuedMessagesOnTurnEnd(): Promise<void> {
    const { session, db, messageQueue, logger } = this.ctx;

    try {
      const { messages: queuedMessages } = db.getUserMessagesByStatus(session.id, 'enqueued');
      const pendingMessages = queuedMessages.filter(
        (msg) => typeof msg.uuid === 'string' && !messageQueue.hasPendingOrInFlight(msg.uuid)
      );

      if (pendingMessages.length === 0) {
        return;
      }

      if (isMessageDeliveryV2Enabled()) {
        await this.deliverFlushUnderV2(pendingMessages, 'recovery');
      } else {
        const v2Owned =
          db.getJobQueueRepo?.()?.activeDeliveryMessageUuids?.(session.id) ?? new Set<string>();
        await this.ctx.ensureQueryStarted();
        for (const msg of pendingMessages) {
          if (v2Owned.has((msg.uuid ?? '') as string)) continue;
          const replayContent = this.toReplayContent(msg.message.content);
          if (replayContent) {
            await messageQueue.enqueueWithId(msg.uuid as string, replayContent);
          }
        }
      }
    } catch (error) {
      logger.error('Failed to send enqueued messages on turn end:', error);
    }
  }

  async replayPendingMessagesForImmediateMode(): Promise<void> {
    await this.sendEnqueuedMessagesOnTurnEnd();
    await this.handleQueryTrigger();
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
