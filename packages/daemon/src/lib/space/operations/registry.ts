import { createStartTaskOperation, type DirectStartOperationDependencies } from './start-task.ts';
import { createCancelTaskOperation } from './cancel-task.ts';
import { createCompleteTaskOperation, type CompleteTaskDependencies } from './complete-task.ts';
import { createSubmitTaskForReviewOperation } from './submit-for-review.ts';
import {
  createOwnedPendingCompletionOperation,
  type OwnedPendingCompletionDependencies,
} from './owned-pending-completion.ts';
import {
  createSpaceTaskDependencyEditor,
  type SpaceTaskDependencyDependencies,
} from './task-dependencies.ts';
import type { Database } from '../../../storage/database.ts';
import type { JobQueueRepository } from '../../../storage/repositories/job-queue-repository.ts';
import { createDatabaseOperationCatalog } from '../../operations/database-catalog.ts';
import type { OperationRegistry } from '../../operations/registry.ts';
import {
  createSpaceTaskMetadataEditor,
  type SpaceTaskMetadataDependencies,
} from './task-metadata.ts';

export function createSpaceOperationRegistryProvider(
  database: Database,
  jobQueue: JobQueueRepository,
  tasks: Omit<SpaceTaskMetadataDependencies & SpaceTaskDependencyDependencies, 'db'>,
  pendingCompletion?: OwnedPendingCompletionDependencies,
  directStart?: DirectStartOperationDependencies,
  completeTask?: CompleteTaskDependencies
) {
  let registry: OperationRegistry | undefined;
  return () =>
    (registry ??= createDatabaseOperationCatalog(database, jobQueue, {
      start: directStart
        ? createStartTaskOperation(() => database.getDatabase(), jobQueue, tasks, directStart)
        : undefined,
      cancel: createCancelTaskOperation(() => database.getDatabase(), jobQueue, tasks),
      complete: completeTask
        ? createCompleteTaskOperation(() => database.getDatabase(), completeTask)
        : undefined,
      submitForReview: createSubmitTaskForReviewOperation(
        () => database.getDatabase(),
        jobQueue,
        tasks
      ),
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
