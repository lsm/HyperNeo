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

export const AgentStatusSchema = z.enum(['active', 'paused', 'disabled', 'archived']);

export const ThinkingLevelSchema = z.enum(['off', 'think8k', 'think16k', 'think24k', 'think32k']);

export const SettingSourcesSchema = z.array(z.enum(['user', 'project', 'local']));

export const ListAgentsSchema = z.object({
  status: AgentStatusSchema.optional().describe('Filter by agent lifecycle status'),
  compact: z.boolean().optional().describe('Return compact agent summaries'),
});

export const GetAgentSchema = z.object({
  agent_id: z.string().describe('Long-horizon agent ID'),
});

export const CreateAgentSchema = z.object({
  name: z.string().min(1).describe('Agent name, unique within the space'),
  description: z.string().optional().describe('Agent specialization summary'),
  model: z.string().optional().describe('Model override'),
  thinking_level: ThinkingLevelSchema.optional().describe('Thinking level override'),
  provider: z.string().optional().describe('Provider override'),
  custom_prompt: z.string().nullable().optional().describe('Operator prompt for this agent'),
  tools: z.array(z.string()).optional().describe('Tool allowlist override'),
  setting_sources: SettingSourcesSchema.nullable()
    .optional()
    .describe('Settings sources for this agent'),
});

export const CreateAgentFromTemplateSchema = z.object({
  template_name: z
    .string()
    .describe(
      'Worker preset name (Coder, Reviewer, QA) or long-horizon template key (marketing.default, security-auditor.default)'
    ),
  name: z
    .string()
    .optional()
    .describe('Optional new agent name; defaults to template name/display name'),
  model: z.string().optional().describe('Model override'),
  provider: z.string().optional().describe('Provider override'),
  thinking_level: ThinkingLevelSchema.optional().describe('Thinking level override'),
});

export const ListAgentTemplatesSchema = z.object({});

export const UpdateAgentSchema = z.object({
  agent_id: z.string().describe('Long-horizon agent ID'),
  name: z.string().optional().describe('New agent name'),
  status: AgentStatusSchema.optional().describe('Lifecycle status'),
  description: z.string().nullable().optional().describe('New description'),
  model: z.string().nullable().optional().describe('Model override, or null to clear'),
  thinking_level: ThinkingLevelSchema.nullable()
    .optional()
    .describe('Thinking level override, or null to clear'),
  provider: z.string().nullable().optional().describe('Provider override, or null to clear'),
  custom_prompt: z.string().nullable().optional().describe('Prompt override, or null to clear'),
  tools: z
    .array(z.string())
    .nullable()
    .optional()
    .describe('Tool allowlist override, or null to clear'),
  setting_sources: SettingSourcesSchema.nullable()
    .optional()
    .describe('Settings sources override, or null to clear'),
});

export const PauseAgentSchema = z.object({
  agent_id: z.string().describe('Long-horizon agent ID'),
});

export const ArchiveAgentSchema = z.object({
  agent_id: z.string().describe('Long-horizon agent ID'),
});

export const AssignAgentToGoalSchema = z.object({
  agent_id: z.string().describe('Long-horizon agent ID'),
  goal_id: z.string().describe('Goal ID'),
});

export const UnassignAgentFromGoalSchema = z.object({
  agent_id: z.string().describe('Long-horizon agent ID'),
  goal_id: z.string().describe('Goal ID'),
});

export const AssignAgentToForgeScopeSchema = z.object({
  agent_id: z.string().describe('Long-horizon agent ID'),
  scope_id: z.string().describe('Forge scope ID'),
});

export const UnassignAgentFromForgeScopeSchema = z.object({
  agent_id: z.string().describe('Long-horizon agent ID'),
  scope_id: z.string().describe('Forge scope ID'),
});

export const CreateAgentReminderSchema = z.object({
  agent_id: z.string().describe('Long-horizon agent ID'),
  message: z.string().min(1).describe('Reminder message'),
  remind_at: z.number().int().describe('Reminder timestamp in ms since epoch'),
});

export const ListAgentRemindersSchema = z.object({
  agent_id: z.string().describe('Long-horizon agent ID'),
  status: z.enum(['active', 'done', 'cancelled']).optional().describe('Reminder status'),
});

export const SubscribeAgentEventSchema = z.object({
  agent_id: z.string().describe('Long-horizon agent ID'),
  topic_pattern: z.string().describe('External event topic glob pattern'),
  label: z.string().optional().describe('Human-readable subscription label'),
});

export const UnsubscribeAgentEventSchema = z.object({
  agent_id: z.string().describe('Long-horizon agent ID'),
  topic_pattern: z.string().describe('External event topic glob pattern'),
  label: z.string().optional().describe('Human-readable subscription label'),
});

export const ListAgentEventSubscriptionsSchema = z.object({
  agent_id: z.string().describe('Long-horizon agent ID'),
});

export const SPACE_AGENT_LIFECYCLE_TOOL_SCHEMAS = {
  list_agents: ListAgentsSchema,
  get_agent: GetAgentSchema,
  create_agent: CreateAgentSchema,
  create_agent_from_template: CreateAgentFromTemplateSchema,
  list_agent_templates: ListAgentTemplatesSchema,
  update_agent: UpdateAgentSchema,
  pause_agent: PauseAgentSchema,
  archive_agent: ArchiveAgentSchema,
  assign_agent_to_goal: AssignAgentToGoalSchema,
  unassign_agent_from_goal: UnassignAgentFromGoalSchema,
  assign_agent_to_forge_scope: AssignAgentToForgeScopeSchema,
  unassign_agent_from_forge_scope: UnassignAgentFromForgeScopeSchema,
  create_agent_reminder: CreateAgentReminderSchema,
  list_agent_reminders: ListAgentRemindersSchema,
  subscribe_agent_event: SubscribeAgentEventSchema,
  unsubscribe_agent_event: UnsubscribeAgentEventSchema,
  list_agent_event_subscriptions: ListAgentEventSubscriptionsSchema,
} as const;

export type SpaceAgentLifecycleToolName = keyof typeof SPACE_AGENT_LIFECYCLE_TOOL_SCHEMAS;

export const GoalStatusSchema = z.enum(['active', 'paused', 'completed', 'archived']);

export const GoalTypeSchema = z.enum(['one_shot', 'measurable', 'recurring']);

export const GoalMetricsSchema = z.record(
  z.string(),
  z.union([z.string(), z.number(), z.boolean(), z.null()])
);

export const GOAL_UPDATE_FIELDS = {
  title: z.string().min(1).optional().describe('New goal title'),
  description: z.string().optional().describe('New goal description'),
  status: GoalStatusSchema.optional().describe('New lifecycle status'),
  type: GoalTypeSchema.optional().describe('Goal type'),
  priority: z.enum(['low', 'normal', 'high', 'urgent']).optional().describe('Goal priority'),
  labels: z.array(z.string()).optional().describe('Labels for future goal tasks'),
  metrics: GoalMetricsSchema.optional().describe('Structured measurement state'),
  summary: z.string().optional().describe('Rolling summary of current goal state'),
  progress: z.number().int().min(0).max(100).optional().describe('Progress percentage 0-100'),
  next_steps: z.array(z.string()).optional().describe('Rolling list of next steps'),
  preferred_workflow_id: z
    .string()
    .nullable()
    .optional()
    .describe('Preferred workflow ID for future goal tasks'),
  auto_trigger_next: z
    .boolean()
    .optional()
    .describe('Queue one follow-up run when trigger is called while another goal task is active'),
  check_in_cron_expression: z
    .string()
    .nullable()
    .optional()
    .describe(
      'Edit the recurring check-in schedule in place. Omit to leave it unchanged. ' +
        'A cron expression (e.g. "0 9 * * 1" or "@hourly") updates the linked schedule ' +
        'cadence (creating one if none) and reschedules the next fire atomically. ' +
        'null removes the schedule. Never creates/detaches tasks or touches pendingNextRun.'
    ),
  check_in_timezone: z
    .string()
    .optional()
    .describe('IANA timezone applied with check_in_cron_expression (e.g. "UTC").'),
  workspace_path: z
    .string()
    .nullable()
    .optional()
    .describe(
      'Registered secondary workspace path to pin this goal to. Omit to leave unchanged, null to unpin back to the space primary workspace.'
    ),
};

export const ListGoalsSchema = z.object({
  status: GoalStatusSchema.optional().describe('Filter by goal status'),
});

export const GetGoalSchema = z.object({
  goal_id: z.string().describe('Goal ID'),
});

export const CreateGoalSchema = z.object({
  title: z.string().min(1).describe('Goal title'),
  description: z.string().optional().describe('Goal description'),
  type: GoalTypeSchema.optional().describe('Goal type'),
  priority: z.enum(['low', 'normal', 'high', 'urgent']).optional().describe('Goal priority'),
  labels: z.array(z.string()).optional().describe('Labels for future goal tasks'),
  metrics: GoalMetricsSchema.optional().describe('Initial structured metric state'),
  summary: z.string().optional().describe('Initial rolling summary'),
  progress: z.number().int().min(0).max(100).optional().describe('Initial progress 0-100'),
  next_steps: z.array(z.string()).optional().describe('Initial next steps'),
  preferred_workflow_id: z
    .string()
    .nullable()
    .optional()
    .describe('Preferred workflow ID for goal tasks'),
  auto_trigger_next: z
    .boolean()
    .optional()
    .describe('Queue one follow-up run when a trigger happens while active task exists'),
  check_in_cron_expression: z
    .string()
    .optional()
    .describe('Cron expression for recurring check-in task creation'),
  check_in_timezone: z.string().optional().describe('IANA timezone for check-ins'),
  trigger_immediately: z.boolean().optional().describe('Create first goal task immediately'),
  owner_agent_id: z
    .string()
    .nullable()
    .optional()
    .describe(
      'Long-horizon agent id to assign as the goal primary owner atomically at creation. Defaults to the calling agent (self-claim) or the coordinator when absent.'
    ),
  workspace_path: z
    .string()
    .nullable()
    .optional()
    .describe(
      'Registered secondary workspace path to pin this goal to. Omit or null for the space primary workspace.'
    ),
});

export const UpdateGoalSchema = z.object({
  goal_id: z.string().describe('Goal ID'),
  ...GOAL_UPDATE_FIELDS,
});

export const PauseGoalSchema = z.object({
  goal_id: z.string().describe('Goal ID'),
});

export const ResumeGoalSchema = z.object({
  goal_id: z.string().describe('Goal ID'),
});

export const TriggerGoalTaskSchema = z.object({
  goal_id: z.string().describe('Goal ID'),
});

export const ListGoalTasksSchema = z.object({
  goal_id: z.string().describe('Goal ID'),
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
    .describe('Filter by linked task status'),
  limit: z.number().int().min(1).max(100).optional().describe('Max tasks to return (default 20)'),
  before: z
    .number()
    .int()
    .optional()
    .describe('Return tasks created before this timestamp (cursor)'),
  before_id: z.string().optional().describe('Cursor id for same-timestamp pagination'),
});

export const ListGoalEventsSchema = z.object({
  goal_id: z.string().describe('Goal ID'),
  limit: z.number().int().min(1).max(100).optional().describe('Max events to return'),
  before: z.number().int().optional().describe('Return events before this timestamp'),
  before_id: z.string().optional().describe('Cursor event ID for same-timestamp pagination'),
});

export const SPACE_GOAL_TOOL_SCHEMAS = {
  list_goals: ListGoalsSchema,
  get_goal: GetGoalSchema,
  create_goal: CreateGoalSchema,
  update_goal: UpdateGoalSchema,
  pause_goal: PauseGoalSchema,
  resume_goal: ResumeGoalSchema,
  trigger_goal_task: TriggerGoalTaskSchema,
  list_goal_tasks: ListGoalTasksSchema,
  list_goal_events: ListGoalEventsSchema,
} as const;

export type SpaceGoalToolName = keyof typeof SPACE_GOAL_TOOL_SCHEMAS;

export const ForgeScopeKindSchema = z.enum([
  'mission',
  'project',
  'campaign',
  'workflow',
  'custom',
]);

export const ForgePolicySchema = z.record(z.string(), z.unknown());

export const ForgeMetricDefinitionSchema = z.object({
  key: z.string().min(1).describe('Stable metric key'),
  label: z.string().min(1).describe('Human-readable metric label'),
  description: z.string().optional().describe('What this metric measures'),
  direction: z.enum(['increase', 'decrease', 'target', 'maintain']),
  targetValue: z.union([z.string(), z.number(), z.boolean(), z.null()]).optional(),
  unit: z.string().optional(),
});

export const ForgeMetricValuesSchema = z.record(
  z.string(),
  z.union([z.string(), z.number(), z.boolean(), z.null()])
);

export const ForgeMetadataSchema = z.record(z.string(), z.unknown());

export const ForgeEpisodeStatusSchema = z.enum(['draft', 'accepted', 'dismissed']);

export const ForgeLessonStatusSchema = z.enum(['candidate', 'active', 'dismissed']);

export const ForgeProposalUpdateStatusSchema = z.enum(['proposed', 'accepted', 'dismissed']);

export const ForgeProposalStatusSchema = z.enum(['proposed', 'accepted', 'dismissed', 'created']);

export const ForgePrioritySchema = z.enum(['low', 'normal', 'high', 'urgent']);

export const CreateForgeScopeSchema = z.object({
  goal_id: z.string().nullable().optional().describe('Optional linked SpaceGoal ID'),
  kind: ForgeScopeKindSchema.describe('Scope kind'),
  name: z.string().min(1).describe('Scope name'),
  objective: z.string().min(1).describe('Scope objective'),
  parent_scope_id: z.string().nullable().optional().describe('Optional parent scope ID'),
  metric_definitions: z
    .array(ForgeMetricDefinitionSchema)
    .optional()
    .describe('Metric definitions tracked by this scope'),
  policy: ForgePolicySchema.optional().describe('Scope policy JSON for judge guidance'),
});

export const CreateForgeScopeFromGoalSchema = z.object({
  goal_id: z.string().describe('SpaceGoal ID in this space'),
  name: z.string().optional().describe('Override scope name'),
  objective: z.string().optional().describe('Override scope objective'),
  metric_definitions: z.array(ForgeMetricDefinitionSchema).optional(),
  policy: ForgePolicySchema.optional(),
});

export const ListForgeScopesSchema = z.object({
  goal_id: z
    .string()
    .nullable()
    .optional()
    .describe('Filter by linked goal ID; null means unlinked scopes'),
  kind: ForgeScopeKindSchema.optional().describe('Filter by scope kind'),
});

export const GetForgeScopeSchema = z.object({
  scope_id: z.string().describe('EvolutionScope ID'),
});

export const UpdateForgeScopeSchema = z.object({
  scope_id: z.string().describe('EvolutionScope ID'),
  goal_id: z.string().nullable().optional().describe('Linked SpaceGoal ID; null unlinks'),
  kind: ForgeScopeKindSchema.optional(),
  name: z.string().min(1).optional(),
  objective: z.string().min(1).optional(),
  parent_scope_id: z.string().nullable().optional(),
  metric_definitions: z.array(ForgeMetricDefinitionSchema).optional(),
  policy: ForgePolicySchema.optional().describe(
    'Full policy JSON replacement. Ignored when policy_patch (or ' +
      'episode_judge_*) is also supplied — policy_patch takes precedence.'
  ),
  policy_patch: ForgePolicySchema.optional().describe(
    'Partial policy to deep-merge onto the existing policy ' +
      '(automation.* is nested-merged; null values clear a key). Takes ' +
      'precedence over a full `policy`. Matches the UI.'
  ),
  episode_judge_model: z
    .string()
    .nullable()
    .optional()
    .describe('Set policy.episodeJudgeModel (folded into policy_patch)'),
  episode_judge_provider: z
    .string()
    .nullable()
    .optional()
    .describe('Set policy.episodeJudgeProvider (folded into policy_patch)'),
});

export const GetForgeTimelineSchema = z.object({
  scope_id: z.string().describe('EvolutionScope ID'),
});

export const AddForgeManualNoteSchema = z.object({
  scope_id: z.string().describe('EvolutionScope ID'),
  summary: z.string().min(1).describe('Evidence note text'),
  metadata: ForgeMetadataSchema.optional(),
  created_at: z.number().int().optional().describe('Optional timestamp ms'),
});

export const AttachForgeTaskEvidenceSchema = z.object({
  task_id: z.string().describe('SpaceTask ID'),
  scope_id: z.string().optional().describe('Optional explicit EvolutionScope ID'),
  summary: z.string().optional(),
  metadata: ForgeMetadataSchema.optional(),
});

export const AttachForgeWorkflowRunEvidenceSchema = z.object({
  workflow_run_id: z.string().describe('Workflow run ID'),
  scope_id: z.string().optional().describe('Optional explicit EvolutionScope ID'),
  summary: z.string().optional(),
  metadata: ForgeMetadataSchema.optional(),
});

export const AddForgeMetricSnapshotSchema = z.object({
  scope_id: z.string().describe('EvolutionScope ID'),
  values: ForgeMetricValuesSchema.describe('Metric values keyed by metric name'),
  source: z.string().min(1).describe('Source label, e.g. manual, CI, analytics'),
  note: z.string().nullable().optional(),
  captured_at: z.number().int().optional().describe('Optional timestamp ms'),
  summary: z.string().optional().describe('Optional evidence summary'),
  metadata: ForgeMetadataSchema.optional(),
});

export const ListForgeEvidenceSchema = z.object({
  scope_id: z.string().describe('EvolutionScope ID'),
});

export const ListForgeMetricSnapshotsSchema = z.object({
  scope_id: z.string().describe('EvolutionScope ID'),
});

export const CreateForgeEpisodeSchema = z.object({
  scope_id: z.string().describe('EvolutionScope ID'),
  evidence_ids: z.array(z.string()).min(1).describe('Evidence IDs from this scope'),
  time_window: z.object({ start: z.number().int(), end: z.number().int() }).nullable().optional(),
  confirm_low_confidence: z
    .boolean()
    .optional()
    .describe('Allow low-confidence generation when preflight warns evidence is thin'),
});

export const ListForgeReviewBundleSchema = z.object({
  scope_id: z.string().describe('EvolutionScope ID'),
});

export const ListForgeLessonsSchema = z.object({
  scope_id: z.string().describe('EvolutionScope ID'),
  status: ForgeLessonStatusSchema.optional(),
});

export const ListForgeProposalsSchema = z.object({
  scope_id: z.string().describe('EvolutionScope ID'),
  status: ForgeProposalStatusSchema.optional(),
});

export const ResolveForgeScopeSchema = z.object({
  goal_id: z.string().optional(),
  task_id: z.string().optional(),
});

export const UpdateForgeEpisodeSchema = z.object({
  episode_id: z.string().describe('EvolutionEpisode ID'),
  status: ForgeEpisodeStatusSchema.optional(),
  title: z.string().min(1).optional(),
  outcome_summary: z.string().optional(),
});

export const UpdateForgeLessonSchema = z.object({
  lesson_id: z.string().describe('EvolutionLesson ID'),
  status: ForgeLessonStatusSchema.optional(),
  applies_to: z.array(z.string()).optional(),
  rule: z.string().min(1).optional(),
  why: z.string().optional(),
  confidence: z.number().min(0).max(1).optional(),
});

export const CreateForgeTaskProposalSchema = z.object({
  scope_id: z.string().describe('EvolutionScope ID'),
  title: z.string().min(1),
  description: z.string(),
  reason: z.string(),
  priority: ForgePrioritySchema.optional(),
  evidence_episode_ids: z.array(z.string()).optional(),
});

export const UpdateForgeTaskProposalSchema = z.object({
  proposal_id: z.string().describe('TaskProposal ID'),
  title: z.string().min(1).optional(),
  description: z.string().optional(),
  reason: z.string().optional(),
  priority: ForgePrioritySchema.optional(),
  status: ForgeProposalUpdateStatusSchema.optional(),
});

export const CreateTaskFromForgeProposalSchema = z.object({
  proposal_id: z.string().describe('TaskProposal ID'),
  title: z.string().optional().describe('Optional edited task title'),
  description: z.string().optional().describe('Optional edited task description'),
  reason: z.string().optional().describe('Optional edited proposal reason'),
  priority: ForgePrioritySchema.optional(),
  depends_on: z
    .array(z.string())
    .optional()
    .describe(
      'List of task IDs this task depends on. All must be in the same space. Dependencies are persisted during task creation so the runtime cannot launch the task before they are attached.'
    ),
});

export const ApplyForgeRollupSchema = z.object({
  episode_id: z.string().describe('EvolutionEpisode ID'),
  goal_update: z.object({
    summary: z.string().optional(),
    progress: z.number().int().min(0).max(100).optional(),
    next_steps: z.array(z.string()).optional(),
    metrics: GoalMetricsSchema.optional(),
  }),
});

export const ReviewGoalOutcomeSchema = z.object({
  goal_id: z
    .string()
    .optional()
    .describe('Goal ID the outcome belongs to (required for a disposition)'),
  task_id: z
    .string()
    .optional()
    .describe('Completed task ID the outcome belongs to (required for a disposition)'),
  notification_id: z
    .string()
    .optional()
    .describe('Pending notification identity; omit to discover owned pending notifications'),
  disposition: z
    .enum(['acknowledge', 'reject', 'supersede'])
    .optional()
    .describe('Terminal disposition'),
  observed_goal_revision: z
    .number()
    .int()
    .optional()
    .nullable()
    .describe('Goal revision observed by the caller; set when resubmitting after a stale denial'),
  summary: z.string().optional().describe('Replace the goal rolling summary'),
  next_steps: z.array(z.string()).optional().describe('Replace the goal next steps'),
  metrics: GoalMetricsSchema.optional().describe('Replace the given goal metric values'),
  observations: z
    .array(
      z.object({
        key: z.string().describe('Metric key'),
        value: z.number().describe('Delta added to the current metric value'),
      })
    )
    .optional()
    .describe('Accumulate metric observations as numeric deltas'),
  progress: z
    .number()
    .int()
    .min(0)
    .max(100)
    .optional()
    .describe('Set goal progress 0-100 (rejected for recurring goals)'),
});

export const SPACE_FORGE_TOOL_SCHEMAS = {
  create_forge_scope: CreateForgeScopeSchema,
  create_forge_scope_from_goal: CreateForgeScopeFromGoalSchema,
  list_forge_scopes: ListForgeScopesSchema,
  get_forge_scope: GetForgeScopeSchema,
  update_forge_scope: UpdateForgeScopeSchema,
  get_forge_timeline: GetForgeTimelineSchema,
  add_forge_manual_note: AddForgeManualNoteSchema,
  attach_forge_task_evidence: AttachForgeTaskEvidenceSchema,
  attach_forge_workflow_run_evidence: AttachForgeWorkflowRunEvidenceSchema,
  add_forge_metric_snapshot: AddForgeMetricSnapshotSchema,
  list_forge_evidence: ListForgeEvidenceSchema,
  list_forge_metric_snapshots: ListForgeMetricSnapshotsSchema,
  create_forge_episode: CreateForgeEpisodeSchema,
  list_forge_review_bundle: ListForgeReviewBundleSchema,
  list_forge_lessons: ListForgeLessonsSchema,
  list_forge_proposals: ListForgeProposalsSchema,
  resolve_forge_scope: ResolveForgeScopeSchema,
  update_forge_episode: UpdateForgeEpisodeSchema,
  update_forge_lesson: UpdateForgeLessonSchema,
  create_forge_task_proposal: CreateForgeTaskProposalSchema,
  update_forge_task_proposal: UpdateForgeTaskProposalSchema,
  create_task_from_forge_proposal: CreateTaskFromForgeProposalSchema,
  apply_forge_rollup: ApplyForgeRollupSchema,
} as const;

export type SpaceForgeToolName = keyof typeof SPACE_FORGE_TOOL_SCHEMAS;

export const TaskScheduleStatusSchema = z.enum(['active', 'paused', 'completed']);

export const TaskScheduleTriggerTypeSchema = z.enum(['cron', 'at']);

export const CreateScheduledTaskSchema = z.object({
  title: z.string().describe('Short title for the task template'),
  description: z.string().describe('Detailed description for the task template'),
  priority: z
    .enum(['low', 'normal', 'high', 'urgent'])
    .optional()
    .describe('Task priority (default: normal)'),
  workflow_id: z.string().optional().describe('Preferred workflow ID to attach to created tasks'),
  labels: z.array(z.string()).optional().describe('Labels to apply to created tasks'),
  trigger_type: TaskScheduleTriggerTypeSchema.describe(
    'Trigger type: "cron" for recurring, "at" for one-shot'
  ),
  cron_expression: z
    .string()
    .optional()
    .describe(
      'Cron expression (e.g. "0 9 * * 1" for every Monday at 9am, "@daily", "@hourly"). Required when trigger_type is "cron".'
    ),
  run_at: z
    .number()
    .optional()
    .describe(
      'Unix timestamp in ms when the task should fire. Required when trigger_type is "at".'
    ),
  timezone: z
    .string()
    .optional()
    .describe('IANA timezone string (default: "UTC"). Example: "America/New_York"'),
});

export const ListScheduledTasksSchema = z.object({
  status: TaskScheduleStatusSchema.optional().describe('Filter by schedule status (default: all)'),
});

export const GetScheduledTaskSchema = z.object({
  schedule_id: z.string().describe('ID of the scheduled task to retrieve'),
});

export const PauseScheduledTaskSchema = z.object({
  schedule_id: z.string().describe('ID of the scheduled task to pause'),
});

export const ResumeScheduledTaskSchema = z.object({
  schedule_id: z.string().describe('ID of the scheduled task to resume'),
});

export const DeleteScheduledTaskSchema = z.object({
  schedule_id: z.string().describe('ID of the scheduled task to delete'),
});

export const SCHEDULED_TOOL_SCHEMAS = {
  create_scheduled_task: CreateScheduledTaskSchema,
  list_scheduled_tasks: ListScheduledTasksSchema,
  get_scheduled_task: GetScheduledTaskSchema,
  pause_scheduled_task: PauseScheduledTaskSchema,
  resume_scheduled_task: ResumeScheduledTaskSchema,
  delete_scheduled_task: DeleteScheduledTaskSchema,
} as const;

export type ScheduledToolName = keyof typeof SCHEDULED_TOOL_SCHEMAS;

export const GetExternalEventSchema = z.object({
  eventId: z.string().min(1).describe('The id of the external event to fetch'),
});

export const EXTERNAL_EVENT_TOOL_SCHEMAS = {
  subscribe_agent_event: SubscribeAgentEventSchema,
  unsubscribe_agent_event: UnsubscribeAgentEventSchema,
  list_agent_event_subscriptions: ListAgentEventSubscriptionsSchema,
  get_external_event: GetExternalEventSchema,
} as const;

export type ExternalEventToolName = keyof typeof EXTERNAL_EVENT_TOOL_SCHEMAS;

export const InactivityConfigGetSchema = z.object({});

export const InactivityConfigSetEnabledSchema = z.object({
  enabled: z.boolean().describe('true to enable or resume, false to pause'),
});

export const InactivityConfigSetSchema = z.object({
  threshold_ms: z
    .number()
    .int()
    .positive()
    .optional()
    .describe('Idle time in milliseconds before the agent is nagged'),
  prompt: z.string().optional().describe('Custom nag prompt; pass an empty string to clear'),
});

export const InactivityRunNowSchema = z.object({});

export const INACTIVITY_TOOL_SCHEMAS = {
  inactivity_config_get: InactivityConfigGetSchema,
  inactivity_config_set_enabled: InactivityConfigSetEnabledSchema,
  inactivity_config_set: InactivityConfigSetSchema,
  inactivity_run_now: InactivityRunNowSchema,
} as const;

export type InactivityToolName = keyof typeof INACTIVITY_TOOL_SCHEMAS;
