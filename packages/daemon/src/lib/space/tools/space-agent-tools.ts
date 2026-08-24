import type { Database as BunDatabase } from '../../../storage/sqlite-compat';
import type { SdkMcpToolDefinition } from '@anthropic-ai/claude-agent-sdk';
import { createSdkMcpServer, tool } from '@anthropic-ai/claude-agent-sdk';
import {
  generateUUID,
  getWorkflowRunExecutionStatusLabel,
  isKnownToolEntry,
  isWorkflowRecoveryTransition,
  KNOWN_TOOLS,
} from '@hyperneo/shared';
import type {
  CreateEvolutionEpisodeParams,
  EvolutionEpisodeStatus,
  EvolutionLessonStatus,
  EvolutionPolicy,
  EvolutionScopeKind,
  MetricDefinition,
  MetricSnapshotValues,
  NodeExecution,
  QuestionDraftResponse,
  SpaceGoalStatus,
  SpaceGoalType,
  SpaceAgentAutonomyLevel,
  SpaceApprovalSource,
  SpaceLongHorizonAgent,
  SpaceLongHorizonAgentStatus,
  SpaceLongHorizonAgentTemplate,
  SpaceTask,
  SpaceTaskPriority,
  UpdateSpaceTaskParams,
  WorkflowRunStatus,
  SpaceTaskStatus,
  TaskProposalStatus,
  TaskScheduleStatus,
  TaskScheduleTriggerType,
} from '@hyperneo/shared';
import { parseAddress } from '../../../../../messaging/src/address';
import { z } from 'zod';
import type { McpAuditLogRepository } from '../../../storage/repositories/mcp-audit-log-repository';
import type { NodeExecutionRepository } from '../../../storage/repositories/node-execution-repository';
import type { SpaceLongHorizonAgentRepository } from '../../../storage/repositories/space-long-horizon-agent-repository';
import type { SpaceTaskRepository } from '../../../storage/repositories/space-task-repository';
import type { SpaceWorkflowRunRepository } from '../../../storage/repositories/space-workflow-run-repository';
import type { AgentSession } from '../../agent/agent-session';
import type { DaemonInternalEventMap, InternalEventBus } from '../../internal-event-bus';
import { Logger } from '../../logger';
import type { SessionManager } from '../../session/session-manager';
import type { PendingAgentMessageQueue } from '../../rpc-handlers/space-task-message-handlers';
import { requireAgentFamily } from '../agents/agent-family-resolver';
import { formatAgentMessage } from '../agent-message-envelope';
import { getLongHorizonAgentTemplates } from '../agents/long-horizon-agent-templates';
import { getPresetAgentTemplates } from '../agents/seed-agents';
import { getNextRunAt, isValidCronExpression } from '../schedule/cron-utils';
import { mergeEvolutionPolicy } from '../evolution-scope-service';
import { validateGoalAutomationSelfNagPolicy } from '../goals/evolution-policy-validation';
import { syncGoalAutomationSelfNagScheduleForScope } from '../goals/goal-automation-schedule-sync';
import { SpaceDeliveryFacade, translateTaskMessageTarget } from '../messaging-adapter';
import type { SpaceAgentManager } from '../managers/space-agent-manager';
import type { SpaceManager } from '../managers/space-manager';
import {
  assertValidSpaceTaskTransition,
  type SpaceTaskManager,
} from '../managers/space-task-manager';
import type { SpaceWorkflowManager } from '../managers/space-workflow-manager';
import type { ReplyRoutingRegistry } from '../runtime/reply-routing-registry';
import type { ActorRef, MessageRecord } from '../../../../../messaging/src/types';
import type { ActorResolver } from '../../../../../messaging/src/contracts';
import type { SpaceRuntime } from '../runtime/space-runtime';
import type { TaskAgentManager } from '../runtime/task-agent-manager';
import { mapPostApprovalDispatchWarning } from '../runtime/post-approval-router';
import type { SpaceMcpSessionRole } from '../runtime/space-mcp-session-policy';
import { decideGoalOwnershipMutationAdmission } from '../goals/goal-ownership-gates';
import type { ToolResult } from './tool-result';
import { jsonResult } from './tool-result';
import { decideUpdateTask } from './space-tool-pipeline';
import {
  routeApproveTask,
  routeArchiveTask,
  routeCancelTask,
  routeCreateTaskWorkflowRef,
  routePublishTask,
  routeReassignTask,
  routeRetryTask,
} from './task-transition-routing';
import {
  decideAutonomyAdmission,
  getToolAutonomyRequirement,
  resolveEffectiveAutonomyLevel,
} from './tool-admission-gates';
import { SpaceTaskStatusSchema, UpdateTaskStatusParamDescription } from './task-agent-tool-schemas';
import { validateGlobPattern, validateSource } from '../../external-events/topic-validator';
import type { ExternalEventStore } from '../../external-events/external-event-store';
import { getAvailableModels, getModelInfoUnfiltered, isValidModel } from '../../model-service';
import { normalizeMeaningfulTaskResult } from '../task-result-utils';
import { RESERVED_SPACE_AGENT_HANDLES, slugifyWithinLimit } from '../slug';
import {
  isReservedAgentHandle,
  normalizeAgentNameToken,
  normalizeReplyTargetHandle,
} from '../agent-handle';

const log = new Logger('space-agent-tools');

function workflowRunAttemptLabel(status: WorkflowRunStatus): string {
  return getWorkflowRunExecutionStatusLabel(status).toLowerCase();
}

type LongHorizonAgentUpdateArgs = {
  name?: string;
  status?: SpaceLongHorizonAgentStatus;
  description?: string | null;
  model?: string | null;
  thinking_level?: SpaceLongHorizonAgent['thinkingLevel'] | null;
  provider?: string | null;
  custom_prompt?: string | null;
  tools?: string[] | null;
  setting_sources?: SpaceLongHorizonAgent['settingSources'] | null;
};

type SkippedTemplateSubscription = {
  source: string;
  topic: string;
  reason: string;
};

type SkippedTemplateReminder = {
  title: string;
  reason: string;
};

export function validateTemplateReminder(
  reminder: SpaceLongHorizonAgentTemplate['reminderDefaults'][number]
): { ok: true } | { ok: false; reason: string } {
  if (reminder.triggerType === 'cron') {
    const cronExpression = reminder.cronExpression?.trim() ?? '';
    if (cronExpression === '') {
      return { ok: false, reason: 'cron reminder is missing cronExpression' };
    }
    if (!isValidCronExpression(cronExpression)) {
      return { ok: false, reason: `invalid cron expression "${cronExpression}"` };
    }
  }
  return { ok: true };
}

type GoalToolUpdateArgs = {
  title?: string;
  description?: string;
  status?: SpaceGoalStatus;
  type?: SpaceGoalType;
  priority?: SpaceTaskPriority;
  labels?: string[];
  metrics?: Record<string, string | number | boolean | null>;
  summary?: string;
  progress?: number;
  next_steps?: string[];
  preferred_workflow_id?: string | null;
  auto_trigger_next?: boolean;
  check_in_cron_expression?: string | null;
  check_in_timezone?: string;
};

type SpaceSessionStatusFilter = 'active' | 'idle' | 'waiting_for_input' | 'error' | 'archived';
type SpaceSessionTypeFilter = 'worker' | 'ad-hoc';
type MutableProcessingState = 'idle' | 'running' | 'waiting_for_input';

type SpaceSessionRow = {
  id: string;
  title: string;
  workspace_path: string | null;
  created_at: string;
  last_active_at: string;
  status: string;
  metadata: string | null;
  is_worktree: number;
  git_branch: string | null;
  processing_state: string | null;
  type: string | null;
  session_context: string | null;
};

type SpaceSessionSummary = {
  id: string;
  title: string;
  status: string;
  type: SpaceSessionTypeFilter;
  processing_state: unknown;
  created_at: string;
  last_active_at: string;
  is_worktree: boolean;
  git_branch: string | null;
  workspace_path: string | null;
};

const SPACE_SESSION_MAX_LIMIT = 100;
const SPACE_SESSION_DEFAULT_LIMIT = 50;
const SESSION_DETAIL_MESSAGE_LIMIT = 5;
const SESSION_MESSAGE_DEFAULT_LIMIT = 20;
const SESSION_MESSAGE_MAX_LIMIT = 100;

function normalizeGoalUpdateArgs(args: GoalToolUpdateArgs) {
  return {
    title: args.title,
    description: args.description,
    status: args.status,
    type: args.type,
    priority: args.priority,
    labels: args.labels,
    metrics: args.metrics,
    summary: args.summary,
    progress: args.progress,
    nextSteps: args.next_steps,
    preferredWorkflowId: args.preferred_workflow_id,
    autoTriggerNext: args.auto_trigger_next,
    checkInCronExpression: args.check_in_cron_expression,
    checkInTimezone: args.check_in_timezone,
  };
}

function validateTools(tools: string[]): string | null {
  const invalid = tools.filter((toolName) => !isKnownToolEntry(toolName));
  if (invalid.length === 0) return null;
  return `Unknown tool${invalid.length > 1 ? 's' : ''}: ${invalid
    .map((toolName) => `"${toolName}"`)
    .join(
      ', '
    )}. Valid tools: ${KNOWN_TOOLS.join(', ')} or scoped Bash entries like 'Bash(gh pr view:*)'`;
}

async function validateLongHorizonModel(
  model: string,
  provider?: string | null
): Promise<string | null> {
  const available = getAvailableModels('global');
  if (available.length === 0) return null;

  if (provider) {
    const valid = await isValidModel(model, 'global', provider);
    return valid ? null : `Unrecognized model "${model}" for provider "${provider}"`;
  }

  const info = await getModelInfoUnfiltered(model, 'global');
  return info ? null : `Unrecognized model: "${model}"`;
}

function compactLongHorizonAgent(agent: {
  id: string;
  handle: string;
  displayName: string;
  status: string;
  model: string | null;
  provider: string | null;
  thinkingLevel: string | null;
  templateKey: string | null;
  updatedAt: number;
}) {
  return {
    id: agent.id,
    handle: agent.handle,
    displayName: agent.displayName,
    status: agent.status,
    model: agent.model,
    provider: agent.provider,
    thinkingLevel: agent.thinkingLevel,
    templateKey: agent.templateKey,
    updatedAt: agent.updatedAt,
  };
}

function mcpReminderShape(reminder: {
  id: string;
  agentId: string;
  title: string;
  body?: string | null;
  status: string;
  runAt: number | null;
  nextRunAt?: number | null;
  createdAt?: number;
  updatedAt?: number;
}) {
  const remindAt = reminder.runAt ?? reminder.nextRunAt ?? null;
  return {
    ...reminder,
    message: reminder.title,
    remind_at: remindAt,
    status: reminder.status === 'fired' ? 'done' : reminder.status,
  };
}

function resolveNodeExecution(executions: NodeExecution[], selector: string): NodeExecution | null {
  const trimmed = selector.trim();
  if (!trimmed) return null;
  const byId = executions.find((exec) => exec.id === trimmed);
  if (byId) return byId;

  const targetName = normalizeAgentNameToken(trimmed);
  const byName = executions.filter(
    (exec) => normalizeAgentNameToken(exec.agentName) === targetName
  );
  return byName.at(-1) ?? null;
}

function resolveWorkerTargetExecution(
  executions: NodeExecution[],
  workflowRunId: string,
  workflowNodeNameById: Map<string, string>,
  target: string
): NodeExecution | null {
  const address = parseAddress(target);
  if (address.kind !== 'worker' || !address.agentName) return null;
  if (address.workflowRunId && address.workflowRunId !== workflowRunId) return null;
  let nodeName: string;
  let agentName: string;
  try {
    nodeName = decodeURIComponent(address.nodeId);
    agentName = decodeURIComponent(address.agentName);
  } catch {
    return null;
  }
  const matches = executions.filter(
    (exec) =>
      normalizeAgentNameToken(exec.agentName) === normalizeAgentNameToken(agentName) &&
      (workflowNodeNameById.get(exec.workflowNodeId) === nodeName ||
        exec.workflowNodeId === nodeName)
  );
  return matches.at(-1) ?? null;
}

type TaskRoutingTargetResolution =
  | { kind: 'task-worker'; exec: NodeExecution }
  | { kind: 'long-horizon-agent'; actor: ActorRef }
  | { kind: 'ambiguous'; actors: ActorRef[]; exec?: NodeExecution }
  | { kind: 'no-match' };

async function resolveHandleForTaskRouting(
  target: string,
  taskExecutions: NodeExecution[],
  spaceId: string,
  workflowRunId: string,
  messageResolver?: ActorResolver,
  longHorizonAgentRepo?: SpaceLongHorizonAgentRepository
): Promise<TaskRoutingTargetResolution> {
  const address = parseAddress(target);
  if (address.kind !== 'handle') return { kind: 'no-match' };

  const handle = `@${address.handle}`;
  const canonicalHandle = `@${normalizeAgentNameToken(address.handle)}`;
  const taskWorker =
    taskExecutions
      .filter(
        (exec) =>
          exec.workflowRunId === workflowRunId &&
          normalizeAgentNameToken(exec.agentName) === normalizeAgentNameToken(address.handle)
      )
      .at(-1) ?? null;
  const actors = messageResolver
    ? (
        await messageResolver.resolveTargets({
          messageId: `msg_probe_${Date.now()}`,
          spaceId,
          senderActorId: 'system:routing-validation',
          targets: [canonicalHandle],
          body: '',
          kind: 'message',
          workflowRunId,
          createdAt: Date.now(),
        })
      ).resolved
        .map((resolved) => resolved.actor)
        .filter(
          (actor) =>
            actor.handle !== undefined &&
            normalizeAgentNameToken(actor.handle) === normalizeAgentNameToken(handle)
        )
    : [];
  const longHorizonActors = actors.filter((actor) => {
    if (actor.actorId.startsWith('system:')) return true;
    if (!actor.actorId.startsWith('agent:')) return false;
    if (actor.actorId === `agent:coordinator:${spaceId}`) return taskWorker !== null;
    if (!longHorizonAgentRepo) return true;
    const agentId = decodeURIComponent(actor.actorId.slice('agent:'.length));
    return longHorizonAgentRepo.getById(agentId)?.spaceId === spaceId;
  });

  if (taskWorker && longHorizonActors.length === 0)
    return { kind: 'task-worker', exec: taskWorker };
  if (taskWorker || longHorizonActors.length > 1)
    return { kind: 'ambiguous', actors: longHorizonActors, exec: taskWorker ?? undefined };
  if (longHorizonActors.length === 1)
    return { kind: 'long-horizon-agent', actor: longHorizonActors[0] };
  return { kind: 'no-match' };
}

function describeTaskExecution(exec: NodeExecution): string {
  return `workflow node "${exec.agentName}" (${exec.id})`;
}

function describeActor(actor: ActorRef): string {
  return `${actor.handle ?? actor.actorId} (${actor.actorId})`;
}

function describeAmbiguousTargetActors(actors: ActorRef[], exec?: NodeExecution): string {
  return [
    ...actors.map((actor) => `- ${describeActor(actor)}`),
    ...(exec ? [`- ${describeTaskExecution(exec)}`] : []),
  ].join('\n');
}

export interface SpaceAgentToolsConfig {
  spaceId: string;
  db?: BunDatabase;
  longHorizonAgentRepo?: SpaceLongHorizonAgentRepository;
  runtime: SpaceRuntime;
  workflowManager: SpaceWorkflowManager;
  spaceManager?: Pick<SpaceManager, 'getSpace'>;
  taskRepo: SpaceTaskRepository;
  nodeExecutionRepo: NodeExecutionRepository;
  workflowRunRepo: SpaceWorkflowRunRepository;
  isWorkflowRunActive?: (runId: string) => boolean;
  taskManager: SpaceTaskManager;
  spaceAgentManager: SpaceAgentManager;
  sessionManager?: Pick<SessionManager, 'getCachedSession' | 'getSessionAsync' | 'sendUserMessage'>;
  clearLongTermAgentSessionProvider?: (spaceId: string, agentId: string) => Promise<void>;
  getRuntimeSession?: (sessionId: string) => AgentSession | undefined;
  taskAgentManager?: TaskAgentManager;
  internalEventBus?: InternalEventBus<DaemonInternalEventMap>;
  activateNode?: (runId: string, nodeId: string) => Promise<void>;
  pendingMessageQueue?: PendingAgentMessageQueue;
  getSpaceAutonomyLevel?: (spaceId: string) => Promise<number>;
  myAgentName?: string;
  myAgentNameAliases?: string[];
  myAgentId?: string;
  mySessionId?: string;
  callerRole?: SpaceMcpSessionRole;

  onRestoreNodeAgent?: (args: { reason?: string }) => Promise<void> | void;
  auditLogRepo?: McpAuditLogRepository;
  scheduleService?: import('../schedule/schedule-service').ScheduleService;
  replyRoutingRegistry?: ReplyRoutingRegistry;
  goalService?: import('../goals/goal-service').SpaceGoalService;
  evolutionScopeService?: import('../evolution-scope-service').EvolutionScopeService;
  goalRepo?: import('../../../storage/repositories/space-goal-repository').SpaceGoalRepository;
  evolutionEpisodeService?: import('../evolution-episode-service').EvolutionEpisodeService;
  messageResolver?: ActorResolver;
  longTermAgentDelivery?: {
    deliverToSession?: (
      actor: ActorRef,
      message: MessageRecord
    ) => Promise<string | null | undefined>;
    queueForActivation?: (
      actor: ActorRef,
      message: MessageRecord
    ) => Promise<string | null | undefined>;
  };
  externalEventStore?: ExternalEventStore;
}

export function createSpaceAgentToolHandlers(config: SpaceAgentToolsConfig) {
  const {
    spaceId,
    runtime,
    workflowManager,
    taskRepo,
    nodeExecutionRepo,
    workflowRunRepo,
    taskManager,
    spaceAgentManager,
    taskAgentManager,
    internalEventBus,
    activateNode,
    pendingMessageQueue,
    getSpaceAutonomyLevel,
    myAgentName,
    myAgentNameAliases,
    myAgentId,
    mySessionId,
    callerRole,
    replyRoutingRegistry,
    messageResolver,
    longTermAgentDelivery,
  } = config;

  const outboundSenderName = myAgentName ?? (mySessionId ? 'space-member' : 'space-agent');
  const isCoordinatorAgent =
    !mySessionId ||
    (typeof myAgentName === 'string' &&
      ['space-agent', 'coordinator'].includes(normalizeAgentNameToken(myAgentName)));
  const outboundSenderLevel =
    outboundSenderName === 'task-agent'
      ? 'task-agent'
      : isCoordinatorAgent
        ? 'space-agent'
        : 'session-agent';
  const outboundSenderDisplayName = outboundSenderName;
  const outboundReplyTargetHandle = myAgentName
    ? (normalizeReplyTargetHandle(myAgentNameAliases?.[0] ?? '') ??
      normalizeReplyTargetHandle(outboundSenderName))
    : mySessionId
      ? `@session:${mySessionId}`
      : normalizeReplyTargetHandle(outboundSenderName);

  function requireGoalService() {
    if (!config.goalService) throw new Error('Goal management not available');
    return config.goalService;
  }

  function requireGoalInSpace(goalId: string) {
    const goal = requireGoalService().getGoal(goalId);
    if (!goal || goal.spaceId !== spaceId) throw new Error(`Goal not found: ${goalId}`);
    return goal;
  }

  function requireEvolutionScopeService() {
    if (!config.evolutionScopeService) throw new Error('Forge scope management not available');
    return config.evolutionScopeService;
  }

  function requireEvolutionEpisodeService() {
    if (!config.evolutionEpisodeService) throw new Error('Forge episode management not available');
    return config.evolutionEpisodeService;
  }

  function requireEvolutionScopeInSpace(scopeId: string) {
    const scope = requireEvolutionScopeService().getScope(scopeId);
    if (!scope || scope.spaceId !== spaceId)
      throw new Error(`EvolutionScope not found: ${scopeId}`);
    return scope;
  }

  function requireEvolutionEpisodeInSpace(episodeId: string) {
    const episode = requireEvolutionEpisodeService().getEpisode(episodeId);
    if (!episode) throw new Error(`EvolutionEpisode not found: ${episodeId}`);
    requireEvolutionScopeInSpace(episode.scopeId);
    return episode;
  }

  function requireDb(): BunDatabase {
    if (!config.db) throw new Error('Session management tools require database access');
    return config.db;
  }

  function parseJsonValue(value: string | null | undefined): unknown {
    if (!value) return null;
    try {
      return JSON.parse(value) as unknown;
    } catch {
      return null;
    }
  }

  function parseProcessingState(value: string | null | undefined): Record<string, unknown> {
    const parsed = parseJsonValue(value);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
    return { status: value ?? 'idle' };
  }

  function normalizeProcessingStatus(row: SpaceSessionRow): SpaceSessionStatusFilter {
    if (row.status === 'archived') return 'archived';
    const state = parseProcessingState(row.processing_state);
    const status = typeof state.status === 'string' ? state.status : 'idle';
    if (
      status === 'processing' ||
      status === 'queued' ||
      status === 'running' ||
      status === 'rate_limit_cooldown'
    ) {
      return 'active';
    }
    if (status === 'waiting_for_input') return 'waiting_for_input';
    if (status === 'error') return 'error';
    return 'idle';
  }

  function sessionKind(row: SpaceSessionRow): SpaceSessionTypeFilter {
    const context = parseJsonValue(row.session_context) as Record<string, unknown> | null;
    return row.type === 'space_task_agent' || typeof context?.taskId === 'string'
      ? 'worker'
      : 'ad-hoc';
  }

  function rowToSessionSummary(row: SpaceSessionRow): SpaceSessionSummary {
    return {
      id: row.id,
      title: row.title,
      status: normalizeProcessingStatus(row),
      type: sessionKind(row),
      processing_state: parseProcessingState(row.processing_state),
      created_at: row.created_at,
      last_active_at: row.last_active_at,
      is_worktree: row.is_worktree === 1,
      git_branch: row.git_branch,
      workspace_path: row.workspace_path,
    };
  }

  function getSpaceSessionRow(sessionId: string): SpaceSessionRow | null {
    const row = requireDb()
      .prepare(
        `SELECT id, title, workspace_path, created_at, last_active_at, status, metadata,
                is_worktree, git_branch, processing_state, type, session_context
           FROM sessions
          WHERE id = ?
            AND space_id = ?
          LIMIT 1`
      )
      .get(sessionId, spaceId) as SpaceSessionRow | undefined;
    return row ?? null;
  }

  function requireSpaceSessionRow(sessionId: string): SpaceSessionRow {
    const row = getSpaceSessionRow(sessionId);
    if (!row) throw new Error(`Session not found in this space: ${sessionId}`);
    return row;
  }

  function requireMutableSpaceSessionRow(sessionId: string): SpaceSessionRow {
    const row = requireSpaceSessionRow(sessionId);
    if (row.status === 'archived') throw new Error(`Session is archived: ${sessionId}`);
    return row;
  }

  function getLiveSession(sessionId: string): AgentSession | null {
    return (
      config.getRuntimeSession?.(sessionId) ??
      config.sessionManager?.getCachedSession(sessionId) ??
      null
    );
  }

  async function requireDeliverableSession(sessionId: string): Promise<AgentSession> {
    const session =
      getLiveSession(sessionId) ?? (await config.sessionManager?.getSessionAsync(sessionId));
    if (!session) throw new Error(`Live session not available: ${sessionId}`);
    return session;
  }

  function buildQuestionResponses(
    pendingQuestion: Record<string, unknown>,
    answerText: string
  ): QuestionDraftResponse[] {
    const questions = Array.isArray(pendingQuestion.questions) ? pendingQuestion.questions : [];
    return questions.map((question, questionIndex) => {
      const options =
        question &&
        typeof question === 'object' &&
        Array.isArray((question as { options?: unknown }).options)
          ? ((question as { options: Array<{ label?: unknown }> }).options ?? [])
          : [];
      const firstMatchingLabel = options.find(
        (option) => typeof option.label === 'string' && option.label === answerText
      )?.label as string | undefined;
      return {
        questionIndex,
        selectedLabels: firstMatchingLabel ? [firstMatchingLabel] : [],
        customText: firstMatchingLabel ? undefined : answerText,
      };
    });
  }

  function getCallingAgentAutonomyLevel(): SpaceAgentAutonomyLevel | null {
    if (!myAgentId) return null;
    const repo = config.longHorizonAgentRepo;
    if (!repo) return null;
    const agent = repo.getById(myAgentId);
    if (agent) {
      if (agent.spaceId !== spaceId) return null;
      return agent.autonomyLevel ?? null;
    }
    const workerAgent = spaceAgentManager.getById(myAgentId);
    if (workerAgent && workerAgent.spaceId === spaceId) return null;
    return 1;
  }

  async function requireSessionWriteAutonomy(toolName: string): Promise<void> {
    const spaceLevel = getSpaceAutonomyLevel ? await getSpaceAutonomyLevel(spaceId) : 1;
    const agentLevel = getCallingAgentAutonomyLevel();
    const { level } = resolveEffectiveAutonomyLevel({ spaceLevel, agentLevel });
    const required = getToolAutonomyRequirement(toolName);
    if (required === undefined) return;
    const admission = decideAutonomyAdmission({
      toolName,
      level,
      required,
      agentLevel,
      spaceLevel,
    });
    if (admission.action === 'allow') return;
    if (admission.reason === 'agent_autonomy_ceiling') {
      logAudit(toolName, {
        blocked: true,
        reason: admission.reason,
        agentLevel: admission.agentLevel,
        spaceLevel: admission.spaceLevel,
        required: admission.required,
      });
    }
    throw new Error(admission.message);
  }

  function summarizeMessageContent(raw: string): string {
    const parsed = parseJsonValue(raw) as Record<string, unknown> | null;
    const content = (parsed?.message as { content?: unknown } | undefined)?.content;
    let text = '';
    if (typeof content === 'string') {
      text = content;
    } else if (Array.isArray(content)) {
      text = content
        .map((block) => {
          if (!block || typeof block !== 'object') return '';
          const item = block as { text?: unknown; thinking?: unknown; type?: unknown };
          if (typeof item.text === 'string') return item.text;
          if (typeof item.thinking === 'string') return item.thinking;
          if (typeof item.type === 'string') return `[${item.type}]`;
          return '';
        })
        .filter(Boolean)
        .join('\n');
    }
    const normalized = text.replace(/\s+/g, ' ').trim();
    return normalized.length > 300 ? `${normalized.slice(0, 297)}...` : normalized;
  }

  function listSessionMessages(sessionId: string, limit: number, before?: string) {
    const boundedLimit = Math.min(Math.max(limit, 1), SESSION_MESSAGE_MAX_LIMIT);
    const params: (string | number)[] = [sessionId];
    let beforeClause = '';
    if (before) {
      const [beforeTimestamp, beforeId] = before.includes('|')
        ? before.split('|', 2)
        : [before, ''];
      if (beforeId) {
        beforeClause = 'AND (timestamp < ? OR (timestamp = ? AND id < ?))';
        params.push(beforeTimestamp, beforeTimestamp, beforeId);
      } else {
        beforeClause = 'AND timestamp < ?';
        params.push(beforeTimestamp);
      }
    }
    params.push(boundedLimit);
    const rows = requireDb()
      .prepare(
        `SELECT id, message_type, message_subtype, is_terminal, timestamp, sdk_message
           FROM sdk_messages
          WHERE session_id = ? ${beforeClause}
            AND COALESCE(message_subtype, '') NOT IN ('thinking_tokens', 'session_state_changed', 'commands_changed')
            AND NOT EXISTS (
              SELECT 1
              FROM sdk_message_replacements replacement
              WHERE replacement.session_id = sdk_messages.session_id
                AND replacement.target_uuid = COALESCE(sdk_messages.sdk_uuid, sdk_messages.id)
            )
          ORDER BY timestamp DESC, id DESC
          LIMIT ?`
      )
      .all(...params) as Array<{
      id: string;
      message_type: string;
      message_subtype: string | null;
      is_terminal: number | null;
      timestamp: string;
      sdk_message: string;
    }>;
    return rows.map((row) => ({
      id: row.id,
      message_type: row.message_type,
      message_subtype: row.message_subtype,
      is_terminal: row.is_terminal === 1,
      timestamp: row.timestamp,
      cursor: `${row.timestamp}|${row.id}`,
      content_summary: summarizeMessageContent(row.sdk_message),
    }));
  }

  function requireEvolutionLessonInSpace(lessonId: string) {
    const lesson = requireEvolutionEpisodeService().getLesson(lessonId);
    if (!lesson) throw new Error(`EvolutionLesson not found: ${lessonId}`);
    requireEvolutionScopeInSpace(lesson.scopeId);
    return lesson;
  }

  function requireTaskProposalInSpace(proposalId: string) {
    const proposal = requireEvolutionEpisodeService().getTaskProposal(proposalId);
    if (!proposal) throw new Error(`TaskProposal not found: ${proposalId}`);
    requireEvolutionScopeInSpace(proposal.scopeId);
    return proposal;
  }

  const goalToolContext = {
    source: 'space_agent_tool' as const,
    sourceSessionId: mySessionId ?? null,
  };

  function requireLongHorizonAgentRepo(): SpaceLongHorizonAgentRepository {
    if (!config.longHorizonAgentRepo)
      throw new Error('Long-horizon agent management not available');
    return config.longHorizonAgentRepo;
  }

  function resolveCreateGoalOwnerId(explicitOwnerAgentId?: string | null): string | null {
    if (typeof explicitOwnerAgentId === 'string' && explicitOwnerAgentId.length > 0) {
      requireLongHorizonAgentInSpace(explicitOwnerAgentId);
      const isSelf = typeof myAgentId === 'string' && myAgentId === explicitOwnerAgentId;
      const admission = decideGoalOwnershipMutationAdmission({
        callerRole,
        hasSession: typeof mySessionId === 'string',
      });
      if (!isSelf && admission.action === 'deny') {
        throw new Error(
          'Specifying an owner other than yourself requires coordinator or explicit human authorization.'
        );
      }
      return explicitOwnerAgentId;
    }
    if (!config.longHorizonAgentRepo) return null;
    if (typeof myAgentId === 'string' && myAgentId.length > 0) {
      const self = config.longHorizonAgentRepo.getById(myAgentId);
      if (self?.spaceId === spaceId) return self.id;
    }
    const coordinator = config.longHorizonAgentRepo.getCoordinator(spaceId);
    return coordinator?.id ?? null;
  }

  function getLongHorizonAgentInSpace(agentId: string) {
    const existing = requireLongHorizonAgentRepo().getById(agentId);
    return existing?.spaceId === spaceId ? existing : null;
  }

  function requireLongHorizonAgentInSpace(agentId: string) {
    return requireAgentFamily({
      spaceId,
      agentId,
      expected: 'long_horizon',
      spaceAgentManager,
      longHorizonAgentRepo: requireLongHorizonAgentRepo(),
    }).longHorizonAgent;
  }

  function uniqueLongHorizonAgentHandle(name: string): string {
    return slugifyWithinLimit(name, [
      ...requireLongHorizonAgentRepo()
        .listBySpaceId(spaceId)
        .map((agent) => agent.handle),
      ...spaceAgentManager.listBySpaceId(spaceId).map((agent) => agent.handle),
      ...RESERVED_SPACE_AGENT_HANDLES,
    ]);
  }

  function sourceFromTopicPattern(topicPattern: string): string {
    return topicPattern.split('/')[0] ?? '';
  }

  function emitTaskUpdated(task: SpaceTask): void {
    if (!internalEventBus) return;
    void internalEventBus
      .publish('space.task.updated', {
        sessionId: 'global',
        spaceId,
        taskId: task.id,
        task,
      })
      .catch((err: unknown) => {
        log.warn(
          `Failed to emit space.task.updated for task ${task.id}: ${err instanceof Error ? err.message : String(err)}`
        );
      });
  }

  function emitLongHorizonAgentCreated(agent: SpaceLongHorizonAgent): void {
    internalEventBus
      ?.publish('spaceLongHorizonAgent.created', {
        sessionId: mySessionId ?? 'space-agent-tools',
        spaceId,
        agent,
      })
      .catch(() => {});
  }

  function emitLongHorizonAgentUpdated(agent: SpaceLongHorizonAgent): void {
    internalEventBus
      ?.publish('spaceLongHorizonAgent.updated', {
        sessionId: mySessionId ?? 'space-agent-tools',
        spaceId,
        agent,
      })
      .catch(() => {});
  }

  function logAudit(
    toolName: string,
    paramsSummary: Record<string, unknown>,
    taskId?: string
  ): void {
    if (config.auditLogRepo) {
      try {
        config.auditLogRepo.createEntry({
          agentName: myAgentName,
          sessionId: mySessionId,
          toolName,
          paramsSummary: JSON.stringify(paramsSummary),
          spaceId,
          taskId,
        });
      } catch {}
    }
  }

  function seedLongHorizonTemplateSubscriptions(
    agentId: string,
    subscriptions: SpaceLongHorizonAgentTemplate['suggestedEventSubscriptions']
  ): {
    seeded: Array<{ source: string; topic: string }>;
    skipped: SkippedTemplateSubscription[];
  } {
    const repo = requireLongHorizonAgentRepo();
    const seeded: Array<{ source: string; topic: string }> = [];
    const skipped: SkippedTemplateSubscription[] = [];
    for (const sub of subscriptions) {
      const sourceCheck = validateSource(sub.source);
      if (!sourceCheck.valid) {
        skipped.push({
          source: sub.source,
          topic: sub.topic,
          reason: sourceCheck.reason ?? 'invalid source',
        });
        continue;
      }
      let stored: ReturnType<SpaceLongHorizonAgentRepository['upsertSubscription']> | undefined;
      try {
        stored = repo.upsertSubscription({
          spaceId,
          agentId,
          source: sub.source,
          topic: sub.topic,
          filter: sub.filter ?? {},
          status: 'active',
        });
        const refresh = runtime.refreshLongHorizonSubscription(spaceId, stored.id);
        if (!refresh.success) {
          try {
            repo.deleteSubscription(stored.id);
          } catch {}
          skipped.push({
            source: sub.source,
            topic: sub.topic,
            reason: refresh.error ?? 'invalid pattern',
          });
          continue;
        }
        seeded.push({ source: stored.source, topic: stored.topic });
      } catch (err) {
        if (stored) {
          try {
            repo.deleteSubscription(stored.id);
          } catch {}
        }
        skipped.push({
          source: sub.source,
          topic: sub.topic,
          reason: err instanceof Error ? err.message : String(err),
        });
      }
    }
    return { seeded, skipped };
  }

  function seedLongHorizonTemplateReminders(
    agentId: string,
    reminders: SpaceLongHorizonAgentTemplate['reminderDefaults']
  ): { seeded: Array<{ title: string }>; skipped: SkippedTemplateReminder[] } {
    const repo = requireLongHorizonAgentRepo();
    const seeded: Array<{ title: string }> = [];
    const skipped: SkippedTemplateReminder[] = [];
    for (const reminder of reminders) {
      const check = validateTemplateReminder(reminder);
      if (!check.ok) {
        skipped.push({ title: reminder.title, reason: check.reason });
        continue;
      }
      try {
        const nextRunAt =
          reminder.triggerType === 'cron' && reminder.cronExpression
            ? getNextRunAt(reminder.cronExpression, reminder.timezone ?? 'UTC')
            : null;
        repo.createReminder({
          spaceId,
          agentId,
          title: reminder.title,
          body: reminder.body,
          triggerType: reminder.triggerType,
          cronExpression: reminder.cronExpression,
          timezone: reminder.timezone,
          nextRunAt,
          status: 'active',
          createdBySession: mySessionId ?? null,
        });
        seeded.push({ title: reminder.title });
      } catch (err) {
        skipped.push({
          title: reminder.title,
          reason: err instanceof Error ? err.message : String(err),
        });
      }
    }
    return { seeded, skipped };
  }

  return {
    async list_sessions(args: {
      status?: SpaceSessionStatusFilter;
      type?: SpaceSessionTypeFilter;
      limit?: number;
      offset?: number;
    }): Promise<ToolResult> {
      try {
        const limit = Math.min(args.limit ?? SPACE_SESSION_DEFAULT_LIMIT, SPACE_SESSION_MAX_LIMIT);
        const offset = Math.max(args.offset ?? 0, 0);
        const clauses = [`space_id = ?`];
        const params: Array<string | number> = [spaceId];
        const processingStatus = `COALESCE(json_extract(processing_state, '$.status'), 'idle')`;
        if (args.status === 'archived') {
          clauses.push(`status = 'archived'`);
        } else if (args.status === 'active') {
          clauses.push(`status != 'archived'`);
          clauses.push(
            `${processingStatus} IN ('processing', 'queued', 'running', 'rate_limit_cooldown')`
          );
        } else if (args.status === 'waiting_for_input' || args.status === 'error') {
          clauses.push(`status != 'archived'`);
          clauses.push(`${processingStatus} = ?`);
          params.push(args.status);
        } else if (args.status === 'idle') {
          clauses.push(`status != 'archived'`);
          clauses.push(
            `${processingStatus} NOT IN ('processing', 'queued', 'running', 'rate_limit_cooldown', 'waiting_for_input', 'error')`
          );
        }
        if (args.type === 'worker') {
          clauses.push(`(type = 'space_task_agent' OR task_id IS NOT NULL)`);
        } else if (args.type === 'ad-hoc') {
          clauses.push(`(type != 'space_task_agent' AND task_id IS NULL)`);
        }
        params.push(limit, offset);
        const rows = requireDb()
          .prepare(
            `SELECT id, title, workspace_path, created_at, last_active_at, status, metadata,
                    is_worktree, git_branch, processing_state, type, session_context
               FROM sessions
              WHERE ${clauses.join(' AND ')}
              ORDER BY last_active_at DESC
              LIMIT ? OFFSET ?`
          )
          .all(...params) as SpaceSessionRow[];
        const sessions = rows.map(rowToSessionSummary);
        return jsonResult({ success: true, sessions });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return jsonResult({ success: false, error: message });
      }
    },

    async get_session_detail(args: { session_id: string }): Promise<ToolResult> {
      try {
        const row = requireSpaceSessionRow(args.session_id);
        return jsonResult({
          success: true,
          session: {
            ...rowToSessionSummary(row),
            raw_status: row.status,
            metadata: parseJsonValue(row.metadata),
            session_context: parseJsonValue(row.session_context),
            last_messages: listSessionMessages(row.id, SESSION_DETAIL_MESSAGE_LIMIT),
          },
        });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return jsonResult({ success: false, error: message });
      }
    },

    async get_session_messages(args: {
      session_id: string;
      limit?: number;
      before?: string;
    }): Promise<ToolResult> {
      try {
        requireSpaceSessionRow(args.session_id);
        return jsonResult({
          success: true,
          messages: listSessionMessages(
            args.session_id,
            args.limit ?? SESSION_MESSAGE_DEFAULT_LIMIT,
            args.before
          ),
        });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return jsonResult({ success: false, error: message });
      }
    },

    async send_session_message(args: {
      session_id: string;
      message: string;
      answer_question?: boolean;
    }): Promise<ToolResult> {
      try {
        const row = requireMutableSpaceSessionRow(args.session_id);
        if (
          args.answer_question ||
          (mySessionId &&
            args.session_id !== mySessionId &&
            (outboundSenderLevel !== 'space-agent' || myAgentId))
        ) {
          await requireSessionWriteAutonomy('send_session_message');
        }
        const liveSession = await requireDeliverableSession(args.session_id);
        let messageId = generateUUID();
        if (args.answer_question) {
          const state = parseProcessingState(row.processing_state);
          if (state.status !== 'waiting_for_input') {
            return jsonResult({
              success: false,
              error: 'Session is not waiting for input',
            });
          }
          const pendingQuestion = state.pendingQuestion;
          if (!pendingQuestion || typeof pendingQuestion !== 'object') {
            return jsonResult({
              success: false,
              error: 'Session has no pending question to answer',
            });
          }
          const toolUseId = (pendingQuestion as { toolUseId?: unknown }).toolUseId;
          if (typeof toolUseId !== 'string' || !toolUseId) {
            return jsonResult({
              success: false,
              error: 'Pending question is missing toolUseId',
            });
          }
          const questions = Array.isArray((pendingQuestion as { questions?: unknown }).questions)
            ? (pendingQuestion as { questions: unknown[] }).questions
            : [];
          if (questions.length !== 1) {
            return jsonResult({
              success: false,
              error:
                'answer_question only supports pending prompts with exactly one question. Use the UI for multi-question prompts.',
            });
          }
          await liveSession.handleQuestionResponse(
            toolUseId,
            buildQuestionResponses(pendingQuestion as Record<string, unknown>, args.message)
          );
          messageId = toolUseId;
        } else {
          await config.sessionManager?.sendUserMessage({
            sessionId: args.session_id,
            messageId,
            content: args.message,
          });
          if (!config.sessionManager) {
            await liveSession.startQueryAndEnqueue(messageId, args.message);
          }
        }
        logAudit('send_session_message', {
          session_id: args.session_id,
          answer_question: args.answer_question ?? false,
          message_length: args.message.length,
        });
        return jsonResult({ success: true, delivered: true, message_id: messageId });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return jsonResult({ success: false, error: message });
      }
    },

    async update_session_state(args: {
      session_id: string;
      processing_state: MutableProcessingState;
      clear_pending_question?: boolean;
    }): Promise<ToolResult> {
      try {
        await requireSessionWriteAutonomy('update_session_state');
        const row = requireMutableSpaceSessionRow(args.session_id);
        const liveSession = getLiveSession(args.session_id);
        if (liveSession) {
          return jsonResult({
            success: false,
            error:
              'update_session_state cannot mutate live sessions. Interrupt or message the live session instead.',
          });
        }
        const previousState = parseProcessingState(row.processing_state);
        const newStatus =
          args.processing_state === 'running' ? 'processing' : args.processing_state;
        const newState: Record<string, unknown> = { ...previousState, status: newStatus };
        if (args.clear_pending_question || args.processing_state !== 'waiting_for_input') {
          delete newState.pendingQuestion;
        }
        if (args.processing_state === 'waiting_for_input' && !newState.pendingQuestion) {
          return jsonResult({
            success: false,
            error: 'Cannot set waiting_for_input without an existing pending question',
          });
        }
        requireDb()
          .prepare(`UPDATE sessions SET processing_state = ?, last_active_at = ? WHERE id = ?`)
          .run(JSON.stringify(newState), new Date().toISOString(), args.session_id);
        logAudit('update_session_state', {
          session_id: args.session_id,
          processing_state: args.processing_state,
          clear_pending_question: args.clear_pending_question ?? false,
        });
        return jsonResult({
          success: true,
          updated: true,
          previous_state: previousState,
          new_state: newState,
        });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return jsonResult({ success: false, error: message });
      }
    },

    async interrupt_session(args: { session_id: string; reason?: string }): Promise<ToolResult> {
      try {
        await requireSessionWriteAutonomy('interrupt_session');
        requireMutableSpaceSessionRow(args.session_id);
        const liveSession = getLiveSession(args.session_id);
        if (!liveSession) {
          return jsonResult({
            success: false,
            error:
              'interrupt_session requires a live cached session. Use update_session_state for cold session recovery.',
          });
        }
        await liveSession.handleInterrupt();
        logAudit('interrupt_session', { session_id: args.session_id, reason: args.reason });
        return jsonResult({ success: true, interrupted: true });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return jsonResult({ success: false, error: message });
      }
    },

    async list_agents(args: {
      status?: SpaceLongHorizonAgentStatus;
      compact?: boolean;
    }): Promise<ToolResult> {
      let agents = requireLongHorizonAgentRepo().listBySpaceId(spaceId);
      if (args.status) agents = agents.filter((agent) => agent.status === args.status);
      return jsonResult({
        success: true,
        agents: args.compact ? agents.map(compactLongHorizonAgent) : agents,
      });
    },

    async get_agent(args: { agent_id: string }): Promise<ToolResult> {
      try {
        const agent = requireLongHorizonAgentInSpace(args.agent_id);
        return jsonResult({ success: true, agent });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return jsonResult({ success: false, error: message });
      }
    },

    async create_agent(args: {
      name: string;
      description?: string;
      model?: string;
      thinking_level?: SpaceLongHorizonAgent['thinkingLevel'];
      provider?: string;
      custom_prompt?: string | null;
      tools?: string[];
      setting_sources?: SpaceLongHorizonAgent['settingSources'] | null;
    }): Promise<ToolResult> {
      try {
        if (args.name.trim() === '') {
          return jsonResult({ success: false, error: 'Agent name cannot be empty' });
        }
        if (args.tools) {
          const toolError = validateTools(args.tools);
          if (toolError) return jsonResult({ success: false, error: toolError });
        }
        if (args.model) {
          const modelError = await validateLongHorizonModel(args.model, args.provider);
          if (modelError) return jsonResult({ success: false, error: modelError });
        }
        const agent = requireLongHorizonAgentRepo().create({
          spaceId,
          handle: uniqueLongHorizonAgentHandle(args.name),
          displayName: args.name,
          instructions: args.custom_prompt ?? args.description ?? '',
          autonomyLevel: getCallingAgentAutonomyLevel(),
          model: args.model ?? null,
          thinkingLevel: args.thinking_level ?? null,
          provider: args.provider ?? null,
          settingSources: args.setting_sources ?? null,
          toolPermissions: args.tools && args.tools.length > 0 ? { tools: args.tools } : {},
        });
        emitLongHorizonAgentCreated(agent);
        logAudit('create_agent', { name: args.name, tools: args.tools });
        return jsonResult({ success: true, agent });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return jsonResult({ success: false, error: message });
      }
    },

    async create_agent_from_template(args: {
      template_name: string;
      name?: string;
      model?: string;
      provider?: string;
      thinking_level?: SpaceLongHorizonAgent['thinkingLevel'];
    }): Promise<ToolResult> {
      const templateName = args.template_name.trim();
      if (templateName === '') {
        return jsonResult({ success: false, error: 'template_name is required' });
      }

      const lhTemplate = getLongHorizonAgentTemplates().find(
        (candidate) => candidate.key.toLowerCase() === templateName.toLowerCase()
      );
      if (lhTemplate) {
        if (isReservedAgentHandle(lhTemplate.handle)) {
          return jsonResult({
            success: false,
            error:
              `Template "${lhTemplate.key}" uses the reserved handle ` +
              `"${lhTemplate.handle}", which is auto-created for every space and ` +
              `cannot be created here. It already exists — use list_agents / ` +
              `update_agent to inspect or modify it.`,
          });
        }
        const nameOverride = args.name?.trim();
        if (args.name !== undefined && nameOverride === '') {
          return jsonResult({ success: false, error: 'Agent name cannot be empty' });
        }
        try {
          if (args.model) {
            const modelError = await validateLongHorizonModel(args.model, args.provider);
            if (modelError) return jsonResult({ success: false, error: modelError });
          }
          const repo = requireLongHorizonAgentRepo();
          const callerCeiling = getCallingAgentAutonomyLevel();
          const autonomyLevel: SpaceAgentAutonomyLevel =
            callerCeiling == null || lhTemplate.suggestedAutonomyLevel <= callerCeiling
              ? lhTemplate.suggestedAutonomyLevel
              : callerCeiling;
          const agent = repo.create({
            spaceId,
            handle: uniqueLongHorizonAgentHandle(nameOverride ?? lhTemplate.handle),
            displayName: nameOverride ?? lhTemplate.displayName,
            templateKey: lhTemplate.key,
            instructions: lhTemplate.instructions,
            autonomyLevel,
            model: args.model ?? null,
            provider: args.provider ?? null,
            thinkingLevel: args.thinking_level ?? null,
            toolPermissions: lhTemplate.toolPermissions,
          });
          const subscriptions = seedLongHorizonTemplateSubscriptions(
            agent.id,
            lhTemplate.suggestedEventSubscriptions
          );
          const reminders = seedLongHorizonTemplateReminders(agent.id, lhTemplate.reminderDefaults);
          emitLongHorizonAgentCreated(agent);
          logAudit('create_agent_from_template', {
            template_name: args.template_name,
            name: args.name,
            long_horizon: true,
          });
          return jsonResult({
            success: true,
            agent,
            seeded_subscriptions: subscriptions.seeded,
            skipped_subscriptions: subscriptions.skipped,
            seeded_reminders: reminders.seeded,
            skipped_reminders: reminders.skipped,
          });
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          return jsonResult({ success: false, error: message });
        }
      }

      const template = getPresetAgentTemplates().find(
        (candidate) => candidate.name.toLowerCase() === templateName.toLowerCase()
      );
      if (!template) {
        return jsonResult({
          success: false,
          error: `Agent template not found: ${args.template_name}. Call list_agent_templates to discover available templates.`,
        });
      }
      const name = args.name ?? template.name;
      try {
        if (name.trim() === '') {
          return jsonResult({ success: false, error: 'Agent name cannot be empty' });
        }
        if (args.model) {
          const modelError = await validateLongHorizonModel(args.model, args.provider);
          if (modelError) return jsonResult({ success: false, error: modelError });
        }
        const agent = requireLongHorizonAgentRepo().create({
          spaceId,
          handle: uniqueLongHorizonAgentHandle(name),
          displayName: name,
          templateKey: template.name,
          instructions: template.customPrompt ?? template.description,
          autonomyLevel: getCallingAgentAutonomyLevel(),
          model: args.model ?? null,
          provider: args.provider ?? null,
          thinkingLevel: args.thinking_level ?? template.thinkingLevel ?? null,
          toolPermissions: template.tools.length > 0 ? { tools: template.tools } : {},
        });
        emitLongHorizonAgentCreated(agent);
        logAudit('create_agent_from_template', {
          template_name: args.template_name,
          name: args.name,
        });
        return jsonResult({ success: true, agent });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return jsonResult({ success: false, error: message });
      }
    },

    async list_agent_templates(): Promise<ToolResult> {
      const presets = getPresetAgentTemplates().map((preset) => ({
        template_name: preset.name,
        description: preset.description,
      }));
      const longHorizonTemplates = getLongHorizonAgentTemplates()
        .filter((template) => !isReservedAgentHandle(template.handle))
        .map((template) => ({
          template_name: template.key,
          handle: template.handle,
          display_name: template.displayName,
          description: template.description,
          suggested_autonomy_level: template.suggestedAutonomyLevel,
        }));
      return jsonResult({ success: true, presets, long_horizon_templates: longHorizonTemplates });
    },

    async update_agent(
      args: { agent_id: string } & LongHorizonAgentUpdateArgs
    ): Promise<ToolResult> {
      try {
        const existingAgent = requireLongHorizonAgentInSpace(args.agent_id);
        if (!existingAgent) throw new Error(`Long-horizon agent not found: ${args.agent_id}`);
        if (args.name !== undefined && args.name.trim() === '') {
          return jsonResult({ success: false, error: 'Agent name cannot be empty' });
        }
        if (args.tools) {
          const toolError = validateTools(args.tools);
          if (toolError) return jsonResult({ success: false, error: toolError });
        }
        const effectiveModel = args.model === undefined ? existingAgent.model : args.model;
        const effectiveProvider =
          args.provider === undefined ? existingAgent.provider : args.provider;
        if (effectiveModel && (args.model !== undefined || args.provider !== undefined)) {
          const modelError = await validateLongHorizonModel(effectiveModel, effectiveProvider);
          if (modelError) return jsonResult({ success: false, error: modelError });
        }
        const agent = requireLongHorizonAgentRepo().update(args.agent_id, {
          displayName: args.name,
          status:
            args.status === 'active' ||
            args.status === 'paused' ||
            args.status === 'disabled' ||
            args.status === 'archived'
              ? args.status
              : undefined,
          instructions:
            args.custom_prompt !== undefined
              ? (args.custom_prompt ?? '')
              : args.description !== undefined
                ? (args.description ?? '')
                : undefined,
          model: args.model,
          thinkingLevel: args.thinking_level,
          provider: args.provider,
          settingSources: args.setting_sources === undefined ? undefined : args.setting_sources,
          toolPermissions:
            args.tools === null ? {} : args.tools ? { tools: args.tools } : undefined,
        });
        if (args.provider === null) {
          await config.clearLongTermAgentSessionProvider?.(spaceId, args.agent_id);
        }
        const refresh = runtime.refreshLongHorizonAgentSubscriptions(spaceId, args.agent_id);
        if (!refresh.success) return jsonResult({ success: false, error: refresh.error });
        if (agent) emitLongHorizonAgentUpdated(agent);
        logAudit('update_agent', { agent_id: args.agent_id, status: args.status });
        return jsonResult({ success: true, agent });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return jsonResult({ success: false, error: message });
      }
    },

    async pause_agent(args: { agent_id: string }): Promise<ToolResult> {
      return this.update_agent({ agent_id: args.agent_id, status: 'paused' });
    },

    async archive_agent(args: { agent_id: string }): Promise<ToolResult> {
      return this.update_agent({ agent_id: args.agent_id, status: 'archived' });
    },

    async assign_agent_to_goal(args: { agent_id: string; goal_id: string }): Promise<ToolResult> {
      try {
        const admission = decideGoalOwnershipMutationAdmission({
          callerRole,
          hasSession: typeof mySessionId === 'string',
        });
        if (admission.action === 'deny') {
          return jsonResult({ success: false, error: admission.message });
        }
        requireLongHorizonAgentInSpace(args.agent_id);
        requireGoalInSpace(args.goal_id);
        requireLongHorizonAgentRepo().assignGoal(args.agent_id, args.goal_id);
        logAudit('assign_agent_to_goal', args);
        return jsonResult({ success: true });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return jsonResult({ success: false, error: message });
      }
    },

    async unassign_agent_from_goal(args: {
      agent_id: string;
      goal_id: string;
    }): Promise<ToolResult> {
      try {
        const admission = decideGoalOwnershipMutationAdmission({
          callerRole,
          hasSession: typeof mySessionId === 'string',
        });
        if (admission.action === 'deny') {
          return jsonResult({ success: false, error: admission.message });
        }
        requireLongHorizonAgentInSpace(args.agent_id);
        requireGoalInSpace(args.goal_id);
        requireLongHorizonAgentRepo().deleteGoalAssignmentByRelationship(
          args.agent_id,
          args.goal_id,
          'owner'
        );
        logAudit('unassign_agent_from_goal', args);
        return jsonResult({ success: true });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return jsonResult({ success: false, error: message });
      }
    },

    async assign_agent_to_forge_scope(args: {
      agent_id: string;
      scope_id: string;
    }): Promise<ToolResult> {
      try {
        requireLongHorizonAgentInSpace(args.agent_id);
        requireEvolutionScopeInSpace(args.scope_id);
        requireLongHorizonAgentRepo().assignForgeScope(args.agent_id, args.scope_id);
        logAudit('assign_agent_to_forge_scope', args);
        return jsonResult({ success: true });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return jsonResult({ success: false, error: message });
      }
    },

    async unassign_agent_from_forge_scope(args: {
      agent_id: string;
      scope_id: string;
    }): Promise<ToolResult> {
      try {
        requireLongHorizonAgentInSpace(args.agent_id);
        requireEvolutionScopeInSpace(args.scope_id);
        requireLongHorizonAgentRepo().deleteForgeScopeAssignment(args.agent_id, args.scope_id);
        logAudit('unassign_agent_from_forge_scope', args);
        return jsonResult({ success: true });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return jsonResult({ success: false, error: message });
      }
    },

    async create_agent_reminder(args: {
      agent_id: string;
      message: string;
      remind_at: number;
    }): Promise<ToolResult> {
      try {
        requireLongHorizonAgentInSpace(args.agent_id);
        const reminder = requireLongHorizonAgentRepo().createReminder({
          spaceId,
          agentId: args.agent_id,
          title: args.message,
          triggerType: 'at',
          runAt: args.remind_at,
          nextRunAt: args.remind_at,
          status: 'active',
          createdBySession: mySessionId ?? null,
        });
        logAudit('create_agent_reminder', { agent_id: args.agent_id, remind_at: args.remind_at });
        return jsonResult({ success: true, reminder: mcpReminderShape(reminder) });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return jsonResult({ success: false, error: message });
      }
    },

    async list_agent_reminders(args: {
      agent_id: string;
      status?: 'active' | 'done' | 'cancelled';
    }): Promise<ToolResult> {
      try {
        requireLongHorizonAgentInSpace(args.agent_id);
        const status =
          args.status === 'done'
            ? 'fired'
            : args.status === 'cancelled'
              ? 'cancelled'
              : args.status;
        const dueTime = (reminder: { runAt: number | null; nextRunAt: number | null }) =>
          reminder.runAt ?? reminder.nextRunAt ?? 0;
        const reminders = requireLongHorizonAgentRepo()
          .listReminders(args.agent_id)
          .filter((reminder) => !status || reminder.status === status)
          .sort((left, right) => dueTime(left) - dueTime(right))
          .map(mcpReminderShape);
        return jsonResult({ success: true, reminders });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return jsonResult({ success: false, error: message });
      }
    },

    async subscribe_agent_event(args: {
      agent_id: string;
      topic_pattern: string;
      label?: string;
    }): Promise<ToolResult> {
      try {
        requireLongHorizonAgentInSpace(args.agent_id);
        const validation = validateGlobPattern(args.topic_pattern);
        if (!validation.valid) {
          return jsonResult({ success: false, error: validation.reason ?? 'invalid pattern' });
        }
        const repo = requireLongHorizonAgentRepo();
        const subscription = repo.upsertSubscription({
          spaceId,
          agentId: args.agent_id,
          source: sourceFromTopicPattern(args.topic_pattern),
          topic: args.topic_pattern,
          filter: args.label ? { label: args.label } : {},
          status: 'active',
        });
        const refresh = runtime.refreshLongHorizonSubscription(spaceId, subscription.id);
        if (!refresh.success) {
          return jsonResult({ success: false, error: refresh.error ?? 'invalid pattern' });
        }
        logAudit('subscribe_agent_event', args);
        return jsonResult({ success: true, subscription });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return jsonResult({ success: false, error: message });
      }
    },

    async unsubscribe_agent_event(args: {
      agent_id: string;
      topic_pattern: string;
      label?: string;
    }): Promise<ToolResult> {
      try {
        const agent = getLongHorizonAgentInSpace(args.agent_id);
        if (!agent) return jsonResult({ success: true });
        const repo = requireLongHorizonAgentRepo();
        const source = sourceFromTopicPattern(args.topic_pattern);
        const subscription = repo.getSubscriptionByRoute(
          spaceId,
          args.agent_id,
          source,
          args.topic_pattern
        );
        repo.deleteSubscriptionByRoute(spaceId, args.agent_id, source, args.topic_pattern);
        if (subscription) runtime.removeLongHorizonSubscription(spaceId, subscription.id);
        logAudit('unsubscribe_agent_event', args);
        return jsonResult({ success: true });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return jsonResult({ success: false, error: message });
      }
    },

    async list_agent_event_subscriptions(args: { agent_id: string }): Promise<ToolResult> {
      try {
        const agent = getLongHorizonAgentInSpace(args.agent_id);
        if (!agent) return jsonResult({ success: true, subscriptions: [] });
        const subscriptions = requireLongHorizonAgentRepo().listSubscriptions(args.agent_id);
        return jsonResult({ success: true, subscriptions });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return jsonResult({ success: false, error: message });
      }
    },

    async get_external_event(args: { eventId: string }): Promise<ToolResult> {
      const store = config.externalEventStore;
      if (!store) {
        return jsonResult({ success: false, error: 'External event lookup is not available.' });
      }
      const record = store.getById(args.eventId);
      if (!record || record.event.spaceId !== spaceId) {
        return jsonResult({ success: false, error: `External event not found: ${args.eventId}` });
      }
      return jsonResult({ success: true, event: record.event, state: record.state });
    },

    async list_workflows(): Promise<ToolResult> {
      const workflows = workflowManager.listWorkflowSummaries(spaceId);
      return jsonResult({ success: true, workflows });
    },

    async get_workflow_run(args: { run_id: string }): Promise<ToolResult> {
      const run = workflowRunRepo.getRun(args.run_id);
      if (!run || run.spaceId !== spaceId) {
        return jsonResult({ success: false, error: `Workflow run not found: ${args.run_id}` });
      }

      const executions = nodeExecutionRepo.listByWorkflowRun(run.id);

      return jsonResult({ success: true, run, executions });
    },

    async change_plan(args: {
      run_id: string;
      description?: string;
      workflow_id?: string;
      workflow_handle?: string;
    }): Promise<ToolResult> {
      const run = workflowRunRepo.getRun(args.run_id);
      if (!run || run.spaceId !== spaceId) {
        return jsonResult({ success: false, error: `Workflow run not found: ${args.run_id}` });
      }

      if (run.status === 'done' || run.status === 'cancelled') {
        return jsonResult({
          success: false,
          error: `Cannot change plan for a ${workflowRunAttemptLabel(run.status)} run.`,
        });
      }

      let targetWorkflowId = args.workflow_id;
      if (targetWorkflowId) {
        const wf = workflowManager.getWorkflow(targetWorkflowId);
        const idUnusable = !wf || wf.spaceId !== spaceId || !!wf.disabled;
        if (idUnusable && typeof args.workflow_handle === 'string') {
          const trimmedHandle = args.workflow_handle.trim();
          if (trimmedHandle === '') {
            return jsonResult({
              success: false,
              error: 'workflow_handle must be a non-empty string.',
            });
          }
          const byHandle = workflowManager.getWorkflowByHandle(spaceId, trimmedHandle);
          if (byHandle) {
            targetWorkflowId = byHandle.id;
          } else {
            return jsonResult({
              success: false,
              error: `Workflow not found (id=${targetWorkflowId}, handle=${trimmedHandle})`,
            });
          }
        }
      } else if (typeof args.workflow_handle === 'string') {
        const trimmedHandle = args.workflow_handle.trim();
        if (trimmedHandle === '') {
          return jsonResult({
            success: false,
            error: 'workflow_handle must be a non-empty string.',
          });
        }
        const byHandle = workflowManager.getWorkflowByHandle(spaceId, trimmedHandle);
        if (!byHandle) {
          return jsonResult({
            success: false,
            error: `Workflow not found by handle: ${trimmedHandle}`,
          });
        }
        targetWorkflowId = byHandle.id;
      }

      if (targetWorkflowId) {
        const targetWorkflow = workflowManager.getWorkflow(targetWorkflowId);
        if (!targetWorkflow) {
          return jsonResult({
            success: false,
            error: `Workflow not found: ${targetWorkflowId}`,
          });
        }
        if (targetWorkflow.disabled) {
          return jsonResult({
            success: false,
            error: `Workflow is disabled: ${targetWorkflowId}`,
          });
        }

        await runtime.cancelWorkflowRun(spaceId, run.id);

        try {
          const newDescription = args.description ?? run.description;
          const { run: newRun, tasks } = await runtime.startWorkflowRun(
            spaceId,
            targetWorkflowId,
            run.title,
            newDescription
          );
          return jsonResult({
            success: true,
            previousRunId: run.id,
            run: newRun,
            tasks,
            message: `Switched from workflow "${run.workflowId}" to "${targetWorkflowId}". Previous run cancelled.`,
          });
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          return jsonResult({ success: false, error: message });
        }
      }

      if (args.description !== undefined) {
        const updated = workflowRunRepo.updateRun(run.id, { description: args.description });
        return jsonResult({ success: true, run: updated });
      }

      return jsonResult({
        success: false,
        error: 'Provide at least one of: description, workflow_id, workflow_handle.',
      });
    },

    async get_workflow_detail(args: {
      workflow_id?: string;
      workflow_handle?: string;
    }): Promise<ToolResult> {
      let workflow = null;
      if (args.workflow_id) {
        workflow = workflowManager.getWorkflow(args.workflow_id);
        const idUnusable = !workflow || workflow.spaceId !== spaceId || !!workflow.disabled;
        if (idUnusable && typeof args.workflow_handle === 'string') {
          const trimmedHandle = args.workflow_handle.trim();
          if (trimmedHandle) {
            const byHandle = workflowManager.getWorkflowByHandle(spaceId, trimmedHandle);
            if (byHandle) {
              workflow = byHandle;
            }
          }
        }
      } else if (typeof args.workflow_handle === 'string') {
        const trimmedHandle = args.workflow_handle.trim();
        if (trimmedHandle === '') {
          return jsonResult({
            success: false,
            error: 'workflow_handle must be a non-empty string.',
          });
        }
        workflow = workflowManager.getWorkflowByHandle(spaceId, trimmedHandle);
      } else {
        return jsonResult({
          success: false,
          error: 'Provide either workflow_id or workflow_handle.',
        });
      }
      if (!workflow) {
        const ref = args.workflow_id ?? args.workflow_handle;
        return jsonResult({ success: false, error: `Workflow not found: ${ref}` });
      }
      return jsonResult({ success: true, workflow });
    },

    async suggest_workflow(_args: { description: string }): Promise<ToolResult> {
      const allWorkflows = workflowManager
        .listWorkflowSummaries(spaceId)
        .filter((w) => !w.disabled);
      if (allWorkflows.length === 0) {
        return jsonResult({
          success: true,
          workflows: [],
          message: 'No workflows available in this space.',
        });
      }
      return jsonResult({ success: true, workflows: allWorkflows });
    },

    async list_tasks(args: {
      status?: SpaceTaskStatus;
      workflow_run_id?: string;
      search?: string;
      limit?: number;
      offset?: number;
      compact?: boolean;
    }): Promise<ToolResult> {
      let tasks: SpaceTask[];
      if (args.workflow_run_id) {
        const run = workflowRunRepo.getRun(args.workflow_run_id);
        if (!run || run.spaceId !== spaceId) {
          return jsonResult({
            success: false,
            error: `Workflow run not found: ${args.workflow_run_id}`,
          });
        }
        tasks = taskRepo.listByWorkflowRun(args.workflow_run_id);
        if (args.status) {
          tasks = tasks.filter((t) => t.status === args.status);
        }
      } else if (args.status) {
        tasks = taskRepo.listByStatus(spaceId, args.status);
      } else {
        tasks = taskRepo.listBySpace(spaceId);
      }
      if (args.search) {
        const q = args.search.toLowerCase();
        tasks = tasks.filter((t) => t.title.toLowerCase().includes(q));
      }
      const total = tasks.length;
      const limit = args.limit ?? 50;
      const offset = args.offset ?? 0;
      tasks = tasks.slice(offset, offset + limit);
      if (args.compact) {
        const compactTasks = tasks.map((t) => ({
          id: t.id,
          title: t.title,
          status: t.status,
          priority: t.priority,
          createdAt: t.createdAt,
        }));
        return jsonResult({ success: true, total, tasks: compactTasks });
      }
      return jsonResult({ success: true, total, tasks });
    },

    async create_standalone_task(args: {
      title: string;
      description: string;
      priority?: SpaceTaskPriority;
      workflow_id?: string;
      workflow_handle?: string;
      depends_on?: string[];
      draft?: boolean;
    }): Promise<ToolResult> {
      const workflowIdArg = args.workflow_id ?? null;
      const idWorkflow = workflowIdArg ? workflowManager.getWorkflow(workflowIdArg) : null;
      const workflowIdUsable =
        idWorkflow !== null && idWorkflow.spaceId === spaceId && !idWorkflow.disabled;
      const hasHandleArg = typeof args.workflow_handle === 'string';
      const trimmedHandle =
        typeof args.workflow_handle === 'string' ? args.workflow_handle.trim() : '';
      const handleWorkflow =
        typeof args.workflow_handle === 'string' && trimmedHandle !== '' && !workflowIdUsable
          ? workflowManager.getWorkflowByHandle(spaceId, trimmedHandle)
          : null;
      const ref = routeCreateTaskWorkflowRef({
        workflowIdArg,
        workflowIdUsable,
        hasHandleArg,
        trimmedHandle,
        handleWorkflowId: handleWorkflow?.id ?? null,
        handleWorkflowDisabled: handleWorkflow?.disabled ?? false,
      });
      if (ref.action === 'reject') {
        return jsonResult({ success: false, error: ref.message });
      }
      const preferredWorkflowId = ref.preferredWorkflowId;
      try {
        const task = await taskManager.createTask({
          title: args.title,
          description: args.description,
          priority: args.priority,
          preferredWorkflowId,
          dependsOn: args.depends_on,
          status: args.draft ? 'draft' : undefined,
          createdBy: myAgentName ?? null,
          createdBySession: mySessionId ?? null,
        });
        logAudit(
          'create_standalone_task',
          {
            title: args.title,
            priority: args.priority,
            workflow_id: preferredWorkflowId ?? undefined,
            workflow_handle: args.workflow_handle,
            depends_on: args.depends_on,
            draft: args.draft,
          },
          task.id
        );
        return jsonResult({ success: true, task });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return jsonResult({ success: false, error: message });
      }
    },

    async update_task(args: {
      task_id: string;
      title?: string;
      description?: string;
      priority?: SpaceTaskPriority;
      depends_on?: string[];
      status?: SpaceTaskStatus;
    }): Promise<ToolResult> {
      try {
        const spaceLevel = getSpaceAutonomyLevel ? await getSpaceAutonomyLevel(spaceId) : 1;
        const agentLevel = getCallingAgentAutonomyLevel();
        const { level } = resolveEffectiveAutonomyLevel({ spaceLevel, agentLevel });
        const hasChanges =
          args.title !== undefined ||
          args.description !== undefined ||
          args.priority !== undefined ||
          args.depends_on !== undefined ||
          args.status !== undefined;
        const task = taskRepo.getTask(args.task_id);
        const fieldParams: UpdateSpaceTaskParams = {};
        if (args.title !== undefined) fieldParams.title = args.title;
        if (args.description !== undefined) fieldParams.description = args.description;
        if (args.priority !== undefined) fieldParams.priority = args.priority;
        if (args.depends_on !== undefined) fieldParams.dependsOn = args.depends_on;
        const hasFieldUpdates = Object.keys(fieldParams).length > 0;
        const applyFieldUpdates = async (): Promise<SpaceTask> =>
          taskManager.updateTask(args.task_id, fieldParams, {
            onCascadedTasks: async (cascadedTasks) => {
              for (const cascadedTask of cascadedTasks) emitTaskUpdated(cascadedTask);
            },
          });
        const transitionAuditParams = {
          title: args.title,
          description: args.description,
          priority: args.priority,
          depends_on: args.depends_on,
          status: args.status,
          previousStatus: task?.status,
        };
        const plan = decideUpdateTask({
          toolName: 'update_task',
          level,
          agentLevel,
          spaceLevel,
          hasChanges,
          taskExists: task !== null,
          taskInSpace: task?.spaceId === spaceId,
          currentStatus: task?.status ?? '',
          requestedStatus: args.status,
          statusDiffers: args.status !== undefined && args.status !== task?.status,
          hasWorkflowRun: task?.workflowRunId != null,
          runActive:
            task?.workflowRunId != null
              ? (config.isWorkflowRunActive?.(task.workflowRunId) ?? false)
              : false,
          isRecoveryTransition:
            args.status !== undefined && task !== null && args.status !== task.status
              ? isWorkflowRecoveryTransition(task.status, args.status)
              : false,
          hasFieldUpdates,
          taskId: args.task_id,
          workflowRunId: task?.workflowRunId ?? undefined,
        });
        if (plan.action === 'reject' || plan.action === 'deny') {
          return jsonResult({ success: false, error: plan.message });
        }
        if (args.status !== undefined && task !== null && args.status !== task.status) {
          assertValidSpaceTaskTransition(task.status, args.status);
        }
        switch (plan.action) {
          case 'park_stopped': {
            const parked = await runtime.parkStoppedWorkflowTask(spaceId, args.task_id);
            if (!parked) {
              return jsonResult({ success: false, error: `Task not found: ${args.task_id}` });
            }
            const updated = hasFieldUpdates ? await applyFieldUpdates() : parked;
            logAudit('update_task', transitionAuditParams, args.task_id);
            if (hasFieldUpdates) emitTaskUpdated(updated);
            return jsonResult({ success: true, task: updated });
          }
          case 'recover_transition': {
            const { task: recovered } = await runtime.recoverWorkflowBackedTask(
              spaceId,
              args.task_id,
              args.status as 'open' | 'in_progress'
            );
            const updated = hasFieldUpdates ? await applyFieldUpdates() : recovered;
            logAudit('update_task', transitionAuditParams, args.task_id);
            if (hasFieldUpdates) emitTaskUpdated(updated);
            return jsonResult({ success: true, task: updated });
          }
          case 'stop_for_status': {
            const stopped =
              (await runtime.stopWorkflowBackedTaskForStatus(spaceId, args.task_id, {
                ...fieldParams,
                status: args.status!,
              })) ?? taskRepo.getTask(args.task_id);
            if (!stopped) {
              return jsonResult({ success: false, error: `Task not found: ${args.task_id}` });
            }
            logAudit('update_task', transitionAuditParams, args.task_id);
            return jsonResult({ success: true, task: stopped });
          }
          case 'set_status': {
            let updated = await taskManager.setTaskStatus(args.task_id, args.status!, {
              onCascadedTasks: async (cascadedTasks) => {
                for (const cascadedTask of cascadedTasks) emitTaskUpdated(cascadedTask);
              },
            });
            if (hasFieldUpdates) {
              updated = await applyFieldUpdates();
            }
            logAudit('update_task', transitionAuditParams, args.task_id);
            emitTaskUpdated(updated);
            return jsonResult({ success: true, task: updated });
          }
          case 'fields_only': {
            const updated = await applyFieldUpdates();
            logAudit(
              'update_task',
              {
                title: args.title,
                description: args.description,
                priority: args.priority,
                depends_on: args.depends_on,
              },
              args.task_id
            );
            emitTaskUpdated(updated);
            return jsonResult({ success: true, task: updated });
          }
        }
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return jsonResult({ success: false, error: message });
      }
    },

    async get_task_detail(args: { task_id?: string; task_number?: number }): Promise<ToolResult> {
      let task: SpaceTask | null = null;
      if (args.task_number !== undefined) {
        task = await taskManager.getTaskByNumber(args.task_number);
      } else if (args.task_id) {
        task = await taskManager.getTask(args.task_id);
      } else {
        return jsonResult({
          success: false,
          error: 'Either task_id or task_number is required',
        });
      }
      if (!task) {
        const ref = args.task_number !== undefined ? `#${args.task_number}` : args.task_id;
        return jsonResult({ success: false, error: `Task not found: ${ref}` });
      }
      return jsonResult({ success: true, task });
    },

    async retry_task(args: { task_id: string; description?: string }): Promise<ToolResult> {
      try {
        const existing = taskRepo.getTask(args.task_id);
        const plan = routeRetryTask({
          taskExists: existing !== null,
          taskInSpace: existing?.spaceId === spaceId,
          currentStatus: existing?.status ?? '',
          hasWorkflowRun: existing?.workflowRunId != null,
          taskId: args.task_id,
        });
        if (plan.action === 'reject') {
          return jsonResult({ success: false, error: plan.message });
        }
        let task: SpaceTask;
        if (plan.action === 'recover_workflow_task') {
          task = (
            await runtime.recoverWorkflowBackedTask(spaceId, args.task_id, plan.targetStatus, {
              description: args.description,
            })
          ).task;
        } else {
          task = await taskManager.retryTask(args.task_id, { description: args.description });
        }
        return jsonResult({ success: true, task });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return jsonResult({ success: false, error: message });
      }
    },

    async cancel_task(args: {
      task_id: string;
      cancel_workflow_run?: boolean;
    }): Promise<ToolResult> {
      try {
        const cancelled = await taskManager.cancelTaskCascade(args.task_id);
        const task = cancelled[0]!;
        for (const cancelledTask of cancelled) {
          emitTaskUpdated(cancelledTask);
        }
        const existingRun = task.workflowRunId ? workflowRunRepo.getRun(task.workflowRunId) : null;
        const plan = routeCancelTask({
          cancelWorkflowRunRequested: args.cancel_workflow_run === true,
          hasWorkflowRun: task.workflowRunId != null,
          runExists: existingRun !== null,
        });
        if (plan.action === 'cancel_run') {
          if (plan.runExists) {
            await runtime.cancelWorkflowRun(spaceId, task.workflowRunId!);
          }
          return jsonResult({
            success: true,
            task,
            workflowRunCancelled: true,
            workflowRunId: task.workflowRunId,
          });
        }
        return jsonResult({ success: true, task });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return jsonResult({ success: false, error: message });
      }
    },

    async publish_task(args: { task_id: string }): Promise<ToolResult> {
      const task = taskRepo.getTask(args.task_id);
      const plan = routePublishTask({
        taskExists: task !== null,
        taskInSpace: task?.spaceId === spaceId,
        currentStatus: task?.status ?? '',
        taskId: args.task_id,
      });
      if (plan.action === 'reject') {
        return jsonResult({ success: false, error: plan.message });
      }
      try {
        const updated = await taskManager.publishTask(args.task_id);

        logAudit('publish_task', { previousStatus: task?.status }, args.task_id);

        emitTaskUpdated(updated);

        return jsonResult({ success: true, task: updated });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return jsonResult({ success: false, error: message });
      }
    },

    async archive_task(args: { task_id: string }): Promise<ToolResult> {
      const task = taskRepo.getTask(args.task_id);
      const plan = routeArchiveTask({
        taskExists: task !== null,
        taskInSpace: task?.spaceId === spaceId,
        hasWorkflowRun: task?.workflowRunId != null,
        runActive:
          task?.workflowRunId != null
            ? (config.isWorkflowRunActive?.(task.workflowRunId) ?? false)
            : false,
        taskId: args.task_id,
        workflowRunId: task?.workflowRunId ?? undefined,
      });
      if (plan.action === 'reject') {
        return jsonResult({ success: false, error: plan.message });
      }
      try {
        const updated = await taskManager.archiveTask(args.task_id);

        logAudit('archive_task', { previousStatus: task?.status }, args.task_id);

        emitTaskUpdated(updated);

        return jsonResult({ success: true, task: updated });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return jsonResult({ success: false, error: message });
      }
    },

    async reassign_task(args: {
      task_id: string;
      custom_agent_id?: string | null;
      assigned_agent?: 'coder' | 'general';
    }): Promise<ToolResult> {
      try {
        const plan = routeReassignTask({
          customAgentId: args.custom_agent_id,
          workerAgentExists:
            args.custom_agent_id != null
              ? spaceAgentManager.getById(args.custom_agent_id) !== null
              : false,
        });
        if (plan.action === 'reject') {
          return jsonResult({ success: false, error: plan.message });
        }

        const task = await taskManager.reassignTask(
          args.task_id,
          args.custom_agent_id,
          args.assigned_agent
        );
        return jsonResult({ success: true, task });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return jsonResult({ success: false, error: message });
      }
    },

    async send_message_to_task(args: {
      task_id?: string;
      task_number?: number;
      message: string;
      node_id?: string;
      target?: string;
    }): Promise<ToolResult> {
      let task: SpaceTask | null = null;
      const audit = (outcome: string, extra: Record<string, unknown> = {}) =>
        logAudit(
          'send_message_to_task',
          { task_id: task?.id ?? args.task_id, outcome, ...extra },
          task?.id
        );

      if (!taskAgentManager) {
        audit('error', { reason: 'task_agent_manager_unavailable' });
        return jsonResult({
          success: false,
          error: 'Task agent communication is not available in this context.',
        });
      }
      if (args.task_id) {
        task = taskRepo.getTask(args.task_id);
        if (!task) {
          audit('failed', { reason: 'task_not_found' });
          return jsonResult({ success: false, error: `Task not found: ${args.task_id}` });
        }
      } else if (typeof args.task_number === 'number') {
        task = taskRepo.getTaskByNumber(spaceId, args.task_number);
        if (!task) {
          audit('failed', { reason: 'task_number_not_found', task_number: args.task_number });
          return jsonResult({
            success: false,
            error: `Task not found in this space with task_number=${args.task_number}`,
          });
        }
      } else {
        audit('failed', { reason: 'missing_task_identifier' });
        return jsonResult({
          success: false,
          error: 'Either task_id or task_number must be provided.',
        });
      }
      if (task.spaceId !== spaceId) {
        audit('failed', { reason: 'space_mismatch' });
        return jsonResult({
          success: false,
          error: `Task ${task.id} does not belong to this space.`,
        });
      }
      if (task.status === 'archived') {
        audit('failed', { reason: 'task_archived' });
        return jsonResult({
          success: false,
          error: `Task ${task.id} is archived — create a new task.`,
        });
      }

      if (args.target === 'task-agent' || args.node_id === 'task-agent') {
        audit('failed', { target: 'task-agent', reason: 'deprecated_task_agent_target' });
        return jsonResult({
          success: false,
          error: 'Target "task-agent" is no longer supported. Use a worker target or node_id.',
        });
      }

      if (!args.node_id && !args.target) {
        audit('failed', { reason: 'missing_target' });
        return jsonResult({
          success: false,
          error: 'Target agent is required. Use node_id or target to specify a recipient.',
        });
      }
      if (!task.workflowRunId) {
        audit('failed', { reason: 'missing_workflow_run' });
        return jsonResult({
          success: false,
          error: `Task ${task.id} has no workflow run — cannot target workflow workers.`,
        });
      }
      const allExecutions = nodeExecutionRepo.listByWorkflowRun(task.workflowRunId);
      const run = workflowRunRepo.getRun(task.workflowRunId);
      const workflow = run ? (workflowManager.getWorkflowForRun(run) ?? null) : null;
      const workflowNodeNameById = new Map(
        (workflow?.nodes ?? []).map((node) => [node.id, node.name] as const)
      );
      let resolved: NodeExecution | null = null;
      let routedTarget = args.node_id ?? null;

      const trimmedTarget = args.target?.trim() ?? '';
      if (trimmedTarget) {
        let targetAddress;
        try {
          targetAddress = parseAddress(trimmedTarget);
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          audit('failed', {
            reason: 'malformed_target',
            target: args.target,
            node_id: args.node_id,
            error: message,
          });
          return jsonResult({
            success: false,
            error: message,
          });
        }
        const handleResolution =
          targetAddress.kind === 'handle'
            ? await resolveHandleForTaskRouting(
                trimmedTarget,
                allExecutions,
                spaceId,
                task.workflowRunId,
                messageResolver,
                config.longHorizonAgentRepo
              )
            : null;
        if (handleResolution?.kind === 'long-horizon-agent' && targetAddress.kind === 'handle') {
          const nodeResolved = args.node_id
            ? resolveNodeExecution(allExecutions, args.node_id)
            : null;
          if (nodeResolved) {
            audit('failed', {
              reason: 'target_node_id_disagree',
              target: args.target,
              node_id: args.node_id,
              resolved_actor: handleResolution.actor.actorId,
              resolved_execution: nodeResolved.id,
            });
            return jsonResult({
              success: false,
              error:
                `target and node_id disagree for task #${task.taskNumber}:\n` +
                `  target: "${trimmedTarget}"  → ${describeActor(handleResolution.actor)}\n` +
                `  node_id: "${args.node_id}"  → ${describeTaskExecution(nodeResolved)}\n` +
                `Pick one. node_id is preferred for workflow node routing.`,
            });
          }
          audit('failed', {
            reason: 'ambiguous_long_horizon_target',
            target: args.target,
            node_id: args.node_id,
            resolved_actor: handleResolution.actor.actorId,
          });
          return jsonResult({
            success: false,
            error:
              `Ambiguous target "${trimmedTarget}" matched long-horizon agent "${handleResolution.actor.handle?.slice(1) ?? handleResolution.actor.actorId}" (${handleResolution.actor.actorId}), not a workflow node of task #${task.taskNumber}.\n` +
              `To target the workflow ${targetAddress.handle} node, use:\n` +
              `  - node_id: "${targetAddress.handle}"  (recommended)\n` +
              `  - target: "@worker:${task.workflowRunId}/${targetAddress.handle}/${targetAddress.handle}"\n` +
              `To target the long-horizon agent explicitly, omit task_id and call send_session_message instead.`,
          });
        }
        let overrideExec: NodeExecution | undefined;
        const nodeResolved = args.node_id
          ? resolveNodeExecution(allExecutions, args.node_id)
          : null;
        const nodeMatchesTargetHandle =
          nodeResolved &&
          targetAddress.kind === 'handle' &&
          normalizeAgentNameToken(nodeResolved.agentName) ===
            normalizeAgentNameToken(targetAddress.handle);
        if (handleResolution?.kind === 'ambiguous') {
          if (nodeMatchesTargetHandle) {
            overrideExec = nodeResolved;
          } else {
            audit('failed', {
              reason: 'ambiguous_target',
              target: args.target,
              node_id: args.node_id,
              matched_actors: handleResolution.actors.map((a) => a.actorId),
              matched_execution: handleResolution.exec?.id,
            });
            return jsonResult({
              success: false,
              error:
                `Ambiguous target "${trimmedTarget}" for task #${task.taskNumber} matched multiple actors:\n` +
                `${describeAmbiguousTargetActors(handleResolution.actors, handleResolution.exec)}\n` +
                `Disambiguate with @worker: for workflow nodes or @session: for a specific session.`,
            });
          }
        }

        let genericTarget: string;
        try {
          genericTarget = translateTaskMessageTarget(
            { target: trimmedTarget, nodeId: args.node_id },
            { workflowRunId: task.workflowRunId, nodeExecutions: allExecutions, workflow }
          );
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          audit('failed', { target: args.target, node_id: args.node_id, reason: message });
          return jsonResult({
            success: false,
            error: message,
          });
        }
        const workerExec =
          overrideExec ??
          (nodeMatchesTargetHandle ? nodeResolved : null) ??
          (handleResolution?.kind === 'task-worker' ? handleResolution.exec : null);
        if (workerExec) {
          genericTarget = `@worker:${encodeURIComponent(task.workflowRunId)}/${encodeURIComponent(workerExec.workflowNodeId)}/${encodeURIComponent(workerExec.agentName)}`;
        }
        routedTarget = genericTarget;
        const address = parseAddress(genericTarget);
        if (address.kind === 'handle' || address.kind === 'role') {
          if (!messageResolver || !longTermAgentDelivery) {
            audit('failed', {
              target: 'space-agent',
              reason: 'long_term_agent_messaging_unavailable',
            });
            return jsonResult({
              success: false,
              error: 'Long-term agent messaging is not available in this context.',
            });
          }
          const messageRecord: MessageRecord = {
            messageId: `msg_space_tool_${Date.now()}_${Math.random().toString(36).slice(2)}`,
            spaceId,
            senderActorId: mySessionId ? `session:${mySessionId}` : `agent:coordinator:${spaceId}`,
            targets: [genericTarget],
            body: formatAgentMessage({
              fromLevel: outboundSenderLevel,
              fromAgentName: outboundSenderDisplayName,
              toLevel: 'space-agent',
              body: args.message,
              taskId: task.id,
              taskNumber: task.taskNumber,
              replyToSessionId: mySessionId,
              replyTargetHandle: outboundReplyTargetHandle,
            }),
            kind: 'message',
            workflowRunId: task.workflowRunId,
            taskId: task.id,
            createdAt: Date.now(),
          };
          const routed = await new SpaceDeliveryFacade({
            resolver: messageResolver,
            deliverToSession: longTermAgentDelivery.deliverToSession,
            queueForActivation: longTermAgentDelivery.queueForActivation,
          }).routeMessage(messageRecord);
          const firstDelivered = routed.deliveries.find(
            (delivery) => delivery.state === 'delivered'
          );
          const deliveredOrQueued = routed.deliveries.some((delivery) =>
            ['delivered', 'queued'].includes(delivery.state)
          );
          const routedOutcome = firstDelivered
            ? 'delivered'
            : deliveredOrQueued
              ? 'queued'
              : 'failed';
          audit(routedOutcome, {
            target: 'space-agent',
            agent_name: genericTarget,
            delivered_session_id: firstDelivered?.deliveredSessionId ?? null,
            reason: deliveredOrQueued ? undefined : 'no_delivery_or_queue',
          });
          return jsonResult({
            success: deliveredOrQueued,
            task_id: task.id,
            target: 'space-agent',
            deliveries: routed.deliveries,
            delivered_session_id: firstDelivered?.deliveredSessionId ?? null,
          });
        }
        if (address.kind === 'worker') {
          resolved = resolveWorkerTargetExecution(
            allExecutions,
            task.workflowRunId,
            workflowNodeNameById,
            genericTarget
          );
        } else if (address.kind === 'session') {
          resolved =
            allExecutions.find((exec) => exec.agentSessionId === address.sessionId) ?? null;
        } else {
          audit('failed', { target: genericTarget, reason: 'generic_target_not_routable' });
          return jsonResult({
            success: false,
            error: `Generic target ${genericTarget} is not routable from this tool. Use @handle, @role:<role>, @worker:<node>/<agent>, @worker:<run>/<node>/<agent>, @session:<task-agent-session>, or node_id.`,
          });
        }
      } else if (args.node_id) {
        resolved = resolveNodeExecution(allExecutions, args.node_id);
      }

      if (args.target && args.node_id) {
        const nodeResolved = resolveNodeExecution(allExecutions, args.node_id);
        if (resolved && nodeResolved && resolved.id !== nodeResolved.id) {
          audit('failed', {
            reason: 'target_node_id_disagree',
            target: args.target,
            node_id: args.node_id,
            resolved_target_execution: resolved.id,
            resolved_node_id_execution: nodeResolved.id,
          });
          return jsonResult({
            success: false,
            error:
              `target and node_id disagree for task #${task.taskNumber}:\n` +
              `  target: "${args.target}"  → ${describeTaskExecution(resolved)}\n` +
              `  node_id: "${args.node_id}"  → ${describeTaskExecution(nodeResolved)}\n` +
              `Pick one. node_id is preferred for workflow node routing.`,
          });
        }
      }

      if (!routedTarget) {
        audit('failed', { reason: 'missing_target' });
        return jsonResult({
          success: false,
          error: 'Target agent is required. Use node_id or target to specify a recipient.',
        });
      }
      if (!resolved) {
        audit('failed', { target: routedTarget, node_id: args.node_id, reason: 'node_not_found' });
        return jsonResult({
          success: false,
          error:
            `Node not found for task ${task.id}: "${routedTarget}". ` +
            `Expected an execution UUID, agent name, @worker target, or task agent @session target.`,
        });
      }

      if (replyRoutingRegistry && mySessionId) {
        replyRoutingRegistry.set(task.id, mySessionId, resolved.agentName);
      }

      if (resolved.agentSessionId) {
        try {
          const sdkMessageId = await taskAgentManager.injectSubSessionMessage(
            resolved.agentSessionId,
            formatAgentMessage({
              fromLevel: outboundSenderLevel,
              fromAgentName: outboundSenderDisplayName,
              toLevel: 'node-agent',
              body: args.message,
              taskId: task.id,
              taskNumber: task.taskNumber,
              nodeId: resolved.agentName,
              replyToSessionId: mySessionId,
              replyTargetHandle: outboundReplyTargetHandle,
            }),
            true
          );
          audit('delivered', {
            target: 'node',
            node_id: resolved.id,
            agent_name: resolved.agentName,
            node_execution_id: resolved.id,
            delivered_session_id: resolved.agentSessionId,
            sdk_message_id: sdkMessageId,
          });
          return jsonResult({
            success: true,
            task_id: task.id,
            target: 'node',
            node_execution_id: resolved.id,
            agent_name: resolved.agentName,
            delivered_session_id: resolved.agentSessionId,
            sdk_message_id: sdkMessageId,
            activated: false,
          });
        } catch {}
      }

      if (!activateNode) {
        audit('failed', {
          target: 'node',
          node_id: resolved.id,
          agent_name: resolved.agentName,
          reason: 'activation_callback_missing',
        });
        return jsonResult({
          success: false,
          error: `Node "${resolved.agentName}" has no live session and no activation callback is configured.`,
        });
      }
      try {
        await activateNode(task.workflowRunId, resolved.workflowNodeId);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        audit('error', {
          target: 'node',
          node_id: resolved.id,
          agent_name: resolved.agentName,
          reason: message,
        });
        return jsonResult({
          success: false,
          error: `Failed to activate node "${resolved.agentName}": ${message}`,
        });
      }

      const refreshedExecution = nodeExecutionRepo.getById(resolved.id);
      const sessionIdAfter = refreshedExecution?.agentSessionId ?? null;
      if (sessionIdAfter) {
        try {
          const sdkMessageId = await taskAgentManager.injectSubSessionMessage(
            sessionIdAfter,
            formatAgentMessage({
              fromLevel: outboundSenderLevel,
              fromAgentName: outboundSenderDisplayName,
              toLevel: 'node-agent',
              body: args.message,
              taskId: task.id,
              taskNumber: task.taskNumber,
              nodeId: resolved.agentName,
              replyToSessionId: mySessionId,
              replyTargetHandle: outboundReplyTargetHandle,
            }),
            true
          );
          audit('delivered', {
            target: 'node',
            node_id: resolved.id,
            agent_name: resolved.agentName,
            node_execution_id: resolved.id,
            delivered_session_id: sessionIdAfter,
            sdk_message_id: sdkMessageId,
          });
          return jsonResult({
            success: true,
            task_id: task.id,
            target: 'node',
            node_execution_id: resolved.id,
            agent_name: resolved.agentName,
            delivered_session_id: sessionIdAfter,
            sdk_message_id: sdkMessageId,
            activated: true,
          });
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          audit('error', {
            target: 'node',
            node_id: resolved.id,
            agent_name: resolved.agentName,
            reason: message,
          });
          return jsonResult({
            success: false,
            error: `Failed to inject message into node "${resolved.agentName}": ${message}`,
          });
        }
      }

      let queuedMessageId: string | null = null;
      if (pendingMessageQueue) {
        const { record } = pendingMessageQueue.enqueue({
          workflowRunId: task.workflowRunId,
          spaceId,
          taskId: task.id,
          sourceAgentName: outboundSenderName,
          targetKind: 'node_agent',
          targetAgentName: resolved.agentName,
          message: formatAgentMessage({
            fromLevel: outboundSenderLevel,
            fromAgentName: outboundSenderDisplayName,
            toLevel: 'node-agent',
            body: args.message,
            taskId: task.id,
            taskNumber: task.taskNumber,
            nodeId: resolved.agentName,
            replyToSessionId: mySessionId,
            replyTargetHandle: outboundReplyTargetHandle,
          }),
        });
        queuedMessageId = record.id;
      }

      audit(queuedMessageId !== null ? 'queued' : 'activated', {
        target: 'node',
        node_id: resolved.id,
        agent_name: resolved.agentName,
        node_execution_id: resolved.id,
        ...(queuedMessageId !== null
          ? { queued_message_id: queuedMessageId }
          : { reason: 'pending_message_queue_unavailable' }),
      });
      return jsonResult({
        success: true,
        task_id: task.id,
        target: 'node',
        node_execution_id: resolved.id,
        agent_name: resolved.agentName,
        delivered_session_id: null,
        sdk_message_id: null,
        activated: true,
        delivered: false,
        queued: queuedMessageId !== null,
        ...(queuedMessageId !== null ? { queued_message_id: queuedMessageId } : {}),
        message:
          queuedMessageId !== null
            ? `Node "${resolved.agentName}" was activated and the message was queued; it will be delivered once the session spawns.`
            : `Node "${resolved.agentName}" was activated but does not yet have a live session; ` +
              `the message was not queued because no pending message queue is configured. Retry after the node starts.`,
      });
    },

    async list_task_members(args: { task_id: string }): Promise<ToolResult> {
      const task = taskRepo.getTask(args.task_id);
      if (!task) {
        return jsonResult({ success: false, error: `Task not found: ${args.task_id}` });
      }
      if (task.spaceId !== spaceId) {
        return jsonResult({
          success: false,
          error: `Task ${args.task_id} does not belong to this space.`,
        });
      }
      if (!task.workflowRunId) {
        return jsonResult({
          success: true,
          task_id: args.task_id,
          executions: [],
          message: 'This task has no associated workflow run.',
        });
      }
      const executions = nodeExecutionRepo.listByWorkflowRun(task.workflowRunId);
      return jsonResult({ success: true, task_id: args.task_id, executions });
    },

    async approve_task(args: { task_id: string; reason?: string }): Promise<ToolResult> {
      const task = taskRepo.getTask(args.task_id);
      const space = config.spaceManager ? await config.spaceManager.getSpace(spaceId) : null;
      const spaceLevel =
        space?.autonomyLevel ?? (getSpaceAutonomyLevel ? await getSpaceAutonomyLevel(spaceId) : 1);
      const agentLevel = getCallingAgentAutonomyLevel();
      const { level } = resolveEffectiveAutonomyLevel({ spaceLevel, agentLevel });
      let completionAutonomyLevel = 5;
      if (task?.workflowRunId) {
        const run = workflowRunRepo.getRun(task.workflowRunId);
        if (run?.workflowId) {
          const workflow = workflowManager.getWorkflowForRun(run);
          if (workflow?.completionAutonomyLevel !== undefined) {
            completionAutonomyLevel = workflow.completionAutonomyLevel;
          }
        }
      }
      const plan = routeApproveTask({
        taskExists: task !== null,
        taskInSpace: task?.spaceId === spaceId,
        currentStatus: task?.status ?? '',
        taskId: args.task_id,
        level,
        required: completionAutonomyLevel,
        agentLevel,
        spaceLevel,
      });
      if (plan.action === 'reject' || plan.action === 'deny') {
        if (plan.action === 'deny' && plan.reason === 'agent_autonomy_ceiling') {
          logAudit(
            'approve_task',
            {
              blocked: true,
              reason: plan.reason,
              agentLevel: plan.agentLevel,
              spaceLevel: plan.spaceLevel,
              required: plan.required,
            },
            args.task_id
          );
        }
        return jsonResult({ success: false, error: plan.message });
      }

      try {
        const updated = await taskManager.setTaskStatus(args.task_id, 'done', {
          result:
            normalizeMeaningfulTaskResult(task!.result) ??
            normalizeMeaningfulTaskResult(task!.reportedSummary) ??
            undefined,
          approvalSource: 'agent',
          approvalReason: args.reason,
          onCascadedTasks: async (cascadedTasks) => {
            for (const cascadedTask of cascadedTasks) emitTaskUpdated(cascadedTask);
          },
        });

        logAudit(
          'approve_task',
          {
            reason: args.reason,
            previousStatus: task!.status,
          },
          args.task_id
        );

        emitTaskUpdated(updated);

        return jsonResult({ success: true, task: updated });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return jsonResult({ success: false, error: message });
      }
    },

    async approve_pending_completion(args: {
      task_id: string;
      approved: boolean;
      reason?: string | null;
    }): Promise<ToolResult> {
      if (callerRole !== 'coordinator' && callerRole !== 'legacy_task_agent') {
        return jsonResult({
          success: false,
          error:
            'approve_pending_completion is only available to the coordinator and task-agent sessions. Worker node agents must use approve_task to self-close.',
        });
      }

      const task = taskRepo.getTask(args.task_id);
      if (!task) {
        return jsonResult({ success: false, error: `Task not found: ${args.task_id}` });
      }
      if (task.spaceId !== spaceId) {
        return jsonResult({
          success: false,
          error: `Task ${args.task_id} does not belong to this space.`,
        });
      }
      if (task.pendingCheckpointType !== 'task_completion') {
        return jsonResult({
          success: false,
          error: `Task ${args.task_id} is not awaiting submit_for_approval review (pendingCheckpointType=${task.pendingCheckpointType ?? 'null'}).`,
        });
      }
      if (task.status !== 'review') {
        return jsonResult({
          success: false,
          error: `Task ${args.task_id} is not in 'review' status (current: ${task.status}).`,
        });
      }

      try {
        let updated: SpaceTask;
        if (args.approved) {
          try {
            await runtime.dispatchPostApproval(args.task_id, 'human' as SpaceApprovalSource, {
              approvalReason: args.reason ?? null,
            });
          } catch (dispatchErr) {
            const afterCommit = taskRepo.getTask(args.task_id);
            if (afterCommit?.status !== 'approved') throw dispatchErr;
            const detail = dispatchErr instanceof Error ? dispatchErr.message : String(dispatchErr);
            log.warn(
              `approve_pending_completion: post-approval dispatch failed for task ${args.task_id} after status commit (${detail}); capturing as post-approval-blocked`
            );
            await taskManager.updateTask(args.task_id, {
              postApprovalBlockedReason: mapPostApprovalDispatchWarning(detail),
            });
          }
          const refreshed = taskRepo.getTask(args.task_id);
          if (!refreshed) throw new Error(`Task not found: ${args.task_id}`);
          updated = refreshed;
        } else {
          updated = await taskManager.setTaskStatus(args.task_id, 'in_progress');
          updated = await taskManager.updateTask(args.task_id, {
            approvalReason: args.reason ?? null,
          });
        }

        emitTaskUpdated(updated);
        logAudit(
          'approve_pending_completion',
          { approved: args.approved, reason: args.reason, previousStatus: task.status },
          args.task_id
        );

        return jsonResult({ success: true, task: updated });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return jsonResult({ success: false, error: message });
      }
    },

    async list_goals(args: { status?: SpaceGoalStatus } = {}): Promise<ToolResult> {
      try {
        const goals = requireGoalService().listGoals({ spaceId, status: args.status });
        return jsonResult({ success: true, goals });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return jsonResult({ success: false, error: message });
      }
    },

    async get_goal(args: { goal_id: string }): Promise<ToolResult> {
      try {
        const goal = requireGoalInSpace(args.goal_id);
        return jsonResult({ success: true, goal });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return jsonResult({ success: false, error: message });
      }
    },

    async review_goal_outcome(args: {
      goal_id?: string;
      task_id?: string;
      notification_id?: string;
      disposition?: 'acknowledge' | 'reject' | 'supersede';
      observed_goal_revision?: number | null;
      summary?: string;
      next_steps?: string[];
      metrics?: Record<string, string | number | boolean | null>;
      observations?: Array<{ key: string; value: number }>;
      progress?: number;
    }): Promise<ToolResult> {
      try {
        const goalService = requireGoalService();
        const callerAgentId = myAgentId ?? null;
        const humanAdmissionAllowed = false;
        const hasGoalUpdate =
          args.summary !== undefined ||
          args.next_steps !== undefined ||
          args.metrics !== undefined ||
          args.observations !== undefined ||
          args.progress !== undefined;
        if (!args.notification_id) {
          if (hasGoalUpdate) {
            return jsonResult({
              success: false,
              error:
                'goal-state updates require notification_id; call without update fields to discover pending notifications',
            });
          }
          const notifications = goalService.listClaimableOutcomeNotifications({
            spaceId,
            callerAgentId,
            humanAdmissionAllowed,
            limit: 100,
          });
          return jsonResult({ success: true, discovery: true, notifications });
        }
        if (!args.disposition && !hasGoalUpdate) {
          return jsonResult({
            success: false,
            error:
              'disposition (acknowledge, reject, or supersede) or a goal-state update is required when notification_id is provided',
          });
        }
        if (args.disposition && args.disposition !== 'acknowledge' && hasGoalUpdate) {
          return jsonResult({
            success: false,
            error: 'goal-state updates require the acknowledge disposition',
          });
        }
        if (!args.goal_id || !args.task_id) {
          return jsonResult({
            success: false,
            error: 'goal_id and task_id are required when notification_id is provided',
          });
        }
        requireGoalInSpace(args.goal_id);
        const dispositionStatus = hasGoalUpdate
          ? 'acknowledged'
          : args.disposition === 'reject'
            ? 'rejected'
            : args.disposition === 'supersede'
              ? 'superseded'
              : 'acknowledged';
        const result = goalService.claimOutcomeNotification({
          notificationId: args.notification_id,
          claimedGoalId: args.goal_id,
          claimedTaskId: args.task_id,
          actorAgentId: callerAgentId,
          humanAdmissionAllowed,
          mutatesGoalState: hasGoalUpdate,
          dispositionStatus,
          isResubmission: args.observed_goal_revision != null,
          observedGoalRevision: args.observed_goal_revision ?? null,
          apply: hasGoalUpdate
            ? (goal) =>
                goalService.applyOutcomeGoalUpdate({
                  goalId: goal.id,
                  summary: args.summary,
                  nextSteps: args.next_steps,
                  metrics: args.metrics,
                  observations: args.observations,
                  progress: args.progress,
                  sourceTaskId: args.task_id,
                  sourceSessionId: mySessionId ?? null,
                })
            : undefined,
        });
        if (result.status === 'claimed' || result.status === 'already_applied') {
          logAudit(
            'review_goal_outcome',
            {
              notification_id: args.notification_id,
              goal_id: args.goal_id,
              disposition: dispositionStatus,
              has_goal_update: hasGoalUpdate,
              status: result.status,
            },
            args.task_id
          );
          return jsonResult({
            success: true,
            status: result.status,
            notification: result.notification,
            goal: result.goal,
          });
        }
        if (result.status === 'denied') {
          return jsonResult({
            success: false,
            reason: result.reason,
            currentGoalRevision: result.currentGoalRevision,
            goal: result.goal,
          });
        }
        return jsonResult({
          success: false,
          error: `Notification not found: ${args.notification_id}`,
        });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return jsonResult({ success: false, error: message });
      }
    },

    async create_goal(args: {
      title: string;
      description?: string;
      type?: SpaceGoalType;
      priority?: SpaceTaskPriority;
      labels?: string[];
      metrics?: Record<string, string | number | boolean | null>;
      summary?: string;
      progress?: number;
      next_steps?: string[];
      preferred_workflow_id?: string | null;
      auto_trigger_next?: boolean;
      check_in_cron_expression?: string;
      check_in_timezone?: string;
      trigger_immediately?: boolean;
      owner_agent_id?: string | null;
    }): Promise<ToolResult> {
      try {
        const primaryOwnerAgentId = resolveCreateGoalOwnerId(args.owner_agent_id);
        const goal = requireGoalService().createGoal(
          {
            spaceId,
            title: args.title,
            description: args.description,
            type: args.type,
            priority: args.priority,
            labels: args.labels,
            metrics: args.metrics,
            summary: args.summary,
            progress: args.progress,
            nextSteps: args.next_steps,
            preferredWorkflowId: args.preferred_workflow_id,
            autoTriggerNext: args.auto_trigger_next,
            checkInCronExpression: args.check_in_cron_expression,
            checkInTimezone: args.check_in_timezone,
            triggerImmediately: args.trigger_immediately,
            primaryOwnerAgentId,
          },
          goalToolContext
        );
        logAudit('create_goal', {
          title: args.title,
          type: args.type,
          priority: args.priority,
          trigger_immediately: args.trigger_immediately,
          check_in_cron_expression: args.check_in_cron_expression,
        });
        return jsonResult({ success: true, goal });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return jsonResult({ success: false, error: message });
      }
    },

    async update_goal(args: { goal_id: string } & GoalToolUpdateArgs): Promise<ToolResult> {
      try {
        requireGoalInSpace(args.goal_id);
        const { goal_id: goalId, ...updates } = args;
        const goal = requireGoalService().updateGoal(
          goalId,
          normalizeGoalUpdateArgs(updates),
          goalToolContext
        );
        logAudit('update_goal', { goal_id: goalId, fields: Object.keys(updates) });
        return jsonResult({ success: true, goal });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return jsonResult({ success: false, error: message });
      }
    },

    async pause_goal(args: { goal_id: string }): Promise<ToolResult> {
      try {
        requireGoalInSpace(args.goal_id);
        const goal = requireGoalService().pauseGoal(args.goal_id, goalToolContext);
        logAudit('pause_goal', { goal_id: args.goal_id });
        return jsonResult({ success: true, goal });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return jsonResult({ success: false, error: message });
      }
    },

    async resume_goal(args: { goal_id: string }): Promise<ToolResult> {
      try {
        requireGoalInSpace(args.goal_id);
        const goal = requireGoalService().resumeGoal(args.goal_id, goalToolContext);
        logAudit('resume_goal', { goal_id: args.goal_id });
        return jsonResult({ success: true, goal });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return jsonResult({ success: false, error: message });
      }
    },

    async trigger_goal_task(args: { goal_id: string }): Promise<ToolResult> {
      try {
        requireGoalInSpace(args.goal_id);
        const result = requireGoalService().createImmediateTask(args.goal_id, goalToolContext);
        logAudit('trigger_goal_task', { goal_id: args.goal_id }, result.task?.id);
        return jsonResult({ success: true, ...result });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return jsonResult({ success: false, error: message });
      }
    },

    async list_goal_tasks(args: {
      goal_id: string;
      status?: SpaceTaskStatus;
      limit?: number;
      before?: number;
      before_id?: string;
    }): Promise<ToolResult> {
      try {
        requireGoalInSpace(args.goal_id);
        const page = taskRepo.listByGoal(spaceId, args.goal_id, {
          status: args.status,
          limit: args.limit,
          before: args.before,
          beforeId: args.before_id,
        });
        const tasks = page.tasks.map((task) => ({
          id: task.id,
          taskNumber: task.taskNumber,
          title: task.title,
          status: task.status,
          priority: task.priority,
          createdAt: task.createdAt,
          updatedAt: task.updatedAt,
        }));
        return jsonResult({
          success: true,
          total: page.total,
          tasks,
          has_more: page.hasMore,
        });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return jsonResult({ success: false, error: message });
      }
    },

    async list_goal_events(args: {
      goal_id: string;
      limit?: number;
      before?: number;
      before_id?: string;
    }): Promise<ToolResult> {
      try {
        requireGoalInSpace(args.goal_id);
        const events = requireGoalService().listGoalEvents(args.goal_id, {
          limit: args.limit,
          before: args.before,
          beforeId: args.before_id,
        });
        return jsonResult({ success: true, total: events.length, events });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return jsonResult({ success: false, error: message });
      }
    },

    async create_forge_scope(args: {
      goal_id?: string | null;
      kind: EvolutionScopeKind;
      name: string;
      objective: string;
      parent_scope_id?: string | null;
      metric_definitions?: MetricDefinition[];
      policy?: EvolutionPolicy;
    }): Promise<ToolResult> {
      try {
        if (args.goal_id) requireGoalInSpace(args.goal_id);
        if (args.parent_scope_id) requireEvolutionScopeInSpace(args.parent_scope_id);
        if (args.policy) validateGoalAutomationSelfNagPolicy({ policy: args.policy });
        const createAndReconcile = () => {
          const created = requireEvolutionScopeService().createScope({
            spaceId,
            spaceGoalId: args.goal_id ?? null,
            kind: args.kind,
            name: args.name,
            objective: args.objective,
            parentScopeId: args.parent_scope_id ?? null,
            metricDefinitions: args.metric_definitions,
            policy: args.policy,
          });
          if (config.goalRepo && config.scheduleService) {
            syncGoalAutomationSelfNagScheduleForScope({
              goalRepo: config.goalRepo,
              scheduleService: config.scheduleService,
              scope: created,
              db: config.db,
            });
          }
          return created;
        };
        const scope = config.db
          ? config.db.transaction(createAndReconcile)()
          : createAndReconcile();
        logAudit('create_forge_scope', { name: args.name, kind: args.kind, goal_id: args.goal_id });
        return jsonResult({ success: true, scope });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return jsonResult({ success: false, error: message });
      }
    },

    async create_forge_scope_from_goal(args: {
      goal_id: string;
      name?: string;
      objective?: string;
      metric_definitions?: MetricDefinition[];
      policy?: EvolutionPolicy;
    }): Promise<ToolResult> {
      try {
        requireGoalInSpace(args.goal_id);
        if (args.policy) validateGoalAutomationSelfNagPolicy({ policy: args.policy });
        const createAndReconcile = () => {
          const created = requireEvolutionScopeService().createScopeFromGoal({
            spaceGoalId: args.goal_id,
            name: args.name,
            objective: args.objective,
            metricDefinitions: args.metric_definitions,
            policy: args.policy,
          });
          if (config.goalRepo && config.scheduleService) {
            syncGoalAutomationSelfNagScheduleForScope({
              goalRepo: config.goalRepo,
              scheduleService: config.scheduleService,
              scope: created,
              db: config.db,
            });
          }
          return created;
        };
        const scope = config.db
          ? config.db.transaction(createAndReconcile)()
          : createAndReconcile();
        logAudit('create_forge_scope_from_goal', { goal_id: args.goal_id, name: args.name });
        return jsonResult({ success: true, scope });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return jsonResult({ success: false, error: message });
      }
    },

    async list_forge_scopes(
      args: { goal_id?: string | null; kind?: EvolutionScopeKind } = {}
    ): Promise<ToolResult> {
      try {
        if (args.goal_id) requireGoalInSpace(args.goal_id);
        const scopes = requireEvolutionScopeService().listScopes({
          spaceId,
          spaceGoalId: args.goal_id,
          kind: args.kind,
        });
        return jsonResult({ success: true, scopes });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return jsonResult({ success: false, error: message });
      }
    },

    async get_forge_scope(args: { scope_id: string }): Promise<ToolResult> {
      try {
        const scope = requireEvolutionScopeInSpace(args.scope_id);
        return jsonResult({ success: true, scope });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return jsonResult({ success: false, error: message });
      }
    },

    async update_forge_scope(args: {
      scope_id: string;
      goal_id?: string | null;
      kind?: EvolutionScopeKind;
      name?: string;
      objective?: string;
      parent_scope_id?: string | null;
      metric_definitions?: MetricDefinition[];
      policy?: EvolutionPolicy;
      policy_patch?: EvolutionPolicy;
      episode_judge_model?: string | null;
      episode_judge_provider?: string | null;
    }): Promise<ToolResult> {
      try {
        const existing = requireEvolutionScopeInSpace(args.scope_id);
        if (args.goal_id) requireGoalInSpace(args.goal_id);
        if (args.parent_scope_id) requireEvolutionScopeInSpace(args.parent_scope_id);

        const patch: EvolutionPolicy = {};
        if (args.policy_patch) Object.assign(patch, args.policy_patch);
        if (args.episode_judge_model !== undefined) {
          patch.episodeJudgeModel = args.episode_judge_model ?? undefined;
        }
        if (args.episode_judge_provider !== undefined) {
          patch.episodeJudgeProvider = args.episode_judge_provider ?? undefined;
        }
        const hasPatch =
          args.policy_patch !== undefined ||
          args.episode_judge_model !== undefined ||
          args.episode_judge_provider !== undefined;

        const serviceParams: Parameters<
          import('../evolution-scope-service').EvolutionScopeService['updateScope']
        >[1] = {
          spaceGoalId: args.goal_id,
          kind: args.kind,
          name: args.name,
          objective: args.objective,
          parentScopeId: args.parent_scope_id,
          metricDefinitions: args.metric_definitions,
        };
        let resultingPolicy: EvolutionPolicy | undefined;
        if (hasPatch) {
          resultingPolicy = mergeEvolutionPolicy(existing.policy, patch);
          serviceParams.policyPatch = patch;
        } else if (args.policy) {
          resultingPolicy = args.policy;
          serviceParams.policy = resultingPolicy;
        }
        validateGoalAutomationSelfNagPolicy({
          policy: resultingPolicy ?? existing.policy,
        });

        const scope = requireEvolutionScopeService().updateScope(args.scope_id, serviceParams);
        logAudit('update_forge_scope', { scope_id: args.scope_id });
        if (scope && config.goalRepo && config.scheduleService) {
          syncGoalAutomationSelfNagScheduleForScope({
            goalRepo: config.goalRepo,
            scheduleService: config.scheduleService,
            scope,
            db: config.db,
          });
        }
        return jsonResult({ success: true, scope });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return jsonResult({ success: false, error: message });
      }
    },

    async get_forge_timeline(args: { scope_id: string }): Promise<ToolResult> {
      try {
        requireEvolutionScopeInSpace(args.scope_id);
        const timeline = requireEvolutionScopeService().listTimeline(args.scope_id);
        return jsonResult({ success: true, ...timeline });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return jsonResult({ success: false, error: message });
      }
    },

    async add_forge_manual_note(args: {
      scope_id: string;
      summary: string;
      metadata?: Record<string, unknown>;
      created_at?: number;
    }): Promise<ToolResult> {
      try {
        requireEvolutionScopeInSpace(args.scope_id);
        const evidence = requireEvolutionScopeService().addManualNoteEvidence({
          scopeId: args.scope_id,
          summary: args.summary,
          metadata: args.metadata,
          createdAt: args.created_at,
        });
        logAudit('add_forge_manual_note', { scope_id: args.scope_id });
        return jsonResult({ success: true, evidence });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return jsonResult({ success: false, error: message });
      }
    },

    async attach_forge_task_evidence(args: {
      task_id: string;
      scope_id?: string;
      summary?: string;
      metadata?: Record<string, unknown>;
    }): Promise<ToolResult> {
      try {
        const task = taskRepo.getTask(args.task_id);
        if (!task || task.spaceId !== spaceId) throw new Error(`Task not found: ${args.task_id}`);
        if (args.scope_id) requireEvolutionScopeInSpace(args.scope_id);
        const evidence = requireEvolutionScopeService().attachTaskEvidence({
          taskId: args.task_id,
          scopeId: args.scope_id,
          summary: args.summary,
          metadata: args.metadata,
        });
        requireEvolutionScopeInSpace(evidence.scopeId);
        logAudit('attach_forge_task_evidence', {
          scope_id: evidence.scopeId,
          task_id: args.task_id,
        });
        return jsonResult({ success: true, evidence });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return jsonResult({ success: false, error: message });
      }
    },

    async attach_forge_workflow_run_evidence(args: {
      workflow_run_id: string;
      scope_id?: string;
      summary?: string;
      metadata?: Record<string, unknown>;
    }): Promise<ToolResult> {
      try {
        const run = workflowRunRepo.getRun(args.workflow_run_id);
        if (!run || run.spaceId !== spaceId) {
          throw new Error(`Workflow run not found: ${args.workflow_run_id}`);
        }
        if (args.scope_id) requireEvolutionScopeInSpace(args.scope_id);
        const evidence = requireEvolutionScopeService().attachWorkflowRunEvidence({
          workflowRunId: args.workflow_run_id,
          scopeId: args.scope_id,
          summary: args.summary,
          metadata: args.metadata,
        });
        requireEvolutionScopeInSpace(evidence.scopeId);
        logAudit('attach_forge_workflow_run_evidence', {
          scope_id: evidence.scopeId,
          workflow_run_id: args.workflow_run_id,
        });
        return jsonResult({ success: true, evidence });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return jsonResult({ success: false, error: message });
      }
    },

    async add_forge_metric_snapshot(args: {
      scope_id: string;
      values: MetricSnapshotValues;
      source: string;
      note?: string | null;
      captured_at?: number;
      summary?: string;
      metadata?: Record<string, unknown>;
    }): Promise<ToolResult> {
      try {
        requireEvolutionScopeInSpace(args.scope_id);
        const result = requireEvolutionScopeService().addMetricSnapshotEvidence({
          scopeId: args.scope_id,
          values: args.values,
          source: args.source,
          note: args.note,
          capturedAt: args.captured_at,
          summary: args.summary,
          metadata: args.metadata,
        });
        logAudit('add_forge_metric_snapshot', { scope_id: args.scope_id, source: args.source });
        return jsonResult({ success: true, ...result });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return jsonResult({ success: false, error: message });
      }
    },

    async list_forge_evidence(args: { scope_id: string }): Promise<ToolResult> {
      try {
        requireEvolutionScopeInSpace(args.scope_id);
        const { evidence } = requireEvolutionScopeService().listEvidence(args.scope_id);
        return jsonResult({ success: true, evidence });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return jsonResult({ success: false, error: message });
      }
    },

    async list_forge_metric_snapshots(args: { scope_id: string }): Promise<ToolResult> {
      try {
        requireEvolutionScopeInSpace(args.scope_id);
        const snapshots = requireEvolutionScopeService().listMetricSnapshots(args.scope_id);
        return jsonResult({ success: true, snapshots });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return jsonResult({ success: false, error: message });
      }
    },

    async create_forge_episode(args: {
      scope_id: string;
      evidence_ids: string[];
      time_window?: CreateEvolutionEpisodeParams['timeWindow'];
      confirm_low_confidence?: boolean;
    }): Promise<ToolResult> {
      try {
        requireEvolutionScopeInSpace(args.scope_id);
        const result = await requireEvolutionEpisodeService().createFromEvidence({
          scopeId: args.scope_id,
          evidenceIds: args.evidence_ids,
          timeWindow: args.time_window,
          confirmLowConfidence: args.confirm_low_confidence,
        });
        logAudit('create_forge_episode', {
          scope_id: args.scope_id,
          evidence_count: args.evidence_ids.length,
        });
        return jsonResult({ success: true, ...result });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return jsonResult({ success: false, error: message });
      }
    },

    async list_forge_review_bundle(args: { scope_id: string }): Promise<ToolResult> {
      try {
        requireEvolutionScopeInSpace(args.scope_id);
        const bundle = requireEvolutionEpisodeService().listReviewBundle(args.scope_id);
        return jsonResult({ success: true, ...bundle });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return jsonResult({ success: false, error: message });
      }
    },

    async list_forge_lessons(args: {
      scope_id: string;
      status?: EvolutionLessonStatus;
    }): Promise<ToolResult> {
      try {
        requireEvolutionScopeInSpace(args.scope_id);
        const lessons = requireEvolutionEpisodeService().listLessons(args.scope_id, args.status);
        logAudit('list_forge_lessons', { scope_id: args.scope_id, status: args.status });
        return jsonResult({ success: true, lessons });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return jsonResult({ success: false, error: message });
      }
    },

    async list_forge_proposals(args: {
      scope_id: string;
      status?: TaskProposalStatus;
    }): Promise<ToolResult> {
      try {
        requireEvolutionScopeInSpace(args.scope_id);
        const proposals = requireEvolutionEpisodeService().listTaskProposals(
          args.scope_id,
          args.status
        );
        logAudit('list_forge_proposals', { scope_id: args.scope_id, status: args.status });
        return jsonResult({ success: true, proposals });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return jsonResult({ success: false, error: message });
      }
    },

    async resolve_forge_scope(args: { goal_id?: string; task_id?: string }): Promise<ToolResult> {
      try {
        let scope;
        if (args.goal_id) {
          requireGoalInSpace(args.goal_id);
          scope = requireEvolutionScopeService().resolveScopeForGoal({
            spaceGoalId: args.goal_id,
          });
        } else if (args.task_id) {
          const task = taskRepo.getTask(args.task_id);
          if (!task || task.spaceId !== spaceId) throw new Error(`Task not found: ${args.task_id}`);
          scope = requireEvolutionScopeService().resolveScopeForTask({ taskId: args.task_id });
        } else {
          throw new Error('Provide goal_id or task_id');
        }
        if (!scope) return jsonResult({ success: false, error: 'No scope found' });
        logAudit('resolve_forge_scope', {
          goal_id: args.goal_id,
          task_id: args.task_id,
          scope_id: scope.id,
        });
        return jsonResult({ success: true, scope });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return jsonResult({ success: false, error: message });
      }
    },

    async update_forge_episode(args: {
      episode_id: string;
      status?: EvolutionEpisodeStatus;
      title?: string;
      outcome_summary?: string;
    }): Promise<ToolResult> {
      try {
        const existing = requireEvolutionEpisodeInSpace(args.episode_id);
        if (existing.status !== 'draft' && args.status && args.status !== existing.status) {
          throw new Error('Terminal Forge episodes cannot be reopened');
        }
        const episode = requireEvolutionEpisodeService().updateEpisode(args.episode_id, {
          status: args.status,
          title: args.title,
          outcomeSummary: args.outcome_summary,
        });
        logAudit('update_forge_episode', { episode_id: args.episode_id, status: args.status });
        return jsonResult({ success: true, episode });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return jsonResult({ success: false, error: message });
      }
    },

    async update_forge_lesson(args: {
      lesson_id: string;
      status?: EvolutionLessonStatus;
      applies_to?: string[];
      rule?: string;
      why?: string;
      confidence?: number;
    }): Promise<ToolResult> {
      try {
        const existing = requireEvolutionLessonInSpace(args.lesson_id);
        if (existing.status === 'dismissed' && args.status && args.status !== 'dismissed') {
          throw new Error('Dismissed lessons cannot be reactivated');
        }
        const lesson = requireEvolutionEpisodeService().updateLesson(args.lesson_id, {
          status: args.status,
          appliesTo: args.applies_to,
          rule: args.rule,
          why: args.why,
          confidence: args.confidence,
        });
        logAudit('update_forge_lesson', { lesson_id: args.lesson_id, status: args.status });
        return jsonResult({ success: true, lesson });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return jsonResult({ success: false, error: message });
      }
    },

    async create_forge_task_proposal(args: {
      scope_id: string;
      title: string;
      description: string;
      reason: string;
      priority?: SpaceTaskPriority;
      evidence_episode_ids?: string[];
    }): Promise<ToolResult> {
      try {
        requireEvolutionScopeInSpace(args.scope_id);
        for (const episodeId of args.evidence_episode_ids ?? []) {
          const episode = requireEvolutionEpisodeInSpace(episodeId);
          if (episode.scopeId !== args.scope_id) {
            throw new Error(`EvolutionEpisode not found in scope: ${episodeId}`);
          }
        }
        const proposal = requireEvolutionEpisodeService().createTaskProposal({
          scopeId: args.scope_id,
          title: args.title,
          description: args.description,
          reason: args.reason,
          priority: args.priority,
          evidenceEpisodeIds: args.evidence_episode_ids,
        });
        logAudit('create_forge_task_proposal', { scope_id: args.scope_id, title: args.title });
        return jsonResult({ success: true, proposal });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return jsonResult({ success: false, error: message });
      }
    },

    async update_forge_task_proposal(args: {
      proposal_id: string;
      title?: string;
      description?: string;
      reason?: string;
      priority?: SpaceTaskPriority;
      status?: TaskProposalStatus;
    }): Promise<ToolResult> {
      try {
        const existing = requireTaskProposalInSpace(args.proposal_id);
        if (args.status === 'created') {
          throw new Error('Use create_task_from_forge_proposal to create tasks from proposals');
        }
        if (existing.status === 'created' && args.status) {
          throw new Error('Created task proposals cannot be reopened');
        }
        if (existing.status === 'dismissed' && args.status && args.status !== 'dismissed') {
          throw new Error('Dismissed proposals cannot be reopened');
        }
        const proposal = requireEvolutionEpisodeService().updateTaskProposal(args.proposal_id, {
          title: args.title,
          description: args.description,
          reason: args.reason,
          priority: args.priority,
          status: args.status,
        });
        logAudit('update_forge_task_proposal', {
          proposal_id: args.proposal_id,
          status: args.status,
        });
        return jsonResult({ success: true, proposal });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return jsonResult({ success: false, error: message });
      }
    },

    async create_task_from_forge_proposal(args: {
      proposal_id: string;
      title?: string;
      description?: string;
      reason?: string;
      priority?: SpaceTaskPriority;
      depends_on?: string[];
    }): Promise<ToolResult> {
      try {
        requireTaskProposalInSpace(args.proposal_id);
        const result = requireEvolutionEpisodeService().createTaskFromProposal(args.proposal_id, {
          title: args.title,
          description: args.description,
          reason: args.reason,
          priority: args.priority,
          dependsOn: args.depends_on,
        });
        logAudit(
          'create_task_from_forge_proposal',
          { proposal_id: args.proposal_id, depends_on: args.depends_on },
          result.task.id
        );
        return jsonResult({ success: true, ...result });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return jsonResult({ success: false, error: message });
      }
    },

    async apply_forge_rollup(args: {
      episode_id: string;
      goal_update: {
        summary?: string;
        progress?: number;
        next_steps?: string[];
        metrics?: Record<string, string | number | boolean | null>;
      };
    }): Promise<ToolResult> {
      try {
        requireEvolutionEpisodeInSpace(args.episode_id);
        const result = requireEvolutionEpisodeService().applyRollupGoalUpdate({
          episodeId: args.episode_id,
          goalUpdate: {
            summary: args.goal_update.summary,
            progress: args.goal_update.progress,
            nextSteps: args.goal_update.next_steps,
            metrics: args.goal_update.metrics,
          },
        });
        logAudit('apply_forge_rollup', { episode_id: args.episode_id });
        return jsonResult({ success: true, ...result });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return jsonResult({ success: false, error: message });
      }
    },

    async create_scheduled_task(args: {
      title: string;
      description: string;
      priority?: SpaceTaskPriority;
      workflow_id?: string;
      labels?: string[];
      trigger_type: TaskScheduleTriggerType;
      cron_expression?: string;
      run_at?: number;
      timezone?: string;
    }): Promise<ToolResult> {
      if (!config.scheduleService) {
        return jsonResult({ success: false, error: 'Schedule management not available' });
      }
      try {
        const schedule = config.scheduleService.createSchedule({
          spaceId,
          title: args.title,
          description: args.description ?? '',
          priority: args.priority,
          preferredWorkflowId: args.workflow_id ?? null,
          labels: args.labels,
          triggerType: args.trigger_type,
          cronExpression: args.cron_expression ?? null,
          runAt: args.run_at ?? null,
          timezone: args.timezone,
          createdByAgent: myAgentName ?? null,
          createdBySession: mySessionId ?? null,
        });
        logAudit('create_scheduled_task', {
          title: args.title,
          trigger_type: args.trigger_type,
          cron_expression: args.cron_expression,
          run_at: args.run_at,
          timezone: args.timezone,
        });
        return jsonResult({ success: true, schedule });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return jsonResult({ success: false, error: message });
      }
    },

    async list_scheduled_tasks(args: { status?: TaskScheduleStatus }): Promise<ToolResult> {
      if (!config.scheduleService) {
        return jsonResult({ success: false, error: 'Schedule management not available' });
      }
      try {
        const schedules = config.scheduleService.listSchedules(spaceId, args.status);
        return jsonResult({ success: true, schedules });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return jsonResult({ success: false, error: message });
      }
    },

    async get_scheduled_task(args: { schedule_id: string }): Promise<ToolResult> {
      if (!config.scheduleService) {
        return jsonResult({ success: false, error: 'Schedule management not available' });
      }
      try {
        const schedule = config.scheduleService.getSchedule(args.schedule_id);
        if (!schedule || schedule.spaceId !== spaceId) {
          return jsonResult({ success: false, error: `Schedule not found: ${args.schedule_id}` });
        }
        return jsonResult({ success: true, schedule });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return jsonResult({ success: false, error: message });
      }
    },

    async pause_scheduled_task(args: { schedule_id: string }): Promise<ToolResult> {
      if (!config.scheduleService) {
        return jsonResult({ success: false, error: 'Schedule management not available' });
      }
      try {
        const existing = config.scheduleService.getSchedule(args.schedule_id);
        if (!existing || existing.spaceId !== spaceId) {
          return jsonResult({ success: false, error: `Schedule not found: ${args.schedule_id}` });
        }
        const schedule = config.scheduleService.pauseSchedule(args.schedule_id);
        logAudit('pause_scheduled_task', { schedule_id: args.schedule_id });
        return jsonResult({ success: true, schedule });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return jsonResult({ success: false, error: message });
      }
    },

    async resume_scheduled_task(args: { schedule_id: string }): Promise<ToolResult> {
      if (!config.scheduleService) {
        return jsonResult({ success: false, error: 'Schedule management not available' });
      }
      try {
        const existing = config.scheduleService.getSchedule(args.schedule_id);
        if (!existing || existing.spaceId !== spaceId) {
          return jsonResult({ success: false, error: `Schedule not found: ${args.schedule_id}` });
        }
        const schedule = config.scheduleService.resumeSchedule(args.schedule_id);
        logAudit('resume_scheduled_task', { schedule_id: args.schedule_id });
        return jsonResult({ success: true, schedule });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return jsonResult({ success: false, error: message });
      }
    },

    async delete_scheduled_task(args: { schedule_id: string }): Promise<ToolResult> {
      if (!config.scheduleService) {
        return jsonResult({ success: false, error: 'Schedule management not available' });
      }
      try {
        const existing = config.scheduleService.getSchedule(args.schedule_id);
        if (!existing || existing.spaceId !== spaceId) {
          return jsonResult({ success: false, error: `Schedule not found: ${args.schedule_id}` });
        }
        const ok = config.scheduleService.deleteSchedule(args.schedule_id);
        if (!ok) {
          return jsonResult({
            success: false,
            error:
              'Schedule was modified concurrently (e.g. a fire job advanced it). Please retry.',
          });
        }
        logAudit('delete_scheduled_task', { schedule_id: args.schedule_id });
        return jsonResult({ success: true });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return jsonResult({ success: false, error: message });
      }
    },
  };
}

export function createSpaceAgentMcpServer(config: SpaceAgentToolsConfig) {
  const handlers = createSpaceAgentToolHandlers(config);

  const agentStatusSchema = z.enum(['active', 'paused', 'disabled', 'archived']);
  const thinkingLevelSchema = z.enum(['off', 'think8k', 'think16k', 'think24k', 'think32k']);
  const settingSourcesSchema = z.array(z.enum(['user', 'project', 'local']));
  const sessionStatusSchema = z.enum(['active', 'idle', 'waiting_for_input', 'error', 'archived']);
  const sessionTypeSchema = z.enum(['worker', 'ad-hoc']);
  const mutableProcessingStateSchema = z.enum(['idle', 'running', 'waiting_for_input']);
  // oxlint-disable-next-line typescript/no-explicit-any -- SDK tool list is heterogeneous by schema.
  const tools: SdkMcpToolDefinition<any>[] = [
    tool(
      'list_sessions',
      'List all ad-hoc and worker sessions in this Space. Filter by derived status or type, with limit/offset pagination.',
      {
        status: sessionStatusSchema.optional().describe('Filter by status'),
        type: sessionTypeSchema.optional().describe('Filter by session type'),
        limit: z.number().int().positive().max(SPACE_SESSION_MAX_LIMIT).optional().default(50),
        offset: z.number().int().min(0).optional().default(0),
      },
      (args) => handlers.list_sessions(args)
    ),
    tool(
      'get_session_detail',
      'Inspect one Space session including parsed processing_state and last 5 messages.',
      { session_id: z.string().describe('Session ID') },
      (args) => handlers.get_session_detail(args)
    ),
    tool(
      'get_session_messages',
      'Retrieve conversation messages for one Space session with summaries and optional timestamp cursor.',
      {
        session_id: z.string().describe('Session ID'),
        limit: z.number().int().positive().max(SESSION_MESSAGE_MAX_LIMIT).optional().default(20),
        before: z.string().optional().describe('Return messages before this timestamp'),
      },
      (args) => handlers.get_session_messages(args)
    ),
    tool(
      'send_session_message',
      'Send a user message to an ad-hoc Space session. Use answer_question:true to clear a waiting_for_input pending question.',
      {
        session_id: z.string().describe('Target session ID'),
        message: z.string().min(1).describe('Message text'),
        answer_question: z
          .boolean()
          .optional()
          .describe('Clear pending question state while delivering this message'),
      },
      (args) => handlers.send_session_message(args)
    ),
    tool(
      'update_session_state',
      'Mutate a Space session processing state to recover stuck sessions. Requires sufficient Space autonomy.',
      {
        session_id: z.string().describe('Target session ID'),
        processing_state: mutableProcessingStateSchema.describe('New processing state'),
        clear_pending_question: z.boolean().optional().describe('Clear stale pendingQuestion'),
      },
      (args) => handlers.update_session_state(args)
    ),
    tool(
      'interrupt_session',
      'Force-interrupt a running or stuck Space session, append interrupt transcript entries, and reset state to idle. Requires sufficient Space autonomy.',
      {
        session_id: z.string().describe('Target session ID'),
        reason: z.string().optional().describe('Reason recorded in the terminal result'),
      },
      (args) => handlers.interrupt_session(args)
    ),
    tool(
      'list_workflows',
      'Show all workflows in this space with their descriptions and steps. Call this first to understand available options before creating a task.',
      {},
      () => handlers.list_workflows()
    ),
    tool(
      'get_workflow_run',
      'Check the current status of a workflow run, including the current step and associated tasks.',
      {
        run_id: z.string().describe('ID of the workflow run to inspect'),
      },
      (args) => handlers.get_workflow_run(args)
    ),
    tool(
      'change_plan',
      'Update the task description for an ongoing run, or switch to a different workflow mid-run (cancels the current run and starts a new one).',
      {
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
      },
      (args) => handlers.change_plan(args)
    ),
    tool(
      'get_workflow_detail',
      'Get the full definition of a specific workflow, including all steps, transitions, and rules. Use this to inspect a candidate workflow before creating a task.',
      {
        workflow_id: z.string().optional().describe('ID of the workflow to retrieve'),
        workflow_handle: z
          .string()
          .optional()
          .describe('Handle of the workflow to retrieve (alternative to workflow_id)'),
      },
      (args) => handlers.get_workflow_detail(args)
    ),
    tool(
      'suggest_workflow',
      'List all workflows available in this space so you can pick the best one for a described piece of work. Returns every workflow in creation order with its id, handle (human-readable slug usable as workflow_handle in create_standalone_task), name, description, tags, and nodes — no pre-ranking, so your own reasoning is not biased by keyword overlap.',
      {
        description: z
          .string()
          .describe(
            'Description of the work you want to do. Provided for context; the tool returns all workflows regardless.'
          ),
      },
      (args) => handlers.suggest_workflow(args)
    ),
    tool(
      'list_tasks',
      'List SpaceTasks for this space. Filterable by status and workflow run. Use compact:true and limit/offset to reduce payload size.',
      {
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
      },
      (args) => handlers.list_tasks(args)
    ),
    tool(
      'create_standalone_task',
      'Create a task request. Runtime may attach and execute a workflow for this task during orchestration. Supports structured task dependencies via depends_on — the task will be blocked until every listed dependency reaches status=done, and cascade-cancelled if a dependency is cancelled.',
      {
        title: z.string().describe('Short title for the task'),
        description: z.string().describe('Detailed description of the work to be done'),
        priority: z
          .enum(['low', 'normal', 'high', 'urgent'])
          .optional()
          .describe('Task priority (default: normal)'),
        custom_agent_id: z
          .string()
          .optional()
          .describe('ID of a worker agent to assign this task to'),
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
      },
      (args) => handlers.create_standalone_task(args)
    ),
    tool(
      'get_task_detail',
      'Retrieve detailed information about a specific task including its status, result, and metadata.',
      {
        task_id: z.string().optional().describe('UUID of the task to retrieve'),
        task_number: z
          .number()
          .optional()
          .describe('Numeric task ID (e.g. 5 for task #5) — preferred over task_id'),
      },
      (args) => handlers.get_task_detail(args)
    ),
    tool(
      'update_task',
      "Edit an existing task's title, description, priority, dependencies, or status. The task must belong to this space. Only the fields you provide are updated. Status changes follow the same transition table as the UI, with the same restrictions: invalid transitions are rejected with the allowed list, 'review' and 'approved' cannot be set here, review→done is owned by the approval pipeline, and archiving a task on an active workflow run is rejected.",
      {
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
      },
      (args) => handlers.update_task(args)
    ),
    tool(
      'retry_task',
      'Retry a failed or cancelled task. Optionally update the task description for the retry attempt.',
      {
        task_id: z.string().describe('ID of the task to retry'),
        description: z
          .string()
          .optional()
          .describe('Updated task description for the retry attempt'),
      },
      (args) => handlers.retry_task(args)
    ),
    tool(
      'cancel_task',
      'Cancel a task. Automatically cascades cancellation to pending dependent tasks. Optionally also cancel the associated workflow run.',
      {
        task_id: z.string().describe('ID of the task to cancel'),
        cancel_workflow_run: z
          .boolean()
          .optional()
          .describe(
            'If true and the task belongs to a workflow run, also cancel that workflow run'
          ),
      },
      (args) => handlers.cancel_task(args)
    ),
    tool(
      'reassign_task',
      'Change the agent assignment for a task. Only allowed for tasks in open, blocked, or cancelled status.',
      {
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
      },
      (args) => handlers.reassign_task(args)
    ),
    tool(
      'publish_task',
      'Publish a draft task, transitioning it from draft to open status. Published tasks become eligible for orchestration by the runtime tick loop. Only valid for tasks in draft status.',
      {
        task_id: z.string().describe('UUID of the draft task to publish'),
      },
      (args) => handlers.publish_task(args)
    ),
    tool(
      'archive_task',
      "Archive a task. Archived tasks are excluded from most queries and cannot be reactivated — this is the true terminal state. Valid from any status that allows the 'archived' transition (e.g. draft, done, cancelled, blocked, review, approved).",
      {
        task_id: z.string().describe('UUID of the task to archive'),
      },
      (args) => handlers.archive_task(args)
    ),

    tool(
      'send_message_to_task',
      'Send a message to a specific workflow node agent or long-term Space agent on a task. Use node_id for workflow nodes, or target for @handle/@role/@session/@worker addresses. Inactive workflow nodes or long-term agents are activated/queued when supported. Provide either task_id or task_number — if both are given, task_id takes precedence.',
      {
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
      },
      (args) => handlers.send_message_to_task(args)
    ),
    tool(
      'list_task_members',
      "List all node executions (workflow member agents) for a task. Returns each node's status, result, and saved data. Use this to inspect the detailed execution state of a running or completed workflow task.",
      {
        task_id: z.string().describe('ID of the task to inspect'),
      },
      (args) => handlers.list_task_members(args)
    ),
    tool(
      'approve_task',
      "Approve a task in 'review' status, transitioning it to 'done'. Use this after reviewing a completed task's output to mark it as approved.",
      {
        task_id: z.string().describe('ID of the task to approve'),
        reason: z.string().optional().describe('Reason for approval'),
      },
      (args) => handlers.approve_task(args)
    ),
    tool(
      'approve_pending_completion',
      "Approve or reject a task paused at a submit_for_approval checkpoint (the human-approval path). This is the coordinator's programmatic equivalent of the UI 'Approve' banner: approved transitions review → approved and fires the post-approval router; rejected transitions review → in_progress. Coordinator/task-agent sessions only — worker node agents use approve_task to self-close.",
      {
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
      },
      (args) => handlers.approve_pending_completion(args)
    ),
  ];

  if (config.db) {
    tools.unshift(
      tool(
        'list_agents',
        'List long-horizon Space agents in this space.',
        {
          status: agentStatusSchema.optional().describe('Filter by agent lifecycle status'),
          compact: z.boolean().optional().describe('Return compact agent summaries'),
        },
        (args) => handlers.list_agents(args)
      ),
      tool(
        'get_agent',
        'Get one long-horizon Space agent by ID.',
        { agent_id: z.string().describe('Long-horizon agent ID') },
        (args) => handlers.get_agent(args)
      ),
      tool(
        'create_agent',
        'Create a long-horizon Space agent. Tool-permission changes are validated against the known tool allowlist.',
        {
          name: z.string().min(1).describe('Agent name, unique within the space'),
          description: z.string().optional().describe('Agent specialization summary'),
          model: z.string().optional().describe('Model override'),
          thinking_level: thinkingLevelSchema.optional().describe('Thinking level override'),
          provider: z.string().optional().describe('Provider override'),
          custom_prompt: z
            .string()
            .nullable()
            .optional()
            .describe('Operator prompt for this agent'),
          tools: z.array(z.string()).optional().describe('Tool allowlist override'),
          setting_sources: settingSourcesSchema
            .nullable()
            .optional()
            .describe('Settings sources for this agent'),
        },
        (args) => handlers.create_agent(args)
      ),
      tool(
        'create_agent_from_template',
        'Create a long-horizon Space agent from a built-in template. Accepts a worker preset name (Coder, Reviewer, QA, ...) or a long-horizon template key (marketing.default, security-auditor.default, ...). Long-horizon templates seed their suggested event subscriptions and reminders. Call list_agent_templates to discover available templates.',
        {
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
          thinking_level: thinkingLevelSchema.optional().describe('Thinking level override'),
        },
        (args) => handlers.create_agent_from_template(args)
      ),
      tool(
        'list_agent_templates',
        'List the built-in agent templates available to create_agent_from_template: worker presets (Coder, Reviewer, QA, ...) and long-horizon templates (marketing.default, security-auditor.default, ...).',
        {},
        () => handlers.list_agent_templates()
      ),
      tool(
        'update_agent',
        'Update a long-horizon Space agent. Autonomy/tool-permission escalation is limited by manager validation and audited.',
        {
          agent_id: z.string().describe('Long-horizon agent ID'),
          name: z.string().optional().describe('New agent name'),
          status: agentStatusSchema.optional().describe('Lifecycle status'),
          description: z.string().nullable().optional().describe('New description'),
          model: z.string().nullable().optional().describe('Model override, or null to clear'),
          thinking_level: thinkingLevelSchema
            .nullable()
            .optional()
            .describe('Thinking level override, or null to clear'),
          provider: z
            .string()
            .nullable()
            .optional()
            .describe('Provider override, or null to clear'),
          custom_prompt: z
            .string()
            .nullable()
            .optional()
            .describe('Prompt override, or null to clear'),
          tools: z
            .array(z.string())
            .nullable()
            .optional()
            .describe('Tool allowlist override, or null to clear'),
          setting_sources: settingSourcesSchema
            .nullable()
            .optional()
            .describe('Settings sources override, or null to clear'),
        },
        (args) => handlers.update_agent(args)
      ),
      tool(
        'pause_agent',
        'Pause a long-horizon Space agent without deleting it.',
        { agent_id: z.string().describe('Long-horizon agent ID') },
        (args) => handlers.pause_agent(args)
      ),
      tool(
        'archive_agent',
        'Archive a long-horizon Space agent.',
        { agent_id: z.string().describe('Long-horizon agent ID') },
        (args) => handlers.archive_agent(args)
      ),
      tool(
        'assign_agent_to_goal',
        'Assign a long-horizon Space agent to a goal.',
        {
          agent_id: z.string().describe('Long-horizon agent ID'),
          goal_id: z.string().describe('Goal ID'),
        },
        (args) => handlers.assign_agent_to_goal(args)
      ),
      tool(
        'unassign_agent_from_goal',
        'Remove a long-horizon Space agent goal assignment.',
        {
          agent_id: z.string().describe('Long-horizon agent ID'),
          goal_id: z.string().describe('Goal ID'),
        },
        (args) => handlers.unassign_agent_from_goal(args)
      ),
      tool(
        'assign_agent_to_forge_scope',
        'Assign a long-horizon Space agent to a Forge scope.',
        {
          agent_id: z.string().describe('Long-horizon agent ID'),
          scope_id: z.string().describe('Forge scope ID'),
        },
        (args) => handlers.assign_agent_to_forge_scope(args)
      ),
      tool(
        'unassign_agent_from_forge_scope',
        'Remove a long-horizon Space agent Forge scope assignment.',
        {
          agent_id: z.string().describe('Long-horizon agent ID'),
          scope_id: z.string().describe('Forge scope ID'),
        },
        (args) => handlers.unassign_agent_from_forge_scope(args)
      ),
      tool(
        'create_agent_reminder',
        'Create a reminder for a long-horizon Space agent.',
        {
          agent_id: z.string().describe('Long-horizon agent ID'),
          message: z.string().min(1).describe('Reminder message'),
          remind_at: z.number().int().describe('Reminder timestamp in ms since epoch'),
        },
        (args) => handlers.create_agent_reminder(args)
      ),
      tool(
        'list_agent_reminders',
        'List reminders for a long-horizon Space agent.',
        {
          agent_id: z.string().describe('Long-horizon agent ID'),
          status: z.enum(['active', 'done', 'cancelled']).optional().describe('Reminder status'),
        },
        (args) => handlers.list_agent_reminders(args)
      ),
      tool(
        'subscribe_agent_event',
        'Record an external-event subscription for a long-horizon Space agent.',
        {
          agent_id: z.string().describe('Long-horizon agent ID'),
          topic_pattern: z.string().describe('External event topic glob pattern'),
          label: z.string().optional().describe('Human-readable subscription label'),
        },
        (args) => handlers.subscribe_agent_event(args)
      ),
      tool(
        'unsubscribe_agent_event',
        'Remove an external-event subscription from a long-horizon Space agent.',
        {
          agent_id: z.string().describe('Long-horizon agent ID'),
          topic_pattern: z.string().describe('External event topic glob pattern'),
          label: z.string().optional().describe('Human-readable subscription label'),
        },
        (args) => handlers.unsubscribe_agent_event(args)
      ),
      tool(
        'list_agent_event_subscriptions',
        'List external-event subscriptions for a long-horizon Space agent.',
        { agent_id: z.string().describe('Long-horizon agent ID') },
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
        { eventId: z.string().min(1).describe('The id of the external event to fetch') },
        (args) => handlers.get_external_event(args)
      )
    );
  }

  const goalStatusSchema = z.enum(['active', 'paused', 'completed', 'archived']);
  const goalTypeSchema = z.enum(['one_shot', 'measurable', 'recurring']);
  const goalMetricsSchema = z.record(
    z.string(),
    z.union([z.string(), z.number(), z.boolean(), z.null()])
  );

  if (config.goalService) {
    const goalUpdateShape = {
      title: z.string().min(1).optional().describe('New goal title'),
      description: z.string().optional().describe('New goal description'),
      status: goalStatusSchema.optional().describe('New lifecycle status'),
      type: goalTypeSchema.optional().describe('Goal type'),
      priority: z.enum(['low', 'normal', 'high', 'urgent']).optional().describe('Goal priority'),
      labels: z.array(z.string()).optional().describe('Labels for future goal tasks'),
      metrics: goalMetricsSchema.optional().describe('Structured measurement state'),
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
        .describe(
          'Queue one follow-up run when trigger is called while another goal task is active'
        ),
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
    };

    tools.push(
      tool(
        'list_goals',
        'List long-horizon goals in this space. Use this before changing goal progress or creating goal tasks.',
        { status: goalStatusSchema.optional().describe('Filter by goal status') },
        (args) => handlers.list_goals(args)
      ),
      tool(
        'get_goal',
        'Get one goal with rolling state, active task pointers, next check-in, metrics, and next steps.',
        { goal_id: z.string().describe('Goal ID') },
        (args) => handlers.get_goal(args)
      ),
      tool(
        'create_goal',
        'Create a long-horizon goal in this space. Optionally schedule recurring check-ins or trigger the first task immediately.',
        {
          title: z.string().min(1).describe('Goal title'),
          description: z.string().optional().describe('Goal description'),
          type: goalTypeSchema.optional().describe('Goal type'),
          priority: z
            .enum(['low', 'normal', 'high', 'urgent'])
            .optional()
            .describe('Goal priority'),
          labels: z.array(z.string()).optional().describe('Labels for future goal tasks'),
          metrics: goalMetricsSchema.optional().describe('Initial structured metric state'),
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
          trigger_immediately: z
            .boolean()
            .optional()
            .describe('Create first goal task immediately'),
          owner_agent_id: z
            .string()
            .nullable()
            .optional()
            .describe(
              'Long-horizon agent id to assign as the goal primary owner atomically at creation. Defaults to the calling agent (self-claim) or the coordinator when absent.'
            ),
        },
        (args) => handlers.create_goal(args)
      ),
      tool(
        'update_goal',
        'Update public goal fields and rolling state. Use summary/progress/metrics/next_steps to keep long-horizon state current. check_in_cron_expression/check_in_timezone edit a recurring goal check-in schedule in place (set, change cadence/timezone, or null to remove) and take effect immediately — the next fire is rescheduled atomically. Internal fields like activeTaskId and taskScheduleId are not writable.',
        { goal_id: z.string().describe('Goal ID'), ...goalUpdateShape },
        (args) => handlers.update_goal(args)
      ),
      tool(
        'pause_goal',
        'Pause an active goal and its linked check-in schedule if present.',
        { goal_id: z.string().describe('Goal ID') },
        (args) => handlers.pause_goal(args)
      ),
      tool(
        'resume_goal',
        'Resume a paused goal and re-enable its linked check-in schedule if present.',
        { goal_id: z.string().describe('Goal ID') },
        (args) => handlers.resume_goal(args)
      ),
      tool(
        'trigger_goal_task',
        'Create an immediate task for a goal. If another goal task is active and auto_trigger_next is true, queues one follow-up instead of overlapping work.',
        { goal_id: z.string().describe('Goal ID') },
        (args) => handlers.trigger_goal_task(args)
      ),
      tool(
        'list_goal_tasks',
        "List tasks linked to a goal in this space, optionally filtered by status. Returns a bounded page (default 20, max 100) of compact task summaries (id, task_number, title, status, priority, createdAt, updatedAt) ordered by most-recently-created; results omit description and result. Pass the last item's createdAt as `before` and its id as `before_id` to fetch the next page. Use `get_task_detail` to retrieve the full record for any task whose outcome you need to inspect.",
        {
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
          limit: z
            .number()
            .int()
            .min(1)
            .max(100)
            .optional()
            .describe('Max tasks to return (default 20)'),
          before: z
            .number()
            .int()
            .optional()
            .describe('Return tasks created before this timestamp (cursor)'),
          before_id: z.string().optional().describe('Cursor id for same-timestamp pagination'),
        },
        (args) => handlers.list_goal_tasks(args)
      ),
      tool(
        'list_goal_events',
        'List append-only history events for a goal. Use this to understand why the current rolling state changed before updating it.',
        {
          goal_id: z.string().describe('Goal ID'),
          limit: z.number().int().min(1).max(100).optional().describe('Max events to return'),
          before: z.number().int().optional().describe('Return events before this timestamp'),
          before_id: z
            .string()
            .optional()
            .describe('Cursor event ID for same-timestamp pagination'),
        },
        (args) => handlers.list_goal_events(args)
      )
    );
  }

  if (config.evolutionScopeService && config.evolutionEpisodeService) {
    const forgeScopeKindSchema = z.enum(['mission', 'project', 'campaign', 'workflow', 'custom']);
    const forgePolicySchema = z.record(z.string(), z.unknown());
    const metricDefinitionSchema = z.object({
      key: z.string().min(1).describe('Stable metric key'),
      label: z.string().min(1).describe('Human-readable metric label'),
      description: z.string().optional().describe('What this metric measures'),
      direction: z.enum(['increase', 'decrease', 'target', 'maintain']),
      targetValue: z.union([z.string(), z.number(), z.boolean(), z.null()]).optional(),
      unit: z.string().optional(),
    });
    const metricValuesSchema = z.record(
      z.string(),
      z.union([z.string(), z.number(), z.boolean(), z.null()])
    );
    const metadataSchema = z.record(z.string(), z.unknown());
    const episodeStatusSchema = z.enum(['draft', 'accepted', 'dismissed']);
    const lessonStatusSchema = z.enum(['candidate', 'active', 'dismissed']);
    const proposalUpdateStatusSchema = z.enum(['proposed', 'accepted', 'dismissed']);
    const proposalStatusSchema = z.enum(['proposed', 'accepted', 'dismissed', 'created']);
    const prioritySchema = z.enum(['low', 'normal', 'high', 'urgent']);

    tools.push(
      tool(
        'create_forge_scope',
        'Create a Forge EvolutionScope in this space. Use goal_id to link it to a recurring goal; policy can include episodeJudgeModel and other judge guidance.',
        {
          goal_id: z.string().nullable().optional().describe('Optional linked SpaceGoal ID'),
          kind: forgeScopeKindSchema.describe('Scope kind'),
          name: z.string().min(1).describe('Scope name'),
          objective: z.string().min(1).describe('Scope objective'),
          parent_scope_id: z.string().nullable().optional().describe('Optional parent scope ID'),
          metric_definitions: z
            .array(metricDefinitionSchema)
            .optional()
            .describe('Metric definitions tracked by this scope'),
          policy: forgePolicySchema.optional().describe('Scope policy JSON for judge guidance'),
        },
        (args) => handlers.create_forge_scope(args)
      ),
      tool(
        'create_forge_scope_from_goal',
        'Create a mission Forge scope linked to an existing SpaceGoal, defaulting name/objective from the goal.',
        {
          goal_id: z.string().describe('SpaceGoal ID in this space'),
          name: z.string().optional().describe('Override scope name'),
          objective: z.string().optional().describe('Override scope objective'),
          metric_definitions: z.array(metricDefinitionSchema).optional(),
          policy: forgePolicySchema.optional(),
        },
        (args) => handlers.create_forge_scope_from_goal(args)
      ),
      tool(
        'list_forge_scopes',
        'List Forge scopes in this space, optionally filtered by linked goal or kind.',
        {
          goal_id: z
            .string()
            .nullable()
            .optional()
            .describe('Filter by linked goal ID; null means unlinked scopes'),
          kind: forgeScopeKindSchema.optional().describe('Filter by scope kind'),
        },
        (args) => handlers.list_forge_scopes(args)
      ),
      tool(
        'get_forge_scope',
        'Get one Forge scope in this space, including linked goal, metric definitions, and policy.',
        { scope_id: z.string().describe('EvolutionScope ID') },
        (args) => handlers.get_forge_scope(args)
      ),
      tool(
        'update_forge_scope',
        'Update a Forge scope. Use goal_id to link/unlink a goal. Prefer policy_patch to deep-merge policy fields (e.g. automation.completedTaskThreshold, episodeJudgeModel, episodeJudgeProvider) without clobbering the rest; policy replaces policy JSON wholesale. episode_judge_model/episode_judge_provider are convenience setters folded into the patch. Changes take effect immediately.',
        {
          scope_id: z.string().describe('EvolutionScope ID'),
          goal_id: z.string().nullable().optional().describe('Linked SpaceGoal ID; null unlinks'),
          kind: forgeScopeKindSchema.optional(),
          name: z.string().min(1).optional(),
          objective: z.string().min(1).optional(),
          parent_scope_id: z.string().nullable().optional(),
          metric_definitions: z.array(metricDefinitionSchema).optional(),
          policy: forgePolicySchema
            .optional()
            .describe(
              'Full policy JSON replacement. Ignored when policy_patch (or ' +
                'episode_judge_*) is also supplied — policy_patch takes precedence.'
            ),
          policy_patch: forgePolicySchema
            .optional()
            .describe(
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
        },
        (args) => handlers.update_forge_scope(args)
      ),
      tool(
        'get_forge_timeline',
        'Get scope overview/timeline: scope, evidence, and metric snapshots.',
        { scope_id: z.string().describe('EvolutionScope ID') },
        (args) => handlers.get_forge_timeline(args)
      ),
      tool(
        'add_forge_manual_note',
        'Attach manual note evidence to a Forge scope.',
        {
          scope_id: z.string().describe('EvolutionScope ID'),
          summary: z.string().min(1).describe('Evidence note text'),
          metadata: metadataSchema.optional(),
          created_at: z.number().int().optional().describe('Optional timestamp ms'),
        },
        (args) => handlers.add_forge_manual_note(args)
      ),
      tool(
        'attach_forge_task_evidence',
        'Attach a completed or relevant SpaceTask as Forge evidence. If scope_id omitted, resolves from task.evolutionScopeId or task.goalId.',
        {
          task_id: z.string().describe('SpaceTask ID'),
          scope_id: z.string().optional().describe('Optional explicit EvolutionScope ID'),
          summary: z.string().optional(),
          metadata: metadataSchema.optional(),
        },
        (args) => handlers.attach_forge_task_evidence(args)
      ),
      tool(
        'attach_forge_workflow_run_evidence',
        'Attach a workflow run as Forge evidence. If scope_id omitted, resolves via first task in the run.',
        {
          workflow_run_id: z.string().describe('Workflow run ID'),
          scope_id: z.string().optional().describe('Optional explicit EvolutionScope ID'),
          summary: z.string().optional(),
          metadata: metadataSchema.optional(),
        },
        (args) => handlers.attach_forge_workflow_run_evidence(args)
      ),
      tool(
        'add_forge_metric_snapshot',
        'Add metric snapshot evidence to a Forge scope.',
        {
          scope_id: z.string().describe('EvolutionScope ID'),
          values: metricValuesSchema.describe('Metric values keyed by metric name'),
          source: z.string().min(1).describe('Source label, e.g. manual, CI, analytics'),
          note: z.string().nullable().optional(),
          captured_at: z.number().int().optional().describe('Optional timestamp ms'),
          summary: z.string().optional().describe('Optional evidence summary'),
          metadata: metadataSchema.optional(),
        },
        (args) => handlers.add_forge_metric_snapshot(args)
      ),
      tool(
        'list_forge_evidence',
        'List evidence refs for a Forge scope.',
        { scope_id: z.string().describe('EvolutionScope ID') },
        (args) => handlers.list_forge_evidence(args)
      ),
      tool(
        'list_forge_metric_snapshots',
        'List metric snapshots for a Forge scope.',
        { scope_id: z.string().describe('EvolutionScope ID') },
        (args) => handlers.list_forge_metric_snapshots(args)
      ),
      tool(
        'create_forge_episode',
        'Generate a draft Forge episode from selected evidence. Calls the episode judge; LLM/model/auth errors are surfaced clearly.',
        {
          scope_id: z.string().describe('EvolutionScope ID'),
          evidence_ids: z.array(z.string()).min(1).describe('Evidence IDs from this scope'),
          time_window: z
            .object({ start: z.number().int(), end: z.number().int() })
            .nullable()
            .optional(),
          confirm_low_confidence: z
            .boolean()
            .optional()
            .describe('Allow low-confidence generation when preflight warns evidence is thin'),
        },
        (args) => handlers.create_forge_episode(args)
      ),
      tool(
        'list_forge_review_bundle',
        'List episodes, lessons, and task proposals for reviewing a Forge scope.',
        { scope_id: z.string().describe('EvolutionScope ID') },
        (args) => handlers.list_forge_review_bundle(args)
      ),
      tool(
        'list_forge_lessons',
        'List Forge lessons for a scope, optionally filtered by status.',
        {
          scope_id: z.string().describe('EvolutionScope ID'),
          status: lessonStatusSchema.optional(),
        },
        (args) => handlers.list_forge_lessons(args)
      ),
      tool(
        'list_forge_proposals',
        'List Forge task proposals for a scope, optionally filtered by status.',
        {
          scope_id: z.string().describe('EvolutionScope ID'),
          status: proposalStatusSchema.optional(),
        },
        (args) => handlers.list_forge_proposals(args)
      ),
      tool(
        'resolve_forge_scope',
        'Resolve a Forge scope from a linked goal_id or task_id when scope_id is unknown.',
        {
          goal_id: z.string().optional(),
          task_id: z.string().optional(),
        },
        (args) => handlers.resolve_forge_scope(args)
      ),
      tool(
        'update_forge_episode',
        'Accept, dismiss, or edit a Forge episode draft. Use status accepted/dismissed only after explicit decision.',
        {
          episode_id: z.string().describe('EvolutionEpisode ID'),
          status: episodeStatusSchema.optional(),
          title: z.string().min(1).optional(),
          outcome_summary: z.string().optional(),
        },
        (args) => handlers.update_forge_episode(args)
      ),
      tool(
        'update_forge_lesson',
        'Activate, dismiss, or edit a candidate lesson. Activation requires explicit tool call.',
        {
          lesson_id: z.string().describe('EvolutionLesson ID'),
          status: lessonStatusSchema.optional(),
          applies_to: z.array(z.string()).optional(),
          rule: z.string().min(1).optional(),
          why: z.string().optional(),
          confidence: z.number().min(0).max(1).optional(),
        },
        (args) => handlers.update_forge_lesson(args)
      ),
      tool(
        'create_forge_task_proposal',
        'Create a Forge task proposal manually for this scope. Later use create_task_from_forge_proposal to make a real SpaceTask.',
        {
          scope_id: z.string().describe('EvolutionScope ID'),
          title: z.string().min(1),
          description: z.string(),
          reason: z.string(),
          priority: prioritySchema.optional(),
          evidence_episode_ids: z.array(z.string()).optional(),
        },
        (args) => handlers.create_forge_task_proposal(args)
      ),
      tool(
        'update_forge_task_proposal',
        'Edit, accept, or dismiss a Forge task proposal. Creating a SpaceTask is separate and explicit.',
        {
          proposal_id: z.string().describe('TaskProposal ID'),
          title: z.string().min(1).optional(),
          description: z.string().optional(),
          reason: z.string().optional(),
          priority: prioritySchema.optional(),
          status: proposalUpdateStatusSchema.optional(),
        },
        (args) => handlers.update_forge_task_proposal(args)
      ),
      tool(
        'create_task_from_forge_proposal',
        'Create a real SpaceTask from a Forge proposal, preserving linked goalId and evolutionScopeId. Supports structured dependencies via depends_on so prerequisite checks are attached atomically before runtime pickup. Idempotent when task already exists.',
        {
          proposal_id: z.string().describe('TaskProposal ID'),
          title: z.string().optional().describe('Optional edited task title'),
          description: z.string().optional().describe('Optional edited task description'),
          reason: z.string().optional().describe('Optional edited proposal reason'),
          priority: prioritySchema.optional(),
          depends_on: z
            .array(z.string())
            .optional()
            .describe(
              'List of task IDs this task depends on. All must be in the same space. Dependencies are persisted during task creation so the runtime cannot launch the task before they are attached.'
            ),
        },
        (args) => handlers.create_task_from_forge_proposal(args)
      ),
      tool(
        'apply_forge_rollup',
        'Accept a Forge episode and roll summary/progress/metrics/next steps into its linked recurring goal.',
        {
          episode_id: z.string().describe('EvolutionEpisode ID'),
          goal_update: z.object({
            summary: z.string().optional(),
            progress: z.number().int().min(0).max(100).optional(),
            next_steps: z.array(z.string()).optional(),
            metrics: goalMetricsSchema.optional(),
          }),
        },
        (args) => handlers.apply_forge_rollup(args)
      )
    );
  }

  if (config.scheduleService) {
    tools.push(
      tool(
        'create_scheduled_task',
        'Create a recurring (cron) or one-shot (at) scheduled task. When it fires, a real SpaceTask is created automatically.',
        {
          title: z.string().describe('Short title for the task template'),
          description: z.string().describe('Detailed description for the task template'),
          priority: z
            .enum(['low', 'normal', 'high', 'urgent'])
            .optional()
            .describe('Task priority (default: normal)'),
          workflow_id: z
            .string()
            .optional()
            .describe('Preferred workflow ID to attach to created tasks'),
          labels: z.array(z.string()).optional().describe('Labels to apply to created tasks'),
          trigger_type: z
            .enum(['cron', 'at'])
            .describe('Trigger type: "cron" for recurring, "at" for one-shot'),
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
        },
        (args) => handlers.create_scheduled_task(args)
      ),
      tool(
        'list_scheduled_tasks',
        'List all scheduled tasks for this space.',
        {
          status: z
            .enum(['active', 'paused', 'completed'])
            .optional()
            .describe('Filter by schedule status (default: all)'),
        },
        (args) => handlers.list_scheduled_tasks(args)
      ),
      tool(
        'get_scheduled_task',
        'Get details of a specific scheduled task including last spawned task ID and next run time.',
        {
          schedule_id: z.string().describe('ID of the scheduled task to retrieve'),
        },
        (args) => handlers.get_scheduled_task(args)
      ),
      tool(
        'pause_scheduled_task',
        'Pause a schedule — stops creating new tasks until resumed.',
        {
          schedule_id: z.string().describe('ID of the scheduled task to pause'),
        },
        (args) => handlers.pause_scheduled_task(args)
      ),
      tool(
        'resume_scheduled_task',
        'Resume a paused schedule, computing the next run time and re-enqueueing the job.',
        {
          schedule_id: z.string().describe('ID of the scheduled task to resume'),
        },
        (args) => handlers.resume_scheduled_task(args)
      ),
      tool(
        'delete_scheduled_task',
        'Permanently delete a scheduled task. Any pending job is cancelled.',
        {
          schedule_id: z.string().describe('ID of the scheduled task to delete'),
        },
        (args) => handlers.delete_scheduled_task(args)
      )
    );
  }

  if (config.callerRole === 'long_term_agent' || config.callerRole === 'coordinator') {
    tools.push(
      tool(
        'review_goal_outcome',
        'Review a terminal goal-outcome notification. Call without notification_id to discover pending notifications you own or are the authorized fallback for; call with notification_id, goal_id, task_id and either a disposition (acknowledge, reject, or supersede) to terminalize a pending outcome without goal mutation, or goal-state updates (summary, next_steps, metrics, observations, progress) to acknowledge the outcome while persisting your review to the goal.',
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
          metrics: goalMetricsSchema.optional().describe('Replace the given goal metric values'),
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

  const server = createSdkMcpServer({ name: 'space-agent', tools });
  return { ...server, tools };
}

export type SpaceAgentMcpServer = ReturnType<typeof createSpaceAgentMcpServer>;
