import type { Database } from '../../storage/database.ts';
import { setStandaloneTaskDependencies } from '../../storage/tasks/set-task-dependencies.ts';
import { transitionStandaloneTask } from '../../storage/tasks/transition-task.ts';
import { listTaskCores } from '../../storage/tasks/list-tasks.ts';
import { createStandaloneTask } from '../../storage/tasks/create-task.ts';
import { readTaskCore } from '../../storage/tasks/task-reader.ts';
import { createStandaloneTaskMetadataEditor } from './task-metadata-standalone.ts';
import { createDaemonOperationCatalog } from './catalog.ts';

export function createDatabaseOperationCatalog(db: Database, jobQueue = db.getJobQueueRepo()) {
  return createDaemonOperationCatalog(jobQueue, {
    readTask: (taskId) => readTaskCore(db.getDatabase(), taskId),
    createTask: (input, creatorSessionId) =>
      createStandaloneTask(db.getDatabase(), input, creatorSessionId, () =>
        db.notifyChange('space_tasks')
      ),
    listTasks: (input) => listTaskCores(db.getDatabase(), input),
    editTask: (input, caller) =>
      createStandaloneTaskMetadataEditor(db.getDatabase(), () => db.notifyChange('space_tasks'))(
        input,
        caller
      ),
    transitionTask: (input) =>
      transitionStandaloneTask(db.getDatabase(), input, () => db.notifyChange('space_tasks')),
    setDependencies: (input) =>
      setStandaloneTaskDependencies(db.getDatabase(), input, () => db.notifyChange('space_tasks')),
  });
}
