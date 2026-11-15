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
  const origin = ask.askOrigin.sessionId;
  const hold =
    service.db.getSession(origin)?.config.queryMode === 'manual'
      ? ('manual' as const)
      : ('immediate' as const);
  for (let attempt = 0; ; attempt++) {
    const through = await service.db.gateway.call(
      neoFrontInputReads,
      'frontSaidThrough',
      conversationId
    );
    const block = catchUpBlock(
      await service.db.gateway.call(
        neoFrontInputReads,
        'frontSaid',
        conversationId,
        messageId,
        ask.createdAt
      )
    );
    const reserved = await service.db.gateway.call(
      neoFrontInputWrites,
      'reserve',
      conversationId,
      [messageId],
      [
        {
          sessionId: origin,
          hold,
          message: neoIntakeMessage(
            { ...ask, sessionId: origin },
            origin,
            readNeoReply(ask.replyTo, service.todos),
            null,
            undefined,
            ask.previewContext ?? null,
            block
          ),
        },
      ],
      through
    );
    if (reserved !== 'stale' || attempt >= 4) return reserved;
  }
}
