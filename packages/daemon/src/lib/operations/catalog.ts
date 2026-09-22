import { createTransitionTaskOperation } from '../tasks/transition-operation.ts';
import { createUpdateTaskOperation } from '../tasks/update-operation.ts';
import { createListTasksOperation } from '../tasks/list-operation.ts';
import { createCreateTaskOperation } from '../tasks/create-operation.ts';
import type { JobQueueRepository } from '../../storage/repositories/job-queue-repository.ts';
import type { CreateStandaloneTaskInput } from '../../storage/tasks/create-task.ts';
import type { TransitionStandaloneTaskInput } from '../../storage/tasks/transition-task.ts';
import { createGetTaskOperation } from '../tasks/get-operation.ts';
import { createDiscoveryOperations } from './discovery.ts';
import {
  createSendMessageOperation,
  type SessionExistenceCheck,
} from '../messaging/message-send.ts';
import { createAttachDaemonOperation } from '../remote-daemons/attach-operation.ts';
import {
  createDetachDaemonOperation,
  createListDaemonsOperation,
  createProbeDaemonOperation,
} from '../remote-daemons/manage-operations.ts';
import { createRemoteSendForwarder } from '../remote-daemons/forward-send.ts';
import { remoteDaemons } from '../remote-daemons/registry.ts';
import {
  createOperationRegistry,
  type OperationRegistry,
  type OperationDefinition,
} from './registry.ts';

export interface TaskOperationDependencies {
  members?: OperationDefinition;
  pendingCompletion?: readonly OperationDefinition[];
  submitForReview?: OperationDefinition;
  cancel?: OperationDefinition;
  complete?: OperationDefinition;
  start?: OperationDefinition;
  setPreferredWorkflow?: OperationDefinition;
  create?: OperationDefinition;
  transition?: OperationDefinition;
  retry?: OperationDefinition;
  sendSessionMessage?: OperationDefinition;
  sendTaskMessage?: OperationDefinition;
  readTask: Parameters<typeof createGetTaskOperation>[0];
  readTaskByNumber?: Parameters<typeof createGetTaskOperation>[1];
  createTask: Parameters<typeof createCreateTaskOperation<CreateStandaloneTaskInput>>[0];
  listTasks: Parameters<typeof createListTasksOperation>[0];
  editTask: Parameters<typeof createUpdateTaskOperation>[0];
  transitionTask: Parameters<
    typeof createTransitionTaskOperation<TransitionStandaloneTaskInput>
  >[0];
  sessionExists: SessionExistenceCheck;
}

export function createDaemonOperationCatalog(
  jobQueue: JobQueueRepository,
  tasks: TaskOperationDependencies,
  extra: readonly OperationDefinition[] = []
): OperationRegistry {
  const registry: OperationRegistry = createOperationRegistry([
    createSendMessageOperation(
      jobQueue,
      tasks.sessionExists,
      createRemoteSendForwarder(remoteDaemons)
    ),
    createAttachDaemonOperation(remoteDaemons),
    createProbeDaemonOperation(remoteDaemons),
    createListDaemonsOperation(remoteDaemons),
    createDetachDaemonOperation(remoteDaemons),
    createGetTaskOperation(tasks.readTask, tasks.readTaskByNumber),
    tasks.create ?? createCreateTaskOperation(tasks.createTask),
    createListTasksOperation(tasks.listTasks),
    createUpdateTaskOperation(tasks.editTask),
    tasks.transition ?? createTransitionTaskOperation(tasks.transitionTask),
    ...(tasks.members ? [tasks.members] : []),
    ...(tasks.retry ? [tasks.retry] : []),
    ...(tasks.pendingCompletion ?? []),
    ...(tasks.submitForReview ? [tasks.submitForReview] : []),
    ...(tasks.cancel ? [tasks.cancel] : []),
    ...(tasks.complete ? [tasks.complete] : []),
    ...(tasks.start ? [tasks.start] : []),
    ...(tasks.setPreferredWorkflow ? [tasks.setPreferredWorkflow] : []),
    ...(tasks.sendSessionMessage ? [tasks.sendSessionMessage] : []),
    ...(tasks.sendTaskMessage ? [tasks.sendTaskMessage] : []),
    ...extra,
    ...createDiscoveryOperations(() => registry),
  ]);
  return registry;
}
