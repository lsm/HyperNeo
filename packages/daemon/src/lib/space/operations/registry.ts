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
import type { NodeExecutionRepository } from '../../../storage/repositories/node-execution-repository.ts';
import type { SpaceLongHorizonAgentRepository } from '../../../storage/repositories/space-long-horizon-agent-repository.ts';
import type { SpaceWorkflowRunRepository } from '../../../storage/repositories/space-workflow-run-repository.ts';
import type { SessionManager } from '../../session/session-manager.ts';
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
import { createArchiveTaskOperation, type ArchiveTaskDependencies } from './archive-task.ts';
import { listScopedTasks, readScopedTask, readScopedTaskByNumber } from './scoped-task-reads.ts';
import { readScopedAgent, listScopedAgents } from './scoped-agent-reads.ts';
import { stampActiveAttempt, stampActiveAttempts } from './direct-attempt-flag.ts';
import {
  createSetPreferredWorkflowOperation,
  type SetPreferredWorkflowDependencies,
} from './set-preferred-workflow.ts';
import { createSendSessionMessageOperation } from './session-message-send.ts';
import {
  createSendTaskMessageOperation,
  type TaskMessageSendDependencies,
} from './task-message-send.ts';

interface ArchiveTaskCapability {
  getTaskManager: ArchiveTaskDependencies['getTaskManager'];
  isWorkflowRunActive: ArchiveTaskDependencies['isWorkflowRunActive'];
}

interface TaskNumberRepository {
  taskRepo?: Pick<SpaceTaskRepository, 'getTaskByNumber'>;
}

interface PreferredWorkflowCapability {
  getWorkflow?: SetPreferredWorkflowDependencies['getWorkflow'];
}

interface SessionMessagingCapability {
  sessionManager?: Pick<SessionManager, 'getCachedSession' | 'getSessionAsync' | 'sendUserMessage'>;
}

interface TaskMessageSendCapability {
  longHorizonAgentRepo?: SpaceLongHorizonAgentRepository;
  workflowRunRepo?: Pick<SpaceWorkflowRunRepository, 'getRun'>;
  getWorkflowForRun?: TaskMessageSendDependencies['getWorkflowForRun'];
  nodeExecutionRepo?: Pick<NodeExecutionRepository, 'listByWorkflowRun' | 'getById'>;
  taskAgentManager?: TaskMessageSendDependencies['taskAgentManager'];
  ensureTargetSession?: TaskMessageSendDependencies['ensureTargetSession'];
  activateNode?: TaskMessageSendDependencies['activateNode'];
  messageResolverFactory?: TaskMessageSendDependencies['messageResolverFactory'];
  longTermAgentDelivery?: TaskMessageSendDependencies['longTermAgentDelivery'];
  replyRoutingRegistry?: TaskMessageSendDependencies['replyRoutingRegistry'];
  audit?: TaskMessageSendDependencies['audit'];
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
    ArchiveTaskCapability &
    TaskNumberRepository &
    PreferredWorkflowCapability &
    SessionMessagingCapability &
    TaskMessageSendCapability &
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
        stampActiveAttempt(
          database.getDatabase(),
          readScopedTask(
            database.getDatabase(),
            caller,
            tasks,
            (id) => tasks.taskRepo?.getTask(id) ?? readTaskCore(database.getDatabase(), id),
            taskId
          )
        ),
      readTaskByNumber: tasks.taskRepo?.getTaskByNumber
        ? (spaceId, taskNumber, caller) =>
            stampActiveAttempt(
              database.getDatabase(),
              readScopedTaskByNumber(
                caller,
                tasks,
                (id, number) => tasks.taskRepo?.getTaskByNumber(id, number) ?? null,
                spaceId,
                taskNumber
              )
            )
        : undefined,
      listTasks: (input, caller) =>
        stampActiveAttempts(
          database.getDatabase(),
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
          )
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
      setPreferredWorkflow: tasks.getWorkflow
        ? createSetPreferredWorkflowOperation({
            ...tasks,
            getWorkflow: tasks.getWorkflow,
            db: database.getDatabase(),
          })
        : undefined,
      archive: createArchiveTaskOperation(() => database.getDatabase(), tasks),
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
      listAgents: (spaceId: string, caller) =>
        listScopedAgents(
          caller,
          {
            getSession: (sessionId) => database.getSession(sessionId),
            longHorizonAgentRepo: database.getLongHorizonAgentRepo(),
          },
          (id) => database.getLongHorizonAgentRepo().listBySpaceId(id),
          spaceId
        ),
      getAgent: (agentId: string, caller) =>
        readScopedAgent(
          caller,
          {
            getSession: (sessionId) => database.getSession(sessionId),
            longHorizonAgentRepo: database.getLongHorizonAgentRepo(),
          },
          (id) => database.getLongHorizonAgentRepo().getById(id),
          agentId
        ),
      sendSessionMessage: tasks.sessionManager
        ? createSendSessionMessageOperation({
            getSessionRow: (spaceId, sessionId) => {
              const row = database
                .getDatabase()
                .prepare(
                  `SELECT status, processing_state FROM sessions WHERE id = ? AND space_id = ?`
                )
                .get(sessionId, spaceId) as {
                status: string;
                processing_state: string | null;
              } | null;
              return row ?? null;
            },
            getLiveSession: async (sessionId) => {
              const cached = tasks.sessionManager!.getCachedSession(sessionId);
              if (cached) return cached;
              return (await tasks.sessionManager!.getSessionAsync(sessionId)) ?? null;
            },
            sendUserMessage: (data) => tasks.sessionManager!.sendUserMessage(data),
          })
        : undefined,
      sendTaskMessage:
        tasks.taskRepo &&
        tasks.workflowRunRepo &&
        tasks.nodeExecutionRepo &&
        tasks.getWorkflowForRun &&
        tasks.taskAgentManager &&
        tasks.ensureTargetSession &&
        tasks.activateNode &&
        tasks.messageResolverFactory &&
        tasks.longTermAgentDelivery
          ? createSendTaskMessageOperation({
              getTask: (taskId) => tasks.taskRepo!.getTask(taskId),
              getTaskByNumber: (spaceId, taskNumber) =>
                tasks.taskRepo!.getTaskByNumber(spaceId, taskNumber),
              getWorkflowRun: (workflowRunId) => tasks.workflowRunRepo!.getRun(workflowRunId),
              getWorkflowForRun: tasks.getWorkflowForRun,
              listNodeExecutions: (workflowRunId) =>
                tasks.nodeExecutionRepo!.listByWorkflowRun(workflowRunId),
              getNodeExecutionById: (executionId) => tasks.nodeExecutionRepo!.getById(executionId),
              ensureTargetSession: tasks.ensureTargetSession,
              activateNode: tasks.activateNode,
              taskAgentManager: tasks.taskAgentManager,
              messageResolverFactory: tasks.messageResolverFactory,
              longHorizonAgentRepo: tasks.longHorizonAgentRepo,
              longTermAgentDelivery: tasks.longTermAgentDelivery,
              replyRoutingRegistry: tasks.replyRoutingRegistry,
              audit: tasks.audit,
            })
          : undefined,
    }));
}
