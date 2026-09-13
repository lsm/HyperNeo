import { createSetTaskDependenciesOperation } from './task-dependencies.ts';
import { createTransitionTaskOperation } from './task-transition.ts';
import { createUpdateTaskOperation } from './task-update.ts';
import { createListTasksOperation } from './task-list.ts';
import { createCreateTaskOperation } from './task-create.ts';
import type { TaskCore } from '@hyperneo/shared/types/task-core';
import type { JobQueueRepository } from '../../storage/repositories/job-queue-repository.ts';
import type { CreateStandaloneTaskInput } from '../../storage/tasks/create-task.ts';
import type { TransitionStandaloneTaskInput } from '../../storage/tasks/transition-task.ts';
import { createGetTaskOperation } from './task-get.ts';
import { createDiscoveryOperations } from './discovery.ts';
import { createSendMessageOperation } from './message-send.ts';
import {
  createOperationRegistry,
  type OperationRegistry,
  type OperationDefinition,
} from './registry.ts';

export interface TaskOperationDependencies {
  members?: OperationDefinition;
  pendingCompletion?: OperationDefinition;
  submitForReview?: OperationDefinition;
  cancel?: OperationDefinition;
  complete?: OperationDefinition;
  start?: OperationDefinition;
  create?: OperationDefinition;
  transition?: OperationDefinition;
  readTask: (taskId: string) => TaskCore | null;
  createTask: Parameters<typeof createCreateTaskOperation<CreateStandaloneTaskInput>>[0];
  listTasks: Parameters<typeof createListTasksOperation>[0];
  editTask: Parameters<typeof createUpdateTaskOperation>[0];
  transitionTask: Parameters<
    typeof createTransitionTaskOperation<TransitionStandaloneTaskInput>
  >[0];
  setDependencies: Parameters<typeof createSetTaskDependenciesOperation>[0];
}

export function createDaemonOperationCatalog(
  jobQueue: JobQueueRepository,
  tasks: TaskOperationDependencies
): OperationRegistry {
  const registry: OperationRegistry = createOperationRegistry([
    createSendMessageOperation(jobQueue),
    createGetTaskOperation(tasks.readTask),
    tasks.create ?? createCreateTaskOperation(tasks.createTask),
    createListTasksOperation(tasks.listTasks),
    createUpdateTaskOperation(tasks.editTask),
    tasks.transition ?? createTransitionTaskOperation(tasks.transitionTask),
    createSetTaskDependenciesOperation(tasks.setDependencies),
    ...(tasks.members ? [tasks.members] : []),
    ...(tasks.pendingCompletion ? [tasks.pendingCompletion] : []),
    ...(tasks.submitForReview ? [tasks.submitForReview] : []),
    ...(tasks.cancel ? [tasks.cancel] : []),
    ...(tasks.complete ? [tasks.complete] : []),
    ...(tasks.start ? [tasks.start] : []),
    ...createDiscoveryOperations(() => registry),
  ]);
  return registry;
}
