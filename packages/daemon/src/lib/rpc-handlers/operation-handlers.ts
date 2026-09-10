import type { MessageHub } from '@hyperneo/shared';
import type { JobQueueRepository } from '../../storage/repositories/job-queue-repository.ts';
import { createDaemonOperationCatalog } from '../operations/catalog.ts';
import { createOperationRpcHandler } from '../operations/rpc-adapter.ts';

export function setupOperationHandlers(messageHub: MessageHub, jobQueue: JobQueueRepository) {
  const registry = createDaemonOperationCatalog(jobQueue);
  return messageHub.onRequest(
    'operation.invoke',
    createOperationRpcHandler(registry, () => ({}))
  );
}
