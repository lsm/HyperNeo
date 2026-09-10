import type { TaskCore } from '@hyperneo/shared/types/task-core';
import type { JobQueueRepository } from '../../storage/repositories/job-queue-repository.ts';
import { createGetTaskOperation } from './task-get.ts';
import { createDiscoveryOperations } from './discovery.ts';
import { createSendMessageOperation } from './message-send.ts';
import { createOperationRegistry, type OperationRegistry } from './registry.ts';

export function createDaemonOperationCatalog(
  jobQueue: JobQueueRepository,
  readTask: (taskId: string) => TaskCore | null
): OperationRegistry {
  const registry: OperationRegistry = createOperationRegistry([
    createSendMessageOperation(jobQueue),
    createGetTaskOperation(readTask),
    ...createDiscoveryOperations(() => registry),
  ]);
  return registry;
}
