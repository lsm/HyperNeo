import type { Session, MessageContent } from '@hyperneo/shared';
import type { DaemonInternalEventMap, InternalEventBus } from '../internal-event-bus';
import type { Logger } from '../logger';
import { Logger as LoggerClass } from '../logger';
import type { ModelSwitchHandler } from './model-switch-handler';
import type { InterruptHandler } from './interrupt-handler';
import type { QueryModeHandler } from './query-mode-handler';
import { isMessageDeliveryV2Enabled } from './message-delivery';

export interface EventSubscriptionSetupContext {
  readonly session: Session;
  readonly internalEventBus: InternalEventBus<DaemonInternalEventMap>;

  readonly modelSwitchHandler: ModelSwitchHandler;
  readonly interruptHandler: InterruptHandler;
  readonly queryModeHandler: QueryModeHandler;

  resetQuery(options?: {
    restartQuery?: boolean;
    hardReset?: boolean;
  }): Promise<{ success: boolean; error?: string }>;
  startQueryAndEnqueue(messageId: string, messageContent: string | MessageContent[]): Promise<void>;
  deliverChatMessage?(messageId: string): Promise<void>;
}

export class EventSubscriptionSetup {
  private logger: Logger;
  private unsubscribers: Array<() => void> = [];

  constructor(private ctx: EventSubscriptionSetupContext) {
    this.logger = new LoggerClass(`EventSubscriptionSetup ${ctx.session.id}`);
  }

  setup(): void {
    const { session, internalEventBus, modelSwitchHandler, interruptHandler, queryModeHandler } =
      this.ctx;
    const sessionId = session.id;

    const unsubModelSwitch = internalEventBus.subscribe(
      'model.switchRequest',
      async ({ sessionId: sid, model, provider }) => {
        if (!provider) {
          throw new Error('model.switchRequest event is missing required field: provider');
        }
        const result = await modelSwitchHandler.switchModel(model, provider);

        await internalEventBus.publish('model.switched', {
          sessionId: sid,
          success: result.success,
          model: result.model,
          error: result.error,
        });
      },
      { sessionId, subscriberName: 'EventSubscriptionSetup.modelSwitchRequest' }
    );
    this.unsubscribers.push(unsubModelSwitch);

    const unsubInterrupt = internalEventBus.subscribe(
      'agent.interruptRequest',
      async ({ sessionId: sid }) => {
        await interruptHandler.handleInterrupt();
        await internalEventBus.publish('agent.interrupted', { sessionId: sid });
      },
      { sessionId, subscriberName: 'EventSubscriptionSetup.agentInterruptRequest' }
    );
    this.unsubscribers.push(unsubInterrupt);

    const unsubReset = internalEventBus.subscribe(
      'agent.resetRequest',
      async ({ sessionId: sid, restartQuery }) => {
        const result = await this.ctx.resetQuery({
          restartQuery: restartQuery ?? true,
          hardReset: true,
        });

        await internalEventBus.publish('agent.reset', {
          sessionId: sid,
          success: result.success,
          error: result.error,
        });
      },
      { sessionId, subscriberName: 'EventSubscriptionSetup.agentResetRequest' }
    );
    this.unsubscribers.push(unsubReset);

    const unsubMessagePersisted = internalEventBus.subscribe(
      'message.persisted',
      async (data) => {
        if (data.skipQueryStart) return;
        if (isMessageDeliveryV2Enabled() && this.ctx.deliverChatMessage) {
          await this.ctx.deliverChatMessage(data.messageId);
          return;
        }
        await this.ctx.startQueryAndEnqueue(
          data.messageId,
          data.messageContent as string | MessageContent[]
        );
      },
      { sessionId, subscriberName: 'EventSubscriptionSetup.messagePersisted' }
    );
    this.unsubscribers.push(unsubMessagePersisted);

    const unsubQueryTrigger = internalEventBus.subscribe(
      'query.trigger',
      async () => {
        await queryModeHandler.replayPendingMessagesForAutomaticTurnEnd();
      },
      { sessionId, subscriberName: 'EventSubscriptionSetup.queryTrigger' }
    );
    this.unsubscribers.push(unsubQueryTrigger);
  }

  cleanup(): void {
    for (const unsubscribe of this.unsubscribers) {
      try {
        unsubscribe();
      } catch (error) {
        this.logger.error('Error during unsubscribe:', error);
      }
    }
    this.unsubscribers = [];
  }
}
