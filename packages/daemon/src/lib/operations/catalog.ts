import { createTransitionTaskOperation } from './task-transition.ts';
import { createUpdateTaskOperation } from './task-update.ts';
import { createListTasksOperation } from './task-list.ts';
import { createCreateTaskOperation } from './task-create.ts';
import type { TaskCore } from '@hyperneo/shared/types/task-core';
import type { JobQueueRepository } from '../../storage/repositories/job-queue-repository.ts';
import { createGetTaskOperation } from './task-get.ts';
import { createDiscoveryOperations } from './discovery.ts';
import { createSendMessageOperation } from './message-send.ts';
import { createOperationRegistry, type OperationRegistry } from './registry.ts';

export function createDaemonOperationCatalog(
  jobQueue: JobQueueRepository,
  readTask: (taskId: string) => TaskCore | null,
  createTask: Parameters<typeof createCreateTaskOperation>[0],
  listTasks: Parameters<typeof createListTasksOperation>[0],
  editTask: Parameters<typeof createUpdateTaskOperation>[0],
  transitionTask: Parameters<typeof createTransitionTaskOperation>[0]
): OperationRegistry {
  const registry: OperationRegistry = createOperationRegistry([
    createSendMessageOperation(jobQueue),
    createGetTaskOperation(readTask),
    createCreateTaskOperation(createTask),
    createListTasksOperation(listTasks),
    createUpdateTaskOperation(editTask),
    createTransitionTaskOperation(transitionTask),
    ...createDiscoveryOperations(() => registry),
  ]);
  return registry;
}
