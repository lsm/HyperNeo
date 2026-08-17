/**
 * TaskAgentManager
 *
 * Manages the lifecycle of workflow node-agent sub-sessions for Space tasks.
 * Each SpaceTask can have multiple node-agent sub-sessions (one per workflow node slot).
 *
 * ## Session hierarchy
 *
 * ```
 * Sub-session  (space:${spaceId}:task:${taskId}:exec:${executionId})
 * Sub-session  (...)
 * ```
 *
 * ## In-memory maps
 *
 * - `subSessions`           — taskId → (nodeId → AgentSession)
 * - `agentSessionIndex`     — agentSessionId → AgentSession (reverse index)
 * - `spawningExecutionIds`  — set of execution IDs currently being spawned
 *
 * The maps are fast-lookup caches; session data is the source of truth in the DB.
 * On daemon restart, maps must be rebuilt via rehydration.
 *
 * ## Sub-session lifecycle
 *
 * Sub-sessions are created with `AgentSession.fromInit()`, which persists them to
 * the DB. DB records include `{ internal: true, parentTaskId }` in context metadata
 * so they can be filtered from user-visible session lists.
 *
 * ## Completion detection
 *
 * Uses `SessionObserver`-style `session.updated` subscription on InternalEventBus<DaemonInternalEventMap>.
 * When a sub-session transitions to `idle` status (after processing completes),
 * registered `onComplete` callbacks are fired.
 */

import { generateUUID, isRateOrUsageLimited, resolveNodeAgents } from '@hyperneo/shared';
import type {
  Space,
  SpaceTask,
  SpaceWorkflow,
  SpaceWorkflowRun,
  NodeExecution,
  MessageHub,
  McpServerConfig,
  MessageContent,
  MessageImage,
  MessageInputKind,
  MessageOrigin,
  WorkflowNode,
  WorkflowNodeAgent,
  Session,
} from '@hyperneo/shared';
import type { SkillsManager } from '../../skills-manager';
import type { AppMcpServerRepository } from '../../../storage/repositories/app-mcp-server-repository';
import type { UUID } from 'crypto';
import type { SDKUserMessage } from '@hyperneo/shared/sdk';
import type { AgentSessionInit } from '../../../lib/agent/agent-session';
import { AgentSession } from '../../../lib/agent/agent-session';
import {
  awaitDeliveryConsumption,
  deliverAndMarkQueued,
  deliveryConsumptionTimeoutMs,
  isMessageDeliveryV2Enabled,
} from '../../../lib/agent/message-delivery';
import { validateImageSizes } from '../../session/message-persistence';
import type { Database } from '../../../storage/database';
import type { ReactiveDatabase } from '../../../storage/reactive-database';
import type { DaemonInternalEventMap, InternalEventBus } from '../../internal-event-bus';
import type { SessionManager } from '../../session-manager';
import type { SpaceManager } from '../managers/space-manager';
import type { SpaceAgentManager } from '../managers/space-agent-manager';
import type { SpaceWorkflowManager } from '../managers/space-workflow-manager';
import type { SpaceRuntimeService } from './space-runtime-service';
import type { SpaceTaskRepository } from '../../../storage/repositories/space-task-repository';
import type { SpaceWorkflowRunRepository } from '../../../storage/repositories/space-workflow-run-repository';
import type { WorkflowRunArtifactRepository } from '../../../storage/repositories/workflow-run-artifact-repository';
import type { ChannelCycleRepository } from '../../../storage/repositories/channel-cycle-repository';
import type { PendingAgentMessageRepository } from '../../../storage/repositories/pending-agent-message-repository';
import type { ToolContinuationRecoveryRepository } from '../../../storage/repositories/tool-continuation-recovery-repository';
import type { ActorRef, MessageRecord } from '../../../../../messaging/src/types';
import type { ActorResolver } from '../../../../../messaging/src/contracts';
import { McpAuditLogRepository } from '../../../storage/repositories/mcp-audit-log-repository';
import type { SpaceWorktreeManager } from '../managers/space-worktree-manager';
import { SpaceTaskManager } from '../managers/space-task-manager';
/** Agent identity metadata for sub-session creation. */
export interface SubSessionMemberInfo {
  /** ID of the SpaceWorkerAgent config this sub-session uses */
  agentId?: string;
  /** Agent slot name from WorkflowNodeAgent.name (e.g. 'coder', 'reviewer') */
  agentName?: string;
  /** Workflow node ID — used to link the sub-session to its NodeExecution record */
  nodeId?: string;
}
import { createNodeAgentMcpServer } from '../tools/node-agent-tools';
import {
  createEndNodeHandlers,
  createMarkCompleteHandler,
  createPrMergedGate,
} from '../tools/end-node-handlers';
import { builtInWorkflowRequiresPrMerge } from '../workflows/built-in-workflows';
import { createGithubConnector } from './connectors/github-connector';
import { collectDispatchablePostApprovalRoutes } from './post-approval-router';
import { jsonResult } from '../tools/tool-result';
import {
  assertExecutionValidAgainstWorkflow,
  isTransientSpawnError,
  PermanentSpawnError,
  TransientSpawnError,
  validateTaskAllowsSpawn,
} from './workflow-node-execution-validation';
import type { DbQueryMcpServer } from '../../db-query/tools';
import { sanitizeAssistantUsageInSDKSessionFile } from '../../sdk-session-file-manager';
import { ChannelResolver } from './channel-resolver';
import { ChannelRouter } from './channel-router';
import { AgentMessageRouter } from './agent-message-router';
import type { ReplyRoutingRegistry } from './reply-routing-registry';
import type { WorkflowArtifactProfile } from './artifact-profile';
import type { AgentMemoryRepository } from '../../../storage/repositories/agent-memory-repository';
import type { EvolutionScopeService } from '../evolution-scope-service';
import { createAgentMemoryMcpServer } from '../tools/agent-memory-tools';
import { POST_APPROVAL_TASK_AGENT_TARGET } from '../workflows/post-approval-validator';
import { NodeExecutionRepository } from '../../../storage/repositories/node-execution-repository';
import { validateGlobPattern } from '../../external-events/topic-validator';
import { HookExecutor } from './hook-executor';
import {
  clearAllRetryableHookActionTimers,
  QUEUED_RETRYABLE_ACTION_STATE_KEY,
  WorkflowHookEngine,
} from './workflow-hook-engine';
import { WorkflowHookStateRepository } from '../../../storage/repositories/workflow-hook-state-repository';
import {
  buildCustomAgentTaskMessage,
  resolveAgentInit,
  type SlotOverrides,
} from '../agents/custom-agent';
import { TERMINAL_NODE_EXECUTION_STATUSES } from '../managers/node-execution-manager';
import { Logger } from '../../logger';
import {
  formatAgentMessage,
  extractReplyToSessionId,
  type AgentMessageLevel,
} from '../agent-message-envelope';

const log = new Logger('task-agent-manager');
const AGENT_MESSAGE_ENVELOPE_HEADER = /^─── Message from ([^\n]+) ───\n\n/;

/** Central escalation target referenced by workflow slot prompts for misrouted tasks. */
const WORKFLOW_ESCALATION_TARGET = 'space-agent';
const AGENT_MESSAGE_ENVELOPE_REPLY_BLOCK = '\n\n─── Reply ───\nTo reply, use: ';

function pendingSourceLevel(sourceAgentName: string): AgentMessageLevel {
  if (sourceAgentName === 'task-agent') return 'task-agent';
  if (sourceAgentName === 'space-agent') return 'space-agent';
  if (sourceAgentName === 'space-member') return 'session-agent';
  return 'node-agent';
}

function expectedEnvelopeSenderNames(sourceAgentName: string): string[] {
  return sourceAgentName === 'space-agent' ? ['space-agent', 'Space Agent'] : [sourceAgentName];
}

export function isWorkflowTerminalNode(
  workflow: SpaceWorkflow | null | undefined,
  workflowNodeId: string
): boolean {
  if (!workflow) return false;
  if (workflow.endNodeId === workflowNodeId) return true;

  const node = workflow.nodes.find((candidate) => candidate.id === workflowNodeId);
  if (!node) return false;

  const nodeAgents = resolveNodeAgents(node);
  const fromRefs = new Set([
    node.name,
    node.id,
    ...nodeAgents.flatMap((agent) => [agent.name, agent.agentId, `${node.id}/${agent.name}`]),
  ]);
  const outgoingChannels = (workflow.channels ?? []).filter(
    (channel) => channel.from === '*' || fromRefs.has(channel.from)
  );
  if (outgoingChannels.some((channel) => channel.from === '*')) return false;
  if (outgoingChannels.length === 0) return true;

  const startNode = workflow.nodes.find((candidate) => candidate.id === workflow.startNodeId);
  const startAgents = startNode ? resolveNodeAgents(startNode) : [];
  const startRefs = new Set(
    [
      workflow.startNodeId,
      startNode?.name,
      ...startAgents.flatMap((agent) => [
        agent.name,
        agent.agentId,
        `${workflow.startNodeId}/${agent.name}`,
      ]),
    ].filter(Boolean)
  );

  return outgoingChannels.every((channel) => {
    const targets = Array.isArray(channel.to) ? channel.to : [channel.to];
    return targets.every((target) => startRefs.has(target));
  });
}

function formatWorkflowNodeSessionTitle(task: SpaceTask, agentName?: string): string {
  const agentDisplayName = agentName ? agentName[0].toUpperCase() + agentName.slice(1) : '';
  const agentLabel = agentDisplayName ? ` — ${agentDisplayName}` : '';
  return `Task #${task.taskNumber}: ${task.title}${agentLabel}`;
}

export function hasAgentMessageEnvelopeForTest(
  message: string,
  sourceAgentName: string,
  toLevel: AgentMessageLevel
): boolean {
  const match = message.match(AGENT_MESSAGE_ENVELOPE_HEADER);
  if (!match) return false;

  const fromLevel = pendingSourceLevel(sourceAgentName);
  const expectedSenders = expectedEnvelopeSenderNames(sourceAgentName);
  const headerSender = match[1];
  if (
    !expectedSenders.some(
      (expectedSender) =>
        headerSender === expectedSender || headerSender.startsWith(`${expectedSender} (task #`)
    )
  ) {
    return false;
  }

  // Node-agent → node-agent envelopes intentionally have no reply block. All
  // inter-level envelopes include reply guidance, so require it before trusting
  // a queued message as already wrapped. This prevents legacy raw bodies that
  // happen to start with the envelope prefix from spoofing attribution.
  if (fromLevel === 'node-agent' && toLevel === 'node-agent') return true;
  return message.includes(AGENT_MESSAGE_ENVELOPE_REPLY_BLOCK);
}

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

export interface TaskAgentManagerConfig {
  /** Custom Database wrapper — used to persist sessions */
  db: Database;
  /**
   * SessionManager — used to register externally-created AgentSessions
   * (Task Agent + sub-sessions) in the shared cache and to interrupt
   * in-memory sessions during cleanup. Task #85: never used here to delete
   * persisted session data.
   */
  sessionManager: SessionManager;
  /** Reactive DB invalidation hooks for LiveQuery-backed task activity */
  reactiveDb?: ReactiveDatabase;
  /** Space manager — used to look up spaces */
  spaceManager: SpaceManager;
  /** Space agent manager — used to look up agents for context */
  spaceAgentManager: SpaceAgentManager;
  /** Workflow manager — used to load workflow definitions */
  spaceWorkflowManager: SpaceWorkflowManager;
  /** SpaceRuntimeService — provides access to WorkflowExecutors */
  spaceRuntimeService: SpaceRuntimeService;
  /** Task repository — direct DB reads */
  taskRepo: SpaceTaskRepository;
  /** Workflow run repository — reading and updating runs */
  workflowRunRepo: SpaceWorkflowRunRepository;
  /** Channel cycle repository — for per-channel cycle tracking in cyclic workflows */
  channelCycleRepo: ChannelCycleRepository;
  /** InternalEventBus<DaemonInternalEventMap> — event bus for session state change subscriptions */
  internalEventBus: InternalEventBus<DaemonInternalEventMap>;
  /** MessageHub — used to write SDK messages */
  messageHub: MessageHub;
  /** Factory function to get the API key at call time */
  getApiKey: () => Promise<string | null>;
  /** Default model ID for sessions that don't specify one */
  defaultModel: string;
  /**
   * Space worktree manager for creating and cleaning up task worktrees.
   * When provided, each task gets its own isolated git worktree at run start.
   * All sub-sessions (node agents) share the same worktree path as their workspace.
   */
  worktreeManager?: SpaceWorktreeManager;
  /**
   * Skills manager — injected into agent sessions so enabled skills (plugins and MCP servers)
   * are available. `QueryOptionsBuilder.getMcpServersFromSkills()` uses this to merge enabled
   * `mcp_server`-type skills into the SDK query options at session start.
   *
   * Note: session skill overrides are NOT applicable to task agent sessions — task agents have no
   * per-room override concept. Skills are either enabled globally or not.
   */
  skillsManager: SkillsManager;
  /**
   * App MCP server repository — used by QueryOptionsBuilder to resolve skills-based MCP configs
   * (maps `AppSkill.config.appMcpServerId` → `AppMcpServer` entry for the SDK config).
   */
  appMcpServerRepo: AppMcpServerRepository;
  /** Node execution repository — for CompletionDetector to query workflow-internal execution state */
  nodeExecutionRepo: NodeExecutionRepository;
  /** Absolute path to the SQLite database file. When provided, a space-scoped db-query MCP
   * server is attached to each task agent session. */
  dbPath?: string;
  /** Workflow run artifact repository — for write_artifact / list_artifacts node agent tools */
  artifactRepo?: WorkflowRunArtifactRepository;
  /**
   * Domain artifact profile. Owns coding-specific semantics (primary-link
   * resolution, terminal outcome summary, gate-keyed side-artifact history) so
   * this manager and the node-agent tools it spawns never name domain kinds.
   * Threaded through to the node-agent tool handlers.
   */
  artifactProfile?: WorkflowArtifactProfile;
  /**
   * Persistent queue of Task Agent → peer agent messages waiting for the target
   * session to activate. When provided, `createSubSession` flushes all pending
   * messages for the newly-activated agent (by name) and `send_message` can
   * enqueue instead of failing when the target is declared but not yet active.
   */
  pendingMessageRepo?: PendingAgentMessageRepository;
  /** Durable recovery store for pending Codex tool_result continuations. */
  toolContinuationRepo?: ToolContinuationRecoveryRepository;
  /**
   * Callback to inject a message into the Space Agent chat session for a space.
   * Used for Task Agent → Space Agent escalation via `send_message`.
   */
  spaceAgentInjector?: (
    spaceId: string,
    message: string,
    replyToSessionId?: string | null,
    /** Pending-row id (crash-retry dedup key); forwarded as the delivery UUID. */
    explicitMessageId?: string
  ) => Promise<void>;
  /**
   * Schedule service — shared business logic for managing task schedules.
   * Injected into `space-agent-tools` so task agent sessions can create /
   * pause / resume / delete schedules via the same code path as the RPC
   * handlers. Optional — when absent, schedule management tools are not
   * registered.
   */
  scheduleService?: import('../schedule/schedule-service').ScheduleService;
  /**
   * Reply routing registry for symmetric message routing.
   * Shared between space-agent-tools (register) and task/node-agent-tools (lookup).
   */
  replyRoutingRegistry?: ReplyRoutingRegistry;
  /** Persistent per-space agent memory repository. */
  memoryRepo?: AgentMemoryRepository;
  /** Generic Space actor resolver factory for @handle/@role long-term agent DMs. */
  messageResolverFactory?: (
    spaceId: string,
    context?: { workflowRunId?: string; nodeId?: string; agentName?: string }
  ) => ActorResolver | undefined;
  /** Deliver to or activate long-term Space agents. */
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
  /** Goal service for terminal goal-task side effects. */
  goalService?: import('../goals/goal-service').SpaceGoalService;
  /** Evolution scope service for scoped lesson injection. */
  evolutionScopeService?: EvolutionScopeService;
  /**
   * External event store, plumbed into node-agent tools so sub-sessions can
   * call `get_external_event` for on-demand raw event fetch. Optional — when
   * absent, the tool is not registered on node-agent sessions.
   */
  externalEventStore?: import('../../external-events/external-event-store').ExternalEventStore;
}

// ---------------------------------------------------------------------------
// Internal types
// ---------------------------------------------------------------------------

/** Map of nodeId → all registered completion callbacks for that session */
type CompletionCallbackMap = Map<string, Array<() => Promise<void>>>;

/**
 * A single sub-session's rate/usage-limit entry, tracked in
 * {@link TaskAgentManager.limitedSessionsByTask} so the task's merged
 * restriction can be recomputed from the live set on every pause/resume.
 */
interface RateLimitSessionEntry {
  /** Epoch-ms when this session's limit is expected to reset. */
  resetAt: number;
  /** 'rate_limit' (transient) or 'usage_limit' (daily/weekly cap). */
  kind: 'rate_limit' | 'usage_limit';
  /** Short reason string (the cooldown decision reason). */
  reason: string;
}

/**
 * Defensive resetAt used when a pause event carries no reset timestamp (the
 * watchdog normally always supplies one). Mirrors the fallback the merge path
 * historically used so a paused task still has a bounded resume-at.
 */
const RATE_LIMIT_FALLBACK_RESET_AT_MS = 60 * 60 * 1000;

interface SpawnTaskAgentOptions {
  /**
   * Whether to inject the initial orchestration message immediately after spawn.
   * `false` keeps the session idle until an explicit inbound message arrives.
   */
  kickoff?: boolean;
}

/**
 * Context passed to {@link buildSlotOverrides} to derive runtime-only fields
 * (task model overrides, prompt-provenance identifiers) that are not stored on
 * the slot itself.
 */
export interface BuildSlotOverridesContext {
  task?: Pick<SpaceTask, 'workflowModelOverrides'>;
  node?: { id: string; name: string };
  workflow?: { id: string };
  workflowRun?: { id: string };
}

/**
 * Build the {@link SlotOverrides} for a single workflow agent slot from its
 * persisted {@link WorkflowNodeAgent} definition.
 *
 * Pure: depends only on its inputs (no instance state), so it can be unit-tested
 * directly. Resolves `customPrompt` (with legacy `systemPrompt`/`instructions`
 * backward compat from migration 79) and threads `replaceAgentPrompt` through so
 * the slot can replace — not just append — the agent's base prompt.
 */
export function buildSlotOverrides(
  slot: WorkflowNodeAgent,
  context?: BuildSlotOverridesContext
): SlotOverrides {
  // Resolve customPrompt from the slot. Support legacy JSON blobs that may still
  // have the old `systemPrompt`/`instructions` shape from before migration 79.
  let slotCustomPrompt: string | undefined = slot.customPrompt?.value;
  // In replace mode the slot's explicit customPrompt (or empty) is the sole
  // replacement text. Legacy systemPrompt/instructions are hidden artifacts of the
  // pre-migration append model and are not surfaced in the editor — folding them in
  // would replace the agent prompt with text the user never opted into instead of
  // the bare SDK contract the UI warns about. So the legacy fallback is append-only.
  if (!slotCustomPrompt && slot.replaceAgentPrompt !== true) {
    // Backward compat: combine legacy systemPrompt + instructions into a single string.
    const legacySlot = slot as {
      systemPrompt?: { value: string };
      instructions?: { value: string };
    };
    const legacySp = legacySlot.systemPrompt?.value?.trim() ?? '';
    const legacyInstr = legacySlot.instructions?.value?.trim() ?? '';
    if (legacySp && legacyInstr) {
      slotCustomPrompt = `${legacySp}\n\n${legacyInstr}`;
    } else {
      slotCustomPrompt = legacySp || legacyInstr || undefined;
    }
  }
  const modelOverrideKey = context?.node ? `${context.node.id}:${slot.name}` : null;
  const taskModelOverride = modelOverrideKey
    ? context?.task?.workflowModelOverrides?.[modelOverrideKey]
    : undefined;
  const effectiveGuards = slot.toolGuards;
  return {
    model: taskModelOverride ?? slot.model,
    thinkingLevel: slot.thinkingLevel,
    customPrompt: slotCustomPrompt,
    replaceAgentPrompt: slot.replaceAgentPrompt,
    disabledSkillIds: slot.disabledSkillIds,
    extraMcpServers: slot.extraMcpServers,
    toolGuards: effectiveGuards,
    resolutionContext: {
      agentId: slot.agentId,
      agentName: slot.name,
      workflowRunId: context?.workflowRun?.id,
      workflowId: context?.workflow?.id,
      nodeId: context?.node?.id,
      nodeName: context?.node?.name,
    },
  };
}

/**
 * Resolve the dispatched post-approval route's target agent name (e.g.
 * `merger`) — the single agent the post-approval worker session represents.
 *
 * Mirrors {@link PostApprovalRouter}'s selection: scan node-level routes in
 * declaration order, then the legacy workflow-level route, skipping the
 * unsupported legacy task-agent executor target (the router never dispatches
 * it, so the worker session is never registered under it). Returns the first
 * valid (non-task-agent) target, or `undefined` when none is configured.
 *
 * Shared by the node-agent channel router (`findPostApprovalTargetAgentName`)
 * and the human-reply RPC so both agree on which agent slot a live post-approval
 * session maps to.
 */
export function resolvePostApprovalTargetAgentName(
  workflow: SpaceWorkflow | null | undefined
): string | undefined {
  if (!workflow) return undefined;
  for (const node of workflow.nodes) {
    const targetAgent = node.postApproval?.targetAgent;
    if (targetAgent && targetAgent !== POST_APPROVAL_TASK_AGENT_TARGET) return targetAgent;
  }
  const legacy = workflow.postApproval?.targetAgent;
  return legacy && legacy !== POST_APPROVAL_TASK_AGENT_TARGET ? legacy : undefined;
}

/**
 * The workflow node the post-approval route targets — i.e. the node declaring
 * the route's target agent slot (the merger node). Used to give a legacy
 * (pre-provenance) worker a derivable node id so exact-node matching holds for
 * node-scoped sends. Mirrors the frontend's postApprovalNodeId derivation.
 * Returns `undefined` when no route / target agent is declared on any node.
 */
export function resolvePostApprovalRouteNodeId(
  workflow: SpaceWorkflow | null | undefined
): string | undefined {
  if (!workflow) return undefined;
  const targetAgent = resolvePostApprovalTargetAgentName(workflow);
  if (!targetAgent) return undefined;
  // Match the spawn path exactly (slot.name === targetAgent). Normalizing
  // would collapse separator-distinct legal slots (qa_one / qa-one) and could
  // bind a legacy worker to the wrong node. Slot names are unique per node.
  return workflow.nodes.find((n) => n.agents.some((a) => a.name === targetAgent))?.id;
}

// ---------------------------------------------------------------------------
// TaskAgentManager
// ---------------------------------------------------------------------------

export class TaskAgentManager {
  attachToolContinuationRepo(repo: ToolContinuationRecoveryRepository): void {
    this.config.toolContinuationRepo = repo;
  }

  /**
   * Maps taskId → (nodeId → AgentSession) for sub-sessions.
   * Sub-session IDs follow the convention:
   *   `space:${spaceId}:task:${taskId}:node:${nodeId}`
   */
  private subSessions = new Map<string, Map<string, AgentSession>>();

  /**
   * Reverse index from sub-session agentSessionId → AgentSession.
   * Used by cancelBySessionId() for O(1) lookup when the runtime needs
   * to cancel a specific agent session by its NodeExecution.agentSessionId.
   */
  private agentSessionIndex = new Map<string, AgentSession>();

  /**
   * Session IDs with a `cancelBySessionId` teardown currently in flight.
   * Checked/set synchronously before the async teardown so concurrent duplicate
   * cancels (e.g. one per task in a multi-task cancelWorkflowRun) deterministically
   * no-op instead of racing a second stopSessionPreserveDb.
   */
  private cancellingSessions = new Set<string>();

  /**
   * Per-session promise chain serializing message injection. A
   * `resetContextPerTurn` clear issues an in-stream `/clear` ahead of the
   * handoff; without serialization a concurrent inject to the same session
   * could interleave and land between the `/clear` and the handoff (running in
   * the pre-clear context, or reordering the clear). The chain makes each
   * session's inject (clear + enqueue) atomic.
   */
  private readonly sessionInjectLocks = new Map<string, Promise<void>>();

  /**
   * Per-session mutex for on-demand post-approval worker restores. Distinct
   * from {@link sessionInjectLocks} so restore (which awaits SDK replay /
   * streaming start) never holds the inject lock and self-deadlocks against
   * the queue flush / reply inject it triggers. Only serializes concurrent
   * restores for the same session.
   */
  private readonly sessionRestoreLocks = new Map<string, Promise<void>>();

  /**
   * Tracks node_execution IDs currently spawning a workflow-node session.
   */
  private spawningExecutionIds = new Set<string>();

  /**
   * Completion callbacks registered via onComplete().
   * Key: session ID (of the sub-session).
   * Value: list of callbacks to fire when the session goes idle.
   */
  private completionCallbacks: CompletionCallbackMap = new Map();

  /**
   * InternalEventBus<DaemonInternalEventMap> unsubscribe functions for session.updated listeners.
   * Key: session ID.
   */
  private sessionListeners = new Map<string, () => void>();

  /**
   * Maps taskId → absolute worktree path for active tasks.
   * Populated in spawnTaskAgent() after worktree creation.
   * Used by createSubSessionFactory() to forward the worktree path to sub-sessions.
   * Also populated during rehydrate() from the workflow run config.
   */
  private taskWorktreePaths = new Map<string, string>();

  /**
   * Maps taskId → db-query MCP server instance for active Task Agent sessions.
   * Closed when the task agent session is cleaned up.
   */
  private taskDbQueryServers = new Map<string, DbQueryMcpServer>();
  /** Audit log repository for MCP write operations. */
  private readonly auditLogRepo: McpAuditLogRepository;

  /**
   * Eager sub-session index: taskId → (agentName → sessionId).
   *
   * Populated by `eagerlySpawnWorkflowNodeAgents()` at task-agent spawn time.
   * Consulted by `createSubSession()`'s reuse path so that a later
   * workflow-node activation for the same `agentName` picks up the already-
   * alive eager session instead of creating a second one.
   *
   * This is an in-memory fast path. The authoritative record is the
   * corresponding `node_executions` row (with `agentSessionId` set), which
   * also drives DB-backed rehydration after daemon restarts.
   */
  private eagerSubSessionIds = new Map<string, Map<string, string>>();

  /**
   * Unsubscribe function for the `space.task.updated` listener that triggers
   * full session cleanup when a task reaches `archived` state.
   * Populated on first cleanup subscription attempt; cleared in `cleanupAll()`.
   */
  private taskArchiveListenerUnsub: (() => void) | null = null;
  /**
   * Unsubs for the rate-limit pause/resume listeners (one each). Torn down in
   * `cleanupAll()`.
   */
  private rateLimitListenerUnsubs: Array<() => void> = [];
  /**
   * Unsubs for the agent-activity listeners (SDK toolUse created/consumed) that
   * refresh `NodeExecution.lastActivityAt`. Torn down in `cleanupAll()`.
   */
  private activityListenerUnsubs: Array<() => void> = [];
  /**
   * Sub-sessions currently in a rate/usage-limit cooldown, keyed by parent
   * taskId → (sessionId → the session's own limit entry). A task with multiple
   * parallel node-agent sessions can have several limited at once; the task is
   * only restored to in_progress when the LAST limited session resumes, so an
   * early resume doesn't hide a remaining cooldown.
   *
   * Storing each session's `{ resetAt, kind, reason }` (not just its id) lets
   * the persisted `restrictions` be RECOMPUTED from the remaining entries on a
   * partial resume — so the cross-restart sweep always trusts a `resetAt` /
   * kind that reflects only the sessions still limited, never a stale later
   * deadline or stronger kind from a session that already resumed.
   */
  private limitedSessionsByTask = new Map<string, Map<string, RateLimitSessionEntry>>();

  constructor(private readonly config: TaskAgentManagerConfig) {
    this.auditLogRepo = new McpAuditLogRepository(this.config.db.getDatabase());
    this.subscribeToTaskArchiveEvents();
    this.subscribeToRateLimitEvents();
    this.subscribeToActivityTracking();
  }

  *getTrackedAgentRootPids(): Iterable<number> {
    for (const [, nodeSessions] of this.subSessions) {
      for (const [, session] of nodeSessions) {
        yield* session.getTrackedAgentRootPids();
      }
    }
  }

  getTrackedAgentRootPidsSplit(): { live: number[]; exited: number[] } {
    const live: number[] = [];
    const exited: number[] = [];
    for (const [, nodeSessions] of this.subSessions) {
      for (const [, session] of nodeSessions) {
        const split = session.getTrackedAgentRootPidsSplit();
        live.push(...split.live);
        exited.push(...split.exited);
      }
    }
    return { live, exited };
  }

  /**
   * Subscribe to `space.task.updated` and run the archive pipeline for tasks
   * that reach the `archived` state.
   *
   * `archived` is the only truly non-recoverable terminal state for a task —
   * per issue #1515, node agent sessions must remain reachable (e.g. for
   * cross-node `send_message` from a reviewer to a completed coder) for the
   * full lifetime of the parent task run, and are only torn down when the
   * task is archived.
   *
   * Task #85: archive is a UI-initiated action. It removes the task's
   * worktree + each attached session's SDK `.jsonl` files, but preserves
   * the `sessions` DB row + `sdk_messages` so the conversation history
   * remains viewable.
   */
  private subscribeToTaskArchiveEvents(): void {
    if (this.taskArchiveListenerUnsub) return;
    this.taskArchiveListenerUnsub = this.config.internalEventBus.subscribe(
      'space.task.updated',
      (event) => {
        if (event.task?.status !== 'archived') return;
        // Task #85: skip the cleanup cascade for automated duplicate-run
        // reconciliation archives. Only user-initiated archives (missing or
        // explicit `'user'` marker) may remove the task worktree and archive
        // the SDK `.jsonl` files.
        if (event.archiveSource === 'system_reconcile') return;
        const taskId = event.taskId;
        // Fire-and-forget — archiveOnTaskArchived is idempotent and safe to
        // skip on failure (cleanupAll still sweeps leftovers on daemon shutdown).
        void this.archiveOnTaskArchived(taskId).catch((err) => {
          log.warn(
            `TaskAgentManager: failed to archive resources for archived task ${taskId}:`,
            err
          );
        });
      },
      { subscriberName: 'TaskAgentManager.taskArchive' }
    );
  }

  /**
   * Surface a paused task status when a worker session hits a rate/usage cap
   * with no fallback left, and restore it on resume.
   *
   * With fallback-chain recovery (Parts A+B) the 429 error broadcast is skipped,
   * so a paused session never emits `session.error` and the task never fails.
   * These listeners add the visible status: on pause, mark the parent task
   * `rate_limited` / `usage_limited` with a `restrictions` resume-at blob; on
   * resume, restore `in_progress` and clear the blob. Global subscriptions — the
   * sessionId on the payload resolves to the parent task via
   * `findParentTaskIdForSubSession`.
   */
  private subscribeToRateLimitEvents(): void {
    if (this.rateLimitListenerUnsubs.length > 0) return;

    this.rateLimitListenerUnsubs.push(
      this.config.internalEventBus.subscribe(
        'session.rate_limit_pause',
        (event) => {
          const taskId = this.findParentTaskIdForSubSession(event.sessionId);
          if (!taskId) return;
          // Record this session's own limit entry, then recompute the task's
          // merged restriction from EVERY currently-limited session. The task
          // is only restored to in_progress when the map empties on resume.
          let entries = this.limitedSessionsByTask.get(taskId);
          if (!entries) {
            entries = new Map();
            this.limitedSessionsByTask.set(taskId, entries);
          }
          entries.set(event.sessionId, {
            resetAt: event.resetAt ?? Date.now() + RATE_LIMIT_FALLBACK_RESET_AT_MS,
            kind: event.kind,
            reason: event.reason,
          });
          try {
            this.recomputeTaskRestriction(taskId);
          } catch (err) {
            log.warn(
              `TaskAgentManager: failed to mark task ${taskId} limited for session ${event.sessionId}:`,
              err
            );
          }
        },
        { subscriberName: 'TaskAgentManager.rateLimitPause' }
      )
    );

    this.rateLimitListenerUnsubs.push(
      this.config.internalEventBus.subscribe(
        'session.rate_limit_resume',
        (event) => {
          const taskId = this.findParentTaskIdForSubSession(event.sessionId);
          if (!taskId) return;
          // Drop this session from the limited map; only restore the task when
          // no limited session for it remains, otherwise recompute the merged
          // restriction from the sessions still limited.
          const entries = this.limitedSessionsByTask.get(taskId);
          if (entries) {
            entries.delete(event.sessionId);
            if (entries.size === 0) {
              this.limitedSessionsByTask.delete(taskId);
              void this.restoreTaskFromRateLimit(taskId).catch((err) => {
                log.warn(
                  `TaskAgentManager: failed to restore task ${taskId} from rate limit for session ${event.sessionId}:`,
                  err
                );
              });
              return;
            }
            // Other sessions still limited — shrink the restriction to reflect
            // only them so a subsequent daemon restart trusts the recomputed
            // resetAt / kind instead of a stale later deadline.
            try {
              this.recomputeTaskRestriction(taskId);
            } catch (err) {
              log.warn(
                `TaskAgentManager: failed to recompute task ${taskId} restriction after session ${event.sessionId} resumed:`,
                err
              );
            }
            return;
          }
          // No in-memory entry (task was paused out-of-band, e.g. directly via
          // the DB). Still attempt the restore — it self-guards on status.
          void this.restoreTaskFromRateLimit(taskId).catch((err) => {
            log.warn(
              `TaskAgentManager: failed to restore task ${taskId} from rate limit for session ${event.sessionId}:`,
              err
            );
          });
        },
        { subscriberName: 'TaskAgentManager.rateLimitResume' }
      )
    );
  }

  /**
   * Subscribe to SDK tool-call/tool-result events to refresh
   * `NodeExecution.lastActivityAt`.
   *
   * Tool activity is the strongest, most frequent "the agent is plainly working"
   * signal and — crucially — it is never produced by the runtime's own recovery
   * machinery (runtime nags are user messages with no tool_use), so subscribing
   * here cannot create a feedback loop that defeats stall detection. An agent
   * that responds to a nag with tool calls IS genuinely working, so advancing
   * the activity timestamp in that case is correct.
   *
   * This source also captures a node's OWN commit pushes: a push is a tool call
   * (`git`/`gh` via Bash) on that node's session, so it refreshes `lastActivityAt`
   * for exactly the pushing node. A PR-level `pull_request.synchronize` event is
   * deliberately NOT used — it fans out to every subscribed target and would mark
   * idle co-subscribers active (see `deliverExternalEventToWorkflowTarget`).
   *
   * Each event is resolved to its node execution via the session→execution index
   * and the dedicated `touchLastActivity` path is used so `updatedAt` (state-write
   * semantic) is left untouched. Activity tracking must never throw into the
   * caller; failures are logged at debug and swallowed.
   */
  private subscribeToActivityTracking(): void {
    if (this.activityListenerUnsubs.length > 0) return;

    this.activityListenerUnsubs.push(
      this.config.internalEventBus.subscribe(
        'sdk.toolUse.created',
        (event) => {
          this.recordActivityForSession(event.sessionId, event.timestamp);
        },
        { subscriberName: 'TaskAgentManager.activityToolUseCreated' }
      )
    );

    this.activityListenerUnsubs.push(
      this.config.internalEventBus.subscribe(
        'sdk.toolUse.consumed',
        (event) => {
          this.recordActivityForSession(event.sessionId, event.timestamp);
        },
        { subscriberName: 'TaskAgentManager.activityToolUseConsumed' }
      )
    );
  }

  /**
   * Advance `lastActivityAt` for whatever node execution owns `sessionId`.
   *
   * Shared by the SDK tool-event subscribers and the peer-message-delivery
   * wrapper. Silent no-op when the session has no execution row (e.g. the
   * post-approval merger session, or a session that was already torn down).
   * Never throws — activity tracking is best-effort and must not break the
   * surrounding delivery/event path.
   */
  private recordActivityForSession(sessionId: string, at: number = Date.now()): void {
    try {
      const execution = this.config.nodeExecutionRepo.getByAgentSessionId(sessionId);
      if (execution) {
        this.config.nodeExecutionRepo.touchLastActivity(execution.id, at);
      }
    } catch (err) {
      log.debug(`TaskAgentManager: failed to record activity for session ${sessionId}:`, err);
    }
  }

  /**
   * Recompute the task's rate/usage-limit restriction from ALL sessions
   * currently tracked as limited in {@link limitedSessionsByTask}.
   *
   * Merge rules (matching the prior merge semantics, now applied symmetrically
   * on pause AND resume):
   *   - status: `usage_limited` if ANY limited session hit a usage cap, else
   *     `rate_limited`. (usage_limit is the stronger kind.)
   *   - resetAt: the LATEST resetAt across all limited sessions, so the
   *     cross-restart sweep waits for the slowest one.
   *
   * Recomputing on every change — not only on pause — keeps the persisted
   * `restrictions` in lockstep with the in-memory set. So when the
   * latest-deadline session resumes first, the persisted resetAt shrinks to the
   * next-latest, and `recoverRateLimitedTasks` no longer trusts a stale later
   * deadline (which would delay recovery) or a stronger kind from a session
   * that's no longer limited.
   *
   * Respects the terminal/decision-status guard: only `in_progress` or
   * already-limited tasks are mutated. A rate-limited sub-session can belong to
   * a task in `review`/`approved` (e.g. a post-approval executor); overwriting
   * those would lose the approval/review lifecycle. The session-level cooldown
   * still holds regardless — this guard only protects the task row.
   */
  private recomputeTaskRestriction(taskId: string): void {
    const entries = this.limitedSessionsByTask.get(taskId);
    if (!entries || entries.size === 0) {
      // Defensive: the resume path deletes the map and restores directly, but
      // keep this idempotent if ever called on an empty set.
      return;
    }
    let resetAt = -Infinity;
    let reason = '';
    let hasUsageLimit = false;
    for (const entry of entries.values()) {
      if (entry.kind === 'usage_limit') hasUsageLimit = true;
      // Track the latest resetAt and carry its reason (deterministic on ties:
      // Map iteration is insertion order, so the earliest-pausing max wins).
      if (entry.resetAt > resetAt) {
        resetAt = entry.resetAt;
        reason = entry.reason;
      }
    }
    const status: 'rate_limited' | 'usage_limited' = hasUsageLimit
      ? 'usage_limited'
      : 'rate_limited';
    const restrictions = {
      type: status === 'usage_limited' ? ('usage_limit' as const) : ('rate_limit' as const),
      limit: reason,
      resetAt,
      sessionRole: 'worker' as const,
    };

    const task = this.config.taskRepo.getTask(taskId);
    if (!task) return;

    // Never touch a terminal/decision status. A rate-limited sub-session can
    // belong to a task in `review`/`approved` (e.g. a post-approval executor);
    // overwriting those would lose the approval/review lifecycle and the
    // post-approval route. The session-level cooldown still holds regardless —
    // this guard only protects the task row.
    const isLimited = isRateOrUsageLimited(task.status);
    if (task.status !== 'in_progress' && !isLimited) return;
    // Skip the write (and event) if nothing actually changed — including the
    // reason string, so a re-pause that only flips the reason still persists.
    if (
      isLimited &&
      task.status === status &&
      task.restrictions?.resetAt === resetAt &&
      task.restrictions?.type === restrictions.type &&
      task.restrictions?.limit === reason
    ) {
      return;
    }
    this.config.taskRepo.updateTask(taskId, { status, restrictions });
    this.emitTaskUpdatedEvent(taskId);
  }

  /** Restore a rate/usage-limited task to in_progress (resume). */
  private async restoreTaskFromRateLimit(taskId: string): Promise<void> {
    const task = this.config.taskRepo.getTask(taskId);
    if (!task) return;
    if (!isRateOrUsageLimited(task.status)) return;
    this.config.taskRepo.updateTask(taskId, { status: 'in_progress', restrictions: null });
    this.emitTaskUpdatedEvent(taskId);
  }

  /**
   * Publish `space.task.updated` for a pause/resume so connected web clients
   * (which sync task lists via this event, not a LiveQuery) see the new status
   * + restriction without a manual refresh.
   */
  private emitTaskUpdatedEvent(taskId: string): void {
    const task = this.config.taskRepo.getTask(taskId);
    if (!task) return;
    this.config.internalEventBus
      .publish('space.task.updated', {
        sessionId: 'global',
        spaceId: task.spaceId,
        taskId: task.id,
        task,
      })
      .catch((err: unknown) => {
        log.warn(
          `Failed to emit space.task.updated for rate-limit pause/resume of task ${task.id}: ${err instanceof Error ? err.message : String(err)}`
        );
      });
  }

  /**
   * Archive pipeline for a task that has transitioned to `archived`.
   *
   * Task #85 invariant:
   *   - DB row + `sdk_messages` for each attached session: PRESERVED.
   *   - Worktree + SDK `.jsonl` files for each attached session: REMOVED
   *     (archive is user-initiated; disk space is freed but the DB row
   *     keeps a pointer to the archived jsonl via `sdkArchivePath`).
   *
   * Steps:
   *   1. Collect IDs of the attached task-agent + sub-session sessions.
   *   2. `cleanup(taskId)` — stop in-memory sessions and clear maps.
   *   3. For each collected session, call
   *      `SessionManager.archiveSessionResources(id, 'ui_task_archive')`,
   *      which stamps the session row as `archived` and archives its
   *      SDK `.jsonl` files to a `.archive/` sidecar.
   *   4. Remove the space-level task worktree so disk space is freed.
   */
  private async archiveOnTaskArchived(taskId: string): Promise<void> {
    // 1. Snapshot session IDs BEFORE cleanup clears the maps.
    const task = this.config.taskRepo.getTask(taskId);
    const sessionIds = new Set<string>();
    const nodeMap = this.subSessions.get(taskId);
    if (nodeMap) {
      for (const [sid] of nodeMap) sessionIds.add(sid);
    }

    // Also include legacy taskAgentSessionId for tasks created before the
    // task-agent LLM removal. After restart, subSessions won't contain this
    // session but the DB column still references it.
    if (task?.taskAgentSessionId) {
      sessionIds.add(task.taskAgentSessionId);
    }

    // 2. In-memory teardown (DB + worktree + jsonl preserved by cleanup).
    try {
      await this.cleanup(taskId, 'done');
    } catch (err) {
      log.warn(`TaskAgentManager.archiveOnTaskArchived: cleanup failed for task ${taskId}:`, err);
    }

    // 3. Archive SDK .jsonl files + mark each attached session as archived.
    for (const sessionId of sessionIds) {
      try {
        await this.config.sessionManager.archiveSessionResources(sessionId, 'ui_task_archive');
      } catch (err) {
        log.warn(
          `TaskAgentManager.archiveOnTaskArchived: failed to archive session ${sessionId} for task ${taskId}:`,
          err
        );
      }
    }

    // 4. Remove the space-level task worktree (disk cleanup). The DB task
    // row remains so the UI can still display the archived task.
    if (this.config.worktreeManager && task?.spaceId) {
      try {
        await this.config.worktreeManager.removeTaskWorktree(task.spaceId, taskId);
        log.info(`TaskAgentManager: removed worktree for archived task ${taskId}`);
      } catch (err) {
        log.warn(
          `TaskAgentManager: failed to remove worktree for archived task ${taskId}: ${err instanceof Error ? err.message : String(err)}`
        );
      }
    }
  }

  /**
   * Spawn a workflow node-agent session for a specific node_execution row.
   *
   * Unlike spawnTaskAgent(), this creates a workflow worker session directly
   * (no Task Agent orchestration layer).
   */
  async spawnWorkflowNodeAgentForExecution(
    task: SpaceTask,
    space: Space,
    workflow: SpaceWorkflow,
    workflowRun: SpaceWorkflowRun,
    execution: NodeExecution,
    options: SpawnTaskAgentOptions = {}
  ): Promise<string> {
    if (execution.agentSessionId && this.agentSessionIndex.has(execution.agentSessionId)) {
      if (this.isSessionAlive(execution.agentSessionId)) {
        const startedAt = execution.startedAt ?? Date.now();
        this.config.nodeExecutionRepo.update(execution.id, {
          status: 'in_progress',
          agentSessionId: execution.agentSessionId,
          startedAt,
          completedAt: null,
        });
        return execution.agentSessionId;
      }
      // Indexed session is dead — evict so the create/reuse path below
      // runs instead of short-circuiting on a stale entry.
      this.agentSessionIndex.delete(execution.agentSessionId);
    }

    if (this.spawningExecutionIds.has(execution.id)) {
      const CONCURRENT_SPAWN_TIMEOUT_MS = 30_000;
      const deadline = Date.now() + CONCURRENT_SPAWN_TIMEOUT_MS;
      return new Promise((resolve, reject) => {
        const interval = setInterval(() => {
          const fresh = this.config.nodeExecutionRepo.getById(execution.id);
          if (fresh?.agentSessionId) {
            clearInterval(interval);
            resolve(fresh.agentSessionId);
            return;
          }
          if (!this.spawningExecutionIds.has(execution.id)) {
            clearInterval(interval);
            reject(
              new Error(
                `Concurrent spawn for execution ${execution.id} failed before session was created`
              )
            );
            return;
          }
          if (Date.now() >= deadline) {
            clearInterval(interval);
            reject(
              new Error(
                `Concurrent spawn for execution ${execution.id} timed out after ${CONCURRENT_SPAWN_TIMEOUT_MS}ms`
              )
            );
          }
        }, 50);
      });
    }

    this.spawningExecutionIds.add(execution.id);
    let spawnedSessionId: string | null = null;

    try {
      // Re-fetch the task at the spawn-commit point: a parallel node may have
      // hit a rate/usage limit after the caller loaded `task`, flipping the DB
      // row to rate_limited while this snapshot still says in_progress. The
      // stale snapshot would pass validation and spawn a worker during the
      // cooldown, bypassing the paused-task protection.
      const freshTask = this.config.taskRepo.getTask(task.id) ?? task;
      validateTaskAllowsSpawn(freshTask);
      assertExecutionValidAgainstWorkflow(execution, workflow);

      const node = workflow.nodes.find((candidate) => candidate.id === execution.workflowNodeId)!;
      const nodeAgents = resolveNodeAgents(node);
      const slot =
        nodeAgents.length === 1
          ? nodeAgents[0]
          : nodeAgents.find((agentSlot) => agentSlot.name === execution.agentName);
      if (!slot?.agentId) {
        throw new Error(
          `No agent slot found for agent name "${execution.agentName}" in node "${execution.workflowNodeId}"`
        );
      }

      const taskId = task.id;
      const baseSessionId = `space:${space.id}:task:${taskId}:exec:${execution.id}`;
      const sessionId = this.resolveSessionId(baseSessionId);

      let workspacePath = this.taskWorktreePaths.get(taskId) ?? space.workspacePath;
      if (!this.taskWorktreePaths.has(taskId) && this.config.worktreeManager) {
        try {
          const result = await this.config.worktreeManager.createTaskWorktree(
            space.id,
            taskId,
            task.title,
            task.taskNumber
          );
          workspacePath = result.path;
          this.taskWorktreePaths.set(taskId, result.path);
        } catch (err) {
          log.warn(
            `TaskAgentManager: failed to create worktree for workflow task ${taskId}, falling back to space workspace: ${err instanceof Error ? err.message : String(err)}`
          );
        }
      }

      const slotOverrides = buildSlotOverrides(slot, {
        task,
        node,
        workflow,
        workflowRun,
      });

      let init = resolveAgentInit({
        task,
        space,
        agentManager: this.config.spaceAgentManager,
        sessionId,
        workspacePath,
        workflowRun,
        workflow,
        slotOverrides,
        agentId: slot.agentId,
      });

      const shouldKickoff = options.kickoff ?? true;
      const customAgent = shouldKickoff
        ? this.config.spaceAgentManager.getById(slot.agentId)
        : null;
      if (shouldKickoff && !customAgent) {
        throw new PermanentSpawnError(`Agent not found: ${slot.agentId}`);
      }

      const nodeAgentMcpServer = this.buildNodeAgentMcpServerForSession(
        taskId,
        sessionId,
        execution.agentName,
        space.id,
        workflowRun.id,
        workspacePath,
        execution.workflowNodeId
      );

      init = {
        ...init,
        title: formatWorkflowNodeSessionTitle(task, execution.agentName),
        mcpServers: {
          ...init.mcpServers,
          'node-agent': nodeAgentMcpServer as unknown as McpServerConfig,
          ...this.buildAgentMemoryMcpServers(space.id, sessionId),
        },
      };

      const actualSessionId = await this.createSubSession(taskId, sessionId, init, {
        agentId: slot.agentId,
        // agentName + nodeId enable two critical behaviours inside createSubSession:
        //   1. Session reuse — if this agent already ran (agentSessionId set on an
        //      older NodeExecution), the existing session is reused rather than spawning
        //      a redundant second session. Each named agent lives in one session per
        //      task lifetime; subsequent activations inject a new message into it.
        //   2. Pending message flush — after the session is created/reused, any
        //      messages queued via PendingAgentMessageRepository (e.g. from a Task
        //      Agent send_message call that raced ahead of this spawn) are drained
        //      into the session. Without agentName this flush is skipped entirely.
        agentName: execution.agentName,
        nodeId: execution.workflowNodeId,
      });
      spawnedSessionId = actualSessionId;

      const spawned = this.getSubSession(actualSessionId);
      if (!spawned) {
        throw new Error(`Spawned node session ${actualSessionId} is not registered in memory`);
      }

      // Stop synchronization — `space.stop` can land while this spawn is in
      // flight (the runtime's spawn gate checked the space row before the
      // awaits above began). Re-read the space row AFTER the session is
      // registered but BEFORE stamping the execution and injecting the
      // kickoff. If the space stopped meanwhile, abort: the catch below
      // interrupts the just-created session (cancelBySessionId preserves the
      // DB row) and resets the execution to the clean-recovery shape so
      // space.start re-drives it. This closes the live window the
      // daemon-restart rehydrate guard cannot: any session registered before
      // this check is visible to stopActiveWork's cleanup pass (which runs
      // after stopSpace committed), and any registration after it sees
      // stopped=true and self-aborts here.
      await this.assertSpaceNotStoppedForSpawn(space.id, `post-registration, exec ${execution.id}`);

      const startedAt = Date.now();
      const updatedExecution = this.config.nodeExecutionRepo.update(execution.id, {
        status: 'in_progress',
        agentSessionId: actualSessionId,
        startedAt,
        completedAt: null,
      });
      if (
        !updatedExecution ||
        updatedExecution.status !== 'in_progress' ||
        updatedExecution.agentSessionId !== actualSessionId ||
        !updatedExecution.startedAt
      ) {
        log.error('[Spawn] Execution state mismatch after spawn', {
          executionId: execution.id,
          expectedStatus: 'in_progress',
          actualStatus: updatedExecution?.status ?? null,
          expectedSessionId: actualSessionId,
          actualSessionId: updatedExecution?.agentSessionId ?? null,
        });
        this.config.nodeExecutionRepo.update(execution.id, {
          status: 'blocked',
          result: 'Execution state corruption after spawn',
          completedAt: Date.now(),
        });
        throw new Error(`Execution state corruption after spawn for ${execution.id}`);
      }

      // Defensive guarantee: verify the node-agent MCP server is present in the
      // sub-session's effective config. If a registry collision, race, or refactor
      // regression ever drops it, self-heal by re-attaching before the first turn
      // kicks off — and emit a loud warning so the regression surfaces in logs.
      //
      // This is a belt-and-braces check to prevent silent recurrence of the
      // "No such tool available" failure mode where the Coder→Reviewer handoff
      // died because mcp__node-agent__send_message was unregistered.
      await this.ensureNodeAgentAttached(spawned, {
        taskId,
        subSessionId: actualSessionId,
        agentName: execution.agentName,
        spaceId: space.id,
        workflowRunId: workflowRun.id,
        workspacePath,
        workflowNodeId: execution.workflowNodeId,
        phase: 'spawn',
      });

      this.registerCompletionCallback(actualSessionId, async () => {
        await this.handleSubSessionComplete(taskId, execution.workflowNodeId, actualSessionId);
      });

      if (shouldKickoff) {
        const goal = task.goalId ? this.config.goalService?.getGoal(task.goalId) : null;
        const linkedGoal = goal?.spaceId === task.spaceId ? goal : null;

        const memoryQuery = `${task.title}\n${task.description}`;
        const coreMemories = this.config.memoryRepo
          ? this.config.memoryRepo.listCoreMemories(space.id, 10)
          : [];
        const relevantMemories = this.config.memoryRepo
          ? await this.config.memoryRepo.search(space.id, memoryQuery, 5)
          : [];
        const relevantScopeLessons = this.config.evolutionScopeService
          ? this.config.evolutionScopeService.selectActiveLessonsForTask({
              taskId: task.id,
              limit: 3,
            })
          : [];
        const initialMessage = buildCustomAgentTaskMessage({
          customAgent: customAgent!,
          task,
          workflowRun,
          workflow,
          space,
          sessionId: actualSessionId,
          workspacePath,
          goal: linkedGoal,
          relevantScopeLessons,
          slotOverrides,
          nodeId: execution.workflowNodeId,
          agentSlotName: execution.agentName,
          coreMemories,
          relevantMemories,
        });
        const runtimeContract = this.buildNodeExecutionRuntimeContract(workflow, execution, space);
        const kickoffMessage = runtimeContract
          ? `${initialMessage}\n\n${runtimeContract}`
          : initialMessage;
        // Second stop synchronization point: the awaits above (MCP attach,
        // memory search) opened a window after the post-registration
        // re-check — a stop landing there must not have its kickoff injected
        // into the stopped space. Same abort semantics: the catch below
        // tears the session down and resets the row.
        await this.assertSpaceNotStoppedForSpawn(space.id, `pre-kickoff, exec ${execution.id}`);
        await this.injectMessageIntoSession(spawned, kickoffMessage);
      }
      return actualSessionId;
    } catch (err) {
      // Roll back partially-created sessions so executions do not get stuck as pending with a stale session.
      if (spawnedSessionId) {
        this.cancelBySessionId(spawnedSessionId);
      }
      // A transient deferral (space stopped mid-spawn, task paused on a
      // rate/usage cap) must leave the execution in the clean-recovery
      // shape: createSubSession may have already stamped it
      // `{in_progress, agentSessionId}` for the now-cancelled session, and a
      // row left bound to a dead session is either mis-accounted as a crash
      // on resume or nags for tens of minutes via the alive-stuck path.
      if (isTransientSpawnError(err)) {
        this.config.nodeExecutionRepo.resetForCleanRecovery(execution.id);
      }
      throw err;
    } finally {
      this.spawningExecutionIds.delete(execution.id);
    }
  }

  /**
   * Stop synchronization for in-flight spawns: re-read the space row and
   * throw `TransientSpawnError` when the space has stopped, so the spawn
   * aborts (session torn down + execution reset to the clean-recovery shape
   * by the caller's catch) and the runtime defers it — no crash accounting,
   * `space.start` re-drives.
   *
   * Deliberately stopped-only (not paused): a pause keeps in-flight work
   * alive by design, so a pause landing between the dispatch hold and this
   * check lets the kickoff proceed — the asymmetry with the hold (which
   * covers paused) is intentional.
   *
   * Failure mode on a `getSpace` throw differs by caller: node spawns fail
   * OPEN (default) — a failed read must not block a legitimate spawn because
   * the tick loop's spawn gate re-checks the space row on every tick.
   * Post-approval kickoffs pass `{ failClosed: true }` — the merge kickoff is
   * one-shot external work with no per-tick gate behind it, so a transient
   * read error must abort into the already-built durable deferral
   * (TransientSpawnError → PostApprovalDeferredError → resume re-drive)
   * rather than inject merge instructions into a possibly-stopped space.
   */
  private async assertSpaceNotStoppedForSpawn(
    spaceId: string,
    phase: string,
    opts: { failClosed?: boolean } = {}
  ): Promise<void> {
    let freshSpace: Space | null | undefined;
    try {
      freshSpace = await this.config.spaceManager.getSpace(spaceId);
    } catch (err) {
      if (opts.failClosed) {
        throw new TransientSpawnError(
          `Space ${spaceId} state unreadable during spawn (${phase}); failing closed — ` +
            `deferring the one-shot kickoff: ${err instanceof Error ? err.message : String(err)}`
        );
      }
      log.warn(
        `TaskAgentManager: failed to re-check stopped state for space ${spaceId} ` +
          `during spawn (${phase}): ${err instanceof Error ? err.message : String(err)}`
      );
      return;
    }
    if (freshSpace?.stopped) {
      throw new TransientSpawnError(
        `Space ${spaceId} stopped during spawn (${phase}); ` +
          `deferring — the execution stays pending and space.start re-drives it`
      );
    }
  }

  /**
	 * Eagerly pre-spawn one sub-session per distinct agent slot referenced by
	 * the workflow graph, _before_ the task-agent kickoff message is injected.
	 *
	 * Why:
	 * - The task-agent session already exists with its SDK init captured
	 *   (see `awaitSdkSessionCaptured` in `spawnTaskAgent`).
	 * - Without eager spawn, node-agent sub-sessions are only created when
	 *   the workflow activates a node. Any daemon restart between the
	 *   task-agent kickoff and that activation leaves the node-agent SDK
	 *   transcripts non-existent, so the workflow effectively starts from
	 *   scratch on rehydrate.
	 * - By spawning all referenced agents now and awaiting their SDK init
	 *   capture, every sub-session's `sdkSessionId` is persisted up front.
	 *   A restart at any later point can safely resume every session with
	 *   full history.
	 *

	/**
	 * Sanitize an agent slot name so it is safe to use as a component of a
	 * session ID: lowercase, alphanumerics + single hyphens, max 40 chars.
	 */
  private sanitizeAgentNameForId(name: string): string {
    return (
      name
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-+|-+$/g, '')
        .slice(0, 40) || 'agent'
    );
  }

  /**
   * Create a sub-session for a workflow node.
   *
   * Called internally from the SubSessionFactory.create() closure. Creates the
   * session via AgentSession.fromInit() to ensure DB persistence. Registers the
   * session in the subSessions map for fast lookup by taskId + nodeId.
   *
   * @param taskId    The parent task ID
   * @param sessionId The session ID to use (generated by the tool handler)
   * @param init      Session init config from resolveAgentInit()
   * @returns The session ID of the created sub-session.
   */
  async createSubSession(
    taskId: string,
    sessionId: string,
    init: AgentSessionInit,
    memberInfo?: SubSessionMemberInfo
  ): Promise<string> {
    // --- Session reuse: if this agent already has a live session, reuse it.
    // Each named agent gets exactly one AgentSession per task lifetime; subsequent
    // node executions inject a new message into the existing session rather than
    // spawning a fresh one. Sessions are only torn down when the task is archived.
    // Primary state is in DB: query nodeExecutionRepo for the most recent session ID
    // for this agent, then check agentSessionIndex (fast path) or lazily rehydrate.
    //
    // Eager-spawn fast path: when `eagerlySpawnWorkflowNodeAgents()` has
    // pre-created a session for this agent name at task-start time, no
    // NodeExecution row with `agentSessionId` exists yet. Resolve the
    // eager session directly from the in-memory index so the reuse logic
    // below picks it up instead of creating a second session.
    if (memberInfo?.agentName) {
      const parentTask = this.config.taskRepo.getTask(taskId);
      if (parentTask?.workflowRunId) {
        const eagerSessionId = this.eagerSubSessionIds.get(taskId)?.get(memberInfo.agentName);
        let prevExec = this.config.nodeExecutionRepo
          .listByWorkflowRun(parentTask.workflowRunId)
          .filter((e) => e.agentName === memberInfo.agentName && e.agentSessionId)
          // listByWorkflowRun returns rows ORDER BY created_at ASC, so .at(-1) is the most recent.
          .at(-1);
        if (!prevExec && eagerSessionId) {
          // Synthesize a pseudo-execution record pointing at the eager session
          // so the downstream reuse logic applies without duplicating it.
          prevExec = {
            id: '',
            workflowRunId: parentTask.workflowRunId,
            workflowNodeId: memberInfo.nodeId ?? '',
            agentName: memberInfo.agentName,
            agentId: memberInfo.agentId ?? null,
            agentSessionId: eagerSessionId,
            status: 'pending',
            result: null,
            data: null,
            createdAt: 0,
            startedAt: null,
            completedAt: null,
            updatedAt: 0,
            lastActivityAt: null,
          };
        }
        if (prevExec?.agentSessionId) {
          // Reuse existing session — get from memory or restore from DB
          const existing =
            this.agentSessionIndex.get(prevExec.agentSessionId) ??
            (await this.rehydrateSubSession(prevExec.agentSessionId));
          if (existing) {
            const existingSessionId = prevExec.agentSessionId;
            log.info(
              `TaskAgentManager: reusing session ${existingSessionId} for agent "${memberInfo.agentName}" (task ${taskId}); skipping new session ${sessionId}`
            );

            // Point the new NodeExecution at the existing session ID and mark it active.
            if (memberInfo.nodeId) {
              const nodeExecs = this.config.nodeExecutionRepo.listByNode(
                parentTask.workflowRunId,
                memberInfo.nodeId
              );
              const match =
                nodeExecs.find((e) => e.agentName === memberInfo.agentName && !e.agentSessionId) ??
                nodeExecs.find(
                  (e) =>
                    e.agentName === memberInfo.agentName && e.agentSessionId === existingSessionId
                );
              if (match) {
                this.config.nodeExecutionRepo.update(match.id, {
                  status: 'in_progress',
                  agentSessionId: existingSessionId,
                  startedAt: match.startedAt ?? Date.now(),
                  completedAt: null,
                });
              }
              // The session is now owned by this node. If it was previously
              // bound to a DIFFERENT node's execution, sweep ALL rows still
              // pointing at the reused session on OTHER nodes (not just the
              // most-recent prevExec — cyclic reactivation and pre-existing
              // multi-owner rows can leave stale co-owners). Clearing them
              // means the old nodes no longer expose the session as live, so
              // clicking them can't open/execute as the new owner. Same-node
              // cyclic retention is the same row, so it's unaffected.
              if (memberInfo.nodeId) {
                const staleCoOwners = this.config.nodeExecutionRepo
                  .listByWorkflowRun(parentTask.workflowRunId)
                  .filter(
                    (e) =>
                      e.agentSessionId === existingSessionId &&
                      e.workflowNodeId !== memberInfo.nodeId
                  );
                for (const stale of staleCoOwners) {
                  // Clear the stale session pointer but PRESERVE statuses that
                  // must stay visible to the runtime: 'blocked' (processRunTick's
                  // blocked-execution detection), 'cancelled', 'waiting_rebind',
                  // and 'pending' — resetWorkflowNodeExecutionForSpawnRetry sets
                  // pending while retaining the session pointer, and rewriting a
                  // pending co-owner to idle (terminal) would make the runtime
                  // treat an agent that never reran as finished. Only genuinely-
                  // active former owners transition to idle.
                  const mustPreserve =
                    stale.status === 'blocked' ||
                    stale.status === 'cancelled' ||
                    stale.status === 'waiting_rebind' ||
                    stale.status === 'pending';
                  this.config.nodeExecutionRepo.update(stale.id, {
                    agentSessionId: null,
                    ...(!mustPreserve ? { status: 'idle' as const } : {}),
                  });
                }
              }
            }

            existing.skillOverrides = init.skillOverrides;
            existing.toolGuards = init.toolGuards;
            await existing.updateConfig({
              model: init.model,
              provider: init.provider as Session['config']['provider'],
              thinkingLevel: init.thinkingLevel,
              systemPrompt: init.systemPrompt,
              features: init.features,
              sdkToolsPreset: init.sdkToolsPreset,
              allowedTools: init.allowedTools,
              disallowedTools: init.disallowedTools,
              agent: init.agent,
              agents: init.agents,
              settingSources: init.settingSources,
              toolGuards: init.toolGuards,
            });

            // P1-4: Rebuild the node-agent MCP server with the new node context.
            //
            // When a session is reused across workflow node activations (e.g. a Coder
            // that processes multiple review cycles), its previous `node-agent` closure
            // captures the OLD workflowNodeId, workspaceRunId, and channel resolver.
            // `send_message` uses workflowNodeId to resolve the "from" node — if stale,
            // the topology check fails or routes incorrectly ("message never arrived").
            //
            // Re-merging with a fresh node-agent and restarting the query ensures the
            // session's tool surface reflects the new node activation context.
            //
            // Re-inject node-agent and enforce the required-server invariant on the reused session.
            if (memberInfo.nodeId) {
              const reuseWorkspacePath = this.taskWorktreePaths.get(taskId) ?? init.workspacePath;
              const reuseCtx = {
                taskId,
                subSessionId: existingSessionId,
                agentName: memberInfo.agentName,
                spaceId: parentTask.spaceId,
                workflowRunId: parentTask.workflowRunId,
                workspacePath: reuseWorkspacePath,
                workflowNodeId: memberInfo.nodeId,
              };
              // Unconditionally rebuild node-agent (fresh node context).
              await this.reinjectNodeAgentMcpServer(existing, reuseCtx);
              await this.ensureRequiredMcpServersAttached(existing, {
                ...reuseCtx,
                phase: 'spawn',
              });
            }

            // Register a fresh completion callback for this execution turn.
            // Clear any stale callback registered by a previous execution (e.g. from
            // rehydrateSubSession, which registers with the old nodeId). Without this,
            // two callbacks would fire on the next idle: one for the old execution and
            // one for the new — causing duplicate completion handling.
            if (memberInfo.nodeId) {
              this.completionCallbacks.delete(existingSessionId);
              this.registerCompletionCallback(existingSessionId, async () => {
                await this.handleSubSessionComplete(taskId, memberInfo.nodeId!, existingSessionId);
              });
            }

            // P1-5: Register the self-heal callback so QueryRunner.start() can
            // recover the session if MCP servers go missing at any point in its
            // lifetime (not just at spawn). The callback fires inside the
            // workflow sub-session's first-turn setup window — the latest point
            // before the agent tries to call send_message.
            existing.onMissingWorkflowMcpServers = async (
              cbSessionId: string,
              missing: string[]
            ) => {
              await this.mcpSelfHeal(cbSessionId, missing);
            };

            // Flush any pending messages for this agent.
            const runId = parentTask.workflowRunId;
            void this.flushPendingMessagesForTarget(
              runId,
              memberInfo.agentName,
              existingSessionId
            ).catch((err) => {
              log.warn(
                `TaskAgentManager: flushPendingMessagesForTarget failed for ${memberInfo.agentName} (session ${existingSessionId}): ${err instanceof Error ? err.message : String(err)}`
              );
            });

            return existingSessionId;
          }
        }
      }
    }

    // --- First execution for this agent: create a new session.
    const parentTask = this.config.taskRepo.getTask(taskId);
    const subSessionInit =
      parentTask && !init.title
        ? { ...init, title: formatWorkflowNodeSessionTitle(parentTask, memberInfo?.agentName) }
        : init;
    const subSession = AgentSession.fromInit(
      subSessionInit,
      this.config.db,
      this.config.messageHub,
      this.config.internalEventBus,
      this.config.getApiKey,
      this.config.defaultModel,
      this.config.skillsManager,
      this.config.appMcpServerRepo
    );

    // Only genuine runtime MCP servers (node-agent, agent-memory, …) belong in
    // session.config.mcpServers. Registry servers are resolved by
    // QueryOptionsBuilder.getMcpServersFromRegistry() at query time using the
    // sub-session's context.spaceId (set in createCustomAgentInit), and are
    // reconciled live on mcp.registry.changed. Copying them in here would leave
    // a stale copy that defeats that reconciliation — disabling, updating, or
    // deleting a registry row would not take effect until the session was
    // recreated. See task #853.
    //
    // mergeRuntimeMcpServers preserves any concurrent subsystem's entries; the
    // session is freshly created here so the map is empty in practice.
    if (subSessionInit.mcpServers && Object.keys(subSessionInit.mcpServers).length > 0) {
      subSession.mergeRuntimeMcpServers(subSessionInit.mcpServers);
    }

    // Determine node ID from session convention or task context.
    // The subSessions map uses the actual session ID as both the map key and session ID.
    // We store by session ID directly (not node ID) in the flat map for getProcessingState.
    if (!this.subSessions.has(taskId)) {
      this.subSessions.set(taskId, new Map());
    }
    this.subSessions.get(taskId)!.set(sessionId, subSession);
    this.agentSessionIndex.set(sessionId, subSession);

    // Register in SessionManager cache to prevent duplicate AgentSession creation.
    this.config.sessionManager.registerSession(subSession);

    // Write active execution state on the matching NodeExecution record so that
    // AgentMessageRouter, sibling cleanup, timeout tracking, and live-query SQL
    // can resolve the session. Requires nodeId (workflowNodeId) and agentName.
    if (memberInfo?.nodeId && memberInfo.agentName) {
      const parentTask = this.config.taskRepo.getTask(taskId);
      if (parentTask?.workflowRunId) {
        const nodeExecs = this.config.nodeExecutionRepo.listByNode(
          parentTask.workflowRunId,
          memberInfo.nodeId
        );
        const match = nodeExecs.find((e) => e.agentName === memberInfo.agentName);
        if (match && !match.agentSessionId) {
          this.config.nodeExecutionRepo.update(match.id, {
            status: 'in_progress',
            agentSessionId: sessionId,
            startedAt: match.startedAt ?? Date.now(),
            completedAt: null,
          });
        } else if (match && match.agentSessionId) {
          log.warn(
            `TaskAgentManager: NodeExecution ${match.id} already has agentSessionId ${match.agentSessionId}; skipping update for new session ${sessionId}`
          );
        } else {
          log.warn(
            `TaskAgentManager: no matching NodeExecution found for (run=${parentTask.workflowRunId}, node=${memberInfo.nodeId}, agent=${memberInfo.agentName})`
          );
        }
      }
    }

    // P1-5: Register the self-heal callback (see reuse path above for rationale).
    // mcpSelfHeal does its own context lookup so no pre-computation needed here.
    subSession.onMissingWorkflowMcpServers = async (cbSessionId: string, missing: string[]) => {
      await this.mcpSelfHeal(cbSessionId, missing);
    };

    // Start streaming query for the sub-session.
    //
    // We intentionally do NOT await sdkSessionId capture on this path.
    // The belt-and-braces "block until init" guarantee lives in
    // `eagerlySpawnWorkflowNodeAgents`, which runs at the earliest point
    // we have enough context to pre-create node-agent sessions. Blocking
    // here regresses the kickoff path: when `spawnWorkflowNodeAgentForExecution`
    // is called directly from `processRunTick` (no eager spawn yet), the
    // caller immediately wants to inject the kickoff user message. A 15s
    // wait ahead of that injection delays kickoff and — if the SDK init
    // message is slow (dev-proxy) or never arrives — converts to a hard
    // failure in the caller's `saveUserMessage` via the foreign-key path.
    await subSession.startStreamingQuery();

    // Flush any queued messages addressed to this agent name so that the
    // reopen/startup race doesn't drop Task Agent → node-agent messages.
    if (memberInfo?.agentName) {
      const parentTask = this.config.taskRepo.getTask(taskId);
      const runId = parentTask?.workflowRunId;
      if (runId) {
        void this.flushPendingMessagesForTarget(runId, memberInfo.agentName, sessionId).catch(
          (err) => {
            log.warn(
              `TaskAgentManager: flushPendingMessagesForTarget failed for ${memberInfo.agentName} (session ${sessionId}): ${err instanceof Error ? err.message : String(err)}`
            );
          }
        );
      }
    }

    log.info(`TaskAgentManager: created sub-session ${sessionId} for task ${taskId}`);
    return sessionId;
  }

  /**
   * Drain the pending-message queue for a specific target in a workflow run,
   * delivering each pending message in FIFO order to the given session.
   *
   * Called immediately after `createSubSession()` activates a sub-session, and
   * also invoked by rehydration paths after daemon restart. Safe to call
   * repeatedly — rows already marked delivered/expired/failed are ignored.
   *
   * Expired rows are swept first so they're never delivered. Each successful
   * injection calls `markDelivered`; each failure increments attempts via
   * `markAttemptFailed` and the row stays pending until `max_attempts` is hit.
   */
  async flushPendingMessagesForTarget(
    workflowRunId: string,
    targetAgentName: string,
    sessionId: string
  ): Promise<void> {
    const repo = this.config.pendingMessageRepo;
    if (!repo) return;

    // Expire stale/overflow rows first so we don't deliver messages beyond retention limits.
    repo.enforceRetention({ runId: workflowRunId });
    repo.expireStale(workflowRunId);

    const execution = this.config.nodeExecutionRepo.getByAgentSessionId(sessionId);
    const workflowNodeName = execution
      ? this.workflowNodeNameForRun(workflowRunId, execution.workflowNodeId)
      : null;
    // Scope the drain so two unstarted nodes reusing an agent slot name don't
    // cross-receive. For a node-execution session, drain rows queued for that
    // node (+ legacy null-node rows). For an execution-less session (the
    // spawned post-approval/merger session) drain ONLY legacy null-node rows —
    // node-scoped rows belong to specific node-execution nodes and must never
    // be delivered to the merger.
    const drainWorkflowNodeId = execution?.workflowNodeId ?? null;
    const executionless = !execution;
    // Drain the bare agent name (new bare+workflowNodeId rows and legacy bare
    // null-node rows) plus the legacy "<nodeName>/<agent>" compound form. The
    // "<nodeId>/<agent>" alias is intentionally NOT drained here: the router now
    // emits bare+workflowNodeId (so node-id compounds are no longer produced),
    // and matching that alias against null-node rows misdelivered messages whose
    // bare slot name happened to equal "<nodeId>/<agent>".
    const queueTargetNames = [
      targetAgentName,
      ...(workflowNodeName ? [`${workflowNodeName}/${targetAgentName}`] : []),
    ];
    const seenIds = new Set<string>();
    const pending = queueTargetNames
      .flatMap((targetName) =>
        drainWorkflowNodeId != null
          ? repo.listPendingForTarget(workflowRunId, targetName, drainWorkflowNodeId)
          : repo.listPendingForTarget(workflowRunId, targetName)
      )
      .filter((row) => row.targetKind === 'node_agent')
      .filter((row) => (executionless ? row.workflowNodeId == null : true))
      .filter((row) => {
        if (seenIds.has(row.id)) return false;
        seenIds.add(row.id);
        return true;
      })
      .sort((a, b) => a.createdAt - b.createdAt);
    if (pending.length === 0) return;

    log.info(
      `TaskAgentManager: flushing ${pending.length} pending message(s) for agent=${targetAgentName} session=${sessionId}`
    );

    for (const row of pending) {
      const isSyntheticMessage = row.sourceAgentName !== 'human';
      const message = isSyntheticMessage
        ? hasAgentMessageEnvelopeForTest(row.message, row.sourceAgentName, 'node-agent')
          ? row.message
          : formatAgentMessage({
              fromLevel: pendingSourceLevel(row.sourceAgentName),
              fromAgentName: row.sourceAgentName,
              toLevel: 'node-agent',
              body: row.message,
              taskId: row.taskId,
              nodeId: targetAgentName,
            })
        : `[Message from human]: ${row.message}`;
      try {
        await this.injectSubSessionMessage(
          sessionId,
          message,
          isSyntheticMessage,
          undefined,
          // Replay a persisted deferred ("queue for next turn") human message
          // with 'defer' so it lands as a deferred row when the freshly-spawned
          // session is busy, instead of defaulting to immediate (steering the
          // kickoff). NULL/legacy rows keep the prior immediate behavior.
          row.deliveryMode ?? undefined,
          undefined,
          row.id
        );
        // A queued peer message was just delivered (the target was unavailable
        // when it was sent, so it went through the pending queue rather than the
        // router's immediate path). That is inbound activity — refresh
        // lastActivityAt so peer-message activity is captured on this common
        // activation/rehydration path too. Runtime recovery nags never reach
        // here (they use injectRuntimeRecoveryMessage), so this cannot reset the
        // stall detector's timer on the runtime's own nag.
        this.recordActivityForSession(sessionId);
        repo.markDelivered(row.id, sessionId);
        this.emitPendingDelivered(row.id, sessionId, row);
      } catch (err) {
        const errMsg = err instanceof Error ? err.message : String(err);
        log.warn(
          `TaskAgentManager: pending message ${row.id} delivery to ${sessionId} failed: ${errMsg}`
        );
        repo.markAttemptFailed(row.id, errMsg);
        // Keep going — a single per-row failure must not block the rest of the queue.
      }
    }
  }

  /**
   * Best-effort attempt to resume a node-agent session and drain its pending
   * message queue immediately after a message has been queued for it.
   *
   * Called by send_message (task-agent-tools) right after `pendingMessageRepo.enqueue()`
   * so that if the target already has a known session (e.g. it ran before and is now
   * idle/completed), the queued message is delivered without waiting for the next
   * activation trigger.
   *
   * Flow:
   *  1. Look for the most recent NodeExecution for this agent that has an `agentSessionId`.
   *  2. If found, look up the session in memory (fast path) or lazily rehydrate it from DB.
   *  3. If the session is live, call `flushPendingMessagesForTarget` to drain the queue.
   *
   * Idempotent and non-fatal — if the session cannot be found or restored the queue
   * is left intact for the next activation (e.g. when `createSubSession` spawns/reuses
   * the session and calls `flushPendingMessagesForTarget`).
   */
  async tryResumeNodeAgentSession(
    workflowRunId: string,
    agentName: string,
    workflowNodeId?: string
  ): Promise<void> {
    const repo = this.config.pendingMessageRepo;
    if (!repo) return;

    const executions = this.config.nodeExecutionRepo.listByWorkflowRun(workflowRunId);
    const exec = executions
      .filter(
        (e) =>
          e.agentName === agentName &&
          e.agentSessionId &&
          (!workflowNodeId || e.workflowNodeId === workflowNodeId)
      )
      .at(-1);
    if (!exec?.agentSessionId) return; // No known session for this agent/node — wait for spawn.

    const sessionId = exec.agentSessionId;

    if (this.agentSessionIndex.has(sessionId)) {
      // Fast path: session is already live in memory — flush pending messages directly.
      await this.flushPendingMessagesForTarget(workflowRunId, agentName, sessionId);
    } else {
      // Slow path: session is not in memory (e.g. after daemon restart).
      // rehydrateSubSession restores it AND calls flushPendingMessagesForTarget internally.
      await this.rehydrateSubSession(sessionId);
    }
  }

  /**
   * Drain the pending-message queue for the Space Agent target of a workflow run.
   * Uses the configured `spaceAgentInjector`. Called after space chat session
   * provisioning / rehydration so that Task Agent escalations survive restarts.
   */
  async flushPendingMessagesForSpaceAgent(spaceId: string, workflowRunId: string): Promise<void> {
    const repo = this.config.pendingMessageRepo;
    const inject = this.config.spaceAgentInjector;
    if (!repo || !inject) return;

    repo.enforceRetention({ runId: workflowRunId });
    repo.expireStale(workflowRunId);

    const pending = repo
      .listPendingForTarget(workflowRunId, 'space-agent')
      .filter((r) => r.targetKind === 'space_agent');
    if (pending.length === 0) return;

    const spaceChatSessionId = `space:chat:${spaceId}`;
    log.info(
      `TaskAgentManager: flushing ${pending.length} pending message(s) for Space Agent session=${spaceChatSessionId}`
    );

    for (const row of pending) {
      const message = hasAgentMessageEnvelopeForTest(
        row.message,
        row.sourceAgentName,
        'space-agent'
      )
        ? row.message
        : formatAgentMessage({
            fromLevel: pendingSourceLevel(row.sourceAgentName),
            fromAgentName: row.sourceAgentName,
            toLevel: 'space-agent',
            body: row.message,
            taskId: row.taskId,
          });
      try {
        // Look up reply routing at flush time so queued messages retain
        // their original reply-to target (ad-hoc member session) instead
        // of always going to the canonical space:chat: session.
        // Dual strategy: (1) extract from message envelope footer (per-message,
        //     immutable, survives daemon restart),
        // (2) in-memory registry (fallback for older rows without footer).
        // Footer takes priority to prevent a newer sender from overwriting
        // the routing of a previously queued message.
        const registry = this.config.replyRoutingRegistry;
        const replyTo =
          extractReplyToSessionId(message) ??
          (registry && row.taskId ? registry.get(row.taskId) : null);
        await inject(spaceId, message, replyTo, row.id);
        repo.markDelivered(row.id, spaceChatSessionId);
        this.emitPendingDelivered(row.id, spaceChatSessionId, row);
      } catch (err) {
        const errMsg = err instanceof Error ? err.message : String(err);
        log.warn(`TaskAgentManager: Space Agent delivery for ${row.id} failed: ${errMsg}`);
        repo.markAttemptFailed(row.id, errMsg);
      }
    }
  }

  /** Emit observability event that a queued message was delivered. */
  private emitPendingDelivered(
    messageId: string,
    sessionId: string,
    row: { spaceId: string; workflowRunId: string; targetAgentName: string; targetKind: string }
  ): void {
    if (!this.config.internalEventBus) return;
    void this.config.internalEventBus
      .publish('space.pendingMessage.delivered', {
        sessionId: 'global',
        spaceId: row.spaceId,
        workflowRunId: row.workflowRunId,
        targetAgentName: row.targetAgentName,
        targetKind: row.targetKind,
        messageId,
        deliveredSessionId: sessionId,
      })
      .catch(() => {});
  }

  // -------------------------------------------------------------------------
  // Public — message injection
  // -------------------------------------------------------------------------

  /**
   * Inject a message into a sub-session.
   * Called by the Task Agent MCP tool handler via the messageInjector callback.
   *
   * `images` is forwarded so human-driven RPCs (`space.task.sendMessage`) can
   * deliver image attachments directly to a node-agent sub-session. Synthetic
   * injects from other agents pass `undefined` and behave exactly as before.
   */
  async injectSubSessionMessage(
    subSessionId: string,
    message: string,
    isSyntheticMessage = true,
    images?: MessageImage[],
    deliveryMode: 'immediate' | 'defer' = 'immediate',
    /**
     * Explicit input-kind override. Synthetic agent-origin messages default to
     * 'task' (kickoff / node→node handoff), which is correct for the handoff
     * delivery paths. Non-handoff synthetic injects — external-event digests
     * (`agent.message.inject`) and hook-failure notices (`notifySourceSession`)
     * — must pass 'system' so they do NOT trigger a `resetContextPerTurn`
     * clear (the contract: only task inputs clear).
     */
    inputKindOverride?: MessageInputKind,
    messageId?: string
  ): Promise<string> {
    const inputKind: MessageInputKind =
      inputKindOverride ?? (isSyntheticMessage ? 'task' : 'human');
    return await this.injectSubSessionMessageWithOrigin(
      subSessionId,
      message,
      undefined,
      isSyntheticMessage,
      images,
      deliveryMode,
      inputKind,
      messageId
    );
  }

  async injectRuntimeRecoveryMessage(subSessionId: string, message: string): Promise<string> {
    return await this.injectSubSessionMessageWithOrigin(
      subSessionId,
      message,
      'system',
      true,
      undefined,
      'immediate',
      'system'
    );
  }

  private async injectSubSessionMessageWithOrigin(
    subSessionId: string,
    message: string,
    origin: MessageOrigin | undefined,
    isSyntheticMessage = true,
    images?: MessageImage[],
    deliveryMode: 'immediate' | 'defer' = 'immediate',
    inputKind: MessageInputKind = 'task',
    messageId?: string
  ): Promise<string> {
    // Gate: peer messages must not drive sessions of a STOPPED space. A stop
    // quiesce interrupts sessions, and a rowless merger (no row to park) or a
    // row that keeps its binding would otherwise remain a resolvable peer —
    // injecting would restart the interrupted session via ensureQueryStarted
    // and drive work the operator stopped. Deliberately NOT gated on paused:
    // pause keeps live sessions running by contract (`Space.paused` =
    // "running work continues"), so a live session on a paused space must
    // still be reachable. The routers report the failed delivery, so the
    // sender sees the failure rather than silently losing the message.
    const gateSpaceId = await this.resolveSpaceIdForSubSession(subSessionId);
    if (gateSpaceId) {
      const gateSpace = await this.config.spaceManager.getSpace(gateSpaceId);
      if (gateSpace?.stopped) {
        log.warn(
          `TaskAgentManager.injectSubSessionMessageWithOrigin: rejecting inject to session ` +
            `${subSessionId} — space ${gateSpaceId} is stopped`
        );
        throw new Error(
          `Cannot inject message to session ${subSessionId} — space ${gateSpaceId} is stopped`
        );
      }
    }

    // Reject inject for a cancelled/archived task or cancelled run — the session
    // may still be in memory (idle, not evicted on cancel) but must not be
    // restarted via ensureQueryStarted. Mirrors the rehydrateSubSession guard.
    const guardExecution = this.resolveNodeExecutionForSubSession(subSessionId);
    if (guardExecution) {
      const guardTask = this.config.taskRepo.listByWorkflowRunIncludingArchived(
        guardExecution.workflowRunId
      )[0];
      const guardRun = this.config.workflowRunRepo.getRun(guardExecution.workflowRunId);
      if (
        guardTask?.status === 'cancelled' ||
        guardTask?.status === 'archived' ||
        guardRun?.status === 'cancelled'
      ) {
        log.warn(
          `TaskAgentManager.injectSubSessionMessageWithOrigin: rejecting inject to session ${subSessionId} — task/run is terminal (${guardTask?.status ?? guardRun?.status})`
        );
        throw new Error(
          `Cannot inject message to session ${subSessionId} — task/run is terminal (${guardTask?.status ?? guardRun?.status})`
        );
      }
    }

    // Serialize per session so a resetContextPerTurn clear (in-stream /clear
    // ahead of the handoff) cannot interleave with a concurrent inject.
    return this.withSessionInjectLock(subSessionId, async () => {
      // Re-check the space inside the lock: the gate read above ran before
      // the lock acquisition and index scans, and a stop landing in between
      // must not let the rehydrate branch below re-bind a parked execution
      // (`updateSessionId` on the repair path) and restart the interrupted
      // session via startStreamingQuery — the exact work the gate prevents.
      // Same stopped-only semantics as the gate.
      if (gateSpaceId) {
        const lockedSpace = await this.config.spaceManager.getSpace(gateSpaceId);
        if (lockedSpace?.stopped) {
          log.warn(
            `TaskAgentManager.injectSubSessionMessageWithOrigin: rejecting inject to session ` +
              `${subSessionId} — space ${gateSpaceId} stopped during the inject`
          );
          throw new Error(
            `Cannot inject message to session ${subSessionId} — space ${gateSpaceId} stopped during the inject`
          );
        }
      }
      const indexed = this.agentSessionIndex.get(subSessionId);
      if (indexed) {
        return await this.injectMessageIntoSession(
          indexed,
          message,
          deliveryMode,
          origin,
          isSyntheticMessage,
          images,
          inputKind,
          messageId
        );
      }

      // Find the sub-session by ID across all task maps
      for (const [, nodeMap] of this.subSessions) {
        const session = nodeMap.get(subSessionId);
        if (session) {
          return await this.injectMessageIntoSession(
            session,
            message,
            deliveryMode,
            origin,
            isSyntheticMessage,
            images,
            inputKind,
            messageId
          );
        }
      }

      // Not in memory — attempt lazy rehydration from DB
      const rehydrated = await this.rehydrateSubSession(subSessionId);
      if (rehydrated) {
        return await this.injectMessageIntoSession(
          rehydrated,
          message,
          deliveryMode,
          origin,
          isSyntheticMessage,
          images,
          inputKind,
          messageId
        );
      }
      throw new Error(`Sub-session not found: ${subSessionId}`);
    });
  }

  /**
   * Per-session async mutex (promise-chain). Holds are released in finally so
   * a throwing inject never deadlocks the session. injectMessageIntoSession is
   * not re-entrant (it never injects into the same session while running), so
   * there is no self-deadlock risk.
   */
  private async withSessionInjectLock<T>(sessionId: string, fn: () => Promise<T>): Promise<T> {
    const prev = this.sessionInjectLocks.get(sessionId) ?? Promise.resolve();
    let release!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    // Each holder publishes its own tail promise; a later caller for the same
    // session chains onto this one and overwrites the map entry with its own.
    const tail = prev.then(() => held);
    this.sessionInjectLocks.set(sessionId, tail);
    await prev;
    try {
      return await fn();
    } finally {
      release();
      // Self-clean: if no later caller chained onto us (the map still points at
      // our tail), drop the entry so the map doesn't retain one resolved
      // promise per historical session ID and grow without bound.
      if (this.sessionInjectLocks.get(sessionId) === tail) {
        this.sessionInjectLocks.delete(sessionId);
      }
    }
  }

  /**
   * Per-session restore mutex (promise-chain), mirroring
   * {@link withSessionInjectLock} but backed by {@link sessionRestoreLocks} so
   * restore does not hold the inject lock. Used to serialize concurrent
   * on-demand restores of the same post-approval worker session.
   */
  private async withSessionRestoreLock<T>(sessionId: string, fn: () => Promise<T>): Promise<T> {
    const prev = this.sessionRestoreLocks.get(sessionId) ?? Promise.resolve();
    let release!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const tail = prev.then(() => held);
    this.sessionRestoreLocks.set(sessionId, tail);
    await prev;
    try {
      return await fn();
    } finally {
      release();
      if (this.sessionRestoreLocks.get(sessionId) === tail) {
        this.sessionRestoreLocks.delete(sessionId);
      }
    }
  }

  /**
   * Find the live AgentSession for a named agent within a task.
   *
   * Queries NodeExecution records from DB to find the most recent agentSessionId
   * for the given agent name, then returns the live session from agentSessionIndex
   * (fast path) or lazily rehydrates it from DB (after daemon restart).
   *
   * Returns null if the agent has never been spawned for this task.
   */
  async getSubSessionByAgentName(
    taskId: string,
    agentName: string,
    workflowNodeId?: string
  ): Promise<AgentSession | null> {
    const task = this.config.taskRepo.getTask(taskId);
    if (!task?.workflowRunId) return null;

    const executions = this.config.nodeExecutionRepo.listByWorkflowRun(task.workflowRunId);
    // Most recent execution for this agent that has a session ID assigned.
    // `workflowNodeId` scopes the lookup to a specific node so that, when two
    // nodes reuse the same agent slot name, only the requested node's session
    // is returned — otherwise the first matching session would hijack the
    // caller's node-specific activation.
    const exec = executions
      .filter(
        (e) =>
          e.agentName === agentName &&
          e.agentSessionId &&
          e.status !== 'cancelled' &&
          // A pending execution may retain a dead agentSessionId from
          // resetWorkflowNodeExecutionForSpawnRetry — selecting it would
          // rehydrate/inject into the failed session instead of letting
          // activation spawn a replacement.
          e.status !== 'pending' &&
          (!workflowNodeId || e.workflowNodeId === workflowNodeId)
      )
      .at(-1);
    if (!exec?.agentSessionId) return null;

    // Fast path: session already live in memory
    const cached = this.agentSessionIndex.get(exec.agentSessionId);
    if (cached) return cached;

    // Slow path: restore from DB (lazy rehydration — no explicit startup step needed)
    return this.rehydrateSubSession(exec.agentSessionId);
  }

  /**
   * Return all agent names that have an assigned session in this task's workflow run.
   * Used by the broadcast ('*') path in send_message.
   * Reads from DB so it is correct after daemon restarts without any rehydration step.
   */
  async getAgentNamesForTask(taskId: string): Promise<string[]> {
    const task = this.config.taskRepo.getTask(taskId);
    if (!task?.workflowRunId) return [];
    const executions = this.config.nodeExecutionRepo.listByWorkflowRun(task.workflowRunId);
    const names = new Set(executions.filter((e) => e.agentSessionId).map((e) => e.agentName));
    return [...names];
  }

  isAgentDeclaredOnNode(taskId: string, workflowNodeId: string, agentName: string): boolean {
    const task = this.config.taskRepo.getTask(taskId);
    if (!task?.workflowRunId) return false;
    const run = this.config.workflowRunRepo.getRun(task.workflowRunId);
    if (!run?.workflowId) return false;
    const workflow = this.config.spaceWorkflowManager.getWorkflowForRun(run);
    if (!workflow) return false;
    const node = workflow.nodes.find((n) => n.id === workflowNodeId);
    if (!node) return false;
    try {
      const slots = resolveNodeAgents(node);
      return slots.some((slot) => slot.name === agentName);
    } catch {
      return false;
    }
  }

  /**
   * Return every agent slot name declared in the static workflow definition
   * for this task, regardless of whether a `node_execution` row exists or a
   * session has been spawned. The workflow definition is the canonical source
   * for "is this a known peer?" — node_executions are lazily created when a
   * node is first activated, so they cannot stand in for it.
   *
   * Used by `send_message` to widen the queueable / reachable target set so
   * declared-but-not-yet-spawned peers can receive lazy activation rather
   * than failing with `notFoundAgentNames`.
   *
   * Returns `[]` if the task has no workflow run, or the workflow / run lookup
   * fails (e.g. on a standalone task).
   */
  getWorkflowDeclaredAgentNamesForTask(taskId: string): string[] {
    const task = this.config.taskRepo.getTask(taskId);
    if (!task?.workflowRunId) return [];
    const run = this.config.workflowRunRepo.getRun(task.workflowRunId);
    if (!run?.workflowId) return [];
    const workflow = this.config.spaceWorkflowManager.getWorkflowForRun(run);
    if (!workflow) return [];
    const names = new Set<string>();
    for (const node of workflow.nodes) {
      let slots: ReturnType<typeof resolveNodeAgents>;
      try {
        slots = resolveNodeAgents(node);
      } catch {
        // Defensive: a malformed node should not poison the lookup of valid siblings.
        continue;
      }
      for (const slot of slots) {
        names.add(slot.name);
      }
    }
    return [...names];
  }

  /**
   * Resolve the persisted post-approval worker session (e.g. the `merger`) for
   * a task, if one has been spawned.
   *
   * The post-approval worker is an execution-less workflow node agent: it has a
   * live session (linked on `space_tasks.post_approval_session_id`) but no
   * `node_executions` row, so it is invisible to every nodeExecutionRepo-based
   * lookup. Returns its session id together with the agent slot name it
   * represents, so the human-reply RPC (`space.task.sendMessage`) can route to
   * it instead of failing with "Workflow agent not found: agent".
   *
   * The agent name is read from the worker session's stamped
   * `metadata.promptProvenance` (the durable identity captured at spawn) so it
   * stays correct even if the workflow's post-approval route is later edited;
   * the workflow route is only consulted as a legacy fallback for sessions
   * persisted before provenance existed.
   *
   * Returns `null` when the task has no post-approval session or the identity
   * cannot be resolved.
   */
  getPostApprovalWorkerSession(
    taskId: string,
    hintSessionId?: string
  ): { sessionId: string; agentName: string; nodeId?: string | null } | null {
    // An explicit session id (e.g. the user selected an older, re-approved
    // worker in the activity feed) is validated directly against durable
    // provenance rather than collapsed to the most-recent worker — otherwise
    // findDurableWorkerSessionId's LIMIT 1 would make every older worker
    // unreachable by explicit selection.
    if (hintSessionId) {
      return this.validateWorkerSessionForTask(taskId, hintSessionId);
    }
    const identity = this.readPostApprovalWorkerIdentity(taskId);
    return identity
      ? {
          sessionId: identity.sessionId,
          agentName: identity.agentName,
          nodeId: identity.nodeId ?? null,
        }
      : null;
  }

  /**
   * Validate that a specific session id is a post-approval worker for a task
   * (task-scoped via `session_context.taskId`, execution-less), and resolve its
   * agent name — from `promptProvenance` when present, else the workflow's
   * dispatched post-approval route (legacy pre-provenance sessions). Rejects
   * terminal (cancelled/archived) tasks. Returns `{sessionId, agentName}` or
   * null.
   */
  private validateWorkerSessionForTask(
    taskId: string,
    sessionId: string
  ): { sessionId: string; agentName: string; nodeId?: string | null } | null {
    const task = this.config.taskRepo.getTask(taskId);
    if (!task?.workflowRunId) return null;
    if (task.status === 'cancelled' || task.status === 'archived') return null;
    if (!this.sessionIsWorkerForTask(sessionId, taskId)) return null;
    const provenance = this.readProvenanceFromSessionRow(sessionId);
    const agentName = provenance?.agentName ?? this.legacyWorkflowRouteAgentName(task);
    return agentName
      ? {
          sessionId,
          agentName,
          nodeId: provenance?.nodeId ?? this.legacyWorkflowRouteNodeId(task) ?? null,
        }
      : null;
  }

  /**
   * Resolve the post-approval target agent name from the task's workflow route
   * — the legacy fallback for worker sessions persisted before
   * `promptProvenance.agentName` existed. Returns `undefined` if the workflow
   * can't be resolved or has no dispatched post-approval route.
   */
  private legacyWorkflowRouteAgentName(
    task: {
      workflowRunId?: string | null;
    } | null
  ): string | undefined {
    if (!task?.workflowRunId) return undefined;
    const run = this.config.workflowRunRepo.getRun(task.workflowRunId);
    if (!run?.workflowId) return undefined;
    const workflow = this.config.spaceWorkflowManager.getWorkflowForRun(run);
    return resolvePostApprovalTargetAgentName(workflow);
  }

  /**
   * The post-approval route's NODE id for a legacy (pre-provenance) worker —
   * derived from the workflow so a node-scoped send can still exact-match the
   * legacy merger node instead of being accepted for any node. Mirrors
   * legacyWorkflowRouteAgentName.
   */
  private legacyWorkflowRouteNodeId(
    task: {
      workflowRunId?: string | null;
    } | null
  ): string | undefined {
    if (!task?.workflowRunId) return undefined;
    const run = this.config.workflowRunRepo.getRun(task.workflowRunId);
    if (!run?.workflowId) return undefined;
    const workflow = this.config.spaceWorkflowManager.getWorkflowForRun(run);
    return resolvePostApprovalRouteNodeId(workflow);
  }

  /**
   * Whether a session id is an execution-less post-approval worker owned by a
   * given task: a `worker` session whose `session_context.taskId` matches, with
   * no `node_executions` row (so a normal, execution-backed node agent is
   * excluded). Scoped to the TASK (not the run) so sibling tasks sharing one
   * run can't cross-match, and does NOT require `promptProvenance` so legacy
   * (pre-provenance) worker sessions are accepted. Shared by the hint-validation
   * and restore paths.
   */
  private sessionIsWorkerForTask(sessionId: string, taskId: string): boolean {
    try {
      const row = this.config.db
        .getDatabase()
        .prepare(
          `SELECT 1 AS ok
             FROM sessions s
            WHERE s.id = ?
              AND s.type = 'worker'
              AND json_extract(s.session_context, '$.taskId') = ?
              AND NOT EXISTS (SELECT 1 FROM node_executions ne WHERE ne.agent_session_id = s.id)`
        )
        .get(sessionId, taskId) as { ok?: number } | undefined;
      return Boolean(row);
    } catch {
      return false;
    }
  }

  /**
   * Read the durable identity of a task's spawned post-approval worker from the
   * persisted session row: `metadata.promptProvenance` (agent slot, node id,
   * agent id). Falls back to the workflow's dispatched post-approval route for
   * legacy sessions without provenance. Returns `null` when the task has no
   * post-approval session, the session row is missing, or no identity can be
   * resolved.
   *
   * Resolution order:
   *  1. The live pointer `space_tasks.post_approval_session_id` (set while the
   *     worker is the active post-approval target).
   *  2. Durable provenance — after `mark_complete` clears that pointer, the
   *     worker session + its messages persist, so resolve the execution-less
   *     worker from `sdk_messages` + `promptProvenance` so a reply to the
   *     completed worker still routes instead of failing.
   *
   * When `hintSessionId` is supplied (an explicitly-selected worker, e.g. an
   * older re-approved one), that specific session is validated and returned
   * instead of the most-recent — so restore targets the worker the caller
   * chose, not whatever `findDurableWorkerSessionId`'s LIMIT 1 picks.
   */
  private readPostApprovalWorkerIdentity(
    taskId: string,
    hintSessionId?: string
  ): {
    sessionId: string;
    agentName: string;
    nodeId?: string;
    agentId?: string;
  } | null {
    const task = this.config.taskRepo.getTask(taskId);
    // A cancelled/archived task's worker must not be (re)startable by a reply.
    // The execution-less worker survives the cancel sweep (idle sessions are
    // not torn down) and injectSubSessionMessage's terminal guard is null
    // without a node_execution, so without this gate a reply would deliver
    // into — and restart — a terminal task's worker.
    if (task?.status === 'cancelled' || task?.status === 'archived') return null;
    if (hintSessionId) {
      // Validate the explicit session (task-scoped, execution-less) and resolve
      // its identity — provenance first, workflow-route fallback for legacy.
      if (!this.sessionIsWorkerForTask(hintSessionId, taskId)) return null;
      const provenance = this.readProvenanceFromSessionRow(hintSessionId);
      const agentName = provenance?.agentName ?? this.legacyWorkflowRouteAgentName(task);
      if (!agentName) return null;
      const nodeId = provenance?.nodeId ?? this.legacyWorkflowRouteNodeId(task);
      return {
        sessionId: hintSessionId,
        agentName,
        ...(nodeId ? { nodeId } : {}),
        ...(provenance?.agentId ? { agentId: provenance.agentId } : {}),
      };
    }
    let sessionId = task?.postApprovalSessionId;
    let provenance = sessionId ? this.readProvenanceFromSessionRow(sessionId) : null;
    if (!provenance && !sessionId && task?.status === 'done') {
      // Durable fallback — ONLY for completed-task history. mark_complete
      // clears post_approval_session_id on approved→done; the worker session +
      // its provenance persist, so resolve the execution-less worker for THIS
      // task so a reply to the completed worker still routes. Gated to `done`
      // so a REOPENED task (recoverWorkflowBackedTask keeps the run id but
      // clears the pointer) does not resolve its previous completed worker and
      // deliver replies to a stale session instead of the current agent.
      const durableId = this.findDurableWorkerSessionId(taskId);
      if (durableId) {
        sessionId = durableId;
        provenance = this.readProvenanceFromSessionRow(durableId);
      }
    }
    if (!sessionId) return null;
    let agentName = provenance?.agentName;
    const agentId = provenance?.agentId;
    // nodeId: provenance first; for a legacy (pre-provenance) worker derive it
    // from the workflow's post-approval route node so node-scoped sends can
    // still exact-match instead of being accepted for any node.
    const nodeId = provenance?.nodeId ?? this.legacyWorkflowRouteNodeId(task);
    if (!agentName) {
      // Legacy session (pre-provenance): resolve from the current workflow route.
      agentName = this.legacyWorkflowRouteAgentName(task);
      if (!agentName) return null;
    }
    return { sessionId, agentName, ...(nodeId ? { nodeId } : {}), ...(agentId ? { agentId } : {}) };
  }

  /**
   * Read `metadata.promptProvenance` (agentName/nodeId/agentId) for a session
   * row. Returns `null` when the row is missing or the metadata has no
   * provenance / is malformed.
   */
  private readProvenanceFromSessionRow(sessionId: string): {
    agentName?: string;
    nodeId?: string;
    agentId?: string;
  } | null {
    try {
      const row = this.config.db
        .getDatabase()
        .prepare('SELECT metadata FROM sessions WHERE id = ?')
        .get(sessionId) as { metadata?: string | null } | undefined;
      if (!row?.metadata) return null;
      const provenance = (JSON.parse(row.metadata) as { promptProvenance?: unknown })
        ?.promptProvenance as { agentName?: string; nodeId?: string; agentId?: string } | undefined;
      return provenance ?? null;
    } catch {
      return null;
    }
  }

  /**
   * Find the execution-less post-approval worker session owned by a task, from
   * durable provenance: a `worker` session whose `session_context.taskId`
   * matches, with no `node_executions` row (normal node-agent sessions are
   * execution-backed and excluded). Scoped to the TASK (not the run) so sibling
   * tasks sharing a run don't cross-match. Used after `mark_complete` clears
   * `post_approval_session_id` (gated to `done` tasks by the caller). Returns
   * the most recently active matching session id, or `undefined`.
   */
  private findDurableWorkerSessionId(taskId: string): string | undefined {
    try {
      const row = this.config.db
        .getDatabase()
        .prepare(
          `SELECT s.id AS id
             FROM sessions s
            WHERE s.type = 'worker'
              AND json_extract(s.session_context, '$.taskId') = ?
              AND NOT EXISTS (SELECT 1 FROM node_executions ne WHERE ne.agent_session_id = s.id)
            ORDER BY s.last_active_at DESC
            LIMIT 1`
        )
        .get(taskId) as { id?: string } | undefined;
      return row?.id;
    } catch {
      return undefined;
    }
  }

  /**
   * Read a persisted `rate_limit_cooldown` processing state for a session that
   * is still active (retryAt in the future). Returns `{retryAt}` or null. Used
   * by the worker restore path to avoid bypassing a rate cap across a restart.
   */
  private readPersistedRateLimitCooldown(sessionId: string): { retryAt: number } | null {
    try {
      const row = this.config.db
        .getDatabase()
        .prepare('SELECT processing_state FROM sessions WHERE id = ?')
        .get(sessionId) as { processing_state?: string | null } | undefined;
      if (!row?.processing_state) return null;
      const state = JSON.parse(row.processing_state) as { status?: string; retryAt?: unknown };
      if (state.status !== 'rate_limit_cooldown') return null;
      const retryAt = typeof state.retryAt === 'number' ? state.retryAt : null;
      if (retryAt === null || retryAt <= Date.now()) return null;
      return { retryAt };
    } catch {
      return null;
    }
  }

  /**
   * Restore a persisted post-approval worker session to memory on demand.
   *
   * The worker has no `node_executions` row, so {@link rehydrateSubSession}
   * (which keys off executions) cannot restore it, and after a daemon restart
   * it is absent from the in-memory index — `injectSubSessionMessage` then
   * throws "Sub-session not found". This brings it back so a human reply
   * reaches the existing worker instead of being silently lost or queued
   * indefinitely (the post-approval router only re-dispatches on a new trigger,
   * so a queued reply to an already-approved task would never drain).
   *
   * Mirrors the worker spawn's provisioning (node-agent + space-agent-tools +
   * agent-memory MCP, the slot's runtime-only `extraMcpServers`, the current
   * slot prompt / toolGuards / skillOverrides, self-heal callbacks) but uses
   * `AgentSession.restore` to resume the persisted session rather than
   * `fromInit`. Deliberately does NOT register a completion callback:
   * post-approval completion flows through `mark_complete`, not the
   * node-completion path (matching the spawn path).
   *
   * Concurrent restores for the same session are serialized via
   * {@link withSessionRestoreLock} so two racing replies construct exactly one
   * `AgentSession` and start one SDK query.
   *
   * Returns the restored session id (whether newly restored or already live),
   * or `null` when the worker cannot be resolved or restored (e.g. the session
   * row is gone, or the task/run is terminal).
   */
  async restorePostApprovalWorkerSession(
    taskId: string,
    hintSessionId?: string
  ): Promise<string | null> {
    // Resolve the SAME session the caller targeted (via hintSessionId) — not
    // the most-recent worker — so a reply to an explicitly-selected older
    // worker restores and delivers to that worker rather than silently
    // misrouting to the most-recent one.
    const identity = this.readPostApprovalWorkerIdentity(taskId, hintSessionId);
    if (!identity) return null;

    // Fast path: already live in memory — nothing to restore.
    if (this.agentSessionIndex.has(identity.sessionId)) return identity.sessionId;

    // Serialize concurrent restores for the same session (e.g. two human
    // replies racing after a daemon restart). The first caller performs the
    // restore; any later caller awaits this mutex, then rechecks the index and
    // finds the session live — so only one AgentSession.restore + streaming
    // start happens per persisted id. Uses a dedicated mutex (not the inject
    // lock) so restore never self-deadlocks against the queue flush / reply
    // inject it triggers.
    return this.withSessionRestoreLock(identity.sessionId, () =>
      this.performPostApprovalWorkerRestore(taskId, identity)
    );
  }

  /**
   * Restore body, invoked under {@link withSessionRestoreLock}.
   */
  private async performPostApprovalWorkerRestore(
    taskId: string,
    identity: { sessionId: string; agentName: string; nodeId?: string; agentId?: string }
  ): Promise<string | null> {
    const { sessionId, agentName, nodeId, agentId } = identity;

    // Recheck under the lock — a concurrent restore may have just registered it.
    if (this.agentSessionIndex.has(sessionId)) return sessionId;

    const task = this.config.taskRepo.getTask(taskId);
    if (!task?.workflowRunId) return null;
    if (task.status === 'cancelled' || task.status === 'archived') return null;
    const workflowRun = this.config.workflowRunRepo.getRun(task.workflowRunId);
    if (workflowRun?.status === 'cancelled') return null;

    // Honor a persisted rate-limit cooldown. AgentSession.restore resets
    // rate_limit_cooldown→idle, which would let us start the worker and deliver
    // the reply before resetAt — bypassing the cap. The RateLimitWatchdog only
    // (re)arms its resume timer through its own 429-decision flow, so we can't
    // safely auto-resume a persisted cooldown here; surface an honest error so
    // the caller retries once the cooldown clears. (Full auto-deferral across a
    // restart is a follow-up.)
    const cooldown = this.readPersistedRateLimitCooldown(sessionId);
    if (cooldown) {
      throw new Error(
        `Post-approval worker "${agentName}" is rate-limited until ${new Date(cooldown.retryAt).toISOString()}; retry after the cooldown expires.`
      );
    }

    const space = await this.config.spaceManager.getSpace(task.spaceId);
    if (!space) return null;
    // Restart-safe worktree resolution: taskWorktreePaths is empty after a
    // daemon restart, so consult the durable space_worktrees table (which
    // getTaskWorktreePath does on cache miss) rather than falling back to the
    // space root — otherwise the worker runs against the wrong checkout and
    // sanitizes the wrong SDK transcript.
    const workspacePath = this.getTaskWorktreePath(taskId) ?? space.workspacePath;

    const workflow = workflowRun?.workflowId
      ? this.config.spaceWorkflowManager.getWorkflowForRun(workflowRun)
      : null;

    // Resolve the persisted slot from provenance so the slot's current config
    // is re-applied like the spawn path: the runtime-only extraMcpServers
    // (never persisted) plus the current prompt / toolGuards / skillOverrides
    // (toolGuards IS persisted, but re-applying the current slot value clears
    // any that a workflow edit removed — see the unconditional assign below).
    // Falls back to minimal provisioning when the slot/node can't be resolved
    // (e.g. a legacy session without full provenance).
    let matchedSlot: ReturnType<typeof resolveNodeAgents>[number] | null = null;
    let matchedNode: WorkflowNode | undefined;
    if (workflow && nodeId) {
      matchedNode = workflow.nodes.find((n) => n.id === nodeId);
      if (matchedNode) {
        for (const slot of resolveNodeAgents(matchedNode)) {
          if (slot.name === agentName || (agentId && slot.agentId === agentId)) {
            matchedSlot = slot;
            break;
          }
        }
      }
    }

    // Reuse a SessionCache ghost (e.g. one hydrated by the state.session RPC
    // via getSessionAsync when the task panel viewed the worker) instead of
    // building a second AgentSession. registerSession would otherwise overwrite
    // the ghost without disposing it, leaving two instances with competing
    // message.persisted subscriptions / SDK queries on one conversation.
    const cached = this.config.sessionManager.getCachedSession(sessionId);
    const createdNow = !cached;
    const agentSession =
      cached ??
      AgentSession.restore(
        sessionId,
        this.config.db,
        this.config.messageHub,
        this.config.internalEventBus,
        this.config.getApiKey,
        this.config.skillsManager,
        this.config.appMcpServerRepo,
        { autoReplayPendingMessages: false }
      );
    if (!agentSession) return null;

    let slotInit: AgentSessionInit | null = null;
    if (matchedSlot?.agentId && matchedNode) {
      const slotOverrides = buildSlotOverrides(matchedSlot, {
        task,
        node: matchedNode,
        workflow: workflow ?? undefined,
        workflowRun: workflowRun ?? undefined,
      });
      slotInit = resolveAgentInit({
        task,
        space,
        agentManager: this.config.spaceAgentManager,
        sessionId,
        workspacePath,
        workflowRun: workflowRun ?? undefined,
        workflow: workflow ?? undefined,
        slotOverrides,
        agentId: matchedSlot.agentId,
      });
      if (slotInit.systemPrompt) agentSession.setRuntimeSystemPrompt(slotInit.systemPrompt);
      // Assign unconditionally (like skillOverrides and the reuse path at the
      // createSubSession reuse branch): slotInit reflects the CURRENT slot
      // config, so a workflow edit that removed the slot's toolGuards must
      // clear them rather than keep enforcing the stale persisted guards.
      agentSession.toolGuards = slotInit.toolGuards;
      agentSession.skillOverrides = slotInit.skillOverrides;
    }

    // Re-provision runtime-only MCP servers: the slot's extraMcpServers (from
    // slotInit — runtime-only, not persisted) plus the three standard servers
    // every worker needs (node-agent, space-agent-tools, agent-memory).
    const nodeAgentMcpServer = this.buildNodeAgentMcpServerForSession(
      taskId,
      sessionId,
      agentName,
      task.spaceId,
      task.workflowRunId,
      workspacePath,
      nodeId ?? ''
    );
    const mergedMcpServers: Record<string, McpServerConfig> = {
      // slotInit?.mcpServers holds the slot's runtime-only extraMcpServers.
      ...slotInit?.mcpServers,
      'node-agent': nodeAgentMcpServer as unknown as McpServerConfig,
      'space-agent-tools': this.config.spaceRuntimeService.buildMemberSpaceToolsMcpServer(
        space,
        sessionId
      ),
      ...this.buildAgentMemoryMcpServers(task.spaceId, sessionId),
    };
    agentSession.mergeRuntimeMcpServers(mergedMcpServers);

    await this.ensureNodeAgentAttached(agentSession, {
      taskId,
      subSessionId: sessionId,
      agentName,
      spaceId: task.spaceId,
      workflowRunId: task.workflowRunId,
      workspacePath,
      workflowNodeId: nodeId ?? '',
      phase: 'rehydrate',
    });

    // Self-heal callbacks (mirror spawnPostApprovalSubSession).
    agentSession.onMissingMemberSpaceMcpServers = async (sid: string) => {
      await this.config.spaceRuntimeService.reattachMemberSpaceTools(sid);
    };
    agentSession.onMissingWorkflowMcpServers = async (cbSessionId: string, missing: string[]) => {
      await this.mcpSelfHeal(cbSessionId, missing);
    };

    // Register in TaskAgentManager's maps. Only (re)register the SessionCache
    // entry when we created the session this turn — a reused ghost is already
    // cached, and re-setting it is redundant.
    if (!this.subSessions.has(taskId)) {
      this.subSessions.set(taskId, new Map());
    }
    this.subSessions.get(taskId)!.set(sessionId, agentSession);
    this.agentSessionIndex.set(sessionId, agentSession);
    if (createdNow) this.config.sessionManager.registerSession(agentSession);

    // Resume the SDK, replay any pending continuations, then drain queued
    // messages for this agent slot (e.g. the reply that triggered the restore).
    // If resumption throws, evict the half-registered session from every map so
    // the fast path does not hand out a dead id and a future restore can retry.
    try {
      this.sanitizeSDKSessionTranscriptForRehydration(agentSession, workspacePath);
      await agentSession.startStreamingQuery();
      await this.replayPendingMessagesAfterRuntimeProvisioning(agentSession);
    } catch (err) {
      this.subSessions.get(taskId)?.delete(sessionId);
      this.agentSessionIndex.delete(sessionId);
      if (createdNow) {
        await this.config.sessionManager.unregisterSession(sessionId).catch(() => {});
      }
      throw err;
    }
    void this.flushPendingMessagesForTarget(task.workflowRunId, agentName, sessionId).catch(
      (err) => {
        log.warn(
          `restorePostApprovalWorkerSession: flushPendingMessagesForTarget failed for ${agentName} (session ${sessionId}): ${err instanceof Error ? err.message : String(err)}`
        );
      }
    );

    log.info(
      `TaskAgentManager.restorePostApprovalWorkerSession: restored worker ${sessionId} (agent ${agentName}${agentId ? `/${agentId}` : ''}) for task ${taskId}`
    );
    return sessionId;
  }

  /**
   * Lazily ensure a node_execution row exists for the workflow node that owns
   * `agentName` so that the SpaceRuntime tick loop will spawn its session.
   *
   * Used by the Task Agent `send_message` queue path when the target is a
   * workflow-declared peer that has never been activated. Without this hop
   * the queue would fill but no spawn would ever fire — the `pendingMessageRepo`
   * is drained only when the target session activates, which itself requires a
   * node_execution row to exist.
   *
   * Idempotent: `ChannelRouter.activateNode` is a no-op when active executions
   * already exist for the node, and `createOrIgnore` makes the underlying row
   * write safe under concurrent activation requests.
   *
   * Resolution:
   *  1. Look up the task → workflowRun → workflow.
   *  2. Find the workflow node whose `resolveNodeAgents()` includes `agentName`.
   *  3. Build a ChannelRouter (mirrors `buildNodeAgentMcpServerForSession`) and
   *     call `activateNode(runId, nodeId)`.
   *
   * Returns `false` when the agent is not declared in the workflow, or when
   * any required dependency is missing (best-effort — never throws).
   */
  async activateTargetSessionsForMessage(
    taskId: string,
    workflowRunId: string,
    agentName: string,
    options?: { reopenReason?: string; reopenBy?: string; workflowNodeId?: string }
  ): Promise<Array<{ agentName: string; sessionId: string }>> {
    await this.tryResumeNodeAgentSession(workflowRunId, agentName, options?.workflowNodeId);
    const matchesNode = (workflowNodeId: string) =>
      !options?.workflowNodeId || workflowNodeId === options.workflowNodeId;
    const existing = this.config.nodeExecutionRepo
      .listByWorkflowRun(workflowRunId)
      .filter(
        (execution) =>
          execution.agentName === agentName &&
          matchesNode(execution.workflowNodeId) &&
          (execution.status === 'in_progress' || execution.status === 'blocked')
      )
      .at(-1);
    if (existing) {
      if (existing.agentSessionId && this.isSessionAlive(existing.agentSessionId)) {
        return [{ agentName, sessionId: existing.agentSessionId }];
      }
      // Evict the stale session from the index so the spawn code
      // doesn't short-circuit on agentSessionIndex.has().
      if (existing.agentSessionId) {
        this.agentSessionIndex.delete(existing.agentSessionId);
      }
      this.config.nodeExecutionRepo.update(existing.id, {
        status: 'pending',
      });
    }

    if (options?.workflowNodeId) {
      const task = this.config.taskRepo.getTask(taskId);
      if (task?.workflowRunId) {
        const run = this.config.workflowRunRepo.getRun(task.workflowRunId);
        if (run?.workflowId) {
          const workflow = this.config.spaceWorkflowManager.getWorkflowForRun(run);
          const node = workflow?.nodes.find((candidate) => candidate.id === options.workflowNodeId);
          const slots = node ? resolveNodeAgents(node) : [];
          if (!slots.some((slot) => slot.name === agentName)) return [];
        }
      }
      await this.ensureWorkflowNodeActivationForAgent(taskId, agentName, options);
    } else {
      await this.ensureWorkflowNodeActivationForAgent(taskId, agentName, options);
    }

    const task = this.config.taskRepo.getTask(taskId);
    const run = this.config.workflowRunRepo.getRun(workflowRunId);
    const workflow = run?.workflowId
      ? this.config.spaceWorkflowManager.getWorkflowForRun(run)
      : null;
    const space = task ? await this.config.spaceManager.getSpace(task.spaceId) : null;
    if (!task || !run || !workflow || !space) return [];

    const execution = this.config.nodeExecutionRepo
      .listByWorkflowRun(workflowRunId)
      .find(
        (candidate) => candidate.agentName === agentName && matchesNode(candidate.workflowNodeId)
      );
    if (!execution) return [];

    const spawnPromise = this.spawnWorkflowNodeAgentForExecution(
      task,
      space,
      workflow,
      run,
      execution
    );
    const timeoutMs = 30_000;
    const timeoutPromise = new Promise<null>((resolve) => {
      setTimeout(() => resolve(null), timeoutMs);
    });
    const sessionId = await Promise.race([spawnPromise, timeoutPromise]);
    if (!sessionId) {
      log.warn(
        `TaskAgentManager.activateTargetSessionsForMessage: timed out after ${timeoutMs}ms activating agent "${agentName}" for run ${workflowRunId}`
      );
      return [];
    }
    return [{ agentName, sessionId }];
  }

  async ensureWorkflowNodeActivationForAgent(
    taskId: string,
    agentName: string,
    options?: { reopenReason?: string; reopenBy?: string; workflowNodeId?: string }
  ): Promise<boolean> {
    try {
      const task = this.config.taskRepo.getTask(taskId);
      if (!task?.workflowRunId) return false;
      const run = this.config.workflowRunRepo.getRun(task.workflowRunId);
      if (!run?.workflowId) return false;
      const workflow = this.config.spaceWorkflowManager.getWorkflowForRun(run);
      if (!workflow) return false;
      const space = await this.config.spaceManager.getSpace(task.spaceId);
      if (!space) return false;

      // Find the node whose declared agent slots include `agentName`.
      let targetNodeId: string | null = null;
      for (const node of workflow.nodes) {
        let slots: ReturnType<typeof resolveNodeAgents>;
        try {
          slots = resolveNodeAgents(node);
        } catch {
          continue;
        }
        if (slots.some((slot) => slot.name === agentName)) {
          if (options?.workflowNodeId && node.id !== options.workflowNodeId) continue;
          targetNodeId = node.id;
          break;
        }
      }
      if (!targetNodeId) return false;

      const channelRouter = new ChannelRouter({
        taskRepo: this.config.taskRepo,
        workflowRunRepo: this.config.workflowRunRepo,
        workflowManager: this.config.spaceWorkflowManager,
        agentManager: this.config.spaceAgentManager,
        nodeExecutionRepo: this.config.nodeExecutionRepo,
        channelCycleRepo: this.config.channelCycleRepo,
        isSessionAlive: (sid) => this.isSessionAlive(sid),
        cancelSessionById: (sid) => this.cancelBySessionId(sid),
        internalEventBus: this.config.internalEventBus,
      });

      await channelRouter.activateNode(run.id, targetNodeId, {
        allowTerminalReopen: true,
        reopenReason: options?.reopenReason ?? `lazy activation of agent "${agentName}"`,
        reopenBy: options?.reopenBy ?? 'task-agent',
        // Slot-targeted: ensure THIS agent's execution is created even when a
        // sibling slot in the same node is already active.
        targetAgentName: agentName,
      });
      return true;
    } catch (err) {
      log.warn(
        `TaskAgentManager.ensureWorkflowNodeActivationForAgent: ` +
          `failed for taskId=${taskId} agentName=${agentName}: ` +
          (err instanceof Error ? err.message : String(err))
      );
      return false;
    }
  }

  // -------------------------------------------------------------------------
  // Public — helpers / query methods
  // -------------------------------------------------------------------------

  /** Returns true if the given taskId is currently being spawned. */
  isSpawning(_taskId: string): boolean {
    return false;
  }

  /** Returns true if the given node execution is currently being spawned. */
  isExecutionSpawning(executionId: string): boolean {
    return this.spawningExecutionIds.has(executionId);
  }

  /** Returns true if a session ID maps to an alive in-memory agent session. */
  isSessionAlive(sessionId: string): boolean {
    const indexed = this.agentSessionIndex.get(sessionId);
    if (indexed) return this.isAgentSessionAlive(indexed);

    // Final check: if SessionManager still holds the live object, treat as alive.
    const session = this.config.sessionManager.getSession(sessionId);
    return session ? this.isAgentSessionAlive(session) : false;
  }

  /**
   * Like `isSessionAlive` but checks ONLY the in-memory index — it does NOT
   * lazy-load a persisted session via SessionManager.getSession(). Use this from
   * restart-time sweeps (e.g. recoverRateLimitedTasks): lazy-loading a persisted
   * session resets its `rate_limit_cooldown` processing state to `idle`
   * (processing-state-manager.restoreFromDatabase), which is then classified as
   * alive — so a post-restart dead cooldown session would be skipped forever.
   */
  isSessionInMemory(sessionId: string): boolean {
    const indexed = this.agentSessionIndex.get(sessionId);
    return !!indexed && this.isAgentSessionAlive(indexed);
  }

  /**
   * Post-approval dispatchability probe: like `isSessionAlive` but never
   * lazy-hydrates from SessionManager (in-memory index or synchronous cache
   * only — a session absent from memory is dead for dispatch purposes, e.g.
   * after a daemon restart). It deliberately excludes `'interrupted'` as
   * defensive hardening, but note that does NOT make it an interruption
   * detector: handleInterrupt ends with setIdle, so a normally-interrupted
   * session reads 'idle' and the probe reports it usable. The interruption
   * detection is `stopActiveWork`'s step 1.5 (it nulls the pointer of a
   * stop-interrupted merger); this probe only re-spawns a `postApprovalSessionId`
   * that survived into a session absent from memory (post-restart).
   */
  isSessionUsableForPostApproval(sessionId: string): boolean {
    const session =
      this.agentSessionIndex.get(sessionId) ??
      this.config.sessionManager.getCachedSession(sessionId);
    if (!session) return false;
    const status = session.getProcessingState().status;
    return (
      status === 'idle' ||
      status === 'queued' ||
      status === 'processing' ||
      status === 'waiting_for_input' ||
      status === 'rate_limit_cooldown'
    );
  }

  private isAgentSessionAlive(session: AgentSession): boolean {
    const state = session.getProcessingState();
    return (
      state.status === 'idle' ||
      state.status === 'queued' ||
      state.status === 'processing' ||
      state.status === 'waiting_for_input' ||
      state.status === 'interrupted' ||
      state.status === 'rate_limit_cooldown'
    );
  }

  /**
   * Returns the worktree path for a task, or undefined if no worktree was created.
   * Useful for test assertions and M6 artifact RPCs.
   *
   * Source of truth is the `space_worktrees` table (populated at worktree-creation
   * time and kept there for the full task lifetime). The in-memory map is a cache
   * populated on spawn/rehydrate; on cache miss we fall back to a sync DB read so
   * callers after a daemon restart or ad-hoc RPC access still get the right path
   * without needing a prior in-memory warm-up.
   */
  getTaskWorktreePath(taskId: string): string | undefined {
    const cached = this.taskWorktreePaths.get(taskId);
    if (cached) return cached;
    if (!this.config.worktreeManager) return undefined;
    const task = this.config.taskRepo.getTask(taskId);
    if (!task) return undefined;
    const stored = this.config.worktreeManager.getTaskWorktreePathSync(task.spaceId, task.id);
    if (stored) {
      // Warm the cache so subsequent reads hit the fast path.
      this.taskWorktreePaths.set(taskId, stored);
      return stored;
    }
    return undefined;
  }

  /** No-op — task-agent LLM sessions are no longer spawned. */
  getTaskAgent(_taskId: string): AgentSession | undefined {
    return undefined;
  }

  /** Returns a sub-session by its session ID, or undefined if not found. */
  getSubSession(subSessionId: string): AgentSession | undefined {
    for (const [, nodeMap] of this.subSessions) {
      const session = nodeMap.get(subSessionId);
      if (session) return session;
    }
    return undefined;
  }

  /**
   * Look up an AgentSession by its session ID across every in-memory map this
   * manager owns. Used by reapers (e.g. SpaceRuntime force-completion) that
   * have only the session ID and need to inspect/mutate the session before
   * reaping it (e.g. clear an orphaned AskUserQuestion card).
   *
   * Lookup order (mirrors `isSessionAlive`):
   *  1. `agentSessionIndex` (fast reverse index for sub-sessions)
   *  3. `SessionManager.getSession()` (general session cache)
   *
   * Step 3 may **lazy-hydrate** an AgentSession from the database if it's
   * not currently in any in-memory map — this is intentional, because:
   *
   *  - The hydrated `AgentSession` constructor calls
   *    `ProcessingStateManager.restoreFromDatabase()`, which preserves
   *    `waiting_for_input` state across daemon restarts (see
   *    `processing-state-manager.ts:62-65`). So `getProcessingState()`
   *    on a hydrated session returns the *persisted* status, not `idle`.
   *  - The Step 1.5 "spare waiting_for_input" guard relies on this
   *    lazy hydration: after a daemon restart, before any explicit
   *    rehydrate path runs, this lookup is what the runtime uses to
   *    detect that a session is still waiting on the user.
   *
   * Caveat: hydration *does* have side effects (event subscriptions,
   * orphaned-message recovery, cache insertion). In practice this is
   * fine because callers reach this method only after `isSessionAlive`
   * has already triggered the same lookup, so hydration happens at most
   * once per session per tick.
   *
   * Returns undefined when the session is not in memory and either does
   * not exist in the DB or fails to load.
   */
  getAgentSessionById(sessionId: string): AgentSession | undefined {
    const indexed = this.agentSessionIndex.get(sessionId);
    if (indexed) return indexed;

    // SessionManager.getSession may hydrate a fresh AgentSession from DB;
    // that's intentional — see method JSDoc for why. Normalize null → undefined
    // so the return contract stays uniform.
    return this.config.sessionManager.getSession(sessionId) ?? undefined;
  }

  getCachedAgentSessionById(sessionId: string): AgentSession | undefined {
    return this.agentSessionIndex.get(sessionId);
  }

  /**
   * Return every ACTIVE sub-session ID this manager tracks for any of the given
   * task IDs, drawn from `subSessions`.
   *
   * Cancellation paths use this to interrupt a coder/reviewer subprocess that
   * the per-row cancel loop cannot see — one whose `NodeExecution` row still
   * carries a null `agentSessionId` during the mid-activation window. Pass every
   * task ID belonging to the run because node agents are spawned against the
   * run's canonical task, which may differ from the task that triggered the
   * cancellation.
   *
   * Idle sessions are deliberately excluded: when a task is paused
   * (transitioned back to `open`), `stopActiveWorkflowTaskAgents` skips idle
   * executions and `handleSubSessionComplete` leaves their sessions in
   * `subSessions` so they can be reused by a later activation. Returning them
   * here would cancel the very sessions the row loop just chose to preserve.
   *
   * `interrupted` sessions are NOT excluded: a session interrupted by an
   * ordinary user interrupt is only transiently `interrupted` (handleInterrupt
   * returns it to idle without cleanup), so task cancellation must still reach
   * it via this sweep to tear it down — otherwise it stays registered and is
   * restartable by a later message injection. Dedup against a cancellation
   * already in flight is handled by the `cancellingSessions` Set in
   * `cancelBySessionId` (and handleInterrupt's idempotency makes a redundant
   * pass safe).
   */
  getLiveSubSessionIdsForTasks(taskIds: string[]): string[] {
    const ids = new Set<string>();
    for (const taskId of taskIds) {
      const nodeMap = this.subSessions.get(taskId);
      if (!nodeMap) continue;
      for (const [sid, session] of nodeMap) {
        if (session.getProcessingState().status === 'idle') continue;
        ids.add(sid);
      }
    }
    return [...ids];
  }

  /**
   * Prepare an existing node-agent sub-session for workflow resume/reopen.
   *
   * The caller has already verified the NodeExecution row is still bound to a
   * live session. Re-run the same runtime MCP attachment path used by self-heal
   * so a resumed workflow has node-agent available even if
   * the in-memory session was restored from DB without workflow MCP servers.
   */
  async prepareSubSessionForWorkflowResume(sessionId: string): Promise<boolean> {
    if (!this.isSessionAlive(sessionId)) return false;
    const session = this.getAgentSessionById(sessionId);
    if (!session) return false;
    await this.mcpSelfHeal(sessionId, ['node-agent']);
    return true;
  }

  /**
   * If a sub-session is sitting in a rate/usage-limit pause, break it out and
   * re-run the turn. Used by manual Resume (rate/usage-limited → in_progress
   * via recoverWorkflowBackedTask) so the task doesn't sit idle until the
   * watchdog timer fires at resetAt.
   *
   * Returns:
   *   - `'retried'`    — an armed cooldown (or startup-exhausted park) was
   *      broken out via `retryNow`; the session is still alive and re-running
   *      the turn. The caller should still prepare it for resume.
   *   - `'respawned'`  — the session was banner-cancelled (the cooldown banner's
   *      Cancel dropped the timer + cleared the episode but left the task
   *      rate-limited). `retryNow` can't re-fire there, and the in-memory
   *      session is skipped by the cross-restart sweep, so the consumed turn
   *      would be orphaned until a daemon restart. The execution is reset to
   *      `pending` with the stale session binding cleared so the workflow tick
   *      spawns a fresh replacement; the caller should NOT prepare the (now
   *      stopped) session.
   *   - `'noop'`       — the session is gone or was never rate-limited.
   */
  async resumeRateLimitedSubSession(sessionId: string): Promise<'retried' | 'respawned' | 'noop'> {
    const session = this.getAgentSessionById(sessionId);
    if (!session) return 'noop';
    // Don't gate on the volatile processing state: query-runner's unconditional
    // setIdle() in the failed-query finally overwrites rate_limit_cooldown to
    // idle, so an ordinary cooldown reaches here with an idle session even
    // though the watchdog's timer is still armed. retryNow self-gates on the
    // watchdog's pending / startup-exhausted state, so just attempt it and
    // report whether it actually fired.
    try {
      const fired = await session.retryNowAfterRateLimit();
      if (fired) return 'retried';
      // retryNow couldn't fire. If the session is banner-cancelled (the cooldown
      // banner's Cancel dropped the timer + cleared the episode but left the task
      // rate-limited and the consumed turn parked), re-spawn the execution so the
      // workflow runtime re-drives it. Without this, the visible Resume can't
      // restart the turn until a daemon restart. Gated on the banner-only signal
      // (NOT the raw pause flag, which is also true while an auto-retry is
      // actively starting) so a Resume during an in-flight retry is a no-op.
      if (!session.isRateLimitBannerCancelled()) return 'noop';
      await this.respawnRateLimitedExecution(sessionId);
      return 'respawned';
    } catch (err) {
      log.warn(
        `TaskAgentManager: failed to resume rate-limited sub-session ${sessionId}: ${err instanceof Error ? err.message : String(err)}`
      );
      return 'noop';
    }
  }

  /**
   * Re-spawn a banner-cancelled (idle, rate-limit-parked) sub-session's
   * execution so the workflow tick spawns a fresh replacement.
   *
   * Mirrors the dead-session reset path in `recoverRateLimitedTasks` (reset the
   * NodeExecution to `pending` + clear the stale `agentSessionId` so the spawn
   * path re-drives it), but the session here is alive-idle, so it is stopped +
   * evicted first — otherwise the spawn would resolve to the same parked
   * session id and re-mark it `in_progress` without re-driving the turn.
   */
  private async respawnRateLimitedExecution(sessionId: string): Promise<void> {
    const execution = this.config.nodeExecutionRepo.getByAgentSessionId(sessionId);
    if (execution) {
      this.config.nodeExecutionRepo.update(execution.id, {
        status: 'pending',
        agentSessionId: null,
        result: null,
        startedAt: null,
        completedAt: null,
      });
    } else {
      log.warn(
        `TaskAgentManager.respawnRateLimitedExecution: no NodeExecution bound to session ${sessionId}; resetting nothing.`
      );
    }
    // Stop + evict the orphaned idle session. Use the in-memory/cached lookup
    // (not the lazy-hydrating getAgentSessionById) so a missing session is a
    // clean no-op rather than a surprise hydration.
    const session =
      this.agentSessionIndex.get(sessionId) ??
      this.config.sessionManager.getCachedSession(sessionId);
    if (!session) return;
    try {
      await this.stopSessionPreserveDb(sessionId, session, { strict: true });
    } catch (err) {
      log.warn(
        `TaskAgentManager.respawnRateLimitedExecution: failed to stop session ${sessionId}: ${err instanceof Error ? err.message : String(err)}`
      );
    }
    this.agentSessionIndex.delete(sessionId);
    for (const [, nodeMap] of this.subSessions) {
      nodeMap.delete(sessionId);
    }
    try {
      await this.config.sessionManager.unregisterSession(sessionId);
    } catch (err) {
      log.warn(
        `TaskAgentManager.respawnRateLimitedExecution: failed to unregister session ${sessionId}: ${err instanceof Error ? err.message : String(err)}`
      );
    }
    // The abandoned session's entry in limitedSessionsByTask is cleared by the
    // `session.rate_limit_resume` event fired synchronously inside
    // `stopSessionPreserveDb` → `handleInterrupt` → `cancel(notifyResume=true)`
    // → `notifyResume` → InternalEventBus.publish — which runs the resume
    // listener (and its `findParentTaskIdForSubSession` + map delete) before
    // this point, while subSessions still holds the session. No explicit cleanup
    // needed here.
  }

  // -------------------------------------------------------------------------
  // Public — cleanup
  // -------------------------------------------------------------------------

  /**
   * Cancel a sub-session by its agent session ID.
   *
   * Used by SpaceRuntime to cancel sibling node agent sessions when the
   * workflow run completes via end-node short-circuit. Looks up the
   * session via the reverse index and interrupts it.
   *
   * No-op if the session is not found (already cleaned up or never registered).
   */
  cancelBySessionId(agentSessionId: string): void {
    // Resolve from the reverse index first (fast path), then the SessionManager
    // cache. Use getCachedSession (not getSession): the synchronous getSession()
    // -> SessionCache.get() THROWS when an async load is in flight for the
    // session (e.g. the UI opened the coder session while its task is being
    // cancelled); getCachedSession is the non-throwing accessor (has ? get : null).
    // The fallback is what actually stops a live coder that isn't in the reverse
    // index (post-restart, evicted, or activated via a path that registered only
    // with SessionManager) — without it, cancel flipped the DB status but the
    // in-flight turn kept streaming.
    const session =
      this.agentSessionIndex.get(agentSessionId) ??
      this.config.sessionManager.getCachedSession(agentSessionId);
    // Drop the reverse-index entry immediately so a concurrent cancelBySessionId
    // no-ops (the cancellingSessions Set + getCachedSession fallback still let a
    // retry reach the session if this teardown fails). The subSessions +
    // SessionManager-cache eviction is deferred until AFTER teardown succeeds
    // (stopSessionPreserveDb is called with { strict: true } below, so a failure
    // that PROPAGATES out of handleInterrupt/cleanup rejects and skips the
    // eviction .then). Caveat: InterruptHandler and QueryLifecycleManager.cleanup
    // swallow SDK interrupt/close and stop()-timeout failures internally, so for
    // the "SDK won't terminate" failure mode strict does NOT make this reject —
    // the eviction still runs. That residual is bounded by the process watchdog
    // (unregisterSession -> preserveRootPids tracks + reaps the leaked
    // subprocess, and the coder can't be restarted once evicted). Fully closing
    // it (propagate the lower-level failures / gate on a real process-exit
    // signal) is the process-reaper pass — broad blast radius beyond cancel.
    this.agentSessionIndex.delete(agentSessionId);
    if (!session) {
      // No live session to stop, but still invalidate any in-flight
      // SessionManager load (unregisterSession -> SessionCache.remove marks
      // removedWhileLoading so a concurrent getSessionAsync skips inserting).
      void this.config.sessionManager.unregisterSession?.(agentSessionId).catch(() => {});
      return;
    }
    // Deterministic idempotency: cancelWorkflowRun can invoke the stop path once
    // per task in the run, so the same session can reach this more than once.
    // This Set is checked/set synchronously before any await, so a concurrent
    // duplicate cancel no-ops instead of racing a second teardown.
    if (this.cancellingSessions.has(agentSessionId)) return;
    this.cancellingSessions.add(agentSessionId);
    // stopSessionPreserveDb runs handleInterrupt (clears the queue, fires
    // session.interrupted, transitions to idle) BEFORE cleanup — cleanup() alone
    // sets cleaningUp and skips that transition, which would leave a cancelled
    // session with persisted waiting_for_input state and an orphaned question
    // card restored on the next hydration.
    void this.stopSessionPreserveDb(agentSessionId, session, { strict: true })
      .then(() => {
        // Teardown succeeded: evict from the remaining lookup maps so a later
        // message can't find + restart the cleaned object, and drop the cache
        // entry (which also invalidates any in-flight load that landed during
        // the teardown). Task #85 invariant: cache/maps only — DB row, worktree,
        // and SDK `.jsonl` are preserved.
        for (const [, nodeMap] of this.subSessions) nodeMap.delete(agentSessionId);
        return this.config.sessionManager.unregisterSession?.(agentSessionId);
      })
      .catch((err) => {
        log.warn(
          `TaskAgentManager.cancelBySessionId: failed to stop session ${agentSessionId}:`,
          err
        );
      })
      .finally(() => {
        this.cancellingSessions.delete(agentSessionId);
      });
  }

  /**
   * Interrupt a sub-session by its agent session ID WITHOUT deleting it.
   *
   * Unlike `cancelBySessionId`, this preserves the session in memory and in
   * the DB, so it remains reachable via `send_message` / `injectSubSessionMessage`
   * while the parent task is still active.
   *
   * Use this when the workflow run completes (end node fires) but the task
   * is not yet `archived` — siblings should stop processing but remain
   * messageable in case a downstream node needs to follow up (e.g. a reviewer
   * sending feedback back to a coder whose node has already finished).
   *
   * No-op if the session is not found or is not in a state that can be interrupted.
   */
  async interruptBySessionId(agentSessionId: string): Promise<void> {
    const session = this.agentSessionIndex.get(agentSessionId);
    if (!session) return;
    try {
      // Called to quiesce in-progress siblings when an end node finishes — a
      // workflow-completion interrupt, not a user interrupt. Suppress the
      // deferred replay so an event deferred while the sibling was processing
      // isn't promoted into a new turn after the workflow has finished.
      await session.handleInterrupt({ skipDeferredReplay: true });
    } catch (err) {
      log.warn(
        `TaskAgentManager.interruptBySessionId: failed to interrupt session ${agentSessionId}:`,
        err
      );
    }
  }

  async restartStuckSubSession(agentSessionId: string): Promise<void> {
    const session = this.getAgentSessionById(agentSessionId);
    if (!session) {
      throw new Error(`Cannot restart stuck sub-session; session not found: ${agentSessionId}`);
    }
    await this.stopSessionPreserveDb(agentSessionId, session, { strict: true });
    this.agentSessionIndex.delete(agentSessionId);
    for (const [, nodeMap] of this.subSessions) {
      nodeMap.delete(agentSessionId);
    }
    await this.config.sessionManager.unregisterSession(agentSessionId);
  }

  // -------------------------------------------------------------------------
  // Public — rehydration
  // -------------------------------------------------------------------------

  /**
   * Rehydrate node-agent sub-sessions after a daemon restart.
   *
   * Queries `space_tasks` for tasks with status `in_progress`, `review`,
   * `blocked`, or `approved` that have a non-null `taskAgentSessionId`.
   * For each active task, clears the stale `taskAgentSessionId` (task-agent
   * LLM sessions are no longer spawned) and eagerly rehydrates workflow
   * sub-sessions via `rehydrateSubSessionsForRun`.
   *
   * This method is called from `SpaceRuntime.rehydrateExecutors()` after
   * WorkflowExecutors are loaded, so executors are ready when sub-sessions run.
   */
  async rehydrate(): Promise<void> {
    const activeTasks = this.config.taskRepo.listActive();

    let selfHealed = 0;
    const processedRunIds = new Set<string>();

    for (const task of activeTasks) {
      // Clear stale taskAgentSessionId (task-agent LLM sessions removed)
      if (task.taskAgentSessionId) {
        log.info(
          `TaskAgentManager.rehydrate: clearing legacy task_agent_session_id for task ${task.id}`
        );
        try {
          this.config.taskRepo.updateTask(task.id, { taskAgentSessionId: null });
          selfHealed++;
        } catch (err) {
          log.warn(
            `TaskAgentManager.rehydrate: failed to clear task_agent_session_id for task ${task.id}:`,
            err
          );
        }
      }

      // Rehydrate sub-sessions for this task's workflow run
      if (task.workflowRunId && !processedRunIds.has(task.workflowRunId)) {
        processedRunIds.add(task.workflowRunId);
        try {
          await this.rehydrateSubSessionsForRun(task.workflowRunId);
        } catch (err) {
          log.warn(
            `TaskAgentManager.rehydrate: failed to rehydrate sub-sessions for run ${task.workflowRunId}:`,
            err
          );
        }
      }
    }

    log.info(
      `TaskAgentManager.rehydrate: processed ${processedRunIds.size} run(s), selfHealed=${selfHealed}`
    );
  }

  /**
   * Stop all active Task Agent sessions and their sub-sessions for daemon shutdown.
   *
   * **Preserves DB state** so that `rehydrate()` can restore every task on the next
   * daemon start. Specifically:
   * - Does NOT delete the session DB row (would orphan `space_tasks.task_agent_session_id`
   *   and break the `spaceTaskActivity.byTask` LiveQuery that feeds the Task Agent /
   *   reviewer dropdown and canvas).
   * - Does NOT mark worktrees completed (the task is still in progress; marking it
   *   completed starts the 7-day TTL reaper clock).
   *
   * Steps per task:
   * 1. Interrupt and cleanup the in-memory AgentSession (stops SDK query & subprocesses).
   *    `stopSessionPreserveDb` also unsubscribes session.updated listeners and
   *    drops completion callbacks for each session ID.
   * 2. Close db-query MCP server file handles.
   * 3. Clear in-memory maps so a subsequent rehydrate starts from a clean slate.
   */
  async cleanupAll(): Promise<void> {
    clearAllRetryableHookActionTimers();
    if (this.taskArchiveListenerUnsub) {
      this.taskArchiveListenerUnsub();
      this.taskArchiveListenerUnsub = null;
    }
    for (const unsub of this.rateLimitListenerUnsubs) unsub();
    this.rateLimitListenerUnsubs = [];
    for (const unsub of this.activityListenerUnsubs) unsub();
    this.activityListenerUnsubs = [];
    const taskIds = Array.from(this.subSessions.keys());
    await Promise.allSettled(taskIds.map((taskId) => this.shutdownTask(taskId)));
    log.info(`TaskAgentManager: cleanupAll complete (${taskIds.length} tasks shut down)`);
  }

  /**
   * Stop all in-memory resources for a task without touching DB state.
   * Used by shutdown only — for task completion / cancellation use `cleanup()`.
   */
  private async shutdownTask(taskId: string): Promise<void> {
    // 1. Stop sub-sessions (interrupt + cleanup, no DB delete).
    // stopSessionPreserveDb unsubscribes listeners and drops completion
    // callbacks for each session ID as part of its teardown.
    // preserveDeliveryJobs: shutdown requeues in-flight message_delivery rows
    // for the next boot (app.ts) BEFORE this runs — cancelling them here would
    // delete the durable handoff we just preserved. The query still aborts so
    // cleanup doesn't block; only the durable-job cancel is skipped.
    const nodeMap = this.subSessions.get(taskId);
    if (nodeMap) {
      for (const [subSessionId, session] of nodeMap) {
        await this.stopSessionPreserveDb(subSessionId, session, {
          preserveDeliveryJobs: true,
        });
        this.agentSessionIndex.delete(subSessionId);
      }
      this.subSessions.delete(taskId);
    }

    // 3. Drop the in-memory worktree path (DB record is preserved)
    this.taskWorktreePaths.delete(taskId);

    // Drop the eager sub-session index (DB NodeExecution rows are preserved).
    this.eagerSubSessionIds.delete(taskId);

    // 4. Close db-query server to release SQLite handles held by the session
    const dbQueryServer = this.taskDbQueryServers.get(taskId);
    if (dbQueryServer) {
      try {
        dbQueryServer.close();
      } catch (err) {
        log.warn(`TaskAgentManager: failed to close db-query server for task ${taskId}:`, err);
      }
      this.taskDbQueryServers.delete(taskId);
    }

    log.info(`TaskAgentManager: shutdown complete for task ${taskId} (DB state preserved)`);
  }

  /**
   * Stop all in-memory resources for a task **without deleting any persisted state**.
   *
   * Task #85 invariant: the only code paths allowed to remove a session's
   * worktree, SDK `.jsonl` files, or DB row are the two UI RPC handlers
   * (`session.archive`/`task.archive` and `session.delete`/`room.delete`).
   * Every other lifecycle event — task done, task cancelled, workflow end,
   * daemon shutdown, spawn rollback — must preserve persisted state and
   * only interrupt the in-memory SDK subprocess so the user keeps their
   * conversation history, worktree checkout, and session metadata.
   *
   * This method:
   *   - Interrupts and cleans up every in-memory AgentSession for the task.
   *   - Drops completion callbacks and session listeners.
   *   - Clears in-memory maps (`subSessions`,
   *     `taskWorktreePaths`, `taskDbQueryServers`, `agentSessionIndex`).
   *   - Closes any db-query MCP server file handles.
   *
   * It does NOT delete any DB row, remove any worktree, or archive any
   * SDK files. Marking the worktree `completed` also belongs to archive
   * (which moves the worktree entirely) — so neither
   * `removeTaskWorktree` nor `markTaskWorktreeCompleted` is called here.
   *
   * @param taskId - The task to clean up.
   * @param reason - Retained for logging only; behavior is identical for
   *                'done', 'cancelled', and 'stopped' (space stop quiesce).
   */
  async cleanup(
    taskId: string,
    reason: 'done' | 'cancelled' | 'stopped' = 'done'
  ): Promise<Set<string>> {
    const sessionIdsToClean = new Set<string>();

    // 1. Stop sub-sessions (interrupt + cleanup, preserve DB).
    const nodeMap = this.subSessions.get(taskId);
    if (nodeMap) {
      for (const [subSessionId, session] of nodeMap) {
        sessionIdsToClean.add(subSessionId);
        await this.stopSessionPreserveDb(subSessionId, session);
      }
      this.subSessions.delete(taskId);
      for (const sid of sessionIdsToClean) {
        this.agentSessionIndex.delete(sid);
      }
    }

    // 3. stopSessionPreserveDb already removed per-session listeners and
    // completion callbacks, but run the cleanup defensively in case any
    // stragglers slipped in through a different registration path.
    for (const sessionId of sessionIdsToClean) {
      this.completionCallbacks.delete(sessionId);
      const unsub = this.sessionListeners.get(sessionId);
      if (unsub) {
        unsub();
        this.sessionListeners.delete(sessionId);
      }
    }

    // 4. Drop the in-memory worktree path. The on-disk worktree is
    // preserved — archive is the only path that removes it.
    this.taskWorktreePaths.delete(taskId);

    // 5. Drop the eager sub-session index.
    this.eagerSubSessionIds.delete(taskId);

    // 6. Close db-query server connection for this task.
    const dbQueryServer = this.taskDbQueryServers.get(taskId);
    if (dbQueryServer) {
      try {
        dbQueryServer.close();
      } catch (err) {
        log.warn(`TaskAgentManager: failed to close db-query server for task ${taskId}:`, err);
      }
      this.taskDbQueryServers.delete(taskId);
    }

    log.info(
      `TaskAgentManager: cleaned up in-memory state for task ${taskId} (reason: ${reason}, DB + worktree preserved)`
    );
    return sessionIdsToClean;
  }

  // -------------------------------------------------------------------------
  // Private — completion callbacks
  // -------------------------------------------------------------------------

  /**
   * Register a completion callback for a sub-session.
   * Subscribes to InternalEventBus<DaemonInternalEventMap> session.updated events for the session.
   * The callback is called at most once when the session first goes idle.
   * Also subscribes to session.error to mark the group member as 'failed'.
   */
  registerCompletionCallback(subSessionId: string, callback: () => Promise<void>): void {
    // Add to callback list
    if (!this.completionCallbacks.has(subSessionId)) {
      this.completionCallbacks.set(subSessionId, []);
    }
    this.completionCallbacks.get(subSessionId)!.push(callback);

    // Only subscribe once per session
    if (this.sessionListeners.has(subSessionId)) return;

    // Track whether we've fired (to make callback fire exactly once)
    let fired = false;

    const unsubscribeUpdated = this.config.internalEventBus.subscribe(
      'session.updated',
      (event) => {
        if (fired) return;
        if (!event.processingState) return;
        const status = event.processingState.status;

        // Fire when session reaches idle — meaning it has completed its work
        if (status === 'idle') {
          const session = this.getSubSession(subSessionId);
          if (!session) return;

          // Only fire if the session has actually done some processing
          const sdkCount = session.getSDKMessageCount();
          if (sdkCount === 0) return; // Not started yet

          fired = true;
          // Unsubscribe immediately to prevent double-firing
          const unsub = this.sessionListeners.get(subSessionId);
          if (unsub) {
            unsub();
            this.sessionListeners.delete(subSessionId);
          }

          // Fire all registered callbacks
          const callbacks = this.completionCallbacks.get(subSessionId) ?? [];
          this.completionCallbacks.delete(subSessionId);
          for (const cb of callbacks) {
            cb().catch((err) => {
              log.error(
                `TaskAgentManager: completion callback error for session ${subSessionId}:`,
                err
              );
            });
          }
        }
      },
      { sessionId: subSessionId, subscriberName: 'TaskAgentManager.subSessionCompletion' }
    );

    // Subscribe to session.error to mark the session as fired so that a subsequent idle
    // transition does not overwrite the error state.
    // Also self-unsubscribes both listeners to prevent multiple invocations.
    const unsubscribeError = this.config.internalEventBus.subscribe(
      'session.error',
      (event) => {
        if (fired) return; // Already handled by completion path
        fired = true;

        // Push an explicit failure event back to the Task Agent so orchestration
        // stays event-driven (no polling loop required to discover crashes).
        void this.handleSubSessionError(subSessionId, event.error).catch((err) => {
          log.warn(
            `TaskAgentManager: failed to handle sub-session error for ${subSessionId}:`,
            err
          );
        });

        // Tear down both listeners now that the error terminal state is handled.
        const unsub = this.sessionListeners.get(subSessionId);
        if (unsub) {
          unsub();
          this.sessionListeners.delete(subSessionId);
        }
      },
      { sessionId: subSessionId, subscriberName: 'TaskAgentManager.subSessionError' }
    );

    // Store a combined unsubscribe that tears down both listeners at once.
    this.sessionListeners.set(subSessionId, () => {
      unsubscribeUpdated();
      unsubscribeError();
    });
  }

  /**
   * Called when a node agent sub-session completes (session goes idle).
   *
   * Automatically transitions the execution to `idle` when the agent's session
   * finishes naturally — completion is signaled by `task.reportedStatus`.
   * Normal completion is runtime-owned and does not notify the Task Agent.
   */
  private async handleSubSessionComplete(
    taskId: string,
    nodeId: string,
    subSessionId: string
  ): Promise<void> {
    log.info(
      `TaskAgentManager: sub-session complete — task ${taskId}, node ${nodeId}, session ${subSessionId}`
    );

    const workflowRunId = this.getWorkflowRunId(taskId);
    let execution = workflowRunId
      ? this.config.nodeExecutionRepo
          .listByWorkflowRun(workflowRunId)
          .find((candidate) => candidate.agentSessionId === subSessionId)
      : null;

    // Auto-transition to idle when the session finishes while still in_progress.
    // This is the normal completion path — agents don't need to call a separate tool.
    if (execution && execution.status === 'in_progress') {
      this.config.nodeExecutionRepo.update(execution.id, { status: 'idle' });
      execution = this.config.nodeExecutionRepo.getById(execution.id);
    }
  }

  /**
   * Handle a sub-session error event and notify the parent Task Agent.
   *
   * This enables event-driven orchestration: Task Agent can react to failures
   * without polling node status.
   *
   * Task-status cascade: marking the execution `blocked` here is picked up on
   * the next runtime tick by `space-runtime.ts`'s blocked-execution detection,
   * which transitions the canonical task to `status='blocked'` with
   * `blockReason='execution_failed'`. End-node failures are surfaced the same
   * way — there's no separate end-node-specific handler because any blocked
   * execution that can't be auto-recovered (`attemptBlockedRunRecovery`)
   * leaves the workflow stuck and needs human/agent intervention.
   */
  private async handleSubSessionError(subSessionId: string, error: string): Promise<void> {
    const parentTaskId = this.findParentTaskIdForSubSession(subSessionId);
    if (!parentTaskId) return;

    const workflowRunId = this.getWorkflowRunId(parentTaskId);
    const failedExecution = workflowRunId
      ? this.config.nodeExecutionRepo
          .listByWorkflowRun(workflowRunId)
          .find((candidate) => candidate.agentSessionId === subSessionId)
      : null;
    if (failedExecution && !TERMINAL_NODE_EXECUTION_STATUSES.has(failedExecution.status)) {
      this.config.nodeExecutionRepo.update(failedExecution.id, {
        status: 'blocked',
        result: error,
      });
    }

    const failedNodeId = failedExecution?.workflowNodeId ?? 'unknown-node';
    log.warn(
      `TaskAgentManager: node "${failedNodeId}" sub-session (${subSessionId}) failed: ${error}. ` +
        `Execution marked blocked; runtime tick will handle escalation.`
    );
  }

  /**
   * Build a runtime contract for a specific node execution from the current
   * workflow graph, including gate requirements derived from outbound channels.
   *
   * The `space` argument is used to determine whether `approve_task` is
   * currently unlocked by the space's autonomy level. When unlocked, the
   * prompt tells the agent it can self-close; otherwise the prompt tells the
   * agent that `submit_for_approval` is the only way to finalize. This keeps
   * the system prompt aligned with what the MCP handler actually enforces at
   * call time.
   */
  private buildNodeExecutionRuntimeContract(
    workflow: SpaceWorkflow | null,
    execution: NodeExecution,
    space: Space | null
  ): string {
    const isEndNode = this.isTerminalNode(workflow, execution.workflowNodeId);

    // Compute whether approve_task is currently unlocked for this space.
    // The MCP handler re-checks at call time, so this is purely for prompt
    // accuracy — the tool is registered unconditionally on end-node sessions.
    const spaceLevel = space?.autonomyLevel ?? 1;
    const requiredLevel = workflow?.completionAutonomyLevel ?? 5;
    const approveUnlocked = spaceLevel >= requiredLevel;

    // End-node tool contract:
    //   - save_artifact: persist typed data to artifact store (all node agents).
    //   - approve_task : self-close (autonomy-gated, end-node only).
    //   - submit_for_approval: human sign-off (always available, end-node only).
    // Keep these strings in sync with `node-agent-tools.ts` and
    // `task-agent-manager.ts` where the handlers live.
    const endNodeContractLines = (indent: string): string[] => {
      if (!isEndNode) return [];
      const lines: string[] = [];
      if (approveUnlocked) {
        lines.push(
          `${indent}- approve_task({}) — Close this task as done (self-approval). Unlocked for this space (autonomy ${spaceLevel} >= required ${requiredLevel}). Use as your FINAL action when you are satisfied the work is complete.`
        );
      } else {
        lines.push(
          `${indent}- approve_task({}) — NOT AVAILABLE: space autonomy ${spaceLevel} < workflow completionAutonomyLevel ${requiredLevel}. Do NOT call this tool; use submit_for_approval instead.`
        );
      }
      lines.push(
        `${indent}- submit_for_approval({ reason? }) — Request human sign-off. Always available to end-node agents. Use when autonomy blocks self-close OR the outcome is risky enough to escalate.`
      );
      return lines;
    };

    const fallback = [
      '## Runtime Execution Contract',
      `Role: "${execution.agentName}"`,
      'Tools available:',
      '  - send_message({ target, message, data? }) — communicate with peers; `data` is passed through to the target agent',
      '  - save_artifact({ shape, kind?, key?, summary?, data? }) — persist a STRUCTURED FACT as a generic shape (link/commit_set/check/metric/decision/note) with a freeform `kind` hint. Use shape="note" for rolling status, shape="decision" for verdicts/outcomes. Do not re-narrate the chat thread into artifacts.',
      ...endNodeContractLines('  '),
      '  - list_artifacts({ nodeId?, type? }) — list artifacts for the current workflow run',
      '  - restore_node_agent({ reason? }) — self-heal fallback: if a previous mcp__node-agent__* call returned "No such tool available", call this once and then retry the original tool',
      `Escalation: send_message({ target: "${WORKFLOW_ESCALATION_TARGET}", message }) requests human/space-level judgment (use for misrouted no-code tasks or hard blockers).`,
      'Only contact the task-agent via send_message if you are blocked or need human input.',
    ].join('\n');

    if (!workflow) {
      return fallback;
    }

    const node = workflow.nodes.find((candidate) => candidate.id === execution.workflowNodeId);
    if (!node) {
      return fallback;
    }

    const lines: string[] = [
      '## Runtime Execution Contract',
      `Node: "${node.name}" (${node.id})`,
      `Agent: "${execution.agentName}"`,
      'Tools available:',
      '  - send_message({ target, message, data? }) — communicate with peers; `data` is passed through to the target agent',
      '  - save_artifact({ shape, kind?, key?, summary?, data? }) — persist a STRUCTURED FACT as a generic shape (link/commit_set/check/metric/decision/note) with a freeform `kind` hint. Use shape="note" for rolling status, shape="decision" for verdicts/outcomes.',
      '  - list_artifacts ({ nodeId?, type? }) — list artifacts for the current workflow run',
      '  - list_peers / list_reachable_agents — discovery',
      '  - restore_node_agent({ reason? }) — self-heal fallback: if a previous mcp__node-agent__* call ever returned "No such tool available", call this once and then retry the original tool',
    ];

    lines.push(
      `Escalation: send_message({ target: "${WORKFLOW_ESCALATION_TARGET}", message }) requests human/space-level judgment (use for misrouted no-code tasks or hard blockers).`
    );
    lines.push(
      'Only contact the task-agent via send_message if you are blocked or need human input.'
    );
    if (isEndNode) {
      if (approveUnlocked) {
        lines.push(
          'When your work is complete: (1) call save_artifact({ shape: "decision", key: "outcome", summary: "...", data: { recommendation: "completed" } }) to record the outcome, then (2) call approve_task({}) as your FINAL action to close the task. The runtime — not your artifact — decides the terminal status via completion actions.'
        );
      } else {
        lines.push(
          'When your work is complete: (1) call save_artifact({ shape: "decision", key: "outcome", summary: "...", data: { recommendation: "completed" } }) to record the outcome, then (2) call submit_for_approval({ reason: "..." }) as your FINAL action. approve_task is NOT available at this autonomy level; only a human can finalize.'
        );
      }
    }
    return lines.join('\n');
  }

  private agentNameVariants(value: string): string[] {
    const trimmed = value.trim();
    if (!trimmed) return [];
    const variants = new Set<string>([trimmed]);
    const kebab = trimmed
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '');
    if (kebab) variants.add(kebab);
    return [...variants];
  }

  private isTerminalNode(
    workflow: SpaceWorkflow | null | undefined,
    workflowNodeId: string
  ): boolean {
    return isWorkflowTerminalNode(workflow, workflowNodeId);
  }

  private workflowNodeNameForRun(workflowRunId: string, workflowNodeId: string): string | null {
    const run = this.config.workflowRunRepo.getRun(workflowRunId);
    if (!run?.workflowId) return null;
    const workflow = this.config.spaceWorkflowManager.getWorkflowForRun(run);
    return workflow?.nodes.find((node) => node.id === workflowNodeId)?.name ?? null;
  }

  /**
   * Resolve whether the workflow agent slot backing `sessionId` has
   * `resetContextPerTurn` enabled. Pure data lookup driven entirely by the
   * workflow definition — no role-name handling. Returns false for non-workflow
   * sessions, missing executions, or unresolvable slots.
   */
  private slotResetsContextForSession(sessionId: string): boolean {
    const execution = this.config.nodeExecutionRepo.getByAgentSessionId(sessionId);
    if (!execution?.workflowRunId || !execution.workflowNodeId) return false;
    const run = this.config.workflowRunRepo.getRun(execution.workflowRunId);
    if (!run?.workflowId) return false;
    const workflow = this.config.spaceWorkflowManager.getWorkflowForRun(run);
    const node = workflow?.nodes.find((candidate) => candidate.id === execution.workflowNodeId);
    if (!node) return false;
    // resolveNodeAgents throws on a node with an empty agents array (e.g. a
    // corrupted or mid-flight-edited definition). This sits on the message
    // delivery path, so a throw would drop the handoff. Treat an unresolvable
    // node as "no clear" and let delivery proceed — matches the guard in
    // node-agent-tools.ts.
    let slots: WorkflowNodeAgent[];
    try {
      slots = resolveNodeAgents(node);
    } catch {
      return false;
    }
    const slot =
      slots.length === 1
        ? slots[0]
        : slots.find((candidate) => candidate.name === execution.agentName);
    return slot?.resetContextPerTurn === true;
  }

  private buildAgentNameAliasesForExecution(
    workflow: SpaceWorkflow | null,
    execution: NodeExecution
  ): string[] {
    const aliases = new Set<string>(this.agentNameVariants(execution.agentName));
    if (!workflow) return [...aliases];

    const node = workflow.nodes.find((candidate) => candidate.id === execution.workflowNodeId);
    if (!node) return [...aliases];

    if (node.name) {
      for (const variant of this.agentNameVariants(node.name)) {
        aliases.add(variant);
      }
    }

    const nodeAgents = resolveNodeAgents(node);
    const slot =
      nodeAgents.find((agent) => agent.name === execution.agentName) ??
      (execution.agentId
        ? nodeAgents.find((agent) => agent.agentId === execution.agentId)
        : undefined);
    if (slot?.name) {
      for (const variant of this.agentNameVariants(slot.name)) {
        aliases.add(variant);
      }
    }

    const spaceAgentId = execution.agentId ?? slot?.agentId;
    if (spaceAgentId) {
      const spaceAgent = this.config.spaceAgentManager.getById(spaceAgentId);
      if (spaceAgent?.name) {
        for (const variant of this.agentNameVariants(spaceAgent.name)) {
          aliases.add(variant);
        }
      }
    }

    return [...aliases];
  }

  // -------------------------------------------------------------------------
  // Private — session creation helpers
  // -------------------------------------------------------------------------

  /**
   * Resolve a session ID that does not already exist in the DB.
   * If the base ID exists (e.g., from a previous crashed attempt), appends a
   * monotonic suffix until an unused ID is found.
   */
  private resolveSessionId(baseId: string): string {
    // Check if base ID is already free
    if (!this.config.db.getSession(baseId)) {
      return baseId;
    }

    // Append monotonic suffix starting from 1; cap at 100 to avoid an
    // unbounded loop if the DB is in an unexpected state.
    const MAX_ATTEMPTS = 100;
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      const candidateId = `${baseId}:${attempt}`;
      if (!this.config.db.getSession(candidateId)) {
        return candidateId;
      }
    }
    throw new Error(
      `Could not find available session ID for base "${baseId}" after ${MAX_ATTEMPTS} attempts`
    );
  }

  /**
   * Eagerly rehydrate every workflow sub-session attached to a workflow run,
   * so the in-process `node-agent` MCP server is
   * re-attached to each sub-session before any external consumer
   * (UI overlay, peer message, gate write) reaches them.
   *
   * Iterates `node_executions` for the run, finds rows that already have an
   * `agentSessionId` assigned (i.e. a sub-session was spawned before the
   * daemon restart) AND whose execution status indicates the agent is still
   * active (`'in_progress'` or `'blocked'`), and calls `rehydrateSubSession`
   * for each that is not yet in the in-memory `agentSessionIndex`.
   * `rehydrateSubSession` is idempotent w.r.t. the maps (see its comments) —
   * calling it for an entry that is somehow already in memory would re-restore
   * from DB, which is wasteful but not harmful; the explicit
   * `agentSessionIndex` guard avoids that wasted work.
   *
   * Status filter rationale (`NodeExecutionStatus` is
   * `'pending' | 'in_progress' | 'idle' | 'blocked' | 'cancelled'`):
   * - `'in_progress'` — agent actively working; must come back.
   * - `'blocked'` — agent sitting at a gate awaiting input; must come back.
   *   This is the original Task #126 scenario.
   * - `'pending'` — declared but never spawned, so `agentSessionId` is null
   *   and the row is already filtered by the `if (!subSessionId)` guard
   *   above. Listed here for completeness.
   * - `'idle'` — the agent finished its turn; `handleSubSessionComplete`
   *   already auto-transitioned the execution and fired the completion
   *   callback. Restoring would attach MCP servers, register a new
   *   completion callback, and restart the streaming query for an agent
   *   that has no remaining work — pure overhead.
   * - `'cancelled'` — the execution was explicitly stopped; same reasoning
   *   as `'idle'`.
   *
   * Failures are isolated per sub-session and logged at warn level — one
   * broken sub-session must not block rehydration of its siblings.
   *
   * No-op when the run's space is STOPPED (see the guard below — paused
   * spaces still rehydrate) or when `workflowRunId` is null (standalone task
   * with no workflow).
   */
  private async rehydrateSubSessionsForRun(workflowRunId: string | null): Promise<void> {
    if (!workflowRunId) return;

    // Defense-in-depth for `space.stop` landing mid-spawn: a STOPPED space
    // must not restore its sub-sessions on daemon restart. stopActiveWork
    // parks in-flight executions (pending + null session), but a stop that
    // raced a spawn can still leave an in_progress row with a session id
    // behind — restoring it would wake work the user explicitly stopped.
    // Deliberately stopped-only: paused spaces keep their live sessions by
    // design, and gating paused too would break pause + daemon restart +
    // resume (sessions would not be restored, then the first active tick
    // would burn crash retries re-spawning them). The space ROW is read — not
    // the runtime's pausedSpaceIds cache — because that cache conflates
    // paused with stopped; only the row distinguishes them.
    try {
      const run = this.config.workflowRunRepo.getRun(workflowRunId);
      const spaceId = run?.spaceId;
      if (spaceId) {
        const space = await this.config.spaceManager.getSpace(spaceId);
        if (space?.stopped) {
          log.info(
            `TaskAgentManager.rehydrateSubSessionsForRun: skipping run ${workflowRunId} — space ${spaceId} is stopped`
          );
          return;
        }
      }
    } catch (err) {
      // A failed space lookup must not block rehydration of the run's other
      // sessions — log and fall through to the normal path.
      log.warn(
        `TaskAgentManager.rehydrateSubSessionsForRun: failed to check stopped state for run ${workflowRunId}: ${err instanceof Error ? err.message : String(err)}`
      );
    }

    const executions = this.config.nodeExecutionRepo.listByWorkflowRun(workflowRunId);
    for (const execution of executions) {
      // agentSessionId is normally stable once assigned during spawn, but it
      // IS deliberately cleared by the clean-recovery resets — every caller
      // of NodeExecutionRepository.resetForCleanRecovery (space-stop parking,
      // passed rate caps, transient spawn aborts; see that helper's doc) —
      // which blank it so the spawn path re-drives the execution without
      // crash accounting. Pending executions that were never spawned — or
      // that were parked — have a null agentSessionId, which this guard
      // correctly skips.
      const subSessionId = execution.agentSessionId;
      if (!subSessionId) continue;

      // Only rehydrate active executions. `idle` / `cancelled` agents have
      // already finished their turn (or been explicitly stopped) and will
      // not receive any new messages — restoring them would attach MCP
      // servers, register a new completion callback, and restart the
      // streaming query for nothing. A queued retryable hook action is the
      // exception: it needs the source session's MCP surface restored so the
      // persisted handoff can replay after daemon restart.
      if (execution.status !== 'in_progress' && execution.status !== 'blocked') {
        if (!this.hasQueuedRetryableHookAction(workflowRunId, execution)) continue;
      }

      // Skip if already in memory (e.g. lazily rehydrated by an earlier
      // inbound message during this same restart, or never torn down).
      if (this.agentSessionIndex.has(subSessionId)) continue;

      try {
        await this.rehydrateSubSession(subSessionId);
      } catch (err) {
        log.warn(
          `TaskAgentManager.rehydrateSubSessionsForRun: failed to rehydrate sub-session ${subSessionId} ` +
            `(run=${workflowRunId}, exec=${execution.id}, agent=${execution.agentName}): ${err instanceof Error ? err.message : String(err)}`
        );
      }
    }
  }

  private hasQueuedRetryableHookAction(workflowRunId: string, execution: NodeExecution): boolean {
    const task = this.config.taskRepo.listByWorkflowRun(workflowRunId)[0];
    if (!task || task.status === 'done' || task.status === 'cancelled') return false;
    const run = this.config.workflowRunRepo.getRun(workflowRunId);
    if (!run || run.status === 'done' || run.status === 'cancelled') return false;
    const workflow = this.config.spaceWorkflowManager.getWorkflowForRun(run);
    const hookStateRepo = new WorkflowHookStateRepository(this.config.db.getDatabase());
    for (const hook of workflow?.hooks ?? []) {
      const state = hookStateRepo.get(workflowRunId, hook.id)?.localState;
      const queued = state?.[QUEUED_RETRYABLE_ACTION_STATE_KEY];
      if (!queued || typeof queued !== 'object') continue;
      const meta = (queued as Record<string, unknown>).meta;
      if (!meta || typeof meta !== 'object') continue;
      const record = meta as Record<string, unknown>;
      if (
        record.sessionId === execution.agentSessionId &&
        record.agentName === execution.agentName &&
        record.nodeId === execution.workflowNodeId
      ) {
        return true;
      }
    }
    return false;
  }

  /**
   * Lazily rehydrate a node-agent sub-session from DB when a message arrives for
   * a session that is no longer in the in-memory maps (e.g., after a daemon restart).
   *
   * Steps:
   * 1. Look up the NodeExecution by agentSessionId.
   * 2. Find the parent SpaceTask via the execution's workflowRunId.
   * 3. Load Space, WorkflowRun, and Workflow from DB.
   * 4. Restore the AgentSession from DB via AgentSession.restore().
   * 5. Re-inject the node-agent MCP server (runtime-only, not persisted).
   * 6. Register the session in in-memory maps and SessionManager.
   * 7. Register a completion callback so handleSubSessionComplete fires normally.
   * 8. Restart the streaming query (idempotent if already running).
   *
   * Returns the rehydrated AgentSession, or null if the session cannot be found
   * in the DB or its parent context is missing.
   */
  private sanitizeSDKSessionTranscriptForRehydration(
    agentSession: AgentSession,
    workspacePath: string
  ): void {
    const session = agentSession.getSessionData();
    if (!session.sdkSessionId) return;

    const result = sanitizeAssistantUsageInSDKSessionFile(workspacePath, session.sdkSessionId);
    if (!result.success) {
      log.warn(
        `TaskAgentManager.rehydrate: failed to sanitize SDK transcript for session ${session.id} ` +
          `(sdkSessionId=${session.sdkSessionId}): ${result.errors.join('; ')}`
      );
      return;
    }
    if (result.sanitizedCount > 0) {
      log.info(
        `TaskAgentManager.rehydrate: sanitized ${result.sanitizedCount} assistant message(s) ` +
          `in SDK transcript for session ${session.id}`
      );
    }
  }

  private async rehydrateSubSession(subSessionId: string): Promise<AgentSession | null> {
    log.warn(`TaskAgentManager: rehydrating ghost sub-session ${subSessionId} from DB...`);

    // --- Look up the NodeExecution by agentSessionId, falling back to the
    // execution id embedded in deterministic workflow sub-session ids.
    const execution = this.resolveNodeExecutionForSubSession(subSessionId);
    if (!execution) {
      log.warn(
        `TaskAgentManager.rehydrateSubSession: no NodeExecution found with agentSessionId=${subSessionId}`
      );
      return null;
    }

    // --- Find the parent SpaceTask via workflowRunId
    const tasks = this.config.taskRepo.listByWorkflowRunIncludingArchived(execution.workflowRunId);
    // The parent task is the primary task for this workflow run (oldest by created_at).
    const parentTask = tasks[0] ?? null;
    if (!parentTask) {
      log.warn(
        `TaskAgentManager.rehydrateSubSession: no parent task found for workflowRunId=${execution.workflowRunId}`
      );
      return null;
    }

    const taskId = parentTask.id;
    const spaceId = parentTask.spaceId;

    // Don't rehydrate (and restart) a session whose task is cancelled or
    // archived — cancellation already tore it down + evicted it, and an archived
    // task's resources are gone, so rehydrating would restart a stopped coder
    // (the inject-after-cancel vector) via startStreamingQuery. A `done` task is
    // NOT rejected here: the completion flow deliberately preserves idle sessions
    // for post-completion cross-node messaging (e.g. reviewer → completed coder)
    // until archival. The queued-retryable-hook replay path is unaffected:
    // hasQueuedRetryableHookAction returns false for cancelled tasks.
    if (parentTask.status === 'cancelled' || parentTask.status === 'archived') {
      log.warn(
        `TaskAgentManager.rehydrateSubSession: refusing to rehydrate session ${subSessionId} — parent task ${taskId} is ${parentTask.status}`
      );
      return null;
    }

    // --- Load Space
    const space = await this.config.spaceManager.getSpace(spaceId);
    if (!space) {
      log.warn(
        `TaskAgentManager.rehydrateSubSession: space ${spaceId} not found for task ${taskId}`
      );
      return null;
    }

    // --- Load WorkflowRun and Workflow
    const workflowRun = this.config.workflowRunRepo.getRun(execution.workflowRunId);
    // Also reject when the WORKFLOW RUN is cancelled — a noncanonical-task
    // cancel transitions the whole run to `cancelled` while the oldest task
    // (parentTask above) can still read `in_progress`, so the task-only check
    // would pass. Only `cancelled` is rejected, NOT `done`: a completed run's
    // sessions are deliberately preserved for post-completion cross-node
    // messaging until archival. Safe vs the queued-hook replay:
    // hasQueuedRetryableHookAction returns false for cancelled runs.
    if (workflowRun?.status === 'cancelled') {
      log.warn(
        `TaskAgentManager.rehydrateSubSession: refusing to rehydrate session ${subSessionId} — run ${execution.workflowRunId} is cancelled`
      );
      return null;
    }
    const workflow = workflowRun?.workflowId
      ? this.config.spaceWorkflowManager.getWorkflowForRun(workflowRun)
      : null;
    const workflowRunId = execution.workflowRunId;

    // --- Restore the AgentSession from DB
    const agentSession = AgentSession.restore(
      subSessionId,
      this.config.db,
      this.config.messageHub,
      this.config.internalEventBus,
      this.config.getApiKey,
      this.config.skillsManager,
      this.config.appMcpServerRepo,
      { autoReplayPendingMessages: false }
    );
    if (!agentSession) {
      log.warn(
        `TaskAgentManager.rehydrateSubSession: AgentSession.restore() returned null for ${subSessionId} — session not in DB`
      );
      return null;
    }

    // --- Determine workspace path
    const workspacePath = this.taskWorktreePaths.get(taskId) ?? space.workspacePath;

    // --- Resolve the current workflow-slot prompt before restarting the SDK.
    // AgentSession.restore() intentionally keeps persisted DB config as-is; without
    // re-applying the current workflow/agent prompt here, a node agent that already
    // existed before a daemon restart would resume with stale instructions. This
    // shows up most visibly for Reviewer agents after built-in workflow prompt
    // updates: the spawn path uses the new slot prompt, while the rehydrate path
    // used to keep the old persisted prompt until the session was recreated.
    const currentInit = this.resolveCurrentNodeAgentInitForExecution({
      task: parentTask,
      space,
      workflow,
      workflowRun,
      execution,
      sessionId: subSessionId,
      workspacePath,
    });
    if (currentInit?.systemPrompt) {
      agentSession.setRuntimeSystemPrompt(currentInit.systemPrompt);
    }

    // --- Re-build and attach node-agent MCP server (runtime-only, not persisted)
    const nodeAgentMcpServer = this.buildNodeAgentMcpServerForSession(
      taskId,
      subSessionId,
      execution.agentName,
      spaceId,
      workflowRunId,
      workspacePath,
      execution.workflowNodeId
    );

    // Merge genuine runtime MCP servers only (node-agent, agent-memory).
    // Registry servers are resolved by QueryOptionsBuilder.getMcpServersFromRegistry()
    // at query time (using this session's context.spaceId) and reconciled live —
    // do NOT copy them in here, or a stale copy would defeat live reconciliation
    // (see the spawn-path note in createSubSession / task #853).
    const mergedMcpServers: Record<string, McpServerConfig> = {
      'node-agent': nodeAgentMcpServer as unknown as McpServerConfig,
      ...this.buildAgentMemoryMcpServers(spaceId, subSessionId),
    };

    // Use merge semantics: the restored session has no in-memory MCP servers
    // (stripped from DB) so this is effectively a full set, but mergeRuntimeMcpServers
    // is safer than the deprecated replace-all setRuntimeMcpServers.
    agentSession.mergeRuntimeMcpServers(mergedMcpServers);

    const rehydrateCtx = {
      taskId,
      subSessionId,
      agentName: execution.agentName,
      spaceId,
      workflowRunId,
      workspacePath,
      workflowNodeId: execution.workflowNodeId,
    };

    // Defensive guarantee — see ensureNodeAgentAttached docs.
    await this.ensureNodeAgentAttached(agentSession, {
      ...rehydrateCtx,
      phase: 'rehydrate',
    });

    // --- Register in in-memory maps
    if (!this.subSessions.has(taskId)) {
      this.subSessions.set(taskId, new Map());
    }
    this.subSessions.get(taskId)!.set(subSessionId, agentSession);
    this.agentSessionIndex.set(subSessionId, agentSession);

    // --- Register in SessionManager cache to prevent duplicate AgentSession creation
    this.config.sessionManager.registerSession(agentSession);

    // --- Register completion callback so the workflow continues normally after this turn
    this.registerCompletionCallback(subSessionId, async () => {
      await this.handleSubSessionComplete(taskId, execution.workflowNodeId, subSessionId);
    });

    // P1-5: Register the self-heal callback on the rehydrated session so that
    // if MCP servers go missing during its lifetime, QueryRunner.start() can recover.
    agentSession.onMissingWorkflowMcpServers = async (cbSessionId: string, missing: string[]) => {
      await this.mcpSelfHeal(cbSessionId, missing);
    };

    // Rehydration must publish the AgentSession in every runtime map before any
    // continuation replay can run. Starting the SDK query is intentionally last:
    // a pending Anthropic tool_result retry may arrive while this method is still
    // restoring MCP/runtime state, and the Codex bridge now waits for the live
    // tool_use correlation map instead of treating that transient window as an
    // unrecoverable orphan.
    const pendingToolContinuations =
      this.config.toolContinuationRepo?.listPendingInboxForSession(subSessionId) ?? [];
    if (pendingToolContinuations.length > 0) {
      log.warn(
        `TaskAgentManager.rehydrateSubSession: session ${subSessionId} has ` +
          `${pendingToolContinuations.length} queued tool_result continuation(s); ` +
          `starting query only after runtime provisioning is complete`
      );
    }

    // Old SDK transcripts may lack assistant message usage. Sanitize only during
    // rehydration, before the SDK reads JSONL history while resuming.
    this.sanitizeSDKSessionTranscriptForRehydration(agentSession, workspacePath);

    // --- Restart the streaming query (idempotent if already running)
    await agentSession.startStreamingQuery();
    await this.replayPendingMessagesAfterRuntimeProvisioning(agentSession);

    // Flush any pending Task Agent → this agent messages that accumulated while
    // the sub-session was not alive in memory.
    void this.flushPendingMessagesForTarget(workflowRunId, execution.agentName, subSessionId).catch(
      (err) => {
        log.warn(
          `TaskAgentManager.rehydrateSubSession: flushPendingMessagesForTarget failed for ${execution.agentName} (session ${subSessionId}): ${err instanceof Error ? err.message : String(err)}`
        );
      }
    );

    log.info(
      `TaskAgentManager.rehydrateSubSession: rehydrated sub-session ${subSessionId} for task ${taskId} (node ${execution.workflowNodeId})`
    );

    return agentSession;
  }

  private resolveCurrentNodeAgentInitForExecution(args: {
    task: SpaceTask;
    space: Space;
    workflow: SpaceWorkflow | null;
    workflowRun: SpaceWorkflowRun | null;
    execution: NodeExecution;
    sessionId: string;
    workspacePath: string;
  }): AgentSessionInit | null {
    const { task, space, workflow, workflowRun, execution, sessionId, workspacePath } = args;
    const node = workflow?.nodes.find((candidate) => candidate.id === execution.workflowNodeId);
    if (!node) {
      log.warn(
        `TaskAgentManager.rehydrateSubSession: workflow node ${execution.workflowNodeId} ` +
          `not found for session ${sessionId}; keeping persisted system prompt`
      );
      return null;
    }

    const nodeAgents = resolveNodeAgents(node);
    const slot =
      nodeAgents.length === 1
        ? nodeAgents[0]
        : nodeAgents.find((agentSlot) => agentSlot.name === execution.agentName);
    if (!slot?.agentId) {
      log.warn(
        `TaskAgentManager.rehydrateSubSession: no agent slot found for agent ${execution.agentName} ` +
          `in node ${execution.workflowNodeId}; keeping persisted system prompt`
      );
      return null;
    }

    return resolveAgentInit({
      task,
      space,
      agentManager: this.config.spaceAgentManager,
      sessionId,
      workspacePath,
      workflowRun,
      workflow,
      slotOverrides: buildSlotOverrides(slot, {
        task,
        node,
        workflow: workflow ?? undefined,
        workflowRun: workflowRun ?? undefined,
      }),
      agentId: slot.agentId,
    });
  }

  /**
   * Resolve the space a sub-session belongs to, for the stopped/paused
   * injection gate. Row-bearing sessions resolve via their execution → run;
   * rowless sub-sessions (the post-approval merger, #852) embed
   * `space:<id>:` in the session id. Returns null when neither resolves
   * (conservative no-gate: an unknown shape is not refused).
   */
  private async resolveSpaceIdForSubSession(subSessionId: string): Promise<string | null> {
    // Prefix first: session ids embed `space:<id>:…` (the merger does, and
    // node-agent sub-sessions too), which resolves without a repo read. The
    // execution path below is the fallback for legacy ids without the prefix.
    const spaceMarker = 'space:';
    const markerIndex = subSessionId.indexOf(spaceMarker);
    if (markerIndex !== -1) {
      const spaceId = subSessionId.slice(markerIndex + spaceMarker.length).split(':')[0];
      if (spaceId) return spaceId;
    }
    const execution = this.resolveNodeExecutionForSubSession(subSessionId);
    if (execution) {
      const run = this.config.workflowRunRepo.getRun(execution.workflowRunId);
      if (run) return run.spaceId;
    }
    return null;
  }

  /**
   * Resolve the workflow execution that owns a sub-session.
   *
   * Normal path: NodeExecution.agentSessionId points at the sub-session.
   * Recovery path: deterministic workflow sub-session ids include the execution
   * id (`space:<spaceId>:task:<taskId>:exec:<nodeExecutionId>`). If a daemon
   * restart or spawn race left `agent_session_id` null, use that embedded id to
   * repair the row and continue rehydration/self-heal without discarding the
   * existing session transcript or queued message.
   */
  private resolveNodeExecutionForSubSession(subSessionId: string): NodeExecution | null {
    const bySessionId = this.config.nodeExecutionRepo.listByAgentSessionId(subSessionId);
    const embeddedExecutionId = this.parseExecutionIdFromSubSessionId(subSessionId);
    const embedded = embeddedExecutionId
      ? this.config.nodeExecutionRepo.getById(embeddedExecutionId)
      : null;

    if (embedded && !embedded.agentSessionId) {
      const repaired = this.config.nodeExecutionRepo.updateSessionId(embedded.id, subSessionId);
      if (repaired) {
        log.warn(
          `TaskAgentManager.resolveNodeExecutionForSubSession: repaired missing agent_session_id ` +
            `for execution ${embedded.id} from sub-session id ${subSessionId}`
        );
        return this.pickBestNodeExecution([repaired, ...bySessionId]);
      }
    }

    const candidates =
      embedded?.agentSessionId === subSessionId ? [embedded, ...bySessionId] : bySessionId;
    return this.pickBestNodeExecution(candidates);
  }

  private parseExecutionIdFromSubSessionId(subSessionId: string): string | null {
    const marker = ':exec:';
    const markerIndex = subSessionId.indexOf(marker);
    if (markerIndex === -1) return null;
    const rest = subSessionId.slice(markerIndex + marker.length);
    const executionId = rest.split(':')[0];
    return executionId || null;
  }

  private pickBestNodeExecution(candidates: NodeExecution[]): NodeExecution | null {
    if (candidates.length === 0) return null;
    const statusRank = (execution: NodeExecution): number => {
      switch (execution.status) {
        case 'in_progress':
          return 0;
        case 'blocked':
          return 1;
        case 'pending':
          return 2;
        default:
          return 3;
      }
    };
    return [...candidates].sort((a, b) => {
      const rankDiff = statusRank(a) - statusRank(b);
      if (rankDiff !== 0) return rankDiff;
      const updatedDiff = b.updatedAt - a.updatedAt;
      if (updatedDiff !== 0) return updatedDiff;
      return b.createdAt - a.createdAt;
    })[0]!;
  }

  private async replayPendingMessagesAfterRuntimeProvisioning(
    session: AgentSession
  ): Promise<void> {
    const replay = (
      session as AgentSession & {
        replayPendingMessagesForImmediateMode?: () => Promise<void>;
      }
    ).replayPendingMessagesForImmediateMode;
    if (typeof replay === 'function') {
      await replay.call(session);
    }
  }

  // -------------------------------------------------------------------------
  // Private — message injection
  // -------------------------------------------------------------------------

  /**
   * True if any message_delivery job (turn or steer) is pending or processing
   * for the session. Used to gate resetContextPerTurn so a `/clear` does not race
   * a v2 turn whose job is enqueued but not yet claimed — the session's live
   * processing state lags the durable job state under v2. Read-only indexed SELECT.
   */
  private hasActiveDeliveryJob(sessionId: string): boolean {
    return this.config.db.getJobQueueRepo().activeDeliveryMessageUuids(sessionId).size > 0;
  }

  /**
   * Inject a handoff/user message into a sub-session under v2 durable delivery.
   * Idempotent on the message UUID (hoisted before the deferred save AND the
   * resetContextPerTurn clear): a flush retry reusing the pending-row id reuses
   * the existing `sdk_messages` row instead of inserting a duplicate, and an
   * already-consumed row short-circuits (no `/clear`, no re-drive). Defers when
   * the target is busy / rate-limited / parent-limited (marking the row
   * `deferred` for QueryModeHandler replay); otherwise enqueues a durable
   * `message_delivery` job via {@link deliverAndMarkQueued}. Returns the row id
   * (the stable message UUID when a row already exists).
   */
  private async injectMessageIntoSession(
    session: AgentSession,
    message: string,
    deliveryMode: 'immediate' | 'defer' = 'immediate',
    origin?: MessageOrigin,
    isSyntheticMessage = true,
    images?: MessageImage[],
    inputKind: MessageInputKind = 'task',
    explicitMessageId?: string
  ): Promise<string> {
    const sessionId = session.session.id;
    const state = session.getProcessingState();
    // 'processing'/'queued' = actively running; 'waiting_for_input' = human gate open;
    // 'interrupted' = the current turn was interrupted but the session is still alive.
    // All four states mean a defer message cannot be safely delivered right now —
    // defer it for replay after the current interaction resolves.
    //
    // Note on 'interrupted': an interrupted session CAN accept a new immediate
    // message (ensureQueryStarted restarts the query), so only defer delivery is
    // deferred. This matches the pattern for 'processing'/'queued': the message is
    // persisted as deferred and replayed once the session becomes idle.
    const isBusy =
      state.status === 'processing' ||
      state.status === 'queued' ||
      state.status === 'waiting_for_input' ||
      state.status === 'interrupted' ||
      state.status === 'rate_limit_cooldown';

    // An explicit id (the pending-message row id from flushPendingMessagesForTarget)
    // makes a crash-retry dedup: deliverMessage/getActiveDeliveryRole keys on it.
    const messageId = explicitMessageId ?? generateUUID();
    const hasImages = !!images && images.length > 0;
    // Validate base64 size up-front so users get the same early "resize image"
    // error returned by the live-session persistence path instead of a late,
    // opaque API failure once the SDK forwards the oversized payload.
    if (hasImages) {
      validateImageSizes(images!);
    }
    const sdkContent: MessageContent[] = hasImages
      ? [
          ...images!.map((img) => ({
            type: 'image' as const,
            source: {
              type: 'base64' as const,
              media_type: img.media_type,
              data: img.data,
            },
          })),
          { type: 'text' as const, text: message },
        ]
      : [{ type: 'text' as const, text: message }];

    const sdkUserMessage: SDKUserMessage & { isSynthetic: boolean } = {
      type: 'user' as const,
      uuid: messageId as UUID,
      session_id: sessionId,
      parent_tool_use_id: null,
      isSynthetic: isSyntheticMessage,
      message: {
        role: 'user' as const,
        content: sdkContent,
      },
    };

    // Idempotent persist guard (v2), hoisted BEFORE the deferred save AND the
    // resetContextPerTurn clear. A flush retry / concurrent flush reuses the
    // pending-row id, but saveUserMessage mints a fresh row id each call.
    // Without this guard up front, (a) the deferred branch inserts a SECOND
    // deferred row with the same non-unique sdk_uuid — QueryModeHandler replays
    // every deferred row, so the handoff delivers multiple times; and (b) a
    // crash after the delivery job completed but before markDelivered retries
    // the same id, reaches resetContextPerTurn's /clear, and rotates away the
    // context holding the just-delivered handoff. `consumed` ⇒ already
    // delivered — return without clearing/re-saving/re-driving; `failed` ⇒ a
    // prior enqueue threw and terminalized it — reopen. (Codex P1.)
    const v2Enabled = isMessageDeliveryV2Enabled();
    const existing = v2Enabled
      ? this.config.db.getSDKMessageRepo().getDeliveryContent(sessionId, messageId)
      : null;
    if (existing?.sendStatus === 'consumed') {
      return messageId; // genuinely delivered on a prior attempt — no clear, no re-drive
    }
    if (existing?.sendStatus === 'failed') {
      this.config.db.getSDKMessageRepo().reopenDeliveryByUuid(sessionId, messageId);
    }

    // defer + busy → persist as deferred for replay after current turn completes.
    // A session in rate_limit_cooldown is paused on a rate/usage cap — ALWAYS
    // defer incoming messages (even `immediate` delivery from an external event
    // or peer handoff) so the pause isn't bypassed. The message is replayed when
    // the watchdog resumes the session and it returns to idle.
    const inRateLimitCooldown = state.status === 'rate_limit_cooldown';
    // After a daemon restart, rehydration flips the persisted
    // rate_limit_cooldown session state to idle, so the session-state check
    // alone would let an injected external-event/peer-handoff message resume
    // work before restrictions.resetAt. The parent task row still carries the
    // paused status until the cross-restart sweep restores it — gate on it too.
    const parentTaskId = this.findParentTaskIdForSubSession(sessionId);
    const parentTask = parentTaskId ? this.config.taskRepo.getTask(parentTaskId) : null;
    const parentLimited = parentTask ? isRateOrUsageLimited(parentTask.status) : false;
    if ((deliveryMode === 'defer' && isBusy) || inRateLimitCooldown || parentLimited) {
      // An existing row that isn't already `deferred` (e.g. a `failed` row just
      // reopened to `enqueued`) must be flipped to `deferred` here, or
      // QueryModeHandler's replay — which selects only `send_status='deferred'` —
      // never picks it up and the handoff is lost on an idle parent-limited
      // session. (Codex P1.)
      if (v2Enabled && existing && existing.sendStatus !== 'deferred') {
        this.config.db.getSDKMessageRepo().markDeliveryDeferredByUuid(sessionId, messageId);
      }
      // Reuse the existing row if present (idempotent); only insert on the first
      // attempt — a duplicate deferred row would replay the handoff multiple times.
      const dbId = existing
        ? messageId
        : this.config.db.saveUserMessage(sessionId, sdkUserMessage, 'deferred', origin);
      return dbId;
    }

    // resetContextPerTurn: at the start of a task-input turn (a node→node
    // handoff), give the slot fresh eyes by issuing `/clear` before the handoff
    // is processed. Only task inputs clear — human input and system recovery are
    // classified at the inject entry points and never reach here as 'task'. Skip
    // when there is no prior context (the slot's first turn — a fresh session has
    // no sdkSessionId yet), when the session is mid-turn (busy), OR when a
    // durable delivery job is already pending/processing for the session (the v2
    // turn will drive shortly; a clear now would race it), so the clear cannot
    // race with queued input and never wastes a no-op clear. `/clear` is an SDK
    // command, so the gate is sdkSessionId: an ACP (codex) slot with the flag set
    // clears nothing until ACP grows an equivalent.
    const hasPriorContext = !!session.session.sdkSessionId;
    const shouldClearContext =
      inputKind === 'task' &&
      !isBusy &&
      hasPriorContext &&
      this.slotResetsContextForSession(sessionId) &&
      !this.hasActiveDeliveryJob(sessionId);
    if (shouldClearContext) {
      try {
        await session.clearConversationContext();
      } catch (err) {
        log.warn(
          `TaskAgentManager: resetContextPerTurn clear failed for session ${sessionId}: ` +
            `${err instanceof Error ? err.message : String(err)} — delivering without clear`
        );
      }
    }

    if (v2Enabled) {
      // The idempotent lookup + consumed/failed handling ran hoisted above; here
      // only the (re-)enqueue + queued marker remain. Reuse the existing row if
      // present, else insert `enqueued`. deliverAndMarkQueued holds withSessionLock
      // so a concurrent steer can't steal the turn's queued marker; the handler
      // then owns ensureQueryStarted and feeding the live transport.
      const dbId = existing
        ? messageId
        : this.config.db.saveUserMessage(sessionId, sdkUserMessage, 'enqueued', origin);
      const sdkMessageRepo = this.config.db.getSDKMessageRepo();
      // Await SDK consumption (onSent) before returning — a direct handoff (the
      // live send_message path) has no retained source row to retry, so it must
      // not report delivered after a bare enqueue that may yet dead-letter. On
      // timeout, terminalize ONLY a fresh row: direct send_message carries no
      // stable id, so a retry mints a fresh UUID — terminalizing the timed-out
      // fresh job stops it being consumed alongside the retry (duplicate). The
      // flush path carries a stable id (existing row), so it omits the
      // terminalize and self-heals via retry. (Codex P1.)
      await awaitDeliveryConsumption({
        sessionId,
        messageUuid: messageId,
        // ACP's consume boundary is acceptance (minutes) — size the wait so a
        // fresh ACP delivery isn't terminalized mid-run. (Codex P1.)
        timeoutMs: deliveryConsumptionTimeoutMs(session.getSessionData?.().config?.provider),
        deliver: () =>
          deliverAndMarkQueued({
            jobQueue: this.config.db.getJobQueueRepo(),
            stateManager: session.stateManager,
            sessionId,
            messageUuid: messageId,
            origin: 'space_inject',
            onEnqueueFailure: () => sdkMessageRepo.markDeliveryFailedByUuid(sessionId, messageId),
          }),
        ...(!existing
          ? {
              terminalizeOnTimeout: () =>
                sdkMessageRepo.markDeliveryFailedByUuid(sessionId, messageId),
            }
          : {}),
      });
      return dbId;
    }
    // Legacy inline path (HYPERNEO_MESSAGE_DELIVERY_V2=0 opt-out).
    await session.ensureQueryStarted();
    const dbId = this.config.db.saveUserMessage(sessionId, sdkUserMessage, 'enqueued', origin);
    // When images are present, enqueue the multi-modal content array so the SDK
    // sees image blocks alongside the text. Otherwise pass the plain string to
    // preserve the existing behaviour for callers that don't supply images.
    await session.messageQueue.enqueueWithId(messageId, hasImages ? sdkContent : message);
    return dbId;
  }

  // -------------------------------------------------------------------------
  // Private — session cleanup helpers
  // -------------------------------------------------------------------------

  /**
   * Interrupt and clean up a session's in-memory state, **preserving its DB row**
   * and all persisted artifacts (worktree + SDK `.jsonl` files).
   *
   * Task #85: this is the only primitive non-UI code paths may use to stop
   * a task agent / sub-session. Task completion, cancellation, workflow end,
   * spawn rollback, daemon shutdown, and session recovery all route through here
   * so that `rehydrate()` (or a subsequent UI visit) can restore the session.
   * Worktree/DB/jsonl removal happens only via
   * `SessionManager.archiveSessionResources` or
   * `SessionManager.deleteSessionResources`.
   */
  private async stopSessionPreserveDb(
    sessionId: string,
    session: AgentSession,
    options: { strict?: boolean; preserveDeliveryJobs?: boolean } = {}
  ): Promise<void> {
    const unsub = this.sessionListeners.get(sessionId);
    if (!options.strict && unsub) {
      unsub();
      this.sessionListeners.delete(sessionId);
    }
    if (!options.strict) {
      this.completionCallbacks.delete(sessionId);
    }

    let stopError: unknown;
    try {
      // preserveDeliveryJobs: on a restart-bound shutdown stop, do NOT cancel
      // the session's message_delivery jobs — app.ts already requeued them for
      // the next boot, and handleInterrupt's default cancel would delete the
      // durable handoff we just preserved. (Codex P1.)
      // skipDeferredReplay: this stop path is teardown-bound (task
      // cancellation/completion/shutdown) — the deferred-queue trigger
      // published on user interrupts must not run here, or it promotes
      // deferred rows to enqueued and drives new delivery jobs for a session
      // that is about to be cleaned up.
      await session.handleInterrupt({
        ...(options.preserveDeliveryJobs ? { preserveDeliveryJobs: true } : {}),
        skipDeferredReplay: true,
      });
    } catch (err) {
      stopError = err;
      log.warn(`TaskAgentManager: failed to interrupt session ${sessionId}:`, err);
    }

    try {
      await session.cleanup();
    } catch (err) {
      stopError = stopError ?? err;
      log.warn(`TaskAgentManager: failed to cleanup session ${sessionId}:`, err);
    }

    if (options.strict && stopError) {
      throw new Error(
        `Failed to stop session ${sessionId}: ${stopError instanceof Error ? stopError.message : String(stopError)}`
      );
    }

    if (options.strict && unsub) {
      unsub();
      this.sessionListeners.delete(sessionId);
      this.completionCallbacks.delete(sessionId);
    }
  }

  // Task #85: `stopAndDeleteSession` has been removed. Non-UI code paths must
  // use `stopSessionPreserveDb` (or `SessionManager.interruptInMemorySession`),
  // which preserves the DB row + `sdk_messages` + worktree + SDK `.jsonl`
  // files. Only the `session.archive`/`task.archive` and
  // `session.delete`/`room.delete` RPC handlers may touch those artifacts,
  // via `SessionManager.archiveSessionResources` /
  // `SessionManager.deleteSessionResources`.

  // -------------------------------------------------------------------------
  // Private — utility lookups
  // -------------------------------------------------------------------------

  /** Returns the workflow run ID for a task by looking it up in the task repo. */
  private getWorkflowRunId(taskId: string): string | null {
    const task = this.config.taskRepo.getTask(taskId);
    return task?.workflowRunId ?? null;
  }

  /**
   * Resolve the parent task ID that owns a given sub-session ID.
   */
  private findParentTaskIdForSubSession(subSessionId: string): string | null {
    for (const [taskId, nodeMap] of this.subSessions) {
      if (nodeMap.has(subSessionId)) {
        return taskId;
      }
    }
    return null;
  }

  /**
   * The MCP servers that every workflow sub-session MUST have attached before its
   * first turn runs. See `ensureNodeAgentAttached` / `ensureRequiredMcpServersAttached`
   * for the invariant enforcement logic.
   *
   * - `node-agent`: peer communication, artifact writes, and node-safe task
   *   actions (including create_standalone_task).
   *   Without this the Coder→Reviewer handoff dies silently with "No such tool
   *   available" (PR #1535 failure mode).
   */
  private static readonly REQUIRED_WORKFLOW_SUBSESSION_MCP_SERVERS = ['node-agent'] as const;

  /**
   * Verify that a workflow node sub-session has its required MCP server
   * (`node-agent`) attached to its in-memory config, and self-heal by
   * re-attaching it when missing.
   *
   * This is a defensive guard against silent recurrence of the peer-communication
   * failure mode:
   *   - PR #1535: Coder sub-session ran without `node-agent`, so
   *     `mcp__node-agent__send_message` returned "No such tool available" and the
   *     Coder→Reviewer handoff died silently.
   *
   * Called from both spawn and rehydrate paths to guarantee the invariant:
   *   "every workflow-node sub-session has `node-agent` attached BEFORE first turn".
   *
   * If any required server is missing (which should never happen given the merge
   * logic in createSubSession + rehydrateSubSession), this method:
   *   1. Logs a loud error tagged with the spawn/rehydrate phase for diagnosis.
   *   2. Re-builds and re-attaches the missing server (preserving any registry-sourced
   *      MCP servers that may already be present in the config).
   *   3. Re-verifies attachment; if any required server is still missing, throws —
   *      better to fail spawn visibly than to start an unrecoverable session.
   *
   * Kept under the name `ensureNodeAgentAttached` for source-compatibility with
   * existing callers and tests; `ensureRequiredMcpServersAttached` is the
   * preferred alias for new code.
   */
  requiredWorkflowSubSessionMcpServers(): string[] {
    return this.config.memoryRepo
      ? [...TaskAgentManager.REQUIRED_WORKFLOW_SUBSESSION_MCP_SERVERS, 'agent-memory']
      : [...TaskAgentManager.REQUIRED_WORKFLOW_SUBSESSION_MCP_SERVERS];
  }

  async ensureNodeAgentAttached(
    session: AgentSession,
    ctx: {
      taskId: string;
      subSessionId: string;
      agentName: string;
      spaceId: string;
      workflowRunId: string;
      workspacePath: string;
      workflowNodeId: string;
      phase: 'spawn' | 'rehydrate';
    }
  ): Promise<void> {
    // `session.config` may be absent on restored ghost sessions before the first
    // query setup, so read defensively — treat as empty servers map.
    const currentMcpServers =
      (session.session.config?.mcpServers as Record<string, McpServerConfig> | undefined) ?? {};

    const required = this.requiredWorkflowSubSessionMcpServers();
    const missing = required.filter((name) => !currentMcpServers[name]);

    if (missing.length === 0) {
      // Invariant holds — log at debug level for traceability.
      log.debug(
        `TaskAgentManager.ensureNodeAgentAttached: all required MCP servers present on session ${ctx.subSessionId} (phase=${ctx.phase}): [${required.join(', ')}]`
      );
      return;
    }

    log.error(
      `TaskAgentManager.ensureNodeAgentAttached: required MCP servers MISSING on workflow sub-session ${ctx.subSessionId} ` +
        `(task=${ctx.taskId}, agent=${ctx.agentName}, phase=${ctx.phase}). ` +
        `Missing: [${missing.join(', ')}]. ` +
        `Visible servers: [${Object.keys(currentMcpServers).sort().join(', ')}]. ` +
        `Self-healing by re-injecting before first turn — but this indicates a regression in the spawn/rehydrate merge logic.`
    );

    // Re-attach missing required servers while preserving other runtime servers.
    for (const name of missing) {
      if (name === 'node-agent') {
        await this.reinjectNodeAgentMcpServer(session, ctx);
      } else if (name === 'agent-memory') {
        await this.reinjectAgentMemoryMcpServer(session, ctx);
      }
    }

    const verifyMcpServers =
      (session.session.config?.mcpServers as Record<string, McpServerConfig> | undefined) ?? {};
    const stillMissing = required.filter((name) => !verifyMcpServers[name]);
    if (stillMissing.length > 0) {
      throw new Error(
        `TaskAgentManager.ensureNodeAgentAttached: failed to re-attach required MCP servers [${stillMissing.join(', ')}] to session ${ctx.subSessionId} after self-heal attempt`
      );
    }
    log.info(
      `TaskAgentManager.ensureNodeAgentAttached: successfully re-attached MCP servers [${missing.join(', ')}] to session ${ctx.subSessionId} (phase=${ctx.phase})`
    );
  }

  /**
   * P1-5: Final backstop — self-heals a workflow sub-session's MCP servers on demand.
   *
   * Called by the `onMissingWorkflowMcpServers` callback that `QueryRunner.start()`
   * invokes when it detects a missing `node-agent` at the moment of first-turn
   * setup. This is the last line of defence for any session that slipped through
   * the spawn/rehydrate path without the required server attached:
   *
   *   - Old sessions that never had the callback registered (before this fix)
   *   - Sessions created by older daemon versions with incomplete MCP injection
   *   - Sessions that lost their servers due to a clobbering `setRuntimeMcpServers`
   *     call from an unknown subsystem
   *   - Reused sessions where the reuse-path MCP rebuild was also missed
   *
   * Recovery steps:
   *   1. Look up the NodeExecution by agentSessionId (same as rehydrateSubSession).
   *   2. Build the full context (taskId, spaceId, workflowRunId, workspacePath).
   *   3. Call `ensureRequiredMcpServersAttached` which re-injects node-agent and
   *      verifies it.
   *
   * @param sessionId   The sub-session ID (matches NodeExecution.agentSessionId).
   * @param missing     The list of server names that were detected as missing.
   */
  async mcpSelfHeal(sessionId: string, missing: string[]): Promise<void> {
    log.warn(
      `TaskAgentManager.mcpSelfHeal: triggered for session ${sessionId}, missing [${missing.join(', ')}]`
    );

    // Step 1: Look up the NodeExecution (same resolver as rehydrateSubSession).
    const execution = this.resolveNodeExecutionForSubSession(sessionId);
    if (!execution) {
      log.error(
        `TaskAgentManager.mcpSelfHeal: no NodeExecution found for agentSessionId=${sessionId} — cannot self-heal`
      );
      return;
    }

    // Step 2: Build context.
    const tasks = this.config.taskRepo.listByWorkflowRun(execution.workflowRunId);
    const parentTask = tasks[0] ?? null;
    if (!parentTask) {
      log.error(
        `TaskAgentManager.mcpSelfHeal: no parent task found for workflowRunId=${execution.workflowRunId} — cannot self-heal`
      );
      return;
    }
    const space = await this.config.spaceManager.getSpace(parentTask.spaceId);
    if (!space) {
      log.error(
        `TaskAgentManager.mcpSelfHeal: space ${parentTask.spaceId} not found for task ${parentTask.id} — cannot self-heal`
      );
      return;
    }

    // Step 3: Get the live AgentSession from memory.
    const agentSession = this.agentSessionIndex.get(sessionId);
    if (!agentSession) {
      log.error(
        `TaskAgentManager.mcpSelfHeal: AgentSession ${sessionId} not in memory — cannot self-heal`
      );
      return;
    }

    // Step 4: Call ensureRequiredMcpServersAttached which re-injects and verifies.
    // Uses phase='rehydrate' since we're recovering an existing session.
    await this.ensureRequiredMcpServersAttached(agentSession, {
      taskId: parentTask.id,
      subSessionId: sessionId,
      agentName: execution.agentName,
      spaceId: parentTask.spaceId,
      workflowRunId: execution.workflowRunId,
      workspacePath: this.taskWorktreePaths.get(parentTask.id) ?? space.workspacePath,
      workflowNodeId: execution.workflowNodeId,
      phase: 'rehydrate',
    });
  }

  /**
   * Preferred alias for `ensureNodeAgentAttached`. See that method for behaviour.
   *
   * The original name remains for backwards compatibility with existing callers,
   * but is misleading now that the check covers `node-agent` and optional `agent-memory`. New code should prefer this alias.
   */
  async ensureRequiredMcpServersAttached(
    session: AgentSession,
    ctx: {
      taskId: string;
      subSessionId: string;
      agentName: string;
      spaceId: string;
      workflowRunId: string;
      workspacePath: string;
      workflowNodeId: string;
      phase: 'spawn' | 'rehydrate';
    }
  ): Promise<void> {
    return this.ensureNodeAgentAttached(session, ctx);
  }

  /**
   * Build (or re-build) the per-session node-agent MCP server and merge it into
   * the session's runtime MCP map, preserving any other MCP servers already present.
   *
   * Used by the defensive self-heal path in ensureNodeAgentAttached and as a
   * restore primitive callable when a sub-session needs node-agent re-attached
   * (e.g., after a refactor regression or registry collision drops it).
   *
   * After merging the new server, if a query is currently running the method calls
   * `restartQuery()` so the SDK picks up the fresh tool registry. Without the restart
   * the running turn keeps the old (pre-merge) tool surface and the self-heal has no
   * visible effect until the next turn boundary.
   *
   * `restartQuery()` is safe to call even when no query is running — it is a no-op
   * in that case — so calling it from `ensureNodeAgentAttached` (before `startStreamingQuery`)
   * is harmless.
   */
  async reinjectNodeAgentMcpServer(
    session: AgentSession,
    ctx: {
      taskId: string;
      subSessionId: string;
      agentName: string;
      spaceId: string;
      workflowRunId: string;
      workspacePath: string;
      workflowNodeId: string;
    }
  ): Promise<void> {
    const nodeAgentMcpServer = this.buildNodeAgentMcpServerForSession(
      ctx.taskId,
      ctx.subSessionId,
      ctx.agentName,
      ctx.spaceId,
      ctx.workflowRunId,
      ctx.workspacePath,
      ctx.workflowNodeId
    );

    // Use merge semantics so other runtime servers (agent-memory, db-query, etc.)
    // are preserved. The deprecated setRuntimeMcpServers would clobber them.
    session.mergeRuntimeMcpServers({
      'node-agent': nodeAgentMcpServer as unknown as McpServerConfig,
    });

    // Restart the running query so the SDK mounts the fresh node-agent server.
    // If no query is running this is a no-op (restartQuery returns early when
    // messageQueue.isRunning() is false).
    await session.restartQuery();
  }

  async reinjectAgentMemoryMcpServer(
    session: AgentSession,
    ctx: { subSessionId: string; spaceId: string }
  ): Promise<void> {
    const mcpServers = this.buildAgentMemoryMcpServers(ctx.spaceId, ctx.subSessionId);
    if (Object.keys(mcpServers).length === 0) return;
    session.mergeRuntimeMcpServers(mcpServers);
    await session.restartQuery();
  }

  /**
   * Build a node agent MCP server for a newly spawned sub-session.
   * Called from the `buildNodeAgentMcpServer` callback in buildNodeAgentMcpServerForSession().
   *
   * Creates a ChannelResolver from the workflow run's config at spawn time and injects
   * it directly into the node agent MCP server config. This avoids a per-call DB lookup
   * and ensures each sub-session has its own resolver scoped to the channels declared
   * at node-start (stored in the run config by SpaceRuntime.storeResolvedChannels()).
   *
   * The server gives the node agent peer communication tools (list_peers, send_message,
   * save_artifact) that are scoped to its group, channel topology, and node task.
   */
  buildAgentMemoryMcpServers(spaceId: string, sessionId: string): Record<string, McpServerConfig> {
    if (!this.config.memoryRepo) return {};
    return {
      'agent-memory': createAgentMemoryMcpServer({
        spaceId,
        memoryRepo: this.config.memoryRepo,
        mySessionId: sessionId,
      }) as unknown as McpServerConfig,
    };
  }

  buildNodeAgentMcpServerForSession(
    taskId: string,
    subSessionId: string,
    agentName: string,
    spaceId: string,
    workflowRunId: string,
    workspacePath: string,
    workflowNodeIdHint?: string
  ) {
    const nodeExecutions = this.config.nodeExecutionRepo.listByWorkflowRun(workflowRunId);
    const bySession = nodeExecutions.find((exec) => exec.agentSessionId === subSessionId);
    const byAgentName = nodeExecutions.find((exec) => exec.agentName === agentName);
    const execution = bySession ?? byAgentName;
    const workflowNodeId = workflowNodeIdHint ?? execution?.workflowNodeId ?? '';
    const run = this.config.workflowRunRepo.getRun(workflowRunId);
    const workflow = run?.workflowId
      ? (this.config.spaceWorkflowManager.getWorkflowForRun(run) ?? null)
      : null;
    const channels = workflow?.channels ?? [];
    const channelResolver = new ChannelResolver(channels);

    const nodeGroups = workflow
      ? Object.fromEntries(
          workflow.nodes.map((node) => [
            node.name,
            resolveNodeAgents(node).map((agent) => agent.name),
          ])
        )
      : undefined;

    // Build a ChannelRouter so node messaging can lazily activate target nodes.
    const nodeAgentChannelRouter = new ChannelRouter({
      taskRepo: this.config.taskRepo,
      workflowRunRepo: this.config.workflowRunRepo,
      workflowManager: this.config.spaceWorkflowManager,
      agentManager: this.config.spaceAgentManager,
      nodeExecutionRepo: this.config.nodeExecutionRepo,
      channelCycleRepo: this.config.channelCycleRepo,
      isSessionAlive: (sid) => this.isSessionAlive(sid),
      cancelSessionById: (sid) => this.cancelBySessionId(sid),
      // The merger sub-session has no node_execution row, so this router's
      // lazy-activateNode step would otherwise spawn a DUPLICATE merger on a
      // peer send_message to the Post-Approval node. Scoped to THIS run (the
      // router is built per task/run); other runs are unaffected.
      findPostApprovalSessionId: (runId) =>
        runId === workflowRunId
          ? (this.config.taskRepo.getTask(taskId)?.postApprovalSessionId ?? undefined)
          : undefined,
      // Non-lazy probe: after a daemon restart the persisted merger is not in
      // the in-memory sub-session index (no NodeExecution to rehydrate from), so
      // the lazy isSessionAlive would falsely report it alive and the skip
      // guard would crash injectSubSessionMessage. In-memory only.
      isPostApprovalSessionInMemory: (sid) => this.isSessionInMemory(sid),
      // Forward the runtime's current sink so a peer-agent `send_message`
      // that auto-reopens a terminal run still emits `workflow_run_reopened`
      // into the Space Agent session.
      internalEventBus: this.config.internalEventBus,
    });
    const agentMessageRouter = new AgentMessageRouter({
      nodeExecutionRepo: this.config.nodeExecutionRepo,
      workflowRunId,
      workflowChannels: channels,
      messageInjector: async (targetSessionId, message) => {
        await this.injectSubSessionMessage(targetSessionId, message, true);
        // A peer message was just delivered to this node-agent session — that is
        // inbound activity, so refresh lastActivityAt. Runtime recovery nags do
        // NOT take this path (they call injectSubSessionMessageWithOrigin
        // directly, bypassing the router), so this cannot reset the stall
        // detector's timer on the runtime's own nag. Stamped only after a
        // successful inject; a throw above skips this so a failed delivery does
        // not register as activity.
        this.recordActivityForSession(targetSessionId);
      },
      activateTargetSession: (targetAgentName) =>
        this.activateTargetSessionsForMessage(taskId, workflowRunId, targetAgentName, {
          reopenReason: `node-agent send_message to activate "${targetAgentName}"`,
          reopenBy: `agent:${agentName}`,
        }),
      channelRouter: nodeAgentChannelRouter,
      nodeGroups,
      spaceAgentInjector: this.config.spaceAgentInjector,
      findPostApprovalSessionId: () => {
        const task = this.config.taskRepo.getTask(taskId);
        const sid = task?.postApprovalSessionId;
        // Gate on IN-MEMORY liveness (not the lazy isSessionAlive): a merger
        // that terminated, OR a persisted merger not yet rehydrated after a
        // daemon restart (it has no NodeExecution, so it is absent from the
        // in-memory sub-session index), must not be treated as a live peer —
        // injecting into either would lose the message or throw
        // "Sub-session not found". Returning undefined falls through to
        // activation so a replacement can be brought up.
        return sid && this.isSessionInMemory(sid) ? sid : undefined;
      },
      // Resolve the DISPATCHED post-approval route's targetAgent (the merger
      // agent name) so the live session is mapped ONLY to that agent. Mirrors
      // PostApprovalRouter's selection via the shared helper — see
      // resolvePostApprovalTargetAgentName.
      findPostApprovalTargetAgentName: () => resolvePostApprovalTargetAgentName(workflow),
      // Wire reply routing so node-agent replies to space-agent route back
      // to the originating ad-hoc member session instead of space:chat:.
      replyRoutingLookup: (fromAgentName) => {
        const registry = this.config.replyRoutingRegistry;
        return registry ? registry.get(taskId, fromAgentName) : null;
      },
      // Wire up the pending-message queue so node agents can queue messages for
      // peers that haven't spawned yet (declared but inactive). The queue is
      // drained by flushPendingMessagesForTarget() when the target session activates.
      workflowNodeNameById: Object.fromEntries(
        (workflow?.nodes ?? []).map((node) => [node.id, node.name])
      ),
      pendingMessageRepo: this.config.pendingMessageRepo,
      messageResolver: this.config.messageResolverFactory?.(spaceId, {
        workflowRunId,
        nodeId: workflowNodeId,
        agentName,
      }),
      longTermAgentDelivery: this.config.longTermAgentDelivery,
      spaceId,
      taskId,
      taskNumber: this.config.taskRepo.getTask(taskId)?.taskNumber ?? null,
      // Auto-resume + lazy-activation callback fired when a message is queued
      // for an inactive peer:
      //
      //   1. `tryResumeNodeAgentSession` — fast path that rehydrates a known
      //      idle/completed session so the queue is drained immediately.
      //   2. `ensureWorkflowNodeActivationForAgent` — explicit activation kick
      //      for workflow-declared peers that have no live session. Mirrors the
      //      Task Agent send-path fix in #139: relying on `channelRouter`'s
      //      activation-on-deliverMessage step is not enough because that step
      //      only fires when the target node has zero active executions; a
      //      workflow node stranded in `pending` state would otherwise queue
      //      forever. `activateNode` is idempotent so this is safe regardless
      //      of the existing row's status.
      onMessageQueued: (targetAgentName, queuedWorkflowNodeId) => {
        // The router now passes the BARE slot name (+ resolved node id); the
        // compound form never matched a declared agent, so lazy activation was a
        // no-op for @worker queues before.
        void this.tryResumeNodeAgentSession(
          workflowRunId,
          targetAgentName,
          queuedWorkflowNodeId
        ).catch((err) => {
          log.warn(
            `AgentMessageRouter.onMessageQueued: tryResumeNodeAgentSession failed for "${targetAgentName}": ${err instanceof Error ? err.message : String(err)}`
          );
        });
        const declaredAgentNames = this.getWorkflowDeclaredAgentNamesForTask(taskId);
        if (declaredAgentNames.includes(targetAgentName)) {
          log.info(
            `agent-message-router.onMessageQueued: lazy-activated peer ${targetAgentName} for task ${taskId}`
          );
          void this.ensureWorkflowNodeActivationForAgent(taskId, targetAgentName, {
            reopenReason: `node-agent send_message to lazily activate "${targetAgentName}"`,
            reopenBy: `agent:${agentName}`,
            workflowNodeId: queuedWorkflowNodeId,
          }).catch((err) => {
            log.warn(
              `AgentMessageRouter.onMessageQueued: ensureWorkflowNodeActivationForAgent failed for "${targetAgentName}": ${err instanceof Error ? err.message : String(err)}`
            );
          });
        }
      },
    });

    const agentNameAliases = execution
      ? this.buildAgentNameAliasesForExecution(workflow, execution)
      : this.agentNameVariants(agentName);

    // End-node tool contract:
    //   `save_artifact`      — persist typed data to artifact store (available to all node agents).
    //   `approve_task`       — closes the task as done (self-approval). Gated
    //                          by `space.autonomyLevel >= workflow.completionAutonomyLevel`.
    //                          Only available to end-node agents.
    //   `submit_for_approval` — request human review of completion.
    //                           Only available to end-node agents.
    const isEndNode = this.isTerminalNode(workflow, workflowNodeId);
    // Bound SpaceTaskManager shared by the `submit_for_approval` and
    // `mark_complete` tool handlers — both rely on the centralised transition
    // validator so any illegal source status fails before fields get written.
    const boundTaskManager = new SpaceTaskManager(
      this.config.db.getDatabase(),
      spaceId,
      this.config.reactiveDb,
      this.config.evolutionScopeService
    );
    const endNodeHandlers = isEndNode
      ? createEndNodeHandlers({
          taskId,
          spaceId,
          workflow,
          workflowNodeId,
          agentName,
          taskRepo: this.config.taskRepo,
          taskManager: boundTaskManager,
          spaceManager: this.config.spaceManager,
          internalEventBus: this.config.internalEventBus,
        })
      : undefined;
    const onApproveTask = endNodeHandlers?.onApproveTask;
    const onSubmitForApproval = endNodeHandlers?.onSubmitForApproval;

    // `mark_complete` (PR 2/5) is mirrored onto every spawned node-agent so
    // post-approval sub-sessions can close the task via `approved → done`.
    // The handler self-validates status (rejects non-approved) — a spawned
    // agent that happens not to be running a post-approval step simply sees
    // the tool reject with a clear error.
    // Merge-completion gate: carry the durable route flag into template-created
    // clones, with built-in identity as backward compatibility for existing rows.
    // Instruction prose is deliberately irrelevant: customizing it must not
    // silently disable the safety contract.
    const dispatchedPostApprovalRoute = collectDispatchablePostApprovalRoutes(workflow ?? null)[0];
    const isCoderOwnedMergeWorkflow =
      dispatchedPostApprovalRoute?.requirePrMerge === true ||
      builtInWorkflowRequiresPrMerge(workflow?.templateName);
    const onMarkComplete = createMarkCompleteHandler({
      taskId,
      spaceId,
      taskRepo: this.config.taskRepo,
      taskManager: boundTaskManager,
      internalEventBus: this.config.internalEventBus,
      goalService: this.config.goalService,
      callerSessionId: subSessionId,
      requiresPostApprovalOwner: dispatchedPostApprovalRoute !== undefined,
      resolveResultArtifactSummary: (task) => {
        // Delegated to the domain artifact profile (coding: the kindless
        // terminal `decision` summary).
        if (!task.workflowRunId) return null;
        return this.config.artifactProfile?.summarizeRunOutcome(task.workflowRunId) ?? null;
      },
      assertPrMerged: isCoderOwnedMergeWorkflow
        ? createPrMergedGate({
            requirePrUrl: true,
            resolvePrUrl: (task) =>
              task.workflowRunId
                ? (this.config.artifactProfile?.resolveInitialPrimaryLinkUrl?.(
                    task.workflowRunId
                  ) ?? '')
                : '',
            getPrState: async (prUrl) => {
              const outcome = await createGithubConnector().ops.getPr(
                { prUrl },
                { workspacePath: '', params: {}, rawParams: {}, hookLocalState: {} }
              );
              if (!outcome.ok) throw new Error(outcome.error);
              const state = (outcome.data as { state?: unknown } | null)?.state;
              return typeof state === 'string' ? state : 'UNKNOWN';
            },
          })
        : undefined,
    });

    // Self-heal callback for the agent-callable `restore_node_agent` tool.
    // Looks up the live AgentSession by the enclosing-scope subSessionId, then
    // calls reinjectNodeAgentMcpServer to (re)attach node-agent and restart the query
    // so the SDK mounts the fresh tool registry for the next turn. Belt-and-braces:
    // the tool call itself is proof the server is already attached, but re-injecting
    // protects against partial/torn registry state and emits a structured log entry
    // for diagnosis. All identity vars (taskId, subSessionId, etc.) are `const` in
    // the enclosing scope, so the closure captures them safely without aliasing.
    const onRestoreNodeAgent = async (args: { reason?: string }): Promise<void> => {
      const liveSession = this.getSubSession(subSessionId);
      if (!liveSession) {
        log.warn(
          `TaskAgentManager.onRestoreNodeAgent: no live AgentSession found for sub-session ${subSessionId} ` +
            `(task=${taskId}, agent=${agentName}). Reason: ${args.reason ?? '<unspecified>'}`
        );
        return;
      }
      try {
        await this.reinjectNodeAgentMcpServer(liveSession, {
          taskId,
          subSessionId,
          agentName,
          spaceId,
          workflowRunId,
          workspacePath,
          workflowNodeId,
        });
        log.info(
          `TaskAgentManager.onRestoreNodeAgent: re-attached node-agent for sub-session ${subSessionId} ` +
            `(task=${taskId}, agent=${agentName}, reason=${args.reason ?? '<unspecified>'})`
        );
      } catch (err) {
        log.error(
          `TaskAgentManager.onRestoreNodeAgent: failed to re-attach node-agent for sub-session ${subSessionId}: ${err instanceof Error ? err.message : String(err)}`
        );
      }
    };

    const onSubscribeExternalEvent = async (args: { topicPattern: string; label?: string }) => {
      const validation = validateGlobPattern(args.topicPattern.trim());
      if (!validation.valid) {
        return jsonResult({ success: false, error: validation.reason });
      }
      try {
        const result = this.config.spaceRuntimeService.registerSubscription(
          workflowRunId,
          taskId,
          workflowNodeId,
          agentName,
          args.topicPattern
        );
        return jsonResult(result);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return jsonResult({ success: false, error: message });
      }
    };
    const onUnsubscribeExternalEvent = async (args: { topicPattern: string }) => {
      const validation = validateGlobPattern(args.topicPattern.trim());
      if (!validation.valid) {
        return jsonResult({ success: false, error: validation.reason });
      }
      const result = this.config.spaceRuntimeService.unregisterSubscription(
        workflowRunId,
        taskId,
        workflowNodeId,
        agentName,
        args.topicPattern
      );
      return jsonResult(result);
    };
    const onListSubscriptions = async (args: { workflowRunId?: string; nodeId?: string }) => {
      try {
        const result = this.config.spaceRuntimeService.listSubscriptions(
          args.workflowRunId ?? workflowRunId,
          spaceId,
          args.nodeId
        );
        return jsonResult(result);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return jsonResult({ success: false, error: message });
      }
    };
    const onCreateStandaloneTask = async (args: {
      title: string;
      description: string;
      priority?: 'low' | 'normal' | 'high' | 'urgent';
      custom_agent_id?: string;
      workflow_id?: string;
      depends_on?: string[];
      draft?: boolean;
    }) => {
      try {
        const task = await boundTaskManager.createTask({
          title: args.title,
          description: args.description,
          priority: args.priority,
          preferredWorkflowId: args.workflow_id ?? null,
          dependsOn: args.depends_on,
          status: args.draft ? 'draft' : undefined,
          createdBy: agentName,
          createdBySession: subSessionId,
        });
        return jsonResult({ success: true, task });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return jsonResult({ success: false, error: message });
      }
    };

    const onPublishTask = async (args: { task_id: string }) => {
      try {
        const updated = await boundTaskManager.publishTask(args.task_id);
        // Emit event so subscribers (e.g. task list UI) see the status change.
        this.config.internalEventBus
          ?.publish('space.task.updated', {
            sessionId: 'global',
            spaceId,
            taskId: updated.id,
            task: updated,
          })
          .catch((err: unknown) => {
            log.warn(
              `Failed to emit space.task.updated (publish) for task ${updated.id}: ${err instanceof Error ? err.message : String(err)}`
            );
          });
        return jsonResult({ success: true, task: updated });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return jsonResult({ success: false, error: message });
      }
    };

    const onArchiveTask = async (args: { task_id: string }) => {
      try {
        // Reject archiving the canonical task of an active (non-terminal) run —
        // it would strand the run (mirrors the spaceTask.update RPC guard and
        // the space agent-tool guard so node-agent archives can't bypass it).
        // (task #849, G1)
        const task = await boundTaskManager.getTask(args.task_id);
        if (
          task?.workflowRunId &&
          this.config.spaceRuntimeService.isWorkflowRunActive(task.workflowRunId)
        ) {
          return jsonResult({
            success: false,
            error:
              `Cannot archive task ${args.task_id}: it belongs to an active workflow run ` +
              `(${task.workflowRunId}). Cancel the run instead so its agents and ` +
              `lifecycle are torn down — archiving would leave the run stranded.`,
          });
        }
        const updated = await boundTaskManager.archiveTask(args.task_id);
        // Emit event so subscribeToTaskArchiveEvents() triggers cleanup
        // (session teardown, SDK JSONL archival, worktree removal).
        this.config.internalEventBus
          ?.publish('space.task.updated', {
            sessionId: 'global',
            spaceId,
            taskId: updated.id,
            task: updated,
          })
          .catch((err: unknown) => {
            log.warn(
              `Failed to emit space.task.updated (archive) for task ${updated.id}: ${err instanceof Error ? err.message : String(err)}`
            );
          });
        return jsonResult({ success: true, task: updated });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return jsonResult({ success: false, error: message });
      }
    };

    // Build workflow hook engine when the workflow defines hooks.
    let hookEngine: WorkflowHookEngine | undefined;
    if (workflow?.hooks && workflow.hooks.length > 0) {
      const hookExecutor = new HookExecutor({ workspacePath });
      hookEngine = new WorkflowHookEngine({
        workflow,
        workflowRunId,
        workflowRunCreatedAt: this.config.workflowRunRepo.getRun(workflowRunId)?.createdAt,
        nodeExecutionRepo: this.config.nodeExecutionRepo,
        artifactRepo: this.config.artifactRepo,
        hookStateRepo: new WorkflowHookStateRepository(this.config.db.getDatabase()),
        hookExecutor,
        workspacePath,
        getWorkflowRunStatus: (runId) => this.config.workflowRunRepo.getRun(runId)?.status,
        getTaskStatus: (tid) => this.config.taskRepo.getTask(tid)?.status,
        getSourceNodeExecutionStatus: (actionMeta) =>
          this.config.nodeExecutionRepo
            .listByWorkflowRun(workflowRunId)
            .find(
              (execution) =>
                execution.agentSessionId === actionMeta.sessionId &&
                execution.agentName === actionMeta.agentName &&
                execution.workflowNodeId === actionMeta.nodeId
            )?.status,
        notifySourceSession: async (sessionId, message) => {
          // Hook-failure notice — a synthetic inject, but NOT a node→node
          // handoff, so it must not trigger a resetContextPerTurn clear.
          await this.injectSubSessionMessage(
            sessionId,
            message,
            true,
            undefined,
            'immediate',
            'system'
          );
        },
        onHookStateUpdated: (hookId, hookState) => {
          this.config.internalEventBus
            ?.publish('space.hookState.updated', {
              sessionId: 'global',
              spaceId,
              runId: workflowRunId,
              hookId,
              hookState,
            })
            .catch((err: unknown) => {
              log.warn(
                `Failed to emit space.hookState.updated for hook ${hookId}: ${err instanceof Error ? err.message : String(err)}`
              );
            });
        },
      });
    }

    return createNodeAgentMcpServer({
      mySessionId: subSessionId,
      myAgentName: agentName,
      myAgentNameAliases: agentNameAliases,
      taskId,
      spaceId,
      channelResolver,
      workflowRunId,
      workflowNodeId,
      nodeExecutionRepo: this.config.nodeExecutionRepo,
      agentMessageRouter,
      internalEventBus: this.config.internalEventBus,
      workflow,
      onApproveTask,
      onSubmitForApproval,
      onMarkComplete,
      onCreateStandaloneTask,
      onPublishTask,
      onArchiveTask,
      onSubscribeExternalEvent,
      onUnsubscribeExternalEvent,
      onListSubscriptions,
      artifactRepo: this.config.artifactRepo,
      artifactProfile: this.config.artifactProfile,
      taskRepo: this.config.taskRepo,
      auditLogRepo: this.auditLogRepo,
      externalEventStore: this.config.externalEventStore,
      onRestoreNodeAgent,
      replyRoutingLookup: (fromAgentName) => {
        const registry = this.config.replyRoutingRegistry;
        return registry ? registry.get(taskId, fromAgentName) : null;
      },
      hookEngine,
    });
  }

  // -------------------------------------------------------------------------
  // Public — post-approval routing delegates (PR 2/5)
  // -------------------------------------------------------------------------

  /**
   * Deliver a post-approval node-agent handoff: reuse the target agent's live
   * session if it has one, otherwise spawn a fresh one — then inject the
   * kickoff instructions as the next user turn.
   *
   * Called by `PostApprovalRouter` when the workflow declares a
   * `postApproval.targetAgent` that is NOT `'task-agent'`. The flow:
   *
   *   1. Look up the agent slot in the workflow by name (matches against both
   *      slot.name and agent display name).
   *   2. If that agent already has a LIVE session, inject the kickoff straight
   *      into it. This bypasses `createSubSession`'s reuse path on purpose:
   *      that path rebuilds the node-agent MCP and calls `restartQuery()`,
   *      which interrupts an active drive (the #816 "Interrupted by user"
   *      failure). Direct injection never interrupts — it enqueues when busy
   *      and starts a fresh turn when idle.
   *   3. Otherwise build an `AgentSessionInit` (same resolver as a normal
   *      node-agent spawn), attach the `node-agent` MCP surface
   *      (`mark_complete` mirrored), create the session, and inject.
   *
   * The built-in `merger` target has no prior session, so it always creates;
   * the reuse branch only fires for workflows whose post-approval target is an
   * agent that already ran (e.g. a custom `targetAgent: 'reviewer'`).
   *
   * Returns `{ sessionId }`. The caller (router) stamps this onto
   * `space_tasks.post_approval_session_id` so the UI banner can render a
   * link + human operators have a jump-off point for manual abort.
   *
   * Failures throw; the router logs and surfaces `mode: 'skipped'` upstream.
   */
  async spawnPostApprovalSubSession(args: {
    task: SpaceTask;
    workflow: SpaceWorkflow;
    targetAgent: string;
    kickoffMessage: string;
  }): Promise<{ sessionId: string }> {
    const { task, workflow, targetAgent, kickoffMessage } = args;
    const taskId = task.id;
    const spaceId = task.spaceId;

    const space = await this.config.spaceManager.getSpace(spaceId);
    if (!space) {
      throw new Error(`spawnPostApprovalSubSession: space ${spaceId} not found for task ${taskId}`);
    }

    // Locate the declared agent slot across all nodes. `targetAgent` is validated
    // at workflow-save time to match a WorkflowNodeAgent.name; we also accept the
    // underlying agent's display name / id as a fallback for extra robustness.
    let matchedSlot: ReturnType<typeof resolveNodeAgents>[number] | null = null;
    let matchedNodeId: string | null = null;
    for (const node of workflow.nodes) {
      for (const slot of resolveNodeAgents(node)) {
        if (slot.name === targetAgent || slot.agentId === targetAgent) {
          matchedSlot = slot;
          matchedNodeId = node.id;
          break;
        }
      }
      if (matchedSlot) break;
    }
    if (!matchedSlot?.agentId || !matchedNodeId) {
      throw new Error(
        `spawnPostApprovalSubSession: no agent slot "${targetAgent}" declared in workflow ${workflow.id}`
      );
    }

    // Reuse-if-exists: if the target agent already has a LIVE session, inject
    // the kickoff straight into it. This deliberately bypasses createSubSession's
    // reuse path, which rebuilds the node-agent MCP server and calls
    // `restartQuery()` — interrupting the session if its drive is still active
    // (the #816 "Interrupted by user" failure). A direct inject never
    // interrupts: injectMessageIntoSession enqueues when busy and starts a
    // fresh turn when idle. The built-in `merger` target has no prior session,
    // so it falls through to the create branch below; this branch only fires
    // for workflows whose post-approval target is an agent that already ran.
    const existingSessionId = this.findLiveSubSessionForAgent(task, matchedSlot.name);
    if (existingSessionId) {
      const existing = this.getSubSession(existingSessionId);
      if (!existing) {
        throw new Error(
          `spawnPostApprovalSubSession: live session ${existingSessionId} for agent "${matchedSlot.name}" vanished before injection (task ${taskId})`
        );
      }
      // Stop synchronization for the reuse path too — a stop landing before
      // this injection must not drive a live session of a stopped space into
      // the merge (same deferral semantics as the create path below).
      await this.assertSpaceNotStoppedForSpawn(
        spaceId,
        `pre-kickoff (post-approval reuse), task ${taskId}`,
        { failClosed: true }
      );
      await this.injectMessageIntoSession(existing, kickoffMessage);
      log.info(
        `TaskAgentManager.spawnPostApprovalSubSession: reused live session ${existingSessionId} for agent "${matchedSlot.name}" (task ${taskId}, node ${matchedNodeId})`
      );
      return { sessionId: existingSessionId };
    }

    // No live session for this agent — create one and inject.
    const workflowRunId = task.workflowRunId;
    const workflowRun = workflowRunId ? this.config.workflowRunRepo.getRun(workflowRunId) : null;

    const workspacePath = this.taskWorktreePaths.get(taskId) ?? space.workspacePath;

    const matchedNode = workflow.nodes.find((node) => node.id === matchedNodeId);
    const slotOverrides = buildSlotOverrides(matchedSlot, {
      task,
      node: matchedNode,
      workflow,
      workflowRun: workflowRun ?? undefined,
    });

    const baseSessionId = `space:${spaceId}:task:${taskId}:post-approval:${this.sanitizeAgentNameForId(matchedSlot.name)}`;
    const sessionId = this.resolveSessionId(baseSessionId);

    let init = resolveAgentInit({
      task,
      space,
      agentManager: this.config.spaceAgentManager,
      sessionId,
      workspacePath,
      workflowRun: workflowRun ?? undefined,
      workflow,
      slotOverrides,
      agentId: matchedSlot.agentId,
    });

    const nodeAgentMcpServer = this.buildNodeAgentMcpServerForSession(
      taskId,
      sessionId,
      matchedSlot.name,
      spaceId,
      workflowRunId ?? '',
      workspacePath,
      matchedNodeId
    );
    init = {
      ...init,
      title: formatWorkflowNodeSessionTitle(task, matchedSlot.name),
      mcpServers: {
        ...init.mcpServers,
        'node-agent': nodeAgentMcpServer as unknown as McpServerConfig,
        // #852: a post-approval session carries no NodeExecution row and its id
        // has no `:exec:` segment, so resolveSpaceMcpSessionPolicy classifies it as
        // an ad-hoc Space member — and ensureMemberSpaceMcpInvariant therefore
        // REQUIRES `space-agent-tools` on it (same as any ad-hoc member). The spawn
        // previously attached only node-agent + agent-memory, so the merger's first
        // turn tripped the invariant and was misrecorded as "Interrupted by user".
        //
        // Attach via the SAME builder attachSpaceToolsToMemberSession uses (no
        // hand-rolled parallel server). init.mcpServers is merged into the session's
        // runtime MCP map inside createSubSession BEFORE startStreamingQuery, so the
        // server is present when runQuery runs the invariant at first turn — this is
        // race-free, unlike a post-create merge which can lose to runQuery's check.
        'space-agent-tools': this.config.spaceRuntimeService.buildMemberSpaceToolsMcpServer(
          space,
          sessionId
        ),
        ...this.buildAgentMemoryMcpServers(spaceId, sessionId),
      },
    };

    // From registration on, any abort must tear the session back down — the
    // same rollback shape as the node-spawn path: an idle registered session
    // that never received its kickoff would leak in the SessionManager cache
    // (and its DB row) until daemon restart, and the resume re-spawn never
    // reclaims it. Most notably a stop landing in the MCP-attach window throws
    // `TransientSpawnError`, which `dispatchPostApproval` converts into the
    // durable post-approval deferral (banner + resume re-drive). The try
    // wraps the createSubSession call itself: registration happens INSIDE it
    // (before its startStreamingQuery await), so a throw there must roll the
    // fresh registration back too. The session-id comparison is the
    // discriminator for both boundaries: a FRESH create registers under (and
    // returns) the proposed id, while the internal reuse branch returns a
    // PRE-EXISTING session under a different id (e.g. rehydrated after a
    // daemon restart) — that one belongs to the run, not this spawn, and is
    // never torn down here (the outer reuse path's no-teardown invariant).
    let actualSessionId = sessionId;
    try {
      actualSessionId = await this.createSubSession(taskId, sessionId, init, {
        agentId: matchedSlot.agentId,
        agentName: matchedSlot.name,
        nodeId: matchedNodeId,
      });

      const spawned = this.getSubSession(actualSessionId);
      if (!spawned) {
        throw new Error(
          `spawnPostApprovalSubSession: spawned session ${actualSessionId} not registered in memory`
        );
      }

      // #852: wire the Space-member MCP self-heal so a future regression (cache
      // eviction / DB reload dropping the in-process `space-agent-tools` server)
      // recovers via reattachMemberSpaceTools instead of tripping
      // ensureMemberSpaceMcpInvariant. Sub-sessions are created via
      // AgentSession.fromInit, which — unlike SessionManager.createAgentSessionFromSession
      // — does NOT wire this callback, so attach it explicitly here, mirroring what
      // attachSpaceToolsToMemberSession wires for normal ad-hoc members.
      spawned.onMissingMemberSpaceMcpServers = async (sid: string) => {
        await this.config.spaceRuntimeService.reattachMemberSpaceTools(sid);
      };

      await this.ensureNodeAgentAttached(spawned, {
        taskId,
        subSessionId: actualSessionId,
        agentName: matchedSlot.name,
        spaceId,
        workflowRunId: workflowRunId ?? '',
        workspacePath,
        workflowNodeId: matchedNodeId,
        phase: 'spawn',
      });

      // Stop synchronization for the merge kickoff: the awaits above (MCP
      // attach, invariant wiring) opened a window after the dispatch hold in
      // `dispatchPostApproval` passed — a stop landing there must not have the
      // merge instructions injected into the stopped space (and a live merger
      // here could complete an external PR merge despite the operator's stop).
      // Throws `TransientSpawnError`, which `dispatchPostApproval` converts
      // into a durable post-approval deferral (banner + resume re-drive).
      await this.assertSpaceNotStoppedForSpawn(
        spaceId,
        `pre-kickoff (post-approval), task ${taskId}`,
        { failClosed: true }
      );
      await this.injectMessageIntoSession(spawned, kickoffMessage);
    } catch (err) {
      // Fresh create (returned/threw under the proposed id) → roll it back;
      // pre-existing reused session (different id) → leave it to the run.
      // cancelBySessionId no-ops safely on an id nothing registered under.
      if (actualSessionId === sessionId) {
        this.cancelBySessionId(actualSessionId);
      }
      throw err;
    }

    log.info(
      `TaskAgentManager.spawnPostApprovalSubSession: spawned session ${actualSessionId} for agent "${matchedSlot.name}" (task ${taskId}, node ${matchedNodeId})`
    );
    return { sessionId: actualSessionId };
  }

  /**
   * Resolve the most recent in-memory (live) sub-session id for a given agent
   * slot in a task's workflow run, or null if there is none live.
   *
   * Used by `spawnPostApprovalSubSession` to decide reuse-vs-create. "Live"
   * means the session is currently held in memory (it ran this daemon lifetime).
   * A session that exists only in the DB (e.g. after a daemon restart) is NOT
   * returned here — `createSubSession` rehydrates it instead, which is safe
   * because a freshly-restored session has no active drive to interrupt.
   *
   * Candidate resolution mirrors `createSubSession`'s reuse path: the most
   * recent `node_executions` row for this agent with an `agentSessionId`.
   */
  private findLiveSubSessionForAgent(task: SpaceTask, agentName: string): string | null {
    if (!task.workflowRunId) return null;
    const prevExec = this.config.nodeExecutionRepo
      .listByWorkflowRun(task.workflowRunId)
      .filter((e) => e.agentName === agentName && e.agentSessionId)
      // listByWorkflowRun returns rows ORDER BY created_at ASC, so .at(-1) is the most recent.
      .at(-1);
    const candidateId = prevExec?.agentSessionId ?? null;
    if (!candidateId) return null;
    return this.getSubSession(candidateId) ? candidateId : null;
  }
}
