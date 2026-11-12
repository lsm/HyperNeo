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
import { attribute, escapeSessionText } from '../messaging/session-envelope.ts';
import type { MailboxMessageContent } from '../mailbox/entry.ts';

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
          return settleConvoInput(
            service,
            job,
            conversationId,
            frontSessionId(conversationId),
            messageId
          );
        };
        if (!front?.enabled || !front.model) return handoff();
        try {
          const id = frontSessionId(conversationId);
          if (service.db.getSDKMessageRepo().getDeliveryMessageIdsByUuids(id, [messageId]).length)
            return await settleConvoInput(service, job, conversationId, id, messageId);
          const session = await frontSession(service, ask, front.model);
          if (service.db.getGlobalSettings().neo?.front?.enabled !== true) return handoff();
          await service.deliverFront(
            session.id,
            messageId,
            [
              {
                type: 'text',
                text: `Human message ${messageId}. First call reply_short with progress:true${service.speech.isListening(service.defaultSessionId() ?? ask.askOrigin.sessionId) ? ', spoken' : ''} and replyTo:["${messageId}"] to give the human a one-sentence acknowledgment. Use reply_short for at most five short sentences in one paragraph; use reply_detailed for more than five sentences or any structured report, list, table or multi-topic update. Then handle the request or call run_in_background. Preserve this ID throughout.`,
              },
              ...(ask.replyTo
                ? [
                    {
                      type: 'text' as const,
                      text: `<quoted>${escapeSessionText(JSON.stringify({ replyTo: ask.replyTo, quoted: quoted ?? null }))}</quoted>`,
                    },
                  ]
                : []),
              { type: 'text', text: `<human-message id="${attribute(messageId)}">` },
              ...(typeof message.message.content === 'string'
                ? [{ type: 'text' as const, text: escapeSessionText(message.message.content) }]
                : (message.message.content as Exclude<MailboxMessageContent, string>).map(
                    (block) =>
                      block.type === 'text'
                        ? { ...block, text: escapeSessionText(block.text) }
                        : block
                  )),
              { type: 'text', text: '</human-message>' },
            ],
            ask.askOrigin.sessionId,
            conversationId
          );
          if (service.db.getGlobalSettings().neo?.front?.enabled !== true) return handoff();
          return await settleConvoInput(service, job, conversationId, session.id, messageId);
        } catch (error) {
          new Logger('NeoFront').warn('Front delivery failed', error);
          if (service.db.getGlobalSettings().neo?.front?.enabled !== true) return handoff();
          return settleConvoInput(
            service,
            job,
            conversationId,
            frontSessionId(conversationId),
            messageId,
            error instanceof Error && error.message === 'front_session_tools_superseded'
              ? 'superseded'
              : 'delivery'
          );
        }
      },
      'job',
      'result'
    )
    .endAsync('result') as (
    job: Job
  ) => Promise<{ delivered: boolean; pending?: boolean; outcome?: string }>;
}
