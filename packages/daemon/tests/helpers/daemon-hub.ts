/**
 * DaemonHub - Type-safe event hub for daemon internal coordination
 *
 * Replaces EventBus with TypedHub for:
 * - Async-everywhere design (future cluster-ready)
 * - Same type-safe API
 * - Session-scoped subscriptions with O(1) lookup
 *
 * EVENT NAMING: Uses dots (.) instead of colons (:)
 * - EventBus: 'session:created'
 * - DaemonHub: 'session.created'
 */

import { TypedHub, type BaseEventData } from '@hyperneo/shared';
import type {
  Session,
  AuthMethod,
  ContextInfo,
  MessageContent,
  MessageDeliveryMode,
  MessageImage,
  GlobalSettings,
  AgentProcessingState,
  ApiConnectionState,
  PendingUserQuestion,
  RewindMode,
  RewindResult,
} from '@hyperneo/shared';
import type { SDKMessage } from '@hyperneo/shared/sdk';
import type { NeoTask, Room, RoomGoal, RuntimeState } from '@hyperneo/shared/types/neo';

/**
 * Compaction trigger type
 */
export type CompactionTrigger = 'manual' | 'auto';

/**
 * Daemon event map - all events must include sessionId
 *
 * Design principle: Publishers include their data in events.
 * StateManager maintains its own state from events (no fetching from sources).
 */
export interface DaemonEventMap extends Record<string, BaseEventData> {
  // Session lifecycle events
  'session.created': { sessionId: string; session: Session };
  'session.updated': {
    sessionId: string;
    source?: string;
    session?: Partial<Session>;
    processingState?: AgentProcessingState;
  };
  'session.deleted': { sessionId: string };
  'session.reset': { sessionId: string; session: Session; restartQuery: boolean };

  // SDK events — message may carry a hyperneo-injected `timestamp` from the DB layer.
  // The SDK defines timestamp?: string (ISO 8601) on user messages; the daemon overrides it
  // with a number (epoch ms) when replaying persisted messages. The intersection keeps both
  // possibilities visible to future subscribers so they know to handle either form.
  'sdk.message': { sessionId: string; message: SDKMessage & { timestamp?: number | string } };

  // Auth events (global events - use 'global' as sessionId)
  'auth.changed': {
    sessionId: string;
    method: AuthMethod;
    isAuthenticated: boolean;
  };

  // API connection events - internal server-side only (global events)
  'api.connection': { sessionId: string } & ApiConnectionState;

  // Settings events (global events - use 'global' as sessionId)
  /**
   * MIGRATED: `settings.updated` is now published/subscribed through
   * `InternalEventBus` (see `DaemonInternalEventMap` in internal-event-bus.ts).
   * This entry remains in `DaemonEventMap` for backward compatibility but new
   * code should use `InternalEventBus` directly.
   */
  'settings.updated': { sessionId: string; settings: GlobalSettings };

  // Commands events
  'commands.updated': { sessionId: string; commands: string[] };

  // Context events - real-time context window usage tracking
  'context.updated': { sessionId: string; contextInfo: ContextInfo };

  // Compaction events
  'context.compacting': { sessionId: string; trigger: CompactionTrigger };
  'context.compacted': {
    sessionId: string;
    trigger: CompactionTrigger;
    preTokens: number;
  };

  // Session error events
  'session.error': { sessionId: string; error: string; details?: unknown };
  'session.errorClear': { sessionId: string };

  // API retry events
  'session.retryAttempt': {
    sessionId: string;
    attempt: number;
    max_retries: number;
    delay_ms: number;
    error_status: number | null;
    error: string;
  };

  // Message events
  'message.sent': { sessionId: string };

  // Title generation events
  'title.generated': { sessionId: string; title: string };
  'title.generationFailed': {
    sessionId: string;
    error: Error;
    attempts: number;
  };

  // AskUserQuestion events
  'question.asked': {
    sessionId: string;
    pendingQuestion: PendingUserQuestion;
  };
  /**
   * Emitted when a pending question is cleaned up because its owning session
   * ended (force-completion, rehydrate failure, daemon shutdown). The card
   * is flipped to a `cancelled` ResolvedQuestion with cancelReason
   * `agent_session_terminated` so the UI can render it distinctly.
   */
  'question.orphaned': {
    sessionId: string;
    toolUseId: string;
    reason: 'agent_session_terminated' | 'rehydrate_failed';
  };
  /**
   * Emitted when an AskUserQuestion answer is delivered after the original
   * in-memory interception resolver was lost (e.g. daemon restart) — the
   * resolver is stored by the channel-agnostic interception core (PreToolUse
   * hook or canUseTool). Helps verify the restart-survival path works in
   * production.
   */
  'question.injected_as_tool_result': {
    sessionId: string;
    toolUseId: string;
    mode: 'submitted' | 'cancelled';
    /**
     * How the answer reached the SDK: consumed by a re-played live
     * interception (PreToolUse hook or canUseTool callback), or delivered via
     * the synthetic tool_result injection used on the post-restart path.
     */
    via: 'can_use_tool' | 'pre_tool_use_hook' | 'tool_result';
  };

  // User message processing events (3-layer communication pattern)
  'userMessage.persisted': {
    sessionId: string;
    messageId: string;
    messageContent: string | MessageContent[];
    userMessageText: string;
    needsWorkspaceInit: boolean;
    hasDraftToClear: boolean;
    skipQueryStart?: boolean;
  };

  // Model switch events
  'model.switchRequest': { sessionId: string; model: string; provider: string };
  'model.switched': {
    sessionId: string;
    success: boolean;
    model: string;
    error?: string;
  };

  // Interrupt events
  'agent.interruptRequest': { sessionId: string };
  'agent.interrupted': { sessionId: string };

  // Reset events
  'agent.resetRequest': { sessionId: string; restartQuery?: boolean };
  'agent.reset': { sessionId: string; success: boolean; error?: string };
  'agent.restart': { sessionId: string; success: boolean; error?: string };

  'message.persisted': {
    sessionId: string;
    messageId: string;
    messageContent: string | MessageContent[];
    userMessageText: string;
    needsWorkspaceInit: boolean;
    hasDraftToClear: boolean;
    sendStatus: 'deferred' | 'enqueued' | 'consumed';
    deliveryMode: MessageDeliveryMode;
    skipQueryStart?: boolean;
  };

  // Query mode events
  // Trigger to send deferred messages (manual mode)
  'query.trigger': { sessionId: string };
  // Notification when message statuses change
  'messages.statusChanged': {
    sessionId: string;
    messageIds: string[];
    status: 'deferred' | 'enqueued' | 'consumed' | 'failed';
  };

  // Rewind events
  'rewind.started': {
    sessionId: string;
    checkpointId: string;
    mode: RewindMode;
  };
  'rewind.completed': {
    sessionId: string;
    checkpointId: string;
    mode: RewindMode;
    result: RewindResult;
  };
  'rewind.failed': {
    sessionId: string;
    checkpointId: string;
    mode: RewindMode;
    error: string;
  };

  // Room events (global events - use 'global' as sessionId)
  'room.created': { sessionId: string; roomId: string; room: Room };
  'room.updated': { sessionId: string; roomId: string; room?: Partial<Room> };
  'room.archived': { sessionId: string; roomId: string };
  'room.deleted': { sessionId: string; roomId: string };
  // Room channel events (emitted to room:${roomId} channel via sessionId)
  // UI subscribes to these for real-time updates
  // sessionId is set to 'room:${roomId}' for channel routing
  'room.overview': {
    sessionId: string; // 'room:${roomId}' for channel routing
    room: Room;
    sessions: { id: string; title: string; status: string; lastActiveAt: number }[];
  };
  'room.runtime.stateChanged': {
    sessionId: string; // 'room:${roomId}' for channel routing
    roomId: string;
    state: RuntimeState;
  };
  'room.task.update': {
    sessionId: string; // 'room:${roomId}' for channel routing
    roomId: string;
    task: NeoTask;
  };

  // Legacy task events (kept for backward compatibility)
  'task.created': { sessionId: string; roomId: string; taskId: string; task: NeoTask };
  'task.updated': {
    sessionId: string;
    roomId: string;
    taskId: string;
    task?: Partial<NeoTask>;
  };

  // Room message events (for room chat)
  'room.message': {
    sessionId: string;
    roomId: string;
    message: {
      id: string;
      role: string;
      content: string;
      timestamp: number;
    };
    sender?: string;
  };

  // Worker events (Manager-less Architecture v1.0)
  'worker.started': {
    sessionId: string;
    roomId: string;
    taskId: string;
  };
  'worker.task_completed': {
    sessionId: string;
    taskId: string;
    summary: string;
    filesChanged?: string[];
    nextSteps?: string[];
  };
  'worker.review_requested': {
    sessionId: string;
    taskId: string;
    reason: string;
  };
  'worker.failed': {
    sessionId: string;
    taskId: string;
    error: string;
  };

  // Lobby events (for lobby manager chat)
  'lobby.message': {
    sessionId: string;
    message: {
      id: string;
      role: 'user' | 'assistant';
      content: string;
      images?: MessageImage[];
      timestamp: string;
    };
  };

  // GitHub integration events
  'github.roomMappingUpdated': {
    sessionId: string;
    roomId: string;
    mapping: import('@hyperneo/shared').RoomGitHubMapping;
  };
  'github.roomMappingDeleted': {
    sessionId: string;
    roomId: string;
  };
  'github.inboxItemRouted': {
    sessionId: string;
    item: import('@hyperneo/shared').InboxItem;
    roomId: string;
  };
  'github.inboxItemDismissed': {
    sessionId: string;
    itemId: string;
  };
  'github.filterConfigUpdated': {
    sessionId: string;
    repository?: string;
    config: import('@hyperneo/shared').GitHubFilterConfig;
  };
  'github.eventReceived': {
    sessionId: string;
    event: import('./github/types').GitHubEvent;
  };
  'github.eventFiltered': {
    sessionId: string;
    eventId: string;
    reason?: string;
  };
  'github.eventSecurityFailed': {
    sessionId: string;
    eventId: string;
    securityResult: import('@hyperneo/shared').SecurityCheckResult;
  };
  'github.eventRouted': {
    sessionId: string;
    eventId: string;
    roomId: string;
    confidence: 'high' | 'medium' | 'low';
    reason: string;
  };
  'github.inboxItemAdded': {
    sessionId: string;
    item: import('@hyperneo/shared').InboxItem;
    reason: string;
  };
  'github.eventError': {
    sessionId: string;
    eventId: string;
    error: string;
    inboxItemId: string;
  };

  // App-level MCP registry events
  /**
   * Emitted by app-mcp-handlers on create/update/delete/setEnabled.
   * Used by SpaceRuntimeService for hot-reload of MCP server lists.
   * This is separate from LiveQuery — both are emitted on every write.
   */
  'mcp.registry.changed': {
    sessionId: string;
  };

  // Goal events
  'goal.created': {
    sessionId: string;
    roomId: string;
    goalId: string;
    goal: RoomGoal;
  };
  /** Emitted when a coder/general task completes without human review (semi-autonomous or no-pr mode) */
  'goal.task.auto_completed': {
    sessionId: string; // 'room:${roomId}' for channel routing
    roomId: string;
    goalId: string;
    taskId: string;
    taskTitle: string;
    prUrl: string;
    approvalSource: 'leader_semi_auto' | 'leader_no_pr';
  };
  'goal.updated': {
    sessionId: string;
    roomId: string;
    goalId: string;
    goal?: Partial<RoomGoal>;
  };
  'goal.progressUpdated': {
    sessionId: string;
    roomId: string;
    goalId: string;
    progress: number;
  };
  'goal.completed': {
    sessionId: string;
    roomId: string;
    goalId: string;
    goal: RoomGoal;
  };

  // Lobby Agent events (for external message processing)
  'lobby.messageReceived': {
    sessionId: string;
    message: import('./lobby/types').ExternalMessage;
  };
  'lobby.messageRouted': {
    sessionId: string;
    messageId: string;
    roomId: string;
    confidence: 'high' | 'medium' | 'low';
    reason: string;
  };
  'lobby.messageToInbox': {
    sessionId: string;
    messageId: string;
    reason: string;
  };
  'lobby.messageRejected': {
    sessionId: string;
    messageId: string;
    reason: string;
  };
  'lobby.messageSecurityFailed': {
    sessionId: string;
    messageId: string;
    securityCheck: import('./lobby/types').ExternalSecurityCheck;
  };

  // Prompt Template events
  'promptTemplate.updated': {
    sessionId: string;
    templateId: string;
    version: number;
  };
  'promptTemplate.deleted': {
    sessionId: string;
    templateId: string;
  };
  'promptTemplate.roomUpdated': {
    sessionId: string;
    roomId: string;
    templateId: string;
  };

  // Space events (global events - use 'global' as sessionId)
  'space.created': { sessionId: string; spaceId: string; space: import('@hyperneo/shared').Space };
  'space.updated': {
    sessionId: string;
    spaceId: string;
    space?: Partial<import('@hyperneo/shared').Space>;
  };
  'space.archived': { sessionId: string; spaceId: string; space: import('@hyperneo/shared').Space };
  'space.deleted': { sessionId: string; spaceId: string };

  // Space task events (global events - use 'global' as sessionId)
  'space.task.created': {
    sessionId: string;
    spaceId: string;
    taskId: string;
    task: import('@hyperneo/shared').SpaceTask;
  };
  'space.task.updated': {
    sessionId: string;
    spaceId: string;
    taskId: string;
    task: import('@hyperneo/shared').SpaceTask;
    /**
     * Task #85: origin marker for transitions that set `status='archived'`.
     * - `'user'` (or absent) — originates from a UI archive action; the
     *   `TaskAgentManager` archive listener MUST run its cleanup cascade
     *   (remove worktree + archive SDK `.jsonl` files).
     * - `'system_reconcile'` — originates from an automated duplicate-run
     *   repair. DB rows + sdk_messages are preserved, but the cleanup
     *   cascade MUST be skipped so automated reconciliation never removes
     *   on-disk artifacts the user didn't ask to remove.
     *
     * Irrelevant for non-archived transitions.
     */
    archiveSource?: 'user' | 'system_reconcile';
  };

  // Space schedule events (global events - use 'global' as sessionId)
  'space.schedule.updated': {
    sessionId: string;
    spaceId: string;
    scheduleId: string;
    schedule: import('@hyperneo/shared').TaskSchedule;
  };

  // Space Task Agent completion events (use 'global' as sessionId)
  /** Emitted when a Task Agent marks a task as done via `task.reportedStatus`. */
  'space.task.done': {
    sessionId: string;
    taskId: string;
    spaceId: string;
    status: string;
    summary: string;
    workflowRunId: string;
    taskTitle: string;
  };
  /**
   * Emitted when a Task Agent marks a task as needs_attention or cancelled via
   * `task.reportedStatus`.
   */
  'space.task.failed': {
    sessionId: string;
    taskId: string;
    spaceId: string;
    status: string;
    summary: string;
    workflowRunId: string;
    taskTitle: string;
  };

  // Space workflow run events (global events - use 'global' as sessionId)
  'space.workflowRun.created': {
    sessionId: string;
    spaceId: string;
    runId: string;
    run: import('@hyperneo/shared').SpaceWorkflowRun;
  };
  'space.workflowRun.updated': {
    sessionId: string;
    spaceId: string;
    runId: string;
    run?: Partial<import('@hyperneo/shared').SpaceWorkflowRun>;
  };
  /** Emitted when gate data changes (agent write_gate, or human approveGate). */
  'space.gateData.updated': {
    sessionId: string;
    spaceId: string;
    runId: string;
    gateId: string;
    data: Record<string, unknown>;
  };
  /**
   * Emitted when channel cycle counters for a workflow run are reset to 0.
   *
   * Currently fired when a human sends a message to a task in the run via
   * `space.task.sendMessage` ("human touch"). `rowsReset` is the number of
   * `channel_cycles` rows actually zeroed — it may be 0 if no cyclic channels
   * had traversed yet at the time of the reset.
   */
  'space.workflowRun.cyclesReset': {
    sessionId: string;
    runId: string;
    reason: 'human_touch';
    taskId?: string;
    rowsReset: number;
  };
  /**
   * Emitted when a workflow_run_artifact_cache row has been written by a
   * background sync job (spaceWorkflowRun.syncGateArtifacts, syncCommits,
   * syncFileDiff). The frontend TaskArtifactsPanel subscribes and refetches
   * the affected cache entry instead of relying on polling.
   */
  'space.artifactCache.updated': {
    sessionId: string;
    spaceId: string;
    runId: string;
    /** Task id (may be empty string when the entry is run-level). */
    taskId: string;
    cacheKey: string;
    status: 'ok' | 'syncing' | 'error';
  };

  // Pending agent message events (queue-until-active)
  // See packages/daemon/src/storage/repositories/pending-agent-message-repository.ts
  /** Emitted when a Task Agent's send_message is queued because the target is not yet active. */
  'space.pendingMessage.queued': {
    sessionId: string;
    spaceId: string;
    workflowRunId: string;
    taskId: string | null;
    targetAgentName: string;
    targetKind: 'node_agent' | 'space_agent';
    messageId: string;
    attempts: number;
    maxAttempts: number;
    expiresAt: number;
    deduped: boolean;
  };
  /** Emitted when a queued pending message is flushed to the target session. */
  'space.pendingMessage.delivered': {
    sessionId: string;
    spaceId: string;
    workflowRunId: string;
    targetAgentName: string;
    targetKind: string;
    messageId: string;
    deliveredSessionId: string;
  };

  // Space Agent events (channel: 'space:${spaceId}')
  'spaceAgent.created': {
    sessionId: string;
    spaceId: string;
    agent: import('@hyperneo/shared').SpaceWorkerAgent;
  };
  'spaceAgent.updated': {
    sessionId: string;
    spaceId: string;
    agent: import('@hyperneo/shared').SpaceWorkerAgent;
  };
  'spaceAgent.deleted': {
    sessionId: string;
    spaceId: string;
    agentId: string;
  };

  // Space workflow definition events (global events - use 'global' as sessionId)
  // NOTE: namespace is 'spaceWorkflow.*' (not 'space.workflow.*') — matches SpaceStore subscriptions in M5
  'spaceWorkflow.created': {
    sessionId: string;
    spaceId: string;
    workflow: import('@hyperneo/shared').SpaceWorkflow;
  };
  'spaceWorkflow.updated': {
    sessionId: string;
    spaceId: string;
    workflow: import('@hyperneo/shared').SpaceWorkflow;
  };
  'spaceWorkflow.deleted': {
    sessionId: string;
    spaceId: string;
    workflowId: string;
  };

  // Feature Flag events (PHASE 3: Gradual rollout infrastructure)
  'featureFlag.updated': {
    sessionId: string;
    flagName: string;
    updates: { enabled?: boolean; rolloutPercentage?: number };
  };
  'featureFlag.rolloutChanged': {
    sessionId: string;
    flagName: string;
    percentage: number;
  };
  'featureFlag.roomWhitelisted': {
    sessionId: string;
    flagName: string;
    roomId: string;
  };
  'featureFlag.roomBlacklisted': {
    sessionId: string;
    flagName: string;
    roomId: string;
  };
}

/**
 * Create a new DaemonHub instance
 * Each component that needs event coordination should use this
 */
export function createDaemonHub(name: string = 'daemon'): TypedHub<DaemonEventMap> {
  return new TypedHub<DaemonEventMap>({ name });
}

/**
 * Type alias for cleaner imports
 */
export type DaemonHub = TypedHub<DaemonEventMap>;
