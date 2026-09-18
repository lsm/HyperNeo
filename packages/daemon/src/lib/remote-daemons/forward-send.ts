import { renderRemoteAddress } from '../mailbox/address.ts';
import { SendMessageResultSchema, type RemoteSendForwarder } from '../messaging/message-send.ts';
import type { RemoteDaemonRegistry } from './registry.ts';

export function createRemoteSendForwarder(registry: RemoteDaemonRegistry): RemoteSendForwarder {
  return async (target, input) => {
    try {
      const reply = await registry.invoke(target.daemonId, 'message.send', {
        sessionId: target.sessionId,
        message: input.message,
        ...(input.deliveryMode === undefined ? {} : { deliveryMode: input.deliveryMode }),
      });
      const parsed = SendMessageResultSchema.safeParse(reply);
      return parsed.success
        ? parsed.data
        : { kind: 'rejected', reason: `Unusable reply from ${renderRemoteAddress(target)}` };
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      return {
        kind: 'rejected',
        reason: `Forward to ${renderRemoteAddress(target)} failed: ${detail}`,
      };
    }
  };
}
