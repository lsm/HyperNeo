/**
 * SpaceRuntime
 *
 * Agent-centric orchestration engine for Spaces.
 * Manages workflow run lifecycles and standalone task queuing
 * using Space tables exclusively (not Room tables).
 *
 * Responsibilities:
 * - Maintain a Map<runId, WorkflowExecutor> for active workflow runs
 * - Rehydrate executors from DB on first executeTick() call
 * - Start new workflow runs (creates run record + executor + first node task)
 * - Spawn Task Agent sessions for pending tasks
 * - Monitor agent liveness and recover from crashes
 * - Resolve task types from agent roles (planner → planning, coder/general → coding, etc.)
 * - Filter and expose workflow rules applicable to a given node
 * - Clean up executors when runs reach terminal states
 *
 * In the agent-centric model, agents drive workflow progression via send_message
 * and `task.reportedStatus` — SpaceRuntime no longer calls advance() directly.
 */

import type { Database as BunDatabase } from 'bun:sqlite';
import type {
  CreateNodeExecutionParams,
  NodeExecution,
  Space,
  SpaceApprovalSource,
  SpaceTask,
  SpaceTaskPriority,
  SpaceWorkflow,
  SpaceWorkflowRun,
  UpdateSpaceTaskParams,
  WorkflowChannel,
  WorkflowNode,
} from '@neokai/shared';
import {
  computeGateDefaults,
  isChannelCyclic,
  MAX_SPACE_CONCURRENT_TASKS,
  MIN_SPACE_CONCURRENT_TASKS,
  resolveNodeAgents,
} from '@neokai/shared';
import type { ReactiveDatabase } from '../../../storage/reactive-database';
import type { ExternalEventPublishedPayload } from '../../external-events/external-event-service';
import type { ExternalEventStore } from '../../external-events/external-event-store';
import type { ExternalEvent } from '../../external-events/types';
import { KNOWN_SOURCES, validateGlobPattern } from '../../external-events/topic-validator';
import { ChannelCycleRepository } from '../../../storage/repositories/channel-cycle-repository';
import { normalizeMeaningfulTaskResult } from '../task-result-utils';
import { GateDataRepository } from '../../../storage/repositories/gate-data-repository';
import { WorkflowHookStateRepository } from '../../../storage/repositories/workflow-hook-state-repository';
import type { NodeExecutionRepository } from '../../../storage/repositories/node-execution-repository';
import type { PendingAgentMessageRepository } from '../../../storage/repositories/pending-agent-message-repository';
import { SDKMessageRepository } from '../../../storage/repositories/sdk-message-repository';
import type { SpaceTaskRepository } from '../../../storage/repositories/space-task-repository';
import type { SpaceWorkflowRunRepository } from '../../../storage/repositories/space-workflow-run-repository';
import { ToolContinuationRecoveryRepository } from '../../../storage/repositories/tool-continuation-recovery-repository';
import type { SpaceLongHorizonAgentRepository } from '../../../storage/repositories/space-long-horizon-agent-repository';
import type { WorkflowRunArtifactRepository } from '../../../storage/repositories/workflow-run-artifact-repository';
import { Logger } from '../../logger';
import type { SpaceAgentManager } from '../managers/space-agent-manager';
import type { SpaceManager } from '../managers/space-manager';
import { isValidSpaceTaskTransition, SpaceTaskManager } from '../managers/space-task-manager';
import {
  isReservedWorkflowAgentName,
  type SpaceWorkflowManager,
} from '../managers/space-workflow-manager';
import { MAX_AGENT_SLOT_EVENT_INTERESTS } from '../export-format';
import { getBuiltInGateScript } from '../workflows/built-in-workflows';
import { getEffectiveGate } from './gate-features';
import { buildPrEventTopicPattern, parsePrUrl } from './parse-pr-url';
import { CompletionDetector } from './completion-detector';
import {
  DEFAULT_AGENT_NO_PROGRESS_THRESHOLD_MS,
  DEFAULT_AGENT_STUCK_NAG_GRACE_MS,
  DEFAULT_TOOL_USE_ACTIVE_TTL_MS,
  MAX_AGENT_STUCK_NAGS,
  MAX_AGENT_STUCK_RESTARTS,
  MAX_BLOCKED_RUN_RETRIES,
  MAX_TASK_AGENT_CRASH_RETRIES,
} from './constants';
import { evaluateGate } from './gate-evaluator';
import { executeGateScript } from './gate-script-executor';
import { classifyLastMessageForIdleAgent } from './last-message-classifier';
import type { SelectWorkflowWithLlm } from './llm-workflow-selector';
import type {
  InternalEventBus,
  DaemonInternalEventMap,
  InternalEventPayload,
} from '../../internal-event-bus';
import {
  MissingCommandHandlerError,
  type DaemonCommandMap,
  type InternalCommandBus,
} from '../../internal-command-bus';
import {
  type PostApprovalRouteContext,
  type PostApprovalRouteResult,
  PostApprovalRouter,
} from './post-approval-router';

import type { TaskAgentManager } from './task-agent-manager';
import type { SpaceActorRegistryAdapter } from '../actor-registry';
import type { SpaceAgentInboxRepository } from '../../../storage/repositories/space-agent-inbox-repository';
import { TopicTrie } from '../../external-events/topic-trie';
import { WorkflowExecutor } from './workflow-executor';
import { isPermanentSpawnError } from './workflow-node-execution-validation';
import { selectWorkflow } from './workflow-selector';
import { canTransition as canTransitionRunStatus } from './workflow-run-status-machine';

const log = new Logger('space-runtime');
const PRIORITY_ORDER: Record<SpaceTaskPriority, number> = {
  urgent: 0,
  high: 1,
  normal: 2,
  low: 3,
};

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

export interface SpaceRuntimeConfig {
  /** Raw Bun SQLite database — used to create per-space SpaceTaskManagers */
  db: BunDatabase;
  /**
   * Optional absolute path to the SQLite database file.
   *
   * Threaded through from `SpaceRuntimeServiceConfig`; retained for callers
   * that need DB access from injected helpers.
   */
  dbPath?: string;
  /** Space manager for listing spaces and fetching workspace paths */
  spaceManager: SpaceManager;
  /** Agent manager for resolving agents */
  spaceAgentManager: SpaceAgentManager;
  /** Long-horizon agent repository for durable external-event subscriptions. */
  longHorizonAgentRepo?: SpaceLongHorizonAgentRepository;
  /** Workflow manager for loading workflow definitions */
  spaceWorkflowManager: SpaceWorkflowManager;
  /** Workflow run repository for run CRUD and status updates */
  workflowRunRepo: SpaceWorkflowRunRepository;
  /** Task repository for querying tasks by run/node */
  taskRepo: SpaceTaskRepository;
  /** Node execution repository for workflow-internal execution state */
  nodeExecutionRepo: NodeExecutionRepository;
  /** Optional gate data repository used to resolve PR URLs written through gated channels. */
  gateDataRepo?: GateDataRepository;
  /** Optional reactive DB invalidation hooks for task LiveQuery surfaces */
  reactiveDb?: ReactiveDatabase;
  /**
   * Optional TaskAgentManager for Task Agent mode.
   *
   * SpaceRuntime uses TaskAgentManager for node-agent session lifecycle
   * (spawn/liveness/cancel) and optional Task Agent messaging sessions.
   */
  taskAgentManager?: TaskAgentManager;
  /**
   * Interval between executeTick() calls in milliseconds.
   * Used by start(). Default: 5000 (5 seconds).
   */
  tickIntervalMs?: number;
  /**
   * Silence window for alive node-agent sessions before Layer 1 runtime recovery
   * considers a non-terminal last SDK message stuck. Default: 15 minutes.
   */
  agentNoProgressThresholdMs?: number;
  /**
   * Minimum wait after injecting a runtime nag before Layer 1 may restart/block
   * the same still-stale session. Default: 2 minutes.
   */
  agentStuckNagGraceMs?: number;
  /**
   * InternalEventBus for publishing typed Space domain events and subscribing to
   * external event publications.
   */
  internalEventBus?: InternalEventBus<DaemonInternalEventMap>;
  /** Command bus used to inject matched external events into node-agent sessions. */
  commandBus?: InternalCommandBus<DaemonCommandMap>;
  /** Persistent external-event delivery state store. */
  externalEventStore?: ExternalEventStore;
  /**
   * Completion detector — inspects the canonical `SpaceTask` to decide whether
   * a workflow run is complete or ready for runtime resolution.
   *
   * Defaults to `new CompletionDetector(taskRepo)` when not provided.
   */
  completionDetector?: CompletionDetector;
  /**
   * Optional artifact repository used by `dispatchPostApproval` to resolve
   * PR URLs (and other structured end-node artifacts) into the template
   * interpolation context for post-approval sessions.
   */
  artifactRepo?: WorkflowRunArtifactRepository;
  /**
   * Optional SDK message repository used to emit synthetic SDK messages into
   * a task's agent session. Defaults to a repo constructed from `db` if not
   * provided — tests can inject a stub to assert emissions.
   */
  sdkMessageRepo?: SDKMessageRepository;
  /**
   * Persistent queue for workflow agent handoff messages. SpaceRuntime sweeps
   * this queue every tick so queued node-to-node handoffs are retried and either
   * delivered or escalated instead of waiting indefinitely for a Task Agent wakeup.
   */
  pendingMessageRepo?: PendingAgentMessageRepository;
  /**
   * Optional callback emitted when runtime mutates a SpaceTask internally.
   * Used to fan out `space.task.updated` events for UI synchronization.
   */
  onTaskUpdated?: (payload: {
    spaceId: string;
    task: SpaceTask;
    archiveSource?: 'user' | 'system_reconcile';
  }) => Promise<void> | void;
  /**
   * Optional callback emitted when runtime creates a workflow run internally.
   * Used to fan out `space.workflowRun.created` events for UI synchronization.
   */
  onWorkflowRunCreated?: (payload: {
    spaceId: string;
    run: SpaceWorkflowRun;
  }) => Promise<void> | void;
  /**
   * Optional callback emitted when runtime updates workflow run status internally.
   * Used to fan out `space.workflowRun.updated` events for UI synchronization.
   */
  onWorkflowRunUpdated?: (payload: {
    spaceId: string;
    run: SpaceWorkflowRun;
  }) => Promise<void> | void;
  /**
   * Optional LLM-backed workflow selector used when a standalone task has no
   * `preferredWorkflowId` and multiple workflows are available. Should return
   * one of the provided workflow ids, or `null` to fall back to the
   * deterministic tag-based tiebreak (`default` → `v2` → most recently updated).
   *
   * Dependency-injected so tests can provide a deterministic stub without
   * touching the provider SDK. In production, wire this to
   * `selectWorkflowWithLlmDefault` from `./llm-workflow-selector`.
   */
  selectWorkflowWithLlm?: SelectWorkflowWithLlm;
  /** Optional goal service for processing terminal goal-task side effects. */
  goalService?: Pick<import('../goals/goal-service').SpaceGoalService, 'handleTaskTerminal'>;
  /** Optional Forge scope service for automatic terminal task evidence capture. */
  evolutionScopeService?: import('../evolution-scope-service').EvolutionScopeService;
  /** Optional actor registry for long-horizon external-event delivery. */
  actorRegistry?: SpaceActorRegistryAdapter;
  /** Optional durable inbox for inactive long-horizon external-event delivery. */
  spaceAgentInboxRepo?: SpaceAgentInboxRepository;
  /** Optional direct long-horizon event delivery hook supplied by SpaceRuntimeService. */
  deliverLongHorizonExternalEvent?: (args: {
    spaceId: string;
    agentId: string;
    message: string;
    idempotencyKey: string;
  }) => Promise<{ delivered: boolean }>;
  /**
   * Optional hook invoked once after an external event is delivered to any
   * subscription target whose workflow run is currently in `blocked` status.
   *
   * Wired by `SpaceRuntimeService` to trigger immediate gate re-evaluation
   * (rather than waiting for the next poll cycle) and notify the blocked
   * agent session when a gate opens as a result.
   *
   * Fire-and-forget from the runtime's perspective — the service swallows
   * errors and logs them so a failing re-evaluation cannot break delivery.
   */
  onBlockedRunExternalEvent?: (payload: {
    runId: string;
    event: ExternalEventPublishedPayload;
  }) => Promise<void> | void;
  /**
   * Optional hook invoked immediately after a workflow run transitions into
   * `blocked` status — covers tick-loop recovery (`recoverStalledRuns`),
   * `markFailed` RPC, and gate-rejection paths that bypass the gate-write
   * sync. Wired by `SpaceRuntimeService` to ensure the PR-event
   * auto-subscription is created when the run becomes blocked regardless
   * of which code path performed the transition.
   *
   * Fire-and-forget; errors are logged and swallowed by the runtime.
   */
  onRunBlocked?: (runId: string) => Promise<void> | void;
  /**
   * Optional hook invoked inside `executeTick` after recovery completes and
   * BEFORE `redispatchPublishedEventsWithoutDeliveries` runs. Wired by
   * `SpaceRuntimeService` to rebuild PR-event auto-subscriptions for blocked
   * runs before the redispatch sweep re-processes crash-pending PR events —
   * without this, those events hit an empty topic trie and get marked
   * `ignored`, blocking the event-driven gate-eval path on the first
   * post-restart tick.
   *
   * Awaited by the runtime so the trie is fully populated before redispatch.
   */
  onBeforeRedispatch?: () => Promise<void> | void;
}

interface StartWorkflowRunOptions {
  /**
   * Optional canonical parent task for this workflow run.
   * When provided, runtime-created node tasks are marked with this parent
   * so user-facing views can keep a one-task-per-run list.
   */
  parentTaskId?: string;
}

type WorkflowTaskRecoveryTargetStatus = 'open' | 'in_progress';

// ---------------------------------------------------------------------------
// SpaceRuntime
// ---------------------------------------------------------------------------

/** Metadata stored alongside each executor to allow recreation with fresh state */
interface ExecutorMeta {
  workflow: SpaceWorkflow;
  spaceId: string;
  workspacePath: string;
}

interface WorkflowSubscriptionTarget {
  kind?: 'workflow';
  workflowRunId: string;
  taskId: string;
  nodeId: string;
  agentName: string;
  topic?: string;
  /**
   * Origin of the subscription:
   * - `static`  — declared in the workflow template's `eventInterests`
   * - `dynamic` — registered at runtime via MCP tooling (`subscribe_external_event`)
   * - `auto`    — registered by the runtime itself (e.g. gate-blocked PR
   *              auto-subscription). Distinct from `dynamic` so cleanup can
   *              target only runtime-managed subscriptions without touching
   *              agent-registered interests on the same topic.
   */
  subscriptionKind?: 'static' | 'dynamic' | 'auto';
  sessionId?: string;
}

interface LongHorizonSubscriptionTarget {
  kind: 'long_horizon_agent';
  spaceId: string;
  agentId: string;
  source: string;
  topic: string;
  subscriptionId: string;
}

type SubscriptionTarget = WorkflowSubscriptionTarget | LongHorizonSubscriptionTarget;

function isWorkflowSubscriptionTarget(
  target: SubscriptionTarget
): target is WorkflowSubscriptionTarget {
  return target.kind !== 'long_horizon_agent';
}

function isLongHorizonSubscriptionTarget(
  target: SubscriptionTarget
): target is LongHorizonSubscriptionTarget {
  return target.kind === 'long_horizon_agent';
}

interface PendingExternalEvent {
  event: ExternalEventPublishedPayload;
  deliveryKey: string;
  deliveryMode: 'immediate' | 'defer';
  createdAt: number;
}

interface ExternalEventDigestItem {
  target: WorkflowSubscriptionTarget;
  event: ExternalEventPublishedPayload;
  deliveryKey: string;
  deliveryMode: 'immediate' | 'defer';
  createdAt: number;
  allowTargetSessionFallback: boolean;
}

interface ExternalEventRateLimitState {
  timestamps: number[];
  pendingDigest: ExternalEventDigestItem[];
  digestTimer: Timer | null;
  cleanupTimer: Timer | null;
}

interface AgentStuckRecoveryState {
  nagCount: number;
  restartCount: number;
  lastAction: 'nag' | 'restart' | 'blocked' | null;
  lastActionAt: number | null;
  lastObservedMessageId: string | null;
  lastObservedMessageAt: number | null;
  lastObservedProgressMessageId: string | null;
  lastObservedProgressMessageAt: number | null;
  lastRuntimeNagMessageId: string | null;
  lastSessionId: string | null;
  pendingRestartNotice: string | null;
}

interface NonTerminalIdleState {
  lastSessionId: string | null;
  lastObservedMessageId: string | null;
  lastObservedProgressMessageId: string | null;
  lastObservedProgressMessageAt: number | null;
  lastRuntimeNudgeMessageId: string | null;
  nudgeCount: number;
  failedNudgeCount: number;
  lastNudgeAt: number | null;
  lastAttentionLogAt: number | null;
}

const NON_TERMINAL_IDLE_FAILED_NUDGE_RETRY_MS = 60 * 1000;
const NON_TERMINAL_IDLE_ATTENTION_LOG_COOLDOWN_MS = 5 * 60 * 1000;
const EXTERNAL_EVENT_RETRY_DELAY_MS = 1000;
const EXTERNAL_EVENT_RETRY_MAX_ATTEMPTS = 5;
const EXTERNAL_EVENT_RATE_WINDOW_MS = 60_000;
const EXTERNAL_EVENT_RATE_LIMIT_PER_MIN = parsePositiveIntegerEnv(
  'EXTERNAL_EVENT_RATE_LIMIT_PER_MIN',
  10
);
const EXTERNAL_EVENT_QUEUE_TTL_MS = parsePositiveIntegerEnv('EXTERNAL_EVENT_QUEUE_TTL_MS', 300_000);

export function parsePositiveIntegerEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value <= 0) return fallback;
  return value;
}

// ---------------------------------------------------------------------------
// Internal notification event shape
// ---------------------------------------------------------------------------

/**
 * Discriminated union of structured runtime events emitted by `SpaceRuntime`.
 *
 * Used as the input shape for {@link SpaceRuntime['safeNotify']} so call sites
 * stay readable (`kind: 'task_blocked', ...`) while the publisher maps them
 * onto the typed `space.*` events on `InternalEventBus`. Kept private to this
 * module — external consumers should subscribe to `InternalEventBus` events
 * directly via `DaemonInternalEventMap`.
 */
type SpaceNotificationEvent =
  | {
      kind: 'task_blocked';
      spaceId: string;
      taskId: string;
      reason: string;
      timestamp: string;
    }
  | {
      kind: 'workflow_run_blocked';
      spaceId: string;
      runId: string;
      reason: string;
      timestamp: string;
    }
  | {
      kind: 'task_timeout';
      spaceId: string;
      taskId: string;
      elapsedMs: number;
      timestamp: string;
    }
  | {
      kind: 'workflow_run_completed';
      spaceId: string;
      runId: string;
      status: 'done' | 'cancelled' | 'blocked';
      summary?: string;
      timestamp: string;
    }
  | {
      kind: 'workflow_run_reopened';
      spaceId: string;
      runId: string;
      fromStatus: 'done' | 'cancelled';
      reason: string;
      by: string;
      timestamp: string;
    }
  | {
      kind: 'agent_crash';
      spaceId: string;
      taskId: string;
      timestamp: string;
    }
  | {
      kind: 'task_retry';
      spaceId: string;
      taskId: string;
      runId: string;
      originalReason: string;
      attemptNumber: number;
      maxAttempts: number;
      timestamp: string;
    }
  | {
      kind: 'workflow_run_needs_attention';
      spaceId: string;
      runId: string;
      taskId: string;
      reason: string;
      retriesExhausted: number;
      timestamp: string;
    }
  | {
      kind: 'task_awaiting_approval';
      spaceId: string;
      taskId: string;
      actionId: string;
      actionName: string;
      actionDescription?: string;
      actionType: 'script' | 'instruction' | 'mcp_call';
      requiredLevel: number;
      spaceLevel: number;
      autonomyLevel: number;
      timestamp: string;
    };

/**
 * Map a notification event onto the corresponding typed `InternalEventBus` event.
 *
 * Returns `null` for unrecognised events (defensive — all current `kind`s map).
 * The `namespaceId` field is set to `'global'` because these events are
 * space-scoped, not session-scoped. Subscribers that need space-scoped
 * filtering should inspect `payload.spaceId`.
 */
function formatCommandError(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === 'string') return error;
  return JSON.stringify(error);
}

function legacyGitHubTopic(topic: string): string | null {
  const segments = topic.split('/');
  if (segments.length !== 5 || segments[0] !== 'github') return null;
  const [source, owner, repo, resource, entityAction] = segments;
  const dotIndex = entityAction.indexOf('.');
  if (dotIndex <= 0 || dotIndex === entityAction.length - 1) return null;
  return `${source}/${owner}/${repo}/${resource}.${entityAction.slice(dotIndex + 1)}`;
}

function rejectSlashSeparatedGitHubAction(topic: string): never {
  throw new Error(
    `GitHub topic "${topic}" must use dotted entity actions like "pull_request/42.closed"`
  );
}

const GITHUB_EVENT_RESOURCES = new Set(['pull_request']);

function isGitHubEventResource(resource: string): boolean {
  return GITHUB_EVENT_RESOURCES.has(resource);
}

function ensureGitHubEventResource(topic: string, resource: string): void {
  if (resource === '*' || isGitHubEventResource(resource)) return;
  throw new Error(
    `GitHub topic "${topic}" uses unsupported resource "${resource}"; supported resources: pull_request`
  );
}

function splitDottedGitHubResource(segment: string): { resource: string; action: string } | null {
  const dotIndex = segment.indexOf('.');
  if (dotIndex <= 0 || dotIndex === segment.length - 1) return null;
  return { resource: segment.slice(0, dotIndex), action: segment.slice(dotIndex + 1) };
}

function rejectGitHubEntityPatternWithoutAction(topic: string): never {
  throw new Error(
    `GitHub topic "${topic}" must use dotted entity actions like "pull_request/42.opened"`
  );
}

function ensureGitHubEntityAction(topic: string, entityAction: string): void {
  if (entityAction === '*') return;
  const dotIndex = entityAction.indexOf('.');
  if (
    dotIndex <= 0 ||
    dotIndex === entityAction.length - 1 ||
    entityAction.indexOf('.', dotIndex + 1) !== -1
  ) {
    rejectGitHubEntityPatternWithoutAction(topic);
  }
}

function composeGitHubSubscriptionPattern(source: string, topic: string): string {
  const segments = topic.split('/');
  const isSourcePrefixed = segments[0] === source;
  const resourceSegments = isSourcePrefixed ? segments.slice(1) : segments;
  const firstResourceSegment = resourceSegments[0] ?? '';
  const firstDottedResource = splitDottedGitHubResource(firstResourceSegment);

  if (isSourcePrefixed && segments.length === 6) rejectSlashSeparatedGitHubAction(topic);
  if (!isSourcePrefixed && segments.length === 5) rejectSlashSeparatedGitHubAction(topic);
  if (resourceSegments.length > 4) {
    throw new Error(
      `GitHub topic "${topic}" must match supported shape "owner/repo/pull_request/<id>.<action>"`
    );
  }
  if (isSourcePrefixed && segments.length === 5) {
    ensureGitHubEventResource(topic, segments[3] ?? '');
    ensureGitHubEntityAction(topic, segments[4] ?? '');
    return topic;
  }
  if (resourceSegments.length === 4) {
    ensureGitHubEventResource(topic, resourceSegments[2] ?? '');
    ensureGitHubEntityAction(topic, resourceSegments[3] ?? '');
    return `${source}/${resourceSegments.join('/')}`;
  }
  if (isSourcePrefixed && resourceSegments.length === 3) {
    const [first, second, third] = resourceSegments;
    if (isGitHubEventResource(first ?? '')) {
      ensureGitHubEntityAction(topic, `${second}.${third}`);
      return `${source}/*/*/${first}/${second}.${third}`;
    }
    if (isGitHubEventResource(second ?? '')) {
      ensureGitHubEntityAction(topic, third ?? '');
      return `${source}/${source}/${first}/${second}/${third}`;
    }
  }
  if (resourceSegments.length === 3) {
    const [owner, repo, resource] = resourceSegments;
    const dotted = splitDottedGitHubResource(resource ?? '');
    if (dotted) {
      ensureGitHubEventResource(topic, dotted.resource);
      return `${source}/${owner}/${repo}/${dotted.resource}/*.${dotted.action}`;
    }
    if (!isGitHubEventResource(resource ?? '')) rejectSlashSeparatedGitHubAction(topic);
    return `${source}/${owner}/${repo}/${resource}/*`;
  }
  if (resourceSegments.length === 2) {
    const [resource, entityAction] = resourceSegments;
    if (!isGitHubEventResource(resource ?? '')) {
      const dottedEntityAction = splitDottedGitHubResource(entityAction ?? '');
      if (isSourcePrefixed && dottedEntityAction) {
        ensureGitHubEventResource(topic, dottedEntityAction.resource);
        return `${source}/${source}/${resource}/${dottedEntityAction.resource}/*.${dottedEntityAction.action}`;
      }
      if (isSourcePrefixed && isGitHubEventResource(entityAction ?? '')) {
        return `${source}/${source}/${resource}/${entityAction}/*`;
      }
      throw new Error(
        `GitHub topic "${topic}" must include a resource segment like "owner/repo/pull_request"`
      );
    }
    ensureGitHubEntityAction(topic, entityAction ?? '');
    return `${source}/*/*/${resource}/${entityAction}`;
  }
  if (resourceSegments.length === 1) {
    if (firstDottedResource) {
      ensureGitHubEventResource(topic, firstDottedResource.resource);
      return `${source}/*/*/${firstDottedResource.resource}/*.${firstDottedResource.action}`;
    }
    ensureGitHubEventResource(topic, firstResourceSegment);
    return `${source}/*/*/${firstResourceSegment}/*`;
  }
  return `${source}/*/*/${topic}`;
}

function composeLongHorizonSubscriptionPattern(source: string, topic: string): string {
  const trimmedSource = source.trim();
  const trimmedTopic = topic.trim();
  if (!trimmedSource) return trimmedTopic;
  const topicSource = trimmedTopic.split('/')[0] ?? '';
  if (trimmedSource === 'github') {
    const segments = trimmedTopic.split('/');
    const isOwnerRepoShorthand =
      segments.length === 3 ||
      segments.length === 4 ||
      (segments[0] === trimmedSource && (segments.length === 3 || segments.length === 4));
    if (isOwnerRepoShorthand || topicSource === trimmedSource) {
      return composeGitHubSubscriptionPattern(trimmedSource, trimmedTopic);
    }
  } else if (topicSource === trimmedSource) {
    return trimmedTopic;
  }
  const normalizedTopicSource = topicSource.toLowerCase();
  if (
    normalizedTopicSource === trimmedSource.toLowerCase() ||
    KNOWN_SOURCES.has(normalizedTopicSource)
  ) {
    throw new Error(`Topic source "${topicSource}" does not match source "${trimmedSource}"`);
  }
  if (trimmedSource === 'github')
    return composeGitHubSubscriptionPattern(trimmedSource, trimmedTopic);
  return `${trimmedSource}/${trimmedTopic}`;
}

function longHorizonSpaceIdFromWorkflowRunId(workflowRunId: string): string | null {
  const prefix = 'long_horizon:';
  return workflowRunId.startsWith(prefix) ? workflowRunId.slice(prefix.length) : null;
}

function isExternallyDeliverableRun(status: SpaceWorkflowRun['status']): boolean {
  return status === 'in_progress' || status === 'blocked';
}

function parseSubscriptionQueueKey(
  key: string
): Pick<WorkflowSubscriptionTarget, 'workflowRunId' | 'taskId' | 'nodeId' | 'agentName'> | null {
  try {
    const parsed = JSON.parse(key) as unknown;
    if (!Array.isArray(parsed) || parsed.length !== 4) return null;
    const [workflowRunId, taskId, nodeId, agentName] = parsed;
    if (
      typeof workflowRunId !== 'string' ||
      typeof taskId !== 'string' ||
      typeof nodeId !== 'string' ||
      typeof agentName !== 'string'
    ) {
      return null;
    }
    return { workflowRunId, taskId, nodeId, agentName };
  } catch {
    return null;
  }
}

function mapNotificationEventToInternalEvent(event: SpaceNotificationEvent): {
  event: keyof DaemonInternalEventMap;
  payload: DaemonInternalEventMap[keyof DaemonInternalEventMap];
} | null {
  const namespaceId = 'global';
  switch (event.kind) {
    case 'task_blocked':
      return {
        event: 'space.task.blocked',
        payload: {
          namespaceId,
          spaceId: event.spaceId,
          taskId: event.taskId,
          reason: event.reason,
          timestamp: event.timestamp,
        },
      };
    case 'workflow_run_blocked':
      return {
        event: 'space.workflowRun.blocked',
        payload: {
          namespaceId,
          spaceId: event.spaceId,
          runId: event.runId,
          reason: event.reason,
          timestamp: event.timestamp,
        },
      };
    case 'task_timeout':
      return {
        event: 'space.task.timeout',
        payload: {
          namespaceId,
          spaceId: event.spaceId,
          taskId: event.taskId,
          elapsedMs: event.elapsedMs,
          timestamp: event.timestamp,
        },
      };
    case 'workflow_run_completed':
      return {
        event: 'space.workflowRun.completed',
        payload: {
          namespaceId,
          spaceId: event.spaceId,
          runId: event.runId,
          status: event.status,
          summary: event.summary,
          timestamp: event.timestamp,
        },
      };
    case 'workflow_run_reopened':
      return {
        event: 'space.workflowRun.reopened',
        payload: {
          namespaceId,
          spaceId: event.spaceId,
          runId: event.runId,
          fromStatus: event.fromStatus,
          reason: event.reason,
          by: event.by,
          timestamp: event.timestamp,
        },
      };
    case 'agent_crash':
      return {
        event: 'space.agent.crashed',
        payload: {
          namespaceId,
          spaceId: event.spaceId,
          taskId: event.taskId,
          timestamp: event.timestamp,
        },
      };
    case 'task_retry':
      return {
        event: 'space.workflowRun.retry',
        payload: {
          namespaceId,
          spaceId: event.spaceId,
          taskId: event.taskId,
          runId: event.runId,
          originalReason: event.originalReason,
          attemptNumber: event.attemptNumber,
          maxAttempts: event.maxAttempts,
          timestamp: event.timestamp,
        },
      };
    case 'workflow_run_needs_attention':
      return {
        event: 'space.workflowRun.needsAttention',
        payload: {
          namespaceId,
          spaceId: event.spaceId,
          runId: event.runId,
          taskId: event.taskId,
          reason: event.reason,
          retriesExhausted: event.retriesExhausted,
          timestamp: event.timestamp,
        },
      };
    case 'task_awaiting_approval':
      return {
        event: 'space.task.awaitingApproval',
        payload: {
          namespaceId,
          spaceId: event.spaceId,
          taskId: event.taskId,
          actionId: event.actionId,
          actionName: event.actionName,
          actionDescription: event.actionDescription,
          actionType: event.actionType,
          requiredLevel: event.requiredLevel,
          spaceLevel: event.spaceLevel,
          autonomyLevel: event.autonomyLevel,
          timestamp: event.timestamp,
        },
      };
    default:
      return null;
  }
}

export class SpaceRuntime {
  /** Map from workflowRunId → WorkflowExecutor for all active runs */
  private executors = new Map<string, WorkflowExecutor>();

  /**
   * Metadata stored per run so the executor can be recreated with fresh DB
   * state when the run has been externally modified (e.g. status reset after
   * a human gate approval).
   */
  private executorMeta = new Map<string, ExecutorMeta>();

  /**
   * Per-space SpaceTaskManager instances, cached to avoid creating a new
   * manager + repository on every executor build.
   */
  private taskManagers = new Map<string, SpaceTaskManager>();

  /**
   * Set to true after the first executeTick() call, after rehydrateExecutors()
   * has loaded in-progress runs from the DB. Prevents repeated rehydration.
   */
  private rehydrated = false;

  /** Handle returned by setInterval when the tick loop is running */
  private tickTimer: ReturnType<typeof setInterval> | null = null;
  /** Single-flight guard to prevent overlapping executeTick() runs. */
  private tickInFlight = false;

  /**
   * InternalEventBus for publishing typed Space domain events.
   *
   * Subscribers like `SpaceAgentNotificationService` listen here to translate
   * runtime events into agent-facing messages. May be undefined when the
   * runtime is constructed in tests that don't need to assert on the bus.
   */
  private internalEventBus: InternalEventBus<DaemonInternalEventMap> | undefined;

  /**
   * Lazy-initialized SDK message repository used for thread-event emission.
   * Sourced from `config.sdkMessageRepo` when provided, otherwise constructed
   * on first use from `config.db`.
   */
  private sdkMessageRepo: SDKMessageRepository | null = null;

  /**
   * Completion detector — inspects canonical `SpaceTask` to decide completion.
   * Initialized from config or defaulted to `new CompletionDetector(taskRepo)`.
   */
  private completionDetector: CompletionDetector;

  /**
   * Deduplication set for notifications keyed by `taskId:status` (e.g. `task-1:blocked`
   * or `task-1:timeout`). Prevents re-notifying for the same task+status across ticks.
   * Entries are cleared when the task leaves the flagged state.
   *
   * Restart contract: this set is in-memory only and starts empty on every daemon restart.
   * Tasks already in `blocked` at restart time will be re-notified once on the first
   * tick. This is intentional: the Space Agent session is also new after restart and needs to
   * learn about outstanding issues. No DB persistence for dedup state is required.
   */
  private notifiedTaskSet = new Set<string>();

  /**
   * In-memory crash counter per execution key (`${runId}:${nodeExecutionId}`).
   *
   * Tracks how many times a workflow node agent session has been detected dead.
   * When the count reaches MAX_TASK_AGENT_CRASH_RETRIES, the node execution is
   * escalated to `blocked`. Below the limit, execution is reset to `pending` for
   * re-spawn to tolerate transient startup failures.
   *
   * Reset contract: this map is in-memory only and starts empty on every daemon restart.
   */
  private taskCrashCounts = new Map<string, number>();

  /**
   * In-memory retry counter per workflow run ID.
   *
   * Tracks how many times a blocked run has been automatically recovered by
   * resetting its blocked executions to `pending`. When the count reaches
   * MAX_BLOCKED_RUN_RETRIES, the run stays blocked and a
   * `workflow_run_needs_attention` event is emitted instead.
   *
   * Reset contract: in-memory only, starts empty on every daemon restart.
   */
  private blockedRetryCounts = new Map<string, number>();

  /** In-memory store of resolved channels per run ID. Replaces run.config._resolvedChannels. */
  private workflowChannelsMap = new Map<string, WorkflowChannel[]>();

  /**
   * Tracks idle executions whose last SDK message was non-terminal.
   *
   * This is an in-memory guard only. Naturally idle incomplete executions are
   * preserved; qualified stale idle sessions receive one direct runtime nudge,
   * then repeated qualified idle is logged for human visibility.
   */
  private nonTerminalIdleStates = new Map<string, NonTerminalIdleState>();

  /**
   * In-memory Layer 1 recovery state keyed by `${runId}:${nodeExecutionId}`.
   * NodeExecution IDs are per agent slot, so a stuck agent in a multi-agent node
   * can be nudged/restarted without touching sibling agents.
   */
  private agentStuckRecovery = new Map<string, AgentStuckRecoveryState>();
  private readonly toolContinuationRepo: ToolContinuationRecoveryRepository;
  private readonly topicTrie = new TopicTrie<SubscriptionTarget>();
  private readonly pendingExternalEventQueue = new Map<string, PendingExternalEvent[]>();
  private readonly externalEventRetryTimers = new Map<string, Timer>();
  private readonly externalEventRetryCounts = new Map<string, number>();
  private readonly externalEventDeliveriesInFlight = new Set<string>();
  private readonly cancelledLongHorizonDeliveries = new Set<string>();
  private readonly longHorizonSubscriptionPatterns = new Map<string, string>();
  private readonly externalEventRateLimits = new Map<string, ExternalEventRateLimitState>();
  private unsubscribeExternalEventPublished?: () => void;
  private unsubscribeSdkToolUseCreated?: () => void;
  private unsubscribeSdkToolUseConsumed?: () => void;
  private acceptingExternalEvents = false;

  constructor(private config: SpaceRuntimeConfig) {
    this.internalEventBus = config.internalEventBus;
    this.completionDetector = config.completionDetector ?? new CompletionDetector(config.taskRepo);
    this.sdkMessageRepo = config.sdkMessageRepo ?? null;
    this.toolContinuationRepo = new ToolContinuationRecoveryRepository(config.db);
    if (hasSqlExec(config.db)) {
      this.toolContinuationRepo.ensureSchema();
    }
    this.subscribeExternalEventPublished();
    this.subscribeSdkToolUseCreated();
  }

  private subscribeSdkToolUseCreated(): void {
    if (
      !this.config.internalEventBus ||
      this.unsubscribeSdkToolUseCreated ||
      this.unsubscribeSdkToolUseConsumed
    ) {
      return;
    }
    this.unsubscribeSdkToolUseCreated = this.config.internalEventBus.subscribe(
      'sdk.toolUse.created',
      (payload) => {
        if (typeof payload.toolUseId !== 'string' || typeof payload.sessionId !== 'string') {
          return;
        }
        this.toolContinuationRepo.recordToolUse({
          toolUseId: payload.toolUseId,
          sessionId: payload.sessionId,
          ttlMs: DEFAULT_TOOL_USE_ACTIVE_TTL_MS,
        });
      },
      { subscriberName: 'SpaceRuntime.toolUseRecovery' }
    );
    this.unsubscribeSdkToolUseConsumed = this.config.internalEventBus.subscribe(
      'sdk.toolUse.consumed',
      (payload) => {
        if (typeof payload.toolUseId !== 'string') return;
        this.toolContinuationRepo.markConsumed(payload.toolUseId);
      },
      { subscriberName: 'SpaceRuntime.toolUseRecovery' }
    );
  }

  private subscribeExternalEventPublished(): void {
    if (this.unsubscribeExternalEventPublished || !this.config.internalEventBus) return;
    this.unsubscribeExternalEventPublished = this.config.internalEventBus.subscribe(
      'externalEvent.published',
      (payload) => this.handleExternalEvent(payload),
      { subscriberName: 'SpaceRuntime.externalEvents' }
    );
  }

  /**
   * Lazy accessor for the SDK message repository. Constructed from `config.db`
   * on first use when the caller did not inject one. Centralized here so
   * emission sites can stay one-liners and tests can inject a stub via config.
   */
  private getSdkMessageRepo(): SDKMessageRepository {
    if (!this.sdkMessageRepo) {
      this.sdkMessageRepo = new SDKMessageRepository(this.config.db);
    }
    return this.sdkMessageRepo;
  }

  private createNodeExecutionOrIgnore(params: CreateNodeExecutionParams): NodeExecution {
    if (isReservedWorkflowAgentName(params.agentName)) {
      throw new Error(`Agent name "${params.agentName}" is reserved for a built-in agent`);
    }
    return this.config.nodeExecutionRepo.createOrIgnore(params);
  }

  registerRunInterests(
    workflowRunId: string,
    taskId: string,
    nodes: WorkflowNode[],
    options: { clearQueuedDeliveries?: boolean } = {}
  ): void {
    this.topicTrie.remove(
      (target) =>
        isWorkflowSubscriptionTarget(target) &&
        target.workflowRunId === workflowRunId &&
        target.subscriptionKind !== 'dynamic'
    );
    if (options.clearQueuedDeliveries) {
      this.clearQueuedDeliveriesForRun(workflowRunId, 'run_interests_rebuilt');
    }
    for (const node of nodes) {
      for (const agentEntry of resolveNodeAgents(node)) {
        for (const interest of agentEntry.eventInterests ?? []) {
          const result = this.registerSubscription(
            workflowRunId,
            taskId,
            node.id,
            agentEntry.name,
            interest.topic,
            {
              subscriptionKind: 'static',
            }
          );
          if (!result.success) {
            throw new Error(
              `Invalid static external event interest for ${workflowRunId}/${node.id}/${agentEntry.name}: ` +
                (result.error ?? 'invalid pattern')
            );
          }
        }
      }
    }
  }

  private registerRunInterestsFromWorkflow(run: SpaceWorkflowRun, workflow: SpaceWorkflow): void {
    const task = this.pickCanonicalTaskForRun(run, this.config.taskRepo.listByWorkflowRun(run.id));
    if (!task) return;
    this.registerRunInterests(run.id, task.id, workflow.nodes);
  }

  /**
   * Register a single external event subscription for a specific workflow
   * run target. This is the primary entry point for runtime-driven
   * subscription registration (MCP tool, gate/artifact scripts).
   *
   * For test use and future runtime callers.
   */
  registerSubscription(
    workflowRunId: string,
    taskId: string,
    nodeId: string,
    agentName: string,
    topic: string,
    options: { subscriptionKind?: 'static' | 'dynamic' | 'auto' } = {}
  ): { success: boolean; error?: string } {
    const trimmed = topic?.trim();
    if (!trimmed) return { success: false, error: 'Topic pattern is required.' };
    const validation = validateGlobPattern(trimmed);
    if (!validation.valid) {
      log.warn(
        `SpaceRuntime: skipping invalid subscription topic "${trimmed}" for ` +
          `${workflowRunId}/${nodeId}/${agentName}: ${validation.reason ?? 'invalid pattern'}`
      );
      return { success: false, error: validation.reason ?? 'invalid pattern' };
    }
    const normalized = trimmed.toLowerCase();
    const subscriptionKind = options.subscriptionKind ?? 'dynamic';
    this.topicTrie.remove(
      (target) =>
        isWorkflowSubscriptionTarget(target) &&
        target.workflowRunId === workflowRunId &&
        target.taskId === taskId &&
        target.nodeId === nodeId &&
        target.agentName === agentName &&
        target.subscriptionKind === subscriptionKind &&
        target.topic?.toLowerCase() === normalized
    );
    const existingInterests = this.topicTrie.count(
      (target) =>
        isWorkflowSubscriptionTarget(target) &&
        target.workflowRunId === workflowRunId &&
        target.nodeId === nodeId &&
        target.agentName === agentName
    );
    if (existingInterests >= MAX_AGENT_SLOT_EVENT_INTERESTS) {
      throw new Error(
        `Agent slot ${workflowRunId}/${nodeId}/${agentName} cannot register more than ` +
          `${MAX_AGENT_SLOT_EVENT_INTERESTS} event interests`
      );
    }
    this.topicTrie.insert(trimmed, {
      workflowRunId,
      taskId,
      nodeId,
      agentName,
      topic: trimmed,
      subscriptionKind,
    });
    return { success: true };
  }

  refreshLongHorizonSubscription(
    spaceId: string,
    subscriptionId: string
  ): { success: boolean; error?: string } {
    const repo = this.config.longHorizonAgentRepo;
    if (!repo) return { success: false, error: 'Long-horizon agent repository unavailable.' };
    this.topicTrie.remove(
      (target) =>
        isLongHorizonSubscriptionTarget(target) &&
        target.spaceId === spaceId &&
        target.subscriptionId === subscriptionId
    );
    const previousPattern = this.longHorizonSubscriptionPatterns.get(subscriptionId);
    const subscription = repo.getSubscription(subscriptionId);
    if (!subscription || subscription.spaceId !== spaceId || subscription.status !== 'active') {
      this.longHorizonSubscriptionPatterns.delete(subscriptionId);
      this.clearLongHorizonRetries(
        (target) => target.spaceId === spaceId && target.subscriptionId === subscriptionId
      );
      return { success: true };
    }
    const agent = repo.getById(subscription.agentId);
    if (!agent || agent.spaceId !== spaceId || agent.status !== 'active') {
      this.longHorizonSubscriptionPatterns.delete(subscriptionId);
      this.clearLongHorizonRetries(
        (target) => target.spaceId === spaceId && target.subscriptionId === subscriptionId
      );
      return { success: true };
    }
    let pattern: string;
    try {
      pattern = composeLongHorizonSubscriptionPattern(subscription.source, subscription.topic);
    } catch (err) {
      return { success: false, error: err instanceof Error ? err.message : String(err) };
    }
    const validation = validateGlobPattern(pattern);
    if (!validation.valid) return { success: false, error: validation.reason ?? 'invalid pattern' };
    if (previousPattern && previousPattern.toLowerCase() !== pattern.toLowerCase()) {
      this.clearLongHorizonRetries(
        (target) => target.spaceId === spaceId && target.subscriptionId === subscriptionId
      );
    }
    this.longHorizonSubscriptionPatterns.set(subscriptionId, pattern);
    this.topicTrie.insert(pattern, {
      kind: 'long_horizon_agent',
      spaceId: subscription.spaceId,
      agentId: subscription.agentId,
      source: subscription.source,
      topic: pattern,
      subscriptionId: subscription.id,
    });
    return { success: true };
  }

  hasPendingRetriesForAgent(spaceId: string, agentId: string): boolean {
    for (const deliveryKey of this.externalEventRetryTimers.keys()) {
      const target = this.parseLongHorizonDeliveryKey(deliveryKey);
      if (target?.spaceId === spaceId && target.agentId === agentId) return true;
    }
    return false;
  }

  refreshLongHorizonAgentSubscriptions(
    spaceId: string,
    agentId: string
  ): { success: boolean; error?: string } {
    const repo = this.config.longHorizonAgentRepo;
    if (!repo) return { success: false, error: 'Long-horizon agent repository unavailable.' };
    const subscriptions = repo
      .listSubscriptions(agentId)
      .filter((subscription) => subscription.spaceId === spaceId);
    for (const subscription of subscriptions) {
      this.refreshLongHorizonSubscription(spaceId, subscription.id);
    }
    return { success: true };
  }

  removeLongHorizonSubscription(spaceId: string, subscriptionId: string): void {
    this.topicTrie.remove(
      (target) =>
        isLongHorizonSubscriptionTarget(target) &&
        target.spaceId === spaceId &&
        target.subscriptionId === subscriptionId
    );
    this.longHorizonSubscriptionPatterns.delete(subscriptionId);
    this.clearLongHorizonRetries(
      (target) => target.spaceId === spaceId && target.subscriptionId === subscriptionId
    );
  }

  removeLongHorizonAgentSubscriptions(spaceId: string, agentId: string): void {
    this.topicTrie.remove((target) => {
      const matches =
        isLongHorizonSubscriptionTarget(target) &&
        target.spaceId === spaceId &&
        target.agentId === agentId;
      if (matches) this.longHorizonSubscriptionPatterns.delete(target.subscriptionId);
      return matches;
    });
    this.clearLongHorizonRetries(
      (target) => target.spaceId === spaceId && target.agentId === agentId
    );
  }

  unregisterSubscription(
    workflowRunId: string,
    taskId: string,
    nodeId: string,
    agentName: string,
    topic: string
  ): { success: boolean; error?: string } {
    const trimmed = topic?.trim();
    if (!trimmed) return { success: false, error: 'Topic pattern is required.' };
    const validation = validateGlobPattern(trimmed);
    if (!validation.valid) {
      return { success: false, error: validation.reason ?? 'invalid pattern' };
    }
    const normalized = trimmed.toLowerCase();
    this.topicTrie.remove(
      (target) =>
        isWorkflowSubscriptionTarget(target) &&
        target.workflowRunId === workflowRunId &&
        target.taskId === taskId &&
        target.nodeId === nodeId &&
        target.agentName === agentName &&
        target.subscriptionKind === 'dynamic' &&
        target.topic?.toLowerCase() === normalized
    );
    return { success: true };
  }

  unregisterExecution(
    workflowRunId: string,
    taskId: string,
    nodeId: string,
    agentName: string
  ): void {
    this.topicTrie.remove(
      (target) =>
        isWorkflowSubscriptionTarget(target) &&
        target.workflowRunId === workflowRunId &&
        target.taskId === taskId &&
        target.nodeId === nodeId &&
        target.agentName === agentName
    );
    this.failQueuedDeliveriesForTarget(
      { workflowRunId, taskId, nodeId, agentName },
      'node_execution_cancelled'
    );
  }

  clearRunInterests(workflowRunId: string): void {
    this.topicTrie.remove(
      (target) => isWorkflowSubscriptionTarget(target) && target.workflowRunId === workflowRunId
    );
    this.clearQueuedDeliveriesForRun(workflowRunId, 'run_terminal_cleanup');
  }

  /**
   * Resolve the agent slot (task / node / agent name) currently active for a
   * workflow run — the most recent non-terminal node execution. Used by
   * auto-subscription helpers to attach GitHub PR event subscriptions on
   * behalf of the agent that posted the PR.
   *
   * Falls back to the most recent execution of any status (preserving its
   * nodeId / agentName) when no live execution exists — e.g. immediately
   * after a stall-recovery transition where the agent session is gone but
   * the next spawn will reuse the same slot. When no execution exists at
   * all, falls back to the workflow's start node + first agent so the
   * subscription attaches somewhere the next agent will inhabit.
   *
   * Returns `null` only when the run has no canonical task AND no workflow
   * definition is available.
   */
  resolveActiveExecutionSlotForRun(
    workflowRunId: string
  ): { taskId: string; nodeId: string; agentName: string } | null {
    const taskId = this.resolveExecutionTaskId(workflowRunId);
    if (!taskId) return null;
    const executions = this.config.nodeExecutionRepo.listByWorkflowRun(workflowRunId);
    const live = executions
      .filter((execution) => execution.agentSessionId && !execution.completedAt)
      .sort((a, b) => (b.startedAt ?? 0) - (a.startedAt ?? 0))[0];
    if (live) {
      return { taskId, nodeId: live.workflowNodeId, agentName: live.agentName };
    }
    // No live execution — fall back to the most recent execution of any
    // status so the subscription attaches to the slot the next spawn will
    // reuse (same nodeId / agentName).
    const mostRecent = executions
      .filter((execution) => execution.agentName)
      .sort((a, b) => (b.startedAt ?? b.createdAt ?? 0) - (a.startedAt ?? a.createdAt ?? 0))[0];
    if (mostRecent) {
      return { taskId, nodeId: mostRecent.workflowNodeId, agentName: mostRecent.agentName };
    }
    // No execution history at all — use the workflow's start node + first
    // agent as the canonical fallback slot.
    const run = this.config.workflowRunRepo.getRun(workflowRunId);
    if (!run) return null;
    const workflow = this.config.spaceWorkflowManager.getWorkflow(run.workflowId);
    const startNode = workflow?.nodes.find((node) => node.id === workflow.startNodeId);
    const firstAgent = startNode?.agents[0];
    if (!startNode || !firstAgent) return null;
    return { taskId, nodeId: startNode.id, agentName: firstAgent.name };
  }

  private resolveExecutionTaskId(workflowRunId: string): string | null {
    const tasks = this.config.taskRepo.listByWorkflowRun(workflowRunId);
    if (tasks.length === 0) return null;
    const run = this.config.workflowRunRepo.getRun(workflowRunId);
    if (!run) return tasks[0]!.id;
    return this.pickCanonicalTaskForRun(run, tasks)?.id ?? tasks[0]!.id;
  }

  /**
   * Auto-subscribe a blocked workflow run to GitHub PR events for a specific
   * pull request. Builds the topic pattern `github/owner/repo/pull_request/N.*`
   * and registers it on the run's currently-active agent slot via
   * {@link registerSubscription} (kind `dynamic`), so it is automatically
   * swept when the run terminates or the slot is unregistered.
   *
   * Returns `{ success: false }` when:
   * - `prUrl` cannot be parsed as a GitHub PR URL
   * - no active agent slot exists for the run
   * - the underlying `registerSubscription` call rejects (capacity / invalid)
   *
   * Idempotent: re-invoking with the same `prUrl` no-ops because
   * `registerSubscription` removes the prior identical pattern first. When
   * the PR URL changes (A → B) the prior auto-subscription for A is dropped
   * before the new one is registered so obsolete PR events stop matching.
   */
  registerPrEventSubscriptionForRun(
    workflowRunId: string,
    prUrl: string
  ): { success: boolean; error?: string; topicPattern?: string } {
    const parsed = parsePrUrl(prUrl);
    if (!parsed) {
      return { success: false, error: `Unable to parse GitHub PR URL: ${prUrl}` };
    }
    const slot = this.resolveActiveExecutionSlotForRun(workflowRunId);
    if (!slot) {
      return { success: false, error: 'No active agent slot for workflow run' };
    }
    // Drop any prior auto-subscriptions for this run before registering the
    // new pattern. This handles PR-URL changes (A → B) and also makes the
    // 'auto' kind a single-entry-per-run invariant.
    this.clearPrEventSubscriptionsForRun(workflowRunId);
    const topicPattern = buildPrEventTopicPattern(parsed);
    try {
      const result = this.registerSubscription(
        workflowRunId,
        slot.taskId,
        slot.nodeId,
        slot.agentName,
        topicPattern,
        { subscriptionKind: 'auto' }
      );
      if (!result.success) return { success: false, error: result.error, topicPattern };
      return { success: true, topicPattern };
    } catch (err) {
      return {
        success: false,
        error: err instanceof Error ? err.message : String(err),
        topicPattern,
      };
    }
  }

  /**
   * Sync the PR-event auto-subscription for a run that just transitioned to
   * `blocked` via direct `workflowRunRepo.transitionStatus(...)` paths that
   * bypass {@link transitionRunStatusAndEmit} (markFailed RPC, gate rejection
   * in space-agent-tools, etc.).
   *
   * Resolves the PR URL from gate data / artifacts (same resolver used at
   * runtime) and calls {@link registerPrEventSubscriptionForRun}. No-op when
   * the run is not actually blocked or no PR URL can be resolved. Idempotent.
   */
  notifyRunBlocked(workflowRunId: string): { subscribed: boolean; reason?: string } {
    const run = this.config.workflowRunRepo.getRun(workflowRunId);
    if (!run || run.status !== 'blocked') {
      return { subscribed: false, reason: `run status is ${run?.status ?? 'unknown'}` };
    }
    const prUrl = this.resolvePrUrlForRun(workflowRunId);
    if (!prUrl) {
      return { subscribed: false, reason: 'no resolvable PR URL' };
    }
    const result = this.registerPrEventSubscriptionForRun(workflowRunId, prUrl);
    if (!result.success) {
      return { subscribed: false, reason: result.error };
    }
    return { subscribed: true };
  }

  /**
   * Remove auto-subscribed GitHub PR event subscriptions for a workflow run.
   *
   * Only removes subscriptions whose `subscriptionKind === 'auto'` — i.e.
   * those created by {@link registerPrEventSubscriptionForRun}. Agent-registered
   * `dynamic` interests (e.g. via `subscribe_external_event`) on the same or
   * overlapping topics are preserved so an agent that explicitly subscribed
   * keeps receiving events after the gate opens.
   *
   * Called when a gate opens or the run transitions out of `blocked`.
   */
  clearPrEventSubscriptionsForRun(workflowRunId: string): void {
    this.topicTrie.remove(
      (target) =>
        isWorkflowSubscriptionTarget(target) &&
        target.workflowRunId === workflowRunId &&
        target.subscriptionKind === 'auto'
    );
  }

  flushPendingNodeQueue(target: WorkflowSubscriptionTarget): void {
    if (!target.sessionId) return;
    const targetWithExecution = this.resolveSubscriptionTarget(target);
    const key = this.buildQueueKey(target);
    const queued = this.pendingExternalEventQueue.get(key);
    if (!queued) return;
    this.pendingExternalEventQueue.delete(key);
    const now = Date.now();
    for (const item of queued) {
      if (this.isQueuedExternalEventExpired(item, now)) {
        this.failQueuedDeliveryForTtl(item, key);
        continue;
      }
      this.clearExternalEventRetry(item.deliveryKey);
      void this.enqueueDeliverableExternalEvent(
        targetWithExecution,
        item.event,
        item.deliveryKey,
        item.deliveryMode,
        item.createdAt,
        true
      );
    }
  }

  private async handleExternalEvent(payload: ExternalEventPublishedPayload): Promise<void> {
    const store = this.config.externalEventStore;
    if (!store) return;
    const allMatches = this.lookupSubscriptionTargets(payload.topic);
    // Trigger event-driven gate re-evaluation for blocked runs BEFORE the
    // delivery filter: a recovery-blocked run may have no live execution to
    // deliver to, but the gate re-eval hook only needs the PR event itself
    // to re-open the gate and unblock the workflow. Filtering on
    // `hasActiveExecutionForRun` here would leave such runs dark until the
    // 5-min poll cycle.
    //
    // Awaiting the hook here also prevents the deduper from terminally
    // marking the event `ignored` if the hook is still in flight when the
    // delivery filter below finds zero deliverable targets — without this,
    // a daemon crash between the fire-and-forget dispatch and gate
    // re-evaluation would lose the only wake-up event for a blocked run.
    const blockedHookRunIds = await this.fireBlockedRunExternalEventHook(payload, allMatches);

    const matches = allMatches.filter((target) => {
      if (isLongHorizonSubscriptionTarget(target)) return target.spaceId === payload.spaceId;
      const run = this.config.workflowRunRepo.getRun(target.workflowRunId);
      if (!run || run.spaceId !== payload.spaceId) return false;
      if (run.status === 'blocked') return this.hasActiveExecutionForRun(run.id);
      return isExternallyDeliverableRun(run.status);
    });

    if (matches.length === 0) {
      // If the blocked-run hook fired for any target, leave the event
      // published rather than marking it ignored — the hook may still
      // open a gate and trigger delivery of follow-up state. Marking
      // ignored here would dedupe-and-drop the only wake-up event.
      if (this.acceptingExternalEvents && blockedHookRunIds.size === 0) {
        store.markEventIgnored(payload.eventId, 'no_matching_subscriptions');
      }
      return;
    }

    const workflowDeliveries = new Map<
      string,
      { target: WorkflowSubscriptionTarget; deliveryKey: string }
    >();
    const longHorizonDeliveries = new Map<
      string,
      { target: LongHorizonSubscriptionTarget; deliveryKey: string }
    >();
    for (const match of matches) {
      try {
        if (isLongHorizonSubscriptionTarget(match)) {
          const deliveryKey = this.buildLongHorizonDeliveryKey(match, payload);
          store.registerExpectedDelivery(payload.eventId, deliveryKey, {
            workflowRunId: `long_horizon:${match.spaceId}`,
            taskId: match.subscriptionId,
            nodeId: match.agentId,
            agentName: match.agentId,
          });
          longHorizonDeliveries.set(deliveryKey, { target: match, deliveryKey });
          continue;
        }
        const target = this.resolveSubscriptionTarget(match);
        const deliveryKey = this.buildDeliveryKey(target, payload);
        store.registerExpectedDelivery(payload.eventId, deliveryKey, target);
        workflowDeliveries.set(deliveryKey, { target, deliveryKey });
      } catch (err) {
        const targetDescription = isLongHorizonSubscriptionTarget(match)
          ? `${match.spaceId}/${match.agentId}`
          : `${match.workflowRunId}/${match.nodeId}/${match.agentName}`;
        log.warn(
          `SpaceRuntime: failed to register external event ${payload.eventId} for ` +
            `${targetDescription}: ${formatCommandError(err)}`
        );
      }
    }

    for (const { target, deliveryKey } of longHorizonDeliveries.values()) {
      if (
        store.isDeliveryTerminal(payload.eventId, deliveryKey) ||
        this.externalEventDeliveriesInFlight.has(deliveryKey)
      ) {
        continue;
      }
      await this.deliverToLongHorizonAgent(target, payload, deliveryKey);
    }

    for (const { target, deliveryKey } of workflowDeliveries.values()) {
      try {
        if (
          store.isDeliveryTerminal(payload.eventId, deliveryKey) ||
          this.externalEventDeliveriesInFlight.has(deliveryKey)
        ) {
          continue;
        }

        if (target.sessionId && this.isTargetSessionLive(target.sessionId)) {
          await this.enqueueDeliverableExternalEvent(target, payload, deliveryKey, 'immediate');
        } else if (target.sessionId) {
          await this.enqueueDeliverableExternalEvent(target, payload, deliveryKey, 'defer');
        } else if (this.isPending(target)) {
          this.queueForPendingNode(target, payload, deliveryKey);
        } else if (
          this.hasActiveExecutionForRun(target.workflowRunId) &&
          !this.hasTerminalExecutionForTarget(target)
        ) {
          this.queueForPendingNode(target, payload, deliveryKey);
        } else {
          store.markDeliveryFailed(payload.eventId, deliveryKey, {
            terminal: true,
            reason: 'node_execution_not_active',
          });
          store.markEventFailedIfAllDeliveriesTerminal(payload.eventId);
        }
      } catch (err) {
        log.warn(
          `SpaceRuntime: failed to process external event ${payload.eventId} for ` +
            `${target.workflowRunId}/${target.nodeId}/${target.agentName}: ${formatCommandError(err)}`
        );
      }
    }
  }

  /**
   * Returns the set of runIds the hook was actually fired for (after all
   * guards). Caller uses this to decide whether to terminally mark the event
   * `ignored` — if a hook is in flight, the event must stay `published` so the
   * deduper can retry it should the hook fail before re-evaluation completes.
   */
  private async fireBlockedRunExternalEventHook(
    payload: ExternalEventPublishedPayload,
    matches: SubscriptionTarget[]
  ): Promise<Set<string>> {
    const hook = this.config.onBlockedRunExternalEvent;
    const firedRunIds = new Set<string>();
    if (!hook) return firedRunIds;
    const visitedRunIds = new Set<string>();
    const inflight: Array<Promise<void>> = [];
    for (const target of matches) {
      if (isLongHorizonSubscriptionTarget(target)) continue;
      const runId = target.workflowRunId;
      if (visitedRunIds.has(runId)) continue;
      const run = this.config.workflowRunRepo.getRun(runId);
      // Match the delivery filter's spaceId guard: a PR event published for
      // space A must not trigger gate re-eval for a blocked run in space B
      // even when both runs auto-subscribed to the same GitHub PR.
      if (!run || run.status !== 'blocked' || run.spaceId !== payload.spaceId) continue;
      visitedRunIds.add(runId);
      firedRunIds.add(runId);
      try {
        const result = hook({ runId, event: payload });
        if (result && typeof (result as Promise<void>).then === 'function') {
          inflight.push(
            (result as Promise<void>).catch((err) => {
              log.warn(
                `SpaceRuntime: onBlockedRunExternalEvent failed for run ${runId}: ` +
                  `${err instanceof Error ? err.message : String(err)}`
              );
            })
          );
        }
      } catch (err) {
        log.warn(
          `SpaceRuntime: onBlockedRunExternalEvent threw for run ${runId}: ` +
            `${err instanceof Error ? err.message : String(err)}`
        );
      }
    }
    if (inflight.length > 0) {
      await Promise.all(inflight);
    }
    return firedRunIds;
  }

  private async deliverToLongHorizonAgent(
    target: LongHorizonSubscriptionTarget,
    event: ExternalEventPublishedPayload,
    deliveryKey: string
  ): Promise<void> {
    const store = this.config.externalEventStore;
    if (!store) return;
    this.externalEventDeliveriesInFlight.add(deliveryKey);
    try {
      if (!this.config.deliverLongHorizonExternalEvent) {
        throw new Error('long-horizon event delivery unavailable');
      }
      const result = await this.config.deliverLongHorizonExternalEvent({
        spaceId: target.spaceId,
        agentId: target.agentId,
        message: this.formatExternalEventMessage(event),
        idempotencyKey: deliveryKey,
      });
      if (this.cancelledLongHorizonDeliveries.has(deliveryKey)) return;
      if (!result.delivered) throw new Error('long-horizon agent unavailable');
      this.clearExternalEventRetry(deliveryKey);
      store.markDeliveryDelivered(event.eventId, deliveryKey);
      store.markEventDeliveredIfAllDeliveriesDelivered(event.eventId);
      store.markEventFailedIfAllDeliveriesTerminal(event.eventId);
    } catch (err) {
      if (this.cancelledLongHorizonDeliveries.has(deliveryKey)) return;
      const failureReason = err instanceof Error ? err.message : String(err);
      store.markDeliveryFailed(event.eventId, deliveryKey, {
        terminal: false,
        reason: failureReason,
      });
      this.scheduleLongHorizonEventRetry(target, event, deliveryKey, failureReason);
      log.warn(
        `SpaceRuntime: failed to deliver external event ${event.eventId} to long-horizon agent ` +
          `${target.agentId}: ${failureReason}`
      );
    } finally {
      this.externalEventDeliveriesInFlight.delete(deliveryKey);
      this.cancelledLongHorizonDeliveries.delete(deliveryKey);
    }
  }

  private clearLongHorizonRetries(
    predicate: (target: LongHorizonSubscriptionTarget) => boolean
  ): void {
    for (const deliveryKey of Array.from(this.externalEventRetryTimers.keys())) {
      const target = this.parseLongHorizonDeliveryKey(deliveryKey);
      if (!target || !predicate(target)) continue;
      this.markLongHorizonRetryCancelled(deliveryKey);
      this.clearExternalEventRetry(deliveryKey);
    }
    for (const deliveryKey of Array.from(this.externalEventDeliveriesInFlight)) {
      const target = this.parseLongHorizonDeliveryKey(deliveryKey);
      if (!target || !predicate(target)) continue;
      this.cancelledLongHorizonDeliveries.add(deliveryKey);
      this.markLongHorizonRetryCancelled(deliveryKey);
    }
  }

  private markLongHorizonRetryCancelled(deliveryKey: string): void {
    const store = this.config.externalEventStore;
    if (!store) return;
    try {
      const eventId = store.getEventIdForDeliveryKey(deliveryKey);
      store.markDeliveryFailed(eventId, deliveryKey, {
        terminal: true,
        reason: 'subscription_no_longer_active',
      });
      store.markEventFailedIfAllDeliveriesTerminal(eventId);
    } catch {
      return;
    }
  }

  private scheduleLongHorizonEventRetry(
    target: LongHorizonSubscriptionTarget,
    event: ExternalEventPublishedPayload,
    deliveryKey: string,
    failureReason: string
  ): void {
    if (this.externalEventRetryTimers.has(deliveryKey)) return;
    const attempts = (this.externalEventRetryCounts.get(deliveryKey) ?? 0) + 1;
    this.externalEventRetryCounts.set(deliveryKey, attempts);
    if (attempts > EXTERNAL_EVENT_RETRY_MAX_ATTEMPTS) {
      this.config.externalEventStore?.markDeliveryFailed(event.eventId, deliveryKey, {
        terminal: true,
        reason: failureReason,
      });
      this.config.externalEventStore?.markEventFailedIfAllDeliveriesTerminal(event.eventId);
      this.clearExternalEventRetry(deliveryKey);
      return;
    }
    const timer = setTimeout(() => {
      this.externalEventRetryTimers.delete(deliveryKey);
      if (this.config.externalEventStore?.isDeliveryTerminal(event.eventId, deliveryKey)) {
        this.clearExternalEventRetry(deliveryKey);
        return;
      }
      if (this.externalEventDeliveriesInFlight.has(deliveryKey)) {
        this.scheduleLongHorizonEventRetry(target, event, deliveryKey, failureReason);
        return;
      }
      void this.deliverToLongHorizonAgent(target, event, deliveryKey);
    }, EXTERNAL_EVENT_RETRY_DELAY_MS);
    this.externalEventRetryTimers.set(deliveryKey, timer);
  }

  private async enqueueDeliverableExternalEvent(
    target: WorkflowSubscriptionTarget,
    event: ExternalEventPublishedPayload,
    deliveryKey: string,
    deliveryMode: 'immediate' | 'defer',
    createdAt = Date.now(),
    allowTargetSessionFallback = false
  ): Promise<void> {
    const now = Date.now();
    const rateLimitKey = this.buildRateLimitKey(target);
    const state = this.getExternalEventRateLimitState(rateLimitKey);
    state.timestamps = state.timestamps.filter(
      (timestamp) => now - timestamp < EXTERNAL_EVENT_RATE_WINDOW_MS
    );
    state.timestamps.push(now);
    if (state.timestamps.length <= EXTERNAL_EVENT_RATE_LIMIT_PER_MIN) {
      await this.deliverToSession(target, event, deliveryKey, deliveryMode);
      this.scheduleExternalEventRateLimitCleanup(rateLimitKey);
      return;
    }

    state.pendingDigest.push({
      target,
      event,
      deliveryKey,
      deliveryMode,
      createdAt,
      allowTargetSessionFallback,
    });
    if (!state.digestTimer) {
      state.digestTimer = setTimeout(() => {
        state.digestTimer = null;
        void this.flushExternalEventDigest(rateLimitKey);
      }, 0);
    }
  }

  private async flushExternalEventDigest(rateLimitKey: string): Promise<void> {
    const state = this.externalEventRateLimits.get(rateLimitKey);
    if (!state || state.pendingDigest.length === 0) return;
    const now = Date.now();
    const digestItems = state.pendingDigest.splice(0);
    state.timestamps = state.timestamps.filter(
      (timestamp) => now - timestamp < EXTERNAL_EVENT_RATE_WINDOW_MS
    );
    if (state.digestTimer) {
      clearTimeout(state.digestTimer);
      state.digestTimer = null;
    }
    this.scheduleExternalEventRateLimitCleanup(rateLimitKey);
    await this.deliverDigestToSession(digestItems);
  }

  private async deliverDigestToSession(items: ExternalEventDigestItem[]): Promise<void> {
    const store = this.config.externalEventStore;
    if (!store || items.length === 0) return;
    const target = this.resolveDigestDeliveryTarget(items[0]!);
    if (!target.sessionId) {
      for (const item of items) {
        store.markDeliveryFailed(item.event.eventId, item.deliveryKey, {
          terminal: false,
          reason: `deliveryMode:${item.deliveryMode}; digest requeued after session loss`,
        });
        this.queueForPendingNode(
          item.target,
          item.event,
          item.deliveryKey,
          item.deliveryMode,
          item.createdAt
        );
      }
      return;
    }
    const deliveryKeys = items.map((item) => item.deliveryKey);
    for (const deliveryKey of deliveryKeys) {
      this.externalEventDeliveriesInFlight.add(deliveryKey);
    }
    try {
      if (!this.config.commandBus) {
        throw new MissingCommandHandlerError('agent.message.inject');
      }
      const result = await this.config.commandBus.dispatch('agent.message.inject', {
        sessionId: target.sessionId,
        message: this.formatExternalEventDigestMessage(items),
        deliveryMode: items.some((item) => item.deliveryMode === 'immediate')
          ? 'immediate'
          : 'defer',
        metadata: {
          workflowRunId: target.workflowRunId,
          taskId: target.taskId,
          nodeId: target.nodeId,
          agentName: target.agentName,
          source: 'external_event_digest',
          eventIds: items.map((item) => item.event.eventId),
          topics: [...new Set(items.map((item) => item.event.topic))],
        },
      });
      if (!result?.ok) {
        throw new Error(formatCommandError(result?.error ?? 'agent.message.inject unavailable'));
      }
      for (const item of items) {
        this.clearExternalEventRetry(item.deliveryKey);
        this.clearQueuedDelivery(item.target, item.deliveryKey);
        store.markDeliveryDelivered(item.event.eventId, item.deliveryKey);
        store.markEventDeliveredIfAllDeliveriesDelivered(item.event.eventId);
        store.markEventFailedIfAllDeliveriesTerminal(item.event.eventId);
      }
    } catch (err) {
      const rawFailureReason = err instanceof Error ? err.message : String(err);
      const terminal = err instanceof MissingCommandHandlerError;
      for (const item of items) {
        const failureReason = `deliveryMode:${item.deliveryMode}; digest; ${rawFailureReason}`;
        store.markDeliveryFailed(item.event.eventId, item.deliveryKey, {
          terminal,
          reason: failureReason,
        });
        if (terminal) {
          this.clearExternalEventRetry(item.deliveryKey);
          this.clearQueuedDelivery(item.target, item.deliveryKey);
          store.markEventFailedIfAllDeliveriesTerminal(item.event.eventId);
          continue;
        }
        this.queueForRetry(
          target,
          item.event,
          item.deliveryKey,
          item.deliveryMode,
          failureReason,
          item.createdAt
        );
      }
    } finally {
      for (const deliveryKey of deliveryKeys) {
        this.externalEventDeliveriesInFlight.delete(deliveryKey);
      }
    }
  }

  private resolveDigestDeliveryTarget(item: ExternalEventDigestItem): WorkflowSubscriptionTarget {
    const target = item.target;
    const resolved = this.resolveSubscriptionTarget({
      workflowRunId: target.workflowRunId,
      taskId: target.taskId,
      nodeId: target.nodeId,
      agentName: target.agentName,
    });
    if (resolved.sessionId) return resolved;
    return item.allowTargetSessionFallback ? target : resolved;
  }

  private async deliverToSession(
    target: WorkflowSubscriptionTarget,
    event: ExternalEventPublishedPayload,
    deliveryKey: string,
    deliveryMode: 'immediate' | 'defer'
  ): Promise<void> {
    const store = this.config.externalEventStore;
    if (!store || !target.sessionId) return;
    this.externalEventDeliveriesInFlight.add(deliveryKey);
    try {
      if (!this.config.commandBus) {
        throw new MissingCommandHandlerError('agent.message.inject');
      }
      const result = await this.config.commandBus.dispatch('agent.message.inject', {
        sessionId: target.sessionId,
        message: this.formatExternalEventMessage(event),
        deliveryMode,
        metadata: {
          workflowRunId: target.workflowRunId,
          taskId: target.taskId,
          nodeId: target.nodeId,
          agentName: target.agentName,
          source: 'external_event',
          eventId: event.eventId,
          topic: event.topic,
        },
      });
      if (!result?.ok) {
        throw new Error(formatCommandError(result?.error ?? 'agent.message.inject unavailable'));
      }
      this.clearExternalEventRetry(deliveryKey);
      this.clearQueuedDelivery(target, deliveryKey);
      store.markDeliveryDelivered(event.eventId, deliveryKey);
      store.markEventDeliveredIfAllDeliveriesDelivered(event.eventId);
      store.markEventFailedIfAllDeliveriesTerminal(event.eventId);
    } catch (err) {
      const rawFailureReason = err instanceof Error ? err.message : String(err);
      const failureReason = `deliveryMode:${deliveryMode}; ${rawFailureReason}`;
      const terminal = err instanceof MissingCommandHandlerError;
      store.markDeliveryFailed(event.eventId, deliveryKey, {
        terminal,
        reason: failureReason,
      });
      if (terminal) {
        this.clearExternalEventRetry(deliveryKey);
        this.clearQueuedDelivery(target, deliveryKey);
        store.markEventFailedIfAllDeliveriesTerminal(event.eventId);
        return;
      }
      // Re-check run deliverability before queueing a retry — the run may
      // have transitioned to terminal while the dispatch was in flight.
      const currentRun = this.config.workflowRunRepo.getRun(target.workflowRunId);
      const blockedWithoutActiveExec =
        currentRun?.status === 'blocked' && !this.hasActiveExecutionForRun(currentRun.id);
      if (
        !currentRun ||
        !isExternallyDeliverableRun(currentRun.status) ||
        blockedWithoutActiveExec
      ) {
        store.markDeliveryFailed(event.eventId, deliveryKey, {
          terminal: true,
          reason: 'run_not_externally_deliverable',
        });
        store.markEventFailedIfAllDeliveriesTerminal(event.eventId);
        this.clearExternalEventRetry(deliveryKey);
        this.clearQueuedDelivery(target, deliveryKey);
        return;
      }
      const queued = this.getQueuedDelivery(target, deliveryKey);
      this.queueForRetry(
        target,
        event,
        deliveryKey,
        deliveryMode,
        failureReason,
        queued?.createdAt
      );
    } finally {
      this.externalEventDeliveriesInFlight.delete(deliveryKey);
    }
  }

  private queueForRetry(
    target: WorkflowSubscriptionTarget,
    event: ExternalEventPublishedPayload,
    deliveryKey: string,
    deliveryMode: 'immediate' | 'defer',
    failureReason: string,
    createdAt = Date.now()
  ): void {
    const queuedItem = { event, deliveryKey, deliveryMode, createdAt };
    if (this.isQueuedExternalEventExpired(queuedItem)) {
      this.failQueuedDeliveryForTtl(queuedItem, this.buildQueueKey(target));
      return;
    }
    this.queueForPendingNode(target, event, deliveryKey, deliveryMode, createdAt);
    this.scheduleExternalEventRetry(target, event, deliveryKey, deliveryMode, failureReason, {
      createdAt,
    });
  }

  private scheduleExternalEventRetry(
    target: WorkflowSubscriptionTarget,
    event: ExternalEventPublishedPayload,
    deliveryKey: string,
    deliveryMode: 'immediate' | 'defer',
    failureReason: string,
    options: { preserveAttemptCount?: boolean; createdAt?: number } = {}
  ): void {
    if (!target.sessionId || this.externalEventRetryTimers.has(deliveryKey)) return;
    const currentAttempts = this.externalEventRetryCounts.get(deliveryKey) ?? 0;
    const attempts = options.preserveAttemptCount ? currentAttempts : currentAttempts + 1;
    this.externalEventRetryCounts.set(deliveryKey, attempts);
    if (attempts > EXTERNAL_EVENT_RETRY_MAX_ATTEMPTS) {
      this.config.externalEventStore?.markDeliveryFailed(event.eventId, deliveryKey, {
        terminal: true,
        reason: failureReason,
      });
      this.config.externalEventStore?.markEventFailedIfAllDeliveriesTerminal(event.eventId);
      this.clearQueuedDelivery(target, deliveryKey);
      this.clearExternalEventRetry(deliveryKey);
      return;
    }

    const timer = setTimeout(() => {
      this.externalEventRetryTimers.delete(deliveryKey);
      if (this.config.externalEventStore?.isDeliveryTerminal(event.eventId, deliveryKey)) {
        this.clearExternalEventRetry(deliveryKey);
        return;
      }
      if (this.externalEventDeliveriesInFlight.has(deliveryKey)) {
        this.scheduleExternalEventRetry(target, event, deliveryKey, deliveryMode, failureReason, {
          preserveAttemptCount: true,
          createdAt: options.createdAt,
        });
        return;
      }
      const queued = this.getQueuedDelivery(target, deliveryKey);
      const queuedItem = queued ?? {
        event,
        deliveryKey,
        deliveryMode,
        createdAt: options.createdAt ?? Date.now(),
      };
      if (this.isQueuedExternalEventExpired(queuedItem)) {
        this.failQueuedDeliveryForTtl(queuedItem, this.buildQueueKey(target));
        return;
      }
      // Re-check run deliverability before dispatching — the run may have
      // transitioned to terminal while the retry timer was pending.
      const run = this.config.workflowRunRepo.getRun(target.workflowRunId);
      const blockedNoExec = run?.status === 'blocked' && !this.hasActiveExecutionForRun(run.id);
      if (!run || !isExternallyDeliverableRun(run.status) || blockedNoExec) {
        this.config.externalEventStore?.markDeliveryFailed(event.eventId, deliveryKey, {
          terminal: true,
          reason: 'run_not_externally_deliverable',
        });
        this.clearExternalEventRetry(deliveryKey);
        this.clearQueuedDelivery(target, deliveryKey);
        this.config.externalEventStore?.markEventFailedIfAllDeliveriesTerminal(event.eventId);
        return;
      }
      void this.deliverToSession(target, event, deliveryKey, deliveryMode);
    }, EXTERNAL_EVENT_RETRY_DELAY_MS);
    this.externalEventRetryTimers.set(deliveryKey, timer);
  }

  private rescheduleQueuedExternalEventRetries(): void {
    for (const [queueKey, queue] of this.pendingExternalEventQueue) {
      const target = parseSubscriptionQueueKey(queueKey);
      if (!target) continue;
      for (const item of queue) {
        if (this.isQueuedExternalEventExpired(item)) {
          this.failQueuedDeliveryForTtl(item, queueKey);
          continue;
        }
        const resolved = this.resolveSubscriptionTarget(target);
        if (!resolved.sessionId) continue;
        this.scheduleExternalEventRetry(
          resolved,
          item.event,
          item.deliveryKey,
          item.deliveryMode,
          `deliveryMode:${item.deliveryMode}; retry rescheduled after runtime restart`,
          { preserveAttemptCount: true, createdAt: item.createdAt }
        );
      }
    }
  }

  private clearExternalEventRetry(deliveryKey: string): void {
    const timer = this.externalEventRetryTimers.get(deliveryKey);
    if (timer) clearTimeout(timer);
    this.externalEventRetryTimers.delete(deliveryKey);
    this.externalEventRetryCounts.delete(deliveryKey);
  }

  private getQueuedDelivery(
    target: Pick<WorkflowSubscriptionTarget, 'workflowRunId' | 'taskId' | 'nodeId' | 'agentName'>,
    deliveryKey: string
  ): PendingExternalEvent | undefined {
    return this.pendingExternalEventQueue
      .get(this.buildQueueKey(target))
      ?.find((item) => item.deliveryKey === deliveryKey);
  }

  private clearQueuedDelivery(target: WorkflowSubscriptionTarget, deliveryKey: string): void {
    this.clearQueuedDeliveryByKey(this.buildQueueKey(target), deliveryKey);
  }

  private clearQueuedDeliveryByKey(key: string, deliveryKey: string): void {
    const queue = this.pendingExternalEventQueue.get(key);
    if (!queue) return;
    const remaining = queue.filter((item) => item.deliveryKey !== deliveryKey);
    if (remaining.length === 0) {
      this.pendingExternalEventQueue.delete(key);
    } else {
      this.pendingExternalEventQueue.set(key, remaining);
    }
  }

  private preservePendingDigestItem(item: ExternalEventDigestItem): void {
    const key = this.buildQueueKey(item.target);
    const queue = this.pendingExternalEventQueue.get(key) ?? [];
    if (queue.some((queued) => queued.deliveryKey === item.deliveryKey)) return;
    queue.push({
      event: item.event,
      deliveryKey: item.deliveryKey,
      deliveryMode: item.deliveryMode,
      createdAt: item.createdAt,
    });
    this.pendingExternalEventQueue.set(key, queue);
  }

  private queueForPendingNode(
    target: WorkflowSubscriptionTarget,
    event: ExternalEventPublishedPayload,
    deliveryKey: string,
    deliveryMode: 'immediate' | 'defer' = 'immediate',
    createdAt = Date.now()
  ): void {
    const key = this.buildQueueKey(target);
    const queue = this.pendingExternalEventQueue.get(key) ?? [];
    if (queue.some((item) => item.deliveryKey === deliveryKey)) return;
    if (queue.length >= 50) {
      const dropped = queue.shift();
      if (dropped && this.config.externalEventStore) {
        this.config.externalEventStore.markDeliveryFailed(
          dropped.event.eventId,
          dropped.deliveryKey,
          {
            terminal: true,
            reason: 'pending_node_queue_overflow',
          }
        );
        this.config.externalEventStore.markEventFailedIfAllDeliveriesTerminal(
          dropped.event.eventId
        );
        this.clearExternalEventRetry(dropped.deliveryKey);
      }
      log.warn(
        `SpaceRuntime: pending external event queue overflow for ${key}; dropped oldest event`
      );
    }
    queue.push({ event, deliveryKey, deliveryMode, createdAt });
    this.pendingExternalEventQueue.set(key, queue);
  }

  private isQueuedExternalEventExpired(item: PendingExternalEvent, now = Date.now()): boolean {
    return now - item.createdAt > EXTERNAL_EVENT_QUEUE_TTL_MS;
  }

  private failQueuedDeliveryForTtl(item: PendingExternalEvent, queueKey: string): void {
    this.config.externalEventStore?.markDeliveryFailed(item.event.eventId, item.deliveryKey, {
      terminal: true,
      reason: 'ttl_expired',
    });
    this.config.externalEventStore?.markEventFailedIfAllDeliveriesTerminal(item.event.eventId);
    this.clearExternalEventRetry(item.deliveryKey);
    this.clearQueuedDeliveryByKey(queueKey, item.deliveryKey);
    log.warn(
      `SpaceRuntime: dropped expired external event ${item.event.eventId} from pending queue ${queueKey}`
    );
  }

  private failQueuedDeliveriesForTarget(
    target: Omit<WorkflowSubscriptionTarget, 'sessionId'>,
    reason: string
  ): void {
    const key = this.buildQueueKey(target);
    const queued = this.pendingExternalEventQueue.get(key);
    if (!queued) return;
    this.failQueuedDeliveries(queued, reason);
    for (const item of queued) {
      this.clearExternalEventRetry(item.deliveryKey);
    }
    this.pendingExternalEventQueue.delete(key);
  }

  private clearQueuedDeliveriesForRun(workflowRunId: string, reason: string): void {
    for (const [queueKey, queued] of this.pendingExternalEventQueue) {
      const parsed = parseSubscriptionQueueKey(queueKey);
      if (!parsed || parsed.workflowRunId !== workflowRunId) continue;
      this.failQueuedDeliveries(queued, reason);
      for (const item of queued) {
        this.clearExternalEventRetry(item.deliveryKey);
      }
      this.pendingExternalEventQueue.delete(queueKey);
    }
  }

  private failQueuedDeliveries(queued: PendingExternalEvent[], reason: string): void {
    const store = this.config.externalEventStore;
    if (!store) return;
    for (const item of queued) {
      store.markDeliveryFailed(item.event.eventId, item.deliveryKey, { terminal: true, reason });
      store.markEventFailedIfAllDeliveriesTerminal(item.event.eventId);
    }
  }

  private resolveSubscriptionTarget(
    target: WorkflowSubscriptionTarget
  ): WorkflowSubscriptionTarget {
    const current = this.getCurrentQueueableOrActiveExecution(target);
    return current?.agentSessionId ? { ...target, sessionId: current.agentSessionId } : target;
  }

  private isPending(target: WorkflowSubscriptionTarget): boolean {
    const current = this.getCurrentQueueableOrActiveExecution(target);
    return current?.status === 'pending' || current?.status === 'waiting_rebind';
  }

  private hasActiveExecutionForRun(workflowRunId: string): boolean {
    return this.config.nodeExecutionRepo
      .listByWorkflowRun(workflowRunId)
      .some(
        (execution) =>
          (execution.status === 'pending' ||
            execution.status === 'in_progress' ||
            execution.status === 'waiting_rebind' ||
            execution.status === 'blocked') &&
          execution.completedAt === null
      );
  }

  private getCurrentQueueableOrActiveExecution(
    target: WorkflowSubscriptionTarget
  ): NodeExecution | undefined {
    return this.config.nodeExecutionRepo
      .listByNode(target.workflowRunId, target.nodeId)
      .filter(
        (execution) =>
          execution.agentName === target.agentName &&
          (execution.status === 'pending' ||
            execution.status === 'in_progress' ||
            execution.status === 'waiting_rebind')
      )
      .sort((a, b) => (b.updatedAt ?? b.createdAt) - (a.updatedAt ?? a.createdAt))[0];
  }

  private isTargetSessionLive(sessionId: string): boolean {
    return this.config.taskAgentManager?.isSessionAlive(sessionId) ?? false;
  }

  /**
   * Returns true when the target node-agent has at least one terminal
   * execution (idle/cancelled). Used to prevent queueing deliveries for
   * targets that have permanently finished but whose run is still active
   * due to other nodes.
   */
  private hasTerminalExecutionForTarget(
    target: Pick<WorkflowSubscriptionTarget, 'workflowRunId' | 'taskId' | 'nodeId' | 'agentName'>
  ): boolean {
    return this.config.nodeExecutionRepo
      .listByNode(target.workflowRunId, target.nodeId)
      .some(
        (execution) =>
          execution.agentName === target.agentName &&
          (execution.status === 'idle' || execution.status === 'cancelled')
      );
  }

  private buildQueueKey(
    target: Pick<WorkflowSubscriptionTarget, 'workflowRunId' | 'taskId' | 'nodeId' | 'agentName'>
  ): string {
    return JSON.stringify([target.workflowRunId, target.taskId, target.nodeId, target.agentName]);
  }

  private getExternalEventRateLimitState(rateLimitKey: string): ExternalEventRateLimitState {
    const existing = this.externalEventRateLimits.get(rateLimitKey);
    if (existing) {
      if (existing.cleanupTimer) {
        clearTimeout(existing.cleanupTimer);
        existing.cleanupTimer = null;
      }
      return existing;
    }
    const created = {
      timestamps: [],
      pendingDigest: [],
      digestTimer: null,
      cleanupTimer: null,
    };
    this.externalEventRateLimits.set(rateLimitKey, created);
    return created;
  }

  private scheduleExternalEventRateLimitCleanup(rateLimitKey: string): void {
    const state = this.externalEventRateLimits.get(rateLimitKey);
    if (!state || state.pendingDigest.length > 0 || state.cleanupTimer) return;
    const now = Date.now();
    state.timestamps = state.timestamps.filter(
      (timestamp) => now - timestamp < EXTERNAL_EVENT_RATE_WINDOW_MS
    );
    if (state.timestamps.length === 0) {
      this.externalEventRateLimits.delete(rateLimitKey);
      return;
    }
    const oldest = Math.min(...state.timestamps);
    state.cleanupTimer = setTimeout(
      () => {
        const current = this.externalEventRateLimits.get(rateLimitKey);
        if (!current) return;
        current.cleanupTimer = null;
        if (current.pendingDigest.length > 0) return;
        const cleanupNow = Date.now();
        current.timestamps = current.timestamps.filter(
          (timestamp) => cleanupNow - timestamp < EXTERNAL_EVENT_RATE_WINDOW_MS
        );
        if (current.timestamps.length === 0) {
          this.externalEventRateLimits.delete(rateLimitKey);
        } else {
          this.scheduleExternalEventRateLimitCleanup(rateLimitKey);
        }
      },
      Math.max(0, EXTERNAL_EVENT_RATE_WINDOW_MS - (now - oldest) + 1)
    );
  }

  private buildRateLimitKey(target: WorkflowSubscriptionTarget): string {
    const executionId = this.getCurrentQueueableOrActiveExecution(target)?.id;
    return executionId ?? `${target.workflowRunId}:${target.nodeId}:${target.agentName}`;
  }

  private buildDeliveryKey(
    target: WorkflowSubscriptionTarget,
    event: ExternalEventPublishedPayload
  ): string {
    return JSON.stringify([
      event.source,
      event.dedupeKey,
      target.taskId,
      target.nodeId,
      target.agentName,
      target.workflowRunId,
    ]);
  }

  private buildLongHorizonDeliveryKey(
    target: LongHorizonSubscriptionTarget,
    event: ExternalEventPublishedPayload
  ): string {
    return JSON.stringify([
      'long_horizon_agent',
      event.source,
      event.dedupeKey,
      target.spaceId,
      target.agentId,
      target.subscriptionId,
    ]);
  }

  private parseLongHorizonDeliveryKey(deliveryKey: string): LongHorizonSubscriptionTarget | null {
    try {
      const parsed = JSON.parse(deliveryKey) as unknown;
      if (!Array.isArray(parsed) || parsed.length !== 6 || parsed[0] !== 'long_horizon_agent') {
        return null;
      }
      const [, , , spaceId, agentId, subscriptionId] = parsed;
      if (
        typeof spaceId !== 'string' ||
        typeof agentId !== 'string' ||
        typeof subscriptionId !== 'string'
      ) {
        return null;
      }
      return {
        kind: 'long_horizon_agent',
        spaceId,
        agentId,
        source: '',
        topic: '',
        subscriptionId,
      };
    } catch {
      return null;
    }
  }

  private formatExternalEventMessage(event: ExternalEventPublishedPayload): string {
    return JSON.stringify(
      {
        type: 'external_event',
        summary: event.summary,
        eventId: event.eventId,
        topic: event.topic,
        source: event.source,
        externalUrl: event.externalUrl,
        occurredAt: event.occurredAt,
        payload: event.payload,
      },
      null,
      2
    );
  }

  private formatExternalEventDigestMessage(items: ExternalEventDigestItem[]): string {
    const topics = [...new Set(items.map((item) => item.event.topic))].sort();
    const occurredAtValues = items.map((item) => item.event.occurredAt);
    const oldest = new Date(Math.min(...occurredAtValues)).toISOString();
    const newest = new Date(Math.max(...occurredAtValues)).toISOString();
    return `${items.length} events received for topics: ${topics.join(
      ', '
    )} (oldest: ${oldest}, newest: ${newest}). Use subscribe_external_event to get details.`;
  }

  /**
   * Persist a synthetic SDK `system` message into the target session so it
   * surfaces in `SpaceTaskUnifiedThread`. Failures are logged and swallowed —
   * thread-event emission must never block a resume or fail a task.
   *
   * @internal — public for testing only.
   */
  emitTaskThreadEvent(sessionId: string, subtype: string, payload: Record<string, unknown>): void {
    try {
      // Shape mirrors the SDK system message contract expected by the web
      // thread renderer (`isSDKSystemMessage` + subtype switch in
      // `space-task-thread-events.ts`). Unknown subtypes degrade gracefully
      // to a generic "system" event, so consumers without the new subtype
      // branch still show something meaningful.
      const message = {
        type: 'system',
        subtype,
        session_id: sessionId,
        uuid: `${subtype}-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`,
        ...payload,
      } as unknown as Parameters<SDKMessageRepository['saveSDKMessage']>[1];
      this.getSdkMessageRepo().saveSDKMessage(sessionId, message);
    } catch (err) {
      log.warn(
        `[SpaceRuntime] Failed to emit thread event ${subtype} on session ${sessionId}: ` +
          `${err instanceof Error ? err.message : String(err)}`
      );
    }
  }

  /**
   * Returns the current dedup set snapshot for testing purposes.
   *
   * The returned Set is a copy — mutations have no effect on SpaceRuntime's
   * internal state.  Call this before and after a tick to verify that dedup
   * entries are added / removed as expected.
   *
   * @internal — exposed only for unit tests in the same package.
   */
  getNotifiedTaskSet(): ReadonlySet<string> {
    return new Set(this.notifiedTaskSet);
  }

  /**
   * Wire a TaskAgentManager into the runtime after construction.
   *
   * Called after construction to resolve the circular dependency:
   * SpaceRuntimeService is created first (so TaskAgentManager can reference it),
   * then TaskAgentManager is created, then it is injected back here.
   */
  setTaskAgentManager(manager: TaskAgentManager): void {
    this.config.taskAgentManager = manager;
    manager.attachToolContinuationRepo?.(this.toolContinuationRepo);
  }

  /**
   * Cached `PostApprovalRouter` instance (PR 2/5 of the
   * task-agent-as-post-approval-executor refactor). Built lazily on first use
   * because it depends on `taskAgentManager`, which is injected after
   * `SpaceRuntime` is constructed.
   */
  private postApprovalRouter: PostApprovalRouter | null = null;

  /**
   * Lazy-construct the `PostApprovalRouter` once `taskAgentManager` is
   * available. Returns `null` when the manager has not yet been injected —
   * the only expected scenario is very early startup before the daemon has
   * finished wiring, in which case we fall through to the legacy path.
   */
  private getPostApprovalRouter(): PostApprovalRouter | null {
    if (this.postApprovalRouter) return this.postApprovalRouter;
    const manager = this.config.taskAgentManager;
    if (!manager) return null;
    this.postApprovalRouter = new PostApprovalRouter({
      taskRepo: this.config.taskRepo,
      resolveCompletionOutcome: (task) => {
        const artifactSummary = task.workflowRunId
          ? this.resolvePrimaryResultArtifactSummary(task.workflowRunId)
          : undefined;
        return this.buildTaskOutcomeUpdates(
          task,
          artifactSummary ??
            normalizeMeaningfulTaskResult(task.result) ??
            normalizeMeaningfulTaskResult(task.reportedSummary),
          artifactSummary ?? normalizeMeaningfulTaskResult(task.reportedSummary)
        );
      },
      spawner: {
        spawnPostApprovalSubSession: (args) => manager.spawnPostApprovalSubSession(args),
      },
      livenessProbe: {
        isSessionAlive: (sessionId) => manager.isSessionAlive(sessionId),
      },
      goalService: this.config.goalService,
      evolutionScopeService: this.config.evolutionScopeService,
    });
    return this.postApprovalRouter;
  }

  /**
   * Public entry point — transition a task into `approved` and dispatch the
   * post-approval step via `PostApprovalRouter`.
   *
   * Called by:
   *   - The `space-runtime.ts` tick loop once an end-node `approve_task` has
   *     flagged the task ready to approve (via `reportedStatus='done'`).
   *   - `SpaceRuntimeService.dispatchPostApproval`, invoked from the
   *     `spaceTask.approvePendingCompletion` RPC handler when a human approves
   *     a task paused at a `task_completion` checkpoint.
   *
   * Contract:
   *   1. If the task is not already `approved`, transition it there via
   *      `SpaceTaskManager.setTaskStatus` (so the centralised transition
   *      validator runs).
   *   2. Call `PostApprovalRouter.route()` — which handles the no-route,
   *      inline (Task Agent), spawn, already-routed, and skip branches.
   *
   * Returns the `PostApprovalRouteResult` from the router (or a `skipped`
   * result when the router is not yet wired / the task is missing).
   */
  async dispatchPostApproval(
    taskId: string,
    approvalSource: SpaceApprovalSource,
    contextExtras: Omit<PostApprovalRouteContext, 'approvalSource'> = {}
  ): Promise<PostApprovalRouteResult> {
    const router = this.getPostApprovalRouter();
    if (!router) {
      const reason = `PostApprovalRouter not wired yet (taskAgentManager missing); task=${taskId}`;
      log.warn(`dispatchPostApproval: ${reason}`);
      return { mode: 'skipped', reason };
    }

    const current = this.config.taskRepo.getTask(taskId);
    if (!current) {
      const reason = `task ${taskId} not found`;
      log.warn(`dispatchPostApproval: ${reason}`);
      return { mode: 'skipped', reason };
    }

    const spaceId = current.spaceId;
    const space = await this.config.spaceManager.getSpace(spaceId);
    // Workflow lookup goes via the run (tasks reference workflowRunId, runs
    // reference workflowId). Standalone tasks have no run → no workflow → the
    // router takes the no-route branch.
    const run = current.workflowRunId
      ? this.config.workflowRunRepo.getRun(current.workflowRunId)
      : null;
    const workflow = run
      ? (this.config.spaceWorkflowManager.getWorkflow(run.workflowId) ?? null)
      : null;

    // 1. Ensure the task is in `approved` before routing. Uses the space's
    //    task manager so the transition validator runs (rejects illegal
    //    transitions with a structured error).
    //
    //    `approvalReason` must be forwarded from `contextExtras` (the RPC
    //    handler passes the operator's rejection/approval note) — otherwise
    //    `SpaceTaskManager.setTaskStatus` would stamp `null` and overwrite
    //    the value the caller may have already written via `updateTask`.
    //    We distinguish missing (undefined) from explicit null so an
    //    explicit clear still wins.
    const resolvedApprovalReason =
      typeof contextExtras.approvalReason === 'string'
        ? contextExtras.approvalReason
        : contextExtras.approvalReason === null
          ? null
          : undefined;
    let approvedTask: SpaceTask = current;
    if (current.status !== 'approved') {
      const taskManager = this.getOrCreateTaskManager(spaceId);
      approvedTask = await taskManager.setTaskStatus(taskId, 'approved', {
        approvalSource,
        approvalReason: resolvedApprovalReason,
      });
      await this.safeOnTaskUpdated(spaceId, approvedTask);
      log.info(
        `task.status-transition: taskId=${taskId} from=${current.status} to=approved source=${approvalSource}`
      );
    }

    // 2. Dispatch the actual post-approval step.
    //
    // `{{pr_url}}` in the merge template is sourced from the most recent
    // `workflow_run_artifacts` row whose `data` carries `prUrl` / `pr_url`.
    // The end-node reviewer persists the URL via
    // `save_artifact({ type: 'result', data: { prUrl } })` immediately
    // before calling `approve_task()`, so by the time we reach this branch
    // the artifact row exists. We deliberately do NOT read from
    // `SpaceTask`: migration 84 dropped `pr_url`/`pr_number` columns from
    // `space_tasks` and moved PR metadata to the artifact store.
    //
    // Callers may still override by passing `pr_url` in `contextExtras`
    // (RPC paths forward operator-supplied values) — their value wins
    // because the spread order below places `contextExtras` after the
    // artifact-resolved default.
    let resolvedPrUrl: string | undefined;
    if (this.config.artifactRepo && approvedTask.workflowRunId) {
      try {
        const artifacts = this.config.artifactRepo.listByRun(approvedTask.workflowRunId);
        // `listByRun` orders ASC by created_at; walk in reverse so the
        // most recent `prUrl`/`pr_url` wins (later reviewer cycles
        // supersede earlier ones).
        for (let i = artifacts.length - 1; i >= 0; i--) {
          const data = artifacts[i]?.data;
          if (!data) continue;
          const candidate =
            (typeof data.prUrl === 'string' && data.prUrl) ||
            (typeof data.pr_url === 'string' && data.pr_url);
          if (candidate) {
            resolvedPrUrl = candidate;
            break;
          }
        }
      } catch (err) {
        log.warn(
          `dispatchPostApproval: artifact lookup failed for run ${approvedTask.workflowRunId}: ${err instanceof Error ? err.message : String(err)}`
        );
      }
    }
    // The template interpolator (see `post-approval-template.ts`) resolves
    // tokens by raw identifier match — `{{autonomy_level}}` looks up the
    // key `autonomy_level`, not `autonomyLevel`. `PostApprovalRouteContext`
    // declares camelCase for the runtime-facing fields, so we MUST also
    // supply snake_case aliases so every merge-template token documented in
    // `POST_APPROVAL_TEMPLATE_KEYS` actually interpolates. Without these
    // aliases the autonomy-gate step in the merge template ("If
    // autonomy_level < 4 …") reads as a literal placeholder, which the
    // reviewer sub-session cannot compare to a number — effectively
    // disabling the gate or triggering spurious human-input requests.
    const routeContext: PostApprovalRouteContext = {
      ...(resolvedPrUrl ? { pr_url: resolvedPrUrl } : {}),
      ...contextExtras,
      approvalSource,
      approval_source: approvalSource,
      spaceId,
      space_id: spaceId,
      autonomyLevel: space?.autonomyLevel,
      autonomy_level: space?.autonomyLevel,
      workspacePath: space?.workspacePath,
      workspace_path: space?.workspacePath,
    };
    const routeResult = await router.route(approvedTask, workflow, routeContext);

    // 4. Re-read and emit so UI listeners see the post-dispatch task state
    //    (no-route → `done`, inline → `approvalReason` stamped, spawn →
    //    `postApprovalSessionId` stamped). The router performs its own
    //    `taskRepo.updateTask` writes without emitting; without this the
    //    end-node tick path would leave the UI waiting until the next poll.
    //    The RPC path also emits via `internalEventBus` after this returns — the
    //    double emit is benign (idempotent UI refresh).
    if (routeResult.mode !== 'skipped') {
      const final = this.config.taskRepo.getTask(taskId);
      if (final) await this.safeOnTaskUpdated(spaceId, final);

      // The no-route branch writes `done` directly via taskRepo,
      // bypassing setTaskStatus — so the dependency-unblock cascade
      // doesn't fire there. Trigger it here and emit for each
      // unblocked dependent so the UI sees the state change.
      // Guard on `final?.status === 'done'` to confirm the write
      // landed, and wrap in try-catch so unblock failures don't
      // abort the already-committed post-approval flow.
      if (routeResult.mode === 'no-route' && final?.status === 'done') {
        try {
          const taskManager = this.getOrCreateTaskManager(spaceId);
          const unblocked = await taskManager.unblockDependentTasks(taskId);
          for (const dep of unblocked) {
            await this.safeOnTaskUpdated(spaceId, dep);
          }
        } catch {
          // Best-effort: unblock failures must not abort
          // the post-approval flow.
        }
      }
    }
    return routeResult;
  }

  /**
   * Publish a Space runtime notification event to the configured InternalEventBus.
   *
   * Maps the legacy `kind`-tagged event shape (retained at call sites for
   * readability) onto the corresponding typed `space.*` event on
   * `InternalEventBus`. The `namespaceId` field is set to `'global'` because
   * these events are space-scoped, not session-scoped — subscribers that need
   * space-scoped filtering should inspect `payload.spaceId`.
   *
   * No-op when no bus is configured (e.g. unit tests). Errors from
   * `publish()` are caught and logged so a faulty subscriber cannot break
   * the runtime tick loop.
   */
  private async safeNotify(event: SpaceNotificationEvent): Promise<void> {
    if (!this.internalEventBus) return;
    const mapped = mapNotificationEventToInternalEvent(event);
    if (!mapped) return;
    try {
      await this.internalEventBus.publish(
        mapped.event,
        mapped.payload as DaemonInternalEventMap[typeof mapped.event] & InternalEventPayload
      );
    } catch (err) {
      log.warn(
        `[SpaceRuntime] internalEventBus.publish() threw for event "${mapped.event}": ${err instanceof Error ? err.message : String(err)}`
      );
    }
  }

  private async safeOnTaskUpdated(
    spaceId: string,
    task: SpaceTask,
    opts?: { archiveSource?: 'user' | 'system_reconcile' }
  ): Promise<void> {
    const handler = this.config.onTaskUpdated;
    if (!handler) return;
    try {
      await handler({ spaceId, task, archiveSource: opts?.archiveSource });
    } catch (err) {
      log.warn(
        `[SpaceRuntime] onTaskUpdated threw for task "${task.id}": ${err instanceof Error ? err.message : String(err)}`
      );
    }
  }

  private async safeOnWorkflowRunCreated(spaceId: string, run: SpaceWorkflowRun): Promise<void> {
    const handler = this.config.onWorkflowRunCreated;
    if (!handler) return;
    try {
      await handler({ spaceId, run });
    } catch (err) {
      log.warn(
        `[SpaceRuntime] onWorkflowRunCreated threw for run "${run.id}": ${err instanceof Error ? err.message : String(err)}`
      );
    }
  }

  private async safeOnWorkflowRunUpdated(spaceId: string, run: SpaceWorkflowRun): Promise<void> {
    const handler = this.config.onWorkflowRunUpdated;
    if (!handler) return;
    try {
      await handler({ spaceId, run });
    } catch (err) {
      log.warn(
        `[SpaceRuntime] onWorkflowRunUpdated threw for run "${run.id}": ${err instanceof Error ? err.message : String(err)}`
      );
    }
  }

  /**
   * Returns active, non-paused, non-stopped spaces.
   * Used by tick-loop methods to skip paused and stopped spaces.
   */
  private async listActiveSpaces(): Promise<import('@neokai/shared').Space[]> {
    const spaces = await this.config.spaceManager.listSpaces(false);
    return spaces.filter((s) => !s.paused && !s.stopped);
  }

  private async stopBlockedWorkflowTask(
    spaceId: string,
    task: SpaceTask,
    reason: string
  ): Promise<SpaceTask> {
    if (!task.workflowRunId) return task;

    const run = this.config.workflowRunRepo.getRun(task.workflowRunId);
    if (run && canTransitionRunStatus(run.status, 'blocked')) {
      await this.transitionRunStatusAndEmit(run.id, 'blocked');
    }

    const now = Date.now();
    for (const execution of this.config.nodeExecutionRepo.listByWorkflowRun(task.workflowRunId)) {
      if (
        !execution.agentSessionId ||
        execution.status === 'idle' ||
        execution.status === 'cancelled'
      ) {
        continue;
      }
      this.config.taskAgentManager?.cancelBySessionId(execution.agentSessionId);
      this.config.nodeExecutionRepo.update(execution.id, {
        status: 'cancelled',
        agentSessionId: null,
        result: reason,
        completedAt: now,
      });
    }

    if (task.taskAgentSessionId) {
      this.config.taskAgentManager?.cancelBySessionId(task.taskAgentSessionId);
    }
    const cleared = this.config.taskRepo.updateTask(task.id, {
      workflowRunId: task.workflowRunId,
      taskAgentSessionId: null,
    });
    if (cleared) {
      await this.safeOnTaskUpdated(spaceId, cleared);
    }
    this.clearAgentStuckStateForRun(task.workflowRunId);
    return cleared ?? task;
  }

  private async stopActiveWorkflowTaskAgents(task: SpaceTask, reason: string): Promise<SpaceTask> {
    if (!task.workflowRunId) return task;

    const now = Date.now();
    for (const execution of this.config.nodeExecutionRepo.listByWorkflowRun(task.workflowRunId)) {
      if (
        !execution.agentSessionId ||
        execution.status === 'idle' ||
        execution.status === 'cancelled'
      ) {
        continue;
      }
      this.config.taskAgentManager?.cancelBySessionId(execution.agentSessionId);
      this.config.nodeExecutionRepo.update(execution.id, {
        status: 'cancelled',
        agentSessionId: null,
        result: reason,
        completedAt: now,
      });
    }

    if (task.taskAgentSessionId) {
      this.config.taskAgentManager?.cancelBySessionId(task.taskAgentSessionId);
    }
    this.clearAgentStuckStateForRun(task.workflowRunId);
    return (
      this.config.taskRepo.updateTask(task.id, {
        workflowRunId: task.workflowRunId,
        taskAgentSessionId: null,
      }) ?? task
    );
  }

  async stopWorkflowBackedTaskForStatus(
    spaceId: string,
    taskId: string,
    params: UpdateSpaceTaskParams
  ): Promise<SpaceTask | null> {
    const previous = this.config.taskRepo.getTask(taskId);
    if (!previous) return null;
    const nextStatus = params.status;
    if (nextStatus && previous.status !== nextStatus) {
      const taskManager = this.getOrCreateTaskManager(spaceId);
      let updated = await taskManager.setTaskStatus(taskId, nextStatus, {
        result: params.result ?? undefined,
        approvalReason:
          nextStatus === 'cancelled'
            ? (params.cancelReason ?? params.approvalReason ?? undefined)
            : (params.approvalReason ?? undefined),
      });

      const {
        status: _status,
        result: _result,
        approvalReason: _approvalReason,
        cancelReason: _cancelReason,
        ...otherFields
      } = params;
      if (Object.keys(otherFields).length > 0) {
        updated = await taskManager.updateTask(taskId, otherFields);
      }
      if (
        nextStatus === 'cancelled' &&
        (params.cancelReason ?? params.approvalReason) &&
        updated.approvalReason !== (params.cancelReason ?? params.approvalReason)
      ) {
        updated =
          this.config.taskRepo.updateTask(taskId, {
            approvalReason: params.cancelReason ?? params.approvalReason ?? null,
          }) ?? updated;
      }
      if (!previous.workflowRunId) {
        await this.safeOnTaskUpdated(spaceId, updated);
        return updated;
      }

      const reason = params.result ?? updated.result ?? `Task ${nextStatus}`;
      updated = await this.stopActiveWorkflowTaskAgents(
        {
          ...updated,
          workflowRunId: previous.workflowRunId,
          taskAgentSessionId: previous.taskAgentSessionId,
        },
        reason
      );
      await this.safeOnTaskUpdated(spaceId, updated);

      if (nextStatus === 'cancelled') {
        const run = this.config.workflowRunRepo.getRun(previous.workflowRunId);
        if (run && canTransitionRunStatus(run.status, 'cancelled')) {
          await this.transitionRunStatusAndEmit(previous.workflowRunId, 'cancelled');
        }
      }
      return updated;
    }

    const updated = this.config.taskRepo.updateTask(taskId, params);
    if (updated) await this.safeOnTaskUpdated(spaceId, updated);
    return updated;
  }

  async cancelWorkflowRun(spaceId: string, runId: string): Promise<SpaceWorkflowRun> {
    const run = this.config.workflowRunRepo.getRun(runId);
    if (!run) throw new Error(`WorkflowRun not found: ${runId}`);
    for (const task of this.config.taskRepo.listByWorkflowRun(runId)) {
      if (task.status === 'open' || task.status === 'in_progress' || task.status === 'blocked') {
        await this.stopWorkflowBackedTaskForStatus(spaceId, task.id, { status: 'cancelled' });
      }
    }
    const updated = this.config.workflowRunRepo.getRun(runId) ?? run;
    if (updated.status === 'cancelled') return updated;
    if (canTransitionRunStatus(updated.status, 'cancelled')) {
      return this.transitionRunStatusAndEmit(runId, 'cancelled');
    }
    return updated;
  }

  async blockWorkflowBackedTask(
    spaceId: string,
    taskId: string,
    params: UpdateSpaceTaskParams
  ): Promise<SpaceTask | null> {
    return this.updateTaskAndEmit(spaceId, taskId, params);
  }

  private async updateTaskAndEmit(
    spaceId: string,
    taskId: string,
    params: UpdateSpaceTaskParams,
    opts?: { archiveSource?: 'user' | 'system_reconcile' }
  ): Promise<SpaceTask | null> {
    const previous = this.config.taskRepo.getTask(taskId);
    let updated = this.config.taskRepo.updateTask(taskId, params);
    if (updated) {
      let emitUpdated = true;

      // Cascade dependent-task state changes based on the parent's terminal status.
      //   - `blocked` (transient, retryable): only abort `in_progress` dependents.
      //     `open` dependents stay `open`, skipped by `areDependenciesMet()` until
      //     the dependency is retried/completed.
      //   - `cancelled` (terminal, will not auto-resume): cancel both `open` and
      //     `in_progress` dependents so they don't wait forever on an unmet dep.
      if (params.status === 'blocked') {
        const reason = params.result ?? updated.result ?? 'Task blocked';
        if (params.blockReason === 'dependency_added') {
          updated = await this.stopBlockedWorkflowTask(
            spaceId,
            {
              ...updated,
              workflowRunId: previous?.workflowRunId ?? updated.workflowRunId,
              taskAgentSessionId: previous?.taskAgentSessionId,
            },
            reason
          );
          emitUpdated = false;
          await this.safeNotify({
            kind: 'task_blocked',
            spaceId,
            taskId: updated.id,
            reason,
            timestamp: new Date().toISOString(),
          });
          if (updated.workflowRunId) {
            await this.safeNotify({
              kind: 'workflow_run_blocked',
              spaceId,
              runId: updated.workflowRunId,
              reason,
              timestamp: new Date().toISOString(),
            });
          }
        }
        const taskManager = this.getOrCreateTaskManager(spaceId);
        const cascaded = await taskManager.blockDependentTasks(taskId);
        for (const blocked of cascaded) {
          await this.safeOnTaskUpdated(spaceId, blocked);
        }
      } else if (params.status === 'cancelled') {
        const taskManager = this.getOrCreateTaskManager(spaceId);
        const cascaded = await taskManager.cancelDependentTasks(taskId);
        for (const cancelled of cascaded) {
          await this.safeOnTaskUpdated(spaceId, cancelled);
          // Cancel the underlying workflow run (if any) so completion
          // detection on the next tick doesn't finalize the run as
          // `done` just because the cancelled task signals
          // completion via `CompletionDetector.isComplete`. Only
          // in_progress dependents had a live run to begin with;
          // open dependents have no run attached.
          if (cancelled.workflowRunId) {
            const run = this.config.workflowRunRepo.getRun(cancelled.workflowRunId);
            if (run && canTransitionRunStatus(run.status, 'cancelled')) {
              await this.transitionRunStatusAndEmit(cancelled.workflowRunId, 'cancelled');
            }
          }
        }
      }
      if (emitUpdated) {
        await this.safeOnTaskUpdated(spaceId, updated, opts);
      }
    }
    return updated;
  }

  private async transitionRunStatusAndEmit(
    runId: string,
    nextStatus: SpaceWorkflowRun['status']
  ): Promise<SpaceWorkflowRun> {
    const previousStatus = this.config.workflowRunRepo.getRun(runId)?.status;
    const updated = this.config.workflowRunRepo.transitionStatus(runId, nextStatus);
    if (nextStatus === 'done' || nextStatus === 'cancelled') {
      this.clearRunInterests(runId);
    }
    if (nextStatus === 'blocked') {
      this.fireRunBlockedHook(runId);
    }
    // When a run leaves `blocked` (via resume / recovery / RPC), drop the
    // auto-registered PR event subscription so subsequent PR events are not
    // delivered to an agent that is no longer waiting on a gate. The
    // gate-open path already clears via syncBlockedRunPrEventSubscription,
    // but manual resume paths bypass it — this sweep covers them.
    if (previousStatus === 'blocked' && nextStatus !== 'blocked') {
      this.clearPrEventSubscriptionsForRun(runId);
    }
    await this.safeOnWorkflowRunUpdated(updated.spaceId, updated);
    return updated;
  }

  private fireRunBlockedHook(runId: string): void {
    const hook = this.config.onRunBlocked;
    if (!hook) return;
    try {
      const result = hook(runId);
      if (result && typeof (result as Promise<void>).catch === 'function') {
        (result as Promise<void>).catch((err) => {
          log.warn(
            `SpaceRuntime: onRunBlocked failed for run ${runId}: ` +
              `${err instanceof Error ? err.message : String(err)}`
          );
        });
      }
    } catch (err) {
      log.warn(
        `SpaceRuntime: onRunBlocked threw for run ${runId}: ` +
          `${err instanceof Error ? err.message : String(err)}`
      );
    }
  }

  /**
   * Choose the canonical task for a workflow run in one-task-per-run mode.
   *
   * Preference:
   * 1. Title exactly matches run title (case-insensitive, trimmed)
   * 2. Lowest task number
   * 3. Earliest created_at
   */
  private pickCanonicalTaskForRun(run: SpaceWorkflowRun, runTasks: SpaceTask[]): SpaceTask | null {
    if (runTasks.length === 0) return null;

    const normalize = (value: string | null | undefined): string =>
      (value ?? '').trim().toLowerCase();
    const runTitle = normalize(run.title);
    const titleMatches = runTasks.filter((task) => normalize(task.title) === runTitle);
    const pool = titleMatches.length > 0 ? titleMatches : runTasks;

    const sorted = [...pool].sort((a, b) => {
      if (a.taskNumber !== b.taskNumber) return a.taskNumber - b.taskNumber;
      if (a.createdAt !== b.createdAt) return a.createdAt - b.createdAt;
      return a.id.localeCompare(b.id);
    });

    return sorted[0] ?? null;
  }

  /**
   * Archive non-canonical run tasks and detach them from the run.
   *
   * This is a strict one-task-per-run repair path that removes legacy/duplicate
   * per-node tasks from active workflow state.
   */
  private async archiveDuplicateRunTasks(
    spaceId: string,
    run: SpaceWorkflowRun,
    canonicalTask: SpaceTask,
    runTasks: SpaceTask[],
    reason: 'active_run' | 'terminal_reconcile'
  ): Promise<void> {
    const duplicates = runTasks.filter((task) => task.id !== canonicalTask.id);
    if (duplicates.length === 0) return;

    log.warn(
      `SpaceRuntime: run ${run.id} has ${runTasks.length} tasks; archiving ${duplicates.length} duplicate task(s) in ${reason} repair`
    );

    const now = Date.now();
    for (const duplicate of duplicates) {
      if (duplicate.taskAgentSessionId && this.config.taskAgentManager) {
        this.config.taskAgentManager.cancelBySessionId(duplicate.taskAgentSessionId);
      }

      // Task #85: duplicate-run reconciliation marks tasks `archived` in DB
      // so the UI stops showing them as active, but this path is NOT a user
      // archive. Tag the event with `archiveSource: 'system_reconcile'` so
      // `TaskAgentManager.subscribeToTaskArchiveEvents` skips the cleanup
      // cascade (worktree removal + SDK .jsonl archival). The UI still
      // receives the `space.task.updated` event for the status change.
      await this.updateTaskAndEmit(
        spaceId,
        duplicate.id,
        {
          status: 'archived',
          archivedAt: duplicate.archivedAt ?? now,
          completedAt: duplicate.completedAt ?? now,
          workflowRunId: null,
          taskAgentSessionId: null,
        },
        { archiveSource: 'system_reconcile' }
      );

      this.notifiedTaskSet.delete(`${duplicate.id}:blocked`);
      this.notifiedTaskSet.delete(`${duplicate.id}:timeout`);
    }
  }

  /**
   * Reconcile task state for a terminal workflow run.
   *
   * Ensures:
   * - exactly one canonical task remains attached to the run
   * - canonical task status mirrors run status
   */
  private async reconcileTerminalRunTasks(run: SpaceWorkflowRun): Promise<void> {
    const runTasks = this.config.taskRepo.listByWorkflowRun(run.id);
    if (runTasks.length === 0) return;

    const canonicalTask = this.pickCanonicalTaskForRun(run, runTasks);
    if (!canonicalTask) return;

    if (runTasks.length > 1) {
      await this.archiveDuplicateRunTasks(
        run.spaceId,
        run,
        canonicalTask,
        runTasks,
        'terminal_reconcile'
      );
    }

    if (run.status === 'done') {
      const workflow =
        this.executorMeta.get(run.id)?.workflow ??
        this.config.spaceWorkflowManager.getWorkflow(run.workflowId) ??
        null;
      const summaryFromArtifact = this.resolvePrimaryResultArtifactSummary(run.id);
      const summaryFromWorkflow = workflow
        ? this.resolveCompletionSummary(run.id, workflow)
        : undefined;
      const summaryFromSibling = runTasks
        .filter((task) => task.id !== canonicalTask.id)
        .map((task) => normalizeMeaningfulTaskResult(task.result))
        .find((result) => result !== null);
      const reportedSummary = normalizeMeaningfulTaskResult(canonicalTask.reportedSummary);
      const existingResult = normalizeMeaningfulTaskResult(canonicalTask.result);
      const freshSummary = summaryFromArtifact ?? summaryFromWorkflow ?? null;
      const nextResult =
        freshSummary ?? existingResult ?? reportedSummary ?? summaryFromSibling ?? null;
      const nextReportedSummary = freshSummary ?? reportedSummary ?? summaryFromSibling ?? null;

      // Skip tasks already at a terminal or paused state — matches the
      // active-tick guard (`taskAlreadyResolved`) at processRunTick.
      // `blocked` is included so that a task that was cascade-blocked
      // by a dependency failure isn't pushed through dispatchPostApproval
      // (which would attempt an invalid `blocked → approved` transition).
      if (
        canonicalTask.status !== 'done' &&
        canonicalTask.status !== 'review' &&
        canonicalTask.status !== 'cancelled' &&
        canonicalTask.status !== 'approved' &&
        canonicalTask.status !== 'blocked'
      ) {
        // Preserve the computed result on the task before routing —
        // dispatchPostApproval handles the status transition itself.
        const updates = this.buildTaskOutcomeUpdates(
          canonicalTask,
          nextResult,
          nextReportedSummary
        );
        if (updates) {
          await this.updateTaskAndEmit(run.spaceId, canonicalTask.id, updates);
        }
        await this.dispatchPostApproval(canonicalTask.id, 'agent');
      } else {
        const updates = this.buildTaskOutcomeUpdates(
          canonicalTask,
          nextResult,
          nextReportedSummary
        );
        if (updates) {
          await this.updateTaskAndEmit(run.spaceId, canonicalTask.id, updates);
        }
      }
      return;
    }

    if (run.status === 'cancelled' && canonicalTask.status !== 'cancelled') {
      await this.updateTaskAndEmit(run.spaceId, canonicalTask.id, {
        status: 'cancelled',
        completedAt: canonicalTask.completedAt ?? run.completedAt ?? Date.now(),
      });
    }
  }

  /**
   * Reconcile terminal runs that are not in the executor map (already cleaned up).
   *
   * This keeps task state consistent after daemon restarts and repairs legacy runs
   * where external paths marked the run terminal but left task state inconsistent.
   */
  private async reconcileTerminalRunsWithoutExecutors(): Promise<void> {
    const spaces = await this.listActiveSpaces();
    for (const space of spaces) {
      const terminalRuns = this.config.workflowRunRepo
        .listBySpace(space.id)
        .filter((run) => run.status === 'done' || run.status === 'cancelled');
      for (const run of terminalRuns) {
        if (this.executors.has(run.id)) continue;
        await this.reconcileTerminalRunTasks(run);
      }
    }
  }

  // -------------------------------------------------------------------------
  // Lifecycle — start / stop
  // -------------------------------------------------------------------------

  /**
   * Starts the periodic tick loop.
   * Calls executeTick() immediately and then every `tickIntervalMs` ms.
   * Errors from executeTick() are caught and logged so the loop keeps running.
   */
  start(): void {
    if (this.tickTimer !== null) return; // already running

    this.subscribeExternalEventPublished();
    this.subscribeSdkToolUseCreated();
    this.acceptingExternalEvents = this.rehydrated;
    this.rescheduleQueuedExternalEventRetries();
    // Sweep events that arrived while stopped. On first start this is a
    // no-op (sweep runs inside executeTick after rehydrate). On
    // stop→start of the same runtime instance, it catches events that
    // were persisted while the external-event subscriber was detached.
    this.redispatchPublishedEventsWithoutDeliveries();
    const interval = this.config.tickIntervalMs ?? 5_000;

    // Kick off the first tick immediately, then schedule the loop.
    this.executeTick().catch((err: unknown) => {
      log.error('SpaceRuntime: initial tick failed:', err);
    });

    this.tickTimer = setInterval(() => {
      this.executeTick().catch((err: unknown) => {
        log.error('SpaceRuntime: tick failed:', err);
      });
    }, interval);
  }

  /**
   * Stops the periodic tick loop and waits for any in-flight tick to complete.
   *
   * This prevents race conditions during shutdown where an in-flight tick
   * continues to perform DB operations after the database has been closed.
   *
   * Does not affect in-progress executors — they remain in the map and can
   * be resumed by calling start() again.
   */
  async stop(): Promise<void> {
    this.unsubscribeExternalEventPublished?.();
    this.unsubscribeExternalEventPublished = undefined;
    this.unsubscribeSdkToolUseCreated?.();
    this.unsubscribeSdkToolUseCreated = undefined;
    this.unsubscribeSdkToolUseConsumed?.();
    this.unsubscribeSdkToolUseConsumed = undefined;
    for (const timer of this.externalEventRetryTimers.values()) {
      clearTimeout(timer);
    }
    this.externalEventRetryTimers.clear();
    this.externalEventRetryCounts.clear();
    for (const state of this.externalEventRateLimits.values()) {
      if (state.digestTimer) clearTimeout(state.digestTimer);
      if (state.cleanupTimer) clearTimeout(state.cleanupTimer);
      for (const item of state.pendingDigest) {
        this.config.externalEventStore?.markDeliveryFailed(item.event.eventId, item.deliveryKey, {
          terminal: false,
          reason: `deliveryMode:${item.deliveryMode}; digest pending during runtime stop`,
        });
        this.preservePendingDigestItem(item);
      }
    }
    this.externalEventRateLimits.clear();
    this.acceptingExternalEvents = false;
    if (this.tickTimer !== null) {
      clearInterval(this.tickTimer);
      this.tickTimer = null;
    }
    // Wait for any in-flight executeTick() to finish so that all DB
    // reads/writes and InternalEventBus<DaemonInternalEventMap> event emissions complete before the
    // caller proceeds to close the database.
    if (this.tickInFlight) {
      const MAX_TICK_DRAIN_MS = 30_000;
      const start = Date.now();
      await new Promise<void>((resolve) => {
        const check = () => {
          if (!this.tickInFlight) {
            resolve();
          } else if (Date.now() - start > MAX_TICK_DRAIN_MS) {
            log.warn(
              `SpaceRuntime: timed out waiting for in-flight tick after ${MAX_TICK_DRAIN_MS}ms — proceeding with shutdown`
            );
            resolve();
          } else {
            // 10 ms balances low latency (fast shutdown) against
            // CPU churn (no busy-spin) during the drain window.
            setTimeout(check, 10);
          }
        };
        check();
      });
    }
  }

  // -------------------------------------------------------------------------
  // Public API
  // -------------------------------------------------------------------------

  /**
   * Main tick method — call on a regular interval.
   *
   * On the first call, rehydrateExecutors() loads all in-progress workflow
   * runs from the DB into the executors map.
   *
   * On every call:
   * 1. Processes completed tasks and advances their workflows
   * 2. Cleans up executors for runs that have reached a terminal state
   * 3. Checks standalone tasks (no workflowRunId) for blocked and timeout
   */
  async executeTick(): Promise<void> {
    if (this.tickInFlight) return;
    this.tickInFlight = true;
    try {
      if (hasSqlExec(this.config.db)) {
        this.toolContinuationRepo.markExpired();
      }

      if (!this.rehydrated) {
        await this.rehydrateExecutors();
        // Run a stalled-run recovery pass right after rehydrate so the
        // first tick that processes runs already sees a clean slate
        // (orphan in_progress executions reset to pending, terminally
        // stalled runs flagged blocked). Idempotent — `recoverStalledRuns`
        // guards itself with `recoveryDone`. SpaceRuntimeService.start()
        // also invokes it after `provisionExistingSpaces`; whichever
        // fires first wins, the other becomes a no-op.
        await this.recoverStalledRuns();
        this.rehydrated = true;
        // Give the service a chance to rebuild in-memory subscriptions
        // (e.g. PR-event auto-subs for blocked runs) BEFORE both:
        //   - flipping `acceptingExternalEvents` to true
        //   - running the redispatch sweep
        // Otherwise a PR event landing during the rebuild window sees an
        // empty topic trie and is terminally marked `ignored`, breaking
        // the event-driven gate-eval path on the first post-restart tick.
        if (this.config.onBeforeRedispatch) {
          try {
            await this.config.onBeforeRedispatch();
          } catch (err) {
            log.warn(
              `SpaceRuntime: onBeforeRedispatch failed: ${err instanceof Error ? err.message : String(err)}`
            );
          }
        }
        this.acceptingExternalEvents = true;
        this.redispatchPublishedEventsWithoutDeliveries();
      }

      await this.attachStandaloneTasksToWorkflows();
      await this.processCompletedTasks();
      await this.cleanupTerminalExecutors();
      await this.reconcileTerminalRunsWithoutExecutors();
      await this.checkStandaloneTasks();
    } finally {
      this.tickInFlight = false;
    }
  }

  /**
   * Start a new workflow run for the given space and workflow.
   *
   * Flow:
   * 1. Load the workflow definition
   * 2. Create a SpaceWorkflowRun record (status: in_progress)
   * 3. Create a WorkflowExecutor and register it in the executors map
   * 4. Ensure one canonical SpaceTask exists for the run
   * 5. Create pending node_execution rows for the start node
   *
   * Returns the created run and its canonical task.
   * Cleans up maps if task/execution creation fails to prevent orphaned executor entries.
   */
  async startWorkflowRun(
    spaceId: string,
    workflowId: string,
    title: string,
    description?: string,
    options: StartWorkflowRunOptions = {}
  ): Promise<{ run: SpaceWorkflowRun; tasks: SpaceTask[] }> {
    const workflow = this.config.spaceWorkflowManager.getWorkflow(workflowId);
    if (!workflow) {
      throw new Error(`Workflow not found: ${workflowId}`);
    }
    if (workflow.disabled) {
      throw new Error(`Workflow "${workflow.name}" is disabled and cannot be used for new runs.`);
    }
    if (!workflow.endNodeId) {
      throw new Error(`Workflow "${workflowId}" is missing endNodeId and cannot be executed.`);
    }

    const space = await this.config.spaceManager.getSpace(spaceId);
    if (!space) {
      throw new Error(`Space not found: ${spaceId}`);
    }

    // Create the run record — starts as 'pending', immediately promoted to 'in_progress'
    const pendingRun = this.config.workflowRunRepo.createRun({
      spaceId,
      workflowId,
      title,
      description,
    });

    const run = this.config.workflowRunRepo.transitionStatus(pendingRun.id, 'in_progress');
    await this.safeOnWorkflowRunCreated(spaceId, run);

    // Initialize gate data defaults so per-cycle anchors (e.g. cycle_start_at)
    // are present from the start of the run.
    if (this.config.gateDataRepo && workflow.gates) {
      this.config.gateDataRepo.initializeForRun(
        run.id,
        workflow.gates.map((gate) => ({
          id: gate.id,
          data: computeGateDefaults(gate.fields ?? []),
        }))
      );
    }

    // Register executor and meta. If a later step fails, we must clean these up.
    const meta: ExecutorMeta = { workflow, spaceId, workspacePath: space.workspacePath };
    this.executorMeta.set(run.id, meta);
    const executor = this.buildExecutor(workflow, run, spaceId, space.workspacePath);
    this.executors.set(run.id, executor);

    // Find start node and ensure canonical run task. Roll back map entries if this fails.
    const startNode = workflow.nodes.find((s) => s.id === workflow.startNodeId);
    if (!startNode) {
      this.executors.delete(run.id);
      this.executorMeta.delete(run.id);
      await this.transitionRunStatusAndEmit(run.id, 'cancelled');
      throw new Error(`Start node "${workflow.startNodeId}" not found in workflow "${workflowId}"`);
    }

    const taskManager = this.getOrCreateTaskManager(spaceId);
    let canonicalTask: SpaceTask | null = null;
    let startAgents: ReturnType<typeof resolveNodeAgents>;
    try {
      // One run == one task. Reuse a provided parent task when available,
      // otherwise create a new canonical task for this run.
      if (options.parentTaskId) {
        const parent = this.config.taskRepo.getTask(options.parentTaskId);
        if (!parent) {
          throw new Error(`Parent task not found: ${options.parentTaskId}`);
        }
        if (parent.spaceId !== spaceId) {
          throw new Error(
            `Parent task ${options.parentTaskId} belongs to a different space (${parent.spaceId})`
          );
        }
        canonicalTask = await this.updateTaskAndEmit(spaceId, parent.id, {
          workflowRunId: run.id,
        });
      } else {
        canonicalTask = await taskManager.createTask({
          title,
          description: description ?? '',
          workflowRunId: run.id,
          status: 'open',
        });
      }
      if (!canonicalTask) {
        throw new Error(`Failed to initialize canonical task for run ${run.id}`);
      }
      await this.safeOnTaskUpdated(spaceId, canonicalTask);

      startAgents = resolveNodeAgents(startNode);
      for (const agentEntry of startAgents) {
        this.createNodeExecutionOrIgnore({
          workflowRunId: run.id,
          workflowNodeId: startNode.id,
          agentName: agentEntry.name,
          agentId: agentEntry.agentId ?? null,
          status: 'pending',
        });
      }
    } catch (err) {
      // Clean up the executor/meta entries so the run is not orphaned in the map.
      this.executors.delete(run.id);
      this.executorMeta.delete(run.id);
      // Cancel the DB run record so rehydrateExecutors() does not silently loop
      // over it on next server restart (an in_progress run with no tasks would
      // sit in the executor map indefinitely, never advancing and never erroring).
      await this.transitionRunStatusAndEmit(run.id, 'cancelled');
      throw err;
    }

    // Resolve channel topology for the start node and store in run config.
    // TODO: Milestone 6: pass resolvedChannels to session group creation in
    // TaskAgentManager.spawnTaskAgent() rather than storing in run config.
    this.storeWorkflowChannels(run.id, workflow.channels ?? []);

    return { run, tasks: canonicalTask ? [canonicalTask] : [] };
  }

  /**
   * Resolve a workflow for a new run from an explicit workflowId.
   *
   * Returns the workflow if found in this space's workflows, or null when:
   *   - No workflowId is provided (LLM agent must call list_workflows first)
   *   - The provided workflowId is not found in this space
   *
   * This is a thin integration point: it loads the space's workflows from the
   * DB and delegates to the pure `selectWorkflow()` function.
   */
  resolveWorkflowForRun(spaceId: string, workflowId?: string): SpaceWorkflow | null {
    const availableWorkflows = this.config.spaceWorkflowManager
      .listWorkflows(spaceId)
      .filter((w) => !w.disabled);
    return selectWorkflow({ spaceId, availableWorkflows, workflowId });
  }

  /**
   * Returns the WorkflowExecutor for a given run ID, or undefined if not tracked.
   * Useful for testing and external inspection.
   */
  getExecutor(runId: string): WorkflowExecutor | undefined {
    return this.executors.get(runId);
  }

  /** @internal — exposed only for unit tests/diagnostics. */
  getActiveGatePollCount(): number {
    return 0;
  }

  /** @internal — exposed only for unit tests/diagnostics. */
  isGatePollActive(runId: string, gateId: string): boolean {
    void runId;
    void gateId;
    return false;
  }

  /** @internal — exposed only for unit tests/diagnostics. */
  getPollPrUrlForRun(runId: string): string {
    return this.resolvePrUrlForRun(runId);
  }

  /**
   * Reopen or resume a workflow-backed task as one lifecycle operation.
   *
   * A bare SpaceTask status update is not enough for workflow tasks: terminal
   * workflow runs are reconciled back to their run status on the next tick, and
   * terminal node executions need either a live session reattached or a pending
   * row for the tick loop to spawn. This method updates the task, run, and the
   * current node execution rows together, then ensures the executor map is ready.
   */
  async recoverWorkflowBackedTask(
    spaceId: string,
    taskId: string,
    targetStatus: WorkflowTaskRecoveryTargetStatus
  ): Promise<{ task: SpaceTask; run: SpaceWorkflowRun }> {
    if (targetStatus !== 'open' && targetStatus !== 'in_progress') {
      throw new Error(
        `Workflow task recovery only supports active target statuses: open, in_progress`
      );
    }

    // Clear stale expired/failed queued handoffs and reset in-memory counters
    // so the next tick does not immediately re-block the run based on stale
    // pending message state from the previous failed cycle.
    //
    // Guarded on both task AND run ownership so a wrong-space caller (or a
    // task whose workflowRunId points to a foreign run) cannot delete messages
    // or reset retry counters. The transaction below also validates and throws
    // on mismatch, but these side-effects run outside the transaction.
    const preTxTask = this.config.taskRepo.getTask(taskId);
    const preTxRunId = preTxTask?.workflowRunId;
    const preTxRun = preTxRunId ? this.config.workflowRunRepo.getRun(preTxRunId) : null;
    if (preTxRunId && preTxTask.spaceId === spaceId && preTxRun?.spaceId === spaceId) {
      if (this.config.pendingMessageRepo) {
        this.config.pendingMessageRepo.clearTerminalForRun(preTxRunId);
      }
      this.blockedRetryCounts.delete(preTxRunId);
      // Clear non-terminal idle state so a manually recovered run starts fresh.
      for (const key of this.nonTerminalIdleStates.keys()) {
        if (key.startsWith(preTxRunId + ':')) {
          this.nonTerminalIdleStates.delete(key);
        }
      }
      // Clear Layer 1 alive-stuck state so manually recovered workflow runs get
      // a fresh nag/restart budget instead of inheriting stale recovery attempts.
      this.clearAgentStuckStateForRun(preTxRunId);
    }

    const liveSessionIds = new Set<string>();
    const recoverTx = this.config.db.transaction(() => {
      const task = this.config.taskRepo.getTask(taskId);
      if (!task) throw new Error(`Task not found: ${taskId}`);
      if (task.spaceId !== spaceId) throw new Error(`Task not found: ${taskId}`);
      if (!task.workflowRunId) {
        throw new Error(`Task ${taskId} is not backed by a workflow run`);
      }
      if (task.status !== targetStatus && !isValidSpaceTaskTransition(task.status, targetStatus)) {
        throw new Error(`Invalid status transition from '${task.status}' to '${targetStatus}'.`);
      }

      const run = this.config.workflowRunRepo.getRun(task.workflowRunId);
      if (!run) throw new Error(`WorkflowRun not found: ${task.workflowRunId}`);
      if (run.spaceId !== spaceId) throw new Error(`WorkflowRun not found: ${task.workflowRunId}`);

      let updatedRun =
        run.status === 'in_progress'
          ? run
          : this.config.workflowRunRepo.transitionStatus(run.id, 'in_progress');
      updatedRun =
        this.config.workflowRunRepo.updateRun(run.id, {
          failureReason: null,
          completedAt: null,
        }) ?? updatedRun;

      const updatedTask = this.config.taskRepo.updateTask(task.id, {
        status: targetStatus,
        completedAt: null,
        result: null,
        blockReason: null,
        approvalSource: null,
        approvalReason: null,
        approvedAt: null,
        pendingCheckpointType: null,
        pendingCompletionSubmittedByNodeId: null,
        pendingCompletionSubmittedAt: null,
        pendingCompletionReason: null,
        postApprovalSessionId: null,
        postApprovalStartedAt: null,
        postApprovalBlockedReason: null,
        reportedStatus: null,
        reportedSummary: null,
      });
      if (!updatedTask) throw new Error(`Failed to update task: ${task.id}`);

      let executions = this.config.nodeExecutionRepo.listByWorkflowRun(run.id);
      if (executions.length === 0) {
        const workflow = this.config.spaceWorkflowManager.getWorkflow(run.workflowId);
        if (!workflow) throw new Error(`Workflow not found: ${run.workflowId}`);
        const startNode = workflow.nodes.find((node) => node.id === workflow.startNodeId);
        if (!startNode) {
          throw new Error(
            `Start node "${workflow.startNodeId}" not found in workflow "${workflow.id}"`
          );
        }
        for (const agentEntry of resolveNodeAgents(startNode)) {
          this.createNodeExecutionOrIgnore({
            workflowRunId: run.id,
            workflowNodeId: startNode.id,
            agentName: agentEntry.name,
            agentId: agentEntry.agentId ?? null,
            status: 'pending',
          });
        }
        executions = this.config.nodeExecutionRepo.listByWorkflowRun(run.id);
      }

      const currentExecution = [...executions].sort((a, b) => {
        const aTime = a.updatedAt ?? a.startedAt ?? a.createdAt;
        const bTime = b.updatedAt ?? b.startedAt ?? b.createdAt;
        if (aTime !== bTime) return bTime - aTime;
        return b.id.localeCompare(a.id);
      })[0];
      const currentNodeExecutions = currentExecution
        ? executions.filter(
            (execution) => execution.workflowNodeId === currentExecution.workflowNodeId
          )
        : [];

      for (const execution of currentNodeExecutions) {
        const sessionId = execution.agentSessionId;
        const hasLiveSession =
          !!sessionId && (this.config.taskAgentManager?.isSessionAlive(sessionId) ?? false);

        if (hasLiveSession && sessionId) {
          this.config.nodeExecutionRepo.update(execution.id, {
            status: 'in_progress',
            completedAt: null,
          });
          liveSessionIds.add(sessionId);
        } else {
          this.config.nodeExecutionRepo.update(execution.id, {
            status: 'pending',
            result: null,
            data: null,
            startedAt: null,
            completedAt: null,
          });
        }
      }

      return { task: updatedTask, run: updatedRun };
    });

    const recovered = recoverTx();
    await this.ensureExecutorRegistered(recovered.run);
    for (const sessionId of liveSessionIds) {
      const prepared =
        (await this.config.taskAgentManager?.prepareSubSessionForWorkflowResume(sessionId)) ?? true;
      if (!prepared) {
        log.warn(
          `Workflow resume could not prepare MCP tools for live node-agent session ${sessionId}`
        );
      }
    }
    await this.safeOnWorkflowRunUpdated(
      spaceId,
      this.config.workflowRunRepo.getRun(recovered.run.id)!
    );
    await this.safeOnTaskUpdated(spaceId, this.config.taskRepo.getTask(recovered.task.id)!);
    return {
      run: this.config.workflowRunRepo.getRun(recovered.run.id) ?? recovered.run,
      task: this.config.taskRepo.getTask(recovered.task.id) ?? recovered.task,
    };
  }

  /**
   * Returns the number of executors currently tracked (active runs).
   */
  get executorCount(): number {
    return this.executors.size;
  }

  // -------------------------------------------------------------------------
  // Private — rehydration
  // -------------------------------------------------------------------------

  private async ensureExecutorRegistered(
    run: SpaceWorkflowRun,
    knownSpace?: Space
  ): Promise<boolean> {
    if (this.executors.has(run.id)) return true;

    const workflow = this.config.spaceWorkflowManager.getWorkflow(run.workflowId);
    if (!workflow) return false;

    const space = knownSpace ?? (await this.config.spaceManager.getSpace(run.spaceId));
    if (!space) return false;

    const meta: ExecutorMeta = {
      workflow,
      spaceId: space.id,
      workspacePath: space.workspacePath,
    };
    this.executorMeta.set(run.id, meta);
    this.executors.set(run.id, this.buildExecutor(workflow, run, space.id, space.workspacePath));
    this.registerRunInterestsFromWorkflow(run, workflow);
    return true;
  }

  /**
   * Rehydrates WorkflowExecutors from the DB for all in-progress workflow runs,
   * then rehydrates Task Agent sessions if a TaskAgentManager is configured.
   *
   * Called once at the start of the first executeTick(). Reconstructs
   * executors with the run's persisted currentNodeId so the tick loop can
   * resume advancement from where it left off.
   *
   * Executor rehydration runs first so that SpaceRuntimeService executors are
   * ready when Task Agents try to use them via their MCP tools.
   *
   * Runs that reference a missing workflow are skipped silently.
   */
  private requeuePersistedPendingDeliveries(): void {
    const store = this.config.externalEventStore;
    if (!store) return;

    for (const delivery of store.listPendingDeliveries()) {
      const eventRecord = store.getById(delivery.eventId);
      if (!eventRecord || eventRecord.state !== 'published') continue;
      const longHorizonSpaceId = longHorizonSpaceIdFromWorkflowRunId(delivery.workflowRunId);
      if (longHorizonSpaceId) {
        const eventPayload = this.externalEventPayloadFromRecord(eventRecord.event);
        const subscription = this.config.longHorizonAgentRepo?.getSubscription(delivery.taskId);
        const agent = subscription
          ? this.config.longHorizonAgentRepo?.getById(subscription.agentId)
          : null;
        let target: LongHorizonSubscriptionTarget | null = null;
        if (subscription) {
          try {
            target = {
              kind: 'long_horizon_agent',
              spaceId: longHorizonSpaceId,
              agentId: subscription.agentId,
              source: subscription.source,
              topic: composeLongHorizonSubscriptionPattern(subscription.source, subscription.topic),
              subscriptionId: subscription.id,
            };
          } catch (err) {
            store.markDeliveryFailed(delivery.eventId, delivery.deliveryKey, {
              terminal: true,
              reason: err instanceof Error ? err.message : String(err),
            });
            store.markEventFailedIfAllDeliveriesTerminal(delivery.eventId);
            continue;
          }
        }
        if (
          !subscription ||
          subscription.spaceId !== longHorizonSpaceId ||
          subscription.status !== 'active' ||
          !agent ||
          agent.spaceId !== longHorizonSpaceId ||
          agent.status !== 'active' ||
          !target ||
          !this.lookupSubscriptionTargets(eventPayload.topic).some(
            (match) =>
              isLongHorizonSubscriptionTarget(match) &&
              match.spaceId === target.spaceId &&
              match.subscriptionId === target.subscriptionId
          )
        ) {
          store.markDeliveryFailed(delivery.eventId, delivery.deliveryKey, {
            terminal: true,
            reason: 'subscription_no_longer_active',
          });
          store.markEventFailedIfAllDeliveriesTerminal(delivery.eventId);
          continue;
        }
        void this.deliverToLongHorizonAgent(target, eventPayload, delivery.deliveryKey);
        continue;
      }

      const run = this.config.workflowRunRepo.getRun(delivery.workflowRunId);
      const target = {
        workflowRunId: delivery.workflowRunId,
        taskId: delivery.taskId,
        nodeId: delivery.nodeId,
        agentName: delivery.agentName,
      };
      const canRequeue = run
        ? run.status === 'blocked'
          ? this.hasActiveExecutionForRun(run.id)
          : isExternallyDeliverableRun(run.status)
        : false;
      if (!canRequeue) {
        store.markDeliveryFailed(delivery.eventId, delivery.deliveryKey, {
          terminal: true,
          reason: 'run_not_externally_deliverable',
        });
        store.markEventFailedIfAllDeliveriesTerminal(delivery.eventId);
        continue;
      }

      if (!this.isTargetStillSubscribed(target, eventRecord.event.topic)) {
        store.markDeliveryFailed(delivery.eventId, delivery.deliveryKey, {
          terminal: true,
          reason: 'subscription_no_longer_active',
        });
        store.markEventFailedIfAllDeliveriesTerminal(delivery.eventId);
        continue;
      }

      const mode: 'immediate' | 'defer' = delivery.failureReason?.startsWith('deliveryMode:defer;')
        ? 'defer'
        : 'immediate';
      const eventPayload = this.externalEventPayloadFromRecord(eventRecord.event);
      const queuedItem = {
        event: eventPayload,
        deliveryKey: delivery.deliveryKey,
        deliveryMode: mode,
        createdAt: eventRecord.createdAt,
      };
      if (this.isQueuedExternalEventExpired(queuedItem)) {
        this.failQueuedDeliveryForTtl(queuedItem, this.buildQueueKey(target));
        continue;
      }
      this.queueForPendingNode(
        target,
        eventPayload,
        delivery.deliveryKey,
        mode,
        eventRecord.createdAt
      );
      const resolved = this.resolveSubscriptionTarget(target);
      if (resolved.sessionId) {
        this.scheduleExternalEventRetry(
          resolved,
          eventPayload,
          delivery.deliveryKey,
          mode,
          delivery.failureReason ?? `deliveryMode:${mode}; retry requeued after runtime rehydrate`,
          { preserveAttemptCount: true, createdAt: eventRecord.createdAt }
        );
      }
    }
  }

  private redispatchPublishedEventsWithoutDeliveries(): void {
    const store = this.config.externalEventStore;
    if (!store) return;
    for (const eventRecord of store.listPublishedEventsWithoutDeliveries()) {
      void this.handleExternalEvent(this.externalEventPayloadFromRecord(eventRecord.event));
    }
  }

  private rehydrateLongHorizonSubscriptions(spaceId: string): void {
    const repo = this.config.longHorizonAgentRepo;
    if (!repo) return;
    this.topicTrie.remove(
      (target) => isLongHorizonSubscriptionTarget(target) && target.spaceId === spaceId
    );
    for (const subscription of repo.listActiveSubscriptionsBySpace(spaceId)) {
      const result = this.refreshLongHorizonSubscription(spaceId, subscription.id);
      if (!result.success) {
        log.warn(
          `SpaceRuntime: skipping invalid long-horizon subscription ${subscription.id}: ` +
            (result.error ?? 'invalid pattern')
        );
      }
    }
  }

  private isTargetStillSubscribed(
    target: Pick<WorkflowSubscriptionTarget, 'workflowRunId' | 'taskId' | 'nodeId' | 'agentName'>,
    topic: string
  ): boolean {
    return this.lookupSubscriptionTargets(topic).some(
      (match) =>
        isWorkflowSubscriptionTarget(match) &&
        match.workflowRunId === target.workflowRunId &&
        match.taskId === target.taskId &&
        match.nodeId === target.nodeId &&
        match.agentName === target.agentName
    );
  }

  private lookupSubscriptionTargets(topic: string): SubscriptionTarget[] {
    const matches = this.topicTrie.lookup(topic);
    const legacyTopic = legacyGitHubTopic(topic);
    if (!legacyTopic) return matches;
    return matches.concat(this.topicTrie.lookup(legacyTopic));
  }

  private externalEventPayloadFromRecord(event: ExternalEvent): ExternalEventPublishedPayload {
    return {
      namespaceId: event.spaceId,
      spaceId: event.spaceId,
      eventId: event.id,
      source: event.source,
      topic: event.topic,
      dedupeKey: event.dedupeKey,
      summary: event.summary,
      externalUrl: event.externalUrl,
      payload: event.payload,
      occurredAt: event.occurredAt,
      ingestedAt: event.ingestedAt,
    };
  }

  async rehydrateExecutors(): Promise<void> {
    const spaces = await this.config.spaceManager.listSpaces(false);

    for (const space of spaces) {
      // getRehydratableRuns returns 'in_progress' AND 'blocked' runs.
      // 'pending' is still excluded — it's transient (task creation may have failed).
      // 'blocked' runs are included so a human-gate-blocked run gets its
      // executor reloaded on restart, allowing it to advance once the gate is resolved.
      const activeRuns = this.config.workflowRunRepo.getRehydratableRuns(space.id);
      const reviewRuns = this.config.workflowRunRepo
        .listBySpace(space.id)
        .filter(
          (run) =>
            !activeRuns.some((activeRun) => activeRun.id === run.id) &&
            run.status !== 'done' &&
            run.status !== 'cancelled' &&
            this.config.taskRepo.listByWorkflowRun(run.id).some((task) => task.status === 'review')
        );
      if (reviewRuns.length > 0) {
        log.info(
          `SpaceRuntime.rehydrateExecutors: found ${reviewRuns.length} review-pending run(s) with non-terminal status in space ${space.id}`
        );
      }
      activeRuns.push(...reviewRuns);

      for (const run of activeRuns) {
        if (this.executors.has(run.id)) continue;
        await this.ensureExecutorRegistered(run, space);
      }
      this.rehydrateLongHorizonSubscriptions(space.id);
    }

    this.requeuePersistedPendingDeliveries();

    // Rehydrate Task Agent sessions after executors are ready.
    // Executors must be loaded first so Task Agents can use MCP tools
    // that rely on the SpaceRuntimeService executor map.
    if (this.config.taskAgentManager) {
      await this.config.taskAgentManager.rehydrate();
    }
  }

  // -------------------------------------------------------------------------
  // Recovery — stalled in_progress runs after daemon restart
  // -------------------------------------------------------------------------

  /** Idempotency guard: ensures recovery runs at most once per process. */
  private recoveryDone = false;

  /**
   * Scan every active space for `in_progress` workflow runs whose in-flight
   * state was orphaned by a daemon restart, and re-drive them so the tick loop
   * can finalize the run on its next pass.
   *
   * Two outcomes (the third — `'skipped'` — covers runs that still have
   * driveable executions, which the tick loop owns):
   *
   *   1. **Stalled-with-completion-signal** — every node execution is terminal
   *      (`idle`/`cancelled`) and the canonical task is either already terminal
   *      or has a non-null `reportedStatus`. The next tick will see
   *      `CompletionDetector.isComplete()` return true and finalize via the
   *      existing pathway — this method only logs and skips.
   *
   *   2. **Stalled-with-no-signal** — every node execution is terminal but no
   *      completion signal was recorded. No agent is going to drive further
   *      progress, so the run is marked `blocked` with `block_reason =
   *      execution_failed` and a clear, restart-aware result message. Note:
   *      `attemptBlockedRunRecovery` early-returns when no executions are in
   *      `blocked` status — and a recovery-blocked run has all-idle/cancelled
   *      executions — so neither the Tier-1 retry nor Tier-2 escalation path
   *      will fire. The run sits `blocked` until human attention (or a future
   *      cleanup teaches `attemptBlockedRunRecovery` to also recover from
   *      idle/cancelled executions). This matches the spec requirement to
   *      flag ambiguous-recovery runs with a clear reason.
   *
   * Note: orphan in-progress executions whose agent sessions died across the
   * restart are NOT handled here — `processRunTick` already detects dead
   * sessions and runs the proper crash-retry pathway (with counting) on the
   * next tick. Duplicating that logic here would silently consume retries.
   *
   * Idempotent — guarded by `recoveryDone`. The first caller wins; subsequent
   * callers (e.g. the first `executeTick()` after `rehydrateExecutors()`) are
   * no-ops. Both `SpaceRuntimeService.start()` and `executeTick()` invoke this,
   * so the order in which they fire does not matter.
   *
   * Must be called *after* `rehydrateExecutors()` so executor metadata is
   * available for any run we might transition.
   */
  async recoverStalledRunsForSpace(spaceId: string): Promise<void> {
    const space = await this.config.spaceManager.getSpace(spaceId);
    if (!space || space.paused || space.stopped) return;

    let blockedCount = 0;
    let completionPendingCount = 0;
    const inProgressRuns = this.config.workflowRunRepo.getActiveRuns(space.id);
    for (const run of inProgressRuns) {
      try {
        const outcome = await this.recoverSingleRun(run);
        if (outcome === 'blocked') blockedCount++;
        else if (outcome === 'completion-pending') completionPendingCount++;
      } catch (err) {
        log.error(
          `SpaceRuntime.recoverStalledRunsForSpace: failed to recover run ${run.id} (space ${space.id}):`,
          err
        );
      }
    }

    if (blockedCount + completionPendingCount > 0) {
      log.info(
        `SpaceRuntime.recoverStalledRunsForSpace: space=${space.id} blocked=${blockedCount} completion-pending=${completionPendingCount}`
      );
    }
  }

  async recoverStalledRuns(): Promise<void> {
    if (this.recoveryDone) return;
    this.recoveryDone = true;

    const spaces = await this.config.spaceManager.listSpaces(false);
    let blockedCount = 0;
    let completionPendingCount = 0;
    let skippedPausedCount = 0;

    for (const space of spaces) {
      if (space.paused || space.stopped) {
        if (this.config.workflowRunRepo.getActiveRuns(space.id).length > 0) skippedPausedCount += 1;
        continue;
      }
      const inProgressRuns = this.config.workflowRunRepo.getActiveRuns(space.id);
      for (const run of inProgressRuns) {
        try {
          const outcome = await this.recoverSingleRun(run);
          if (outcome === 'blocked') blockedCount++;
          else if (outcome === 'completion-pending') completionPendingCount++;
        } catch (err) {
          log.error(
            `SpaceRuntime.recoverStalledRuns: failed to recover run ${run.id} (space ${space.id}):`,
            err
          );
        }
      }
    }

    if (skippedPausedCount > 0) {
      this.recoveryDone = false;
    }

    if (blockedCount + completionPendingCount > 0) {
      log.info(
        `SpaceRuntime.recoverStalledRuns: blocked=${blockedCount} completion-pending=${completionPendingCount}`
      );
    }
  }

  /**
   * Recover a single in_progress run after daemon restart.
   *
   * Returns the recovery outcome so the caller can aggregate counts:
   *   - `'completion-pending'` — all executions terminal AND completion signal
   *                              recorded; tick will finalize via CompletionDetector.
   *   - `'blocked'`           — all executions terminal AND no completion signal;
   *                              run forced to `blocked` for human/auto-recovery.
   *   - `'skipped'`           — nothing to do (e.g. has pending/in_progress/blocked
   *                              executions that the tick loop already drives,
   *                              or no executions at all).
   *
   * Orphan in_progress executions (whose agent sessions died at restart) are
   * intentionally left for `processRunTick` to handle — it already detects
   * dead sessions and applies the proper crash-retry-with-counting flow.
   */
  private async recoverSingleRun(
    run: SpaceWorkflowRun
  ): Promise<'completion-pending' | 'blocked' | 'skipped'> {
    const workflow = this.config.spaceWorkflowManager.getWorkflow(run.workflowId);
    const executions = this.config.nodeExecutionRepo.listByWorkflowRun(run.id);
    if (!workflow) {
      await this.blockRunWithMissingWorkflow(run, executions);
      return 'blocked';
    }
    const space = await this.config.spaceManager.getSpace(run.spaceId);
    if (executions.length === 0) return 'skipped';

    // If the tick loop has any work it can drive — `pending` (about
    // to spawn), `in_progress` (alive or crashed agent → existing
    // liveness path resets/blocks), or `blocked` (existing
    // `attemptBlockedRunRecovery` will retry/escalate) — leave the run
    // alone. Recovery only intervenes when the runtime has nothing it
    // can act on (every execution is `idle` or `cancelled`).
    const hasDriveableExecution = executions.some(
      (ex) =>
        ex.status === 'pending' ||
        ex.status === 'in_progress' ||
        ex.status === 'waiting_rebind' ||
        ex.status === 'blocked'
    );
    const hasQueuedNodeHandoff =
      this.config.pendingMessageRepo
        ?.listPendingForRun(run.id)
        .some((row) => row.targetKind === 'node_agent') ?? false;
    if (hasDriveableExecution || hasQueuedNodeHandoff) return 'skipped';

    // Every execution is `idle` or `cancelled` (true terminal at the
    // node level — no agent is going to drive further state). Branch on
    // whether a completion signal was recorded on the canonical task.
    const tasks = this.config.taskRepo.listByWorkflowRun(run.id);
    const canonicalTask = this.pickCanonicalTaskForRun(run, tasks);

    // A canonical task is "at rest" — i.e. NOT a stalled run that needs
    // daemon-restart intervention — when it is in any of these states:
    //
    //   - `done` / `cancelled`  → terminal; the tick loop's
    //                             CompletionDetector will pick it up and
    //                             finalize the run.
    //   - `review`              → end-node agent finished and the workflow
    //                             is paused awaiting human approval (e.g.
    //                             via `submit_for_approval`). All node
    //                             executions are correctly `idle` while we
    //                             wait for the human; this is not a stall.
    //   - `approved`            → human (or auto_policy) approved; a
    //                             post-approval executor (e.g. PR merge)
    //                             may still be in flight, leaving prior
    //                             node executions `idle`.
    //   - `reportedStatus !== null` → end-node agent reported a result;
    //                                 the next tick will route through the
    //                                 completion path.
    //
    // In all of these cases a daemon restart must NOT alter task status.
    // Only when none of these hold is the run genuinely stalled and
    // eligible to be flagged `blocked`.
    const completionSignalled =
      canonicalTask !== null &&
      (canonicalTask.status === 'done' ||
        canonicalTask.status === 'cancelled' ||
        canonicalTask.status === 'review' ||
        canonicalTask.status === 'approved' ||
        canonicalTask.reportedStatus !== null);

    if (!completionSignalled && canonicalTask) {
      const nonTerminalIdleOutcome = await this.handleNonTerminalIdleExecutions(
        run.id,
        run.spaceId,
        canonicalTask,
        workflow,
        undefined,
        space ?? null
      );
      if (nonTerminalIdleOutcome === 'blocked') return 'blocked';
      if (nonTerminalIdleOutcome === 'retried' || nonTerminalIdleOutcome === 'preserved') {
        return 'skipped';
      }
    }

    if (completionSignalled) {
      // Tick loop's CompletionDetector + processRunTick will fire on the
      // next pass and transition the run to `done` (or pick up the
      // cancelled task), or the run will remain paused awaiting the
      // human / post-approval executor that owns it. Nothing to do
      // here — the run is at rest, not stalled.
      return 'completion-pending';
    }

    const activated = await this.activateRestartRecoveryDownstreamNodes(run, executions);
    if (activated) return 'skipped';

    // Genuinely stalled with no completion signal — flag the run
    // as blocked so the user-facing task surfaces in the "Needs Attention"
    // group rather than appearing in_progress forever.
    //
    // We use `execution_failed` as the block reason (the most accurate of
    // the existing `SpaceBlockReason` values for "node terminated without
    // reaching completion") and a dedicated, restart-aware `result`
    // message so operators can distinguish this from the in-tick blocked
    // path.
    await this.transitionRunStatusAndEmit(run.id, 'blocked');
    if (canonicalTask) {
      const result =
        'Workflow run stalled across daemon restart: all node executions ' +
        'terminated (idle/cancelled) without a completion signal. The run ' +
        'will auto-retry or escalate for human attention.';
      await this.updateTaskAndEmit(run.spaceId, canonicalTask.id, {
        status: 'blocked',
        blockReason: 'execution_failed',
        result,
        completedAt: null,
      });
      await this.safeNotify({
        kind: 'task_blocked',
        spaceId: run.spaceId,
        taskId: canonicalTask.id,
        reason: result,
        timestamp: new Date().toISOString(),
      });
    }
    await this.safeNotify({
      kind: 'workflow_run_blocked',
      spaceId: run.spaceId,
      runId: run.id,
      reason: 'Daemon restart left workflow run stalled with no completion signal',
      timestamp: new Date().toISOString(),
    });
    log.warn(
      `SpaceRuntime.recoverStalledRuns: run ${run.id} (space ${run.spaceId}) was in_progress ` +
        `with all node executions idle/cancelled and no completion signal — flagged blocked`
    );
    return 'blocked';
  }

  private async blockRunWithMissingWorkflow(
    run: SpaceWorkflowRun,
    executions: NodeExecution[]
  ): Promise<void> {
    const reason = `Workflow ${run.workflowId} no longer exists; workflow run cannot continue`;
    const now = Date.now();
    for (const execution of executions) {
      if (execution.status === 'cancelled') continue;
      if (execution.agentSessionId) {
        this.config.taskAgentManager?.cancelBySessionId(execution.agentSessionId);
      }
      this.config.nodeExecutionRepo.update(execution.id, {
        status: 'cancelled',
        result: reason,
        completedAt: now,
      });
    }
    await this.transitionRunStatusAndEmit(run.id, 'blocked');
    const canonicalTask = this.pickCanonicalTaskForRun(
      run,
      this.config.taskRepo.listByWorkflowRun(run.id)
    );
    if (canonicalTask) {
      await this.updateTaskAndEmit(run.spaceId, canonicalTask.id, {
        status: 'blocked',
        blockReason: 'workflow_invalid',
        result: reason,
        completedAt: null,
      });
      await this.safeNotify({
        kind: 'task_blocked',
        spaceId: run.spaceId,
        taskId: canonicalTask.id,
        reason,
        timestamp: new Date().toISOString(),
      });
    }
    await this.safeNotify({
      kind: 'workflow_run_blocked',
      spaceId: run.spaceId,
      runId: run.id,
      reason,
      timestamp: new Date().toISOString(),
    });
    log.warn(`SpaceRuntime.recoverStalledRuns: blocked run ${run.id}: ${reason}`);
  }

  private async activateRestartRecoveryDownstreamNodes(
    run: SpaceWorkflowRun,
    executions: NodeExecution[]
  ): Promise<boolean> {
    const workflow = this.config.spaceWorkflowManager.getWorkflow(run.workflowId);
    if (!workflow) return false;
    const channels = workflow.channels ?? [];
    if (channels.length === 0) return false;

    const nodeByName = new Map(workflow.nodes.map((node) => [node.name, node]));
    const idleExecutions = executions.filter((execution) => execution.status === 'idle');
    const stalledTransitions: Array<{
      sourceExecution: NodeExecution;
      sourceNode: SpaceWorkflow['nodes'][number];
      channel: WorkflowChannel;
      channelIndex: number;
      targetNames: string[];
    }> = [];
    for (const execution of idleExecutions) {
      const node = workflow.nodes.find((candidate) => candidate.id === execution.workflowNodeId);
      if (!node) continue;
      for (const [channelIndex, channel] of channels.entries()) {
        if (!this.matchesRestartRecoveryChannelSource(channel, node, execution.agentName)) continue;
        const targetNames = this.resolveRestartRecoveryTargetNames(channel, workflow).filter(
          (targetName) => {
            const targetNode = nodeByName.get(targetName);
            return (
              !targetNode ||
              this.shouldRecoverRestartRecoveryTarget(targetNode, executions, workflow.endNodeId)
            );
          }
        );
        if (targetNames.length === 0) continue;
        stalledTransitions.push({
          sourceExecution: execution,
          sourceNode: node,
          channel,
          channelIndex,
          targetNames,
        });
      }
    }
    const createdOrReset: string[] = [];
    const blockedGateReasons: string[] = [];

    for (const {
      sourceExecution,
      sourceNode,
      channel,
      channelIndex,
      targetNames,
    } of stalledTransitions) {
      const cycleResult = this.evaluateRestartRecoveryCycle(
        run.id,
        workflow,
        channel,
        channelIndex
      );
      if (!cycleResult.open) {
        blockedGateReasons.push(cycleResult.reason);
        continue;
      }
      let activatedOnChannel = false;
      for (const targetName of targetNames) {
        const targetNode = nodeByName.get(targetName);
        if (!targetNode || targetNode.id === sourceNode.id) continue;

        const gateSourceName = channel.from === '*' ? sourceNode.name : channel.from;
        const gateResult = await this.evaluateRestartRecoveryChannelGate(
          run.id,
          workflow,
          channel,
          gateSourceName
        );
        if (!gateResult.open) {
          blockedGateReasons.push(
            gateResult.reason ?? `Gate ${channel.gateId ?? 'unknown'} blocked channel ${channel.id}`
          );
          continue;
        }

        let activatedForTarget = false;
        let resetExistingTarget = false;
        for (const agentEntry of resolveNodeAgents(targetNode)) {
          const existing = this.config.nodeExecutionRepo
            .listByNode(run.id, targetNode.id)
            .find((execution) => execution.agentName === agentEntry.name);
          if (existing) {
            if (existing.status === 'idle' || existing.status === 'cancelled') {
              this.config.nodeExecutionRepo.update(existing.id, {
                status: 'pending',
                result: null,
                startedAt: null,
                completedAt: null,
              });
              activatedForTarget = true;
              resetExistingTarget = true;
            }
            continue;
          }
          this.createNodeExecutionOrIgnore({
            workflowRunId: run.id,
            workflowNodeId: targetNode.id,
            agentName: agentEntry.name,
            agentId: agentEntry.agentId ?? null,
            status: 'pending',
          });
          activatedForTarget = true;
        }
        if (activatedForTarget) {
          createdOrReset.push(targetNode.name);
          activatedOnChannel = true;
          this.enqueueRestartRecoveryMessage(
            run,
            sourceExecution.agentName,
            targetNode,
            resetExistingTarget
          );
        }
      }
      if (activatedOnChannel) {
        this.recordRestartRecoveryCycleTraversal(run.id, workflow, channel, channelIndex);
      }
    }

    if (createdOrReset.length > 0) {
      log.warn(
        `SpaceRuntime.recoverStalledRuns: recovered run ${run.id} by activating downstream node(s): ${[
          ...new Set(createdOrReset),
        ].join(', ')}`
      );
      return true;
    }
    if (blockedGateReasons.length > 0) {
      log.warn(
        `SpaceRuntime.recoverStalledRuns: run ${run.id} has downstream transition(s) but gate(s) are closed: ${[
          ...new Set(blockedGateReasons),
        ].join('; ')}`
      );
    }
    return false;
  }

  private evaluateRestartRecoveryCycle(
    runId: string,
    workflow: SpaceWorkflow,
    channel: WorkflowChannel,
    channelIndex: number
  ): { open: true } | { open: false; reason: string } {
    if (!isChannelCyclic(channelIndex, workflow.channels ?? [], workflow.nodes)) {
      return { open: true };
    }
    const maxCycles = channel.maxCycles ?? 5;
    const cycleRepo = new ChannelCycleRepository(this.config.db);
    const record = cycleRepo.get(runId, channelIndex);
    if (record && record.count >= maxCycles) {
      return {
        open: false,
        reason: `Cyclic channel "${channel.id ?? channelIndex}" has reached the maximum cycle count (${maxCycles}). Increase maxCycles to allow more cycles.`,
      };
    }
    return { open: true };
  }

  private recordRestartRecoveryCycleTraversal(
    runId: string,
    workflow: SpaceWorkflow,
    channel: WorkflowChannel,
    channelIndex: number
  ): void {
    if (!isChannelCyclic(channelIndex, workflow.channels ?? [], workflow.nodes)) return;
    const maxCycles = channel.maxCycles ?? 5;
    const cycleRepo = new ChannelCycleRepository(this.config.db);
    const gateDataRepo = new GateDataRepository(this.config.db);
    const cyclicGates = (workflow.gates ?? []).filter((gate) => gate.resetOnCycle);
    const increment = () => {
      for (const gate of cyclicGates) {
        gateDataRepo.reset(runId, gate.id, computeGateDefaults(gate.fields ?? []));
      }
      return cycleRepo.incrementCycleCount(runId, channelIndex, maxCycles);
    };
    const incremented =
      cyclicGates.length > 0 ? this.config.db.transaction(increment)() : increment();
    if (!incremented) {
      log.warn(
        `SpaceRuntime.recoverStalledRuns: cyclic channel "${channel.id ?? channelIndex}" reached maxCycles during recovery activation`
      );
    }
  }

  private matchesRestartRecoveryChannelSource(
    channel: WorkflowChannel,
    sourceNode: SpaceWorkflow['nodes'][number],
    sourceAgentName: string
  ): boolean {
    return (
      channel.from === '*' || channel.from === sourceNode.name || channel.from === sourceAgentName
    );
  }

  private shouldRecoverRestartRecoveryTarget(
    targetNode: SpaceWorkflow['nodes'][number],
    executions: NodeExecution[],
    endNodeId?: string
  ): boolean {
    if (targetNode.id === endNodeId) return true;
    const executionsByAgent = new Map(
      executions
        .filter((execution) => execution.workflowNodeId === targetNode.id)
        .map((execution) => [execution.agentName, execution])
    );
    return resolveNodeAgents(targetNode).some((agentEntry) => {
      const execution = executionsByAgent.get(agentEntry.name);
      return !execution || execution.status !== 'idle';
    });
  }

  private resolveRestartRecoveryTargetNames(
    channel: WorkflowChannel,
    workflow: SpaceWorkflow
  ): string[] {
    const rawTargets = Array.isArray(channel.to) ? channel.to : [channel.to];
    const resolvedTargets = new Set<string>();
    for (const rawTarget of rawTargets) {
      const targetNode = workflow.nodes.find(
        (node) =>
          node.name === rawTarget ||
          node.id === rawTarget ||
          resolveNodeAgents(node).some((agent) => agent.name === rawTarget)
      );
      resolvedTargets.add(targetNode?.name ?? rawTarget);
    }
    return [...resolvedTargets];
  }

  private async evaluateRestartRecoveryChannelGate(
    runId: string,
    workflow: SpaceWorkflow,
    channel: WorkflowChannel,
    sourceName?: string
  ): Promise<{ open: boolean; reason?: string }> {
    if (!channel.gateId) return { open: true };
    const storedGate = (workflow.gates ?? []).find((candidate) => candidate.id === channel.gateId);
    if (!storedGate) {
      return {
        open: false,
        reason: `Gate "${channel.gateId}" not found — channel "${channel.id}" is closed (misconfiguration)`,
      };
    }
    let gate = storedGate;
    if (workflow.templateName) {
      const liveScript = getBuiltInGateScript(workflow.templateName, storedGate.id);
      if (liveScript && storedGate.script) gate = { ...storedGate, script: liveScript };
    }
    gate = getEffectiveGate(gate, workflow, sourceName ?? channel.from);
    const gateDataRepo = new GateDataRepository(this.config.db);
    const gateDataRecord = gateDataRepo.get(runId, gate.id);
    const runtimeData = gateDataRecord?.data ?? computeGateDefaults(gate.fields ?? []);
    const run = this.config.workflowRunRepo.getRun(runId);
    const space = await this.config.spaceManager.getSpace(workflow.spaceId);
    const result = await evaluateGate(gate, runtimeData, executeGateScript, {
      workspacePath: space?.workspacePath ?? process.cwd(),
      gateId: gate.id,
      runId,
      gateData: runtimeData,
      workflowStartIso: run ? new Date(run.createdAt).toISOString() : undefined,
      gateDataUpdatedIso: gateDataRecord
        ? new Date(gateDataRecord.updatedAt).toISOString()
        : undefined,
      prUrl: this.resolvePrUrlForRun(runId) || undefined,
    });
    return { open: result.open, reason: result.reason };
  }

  private enqueueRestartRecoveryMessage(
    run: SpaceWorkflowRun,
    lastAgentName: string,
    targetNode: SpaceWorkflow['nodes'][number],
    resetExistingTarget: boolean
  ): void {
    const repo = this.config.pendingMessageRepo;
    if (!repo) return;
    const tasks = this.config.taskRepo.listByWorkflowRun(run.id);
    const task = this.pickCanonicalTaskForRun(run, tasks);
    const message = resetExistingTarget
      ? `[Daemon restart recovery] The ${targetNode.name} node's previous session ended before completing the workflow. Please check the PR and review status, then continue.`
      : `[Daemon restart recovery] The previous agent (${lastAgentName}) completed but the handoff message was not delivered. Please check the PR and review status, then continue.`;
    for (const agentEntry of resolveNodeAgents(targetNode)) {
      repo.enqueue({
        workflowRunId: run.id,
        spaceId: run.spaceId,
        taskId: task?.id ?? null,
        sourceAgentName: lastAgentName,
        targetKind: 'node_agent',
        targetAgentName: agentEntry.name,
        message,
        idempotencyKey: `daemon-restart-recovery:${targetNode.id}:${agentEntry.name}`,
      });
    }
  }

  // -------------------------------------------------------------------------
  // Private — tick helpers
  // -------------------------------------------------------------------------

  /**
   * For each active executor, processes the current node's tasks:
   * - Detects blocked and timeout conditions
   * - Spawns Task Agent sessions for pending tasks
   * - Monitors agent liveness and resets dead agents
   *
   * Agents drive workflow progression themselves via send_message and
   * `task.reportedStatus`. This method never calls advance() directly.
   *
   * Errors from individual runs are caught and re-thrown after all runs have
   * been processed, so a single bad run cannot starve subsequent ones.
   */
  private async processCompletedTasks(): Promise<void> {
    let firstError: unknown = null;

    for (const [runId] of this.executors) {
      try {
        await this.processRunTick(runId);
      } catch (err) {
        // Capture first unexpected error; continue processing remaining runs.
        if (firstError === null) firstError = err;
      }
    }

    // Re-throw after all runs processed so callers see the error.
    if (firstError !== null) throw firstError;
  }

  /**
   * Process a single workflow run tick: re-read from DB, recreate executor
   * with fresh state, detect issues, and spawn/monitor Task Agent sessions.
   */
  private makeAgentStuckKey(runId: string, executionId: string): string {
    return `${runId}:${executionId}`;
  }

  private getAgentStuckState(runId: string, execution: NodeExecution): AgentStuckRecoveryState {
    const key = this.makeAgentStuckKey(runId, execution.id);
    const existing = this.agentStuckRecovery.get(key);
    if (existing) return existing;
    const created: AgentStuckRecoveryState = {
      nagCount: 0,
      restartCount: 0,
      lastAction: null,
      lastActionAt: null,
      lastObservedMessageId: null,
      lastObservedMessageAt: null,
      lastObservedProgressMessageId: null,
      lastObservedProgressMessageAt: null,
      lastRuntimeNagMessageId: null,
      lastSessionId: execution.agentSessionId,
      pendingRestartNotice: null,
    };
    this.agentStuckRecovery.set(key, created);
    return created;
  }

  private consumeAgentRestartNotice(runId: string, execution: NodeExecution): string | null {
    const state = this.agentStuckRecovery.get(this.makeAgentStuckKey(runId, execution.id));
    if (!state?.pendingRestartNotice) return null;
    const notice = state.pendingRestartNotice;
    state.pendingRestartNotice = null;
    return notice;
  }

  private clearAgentStuckState(runId: string, executionId: string): void {
    this.agentStuckRecovery.delete(this.makeAgentStuckKey(runId, executionId));
  }

  private clearAgentStuckStateForRun(runId: string): void {
    for (const key of this.agentStuckRecovery.keys()) {
      if (key.startsWith(runId + ':')) {
        this.agentStuckRecovery.delete(key);
      }
    }
    for (const key of this.nonTerminalIdleStates.keys()) {
      if (key.startsWith(runId + ':')) {
        this.nonTerminalIdleStates.delete(key);
      }
    }
  }

  private getAgentNoProgressThresholdMs(workflow: SpaceWorkflow, execution: NodeExecution): number {
    const configuredDefault =
      this.config.agentNoProgressThresholdMs ?? DEFAULT_AGENT_NO_PROGRESS_THRESHOLD_MS;
    const node = workflow.nodes.find((candidate) => candidate.id === execution.workflowNodeId);
    const slot = node?.agents?.find((agent) => agent.name === execution.agentName);
    const slotTimeoutMs = slot?.timeoutMs;
    if (typeof slotTimeoutMs === 'number' && slotTimeoutMs > 0) {
      return slotTimeoutMs;
    }
    return configuredDefault;
  }

  private buildRuntimeNagMessage(
    runId: string,
    execution: NodeExecution,
    lastMessageAt: number,
    reason: string
  ): string {
    return [
      '[Runtime recovery notice]',
      '',
      `No observable progress has been recorded for workflow run ${runId}, node ${execution.workflowNodeId}, agent ${execution.agentName} since ${new Date(lastMessageAt).toISOString()}.`,
      `The last SDK message is non-terminal: ${reason}.`,
      '',
      'Please continue your assigned work from the current state. If work is complete, report completion through the workflow tools. If you are blocked, report the blocker clearly through the available tools. Do not wait silently.',
    ].join('\n');
  }

  private buildNonTerminalIdleNudgeMessage(): string {
    return 'Runtime noticed no recent progress. Continue current work, or report a blocker.';
  }

  private buildRuntimeRestartNotice(execution: NodeExecution): string {
    return [
      '[Runtime session recovery]',
      '',
      `Your previous agent session for node ${execution.workflowNodeId}, agent ${execution.agentName}, stopped making observable progress and was restarted by the runtime.`,
      'Continue the same task from the current repository and workflow state. Inspect task/workflow status, recent messages, git state, PR state, and artifacts as needed before acting. Do not start from scratch blindly.',
      'If you are blocked, report the blocker clearly through the available workflow tools.',
    ].join('\n');
  }

  private async handleAliveStuckExecutions(
    runId: string,
    spaceId: string,
    canonicalTask: SpaceTask,
    nodeExecutions: NodeExecution[],
    tam: TaskAgentManager,
    workflow: SpaceWorkflow
  ): Promise<'none' | 'restarted' | 'blocked'> {
    const nagGraceMs = this.config.agentStuckNagGraceMs ?? DEFAULT_AGENT_STUCK_NAG_GRACE_MS;
    const now = Date.now();
    for (const execution of nodeExecutions) {
      if (execution.status !== 'in_progress' || !execution.agentSessionId) {
        if (execution.status !== 'pending') {
          this.clearAgentStuckState(runId, execution.id);
        }
        continue;
      }

      if (!tam.isSessionAlive(execution.agentSessionId)) continue;
      const session = tam.getAgentSessionById?.(execution.agentSessionId);
      const processingState = session?.getProcessingState();
      if (processingState?.status === 'waiting_for_input') continue;

      // Skip nag when task is awaiting human approval — the agent has already
      // submitted its work and is intentionally idle pending review.
      if (canonicalTask.pendingCheckpointType === 'task_completion') continue;
      // Skip nag when the execution already has a result and the task is in a
      // review/approved state — the node agent reported completion and is waiting
      // for the workflow to advance through the approval gate.
      if (
        execution.result &&
        (canonicalTask.status === 'review' || canonicalTask.status === 'approved')
      )
        continue;

      const lastMessage = this.getSdkMessageRepo().getLastSDKMessage(execution.agentSessionId);
      const classification = classifyLastMessageForIdleAgent(lastMessage);
      const state = this.getAgentStuckState(runId, execution);
      const isRuntimeNagMessage =
        lastMessage?.type === 'user' && lastMessage.dbId === state.lastRuntimeNagMessageId;
      const progressMessage = lastMessage && !isRuntimeNagMessage ? lastMessage : null;
      const observedAt =
        progressMessage?.timestamp ?? execution.startedAt ?? state.lastActionAt ?? now;
      const thresholdMs = this.getAgentNoProgressThresholdMs(workflow, execution);

      if (state.lastSessionId !== execution.agentSessionId) {
        state.lastSessionId = execution.agentSessionId;
        state.lastObservedMessageId = lastMessage?.dbId ?? null;
        state.lastObservedMessageAt = lastMessage?.timestamp ?? null;
        state.lastObservedProgressMessageId = progressMessage?.dbId ?? null;
        state.lastObservedProgressMessageAt = progressMessage?.timestamp ?? null;
        state.lastRuntimeNagMessageId = null;
        state.lastAction = null;
        state.lastActionAt = null;
        state.nagCount = 0;
        state.restartCount = 0;
        state.pendingRestartNotice = null;
      } else if (state.lastObservedMessageId !== (lastMessage?.dbId ?? null)) {
        state.lastObservedMessageId = lastMessage?.dbId ?? null;
        state.lastObservedMessageAt = lastMessage?.timestamp ?? null;
        if (progressMessage && state.lastObservedProgressMessageId !== progressMessage.dbId) {
          state.lastObservedProgressMessageId = progressMessage.dbId;
          state.lastObservedProgressMessageAt = progressMessage.timestamp;
          state.lastAction = null;
          state.lastActionAt = null;
          state.nagCount = 0;
          state.restartCount = 0;
          state.pendingRestartNotice = null;
        }
      }

      if (classification.terminal) {
        this.clearAgentStuckState(runId, execution.id);
        continue;
      }

      if (this.toolContinuationRepo.hasActiveToolUseForExecution(execution.id)) {
        continue;
      }

      if (now - observedAt <= thresholdMs) continue;

      if (state.nagCount < MAX_AGENT_STUCK_NAGS) {
        const nagMessageId = await tam.injectRuntimeRecoveryMessage(
          execution.agentSessionId,
          this.buildRuntimeNagMessage(runId, execution, observedAt, classification.reason)
        );
        state.lastRuntimeNagMessageId = nagMessageId;
        state.nagCount += 1;
        state.lastAction = 'nag';
        state.lastActionAt = now;
        log.warn(
          `SpaceRuntime: sent runtime nag to stuck agent execution ${execution.id} ` +
            `(agent ${execution.agentName}, session ${execution.agentSessionId})`
        );
        continue;
      }

      if (state.lastAction === 'nag' && state.lastActionAt !== null) {
        const elapsedSinceNag = now - state.lastActionAt;
        if (elapsedSinceNag < nagGraceMs) {
          log.debug(
            `SpaceRuntime: delaying restart for stuck agent execution ${execution.id}; ` +
              `runtime nag grace has ${nagGraceMs - elapsedSinceNag}ms remaining`
          );
          continue;
        }
      }

      if (state.restartCount < MAX_AGENT_STUCK_RESTARTS) {
        await tam.restartStuckSubSession(execution.agentSessionId);
        state.restartCount += 1;
        state.lastAction = 'restart';
        state.lastActionAt = now;
        state.pendingRestartNotice = this.buildRuntimeRestartNotice(execution);
        this.config.nodeExecutionRepo.update(execution.id, {
          status: 'pending',
          agentSessionId: null,
          startedAt: null,
          completedAt: null,
          result: 'Runtime restarted agent session after no observable progress.',
        });
        log.warn(
          `SpaceRuntime: restarted stuck agent execution ${execution.id} ` +
            `(agent ${execution.agentName}, session ${execution.agentSessionId})`
        );
        return 'restarted';
      }

      const reason = `Agent stuck without observable progress after runtime nag/restart recovery: ${classification.reason}`;
      state.lastAction = 'blocked';
      state.lastActionAt = now;
      this.config.nodeExecutionRepo.update(execution.id, {
        status: 'blocked',
        result: reason,
      });
      await this.transitionRunStatusAndEmit(runId, 'blocked');
      await this.updateTaskAndEmit(spaceId, canonicalTask.id, {
        status: 'blocked',
        result: reason,
        blockReason: 'execution_failed',
        completedAt: null,
      });
      await this.safeNotify({
        kind: 'task_blocked',
        spaceId,
        taskId: canonicalTask.id,
        reason,
        timestamp: new Date(now).toISOString(),
      });
      await this.safeNotify({
        kind: 'workflow_run_blocked',
        spaceId,
        runId,
        reason,
        timestamp: new Date(now).toISOString(),
      });
      return 'blocked';
    }
    return 'none';
  }

  private resetWorkflowNodeExecutionForSpawnRetry(
    runId: string,
    execution: NodeExecution,
    reason: string,
    sessionId: string | null = execution.agentSessionId
  ): boolean {
    const crashKey = `${runId}:${execution.id}`;
    const crashCount = (this.taskCrashCounts.get(crashKey) ?? 0) + 1;
    this.taskCrashCounts.set(crashKey, crashCount);
    const exhausted = crashCount > MAX_TASK_AGENT_CRASH_RETRIES;
    if (exhausted) {
      log.warn(
        `SpaceRuntime: workflow node agent spawn/retry failed for execution ${execution.id} ` +
          `(session ${sessionId ?? 'none'}); marking blocked after ${crashCount} failures ` +
          `(limit: ${MAX_TASK_AGENT_CRASH_RETRIES}): ${reason}`
      );
      this.config.nodeExecutionRepo.update(execution.id, {
        startedAt: null,
        status: 'blocked',
        result: `Agent session failed to spawn or crashed ${crashCount} times consecutively: ${reason}`,
      });
      return true;
    }

    log.warn(
      `SpaceRuntime: workflow node agent spawn/retry failed for execution ${execution.id} ` +
        `(session ${sessionId ?? 'none'}); resetting execution to pending ` +
        `(failure ${crashCount}/${MAX_TASK_AGENT_CRASH_RETRIES}): ${reason}`
    );
    this.config.nodeExecutionRepo.update(execution.id, {
      startedAt: null,
      status: 'pending',
      result: null,
      completedAt: null,
    });
    return false;
  }

  private async processRunTick(runId: string): Promise<void> {
    // Always re-read run from DB to pick up external status changes (e.g. human
    // approval reset, external cancellation).
    const run = this.config.workflowRunRepo.getRun(runId);
    if (!run) return;
    if (run.status === 'cancelled' || run.status === 'done') {
      this.clearAgentStuckStateForRun(runId);
      return;
    }

    // Blocked run recovery: attempt bounded automatic retry before giving up.
    if (run.status === 'blocked') {
      await this.attemptBlockedRunRecovery(runId, run);
      return;
    }

    // In the agent-centric model, agents activate nodes themselves via activateNode().
    // The tick loop processes node_executions for the run while keeping exactly
    // one canonical task as the user-facing envelope.
    const meta = this.executorMeta.get(runId);
    if (!meta) return;

    // One run should have exactly one canonical task.
    const allRunTasks = this.config.taskRepo.listByWorkflowRun(runId);
    if (allRunTasks.length === 0) return;

    let canonicalTask = this.pickCanonicalTaskForRun(run, allRunTasks);
    if (!canonicalTask) return;
    if (allRunTasks.length > 1) {
      await this.archiveDuplicateRunTasks(
        meta.spaceId,
        run,
        canonicalTask,
        allRunTasks,
        'active_run'
      );
    }
    if (canonicalTask.workflowRunId !== runId) {
      const refreshed = await this.updateTaskAndEmit(meta.spaceId, canonicalTask.id, {
        workflowRunId: runId,
      });
      canonicalTask = refreshed ?? canonicalTask;
    }

    if (!meta.workflow.endNodeId) {
      await this.transitionRunStatusAndEmit(runId, 'blocked');
      if (canonicalTask.status !== 'blocked') {
        await this.updateTaskAndEmit(meta.spaceId, canonicalTask.id, {
          status: 'blocked',
          result: 'Workflow is missing endNodeId and cannot be executed safely.',
          blockReason: 'workflow_invalid',
          completedAt: null,
        });
      }
      await this.safeNotify({
        kind: 'workflow_run_blocked',
        spaceId: meta.spaceId,
        runId,
        reason: 'Workflow is missing endNodeId',
        timestamp: new Date().toISOString(),
      });
      return;
    }

    let nodeExecutions = this.config.nodeExecutionRepo.listByWorkflowRun(runId);
    if (nodeExecutions.length === 0) return;

    // Refresh dedup entries for this run's canonical task.
    if (canonicalTask.status !== 'blocked') {
      this.notifiedTaskSet.delete(`${canonicalTask.id}:blocked`);
    }
    if (canonicalTask.status !== 'in_progress') {
      this.notifiedTaskSet.delete(`${canonicalTask.id}:timeout`);
    }

    // ─── Completion bypass ───────────────────────────────────────────────
    // If the canonical task is either already terminal or the end-node agent
    // has reported a result, skip blocked/timeout notifications for sibling
    // nodes and proceed directly to completion handling. This prevents
    // spurious "task_blocked" notifications for sibling nodes that are still
    // running when the end node finishes first.
    //
    // Cached for reuse below at the completion-detection branch — neither
    // `task.status` nor `reportedStatus` changes between here and there.
    const endNodeId = meta.workflow.endNodeId;
    const runIsComplete = this.completionDetector.isComplete({ workflowRunId: runId });

    // Detect execution-level blocked BEFORE the all-completed guard.
    // When the run is already complete, skip blocked notifications for
    // siblings — the run will be completed imminently.
    if (!runIsComplete && nodeExecutions.some((execution) => execution.status === 'blocked')) {
      const blockedReason =
        nodeExecutions.find((execution) => execution.status === 'blocked')?.result ??
        'One or more workflow agents are blocked';
      const dedupKey = `${canonicalTask.id}:blocked`;
      if (!this.notifiedTaskSet.has(dedupKey)) {
        this.notifiedTaskSet.add(dedupKey);
        await this.safeNotify({
          kind: 'task_blocked',
          spaceId: meta.spaceId,
          taskId: canonicalTask.id,
          reason: blockedReason,
          timestamp: new Date().toISOString(),
        });
      }

      await this.transitionRunStatusAndEmit(runId, 'blocked');
      if (canonicalTask.status !== 'blocked') {
        await this.updateTaskAndEmit(meta.spaceId, canonicalTask.id, {
          status: 'blocked',
          result: blockedReason,
          blockReason: 'execution_failed',
          completedAt: null,
        });
      }
      await this.safeNotify({
        kind: 'workflow_run_blocked',
        spaceId: meta.spaceId,
        runId,
        reason: 'One or more tasks require attention',
        timestamp: new Date().toISOString(),
      });

      return;
    }

    // Timeout detection: check in_progress tasks against Space.config.taskTimeoutMs.
    // Skip when the run is already complete — it's about to finalize.
    const space = await this.config.spaceManager.getSpace(meta.spaceId);
    if (!runIsComplete) {
      const taskTimeoutMs = space?.config?.taskTimeoutMs;
      if (taskTimeoutMs !== undefined) {
        const now = Date.now();
        const timedOutExecutions = nodeExecutions.filter((execution) => {
          if (execution.status !== 'in_progress' || !execution.startedAt) return false;
          return now - execution.startedAt > taskTimeoutMs;
        });
        const dedupKey = `${canonicalTask.id}:timeout`;
        if (timedOutExecutions.length === 0) {
          this.notifiedTaskSet.delete(dedupKey);
        } else if (!this.notifiedTaskSet.has(dedupKey)) {
          const elapsedMs = Math.max(
            ...timedOutExecutions.map((execution) => now - (execution.startedAt ?? now))
          );
          this.notifiedTaskSet.add(dedupKey);
          await this.safeNotify({
            kind: 'task_timeout',
            spaceId: meta.spaceId,
            taskId: canonicalTask.id,
            elapsedMs,
            timestamp: new Date().toISOString(),
          });
        }
      }
    }

    // Workflow runs created directly via RPC stay pending until a per-space slot is
    // available. Existing in-progress canonical tasks continue even if the limit is
    // later lowered below the current running count.
    if (canonicalTask.status === 'open' && this.getAvailableTaskSlots(space) <= 0) return;

    // ─── Task Agent integration ───────────────────────────────────────────────
    // When a TaskAgentManager is configured, Task Agents drive the workflow.
    // SpaceRuntime's role here is lifecycle management only: spawn for pending
    // tasks, check liveness, and recover from crashes. Agents drive progression
    // themselves via send_message and `task.reportedStatus` — SpaceRuntime
    // never calls advance().
    if (this.config.taskAgentManager) {
      const tam = this.config.taskAgentManager;
      let blockedByCrash = false;

      // Snapshot which executions were already pending before this tick's
      // liveness processing. The repair loop below uses this
      // to avoid re-elevating executions that were just force-idled and
      // then reset to pending within the same tick.
      const preTickPendingIds = new Set(
        nodeExecutions.filter((e) => e.status === 'pending').map((e) => e.id)
      );

      // Step 1: Check workflow-node agent liveness by NodeExecution.sessionId.
      for (const execution of nodeExecutions) {
        if (
          !execution.agentSessionId ||
          (execution.status !== 'in_progress' && execution.status !== 'pending')
        ) {
          continue;
        }

        if (tam.isSessionAlive(execution.agentSessionId)) {
          continue;
        }

        // Part C (task #138): if the dead session was sitting in
        // `waiting_for_input`, the persisted AskUserQuestion card is now
        // unanswerable. Try to flip it to `cancelled` (cancelReason
        // `agent_session_terminated`) so the UI removes the dead-end
        // rather than rendering a permanently-frozen card. Best-effort:
        // the AgentSession instance may already be gone from every map.
        try {
          const liveSession = tam.getAgentSessionById(execution.agentSessionId);
          if (liveSession) {
            await liveSession.markPendingQuestionOrphaned('agent_session_terminated');
          }
        } catch (err) {
          log.warn(
            `SpaceRuntime: failed to clean up pending question for crashed session ${execution.agentSessionId}:`,
            err
          );
        }

        const exhausted = this.resetWorkflowNodeExecutionForSpawnRetry(
          runId,
          execution,
          'agent session is no longer alive',
          execution.agentSessionId
        );
        if (exhausted) {
          blockedByCrash = true;
          await this.safeNotify({
            kind: 'agent_crash',
            spaceId: meta.spaceId,
            taskId: canonicalTask.id,
            timestamp: new Date().toISOString(),
          });
        }
      }

      nodeExecutions = this.config.nodeExecutionRepo.listByWorkflowRun(runId);

      if (blockedByCrash) {
        await this.blockRunForAgentCrash(runId, meta.spaceId, canonicalTask, nodeExecutions);
        return;
      }

      const aliveStuckOutcome = await this.handleAliveStuckExecutions(
        runId,
        meta.spaceId,
        canonicalTask,
        nodeExecutions,
        tam,
        meta.workflow
      );
      if (aliveStuckOutcome === 'restarted' || aliveStuckOutcome === 'blocked') {
        return;
      }

      const stoppedAfterWaitingRebind = await this.handleWaitingRebindExecutions(
        runId,
        run,
        meta.spaceId,
        canonicalTask
      );
      if (stoppedAfterWaitingRebind) {
        return;
      }
      nodeExecutions = this.config.nodeExecutionRepo.listByWorkflowRun(runId);

      const nonTerminalIdleOutcome = await this.handleNonTerminalIdleExecutions(
        runId,
        meta.spaceId,
        canonicalTask,
        meta.workflow,
        tam,
        space ?? null
      );
      if (nonTerminalIdleOutcome === 'blocked') {
        return;
      }
      nodeExecutions = this.config.nodeExecutionRepo.listByWorkflowRun(runId);

      if (
        canonicalTask.status === 'done' ||
        canonicalTask.status === 'cancelled' ||
        canonicalTask.status === 'archived'
      ) {
        const stoppedAfterTerminalHandoffCleanup = await this.repairQueuedWorkflowNodeHandoffs(
          runId,
          run,
          meta,
          canonicalTask,
          space ?? null
        );
        if (stoppedAfterTerminalHandoffCleanup) {
          return;
        }
      }

      // Step 1.6: Completion detection.
      //
      // Reuses the `runIsComplete` snapshot from above — neither `task.status`
      // nor `reportedStatus` is mutated between the two checks (the recovery
      // branches that could change them all `return` before reaching here).
      //
      // In the reported-but-not-yet-resolved case, dispatch through the
      // PostApprovalRouter (PR 2/5). The router handles the terminal
      // transition — `approved`→(inline/spawn/already-routed) or directly
      // to `done` when no route is defined. End-node agents signal
      // completion by setting `task.reportedStatus`, not by calling
      // `setTaskStatus` directly.
      if (runIsComplete) {
        await this.transitionRunStatusAndEmit(runId, 'done');
        const summaryFromArtifact = this.resolvePrimaryResultArtifactSummary(runId);
        const summary = this.resolveCompletionSummary(runId, meta.workflow);
        const reportedSummary = normalizeMeaningfulTaskResult(canonicalTask.reportedSummary);
        const existingResult = normalizeMeaningfulTaskResult(canonicalTask.result);
        const freshSummary = summaryFromArtifact ?? summary ?? null;
        const nextTaskResult = freshSummary ?? existingResult ?? reportedSummary ?? null;
        const nextReportedSummary = freshSummary ?? reportedSummary ?? null;

        // Skip re-resolution when the task is already at a non-`open`/non-`in_progress`
        // status — `done`/`cancelled` are terminal; `approved` means
        // PostApprovalRouter already ran once. `review` can only occur via
        // gate-type checkpoints now that completion actions are removed.
        // `blocked` is also skipped: a task that was cascade-blocked by a
        // failed dependency can't be transitioned `blocked → approved`
        // (invalid transition), so we leave it for manual retry.
        const taskAlreadyResolved =
          canonicalTask.status === 'done' ||
          canonicalTask.status === 'review' ||
          canonicalTask.status === 'cancelled' ||
          canonicalTask.status === 'approved' ||
          canonicalTask.status === 'blocked';

        // Final status drives sibling cancellation. We only kill siblings when
        // the task reached a true terminal state (`done`/`cancelled`).
        let finalTaskStatus: SpaceTask['status'] = canonicalTask.status;

        if (!taskAlreadyResolved) {
          const updates = this.buildTaskOutcomeUpdates(
            canonicalTask,
            nextTaskResult,
            nextReportedSummary
          );
          if (updates) {
            await this.updateTaskAndEmit(meta.spaceId, canonicalTask.id, updates);
          }
          const result = await this.dispatchPostApproval(canonicalTask.id, 'agent');
          // Resolve the final status from the router result. 'no-route'
          // moved directly to done; 'inline' / 'spawn' / 'already-routed'
          // parked at approved awaiting mark_complete.
          finalTaskStatus =
            result.mode === 'no-route'
              ? 'done'
              : result.mode === 'skipped'
                ? canonicalTask.status
                : 'approved';
        } else {
          const updates = this.buildTaskOutcomeUpdates(
            canonicalTask,
            nextTaskResult,
            nextReportedSummary
          );
          if (updates) {
            await this.updateTaskAndEmit(meta.spaceId, canonicalTask.id, updates);
          }
        }

        // Sibling NodeExecution quiescing: interrupt siblings still in_progress
        // when the canonical task reaches a terminal status, transitioning them
        // to `idle` so they remain reachable via send_message. The end-node
        // execution itself is excluded so its session can finish writing back
        // to the agent (it set `task.reportedStatus`, which triggered this
        // completion path). Skipped when the task is paused at `review` —
        // the human may yet reject the completion, in which case sibling
        // progress is still relevant.
        //
        // Sessions are deliberately NOT deleted here — they are only destroyed
        // when the task transitions to `archived` (the true non-recoverable
        // terminal state). This allows post-completion cross-node messaging,
        // e.g. a reviewer sending follow-up feedback to a coder whose node
        // already finished while the PR is still being merged.
        //
        // `blocked` is included alongside `done`/`cancelled` because the run
        // itself has just been transitioned to `done` (above), so leaving
        // siblings in `in_progress` would create inconsistent run/execution
        // lifecycle state. `approved` is included for the same reason — the
        // task has crossed the post-approval boundary; only `review` keeps
        // siblings live because the human may still reject the completion.
        const taskTerminal =
          finalTaskStatus === 'done' ||
          finalTaskStatus === 'cancelled' ||
          finalTaskStatus === 'blocked' ||
          finalTaskStatus === 'approved';
        if (taskTerminal) {
          const sourceNodeId = canonicalTask.pendingCompletionSubmittedByNodeId ?? endNodeId;
          const siblingsToQuiesce = this.config.nodeExecutionRepo
            .listByWorkflowRun(runId)
            .filter(
              (e) =>
                e.status === 'in_progress' &&
                e.agentSessionId &&
                (!sourceNodeId || e.workflowNodeId !== sourceNodeId)
            );
          for (const sibling of siblingsToQuiesce) {
            this.config.nodeExecutionRepo.updateStatus(sibling.id, 'idle');
            if (this.config.taskAgentManager) {
              void this.config.taskAgentManager
                .interruptBySessionId(sibling.agentSessionId!)
                .catch((err) => {
                  log.warn(
                    `SpaceRuntime: failed to interrupt sibling session ${sibling.agentSessionId}:`,
                    err
                  );
                });
            }
            log.info(
              `SpaceRuntime: quiesced sibling node execution ${sibling.id} ` +
                `(node ${sibling.workflowNodeId}, agent ${sibling.agentName}) ` +
                `to idle for completed run ${runId}; session kept alive for post-completion messaging`
            );
          }
        }

        return;
      }

      // Step 2: Spawn workflow node agents for pending executions without sessions.
      // Skip spawning for paused or stopped spaces — completion/timeout/crash detection above
      // still runs so in-flight agents are monitored, but no new agents are started.
      if (space?.paused || space?.stopped) return;

      const hasQueuedNodeHandoff =
        this.config.pendingMessageRepo
          ?.listPendingForRun(runId)
          .some((row) => row.targetKind === 'node_agent') ?? false;
      if (!space && !hasQueuedNodeHandoff) return;

      const stoppedAfterQueuedHandoffRepair = await this.repairQueuedWorkflowNodeHandoffs(
        runId,
        run,
        meta,
        canonicalTask,
        space ?? null
      );
      if (stoppedAfterQueuedHandoffRepair) {
        return;
      }

      nodeExecutions = this.config.nodeExecutionRepo.listByWorkflowRun(runId);
      for (const execution of nodeExecutions) {
        if (execution.status !== 'pending') continue;
        if (!execution.agentSessionId) continue;
        if (!preTickPendingIds.has(execution.id)) continue;
        if (tam.isSessionAlive(execution.agentSessionId)) {
          log.warn(
            `SpaceRuntime: repaired pending execution ${execution.id} with live session ${execution.agentSessionId}`
          );
          this.config.nodeExecutionRepo.update(execution.id, {
            status: 'in_progress',
            agentSessionId: execution.agentSessionId,
            startedAt: execution.startedAt ?? Date.now(),
            completedAt: null,
          });
        }
        // Dead session on a pending execution: spawn will overwrite the
      }
      nodeExecutions = this.config.nodeExecutionRepo.listByWorkflowRun(runId);
      const pendingExecutions = nodeExecutions.filter(
        (execution) => execution.status === 'pending'
      );

      // Skip spawning when the canonical task is terminal (done/cancelled/archived).
      // The task was externally resolved while the run was in_progress — spawning new
      // agent sub-sessions would conflict with the caller's intent and disturb tests
      // that mark the task done to prevent agent interference.
      const canonicalTaskIsTerminal =
        canonicalTask.status === 'done' ||
        canonicalTask.status === 'cancelled' ||
        canonicalTask.status === 'archived';

      if (pendingExecutions.length > 0 && canonicalTaskIsTerminal) {
        log.info(
          `SpaceRuntime: skipping agent spawn for run ${runId} — canonical task ${canonicalTask.id} is terminal (${canonicalTask.status})`
        );
      } else if (pendingExecutions.length > 0) {
        if (!space) {
          log.warn(
            `SpaceRuntime: cannot spawn workflow node agents for run ${runId} — space ${meta.spaceId} not found`
          );
        } else {
          let permanentSpawnFailureReason: string | null = null;
          for (const execution of pendingExecutions) {
            if (tam.isExecutionSpawning(execution.id)) continue;
            try {
              const sessionId = await tam.spawnWorkflowNodeAgentForExecution(
                canonicalTask,
                space,
                meta.workflow,
                run,
                execution,
                {
                  kickoff: true,
                }
              );
              this.flushPendingNodeQueue({
                workflowRunId: runId,
                taskId: canonicalTask.id,
                nodeId: execution.workflowNodeId,
                agentName: execution.agentName,
                sessionId,
              });
              const restartNotice = this.consumeAgentRestartNotice(runId, execution);
              if (restartNotice) {
                void tam.injectRuntimeRecoveryMessage(sessionId, restartNotice).catch((err) => {
                  log.warn(
                    `SpaceRuntime: failed to deliver restart recovery notice to session ${sessionId}: ${err instanceof Error ? err.message : String(err)}`
                  );
                });
              }
            } catch (err) {
              if (this.cancelExecutionForPermanentSpawnError(execution, err)) {
                permanentSpawnFailureReason = err instanceof Error ? err.message : String(err);
                continue;
              }
              const stale = this.config.nodeExecutionRepo.getById(execution.id) ?? execution;
              if (
                stale.status === 'cancelled' ||
                stale.status === 'blocked' ||
                stale.status === 'idle'
              ) {
                log.warn(
                  `SpaceRuntime: preserving terminal execution ${execution.id} (${stale.status}) after spawn failure: ${err instanceof Error ? err.message : String(err)}`
                );
                continue;
              }
              if (stale.agentSessionId) {
                tam.cancelBySessionId(stale.agentSessionId);
              }
              if (
                this.resetWorkflowNodeExecutionForSpawnRetry(
                  runId,
                  stale,
                  err instanceof Error ? err.message : String(err),
                  stale.agentSessionId
                )
              ) {
                blockedByCrash = true;
              }
              log.warn(
                `SpaceRuntime: transient spawn failure for workflow node execution ${execution.id}: ${err instanceof Error ? err.message : String(err)}`
              );
            }
          }
          if (permanentSpawnFailureReason) {
            const refreshedExecutions = this.config.nodeExecutionRepo.listByWorkflowRun(runId);
            const hasDriveableExecution = refreshedExecutions.some(
              (execution) =>
                execution.status === 'pending' ||
                execution.status === 'in_progress' ||
                execution.status === 'waiting_rebind' ||
                execution.status === 'blocked'
            );
            if (!hasDriveableExecution) {
              await this.blockRunForPermanentSpawnFailure(
                runId,
                meta.spaceId,
                canonicalTask,
                permanentSpawnFailureReason
              );
              return;
            }
          }
          if (blockedByCrash) {
            nodeExecutions = this.config.nodeExecutionRepo.listByWorkflowRun(runId);
            await this.blockRunForAgentCrash(runId, meta.spaceId, canonicalTask, nodeExecutions);
            return;
          }
          if (
            canonicalTask.status === 'open' ||
            (canonicalTask.status === 'review' && canonicalTask.pendingCheckpointType === 'gate')
          ) {
            const nowTs = Date.now();
            await this.updateTaskAndEmit(meta.spaceId, canonicalTask.id, {
              status: 'in_progress',
              startedAt: canonicalTask.startedAt ?? nowTs,
              completedAt: null,
              pendingCheckpointType: null,
            });
          }
        }
      }

      // Agents drive workflow progression via send_message and
      // `task.reportedStatus`.
      return;
    }
  }

  private async blockRunForPermanentSpawnFailure(
    runId: string,
    spaceId: string,
    canonicalTask: SpaceTask,
    reason: string
  ): Promise<void> {
    await this.transitionRunStatusAndEmit(runId, 'blocked');
    await this.updateTaskAndEmit(spaceId, canonicalTask.id, {
      status: 'blocked',
      result: reason,
      blockReason: 'workflow_invalid',
      completedAt: null,
    });
    await this.safeNotify({
      kind: 'workflow_run_blocked',
      spaceId,
      runId,
      reason,
      timestamp: new Date().toISOString(),
    });
  }

  private cancelExecutionForPermanentSpawnError(execution: NodeExecution, err: unknown): boolean {
    if (!isPermanentSpawnError(err)) return false;
    const run = this.config.workflowRunRepo.getRun(execution.workflowRunId);
    const task = run
      ? this.pickCanonicalTaskForRun(
          run,
          this.config.taskRepo.listByWorkflowRun(execution.workflowRunId)
        )
      : null;
    if (task) {
      this.unregisterExecution(
        execution.workflowRunId,
        task.id,
        execution.workflowNodeId,
        execution.agentName
      );
    }
    this.config.nodeExecutionRepo.update(execution.id, {
      status: 'cancelled',
      result: err.message,
      completedAt: Date.now(),
    });
    log.warn(
      `SpaceRuntime: cancelled workflow node execution ${execution.id} after permanent spawn failure: ${err.message}`
    );
    return true;
  }

  private async repairQueuedWorkflowNodeHandoffs(
    runId: string,
    run: SpaceWorkflowRun,
    meta: ExecutorMeta,
    canonicalTask: SpaceTask,
    space: Space | null
  ): Promise<boolean> {
    const repo = this.config.pendingMessageRepo;
    const tam = this.config.taskAgentManager;
    if (!repo || !tam) return false;

    repo.expireStale(runId);
    const pending = repo.listPendingForRun(runId).filter((row) => row.targetKind === 'node_agent');
    const isTerminalTask =
      canonicalTask.status === 'done' ||
      canonicalTask.status === 'cancelled' ||
      canonicalTask.status === 'archived';

    if (isTerminalTask) {
      const expiredNodeHandoffs = repo
        .listByRunAndStatus(runId, 'expired')
        .filter((row) => row.targetKind === 'node_agent');
      const reason = `Queued workflow handoff cannot be delivered because task ${canonicalTask.id} is terminal (${canonicalTask.status})`;
      for (const row of pending) repo.markFailed(row.id, reason);
      if (pending.length > 0 || expiredNodeHandoffs.length > 0) {
        log.warn(
          `SpaceRuntime: ignored ${pending.length + expiredNodeHandoffs.length} queued handoff(s) for terminal task: ${reason}`
        );
      }
      return false;
    }

    const expiredNodeHandoffs = repo
      .listByRunAndStatus(runId, 'expired')
      .filter((row) => row.targetKind === 'node_agent');
    if (expiredNodeHandoffs.length > 0) {
      const first = expiredNodeHandoffs[0];
      const reason = `Queued workflow handoff to ${first.targetAgentName} expired before delivery after ${first.attempts} attempt(s)`;
      await this.blockRunForQueuedHandoffFailure(runId, meta.spaceId, canonicalTask, reason);
      return true;
    }

    if (pending.length === 0) return false;

    if (!space) {
      let blockedReason: string | null = null;
      const reason = `Cannot activate queued handoff target: space ${meta.spaceId} not found`;
      for (const row of pending) {
        const updated = repo.markAttemptFailed(row.id, reason);
        if (updated?.status === 'failed') {
          blockedReason = `Queued workflow handoff to ${updated.targetAgentName} failed after ${updated.attempts} attempt(s): ${reason}`;
        }
      }
      if (blockedReason) {
        await this.blockRunForQueuedHandoffFailure(
          runId,
          meta.spaceId,
          canonicalTask,
          blockedReason
        );
        return true;
      }
      return false;
    }

    let blockedReason: string | null = null;
    const targets = [...new Set(pending.map((row) => row.targetAgentName))];
    const recordBlockedFlushFailure = (
      targetAgentName: string,
      rowsForCurrentAttempt: typeof pending
    ): void => {
      const first = rowsForCurrentAttempt
        .map((row) => repo.getById(row.id))
        .find((row) => row?.status === 'failed');
      if (!first) return;
      blockedReason = `Queued workflow handoff to ${targetAgentName} failed after ${first.attempts} attempt(s): ${first.lastError ?? 'delivery failed'}`;
    };

    for (const targetAgentName of targets) {
      const rowsForTarget = pending.filter((row) => row.targetAgentName === targetAgentName);
      try {
        let execution = this.resolveQueuedHandoffExecution(runId, meta.workflow, targetAgentName);

        if (!execution) {
          const resolved = this.resolveQueuedHandoffTarget(meta.workflow, targetAgentName);
          if (!resolved) {
            throw new Error(
              `Queued workflow handoff target "${targetAgentName}" is not declared in workflow "${meta.workflow.id}"`
            );
          }
          execution = this.createNodeExecutionOrIgnore({
            workflowRunId: runId,
            workflowNodeId: resolved.nodeId,
            agentName: resolved.agentName,
            agentId: resolved.agentId,
            status: 'pending',
          });
        }

        if (execution.status === 'waiting_rebind') {
          continue;
        }

        await tam.tryResumeNodeAgentSession(runId, execution.agentName);
        execution = this.config.nodeExecutionRepo.getById(execution.id) ?? execution;
        if (execution.status === 'waiting_rebind') {
          continue;
        }

        if (execution.agentSessionId && tam.isSessionAlive(execution.agentSessionId)) {
          await tam.flushPendingMessagesForTarget(
            runId,
            execution.agentName,
            execution.agentSessionId
          );
          recordBlockedFlushFailure(targetAgentName, rowsForTarget);
          continue;
        }

        if (execution.agentSessionId && !tam.isSessionAlive(execution.agentSessionId)) {
          this.resetWorkflowNodeExecutionForSpawnRetry(
            runId,
            execution,
            'queued handoff execution referenced a dead session before spawn',
            execution.agentSessionId
          );
          execution = this.config.nodeExecutionRepo.getById(execution.id) ?? execution;
          if (execution.status === 'blocked') {
            blockedReason = execution.result ?? 'Queued workflow handoff target failed to spawn';
            continue;
          }
        }

        if (execution.status === 'blocked') {
          this.config.nodeExecutionRepo.update(execution.id, {
            status: 'pending',
            result: null,
            completedAt: null,
          });
          execution = this.config.nodeExecutionRepo.getById(execution.id) ?? execution;
        }

        if (tam.isExecutionSpawning(execution.id)) {
          continue;
        }

        const sessionId = await tam.spawnWorkflowNodeAgentForExecution(
          canonicalTask,
          space,
          meta.workflow,
          run,
          execution,
          { kickoff: true }
        );
        this.flushPendingNodeQueue({
          workflowRunId: runId,
          taskId: canonicalTask.id,
          nodeId: execution.workflowNodeId,
          agentName: execution.agentName,
          sessionId,
        });
        await tam.flushPendingMessagesForTarget(runId, execution.agentName, sessionId);
        recordBlockedFlushFailure(targetAgentName, rowsForTarget);
      } catch (err) {
        const errMsg = err instanceof Error ? err.message : String(err);
        if (isPermanentSpawnError(err)) {
          log.warn(
            `SpaceRuntime: queued workflow handoff target ${targetAgentName} has permanent spawn failure: ${errMsg}`
          );
        } else {
          log.warn(
            `SpaceRuntime: queued workflow handoff repair failed for target ${targetAgentName}: ${errMsg}`
          );
        }
        const maybeExecution = this.resolveQueuedHandoffExecution(
          runId,
          meta.workflow,
          targetAgentName
        );
        if (maybeExecution) this.cancelExecutionForPermanentSpawnError(maybeExecution, err);
        for (const row of rowsForTarget) {
          const updated = repo.markAttemptFailed(row.id, errMsg);
          if (updated?.status === 'failed') {
            blockedReason = `Queued workflow handoff to ${targetAgentName} failed after ${updated.attempts} attempt(s): ${errMsg}`;
          }
        }
      }
    }

    if (blockedReason) {
      await this.blockRunForQueuedHandoffFailure(runId, meta.spaceId, canonicalTask, blockedReason);
      return true;
    }

    return false;
  }

  private resolveQueuedHandoffExecution(
    runId: string,
    workflow: SpaceWorkflow,
    targetAgentName: string
  ): NodeExecution | undefined {
    const resolved = this.resolveQueuedHandoffTarget(workflow, targetAgentName);
    if (resolved) {
      const nodeExecution = this.config.nodeExecutionRepo
        .listByNode(runId, resolved.nodeId)
        .filter((candidate) => candidate.agentName === resolved.agentName)
        .at(-1);
      if (nodeExecution) return nodeExecution;
    }

    return this.config.nodeExecutionRepo
      .listByWorkflowRun(runId)
      .filter((candidate) => candidate.agentName === targetAgentName)
      .at(-1);
  }

  private resolveQueuedHandoffTarget(
    workflow: SpaceWorkflow,
    targetAgentName: string
  ): { nodeId: string; agentName: string; agentId: string | null } | null {
    for (const node of workflow.nodes) {
      const slots = resolveNodeAgents(node);
      const nodeNameMatch = node.name === targetAgentName || node.id === targetAgentName;
      const direct = slots.find(
        (slot) => slot.name === targetAgentName || (nodeNameMatch && slot.name === node.name)
      );
      if (direct)
        return { nodeId: node.id, agentName: direct.name, agentId: direct.agentId ?? null };
      if (nodeNameMatch && slots[0]) {
        return { nodeId: node.id, agentName: slots[0].name, agentId: slots[0].agentId ?? null };
      }
      if (nodeNameMatch) {
        return { nodeId: node.id, agentName: targetAgentName, agentId: null };
      }
    }
    return null;
  }

  private async blockRunForAgentCrash(
    runId: string,
    spaceId: string,
    canonicalTask: SpaceTask,
    nodeExecutions: NodeExecution[]
  ): Promise<void> {
    const blockedReason =
      nodeExecutions.find((execution) => execution.status === 'blocked')?.result ??
      'One or more workflow agents are blocked';
    const dedupKey = `${canonicalTask.id}:blocked`;
    if (!this.notifiedTaskSet.has(dedupKey)) {
      this.notifiedTaskSet.add(dedupKey);
      await this.safeNotify({
        kind: 'task_blocked',
        spaceId,
        taskId: canonicalTask.id,
        reason: blockedReason,
        timestamp: new Date().toISOString(),
      });
    }
    await this.transitionRunStatusAndEmit(runId, 'blocked');
    if (canonicalTask.status !== 'blocked') {
      await this.updateTaskAndEmit(spaceId, canonicalTask.id, {
        status: 'blocked',
        result: blockedReason,
        blockReason: 'agent_crashed',
        completedAt: null,
      });
    }
    await this.safeNotify({
      kind: 'workflow_run_blocked',
      spaceId,
      runId,
      reason: 'One or more tasks require attention',
      timestamp: new Date().toISOString(),
    });
  }

  private async blockRunForQueuedHandoffFailure(
    runId: string,
    spaceId: string,
    canonicalTask: SpaceTask,
    reason: string
  ): Promise<void> {
    await this.transitionRunStatusAndEmit(runId, 'blocked');
    await this.updateTaskAndEmit(spaceId, canonicalTask.id, {
      status: 'blocked',
      result: reason,
      blockReason: 'execution_failed',
      completedAt: null,
    });
    await this.safeNotify({
      kind: 'workflow_run_blocked',
      spaceId,
      runId,
      reason,
      timestamp: new Date().toISOString(),
    });
  }

  private async handleNonTerminalIdleExecutions(
    runId: string,
    spaceId: string,
    canonicalTask: SpaceTask,
    workflow?: SpaceWorkflow,
    tam?: TaskAgentManager,
    space?: Space | null
  ): Promise<'none' | 'retried' | 'blocked' | 'preserved'> {
    if (space?.paused || space?.stopped) return 'none';

    // Explicit task completion or pause signals are authoritative. A final tool
    // call may have set reportedStatus or parked the task for human/post-approval
    // review even if the SDK result row has not been persisted yet.
    if (
      canonicalTask.reportedStatus !== null ||
      canonicalTask.status === 'review' ||
      canonicalTask.status === 'approved' ||
      canonicalTask.status === 'done' ||
      canonicalTask.status === 'cancelled' ||
      canonicalTask.status === 'archived'
    ) {
      return 'none';
    }

    let preservedAny = false;
    const idleExecutions = this.config.nodeExecutionRepo
      .listByWorkflowRun(runId)
      .filter((execution) => execution.status === 'idle' && !!execution.agentSessionId);
    for (const execution of idleExecutions) {
      const sessionId = execution.agentSessionId;
      if (!sessionId) continue;
      const lastMessage = this.getSdkMessageRepo().getLastSDKMessage(sessionId);
      const classification = classifyLastMessageForIdleAgent(lastMessage);
      const key = `${runId}:${execution.id}`;
      if (classification.terminal) {
        this.nonTerminalIdleStates.delete(key);
        continue;
      }

      preservedAny = true;
      const state = this.nonTerminalIdleStates.get(key) ?? {
        lastSessionId: sessionId,
        lastObservedMessageId: null,
        lastObservedProgressMessageId: null,
        lastObservedProgressMessageAt: null,
        lastRuntimeNudgeMessageId: null,
        nudgeCount: 0,
        failedNudgeCount: 0,
        lastNudgeAt: null,
        lastAttentionLogAt: null,
      };
      this.nonTerminalIdleStates.set(key, state);

      const isRuntimeNudgeMessage =
        lastMessage?.type === 'user' && lastMessage.dbId === state.lastRuntimeNudgeMessageId;
      const progressMessage = lastMessage && !isRuntimeNudgeMessage ? lastMessage : null;
      if (state.lastSessionId !== sessionId) {
        state.lastSessionId = sessionId;
        state.lastObservedMessageId = lastMessage?.dbId ?? null;
        state.lastObservedProgressMessageId = progressMessage?.dbId ?? null;
        state.lastObservedProgressMessageAt = progressMessage?.timestamp ?? null;
        state.lastRuntimeNudgeMessageId = null;
        state.nudgeCount = 0;
        state.failedNudgeCount = 0;
        state.lastNudgeAt = null;
        state.lastAttentionLogAt = null;
      } else if (state.lastObservedMessageId !== (lastMessage?.dbId ?? null)) {
        state.lastObservedMessageId = lastMessage?.dbId ?? null;
        if (progressMessage && state.lastObservedProgressMessageId !== progressMessage.dbId) {
          state.lastObservedProgressMessageId = progressMessage.dbId;
          state.lastObservedProgressMessageAt = progressMessage.timestamp;
          state.lastRuntimeNudgeMessageId = null;
          state.nudgeCount = 0;
          state.lastNudgeAt = null;
        }
      }

      const observedAt =
        state.lastObservedProgressMessageAt ??
        progressMessage?.timestamp ??
        execution.startedAt ??
        Date.now();
      const thresholdMs = workflow
        ? this.getAgentNoProgressThresholdMs(workflow, execution)
        : (this.config.agentNoProgressThresholdMs ?? DEFAULT_AGENT_NO_PROGRESS_THRESHOLD_MS);
      const now = Date.now();
      const reason = `Agent went idle without completing — non-terminal last message (${classification.reason})`;
      if (now - observedAt <= thresholdMs) {
        log.debug(
          `Node ${execution.workflowNodeId} is idle with non-terminal last message but within threshold; preserving idle session: ` +
            `execution=${execution.id} agent=${execution.agentName} session=${sessionId} reason=${classification.reason}`
        );
        continue;
      }
      if (this.toolContinuationRepo.hasActiveToolUseForExecution(execution.id)) {
        log.debug(
          `Node ${execution.workflowNodeId} is idle with non-terminal last message but has active tool use; preserving idle session: ` +
            `execution=${execution.id} agent=${execution.agentName} session=${sessionId}`
        );
        continue;
      }
      if (this.toolContinuationRepo.listPendingInboxForExecution(execution.id).length > 0) {
        log.debug(
          `Node ${execution.workflowNodeId} is idle with non-terminal last message but has pending tool continuation; preserving idle session: ` +
            `execution=${execution.id} agent=${execution.agentName} session=${sessionId}`
        );
        continue;
      }
      if (state.nudgeCount > 0) {
        if (state.failedNudgeCount > 0 && state.lastNudgeAt !== null) {
          const retryAfter = state.lastNudgeAt + NON_TERMINAL_IDLE_FAILED_NUDGE_RETRY_MS;
          if (now < retryAfter) {
            if (
              state.lastAttentionLogAt === null ||
              now - state.lastAttentionLogAt >= NON_TERMINAL_IDLE_ATTENTION_LOG_COOLDOWN_MS
            ) {
              state.lastAttentionLogAt = now;
              log.warn(
                `Node ${execution.workflowNodeId} remains idle with non-terminal last message after failed runtime nudge; needs attention: ` +
                  `execution=${execution.id} agent=${execution.agentName} session=${sessionId} reason=${classification.reason}`
              );
            }
            continue;
          }
        } else {
          if (
            state.lastAttentionLogAt === null ||
            now - state.lastAttentionLogAt >= NON_TERMINAL_IDLE_ATTENTION_LOG_COOLDOWN_MS
          ) {
            state.lastAttentionLogAt = now;
            log.warn(
              `Node ${execution.workflowNodeId} remains idle with non-terminal last message after runtime nudge; needs attention: ` +
                `execution=${execution.id} agent=${execution.agentName} session=${sessionId} reason=${classification.reason}`
            );
          }
          continue;
        }
      }
      const manager = tam ?? this.config.taskAgentManager;
      if (!manager) {
        log.warn(
          `Node ${execution.workflowNodeId} qualified as idle with non-terminal last message, but TaskAgentManager is unavailable; needs attention: ` +
            `execution=${execution.id} agent=${execution.agentName} session=${sessionId} reason=${classification.reason}`
        );
        continue;
      }
      state.nudgeCount += 1;
      state.lastNudgeAt = now;
      try {
        state.lastRuntimeNudgeMessageId = await manager.injectRuntimeRecoveryMessage(
          sessionId,
          this.buildNonTerminalIdleNudgeMessage()
        );
        state.failedNudgeCount = 0;
        log.warn(
          `Node ${execution.workflowNodeId} went idle with non-terminal last message; sent direct runtime nudge: ` +
            `execution=${execution.id} agent=${execution.agentName} session=${sessionId} reason=${classification.reason}`
        );
      } catch (error) {
        state.failedNudgeCount += 1;
        state.lastAttentionLogAt = now;
        log.warn(
          `Failed to nudge idle non-terminal node ${execution.workflowNodeId}; needs attention: ` +
            `execution=${execution.id} agent=${execution.agentName} session=${sessionId} reason=${reason}: ${formatCommandError(error)}`
        );
      }
    }
    return preservedAny ? 'preserved' : 'none';
  }

  private async handleWaitingRebindExecutions(
    runId: string,
    run: SpaceWorkflowRun,
    spaceId: string,
    canonicalTask: SpaceTask
  ): Promise<boolean> {
    const waitingExecutions = this.config.nodeExecutionRepo
      .listByWorkflowRun(runId)
      .filter((execution) => execution.status === 'waiting_rebind');
    if (waitingExecutions.length === 0) return false;

    const recoveryStates = waitingExecutions.map((execution) => {
      const data = parseNodeExecutionData(execution.data);
      const recoveryData = isRecord(data.orphanedToolContinuation)
        ? data.orphanedToolContinuation
        : {};
      const retryCount = typeof recoveryData.retryCount === 'number' ? recoveryData.retryCount : 0;
      const pendingInbox = this.toolContinuationRepo.listPendingInboxForExecution(execution.id);
      const hasActiveTool = this.toolContinuationRepo.hasActiveToolUseForExecution(execution.id);
      const hasLiveSession = execution.agentSessionId
        ? (this.config.taskAgentManager?.isSessionAlive(execution.agentSessionId) ?? false)
        : false;
      return {
        execution,
        data,
        recoveryData,
        retryCount,
        pendingInbox,
        hasActiveTool,
        hasLiveSession,
      };
    });

    for (const state of recoveryStates) {
      const {
        execution,
        data,
        recoveryData,
        retryCount,
        pendingInbox,
        hasActiveTool,
        hasLiveSession,
      } = state;
      if (hasActiveTool || hasLiveSession) {
        continue;
      }

      if (pendingInbox.length > 0 && retryCount < 1) {
        continue;
      }

      const reason =
        retryCount >= 1
          ? 'orphaned tool_result recovery exhausted its single automatic retry'
          : 'orphaned tool_result recovery expired before a continuation arrived';
      data.orphanedToolContinuation = {
        ...recoveryData,
        state: 'failed',
        retryCount,
        reason,
        updatedAt: Date.now(),
      };
      this.config.nodeExecutionRepo.update(execution.id, {
        status: 'blocked',
        result: reason,
        data,
        completedAt: Date.now(),
      });
      await this.transitionRunStatusAndEmit(run.id, 'blocked');
      await this.updateTaskAndEmit(spaceId, canonicalTask.id, {
        status: 'blocked',
        result: reason,
        blockReason: 'execution_failed',
        completedAt: null,
      });
      await this.safeNotify({
        kind: 'workflow_run_blocked',
        spaceId,
        runId,
        reason,
        timestamp: new Date().toISOString(),
      });
      log.warn(
        `SpaceRuntime: failed orphaned tool_result recovery for execution ${execution.id}: ${reason}`
      );
      return true;
    }

    for (const state of recoveryStates) {
      const { execution, data, recoveryData, retryCount, pendingInbox, hasLiveSession } = state;
      if (hasLiveSession || pendingInbox.length === 0 || retryCount >= 1) {
        continue;
      }

      const reason =
        pendingInbox[0]?.recoveryReason ??
        'orphaned tool_result continuation queued for deterministic retry';
      data.orphanedToolContinuation = {
        ...recoveryData,
        state: 'rebound',
        retryCount: retryCount + 1,
        reason,
        queuedContinuations: pendingInbox.length,
        updatedAt: Date.now(),
      };
      this.toolContinuationRepo.markInboxReboundForExecution(
        execution.id,
        'queued orphaned tool_result rebound by restarting workflow node execution'
      );
      this.config.nodeExecutionRepo.update(execution.id, {
        status: 'pending',
        result: null,
        data,
        startedAt: null,
        completedAt: null,
      });
      if (run.status !== 'in_progress') {
        await this.transitionRunStatusAndEmit(run.id, 'in_progress');
      }
      if (canonicalTask.status === 'blocked' || canonicalTask.status === 'open') {
        await this.updateTaskAndEmit(spaceId, canonicalTask.id, {
          status: 'in_progress',
          completedAt: null,
          result: null,
          blockReason: null,
        });
      }
      await this.safeNotify({
        kind: 'task_retry',
        spaceId,
        taskId: canonicalTask.id,
        runId,
        originalReason: reason,
        attemptNumber: retryCount + 1,
        maxAttempts: 1,
        timestamp: new Date().toISOString(),
      });
      log.info(
        `SpaceRuntime: rebound orphaned tool_result continuation for execution ${execution.id}; ` +
          `reset to pending for retry ${retryCount + 1}/1`
      );
    }
    return false;
  }

  /**
   * Attempt automatic recovery for a blocked workflow run.
   *
   * Tier 1 — Re-trigger: Reset blocked node executions to `pending` and
   * transition the run back to `in_progress` so the runtime re-spawns
   * agents on the next tick.
   *
   * Tier 2 — Escalate: When retries are exhausted, emit a
   * `workflow_run_needs_attention` event to the Space Agent for
   * human/agent escalation.
   */
  private async attemptBlockedRunRecovery(runId: string, run: SpaceWorkflowRun): Promise<void> {
    const meta = this.executorMeta.get(runId);
    if (!meta) return;

    const allRunTasks = this.config.taskRepo.listByWorkflowRun(runId);
    if (allRunTasks.length === 0) return;
    const canonicalTask = this.pickCanonicalTaskForRun(run, allRunTasks);
    if (!canonicalTask) return;

    const retryCount = this.blockedRetryCounts.get(runId) ?? 0;
    const blockedExecutions = this.config.nodeExecutionRepo
      .listByWorkflowRun(runId)
      .filter((e) => e.status === 'blocked');

    if (blockedExecutions.length === 0) return;

    const blockedReason = blockedExecutions[0].result ?? 'Unknown blocked reason';

    if (retryCount < MAX_BLOCKED_RUN_RETRIES) {
      // Enforce slot cap — don't promote if concurrency limit is reached.
      const space = await this.config.spaceManager.getSpace(meta.spaceId);
      if (this.getAvailableTaskSlots(space) <= 0) return;

      // Tier 1: Reset blocked executions and resume the run.
      for (const execution of blockedExecutions) {
        this.config.nodeExecutionRepo.update(execution.id, {
          status: 'pending',
          result: null,
        });
      }
      this.blockedRetryCounts.set(runId, retryCount + 1);

      // Transition run back to in_progress for the next tick to pick up.
      await this.transitionRunStatusAndEmit(runId, 'in_progress');
      if (canonicalTask.status === 'blocked') {
        await this.updateTaskAndEmit(meta.spaceId, canonicalTask.id, {
          status: 'in_progress',
          completedAt: null,
        });
      }

      // Clear dedup so a re-block can be notified again.
      this.notifiedTaskSet.delete(`${canonicalTask.id}:blocked`);

      await this.safeNotify({
        kind: 'task_retry',
        spaceId: meta.spaceId,
        taskId: canonicalTask.id,
        runId,
        originalReason: blockedReason,
        attemptNumber: retryCount + 1,
        maxAttempts: MAX_BLOCKED_RUN_RETRIES,
        timestamp: new Date().toISOString(),
      });
      log.info(
        `SpaceRuntime: auto-retrying blocked run ${runId} ` +
          `(attempt ${retryCount + 1}/${MAX_BLOCKED_RUN_RETRIES})`
      );
    } else {
      // Tier 2: Retries exhausted — escalate to Space Agent.
      await this.safeNotify({
        kind: 'workflow_run_needs_attention',
        spaceId: meta.spaceId,
        runId,
        taskId: canonicalTask.id,
        reason: blockedReason,
        retriesExhausted: retryCount,
        timestamp: new Date().toISOString(),
      });
      log.warn(
        `SpaceRuntime: blocked run ${runId} exhausted ${retryCount} retries, ` +
          `emitted workflow_run_needs_attention`
      );
    }
  }

  /**
   * Finds a completion summary from terminal node executions in a completed run.
   *
   * Strategy:
   * 1. Find terminal node IDs — workflow nodes with no outbound channel.
   * 2. Scan node_executions for those nodes.
   * 3. Return the first non-empty execution result.
   */

  private resolvePrUrlForRun(runId: string): string {
    const fromData = (data: Record<string, unknown> | undefined): string =>
      (typeof data?.prUrl === 'string' && data.prUrl) ||
      (typeof data?.pr_url === 'string' && data.pr_url) ||
      '';

    try {
      const gateDataRepo = this.config.gateDataRepo ?? new GateDataRepository(this.config.db);
      const gateRecords = gateDataRepo.listByRun(runId).sort((a, b) => b.updatedAt - a.updatedAt);
      for (const record of gateRecords) {
        const candidate = fromData(record.data);
        if (candidate) return candidate;
      }
    } catch (err) {
      log.warn(
        `SpaceRuntime.resolvePrUrlForRun: failed to read gate data for run ${runId}: ${err instanceof Error ? err.message : String(err)}`
      );
    }

    // Scan workflow hook state next so `pr_ready` hook state (which persists
    // `pr_url` after a successful send_message) is picked up even when the
    // gate schema does not declare `pr_url` (e.g. Review→QA approval gate).
    try {
      const hookStateRepo = new WorkflowHookStateRepository(this.config.db);
      const hookStates = hookStateRepo
        .listByRun(runId)
        .sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0));
      for (const snapshot of hookStates) {
        const candidate = fromData(snapshot.localState);
        if (candidate) return candidate;
      }
    } catch (err) {
      log.warn(
        `SpaceRuntime.resolvePrUrlForRun: failed to read hook state for run ${runId}: ${err instanceof Error ? err.message : String(err)}`
      );
    }

    if (this.config.artifactRepo) {
      try {
        const artifacts = this.config.artifactRepo.listByRun(runId);
        for (let i = artifacts.length - 1; i >= 0; i--) {
          const candidate = fromData(artifacts[i]?.data);
          if (candidate) return candidate;
        }
      } catch (err) {
        log.warn(
          `SpaceRuntime.resolvePrUrlForRun: failed to read artifacts for run ${runId}: ${err instanceof Error ? err.message : String(err)}`
        );
      }
    }

    return '';
  }

  private resolvePrimaryResultArtifactSummary(runId: string): string | undefined {
    if (!this.config.artifactRepo) return undefined;

    try {
      const artifacts = this.config.artifactRepo.listByRun(runId, { artifactType: 'result' });
      const artifact = artifacts
        .map((item, index) => ({ item, index }))
        .filter(({ item }) => typeof item.data.summary === 'string' && item.data.summary.trim())
        .toSorted(
          (a, b) =>
            b.item.updatedAt - a.item.updatedAt ||
            b.item.createdAt - a.item.createdAt ||
            b.index - a.index
        )[0]?.item;
      return typeof artifact?.data.summary === 'string' ? artifact.data.summary : undefined;
    } catch (err) {
      log.warn(
        `SpaceRuntime.resolvePrimaryResultArtifactSummary: failed to read artifacts for run ${runId}: ${err instanceof Error ? err.message : String(err)}`
      );
      return undefined;
    }
  }

  private buildTaskOutcomeUpdates(
    task: SpaceTask,
    result: string | null,
    reportedSummary: string | null
  ): UpdateSpaceTaskParams | null {
    const updates: UpdateSpaceTaskParams = {};
    if (result && task.result !== result) {
      updates.result = result;
    }
    if (reportedSummary && task.reportedSummary !== reportedSummary) {
      updates.reportedSummary = reportedSummary;
    }
    return Object.keys(updates).length > 0 ? updates : null;
  }

  private resolveCompletionSummary(runId: string, workflow: SpaceWorkflow): string | undefined {
    const channels = workflow.channels ?? [];
    const nodes = workflow.nodes;

    // Build name → nodeId map: node names and per-node agent slot names both resolve
    // to the containing node's UUID.
    const nameToNodeId = new Map<string, string>();
    for (const node of nodes) {
      nameToNodeId.set(node.name, node.id);
      if (node.agents) {
        for (const agent of node.agents) {
          nameToNodeId.set(agent.name, node.id);
        }
      }
    }

    // Resolve a channel endpoint reference to a node UUID.
    // Handles: plain names (node/agent-slot), cross-node "nodeId/agentName", '*' wildcard.
    const resolveRef = (ref: string): string | undefined => {
      if (ref === '*') return undefined;
      const slashIdx = ref.indexOf('/');
      if (slashIdx !== -1) {
        // Cross-node format — the part before the slash is the node UUID
        return ref.slice(0, slashIdx);
      }
      return nameToNodeId.get(ref);
    };

    // Collect node IDs that appear as channel sources (have outbound channels).
    // Each channel is one-way; a node has outbound if it appears in channel.from.
    const nodesWithOutbound = new Set<string>();
    for (const ch of channels) {
      const fromId = resolveRef(ch.from);
      if (fromId) nodesWithOutbound.add(fromId);
    }

    // Terminal nodes are those with no outbound channels
    const terminalNodeIds = new Set<string>();
    for (const node of nodes) {
      if (!nodesWithOutbound.has(node.id)) {
        terminalNodeIds.add(node.id);
      }
    }

    if (terminalNodeIds.size === 0) return undefined;

    // Look up completed node executions for terminal nodes and return the first result
    const executions = this.config.nodeExecutionRepo.listByWorkflowRun(runId);
    for (const execution of executions) {
      if (
        terminalNodeIds.has(execution.workflowNodeId) &&
        execution.status === 'idle' &&
        execution.result
      ) {
        return execution.result;
      }
    }

    return undefined;
  }

  /**
   * Removes from the executors map any executor whose run has reached a
   * terminal state (completed or cancelled).
   *
   * Reads run status from DB rather than relying on the executor's cached
   * this.run, so external status changes (e.g. cancellation via API) are
   * picked up without requiring executor recreation.
   *
   * Emits a `workflow_run_completed` notification for runs that reached the
   * `completed` state (set by the CompletionDetector or external cancellation).
   * Includes the Done node agent's result summary (if available) so the
   * Space Chat Agent can surface it to the human.
   */
  private async cleanupTerminalExecutors(): Promise<void> {
    for (const [runId] of this.executors) {
      const run = this.config.workflowRunRepo.getRun(runId);

      // Blocked runs keep their executor and proactive gate polls so they remain
      // rehydratable and poll timers can detect external conditions that may help
      // unblock the run. Do not remove the executor or prune dedup keys here.
      if (run?.status === 'blocked') {
        continue;
      }

      if (!run || run.status === 'done' || run.status === 'cancelled') {
        this.clearAgentStuckStateForRun(runId);
        if (run?.status === 'done') {
          const meta = this.executorMeta.get(runId);
          if (meta) {
            const summary = this.resolveCompletionSummary(runId, meta.workflow);
            await this.safeNotify({
              kind: 'workflow_run_completed',
              spaceId: meta.spaceId,
              runId,
              status: 'done',
              summary,
              timestamp: new Date().toISOString(),
            });
          }
        }
        if (run) {
          await this.reconcileTerminalRunTasks(run);
        }
        // Prune dedup entries for all tasks in this run so the set doesn't
        // grow unboundedly. Once a run is terminal its tasks will never
        // reappear in nodeTasks, so the normal per-tick pruning loop
        // (processRunTick) would never clear them otherwise.
        for (const task of this.config.taskRepo.listByWorkflowRun(runId)) {
          this.notifiedTaskSet.delete(`${task.id}:blocked`);
          this.notifiedTaskSet.delete(`${task.id}:timeout`);
        }
        this.clearRunInterests(runId);
        this.executors.delete(runId);
        this.executorMeta.delete(runId);
      }
    }
  }

  /**
   * Returns the cached SpaceTaskManager for a given space.
   * Public so that tool handlers (e.g. global-spaces-tools) can retry/cancel/reassign tasks.
   */
  getTaskManagerForSpace(spaceId: string): SpaceTaskManager {
    return this.getOrCreateTaskManager(spaceId);
  }

  /**
   * Checks standalone tasks (tasks without a workflowRunId) across all spaces for:
   *   - `blocked` status → emit `task_blocked` notification
   *   - `in_progress` timeout    → emit `task_timeout` notification
   *
   * Uses the shared `notifiedTaskSet` for deduplication so the same task+status pair
   * is never notified twice in a row. Dedup keys are cleared when the task leaves the
   * flagged state, allowing re-notification if the task cycles back into it.
   *
   * Dedup cleanup includes archived tasks (fetched via includeArchived=true) to prevent
   * notifiedTaskSet from accumulating stale keys for tasks that were archived while in
   * a flagged state. Archived tasks can never re-enter blocked or in_progress,
   * so their dedup keys are always safe to remove.
   *
   * Restart contract: because `notifiedTaskSet` is in-memory only, tasks already in
   * `blocked` at daemon startup will re-notify once on the first tick. This is
   * intentional — the Space Agent session is new after restart and needs to be informed
   * of outstanding issues. See the `notifiedTaskSet` field comment for details.
   */
  private async checkStandaloneTasks(): Promise<void> {
    const spaces = await this.listActiveSpaces();

    for (const space of spaces) {
      // Fetch all standalone tasks including archived ones for the dedup cleanup pass.
      // Using listStandaloneBySpace pushes workflow_run_id IS NULL into SQL so only
      // standalone tasks are returned — no JS-side filtering needed.
      // includeArchived=true ensures archived tasks have their dedup keys cleared and
      // do not accumulate as stale entries in notifiedTaskSet indefinitely.
      const allStandalone = this.config.taskRepo.listStandaloneBySpace(space.id, true);
      const activeStandalone = allStandalone.filter((t) => !t.archivedAt);

      // Dedup cleanup: clear keys for tasks that have left their flagged state.
      // Archived tasks always get their keys cleared — they can never re-enter a
      // flagged state, so keeping their keys would be a permanent memory leak.
      for (const task of allStandalone) {
        const archived = !!task.archivedAt;
        if (archived || task.status !== 'blocked') {
          this.notifiedTaskSet.delete(`${task.id}:blocked`);
        }
        if (archived || task.status !== 'in_progress') {
          this.notifiedTaskSet.delete(`${task.id}:timeout`);
        }
      }

      // Emit task_blocked for active standalone tasks in blocked state.
      for (const task of activeStandalone) {
        if (task.status !== 'blocked') continue;
        const dedupKey = `${task.id}:blocked`;
        if (!this.notifiedTaskSet.has(dedupKey)) {
          this.notifiedTaskSet.add(dedupKey);
          await this.safeNotify({
            kind: 'task_blocked',
            spaceId: space.id,
            taskId: task.id,
            reason: 'Task requires attention',
            timestamp: new Date().toISOString(),
          });
        }
      }

      // Timeout detection for active standalone in_progress tasks.
      const taskTimeoutMs = space.config?.taskTimeoutMs;
      if (taskTimeoutMs !== undefined) {
        const now = Date.now();
        for (const task of activeStandalone) {
          if (task.status !== 'in_progress' || !task.startedAt) continue;
          const elapsedMs = now - task.startedAt;
          if (elapsedMs > taskTimeoutMs) {
            const dedupKey = `${task.id}:timeout`;
            if (!this.notifiedTaskSet.has(dedupKey)) {
              this.notifiedTaskSet.add(dedupKey);
              await this.safeNotify({
                kind: 'task_timeout',
                spaceId: space.id,
                taskId: task.id,
                elapsedMs,
                timestamp: new Date().toISOString(),
              });
            }
          }
        }
      }
    }
  }

  /**
   * Attach a workflow run to open standalone tasks so workflow execution is driven
   * by the runtime tick (not by Task Agent session creation).
   *
   * For each open standalone task:
   * 1. Select a workflow for the task (LLM-driven, with deterministic fallback)
   * 2. Start a workflow run
   * 3. Attach the original task to the run and mark it in_progress
   *
   * Selection work runs in parallel across tasks so a slow LLM call on one
   * task does not delay the rest of the tick.
   */
  private normalizeConcurrentTaskLimit(limit: number | undefined): number {
    if (limit === undefined || !Number.isFinite(limit)) return MIN_SPACE_CONCURRENT_TASKS;
    return Math.min(
      MAX_SPACE_CONCURRENT_TASKS,
      Math.max(MIN_SPACE_CONCURRENT_TASKS, Math.trunc(limit))
    );
  }

  private getConcurrentTaskLimit(space: Space): number {
    return this.normalizeConcurrentTaskLimit(
      space.maxConcurrentTasks ?? space.config?.maxConcurrentTasks
    );
  }

  private getRunningTaskCount(spaceId: string): number {
    return this.config.taskRepo
      .listBySpace(spaceId, false)
      .filter((task) => task.status === 'in_progress' || task.status === 'approved').length;
  }

  private getAvailableTaskSlots(space: Space | null): number {
    if (!space) return 0;
    return Math.max(0, this.getConcurrentTaskLimit(space) - this.getRunningTaskCount(space.id));
  }

  private sortTasksByPriority(tasks: SpaceTask[]): SpaceTask[] {
    return [...tasks].sort((a, b) => {
      const priorityDelta = PRIORITY_ORDER[a.priority] - PRIORITY_ORDER[b.priority];
      if (priorityDelta !== 0) return priorityDelta;
      if (a.createdAt !== b.createdAt) return a.createdAt - b.createdAt;
      return a.id.localeCompare(b.id);
    });
  }

  private async attachStandaloneTasksToWorkflows(): Promise<void> {
    const spaces = await this.listActiveSpaces();

    for (const space of spaces) {
      const workflows = this.config.spaceWorkflowManager
        .listWorkflows(space.id)
        .filter((w) => !w.disabled);
      if (workflows.length === 0) continue;

      let availableSlots = this.getAvailableTaskSlots(space);
      if (availableSlots <= 0) continue;

      const standaloneOpenTasks = this.sortTasksByPriority(
        this.config.taskRepo
          .listStandaloneBySpace(space.id, false)
          .filter((task) => task.status === 'open')
      );

      const taskManager = this.getOrCreateTaskManager(space.id);

      // Evaluate the full priority-ordered queue so ineligible high-priority
      // tasks (for example, unmet dependencies) do not strand ready lower-priority
      // work while slots are available.
      for (const task of standaloneOpenTasks) {
        if (availableSlots <= 0) break;
        const fresh = this.config.taskRepo.getTask(task.id);
        if (!fresh || fresh.workflowRunId) continue;
        if (fresh.status !== 'open') continue;
        if (!(await taskManager.areDependenciesMet(fresh))) continue;

        const selected = await this.selectWorkflowForStandaloneTask(fresh, workflows);
        if (!selected) continue;

        // Re-read once more to defend against concurrent updates between
        // eligibility checks and attachment (e.g. another actor attached the task).
        const current = this.config.taskRepo.getTask(fresh.id);
        if (!current || current.workflowRunId) continue;
        if (current.status !== 'open') continue;
        if (this.getAvailableTaskSlots(space) <= 0) {
          availableSlots = 0;
          break;
        }

        try {
          const { run } = await this.startWorkflowRun(
            space.id,
            selected.id,
            current.title,
            current.description,
            { parentTaskId: current.id }
          );

          await this.updateTaskAndEmit(space.id, current.id, {
            workflowRunId: run.id,
            status: 'in_progress',
            startedAt: current.startedAt ?? Date.now(),
            completedAt: null,
          });
          availableSlots--;
        } catch (err) {
          log.warn(
            `SpaceRuntime: failed to attach standalone task ${current.id} to workflow ${selected.id}:`,
            err
          );
        }
      }
    }
  }

  /**
   * Pick the workflow to run for a standalone task.
   *
   * Order of precedence:
   * 1. `task.preferredWorkflowId` when it resolves to an existing workflow.
   * 2. The LLM selector (`SpaceRuntimeConfig.selectWorkflowWithLlm`) when
   *    provided and it returns an id that exists in the candidate list.
   *    Unknown ids, `null` returns, and thrown errors all fall through.
   * 3. Deterministic fallback: the first workflow tagged `default`, else the
   *    first tagged `v2`, else the most recently updated workflow.
   *
   * The old substring/keyword scorer was retired in favour of LLM-based
   * selection because it mis-routed tasks whose descriptions happened to
   * share words with workflow metadata (e.g. a "review feedback" task
   * hijacking a "review" workflow even when "coding" was the right fit).
   */
  private async selectWorkflowForStandaloneTask(
    task: SpaceTask,
    workflows: SpaceWorkflow[]
  ): Promise<SpaceWorkflow | null> {
    if (workflows.length === 0) return null;

    // Caller-specified preferred workflow wins over both LLM and deterministic
    // fallback. Fall through if the id doesn't resolve (e.g. workflow was
    // deleted between task creation and attachment) or is disabled.
    if (task.preferredWorkflowId) {
      const explicit = this.config.spaceWorkflowManager.getWorkflow(task.preferredWorkflowId);
      if (explicit && !explicit.disabled) return explicit;
      log.warn(
        `SpaceRuntime: preferred_workflow_id "${task.preferredWorkflowId}" not found or disabled for task ${task.id}; selecting a workflow automatically`
      );
    }

    if (workflows.length === 1) return workflows[0];

    const llmSelector = this.config.selectWorkflowWithLlm;
    if (llmSelector) {
      let llmResult: string | null = null;
      try {
        llmResult = await llmSelector(task, workflows);
      } catch (err) {
        log.warn(
          `SpaceRuntime: LLM workflow selector threw for task ${task.id}; using deterministic fallback:`,
          err
        );
        llmResult = null;
      }

      if (llmResult) {
        const hit = workflows.find((w) => w.id === llmResult);
        if (hit) return hit;
        log.warn(
          `SpaceRuntime: LLM workflow selector returned unknown id "${llmResult}" for task ${task.id}; using deterministic fallback`
        );
      }
    }

    return this.selectDeterministicWorkflowFallback(workflows);
  }

  /**
   * Tiebreak selection when no LLM/preferred workflow is available.
   *
   * Preference order:
   * 1. `default` tag
   * 2. `v2` tag
   * 3. Most recently updated workflow
   */
  private selectDeterministicWorkflowFallback(workflows: SpaceWorkflow[]): SpaceWorkflow | null {
    if (workflows.length === 0) return null;
    if (workflows.length === 1) return workflows[0];

    const scored = workflows.map((workflow) => {
      const tags = workflow.tags ?? [];
      return {
        workflow,
        isDefault: tags.includes('default') ? 1 : 0,
        isV2: tags.includes('v2') ? 1 : 0,
      };
    });

    scored.sort((a, b) => {
      if (b.isDefault !== a.isDefault) return b.isDefault - a.isDefault;
      if (b.isV2 !== a.isV2) return b.isV2 - a.isV2;
      return b.workflow.updatedAt - a.workflow.updatedAt;
    });

    return scored[0]?.workflow ?? null;
  }

  /**
   * Returns the cached SpaceTaskManager for a space, creating it if needed.
   * Caching avoids creating a new manager + repository on every executor build.
   */
  private getOrCreateTaskManager(spaceId: string): SpaceTaskManager {
    let manager = this.taskManagers.get(spaceId);
    if (!manager) {
      manager = new SpaceTaskManager(
        this.config.db,
        spaceId,
        this.config.reactiveDb,
        this.config.evolutionScopeService
      );
      this.taskManagers.set(spaceId, manager);
    }
    return manager;
  }

  /**
   * Builds a WorkflowExecutor for the given run with fresh state.
   * Used for graph navigation (getCurrentNode, isComplete) and condition evaluation.
   */
  private buildExecutor(
    workflow: SpaceWorkflow,
    run: SpaceWorkflowRun,
    _spaceId: string,
    _workspacePath: string
  ): WorkflowExecutor {
    return new WorkflowExecutor(workflow, run);
  }

  /**
   * Resolves the channel topology for a workflow node and stores it in the run's
   * config for use by session group creation (Milestone 6).
   *
   * Resolves channel topology using `WorkflowNodeAgent.name` entries from the node
   * and the workflow-level channels array.
   * Stores the result under `run.config._resolvedChannels`.
   *
   * TODO Milestone 6: pass resolvedChannels to session group metadata in
   * TaskAgentManager.spawnTaskAgent() instead of storing in run config.
   *
   * Note: Task Agent channels are persisted as WorkflowChannel entries in the
   * workflow channels array. This function only resolves and stores user-declared
   * channels — no runtime auto-generation.
   */
  /**
   * Stores the workflow channels for a run in memory.
   * Channels are node-to-node (WorkflowNode.name) and need no slot-level resolution.
   */
  storeWorkflowChannels(runId: string, channels: WorkflowChannel[]): void {
    this.workflowChannelsMap.set(runId, channels);
  }

  /**
   * Returns the channels for the given run ID.
   */
  getRunWorkflowChannels(runId: string): WorkflowChannel[] {
    return this.workflowChannelsMap.get(runId) ?? [];
  }

  /**
   * Returns the channels array for the workflow associated with the given run.
   */
  getWorkflowChannels(runId: string): WorkflowChannel[] {
    const run = this.config.workflowRunRepo.getRun(runId);
    if (!run) return [];
    const workflow = this.config.spaceWorkflowManager.getWorkflow(run.workflowId);
    return workflow?.channels ?? [];
  }
}

function parseNodeExecutionData(value: unknown): Record<string, unknown> {
  if (!value) return {};
  if (isRecord(value)) return { ...value };
  if (typeof value !== 'string') return {};
  try {
    const parsed = JSON.parse(value) as unknown;
    return isRecord(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function hasSqlExec(value: unknown): value is { exec: (sql: string) => void } {
  return isRecord(value) && typeof value.exec === 'function';
}
