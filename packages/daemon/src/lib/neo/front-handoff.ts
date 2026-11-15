import type { NeoConversationAsk } from '@hyperneo/shared/types/neo-conversation-ask';
import { neoFrontInputWrites } from '../../storage/repositories/neo-front-input-worker.ts';
import { catchUpBlock } from './front-catch-up.ts';
import { neoIntakeMessage, readNeoReply } from './intake.ts';
import type { NeoService } from './service.ts';

type FrontSaid = { replyTo?: readonly string[]; fullText: string; workOn?: boolean };

export function handOffToNeo(
  service: NeoService,
  conversationId: string,
  asks: readonly NeoConversationAsk[],
  messageIds: readonly string[],
  said: readonly FrontSaid[]
) {
  const block = catchUpBlock(said);
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
