import type { MessageHub } from '@hyperneo/shared';
import type { JobQueueRepository } from '../../storage/repositories/job-queue-repository.ts';
import { createDaemonOperationCatalog } from '../operations/catalog.ts';
import { createOperationRpcHandler } from '../operations/rpc-adapter.ts';

export function setupOperationHandlers(
  messageHub: MessageHub,
  jobQueue: JobQueueRepository,
  readTask: Parameters<typeof createDaemonOperationCatalog>[1],
  createTask: Parameters<typeof createDaemonOperationCatalog>[2],
  listTasks: Parameters<typeof createDaemonOperationCatalog>[3]
) {
  const registry = createDaemonOperationCatalog(jobQueue, readTask, createTask, listTasks);
  return messageHub.onRequest(
    'operation.invoke',
    createOperationRpcHandler(registry, () => ({}))
  );
}
