import type { Database } from '../../storage/database.ts';
import { transitionStandaloneTask } from '../../storage/tasks/transition-task.ts';
import { listTaskCores } from '../../storage/tasks/list-tasks.ts';
import { createStandaloneTask } from '../../storage/tasks/create-task.ts';
import { readTaskCore } from '../../storage/tasks/task-reader.ts';
import { createStandaloneTaskMetadataEditor } from '../tasks/metadata-standalone.ts';
import { listScopedTasks, readScopedTask } from '../tasks/scoped-task-reads.ts';
import { FAIL_CLOSED_LONG_HORIZON_AGENT_REPO } from '../space/runtime/space-mcp-session-policy.ts';
import { createDaemonOperationCatalog, type TaskOperationDependencies } from './catalog.ts';
import type { OperationDefinition } from './registry.ts';

const FALLBACK_TASK_READ_ADMISSION = {
  getSession: () => null,
  longHorizonAgentRepo: FAIL_CLOSED_LONG_HORIZON_AGENT_REPO,
};

function sessionRowExists(db: Database, sessionId: string): boolean {
  return db.getDatabase().prepare('SELECT 1 FROM sessions WHERE id = ?').get(sessionId) != null;
}

export function createDatabaseOperationCatalog(
  db: Database,
  jobQueue = db.getJobQueueRepo(),
  overrides: Partial<TaskOperationDependencies> = {},
  extra: readonly OperationDefinition[] = []
) {
  return createDaemonOperationCatalog(
    jobQueue,
    {
      readTask: (taskId, caller) =>
        readScopedTask(
          db.getDatabase(),
          caller,
          FALLBACK_TASK_READ_ADMISSION,
          (id) => readTaskCore(db.getDatabase(), id),
          taskId
        ),
      createTask: (input, creatorSessionId) =>
        createStandaloneTask(db.getDatabase(), input, creatorSessionId, () =>
          db.notifyChange('space_tasks')
        ),
      listTasks: (input, caller) =>
        listScopedTasks(
          caller,
          FALLBACK_TASK_READ_ADMISSION,
          (listInput) => listTaskCores(db.getDatabase(), listInput),
          input
        ),
      editTask: (input, caller) =>
        createStandaloneTaskMetadataEditor(db.getDatabase(), () => db.notifyChange('space_tasks'))(
          input,
          caller
        ),
      transitionTask: (input) =>
        transitionStandaloneTask(db.getDatabase(), input, () => db.notifyChange('space_tasks')),
      sessionExists: (sessionId) => sessionRowExists(db, sessionId),
      ...overrides,
    },
    extra
  );
}
