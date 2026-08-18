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

export type CompactionTrigger = 'manual' | 'auto';

export interface DaemonEventMap extends Record<string, BaseEventData> {
  'session.created': { sessionId: string; session: Session };
  'session.updated': {
    sessionId: string;
    source?: string;
    session?: Partial<Session>;
    processingState?: AgentProcessingState;
  };
  'session.deleted': { sessionId: string };
  'session.reset': { sessionId: string; session: Session; restartQuery: boolean };

  'sdk.message': { sessionId: string; message: SDKMessage & { timestamp?: number | string } };

  'auth.changed': {
    sessionId: string;
    method: AuthMethod;
    isAuthenticated: boolean;
  };

  'api.connection': { sessionId: string } & ApiConnectionState;

  'settings.updated': { sessionId: string; settings: GlobalSettings };

  'commands.updated': { sessionId: string; commands: string[] };

  'context.updated': { sessionId: string; contextInfo: ContextInfo };

  'context.compacting': { sessionId: string; trigger: CompactionTrigger };
  'context.compacted': {
    sessionId: string;
    trigger: CompactionTrigger;
    preTokens: number;
  };

  'session.error': { sessionId: string; error: string; details?: unknown };
  'session.errorClear': { sessionId: string };

  'session.retryAttempt': {
    sessionId: string;
    attempt: number;
    max_retries: number;
    delay_ms: number;
    error_status: number | null;
    error: string;
  };

  'message.sent': { sessionId: string };

  'title.generated': { sessionId: string; title: string };
  'title.generationFailed': {
    sessionId: string;
    error: Error;
    attempts: number;
  };

  'question.asked': {
    sessionId: string;
    pendingQuestion: PendingUserQuestion;
  };
  'question.orphaned': {
    sessionId: string;
    toolUseId: string;
    reason: 'agent_session_terminated' | 'rehydrate_failed';
  };
  'question.injected_as_tool_result': {
    sessionId: string;
    toolUseId: string;
    mode: 'submitted' | 'cancelled';
    via: 'can_use_tool' | 'pre_tool_use_hook' | 'tool_result';
  };

  'userMessage.persisted': {
    sessionId: string;
    messageId: string;
    messageContent: string | MessageContent[];
    userMessageText: string;
    needsWorkspaceInit: boolean;
    hasDraftToClear: boolean;
    skipQueryStart?: boolean;
  };

  'model.switchRequest': { sessionId: string; model: string; provider: string };
  'model.switched': {
    sessionId: string;
    success: boolean;
    model: string;
    error?: string;
  };

  'agent.interruptRequest': { sessionId: string };
  'agent.interrupted': { sessionId: string };

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

  'query.trigger': { sessionId: string };
  'messages.statusChanged': {
    sessionId: string;
    messageIds: string[];
    status: 'deferred' | 'enqueued' | 'consumed' | 'failed';
  };

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

  'room.created': { sessionId: string; roomId: string; room: Room };
  'room.updated': { sessionId: string; roomId: string; room?: Partial<Room> };
  'room.archived': { sessionId: string; roomId: string };
  'room.deleted': { sessionId: string; roomId: string };
  'room.overview': {
    sessionId: string;
    room: Room;
    sessions: { id: string; title: string; status: string; lastActiveAt: number }[];
  };
  'room.runtime.stateChanged': {
    sessionId: string;
    roomId: string;
    state: RuntimeState;
  };
  'room.task.update': {
    sessionId: string;
    roomId: string;
    task: NeoTask;
  };

  'task.created': { sessionId: string; roomId: string; taskId: string; task: NeoTask };
  'task.updated': {
    sessionId: string;
    roomId: string;
    taskId: string;
    task?: Partial<NeoTask>;
  };

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

  'mcp.registry.changed': {
    sessionId: string;
  };

  'goal.created': {
    sessionId: string;
    roomId: string;
    goalId: string;
    goal: RoomGoal;
  };
  'goal.task.auto_completed': {
    sessionId: string;
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

  'space.created': { sessionId: string; spaceId: string; space: import('@hyperneo/shared').Space };
  'space.updated': {
    sessionId: string;
    spaceId: string;
    space?: Partial<import('@hyperneo/shared').Space>;
  };
  'space.archived': { sessionId: string; spaceId: string; space: import('@hyperneo/shared').Space };
  'space.deleted': { sessionId: string; spaceId: string };

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
    archiveSource?: 'user' | 'system_reconcile';
  };

  'space.schedule.updated': {
    sessionId: string;
    spaceId: string;
    scheduleId: string;
    schedule: import('@hyperneo/shared').TaskSchedule;
  };

  'space.task.done': {
    sessionId: string;
    taskId: string;
    spaceId: string;
    status: string;
    summary: string;
    workflowRunId: string;
    taskTitle: string;
  };
  'space.task.failed': {
    sessionId: string;
    taskId: string;
    spaceId: string;
    status: string;
    summary: string;
    workflowRunId: string;
    taskTitle: string;
  };

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
  'space.gateData.updated': {
    sessionId: string;
    spaceId: string;
    runId: string;
    gateId: string;
    data: Record<string, unknown>;
  };
  'space.workflowRun.cyclesReset': {
    sessionId: string;
    runId: string;
    reason: 'human_touch';
    taskId?: string;
    rowsReset: number;
  };
  'space.artifactCache.updated': {
    sessionId: string;
    spaceId: string;
    runId: string;
    taskId: string;
    cacheKey: string;
    status: 'ok' | 'syncing' | 'error';
  };

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
  'space.pendingMessage.delivered': {
    sessionId: string;
    spaceId: string;
    workflowRunId: string;
    targetAgentName: string;
    targetKind: string;
    messageId: string;
    deliveredSessionId: string;
  };

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

export function createDaemonHub(name: string = 'daemon'): TypedHub<DaemonEventMap> {
  return new TypedHub<DaemonEventMap>({ name });
}

export type DaemonHub = TypedHub<DaemonEventMap>;
