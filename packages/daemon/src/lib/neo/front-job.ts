import type { NeoConversationAsk } from '@hyperneo/shared/types/neo-conversation-ask';
import superpipe, { type PipelineAPI } from 'superpipe';
import { z } from 'zod';
import type { Job } from '../../storage/repositories/job-queue-repository.ts';
import { neoPublicationWrites } from '../../storage/repositories/neo-publication-repository.ts';
import { neoDerivedId } from './derived-id.ts';
import { runNeoFrontModel } from './front-model.ts';
import type { NeoService } from './service.ts';

type FrontReply = { ask: NeoConversationAsk; publicationId: string; text: string };

const Receipt = z.object({ conversationId: z.uuid(), messageId: z.uuid() }).strict();

export function createNeoFrontHandler(service: NeoService, infer = runNeoFrontModel) {
  return (superpipe({})('neo-front-reply') as PipelineAPI)
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
          return null;
        const publicationId = neoDerivedId(`front-reply:${conversationId}:${messageId}`);
        const previous = service.publications.get(conversationId, publicationId);
        const text =
          previous?.fullText ?? (await infer(service, ask, front.model).catch(() => null));
        if (!text || service.db.getGlobalSettings().neo?.front?.enabled !== true) return null;
        return { ask, publicationId, text };
      },
      'job',
      'reply'
    )
    .pipe(
      async (reply: FrontReply | null) => {
        if (!reply) return { delivered: false };
        const { ask, publicationId, text } = reply;
        const receipt = await service.db.gateway.call(neoPublicationWrites, 'append', {
          conversationId: ask.conversationId,
          publicationId,
          fullText: text,
          verbatim: true,
          replyTo: [ask.requestId],
          links: [],
        });
        if (!receipt.accepted) return { delivered: false };
        service.notifyPublicationsChanged(ask.conversationId);
        await service.speech.publish(
          ask.askOrigin.sessionId,
          publicationId,
          receipt.publication.fullText
        );
        return { delivered: true };
      },
      'reply',
      'result'
    )
    .endAsync('result') as (job: Job) => Promise<{ delivered: boolean }>;
}
