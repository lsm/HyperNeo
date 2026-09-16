import {
  isRateOrUsageLimited,
  isWorkflowRecoveryTransition,
  type SpaceTaskStatus,
} from '@hyperneo/shared';
import type { z } from 'zod';
import type { OperationRegistrySource } from '../../operations/registry.ts';
import { hasSpaceAuthority } from '../runtime/space-mcp-session-policy.ts';
import { normalizeReplyTargetHandle } from '../../messaging/agent-handle.ts';
import {
  HUMAN_ONLY_AUTONOMY_LEVEL,
  SESSION_WRITE_AUTONOMY_LEVEL,
} from '../tools/tool-admission-gates.ts';
import { jsonResult } from '../tools/tool-result.ts';
import {
  type CreateStandaloneTaskParams,
  mapCreateTaskParams,
} from '../../tasks/create-task-params.ts';
import { RestoreNodeAgentSchema } from './node-agent-schemas.ts';
import { createOperationActionHandler } from './operation-action.ts';
import { type ActionDefinition, defineAction } from './registry.ts';
import {
  ApprovePendingCompletionSchema,
  ApproveTaskSchema,
  ArchiveAgentSchema,
  AssignAgentToForgeScopeSchema,
  AssignAgentToGoalSchema,
  ChangePlanSchema,
  CreateAgentFromTemplateSchema,
  CreateAgentReminderSchema,
  CreateAgentSchema,
  CreateAgentTemplateSchema,
  CreateGoalSchema,
  CreateStandaloneTaskSchema,
  DeleteAgentTemplateSchema,
  GetAgentSchema,
  GetExternalEventSchema,
  GetWorkflowDetailSchema,
  GetWorkflowRunSchema,
  InactivityConfigGetSchema,
  InactivityConfigSetEnabledSchema,
  InactivityConfigSetSchema,
  InactivityRunNowSchema,
  ListAgentEventSubscriptionsSchema,
  ListAgentRemindersSchema,
  ListAgentsSchema,
  ListAgentTemplatesSchema,
  ListTasksSchema,
  ListWorkflowsSchema,
  PauseAgentSchema,
  PauseGoalSchema,
  ReassignTaskSchema,
  ResumeGoalSchema,
  ReviewGoalOutcomeSchema,
  SendMessageToTaskSchema,
  SubscribeAgentEventSchema,
  SuggestWorkflowSchema,
  TriggerGoalTaskSchema,
  UnassignAgentFromForgeScopeSchema,
  UnassignAgentFromGoalSchema,
  UnsubscribeAgentEventSchema,
  UpdateAgentSchema,
  UpdateAgentTemplateSchema,
  UpdateGoalSchema,
  UpdateTaskSchema,
} from './space-agent-schemas.ts';
import { DEFAULT_INACTIVITY_THRESHOLD_MS } from '../../external-events/inactivity-operations.ts';
import { createSpaceAgentToolHandlers, type SpaceAgentToolsConfig } from './space-handlers.ts';

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

export function createSpaceRegistryEntries(
  config: SpaceAgentToolsConfig,
  operations?: OperationRegistrySource
): ActionDefinition[] {
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
      const tearsDownLiveSessions =
        (params.status === 'done' || params.status === 'blocked') &&
        (!!task.taskAgentSessionId ||
          !!task.postApprovalSessionId ||
          runHasLiveSessions(task.workflowRunId));
      if (tearsDownLiveSessions) return DESTRUCTIVE_ACTION_AUTONOMY_LEVEL;
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

  const runHasLiveSessions = (workflowRunId: string): boolean => {
    const hasLiveExecution = config.nodeExecutionRepo
      .listByWorkflowRun(workflowRunId)
      .some((execution) => !!execution.agentSessionId && execution.status !== 'cancelled');
    if (hasLiveExecution) return true;
    const runTaskIds = config.taskRepo.listByWorkflowRun(workflowRunId).map((t) => t.id);
    return (config.taskAgentManager?.getLiveSubSessionIdsForTasks(runTaskIds).length ?? 0) > 0;
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
      auditRedactKeys: ['custom_prompt', 'description'],
      handler: (args) => handlers.create_agent(args),
    }),
    defineAction({
      name: 'create_agent_from_template',
      family: 'agents',
      safetyClass: 'mutate',
      description:
        'Create a long-horizon agent from a long-horizon template key, seeding suggested subscriptions and reminders; returns the created agent.',
      paramsDoc: 'template_name, name?, model?, provider?, thinking_level?',
      paramsSchema: CreateAgentFromTemplateSchema,
      handler: (args) => handlers.create_agent_from_template(args),
    }),
    defineAction({
      name: 'create_agent_template',
      family: 'agents',
      safetyClass: 'mutate',
      description:
        'Create a reusable agent template (prompt, model settings, tool allowlist, labels, suggested autonomy); optional from_agent_id derives defaults from an existing agent; returns the created template.',
      paramsDoc:
        'key, handle, display_name?, description?, instructions?, labels?, suggested_autonomy_level?, model?, provider?, model_pool?, thinking_level?, setting_sources?, tools?, from_agent_id?',
      paramsSchema: CreateAgentTemplateSchema,
      auditRedactKeys: ['instructions', 'description'],
      handler: (args) => handlers.create_agent_template(args),
    }),
    defineAction({
      name: 'update_agent_template',
      family: 'agents',
      safetyClass: 'mutate',
      description:
        'Update a user-authored agent template by key with compare-and-swap versioning; built-in templates are code-defined and rejected; returns the updated template with its new version.',
      paramsDoc:
        'key, expected_version?, display_name?, description?, instructions?, labels?, model?, provider?, model_pool?, thinking_level?, setting_sources?, tools? (null clears)',
      paramsSchema: UpdateAgentTemplateSchema,
      auditRedactKeys: ['instructions', 'description'],
      handler: (args) => handlers.update_agent_template(args),
    }),
    defineAction({
      name: 'list_agent_templates',
      family: 'agents',
      safetyClass: 'read',
      description:
        'List the merged agent template library: built-in templates plus user-authored templates; entries carry labels and a builtin flag.',
      paramsDoc: 'none',
      paramsSchema: ListAgentTemplatesSchema,
      handler: () => handlers.list_agent_templates(),
    }),
    defineAction({
      name: 'delete_agent_template',
      family: 'agents',
      safetyClass: 'destructive',
      description:
        'Permanently delete a user-authored agent template by key; optional CAS version fails the delete on concurrent modification; workflow references do not block deletion — a run that pinned a template snapshot resolves from that copy, while a run without one may fail to activate a later node, and saved workflows still naming the key must be re-pointed or their future runs cannot activate that slot.',
      paramsDoc: 'key, expected_version?',
      paramsSchema: DeleteAgentTemplateSchema,
      autonomyRequirement: DESTRUCTIVE_ACTION_AUTONOMY_LEVEL,
      handler: (args) => handlers.delete_agent_template(args),
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
      auditRedactKeys: ['custom_prompt', 'description'],
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
        'Assign a long-horizon agent to own a goal (admission-checked for Space agent session authorization); returns success.',
      paramsDoc: 'agent_id, goal_id',
      paramsSchema: AssignAgentToGoalSchema,
      handler: (args) => handlers.assign_agent_to_goal(args),
    }),
    defineAction({
      name: 'unassign_agent_from_goal',
      family: 'agents',
      safetyClass: 'mutate',
      description:
        'Remove a long-horizon agent goal ownership (admission-checked for Space agent session authorization); returns success.',
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

  if (config.onRestoreNodeAgent) {
    const restoreCallback = config.onRestoreNodeAgent;
    partCEntries.push(
      defineAction({
        name: 'restore_node_agent',
        family: 'sessions',
        safetyClass: 'mutate',
        description:
          'Self-heal: re-attach this session’s node MCP server and restart the query so the restored tool surface takes effect; the current turn is interrupted, retry the failed call afterwards.',
        paramsDoc: 'reason?',
        paramsSchema: RestoreNodeAgentSchema,
        handler: async (args) => {
          try {
            await restoreCallback({ reason: args.reason });
          } catch {}
          return jsonResult({
            success: true,
            message:
              'node MCP server re-attached and query restarted; retry the failed tool call in the next turn.',
          });
        },
      })
    );
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
      handler: operations
        ? createOperationActionHandler(
            operations,
            { sessionId: config.mySessionId },
            'task.list',
            async (params) => {
              const typed = params as {
                status?: SpaceTaskStatus;
                workflow_run_id?: string;
                search?: string;
                limit?: number;
                offset?: number;
              };
              if (typed.workflow_run_id) {
                const run = config.workflowRunRepo.getRun(typed.workflow_run_id);
                if (!run || run.spaceId !== config.spaceId) {
                  return { reject: `Workflow run not found: ${typed.workflow_run_id}` };
                }
              }
              return {
                spaceId: config.spaceId,
                status: typed.status,
                workflowRunId: typed.workflow_run_id,
                search: typed.search,
                limit: typed.limit,
                offset: typed.offset,
              };
            },
            (value, originalParams) => {
              const page = value as { tasks: unknown[]; total: number };
              const compact = (originalParams as { compact?: boolean }).compact;
              const tasks = compact
                ? page.tasks.map((t) => ({
                    id: (t as { id: string }).id,
                    title: (t as { title: string }).title,
                    status: (t as { status: string }).status,
                    priority: (t as { priority: string }).priority,
                    createdAt: (t as { createdAt: number }).createdAt,
                  }))
                : page.tasks;
              return { success: true, total: page.total, tasks };
            }
          )
        : (args) => handlers.list_tasks(args),
    }),
    defineAction({
      name: 'create_standalone_task',
      family: 'tasks',
      safetyClass: 'mutate',
      description:
        'Create a task the runtime may attach a workflow to, through the shared task.create operation; supports dependencies, draft mode, and workspace selection; returns the created task core.',
      paramsDoc:
        'title, description, priority?, workflow_id?/workflow_handle?, depends_on? (task ids), draft?, workspace?',
      auditRedactKeys: ['description'],
      paramsSchema: CreateStandaloneTaskSchema,
      handler: operations
        ? createOperationActionHandler(
            operations,
            { sessionId: config.mySessionId },
            'task.create',
            (params) => mapCreateTaskParams(params as CreateStandaloneTaskParams, config)
          )
        : (args) => handlers.create_standalone_task(args),
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
      name: 'send_message_to_task',
      family: 'tasks',
      safetyClass: 'mutate',
      description:
        'Message a workflow node agent or long-term agent on a task, activating or queueing it when supported; returns the delivery outcome.',
      paramsDoc:
        'task_id or task_number, message, node_id? or target? (@handle/@role/@session/@worker)',
      paramsSchema: SendMessageToTaskSchema,
      auditRedactKeys: ['message'],
      handler: operations
        ? createOperationActionHandler(
            operations,
            { sessionId: config.mySessionId },
            'task.message.send',
            (params) => {
              const typed = params as z.infer<typeof SendMessageToTaskSchema>;
              const outboundSenderName = config.myAgentName ?? 'space-member';
              const callerHasSpaceAuthority = hasSpaceAuthority(config.callerRole);
              const outboundSenderLevel =
                outboundSenderName === 'task-agent'
                  ? 'task-agent'
                  : callerHasSpaceAuthority && config.myAgentId
                    ? 'long-horizon-agent'
                    : 'session-agent';
              const outboundSenderDisplayName = outboundSenderName;
              const outboundReplyTargetHandle = config.myAgentName
                ? (normalizeReplyTargetHandle(config.myAgentNameAliases?.[0] ?? '') ??
                  normalizeReplyTargetHandle(outboundSenderName))
                : config.mySessionId
                  ? `@session:${config.mySessionId}`
                  : normalizeReplyTargetHandle(outboundSenderName);
              return {
                spaceId: config.spaceId,
                ...(typed.task_id
                  ? { taskId: typed.task_id }
                  : typed.task_number
                    ? { taskNumber: typed.task_number }
                    : {}),
                message: typed.message,
                ...(typed.node_id ? { nodeId: typed.node_id } : {}),
                ...(typed.target ? { target: typed.target } : {}),
                mySessionId: config.mySessionId,
                outboundSenderLevel,
                outboundSenderDisplayName,
                outboundReplyTargetHandle,
              };
            }
          )
        : (args) => handlers.send_message_to_task(args),
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
        'Approve or reject a task paused at the submit_for_approval checkpoint; long-horizon agent and legacy task-agent sessions only; returns the updated task.',
      paramsDoc: 'task_id, approved (true approves, false rejects to in_progress), reason?',
      paramsSchema: ApprovePendingCompletionSchema,
      autonomyRequirement: HUMAN_ONLY_AUTONOMY_LEVEL,
      handler: (args) => handlers.approve_pending_completion(args),
    }),
  ];

  const goalEntries: ActionDefinition[] = [
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
    ? [...agentLifecycleEntries, ...workflowEntries, ...taskEntries, ...partCEntries]
    : [...workflowEntries, ...taskEntries, ...partCEntries];
  if (config.goalService) entries.push(...goalEntries);
  if (hasSpaceAuthority(config.callerRole)) entries.push(reviewGoalOutcomeEntry);
  return config.taskAgentManager
    ? entries
    : entries.filter((entry) => entry.name !== 'send_message_to_task');
}
