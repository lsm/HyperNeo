import { createStartTaskOperation, type DirectStartOperationDependencies } from './start-task.ts';
import { createCancelTaskOperation, type CancelPolicyContext } from './cancel-task.ts';
import { createSubmitTaskForReviewOperation } from './submit-for-review.ts';
import { createSpaceCreateTaskOperation, type SpaceCreateTaskDependencies } from './create-task.ts';
import { createCompleteTaskOperation, type CompleteTaskDependencies } from './complete-task.ts';
import {
  createOwnedPendingCompletionOperation,
  type OwnedPendingCompletionDependencies,
} from './owned-pending-completion.ts';
import {
  createSpaceTaskDependencyEditor,
  type SpaceTaskDependencyDependencies,
} from './task-dependencies.ts';
import {
  createSpaceTransitionTaskOperation,
  type SpaceTransitionTaskDependencies,
} from './transition-task.ts';
import type { Database } from '../../../storage/database.ts';
import type { SpaceTaskRepository } from '../../../storage/repositories/space-task-repository.ts';
import type { JobQueueRepository } from '../../../storage/repositories/job-queue-repository.ts';
import { listTaskCores } from '../../../storage/tasks/list-tasks.ts';
import { readTaskCore } from '../../../storage/tasks/task-reader.ts';
import { listTasksWithSpaceFields, spaceTaskBatchReader } from './list-tasks-with-space-fields.ts';
import { createDatabaseOperationCatalog } from '../../operations/database-catalog.ts';
import type { OperationRegistry } from '../../operations/registry.ts';
import {
  createSpaceTaskMetadataEditor,
  type SpaceTaskMetadataDependencies,
} from './task-metadata.ts';
import {
  createListTaskMembersOperation,
  type TaskMemberRepositories,
} from './list-task-members.ts';
import { createRecoverTaskOperation, type RecoverTaskDependencies } from './recover-task.ts';
import { listScopedTasks, readScopedTask, readScopedTaskByNumber } from './scoped-task-reads.ts';

interface RecoverTaskCapability {
  getTaskManager: RecoverTaskDependencies['getTaskManager'];
  recoverWorkflowTask: RecoverTaskDependencies['recoverWorkflowTask'];
}

interface TaskNumberRepository {
  taskRepo?: Pick<SpaceTaskRepository, 'getTaskByNumber'>;
}

export function createSpaceOperationRegistryProvider(
  database: Database,
  jobQueue: JobQueueRepository,
  tasks: Omit<
    SpaceTaskMetadataDependencies & SpaceTaskDependencyDependencies & SpaceCreateTaskDependencies,
    'db'
  > &
    CancelPolicyContext &
    TaskMemberRepositories &
    RecoverTaskCapability &
    TaskNumberRepository &
    Omit<
      CompleteTaskDependencies,
      'getTaskManager' | 'emitTaskUpdated' | 'requiresPostApprovalOwner' | 'completionGate'
    > &
    Required<Pick<CompleteTaskDependencies, 'requiresPostApprovalOwner' | 'completionGate'>>,
  pendingCompletion?: OwnedPendingCompletionDependencies,
  directStart?: DirectStartOperationDependencies,
  transition?: Omit<SpaceTransitionTaskDependencies, 'db'>
) {
  let registry: OperationRegistry | undefined;
  return () =>
    (registry ??= createDatabaseOperationCatalog(database, jobQueue, {
      readTask: (taskId, caller) =>
        readScopedTask(
          database.getDatabase(),
          caller,
          tasks,
          (id) => tasks.taskRepo?.getTask(id) ?? readTaskCore(database.getDatabase(), id),
          taskId
        ),
      readTaskByNumber: tasks.taskRepo?.getTaskByNumber
        ? (spaceId, taskNumber, caller) =>
            readScopedTaskByNumber(
              caller,
              tasks,
              (id, number) => tasks.taskRepo?.getTaskByNumber(id, number) ?? null,
              spaceId,
              taskNumber
            )
        : undefined,
      listTasks: (input, caller) =>
        listScopedTasks(
          caller,
          tasks,
          (listInput) =>
            listTasksWithSpaceFields(
              (coreInput) => listTaskCores(database.getDatabase(), coreInput),
              listInput,
              spaceTaskBatchReader(tasks.taskRepo)
            ),
          input
        ),
      create: createSpaceCreateTaskOperation({
        ...tasks,
        get db() {
          return database.getDatabase();
        },
      }),
      start: directStart
        ? createStartTaskOperation(() => database.getDatabase(), jobQueue, tasks, directStart)
        : undefined,
      cancel: createCancelTaskOperation(() => database.getDatabase(), jobQueue, tasks),
      recover: createRecoverTaskOperation(() => database.getDatabase(), tasks),
      members:
        tasks.taskRepo && tasks.nodeExecutionRepo
          ? createListTaskMembersOperation({
              taskRepo: tasks.taskRepo,
              nodeExecutionRepo: tasks.nodeExecutionRepo,
              readCoreTask: (taskId) => readTaskCore(database.getDatabase(), taskId),
            })
          : undefined,
      submitForReview: createSubmitTaskForReviewOperation(
        () => database.getDatabase(),
        jobQueue,
        tasks
      ),
      complete: createCompleteTaskOperation(() => database.getDatabase(), tasks),
      transition: transition
        ? createSpaceTransitionTaskOperation({
            ...transition,
            get db() {
              return database.getDatabase();
            },
          })
        : undefined,
      pendingCompletion: pendingCompletion
        ? createOwnedPendingCompletionOperation(pendingCompletion)
        : undefined,
      editTask: (input, caller) =>
        createSpaceTaskMetadataEditor({
          ...tasks,
          db: database.getDatabase(),
        })(input, caller),
      setDependencies: (input, caller) =>
        createSpaceTaskDependencyEditor({
          ...tasks,
          db: database.getDatabase(),
        })(input, caller),
    }));
}
