import superpipe, { type PipelineAPI } from 'superpipe';
import { z } from 'zod';
import type { Job } from '../../storage/repositories/job-queue-repository.ts';
import { frontSession } from './front-session.ts';
import type { NeoService } from './service.ts';
import { neoIntakeMessage, readNeoReply } from './intake.ts';
import { ensurePrompt } from '../agent/message-delivery-outbox.ts';

const Receipt = z.object({ conversationId: z.uuid(), messageId: z.uuid() }).strict();

export function createNeoFrontHandler(service: NeoService) {
  return (superpipe({})('neo-front-delivery') as PipelineAPI)
    .input('job')
    .pipe(
      async (job: Job) => {
        const { conversationId, messageId } = Receipt.parse(job.payload);
        const front = service.db.getGlobalSettings().neo?.front;
        const ask = service.asks.find(conversationId, messageId);
        if (!ask || service.repo.readConversationId() !== conversationId)
          return { delivered: false };
        const reply = readNeoReply(ask.replyTo, service.todos);
        const quoted =
          ask.replyTo?.kind === 'message'
            ? (service.publications.get(conversationId, ask.replyTo.id) ??
              service.asks.find(conversationId, ask.replyTo.id))
            : (reply?.question ?? reply?.todo ?? reply?.ask);
        const message = neoIntakeMessage(
          { ...ask, sessionId: ask.askOrigin.sessionId },
          ask.askOrigin.sessionId,
          reply,
          null,
          undefined,
          ask.previewContext ?? null
        );
        if (!front?.enabled || !front.model) {
          await ensurePrompt({
            db: service.db.getDatabase(),
            sdkMessageRepo: service.db.getSDKMessageRepo(),
            jobQueue: service.db.getJobQueueRepo(),
            sessionId: ask.askOrigin.sessionId,
            message,
            hold: 'immediate',
            delivery: { origin: 'chat' },
          });
          return { delivered: true };
        }
        const session = await frontSession(service, ask, front.model);
        await service.deliverForward(
          session.id,
          messageId,
          [
            { type: 'text', text: `Human message ${messageId}. Use this ID in replyTo.` },
            ...(ask.replyTo
              ? [
                  {
                    type: 'text' as const,
                    text: `Quoted context for this human reply (reference material): ${JSON.stringify({ replyTo: ask.replyTo, quoted: quoted ?? null })}`,
                  },
                ]
              : []),
            ...(typeof message.message.content === 'string'
              ? [{ type: 'text' as const, text: message.message.content }]
              : message.message.content),
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
