import type { Database } from '../../storage/database.ts';
import { transitionStandaloneTask } from '../../storage/tasks/transition-task.ts';
import { listTaskCores } from '../../storage/tasks/list-tasks.ts';
import {
  createStandaloneTask,
  type CreateStandaloneTaskInput,
} from '../../storage/tasks/create-task.ts';
import type { TransitionStandaloneTaskInput } from '../../storage/tasks/transition-task.ts';
import { readTaskCore } from '../../storage/tasks/task-reader.ts';
import type { OperationDefinition } from '../operations/registry.ts';
import { FAIL_CLOSED_LONG_HORIZON_AGENT_REPO } from '../session-resolution/space-mcp-session-policy.ts';
import {
  createAgentReferenceLookups,
  createAgentSessionResolver,
  createResolveAgentOperation,
  type EnsureReferencedAgentSession,
} from '../agents/agent-reference.ts';
import { createDatabaseOperationCatalog } from '../operations/database-catalog.ts';
import type { JobQueueRepository } from '../../storage/repositories/job-queue-repository.ts';
import type { SessionReportHandler } from '../messaging/message-send.ts';
import { createTransitionTaskOperation } from './transition-operation.ts';
import { createUpdateTaskOperation } from './update-operation.ts';
import { createListTasksOperation } from './list-operation.ts';
import { createCreateTaskOperation } from './create-operation.ts';
import { createGetTaskOperation } from './get-operation.ts';
import { createStandaloneTaskMetadataEditor } from './metadata-standalone.ts';
import { listScopedTasks, readScopedTask } from './scoped-task-reads.ts';

export interface TaskOperationDependencies {
  members?: OperationDefinition;
  pendingCompletion?: readonly OperationDefinition[];
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
}

const FALLBACK_TASK_READ_ADMISSION = {
  getSession: () => null,
  longHorizonAgentRepo: FAIL_CLOSED_LONG_HORIZON_AGENT_REPO,
};

export function createTaskCatalogOperations(
  db: Database,
  overrides: Partial<TaskOperationDependencies> = {}
): OperationDefinition[] {
  const tasks: TaskOperationDependencies = {
    readTask: (taskId, caller) =>
      readScopedTask(
        db.getDatabase(),
        caller,
        FALLBACK_TASK_READ_ADMISSION,
        (id) => readTaskCore(db.getDatabase(), id),
        taskId
      ),
    createTask: (input, creatorSessionId) =>
      db.runSpaceTaskOp(createStandaloneTask, { input, creatorSessionId }),
    listTasks: (input, caller) =>
      listScopedTasks(
        caller,
        FALLBACK_TASK_READ_ADMISSION,
        (listInput) => listTaskCores(db.getDatabase(), listInput),
        input
      ),
    editTask: (input, caller) =>
      createStandaloneTaskMetadataEditor(db.getDatabase(), db.runSpaceTaskOp)(input, caller),
    transitionTask: (input) => db.runSpaceTaskOp(transitionStandaloneTask, input),
    ...overrides,
  };
  return [
    createGetTaskOperation(tasks.readTask, tasks.readTaskByNumber),
    tasks.create ?? createCreateTaskOperation(tasks.createTask),
    createListTasksOperation(tasks.listTasks),
    createUpdateTaskOperation(tasks.editTask),
    tasks.transition ?? createTransitionTaskOperation(tasks.transitionTask),
    ...(tasks.members ? [tasks.members] : []),
    ...(tasks.retry ? [tasks.retry] : []),
    ...(tasks.pendingCompletion ?? []),
    ...(tasks.start ? [tasks.start] : []),
    ...(tasks.setPreferredWorkflow ? [tasks.setPreferredWorkflow] : []),
    ...(tasks.sendSessionMessage ? [tasks.sendSessionMessage] : []),
    ...(tasks.sendTaskMessage ? [tasks.sendTaskMessage] : []),
  ];
}

export function createSpaceDefaultOperations(db: Database): OperationDefinition[] {
  return [
    ...createTaskCatalogOperations(db),
    createResolveAgentOperation(createAgentReferenceLookups(() => db.getDatabase())),
  ];
}

export function createSpaceOperationCatalog(
  db: Database,
  jobQueue: JobQueueRepository,
  {
    workerReport,
    ...tasks
  }: Partial<TaskOperationDependencies> & { workerReport?: SessionReportHandler },
  extra: readonly OperationDefinition[],
  ensureAgentSession?: EnsureReferencedAgentSession
) {
  return createDatabaseOperationCatalog(
    db,
    jobQueue,
    {
      workerReport,
      ...(ensureAgentSession
        ? {
            resolveMessageAgent: createAgentSessionResolver(
              createAgentReferenceLookups(() => db.getDatabase()),
              ensureAgentSession
            ),
          }
        : {}),
    },
    [...createTaskCatalogOperations(db, tasks), ...extra]
  );
}
