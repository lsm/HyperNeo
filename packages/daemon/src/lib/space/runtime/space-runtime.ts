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

import type { Database as BunDatabase } from '../../../storage/sqlite-compat';
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
} from '@hyperneo/shared';
import type { SDKMessage } from '@hyperneo/shared/sdk';
import {
  isChannelCyclic,
  isRateOrUsageLimited,
  isWorkflowRunSucceeded,
  isWorkflowRunWaiting,
  MAX_SPACE_CONCURRENT_TASKS,
  MIN_SPACE_CONCURRENT_TASKS,
  resolveNodeAgents,
} from '@hyperneo/shared';
import type { ReactiveDatabase } from '../../../storage/reactive-database';
import type { ExternalEventPublishedPayload } from '../../external-events/external-event-service';
import { formatExternalEventEssence } from '../../external-events/event-essence';
import type { ExternalEventStore } from '../../external-events/external-event-store';
import {
  type QueueHealthGauges,
  type QueueHealthSnapshot,
  ExternalEventQueueMetrics,
  computeQueueAgeStats,
} from '../../external-events/queue-health-metrics';
import type { ExternalEvent } from '../../external-events/types';
import { validateGlobPattern } from '../../external-events/topic-validator';
import { legacyGitHubTopic } from '../../external-events/github-subscription-pattern';
import { composeLongHorizonSubscriptionPattern } from '../../external-events/long-horizon-subscription-pattern';
import {
  ChannelCycleRepository,
  DEAD_LOOP_THRESHOLD,
  DEAD_LOOP_WINDOW_MS,
} from '../../../storage/repositories/channel-cycle-repository';
import { normalizeMeaningfulTaskResult } from '../task-result-utils';
import type { WorkflowArtifactProfile } from './artifact-profile';
import type { NodeExecutionRepository } from '../../../storage/repositories/node-execution-repository';
import type { PendingAgentMessageRepository } from '../../../storage/repositories/pending-agent-message-repository';
import { SDKMessageRepository } from '../../../storage/repositories/sdk-message-repository';
import type { SpaceTaskRepository } from '../../../storage/repositories/space-task-repository';
import { SpaceWorkflowEventSubscriptionRepository } from '../../../storage/repositories/space-workflow-event-subscription-repository';
import type { SpaceWorkflowRunRepository } from '../../../storage/repositories/space-workflow-run-repository';
import { ToolContinuationRecoveryRepository } from '../../../storage/repositories/tool-continuation-recovery-repository';
import type { SpaceLongHorizonAgentRepository } from '../../../storage/repositories/space-long-horizon-agent-repository';
import type { WorkflowRunArtifactRepository } from '../../../storage/repositories/workflow-run-artifact-repository';
import { Logger } from '../../logger';
import { isSDKResultError } from '@hyperneo/shared/sdk';
import type { SpaceAgentManager } from '../managers/space-agent-manager';
import type { SpaceManager } from '../managers/space-manager';
import { isValidSpaceTaskTransition, SpaceTaskManager } from '../managers/space-task-manager';
import {
  isReservedWorkflowAgentName,
  type SpaceWorkflowManager,
} from '../managers/space-workflow-manager';
import { MAX_AGENT_SLOT_EVENT_INTERESTS } from '../export-format';
import { deliveryModeFromFailureReason } from './delivery-mode';
import { CompletionDetector } from './completion-detector';
import {
  DEFAULT_AGENT_NO_PROGRESS_THRESHOLD_MS,
  DEFAULT_AGENT_STUCK_NAG_GRACE_MS,
  DEFAULT_TOOL_USE_ACTIVE_TTL_MS,
  MAX_AGENT_STUCK_NAGS,
  MAX_AGENT_STUCK_RESTARTS,
  MAX_BLOCKED_RUN_RETRIES,
  MAX_TASK_AGENT_CRASH_RETRIES,
  MAX_TERMINAL_ERROR_CONTINUE_RETRIES,
} from './constants';
import { classifyLastMessageForIdleAgent } from './last-message-classifier';
import {
  COMPACT_RESULT_TIMEOUT_MS,
  MAX_PROMPT_TOO_LONG_RECOVERY_ATTEMPTS,
  buildPromptTooLongContinueNag,
  createPromptTooLongRecoveryState,
  isPromptTooLongErrorMessage,
  type PromptTooLongRecoveryState,
} from './prompt-too-long-recovery';
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
  clearPendingCompletionState,
} from './post-approval-router';

import type { TaskAgentManager } from './task-agent-manager';
import type { SpaceActorRegistryAdapter } from '../actor-registry';
import type { SpaceAgentInboxRepository } from '../../../storage/repositories/space-agent-inbox-repository';
import { TopicTrie } from '../../external-events/topic-trie';
import { WorkflowExecutor } from './workflow-executor';
import {
  isMissingWorkflowAgentError,
  isPermanentSpawnError,
  isTransientSpawnError,
  MissingWorkflowAgentError,
  findMissingNodeAgentReferences,
  formatMissingAgentReference,
} from './workflow-node-execution-validation';
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
  /**
   * Channel cycle repository for rate-based dead-loop detection on cyclic
   * channels. Injected (mirroring ChannelRouter / TaskAgentManager) so the repo
   * can be mocked in recovery tests and a single instance is shared. Auto-built
   * from `db` when not supplied.
   */
  channelCycleRepo?: ChannelCycleRepository;
  /** Space manager for listing spaces and fetching workspace paths */
  spaceManager: SpaceManager;
  /** Agent manager for resolving agents */
  spaceAgentManager: SpaceAgentManager;
  /** Long-horizon agent repository for durable external-event subscriptions. */
  longHorizonAgentRepo?: SpaceLongHorizonAgentRepository;
  /**
   * Durable workflow-run event subscription store. Source of truth for
   * agent-registered `dynamic` runtime subscriptions (static template interests
   * are re-materialized from the workflow definition); the in-memory topic trie
   * is rebuilt from it on rehydrate. Auto-created from `db` when not supplied.
   */
  workflowEventSubscriptionRepo?: SpaceWorkflowEventSubscriptionRepository;
  /** Workflow manager for loading workflow definitions */
  spaceWorkflowManager: SpaceWorkflowManager;
  /** Workflow run repository for run CRUD and status updates */
  workflowRunRepo: SpaceWorkflowRunRepository;
  /** Task repository for querying tasks by run/node */
  taskRepo: SpaceTaskRepository;
  /** Node execution repository for workflow-internal execution state */
  nodeExecutionRepo: NodeExecutionRepository;
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
   * Optional queue-health metrics collector for the pending external-event
   * delivery queue. Defaults to a new in-memory instance. The same instance is
   * wired to the store's delivery-terminal hook by the service so terminal
   * outcomes are counted from a single observation point.
   */
  queueHealthMetrics?: ExternalEventQueueMetrics;
  /**
   * Per-target recoverable-failure cool-down window for external-event
   * injection (ms). Defaults to {@link EXTERNAL_EVENT_DELIVERY_COOLDOWN_MS}
   * (env `HYPERNEO_EXTERNAL_EVENT_DELIVERY_COOLDOWN_MS`, default 30s). Exposed
   * primarily for tests; production omits it to use the env default.
   */
  externalEventDeliveryCooldownMs?: number;
  /**
   * Soft cap on the per-delivery cool-down map size; once exceeded, expired
   * entries are swept on arm. Defaults to
   * {@link EXTERNAL_EVENT_DELIVERY_COOLDOWN_MAP_CAP}. Exposed for tests.
   */
  externalEventDeliveryCooldownMapCap?: number;
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
   * Domain artifact profile. Owns coding-specific semantics (which `link` is
   * the run's PR, which `decision` is the terminal outcome) so this class never
   * names domain kinds. When omitted, primary-link resolution returns '' and
   * outcome summaries return undefined.
   */
  artifactProfile?: WorkflowArtifactProfile;
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
   * - `dynamic` — registered at runtime via MCP tooling (`subscribe_external_event`
   *              / `subscribe_pr_events`), e.g. a coder subscribing to its own PR.
   */
  subscriptionKind?: 'static' | 'dynamic';
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

// ---------------------------------------------------------------------------
// listSubscriptions — read-only diagnostic result (Task #908)
// ---------------------------------------------------------------------------

/**
 * A declared static event interest, re-derived from the workflow definition
 * (durable). `topic` and `topicFrom` are mutually exclusive. `active` is a live
 * cross-check against the in-memory trie: true iff a `static` trie entry exists
 * for this slot + topic. `topicFrom` interests are inert until their resolver
 * ships, so they report `active: false` and are excluded from the mismatch
 * count (they are known-not-active by design, not drift).
 */
interface SubscriptionDeclaredInterest {
  nodeId: string;
  nodeName: string;
  agentName: string;
  topic: string | null;
  topicFrom: { source: 'primaryLink'; pattern: string } | null;
  label: string | null;
  active: boolean;
}

/**
 * A persisted dynamic subscription row from `space_workflow_event_subscriptions`
 * (durable). `active` is a live cross-check: true iff a `dynamic` trie entry
 * exists for this slot + topic.
 */
interface SubscriptionPersistedRow {
  nodeId: string;
  agentName: string;
  taskId: string;
  topic: string;
  createdAt: number;
  updatedAt: number;
  active: boolean;
}

/**
 * An active in-memory trie entry — the live cross-check layer, NEVER the
 * answer on its own. `source` reconciles it against durable state:
 * `'declared'` (a workflow-definition interest backs this static entry),
 * `'persisted'` (a table row backs this dynamic entry), `'orphan'` (in the
 * trie with no durable backing — indicates drift, e.g. a stale trie entry left
 * by a partial rehydrate, a mid-run definition-version change, or a static
 * entry surviving on a terminal/non-canonical task; benign in the upgrade
 * window, worth investigating if it persists in steady state), or `'unknown'`
 * (a static entry whose declaration layer could not be loaded — backing is
 * unverifiable, so it is neither confirmed nor reported as drift).
 */
interface SubscriptionActiveEntry {
  nodeId: string;
  agentName: string;
  taskId: string;
  topic: string;
  subscriptionKind: 'static' | 'dynamic';
  source: 'declared' | 'persisted' | 'orphan' | 'unknown';
}

interface SubscriptionListResult {
  workflowRunId: string;
  /** nodeId filter applied, or null when the whole run is returned. */
  nodeId: string | null;
  /**
   * Whether the run's workflow definition resolved. When false, `declared` is
   * empty NOT because nothing is declared but because the definition could not
   * be loaded (e.g. a deleted/stale definition) — so the caller does not
   * misread an unavailable durable layer as "node declares no subscriptions."
   */
  definitionResolved: boolean;
  declared: SubscriptionDeclaredInterest[];
  persisted: SubscriptionPersistedRow[];
  active: SubscriptionActiveEntry[];
  /** Reconciliation counts derived from the three layers. */
  mismatches: {
    /**
     * Declared concrete-topic interests with no matching active static entry.
     * Suppressed for terminal-task runs (see listSubscriptions): their static
     * interests are intentionally cleared by the task lifecycle.
     */
    declaredNotActive: number;
    /** Persisted rows with no matching active dynamic entry. */
    persistedNotActive: number;
    /** Active entries with no durable backing (static w/o declared, dynamic w/o persisted). */
    orphanActive: number;
  };
}

// Normalized reconciliation key: slot (node + agent) + lowercased topic, plus
// an optional taskId. Static declaration has no task (interests are slot-level
// in the workflow definition), so static keys omit it; dynamic rows/targets
// both carry taskId and include it so two tasks sharing a slot+topic can't
// cross-match (which would mask the persisted↔active drift this tool surfaces).
function subscriptionReconcileKey(
  nodeId: string,
  agentName: string,
  topic: string,
  taskId?: string
): string {
  return `${nodeId}|${agentName.toLowerCase()}|${topic.toLowerCase()}${taskId ? `|${taskId}` : ''}`;
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

/**
 * Recovery state for a node-agent session that ended on a terminal error
 * result. Tracks the number of auto-continue injections and the normalized
 * error signature of the last error we continued past, so a deterministic
 * repeat (identical signature) can be escalated instead of looped on.
 *
 * `lastSessionId` detects a re-spawn (new session after `blocked` recovery):
 * the count resets so a genuinely restarted session gets a fresh budget, while
 * the total stays bounded by `MAX_BLOCKED_RUN_RETRIES`.
 */
interface TerminalErrorContinueState {
  lastSessionId: string | null;
  continueCount: number;
  lastRetriedErrorSignature: string | null;
  lastContinueAt: number | null;
  /**
   * Consecutive failed `injectRuntimeRecoveryMessage` attempts. A live but
   * wedged session whose injection keeps throwing would otherwise retry every
   * grace interval forever; once this reaches the cap the execution escalates
   * to `blocked`. Reset to 0 on any successful injection.
   */
  failedInjectionCount: number;
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
/**
 * Per-target cool-down applied after a RECOVERABLE external-event delivery
 * failure (the dispatch threw non-terminally). While a target is within this
 * window of its last recoverable failure, new injections for it are SKIPPED —
 * the event stays `published` and re-evaluates on the next source re-poll — so a
 * target session stuck in a provider-error loop no longer mints a fresh
 * `failed` user-message row (fresh UUID) on every re-poll. The cool-down lifts
 * after the window; the core turn-recovery fix (this PR) recovers the session
 * within it. Terminal failures (subscription gone, task terminal, missing
 * command handler) do NOT arm the cool-down — they are done. Bounded by
 * {@link SpaceRuntime.externalEventDeliveryCooldowns}.
 */
const EXTERNAL_EVENT_DELIVERY_COOLDOWN_MS = parsePositiveIntegerEnv(
  'HYPERNEO_EXTERNAL_EVENT_DELIVERY_COOLDOWN_MS',
  30_000
);
/**
 * Soft cap on the per-delivery cool-down map. Entries are reaped lazily on re-
 * query, so a delivery that fails once and is never republished would otherwise
 * linger until runtime stop; in a long-running daemon a provider-error storm
 * targeting many distinct deliveries could grow the map without bound. On arm,
 * once the map exceeds this cap, expired entries are swept (amortized over
 * arms). A still-oversized map after the sweep means a genuinely large set of
 * live (in-window) failing deliveries — itself a bounded, observable signal.
 */
const EXTERNAL_EVENT_DELIVERY_COOLDOWN_MAP_CAP = parsePositiveIntegerEnv(
  'HYPERNEO_EXTERNAL_EVENT_DELIVERY_COOLDOWN_MAP_CAP',
  4096
);
/**
 * TTL for pending external-event deliveries that are waiting for their target
 * node to become active (in-memory pending queue, DB-persisted pending rows,
 * and retry replay).
 *
 * **TTL anchor is the external event's age** — i.e. the source-event row's
 * `created_at` (ingestion time), NOT the delivery row's registration time.
 * External events are time-sensitive (e.g. a GitHub review comment), so a
 * delivery is dropped once its *event* is older than this window, regardless
 * of when the delivery row was registered. This matters for delayed
 * registration (event backdated/backlogged, subscription added late, or daemon
 * restart replay): such deliveries must not get a fresh TTL window measured
 * from registration. The delivery table intentionally has no `created_at`
 * column; if registration-age TTL were ever wanted, it would require a schema
 * migration plus changes to both `collectPersistedPendingDeliveries` and the
 * rehydrate retry sweep (which both read `eventRecord.createdAt`).
 *
 * See `isQueuedExternalEventExpired` and design doc §5 "Backpressure — Event TTL".
 */
const EXTERNAL_EVENT_QUEUE_TTL_MS = parsePositiveIntegerEnv('EXTERNAL_EVENT_QUEUE_TTL_MS', 300_000);

export function parsePositiveIntegerEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value <= 0) return fallback;
  return value;
}

/**
 * Choose the canonical task for a workflow run in one-task-per-run mode.
 *
 * Preference:
 * 1. Title exactly matches run title (case-insensitive, trimmed)
 * 2. Lowest task number
 * 3. Earliest created_at
 *
 * Exported as a pure function so external completion paths
 * (`complete_validation_task` on node-agent servers) apply the EXACT same
 * selection rule the tick loop uses when it later archives non-canonical
 * duplicates — a completion recorded on a duplicate would be discarded by
 * that archive while its side effects (evidence capture, dependent
 * unblocking) persisted.
 */
export function pickCanonicalRunTask(
  run: SpaceWorkflowRun,
  runTasks: SpaceTask[]
): SpaceTask | null {
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

function longHorizonSpaceIdFromWorkflowRunId(workflowRunId: string): string | null {
  const prefix = 'long_horizon:';
  return workflowRunId.startsWith(prefix) ? workflowRunId.slice(prefix.length) : null;
}

type ExternalEventTaskDecision =
  | { action: 'deliver' }
  | { action: 'reactivate' }
  | { action: 'hold' }
  | { action: 'fail'; reason: string };

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
   * Timestamp (ms) of the last periodic `channel_cycle_events` prune. Rows are
   * pruned at most once per `DEAD_LOOP_WINDOW_MS` from `executeTick` so that
   * history retained on reopenable done/cancelled runs (which are no longer
   * traversed, so lazy per-channel pruning never runs) cannot grow the table
   * without bound on a long-lived daemon. See {@link pruneExpiredCycleEvents}.
   */
  private lastGlobalCyclePruneAt = 0;

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
   * In-memory recovery state keyed by `${runId}:${nodeExecutionId}` for
   * node-agent sessions that ended on a terminal error result.
   *
   * Bounds auto-continue injections (`MAX_TERMINAL_ERROR_CONTINUE_RETRIES`)
   * before escalating to `blocked`, and short-circuits deterministic repeats.
   */
  private terminalErrorContinueStates = new Map<string, TerminalErrorContinueState>();

  /**
   * In-memory Layer 1 recovery state keyed by `${runId}:${nodeExecutionId}`.
   * NodeExecution IDs are per agent slot, so a stuck agent in a multi-agent node
   * can be nudged/restarted without touching sibling agents.
   */
  private agentStuckRecovery = new Map<string, AgentStuckRecoveryState>();

  /**
   * Prompt-too-long recovery state keyed by `${runId}:${nodeExecutionId}`.
   * Tracks compact-then-continue progress for executions that overflowed their
   * context window and received a terminal `prompt_too_long` result.
   */
  private promptTooLongRecovery = new Map<string, PromptTooLongRecoveryState>();
  private readonly toolContinuationRepo: ToolContinuationRecoveryRepository;
  private readonly workflowEventSubscriptionRepo: SpaceWorkflowEventSubscriptionRepository;
  private readonly topicTrie = new TopicTrie<SubscriptionTarget>();
  private readonly pendingExternalEventQueue = new Map<string, PendingExternalEvent[]>();
  private readonly externalEventRetryTimers = new Map<string, Timer>();
  private readonly externalEventRetryCounts = new Map<string, number>();
  private readonly externalEventDeliveriesInFlight = new Set<string>();
  /**
   * Tracks in-flight task reactivation promises (check_failed recovery) so
   * concurrent deliveries targeting the same task await the recovery —
   * including ensureExecutorRegistered / prepareSubSessionForWorkflowResume —
   * before injecting into the session, avoiding stale/missing workflow tools.
   */
  private readonly recoveryInFlight = new Map<string, Promise<void>>();
  private readonly cancelledLongHorizonDeliveries = new Set<string>();
  private readonly longHorizonSubscriptionPatterns = new Map<string, string>();
  private readonly externalEventRateLimits = new Map<string, ExternalEventRateLimitState>();
  /**
   * Per-delivery cool-down: maps a delivery key (event + target — see
   * {@link buildDeliveryKey}) to the epoch ms of its last RECOVERABLE delivery
   * failure. While `now - lastFailureAt < {@link deliveryCooldownMs}`, a FRESH
   * dispatch (publish / re-poll) of that same delivery is skipped in
   * {@link handleExternalEventImpl} so a session stuck in a provider-error loop
   * does not mint a fresh `failed` user-message row on every source re-poll of
   * the same event. Distinct events and the bounded retry path
   * ({@link scheduleExternalEventRetry}, which bypasses
   * {@link handleExternalEventImpl}) are unaffected. Entries hold only a
   * timestamp (no timers) and expire lazily in
   * {@link isDeliveryInDeliveryCooldown}.
   */
  private readonly externalEventDeliveryCooldowns = new Map<string, number>();
  /**
   * Active cool-down window (ms). Bound from config at construction so tests can
   * shrink it; production uses {@link EXTERNAL_EVENT_DELIVERY_COOLDOWN_MS}.
   */
  private readonly deliveryCooldownMs: number;
  /** Soft cap on {@link externalEventDeliveryCooldowns}; sweeps expired on arm. */
  private readonly deliveryCooldownMapCap: number;
  /**
   * Pending external-event queue health counters. Defaults to a fresh
   * in-memory instance; the service wires the store's delivery-terminal hook
   * to the same instance (when shared) so terminal outcomes are counted once.
   */
  private readonly queueHealthMetrics: ExternalEventQueueMetrics;
  private unsubscribeExternalEventPublished?: () => void;
  private unsubscribeSdkToolUseCreated?: () => void;
  private unsubscribeSdkToolUseConsumed?: () => void;
  private unsubscribeSpaceResumed?: () => void;
  private unsubscribeSpacePaused?: () => void;
  private unsubscribeSpaceStopped?: () => void;
  private acceptingExternalEvents = false;
  /**
   * Incremented by stop(). start() captures the current value for its
   * fire-and-forget restart IIFE to detect a stop() that landed during the
   * IIFE's awaited space scan and abort before re-subscribing/ticking a
   * stopped runtime.
   */
  private runtimeGeneration = 0;
  /**
   * False during a stop→start paused-space reconciliation; executeTick returns
   * early while false so interval ticks can't process events against a stale
   * pausedSpaceIds before the reconciliation IIFE rebuilds it.
   */
  private reconciliationDone = true;
  /**
   * Set true by stop(), false by start(). Guards retained-event replay so an
   * in-flight handler past the stop point cannot re-set the deferred-flush flag
   * and inject retained events after shutdown. Defaults false so pre-start
   * callers (tests, direct ensure) are not blocked.
   */
  private isStopped = false;
  /**
   * Sync cache of paused/stopped space ids, maintained via the space
   * pause/resume registers and seeded on rehydrate. Lets the delivery hot path
   * defer (not inject) events for paused spaces without an async lookup —
   * pauseSpace does not terminate sessions, so a live in_progress session would
   * otherwise be injected during pause.
   */
  private pausedSpaceIds = new Set<string>();
  /**
   * Re-entrancy depth for {@link handleExternalEvent}. When > 0, a newly-created
   * PR auto-subscription must not synchronously redispatch retained events — it
   * would re-handle the in-flight event. The redispatch is deferred via
   * {@link retainedEventRedispatchPending} and flushed when depth returns to 0.
   */
  private externalEventHandlingDepth = 0;
  private retainedEventRedispatchPending = false;

  constructor(private config: SpaceRuntimeConfig) {
    this.internalEventBus = config.internalEventBus;
    this.completionDetector = config.completionDetector ?? new CompletionDetector(config.taskRepo);
    this.sdkMessageRepo = config.sdkMessageRepo ?? null;
    this.toolContinuationRepo = new ToolContinuationRecoveryRepository(config.db);
    if (hasSqlExec(config.db)) {
      this.toolContinuationRepo.ensureSchema();
    }
    // Workflow-run event subscriptions are the durable source of truth for the
    // in-memory topic trie; auto-create the repo + table so the trie can be
    // rebuilt purely from it on rehydrate.
    this.workflowEventSubscriptionRepo =
      config.workflowEventSubscriptionRepo ??
      new SpaceWorkflowEventSubscriptionRepository(config.db);
    if (hasSqlExec(config.db)) {
      this.workflowEventSubscriptionRepo.ensureSchema();
    }
    this.queueHealthMetrics = config.queueHealthMetrics ?? new ExternalEventQueueMetrics();
    this.deliveryCooldownMs =
      config.externalEventDeliveryCooldownMs ?? EXTERNAL_EVENT_DELIVERY_COOLDOWN_MS;
    this.deliveryCooldownMapCap =
      config.externalEventDeliveryCooldownMapCap ?? EXTERNAL_EVENT_DELIVERY_COOLDOWN_MAP_CAP;
    this.subscribeExternalEventPublished();
    this.subscribeSdkToolUseCreated();
    this.unsubscribeSpaceResumed = this.config.spaceManager.onSpaceResumedRegister?.((spaceId) =>
      this.onSpaceResumed(spaceId)
    );
    this.unsubscribeSpacePaused = this.config.spaceManager.onSpacePausedRegister?.((spaceId) => {
      this.pausedSpaceIds.add(spaceId);
    });
    this.unsubscribeSpaceStopped = this.config.spaceManager.onSpaceStoppedRegister?.((spaceId) => {
      this.pausedSpaceIds.add(spaceId);
    });
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
      this.sdkMessageRepo = new SDKMessageRepository(this.config.db, this.config.reactiveDb);
    }
    return this.sdkMessageRepo;
  }

  private createNodeExecutionOrIgnore(params: CreateNodeExecutionParams): NodeExecution {
    if (isReservedWorkflowAgentName(params.agentName)) {
      throw new Error(`Agent name "${params.agentName}" is reserved for a built-in agent`);
    }
    this.assertAgentReferenceExists(params);
    return this.config.nodeExecutionRepo.createOrIgnore(params);
  }

  /**
   * Validate that a configured custom-agent reference still exists before a
   * node_execution is created. A non-null agentId pointing at a deleted
   * space_agents row would otherwise make the INSERT raise
   * SQLITE_CONSTRAINT_FOREIGNKEY (INSERT OR IGNORE does not suppress foreign-key
   * failures). Null agentId (built-in/worker slots) is always valid and left
   * untouched — we never silently null a reference the workflow genuinely
   * requires.
   *
   * This is the shared chokepoint for every runtime node-activation path (run
   * start, restart-recovery downstream activation, event/task recovery, queued
   * handoff). The channel-router activation path performs the same check up
   * front with the node name for a richer diagnostic.
   */
  private assertAgentReferenceExists(params: CreateNodeExecutionParams): void {
    const agentId = params.agentId;
    if (!agentId) return;
    if (this.config.spaceAgentManager.getById(agentId)) return;
    throw new MissingWorkflowAgentError(
      formatMissingAgentReference({
        runId: params.workflowRunId,
        nodeLabel: params.workflowNodeId,
        agentName: params.agentName,
        agentId,
      }),
      { agentName: params.agentName, agentId }
    );
  }

  registerRunInterests(
    workflowRunId: string,
    taskId: string,
    nodes: WorkflowNode[],
    options: { clearQueuedDeliveries?: boolean } = {}
  ): void {
    // Refresh only workflow-defined static interests, preserving agent-created
    // (dynamic) subscriptions so an agent that explicitly subscribed keeps
    // receiving events after a re-registration. Static interests are not
    // persisted (they are re-materialized from the definition), so only the
    // trie needs clearing here — the durable table holds dynamic rows only.
    this.topicTrie.remove(
      (target) =>
        isWorkflowSubscriptionTarget(target) &&
        target.workflowRunId === workflowRunId &&
        target.subscriptionKind === 'static'
    );
    if (options.clearQueuedDeliveries) {
      this.clearQueuedDeliveriesForRun(workflowRunId, 'run_interests_rebuilt');
    }
    for (const node of nodes) {
      for (const agentEntry of resolveNodeAgents(node)) {
        for (const interest of agentEntry.eventInterests ?? []) {
          // Only static `topic` interests are registered here. A `topicFrom`
          // interest is resolved into a concrete topic against the run's primary
          // link at subscription time (see `resolveTopicFromInterest`); that
          // resolution is wired in a later PR, so `topicFrom` interests are
          // intentionally inert here and must not enter the trie yet.
          if (typeof interest.topic !== 'string') continue;
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
    // Skip static re-materialization when the canonical task is terminal or
    // retryably cancelled: its static interests were cleared by the task
    // lifecycle (clearTaskInterests on done/archived,
    // clearTaskInterestsPreservingDynamic on cancelled), and re-adding them
    // would undo that — a matching event would terminalize as
    // target_task_terminal instead of waiting for the task to resume (retry) or
    // fan out to a dead target. (Not gated on RUN status: a done run whose task
    // is review/approved still needs its static interests for the post-approval
    // phase.)
    if (task.status === 'cancelled' || task.status === 'done' || task.status === 'archived') {
      return;
    }
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
    options: { subscriptionKind?: 'static' | 'dynamic' } = {}
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
    // Resolve the run before mutating anything. A stale worker whose run is gone
    // would yield an undeliverable, non-durable target — reject up front.
    const run = this.config.workflowRunRepo.getRun(workflowRunId);
    if (!run) {
      return { success: false, error: `Workflow run not found: ${workflowRunId}` };
    }
    // The task-lifecycle gate applies to DYNAMIC (agent-driven) registrations
    // only: a stale worker subscribing after its task is terminal/detached would
    // persist a row that fans out to a known-invalid target. STATIC interests are
    // runtime-driven re-materialization (registerRunInterests), and a run can be
    // rehydratable (in_progress/blocked) with a retryably-CANCELLED canonical
    // task — rejecting there would make registerRunInterests throw and abort the
    // whole rehydrate pass, so static skips this check (run-level eligibility
    // already gates the static-rebuild loop).
    if (subscriptionKind === 'dynamic') {
      const taskError = this.validateSubscriptionTargetTask(run, taskId);
      if (taskError) return { success: false, error: taskError };
    }
    // Capture the entry this registration displaces (idempotent re-registration
    // of the same slot+topic+kind) so the trie can be restored if a later step
    // fails — otherwise the dedup-remove below drops the pre-existing entry
    // while the table keeps its row, and events stop reaching the still-
    // subscribed actor until restart.
    const displaced = this.findExactWorkflowSubscriptionTarget(
      workflowRunId,
      taskId,
      nodeId,
      agentName,
      normalized,
      subscriptionKind
    );
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
    // The per-slot cap protects against agents registering excessive
    // user/static/dynamic interests on a single slot.
    const existingInterests = this.topicTrie.count(
      (target) =>
        isWorkflowSubscriptionTarget(target) &&
        target.workflowRunId === workflowRunId &&
        target.nodeId === nodeId &&
        target.agentName === agentName
    );
    if (existingInterests >= MAX_AGENT_SLOT_EVENT_INTERESTS) {
      if (displaced) this.topicTrie.insert(displaced.topic ?? trimmed, displaced);
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
    // Write-through: persist DYNAMIC subscriptions so they survive a daemon
    // restart — these cannot be re-derived, so the table is their only source.
    // Static (template) interests are deliberately NOT persisted: they are
    // re-materialized from the workflow definition on rehydrate
    // (`ensureExecutorRegistered` / the static-rebuild loop), which already
    // applies the correct review/post-approval eligibility. The slot+topic+kind
    // is the upsert key, so re-registering is idempotent. If the durable write
    // fails, roll back the trie insert so the two stay consistent (the entry
    // would not survive a restart anyway) and surface the failure.
    if (subscriptionKind === 'dynamic') {
      try {
        this.workflowEventSubscriptionRepo.upsert({
          spaceId: run.spaceId,
          workflowRunId,
          taskId,
          nodeId,
          agentName,
          topic: trimmed,
          subscriptionKind,
        });
      } catch (err) {
        // Roll back the new trie entry and restore whatever re-registration
        // displaced, keeping the trie consistent with the durable store.
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
        if (displaced) this.topicTrie.insert(displaced.topic ?? trimmed, displaced);
        log.warn(
          `SpaceRuntime: failed to persist subscription for ${workflowRunId}/${nodeId}/${agentName}: ` +
            (err instanceof Error ? err.message : String(err))
        );
        return { success: false, error: 'Failed to persist subscription.' };
      }
    }
    // An event can arrive in the brief interval between an external resource
    // being created and the actor registering its dynamic interest. Unmatched
    // events stay `published` for the bounded retention TTL; replay here so a
    // newly-registered interest receives any event that arrived in that gap.
    // Static interests are rebuilt during rehydrate before the runtime accepts
    // events, so only runtime-created dynamic interests need the direct replay.
    if (subscriptionKind === 'dynamic') {
      this.redispatchRetainedExternalEvents();
    }
    return { success: true };
  }

  /**
   * Verify `taskId` belongs to `run` and is in a lifecycle that can still
   * deliver events. Applied to DYNAMIC (agent-driven) registrations only — a
   * stale worker subscribing after its task is terminal (done/archived/cancelled)
   * or detached from the run would persist a row that fans events out to a
   * known-invalid target (delivery rejects it; task-lifecycle cleanup already
   * fired). Returns an error string, or null when the task is eligible.
   */
  private validateSubscriptionTargetTask(run: SpaceWorkflowRun, taskId: string): string | null {
    const task = this.config.taskRepo.getTask(taskId);
    if (!task || task.workflowRunId !== run.id) {
      return `Task ${taskId} does not belong to workflow run ${run.id}`;
    }
    if (task.status === 'done' || task.status === 'archived' || task.status === 'cancelled') {
      return `Task ${taskId} is terminal (${task.status}); cannot register subscriptions`;
    }
    return null;
  }

  /**
   * Find the existing workflow-subscription trie entry for an exact slot + topic
   * (case-insensitive) + kind, if any. Used to capture the entry an idempotent
   * re-registration displaces so it can be restored on a later failure.
   */
  private findExactWorkflowSubscriptionTarget(
    workflowRunId: string,
    taskId: string,
    nodeId: string,
    agentName: string,
    normalizedTopic: string,
    subscriptionKind: 'static' | 'dynamic'
  ): WorkflowSubscriptionTarget | undefined {
    return this.topicTrie
      .lookup(normalizedTopic)
      .find(
        (target): target is WorkflowSubscriptionTarget =>
          isWorkflowSubscriptionTarget(target) &&
          target.workflowRunId === workflowRunId &&
          target.taskId === taskId &&
          target.nodeId === nodeId &&
          target.agentName === agentName &&
          target.subscriptionKind === subscriptionKind &&
          (target.topic ?? '').toLowerCase() === normalizedTopic
      );
  }

  /**
   * Read-only diagnostic snapshot of a run's external-event subscriptions across
   * three layers (Task #908):
   *   1. `declared`  — static interests from the workflow definition (durable).
   *   2. `persisted` — dynamic rows from `space_workflow_event_subscriptions` (durable).
   *   3. `active`    — in-memory trie entries (live cross-check ONLY).
   *
   * The durable layers (1 + 2) are the source of truth; the trie (3) is never
   * the answer, only a sanity check — each active entry is reconciled against
   * durable state so declared-vs-active drift surfaces as `source: 'orphan'`,
   * and durable rows missing from the trie surface via `active: false` plus the
   * `mismatches` counts. For task #896 this returns "Coding node has no declared
   * PR-event interest" from durable data alone.
   *
   * `spaceId` guards cross-space access: a run in another space is rejected.
   *
   * `declaredNotActive` only fires when a static entry *should* be live — i.e.
   * the run's canonical task is non-terminal. For a terminal task
   * (`done`/`archived`/`cancelled`) `registerRunInterestsFromWorkflow`
   * deliberately clears static interests, so their `active: false` is expected
   * lifecycle cleanup, not drift (the count is suppressed there to keep the
   * headline signal honest for the common "investigate a finished run" case).
   */
  listSubscriptions(
    workflowRunId: string,
    spaceId: string,
    nodeId?: string
  ): { success: true; result: SubscriptionListResult } | { success: false; error: string } {
    const run = this.config.workflowRunRepo.getRun(workflowRunId);
    if (!run) {
      return { success: false, error: `Workflow run not found: ${workflowRunId}` };
    }
    if (run.spaceId !== spaceId) {
      return { success: false, error: `Workflow run ${workflowRunId} is not in this space.` };
    }
    const workflow = this.config.spaceWorkflowManager.getWorkflowForRun(run) ?? null;
    const definitionResolved = workflow !== null;
    const nodeFilter = nodeId ?? null;
    // Whether static interests should currently be materialized in the trie.
    // Mirrors registerRunInterestsFromWorkflow, which skips static re-materialization
    // when the canonical task is absent or terminal (its interests were cleared by the
    // task lifecycle). When false, declared `active: false` is expected, not drift.
    const canonicalTask = this.pickCanonicalTaskForRun(
      run,
      this.config.taskRepo.listByWorkflowRun(run.id)
    );
    const staticMaterializable =
      !!canonicalTask &&
      canonicalTask.status !== 'done' &&
      canonicalTask.status !== 'archived' &&
      canonicalTask.status !== 'cancelled';

    // Layer 1 — declared static interests, re-derived from the definition.
    const declared: SubscriptionDeclaredInterest[] = [];
    if (workflow) {
      for (const node of workflow.nodes) {
        if (nodeFilter && node.id !== nodeFilter) continue;
        let agents: ReturnType<typeof resolveNodeAgents>;
        try {
          agents = resolveNodeAgents(node);
        } catch {
          continue; // malformed node — nothing to declare.
        }
        for (const agent of agents) {
          for (const interest of agent.eventInterests ?? []) {
            const topic = typeof interest.topic === 'string' ? interest.topic : null;
            declared.push({
              nodeId: node.id,
              nodeName: node.name,
              agentName: agent.name,
              topic,
              topicFrom: interest.topicFrom ?? null,
              label: interest.label ?? null,
              // topicFrom interests are inert (no resolver yet) → never active.
              active: false,
            });
          }
        }
      }
    }

    // Layer 2 — persisted dynamic rows.
    const persisted: SubscriptionPersistedRow[] = this.workflowEventSubscriptionRepo
      .listByRun(workflowRunId)
      .filter((row) => !nodeFilter || row.nodeId === nodeFilter)
      .map((row) => ({
        nodeId: row.nodeId,
        agentName: row.agentName,
        taskId: row.taskId,
        topic: row.topic,
        createdAt: row.createdAt,
        updatedAt: row.updatedAt,
        active: false,
      }));

    // Layer 3 — active in-memory trie entries (workflow targets for this run).
    // values() walks the whole per-space trie, so this is O(total subscriptions
    // in the space); acceptable for an occasionally-invoked diagnostic. A
    // run-indexed trie structure can be added later if this is ever called in a
    // loop or spaces grow large.
    const active: SubscriptionActiveEntry[] = this.topicTrie
      .values()
      .filter(
        (target): target is WorkflowSubscriptionTarget =>
          isWorkflowSubscriptionTarget(target) &&
          target.workflowRunId === workflowRunId &&
          (!nodeFilter || target.nodeId === nodeFilter)
      )
      .map((target) => ({
        nodeId: target.nodeId,
        agentName: target.agentName,
        taskId: target.taskId,
        topic: target.topic ?? '',
        subscriptionKind: target.subscriptionKind ?? 'dynamic',
        source: 'orphan' as const,
      }));

    // Reconcile durable ↔ trie via normalized keys.
    //
    // Dynamic keys include the taskId so two tasks sharing a slot+topic can't
    // cross-match. Static declaration is slot-level (no task), but a static trie
    // entry only "effectively" backs a declaration when the definition loaded
    // (definitionResolved), the canonical task is non-terminal
    // (staticMaterializable), AND the entry belongs to the canonical task — a
    // duplicate/superseded task's static entry is stale. When the definition
    // itself is unavailable, a static entry's backing is unverifiable, reported
    // as `source: 'unknown'` (neither drift nor confirmed) rather than a false
    // `orphan`.
    const canonicalTaskId = canonicalTask?.id ?? null;
    const activeStaticKeys = new Set<string>();
    const activeDynamicKeys = new Set<string>();
    for (const entry of active) {
      if (entry.subscriptionKind === 'static') {
        if (
          definitionResolved &&
          staticMaterializable &&
          (!canonicalTaskId || entry.taskId === canonicalTaskId)
        ) {
          activeStaticKeys.add(
            subscriptionReconcileKey(entry.nodeId, entry.agentName, entry.topic)
          );
        }
      } else {
        activeDynamicKeys.add(
          subscriptionReconcileKey(entry.nodeId, entry.agentName, entry.topic, entry.taskId)
        );
      }
    }
    const declaredKeys = new Set<string>();
    for (const d of declared) {
      if (d.topic === null) continue; // topicFrom is not reconcilable yet.
      const key = subscriptionReconcileKey(d.nodeId, d.agentName, d.topic);
      declaredKeys.add(key);
      d.active = activeStaticKeys.has(key);
    }
    const persistedKeys = new Set<string>();
    for (const p of persisted) {
      const key = subscriptionReconcileKey(p.nodeId, p.agentName, p.topic, p.taskId);
      persistedKeys.add(key);
      p.active = activeDynamicKeys.has(key);
    }
    let orphanActive = 0;
    for (const entry of active) {
      if (entry.subscriptionKind === 'static') {
        if (!definitionResolved) {
          entry.source = 'unknown';
          continue; // declaration layer unavailable — can't classify, don't count
        }
        const canonicalOwned = !canonicalTaskId || entry.taskId === canonicalTaskId;
        const backed =
          staticMaterializable &&
          canonicalOwned &&
          declaredKeys.has(subscriptionReconcileKey(entry.nodeId, entry.agentName, entry.topic));
        entry.source = backed ? 'declared' : 'orphan';
        if (!backed) orphanActive += 1;
      } else {
        const backed = persistedKeys.has(
          subscriptionReconcileKey(entry.nodeId, entry.agentName, entry.topic, entry.taskId)
        );
        entry.source = backed ? 'persisted' : 'orphan';
        if (!backed) orphanActive += 1;
      }
    }

    return {
      success: true,
      result: {
        workflowRunId,
        nodeId: nodeFilter,
        definitionResolved,
        declared,
        persisted,
        active,
        mismatches: {
          // Only count as drift when a static entry should be live; for terminal
          // tasks static interests are intentionally cleared (see above).
          declaredNotActive: staticMaterializable
            ? declared.filter((d) => d.topic !== null && !d.active).length
            : 0,
          persistedNotActive: persisted.filter((p) => !p.active).length,
          orphanActive,
        },
      },
    };
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
    this.workflowEventSubscriptionRepo.deleteBySlotTopic(
      workflowRunId,
      taskId,
      nodeId,
      agentName,
      trimmed,
      'dynamic'
    );
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
    this.workflowEventSubscriptionRepo.deleteBySlot(workflowRunId, taskId, nodeId, agentName);
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
    this.workflowEventSubscriptionRepo.deleteByRun(workflowRunId);
    this.topicTrie.remove(
      (target) => isWorkflowSubscriptionTarget(target) && target.workflowRunId === workflowRunId
    );
    this.clearQueuedDeliveriesForRun(workflowRunId, 'run_terminal_cleanup');
  }

  /**
   * Like {@link clearRunInterests} but preserves agent-created `dynamic`
   * subscriptions. Used for a retryable task cancellation: the run's static and
   * runtime-auto interests are cleared (the task is no longer active), but a
   * reused worker session keeps the topics it registered via
   * `subscribe_external_event` so a later retry still receives them. A full
   * `clearRunInterests` (also dropping dynamic) is used for permanent teardown
   * (archive, space delete).
   */
  clearRunInterestsPreservingDynamic(workflowRunId: string): void {
    // Only the trie needs clearing: the durable table holds dynamic rows only,
    // which this path intentionally preserves for retry. Static interests are
    // not persisted.
    this.topicTrie.remove(
      (target) =>
        isWorkflowSubscriptionTarget(target) &&
        target.workflowRunId === workflowRunId &&
        target.subscriptionKind !== 'dynamic'
    );
    this.clearQueuedDeliveriesForRun(workflowRunId, 'run_terminal_cleanup');
  }

  /**
   * Remove only the trie interests belonging to a specific task (by taskId),
   * without affecting other tasks on the same run. Used when a noncanonical
   * duplicate task is cancelled or archived — the run-wide clear would
   * incorrectly strip the canonical task's subscriptions.
   */
  /**
   * Add a space to the synchronous delivery-hold cache so external events are
   * deferred (not injected) while the space is being stopped. Called by
   * stopActiveWork BEFORE its async task cleanup so a check_failed cannot
   * reactivate a task during the cleanup window.
   */
  holdSpaceDeliveries(spaceId: string): void {
    this.pausedSpaceIds.add(spaceId);
  }

  clearTaskInterests(taskId: string): void {
    this.workflowEventSubscriptionRepo.deleteByTask(taskId);
    this.topicTrie.remove(
      (target) => isWorkflowSubscriptionTarget(target) && target.taskId === taskId
    );
    this.clearQueuedDeliveriesForTask(taskId);
  }

  /**
   * Task-scoped variant that preserves dynamic subscriptions. Used for a
   * retryable cancellation: the cancelled task's static/auto interests are
   * cleared, but a reused worker session keeps its subscribe_external_event
   * topics for a potential retry.
   */
  clearTaskInterestsPreservingDynamic(taskId: string): void {
    // Trie-only: the durable table holds dynamic rows only, which this path
    // preserves for retry. Static interests are not persisted.
    this.topicTrie.remove(
      (target) =>
        isWorkflowSubscriptionTarget(target) &&
        target.taskId === taskId &&
        target.subscriptionKind !== 'dynamic'
    );
    this.clearQueuedDeliveriesForTask(taskId);
  }

  /**
   * Reset any blocked node executions for a run back to pending. Called by
   * direct resume paths that bypass the normal blocked → in_progress
   * transition so the tick loop
   * re-drives the recovered slot instead of short-circuiting through the
   * blocked-execution guard. Best-effort — errors are logged and swallowed.
   */
  resetBlockedExecutionsForRun(runId: string): void {
    try {
      const executions = this.config.nodeExecutionRepo.listByWorkflowRun(runId);
      for (const execution of executions) {
        if (execution.status !== 'blocked') continue;
        this.config.nodeExecutionRepo.update(execution.id, {
          status: 'pending',
          completedAt: null,
        });
      }
    } catch (err) {
      log.warn(
        `SpaceRuntime: resetBlockedExecutionsForRun failed for run ${runId}: ${formatCommandError(err)}`
      );
    }
  }

  /**
   * Expire retained published events past their TTL, then redispatch any
   * published events that still have no delivery rows so a newly-registered
   * subscription can pick them up. Public so the service can replay after a
   * run transitions to in_progress (e.g. a gate-open resume). Re-entrancy-safe:
   * when called from inside handleExternalEvent (e.g. via the blocked-run gate
   * hook), it defers to the post-handling flush so the in-flight event is not
   * re-handled before its delivery rows are registered. Idempotent.
   */
  redispatchRetainedExternalEvents(): void {
    if (this.externalEventHandlingDepth > 0) {
      // Don't set the deferred-flush flag on a stopped runtime — an in-flight
      // handler past the stop point shouldn't trigger a post-shutdown flush.
      if (!this.isStopped) {
        this.retainedEventRedispatchPending = true;
      }
      return;
    }
    this.expirePublishedExternalEventsPastTtl();
    this.redispatchPublishedEventsWithoutDeliveries();
  }

  flushPendingNodeQueue(target: WorkflowSubscriptionTarget, excludeDeliveryKey?: string): void {
    const prepared = this.preparePendingNodeQueueDispatchable(target, excludeDeliveryKey);
    if (!prepared) return;
    const { targetWithExecution, dispatchable } = prepared;

    let dispatched = 0;
    for (const item of dispatchable) {
      // A concurrent cleanup may have marked this delivery terminal while the
      // batch was being prepared. Skip dispatch rather than injecting into a
      // target that is no longer eligible. Also re-check the current trie: the
      // persisted delivery row can still be non-terminal if another identical
      // interest remains, but a queued in-memory item for this target must not
      // flush after its specific subscription was removed.
      const deliveryTerminal = this.config.externalEventStore?.isDeliveryTerminal(
        item.event.eventId,
        item.deliveryKey
      );
      const targetStillSubscribed = this.isTargetStillSubscribed(target, item.event.topic);
      if (deliveryTerminal || !targetStillSubscribed) {
        if (!deliveryTerminal && !targetStillSubscribed) {
          this.config.externalEventStore?.markDeliveryFailed(item.event.eventId, item.deliveryKey, {
            terminal: true,
            reason: 'subscription_no_longer_active',
          });
          this.config.externalEventStore?.markEventFailedIfAllDeliveriesTerminal(
            item.event.eventId
          );
        }
        this.clearExternalEventRetry(item.deliveryKey);
        continue;
      }
      this.clearExternalEventRetry(item.deliveryKey);
      dispatched += 1;
      void this.enqueueDeliverableExternalEvent(
        targetWithExecution,
        item.event,
        item.deliveryKey,
        item.deliveryMode,
        item.createdAt,
        true
      );
    }
    this.queueHealthMetrics.recordFlushAttempt(dispatched);
  }

  private async flushPendingNodeQueueAsync(
    target: WorkflowSubscriptionTarget,
    excludeDeliveryKey?: string,
    includeCurrent?: PendingExternalEvent
  ): Promise<void> {
    const prepared = this.preparePendingNodeQueueDispatchable(target, excludeDeliveryKey);
    if (!prepared) return;
    const { targetWithExecution, dispatchable } = prepared;

    if (includeCurrent) {
      dispatchable.push(includeCurrent);
    }

    if (dispatchable.length > 1) {
      dispatchable.sort((a, b) => a.createdAt - b.createdAt);
    }

    let dispatched = 0;
    for (const item of dispatchable) {
      // A concurrent cleanup (unregisterExecution, subscription removal, or
      // run terminalization) may have marked this delivery terminal while the
      // ordered batch was being prepared. Skip dispatch rather than injecting
      // an event into a target that is no longer eligible.
      const deliveryTerminal = this.config.externalEventStore?.isDeliveryTerminal(
        item.event.eventId,
        item.deliveryKey
      );
      const targetStillSubscribed = this.isTargetStillSubscribed(target, item.event.topic);
      if (deliveryTerminal || !targetStillSubscribed) {
        if (!deliveryTerminal && !targetStillSubscribed) {
          this.config.externalEventStore?.markDeliveryFailed(item.event.eventId, item.deliveryKey, {
            terminal: true,
            reason: 'subscription_no_longer_active',
          });
          this.config.externalEventStore?.markEventFailedIfAllDeliveriesTerminal(
            item.event.eventId
          );
        }
        this.clearExternalEventRetry(item.deliveryKey);
        continue;
      }
      this.clearExternalEventRetry(item.deliveryKey);
      dispatched += 1;
      await this.enqueueDeliverableExternalEvent(
        targetWithExecution,
        item.event,
        item.deliveryKey,
        item.deliveryMode,
        item.createdAt,
        true
      );
    }
    this.queueHealthMetrics.recordFlushAttempt(dispatched);
  }

  private preparePendingNodeQueueDispatchable(
    target: WorkflowSubscriptionTarget,
    excludeDeliveryKey?: string
  ): {
    targetWithExecution: WorkflowSubscriptionTarget;
    dispatchable: PendingExternalEvent[];
  } | null {
    if (!target.sessionId) return null;
    const targetWithExecution = this.resolveSubscriptionTarget(target);
    const key = this.buildQueueKey(target);
    const queued = this.pendingExternalEventQueue.get(key);
    const inMemoryDeliveryKeys = new Set(queued?.map((item) => item.deliveryKey) ?? []);

    // Collect dispatchable items from both in-memory queue and DB-persisted
    // pending deliveries into a single list so they can be sorted and
    // dispatched in chronological order.
    const dispatchable: PendingExternalEvent[] = [];

    if (queued) {
      this.pendingExternalEventQueue.delete(key);
      const now = Date.now();
      for (const item of queued) {
        if (item.deliveryKey === excludeDeliveryKey) continue;
        if (this.isQueuedExternalEventExpired(item, now)) {
          this.failQueuedDeliveryForTtl(item, key);
          continue;
        }
        dispatchable.push(item);
      }
    }

    this.collectPersistedPendingDeliveries(
      targetWithExecution,
      inMemoryDeliveryKeys,
      dispatchable,
      excludeDeliveryKey
    );

    if (dispatchable.length === 0) return { targetWithExecution, dispatchable };

    // Sort by createdAt so events from both sources are dispatched in
    // chronological order regardless of which queue held them. Uses stable
    // sort (default in modern JS engines) so items with the same createdAt
    // preserve their insertion order (FIFO from the in-memory queue).
    dispatchable.sort((a, b) => a.createdAt - b.createdAt);

    return { targetWithExecution, dispatchable };
  }

  private collectPersistedPendingDeliveries(
    target: WorkflowSubscriptionTarget,
    skipDeliveryKeys: Set<string>,
    dispatchable: PendingExternalEvent[],
    excludeDeliveryKey?: string
  ): void {
    const store = this.config.externalEventStore;
    if (!store || !target.sessionId) return;

    const deliveries = store
      .listPendingDeliveries(target.workflowRunId)
      .filter(
        (delivery) =>
          delivery.taskId === target.taskId &&
          delivery.nodeId === target.nodeId &&
          delivery.agentName === target.agentName &&
          delivery.deliveryKey !== excludeDeliveryKey &&
          !skipDeliveryKeys.has(delivery.deliveryKey) &&
          // Only flush deliveries that carry an explicit retryable
          // failureReason (e.g. `node_execution_not_active`). A `pending` row
          // with a null failureReason is still owned by its original dispatch
          // path and re-dispatching it here would duplicate delivery. The three
          // in-process owners of a null-failureReason pending row are:
          //   1. the in-memory pending queue (queueForPendingNode) — already
          //      drained by the caller and excluded via `skipDeliveryKeys`,
          //   2. an in-flight dispatch (externalEventDeliveriesInFlight), and
          //   3. a pending rate-limit digest (externalEventRateLimits.pendingDigest),
          //      for which this filter is the *only* guard against a duplicate.
          // Rows left pending+null by a crash/interruption are recovered by
          // requeuePersistedPendingDeliveries() on the next rehydrate, which
          // re-queues ALL pending rows (null or not) so none stay stranded.
          delivery.failureReason !== null
      )
      .map((delivery) => {
        const eventRecord = store.getById(delivery.eventId);
        return eventRecord ? { delivery, eventRecord } : null;
      })
      .filter((entry): entry is NonNullable<typeof entry> => entry !== null)
      .filter(({ eventRecord }) => eventRecord.state === 'published')
      .sort(
        (a, b) =>
          a.eventRecord.createdAt - b.eventRecord.createdAt ||
          a.delivery.updatedAt - b.delivery.updatedAt ||
          a.delivery.deliveryKey.localeCompare(b.delivery.deliveryKey)
      );

    for (const { delivery, eventRecord } of deliveries) {
      if (store.isDeliveryTerminal(delivery.eventId, delivery.deliveryKey)) continue;
      if (this.externalEventDeliveriesInFlight.has(delivery.deliveryKey)) {
        this.queueHealthMetrics.recordClaimConflict();
        log.debug('SpaceRuntime: external event delivery already in flight; skipped flush', {
          runId: delivery.workflowRunId,
          deliveryKey: delivery.deliveryKey,
        });
        continue;
      }
      if (!this.isTargetStillSubscribed(target, eventRecord.event.topic)) {
        store.markDeliveryFailed(delivery.eventId, delivery.deliveryKey, {
          terminal: true,
          reason: 'subscription_no_longer_active',
        });
        store.markEventFailedIfAllDeliveriesTerminal(delivery.eventId);
        this.clearExternalEventRetry(delivery.deliveryKey);
        log.debug('SpaceRuntime: external event delivery skipped — subscription removed', {
          runId: delivery.workflowRunId,
          deliveryKey: delivery.deliveryKey,
        });
        continue;
      }

      const mode = deliveryModeFromFailureReason(delivery.failureReason);
      const eventPayload = this.externalEventPayloadFromRecord(eventRecord.event);
      // TTL anchor is the event's creation/ingestion time, NOT the delivery
      // row's registration/updated time — see EXTERNAL_EVENT_QUEUE_TTL_MS.
      // A delivery registered late for an already-stale event must still
      // expire, so the event age (not the delivery age) drives the check.
      const queuedItem: PendingExternalEvent = {
        event: eventPayload,
        deliveryKey: delivery.deliveryKey,
        deliveryMode: mode,
        createdAt: eventRecord.createdAt,
      };
      if (this.isQueuedExternalEventExpired(queuedItem)) {
        this.failQueuedDeliveryForTtl(queuedItem, this.buildQueueKey(target));
        continue;
      }
      dispatchable.push(queuedItem);
    }
  }

  private async handleExternalEvent(payload: ExternalEventPublishedPayload): Promise<void> {
    this.externalEventHandlingDepth += 1;
    try {
      await this.handleExternalEventImpl(payload);
    } finally {
      this.externalEventHandlingDepth -= 1;
      if (this.externalEventHandlingDepth === 0 && this.retainedEventRedispatchPending) {
        this.retainedEventRedispatchPending = false;
        if (!this.isStopped) {
          this.redispatchRetainedExternalEvents();
        }
      }
    }
  }

  private async handleExternalEventImpl(payload: ExternalEventPublishedPayload): Promise<void> {
    const store = this.config.externalEventStore;
    if (!store) return;
    const matches = this.lookupSubscriptionTargets(payload.topic).filter((target) => {
      if (isLongHorizonSubscriptionTarget(target)) return target.spaceId === payload.spaceId;
      return this.isWorkflowTargetOwnedBySpace(target, payload.spaceId);
    });

    if (matches.length === 0) {
      // Keep unmatched events published for the bounded retention TTL. This is
      // connector-agnostic: any actor that registers a dynamic interest moments
      // after an external resource is created can replay the event that arrived
      // in the registration gap. The periodic TTL sweep terminalizes events that
      // never gain a matching interest, so this does not grow without bound.
      if (this.acceptingExternalEvents && this.isPublishedExternalEventExpired(payload)) {
        try {
          store.markEventFailed(payload.eventId, {
            terminal: true,
            reason: 'ttl_expired',
          });
        } catch (err) {
          log.warn(
            `SpaceRuntime: markEventFailed for ${payload.eventId} failed: ${err instanceof Error ? err.message : String(err)}`
          );
        }
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
      if (store.isDeliveryTerminal(payload.eventId, deliveryKey)) {
        continue;
      }
      if (this.externalEventDeliveriesInFlight.has(deliveryKey)) {
        this.queueHealthMetrics.recordClaimConflict();
        continue;
      }
      await this.deliverToLongHorizonAgent(target, payload, deliveryKey);
    }

    // If a reactive check_failed requires reactivation, perform the shared
    // task/run recovery ONCE before per-target delivery. This makes the reopen
    // atomic: every matching target then delivers against the already-in_progress
    // task instead of each target independently deciding to recover, which could
    // otherwise leave multiple slots handling one reactivation inconsistently.
    const reactivationTarget = [...workflowDeliveries.values()]
      .filter(
        ({ deliveryKey }) =>
          !store.isDeliveryTerminal(payload.eventId, deliveryKey) &&
          !this.externalEventDeliveriesInFlight.has(deliveryKey)
      )
      .map((entry) => entry.target)
      .find((target) => this.prepareExternalEventTask(target, payload).action === 'reactivate');
    if (reactivationTarget) {
      const task = this.config.taskRepo.getTask(reactivationTarget.taskId);
      if (task) {
        // Check-then-create: if a concurrent handler already started recovery for
        // this task, reuse its promise instead of overwriting. The finally only
        // deletes the entry when it is still ours, so a concurrent recovery's
        // entry is not prematurely removed.
        const existing = this.recoveryInFlight.get(task.id);
        if (existing) {
          await existing;
        } else {
          const recoveryPromise = (async () => {
            try {
              await this.recoverWorkflowBackedTask(task.spaceId, task.id, 'in_progress', {
                workflowNodeId: reactivationTarget.nodeId,
                agentName: reactivationTarget.agentName,
              });
            } catch (err) {
              log.warn(
                `SpaceRuntime: failed to reactivate task ${task.id} for event ${payload.eventId}: ${formatCommandError(err)}`
              );
            }
          })();
          this.recoveryInFlight.set(task.id, recoveryPromise);
          await recoveryPromise.finally(() => {
            this.recoveryInFlight.delete(task.id);
          });
        }
      }
    }

    for (const { target, deliveryKey } of workflowDeliveries.values()) {
      // Failure-aware cool-down: a delivery whose last dispatch failed
      // RECOVERABLY is skipped for a bounded window on FRESH dispatches (a newly
      // published or re-polled event). Without this, a session stuck in a
      // provider-error loop mints a fresh `failed` user-message row on every
      // source re-poll of the same event (each injection generates a new UUID).
      // The event stays `published` (delivery pending) and re-evaluates once the
      // window lifts; the core turn-recovery fix recovers the session in the
      // meantime. Keyed per-delivery so distinct events still flow (the burst
      // rate-limit / digest coalesces them) and only re-dispatches of an
      // already-failed delivery are gated. The bounded retry path
      // (scheduleExternalEventRetry) does NOT pass through here, so legitimate
      // transient-failure retries are unaffected. Terminal failures never arm
      // the cool-down.
      if (this.isDeliveryInDeliveryCooldown(deliveryKey)) {
        this.queueHealthMetrics.recordCooldownSkip();
        continue;
      }
      await this.deliverExternalEventToWorkflowTarget(target, payload, deliveryKey);
    }
  }

  /**
   * Deliver (or queue/retry) a single external-event payload to a specific
   * workflow subscription target. This is the per-target logic extracted from
   * handleExternalEvent so activation retries can be scoped to the original
   * delivery instead of replaying the entire event and re-computing matches.
   */
  private async deliverExternalEventToWorkflowTarget(
    target: WorkflowSubscriptionTarget,
    payload: ExternalEventPublishedPayload,
    deliveryKey: string
  ): Promise<void> {
    const store = this.config.externalEventStore;
    if (!store) return;
    // If a task reactivation (check_failed recovery) is in flight for this task,
    // await it before delivering — the executor/MCP-server restoration must finish
    // first to avoid injecting with stale or missing workflow tools.
    const pendingRecovery = this.recoveryInFlight.get(target.taskId);
    if (pendingRecovery) await pendingRecovery;
    // Re-resolve the target at retry/delivery time so a session that appeared
    // since the delivery was registered is picked up.
    const resolved = this.resolveSubscriptionTarget(target);
    try {
      if (store.isDeliveryTerminal(payload.eventId, deliveryKey)) {
        return;
      }
      if (this.externalEventDeliveriesInFlight.has(deliveryKey)) {
        this.queueHealthMetrics.recordClaimConflict();
        log.debug('SpaceRuntime: external event delivery already in flight; skipped dispatch', {
          runId: resolved.workflowRunId,
          deliveryKey,
        });
        return;
      }

      if (!this.isTargetStillSubscribed(resolved, payload.topic)) {
        store.markDeliveryFailed(payload.eventId, deliveryKey, {
          terminal: true,
          reason: 'subscription_no_longer_active',
        });
        store.markEventFailedIfAllDeliveriesTerminal(payload.eventId);
        this.clearExternalEventRetry(deliveryKey);
        this.clearQueuedDelivery(resolved, deliveryKey);
        return;
      }

      const taskDecision = await this.resolveExternalEventDelivery(resolved, payload);
      if (taskDecision.action === 'fail') {
        store.markDeliveryFailed(payload.eventId, deliveryKey, {
          terminal: true,
          reason: taskDecision.reason,
        });
        store.markEventFailedIfAllDeliveriesTerminal(payload.eventId);
        this.clearExternalEventRetry(deliveryKey);
        this.clearQueuedDelivery(resolved, deliveryKey);
        return;
      }
      if (taskDecision.action === 'hold') {
        this.queueHealthMetrics.recordPausedSpaceSkip();
        return;
      }

      const preparedTarget = taskDecision.target;
      const currentExecution = this.getCurrentQueueableOrActiveExecution(preparedTarget);
      // NOTE: a `pull_request.synchronize` event is intentionally NOT used to
      // refresh lastActivityAt here. It is a PR-level event that fans out to
      // EVERY subscribed target (coder + reviewer both subscribe to the run's
      // PR), so stamping on it would mark idle co-subscribers active and
      // suppress their stall nag. A node's OWN commit push is already captured
      // — the push is a tool call (`git`/`gh`) on that node's session, which
      // the sdk.toolUse activity source refreshes, correctly attributed to just
      // the pushing node. An external push (human/bot) is not agent activity.
      if (preparedTarget.sessionId && this.isTargetSessionLive(preparedTarget.sessionId)) {
        // pauseSpace does not terminate sessions, so a live in_progress session
        // would otherwise be injected now, defeating the pause. Skip injection
        // while the target's space is paused/stopped (sync cache updated via the
        // space pause/resume registers) — the delivery stays pending and is
        // requeued by onSpaceResumed. (Regressed by this PR's in_progress
        // auto-subscription, which now matches PR events during pause.)
        const targetRun = this.config.workflowRunRepo.getRun(preparedTarget.workflowRunId);
        if (targetRun && this.pausedSpaceIds.has(targetRun.spaceId)) {
          this.queueHealthMetrics.recordPausedSpaceSkip();
          // Persist the defer mode: onSpaceResumed requeues pending
          // deliveries and reconstructs a null failureReason as 'immediate',
          // which would steer the kickoff turn after resume.
          store.markDeliveryFailed(payload.eventId, deliveryKey, {
            terminal: false,
            reason: 'deliveryMode:defer; space_paused',
          });
          return;
        }
        const eventRecord = store.getById(payload.eventId);
        // Normalize a stale persisted 'interrupted' state (daemon crash
        // between setInterrupted and setIdle) to idle first: the inject layer
        // treats 'interrupted' as busy, so a defer handoff against it would
        // persist a row nothing replays.
        await this.normalizeStaleInterruptedSession(preparedTarget.sessionId);
        // A session mid-interrupt cannot replay a deferred row (P2): park the
        // delivery and retry once the interrupt resolves to a true idle.
        if (
          this.parkDeliveryForInterruptedSession(
            preparedTarget,
            payload,
            deliveryKey,
            eventRecord?.createdAt ?? Date.now()
          )
        ) {
          return;
        }
        // External events ALWAYS deliver on the "next" boundary: insert when
        // idle, defer/queue when busy and deliver at the next idle point — never
        // inject mid-work. Force 'defer' and let the inject layer
        // (injectMessageIntoSession) decide idle→deliver-now vs busy→replay-at-
        // idle. resolveIncludeCurrentDeliveryMode defaulted to 'immediate' for
        // fresh deliveries, which derailed an actively-processing session.
        // Known gap deferred to message-delivery-v2 (task #951): the replayed
        // turn's completion is not tracked by the node execution (the one-shot
        // completion callback fires on the pre-replay idle).
        await this.flushPendingNodeQueueAsync(preparedTarget, deliveryKey, {
          event: payload,
          deliveryKey,
          deliveryMode: 'defer',
          createdAt: eventRecord?.createdAt ?? Date.now(),
        });
      } else if (preparedTarget.sessionId) {
        // The session captured at spawn is no longer live (worker crashed or
        // was superseded) — defer the delivery rather than injecting into a
        // dead session. Counts as a stale-session skip for queue health.
        this.queueHealthMetrics.recordStaleSessionSkip();
        const eventRecord = store.getById(payload.eventId);
        await this.flushPendingNodeQueueAsync(preparedTarget, deliveryKey, {
          event: payload,
          deliveryKey,
          deliveryMode: 'defer',
          createdAt: eventRecord?.createdAt ?? Date.now(),
        });
      } else if (
        currentExecution?.status === 'pending' ||
        currentExecution?.status === 'waiting_rebind'
      ) {
        const eventRecord = store.getById(payload.eventId);
        // Queue in 'defer' mode: the stored mode is forwarded unchanged at
        // flush time, and an 'immediate' item flushed into an
        // already-processing session would steer it mid-turn — violating the
        // never-inject-mid-work intent. Defer is a no-op difference for a
        // fresh idle session (defer + idle delivers now).
        this.queueForPendingNode(
          preparedTarget,
          payload,
          deliveryKey,
          'defer',
          eventRecord?.createdAt ?? Date.now()
        );
        // Mark the persisted delivery with the defer-encoded reason (not
        // markFailure:false): after a daemon restart the in-memory queue is
        // gone and requeuePersistedPendingDeliveries reconstructs the mode
        // via deliveryModeFromFailureReason. The explicit defer marker keeps
        // the intent legible even though recovery's default is also defer.
        this.scheduleActivationRetry(
          preparedTarget,
          payload,
          deliveryKey,
          'deliveryMode:defer; node_execution_pending',
          {
            preserveAttemptCount: true,
          }
        );
      } else {
        let activatedTarget: WorkflowSubscriptionTarget | null = null;
        try {
          activatedTarget = await this.activateSubscribedTargetForExternalEvent(preparedTarget);
        } catch (err) {
          const failureReason = err instanceof Error ? err.message : String(err);
          const eventRecord = store.getById(payload.eventId);
          this.queueForPendingNode(
            resolved,
            payload,
            deliveryKey,
            'defer',
            eventRecord?.createdAt ?? Date.now()
          );
          this.scheduleActivationRetry(
            resolved,
            payload,
            deliveryKey,
            // Defer-encoded prefix so a daemon restart before the retry
            // succeeds reconstructs 'defer' explicitly (recovery's default
            // is also defer; the marker documents the queued intent).
            `deliveryMode:defer; activation_failed; ${failureReason}`
          );
          return;
        }
        if (activatedTarget?.sessionId && this.isTargetSessionLive(activatedTarget.sessionId)) {
          const eventRecord = store.getById(payload.eventId);
          // Same stale-state normalization as the pre-activation branch above.
          await this.normalizeStaleInterruptedSession(activatedTarget.sessionId);
          // Same mid-interrupt park as the pre-activation branch above (P2).
          if (
            this.parkDeliveryForInterruptedSession(
              activatedTarget,
              payload,
              deliveryKey,
              eventRecord?.createdAt ?? Date.now()
            )
          ) {
            return;
          }
          await this.flushPendingNodeQueueAsync(activatedTarget, deliveryKey, {
            event: payload,
            deliveryKey,
            // Always defer to the next idle boundary — see the pre-activation
            // live-session branch above for rationale (never inject mid-work).
            deliveryMode: 'defer',
            createdAt: eventRecord?.createdAt ?? Date.now(),
          });
        } else if (activatedTarget?.sessionId) {
          // Activation returned a session that is already non-live (worker died
          // during activation) — defer the delivery. Same stale-session path as
          // the pre-activation branch above; record the skip for queue health.
          this.queueHealthMetrics.recordStaleSessionSkip();
          const eventRecord = store.getById(payload.eventId);
          await this.flushPendingNodeQueueAsync(activatedTarget, deliveryKey, {
            event: payload,
            deliveryKey,
            deliveryMode: 'defer',
            createdAt: eventRecord?.createdAt ?? Date.now(),
          });
        } else if (activatedTarget) {
          store.markDeliveryFailed(payload.eventId, deliveryKey, {
            terminal: false,
            // Defer-encoded so a daemon restart reconstructs 'defer'
            // explicitly (recovery's default is also defer).
            reason: 'deliveryMode:defer; node_execution_not_active',
          });
          // The persisted retryable delivery plus the activation retry timer
          // are sufficient; do not duplicate it in the in-memory queue.
          // In-memory items use queue-time ordering, which would break the
          // chronological ordering between persisted pending deliveries.
          if (!(await this.isTargetSpacePausedOrStopped(activatedTarget))) {
            this.scheduleActivationRetry(
              activatedTarget,
              payload,
              deliveryKey,
              'deliveryMode:defer; node_execution_not_active'
            );
          }
        } else {
          const eventRecord = store.getById(payload.eventId);
          this.queueForPendingNode(
            resolved,
            payload,
            deliveryKey,
            'defer',
            eventRecord?.createdAt ?? Date.now()
          );
          if (!(await this.isTargetSpacePausedOrStopped(resolved))) {
            this.scheduleActivationRetry(
              resolved,
              payload,
              deliveryKey,
              // Defer-encoded — same restart-recovery rationale as above.
              'deliveryMode:defer; node_execution_not_active'
            );
          }
        }
      }
    } catch (err) {
      log.warn(
        `SpaceRuntime: failed to process external event ${payload.eventId} for ` +
          `${resolved.workflowRunId}/${resolved.nodeId}/${resolved.agentName}: ${formatCommandError(err)}`
      );
    }
  }

  private async isTargetSpacePausedOrStopped(target: WorkflowSubscriptionTarget): Promise<boolean> {
    const task = this.config.taskRepo.getTask(target.taskId);
    if (!task) return true;
    const space = await this.config.spaceManager.getSpace(task.spaceId);
    return !space || space.paused || space.stopped;
  }

  private async activateSubscribedTargetForExternalEvent(
    target: WorkflowSubscriptionTarget
  ): Promise<WorkflowSubscriptionTarget | null> {
    const task = this.config.taskRepo.getTask(target.taskId);
    const run = this.config.workflowRunRepo.getRun(target.workflowRunId);
    if (
      !task ||
      !run ||
      task.workflowRunId !== run.id ||
      task.spaceId !== run.spaceId ||
      task.status === 'cancelled' ||
      task.status === 'archived'
    ) {
      return null;
    }
    // Guard against spurious activation of slots that are not meaningfully
    // activatable from an event. These are availability decisions (not task
    // lifecycle): a cancelled execution is a permanently finished slot, a
    // blocked execution is owned by the blocked-run recovery path, and a
    // target with no execution history is a workflow node that has not been
    // reached by normal progression (queue for it instead of pre-spawning).
    if (this.hasTerminalExecutionForTarget(target)) return null;
    const currentExecution = this.getCurrentQueueableOrActiveExecution(target);
    if (currentExecution?.status === 'blocked') return null;
    if (!this.hasAnyExecutionForTarget(target)) return null;
    const space = await this.config.spaceManager.getSpace(task.spaceId);
    if (!space || space.paused || space.stopped) return target;
    const activate = this.config.taskAgentManager?.activateTargetSessionsForMessage;
    if (!activate) return null;

    const activated = await activate.call(
      this.config.taskAgentManager,
      target.taskId,
      target.workflowRunId,
      target.agentName,
      {
        reopenReason: `external event delivery to subscribed agent "${target.agentName}"`,
        reopenBy: 'external-event',
        workflowNodeId: target.nodeId,
      }
    );
    // If activation timed out or could not produce a session, return the target
    // so the caller queues the event and schedules a bounded activation retry.
    // Returning null here would strand the event in the pending queue with no
    // retry timer.
    if (activated.length === 0) return target;

    return this.resolveSubscriptionTarget(target);
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
        message: formatExternalEventEssence(event),
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
      // Prefix with a retry-exhaustion marker so the queue-health categorizer
      // recognizes these as retry_exhausted regardless of the underlying error
      // message (which may be an arbitrary thrown string from the injected
      // long-horizon delivery fn, not one of the enumerated literals).
      this.config.externalEventStore?.markDeliveryFailed(event.eventId, deliveryKey, {
        terminal: true,
        reason: `retry_exhausted; ${failureReason}`,
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
        this.queueHealthMetrics.recordClaimConflict();
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
    const store = this.config.externalEventStore;
    if (
      !store ||
      store.isDeliveryTerminal(event.eventId, deliveryKey) ||
      this.externalEventDeliveriesInFlight.has(deliveryKey)
    ) {
      return;
    }
    // Claim synchronously so a concurrent flush cannot re-select the same
    // persisted delivery while this path is paused on the lifecycle check.
    this.externalEventDeliveriesInFlight.add(deliveryKey);
    let retainClaim = false;
    try {
      if (!this.isTargetStillSubscribed(target, event.topic)) {
        store.markDeliveryFailed(event.eventId, deliveryKey, {
          terminal: true,
          reason: 'subscription_no_longer_active',
        });
        store.markEventFailedIfAllDeliveriesTerminal(event.eventId);
        this.clearExternalEventRetry(deliveryKey);
        this.clearQueuedDelivery(target, deliveryKey);
        return;
      }

      // Rate-limit accounting is synchronous so the digest timer is armed before
      // any awaited lifecycle check — otherwise the timer registration would slip
      // past a caller's flush-wait macrotask. The digest path applies the task
      // lifecycle check itself in deliverDigestToSession.
      const now = Date.now();
      const rateLimitKey = this.buildRateLimitKey(target);
      const state = this.getExternalEventRateLimitState(rateLimitKey);
      state.timestamps = state.timestamps.filter(
        (timestamp) => now - timestamp < EXTERNAL_EVENT_RATE_WINDOW_MS
      );
      state.timestamps.push(now);
      if (state.timestamps.length > EXTERNAL_EVENT_RATE_LIMIT_PER_MIN) {
        state.pendingDigest.push({
          target,
          event,
          deliveryKey,
          deliveryMode,
          createdAt,
          allowTargetSessionFallback,
        });
        // The digest path retains the claim until deliverDigestToSession runs.
        retainClaim = true;
        if (!state.digestTimer) {
          state.digestTimer = setTimeout(() => {
            state.digestTimer = null;
            void this.flushExternalEventDigest(rateLimitKey);
          }, 0);
        }
        return;
      }

      // Immediate path: apply the synchronous task-lifecycle decision so the
      // common `deliver` case reaches deliverToSession without an awaited lookup
      // (the flush path observes injections synchronously). `reactivate` (a done
      // task receiving a check_failed) is the only async case — handle it on a
      // detached continuation so it cannot block or reorder synchronous dispatch.
      const taskDecision = this.prepareExternalEventTask(target, event);
      if (taskDecision.action === 'fail') {
        store.markDeliveryFailed(event.eventId, deliveryKey, {
          terminal: true,
          reason: taskDecision.reason,
        });
        store.markEventFailedIfAllDeliveriesTerminal(event.eventId);
        this.clearExternalEventRetry(deliveryKey);
        this.clearQueuedDelivery(target, deliveryKey);
        return;
      }
      if (taskDecision.action === 'hold') {
        this.queueHealthMetrics.recordPausedSpaceSkip();
        this.queueForPendingNode(target, event, deliveryKey, deliveryMode, createdAt);
        return;
      }
      if (taskDecision.action === 'reactivate') {
        // The claim is retained across the async recovery; the helper releases it.
        retainClaim = true;
        void this.deliverReactivatedExternalEvent(
          target,
          event,
          deliveryKey,
          deliveryMode,
          createdAt,
          rateLimitKey
        );
        return;
      }

      // action === 'deliver'
      await this.deliverToSession(target, event, deliveryKey, deliveryMode, createdAt);
      this.scheduleExternalEventRateLimitCleanup(rateLimitKey);
    } finally {
      if (!retainClaim) this.externalEventDeliveriesInFlight.delete(deliveryKey);
    }
  }

  /**
   * Reactivate a done task for a reactive PR check_failed event and then deliver
   * it. Runs detached from the synchronous flush path so reactivation never
   * blocks or reorders synchronous dispatch. Owns (and releases) the in-flight
   * delivery claim acquired by {@link enqueueDeliverableExternalEvent}.
   */
  private async deliverReactivatedExternalEvent(
    target: WorkflowSubscriptionTarget,
    event: ExternalEventPublishedPayload,
    deliveryKey: string,
    deliveryMode: 'immediate' | 'defer',
    createdAt: number,
    rateLimitKey: string
  ): Promise<void> {
    const store = this.config.externalEventStore;
    try {
      if (!store) return;
      const task = this.config.taskRepo.getTask(target.taskId);
      if (!task) {
        store.markDeliveryFailed(event.eventId, deliveryKey, {
          terminal: true,
          reason: 'invalid_target_ownership',
        });
        store.markEventFailedIfAllDeliveriesTerminal(event.eventId);
        this.clearExternalEventRetry(deliveryKey);
        this.clearQueuedDelivery(target, deliveryKey);
        return;
      }
      // Check-then-create recoveryInFlight so concurrent deliveries for the
      // same task await this recovery before injecting.
      const existingRecovery = this.recoveryInFlight.get(task.id);
      if (existingRecovery) {
        await existingRecovery;
        // Recheck recovery success: the shared promise may have failed (task
        // still done). Terminalize this delivery if the task wasn't reopened.
        const afterShared = this.config.taskRepo.getTask(target.taskId);
        if (!afterShared || afterShared.status === 'done') {
          store.markDeliveryFailed(event.eventId, deliveryKey, {
            terminal: true,
            reason: 'target_task_reactivation_failed',
          });
          store.markEventFailedIfAllDeliveriesTerminal(event.eventId);
          this.clearExternalEventRetry(deliveryKey);
          this.clearQueuedDelivery(target, deliveryKey);
          return;
        }
      } else {
        const recoveryPromise = (async () => {
          try {
            await this.recoverWorkflowBackedTask(task.spaceId, task.id, 'in_progress', {
              workflowNodeId: target.nodeId,
              agentName: target.agentName,
            });
          } catch (err) {
            log.warn(
              `SpaceRuntime: failed to reactivate task ${task.id} for check failure ${event.eventId}: ${formatCommandError(err)}`
            );
          }
        })();
        this.recoveryInFlight.set(task.id, recoveryPromise);
        await recoveryPromise.finally(() => {
          this.recoveryInFlight.delete(task.id);
        });
        // If recovery failed, the task is still done — terminalize.
        const recoveredTask = this.config.taskRepo.getTask(target.taskId);
        if (!recoveredTask || recoveredTask.status === 'done') {
          store.markDeliveryFailed(event.eventId, deliveryKey, {
            terminal: true,
            reason: 'target_task_reactivation_failed',
          });
          store.markEventFailedIfAllDeliveriesTerminal(event.eventId);
          this.clearExternalEventRetry(deliveryKey);
          this.clearQueuedDelivery(target, deliveryKey);
          return;
        }
      }
      // The recovery await is a cancel/archive/pause race window: re-validate
      // ownership, lifecycle, subscription, and paused state on the refreshed
      // target before delivering or queueing.
      const rechecked = this.revalidateRecoveredTarget(target, event);
      if (rechecked.action === 'fail') {
        store.markDeliveryFailed(event.eventId, deliveryKey, {
          terminal: true,
          reason: rechecked.reason,
        });
        store.markEventFailedIfAllDeliveriesTerminal(event.eventId);
        this.clearExternalEventRetry(deliveryKey);
        this.clearQueuedDelivery(target, deliveryKey);
        return;
      }
      if (rechecked.action === 'hold') {
        this.queueHealthMetrics.recordPausedSpaceSkip();
        const eventRecord = store.getById(event.eventId);
        this.queueForPendingNode(
          target,
          event,
          deliveryKey,
          deliveryMode,
          eventRecord?.createdAt ?? createdAt
        );
        return;
      }
      const refreshed = rechecked.target;
      if (refreshed.sessionId && this.isTargetSessionLive(refreshed.sessionId)) {
        // Same stale-state normalization + mid-interrupt park as the fresh
        // live-session branches: a check_failed reactivation can land while
        // the target session is mid-interrupt, where a defer handoff would
        // be marked delivered with nothing owning the row's replay (and a
        // recovered immediate row would restart the interrupted session).
        await this.normalizeStaleInterruptedSession(refreshed.sessionId);
        if (this.parkDeliveryForInterruptedSession(refreshed, event, deliveryKey, createdAt)) {
          return;
        }
        await this.deliverToSession(refreshed, event, deliveryKey, deliveryMode, createdAt);
      } else {
        // Recovery resets the finished execution to pending with no live session.
        // Queue the event and schedule an activation retry so it is delivered once
        // the recovered slot spawns, instead of stranding the persisted delivery
        // with no in-memory owner until a daemon restart.
        const eventRecord = store.getById(event.eventId);
        this.queueForPendingNode(
          refreshed,
          event,
          deliveryKey,
          deliveryMode,
          eventRecord?.createdAt ?? createdAt
        );
        if (!(await this.isTargetSpacePausedOrStopped(refreshed))) {
          this.scheduleActivationRetry(
            refreshed,
            event,
            deliveryKey,
            // Encode the recovered mode so a daemon restart reconstructs it
            // faithfully: only the explicit immediate marker recovers
            // 'immediate'; everything else (defer marker, bare, null)
            // recovers the defer default.
            `deliveryMode:${deliveryMode}; node_execution_not_active`
          );
        }
      }
      this.scheduleExternalEventRateLimitCleanup(rateLimitKey);
    } finally {
      this.externalEventDeliveriesInFlight.delete(deliveryKey);
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
    const dispatchable: ExternalEventDigestItem[] = [];
    for (const item of items) {
      if (store.isDeliveryTerminal(item.event.eventId, item.deliveryKey)) {
        this.externalEventDeliveriesInFlight.delete(item.deliveryKey);
        continue;
      }
      if (!this.isTargetStillSubscribed(item.target, item.event.topic)) {
        store.markDeliveryFailed(item.event.eventId, item.deliveryKey, {
          terminal: true,
          reason: 'subscription_no_longer_active',
        });
        store.markEventFailedIfAllDeliveriesTerminal(item.event.eventId);
        this.externalEventDeliveriesInFlight.delete(item.deliveryKey);
        continue;
      }
      const taskDecision = this.prepareExternalEventTask(item.target, item.event);
      if (taskDecision.action === 'fail') {
        store.markDeliveryFailed(item.event.eventId, item.deliveryKey, {
          terminal: true,
          reason: taskDecision.reason,
        });
        store.markEventFailedIfAllDeliveriesTerminal(item.event.eventId);
        this.externalEventDeliveriesInFlight.delete(item.deliveryKey);
        continue;
      }
      if (taskDecision.action === 'hold') {
        this.queueHealthMetrics.recordPausedSpaceSkip();
        this.preservePendingDigestItem(item);
        this.externalEventDeliveriesInFlight.delete(item.deliveryKey);
        continue;
      }
      if (taskDecision.action === 'reactivate') {
        // A done task reactivating on a check_failed is rare in the rate-limited
        // digest path; route it through the detached reactivation delivery rather
        // than recovering inline (which would block the digest batch). Keep the
        // in-flight claim held — the detached helper owns and releases it in its
        // finally, so a concurrent flush cannot re-select and double-deliver.
        void this.deliverReactivatedExternalEvent(
          item.target,
          item.event,
          item.deliveryKey,
          item.deliveryMode,
          item.createdAt,
          this.buildRateLimitKey(item.target)
        );
        continue;
      }
      dispatchable.push(item);
    }
    if (dispatchable.length === 0) return;
    items = dispatchable;
    const target = this.resolveDigestDeliveryTarget(items[0]!);
    // Don't inject a digest while the target's space is paused (digests
    // scheduled before the pause bypass the fresh-delivery guard). Requeue the
    // items as pending — onSpaceResumed requeues them when the space resumes.
    const pausedRun = target.workflowRunId
      ? this.config.workflowRunRepo.getRun(target.workflowRunId)
      : null;
    const spacePaused = !!(pausedRun && this.pausedSpaceIds.has(pausedRun.spaceId));
    if (!target.sessionId || spacePaused) {
      const sessionLoss = !target.sessionId;
      const reason = spacePaused ? 'space_paused' : 'session loss';
      for (const item of items) {
        if (sessionLoss) this.queueHealthMetrics.recordStaleSessionSkip();
        else this.queueHealthMetrics.recordPausedSpaceSkip();
        store.markDeliveryFailed(item.event.eventId, item.deliveryKey, {
          terminal: false,
          reason: `deliveryMode:${item.deliveryMode}; digest requeued after ${reason}`,
        });
        this.queueForPendingNode(
          item.target,
          item.event,
          item.deliveryKey,
          item.deliveryMode,
          item.createdAt
        );
        // Release the synchronous digest-path claim acquired in
        // enqueueDeliverableExternalEvent; the item is back in the pending
        // queue and will be re-claimed on the next flush.
        this.externalEventDeliveriesInFlight.delete(item.deliveryKey);
      }
      if (sessionLoss) {
        log.debug('SpaceRuntime: external event digest requeued — target session not live', {
          runId: target.workflowRunId,
          count: items.length,
        });
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
      const digestMessage = this.formatExternalEventDigestMessage(items);
      const result = await this.config.commandBus.dispatch('agent.message.inject', {
        sessionId: target.sessionId,
        message: digestMessage,
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
    const liveTarget = this.resolveLiveDeliveryTarget({
      workflowRunId: target.workflowRunId,
      taskId: target.taskId,
      nodeId: target.nodeId,
      agentName: target.agentName,
    });
    if (liveTarget?.sessionId) return liveTarget;
    // No current worker session for this node. The activation flush's
    // allowTargetSessionFallback may fall back to the sessionId captured at
    // spawn time — but only when that session is still live. A superseded
    // (dead) activation session must never receive the digest; returning a
    // sessionless target makes deliverDigestToSession requeue the items as
    // pending for the next activation.
    if (
      item.allowTargetSessionFallback &&
      target.sessionId &&
      this.isTargetSessionLive(target.sessionId)
    ) {
      return target;
    }
    return {
      workflowRunId: target.workflowRunId,
      taskId: target.taskId,
      nodeId: target.nodeId,
      agentName: target.agentName,
    };
  }

  private async deliverToSession(
    target: WorkflowSubscriptionTarget,
    event: ExternalEventPublishedPayload,
    deliveryKey: string,
    deliveryMode: 'immediate' | 'defer',
    fallbackCreatedAt?: number
  ): Promise<void> {
    const store = this.config.externalEventStore;
    if (!store || !target.sessionId) return;
    // Don't inject into a live session while the target's space is paused.
    // This is the final injection point for retries/digests scheduled before a
    // pause that bypass the fresh-delivery guard in deliverExternalEventToWorkflowTarget;
    // leaving the persisted delivery pending lets onSpaceResumed requeue it.
    const pausedRun = this.config.workflowRunRepo.getRun(target.workflowRunId);
    if (pausedRun && this.pausedSpaceIds.has(pausedRun.spaceId)) {
      this.queueHealthMetrics.recordPausedSpaceSkip();
      return;
    }
    this.externalEventDeliveriesInFlight.add(deliveryKey);
    try {
      if (!this.config.commandBus) {
        throw new MissingCommandHandlerError('agent.message.inject');
      }
      const result = await this.config.commandBus.dispatch('agent.message.inject', {
        sessionId: target.sessionId,
        message: formatExternalEventEssence(event),
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
      // Recoverable dispatch failure — arm the per-delivery cool-down so a
      // source re-poll of this same event skips re-injection (no fresh `failed`
      // row) while the bounded retry path below still drives recovery.
      this.armDeliveryCooldown(deliveryKey);
      const queued = this.getQueuedDelivery(target, deliveryKey);
      this.queueForRetry(
        target,
        event,
        deliveryKey,
        deliveryMode,
        failureReason,
        queued?.createdAt ?? fallbackCreatedAt
      );
    } finally {
      this.externalEventDeliveriesInFlight.delete(deliveryKey);
    }
  }

  private scheduleActivationRetry(
    target: WorkflowSubscriptionTarget,
    event: ExternalEventPublishedPayload,
    deliveryKey: string,
    failureReason: string,
    options: { preserveAttemptCount?: boolean; markFailure?: boolean } = {}
  ): void {
    if (this.externalEventRetryTimers.has(deliveryKey)) return;
    let attempts = this.externalEventRetryCounts.get(deliveryKey) ?? 0;
    if (!options.preserveAttemptCount) {
      attempts += 1;
      this.externalEventRetryCounts.set(deliveryKey, attempts);
    }
    if (options.markFailure !== false) {
      this.config.externalEventStore?.markDeliveryFailed(event.eventId, deliveryKey, {
        terminal: attempts > EXTERNAL_EVENT_RETRY_MAX_ATTEMPTS,
        reason: failureReason,
      });
    }
    if (attempts > EXTERNAL_EVENT_RETRY_MAX_ATTEMPTS) {
      this.config.externalEventStore?.markEventFailedIfAllDeliveriesTerminal(event.eventId);
      this.clearExternalEventRetry(deliveryKey);
      this.clearQueuedDelivery(target, deliveryKey);
      return;
    }
    const timer = setTimeout(() => {
      this.externalEventRetryTimers.delete(deliveryKey);
      if (this.config.externalEventStore?.isDeliveryTerminal(event.eventId, deliveryKey)) {
        this.clearExternalEventRetry(deliveryKey);
        return;
      }
      const eventRecord = this.config.externalEventStore?.getById(event.eventId);
      const queuedItem = this.getQueuedDelivery(target, deliveryKey) ?? {
        event,
        deliveryKey,
        deliveryMode: 'immediate',
        createdAt: eventRecord?.createdAt ?? Date.now(),
      };
      // The event record is the authoritative TTL anchor; a queued item created
      // before the event was backdated (or with a stale clock) must still expire
      // when the underlying event is older than the TTL window.
      const ttlAnchor = eventRecord?.createdAt ?? queuedItem.createdAt;
      if (this.isQueuedExternalEventExpired({ ...queuedItem, createdAt: ttlAnchor })) {
        this.failQueuedDeliveryForTtl(
          { ...queuedItem, createdAt: ttlAnchor },
          this.buildQueueKey(target)
        );
        return;
      }
      void this.deliverExternalEventToWorkflowTarget(target, event, deliveryKey);
    }, EXTERNAL_EVENT_RETRY_DELAY_MS);
    this.externalEventRetryTimers.set(deliveryKey, timer);
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
        this.queueHealthMetrics.recordClaimConflict();
        this.scheduleExternalEventRetry(target, event, deliveryKey, deliveryMode, failureReason, {
          preserveAttemptCount: true,
          createdAt: options.createdAt,
        });
        return;
      }
      const eventRecord = this.config.externalEventStore?.getById(event.eventId);
      const queued = this.getQueuedDelivery(target, deliveryKey);
      const queuedItem = queued ?? {
        event,
        deliveryKey,
        deliveryMode,
        createdAt: eventRecord?.createdAt ?? options.createdAt ?? Date.now(),
      };
      // The event record is the authoritative TTL anchor; prefer it over an
      // in-memory queued item that may carry a stale queue-time timestamp.
      const ttlAnchor = eventRecord?.createdAt ?? queuedItem.createdAt;
      if (this.isQueuedExternalEventExpired({ ...queuedItem, createdAt: ttlAnchor })) {
        this.failQueuedDeliveryForTtl(
          { ...queuedItem, createdAt: ttlAnchor },
          this.buildQueueKey(target)
        );
        return;
      }
      void this.deliverExternalEventToWorkflowTarget(target, event, deliveryKey);
    }, EXTERNAL_EVENT_RETRY_DELAY_MS);
    this.externalEventRetryTimers.set(deliveryKey, timer);
  }

  private rescheduleQueuedExternalEventRetries(): void {
    for (const [queueKey, queue] of Array.from(this.pendingExternalEventQueue.entries())) {
      const target = parseSubscriptionQueueKey(queueKey);
      if (!target) continue;
      for (const item of queue) {
        const eventRecord = this.config.externalEventStore?.getById(item.event.eventId);
        const ttlAnchor = eventRecord?.createdAt ?? item.createdAt;
        if (this.isQueuedExternalEventExpired({ ...item, createdAt: ttlAnchor })) {
          this.failQueuedDeliveryForTtl({ ...item, createdAt: ttlAnchor }, queueKey);
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
          { preserveAttemptCount: true, createdAt: ttlAnchor }
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
    // These items are rehoused from the rate-limit digest (they bypassed
    // queueForPendingNode), so count the enqueue here to keep the cumulative
    // counter consistent with the live queueDepth gauge.
    this.queueHealthMetrics.recordEnqueue(
      item.event.source,
      this.describeEnqueueTargetState(item.target)
    );
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
    this.queueHealthMetrics.recordEnqueue(event.source, this.describeEnqueueTargetState(target));
  }

  /**
   * Describe the target's run + node-execution state at enqueue time, for the
   * queue-health `enqueueByTargetState` breakdown. Surfaces which states force
   * an event to be queued rather than delivered immediately (e.g. an
   * `in_progress` run whose node is still `pending`, or a `blocked` run).
   */
  private describeEnqueueTargetState(target: WorkflowSubscriptionTarget): string {
    const run = this.config.workflowRunRepo.getRun(target.workflowRunId);
    const nodeStatus = this.getCurrentQueueableOrActiveExecution(target)?.status ?? 'none';
    return `run=${run?.status ?? 'unknown'};node=${nodeStatus}`;
  }

  /**
   * Aggregate health snapshot for the pending external-event delivery queue,
   * surfaced to operators/debug views. Merges cumulative counters (enqueue,
   * flush, skips, delivered, failures by reason) with live gauges (depth, age,
   * in-flight, digest backlog) computed from this runtime's in-memory state and
   * the durable store. Counters are process-lifetime and reset on restart.
   */
  getQueueHealthSnapshot(): QueueHealthSnapshot {
    const now = Date.now();
    let queueDepth = 0;
    const inMemoryAges: number[] = [];
    for (const queue of this.pendingExternalEventQueue.values()) {
      queueDepth += queue.length;
      for (const item of queue) inMemoryAges.push(now - item.createdAt);
    }
    let digestBacklog = 0;
    for (const state of this.externalEventRateLimits.values()) {
      digestBacklog += state.pendingDigest.length;
    }
    // Persisted-pending count + age via SQL aggregates — avoids materializing
    // every pending row (and a full in-memory sort) on each snapshot read.
    const store = this.config.externalEventStore;
    const persisted = store ? store.summarizePendingDeliveries(now) : null;
    const gauges: QueueHealthGauges = {
      queueDepth,
      queueKeys: this.pendingExternalEventQueue.size,
      inFlight: this.externalEventDeliveriesInFlight.size,
      digestBacklog,
      retryTimers: this.externalEventRetryTimers.size,
      persistedPending: persisted?.count ?? 0,
      queueAgeMs: computeQueueAgeStats(inMemoryAges),
      persistedAgeMs: persisted,
    };
    return this.queueHealthMetrics.snapshot(gauges, now);
  }

  /**
   * Whether a pending external-event delivery has exceeded its TTL.
   *
   * `item.createdAt` is the event's creation/ingestion time for DB-persisted
   * deliveries (and the queueing time for in-memory deliveries, which ≈ event
   * ingestion time since they are queued the moment the event is handled).
   * Expiry is therefore event-age based — see EXTERNAL_EVENT_QUEUE_TTL_MS.
   */
  private isQueuedExternalEventExpired(item: PendingExternalEvent, now = Date.now()): boolean {
    return now - item.createdAt > EXTERNAL_EVENT_QUEUE_TTL_MS;
  }

  /**
   * TTL check for a published source event that has no registered deliveries.
   * Mirrors `isQueuedExternalEventExpired`: the anchor is the source event's
   * ingestion time (`space_external_events.created_at`), not the current
   * handling time. Used to bound how long a PR event can stay `published`
   * waiting for a subscription to appear.
   */
  private isPublishedExternalEventExpired(
    payload: ExternalEventPublishedPayload,
    now = Date.now()
  ): boolean {
    const store = this.config.externalEventStore;
    const createdAt = store?.getById(payload.eventId)?.createdAt;
    if (createdAt === undefined) return false;
    return now - createdAt > EXTERNAL_EVENT_QUEUE_TTL_MS;
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
    if (queued) {
      this.failQueuedDeliveries(queued, reason);
      for (const item of queued) {
        this.clearExternalEventRetry(item.deliveryKey);
      }
      this.pendingExternalEventQueue.delete(key);
    }

    const store = this.config.externalEventStore;
    if (!store) return;
    for (const delivery of store.listPendingDeliveries(target.workflowRunId)) {
      if (
        delivery.taskId !== target.taskId ||
        delivery.nodeId !== target.nodeId ||
        delivery.agentName !== target.agentName
      ) {
        continue;
      }
      const eventRecord = store.getById(delivery.eventId);
      if (eventRecord?.event && this.isTargetStillSubscribed(target, eventRecord.event.topic)) {
        continue;
      }
      store.markDeliveryFailed(delivery.eventId, delivery.deliveryKey, { terminal: true, reason });
      store.markEventFailedIfAllDeliveriesTerminal(delivery.eventId);
      this.clearExternalEventRetry(delivery.deliveryKey);
    }
  }

  private clearQueuedDeliveriesForRun(workflowRunId: string, reason: string): void {
    const store = this.config.externalEventStore;
    for (const [queueKey, queued] of this.pendingExternalEventQueue) {
      const parsed = parseSubscriptionQueueKey(queueKey);
      if (!parsed || parsed.workflowRunId !== workflowRunId) continue;
      this.failQueuedDeliveries(queued, reason);
      for (const item of queued) {
        this.clearExternalEventRetry(item.deliveryKey);
      }
      this.pendingExternalEventQueue.delete(queueKey);
    }
    if (!store) return;
    for (const delivery of store.listPendingDeliveries(workflowRunId)) {
      store.markDeliveryFailed(delivery.eventId, delivery.deliveryKey, { terminal: true, reason });
      store.markEventFailedIfAllDeliveriesTerminal(delivery.eventId);
      this.clearExternalEventRetry(delivery.deliveryKey);
    }
  }

  /**
   * Task-scoped variant: fail persisted pending deliveries and clear in-memory
   * queue entries whose target belongs to the given taskId (across all
   * runs/nodes/agents), without affecting other tasks on the same run.
   */
  private clearQueuedDeliveriesForTask(taskId: string): void {
    const store = this.config.externalEventStore;
    for (const [queueKey, queued] of this.pendingExternalEventQueue) {
      const parsed = parseSubscriptionQueueKey(queueKey);
      if (!parsed || parsed.taskId !== taskId) continue;
      this.failQueuedDeliveries(queued, 'task_terminal_cleanup');
      for (const item of queued) {
        this.clearExternalEventRetry(item.deliveryKey);
      }
      this.pendingExternalEventQueue.delete(queueKey);
    }
    if (!store) return;
    for (const delivery of store.listPendingDeliveries()) {
      if (delivery.taskId !== taskId) continue;
      store.markDeliveryFailed(delivery.eventId, delivery.deliveryKey, {
        terminal: true,
        reason: 'task_terminal_cleanup',
      });
      store.markEventFailedIfAllDeliveriesTerminal(delivery.eventId);
      this.clearExternalEventRetry(delivery.deliveryKey);
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

  /**
   * Re-resolves the authoritative live session for `target` — the stale-session
   * guard used immediately before injecting an external event.
   *
   * `target.sessionId` is captured when a delivery is queued (at node spawn /
   * activation time). By the time the async dispatch runs the worker may have
   * been superseded: it crashed and was respawned (a new `agentSessionId` on
   * the same node execution) or its execution was reset to pending
   * (`agentSessionId` cleared). The node execution record is authoritative —
   * `spawnWorkflowNodeAgentForExecution` writes the new `agentSessionId`
   * before returning — so `getCurrentQueueableOrActiveExecution` is trusted
   * over the captured `sessionId`.
   *
   * Returns the target retargeted onto the *current* live session, or `null`
   * when no live session can be resolved. Callers requeue the delivery as
   * pending instead of injecting into a superseded (dead) session.
   */
  private resolveLiveDeliveryTarget(
    target: Pick<WorkflowSubscriptionTarget, 'workflowRunId' | 'taskId' | 'nodeId' | 'agentName'>
  ): WorkflowSubscriptionTarget | null {
    const current = this.getCurrentQueueableOrActiveExecution(target);
    if (!current?.agentSessionId) return null;
    return { ...target, sessionId: current.agentSessionId };
  }

  private isRunInterestRebuildEligible(run: SpaceWorkflowRun): boolean {
    return this.isRunInterestRebuildEligibleWithTasks(
      run,
      this.config.taskRepo.listByWorkflowRunIncludingArchived(run.id)
    );
  }

  /**
   * Tasks-accepting core of {@link isRunInterestRebuildEligible}. Lets the
   * rehydrate path batch-fetch tasks once per space (via
   * `listByWorkflowRunIdsIncludingArchived`) and reuse them across both the
   * static-rebuild loop and the dynamic-subscription purge, instead of issuing
   * a per-run task query in each.
   */
  private isRunInterestRebuildEligibleWithTasks(
    run: SpaceWorkflowRun,
    runTasks: SpaceTask[]
  ): boolean {
    // A cancelled run (e.g. cancelled by space.stop) must not have its static
    // event interests rebuilt on resume/rehydrate — the run is no longer active
    // even if a review task on it was not cancelled. A `done` run is terminal
    // (it can no longer deliver events — every delivery fails with
    // target_task_terminal), so rebuilding its interests only causes fan-out
    // waste on every matching event; the coder re-subscribes if the run reopens.
    if (run.status === 'cancelled' || isWorkflowRunSucceeded(run.status)) {
      return false;
    }
    const task = this.pickCanonicalTaskForRun(run, runTasks);
    return (
      !!task && task.status !== 'cancelled' && task.status !== 'archived' && task.status !== 'done'
    );
  }

  private isWorkflowTargetOwnedBySpace(
    target: WorkflowSubscriptionTarget,
    spaceId: string
  ): boolean {
    const task = this.config.taskRepo.getTask(target.taskId);
    const run = this.config.workflowRunRepo.getRun(target.workflowRunId);
    return !!(
      task &&
      run &&
      task.spaceId === spaceId &&
      run.spaceId === spaceId &&
      task.workflowRunId === run.id
    );
  }

  /**
   * Synchronous task-lifecycle decision for an external event. A `done` task is
   * terminal — it no longer receives events (the prior reactive-reopen on a late
   * CI failure relied on a runtime-owned PR subscription that no longer exists;
   * see task #886). Keeping this synchronous lets the common `deliver` case reach
   * delivery without an awaited lookup (the flush path dispatches synchronously).
   */
  private prepareExternalEventTask(
    target: WorkflowSubscriptionTarget,
    event: ExternalEventPublishedPayload
  ): ExternalEventTaskDecision {
    const task = this.config.taskRepo.getTask(target.taskId);
    const run = this.config.workflowRunRepo.getRun(target.workflowRunId);
    if (
      !task ||
      !run ||
      task.spaceId !== event.spaceId ||
      run.spaceId !== event.spaceId ||
      task.workflowRunId !== run.id
    ) {
      return { action: 'fail', reason: 'invalid_target_ownership' };
    }
    if (task.status === 'cancelled' || task.status === 'archived' || task.status === 'done') {
      return { action: 'fail', reason: 'target_task_terminal' };
    }

    return { action: 'deliver' };
  }

  /**
   * Resolve a task-lifecycle decision into a deliverable target, performing the
   * async reactivation when the decision is `reactivate`. Used by the routing
   * and digest paths (both awaited); the synchronous flush path handles
   * `reactivate` separately so its `deliver` case stays synchronous.
   */
  private async resolveExternalEventDelivery(
    target: WorkflowSubscriptionTarget,
    event: ExternalEventPublishedPayload
  ): Promise<
    | { action: 'deliver'; target: WorkflowSubscriptionTarget }
    | { action: 'hold' }
    | { action: 'fail'; reason: string }
  > {
    const decision = this.prepareExternalEventTask(target, event);
    if (decision.action === 'fail') return { action: 'fail', reason: decision.reason };
    if (decision.action === 'hold') return { action: 'hold' };
    if (decision.action === 'reactivate') {
      const task = this.config.taskRepo.getTask(target.taskId);
      if (!task) return { action: 'fail', reason: 'invalid_target_ownership' };
      try {
        await this.recoverWorkflowBackedTask(task.spaceId, task.id, 'in_progress', {
          workflowNodeId: target.nodeId,
          agentName: target.agentName,
        });
      } catch (err) {
        log.warn(
          `SpaceRuntime: failed to reactivate task ${task.id} for check failure ${event.eventId}: ${formatCommandError(err)}`
        );
        return { action: 'fail', reason: 'target_task_reactivation_failed' };
      }
      // The recovery await is a cancellation/archive race window: re-run the
      // ownership, lifecycle, subscription, and paused checks on the refreshed
      // target before declaring the event deliverable.
      return this.revalidateRecoveredTarget(target, event);
    }
    return { action: 'deliver', target };
  }

  /**
   * Re-validate a target after an async task recovery. The recovery await can
   * straddle a task cancel/archive (which clears the subscription) or a pause,
   * so the post-recovery decision must be recomputed rather than assumed.
   */
  private revalidateRecoveredTarget(
    target: WorkflowSubscriptionTarget,
    event: ExternalEventPublishedPayload
  ):
    | { action: 'deliver'; target: WorkflowSubscriptionTarget }
    | { action: 'hold' }
    | { action: 'fail'; reason: string } {
    const refreshed = this.resolveSubscriptionTarget(target);
    if (!this.isTargetStillSubscribed(refreshed, event.topic)) {
      return { action: 'fail', reason: 'subscription_no_longer_active' };
    }
    const rechecked = this.prepareExternalEventTask(refreshed, event);
    if (rechecked.action === 'fail') return { action: 'fail', reason: rechecked.reason };
    if (rechecked.action === 'hold') return { action: 'hold' };
    // Recovery already ran; do not re-enter reactivation (reactivate would only
    // recur if the task were still done, which recovery resolved).
    return { action: 'deliver', target: refreshed };
  }

  /**
   * Synchronous task-lifecycle check for the rehydrate/resume requeue sweeps.
   * Returns a terminal failure reason when a persisted pending delivery can no
   * longer ever matter (cancelled/archived/done task), or `null` to continue
   * requeuing. A `done` task is terminal — it no longer reacts to events.
   */
  private evaluateRequeueTaskLifecycle(
    target: Pick<WorkflowSubscriptionTarget, 'taskId'>,
    event: { topic: string; source: string }
  ): string | null {
    void event;
    const task = this.config.taskRepo.getTask(target.taskId);
    if (!task) return 'invalid_target_ownership';
    if (task.status === 'cancelled' || task.status === 'archived' || task.status === 'done') {
      return 'target_task_terminal';
    }
    return null;
  }

  private getCurrentQueueableOrActiveExecution(
    target: WorkflowSubscriptionTarget
  ): NodeExecution | undefined {
    return this.config.nodeExecutionRepo
      .listByNode(target.workflowRunId, target.nodeId)
      .filter(
        (execution) => execution.agentName === target.agentName && execution.status !== 'cancelled'
      )
      .sort((a, b) => (b.updatedAt ?? b.createdAt) - (a.updatedAt ?? a.createdAt))[0];
  }

  private isTargetSessionLive(sessionId: string): boolean {
    return this.config.taskAgentManager?.isSessionAlive(sessionId) ?? false;
  }

  /**
   * Normalize a target's stale persisted `interrupted` state to idle before a
   * defer handoff. Self-guarding: no-op unless the state is `interrupted`
   * with no interrupt actually in flight.
   */
  private async normalizeStaleInterruptedSession(sessionId: string): Promise<void> {
    const session = this.config.taskAgentManager?.getAgentSessionById?.(sessionId);
    await session?.normalizeStaleInterruptedState();
  }

  /**
   * Whether the target's live session is mid-interrupt. A deferred row handed
   * to a session in this state has no replay owner unless the interrupt's own
   * completion publishes `query.trigger` — which the InterruptHandler now does
   * for USER interrupts, but teardown-bound ones (session stop, sibling
   * quiesce, shutdown) deliberately suppress. Parking keeps the delivery in
   * the runtime's retry loop until the interrupt resolves to a true idle.
   */
  private isTargetSessionInterrupted(sessionId: string): boolean {
    const session = this.config.taskAgentManager?.getAgentSessionById?.(sessionId);
    if (session?.getProcessingState().status !== 'interrupted') return false;
    // A persisted 'interrupted' status without an interrupt actually in
    // flight is stale (e.g. a daemon crash between setInterrupted and
    // setIdle) — no interrupt operation remains to resolve it to idle, so
    // parking on it would hold the delivery until TTL. Treat it as
    // not-interrupted and take the normal defer handoff instead.
    return session.isInterruptInProgress();
  }

  /**
   * Park an external-event delivery when its target's live session is
   * mid-interrupt (P2): queue it for the pending node and arm a retry instead
   * of handing it off in 'defer' mode. The interrupt resolves to a true idle
   * within seconds, and the retry delivers at that idle boundary. Returns true
   * when the delivery was parked — the caller must not also hand it off.
   */
  private parkDeliveryForInterruptedSession(
    target: WorkflowSubscriptionTarget,
    payload: ExternalEventPublishedPayload,
    deliveryKey: string,
    createdAt: number
  ): boolean {
    if (!target.sessionId || !this.isTargetSessionInterrupted(target.sessionId)) return false;
    this.queueForPendingNode(target, payload, deliveryKey, 'defer', createdAt);
    // Defer-encoded failure reason documents the queued intent for a daemon
    // restart (recovery's default is also defer).
    this.scheduleActivationRetry(
      target,
      payload,
      deliveryKey,
      'deliveryMode:defer; target_session_interrupted',
      {
        preserveAttemptCount: true,
      }
    );
    return true;
  }

  /**
   * Returns true when the target slot has at least one cancelled execution. A
   * cancelled execution is a permanently finished slot that subscriber
   * activation should not respawn.
   */
  private hasTerminalExecutionForTarget(
    target: Pick<WorkflowSubscriptionTarget, 'workflowRunId' | 'taskId' | 'nodeId' | 'agentName'>
  ): boolean {
    return this.config.nodeExecutionRepo
      .listByNode(target.workflowRunId, target.nodeId)
      .some(
        (execution) => execution.agentName === target.agentName && execution.status === 'cancelled'
      );
  }

  private hasAnyExecutionForTarget(
    target: Pick<WorkflowSubscriptionTarget, 'workflowRunId' | 'taskId' | 'nodeId' | 'agentName'>
  ): boolean {
    return this.config.nodeExecutionRepo
      .listByNode(target.workflowRunId, target.nodeId)
      .some((execution) => execution.agentName === target.agentName);
  }

  private buildQueueKey(
    target: Pick<WorkflowSubscriptionTarget, 'workflowRunId' | 'taskId' | 'nodeId' | 'agentName'>
  ): string {
    return JSON.stringify([target.workflowRunId, target.taskId, target.nodeId, target.agentName]);
  }

  /**
   * Whether the delivery identified by `deliveryKey` is within its
   * recoverable-failure cool-down window. Entries past the window are reaped
   * lazily. The arm ({@link deliverToSession}) and the gate
   * ({@link handleExternalEventImpl}) share the same delivery key, so a
   * re-published event whose delivery already failed recoverably is skipped
   * while distinct events and the bounded retry path proceed.
   */
  private isDeliveryInDeliveryCooldown(deliveryKey: string): boolean {
    const lastFailureAt = this.externalEventDeliveryCooldowns.get(deliveryKey);
    if (lastFailureAt === undefined) return false;
    if (Date.now() - lastFailureAt < this.deliveryCooldownMs) return true;
    this.externalEventDeliveryCooldowns.delete(deliveryKey);
    return false;
  }

  /**
   * Arm (or refresh) the recoverable-failure cool-down for a delivery.
   * Subsequent FRESH dispatches (publish / re-poll) of the same delivery within
   * {@link deliveryCooldownMs} are skipped by {@link handleExternalEventImpl};
   * the event stays `published` and re-evaluates once the window lifts.
   */
  private armDeliveryCooldown(deliveryKey: string): void {
    const map = this.externalEventDeliveryCooldowns;
    map.set(deliveryKey, Date.now());
    // Bound growth: stale entries (a delivery that failed once and is never
    // republished) are only reaped lazily on re-query, so sweep expired entries
    // once the map exceeds its cap. Amortized over arms; a still-oversized map
    // after the sweep is a genuinely large live-storm (bounded by distinct
    // in-window failing deliveries).
    if (map.size > this.deliveryCooldownMapCap) {
      const now = Date.now();
      for (const [key, lastFailureAt] of map) {
        if (now - lastFailureAt >= this.deliveryCooldownMs) map.delete(key);
      }
    }
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

  private formatExternalEventDigestMessage(items: ExternalEventDigestItem[]): string {
    const topics = [...new Set(items.map((item) => item.event.topic))].sort();
    const occurredAtValues = items.map((item) => item.event.occurredAt);
    const oldest = new Date(Math.min(...occurredAtValues)).toISOString();
    const newest = new Date(Math.max(...occurredAtValues)).toISOString();
    // Include every coalesced event id so the agent can fetch any of them via
    // get_external_event(eventId). deliverDigestToSession marks ALL coalesced
    // deliveries as delivered after injecting this single message, so hiding
    // any id (e.g. via a cap) would leave delivered-but-unreachable events.
    // Rate-limit digests are small in practice, and even a large burst stays
    // well within an injected-message budget (UUIDs are compact), so we list
    // all ids rather than truncate.
    const eventIds = items.map((item) => item.event.eventId).join(', ');
    return (
      `${items.length} events received for topics: ${topics.join(', ')} ` +
      `(oldest: ${oldest}, newest: ${newest}). ` +
      `Event IDs: ${eventIds}. ` +
      `Use get_external_event(eventId) for full details.`
    );
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
    const workflow = run ? (this.config.spaceWorkflowManager.getWorkflowForRun(run) ?? null) : null;

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

    // 2. Resolve the post-approval route context (PR URL + template tokens).
    //
    // `{{pr_url}}` is the immutable PR identity established by the original
    // review handoff. Do not use the freshest agent-writable link artifact here:
    // dispatching merge instructions for a substituted PR could merge it before
    // the final completion gate notices the mismatch.
    let resolvedPrUrl: string | undefined;
    if (approvedTask.workflowRunId) {
      resolvedPrUrl =
        this.config.artifactProfile?.resolveInitialPrimaryLinkUrl?.(approvedTask.workflowRunId) ||
        undefined;
    }
    const overridePrUrl =
      typeof contextExtras.pr_url === 'string' ? contextExtras.pr_url : undefined;
    if (overridePrUrl && resolvedPrUrl && overridePrUrl !== resolvedPrUrl) {
      throw new Error(
        `Post-approval PR URL override ${overridePrUrl} does not match the reviewed run PR ${resolvedPrUrl}`
      );
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
    //
    // `{{approval_authority}}` is the node the Merger reports blockers to and
    // waits on — the APPROVING node (the one that submitted the completion,
    // falling back to the workflow end node). It is "Review" for the
    // Coding/Research workflows and "QA" for the Fullstack QA Loop. Deriving
    // it here (rather than hard-coding "Review" in the template) keeps the
    // Fullstack merger from misrouting a blocker to Review when QA is the
    // authority, even though both channels are reachable.
    // Read the authority from the DURABLE `postApprovalSourceNodeId` field, not
    // `pendingCompletionSubmittedByNodeId` — the pending field is cleared
    // atomically in the same UPDATE that commits `approved` (task #851), so it
    // is null by the time dispatch runs. Mirrors the router's own sourceNodeId.
    const approvalAuthorityNodeId =
      approvedTask.postApprovalSourceNodeId ?? workflow?.endNodeId ?? null;
    const approvalAuthorityNode =
      approvalAuthorityNodeId !== null
        ? (workflow?.nodes.find((n) => n.id === approvalAuthorityNodeId) ?? null)
        : null;
    const approvalAuthorityName = approvalAuthorityNode?.name;
    const routeContext: PostApprovalRouteContext = {
      ...contextExtras,
      ...(resolvedPrUrl ? { pr_url: resolvedPrUrl } : {}),
      task_id: taskId,
      approvalSource,
      approval_source: approvalSource,
      spaceId,
      space_id: spaceId,
      autonomyLevel: space?.autonomyLevel,
      autonomy_level: space?.autonomyLevel,
      workspacePath: space?.workspacePath,
      workspace_path: space?.workspacePath,
      ...(approvalAuthorityName ? { approval_authority: approvalAuthorityName } : {}),
    };
    // 3. Dispatch the actual post-approval step. Wrapped in a `finally` that
    //    GUARANTEES the pending-completion fields are cleared regardless of
    //    which router branch ran or whether the router threw. The router
    //    clears these on most paths, but the `already-routed` and status-skip
    //    branches do not, and a throw mid-route (e.g. an SDK abort during
    //    sub-session spawn) would leave them set — causing the approval
    //    banner to linger on an already-approved task (reproducer tasks
    //    #846/#847). Per-branch cleanup proved too brittle; this is the
    //    single structural invariant.
    let routeResult: PostApprovalRouteResult;
    try {
      routeResult = await router.route(approvedTask, workflow, routeContext);
    } finally {
      clearPendingCompletionState(this.config.taskRepo, taskId);
    }

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
  private async listActiveSpaces(): Promise<import('@hyperneo/shared').Space[]> {
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
    const isTerminalCancel = task.status === 'cancelled';
    const cancelledSessionIds = new Set<string>();
    for (const execution of this.config.nodeExecutionRepo.listByWorkflowRun(task.workflowRunId)) {
      if (
        !execution.agentSessionId ||
        execution.status === 'cancelled' ||
        // Preserve idle sessions only for resumable pauses (task → open), not
        // terminal cancellation — an idle session on a cancelled run must be
        // evicted so no path (inject, message.send RPC, etc.) can find + restart
        // it via ensureQueryStarted.
        (!isTerminalCancel && execution.status === 'idle')
      ) {
        continue;
      }
      // Two non-idle executions can share one agentSessionId when a node session
      // is reused. Interrupt the shared session once (a second cancelBySessionId
      // would hit the SessionManager fallback and start a concurrent teardown on
      // the same AgentSession) — but still terminalize every sharing row below.
      if (!cancelledSessionIds.has(execution.agentSessionId)) {
        this.config.taskAgentManager?.cancelBySessionId(execution.agentSessionId);
        cancelledSessionIds.add(execution.agentSessionId);
      }
      // For idle (completed) executions, evict the session but preserve the
      // completed row — don't overwrite status/result/completedAt with the
      // cancellation reason. The session is gone from every map; the execution
      // history stays intact.
      if (execution.status !== 'idle') {
        this.config.nodeExecutionRepo.update(execution.id, {
          status: 'cancelled',
          agentSessionId: null,
          result: reason,
          completedAt: now,
        });
      }
    }

    // Sweep live sub-sessions the TaskAgentManager tracks for this run whose
    // NodeExecution row carried a null agentSessionId at cancel time (their live
    // SDK subprocess still needs to be interrupted so the in-flight coder turn
    // actually stops). Node agents are spawned against the run's canonical task,
    // so pass every task ID in the run to cover it regardless of which task
    // triggered the stop. Skip IDs already interrupted above. Invoked
    // defensively (`?.`): a manager that doesn't expose the method falls back to
    // the per-row loop above.
    const runTaskIds = this.config.taskRepo.listByWorkflowRun(task.workflowRunId).map((t) => t.id);
    for (const sid of this.config.taskAgentManager?.getLiveSubSessionIdsForTasks?.(runTaskIds) ??
      []) {
      if (cancelledSessionIds.has(sid)) continue;
      this.config.taskAgentManager?.cancelBySessionId(sid);
    }

    if (task.taskAgentSessionId && !cancelledSessionIds.has(task.taskAgentSessionId)) {
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
          // A pre-registration spawn can register its session in subSessions
          // between the first stop pass (above) and this run transition, so the
          // first sweep missed it. Repeat the pass now that the run is
          // cancelled. Idempotent — cancellingSessions and the already-cancelled
          // execution rows make it a no-op for stopped sessions. (A residual
          // window remains for sessions registered after even this pass; fully
          // closing the spawn-during-cancel race needs the coordinated
          // cancellation-token pass tracked separately.)
          updated = await this.stopActiveWorkflowTaskAgents(
            {
              ...updated,
              workflowRunId: previous.workflowRunId,
              taskAgentSessionId: null,
            },
            reason
          );
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
      if (task.status === 'approved') {
        // `approved → cancelled` is now a valid direct transition (matrix gap
        // G3), so the generic branch below would cancel it in one step. We keep
        // this explicit two-step (`approved → in_progress → cancelled`) as a
        // defensive fallback: bouncing through `in_progress` first guarantees
        // the post-approval worker session, runtime interests, and cooldown
        // timers are torn down at the intermediate state before the final
        // cancelled sweep runs — identical to the pre-G3 path this code
        // shipped with. Checked before the generic branch so it stays
        // reachable (otherwise the generic branch would preempt it).
        await this.stopWorkflowBackedTaskForStatus(spaceId, task.id, { status: 'in_progress' });
        await this.stopWorkflowBackedTaskForStatus(spaceId, task.id, { status: 'cancelled' });
      } else if (isValidSpaceTaskTransition(task.status, 'cancelled')) {
        // Cancel every task that can transition to cancelled — including `review`
        // tasks waiting at a gate and rate/usage-limited tasks (whose
        // rate_limited/usage_limited → cancelled transition is valid) — so
        // switching/cancelling a run tears down every live session + its cooldown
        // timer and does not leave them reachable by later events.
        await this.stopWorkflowBackedTaskForStatus(spaceId, task.id, { status: 'cancelled' });
      } else if (task.status === 'cancelled' && task.workflowRunId) {
        // The requested task may have been pre-cancelled (cancel_task with
        // cancel_workflow_run: true cancels it before this call), so the
        // transition above is skipped — still stop its live worker session.
        await this.stopActiveWorkflowTaskAgents(task, 'workflow run cancelled');
      }
    }
    const updated = this.config.workflowRunRepo.getRun(runId) ?? run;
    if (updated.status === 'cancelled') {
      // Full run cancellation: drop ALL interests (incl. agent-created dynamic)
      // since the task-cancel subscriber only preserves-dynamic. The run is gone.
      this.clearRunInterests(runId);
      return updated;
    }
    if (canTransitionRunStatus(updated.status, 'cancelled')) {
      const cancelled = await this.transitionRunStatusAndEmit(runId, 'cancelled');
      this.clearRunInterests(runId);
      return cancelled;
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
    const updated = this.config.workflowRunRepo.transitionStatus(runId, nextStatus);
    // done/cancelled are NOT cleared here. They are reopenable: a peer
    // `send_message` flips the run back to `in_progress` (see ChannelRouter's
    // reopen path and WorkflowRunStatusMachine), so a runaway exchange that
    // crosses the terminal boundary must keep counting against the rolling
    // dead-loop window — clearing it would hand a reopened run a fresh 15
    // traversals within the same 5-minute window. The rate-window history is
    // retained until the rows age out of the window (pruneAllOldEvents at
    // startup) or the owning task is archived — the true tombstone and only
    // status from which ChannelRouter hard-blocks further sends (cleared in
    // SpaceTaskManager.setTaskStatus).
    await this.safeOnWorkflowRunUpdated(updated.spaceId, updated);
    return updated;
  }

  /**
   * Choose the canonical task for a workflow run in one-task-per-run mode.
   * Delegates to the exported pure `pickCanonicalRunTask` (also used by the
   * node-agent `complete_validation_task` handler so external completion
   * paths reject duplicates with the exact same selection rule the tick
   * loop applies).
   */
  private pickCanonicalTaskForRun(run: SpaceWorkflowRun, runTasks: SpaceTask[]): SpaceTask | null {
    return pickCanonicalRunTask(run, runTasks);
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

      // Remove this duplicate task's external-event interests before detaching
      // it from the run. The archive event nulls workflowRunId, so the task-
      // cancel/archive subscriber (which keys on workflowRunId) would otherwise
      // skip cleanup and leave stale dynamic interests matching future webhooks.
      // Use clearTaskInterests (not raw trie remove) so queued deliveries are
      // also terminalized.
      this.clearTaskInterests(duplicate.id);

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
   * Reconcile task state after a workflow execution attempt has finished.
   *
   * Ensures:
   * - exactly one canonical task remains attached to the run
   * - succeeded/cancelled run outcomes are reflected in task lifecycle state
   *
   * TODO(workflow-completion): keep this coupling explicit when PR/CI lifecycle
   * events become task-owned; a succeeded run is not the same as accepted work.
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

    if (isWorkflowRunSucceeded(run.status)) {
      const workflow =
        this.executorMeta.get(run.id)?.workflow ??
        this.config.spaceWorkflowManager.getWorkflowForRun(run) ??
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
      // TODO(workflow-completion): a `done`/Succeeded run can still have a
      // `blocked` or `cancelled` canonical task here. Reconcile run status vs
      // task outcome when PR/CI lifecycle events become task-owned.
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
   * Reconcile finished execution attempts that are not in the executor map.
   *
   * This keeps task state consistent after daemon restarts and repairs legacy runs
   * where external paths marked the run terminal but left task state inconsistent.
   */
  private async reconcileTerminalRunsWithoutExecutors(): Promise<void> {
    const spaces = await this.listActiveSpaces();
    for (const space of spaces) {
      const finishedRuns = this.config.workflowRunRepo
        .listBySpace(space.id)
        .filter((run) => isWorkflowRunSucceeded(run.status) || run.status === 'cancelled');
      for (const run of finishedRuns) {
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
    this.isStopped = false;

    // Capture the runtime generation so the fire-and-forget restart IIFE can
    // detect a stop() that landed during its awaited space scan and abort
    // instead of re-subscribing/ticking a stopped runtime.
    const generation = this.runtimeGeneration;
    this.subscribeSdkToolUseCreated();
    // Re-register the space-resume hook after a stop->start cycle; stop()
    // unsubscribes it to avoid stale callbacks, so start() must restore it.
    this.unsubscribeSpaceResumed ??= this.config.spaceManager.onSpaceResumedRegister?.((spaceId) =>
      this.onSpaceResumed(spaceId)
    );
    // Maintain the sync paused-space cache so the delivery hot path can defer
    // (not inject) events for paused spaces without an async lookup.
    this.unsubscribeSpacePaused ??= this.config.spaceManager.onSpacePausedRegister?.((spaceId) => {
      this.pausedSpaceIds.add(spaceId);
    });
    this.unsubscribeSpaceStopped ??= this.config.spaceManager.onSpaceStoppedRegister?.(
      (spaceId) => {
        this.pausedSpaceIds.add(spaceId);
      }
    );
    this.acceptingExternalEvents = this.rehydrated;
    const interval = this.config.tickIntervalMs ?? 5_000;
    // Arm the tick loop synchronously so callers (and tests) observe tickTimer
    // set immediately. executeTick gates on reconciliationDone so interval ticks
    // that fire before the stop→start reconciliation completes are no-ops.
    this.tickTimer = setInterval(() => {
      this.executeTick().catch((err: unknown) => {
        log.error('SpaceRuntime: tick failed:', err);
      });
    }, interval);
    if (this.rehydrated) {
      // Defer all post-reconciliation work until the paused cache is rebuilt.
      this.reconciliationDone = false;
      void (async () => {
        const pausedSpaceIds = new Set<string>();
        try {
          for (const space of await this.config.spaceManager.listSpaces(false)) {
            if (space.paused || space.stopped) {
              pausedSpaceIds.add(space.id);
              this.pausedSpaceIds.add(space.id);
            } else {
              this.pausedSpaceIds.delete(space.id);
            }
          }
        } catch (err) {
          log.warn(
            `SpaceRuntime: start() could not list spaces for paused-deferral: ${formatCommandError(err)}`
          );
        }
        if (generation !== this.runtimeGeneration) return;
        this.rescheduleQueuedExternalEventRetries();
        this.requeuePersistedPendingDeliveries(pausedSpaceIds);
        this.subscribeExternalEventPublished();
        this.reconciliationDone = true;
        this.redispatchRetainedExternalEvents();
        this.executeTick().catch((err: unknown) => {
          log.error('SpaceRuntime: initial tick failed:', err);
        });
      })();
    } else {
      // First start: no retained subs in the trie yet, so no injection risk.
      this.rescheduleQueuedExternalEventRetries();
      this.subscribeExternalEventPublished();
      this.redispatchRetainedExternalEvents();
      this.executeTick().catch((err: unknown) => {
        log.error('SpaceRuntime: initial tick failed:', err);
      });
    }
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
    // Invalidate any in-flight restart IIFE so it aborts before re-subscribing/
    // ticking this now-stopped runtime.
    this.runtimeGeneration += 1;
    this.isStopped = true;
    // Cancel any deferred retained-event flush so an in-flight handleExternalEvent
    // finally doesn't process retained webhooks after shutdown.
    this.retainedEventRedispatchPending = false;
    this.unsubscribeExternalEventPublished?.();
    this.unsubscribeExternalEventPublished = undefined;
    this.unsubscribeSdkToolUseCreated?.();
    this.unsubscribeSdkToolUseCreated = undefined;
    this.unsubscribeSdkToolUseConsumed?.();
    this.unsubscribeSdkToolUseConsumed = undefined;
    this.unsubscribeSpaceResumed?.();
    this.unsubscribeSpaceResumed = undefined;
    this.unsubscribeSpacePaused?.();
    this.unsubscribeSpacePaused = undefined;
    this.unsubscribeSpaceStopped?.();
    this.unsubscribeSpaceStopped = undefined;
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
        // Release the synchronous digest-path claim acquired in
        // enqueueDeliverableExternalEvent so the requeued delivery can be
        // retried/flushed after a restart.
        this.externalEventDeliveriesInFlight.delete(item.deliveryKey);
      }
    }
    this.externalEventRateLimits.clear();
    this.externalEventDeliveryCooldowns.clear();
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
    if (this.tickInFlight || !this.reconciliationDone) return;
    this.tickInFlight = true;
    try {
      if (hasSqlExec(this.config.db)) {
        this.toolContinuationRepo.markExpired();
      }

      const justRehydrated = !this.rehydrated;
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
        this.acceptingExternalEvents = true;
      }

      if (justRehydrated) {
        // Route through the re-entrancy-guarded helper: if an event is still
        // mid-handling (awaiting gate re-eval, before its delivery rows exist),
        // the raw redispatch would re-handle it; the guard defers to the
        // post-handling flush instead.
        this.redispatchRetainedExternalEvents();
      }

      await this.attachStandaloneTasksToWorkflows();
      await this.processCompletedTasks();
      await this.cleanupTerminalExecutors();
      await this.reconcileTerminalRunsWithoutExecutors();
      await this.checkStandaloneTasks();
      // Auto-resume tasks paused on a rate/usage cap whose reset has passed.
      // Driven off the persisted `restrictions.resetAt`, so it survives daemon
      // restarts (the in-memory watchdog cooldown does not).
      await this.recoverRateLimitedTasks();

      // Bound published events without deliveries (e.g. retained events waiting
      // for a subscription) so they do not last forever when no matching
      // subscription, duplicate webhook, or restart occurs.
      this.expirePublishedExternalEventsPastTtl();

      // Physically prune dead-loop event history older than the rolling window
      // across ALL runs. Active runs lazy-prune their own channels on each
      // traversal, but done/cancelled (reopenable) runs are never traversed
      // again — without this periodic sweep their retained rows would accumulate
      // until the next daemon restart. Throttled to once per window.
      this.pruneExpiredCycleEvents();
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
    const workflowResult = this.config.spaceWorkflowManager.getWorkflowForRunStart(workflowId);
    if (!workflowResult) {
      throw new Error(`Workflow not found: ${workflowId}`);
    }
    const { rawWorkflow, workflow } = workflowResult;
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
    const pendingRun = this.config.workflowRunRepo.createPinnedRun({
      spaceId,
      workflowId,
      title,
      description,
      rawWorkflow,
    });

    const run = this.config.workflowRunRepo.transitionStatus(pendingRun.id, 'in_progress');
    await this.safeOnWorkflowRunCreated(spaceId, run);

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

  /**
   * The PR URL recorded for a workflow run (the approved task's PR), or null when
   * none is resolvable. Used by the `merge_pr` handler to bind the caller-supplied
   * `pr_url` to the task's actual PR, so an authorized merger for task A cannot
   * merge task B's PR by passing its URL (task #866).
   */
  getApprovedPrUrlForRun(runId: string): string | null {
    const url = this.resolvePrUrlForRun(runId);
    return typeof url === 'string' && url.length > 0 ? url : null;
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
    targetStatus: WorkflowTaskRecoveryTargetStatus,
    options: { workflowNodeId?: string; agentName?: string; description?: string } = {}
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

      // Refuse to reopen against a workflow definition that no longer exists
      // (e.g. deleted after the run completed) — otherwise the task/run are
      // mutated to in_progress but the run can never tick or spawn again.
      const workflow = this.config.spaceWorkflowManager.getWorkflowForRun(run);
      if (!workflow) {
        throw new Error(`Workflow not found: ${run.workflowId}`);
      }

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
        postApprovalSourceNodeId: null,
        reportedStatus: null,
        reportedSummary: null,
        ...(options.description !== undefined ? { description: options.description } : {}),
      });
      if (!updatedTask) throw new Error(`Failed to update task: ${task.id}`);

      let executions = this.config.nodeExecutionRepo.listByWorkflowRun(run.id);
      if (executions.length === 0) {
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

      // Prefer the subscribed slot (node + agent) when recovering for an event
      // (e.g. a check_failed that matched an earlier node's agent); otherwise
      // reset the most recently updated node. Resetting the wrong slot would
      // leave both the last node/agent and the subscribed one runnable.
      const byRecency = (a: NodeExecution, b: NodeExecution) => {
        const aTime = a.updatedAt ?? a.startedAt ?? a.createdAt;
        const bTime = b.updatedAt ?? b.startedAt ?? b.createdAt;
        if (aTime !== bTime) return bTime - aTime;
        return b.id.localeCompare(a.id);
      };
      let currentExecution: NodeExecution | undefined;
      let currentNodeExecutions: NodeExecution[];
      if (options.workflowNodeId) {
        const slotExecutions = executions.filter(
          (execution) =>
            execution.workflowNodeId === options.workflowNodeId &&
            (!options.agentName || execution.agentName === options.agentName)
        );
        if (slotExecutions.length === 0) {
          // The subscribed slot has no execution (e.g. an interest on a node that
          // was never reached). If the slot is a declared workflow agent, seed a
          // pending execution so the tick can spawn it; otherwise the subscription
          // is orphaned — abort so the task/run are not reopened with no runnable
          // slot (the transaction rolls back).
          const slotNode = workflow.nodes.find((node) => node.id === options.workflowNodeId);
          const slot =
            slotNode && options.agentName
              ? resolveNodeAgents(slotNode).find((agent) => agent.name === options.agentName)
              : undefined;
          if (!slotNode || (options.agentName && !slot)) {
            throw new Error(
              `Subscribed slot ${options.workflowNodeId}/${options.agentName ?? ''} is not recoverable`
            );
          }
          this.createNodeExecutionOrIgnore({
            workflowRunId: run.id,
            workflowNodeId: slotNode.id,
            agentName: options.agentName ?? slot?.name ?? '',
            agentId: slot?.agentId ?? null,
            status: 'pending',
          });
          executions = this.config.nodeExecutionRepo.listByWorkflowRun(run.id);
          currentExecution = executions.find(
            (execution) =>
              execution.workflowNodeId === slotNode.id &&
              (!options.agentName || execution.agentName === options.agentName)
          );
        } else {
          currentExecution = [...slotExecutions].sort(byRecency)[0];
        }
        currentNodeExecutions = currentExecution
          ? executions.filter(
              (execution) =>
                execution.workflowNodeId === currentExecution!.workflowNodeId &&
                (!options.agentName || execution.agentName === options.agentName)
            )
          : [];
      } else {
        currentExecution = [...executions].sort(byRecency)[0];
        currentNodeExecutions = currentExecution
          ? executions.filter(
              (execution) => execution.workflowNodeId === currentExecution!.workflowNodeId
            )
          : [];
      }

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
    // ensureExecutorRegistered early-returns when the executor is already
    // cached, so a recover after a cancel/archive cleared the run's static
    // workflow interests would leave them unregistered. Re-register explicitly
    // (idempotent: refreshes static interests, preserves dynamic/auto_pr).
    const recoveredWorkflow = this.config.spaceWorkflowManager.getWorkflowForRun(recovered.run);
    if (recoveredWorkflow) {
      this.registerRunInterestsFromWorkflow(recovered.run, recoveredWorkflow);
    }
    for (const sessionId of liveSessionIds) {
      // If the live session is paused in a rate/usage-limit cooldown, break it
      // out immediately so the manual Resume re-runs the turn now instead of
      // sitting idle until the watchdog timer fires at resetAt. A banner-
      // cancelled session (cooldown banner's Cancel) can't be broken out via
      // retryNow, so resumeRateLimitedSubSession re-spawns its execution; in
      // that case the session is stopped and a fresh one is spawned by the next
      // tick (with MCP tools attached at spawn), so skip the prepare step.
      const tam = this.config.taskAgentManager;
      const resumeOutcome: 'retried' | 'respawned' | 'noop' =
        tam && typeof tam.resumeRateLimitedSubSession === 'function'
          ? await tam.resumeRateLimitedSubSession(sessionId).catch((err: unknown) => {
              log.warn(
                `Workflow resume: failed to resume rate-limited session ${sessionId}: ${err instanceof Error ? err.message : String(err)}`
              );
              return 'noop' as const;
            })
          : 'noop';
      if (resumeOutcome === 'respawned') continue;
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

    const workflow = this.config.spaceWorkflowManager.getWorkflowForRun(run);
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
    // Guarded like the static-rebuild loop: a malformed workflow definition
    // (invalid eventInterests glob, or a slot over MAX_AGENT_SLOT_EVENT_INTERESTS)
    // would otherwise throw out of registerRunInterests, propagate through the
    // ungated activeRuns loop, and abort rehydrate for every space.
    try {
      this.registerRunInterestsFromWorkflow(run, workflow);
    } catch (err) {
      log.warn(
        `SpaceRuntime: failed to rebuild static interests for run ${run.id} during executor registration: ${formatCommandError(err)}`
      );
    }
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
  private requeuePersistedPendingDeliveries(pausedSpaceIds: Set<string> = new Set()): void {
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
      // Paused/stopped spaces rebuild task-owned subscriptions on resume. Leave
      // pending deliveries untouched until then rather than treating the absent
      // in-memory trie entry as an unsubscribe.
      if (run && pausedSpaceIds.has(run.spaceId)) {
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

      const lifecycleReason = this.evaluateRequeueTaskLifecycle(target, eventRecord.event);
      if (lifecycleReason) {
        store.markDeliveryFailed(delivery.eventId, delivery.deliveryKey, {
          terminal: true,
          reason: lifecycleReason,
        });
        store.markEventFailedIfAllDeliveriesTerminal(delivery.eventId);
        this.clearExternalEventRetry(delivery.deliveryKey);
        continue;
      }

      const mode = deliveryModeFromFailureReason(delivery.failureReason);
      const eventPayload = this.externalEventPayloadFromRecord(eventRecord.event);
      // TTL anchor is the event's creation/ingestion time, not the delivery's
      // registration/updated time — see EXTERNAL_EVENT_QUEUE_TTL_MS. This
      // rehydrate retry sweep must use the same anchor as the activation
      // flush (collectPersistedPendingDeliveries) so a persisted pending
      // delivery cannot dodge the TTL by being replayed after a restart.
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
      // Schedule a delayed retry rather than delivering inline: rehydrate runs
      // before executors/sessions are fully restored, so an immediate inject or
      // activation can race the spawn path. The retry re-enters the task-owned
      // delivery path once the runtime is accepting events.
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
      } else {
        this.scheduleActivationRetry(
          target,
          eventPayload,
          delivery.deliveryKey,
          delivery.failureReason ?? 'node_execution_not_active'
        );
      }
    }
  }

  /**
   * Called when a paused/stopped space resumes. Re-schedules activation retries
   * for sessionless pending deliveries in that space so idle subscribed targets
   * are not stranded until an unrelated activation or restart happens.
   */
  onSpaceResumed(spaceId: string): void {
    const store = this.config.externalEventStore;
    // The space is active again — clear the sync paused cache so the delivery
    // hot path resumes injecting into live sessions.
    this.pausedSpaceIds.delete(spaceId);
    if (!store) return;

    // Re-register workflow-defined static event interests for eligible runs
    // before evaluating pending deliveries. The startup rehydrate skips paused
    // spaces, so a run relying on a workflow eventInterests pattern may have no
    // trie entry yet; rebuilding first avoids false subscription removal.
    const reactiveRuns = this.config.workflowRunRepo
      .listBySpace(spaceId)
      .filter((run) => this.isRunInterestRebuildEligible(run));
    for (const run of reactiveRuns) {
      const staticWorkflow = this.config.spaceWorkflowManager.getWorkflowForRun(run);
      if (staticWorkflow) {
        try {
          this.registerRunInterestsFromWorkflow(run, staticWorkflow);
        } catch (err) {
          log.warn(
            `SpaceRuntime: failed to rebuild static interests for run ${run.id} on resume: ${formatCommandError(err)}`
          );
        }
      }
    }

    for (const delivery of store.listPendingDeliveries()) {
      const task = this.config.taskRepo.getTask(delivery.taskId);
      if (!task || task.spaceId !== spaceId) continue;

      const target = {
        workflowRunId: delivery.workflowRunId,
        taskId: delivery.taskId,
        nodeId: delivery.nodeId,
        agentName: delivery.agentName,
      };
      const eventRecord = store.getById(delivery.eventId);
      if (!eventRecord || eventRecord.state !== 'published') continue;
      // A deferred delivery may have sat paused longer than the queue TTL.
      // Apply the same event-age TTL guard as requeuePersistedPendingDeliveries
      // before scheduling a retry so stale events are failed as ttl_expired
      // instead of being injected on resume.
      const mode = deliveryModeFromFailureReason(delivery.failureReason);
      const ttlItem = {
        event: this.externalEventPayloadFromRecord(eventRecord.event),
        deliveryKey: delivery.deliveryKey,
        deliveryMode: mode,
        createdAt: eventRecord.createdAt,
      };
      if (this.isQueuedExternalEventExpired(ttlItem)) {
        this.failQueuedDeliveryForTtl(ttlItem, this.buildQueueKey(target));
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

      const lifecycleReason = this.evaluateRequeueTaskLifecycle(target, eventRecord.event);
      if (lifecycleReason) {
        store.markDeliveryFailed(delivery.eventId, delivery.deliveryKey, {
          terminal: true,
          reason: lifecycleReason,
        });
        store.markEventFailedIfAllDeliveriesTerminal(delivery.eventId);
        this.clearExternalEventRetry(delivery.deliveryKey);
        continue;
      }

      const eventPayload = this.externalEventPayloadFromRecord(eventRecord.event);
      // Pass the persisted event creation time so the queued item keeps the
      // original TTL anchor — stamping the resume time would let an event that
      // should already have expired survive until five minutes after resume.
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
          delivery.failureReason ?? `deliveryMode:${mode}; retry requeued after space resume`,
          { preserveAttemptCount: true, createdAt: eventRecord.createdAt }
        );
      } else {
        this.scheduleActivationRetry(
          target,
          eventPayload,
          delivery.deliveryKey,
          delivery.failureReason ?? 'node_execution_not_active'
        );
      }
    }

    // Replay retained no-delivery PR events unconditionally (after the
    // persisted pending deliveries above are requeued). A retained event may
    // have been kept published during pause for a run whose auto-sub already
    // existed (so subscribedPrRuns stayed 0); without this it would never be
    // re-evaluated and would expire. Re-entrancy-guarded; no-op when nothing is
    // retained.
    this.redispatchRetainedExternalEvents();
  }

  private redispatchPublishedEventsWithoutDeliveries(): void {
    const store = this.config.externalEventStore;
    if (!store) return;
    for (const eventRecord of store.listPublishedEventsWithoutDeliveries()) {
      void this.handleExternalEvent(this.externalEventPayloadFromRecord(eventRecord.event));
    }
  }

  /**
   * Periodic TTL sweep for source events that are still `published` and have
   * no delivery rows. This bounds events that the runtime intentionally keeps
   * published waiting for a subscription (e.g. PR-linked events) so they do not
   * remain in `space_external_events` indefinitely when no matching subscription,
   * duplicate webhook, or restart occurs.
   */
  private expirePublishedExternalEventsPastTtl(now = Date.now()): void {
    const store = this.config.externalEventStore;
    if (!store) return;
    for (const eventRecord of store.listPublishedEventsWithoutDeliveries()) {
      if (now - eventRecord.createdAt <= EXTERNAL_EVENT_QUEUE_TTL_MS) continue;
      try {
        store.markEventFailed(eventRecord.event.id, {
          terminal: true,
          reason: 'ttl_expired',
        });
      } catch (err) {
        log.warn(
          `SpaceRuntime: TTL sweep failed for ${eventRecord.event.id}: ${err instanceof Error ? err.message : String(err)}`
        );
      }
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

  /**
   * Group a flat task list (e.g. from the batched `listByWorkflowRunIdsIncludingArchived`)
   * by `workflow_run_id`, preserving the within-run ordering the batched query
   * already returns. Tasks with no workflow_run_id are skipped.
   */
  private groupTasksByRun(tasks: SpaceTask[]): Map<string, SpaceTask[]> {
    const byRun = new Map<string, SpaceTask[]>();
    for (const task of tasks) {
      if (!task.workflowRunId) continue;
      const list = byRun.get(task.workflowRunId);
      if (list) list.push(task);
      else byRun.set(task.workflowRunId, [task]);
    }
    return byRun;
  }

  /**
   * Restore agent-registered `dynamic` workflow subscriptions from the durable
   * `space_workflow_event_subscriptions` table into the in-memory trie on daemon
   * rehydrate. This is what lets a subscription an agent created at runtime
   * (e.g. a coder subscribing to its own PR) survive a restart — dynamic
   * interests cannot be re-derived, so the table is their source of truth.
   *
   * `static` template interests are NOT restored here: they are re-materialized
   * from the workflow definition by `ensureExecutorRegistered` and the
   * static-rebuild loop, whose eligibility already covers the post-approval
   * review phase (a succeeded run whose canonical task parks at `approved`).
   * Rebuilding static here would duplicate that work under a stricter gate
   * (`isRunInterestRebuildEligible` excludes done runs) and drop those review
   * interests, so this method clears/re-inserts `dynamic` entries only.
   *
   * Terminal reconciliation: each row is purged rather than restored when its
   * run is `cancelled` (cancelWorkflowRun's `clearRunInterests` may not have
   * fired) OR its OWN task is `done`/`archived` (`clearTaskInterests` may not
   * have fired) — checked per-row so a terminal NONCANONICAL task's row is
   * caught even when the run's canonical task is still active. Cancelled-TASK
   * rows on a retryable non-cancelled run are preserved (the lifecycle keeps
   * them via `clearTaskInterestsPreservingDynamic`), as are rows on succeeded
   * runs whose task is `review`/`approved` (the post-approval phase).
   *
   * `runs`/`tasksByRun` are the caller's already-fetched run + task lists for
   * the space (one batched `listByWorkflowRunIdsIncludingArchived` per space,
   * shared with the static-rebuild loop). `sessionId` is intentionally not
   * persisted — it is resolved dynamically from the live node execution at
   * delivery time (`resolveSubscriptionTarget`).
   */
  private rehydrateWorkflowSubscriptions(
    spaceId: string,
    runs: SpaceWorkflowRun[],
    tasksByRun: Map<string, SpaceTask[]>
  ): void {
    const runById = new Map(runs.map((run) => [run.id, run]));
    const cancelledRunIds = new Set(
      runs.filter((run) => run.status === 'cancelled').map((run) => run.id)
    );
    // Index every task by id so each row can be reconciled against its OWN task
    // (not just the run's canonical one — a run can briefly hold a terminal
    // noncanonical duplicate whose row must still be purged).
    const terminalTaskIds = new Set<string>();
    for (const runTasks of tasksByRun.values()) {
      for (const task of runTasks) {
        if (task.status === 'done' || task.status === 'archived') {
          terminalTaskIds.add(task.id);
        }
      }
    }
    // Clear only the dynamic trie entries owned by this space so the rebuild is
    // idempotent WITHOUT clobbering static interests the def-re-materialization
    // paths (`ensureExecutorRegistered`, run before this, and the static-rebuild
    // loop, run after) have already established.
    this.topicTrie.remove(
      (target) =>
        isWorkflowSubscriptionTarget(target) &&
        runById.has(target.workflowRunId) &&
        target.subscriptionKind === 'dynamic'
    );
    // Track already-purged runs/tasks so the delete fires once each even when a
    // run/task has multiple subscription rows.
    const purgedRuns = new Set<string>();
    const purgedTasks = new Set<string>();
    for (const sub of this.workflowEventSubscriptionRepo.listBySpace(spaceId)) {
      if (cancelledRunIds.has(sub.workflowRunId)) {
        if (!purgedRuns.has(sub.workflowRunId)) {
          this.workflowEventSubscriptionRepo.deleteByRun(sub.workflowRunId);
          purgedRuns.add(sub.workflowRunId);
        }
        continue;
      }
      if (terminalTaskIds.has(sub.taskId)) {
        if (!purgedTasks.has(sub.taskId)) {
          this.workflowEventSubscriptionRepo.deleteByTask(sub.taskId);
          purgedTasks.add(sub.taskId);
        }
        continue;
      }
      try {
        this.topicTrie.insert(sub.topic, {
          workflowRunId: sub.workflowRunId,
          taskId: sub.taskId,
          nodeId: sub.nodeId,
          agentName: sub.agentName,
          topic: sub.topic,
          subscriptionKind: sub.subscriptionKind,
        });
      } catch (err) {
        log.warn(
          `SpaceRuntime: skipping malformed workflow subscription ${sub.id} ` +
            `(${sub.workflowRunId}/${sub.nodeId}/${sub.agentName} ${sub.topic}) during rehydrate: ` +
            (err instanceof Error ? err.message : String(err))
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
    const pausedSpaceIds = new Set<string>();

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
            run.status !== 'cancelled' &&
            this.config.taskRepo
              .listByWorkflowRun(run.id)
              .some((task) => task.status === 'review' || task.status === 'approved')
        );
      if (reviewRuns.length > 0) {
        log.info(
          `SpaceRuntime.rehydrateExecutors: found ${reviewRuns.length} review/approved-pending run(s) in space ${space.id}`
        );
      }
      activeRuns.push(...reviewRuns);

      for (const run of activeRuns) {
        if (this.executors.has(run.id)) continue;
        await this.ensureExecutorRegistered(run, space);
      }
      this.rehydrateLongHorizonSubscriptions(space.id);
      // Fetch the space's runs + their tasks once (batched) and reuse for both
      // the dynamic-subscription rebuild and the static-interest rebuild below,
      // avoiding a per-run task-list query in each loop.
      const spaceRuns = this.config.workflowRunRepo.listBySpace(space.id);
      const tasksByRun = this.groupTasksByRun(
        this.config.taskRepo.listByWorkflowRunIdsIncludingArchived(spaceRuns.map((run) => run.id))
      );
      // Rebuild the workflow-subscription (dynamic) trie from the durable table
      // so an agent-registered subscription survives the restart, and purge any
      // cancelled-run / terminal-task rows that leaked through the crash window.
      // Runs before the paused-space short-circuit so a resumed space finds its
      // trie intact.
      this.rehydrateWorkflowSubscriptions(space.id, spaceRuns, tasksByRun);
      // Re-register workflow-defined static event interests for eligible runs
      // BEFORE persisted-delivery replay. Executor rehydration intentionally
      // excludes most succeeded runs, so a run relying on a workflow
      // eventInterests pattern would otherwise have no trie entry after a
      // restart. Idempotent for already-active runs.
      if (space.paused || space.stopped) {
        pausedSpaceIds.add(space.id);
        this.pausedSpaceIds.add(space.id);
        continue;
      }
      for (const run of spaceRuns) {
        if (!this.isRunInterestRebuildEligibleWithTasks(run, tasksByRun.get(run.id) ?? [])) {
          continue;
        }
        const staticWorkflow = this.config.spaceWorkflowManager.getWorkflowForRun(run);
        if (staticWorkflow) {
          try {
            this.registerRunInterestsFromWorkflow(run, staticWorkflow);
          } catch (err) {
            log.warn(
              `SpaceRuntime: failed to rebuild static interests for run ${run.id} during rehydrate: ${formatCommandError(err)}`
            );
          }
        }
      }
    }

    this.requeuePersistedPendingDeliveries(pausedSpaceIds);

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

    // Garbage-collect dead-loop event history older than the rolling window
    // across all runs. Active cyclic channels are pruned lazily on every
    // traversal; this bounds history for abandoned/stalled runs that are never
    // traversed again. Once per daemon start is sufficient — abandoned-run
    // events are static (no further traversals add rows).
    try {
      this.getCycleRepo().pruneAllOldEvents();
    } catch (err) {
      log.warn(
        `SpaceRuntime.recoverStalledRuns: failed to prune old cycle events: ${
          err instanceof Error ? err.message : String(err)
        }`
      );
    }

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
    const workflow = this.config.spaceWorkflowManager.getWorkflowForRun(run);
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
    const pendingMessageRepo = this.config.pendingMessageRepo;
    pendingMessageRepo?.enforceRetention({ runId: run.id });
    const hasQueuedNodeHandoff =
      pendingMessageRepo
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

    let activated: boolean;
    try {
      activated = await this.activateRestartRecoveryDownstreamNodes(run, executions);
    } catch (err) {
      // A downstream target references a deleted custom agent. Block THIS run
      // with an actionable diagnostic instead of leaking a raw SQLite FK error
      // (which would only be logged and leave the run in_progress, retrying on
      // every restart). Isolated to this run — the caller's per-run loop still
      // recovers other stalled runs.
      if (isMissingWorkflowAgentError(err)) {
        await this.blockRunForMissingAgent(run, err);
        return 'blocked';
      }
      throw err;
    }
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

  /**
   * Block a run whose workflow references a custom agent that no longer exists.
   * Unlike {@link blockRunWithMissingWorkflow} (whole definition gone) we keep
   * existing executions intact — the run is recoverable once the operator
   * recreates the agent or repoints the workflow slot, so cancelling live
   * executions would discard useful state. The run moves to `blocked` with a
   * diagnostic carrying the run id, target node, agent name, and stale agent id.
   */
  private async blockRunForMissingAgent(
    run: SpaceWorkflowRun,
    err: MissingWorkflowAgentError
  ): Promise<void> {
    const reason = err.message;
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
    const workflow = this.config.spaceWorkflowManager.getWorkflowForRun(run);
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
    const blockedReasons: string[] = [];
    // A single persisted (run, channel) dead-loop incident must surface at most
    // one recovery notification, even when multiple idle source executions or a
    // wildcard source channel yield several stalled transitions for the same
    // channel in one pass.
    const notifiedDeadLoopChannels = new Set<number>();

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
        blockedReasons.push(cycleResult.reason);
        // Surface a recovery-detected dead loop to the UI (mirrors the live
        // ChannelRouter surfacing) so it is not mistaken for a generic stall —
        // once per (run, channel) incident.
        if (cycleResult.deadLoop && !notifiedDeadLoopChannels.has(channelIndex)) {
          // Record dedup only on a successful publish — a failed publish must
          // remain retryable on the next stalled transition in this pass.
          const notified = await this.notifyRecoveryDeadLoop(
            run,
            channel,
            channelIndex,
            sourceExecution.agentName,
            targetNames,
            cycleResult.recentCount
          );
          if (notified) notifiedDeadLoopChannels.add(channelIndex);
        }
        continue;
      }
      let activatedOnChannel = false;
      for (const targetName of targetNames) {
        const targetNode = nodeByName.get(targetName);
        if (!targetNode || targetNode.id === sourceNode.id) continue;

        // Validate this target's configured agent references now that the channel
        // is confirmed reachable (cycle cap open), but BEFORE creating any
        // execution for it. A stale reference blocks the run via
        // recoverSingleRun's handler; an UNREACHABLE target (capped cycle) was
        // skipped above and must not block recovery of other branches.
        // Built-in/worker slots (agentId=null) are preserved.
        const missing = findMissingNodeAgentReferences(
          targetNode,
          (id) => this.config.spaceAgentManager.getById(id) !== null
        );
        if (missing.length > 0) {
          const first = missing[0];
          throw new MissingWorkflowAgentError(
            formatMissingAgentReference({
              runId: run.id,
              nodeLabel: targetNode.name,
              agentName: first.agentName,
              agentId: first.agentId,
            }),
            first
          );
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
    if (blockedReasons.length > 0) {
      log.warn(
        `SpaceRuntime.recoverStalledRuns: run ${run.id} has downstream transition(s) that cannot proceed: ${[
          ...new Set(blockedReasons),
        ].join('; ')}`
      );
    }
    return false;
  }

  /**
   * Resolves the channel cycle repository, preferring the injected instance
   * (mockable, shared) and falling back to one built from `db` for callers that
   * don't wire it (e.g. lightweight tests).
   */
  private getCycleRepo(): ChannelCycleRepository {
    return this.config.channelCycleRepo ?? new ChannelCycleRepository(this.config.db);
  }

  /**
   * Periodically prunes `channel_cycle_events` rows older than the rolling
   * dead-loop window across every run. Active runs already lazy-prune their own
   * (run, channel) on each traversal, but done/cancelled runs are reopenable and
   * therefore retain their history while never being traversed again — so
   * without this sweep they would leak rows until the next daemon restart (the
   * one-shot startup prune only covers runs that existed at boot).
   *
   * Throttled to one pass per `DEAD_LOOP_WINDOW_MS`: rows older than the window
   * are already excluded from the rate count, so deferring their physical
   * deletion by up to a window is harmless and keeps the (full-scan) prune off
   * the hot path. Best-effort — a failure is logged, never thrown.
   */
  pruneExpiredCycleEvents(now: number = Date.now()): void {
    if (now - this.lastGlobalCyclePruneAt < DEAD_LOOP_WINDOW_MS) return;
    this.lastGlobalCyclePruneAt = now;
    try {
      this.getCycleRepo().pruneAllOldEvents(now);
    } catch (err) {
      log.warn(
        `[SpaceRuntime] periodic channel_cycle_events prune failed: ${
          err instanceof Error ? err.message : String(err)
        }`
      );
    }
  }

  private evaluateRestartRecoveryCycle(
    runId: string,
    workflow: SpaceWorkflow,
    channel: WorkflowChannel,
    channelIndex: number
  ): { open: true } | { open: false; deadLoop: true; reason: string; recentCount: number } {
    if (!isChannelCyclic(channelIndex, workflow.channels ?? [], workflow.nodes)) {
      return { open: true };
    }
    // Rate-based dead-loop detection: block only a runaway tight ping-pong,
    // never a genuine extended review spread over time.
    const cycleRepo = this.getCycleRepo();
    const recentCount = cycleRepo.countRecentCycleEvents(runId, channelIndex);
    if (recentCount >= DEAD_LOOP_THRESHOLD) {
      return {
        open: false,
        deadLoop: true,
        recentCount,
        reason: `Cyclic channel "${channel.id ?? channelIndex}" is in a dead loop (too many round-trips within the rate window).`,
      };
    }
    return { open: true };
  }

  /**
   * Best-effort: publish a `space.workflowRun.deadLoop` event when restart
   * recovery finds a cyclic channel already in a dead loop, so the human sees
   * the block in the UI rather than a generic stall. Mirrors the live
   * `ChannelRouter.notifyDeadLoop` surfacing. Returns `true` on a successful
   * publish, `false` when no bus is configured or the publish threw — callers
   * use that to record dedup only on success (a failed publish must be
   * retryable on the next pass, not permanently suppressed).
   */
  private async notifyRecoveryDeadLoop(
    run: SpaceWorkflowRun,
    channel: WorkflowChannel,
    channelIndex: number,
    fromAgent: string,
    toTargets: string[],
    recentCount: number
  ): Promise<boolean> {
    if (!this.internalEventBus) return false;
    const channelLabel = channel.id ?? channelIndex;
    try {
      await this.internalEventBus.publish('space.workflowRun.deadLoop', {
        namespaceId: 'global',
        spaceId: run.spaceId,
        runId: run.id,
        fromAgent,
        toTarget: toTargets.length > 0 ? toTargets.join(',') : String(channelLabel),
        channelIndex,
        recentCount,
        threshold: DEAD_LOOP_THRESHOLD,
        windowMs: DEAD_LOOP_WINDOW_MS,
        reason: `Cyclic channel "${channelLabel}" is in a dead loop (detected during restart recovery): ${recentCount} message round-trips within the rate window.`,
        timestamp: new Date().toISOString(),
      } satisfies DaemonInternalEventMap['space.workflowRun.deadLoop'] & InternalEventPayload);
      return true;
    } catch (err) {
      log.warn(
        `[SpaceRuntime] deadLoop notify threw during recovery: ${
          err instanceof Error ? err.message : String(err)
        }`
      );
      return false;
    }
  }

  private recordRestartRecoveryCycleTraversal(
    runId: string,
    workflow: SpaceWorkflow,
    channel: WorkflowChannel,
    channelIndex: number
  ): void {
    if (!isChannelCyclic(channelIndex, workflow.channels ?? [], workflow.nodes)) return;
    const cycleRepo = this.getCycleRepo();
    cycleRepo.recordCycleEvent(runId, channelIndex);
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
        workflowNodeId: targetNode.id,
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
    for (const key of this.promptTooLongRecovery.keys()) {
      if (key.startsWith(runId + ':')) {
        this.promptTooLongRecovery.delete(key);
      }
    }
    for (const key of this.terminalErrorContinueStates.keys()) {
      if (key.startsWith(runId + ':')) {
        this.terminalErrorContinueStates.delete(key);
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

  /**
   * Compact-then-continue recovery for an idle execution that overflowed its
   * context window (terminal `prompt_too_long` result).
   *
   * State machine (keyed by `${runId}:${executionId}`):
   *  - prompt-too-long & awaitingContinue (compact in flight) & no result yet &
   *    within timeout → wait.
   *  - awaitingContinue & a `result` landed → clear the wait; if the result is
   *    non-overflow, mark continueNagPending; if overflow, re-compact/escalate.
   *  - awaitingContinue past COMPACT_RESULT_TIMEOUT_MS with no result → the
   *    compact turn hung → escalate to blocked.
   *  - prompt-too-long & not awaiting & attempts < MAX → inject `/compact`.
   *  - prompt-too-long & attempts >= MAX → escalate to blocked.
   *  - continueNagPending → deliver the resume nag; on success reset
   *    compactAttempts (productive compaction) and clear; on failure retry,
   *    bounded, then escalate.
   *
   * The wait clears ONLY on a `result` message (real turn completion) — not an
   * intermediate `status: 'compacting'` row — so the resume nag is never sent
   * mid-compaction. `compactAttempts` counts consecutive *unproductive*
   * compactions and resets on a productive resume, so a long-running worker is
   * not penalised for stale recovery history.
   */
  private async recoverPromptTooLongIdleExecution(
    runId: string,
    spaceId: string,
    canonicalTask: SpaceTask,
    execution: NodeExecution,
    lastMessage: SDKMessage | null | undefined,
    manager: TaskAgentManager | undefined
  ): Promise<'handled' | 'blocked'> {
    const key = `${runId}:${execution.id}`;
    const sessionId = execution.agentSessionId;
    const now = Date.now();
    const state = this.promptTooLongRecovery.get(key) ?? createPromptTooLongRecoveryState();
    this.promptTooLongRecovery.set(key, state);

    const lastMessageDbId = (lastMessage as { dbId?: string } | null | undefined)?.dbId ?? null;
    const lastMessageIsResult =
      !!lastMessage && (lastMessage as { type?: string }).type === 'result';
    const overflowed = isPromptTooLongErrorMessage(lastMessage);
    const lastMessageIsSuccessResult =
      lastMessageIsResult && !(lastMessage as { is_error?: boolean }).is_error;

    // The `/compact` turn landed a RESULT (real completion — not an intermediate
    // status/compact_boundary row) OR another prompt-too-long user message (e.g.
    // Kimi returning the overflow as `<local-command-stderr>` stderr). End the
    // wait and re-evaluate.
    let compactJustFailed = false;
    if (
      state.awaitingContinue &&
      state.awaitingContinueAfterDbId !== null &&
      lastMessageDbId !== state.awaitingContinueAfterDbId &&
      (lastMessageIsResult || overflowed)
    ) {
      state.awaitingContinue = false;
      state.awaitingContinueAfterDbId = null;
      state.awaitingContinueSince = null;
      // Only a SUCCESS result proves compaction shrank the context — queue the
      // resume nag and record this result as the resume anchor. A non-overflow
      // ERROR result (model/auth/rate-limit) means compaction failed; route it to
      // re-compact/escalate instead of resuming into an unchanged, still-over-limit
      // context.
      if (lastMessageIsSuccessResult) {
        state.continueNagPending = true;
        state.awaitingResumeAfterDbId = lastMessageDbId;
      } else if (!overflowed) {
        compactJustFailed = true;
      }
      // A fresh overflow result falls through with `overflowed` to re-compact.
    }

    // Resume-nag wait: after the continue nag is delivered it is an enqueued
    // user message invisible to getLastSDKMessage, so the sweep keeps seeing the
    // compact-success anchor until the resumed turn advances. Hold the recovery
    // open (preventing the terminal-skip from clearing the state and resetting
    // compactAttempts prematurely). When the resumed turn produces a RESULT:
    //  - SUCCESS → productive, clear the recovery state (fresh next time);
    //  - prompt-too-long → re-compact/escalate with attempts PRESERVED;
    //  - non-overflow ERROR (auth/rate-limit/model) → route to re-compact/escalate
    //    (not silently cleared as productive — the resume failed, and a persistent
    //    error escalates to blocked at the cap rather than leaving the run idle).
    //
    // The wait is bounded by COMPACT_RESULT_TIMEOUT_MS: if the resumed turn never
    // produces a result (provider hang / session died after consuming the nag),
    // escalate — the execution is `idle`, so the alive-stuck sweep cannot rescue it.
    //
    // The wait clears ONLY on a RESULT from the resumed turn — not on the
    // consumed continue nag itself (a user message), which getLastSDKMessage
    // briefly returns before the resumed API call returns.
    if (state.awaitingResume && state.awaitingResumeAfterDbId !== null) {
      // Process a visible resumed-turn RESULT before the timeout — a turn that
      // legitimately took longer than the window (e.g. tick loop paused) but
      // did complete must not be mis-blocked. Timeout fires only when NO result
      // has landed (mirrors the /compact wait's result-first ordering).
      // A newer prompt-too-long user message (e.g. Kimi stderr) also completes
      // the resumed turn, so treat it the same as an overflow result.
      if (
        lastMessageDbId !== state.awaitingResumeAfterDbId &&
        (lastMessageIsResult || overflowed)
      ) {
        state.awaitingResume = false;
        state.awaitingResumeAfterDbId = null;
        state.awaitingResumeSince = null;
        state.awaitingResumeLastProgressDbId = null;
        if (lastMessageIsSuccessResult) {
          // Productive — real progress. Clear the recovery state (fresh next time).
          this.promptTooLongRecovery.delete(key);
          return 'handled';
        }
        // Overflow (fall through with `overflowed`) OR non-overflow error: the
        // resume did not make progress → re-compact/escalate with attempts preserved.
        if (!overflowed) {
          compactJustFailed = true;
        }
      } else {
        // No resumed-turn result yet. Refresh the timeout clock ONLY when a NEW
        // progress message appears (dbId differs from the anchor AND from the
        // last progress dbId). Refreshing on every tick for an unchanged row
        // would let a turn that hung after producing one message never time out.
        if (
          lastMessageDbId !== state.awaitingResumeAfterDbId &&
          lastMessageDbId !== state.awaitingResumeLastProgressDbId &&
          state.awaitingResumeSince !== null
        ) {
          state.awaitingResumeSince = now;
          state.awaitingResumeLastProgressDbId = lastMessageDbId;
        }
        if (
          state.awaitingResumeSince !== null &&
          now - state.awaitingResumeSince > COMPACT_RESULT_TIMEOUT_MS
        ) {
          const reason = `Context-overflow recovery timed out: the resumed turn did not produce a result within ${COMPACT_RESULT_TIMEOUT_MS / 1000}s for agent ${execution.agentName}.`;
          await this.escalatePromptTooLongBlocked(
            runId,
            spaceId,
            canonicalTask,
            execution,
            now,
            reason,
            manager
          );
          return 'blocked';
        }
        return 'handled'; // nag enqueued/consumed but resumed turn hasn't produced a result
      }
    }

    // Bound the post-compact wait: if the /compact turn produced no result
    // within the timeout, it hung — escalate (the execution is `idle`, so the
    // alive-stuck sweep cannot rescue it).
    if (
      state.awaitingContinue &&
      state.awaitingContinueSince !== null &&
      now - state.awaitingContinueSince > COMPACT_RESULT_TIMEOUT_MS
    ) {
      const reason = `Context-overflow recovery timed out: the /compact turn did not produce a result within ${COMPACT_RESULT_TIMEOUT_MS / 1000}s for agent ${execution.agentName}.`;
      await this.escalatePromptTooLongBlocked(
        runId,
        spaceId,
        canonicalTask,
        execution,
        now,
        reason,
        manager
      );
      return 'blocked';
    }

    // Re-compact/escalate on a fresh overflow OR a just-failed compaction
    // (non-overflow error result). Both mean compaction did not shrink the
    // context enough. Also re-enter on a pending retry after a previously failed
    // injection (compactRetryPending) — a non-overflow-error last message
    // wouldn't otherwise re-enter the gate.
    if (overflowed || compactJustFailed || state.compactRetryPending) {
      state.compactRetryPending = false;
      // `/compact` still in flight — wait for the result.
      if (state.awaitingContinue) {
        return 'handled';
      }
      if (state.compactAttempts >= MAX_PROMPT_TOO_LONG_RECOVERY_ATTEMPTS) {
        const reason =
          compactJustFailed || state.compactRetryPending
            ? `Context-overflow recovery: /compact failed (non-overflow error) after ${state.compactAttempts} attempt(s) for agent ${execution.agentName}.`
            : `Context overflow ("prompt is too long") could not be resolved after ${state.compactAttempts} compaction attempt(s); agent ${execution.agentName} cannot make progress.`;
        await this.escalatePromptTooLongBlocked(
          runId,
          spaceId,
          canonicalTask,
          execution,
          now,
          reason,
          manager
        );
        return 'blocked';
      }
      // Compact FIRST, then continue on a later tick. Count the attempt toward
      // the cap up front so a session that cannot receive the compact still
      // escalates. Only mark awaiting after a successful injection.
      state.compactAttempts += 1;
      let injectedDbId: string | null = null;
      try {
        injectedDbId =
          (await manager?.injectRuntimeRecoveryMessage(sessionId!, '/compact')) ?? null;
      } catch (err) {
        log.warn(
          `SpaceRuntime: failed to inject /compact for overflowed execution ${execution.id} ` +
            `(session ${sessionId}): ${err instanceof Error ? err.message : String(err)}`
        );
      }
      if (injectedDbId !== null) {
        state.awaitingContinue = true;
        // Anchor the wait on the PRE-COMPACT last message (the overflow result),
        // NOT the injected `/compact`. `getLastSDKMessage` excludes user messages
        // saved with send_status='enqueued' (sdk-message-repository.ts:995), and
        // injectRuntimeRecoveryMessage enqueues the `/compact` — so the injected
        // row is invisible to getLastSDKMessage until the SDK consumes it. While
        // the `/compact` is in flight, getLastSDKMessage keeps returning this
        // pre-compact result; the wait clears only when a newer consumed/result
        // row lands (the compacted turn's output).
        state.awaitingContinueAfterDbId = lastMessageDbId;
        state.awaitingContinueSince = now;
        log.warn(
          `SpaceRuntime: injected /compact for overflowed execution ${execution.id} ` +
            `(agent ${execution.agentName}, session ${sessionId}, attempt ${state.compactAttempts}/${MAX_PROMPT_TOO_LONG_RECOVERY_ATTEMPTS})`
        );
      } else {
        // Injection failed — preserve a retryable flag so the next tick re-enters
        // (a non-overflow-error last message wouldn't re-enter the gate on its own).
        state.compactRetryPending = true;
        log.warn(
          `SpaceRuntime: could not inject /compact for overflowed execution ${execution.id} ` +
            `(session ${sessionId}); will retry or escalate on the next tick`
        );
      }
      return 'handled';
    }

    // Not prompt-too-long. If a `/compact` is still in flight (no result yet),
    // wait for the post-compact result.
    if (state.awaitingContinue) {
      return 'handled';
    }

    // Compaction succeeded — deliver the resume nag (retryable on failure so a
    // transient/absent injection is not silently swallowed). On success the
    // compaction was productive: reset compactAttempts so a long-running worker
    // that legitimately re-fills context is not blocked by stale history.
    if (state.continueNagPending) {
      let nagDelivered = false;
      try {
        nagDelivered =
          !!(await manager?.injectRuntimeRecoveryMessage(
            sessionId!,
            buildPromptTooLongContinueNag()
          )) && !!manager;
      } catch (err) {
        log.warn(
          `SpaceRuntime: failed to inject continue nag for execution ${execution.id} ` +
            `(session ${sessionId}): ${err instanceof Error ? err.message : String(err)}`
        );
      }
      if (nagDelivered) {
        state.continueNagPending = false;
        state.continueNagAttempts = 0;
        // compactAttempts is NOT reset here (see awaitingResume handling above).
        // The delivered nag is an enqueued user message invisible to
        // getLastSDKMessage, so awaitingResume holds the recovery open until the
        // resumed turn actually advances — preventing the terminal-skip from
        // clearing the state (and resetting attempts) while the nag is in flight.
        state.awaitingResume = true;
        state.awaitingResumeSince = now;
        log.warn(
          `SpaceRuntime: injected continue nag after compaction for execution ${execution.id} (agent ${execution.agentName}, session ${sessionId})`
        );
      } else {
        state.continueNagAttempts += 1;
        if (state.continueNagAttempts >= MAX_PROMPT_TOO_LONG_RECOVERY_ATTEMPTS) {
          const reason = `Context-overflow recovery could not deliver the resume nag to agent ${execution.agentName} after ${state.continueNagAttempts} attempts (session unavailable).`;
          await this.escalatePromptTooLongBlocked(
            runId,
            spaceId,
            canonicalTask,
            execution,
            now,
            reason,
            manager
          );
          return 'blocked';
        }
        log.warn(
          `SpaceRuntime: continue nag delivery failed for execution ${execution.id} ` +
            `(session ${sessionId}); will retry (attempt ${state.continueNagAttempts}/${MAX_PROMPT_TOO_LONG_RECOVERY_ATTEMPTS})`
        );
      }
      return 'handled';
    }

    // No active recovery phase and not overflowing — nothing to recover.
    this.promptTooLongRecovery.delete(key);
    return 'handled';
  }

  /**
   * Shared escalation: mark the execution + run `blocked`, notify, and clear the
   * prompt-too-long recovery state.
   */
  private async escalatePromptTooLongBlocked(
    runId: string,
    spaceId: string,
    canonicalTask: SpaceTask,
    execution: NodeExecution,
    now: number,
    reason: string,
    manager: TaskAgentManager | undefined
  ): Promise<void> {
    const key = `${runId}:${execution.id}`;
    // Cancel the (possibly still-running) session before detaching. A timed-out
    // /compact or resumed turn may still be processing; leaving it alive while the
    // bounded blocked-run retry spawns a fresh agent would run two sessions
    // concurrently for one execution.
    if (execution.agentSessionId) {
      try {
        manager?.cancelBySessionId?.(execution.agentSessionId);
      } catch (err) {
        log.warn(
          `SpaceRuntime: failed to cancel session ${execution.agentSessionId} during prompt-too-long escalation: ${err instanceof Error ? err.message : String(err)}`
        );
      }
    }
    this.promptTooLongRecovery.delete(key);
    this.config.nodeExecutionRepo.update(execution.id, {
      status: 'blocked',
      result: reason,
      // Detach the overflowed session. Its context is exhausted, so reusing it
      // would just re-overflow. Clearing the id lets the bounded blocked-run
      // retry (attemptBlockedRunRecovery) spawn fresh on retry instead of
      // resurrecting this terminal-overflow session into a stuck in_progress.
      agentSessionId: null,
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
    log.warn(
      `SpaceRuntime: blocked execution ${execution.id} (agent ${execution.agentName}) — ${reason}`
    );
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
      // Use the NEWEST PROGRESS timestamp, not a ??-chain: once lastActivityAt
      // is set it must not shadow a MORE RECENT SDK message (or vice versa), or
      // the detector could nag/restart an agent that just made progress.
      // lastActivityAt captures tool/message/commit activity that the SDK-message
      // timestamp misses; take the max of the progress signals only.
      // `startedAt` is deliberately EXCLUDED from the max — it is a session-
      // lifecycle marker (re-stamped on restart/recovery), not progress, so
      // including it would let a freshly-(re)started-but-still-stuck agent look
      // fresh and suppress its restart. It remains a fallback for a brand-new
      // session that has produced no progress signal yet.
      const progressSignals = [execution.lastActivityAt, progressMessage?.timestamp].filter(
        (t): t is number => typeof t === 'number'
      );
      const observedAt =
        progressSignals.length > 0
          ? Math.max(...progressSignals)
          : (execution.startedAt ?? state.lastActionAt ?? now);
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
    if (run.status === 'cancelled' || isWorkflowRunSucceeded(run.status)) {
      this.clearAgentStuckStateForRun(runId);
      return;
    }

    // Waiting run recovery: attempt bounded automatic retry before giving up.
    if (isWorkflowRunWaiting(run.status)) {
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

    // ─── Rate/usage-limited pause guard ───────────────────────────────────
    // A canonical task paused on a rate/usage cap has a dead worker session
    // (the cooldown timer owns the wait, or the daemon restarted mid-wait).
    // Skip ALL liveness/spawn/respawn processing for it: its in_progress
    // execution must NOT be classified as crashed and respawned (that would
    // resume work immediately, bypassing the cooldown). When
    // `recoverRateLimitedTasks()` later restores the task to `in_progress`
    // (reset time passed), the next tick re-enters the normal path and the
    // execution is re-driven then.
    if (isRateOrUsageLimited(canonicalTask.status)) {
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

      // Catch-all recovery: a node-agent session that ended on a terminal error
      // result (e.g. Codex 400, error_during_execution) leaves the node idle
      // with a *live* session that no other sweep recovers — the result is
      // classified terminal so the non-terminal-idle and alive-stuck paths both
      // bail. Auto-continue once/twice, then escalate to `blocked` so
      // attemptBlockedRunRecovery takes over with its own bounded re-spawn.
      const terminalErrorOutcome = await this.handleTerminalErrorIdleExecutions(
        runId,
        meta.spaceId,
        canonicalTask,
        tam,
        space ?? null
      );
      if (terminalErrorOutcome === 'blocked') {
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
        // Recovery recheck BEFORE the terminal flip: `runIsComplete` was
        // decided before the awaited sweeps above (stall/blocked/timeout
        // handling, idle-execution recovery, handoff repair), and a
        // concurrent `recoverWorkflowBackedTask` can land during one of
        // those awaits — reopening the task (in_progress, reportedStatus
        // cleared) while the local snapshot still reads terminal. Flipping
        // the run to done on the stale decision would stomp the recovery:
        // subsequent ticks early-return for the succeeded run, the reopened
        // task's pending execution never spawns, and the periodic
        // reconciler later force-dispatches the task back to done —
        // silently reverting the reopen. Re-derive the completion state
        // with the SAME completion signal the post-transition check uses
        // (done/cancelled, or a non-null reportedStatus): a recovery to
        // `open` clears reportedStatus without touching the run, and an
        // `open` task attached to a done run would never be driven again
        // from the CURRENT rows and let the next tick evaluate the
        // recovered state instead.
        const preTransitionTask = this.config.taskRepo.getTask(canonicalTask.id);
        const preTransitionRun = this.config.workflowRunRepo.getRun(runId);
        const preTransitionHolds =
          (preTransitionRun == null || preTransitionRun.status === 'in_progress') &&
          (preTransitionTask == null ||
            preTransitionTask.workflowRunId === runId ||
            preTransitionTask.workflowRunId == null) &&
          (preTransitionTask == null ||
            preTransitionTask.status === 'done' ||
            preTransitionTask.status === 'cancelled' ||
            preTransitionTask.reportedStatus !== null);
        if (!preTransitionHolds) {
          return;
        }
        await this.transitionRunStatusAndEmit(runId, 'done');
        // Re-read the canonical task before deciding routing: the snapshot
        // above predates awaits (duplicate-repair, this transition), and
        // CompletionDetector rereads from the DB — so an external terminal
        // write landing during one of those awaits (e.g.
        // complete_validation_task) makes `runIsComplete` true while the
        // local `canonicalTask` is still stale. Deciding `taskAlreadyResolved`
        // from the stale row would route a freshly-done task through
        // dispatchPostApproval (an invalid done→approved attempt) instead of
        // the resolved branch (result precedence, evidence refresh, sibling
        // quiesce). (task #918)
        const refreshedCanonical = this.config.taskRepo.getTask(canonicalTask.id);
        if (refreshedCanonical) {
          canonicalTask = refreshedCanonical;
        }
        // Recompute completion after the refresh: a concurrent
        // `recoverWorkflowBackedTask` reopens BOTH the run and the task in
        // one transaction (run → in_progress, task reset with reportedStatus
        // cleared) and can land during the awaited transition notification
        // above. The refreshed task observes that recovery, but
        // `runIsComplete` above is the stale decision — continuing would
        // dispatch post-approval on the recovered task, re-terminalize it,
        // and quiesce the freshly recovered workers. If the run is no longer
        // done, or the refreshed task no longer signals completion, return
        // and let the next tick evaluate the recovered state. (task #918)
        const runAfterTransition = this.config.workflowRunRepo.getRun(runId);
        const completionStillHolds =
          runAfterTransition?.status === 'done' &&
          // The refreshed task must still belong to THIS run: a mid-tick
          // `spaceTask.update` can move a done task to another run while
          // retaining its completion signal — finalizing this run would
          // then apply its outcome and post-approval routing to a task the
          // new run owns, prematurely completing that workflow.
          (canonicalTask.workflowRunId == null || canonicalTask.workflowRunId === runId) &&
          (canonicalTask.status === 'done' ||
            canonicalTask.status === 'cancelled' ||
            canonicalTask.reportedStatus !== null);
        if (!completionStillHolds) {
          return;
        }
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
        // Capture the post-approval session the router may spawn just below so
        // the sibling-quiesce sweep does NOT interrupt it. The spawn happens in
        // the SAME synchronous block as the sweep (`dispatchPostApproval` →
        // `PostApprovalRouter.route` → `spawnPostApprovalSubSession` stamps an
        // `in_progress` node_execution for the merge target node). Without this
        // exclusion the sweep's victim set is stale relative to that spawn and
        // kills the freshly-created merge session ~2ms after it starts.
        let spawnedPostApprovalSessionId: string | undefined;

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
          // The router stamps `postApprovalSessionId` on the task for the
          // `spawn` (fresh sub-session) and `already-routed` (prior live
          // sub-session) modes. Narrow the union so we can carry it into the
          // sibling-quiesce exclusion below.
          spawnedPostApprovalSessionId =
            result.mode === 'spawn' || result.mode === 'already-routed'
              ? result.postApprovalSessionId
              : undefined;
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
          // Refresh auto-captured Forge evidence for an EXTERNALLY resolved
          // task (e.g. `complete_validation_task`): its terminal transition
          // captured evidence while this run was still `in_progress` —
          // provisional result, non-terminal run status, null completedAt.
          // The run just transitioned to `done` above and the result
          // precedence was applied, so recapture now; `createAutoEvidenceOnce`
          // upserts (kind + sourceId keyed), so this refreshes the existing
          // record in place and is a no-op-shape pass for runtime-driven
          // completions whose capture already saw the final state. (task #918)
          if (canonicalTask.status === 'done') {
            try {
              this.config.evolutionScopeService?.captureCompletedTaskEvidence({
                taskId: canonicalTask.id,
              });
            } catch (err) {
              log.warn(
                `Forge evidence recapture threw for task "${canonicalTask.id}": ${err instanceof Error ? err.message : String(err)}`
              );
            }
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
          // Recovery recheck: the decision above was computed from the
          // `canonicalTask` snapshot taken before the awaited publishes
          // (outcome updates, dispatch, evidence recapture). A concurrent
          // `recoverWorkflowBackedTask` can commit during one of those awaits
          // — reopening the run AND the task to `in_progress` and restarting
          // node executions — while the local snapshot still says terminal.
          // The sweep's victim list is read FRESH below, so proceeding on the
          // stale decision would idle + interrupt the freshly recovered
          // workers. Reread both rows and only sweep when the recovery did
          // not land: task still terminal AND run still `done`.
          const refreshedTask = this.config.taskRepo.getTask(canonicalTask.id);
          const refreshedRun = this.config.workflowRunRepo.getRun(runId);
          const refreshedStatus = refreshedTask?.status ?? canonicalTask.status;
          const stillTerminal =
            (refreshedStatus === 'done' ||
              refreshedStatus === 'cancelled' ||
              refreshedStatus === 'blocked' ||
              refreshedStatus === 'approved') &&
            refreshedRun?.status === 'done';
          if (!stillTerminal) {
            return;
          }
          // Resolve the source node to exclude from quiescing. Prefer the DURABLE
          // `postApprovalSourceNodeId`; fall back to `pendingCompletionSubmittedByNodeId`
          // (the no-route branch clears the durable field on approved → done but
          // deliberately retains the pending field as an audit write, so for a
          // `done` canonical task re-processed by a reconciliation tick while the
          // run is still active — e.g. a human no-route approval, whose RPC path
          // doesn't pre-quiesce siblings — the retained pending field is the only
          // record of the non-end submitter); then the workflow end node. Without
          // this ordering a reconciliation sweep on such a task would fall through
          // to `endNodeId` and interrupt the real submitter instead of excluding
          // it. (task #851.)
          const sourceNodeId =
            canonicalTask.postApprovalSourceNodeId ??
            canonicalTask.pendingCompletionSubmittedByNodeId ??
            endNodeId;
          const siblingsToQuiesce = this.config.nodeExecutionRepo.listByWorkflowRun(runId).filter(
            (e) =>
              e.status === 'in_progress' &&
              e.agentSessionId &&
              // Do not kill the post-approval session the router just spawned
              // in this same synchronous block — it is the legitimate
              // continuation worker (e.g. the merge step), not a stale sibling.
              e.agentSessionId !== spawnedPostApprovalSessionId &&
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
                `to idle for finished execution attempt ${runId}; session kept alive for post-completion messaging`
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
              // A deferred spawn (task paused on a rate/usage cap): leave the
              // execution `pending` and re-attempt on a later tick once
              // recoverRateLimitedTasks restores the task. NOT a crash (don't
              // consume a crash-retry) and NOT permanent (don't
              // cancel/unregister — a transient cooldown must not permanently
              // remove the target agent).
              if (isTransientSpawnError(err)) {
                log.warn(
                  `SpaceRuntime: deferring spawn for limited-task execution ${execution.id}: ${err instanceof Error ? err.message : String(err)}`
                );
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
          if (canonicalTask.status === 'open') {
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

    if (pending.length === 0) {
      const expiredNodeHandoffs = repo
        .listByRunAndStatus(runId, 'expired')
        .filter((row) => row.targetKind === 'node_agent');
      if (expiredNodeHandoffs.length > 0) {
        const first = expiredNodeHandoffs[0];
        const reason = `Queued workflow handoff to ${first.targetAgentName} expired before delivery after ${first.attempts} attempt(s)`;
        await this.blockRunForQueuedHandoffFailure(runId, meta.spaceId, canonicalTask, reason);
        return true;
      }
      return false;
    }

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
    // Group by (targetAgentName, workflowNodeId) so two nodes reusing a slot
    // name drain independently — otherwise recovery picks the first node and
    // strands the other’s queued rows until they expire and block the run.
    // Use a structured Map instead of an in-band delimiter (slot names are
    // only validated as non-empty + unique, so a delimiter could collide).
    const groups = new Map<string, Map<string, typeof pending>>();
    for (const row of pending) {
      const nodeId = row.workflowNodeId ?? '';
      let nodeMap = groups.get(row.targetAgentName);
      if (!nodeMap) {
        nodeMap = new Map();
        groups.set(row.targetAgentName, nodeMap);
      }
      let rows = nodeMap.get(nodeId);
      if (!rows) {
        rows = [];
        nodeMap.set(nodeId, rows);
      }
      rows.push(row);
    }
    const recordBlockedFlushFailure = (
      targetAgentName: string,
      rowsForCurrentAttempt: typeof pending
    ): void => {
      // The scoped flush (listPendingForTarget with workflowNodeId) also drains
      // legacy null-node rows (workflow_node_id IS NULL) for the same target, so
      // a failure in those rows isn't visible in `rowsForCurrentAttempt`. Include
      // every pending row for the target — from the original snapshot plus the
      // attempt's rows — so a failed handoff always blocks the run as intended.
      const targetRows = [
        ...rowsForCurrentAttempt,
        ...pending.filter((row) => row.targetAgentName === targetAgentName),
      ];
      const first = targetRows
        .map((row) => repo.getById(row.id))
        .find((row) => row?.status === 'failed');
      if (!first) return;
      blockedReason = `Queued workflow handoff to ${targetAgentName} failed after ${first.attempts} attempt(s): ${first.lastError ?? 'delivery failed'}`;
    };

    // Legacy null-node rows drain for EVERY scoped group (the flush includes
    // workflow_node_id IS NULL). A transiently-failed legacy row would be
    // retried once per group in a single tick, consuming all retry attempts and
    // blocking the run. Track which legacy rows this sweep has already attempted
    // and let only the FIRST group that sees them drive the drain.
    const attemptedLegacyIds = new Set<string>();
    for (const [targetAgentName, nodeMap] of groups) {
      for (const [workflowNodeIdRaw, rowsForTarget] of nodeMap) {
        const workflowNodeId = workflowNodeIdRaw || undefined;
        try {
          // Reload this group's rows fresh: a prior group's flush can consume
          // shared null-node rows (listPendingForTarget includes
          // workflow_node_id IS NULL), so the original snapshot may list rows
          // already delivered. Skip to avoid an unnecessary resume/spawn of an
          // unrelated agent continuation.
          const remainingForGroup = repo.listPendingForRun(runId).filter(
            (row) =>
              row.targetAgentName === targetAgentName &&
              (row.workflowNodeId ?? '') === workflowNodeIdRaw &&
              // Skip legacy null-node rows already attempted by an earlier
              // group in this sweep (retry-storm guard).
              (row.workflowNodeId || !attemptedLegacyIds.has(row.id))
          );
          if (remainingForGroup.length === 0) continue;

          // Resolve the target and rescope legacy compound / null-scoped rows to
          // the pinned bare form (bare agent + resolved node id) BEFORE the
          // execution lookup. The rescope must run whether or not an execution
          // already exists — otherwise an existing execution skips it, the row
          // keeps its old "<nodeId>/<agent>" key, and the flush (bare agent +
          // "<nodeName>/<agent>") never sees it, so it expires and blocks the run.
          const rescopedTarget = this.resolveQueuedHandoffTarget(
            meta.workflow,
            targetAgentName,
            workflowNodeId
          );
          if (
            rescopedTarget &&
            (targetAgentName !== rescopedTarget.agentName ||
              (workflowNodeId ?? null) !== rescopedTarget.nodeId)
          ) {
            for (const row of remainingForGroup) {
              repo.rescopeTarget(row.id, rescopedTarget.agentName, rescopedTarget.nodeId);
            }
          }

          let execution = this.resolveQueuedHandoffExecution(
            runId,
            meta.workflow,
            targetAgentName,
            workflowNodeId
          );

          if (!execution) {
            if (!rescopedTarget) {
              throw new Error(
                `Queued workflow handoff target "${targetAgentName}" is not declared in workflow "${meta.workflow.id}"`
              );
            }
            execution = this.createNodeExecutionOrIgnore({
              workflowRunId: runId,
              workflowNodeId: rescopedTarget.nodeId,
              agentName: rescopedTarget.agentName,
              agentId: rescopedTarget.agentId,
              status: 'pending',
            });
          }

          if (execution.status === 'waiting_rebind') {
            continue;
          }

          await tam.tryResumeNodeAgentSession(
            runId,
            execution.agentName,
            execution.workflowNodeId ?? undefined
          );
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
            // The flush drains legacy null-node rows for this target alongside
            // the scoped rows (listPendingForTarget includes IS NULL). Mark ALL
            // of the target's pending legacy rows attempted so a later scoped
            // group in this sweep doesn't re-drain a transiently-failed one.
            for (const row of pending) {
              if (row.targetAgentName === targetAgentName && !row.workflowNodeId) {
                attemptedLegacyIds.add(row.id);
              }
            }
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
          for (const row of pending) {
            if (row.targetAgentName === targetAgentName && !row.workflowNodeId) {
              attemptedLegacyIds.add(row.id);
            }
          }
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
            targetAgentName,
            workflowNodeId
          );
          if (maybeExecution) this.cancelExecutionForPermanentSpawnError(maybeExecution, err);
          for (const row of rowsForTarget) {
            const updated = repo.markAttemptFailed(row.id, errMsg);
            if (updated?.status === 'failed') {
              blockedReason = `Queued workflow handoff to ${targetAgentName} failed after ${updated.attempts} attempt(s): ${errMsg}`;
            }
          }
          // Mark the target's pending legacy null-node rows attempted on ANY
          // outcome (including transient errors) so a later scoped group in the
          // same sweep doesn't re-drain them — a retry storm would consume all
          // attempts and block the run. The flush drains legacy rows alongside
          // the scoped ones, so they belong to this group's attempt too.
          for (const row of pending) {
            if (row.targetAgentName === targetAgentName && !row.workflowNodeId) {
              attemptedLegacyIds.add(row.id);
            }
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
    targetAgentName: string,
    workflowNodeId?: string
  ): NodeExecution | undefined {
    const resolved = this.resolveQueuedHandoffTarget(workflow, targetAgentName, workflowNodeId);
    if (resolved) {
      const nodeExecution = this.config.nodeExecutionRepo
        .listByNode(runId, resolved.nodeId)
        .filter((candidate) => candidate.agentName === resolved.agentName)
        .at(-1);
      if (nodeExecution) return nodeExecution;
    }

    // Legacy fallback for targets the resolver could not map to a declared
    // node/slot (e.g. a bare slot/node name no longer in the workflow). The raw
    // comparison is intentional for compound targets: a valid compound is
    // resolved above, and an invalid one has no matching execution, so comparing
    // the full "node/agent" string returns undefined and lets the caller surface
    // it as undeclared. Stripping the prefix here would over-match — e.g.
    // "WrongNode/reviewer" would bind to another node's reviewer execution.
    return this.config.nodeExecutionRepo
      .listByWorkflowRun(runId)
      .filter(
        (candidate) =>
          candidate.agentName === targetAgentName &&
          (!workflowNodeId || candidate.workflowNodeId === workflowNodeId)
      )
      .at(-1);
  }

  private resolveQueuedHandoffTarget(
    workflow: SpaceWorkflow,
    targetAgentName: string,
    workflowNodeId?: string
  ): { nodeId: string; agentName: string; agentId: string | null } | null {
    // Queued handoff rows are addressed two ways:
    //  - PINNED (workflowNodeId set): the router and enqueueRestartRecoveryMessage
    //    store the BARE agent slot name + the node id. Slot names may contain "/",
    //    so match the exact name and never interpret it as a compound.
    //  - UNPINNED (legacy, workflowNodeId absent): the router stored a compound
    //    "<nodeId-or-name>/<agent>" so two nodes reusing a slot name don't
    //    cross-receive. Worker handles encode either the node name or id, and
    //    node/agent names may contain "/", so match by prefixing each node
    //    identifier and comparing exactly — never split on the first "/".
    // Unpinned only, and only for slash-shaped targets: a slot name containing
    // "/" can resemble another node's compound (e.g. Audit slot "Review/foo" vs
    // Review's compound "Review/foo"), so an exact bare-slot match must win over
    // compound parsing. Limit to "/"-containing values so a bare node name like
    // "Review" still falls through to the bare-node/legacy handling below even
    // if another node happens to have a slot of that name.
    if (!workflowNodeId && targetAgentName.includes('/')) {
      for (const node of workflow.nodes) {
        const exact = resolveNodeAgents(node).find((slot) => slot.name === targetAgentName);
        if (exact)
          return { nodeId: node.id, agentName: exact.name, agentId: exact.agentId ?? null };
      }
    }
    for (const node of workflow.nodes) {
      // Node-scoped resolution: only consider the pinned node so two nodes
      // reusing a slot name don't both resolve to the first one.
      if (workflowNodeId != null && node.id !== workflowNodeId) continue;
      const slots = resolveNodeAgents(node);

      if (workflowNodeId != null) {
        // Pinned row: bare slot name. Match exactly (a slot named
        // "<node>/reviewer" must not be stripped to "reviewer"). No compound
        // parsing, no slots[0] fallback — the row is for this node specifically.
        // Use an explicit null check so an empty-string node id still pins.
        const direct = slots.find((slot) => slot.name === targetAgentName);
        if (direct)
          return { nodeId: node.id, agentName: direct.name, agentId: direct.agentId ?? null };
        continue;
      }

      // Unpinned compound "<nodeId-or-name>/<agent>": a precise address. The node
      // must match by name or id AND the named slot must exist — a non-matching
      // slot (typo, stale def, wrong node) returns no match instead of falling
      // back to another slot and misdelivering (e.g. "Review/reveiwer" must fail).
      let nodeFormMatched = false;
      for (const nodeForm of [node.name, node.id]) {
        const prefix = `${nodeForm}/`;
        if (!targetAgentName.startsWith(prefix)) continue;
        nodeFormMatched = true;
        const direct = slots.find((slot) => slot.name === targetAgentName.slice(prefix.length));
        if (direct)
          return { nodeId: node.id, agentName: direct.name, agentId: direct.agentId ?? null };
      }
      if (nodeFormMatched) continue;

      // Legacy non-compound behavior for bare slot names and node names.
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
      // Prompt-too-long recovery takes priority over both the terminal-skip and
      // the generic non-terminal idle path. It must fire for a terminal overflow
      // result, while awaiting a post-compact result, and while a resume nag is
      // pending (retryable) — regardless of whether the latest message is
      // classified as terminal.
      const ptlState = this.promptTooLongRecovery.get(key);
      if (
        isPromptTooLongErrorMessage(lastMessage) ||
        ptlState?.awaitingContinue ||
        ptlState?.continueNagPending ||
        ptlState?.awaitingResume ||
        ptlState?.compactRetryPending
      ) {
        const manager = tam ?? this.config.taskAgentManager;
        const outcome = await this.recoverPromptTooLongIdleExecution(
          runId,
          spaceId,
          canonicalTask,
          execution,
          lastMessage,
          manager
        );
        if (outcome === 'blocked') return 'blocked';
        preservedAny = true;
        continue;
      }
      if (classification.terminal) {
        this.nonTerminalIdleStates.delete(key);
        this.promptTooLongRecovery.delete(key);
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

      // Newest PROGRESS timestamp — see handleAliveStuckExecutions for why this
      // is a max over progress signals only (a stale lastActivityAt must not
      // shadow a newer SDK message; startedAt is a lifecycle marker excluded
      // from the max and used only as a fallback).
      const progressSignals = [
        execution.lastActivityAt,
        state.lastObservedProgressMessageAt,
        progressMessage?.timestamp,
      ].filter((t): t is number => typeof t === 'number');
      const observedAt =
        progressSignals.length > 0
          ? Math.max(...progressSignals)
          : (execution.startedAt ?? Date.now());
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

  /**
   * Catch-all recovery for idle node-agent sessions that ended on a terminal
   * error result (e.g. Codex 400, `error_during_execution`).
   *
   * The result is classified `terminal`, so neither `handleAliveStuckExecutions`
   * nor `handleNonTerminalIdleExecutions` acts on it — the node silently goes
   * idle with a live session and no recovery fires. This sweep injects a bounded
   * number of "continue" messages via the same primitive a manual continue uses
   * (`tam.injectRuntimeRecoveryMessage`), then escalates to `blocked` so
   * `attemptBlockedRunRecovery` takes over with its own re-spawn cap.
   *
   * Guards (see task #673):
   * - Only retryable subtypes (`error_during_execution`, `error_max_turns`) are
   *   continued. Cost (`error_max_budget_usd`) and structured-output exhaustion
   *   are skipped (non-retryable); prompt-too-long is deferred to #670.
   * - Only when the task is `in_progress` with no `reportedStatus`.
   * - A live session gets a bounded continue; a dead session is reset for a
   *   bounded re-spawn (the crash-retry path only scans in_progress/pending, so
   *   an idle dead terminal-error row would otherwise sit unrecovered).
   * - Per-execution retry cap (`MAX_TERMINAL_ERROR_CONTINUE_RETRIES`).
   * - Deterministic repeats (identical error signature) escalate immediately,
   *   but only after the prior continue's grace window. A genuinely recovered
   *   session gets a fresh budget only via a re-spawn (new session id), which
   *   `attemptBlockedRunRecovery` provides after a block — the state is NOT
   *   reset on a non-error last message, because `getLastSDKMessage` returns
   *   consumed user rows (e.g. the injected continue) that are not evidence of
   *   real progress and would otherwise defeat the repeat/cap guards.
   * - Grace cooldown between attempts (mirrors the alive-stuck nag grace).
   */
  private async handleTerminalErrorIdleExecutions(
    runId: string,
    spaceId: string,
    canonicalTask: SpaceTask,
    tam: TaskAgentManager,
    space?: Space | null
  ): Promise<'none' | 'continued' | 'blocked'> {
    if (space?.paused || space?.stopped) return 'none';

    // Explicit completion / review signals are authoritative — a final tool
    // call may have parked the task even if the error result row persisted.
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
    if (canonicalTask.status !== 'in_progress') return 'none';

    const graceMs = this.config.agentStuckNagGraceMs ?? DEFAULT_AGENT_STUCK_NAG_GRACE_MS;
    const now = Date.now();

    const allExecutions = this.config.nodeExecutionRepo.listByWorkflowRun(runId);
    const idleExecutions = allExecutions.filter(
      (execution) => execution.status === 'idle' && !!execution.agentSessionId
    );

    // Index executions by session so per-session guards can be checked across
    // EVERY row sharing a session (a reused agent can leave tool-continuation
    // or #670 prompt-too-long state on a sibling idle row, not the newest one).
    const executionsBySession = new Map<string, NodeExecution[]>();
    for (const ex of allExecutions) {
      if (!ex.agentSessionId) continue;
      const list = executionsBySession.get(ex.agentSessionId);
      if (list) list.push(ex);
      else executionsBySession.set(ex.agentSessionId, [ex]);
    }

    // A reused named-agent session can have a newer activation in_progress while
    // older rows remain idle. Skip any session that already has an active
    // (in_progress/pending) owner — that session is processing the new
    // activation and must not be recovered via the stale idle row.
    const activeSessions = new Set<string>();
    for (const ex of allExecutions) {
      if (ex.agentSessionId && (ex.status === 'in_progress' || ex.status === 'pending')) {
        activeSessions.add(ex.agentSessionId);
      }
    }

    // createSubSession treats the NEWEST execution for a session as current
    // (listByWorkflowRun is created_at ASC). Group by session, keep the newest
    // idle row per session (excluding active-owner sessions), so recovery
    // targets the current activation and each shared session is processed at
    // most once per tick (no double-injected continues).
    const newestPerSession = new Map<string, NodeExecution>();
    for (const execution of idleExecutions) {
      const sid = execution.agentSessionId!;
      if (activeSessions.has(sid)) continue;
      const existing = newestPerSession.get(sid);
      if (!existing || (execution.createdAt ?? 0) >= (existing.createdAt ?? 0)) {
        newestPerSession.set(sid, execution);
      }
    }

    for (const execution of newestPerSession.values()) {
      const sessionId = execution.agentSessionId!;
      const lastMessage = this.getSdkMessageRepo().getLastSDKMessage(sessionId);
      const key = `${runId}:${execution.id}`;
      if (!lastMessage || !isSDKResultError(lastMessage)) continue;
      // Guards below are checked across EVERY row sharing this session: a reused
      // agent can leave #670 prompt-too-long state or an active tool continuation
      // on a sibling idle row, not the newest one selected here.
      const sessionExecutions = executionsBySession.get(sessionId) ?? [execution];

      // Defer to #670: if its prompt-too-long state machine owns ANY execution for
      // this session it may be mid-compact even when the latest result is a
      // non-overflow error_during_execution; a terminal-error continue here would
      // race that recovery.
      if (sessionExecutions.some((e) => this.promptTooLongRecovery.has(`${runId}:${e.id}`))) {
        continue;
      }
      // Defer over-long-context results to #670 (compaction), not a plain
      // continue — continuing won't shrink the context.
      if (this.isPromptTooLongResultError(lastMessage)) continue;

      // Only retryable subtypes. Cost guard and structured-output exhaustion are
      // non-retryable; auth errors arrive via session.error/blocked instead.
      if (
        lastMessage.subtype !== 'error_during_execution' &&
        lastMessage.subtype !== 'error_max_turns'
      ) {
        continue;
      }

      // Preserve executions with active tool continuations BEFORE the dead-session
      // reset — the pending tool_result is the next valid transcript item, and
      // resetting/clearing the session here would orphan/409 it. Checked across
      // all rows sharing the session (mirrors handleNonTerminalIdleExecutions).
      if (
        sessionExecutions.some(
          (e) =>
            this.toolContinuationRepo.hasActiveToolUseForExecution(e.id) ||
            this.toolContinuationRepo.listPendingInboxForExecution(e.id).length > 0
        )
      ) {
        continue;
      }

      // A dead session cannot be continued. The liveness/crash-retry sweep
      // earlier in processRunTick only considers in_progress/pending rows, so
      // an idle execution whose session died on a retryable terminal error
      // would otherwise sit unrecovered — reset it for a bounded re-spawn (or
      // block if crash retries are exhausted). This runs AFTER the subtype
      // guards above so non-retryable/cost-guarded subtypes are skipped
      // consistently whether the session is live or dead (no wasteful
      // guaranteed-to-re-fail re-spawns).
      if (!tam.isSessionAlive(sessionId)) {
        const crashExhausted = this.resetWorkflowNodeExecutionForSpawnRetry(
          runId,
          execution,
          `terminal-error session is no longer alive (subtype ${lastMessage.subtype})`,
          sessionId
        );
        if (crashExhausted) {
          // Crash retries exhausted: escalate via the terminal-error path so the
          // blockReason is 'execution_failed' (consistent with the alive-session
          // escalation) and the stale dead session is cleared — letting the row
          // fall to blockRunForAgentCrash would tag it 'agent_crashed' and leave
          // agentSessionId attached for attemptBlockedRunRecovery to reuse.
          await this.escalateTerminalErrorToBlocked(
            runId,
            spaceId,
            canonicalTask,
            execution,
            lastMessage,
            tam,
            `terminal-error session died and crash-retries exhausted (subtype ${lastMessage.subtype}, signature ${this.computeTerminalErrorSignature(lastMessage)})`
          );
          return 'blocked';
        }
        // Clear the stale (dead, terminal-result-tainted) session id from EVERY
        // row that references it so the spawn loop creates a FRESH session.
        // createSubSession reuses the most recent execution that still carries
        // an agentSessionId, so leaving sibling idle rows attached would
        // resurrect this terminal-tainted session on re-spawn.
        this.detachSessionFromAllExecutions(runId, sessionId);
        continue; // reset to pending; the spawn loop re-spawns a fresh session
      }

      const state =
        this.terminalErrorContinueStates.get(key) ??
        ({
          lastSessionId: sessionId,
          continueCount: 0,
          lastRetriedErrorSignature: null,
          lastContinueAt: null,
          failedInjectionCount: 0,
        } satisfies TerminalErrorContinueState);
      this.terminalErrorContinueStates.set(key, state);

      // A re-spawn (e.g. after blocked recovery) produces a new session id.
      // Reset the budget so a genuinely restarted session gets a fresh chance;
      // total attempts stay bounded by MAX_BLOCKED_RUN_RETRIES.
      if (state.lastSessionId !== sessionId) {
        state.lastSessionId = sessionId;
        state.continueCount = 0;
        state.lastRetriedErrorSignature = null;
        state.lastContinueAt = null;
        state.failedInjectionCount = 0;
      }

      const signature = this.computeTerminalErrorSignature(lastMessage);

      // Grace cooldown FIRST. getLastSDKMessage skips user rows the SDK has not
      // yet consumed, so immediately after a continue the last message is still
      // the old terminal result. Evaluating the repeat/cap checks before the
      // cooldown would block the run before the prior continue is even consumed.
      // The grace window gives the injected continue time to take effect; only
      // after it passes do we re-evaluate whether the error recurred.
      if (state.lastContinueAt !== null && now - state.lastContinueAt < graceMs) {
        continue;
      }

      // Bound persistently-failing injections: a live but wedged session whose
      // injection keeps throwing would otherwise retry every grace interval
      // forever. Escalate once consecutive failures reach the cap.
      if (state.failedInjectionCount >= MAX_TERMINAL_ERROR_CONTINUE_RETRIES) {
        await this.escalateTerminalErrorToBlocked(
          runId,
          spaceId,
          canonicalTask,
          execution,
          lastMessage,
          tam,
          `runtime continue injection failed ${state.failedInjectionCount} consecutive time(s) for a live session (${signature})`
        );
        return 'blocked';
      }

      // Deterministic repeat (evaluated only after the grace window): a plain
      // continue already failed to clear this exact error_during_execution, so
      // looping again cannot help — escalate to blocked. error_max_turns is
      // exempt: a same-signature max-turns result just means the agent hit the
      // per-turn cap again (likely after making progress), not a deterministic
      // failure, so it should consume the continueCount cap below rather than
      // being short-circuited to a single continue.
      if (
        state.lastRetriedErrorSignature === signature &&
        lastMessage.subtype === 'error_during_execution'
      ) {
        await this.escalateTerminalErrorToBlocked(
          runId,
          spaceId,
          canonicalTask,
          execution,
          lastMessage,
          tam,
          `Terminal error recurred with an identical signature after a runtime continue (${signature})`
        );
        return 'blocked';
      }

      // Retry cap exhausted — escalate to blocked so attemptBlockedRunRecovery
      // can attempt a single bounded re-spawn.
      if (state.continueCount >= MAX_TERMINAL_ERROR_CONTINUE_RETRIES) {
        await this.escalateTerminalErrorToBlocked(
          runId,
          spaceId,
          canonicalTask,
          execution,
          lastMessage,
          tam,
          `Terminal error persisted after ${state.continueCount} runtime continue(s) (${signature})`
        );
        return 'blocked';
      }

      try {
        await tam.injectRuntimeRecoveryMessage(
          sessionId,
          this.buildTerminalErrorContinueMessage(execution, lastMessage)
        );
        state.continueCount += 1;
        state.lastContinueAt = now;
        state.lastRetriedErrorSignature = signature;
        state.failedInjectionCount = 0;
        // NB: the execution is intentionally left `idle`. The sweep re-evaluates
        // idle rows every tick, so once the SDK writes the resumed turn's new
        // last message the cooldown/repeat/cap logic re-applies naturally.
        // Flipping to `in_progress` here would be a regression:
        // handleSubSessionComplete is a one-shot callback that already fired for
        // the original terminal error, so it would NOT re-fire to return the
        // resumed turn to `idle`, leaving the row stuck in `in_progress`.
        log.warn(
          `Node ${execution.workflowNodeId} ended idle on a terminal error result; ` +
            `sent runtime continue ${state.continueCount}/${MAX_TERMINAL_ERROR_CONTINUE_RETRIES}: ` +
            `execution=${execution.id} agent=${execution.agentName} session=${sessionId} ` +
            `subtype=${lastMessage.subtype} signature=${signature}`
        );
      } catch (error) {
        // Apply the grace cooldown on failure so a transiently-failing
        // injection can't tight-loop every tick. The continue count/signature
        // stay unset so a later success still counts correctly; consecutive
        // failures are bounded by the failedInjectionCount check above.
        state.lastContinueAt = now;
        state.failedInjectionCount += 1;
        log.warn(
          `Failed to send runtime continue for terminal-error idle node ${execution.workflowNodeId} ` +
            `(failure ${state.failedInjectionCount}/${MAX_TERMINAL_ERROR_CONTINUE_RETRIES}); ` +
            `needs attention: execution=${execution.id} agent=${execution.agentName} ` +
            `session=${sessionId} signature=${signature}: ${formatCommandError(error)}`
        );
      }
    }
    return 'none';
  }

  /**
   * Clear an `agentSessionId` from every execution row in the run that currently
   * references it. Used when tearing down a terminal-tainted session so that
   * `createSubSession` (which reuses the most recent execution that still
   * carries an agentSessionId) spawns a FRESH session instead of resurrecting
   * the stale one via a sibling row.
   */
  private detachSessionFromAllExecutions(runId: string, sessionId: string): void {
    for (const ex of this.config.nodeExecutionRepo.listByWorkflowRun(runId)) {
      if (ex.agentSessionId === sessionId) {
        this.config.nodeExecutionRepo.update(ex.id, { agentSessionId: null });
      }
    }
  }

  /**
   * Escalate a terminal-error-idle execution to `blocked`, mirroring the
   * alive-stuck blocked path so `attemptBlockedRunRecovery` picks it up on the
   * next tick with its own `MAX_BLOCKED_RUN_RETRIES` re-spawn cap.
   */
  private async escalateTerminalErrorToBlocked(
    runId: string,
    spaceId: string,
    canonicalTask: SpaceTask,
    execution: NodeExecution,
    errorResult: { subtype: string; errors?: string[] },
    tam: TaskAgentManager,
    detail: string
  ): Promise<void> {
    const errorSnippet = (errorResult.errors ?? []).join('; ').slice(0, 280);
    const reason =
      `Agent session ended on a terminal error result and exhausted runtime auto-continue recovery ` +
      `(node ${execution.workflowNodeId}, agent ${execution.agentName}, subtype ${errorResult.subtype}): ` +
      `${detail}${errorSnippet ? ` — ${errorSnippet}` : ''}`;
    // Tear down the stale live session and clear the row's agentSessionId.
    // attemptBlockedRunRecovery resets blocked executions to `pending` WITHOUT
    // clearing agentSessionId, and the pending-repair loop re-promotes any
    // pending execution whose agentSessionId is still alive back to
    // in_progress — so leaving the live terminal session attached would skip
    // the fresh re-spawn entirely and leave the run stuck on the same session.
    if (execution.agentSessionId) {
      try {
        tam.cancelBySessionId(execution.agentSessionId);
      } catch (err) {
        log.warn(
          `SpaceRuntime: failed to cancel stale terminal-error session ${execution.agentSessionId} during block escalation: ${err instanceof Error ? err.message : String(err)}`
        );
      }
      // Clear the session from EVERY row that references it. A reused named
      // agent can have sibling idle rows pointing at the same agentSessionId;
      // createSubSession reuses the most recent execution that still carries
      // one, so leaving siblings attached would resurrect this terminal-tainted
      // session on the next spawn instead of starting fresh.
      this.detachSessionFromAllExecutions(runId, execution.agentSessionId);
    }
    this.config.nodeExecutionRepo.update(execution.id, {
      status: 'blocked',
      result: reason,
      agentSessionId: null,
      startedAt: null,
      completedAt: null,
    });
    await this.transitionRunStatusAndEmit(runId, 'blocked');
    await this.updateTaskAndEmit(spaceId, canonicalTask.id, {
      status: 'blocked',
      result: reason,
      blockReason: 'execution_failed',
      completedAt: null,
    });
    const dedupKey = `${canonicalTask.id}:blocked`;
    if (!this.notifiedTaskSet.has(dedupKey)) {
      this.notifiedTaskSet.add(dedupKey);
      await this.safeNotify({
        kind: 'task_blocked',
        spaceId,
        taskId: canonicalTask.id,
        reason,
        timestamp: new Date().toISOString(),
      });
    }
    await this.safeNotify({
      kind: 'workflow_run_blocked',
      spaceId,
      runId,
      reason,
      timestamp: new Date().toISOString(),
    });
  }

  /**
   * Normalized signature for a terminal error result, used to detect
   * deterministic repeats (same subtype + terminal_reason + error strings).
   */
  private computeTerminalErrorSignature(message: {
    subtype: string;
    terminal_reason?: string;
    errors?: string[];
  }): string {
    const terminalReason =
      typeof message.terminal_reason === 'string' ? message.terminal_reason : '';
    // Errors can be verbose; trim each so a recurring identical failure matches
    // while an unrelated new error does not.
    const errors = (message.errors ?? []).map((entry) => entry.trim().slice(0, 200));
    return `${message.subtype}|${terminalReason}|${errors.join('\n')}`;
  }

  /**
   * Whether a terminal error result represents an over-long-context failure.
   * Such results must compact (#670) rather than receive a plain continue,
   * which would only re-hit the same context limit.
   */
  private isPromptTooLongResultError(message: {
    terminal_reason?: string;
    errors?: string[];
  }): boolean {
    if (message.terminal_reason === 'prompt_too_long') return true;
    return (message.errors ?? []).some((entry) => /prompt is too long/i.test(entry));
  }

  private buildTerminalErrorContinueMessage(
    execution: NodeExecution,
    errorResult: { subtype: string; errors?: string[] }
  ): string {
    const errorSummary = (errorResult.errors ?? []).join('; ').slice(0, 280);
    return [
      '[Runtime recovery — terminal error]',
      '',
      `Your previous turn ended with a terminal error result (${errorResult.subtype})` +
        `${errorSummary ? `: ${errorSummary}` : ''}.`,
      `The error appears transient. Resume your assigned task for node ${execution.workflowNodeId}` +
        ` (agent ${execution.agentName}) from the current repository and workflow state.`,
      'Inspect task/workflow status, recent messages, and any partial work before continuing.',
      'If the same error recurs, report the blocker clearly through the available workflow tools.',
    ].join('\n');
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
   * Finds a completion summary from terminal node executions in a succeeded run.
   *
   * Strategy:
   * 1. Find terminal node IDs — workflow nodes with no outbound channel.
   * 2. Scan node_executions for those nodes.
   * 3. Return the first non-empty execution result.
   */

  private resolvePrUrlForRun(runId: string): string {
    // Delegated to the domain artifact profile (coding: resolves the PR URL).
    // Generic infra does not know which `link` is the PR, so without a profile
    // there is no primary link to resolve.
    return this.config.artifactProfile?.resolvePrimaryLinkUrl(runId) ?? '';
  }

  private resolvePrimaryResultArtifactSummary(runId: string): string | undefined {
    // Delegated to the domain artifact profile (coding: the kindless terminal
    // `decision` summary). Returns undefined when no profile is wired.
    return this.config.artifactProfile?.summarizeRunOutcome(runId) ?? undefined;
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
        // Re-read the run status before reconciling/removing the executor: a
        // check_failed reactivation may have reopened it to in_progress during
        // the notification await above. If so, keep its executor alive so the
        // reopened run can still tick/spawn, and skip stale terminal reconcile.
        const currentRun = this.config.workflowRunRepo.getRun(runId);
        if (currentRun && currentRun.status !== 'done' && currentRun.status !== 'cancelled') {
          continue;
        }
        if (run) {
          await this.reconcileTerminalRunTasks(run);
        }
        // Re-read again after the reconcile await: a check_failed reactivation
        // can reopen the run during that await too. If it did, keep the executor.
        const postReconcileRun = this.config.workflowRunRepo.getRun(runId);
        if (
          postReconcileRun &&
          postReconcileRun.status !== 'done' &&
          postReconcileRun.status !== 'cancelled'
        ) {
          continue;
        }
        // Prune dedup entries for all tasks in this run so the set doesn't
        // grow unboundedly. Once a run is terminal its tasks will never
        // reappear in nodeTasks, so the normal per-tick pruning loop
        // (processRunTick) would never clear them otherwise.
        for (const task of this.config.taskRepo.listByWorkflowRun(runId)) {
          this.notifiedTaskSet.delete(`${task.id}:blocked`);
          this.notifiedTaskSet.delete(`${task.id}:timeout`);
        }
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
  /**
   * Auto-resume tasks paused on a rate/usage cap (`rate_limited` / `usage_limited`)
   * once their reset window has passed.
   *
   * The pause is set by the RateLimitWatchdog via `session.rate_limit_pause`, and
   * the resume normally fires from the watchdog's in-memory cooldown timer. That
   * timer does not survive a daemon restart, so this sweep — driven off the
   * persisted `restrictions.resetAt` — is the cross-restart backstop: any paused
   * task whose `resetAt` is in the past (or has none) is restored to `in_progress`
   * + restrictions cleared, after which the normal in_progress rehydration
   * (recoverStalledRuns / processRunTick) restarts the worker. Tasks with a
   * future `resetAt` are left paused and picked up on a later tick.
   */
  private async recoverRateLimitedTasks(): Promise<void> {
    const spaces = await this.listActiveSpaces();
    const now = Date.now();
    for (const space of spaces) {
      for (const task of this.config.taskRepo.listRateLimitedBySpace(space.id)) {
        const resetAt = task.restrictions?.resetAt;
        if (resetAt !== undefined && resetAt > now) continue; // still waiting
        try {
          // If the task's worker session is still alive IN MEMORY (e.g. the live
          // watchdog's cooldown timer hasn't fired yet even though resetAt has
          // passed), let the watchdog perform the resume. Touching the task row
          // / execution here would race the watchdog: restoring the task while
          // the session is still in cooldown, or resetting the execution and
          // spawning a second agent for the same slot.
          //
          // Use isSessionInMemory (NOT isSessionAlive): the latter lazy-loads a
          // persisted session via SessionManager.getSession(), whose hydration
          // resets rate_limit_cooldown → idle (classified alive), so a
          // post-restart DEAD cooldown session would be skipped forever.
          const tam = this.config.taskAgentManager;
          const liveSessionForTask =
            !!task.workflowRunId &&
            this.config.nodeExecutionRepo
              .listByWorkflowRun(task.workflowRunId)
              .some(
                (e) =>
                  e.status === 'in_progress' &&
                  !!e.agentSessionId &&
                  (tam?.isSessionInMemory(e.agentSessionId) ?? false)
              );
          if (liveSessionForTask) continue;
          // Reset the task's in_progress node executions to `pending` directly
          // (bypassing crash accounting). After a restart the paused task's
          // worker session is dead; if the liveness path saw it first it would
          // classify the dead session as an agent crash and consume a
          // MAX_TASK_AGENT_CRASH_RETRY. Resetting here means the next tick's
          // spawn path re-drives the worker cleanly instead.
          if (task.workflowRunId) {
            for (const exec of this.config.nodeExecutionRepo.listByWorkflowRun(
              task.workflowRunId
            )) {
              if (exec.status === 'in_progress') {
                this.config.nodeExecutionRepo.update(exec.id, {
                  status: 'pending',
                  result: null,
                  // Clear the dead session binding: processRunTick scans pending
                  // executions WITH an agentSessionId, detects this stale one as
                  // dead, and would otherwise run it through the crash-retry path
                  // (incrementing taskCrashCounts). A blank agentSessionId makes
                  // the pending execution a clean non-crash recovery that the
                  // spawn path re-drives from scratch.
                  agentSessionId: null,
                });
              }
            }
          }
          await this.updateTaskAndEmit(space.id, task.id, {
            status: 'in_progress',
            restrictions: null,
          });
          log.info(
            `SpaceRuntime: auto-resumed ${task.status} task ${task.id} (resetAt ${resetAt ?? 'none'} ≤ now) — rehydration will restart the worker.`
          );
        } catch (err) {
          log.warn(
            `SpaceRuntime: failed to auto-resume paused task ${task.id}: ${err instanceof Error ? err.message : String(err)}`
          );
        }
      }
    }
  }

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
    return this.config.taskRepo.listBySpace(spaceId, false).filter(
      // A task paused on a rate/usage cap still holds its concurrency slot: it
      // will auto-resume when the cap lifts, so counting it prevents the freed
      // slot from being taken by another task and the later resume from
      // exceeding the configured limit.
      (task) =>
        task.status === 'in_progress' ||
        task.status === 'approved' ||
        isRateOrUsageLimited(task.status)
    ).length;
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
    const workflow = this.config.spaceWorkflowManager.getWorkflowForRun(run);
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
