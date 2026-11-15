import type { NeoConversationAsk } from '@hyperneo/shared/types/neo-conversation-ask';
import {
  neoFrontInputReads,
  neoFrontInputWrites,
} from '../../storage/repositories/neo-front-input-worker.ts';
import { catchUpBlock } from './front-catch-up.ts';
import { neoIntakeMessage, readNeoReply } from './intake.ts';
import type { NeoService } from './service.ts';

export async function handOffToNeo(
  service: NeoService,
  conversationId: string,
  ask: NeoConversationAsk,
  messageId: string
) {
  const messageIds = [messageId];
  const asks = [ask];
  const block = catchUpBlock(
    await service.db.gateway.call(neoFrontInputReads, 'frontSaid', conversationId, messageId)
  );
  return service.db.gateway.call(
    neoFrontInputWrites,
    'reserve',
    conversationId,
    messageIds,
    asks.map((ask) => {
      const message = neoIntakeMessage(
        { ...ask, sessionId: ask.askOrigin.sessionId },
        ask.askOrigin.sessionId,
        readNeoReply(ask.replyTo, service.todos),
        null,
        undefined,
        ask.previewContext ?? null
      );
      const content = message.message.content as Exclude<typeof message.message.content, string>;
      return {
        sessionId: ask.askOrigin.sessionId,
        message: block
          ? {
              ...message,
              message: {
                ...message.message,
                content: [...content, { type: 'text' as const, text: block }],
              },
            }
          : message,
      };
    })
  );
}
