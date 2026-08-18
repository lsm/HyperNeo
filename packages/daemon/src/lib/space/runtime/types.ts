import type { MessageDeliveryMode, MessageOrigin } from '@hyperneo/shared';

export interface SessionFactory {
  injectMessage(
    sessionId: string,
    message: string,
    opts?: { deliveryMode?: MessageDeliveryMode; origin?: MessageOrigin }
  ): Promise<void>;
}
