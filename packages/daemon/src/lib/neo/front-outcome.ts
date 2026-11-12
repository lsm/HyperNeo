import { publicationSpeaker } from './front-mode.ts';
import type { Job } from '../../storage/repositories/job-queue-repository.ts';
import { jobQueueWrites } from '../../storage/repositories/job-queue-repository.ts';
import { neoFrontInputReads } from '../../storage/repositories/neo-front-input-worker.ts';
import { neoPublicationWrites } from '../../storage/repositories/neo-publication-repository.ts';
import { neoDerivedId } from './derived-id.ts';
import { FRONT_FALLBACK_TEXT } from './front-catch-up.ts';
import type { NeoService } from './service.ts';

const SETTLEMENT_TIMEOUT_MS = 30 * 60_000;

export async function settleConvoInput(
  service: NeoService,
  job: Job,
  conversationId: string,
  sessionId: string,
  messageId: string,
  failure?: 'delivery' | 'superseded'
) {
  const owner = await service.db.gateway.call(neoFrontInputReads, 'get', conversationId, messageId);
  if (owner?.owner) return { delivered: true, outcome: 'answered' };
  const ask = service.asks.find(conversationId, messageId);
  if (!ask) return { delivered: false };
  const sdk = service.db.getSDKMessageRepo();
  const status = sdk.getUserSendStatus(ask.askOrigin.sessionId, messageId);
  if (status === 'consumed') return { delivered: true, outcome: 'handed_off' };
  const deadline = Date.parse(ask.createdAt) + SETTLEMENT_TIMEOUT_MS;
  const pending = async () => {
    const now = Date.now();
    await service.db.gateway.call(
      jobQueueWrites,
      'requeue',
      job.id,
      now < deadline ? Math.min(now + 1000, deadline) : now + 60_000,
      job.claimToken
    );
    return { delivered: false, pending: true };
  };
  if ((failure === 'superseded' && Date.now() < deadline) || (status && status !== 'failed'))
    return pending();
  const terminal =
    (await service.db.gateway.call(
      neoFrontInputReads,
      'terminal',
      conversationId,
      sessionId,
      messageId
    )) ??
    (failure === 'delivery' || status === 'failed' || Date.now() >= deadline
      ? { messageIds: [messageId], toolUsed: false }
      : null);
  if (!terminal) return pending();
  const deliveries = terminal.messageIds.map((id) => ({
    id,
    status: id === messageId ? status : sdk.getUserSendStatus(ask.askOrigin.sessionId, id),
  }));
  if (deliveries.some(({ status }) => status && status !== 'consumed' && status !== 'failed'))
    return pending();
  const ids = deliveries.filter(({ status }) => status !== 'consumed').map(({ id }) => id);
  if (!ids.length) return { delivered: true, outcome: 'handed_off' };
  if (terminal.toolUsed) return { delivered: true, outcome: 'answered' };
  const receipt = await service.db.gateway.call(
    neoPublicationWrites,
    'append',
    {
      conversationId,
      publicationId: neoDerivedId(`convo-reply:${conversationId}:${[...ids].sort().join(',')}`),
      verbatim: true,
      fullText: FRONT_FALLBACK_TEXT,
      replyTo: ids,
      links: [],
    },
    publicationSpeaker(conversationId, service.db.getGlobalSettings().neo?.front?.enabled === true)
  );
  if (!receipt.accepted) {
    if (receipt.reason === 'publication_superseded') return pending();
    throw new Error(receipt.reason);
  }
  service.notifyPublicationsChanged(conversationId);
  return { delivered: true, outcome: 'answered' };
}
