import superpipe, { type PipelineAPI } from 'superpipe';
import { z } from 'zod';
import type { Job } from '../../storage/repositories/job-queue-repository.ts';
import { frontSession } from './front-session.ts';
import type { NeoService } from './service.ts';

const Receipt = z.object({ conversationId: z.uuid(), messageId: z.uuid() }).strict();

export function createNeoFrontHandler(service: NeoService) {
  return (superpipe({})('neo-front-delivery') as PipelineAPI)
    .input('job')
    .pipe(
      async (job: Job) => {
        const { conversationId, messageId } = Receipt.parse(job.payload);
        const front = service.db.getGlobalSettings().neo?.front;
        const ask = service.asks.find(conversationId, messageId);
        if (
          !front?.enabled ||
          !front.model ||
          !ask ||
          service.repo.readConversationId() !== conversationId
        )
          return { delivered: false };
        const session = await frontSession(service, ask, front.model);
        await service.deliverForward(
          session.id,
          messageId,
          [
            { type: 'text', text: `Human message ${messageId}. Use this ID in replyTo.` },
            ...(typeof ask.content === 'string'
              ? [{ type: 'text' as const, text: ask.content }]
              : ask.content),
          ],
          ask.askOrigin.sessionId,
          'event'
        );
        return { delivered: true };
      },
      'job',
      'result'
    )
    .endAsync('result') as (job: Job) => Promise<{ delivered: boolean }>;
}
