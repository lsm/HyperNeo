import type { MessageHub } from '@hyperneo/shared';
import type { Database } from '../../storage/database';
import type { SDKMessage } from '@hyperneo/shared/sdk';

export function setupTestHandlers(messageHub: MessageHub, db: Database): void {
  messageHub.onRequest('test.injectSDKMessage', async (data) => {
    const { sessionId, message } = data as {
      sessionId: string;
      message: SDKMessage;
    };

    db.saveSDKMessage(sessionId, message);

    const messageWithTimestamp = {
      ...message,
      timestamp: Date.now(),
    } as SDKMessage & { timestamp: number };

    messageHub.event(
      'state.sdkMessages.delta',
      {
        added: [messageWithTimestamp],
        timestamp: messageWithTimestamp.timestamp,
      },
      { channel: `session:${sessionId}` }
    );

    return { success: true, uuid: message.uuid };
  });

  messageHub.onRequest('test.broadcastDelta', async (data) => {
    const {
      sessionId,
      channel,
      data: deltaData,
    } = data as {
      sessionId: string;
      channel: string;
      data: unknown;
    };

    messageHub.event(channel, deltaData, { channel: `session:${sessionId}` });
  });
}
