import superpipe, { type PipelineAPI } from 'superpipe';
import { z } from 'zod';
import { Logger } from '../logger.ts';
import type { Job } from '../../storage/repositories/job-queue-repository.ts';
import { frontSession } from './front-session.ts';
import { settleConvoInput } from './front-outcome.ts';
import { frontSessionId } from './front-mode.ts';
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
        const handoff = async () => {
          await ensurePrompt({
            db: service.db.getDatabase(),
            sdkMessageRepo: service.db.getSDKMessageRepo(),
            jobQueue: service.db.getJobQueueRepo(),
            sessionId: ask.askOrigin.sessionId,
            message,
            hold:
              service.db.getSession(ask.askOrigin.sessionId)?.config.queryMode === 'manual'
                ? 'manual'
                : 'immediate',
            delivery: { origin: 'chat' },
          });
          if (
            service.db
              .getSDKMessageRepo()
              .getMessageByStatusAndUuid(ask.askOrigin.sessionId, 'failed', messageId)
          )
            return settleConvoInput(
              service,
              job,
              conversationId,
              frontSessionId(conversationId),
              messageId
            );
          return { delivered: true, outcome: 'handed_off' };
        };
        if (!front?.enabled || !front.model) return handoff();
        try {
          const id = frontSessionId(conversationId);
          if (service.db.getSDKMessageRepo().getDeliveryMessageIdsByUuids(id, [messageId]).length)
            return await settleConvoInput(service, job, conversationId, id, messageId);
          const session = await frontSession(service, ask, front.model);
          if (service.db.getGlobalSettings().neo?.front?.enabled !== true) return handoff();
          await service.deliverForward(
            session.id,
            messageId,
            [
              {
                type: 'text',
                text: `Human message ${messageId}. Preserve this ID when handing the request to Neo.`,
              },
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
          if (service.db.getGlobalSettings().neo?.front?.enabled !== true) return handoff();
          return await settleConvoInput(service, job, conversationId, session.id, messageId);
        } catch (error) {
          new Logger('NeoFront').warn('Convo delivery failed; handing input to Neo', error);
          return handoff();
        }
      },
      'job',
      'result'
    )
    .endAsync('result') as (
    job: Job
  ) => Promise<{ delivered: boolean; pending?: boolean; outcome?: string }>;
}
