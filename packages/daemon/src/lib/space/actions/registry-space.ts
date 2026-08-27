import {
  AddForgeManualNoteSchema,
  AddForgeMetricSnapshotSchema,
  ApplyForgeRollupSchema,
  ArchiveAgentSchema,
  AssignAgentToForgeScopeSchema,
  AssignAgentToGoalSchema,
  AttachForgeTaskEvidenceSchema,
  AttachForgeWorkflowRunEvidenceSchema,
  CreateAgentFromTemplateSchema,
  CreateAgentReminderSchema,
  CreateAgentSchema,
  CreateForgeEpisodeSchema,
  CreateForgeScopeFromGoalSchema,
  CreateForgeScopeSchema,
  CreateForgeTaskProposalSchema,
  CreateGoalSchema,
  CreateTaskFromForgeProposalSchema,
  GetAgentSchema,
  GetForgeScopeSchema,
  GetForgeTimelineSchema,
  GetGoalSchema,
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
  PauseAgentSchema,
  PauseGoalSchema,
  ResolveForgeScopeSchema,
  ResumeGoalSchema,
  ReviewGoalOutcomeSchema,
  SubscribeAgentEventSchema,
  TriggerGoalTaskSchema,
  UnassignAgentFromForgeScopeSchema,
  UnassignAgentFromGoalSchema,
  UnsubscribeAgentEventSchema,
  UpdateAgentSchema,
  UpdateForgeEpisodeSchema,
  UpdateForgeLessonSchema,
  UpdateForgeScopeSchema,
  UpdateForgeTaskProposalSchema,
  UpdateGoalSchema,
} from '../tools/space-agent-tool-schemas.ts';
import {
  createSpaceAgentToolHandlers,
  type SpaceAgentToolsConfig,
} from '../tools/space-agent-tools.ts';
import { type ActionDefinition, defineAction } from './registry.ts';

export function createSpaceRegistryEntries(config: SpaceAgentToolsConfig): ActionDefinition[] {
  const handlers = createSpaceAgentToolHandlers(config);

  const agentLifecycleEntries: ActionDefinition[] = [
    defineAction({
      name: 'list_agents',
      family: 'agents',
      safetyClass: 'read',
      description:
        'List long-horizon agents in this space; returns agent records with lifecycle status, model, and tool permissions.',
      paramsDoc: 'status? (active|paused|disabled|archived), compact?',
      paramsSchema: ListAgentsSchema,
      handler: (args) => handlers.list_agents(args),
    }),
    defineAction({
      name: 'get_agent',
      family: 'agents',
      safetyClass: 'read',
      description: 'Get one long-horizon agent by ID; returns the full agent record.',
      paramsDoc: 'agent_id',
      paramsSchema: GetAgentSchema,
      handler: (args) => handlers.get_agent(args),
    }),
    defineAction({
      name: 'create_agent',
      family: 'agents',
      safetyClass: 'mutate',
      description:
        'Create a long-horizon agent with optional model, prompt, and tool-permission overrides (validated against the known allowlist); returns the created agent.',
      paramsDoc:
        'name, description?, model?, thinking_level?, provider?, custom_prompt?, tools?, setting_sources?',
      paramsSchema: CreateAgentSchema,
      handler: (args) => handlers.create_agent(args),
    }),
    defineAction({
      name: 'create_agent_from_template',
      family: 'agents',
      safetyClass: 'mutate',
      description:
        'Create a long-horizon agent from a worker preset name (Coder, Reviewer, QA, ...) or long-horizon template key, seeding suggested subscriptions and reminders; returns the created agent.',
      paramsDoc: 'template_name, name?, model?, provider?, thinking_level?',
      paramsSchema: CreateAgentFromTemplateSchema,
      handler: (args) => handlers.create_agent_from_template(args),
    }),
    defineAction({
      name: 'list_agent_templates',
      family: 'agents',
      safetyClass: 'read',
      description:
        'List built-in agent templates available to create_agent_from_template — worker presets and long-horizon templates; returns template descriptors.',
      paramsDoc: 'none',
      paramsSchema: ListAgentTemplatesSchema,
      handler: () => handlers.list_agent_templates(),
    }),
    defineAction({
      name: 'update_agent',
      family: 'agents',
      safetyClass: 'mutate',
      description:
        "Update a long-horizon agent's name, status, model, prompt, or tool permissions; autonomy/tool escalation is limited by manager validation and audited; returns the updated agent.",
      paramsDoc:
        'agent_id, plus any of name?, status?, description?, model?, thinking_level?, provider?, custom_prompt?, tools?, setting_sources? (null clears)',
      paramsSchema: UpdateAgentSchema,
      handler: (args) => handlers.update_agent(args),
    }),
    defineAction({
      name: 'pause_agent',
      family: 'agents',
      safetyClass: 'mutate',
      description: 'Pause a long-horizon agent without deleting it; returns the updated agent.',
      paramsDoc: 'agent_id',
      paramsSchema: PauseAgentSchema,
      handler: (args) => handlers.pause_agent(args),
    }),
    defineAction({
      name: 'archive_agent',
      family: 'agents',
      safetyClass: 'mutate',
      description:
        'Archive a long-horizon agent, excluding it from active lookups (reversible via update_agent); returns the updated agent.',
      paramsDoc: 'agent_id',
      paramsSchema: ArchiveAgentSchema,
      handler: (args) => handlers.archive_agent(args),
    }),
    defineAction({
      name: 'assign_agent_to_goal',
      family: 'agents',
      safetyClass: 'mutate',
      description:
        'Assign a long-horizon agent to own a goal (admission-checked for coordinator authorization); returns success.',
      paramsDoc: 'agent_id, goal_id',
      paramsSchema: AssignAgentToGoalSchema,
      handler: (args) => handlers.assign_agent_to_goal(args),
    }),
    defineAction({
      name: 'unassign_agent_from_goal',
      family: 'agents',
      safetyClass: 'mutate',
      description:
        'Remove a long-horizon agent goal ownership (admission-checked for coordinator authorization); returns success.',
      paramsDoc: 'agent_id, goal_id',
      paramsSchema: UnassignAgentFromGoalSchema,
      handler: (args) => handlers.unassign_agent_from_goal(args),
    }),
    defineAction({
      name: 'assign_agent_to_forge_scope',
      family: 'agents',
      safetyClass: 'mutate',
      description: 'Assign a long-horizon agent to a Forge scope; returns success.',
      paramsDoc: 'agent_id, scope_id',
      paramsSchema: AssignAgentToForgeScopeSchema,
      handler: (args) => handlers.assign_agent_to_forge_scope(args),
    }),
    defineAction({
      name: 'unassign_agent_from_forge_scope',
      family: 'agents',
      safetyClass: 'mutate',
      description: 'Remove a long-horizon agent Forge scope assignment; returns success.',
      paramsDoc: 'agent_id, scope_id',
      paramsSchema: UnassignAgentFromForgeScopeSchema,
      handler: (args) => handlers.unassign_agent_from_forge_scope(args),
    }),
    defineAction({
      name: 'create_agent_reminder',
      family: 'agents',
      safetyClass: 'mutate',
      description:
        'Create a one-shot reminder delivered to a long-horizon agent at a timestamp; returns the created reminder.',
      paramsDoc: 'agent_id, message, remind_at (ms since epoch)',
      paramsSchema: CreateAgentReminderSchema,
      handler: (args) => handlers.create_agent_reminder(args),
    }),
    defineAction({
      name: 'list_agent_reminders',
      family: 'agents',
      safetyClass: 'read',
      description:
        'List reminders for a long-horizon agent, optionally filtered by status; returns reminder records.',
      paramsDoc: 'agent_id, status? (active|done|cancelled)',
      paramsSchema: ListAgentRemindersSchema,
      handler: (args) => handlers.list_agent_reminders(args),
    }),
    defineAction({
      name: 'subscribe_agent_event',
      family: 'agents',
      safetyClass: 'mutate',
      description:
        'Record an external-event topic subscription for a long-horizon agent; returns the subscription record.',
      paramsDoc: 'agent_id, topic_pattern (glob), label?',
      paramsSchema: SubscribeAgentEventSchema,
      handler: (args) => handlers.subscribe_agent_event(args),
    }),
    defineAction({
      name: 'unsubscribe_agent_event',
      family: 'agents',
      safetyClass: 'mutate',
      description:
        'Remove an external-event topic subscription from a long-horizon agent; returns success.',
      paramsDoc: 'agent_id, topic_pattern, label?',
      paramsSchema: UnsubscribeAgentEventSchema,
      handler: (args) => handlers.unsubscribe_agent_event(args),
    }),
    defineAction({
      name: 'list_agent_event_subscriptions',
      family: 'agents',
      safetyClass: 'read',
      description:
        'List external-event subscriptions for a long-horizon agent; returns subscription records.',
      paramsDoc: 'agent_id',
      paramsSchema: ListAgentEventSubscriptionsSchema,
      handler: (args) => handlers.list_agent_event_subscriptions(args),
    }),
  ];

  const goalEntries: ActionDefinition[] = [
    defineAction({
      name: 'list_goals',
      family: 'goals',
      safetyClass: 'read',
      description:
        'List long-horizon goals in this space with rolling summary and progress; read this before changing goal state; returns goal records.',
      paramsDoc: 'status?',
      paramsSchema: ListGoalsSchema,
      handler: (args) => handlers.list_goals(args),
    }),
    defineAction({
      name: 'get_goal',
      family: 'goals',
      safetyClass: 'read',
      description:
        'Get one goal with rolling state, active task pointers, next check-in, metrics, and next steps; returns the full goal record.',
      paramsDoc: 'goal_id',
      paramsSchema: GetGoalSchema,
      handler: (args) => handlers.get_goal(args),
    }),
    defineAction({
      name: 'create_goal',
      family: 'goals',
      safetyClass: 'mutate',
      description:
        'Create a long-horizon goal, optionally scheduling recurring check-ins or triggering the first task immediately; returns the created goal.',
      paramsDoc:
        'title, description?, type?, priority?, labels?, metrics?, summary?, progress?, next_steps?, preferred_workflow_id?, auto_trigger_next?, check_in_cron_expression?, check_in_timezone?, trigger_immediately?, owner_agent_id?, workspace_path?',
      paramsSchema: CreateGoalSchema,
      handler: (args) => handlers.create_goal(args),
    }),
    defineAction({
      name: 'update_goal',
      family: 'goals',
      safetyClass: 'mutate',
      description:
        'Update goal fields and rolling state (summary/progress/metrics/next_steps), or edit its check-in schedule in place; internal fields are not writable; returns the updated goal.',
      paramsDoc:
        'goal_id, plus any of title?, description?, status?, type?, priority?, labels?, metrics?, summary?, progress?, next_steps?, preferred_workflow_id?, auto_trigger_next?, check_in_cron_expression?, check_in_timezone?, workspace_path?',
      paramsSchema: UpdateGoalSchema,
      handler: (args) => handlers.update_goal(args),
    }),
    defineAction({
      name: 'pause_goal',
      family: 'goals',
      safetyClass: 'mutate',
      description:
        'Pause an active goal and its linked check-in schedule if present; returns the updated goal.',
      paramsDoc: 'goal_id',
      paramsSchema: PauseGoalSchema,
      handler: (args) => handlers.pause_goal(args),
    }),
    defineAction({
      name: 'resume_goal',
      family: 'goals',
      safetyClass: 'mutate',
      description:
        'Resume a paused goal and re-enable its linked check-in schedule if present; returns the updated goal.',
      paramsDoc: 'goal_id',
      paramsSchema: ResumeGoalSchema,
      handler: (args) => handlers.resume_goal(args),
    }),
    defineAction({
      name: 'trigger_goal_task',
      family: 'goals',
      safetyClass: 'mutate',
      description:
        'Create an immediate task for a goal, queueing one follow-up when another goal task is active and auto_trigger_next is set; returns the created task.',
      paramsDoc: 'goal_id',
      paramsSchema: TriggerGoalTaskSchema,
      handler: (args) => handlers.trigger_goal_task(args),
    }),
    defineAction({
      name: 'list_goal_tasks',
      family: 'goals',
      safetyClass: 'read',
      description:
        'List tasks linked to a goal as a bounded page of compact summaries ordered newest-first; paginate with before/before_id.',
      paramsDoc: 'goal_id, status?, limit? (default 20, max 100), before?, before_id?',
      paramsSchema: ListGoalTasksSchema,
      handler: (args) => handlers.list_goal_tasks(args),
    }),
    defineAction({
      name: 'list_goal_events',
      family: 'goals',
      safetyClass: 'read',
      description:
        'List append-only history events for a goal to understand why its rolling state changed; returns newest-first events.',
      paramsDoc: 'goal_id, limit?, before?, before_id?',
      paramsSchema: ListGoalEventsSchema,
      handler: (args) => handlers.list_goal_events(args),
    }),
  ];

  const forgeEntries: ActionDefinition[] = [
    defineAction({
      name: 'create_forge_scope',
      family: 'forge',
      safetyClass: 'mutate',
      description:
        'Create a Forge scope, optionally linked to a recurring goal, with policy for judge guidance; returns the created scope.',
      paramsDoc: 'kind, name, objective, goal_id?, parent_scope_id?, metric_definitions?, policy?',
      paramsSchema: CreateForgeScopeSchema,
      handler: (args) => handlers.create_forge_scope(args),
    }),
    defineAction({
      name: 'create_forge_scope_from_goal',
      family: 'forge',
      safetyClass: 'mutate',
      description:
        'Create a mission Forge scope linked to an existing goal, defaulting name/objective from the goal; returns the created scope.',
      paramsDoc: 'goal_id, name?, objective?, metric_definitions?, policy?',
      paramsSchema: CreateForgeScopeFromGoalSchema,
      handler: (args) => handlers.create_forge_scope_from_goal(args),
    }),
    defineAction({
      name: 'list_forge_scopes',
      family: 'forge',
      safetyClass: 'read',
      description:
        'List Forge scopes in this space, optionally filtered by linked goal or kind; returns scope records.',
      paramsDoc: 'goal_id? (null = unlinked), kind?',
      paramsSchema: ListForgeScopesSchema,
      handler: (args) => handlers.list_forge_scopes(args),
    }),
    defineAction({
      name: 'get_forge_scope',
      family: 'forge',
      safetyClass: 'read',
      description:
        'Get one Forge scope including linked goal, metric definitions, and policy; returns the full scope record.',
      paramsDoc: 'scope_id',
      paramsSchema: GetForgeScopeSchema,
      handler: (args) => handlers.get_forge_scope(args),
    }),
    defineAction({
      name: 'update_forge_scope',
      family: 'forge',
      safetyClass: 'mutate',
      description:
        'Update a Forge scope — link/unlink a goal; prefer policy_patch to deep-merge policy fields without clobbering the rest; changes take effect immediately; returns the updated scope.',
      paramsDoc:
        'scope_id, plus goal_id?, kind?, name?, objective?, parent_scope_id?, metric_definitions?, policy?/policy_patch?, episode_judge_model?, episode_judge_provider?',
      paramsSchema: UpdateForgeScopeSchema,
      handler: (args) => handlers.update_forge_scope(args),
    }),
    defineAction({
      name: 'get_forge_timeline',
      family: 'forge',
      safetyClass: 'read',
      description:
        'Get a scope overview/timeline with scope, evidence, and metric snapshots; returns the timeline bundle.',
      paramsDoc: 'scope_id',
      paramsSchema: GetForgeTimelineSchema,
      handler: (args) => handlers.get_forge_timeline(args),
    }),
    defineAction({
      name: 'add_forge_manual_note',
      family: 'forge',
      safetyClass: 'mutate',
      description:
        'Attach a manual-note evidence item to a Forge scope; returns the evidence record.',
      paramsDoc: 'scope_id, summary, metadata?, created_at?',
      paramsSchema: AddForgeManualNoteSchema,
      handler: (args) => handlers.add_forge_manual_note(args),
    }),
    defineAction({
      name: 'attach_forge_task_evidence',
      family: 'forge',
      safetyClass: 'mutate',
      description:
        'Attach a completed or relevant task as Forge evidence, resolving the scope from the task when scope_id is omitted; returns the evidence record.',
      paramsDoc: 'task_id, scope_id?, summary?, metadata?',
      paramsSchema: AttachForgeTaskEvidenceSchema,
      handler: (args) => handlers.attach_forge_task_evidence(args),
    }),
    defineAction({
      name: 'attach_forge_workflow_run_evidence',
      family: 'forge',
      safetyClass: 'mutate',
      description:
        "Attach a workflow run as Forge evidence, resolving the scope via the run's first task when scope_id is omitted; returns the evidence record.",
      paramsDoc: 'workflow_run_id, scope_id?, summary?, metadata?',
      paramsSchema: AttachForgeWorkflowRunEvidenceSchema,
      handler: (args) => handlers.attach_forge_workflow_run_evidence(args),
    }),
    defineAction({
      name: 'add_forge_metric_snapshot',
      family: 'forge',
      safetyClass: 'mutate',
      description:
        'Add a metric-snapshot evidence item to a Forge scope; returns the snapshot record.',
      paramsDoc: 'scope_id, values, source, note?, captured_at?, summary?, metadata?',
      paramsSchema: AddForgeMetricSnapshotSchema,
      handler: (args) => handlers.add_forge_metric_snapshot(args),
    }),
    defineAction({
      name: 'list_forge_evidence',
      family: 'forge',
      safetyClass: 'read',
      description: 'List evidence refs for a Forge scope; returns evidence records.',
      paramsDoc: 'scope_id',
      paramsSchema: ListForgeEvidenceSchema,
      handler: (args) => handlers.list_forge_evidence(args),
    }),
    defineAction({
      name: 'list_forge_metric_snapshots',
      family: 'forge',
      safetyClass: 'read',
      description: 'List metric snapshots for a Forge scope; returns snapshot records.',
      paramsDoc: 'scope_id',
      paramsSchema: ListForgeMetricSnapshotsSchema,
      handler: (args) => handlers.list_forge_metric_snapshots(args),
    }),
    defineAction({
      name: 'create_forge_episode',
      family: 'forge',
      safetyClass: 'mutate',
      description:
        'Generate a draft Forge episode from selected evidence via the episode judge (LLM/model/auth errors are surfaced clearly); returns the draft episode.',
      paramsDoc: 'scope_id, evidence_ids, time_window?, confirm_low_confidence?',
      paramsSchema: CreateForgeEpisodeSchema,
      handler: (args) => handlers.create_forge_episode(args),
    }),
    defineAction({
      name: 'list_forge_review_bundle',
      family: 'forge',
      safetyClass: 'read',
      description:
        'List episodes, lessons, and task proposals for reviewing a Forge scope; returns the review bundle.',
      paramsDoc: 'scope_id',
      paramsSchema: ListForgeReviewBundleSchema,
      handler: (args) => handlers.list_forge_review_bundle(args),
    }),
    defineAction({
      name: 'list_forge_lessons',
      family: 'forge',
      safetyClass: 'read',
      description:
        'List Forge lessons for a scope, optionally filtered by status; returns lesson records.',
      paramsDoc: 'scope_id, status? (candidate|active|dismissed)',
      paramsSchema: ListForgeLessonsSchema,
      handler: (args) => handlers.list_forge_lessons(args),
    }),
    defineAction({
      name: 'list_forge_proposals',
      family: 'forge',
      safetyClass: 'read',
      description:
        'List Forge task proposals for a scope, optionally filtered by status; returns proposal records.',
      paramsDoc: 'scope_id, status?',
      paramsSchema: ListForgeProposalsSchema,
      handler: (args) => handlers.list_forge_proposals(args),
    }),
    defineAction({
      name: 'resolve_forge_scope',
      family: 'forge',
      safetyClass: 'read',
      description:
        'Resolve a Forge scope from a linked goal_id or task_id when scope_id is unknown; returns the scope.',
      paramsDoc: 'goal_id? or task_id?',
      paramsSchema: ResolveForgeScopeSchema,
      handler: (args) => handlers.resolve_forge_scope(args),
    }),
    defineAction({
      name: 'update_forge_episode',
      family: 'forge',
      safetyClass: 'mutate',
      description:
        'Accept, dismiss, or edit a Forge episode draft — use accept/dismiss only after an explicit decision; returns the updated episode.',
      paramsDoc: 'episode_id, status?, title?, outcome_summary?',
      paramsSchema: UpdateForgeEpisodeSchema,
      handler: (args) => handlers.update_forge_episode(args),
    }),
    defineAction({
      name: 'update_forge_lesson',
      family: 'forge',
      safetyClass: 'mutate',
      description:
        'Activate, dismiss, or edit a candidate lesson — activation requires an explicit tool call; returns the updated lesson.',
      paramsDoc: 'lesson_id, status?, applies_to?, rule?, why?, confidence?',
      paramsSchema: UpdateForgeLessonSchema,
      handler: (args) => handlers.update_forge_lesson(args),
    }),
    defineAction({
      name: 'create_forge_task_proposal',
      family: 'forge',
      safetyClass: 'mutate',
      description:
        'Manually create a Forge task proposal for a scope; a later create_task_from_forge_proposal makes the real task; returns the proposal.',
      paramsDoc: 'scope_id, title, description, reason, priority?, evidence_episode_ids?',
      paramsSchema: CreateForgeTaskProposalSchema,
      handler: (args) => handlers.create_forge_task_proposal(args),
    }),
    defineAction({
      name: 'update_forge_task_proposal',
      family: 'forge',
      safetyClass: 'mutate',
      description:
        'Edit, accept, or dismiss a Forge task proposal — creating the SpaceTask is separate and explicit; returns the updated proposal.',
      paramsDoc: 'proposal_id, title?, description?, reason?, priority?, status?',
      paramsSchema: UpdateForgeTaskProposalSchema,
      handler: (args) => handlers.update_forge_task_proposal(args),
    }),
    defineAction({
      name: 'create_task_from_forge_proposal',
      family: 'forge',
      safetyClass: 'mutate',
      description:
        'Create a real SpaceTask from a Forge proposal, preserving linked goal and scope bindings, with optional dependencies; idempotent when the task already exists; returns the created task.',
      paramsDoc: 'proposal_id, title?, description?, reason?, priority?, depends_on?',
      paramsSchema: CreateTaskFromForgeProposalSchema,
      handler: (args) => handlers.create_task_from_forge_proposal(args),
    }),
    defineAction({
      name: 'apply_forge_rollup',
      family: 'forge',
      safetyClass: 'mutate',
      description:
        'Accept a Forge episode and roll its summary/progress/metrics/next steps into the linked recurring goal; returns the rollup result.',
      paramsDoc: 'episode_id, goal_update {summary?, progress?, next_steps?, metrics?}',
      paramsSchema: ApplyForgeRollupSchema,
      handler: (args) => handlers.apply_forge_rollup(args),
    }),
  ];

  const reviewGoalOutcomeEntry = defineAction({
    name: 'review_goal_outcome',
    family: 'goals',
    safetyClass: 'mutate',
    description:
      'Review a terminal goal-outcome notification — call without notification_id to discover pending notifications you own, then terminalize with a disposition (acknowledge/reject/supersede) or acknowledge while persisting goal-state updates.',
    paramsDoc:
      'notification_id?, goal_id?, task_id?, disposition? (acknowledge|reject|supersede), observed_goal_revision?, summary?, next_steps?, metrics?, observations?, progress?',
    paramsSchema: ReviewGoalOutcomeSchema,
    handler: (args) => handlers.review_goal_outcome(args),
  });

  const entries: ActionDefinition[] = [];
  if (config.db) entries.push(...agentLifecycleEntries);
  if (config.goalService) entries.push(...goalEntries);
  if (config.evolutionScopeService && config.evolutionEpisodeService) entries.push(...forgeEntries);
  if (config.callerRole === 'long_term_agent' || config.callerRole === 'coordinator')
    entries.push(reviewGoalOutcomeEntry);
  return entries;
}
