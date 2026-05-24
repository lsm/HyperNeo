/**
 * Shared types for the Space runtime module.
 *
 * Centralises interfaces that are consumed by multiple runtime services
 * to avoid duplication and drift.
 */

import type { MessageDeliveryMode, MessageOrigin } from '@neokai/shared';

/**
 * Minimal interface for injecting messages into a session.
 *
 * Used by `SpaceAgentNotificationService` to forward structured events into
 * the Space Agent session without depending on the full SessionManager
 * surface.
 */
export interface SessionFactory {
  injectMessage(
    sessionId: string,
    message: string,
    opts?: { deliveryMode?: MessageDeliveryMode; origin?: MessageOrigin }
  ): Promise<void>;
}
