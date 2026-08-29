import {
  isRateOrUsageLimited,
  isWorkflowRecoveryTransition,
  type SpaceTaskStatus,
} from '@hyperneo/shared';
import type { z } from 'zod';
import {
  ApprovePendingCompletionSchema,
  ApproveTaskSchema,
  ArchiveTaskSchema,
  CancelTaskSchema,
  ChangePlanSchema,
  CreateGoalSchema,
  CreateScheduledTaskSchema,
  CreateStandaloneTaskSchema,
  DeleteScheduledTaskSchema,
  GetExternalEventSchema,
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
  ListGoalEventsSchema,
  ListGoalsSchema,
  ListGoalTasksSchema,
  ListScheduledTasksSchema,
  ListSessionsSchema,
  ListTaskMembersSchema,
  ListTasksSchema,
  ListWorkflowsSchema,
  PauseGoalSchema,
  PauseScheduledTaskSchema,
  PublishTaskSchema,
  ReassignTaskSchema,
  ResumeGoalSchema,
  ResumeScheduledTaskSchema,
  ReviewGoalOutcomeSchema,
  RetryTaskSchema,
  SendMessageToTaskSchema,
  SendSessionMessageSchema,
  SuggestWorkflowSchema,
  TriggerGoalTaskSchema,
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

  const entries = config.db
    ? [...sessionEntries, ...workflowEntries, ...taskEntries, ...partCEntries]
    : [...workflowEntries, ...taskEntries, ...partCEntries];
  if (config.goalService) entries.push(...goalEntries);
  if (config.callerRole === 'long_term_agent' || config.callerRole === 'coordinator')
    entries.push(reviewGoalOutcomeEntry);
  return config.taskAgentManager
    ? entries
    : entries.filter((entry) => entry.name !== 'send_message_to_task');
}
