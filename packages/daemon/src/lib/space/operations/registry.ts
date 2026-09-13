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
import type { JobQueueRepository } from '../../../storage/repositories/job-queue-repository.ts';
import type { SpaceTaskRepository } from '../../../storage/repositories/space-task-repository.ts';
import { listTaskCores } from '../../../storage/tasks/list-tasks.ts';
import { readTaskCore } from '../../../storage/tasks/task-reader.ts';
import { createDatabaseOperationCatalog } from '../../operations/database-catalog.ts';
import type { OperationRegistry } from '../../operations/registry.ts';
import {
  createSpaceTaskMetadataEditor,
  type SpaceTaskMetadataDependencies,
} from './task-metadata.ts';

export function createSpaceOperationRegistryProvider(
  database: Database,
  jobQueue: JobQueueRepository,
  tasks: Omit<
    SpaceTaskMetadataDependencies & SpaceTaskDependencyDependencies & SpaceCreateTaskDependencies,
    'db'
  > &
    CancelPolicyContext &
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
      readTask: (taskId) =>
        tasks.taskRepo?.getTask(taskId) ?? readTaskCore(database.getDatabase(), taskId),
      listTasks: async (input) => {
        const page = listTaskCores(database.getDatabase(), input);
        const taskRepo = tasks.taskRepo as SpaceTaskRepository | undefined;
        if (!taskRepo || page.tasks.length === 0) return page;
        const bySpaceId = new Map(
          taskRepo.getTasksByIds(page.tasks.map((task) => task.id)).map((task) => [task.id, task])
        );
        return { ...page, tasks: page.tasks.map((task) => bySpaceId.get(task.id) ?? task) };
      },
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
