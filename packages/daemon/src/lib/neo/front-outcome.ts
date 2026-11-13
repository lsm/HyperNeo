import type { Job } from '../../storage/repositories/job-queue-repository.ts';
import { jobQueueWrites } from '../../storage/repositories/job-queue-repository.ts';
import {
  neoFrontInputReads,
  neoFrontInputWrites,
} from '../../storage/repositories/neo-front-input-worker.ts';
import { sdkMessageWrites } from '../../storage/repositories/sdk-message-writes.ts';
import { neoIntakeMessage, readNeoReply } from './intake.ts';
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
  if (owner?.owner === 'neo') return { delivered: true, outcome: 'handed_off' };
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
      ? { messageIds: [messageId] }
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
  const open: string[] = [];
  for (const id of ids) {
    const input = await service.db.gateway.call(neoFrontInputReads, 'get', conversationId, id);
    if (input?.owner === 'neo') continue;
    open.push(id);
  }
  const markFailed = async (id: string) => {
    const failedAsk = id === messageId ? ask : service.asks.find(conversationId, id);
    if (!failedAsk || sdk.getUserSendStatus(failedAsk.askOrigin.sessionId, id) === 'consumed')
      return;
    await service.db.gateway.call(
      sdkMessageWrites,
      'markDeliveryFailedByUuidInclusive',
      sessionId,
      id
    );
    if (sdk.getUserSendStatus(failedAsk.askOrigin.sessionId, id) !== null) return;
    await service.db.gateway.call(
      sdkMessageWrites,
      'saveUserMessage',
      failedAsk.askOrigin.sessionId,
      neoIntakeMessage(
        { ...failedAsk, sessionId: failedAsk.askOrigin.sessionId },
        failedAsk.askOrigin.sessionId,
        readNeoReply(failedAsk.replyTo, service.todos),
        null,
        undefined,
        failedAsk.previewContext ?? null
      ),
      'failed'
    );
  };
  if (!open.includes(messageId)) {
    const self = await service.db.gateway.call(
      neoFrontInputReads,
      'get',
      conversationId,
      messageId
    );
    if (self?.owner === 'neo') return { delivered: true, outcome: 'handed_off' };
    await markFailed(messageId);
    return { delivered: true, outcome: 'failed' };
  }
  await service.db.gateway.call(neoFrontInputWrites, 'release', conversationId, open);
  for (const id of open) await markFailed(id);
  return { delivered: true, outcome: 'failed' };
}
