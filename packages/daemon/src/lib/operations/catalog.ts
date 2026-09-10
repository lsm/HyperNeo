import type { JobQueueRepository } from '../../storage/repositories/job-queue-repository.ts';
import { createDiscoveryOperations } from './discovery.ts';
import { createSendMessageOperation } from './message-send.ts';
import { createOperationRegistry, type OperationRegistry } from './registry.ts';

export function createDaemonOperationCatalog(jobQueue: JobQueueRepository): OperationRegistry {
  const registry: OperationRegistry = createOperationRegistry([
    createSendMessageOperation(jobQueue),
    ...createDiscoveryOperations(() => registry),
  ]);
  return registry;
}
