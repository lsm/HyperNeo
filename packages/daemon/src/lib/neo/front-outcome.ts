import type { Job } from '../../storage/repositories/job-queue-repository.ts';
import { jobQueueWrites } from '../../storage/repositories/job-queue-repository.ts';
import { neoFrontInputReads } from '../../storage/repositories/neo-front-input-worker.ts';
import { neoPublicationWrites } from '../../storage/repositories/neo-publication-repository.ts';
import { neoDerivedId } from './derived-id.ts';
import type { NeoService } from './service.ts';

export async function settleConvoInput(
  service: NeoService,
  job: Job,
  conversationId: string,
  sessionId: string,
  messageId: string
) {
  const owner = await service.db.gateway.call(neoFrontInputReads, 'get', conversationId, messageId);
  if (owner?.owner) return { delivered: true, outcome: 'answered' };
  const ask = service.asks.find(conversationId, messageId);
  if (!ask) return { delivered: false };
  if (
    service.db
      .getSDKMessageRepo()
      .getDeliveryMessageIdsByUuids(ask.askOrigin.sessionId, [messageId]).length
  )
    return { delivered: true, outcome: 'handed_off' };
  const terminal = await service.db.gateway.call(
    neoFrontInputReads,
    'terminal',
    conversationId,
    sessionId,
    messageId
  );
  const pending = async () => {
    await service.db.gateway.call(
      jobQueueWrites,
      'requeue',
      job.id,
      Date.now() + 1000,
      job.claimToken
    );
    return { delivered: false, pending: true };
  };
  if (!terminal) return pending();
  const ids = terminal.messageIds.filter(
    (id) =>
      !service.db.getSDKMessageRepo().getDeliveryMessageIdsByUuids(ask.askOrigin.sessionId, [id])
        .length
  );
  if (!ids.length) return { delivered: true, outcome: 'handed_off' };
  const receipt = await service.db.gateway.call(
    neoPublicationWrites,
    'append',
    {
      conversationId,
      publicationId: neoDerivedId(`convo-reply:${conversationId}:${[...ids].sort().join(',')}`),
      verbatim: true,
      fullText:
        terminal.text.trim() && terminal.text.length <= 16000
          ? terminal.text
          : 'Convo could not complete this reply. Please try again.',
      replyTo: ids,
      links: [],
    },
    sessionId
  );
  if (!receipt.accepted) {
    if (receipt.reason === 'publication_superseded') return pending();
    throw new Error(receipt.reason);
  }
  service.notifyPublicationsChanged(conversationId);
  if (receipt.created)
    await service.speech.publish(
      ask.askOrigin.sessionId,
      receipt.publication.publicationId,
      receipt.publication.fullText
    );
  return { delivered: true, outcome: 'answered' };
}
