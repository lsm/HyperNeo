import type { SessionTarget } from '../session-resolution/target.ts';
import type {
  AgentMessageDeliveryOutcome,
  AgentMessageRouterConfig,
} from './agent-message-router.ts';

export function buildDataAppendix(data?: Record<string, unknown>): string {
  return data && Object.keys(data).length > 0
    ? `\n\n<structured-data>\n${JSON.stringify(data, null, 2)}\n</structured-data>`
    : '';
}

export async function deliverSingleTarget(
  config: AgentMessageRouterConfig,
  target: SessionTarget,
  message: string,
  messageId: string,
  sessionIdHint?: string
): Promise<AgentMessageDeliveryOutcome> {
  if (config.deliverToTarget) {
    return config.deliverToTarget(target, message, messageId, sessionIdHint);
  }
  if (target.kind === 'session') {
    if (config.sessionMessageInjector && config.spaceId) {
      const outcome = await config.sessionMessageInjector(
        config.spaceId,
        message,
        target.sessionId
      );
      if (outcome.state === 'failed') {
        return { state: 'failed', sessionId: outcome.sessionId, messageId, error: outcome.error };
      }
      return {
        state: 'queued',
        sessionId: outcome.sessionId,
        messageId: outcome.messageId,
      };
    }
    if (config.messageInjector) {
      await config.messageInjector(target.sessionId, message);
      return { state: 'delivered', sessionId: target.sessionId, messageId };
    }
  }
  if (target.kind === 'worker' && sessionIdHint && config.messageInjector) {
    await config.messageInjector(sessionIdHint, message);
    return { state: 'delivered', sessionId: sessionIdHint, messageId };
  }
  throw new Error(`No delivery door configured for ${target.kind} target`);
}
