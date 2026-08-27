import {
  ChangePlanSchema,
  CreateScheduledTaskSchema,
  DeleteScheduledTaskSchema,
  GetExternalEventSchema,
  GetScheduledTaskSchema,
  GetSessionDetailSchema,
  GetSessionMessagesSchema,
  GetWorkflowDetailSchema,
  GetWorkflowRunSchema,
  InactivityConfigGetSchema,
  InactivityConfigSetEnabledSchema,
  InactivityConfigSetSchema,
  InactivityRunNowSchema,
  InterruptSessionSchema,
  ListScheduledTasksSchema,
  ListSessionsSchema,
  ListWorkflowsSchema,
  PauseScheduledTaskSchema,
  ResumeScheduledTaskSchema,
  SendSessionMessageSchema,
  SuggestWorkflowSchema,
  UpdateSessionStateSchema,
} from '../tools/space-agent-tool-schemas.ts';
import {
  createSpaceAgentToolHandlers,
  DEFAULT_INACTIVITY_THRESHOLD_MS,
  type SpaceAgentToolsConfig,
} from '../tools/space-agent-tools.ts';
import { SESSION_WRITE_AUTONOMY_LEVEL } from '../tools/tool-admission-gates.ts';
import { jsonResult } from '../tools/tool-result.ts';
import { type ActionDefinition, defineAction } from './registry.ts';

export function createSpaceRegistryEntries(config: SpaceAgentToolsConfig): ActionDefinition[] {
  const handlers = createSpaceAgentToolHandlers({ ...config, auditLogRepo: undefined });

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

  const baseEntries = config.db ? [...sessionEntries, ...workflowEntries] : [...workflowEntries];
  const entries = [...baseEntries, ...partCEntries];
  return config.taskAgentManager
    ? entries
    : entries.filter((entry) => entry.name !== 'send_message_to_task');
}
