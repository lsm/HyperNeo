import type { z } from 'zod';
import {
  ApprovePendingCompletionSchema,
  ApproveTaskSchema,
  ArchiveTaskSchema,
  CancelTaskSchema,
  ChangePlanSchema,
  CreateStandaloneTaskSchema,
  GetSessionDetailSchema,
  GetSessionMessagesSchema,
  GetTaskDetailSchema,
  GetWorkflowDetailSchema,
  GetWorkflowRunSchema,
  InterruptSessionSchema,
  ListSessionsSchema,
  ListTaskMembersSchema,
  ListTasksSchema,
  ListWorkflowsSchema,
  PublishTaskSchema,
  ReassignTaskSchema,
  RetryTaskSchema,
  SendMessageToTaskSchema,
  SendSessionMessageSchema,
  SuggestWorkflowSchema,
  UpdateSessionStateSchema,
  UpdateTaskSchema,
} from '../tools/space-agent-tool-schemas.ts';
import {
  createSpaceAgentToolHandlers,
  type SpaceAgentToolsConfig,
} from '../tools/space-agent-tools.ts';
import { SESSION_WRITE_AUTONOMY_LEVEL } from '../tools/tool-admission-gates.ts';
import { type ActionDefinition, defineAction } from './registry.ts';

const DEFAULT_COMPLETION_AUTONOMY_LEVEL = 5;

export function createSpaceRegistryEntries(config: SpaceAgentToolsConfig): ActionDefinition[] {
  const handlers = createSpaceAgentToolHandlers(config);

  const approveTaskAutonomy = async (params: z.infer<typeof ApproveTaskSchema>) => {
    const task = config.taskRepo.getTask(params.task_id);
    const run = task?.workflowRunId ? config.workflowRunRepo.getRun(task.workflowRunId) : null;
    const workflow = run?.workflowId ? config.workflowManager.getWorkflowForRun(run) : null;
    return workflow?.completionAutonomyLevel ?? DEFAULT_COMPLETION_AUTONOMY_LEVEL;
  };

  const sessionEntries: ActionDefinition[] = [
    defineAction({
      name: 'list_sessions',
      family: 'sessions',
      safetyClass: 'read',
      description:
        'List ad-hoc and worker sessions in this space; returns summaries with derived status, type, workspace, and git branch.',
      paramsDoc: 'status?, type?, limit? (max 100, default 50), offset? (default 0)',
      paramsSchema: ListSessionsSchema,
      handler: (args) => handlers.list_sessions(args),
    }),
    defineAction({
      name: 'get_session_detail',
      family: 'sessions',
      safetyClass: 'read',
      description:
        'Inspect one session including parsed processing_state and its last messages; returns the full session summary.',
      paramsDoc: 'session_id',
      paramsSchema: GetSessionDetailSchema,
      handler: (args) => handlers.get_session_detail(args),
    }),
    defineAction({
      name: 'get_session_messages',
      family: 'sessions',
      safetyClass: 'read',
      description:
        'Read one session conversation with per-message summaries; returns newest-first messages and a pagination cursor.',
      paramsDoc:
        'session_id, limit? (max 100, default 20), before? (timestamp or timestamp|id cursor)',
      paramsSchema: GetSessionMessagesSchema,
      handler: (args) => handlers.get_session_messages(args),
    }),
    defineAction({
      name: 'send_session_message',
      family: 'sessions',
      safetyClass: 'mutate',
      description:
        'Send a user message to an ad-hoc session and optionally clear a pending question; returns the delivery result.',
      paramsDoc: 'session_id, message, answer_question?',
      paramsSchema: SendSessionMessageSchema,
      autonomyRequirement: SESSION_WRITE_AUTONOMY_LEVEL,
      handler: (args) => handlers.send_session_message(args),
    }),
    defineAction({
      name: 'update_session_state',
      family: 'sessions',
      safetyClass: 'mutate',
      description:
        'Force a stuck session processing_state to idle, running, or waiting_for_input; returns previous and new state.',
      paramsDoc:
        'session_id, processing_state (idle|running|waiting_for_input), clear_pending_question?',
      paramsSchema: UpdateSessionStateSchema,
      autonomyRequirement: SESSION_WRITE_AUTONOMY_LEVEL,
      handler: (args) => handlers.update_session_state(args),
    }),
    defineAction({
      name: 'interrupt_session',
      family: 'sessions',
      safetyClass: 'mutate',
      description:
        'Force-interrupt a running or stuck session and reset it to idle; returns whether the interrupt was delivered.',
      paramsDoc: 'session_id, reason?',
      paramsSchema: InterruptSessionSchema,
      autonomyRequirement: SESSION_WRITE_AUTONOMY_LEVEL,
      handler: (args) => handlers.interrupt_session(args),
    }),
  ];

  const workflowEntries: ActionDefinition[] = [
    defineAction({
      name: 'list_workflows',
      family: 'workflows',
      safetyClass: 'read',
      description:
        'List every workflow in this space with its description and steps; returns id, handle, and node summaries.',
      paramsDoc: 'none',
      paramsSchema: ListWorkflowsSchema,
      handler: () => handlers.list_workflows(),
    }),
    defineAction({
      name: 'get_workflow_run',
      family: 'workflows',
      safetyClass: 'read',
      description:
        'Check one workflow run including its current step; returns the run record and its node executions.',
      paramsDoc: 'run_id',
      paramsSchema: GetWorkflowRunSchema,
      handler: (args) => handlers.get_workflow_run(args),
    }),
    defineAction({
      name: 'change_plan',
      family: 'workflows',
      safetyClass: 'mutate',
      description:
        'Update an active run description, or switch it to another workflow (cancels the run and starts a new one); returns the affected run(s).',
      paramsDoc: 'run_id, plus description? and/or workflow_id?/workflow_handle?',
      paramsSchema: ChangePlanSchema,
      handler: (args) => handlers.change_plan(args),
    }),
    defineAction({
      name: 'get_workflow_detail',
      family: 'workflows',
      safetyClass: 'read',
      description:
        'Read one workflow definition including steps, transitions, and rules; returns the full workflow record.',
      paramsDoc: 'workflow_id? or workflow_handle? (one required)',
      paramsSchema: GetWorkflowDetailSchema,
      handler: (args) => handlers.get_workflow_detail(args),
    }),
    defineAction({
      name: 'suggest_workflow',
      family: 'workflows',
      safetyClass: 'read',
      description:
        'List all enabled workflows unranked for a described piece of work; returns id, handle, description, tags, and nodes.',
      paramsDoc: 'description (context only — every workflow is returned)',
      paramsSchema: SuggestWorkflowSchema,
      handler: (args) => handlers.suggest_workflow(args),
    }),
  ];

  const taskEntries: ActionDefinition[] = [
    defineAction({
      name: 'list_tasks',
      family: 'tasks',
      safetyClass: 'read',
      description:
        'List tasks in this space filterable by status, run, and title search; returns task summaries (compact mode trims fields).',
      paramsDoc: 'status?, workflow_run_id?, search?, limit? (default 50), offset?, compact?',
      paramsSchema: ListTasksSchema,
      handler: (args) => handlers.list_tasks(args),
    }),
    defineAction({
      name: 'create_standalone_task',
      family: 'tasks',
      safetyClass: 'mutate',
      description:
        'Create a task the runtime may attach a workflow to; supports dependencies, draft mode, and workspace selection; returns the created task.',
      paramsDoc:
        'title, description, priority?, workflow_id?/workflow_handle?, depends_on? (task ids), draft?, workspace?',
      paramsSchema: CreateStandaloneTaskSchema,
      handler: (args) => handlers.create_standalone_task(args),
    }),
    defineAction({
      name: 'get_task_detail',
      family: 'tasks',
      safetyClass: 'read',
      description:
        'Read one task including status, result, and metadata; returns the full task record.',
      paramsDoc: 'task_number (preferred) or task_id',
      paramsSchema: GetTaskDetailSchema,
      handler: (args) => handlers.get_task_detail(args),
    }),
    defineAction({
      name: 'update_task',
      family: 'tasks',
      safetyClass: 'mutate',
      description:
        "Edit a task's title, description, priority, dependencies, or status; status follows the UI transition table; returns the updated task.",
      paramsDoc: 'task_id, plus any of title?, description?, priority?, depends_on?, status?',
      paramsSchema: UpdateTaskSchema,
      handler: (args) => handlers.update_task(args),
    }),
    defineAction({
      name: 'retry_task',
      family: 'tasks',
      safetyClass: 'mutate',
      description:
        'Retry a failed or cancelled task, optionally with an updated description; returns the restarted task.',
      paramsDoc: 'task_id, description?',
      paramsSchema: RetryTaskSchema,
      handler: (args) => handlers.retry_task(args),
    }),
    defineAction({
      name: 'cancel_task',
      family: 'tasks',
      safetyClass: 'mutate',
      description:
        'Cancel a task, cascading to pending dependents and optionally its workflow run; returns the cancelled task.',
      paramsDoc: 'task_id, cancel_workflow_run?',
      paramsSchema: CancelTaskSchema,
      handler: (args) => handlers.cancel_task(args),
    }),
    defineAction({
      name: 'reassign_task',
      family: 'tasks',
      safetyClass: 'mutate',
      description:
        'Change a task worker-agent or coder/general assignment (open, blocked, or cancelled tasks only); returns the updated task.',
      paramsDoc: 'task_id, custom_agent_id? (null clears), assigned_agent? (coder|general)',
      paramsSchema: ReassignTaskSchema,
      handler: (args) => handlers.reassign_task(args),
    }),
    defineAction({
      name: 'publish_task',
      family: 'tasks',
      safetyClass: 'mutate',
      description:
        'Publish a draft task to open so orchestration can pick it up; returns the updated task.',
      paramsDoc: 'task_id',
      paramsSchema: PublishTaskSchema,
      handler: (args) => handlers.publish_task(args),
    }),
    defineAction({
      name: 'archive_task',
      family: 'tasks',
      safetyClass: 'destructive',
      description:
        'Archive a task — the true terminal state; archived tasks are excluded from queries and cannot be reactivated.',
      paramsDoc: 'task_id',
      paramsSchema: ArchiveTaskSchema,
      handler: (args) => handlers.archive_task(args),
    }),
    defineAction({
      name: 'send_message_to_task',
      family: 'tasks',
      safetyClass: 'mutate',
      description:
        'Message a workflow node agent or long-term agent on a task, activating or queueing it when supported; returns the delivery outcome.',
      paramsDoc:
        'task_id or task_number, message, node_id? or target? (@handle/@role/@session/@worker)',
      paramsSchema: SendMessageToTaskSchema,
      handler: (args) => handlers.send_message_to_task(args),
    }),
    defineAction({
      name: 'list_task_members',
      family: 'tasks',
      safetyClass: 'read',
      description:
        "List a task's workflow node executions with status, result, and saved data; returns the execution list.",
      paramsDoc: 'task_id',
      paramsSchema: ListTaskMembersSchema,
      handler: (args) => handlers.list_task_members(args),
    }),
    defineAction({
      name: 'approve_task',
      family: 'tasks',
      safetyClass: 'mutate',
      description:
        "Approve a task in 'review' status to done; requires the workflow's completionAutonomyLevel (default 5); returns the approved task.",
      paramsDoc: 'task_id, reason?',
      paramsSchema: ApproveTaskSchema,
      autonomyRequirement: approveTaskAutonomy,
      handler: (args) => handlers.approve_task(args),
    }),
    defineAction({
      name: 'approve_pending_completion',
      family: 'tasks',
      safetyClass: 'human_only',
      description:
        'Approve or reject a task paused at the submit_for_approval checkpoint; coordinator and task-agent sessions only; returns the updated task.',
      paramsDoc: 'task_id, approved (true approves, false rejects to in_progress), reason?',
      paramsSchema: ApprovePendingCompletionSchema,
      handler: (args) => handlers.approve_pending_completion(args),
    }),
  ];

  const entries = config.db
    ? [...sessionEntries, ...workflowEntries, ...taskEntries]
    : [...workflowEntries, ...taskEntries];
  return config.taskAgentManager
    ? entries
    : entries.filter((entry) => entry.name !== 'send_message_to_task');
}
