import type { MessageHub } from '@hyperneo/shared';
import type { JobQueueRepository } from '../../storage/repositories/job-queue-repository.ts';
import {
  createDaemonOperationCatalog,
  type TaskOperationDependencies,
} from '../operations/catalog.ts';
import { createOperationRpcHandler } from '../operations/rpc-adapter.ts';

export function setupOperationHandlers(
  messageHub: MessageHub,
  jobQueue: JobQueueRepository,
  tasks: TaskOperationDependencies
) {
  const registry = createDaemonOperationCatalog(jobQueue, tasks);
  return messageHub.onRequest(
    'operation.invoke',
    createOperationRpcHandler(registry, () => ({}))
  );
}
