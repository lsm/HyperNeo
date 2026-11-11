import { Logger } from '../logger.ts';
import type { NeoModelPreference } from '@hyperneo/shared';
import type { NeoConversationAsk } from '@hyperneo/shared/types/neo-conversation-ask';
import superpipe, { type PipelineAPI } from 'superpipe';
import { z } from 'zod';
import type { Job } from '../../storage/repositories/job-queue-repository.ts';
import { DeadLetterImmediatelyError } from '../../storage/job-queue-processor.ts';
import { neoPublicationWrites } from '../../storage/repositories/neo-publication-repository.ts';
import { neoDerivedId } from './derived-id.ts';
import { runNeoFrontModel } from './front-model.ts';
import type { NeoService } from './service.ts';

type FrontReply = { ask: NeoConversationAsk; publicationId: string; text: string };
type Infer = typeof runNeoFrontModel;

const Receipt = z.object({ conversationId: z.uuid(), messageId: z.uuid() }).strict();

export function createNeoFrontHandler(service: NeoService, infer: Infer = runNeoFrontModel) {
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
        const text = previous?.fullText ?? (await inferOnce(service, ask, front.model, infer));
        if (!text) throw new DeadLetterImmediatelyError('front_empty_reply');
        if (service.db.getGlobalSettings().neo?.front?.enabled !== true) return null;
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

async function inferOnce(
  service: NeoService,
  ask: NeoConversationAsk,
  model: NeoModelPreference,
  infer: Infer
): Promise<string | null> {
  const sessionId = neoDerivedId(`front-session:${ask.conversationId}`);
  const recorded = service.db
    .getSDKMessageRepo()
    .getMessageByUuid(sessionId, neoDerivedId(`front-failure:${ask.requestId}`));
  if (recorded)
    throw new DeadLetterImmediatelyError(
      'front_turn_already_failed: the recorded failure for this message is final'
    );
  try {
    return await infer(service, ask, model);
  } catch (error) {
    new Logger('NeoFront').warn('Front inference failed', {
      provider: model.provider,
      model: model.model,
      errorType: error instanceof Error ? error.name : 'unknown',
    });
    throw new DeadLetterImmediatelyError(
      error instanceof Error ? error.message : 'front_inference_failed'
    );
  }
}
