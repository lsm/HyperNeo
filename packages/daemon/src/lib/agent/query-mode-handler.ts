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
  prepareContextResetFlush?(pendingCount: number): Promise<'prepared' | 'noop'>;
}

export class QueryModeHandler {
  constructor(private ctx: QueryModeHandlerContext) {}

  async handleQueryTrigger(): Promise<{
    success: boolean;
    messageCount: number;
    error?: string;
  }> {
    const { session, db, internalEventBus, messageQueue, logger } = this.ctx;

    try {
      const deferredMessages = db.getMessagesByStatus(session.id, 'deferred');

      if (deferredMessages.length === 0) {
        return { success: true, messageCount: 0 };
      }

      await this.ctx.prepareContextResetFlush?.(deferredMessages.length);

      const dbIds = deferredMessages.map((m) => m.dbId);
      db.updateMessageStatus(dbIds, 'enqueued');

      await internalEventBus.publish('messages.statusChanged', {
        sessionId: session.id,
        messageIds: dbIds,
        status: 'enqueued',
      });

      if (isMessageDeliveryV2Enabled()) {
        await this.deliverFlushUnderV2(deferredMessages, 'recovery');
      } else {
        const v2Owned =
          db.getJobQueueRepo?.()?.activeDeliveryMessageUuids?.(session.id) ?? new Set<string>();
        await this.ctx.ensureQueryStarted();
        for (const msg of deferredMessages) {
          if (!isSDKUserMessage(msg)) continue;
          if (v2Owned.has((msg.uuid ?? '') as string)) continue;
          const replayContent = this.toReplayContent(msg.message.content);
          if (replayContent) {
            await messageQueue.enqueueWithId(msg.uuid as string, replayContent);
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
    origin: MessageDeliveryOrigin
  ): Promise<void> {
    const jobQueue = this.ctx.db.getJobQueueRepo();
    const pending = messages.filter(
      (msg) => isSDKUserMessage(msg) && typeof msg.uuid === 'string' && msg.uuid.length > 0
    );
    const allBatchable = pending.every((msg) => {
      if (!isSDKUserMessage(msg)) return false;
      const text = flattenDeliveryText(msg.message.content ?? '');
      return text !== null && !text.startsWith('/');
    });

    if (allBatchable && pending.length >= 2) {
      const batched = await deliverBatchAndMarkQueued({
        jobQueue,
        stateManager: this.ctx.stateManager,
        sessionId: this.ctx.session.id,
        messageUuids: pending.map((m) => m.uuid as string),
        origin,
      });
      if (batched) return;
    }
    await this.deliverEachUnderV2(pending, origin);
  }

  private async deliverEachUnderV2(
    messages: Array<SDKMessage & { dbId: string; timestamp: number }>,
    origin: MessageDeliveryOrigin
  ): Promise<void> {
    const jobQueue = this.ctx.db.getJobQueueRepo();
    const active = jobQueue.activeDeliveryMessageUuids(this.ctx.session.id);
    for (const msg of messages) {
      const uuid = msg.uuid as string;
      if (active.has(uuid)) continue;
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
      const queuedMessages = db.getMessagesByStatus(session.id, 'enqueued');

      if (queuedMessages.length === 0) {
        return;
      }

      await this.ctx.prepareContextResetFlush?.(queuedMessages.length);

      if (isMessageDeliveryV2Enabled()) {
        await this.deliverFlushUnderV2(queuedMessages, 'recovery');
      } else {
        const v2Owned =
          db.getJobQueueRepo?.()?.activeDeliveryMessageUuids?.(session.id) ?? new Set<string>();
        await this.ctx.ensureQueryStarted();
        for (const msg of queuedMessages) {
          if (!isSDKUserMessage(msg)) continue;
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
