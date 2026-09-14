import type { SdkMcpToolDefinition } from '@anthropic-ai/claude-agent-sdk';
import { createSdkMcpServer, tool } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';
import {
  AddForgeManualNoteSchema,
  AddForgeMetricSnapshotSchema,
  ApplyForgeRollupSchema,
  ApprovePendingCompletionSchema,
  ApproveTaskSchema,
  ArchiveAgentSchema,
  ArchiveTaskSchema,
  AssignAgentToForgeScopeSchema,
  AssignAgentToGoalSchema,
  AttachForgeTaskEvidenceSchema,
  AttachForgeWorkflowRunEvidenceSchema,
  CancelTaskSchema,
  ChangePlanSchema,
  CreateAgentFromTemplateSchema,
  CreateAgentReminderSchema,
  CreateAgentSchema,
  CreateAgentTemplateSchema,
  CreateForgeEpisodeSchema,
  CreateForgeScopeFromGoalSchema,
  CreateForgeScopeSchema,
  CreateForgeTaskProposalSchema,
  CreateGoalSchema,
  CreateScheduledTaskSchema,
  CreateStandaloneTaskSchema,
  CreateTaskFromForgeProposalSchema,
  DeleteAgentTemplateSchema,
  DeleteScheduledTaskSchema,
  GetAgentSchema,
  GetExternalEventSchema,
  GetForgeScopeSchema,
  GetForgeTimelineSchema,
  GetGoalSchema,
  GetScheduledTaskSchema,
  GetSessionDetailSchema,
  GetSessionMessagesSchema,
  GetTaskDetailSchema,
  GetWorkflowDetailSchema,
  GetWorkflowRunSchema,
  GoalMetricsSchema,
  InactivityConfigGetSchema,
  InactivityConfigSetEnabledSchema,
  InactivityConfigSetSchema,
  InactivityRunNowSchema,
  InterruptSessionSchema,
  ListAgentEventSubscriptionsSchema,
  ListAgentRemindersSchema,
  ListAgentsSchema,
  ListAgentTemplatesSchema,
  ListForgeEvidenceSchema,
  ListForgeLessonsSchema,
  ListForgeMetricSnapshotsSchema,
  ListForgeProposalsSchema,
  ListForgeReviewBundleSchema,
  ListForgeScopesSchema,
  ListGoalEventsSchema,
  ListGoalsSchema,
  ListGoalTasksSchema,
  ListScheduledTasksSchema,
  ListSessionsSchema,
  ListTaskMembersSchema,
  ListTasksSchema,
  ListWorkflowsSchema,
  PauseAgentSchema,
  PauseGoalSchema,
  PauseScheduledTaskSchema,
  PublishTaskSchema,
  ReassignTaskSchema,
  ResolveForgeScopeSchema,
  ResumeGoalSchema,
  ResumeScheduledTaskSchema,
  RetryTaskSchema,
  SendMessageToTaskSchema,
  SendSessionMessageSchema,
  SubscribeAgentEventSchema,
  SuggestWorkflowSchema,
  TriggerGoalTaskSchema,
  UnassignAgentFromForgeScopeSchema,
  UnassignAgentFromGoalSchema,
  UnsubscribeAgentEventSchema,
  UpdateAgentSchema,
  UpdateAgentTemplateSchema,
  UpdateForgeEpisodeSchema,
  UpdateForgeLessonSchema,
  UpdateForgeScopeSchema,
  UpdateForgeTaskProposalSchema,
  UpdateGoalSchema,
  UpdateSessionStateSchema,
  UpdateTaskSchema,
} from '../actions/space-agent-schemas.ts';
import {
  createSpaceAgentToolHandlers,
  DEFAULT_INACTIVITY_THRESHOLD_MS,
  type SpaceAgentToolsConfig,
  validateTemplateReminder,
} from '../actions/space-handlers.ts';
import { hasSpaceAuthority } from '../runtime/space-mcp-session-policy.ts';
import { instrumentTypedTelemetryAtMcpBoundary } from './mcp-typed-telemetry-boundary.ts';

export type { SpaceAgentToolsConfig };
export { createSpaceAgentToolHandlers, DEFAULT_INACTIVITY_THRESHOLD_MS, validateTemplateReminder };

export function createSpaceAgentMcpServer(config: SpaceAgentToolsConfig) {
  const handlers = createSpaceAgentToolHandlers(config);
  // oxlint-disable-next-line typescript/no-explicit-any -- SDK tool list is heterogeneous by schema.
  const tools: SdkMcpToolDefinition<any>[] = [
    tool(
      'list_sessions',
      'List all ad-hoc and worker sessions in this Space. Filter by derived status or type, with limit/offset pagination.',
      ListSessionsSchema.shape,
      (args) => handlers.list_sessions(args)
    ),
    tool(
      'get_session_detail',
      'Inspect one Space session including parsed processing_state and last 5 messages.',
      GetSessionDetailSchema.shape,
      (args) => handlers.get_session_detail(args)
    ),
    tool(
      'get_session_messages',
      'Retrieve conversation messages for one Space session with summaries and optional timestamp cursor.',
      GetSessionMessagesSchema.shape,
      (args) => handlers.get_session_messages(args)
    ),
    tool(
      'send_session_message',
      'Send a user message to an ad-hoc Space session. Use answer_question:true to clear a waiting_for_input pending question.',
      SendSessionMessageSchema.shape,
      (args) => handlers.send_session_message(args)
    ),
    tool(
      'update_session_state',
      'Mutate a Space session processing state to recover stuck sessions. Requires sufficient Space autonomy.',
      UpdateSessionStateSchema.shape,
      (args) => handlers.update_session_state(args)
    ),
    tool(
      'interrupt_session',
      'Force-interrupt a running or stuck Space session, append interrupt transcript entries, and reset state to idle. Requires sufficient Space autonomy.',
      InterruptSessionSchema.shape,
      (args) => handlers.interrupt_session(args)
    ),
    tool(
      'list_workflows',
      'Show all workflows in this space with their descriptions and steps. Call this first to understand available options before creating a task.',
      ListWorkflowsSchema.shape,
      () => handlers.list_workflows()
    ),
    tool(
      'get_workflow_run',
      'Check the current status of a workflow run, including the current step and associated tasks.',
      GetWorkflowRunSchema.shape,
      (args) => handlers.get_workflow_run(args)
    ),
    tool(
      'change_plan',
      'Update the task description for an ongoing run, or switch to a different workflow mid-run (cancels the current run and starts a new one).',
      ChangePlanSchema.shape,
      (args) => handlers.change_plan(args)
    ),
    tool(
      'get_workflow_detail',
      'Get the full definition of a specific workflow, including all steps, transitions, and rules. Use this to inspect a candidate workflow before creating a task.',
      GetWorkflowDetailSchema.shape,
      (args) => handlers.get_workflow_detail(args)
    ),
    tool(
      'suggest_workflow',
      'List all workflows available in this space so you can pick the best one for a described piece of work. Returns every workflow in creation order with its id, handle (human-readable slug usable as workflow_handle in create_standalone_task), name, description, tags, and nodes — no pre-ranking, so your own reasoning is not biased by keyword overlap.',
      SuggestWorkflowSchema.shape,
      (args) => handlers.suggest_workflow(args)
    ),
    tool(
      'list_tasks',
      'List SpaceTasks for this space. Filterable by status and workflow run. Use compact:true and limit/offset to reduce payload size.',
      ListTasksSchema.shape,
      (args) => handlers.list_tasks(args)
    ),
    tool(
      'create_standalone_task',
      'Create a task request. Runtime may attach and execute a workflow for this task during orchestration. Supports structured task dependencies via depends_on — the task will be blocked until every listed dependency reaches status=done, and cascade-cancelled if a dependency is cancelled.',
      CreateStandaloneTaskSchema.shape,
      (args) => handlers.create_standalone_task(args)
    ),
    tool(
      'get_task_detail',
      'Retrieve detailed information about a specific task including its status, result, and metadata.',
      GetTaskDetailSchema.shape,
      (args) => handlers.get_task_detail(args)
    ),
    tool(
      'update_task',
      "Edit an existing task's title, description, priority, dependencies, or status. The task must belong to this space. Only the fields you provide are updated. Status changes follow the same transition table as the UI, with the same restrictions: invalid transitions are rejected with the allowed list, 'review' and 'approved' cannot be set here, review→done is owned by the approval pipeline, and archiving a task on an active workflow run is rejected.",
      UpdateTaskSchema.shape,
      (args) => handlers.update_task(args)
    ),
    tool(
      'retry_task',
      'Retry a failed or cancelled task. Optionally update the task description for the retry attempt.',
      RetryTaskSchema.shape,
      (args) => handlers.retry_task(args)
    ),
    tool(
      'cancel_task',
      'Cancel a task. Automatically cascades cancellation to pending dependent tasks. Optionally also cancel the associated workflow run.',
      CancelTaskSchema.shape,
      (args) => handlers.cancel_task(args)
    ),
    tool(
      'reassign_task',
      'Change the agent assignment for a task. Only allowed for tasks in open, blocked, or cancelled status.',
      ReassignTaskSchema.shape,
      (args) => handlers.reassign_task(args)
    ),
    tool(
      'publish_task',
      'Publish a draft task, transitioning it from draft to open status. Published tasks become eligible for orchestration by the runtime tick loop. Only valid for tasks in draft status.',
      PublishTaskSchema.shape,
      (args) => handlers.publish_task(args)
    ),
    tool(
      'archive_task',
      "Archive a task. Archived tasks are excluded from most queries and cannot be reactivated — this is the true terminal state. Valid from any status that allows the 'archived' transition (e.g. draft, done, cancelled, blocked, review, approved).",
      ArchiveTaskSchema.shape,
      (args) => handlers.archive_task(args)
    ),

    tool(
      'send_message_to_task',
      'Send a message to a specific workflow node agent or long-term Space agent on a task. Use node_id for workflow nodes, or target for @handle/@role/@session/@worker addresses. Inactive workflow nodes or long-term agents are activated/queued when supported. Provide either task_id or task_number — if both are given, task_id takes precedence.',
      SendMessageToTaskSchema.shape,
      (args) => handlers.send_message_to_task(args)
    ),
    tool(
      'list_task_members',
      "List all node executions (workflow member agents) for a task. Returns each node's status, result, and saved data. Use this to inspect the detailed execution state of a running or completed workflow task.",
      ListTaskMembersSchema.shape,
      (args) => handlers.list_task_members(args)
    ),
    tool(
      'approve_task',
      "Approve a task in 'review' status, transitioning it to 'done'. Use this after reviewing a completed task's output to mark it as approved.",
      ApproveTaskSchema.shape,
      (args) => handlers.approve_task(args)
    ),
    tool(
      'approve_pending_completion',
      "Approve or reject a task paused at a submit_for_approval checkpoint (the human-approval path). This is a Space agent session's programmatic equivalent of the UI 'Approve' banner: approved transitions review → approved and fires the post-approval router; rejected resumes an existing active worker in in_progress, or queues a fresh direct worker with the task open until execution is ready. Long-horizon agent and legacy task-agent sessions only — worker node agents use approve_task to self-close.",
      ApprovePendingCompletionSchema.shape,
      (args) => handlers.approve_pending_completion(args)
    ),
  ];

  if (config.db) {
    tools.unshift(
      tool(
        'list_agents',
        'List long-horizon Space agents in this space.',
        ListAgentsSchema.shape,
        (args) => handlers.list_agents(args)
      ),
      tool('get_agent', 'Get one long-horizon Space agent by ID.', GetAgentSchema.shape, (args) =>
        handlers.get_agent(args)
      ),
      tool(
        'create_agent',
        'Create a long-horizon Space agent. Tool-permission changes are validated against the known tool allowlist.',
        CreateAgentSchema.shape,
        (args) => handlers.create_agent(args)
      ),
      tool(
        'create_agent_from_template',
        'Create a long-horizon Space agent from a template key. Resolution order: exact built-in key (worker.research, worker.qa, ...), then exact user-created template key stored in this space, then case-insensitive built-in match. Templates carrying suggested event subscriptions and reminders seed them on create. Call list_agent_templates to discover available templates.',
        CreateAgentFromTemplateSchema.shape,
        (args) => handlers.create_agent_from_template(args)
      ),
      tool(
        'create_agent_template',
        'Create a reusable agent template in this Space: handle, prompt, model/provider/model_pool/thinking_level/setting_sources, tool allowlist, labels, and a suggested autonomy level. Pass from_agent_id to derive defaults from an existing long-horizon agent in this space; caller-supplied fields override the derived ones.',
        CreateAgentTemplateSchema.shape,
        (args) => handlers.create_agent_template(args)
      ),
      tool(
        'update_agent_template',
        'Update a user-authored agent template in this Space by key: display_name, description, instructions, labels, model/provider/model_pool/thinking_level/setting_sources, and tools. Omitted fields stay unchanged; null clears a field to inherit defaults. Pass expected_version (from a prior create/update result) to fail on concurrent modification — the returned template carries its new version. Built-in templates are defined in code and cannot be updated.',
        UpdateAgentTemplateSchema.shape,
        (args) => handlers.update_agent_template(args)
      ),
      tool(
        'list_agent_templates',
        'List the agent templates available in this space: built-in templates (worker.research, worker.qa, ...) plus user-authored templates. Each entry carries a labels array and a builtin flag.',
        ListAgentTemplatesSchema.shape,
        () => handlers.list_agent_templates()
      ),

      tool(
        'delete_agent_template',
        'Delete a user-authored agent template by key. Optional expected_version enables compare-and-swap (create/update results and list_agent_templates report the current version); the delete fails when the template changed since, and the error reports the current version. Built-in templates cannot be deleted. Workflow references do not block deletion. A run that pinned a template snapshot at creation resolves from that copy and is unaffected; a run without one may fail to activate a later node. Saved workflows still naming the key keep starting runs that cannot activate that slot, so replace those references before deleting.',
        DeleteAgentTemplateSchema.shape,
        (args) => handlers.delete_agent_template(args)
      ),
      tool(
        'update_agent',
        'Update a long-horizon Space agent. Autonomy/tool-permission escalation is limited by manager validation and audited.',
        UpdateAgentSchema.shape,
        (args) => handlers.update_agent(args)
      ),
      tool(
        'pause_agent',
        'Pause a long-horizon Space agent without deleting it.',
        PauseAgentSchema.shape,
        (args) => handlers.pause_agent(args)
      ),
      tool(
        'archive_agent',
        'Archive a long-horizon Space agent.',
        ArchiveAgentSchema.shape,
        (args) => handlers.archive_agent(args)
      ),
      tool(
        'assign_agent_to_goal',
        'Assign a long-horizon Space agent to a goal.',
        AssignAgentToGoalSchema.shape,
        (args) => handlers.assign_agent_to_goal(args)
      ),
      tool(
        'unassign_agent_from_goal',
        'Remove a long-horizon Space agent goal assignment.',
        UnassignAgentFromGoalSchema.shape,
        (args) => handlers.unassign_agent_from_goal(args)
      ),
      tool(
        'assign_agent_to_forge_scope',
        'Assign a long-horizon Space agent to a Forge scope.',
        AssignAgentToForgeScopeSchema.shape,
        (args) => handlers.assign_agent_to_forge_scope(args)
      ),
      tool(
        'unassign_agent_from_forge_scope',
        'Remove a long-horizon Space agent Forge scope assignment.',
        UnassignAgentFromForgeScopeSchema.shape,
        (args) => handlers.unassign_agent_from_forge_scope(args)
      ),
      tool(
        'create_agent_reminder',
        'Create a reminder for a long-horizon Space agent.',
        CreateAgentReminderSchema.shape,
        (args) => handlers.create_agent_reminder(args)
      ),
      tool(
        'list_agent_reminders',
        'List reminders for a long-horizon Space agent.',
        ListAgentRemindersSchema.shape,
        (args) => handlers.list_agent_reminders(args)
      ),
      tool(
        'subscribe_agent_event',
        'Record an external-event subscription for a long-horizon Space agent.',
        SubscribeAgentEventSchema.shape,
        (args) => handlers.subscribe_agent_event(args)
      ),
      tool(
        'unsubscribe_agent_event',
        'Remove an external-event subscription from a long-horizon Space agent.',
        UnsubscribeAgentEventSchema.shape,
        (args) => handlers.unsubscribe_agent_event(args)
      ),
      tool(
        'list_agent_event_subscriptions',
        'List external-event subscriptions for a long-horizon Space agent.',
        ListAgentEventSubscriptionsSchema.shape,
        (args) => handlers.list_agent_event_subscriptions(args)
      )
    );
  }

  if (config.externalEventStore) {
    tools.push(
      tool(
        'get_external_event',
        'Fetch the full raw record for a single external event by id — the on-demand deep-dive counterpart to ' +
          'the lean event summary injected into a session as a message. Use this for the rare case where the summary ' +
          'is not enough and you need the complete payload (incl. `rawPayload`, `body`, `actor`, `eventType`, ' +
          'source-native fields such as review `state`, check-run `conclusion`, diff `path`/`line`, etc.). ' +
          'Returns a not-found result for unknown ids.',
        GetExternalEventSchema.shape,
        (args) => handlers.get_external_event(args)
      )
    );
  }

  if (config.goalService) {
    tools.push(
      tool(
        'list_goals',
        'List long-horizon goals in this space. Use this before changing goal progress or creating goal tasks.',
        ListGoalsSchema.shape,
        (args) => handlers.list_goals(args)
      ),
      tool(
        'get_goal',
        'Get one goal with rolling state, active task pointers, next check-in, metrics, and next steps.',
        GetGoalSchema.shape,
        (args) => handlers.get_goal(args)
      ),
      tool(
        'create_goal',
        'Create a long-horizon goal in this space. Optionally schedule recurring check-ins or trigger the first task immediately.',
        CreateGoalSchema.shape,
        (args) => handlers.create_goal(args)
      ),
      tool(
        'update_goal',
        'Update public goal fields and rolling state. Use summary/progress/metrics/next_steps to keep long-horizon state current. check_in_cron_expression/check_in_timezone edit a recurring goal check-in schedule in place (set, change cadence/timezone, or null to remove) and take effect immediately — the next fire is rescheduled atomically. Internal fields like activeTaskId and taskScheduleId are not writable.',
        UpdateGoalSchema.shape,
        (args) => handlers.update_goal(args)
      ),
      tool(
        'pause_goal',
        'Pause an active goal and its linked check-in schedule if present.',
        PauseGoalSchema.shape,
        (args) => handlers.pause_goal(args)
      ),
      tool(
        'resume_goal',
        'Resume a paused goal and re-enable its linked check-in schedule if present.',
        ResumeGoalSchema.shape,
        (args) => handlers.resume_goal(args)
      ),
      tool(
        'trigger_goal_task',
        'Create an immediate task for a goal. If another goal task is active and auto_trigger_next is true, queues one follow-up instead of overlapping work.',
        TriggerGoalTaskSchema.shape,
        (args) => handlers.trigger_goal_task(args)
      ),
      tool(
        'list_goal_tasks',
        "List tasks linked to a goal in this space, optionally filtered by status. Returns a bounded page (default 20, max 100) of compact task summaries (id, task_number, title, status, priority, createdAt, updatedAt) ordered by most-recently-created; results omit description and result. Pass the last item's createdAt as `before` and its id as `before_id` to fetch the next page. Use `get_task_detail` to retrieve the full record for any task whose outcome you need to inspect.",
        ListGoalTasksSchema.shape,
        (args) => handlers.list_goal_tasks(args)
      ),
      tool(
        'list_goal_events',
        'List append-only history events for a goal. Use this to understand why the current rolling state changed before updating it.',
        ListGoalEventsSchema.shape,
        (args) => handlers.list_goal_events(args)
      )
    );
  }

  if (config.evolutionScopeService && config.evolutionEpisodeService) {
    tools.push(
      tool(
        'create_forge_scope',
        'Create a Forge EvolutionScope in this space. Use goal_id to link it to a recurring goal; policy can include episodeJudgeModel and other judge guidance.',
        CreateForgeScopeSchema.shape,
        (args) => handlers.create_forge_scope(args)
      ),
      tool(
        'create_forge_scope_from_goal',
        'Create a mission Forge scope linked to an existing SpaceGoal, defaulting name/objective from the goal.',
        CreateForgeScopeFromGoalSchema.shape,
        (args) => handlers.create_forge_scope_from_goal(args)
      ),
      tool(
        'list_forge_scopes',
        'List Forge scopes in this space, optionally filtered by linked goal or kind.',
        ListForgeScopesSchema.shape,
        (args) => handlers.list_forge_scopes(args)
      ),
      tool(
        'get_forge_scope',
        'Get one Forge scope in this space, including linked goal, metric definitions, and policy.',
        GetForgeScopeSchema.shape,
        (args) => handlers.get_forge_scope(args)
      ),
      tool(
        'update_forge_scope',
        'Update a Forge scope. Use goal_id to link/unlink a goal. Prefer policy_patch to deep-merge policy fields (e.g. automation.completedTaskThreshold, episodeJudgeModel, episodeJudgeProvider) without clobbering the rest; policy replaces policy JSON wholesale. episode_judge_model/episode_judge_provider are convenience setters folded into the patch. Changes take effect immediately.',
        UpdateForgeScopeSchema.shape,
        (args) => handlers.update_forge_scope(args)
      ),
      tool(
        'get_forge_timeline',
        'Get scope overview/timeline: scope, evidence, and metric snapshots.',
        GetForgeTimelineSchema.shape,
        (args) => handlers.get_forge_timeline(args)
      ),
      tool(
        'add_forge_manual_note',
        'Attach manual note evidence to a Forge scope.',
        AddForgeManualNoteSchema.shape,
        (args) => handlers.add_forge_manual_note(args)
      ),
      tool(
        'attach_forge_task_evidence',
        'Attach a completed or relevant SpaceTask as Forge evidence. If scope_id omitted, resolves from task.evolutionScopeId or task.goalId.',
        AttachForgeTaskEvidenceSchema.shape,
        (args) => handlers.attach_forge_task_evidence(args)
      ),
      tool(
        'attach_forge_workflow_run_evidence',
        'Attach a workflow run as Forge evidence. If scope_id omitted, resolves via first task in the run.',
        AttachForgeWorkflowRunEvidenceSchema.shape,
        (args) => handlers.attach_forge_workflow_run_evidence(args)
      ),
      tool(
        'add_forge_metric_snapshot',
        'Add metric snapshot evidence to a Forge scope.',
        AddForgeMetricSnapshotSchema.shape,
        (args) => handlers.add_forge_metric_snapshot(args)
      ),
      tool(
        'list_forge_evidence',
        'List evidence refs for a Forge scope.',
        ListForgeEvidenceSchema.shape,
        (args) => handlers.list_forge_evidence(args)
      ),
      tool(
        'list_forge_metric_snapshots',
        'List metric snapshots for a Forge scope.',
        ListForgeMetricSnapshotsSchema.shape,
        (args) => handlers.list_forge_metric_snapshots(args)
      ),
      tool(
        'create_forge_episode',
        'Generate a draft Forge episode from selected evidence. Calls the episode judge; LLM/model/auth errors are surfaced clearly.',
        CreateForgeEpisodeSchema.shape,
        (args) => handlers.create_forge_episode(args)
      ),
      tool(
        'list_forge_review_bundle',
        'List episodes, lessons, and task proposals for reviewing a Forge scope.',
        ListForgeReviewBundleSchema.shape,
        (args) => handlers.list_forge_review_bundle(args)
      ),
      tool(
        'list_forge_lessons',
        'List Forge lessons for a scope, optionally filtered by status.',
        ListForgeLessonsSchema.shape,
        (args) => handlers.list_forge_lessons(args)
      ),
      tool(
        'list_forge_proposals',
        'List Forge task proposals for a scope, optionally filtered by status.',
        ListForgeProposalsSchema.shape,
        (args) => handlers.list_forge_proposals(args)
      ),
      tool(
        'resolve_forge_scope',
        'Resolve a Forge scope from a linked goal_id or task_id when scope_id is unknown.',
        ResolveForgeScopeSchema.shape,
        (args) => handlers.resolve_forge_scope(args)
      ),
      tool(
        'update_forge_episode',
        'Accept, dismiss, or edit a Forge episode draft. Use status accepted/dismissed only after explicit decision.',
        UpdateForgeEpisodeSchema.shape,
        (args) => handlers.update_forge_episode(args)
      ),
      tool(
        'update_forge_lesson',
        'Activate, dismiss, or edit a candidate lesson. Activation requires explicit tool call.',
        UpdateForgeLessonSchema.shape,
        (args) => handlers.update_forge_lesson(args)
      ),
      tool(
        'create_forge_task_proposal',
        'Create a Forge task proposal manually for this scope. Later use create_task_from_forge_proposal to make a real SpaceTask.',
        CreateForgeTaskProposalSchema.shape,
        (args) => handlers.create_forge_task_proposal(args)
      ),
      tool(
        'update_forge_task_proposal',
        'Edit, accept, or dismiss a Forge task proposal. Creating a SpaceTask is separate and explicit.',
        UpdateForgeTaskProposalSchema.shape,
        (args) => handlers.update_forge_task_proposal(args)
      ),
      tool(
        'create_task_from_forge_proposal',
        'Create a real SpaceTask from a Forge proposal, preserving linked goalId and evolutionScopeId. Supports structured dependencies via depends_on so prerequisite checks are attached atomically before runtime pickup. Idempotent when task already exists.',
        CreateTaskFromForgeProposalSchema.shape,
        (args) => handlers.create_task_from_forge_proposal(args)
      ),
      tool(
        'apply_forge_rollup',
        'Accept a Forge episode and roll summary/progress/metrics/next steps into its linked recurring goal.',
        ApplyForgeRollupSchema.shape,
        (args) => handlers.apply_forge_rollup(args)
      )
    );
  }

  if (config.scheduleService) {
    tools.push(
      tool(
        'create_scheduled_task',
        'Create a recurring (cron) or one-shot (at) scheduled task. When it fires, a real SpaceTask is created automatically.',
        CreateScheduledTaskSchema.shape,
        (args) => handlers.create_scheduled_task(args)
      ),
      tool(
        'list_scheduled_tasks',
        'List all scheduled tasks for this space.',
        ListScheduledTasksSchema.shape,
        (args) => handlers.list_scheduled_tasks(args)
      ),
      tool(
        'get_scheduled_task',
        'Get details of a specific scheduled task including last spawned task ID and next run time.',
        GetScheduledTaskSchema.shape,
        (args) => handlers.get_scheduled_task(args)
      ),
      tool(
        'pause_scheduled_task',
        'Pause a schedule — stops creating new tasks until resumed.',
        PauseScheduledTaskSchema.shape,
        (args) => handlers.pause_scheduled_task(args)
      ),
      tool(
        'resume_scheduled_task',
        'Resume a paused schedule, computing the next run time and re-enqueueing the job.',
        ResumeScheduledTaskSchema.shape,
        (args) => handlers.resume_scheduled_task(args)
      ),
      tool(
        'delete_scheduled_task',
        'Permanently delete a scheduled task. Any pending job is cancelled.',
        DeleteScheduledTaskSchema.shape,
        (args) => handlers.delete_scheduled_task(args)
      )
    );
  }

  if (hasSpaceAuthority(config.callerRole)) {
    tools.push(
      tool(
        'review_goal_outcome',
        'Review a terminal goal-outcome notification. Call without notification_id to discover pending notifications for goals you own; call with notification_id, goal_id, task_id and either a disposition (acknowledge, reject, or supersede) to terminalize a pending outcome without goal mutation, or goal-state updates (summary, next_steps, metrics, observations, progress) to acknowledge the outcome while persisting your review to the goal.',
        {
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
            .describe(
              'Pending notification identity; omit to discover owned pending notifications'
            ),
          disposition: z
            .enum(['acknowledge', 'reject', 'supersede'])
            .optional()
            .describe('Terminal disposition'),
          observed_goal_revision: z
            .number()
            .int()
            .optional()
            .nullable()
            .describe(
              'Goal revision observed by the caller; set when resubmitting after a stale denial'
            ),
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
        },
        (args) => handlers.review_goal_outcome(args)
      )
    );
  }

  if (config.onRestoreNodeAgent) {
    const restoreCallback = config.onRestoreNodeAgent;
    tools.push(
      tool(
        'restore_node_agent',
        'Self-heal tool: re-attaches the node-agent MCP server for this session and restarts ' +
          'the query so the new tool surface takes effect. Call this if a previous ' +
          'mcp__node-agent__send_message or similar call returned "No such tool available". ' +
          'The tool restarts your current turn — retry the failed tool call afterwards.',
        {
          reason: z
            .string()
            .optional()
            .describe('Brief explanation of why you are calling this tool'),
        },
        async (args) => {
          try {
            await restoreCallback({ reason: args.reason });
          } catch {}
          return {
            content: [
              {
                type: 'text' as const,
                text: JSON.stringify({
                  success: true,
                  message:
                    'node-agent MCP server re-attached and query restarted. ' +
                    'Your current turn will be interrupted — retry the failed tool call in the next turn.',
                }),
              },
            ],
          };
        }
      )
    );
  }

  if (config.inactivityConfigRepo) {
    tools.push(
      tool(
        'inactivity_config_get',
        "Return this agent's inactivity watchdog configuration: enabled, idle threshold in ms, nag prompt, and config revision.",
        InactivityConfigGetSchema.shape,
        async () => {
          if (!config.myAgentId) {
            throw new Error('No agent identity available for inactivity config');
          }
          const cfg = config.inactivityConfigRepo?.getByAgent(config.spaceId, config.myAgentId);
          const claim = config.inactivityClaimRepo?.getByAgent(config.spaceId, config.myAgentId);
          return {
            content: [
              {
                type: 'text' as const,
                text: JSON.stringify({
                  config: cfg ?? null,
                  degraded: claim?.degraded ?? false,
                }),
              },
            ],
          };
        }
      ),
      tool(
        'inactivity_config_set_enabled',
        'Enable, pause, or resume the inactivity watchdog for this agent. Pausing keeps the threshold and prompt but stops new nags until resumed.',
        InactivityConfigSetEnabledSchema.shape,
        async (args) => {
          if (!config.myAgentId) {
            throw new Error('No agent identity available for inactivity config');
          }
          const cfg = config.inactivityConfigRepo?.setEnabled(
            config.spaceId,
            config.myAgentId,
            args.enabled
          );
          if (args.enabled) {
            config.inactivityClaimRepo?.clearDegraded(config.spaceId, config.myAgentId);
            if (cfg && cfg.thresholdMs === null) {
              config.inactivityConfigRepo?.upsert({
                spaceId: config.spaceId,
                agentId: config.myAgentId,
                thresholdMs: DEFAULT_INACTIVITY_THRESHOLD_MS,
              });
            }
          }
          return {
            content: [
              {
                type: 'text' as const,
                text: JSON.stringify({ ok: true, enabled: cfg?.enabled ?? args.enabled }),
              },
            ],
          };
        }
      ),
      tool(
        'inactivity_config_set',
        'Adjust the inactivity watchdog threshold (ms of idleness before a nag) or the nag prompt for this agent. Changing either bumps the config revision so a pending nag revalidates against the new settings.',
        InactivityConfigSetSchema.shape,
        async (args) => {
          if (!config.myAgentId) {
            throw new Error('No agent identity available for inactivity config');
          }
          config.inactivityConfigRepo?.upsert({
            spaceId: config.spaceId,
            agentId: config.myAgentId,
            thresholdMs: args.threshold_ms,
            prompt: args.prompt,
          });
          return { content: [{ type: 'text' as const, text: JSON.stringify({ ok: true }) }] };
        }
      )
    );
    if (config.inactivityRunNow) {
      tools.push(
        tool(
          'inactivity_run_now',
          'Run the inactivity watchdog scan for this agent immediately, through the same admission gates as the periodic scan.',
          InactivityRunNowSchema.shape,
          async () => {
            if (!config.myAgentId) {
              throw new Error('No agent identity available for inactivity config');
            }
            await config.inactivityRunNow?.(config.spaceId, config.myAgentId);
            return { content: [{ type: 'text' as const, text: JSON.stringify({ ok: true }) }] };
          }
        )
      );
    }
  }

  const server = createSdkMcpServer({ name: 'space-agent', tools });
  instrumentTypedTelemetryAtMcpBoundary(server, config);
  return { ...server, tools };
}

export type SpaceAgentMcpServer = ReturnType<typeof createSpaceAgentMcpServer>;
