import type { MessageHub } from '@hyperneo/shared';
import type { JobQueueRepository } from '../../storage/repositories/job-queue-repository.ts';
import { createSendMessageOperation } from '../operations/message-send.ts';
import { createOperationRegistry } from '../operations/registry.ts';
import { createOperationRpcHandler } from '../operations/rpc-adapter.ts';

export function setupOperationHandlers(messageHub: MessageHub, jobQueue: JobQueueRepository) {
  const registry = createOperationRegistry([createSendMessageOperation(jobQueue)]);
  return messageHub.onRequest(
    'operation.invoke',
    createOperationRpcHandler(registry, () => ({}))
  );
}
