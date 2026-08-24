import type { GlobalSettings } from '@hyperneo/shared';
import type { ExternalEventPublishedPayload } from './external-events/external-event-service.ts';

export interface HandlerFailure {
  subscriberName: string;

  event: string;

  error: Error;
}

export interface PublishResult {
  delivered: number;

  failures: HandlerFailure[];
}

export class InternalEventBusPublishError extends Error {
  constructor(
    public readonly event: string,
    public readonly result: PublishResult
  ) {
    super(
      `Publish of '${event}' failed with ${result.failures.length} handler failure(s) ` +
        `(${result.delivered} succeeded)`
    );
    this.name = 'InternalEventBusPublishError';
  }
}

export interface InternalEventPayload {
  sessionId?: string;
  namespaceId?: string;

  [key: string]: unknown;
}

export interface SubscribeOptions {
  subscriberName: string;

  sessionId?: string;
  namespaceId?: string;
}

export type InternalEventHandler<TPayload> = (data: TPayload) => void | Promise<void>;

interface RegisteredHandler {
  subscriberName: string;
  handler: (data: unknown) => void | Promise<void>;
}

const GLOBAL_SESSION_KEY = '__global__';

export class InternalEventBus<TEventMap extends object = Record<string, InternalEventPayload>> {
  private handlers = new Map<string, Map<string, Set<RegisteredHandler>>>();

  subscribe<K extends keyof TEventMap & string>(
    event: K,
    handler: InternalEventHandler<TEventMap[K] & InternalEventPayload>,
    options: SubscribeOptions
  ): () => void {
    const eventKey = event;
    const sessionKey = options.sessionId ?? options.namespaceId ?? GLOBAL_SESSION_KEY;

    if ((options.sessionId ?? options.namespaceId) === GLOBAL_SESSION_KEY) {
      throw new Error(
        `'${GLOBAL_SESSION_KEY}' is a reserved session key and cannot be used as an explicit sessionId`
      );
    }

    if (!options.subscriberName || options.subscriberName.trim().length === 0) {
      throw new Error('InternalEventBus.subscribe requires a non-empty subscriberName');
    }

    let sessionMap = this.handlers.get(eventKey);
    if (!sessionMap) {
      sessionMap = new Map();
      this.handlers.set(eventKey, sessionMap);
    }

    let handlerSet = sessionMap.get(sessionKey);
    if (!handlerSet) {
      handlerSet = new Set();
      sessionMap.set(sessionKey, handlerSet);
    }

    const registered: RegisteredHandler = {
      subscriberName: options.subscriberName,
      handler: handler as (data: unknown) => void | Promise<void>,
    };

    handlerSet.add(registered);

    return () => {
      const map = this.handlers.get(eventKey);
      if (!map) return;
      const set = map.get(sessionKey);
      if (!set) return;
      set.delete(registered);
      if (set.size === 0) map.delete(sessionKey);
      if (map.size === 0) this.handlers.delete(eventKey);
    };
  }

  async publish<K extends keyof TEventMap & string>(
    event: K,
    data: TEventMap[K] & InternalEventPayload
  ): Promise<PublishResult> {
    const eventKey = event;
    const sessionMap = this.handlers.get(eventKey);

    if (!sessionMap || sessionMap.size === 0) {
      return { delivered: 0, failures: [] };
    }

    const sessionId = data.sessionId ?? data.namespaceId ?? GLOBAL_SESSION_KEY;
    const failures: HandlerFailure[] = [];
    let delivered = 0;

    const targets: RegisteredHandler[] = [];

    const scoped = sessionMap.get(sessionId);
    if (scoped) {
      for (const h of scoped) targets.push(h);
    }

    if (sessionId !== GLOBAL_SESSION_KEY) {
      const global = sessionMap.get(GLOBAL_SESSION_KEY);
      if (global) {
        for (const h of global) targets.push(h);
      }
    }

    if (targets.length === 0) {
      return { delivered: 0, failures: [] };
    }

    await Promise.all(
      targets.map(async (registered) => {
        try {
          await registered.handler(data);
          delivered++;
        } catch (raw) {
          const error = raw instanceof Error ? raw : new Error(String(raw));
          failures.push({
            subscriberName: registered.subscriberName,
            event: eventKey,
            error,
          });
        }
      })
    );

    const result: PublishResult = { delivered, failures };

    if (failures.length > 0) {
      throw new InternalEventBusPublishError(eventKey, result);
    }

    return result;
  }

  publishAsync<K extends keyof TEventMap & string>(
    event: K,
    data: TEventMap[K] & InternalEventPayload
  ): void {
    queueMicrotask(() => {
      this.publish(event, data).catch(() => {});
    });
  }

  off<K extends keyof TEventMap & string>(event: K): void {
    this.handlers.delete(event);
  }

  clear(): void {
    this.handlers.clear();
  }

  getHandlerCount<K extends keyof TEventMap & string>(event: K): number {
    const sessionMap = this.handlers.get(event);
    if (!sessionMap) return 0;
    let total = 0;
    for (const set of sessionMap.values()) {
      total += set.size;
    }
    return total;
  }

  getHandlerCountForSession<K extends keyof TEventMap & string>(
    event: K,
    sessionId: string
  ): number {
    const sessionMap = this.handlers.get(event);
    if (!sessionMap) return 0;
    return sessionMap.get(sessionId)?.size ?? 0;
  }

  getHandlerCountForNamespace<K extends keyof TEventMap & string>(
    event: K,
    namespaceId: string
  ): number {
    return this.getHandlerCountForSession(event, namespaceId);
  }
}

export function createInternalEventBus<
  TEventMap extends object = Record<string, InternalEventPayload>,
>(): InternalEventBus<TEventMap> {
  return new InternalEventBus<TEventMap>();
}

export interface SettingsUpdatedEvent {
  sessionId?: string;
  namespaceId?: string;
  settings: GlobalSettings;
}

export interface SettingsEvents {
  'settings.updated': SettingsUpdatedEvent;
}

export interface ExternalEventEvents {
  'externalEvent.published': ExternalEventPublishedPayload;
}

export interface SessionEvents {
  'sdk.toolUse.created': {
    sessionId: string;
    toolUseId: string;
    toolName: string;
    timestamp: number;
  };
  'sdk.toolUse.consumed': {
    sessionId: string;
    toolUseId: string;
    timestamp: number;
  };
  'session.created': { sessionId: string; session: import('@hyperneo/shared').Session };
  'session.updated': {
    sessionId: string;
    source?: string;
    session?: Partial<import('@hyperneo/shared').Session>;
    processingState?: import('@hyperneo/shared').AgentProcessingState;
  };
  'session.deleted': { sessionId: string };
  'commands.updated': { sessionId: string; commands: string[] };
  'session.error': { sessionId: string; error: string; details?: unknown };
  'session.errorObserved': { sessionId: string; details: unknown };
  'session.errorClear': { sessionId: string };
  'session.rate_limit_pause': {
    sessionId: string;
    kind: 'rate_limit' | 'usage_limit';
    resetAt?: number;
    reason: string;
  };
  'session.rate_limit_resume': { sessionId: string };
}

export interface ApiConnectionEvents {
  'api.connection': { sessionId: string } & import('@hyperneo/shared').ApiConnectionState;
}

export interface SpaceTaskBlockedEvent {
  sessionId: string;
  spaceId: string;
  taskId: string;
  reason: string;
  timestamp: string;
}

export interface SpaceTaskUnblockedEvent {
  sessionId: string;
  spaceId: string;
  taskId: string;
  reason: string;
  timestamp: string;
}

export interface SpaceTaskCompletedEvent {
  sessionId: string;
  spaceId: string;
  taskId: string;
  status: 'done' | 'cancelled' | 'blocked';
  timestamp: string;
}

export interface SpaceTaskFailedEvent {
  sessionId: string;
  spaceId: string;
  taskId: string;
  reason: string;
  timestamp: string;
}

export interface SpaceAgentCrashedEvent {
  sessionId: string;
  spaceId: string;
  taskId: string;
  timestamp: string;
}

export interface SpaceAgentRecoveredEvent {
  sessionId: string;
  spaceId: string;
  taskId: string;
  timestamp: string;
}

export interface SpaceWorkflowRunCompletedEvent {
  sessionId: string;
  spaceId: string;
  runId: string;
  status: 'done' | 'cancelled' | 'blocked';
  summary?: string;
  timestamp: string;
}

export interface SpaceWorkflowRunFailedEvent {
  sessionId: string;
  spaceId: string;
  runId: string;
  reason: string;
  timestamp: string;
}

export interface SpaceWorkflowRunBlockedEvent {
  sessionId: string;
  spaceId: string;
  runId: string;
  reason: string;
  timestamp: string;
}

export interface SpaceWorkflowRunReopenedEvent {
  sessionId?: string;
  namespaceId?: string;
  spaceId: string;
  runId: string;
  fromStatus: 'done' | 'cancelled' | 'blocked';
  reason: string;
  by: string;
  timestamp: string;
}

export interface SpaceWorkflowRunDeadLoopEvent {
  sessionId?: string;
  namespaceId?: string;
  spaceId: string;
  runId: string;
  fromAgent: string;
  toTarget: string;
  channelIndex: number;
  recentCount: number;
  threshold: number;
  windowMs: number;
  reason: string;
  timestamp: string;
}

export interface SpaceWorkflowRunRetryEvent {
  sessionId: string;
  spaceId: string;
  taskId: string;
  runId: string;
  originalReason: string;
  attemptNumber: number;
  maxAttempts: number;
  timestamp: string;
}

export interface SpaceWorkflowRunNeedsAttentionEvent {
  sessionId: string;
  spaceId: string;
  runId: string;
  taskId: string;
  reason: string;
  retriesExhausted: number;
  timestamp: string;
  handledBySpaceService?: boolean;
}

export interface SpaceTaskAwaitingApprovalEvent {
  sessionId: string;
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
}

export interface SpaceTaskTimeoutEvent {
  sessionId: string;
  spaceId: string;
  taskId: string;
  elapsedMs: number;
  timestamp: string;
}

export interface SpaceEvents {
  'space.task.blocked': SpaceTaskBlockedEvent;
  'space.task.unblocked': SpaceTaskUnblockedEvent;
  'space.task.completed': SpaceTaskCompletedEvent;
  'space.task.failed': SpaceTaskFailedEvent;
  'space.agent.crashed': SpaceAgentCrashedEvent;
  'space.agent.recovered': SpaceAgentRecoveredEvent;
  'space.workflowRun.completed': SpaceWorkflowRunCompletedEvent;
  'space.workflowRun.failed': SpaceWorkflowRunFailedEvent;
  'space.workflowRun.blocked': SpaceWorkflowRunBlockedEvent;
  'space.workflowRun.reopened': SpaceWorkflowRunReopenedEvent;
  'space.workflowRun.deadLoop': SpaceWorkflowRunDeadLoopEvent;
  'space.workflowRun.retry': SpaceWorkflowRunRetryEvent;
  'space.workflowRun.needsAttention': SpaceWorkflowRunNeedsAttentionEvent;
  'space.task.awaitingApproval': SpaceTaskAwaitingApprovalEvent;
  'space.task.timeout': SpaceTaskTimeoutEvent;
}

type InternalEventBusPayload = { sessionId?: string; namespaceId?: string } & Record<
  string,
  unknown
>;

interface AgentControlEvents {
  'model.switchRequest': { sessionId: string; model: string; provider: string };
  'model.switched': { sessionId: string; success: boolean; model: string; error?: string };
  'agent.interruptRequest': { sessionId: string };
  'agent.interrupted': { sessionId: string };
  'agent.resetRequest': { sessionId: string; restartQuery?: boolean };
  'agent.reset': { sessionId: string; success: boolean; error?: string };
  'message.persisted': {
    sessionId: string;
    messageId: string;
    messageContent: string | import('@hyperneo/shared').MessageContent[];
    userMessageText: string;
    needsWorkspaceInit: boolean;
    hasDraftToClear: boolean;
    voicePendingSent?: string;
    sendStatus: 'deferred' | 'enqueued' | 'consumed';
    deliveryMode: import('@hyperneo/shared').MessageDeliveryMode;
    skipQueryStart?: boolean;
  };
  'query.trigger': { sessionId: string };
  'context.updated': { sessionId: string; contextInfo: import('@hyperneo/shared').ContextInfo };
}

interface ClientForwardingEvents {
  'auth.changed': {
    sessionId: string;
    method: import('@hyperneo/shared').AuthMethod;
    isAuthenticated: boolean;
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
  'space.hookState.updated': {
    sessionId: string;
    spaceId: string;
    runId: string;
    hookId: string;
    hookState: import('@hyperneo/shared').WorkflowHookStateSnapshot;
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
  'spaceAgent.deleted': { sessionId: string; spaceId: string; agentId: string };
  'spaceLongHorizonAgent.created': {
    sessionId: string;
    spaceId: string;
    agent: import('@hyperneo/shared').SpaceLongHorizonAgent;
  };
  'spaceLongHorizonAgent.updated': {
    sessionId: string;
    spaceId: string;
    agent: import('@hyperneo/shared').SpaceLongHorizonAgent;
  };
  'spaceLongHorizonAgent.deleted': { sessionId: string; spaceId: string; agentId: string };
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
  'spaceWorkflow.deleted': { sessionId: string; spaceId: string; workflowId: string };
  'providers.changed': { sessionId: string };
}

export type DaemonInternalEventMap = Record<string, InternalEventBusPayload> &
  AgentControlEvents &
  ClientForwardingEvents &
  SettingsEvents &
  ExternalEventEvents &
  SessionEvents &
  ApiConnectionEvents &
  SpaceEvents;

export function createDaemonInternalEventBus(): InternalEventBus<DaemonInternalEventMap> {
  return new InternalEventBus<DaemonInternalEventMap>();
}
