import { z } from 'zod';
import {
  SpaceTaskStatusSchema,
  UpdateTaskStatusParamDescription,
} from './task-agent-tool-schemas.ts';

export const SpaceSessionStatusSchema = z.enum([
  'active',
  'idle',
  'waiting_for_input',
  'error',
  'archived',
]);

export const SpaceSessionTypeSchema = z.enum(['worker', 'ad-hoc']);

export const MutableProcessingStateSchema = z.enum(['idle', 'running', 'waiting_for_input']);

export const SPACE_SESSION_MAX_LIMIT = 100;

export const SESSION_MESSAGE_MAX_LIMIT = 100;

export const ListSessionsSchema = z.object({
  status: SpaceSessionStatusSchema.optional().describe('Filter by status'),
  type: SpaceSessionTypeSchema.optional().describe('Filter by session type'),
  limit: z.number().int().positive().max(SPACE_SESSION_MAX_LIMIT).optional().default(50),
  offset: z.number().int().min(0).optional().default(0),
});

export const GetSessionDetailSchema = z.object({
  session_id: z.string().describe('Session ID'),
});

export const GetSessionMessagesSchema = z.object({
  session_id: z.string().describe('Session ID'),
  limit: z.number().int().positive().max(SESSION_MESSAGE_MAX_LIMIT).optional().default(20),
  before: z.string().optional().describe('Return messages before this timestamp'),
});

export const SendSessionMessageSchema = z.object({
  session_id: z.string().describe('Target session ID'),
  message: z.string().min(1).describe('Message text'),
  answer_question: z
    .boolean()
    .optional()
    .describe('Clear pending question state while delivering this message'),
});

export const UpdateSessionStateSchema = z.object({
  session_id: z.string().describe('Target session ID'),
  processing_state: MutableProcessingStateSchema.describe('New processing state'),
  clear_pending_question: z.boolean().optional().describe('Clear stale pendingQuestion'),
});

export const InterruptSessionSchema = z.object({
  session_id: z.string().describe('Target session ID'),
  reason: z.string().optional().describe('Reason recorded in the terminal result'),
});

export const ListWorkflowsSchema = z.object({});

export const GetWorkflowRunSchema = z.object({
  run_id: z.string().describe('ID of the workflow run to inspect'),
});

export const ChangePlanSchema = z.object({
  run_id: z.string().describe('ID of the current workflow run'),
  description: z.string().optional().describe('Updated task description'),
  workflow_id: z
    .string()
    .optional()
    .describe(
      'New workflow ID to switch to. The current run will be cancelled and a new run started with the same title.'
    ),
  workflow_handle: z
    .string()
    .optional()
    .describe(
      'New workflow handle to switch to (alternative to workflow_id). The current run will be cancelled and a new run started with the same title.'
    ),
});

export const GetWorkflowDetailSchema = z.object({
  workflow_id: z.string().optional().describe('ID of the workflow to retrieve'),
  workflow_handle: z
    .string()
    .optional()
    .describe('Handle of the workflow to retrieve (alternative to workflow_id)'),
});

export const SuggestWorkflowSchema = z.object({
  description: z
    .string()
    .describe(
      'Description of the work you want to do. Provided for context; the tool returns all workflows regardless.'
    ),
});

export const ListTasksSchema = z.object({
  status: z
    .enum([
      'draft',
      'open',
      'in_progress',
      'review',
      'approved',
      'done',
      'blocked',
      'cancelled',
      'archived',
    ])
    .optional()
    .describe('Filter by task status'),
  workflow_run_id: z
    .string()
    .optional()
    .describe('Filter to only tasks belonging to a specific workflow run'),
  search: z.string().optional().describe('Substring match on task title'),
  limit: z
    .number()
    .int()
    .positive()
    .optional()
    .default(50)
    .describe('Maximum number of tasks to return (default: 50)'),
  offset: z
    .number()
    .int()
    .min(0)
    .optional()
    .default(0)
    .describe('Number of tasks to skip for pagination (default: 0)'),
  compact: z
    .boolean()
    .optional()
    .default(false)
    .describe(
      'Return only summary fields (id, title, status, priority, createdAt) to reduce payload size'
    ),
});

export const CreateStandaloneTaskSchema = z.object({
  title: z.string().describe('Short title for the task'),
  description: z.string().describe('Detailed description of the work to be done'),
  priority: z
    .enum(['low', 'normal', 'high', 'urgent'])
    .optional()
    .describe('Task priority (default: normal)'),
  custom_agent_id: z.string().optional().describe('ID of a worker agent to assign this task to'),
  workflow_id: z
    .string()
    .optional()
    .describe(
      'ID of the workflow to use for this task. When provided, the runtime uses this workflow instead of auto-selecting one. Call list_workflows to discover available workflows (returns both IDs and handles).'
    ),
  workflow_handle: z
    .string()
    .optional()
    .describe(
      'Handle of the workflow to use for this task (alternative to workflow_id). Example: "coding-with-qa".'
    ),
  depends_on: z
    .array(z.string())
    .optional()
    .describe(
      'List of task IDs this task depends on. All must be in the same space. The task will be blocked until every dependency reaches status=done. Cycles and non-existent IDs are rejected.'
    ),
  draft: z
    .boolean()
    .optional()
    .describe(
      'When true, create the task in draft status. Draft tasks are never auto-started by the runtime, even with a workflow and priority assigned. Must be explicitly published before orchestration picks it up.'
    ),
  workspace: z
    .string()
    .optional()
    .describe(
      'Optional workspace for this task, given as the label or absolute path of a workspace registered in this space. Omit to use the space primary workspace. Unknown labels or paths are rejected with the list of registered workspaces.'
    ),
});

export const GetTaskDetailSchema = z.object({
  task_id: z.string().optional().describe('UUID of the task to retrieve'),
  task_number: z
    .number()
    .optional()
    .describe('Numeric task ID (e.g. 5 for task #5) — preferred over task_id'),
});

export const UpdateTaskSchema = z.object({
  task_id: z.string().describe('UUID of the task to update'),
  title: z.string().min(1).optional().describe('New title for the task'),
  description: z.string().optional().describe('New description for the task'),
  priority: z.enum(['low', 'normal', 'high', 'urgent']).optional().describe('New priority'),
  depends_on: z
    .array(z.string())
    .optional()
    .describe(
      'New dependency list (replaces existing). All must be in the same space. Cycles and non-existent IDs are rejected.'
    ),
  status: SpaceTaskStatusSchema.optional().describe(UpdateTaskStatusParamDescription),
});

export const RetryTaskSchema = z.object({
  task_id: z.string().describe('ID of the task to retry'),
  description: z.string().optional().describe('Updated task description for the retry attempt'),
});

export const CancelTaskSchema = z.object({
  task_id: z.string().describe('ID of the task to cancel'),
  cancel_workflow_run: z
    .boolean()
    .optional()
    .describe('If true and the task belongs to a workflow run, also cancel that workflow run'),
});

export const ReassignTaskSchema = z.object({
  task_id: z.string().describe('ID of the task to reassign'),
  custom_agent_id: z
    .string()
    .nullable()
    .optional()
    .describe(
      'ID of the worker agent to assign to. Pass null to clear the worker agent assignment.'
    ),
  assigned_agent: z
    .enum(['coder', 'general'])
    .optional()
    .describe('Agent type to assign (coder or general)'),
});

export const PublishTaskSchema = z.object({
  task_id: z.string().describe('UUID of the draft task to publish'),
});

export const ArchiveTaskSchema = z.object({
  task_id: z.string().describe('UUID of the task to archive'),
});

export const SendMessageToTaskSchema = z.object({
  task_id: z
    .string()
    .optional()
    .describe(
      'ID of the task whose agent session should receive the message. Either task_id or task_number is required.'
    ),
  task_number: z
    .number()
    .int()
    .positive()
    .optional()
    .describe('Space-scoped numeric task ID (e.g. 37). Used when task_id is not provided.'),
  message: z.string().describe('Message to send to the target node agent'),
  node_id: z
    .string()
    .optional()
    .describe(
      'Workflow node selector. Accepts a node_execution UUID or an agent name (e.g. "coder", "reviewer"). The message is routed to that node\'s sub-session; the node is activated automatically if it has no live session.'
    ),
  target: z
    .string()
    .optional()
    .describe(
      'Explicit generic target such as @handle, @role:task-manager, @session:<id>, or @worker:<node>/<agent>. Takes precedence over node_id when supported.'
    ),
});

export const ListTaskMembersSchema = z.object({
  task_id: z.string().describe('ID of the task to inspect'),
});

export const ApproveTaskSchema = z.object({
  task_id: z.string().describe('ID of the task to approve'),
  reason: z.string().optional().describe('Reason for approval'),
});

export const ApprovePendingCompletionSchema = z.object({
  task_id: z.string().describe('ID of the task awaiting submit_for_approval review'),
  approved: z
    .boolean()
    .describe(
      'true to approve (review → approved, fires post-approval router); false to reject (review → in_progress)'
    ),
  reason: z
    .string()
    .nullable()
    .optional()
    .describe('Optional approval/rejection note; recorded on the task as approvalReason'),
});

export const SPACE_AGENT_TOOL_SCHEMAS = {
  list_sessions: ListSessionsSchema,
  get_session_detail: GetSessionDetailSchema,
  get_session_messages: GetSessionMessagesSchema,
  send_session_message: SendSessionMessageSchema,
  update_session_state: UpdateSessionStateSchema,
  interrupt_session: InterruptSessionSchema,
  list_workflows: ListWorkflowsSchema,
  get_workflow_run: GetWorkflowRunSchema,
  change_plan: ChangePlanSchema,
  get_workflow_detail: GetWorkflowDetailSchema,
  suggest_workflow: SuggestWorkflowSchema,
  list_tasks: ListTasksSchema,
  create_standalone_task: CreateStandaloneTaskSchema,
  get_task_detail: GetTaskDetailSchema,
  update_task: UpdateTaskSchema,
  retry_task: RetryTaskSchema,
  cancel_task: CancelTaskSchema,
  reassign_task: ReassignTaskSchema,
  publish_task: PublishTaskSchema,
  archive_task: ArchiveTaskSchema,
  send_message_to_task: SendMessageToTaskSchema,
  list_task_members: ListTaskMembersSchema,
  approve_task: ApproveTaskSchema,
  approve_pending_completion: ApprovePendingCompletionSchema,
} as const;

export type SpaceAgentToolName = keyof typeof SPACE_AGENT_TOOL_SCHEMAS;
