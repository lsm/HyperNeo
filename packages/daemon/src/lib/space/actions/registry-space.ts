import {
  isRateOrUsageLimited,
  isWorkflowRecoveryTransition,
  type SpaceTaskStatus,
} from '@hyperneo/shared';
import type { z } from 'zod';
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
  CreateForgeEpisodeSchema,
  CreateForgeScopeFromGoalSchema,
  CreateForgeScopeSchema,
  CreateForgeTaskProposalSchema,
  CreateGoalSchema,
  CreateScheduledTaskSchema,
  CreateStandaloneTaskSchema,
  CreateTaskFromForgeProposalSchema,
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
  ReviewGoalOutcomeSchema,
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
  UpdateForgeEpisodeSchema,
  UpdateForgeLessonSchema,
  UpdateForgeScopeSchema,
  UpdateForgeTaskProposalSchema,
  UpdateGoalSchema,
  UpdateSessionStateSchema,
  UpdateTaskSchema,
} from '../tools/space-agent-tool-schemas.ts';
import {
  createSpaceAgentToolHandlers,
  DEFAULT_INACTIVITY_THRESHOLD_MS,
  type SpaceAgentToolsConfig,
} from '../tools/space-agent-tools.ts';
import { SESSION_WRITE_AUTONOMY_LEVEL } from '../tools/tool-admission-gates.ts';
import { jsonResult } from '../tools/tool-result.ts';
import { type ActionDefinition, defineAction } from './registry.ts';

const DEFAULT_COMPLETION_AUTONOMY_LEVEL = 5;

function routeCancelsActiveWorkflowRun(currentStatus: SpaceTaskStatus): boolean {
  const rateOrUsageLimited = isRateOrUsageLimited(currentStatus);
  return (
    currentStatus === 'in_progress' ||
    currentStatus === 'blocked' ||
    currentStatus === 'stopped' ||
    rateOrUsageLimited
  );
}

const DESTRUCTIVE_ACTION_AUTONOMY_LEVEL = SESSION_WRITE_AUTONOMY_LEVEL;

const HUMAN_ONLY_AUTONOMY_LEVEL = 5;

const forgeTerminalStatusAutonomy =
  (committingStatuses: readonly string[]) =>
  async (params: { status?: string }): Promise<number> =>
    params.status !== undefined && committingStatuses.includes(params.status)
      ? DESTRUCTIVE_ACTION_AUTONOMY_LEVEL
      : 1;

export function createSpaceRegistryEntries(config: SpaceAgentToolsConfig): ActionDefinition[] {
  const handlers = createSpaceAgentToolHandlers({ ...config, auditLogRepo: undefined });

  const taskInSpace = (taskId: string) => {
    const task = config.taskRepo.getTask(taskId);
    return task && task.spaceId === config.spaceId ? task : null;
  };

  const approveTaskAutonomy = async (params: z.infer<typeof ApproveTaskSchema>) => {
    const task = taskInSpace(params.task_id);
    if (task?.pendingCheckpointType === 'task_completion') return HUMAN_ONLY_AUTONOMY_LEVEL;
    const run = task?.workflowRunId ? config.workflowRunRepo.getRun(task.workflowRunId) : null;
    const workflow = run?.workflowId ? config.workflowManager.getWorkflowForRun(run) : null;
    return workflow?.completionAutonomyLevel ?? DEFAULT_COMPLETION_AUTONOMY_LEVEL;
  };

  const updateTaskAutonomy = async (params: z.infer<typeof UpdateTaskSchema>) => {
    const task = taskInSpace(params.task_id);
    if (
      params.status !== undefined &&
      params.status !== task?.status &&
      task?.pendingCheckpointType === 'task_completion'
    ) {
      return HUMAN_ONLY_AUTONOMY_LEVEL;
    }
    if (params.status === 'archived') return DESTRUCTIVE_ACTION_AUTONOMY_LEVEL;
    if (task?.workflowRunId && params.status !== undefined && params.status !== task.status) {
      if (params.status === 'stopped') return DESTRUCTIVE_ACTION_AUTONOMY_LEVEL;
      const toStopped = params.status === 'open' || params.status === 'cancelled';
      const toBlockedFromPaused = params.status === 'blocked' && isRateOrUsageLimited(task.status);
      if (
        (toStopped || toBlockedFromPaused) &&
        routeCancelsActiveWorkflowRun(task.status) &&
        !isWorkflowRecoveryTransition(task.status, params.status)
      ) {
        return DESTRUCTIVE_ACTION_AUTONOMY_LEVEL;
      }
    }
    return 1;
  };

  const cancelTaskAutonomy = async (params: z.infer<typeof CancelTaskSchema>) => {
    const task = taskInSpace(params.task_id);
    if (task?.pendingCheckpointType === 'task_completion') return HUMAN_ONLY_AUTONOMY_LEVEL;
    if (params.cancel_workflow_run === true && task?.workflowRunId) {
      return DESTRUCTIVE_ACTION_AUTONOMY_LEVEL;
    }
    return 1;
  };

  const archiveTaskAutonomy = async (params: z.infer<typeof ArchiveTaskSchema>) => {
    const task = taskInSpace(params.task_id);
    if (task?.pendingCheckpointType === 'task_completion') return HUMAN_ONLY_AUTONOMY_LEVEL;
    return DESTRUCTIVE_ACTION_AUTONOMY_LEVEL;
  };

  const changePlanAutonomy = async (params: z.infer<typeof ChangePlanSchema>) => {
    const switching =
      (params.workflow_id !== undefined && params.workflow_id.length > 0) ||
      (params.workflow_handle !== undefined && params.workflow_handle.length > 0);
    if (!switching) return 1;
    const run = config.workflowRunRepo.getRun(params.run_id);
    const runTasks =
      run && run.spaceId === config.spaceId ? config.taskRepo.listByWorkflowRun(run.id) : [];
    if (runTasks.some((task) => task.pendingCheckpointType === 'task_completion')) {
      return HUMAN_ONLY_AUTONOMY_LEVEL;
    }
    return DESTRUCTIVE_ACTION_AUTONOMY_LEVEL;
  };

  const forgeRecordInSpace = (scopeId: string): boolean =>
    config.evolutionScopeService?.getScope(scopeId)?.spaceId === config.spaceId;

  const forgeLessonUpdateAutonomy = async (params: z.infer<typeof UpdateForgeLessonSchema>) => {
    const lesson = config.evolutionEpisodeService?.getLesson(params.lesson_id);
    if (lesson && forgeRecordInSpace(lesson.scopeId) && lesson.status !== 'candidate') {
      return DESTRUCTIVE_ACTION_AUTONOMY_LEVEL;
    }
    return forgeTerminalStatusAutonomy(['active', 'dismissed'])(params);
  };

  const forgeEpisodeUpdateAutonomy = async (params: z.infer<typeof UpdateForgeEpisodeSchema>) => {
    const episode = config.evolutionEpisodeService?.getEpisode(params.episode_id);
    if (episode && forgeRecordInSpace(episode.scopeId) && episode.status !== 'draft') {
      return DESTRUCTIVE_ACTION_AUTONOMY_LEVEL;
    }
    return forgeTerminalStatusAutonomy(['accepted', 'dismissed'])(params);
  };

  const forgeProposalUpdateAutonomy = async (
    params: z.infer<typeof UpdateForgeTaskProposalSchema>
  ) => {
    const proposal = config.evolutionEpisodeService?.getTaskProposal(params.proposal_id);
    if (proposal && forgeRecordInSpace(proposal.scopeId) && proposal.status !== 'proposed') {
      return DESTRUCTIVE_ACTION_AUTONOMY_LEVEL;
    }
    return forgeTerminalStatusAutonomy(['accepted', 'dismissed'])(params);
  };

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
      auditRedactKeys: ['message'],
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
      auditRedactKeys: ['message'],
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
      safetyClass: 'destructive',
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
        'List every workflow in this space; returns summaries with id, handle, description, tags, and node count.',
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
      safetyClass: 'destructive',
      description:
        'Update an active run description, or switch it to another workflow (cancels the run and starts a new one); returns the affected run(s).',
      paramsDoc: 'run_id, plus description? and/or workflow_id?/workflow_handle?',
      auditRedactKeys: ['description'],
      paramsSchema: ChangePlanSchema,
      autonomyRequirement: changePlanAutonomy,
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
        'List all enabled workflows unranked for a described piece of work; returns id, handle, description, tags, and node count.',
      paramsDoc: 'description (context only — every workflow is returned)',
      auditRedactKeys: ['description'],
      paramsSchema: SuggestWorkflowSchema,
      handler: (args) => handlers.suggest_workflow(args),
    }),
  ];

  const partCEntries: ActionDefinition[] = [];

  function requireInactivityAgentId(): string {
    if (!config.myAgentId) {
      throw new Error('No agent identity available for inactivity config');
    }
    return config.myAgentId;
  }

  if (config.scheduleService) {
    partCEntries.push(
      defineAction({
        name: 'create_scheduled_task',
        family: 'scheduled',
        safetyClass: 'mutate',
        description:
          'Create a recurring (cron) or one-shot (at) schedule that spawns a real Space task each time it fires; returns the created schedule.',
        paramsDoc:
          'title, description, trigger_type (cron|at), cron_expression? (required for cron), run_at? ms (required for at), priority?, workflow_id?, labels?, timezone?',
        auditRedactKeys: ['description'],
        paramsSchema: CreateScheduledTaskSchema,
        handler: (args) => handlers.create_scheduled_task(args),
      }),
      defineAction({
        name: 'list_scheduled_tasks',
        family: 'scheduled',
        safetyClass: 'read',
        description:
          'List every task schedule in this space; returns schedules with trigger, next run time, and status.',
        paramsDoc: 'status? (active|paused|completed)',
        paramsSchema: ListScheduledTasksSchema,
        handler: (args) => handlers.list_scheduled_tasks(args),
      }),
      defineAction({
        name: 'get_scheduled_task',
        family: 'scheduled',
        safetyClass: 'read',
        description:
          'Inspect one schedule including its last spawned task and next run time; returns the schedule record.',
        paramsDoc: 'schedule_id',
        paramsSchema: GetScheduledTaskSchema,
        handler: (args) => handlers.get_scheduled_task(args),
      }),
      defineAction({
        name: 'pause_scheduled_task',
        family: 'scheduled',
        safetyClass: 'mutate',
        description:
          'Pause a schedule so it stops creating tasks until resumed; returns the paused schedule.',
        paramsDoc: 'schedule_id',
        paramsSchema: PauseScheduledTaskSchema,
        handler: (args) => handlers.pause_scheduled_task(args),
      }),
      defineAction({
        name: 'resume_scheduled_task',
        family: 'scheduled',
        safetyClass: 'mutate',
        description:
          'Resume a paused schedule, recomputing the next run time and re-enqueueing the job; returns the resumed schedule.',
        paramsDoc: 'schedule_id',
        paramsSchema: ResumeScheduledTaskSchema,
        handler: (args) => handlers.resume_scheduled_task(args),
      }),
      defineAction({
        name: 'delete_scheduled_task',
        family: 'scheduled',
        safetyClass: 'destructive',
        description:
          'Permanently delete a schedule and cancel its pending fire job; returns success, or a retry hint when modified concurrently.',
        paramsDoc: 'schedule_id',
        paramsSchema: DeleteScheduledTaskSchema,
        autonomyRequirement: DESTRUCTIVE_ACTION_AUTONOMY_LEVEL,
        handler: (args) => handlers.delete_scheduled_task(args),
      })
    );
  }

  if (config.externalEventStore) {
    partCEntries.push(
      defineAction({
        name: 'get_external_event',
        family: 'external_events',
        safetyClass: 'read',
        description:
          'Fetch the full raw record for one external event by id — the on-demand deep-dive counterpart to the lean event summary injected as a message; returns the event and its delivery state, or not-found for unknown ids.',
        paramsDoc: 'eventId',
        paramsSchema: GetExternalEventSchema,
        handler: (args) => handlers.get_external_event(args),
      })
    );
  }

  if (config.inactivityConfigRepo) {
    partCEntries.push(
      defineAction({
        name: 'inactivity_config_get',
        family: 'inactivity',
        safetyClass: 'read',
        description:
          "Read this agent's inactivity watchdog configuration (enabled, idle threshold, nag prompt) and degraded flag.",
        paramsDoc: 'none',
        paramsSchema: InactivityConfigGetSchema,
        handler: async () => {
          const agentId = requireInactivityAgentId();
          const cfg = config.inactivityConfigRepo?.getByAgent(config.spaceId, agentId);
          const claim = config.inactivityClaimRepo?.getByAgent(config.spaceId, agentId);
          return jsonResult({ config: cfg ?? null, degraded: claim?.degraded ?? false });
        },
      }),
      defineAction({
        name: 'inactivity_config_set_enabled',
        family: 'inactivity',
        safetyClass: 'mutate',
        description:
          "Enable, pause, or resume this agent's inactivity watchdog. Pausing keeps the threshold and prompt but stops new nags until resumed.",
        paramsDoc: 'enabled (true to enable or resume, false to pause)',
        paramsSchema: InactivityConfigSetEnabledSchema,
        handler: async (args) => {
          const agentId = requireInactivityAgentId();
          const cfg = config.inactivityConfigRepo?.setEnabled(
            config.spaceId,
            agentId,
            args.enabled
          );
          if (args.enabled) {
            config.inactivityClaimRepo?.clearDegraded(config.spaceId, agentId);
            if (cfg && cfg.thresholdMs === null) {
              config.inactivityConfigRepo?.upsert({
                spaceId: config.spaceId,
                agentId,
                thresholdMs: DEFAULT_INACTIVITY_THRESHOLD_MS,
              });
            }
          }
          return jsonResult({ ok: true, enabled: cfg?.enabled ?? args.enabled });
        },
      }),
      defineAction({
        name: 'inactivity_config_set',
        family: 'inactivity',
        safetyClass: 'mutate',
        description:
          "Adjust this agent's inactivity watchdog threshold (ms of idleness before a nag) or nag prompt. Changing either bumps the config revision so a pending nag revalidates against the new settings.",
        paramsDoc: 'threshold_ms? (positive int), prompt? (empty string clears)',
        auditRedactKeys: ['prompt'],
        paramsSchema: InactivityConfigSetSchema,
        handler: async (args) => {
          const agentId = requireInactivityAgentId();
          config.inactivityConfigRepo?.upsert({
            spaceId: config.spaceId,
            agentId,
            thresholdMs: args.threshold_ms,
            prompt: args.prompt,
          });
          return jsonResult({ ok: true });
        },
      })
    );
    if (config.inactivityRunNow) {
      partCEntries.push(
        defineAction({
          name: 'inactivity_run_now',
          family: 'inactivity',
          safetyClass: 'mutate',
          description:
            "Run this agent's inactivity watchdog scan immediately, through the same admission gates as the periodic scan.",
          paramsDoc: 'none',
          paramsSchema: InactivityRunNowSchema,
          handler: async () => {
            const agentId = requireInactivityAgentId();
            await config.inactivityRunNow?.(config.spaceId, agentId);
            return jsonResult({ ok: true });
          },
        })
      );
    }
  }

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
      auditRedactKeys: ['description'],
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
      taskIdPreference: 'task_number',
      handler: (args) => handlers.get_task_detail(args),
    }),
    defineAction({
      name: 'update_task',
      family: 'tasks',
      safetyClass: 'mutate',
      description:
        "Edit a task's title, description, priority, dependencies, or status; status follows the UI transition table; returns the updated task.",
      paramsDoc: 'task_id, plus any of title?, description?, priority?, depends_on?, status?',
      auditRedactKeys: ['description'],
      paramsSchema: UpdateTaskSchema,
      autonomyRequirement: updateTaskAutonomy,
      handler: (args) => handlers.update_task(args),
    }),
    defineAction({
      name: 'retry_task',
      family: 'tasks',
      safetyClass: 'mutate',
      description:
        'Retry a blocked, cancelled, or done task, optionally with an updated description; returns the restarted task.',
      paramsDoc: 'task_id, description? (retryable statuses: blocked, cancelled, done)',
      auditRedactKeys: ['description'],
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
      autonomyRequirement: cancelTaskAutonomy,
      handler: (args) => handlers.cancel_task(args),
    }),
    defineAction({
      name: 'reassign_task',
      family: 'tasks',
      safetyClass: 'mutate',
      description:
        'Validate a reassignment request for an open, blocked, cancelled, or done task; returns the task unchanged — assignment mutation is not implemented (fields removed in M71).',
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
        'Archive a task — the true terminal state; archived tasks are excluded from default task listings and cannot be reactivated.',
      paramsDoc: 'task_id',
      paramsSchema: ArchiveTaskSchema,
      autonomyRequirement: archiveTaskAutonomy,
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
      auditRedactKeys: ['message'],
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
      autonomyRequirement: HUMAN_ONLY_AUTONOMY_LEVEL,
      handler: (args) => handlers.approve_pending_completion(args),
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

  const forgeEntries: ActionDefinition[] = [
    defineAction({
      name: 'create_forge_scope',
      family: 'forge',
      safetyClass: 'mutate',
      description:
        'Create a Forge scope, optionally linked to a recurring goal, with policy for judge guidance; returns the created scope.',
      paramsDoc: 'kind, name, objective, goal_id?, parent_scope_id?, metric_definitions?, policy?',
      paramsSchema: CreateForgeScopeSchema,
      auditRedactKeys: ['objective', 'metric_definitions', 'policy'],
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
      auditRedactKeys: ['objective', 'metric_definitions', 'policy'],
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
      auditRedactKeys: ['objective', 'metric_definitions', 'policy', 'policy_patch'],
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
      auditRedactKeys: ['summary', 'metadata'],
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
      auditRedactKeys: ['summary', 'metadata'],
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
      auditRedactKeys: ['summary', 'metadata'],
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
      auditRedactKeys: ['note', 'summary', 'metadata', 'values'],
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
      auditRedactKeys: ['title', 'outcome_summary'],
      autonomyRequirement: forgeEpisodeUpdateAutonomy,
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
      auditRedactKeys: ['rule', 'why'],
      autonomyRequirement: forgeLessonUpdateAutonomy,
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
      auditRedactKeys: ['description', 'reason'],
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
      auditRedactKeys: ['description', 'reason'],
      autonomyRequirement: forgeProposalUpdateAutonomy,
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
      auditRedactKeys: ['title', 'description', 'reason'],
      autonomyRequirement: DESTRUCTIVE_ACTION_AUTONOMY_LEVEL,
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
      auditRedactKeys: ['goal_update'],
      autonomyRequirement: DESTRUCTIVE_ACTION_AUTONOMY_LEVEL,
      handler: (args) => handlers.apply_forge_rollup(args),
    }),
  ];

  const entries = config.db
    ? [
        ...agentLifecycleEntries,
        ...sessionEntries,
        ...workflowEntries,
        ...taskEntries,
        ...partCEntries,
      ]
    : [...workflowEntries, ...taskEntries, ...partCEntries];
  if (config.goalService) entries.push(...goalEntries);
  if (config.evolutionScopeService && config.evolutionEpisodeService) entries.push(...forgeEntries);
  if (config.callerRole === 'long_term_agent' || config.callerRole === 'coordinator')
    entries.push(reviewGoalOutcomeEntry);
  return config.taskAgentManager
    ? entries
    : entries.filter((entry) => entry.name !== 'send_message_to_task');
}
