import { describe, it, expect, mock } from 'bun:test';
import type {
  Job,
  JobQueueRepository,
} from '../../../../src/storage/repositories/job-queue-repository';
import type { MessageDeliverySession } from '../../../../src/lib/agent/message-delivery';
import {
  createMessageDeliveryHandler,
  type MessageDeliveryHandlerDeps,
} from '../../../../src/lib/job-handlers/message-delivery.handler';

function makeJob(payload: Record<string, unknown>): Job {
  return { id: 'job-1', claimToken: 'claim-1', payload } as unknown as Job;
}

describe('createMessageDeliveryHandler', () => {
  it('publishes a batched failed status for an archived session', async () => {
    const markFailedSpy = mock((_sessionId: string, uuid: string) => `db-${uuid}`);
    const publishSpy = mock(async () => {});
    const settleSpy = mock(async () => {});
    const deps: MessageDeliveryHandlerDeps = {
      jobQueue: { isClaimCurrent: mock(() => true) } as unknown as JobQueueRepository,
      getSession: () => ({ settleSkippedDelivery: settleSpy }) as unknown as MessageDeliverySession,
      getMessageContent: () => null,
      isSessionArchived: () => true,
      markDeliveryFailed: markFailedSpy,
      publishStatusChanged: publishSpy,
    };

    const handler = createMessageDeliveryHandler(deps);
    const result = await handler(
      makeJob({
        sessionId: 'sess-1',
        messageUuid: 'uuid-1',
        role: 'turn',
        origin: 'chat',
        batchUuids: ['uuid-1', 'uuid-2'],
      }),
      {}
    );

    expect(result).toEqual({ outcome: 'archived' });
    expect(markFailedSpy).toHaveBeenCalledWith('sess-1', 'uuid-1');
    expect(markFailedSpy).toHaveBeenCalledWith('sess-1', 'uuid-2');
    expect(publishSpy).toHaveBeenCalledWith('sess-1', ['db-uuid-1', 'db-uuid-2']);
    expect(settleSpy).toHaveBeenCalledWith('uuid-1');
  });

  it('does not publish status when no rows flip to failed', async () => {
    const markFailedSpy = mock(() => null);
    const publishSpy = mock(async () => {});
    const settleSpy = mock(async () => {});
    const deps: MessageDeliveryHandlerDeps = {
      jobQueue: { isClaimCurrent: mock(() => true) } as unknown as JobQueueRepository,
      getSession: () => ({ settleSkippedDelivery: settleSpy }) as unknown as MessageDeliverySession,
      getMessageContent: () => null,
      isSessionArchived: () => true,
      markDeliveryFailed: markFailedSpy,
      publishStatusChanged: publishSpy,
    };

    const handler = createMessageDeliveryHandler(deps);
    const result = await handler(
      makeJob({ sessionId: 'sess-1', messageUuid: 'uuid-1', role: 'turn', origin: 'chat' }),
      {}
    );

    expect(result).toEqual({ outcome: 'archived' });
    expect(markFailedSpy).toHaveBeenCalledWith('sess-1', 'uuid-1');
    expect(publishSpy).not.toHaveBeenCalled();
  });
});
