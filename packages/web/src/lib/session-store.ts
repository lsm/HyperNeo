import { signal, computed } from '@preact/signals';
import type {
  Session,
  ContextInfo,
  AgentProcessingState,
  SessionState,
  LiveQuerySnapshotEvent,
  LiveQueryDeltaEvent,
  LiveQueryErrorEvent,
} from '@hyperneo/shared';
import type { ChatMessage } from '@hyperneo/shared';
import { Logger, MessageHubResponseError } from '@hyperneo/shared';
import { flattenSDKSlashCommands, type SDKSlashCommand } from '@hyperneo/shared/sdk';
import { connectionManager } from './connection-manager';
import {
  classifySessionLoadError,
  isHardUnavailable,
  type SessionLoadErrorKind,
} from './session-load-error';
import { connectionState } from './state';
import { slashCommandsSignal } from './signals';
import { toast } from './toast';
import type { StructuredError } from '../types/error';

const LIVE_QUERY_MESSAGE_LIMIT = 200;

const LIVE_QUERY_RESUBSCRIBE_MAX_ATTEMPTS = 3;
const LIVE_QUERY_RESUBSCRIBE_RETRY_DELAY_MS = 500;

const RECOVERY_REJOIN_MAX_ATTEMPTS = 3;
const RECOVERY_REJOIN_RETRY_DELAY_MS = 500;

const logger = new Logger('hyperneo:web:sessionstore');

const HYPERNEO_BUILT_IN_COMMANDS = ['merge-session'];

const activeStores = new Set<SessionStore>();

let messageSubscriptionSeq = 0;

type MessageRow = ChatMessage & { id?: unknown; timestamp?: number; rowid?: number };
const rowTimestamp = (m: ChatMessage): number => (m as MessageRow).timestamp || 0;
const rowRowid = (m: ChatMessage): number => (m as MessageRow).rowid ?? 0;
const rowId = (m: ChatMessage): unknown => (m as MessageRow).id;

const compareByTimestampRowid = (a: ChatMessage, b: ChatMessage): number =>
  rowTimestamp(a) - rowTimestamp(b) || rowRowid(a) - rowRowid(b);

function sortByTimestampRowid(messages: ChatMessage[]): ChatMessage[] {
  return [...messages].sort(compareByTimestampRowid);
}

function isSortedByTimestampRowid(messages: ChatMessage[]): boolean {
  for (let i = 1; i < messages.length; i++) {
    if (compareByTimestampRowid(messages[i - 1], messages[i]) > 0) return false;
  }
  return true;
}

function insertByTimestampRowid(existing: ChatMessage[], rows: ChatMessage[]): ChatMessage[] {
  const added = [...rows].sort(compareByTimestampRowid);
  if (existing.length === 0) return added;
  if (!isSortedByTimestampRowid(existing)) {
    return sortByTimestampRowid([...existing, ...added]);
  }
  if (compareByTimestampRowid(existing[existing.length - 1], added[0]) <= 0) {
    return [...existing, ...added];
  }
  const next = existing.slice();
  for (const row of added) {
    let low = 0;
    let high = next.length;
    while (low < high) {
      const mid = (low + high) >> 1;
      if (compareByTimestampRowid(next[mid], row) <= 0) low = mid + 1;
      else high = mid;
    }
    next.splice(low, 0, row);
  }
  return next;
}

const SNAPSHOT_TIMESTAMP_JITTER_MS = 1;

export function mergeSnapshotIntoTranscript(
  existing: ChatMessage[],
  rows: ChatMessage[],
  preservePrefix: boolean
): ChatMessage[] {
  const sorted = rows.slice().sort((a, b) => rowTimestamp(a) - rowTimestamp(b));
  if (sorted.length === 0 || !preservePrefix) return sorted;
  const oldestTs = rowTimestamp(sorted[0]);
  const oldestRowid = rowRowid(sorted[0]);
  const snapshotIds = new Set(sorted.map(rowId).filter((id) => id != null));
  const prefix = existing.filter((m) => {
    const id = rowId(m);
    if (id != null && snapshotIds.has(id)) return false;
    const ts = rowTimestamp(m);
    if (ts < oldestTs) return true;
    return ts <= oldestTs + SNAPSHOT_TIMESTAMP_JITTER_MS && rowRowid(m) < oldestRowid;
  });
  return [...prefix, ...sorted];
}

export class SessionStore {
  constructor() {
    activeStores.add(this);
  }

  readonly activeSessionId = signal<string | null>(null);

  readonly sessionState = signal<SessionState | null>(null);

  readonly sdkMessages = signal<ChatMessage[]>([]);

  readonly backgroundTaskMessages = signal<ChatMessage[]>([]);

  readonly messagesLoaded = signal<boolean>(false);

  readonly isRecovering = signal<boolean>(false);

  readonly loadErrorKind = signal<SessionLoadErrorKind | null>(null);

  readonly retryAttempts = signal<
    Array<{
      attempt: number;
      max_retries: number;
      delay_ms: number;
      error_status: number | null;
      error: string;
      occurredAt: number;
    }>
  >([]);

  readonly sessionInfo = computed<Session | null>(
    () => this.sessionState.value?.sessionInfo || null
  );

  readonly agentState = computed<AgentProcessingState>(
    () => this.sessionState.value?.agentState || { status: 'idle' }
  );

  readonly contextInfo = computed<ContextInfo | null>(
    () =>
      this._contextInfo.value ||
      this.sessionState.value?.sessionInfo?.metadata?.lastContextInfo ||
      null
  );

  readonly commandsData = computed<string[]>(() => {
    const cmds = this.sessionState.value?.commandsData?.availableCommands;
    return Array.isArray(cmds) ? cmds : [];
  });

  readonly error = computed<{
    message: string;
    details?: unknown;
    occurredAt: number;
  } | null>(() => this.sessionState.value?.error || null);

  readonly isCompacting = computed<boolean>(() => {
    const state = this.agentState.value;
    return state.status === 'processing' && 'isCompacting' in state && state.isCompacting === true;
  });

  readonly isWorking = computed<boolean>(() => {
    const state = this.agentState.value;
    return state.status === 'processing' || state.status === 'queued';
  });

  readonly hasMoreMessages = computed<boolean>(() => this._hasMoreMessages.value);

  private selectPromise: Promise<void> = Promise.resolve();

  private destroyed = false;

  private deleted = false;

  private selectGeneration = 0;

  private fetchSeq = 0;
  private lastCommittedFetchSeq = 0;

  private lastAppliedRevision = 0;
  private lastDaemonEpoch: string | null = null;
  private contextPushVersion = 0;

  private recoverySeq = 0;

  private cleanupFunctions: Array<() => void> = [];

  private sessionSwitchTime: number = 0;

  private readonly _initialMessageCount = signal(0);

  private readonly _hasMoreMessages = signal(false);

  private readonly _contextInfo = signal<ContextInfo | null>(null);

  private activeMessagesSubscriptionId: string | null = null;

  private hasPaginatedOlder = false;

  select(sessionId: string | null): Promise<void> {
    if (this.destroyed) {
      return Promise.resolve();
    }
    this.selectPromise = this.selectPromise.then(() => this.doSelect(sessionId));
    return this.selectPromise;
  }

  private async doSelect(sessionId: string | null): Promise<void> {
    if (this.destroyed) {
      return;
    }
    const alreadyLoaded =
      this.sessionState.value !== null &&
      !this.sessionState.value?.error &&
      this.loadErrorKind.value === null;
    if (this.activeSessionId.value === sessionId && alreadyLoaded) {
      return;
    }

    const oldSessionId = this.activeSessionId.value;

    await this.stopSubscriptions();
    this.releaseSessionChannel(oldSessionId);

    this.sessionState.value = null;
    this.sdkMessages.value = [];
    this.backgroundTaskMessages.value = [];
    this.retryAttempts.value = [];
    this._initialMessageCount.value = 0;
    this._hasMoreMessages.value = false;
    this._contextInfo.value = null;
    this.lastAppliedRevision = 0;
    this.messagesLoaded.value = false;
    this.isRecovering.value = false;
    this.loadErrorKind.value = null;
    this.deleted = false;
    this.hasPaginatedOlder = false;
    this.activeMessagesSubscriptionId = null;
    this.sessionSwitchTime = Date.now();

    this.activeSessionId.value = sessionId;
    this.selectGeneration++;
    if (sessionId) {
      activeStores.add(this);
    } else {
      activeStores.delete(this);
    }

    if (sessionId) {
      await this.startSubscriptions(sessionId);
    }
  }

  private async startSubscriptions(sessionId: string): Promise<void> {
    try {
      const hub = await connectionManager.getHub();

      this.joinSessionChannel(hub, sessionId);

      const unsubSessionState = hub.onEvent<SessionState>('state.session', (state, context) => {
        if (context?.channel !== `session:${sessionId}`) return;
        this.reconcileDaemonEpoch(state.daemonEpoch);
        if (state.revision !== undefined && state.revision <= this.lastAppliedRevision) {
          return;
        }
        if (state.revision !== undefined) this.lastAppliedRevision = state.revision;
        this.sessionState.value = state;

        if (state.sessionInfo && !state.error && !this.deleted) {
          this.loadErrorKind.value = null;
        }

        if (state.sessionInfo?.metadata?.lastContextInfo) {
          this._contextInfo.value = state.sessionInfo.metadata.lastContextInfo;
        }

        const cmds = state.commandsData?.availableCommands;
        if (Array.isArray(cmds) && cmds.length > 0) {
          slashCommandsSignal.value = cmds;
        }

        if (!Array.isArray(cmds) || cmds.length === 0) {
          this._syncCommandsFromSDKMessages(this.sdkMessages.value);
        }

        if (state.error && state.error.occurredAt > this.sessionSwitchTime) {
          toast.error(state.error.message);
        }
      });
      this.cleanupFunctions.push(unsubSessionState);

      const unsubContextUpdated = hub.onEvent<ContextInfo>(
        'context.updated',
        (contextInfo, context) => {
          if (context?.channel !== `session:${sessionId}`) return;
          this.contextPushVersion++;
          this._contextInfo.value = contextInfo;
        }
      );
      this.cleanupFunctions.push(unsubContextUpdated);

      const unsubRetryAttempt = hub.onEvent<{
        sessionId: string;
        attempt: number;
        max_retries: number;
        delay_ms: number;
        error_status: number | null;
        error: string;
      }>('session.retryAttempt', (retryInfo) => {
        if (retryInfo.sessionId !== sessionId) return;
        this.retryAttempts.value = [
          ...this.retryAttempts.value,
          {
            attempt: retryInfo.attempt,
            max_retries: retryInfo.max_retries,
            delay_ms: retryInfo.delay_ms,
            error_status: retryInfo.error_status,
            error: retryInfo.error,
            occurredAt: Date.now(),
          },
        ];
      });
      this.cleanupFunctions.push(unsubRetryAttempt);

      const unsubDeleted = hub.onEvent<{ sessionId: string }>('session.deleted', (event) => {
        if (event?.sessionId && event.sessionId === sessionId && !this.destroyed) {
          this.deleted = true;
          this.loadErrorKind.value = 'not-found';
        }
      });
      this.cleanupFunctions.push(unsubDeleted);

      await this.fetchInitialSessionState(hub, sessionId);

      await this.subscribeToMessagesLiveQuery(hub, sessionId);
    } catch (err) {
      logger.error('Failed to start subscriptions:', err);
      toast.error('Failed to connect to daemon');
    }
  }

  private async subscribeToMessagesLiveQuery(
    hub: Awaited<ReturnType<typeof connectionManager.getHub>>,
    sessionId: string
  ): Promise<void> {
    const subscriptionId = `messages:${sessionId}:${Date.now()}:${messageSubscriptionSeq++}`;
    this.activeMessagesSubscriptionId = subscriptionId;
    let awaitingSnapshot = true;

    const unsubSnapshot = hub.onEvent<LiveQuerySnapshotEvent>('liveQuery.snapshot', (event) => {
      if (event.subscriptionId !== subscriptionId) return;
      if (this.activeMessagesSubscriptionId !== subscriptionId) return;
      awaitingSnapshot = false;
      this._applyMessagesSnapshot(event.rows as ChatMessage[], event.metadata);
    });
    this.cleanupFunctions.push(unsubSnapshot);

    const unsubDelta = hub.onEvent<LiveQueryDeltaEvent>('liveQuery.delta', (event) => {
      if (event.subscriptionId !== subscriptionId) return;
      if (this.activeMessagesSubscriptionId !== subscriptionId) return;
      if (awaitingSnapshot) return;
      this._applyMessagesDelta(event);
    });
    this.cleanupFunctions.push(unsubDelta);

    const unsubError = hub.onEvent<LiveQueryErrorEvent>('liveQuery.error', (event) => {
      if (event.subscriptionId !== subscriptionId) return;
      if (this.activeMessagesSubscriptionId !== subscriptionId) return;
      if (event.code === 'MESSAGE_TOO_LARGE') {
        awaitingSnapshot = true;
        this.messagesLoaded.value = false;
        toast.error('Session is too large to load in one window. Try loading less history.');
        if (event.phase === 'delta') {
          hub
            .request('liveQuery.subscribe', {
              queryName: 'messages.bySession',
              params: [sessionId, LIVE_QUERY_MESSAGE_LIMIT],
              subscriptionId,
            })
            .catch((error) => logger.warn('Failed to resynchronize messages LiveQuery:', error));
        }
      }
    });
    this.cleanupFunctions.push(unsubError);

    const unsubReconnect = hub.onConnection((state) => {
      if (state === 'disconnected' || state === 'reconnecting') {
        if (this.activeMessagesSubscriptionId === subscriptionId && !this.destroyed) {
          this.beginRecovery();
        }
        return;
      }
      if (state === 'failed') {
        if (this.activeMessagesSubscriptionId === subscriptionId) {
          this.isRecovering.value = false;
        }
        return;
      }
      if (state !== 'connected') return;
      if (this.activeMessagesSubscriptionId !== subscriptionId) return;
      this.performRecovery(hub, sessionId, subscriptionId).catch((err) => {
        logger.warn('Session recovery on reconnect failed:', err);
      });
    });
    this.cleanupFunctions.push(unsubReconnect);

    this.cleanupFunctions.push(() => {
      const activeHub = connectionManager.getHubIfConnected();
      if (activeHub) {
        activeHub.request('liveQuery.unsubscribe', { subscriptionId }).catch(() => {});
      }
    });

    try {
      await hub.request('liveQuery.subscribe', {
        queryName: 'messages.bySession',
        params: [sessionId, LIVE_QUERY_MESSAGE_LIMIT],
        subscriptionId,
      });
    } catch (err) {
      logger.error('Failed to subscribe to messages LiveQuery:', err);
      if (
        this.activeMessagesSubscriptionId === subscriptionId &&
        !(err instanceof MessageHubResponseError && err.message.includes('MESSAGE_TOO_LARGE'))
      ) {
        this.messagesLoaded.value = true;
      }
    }
  }

  private _applyMessagesSnapshot(rows: ChatMessage[], metadata?: Record<string, unknown>): void {
    const merged = mergeSnapshotIntoTranscript(
      this.sdkMessages.value,
      rows,
      this.hasPaginatedOlder
    );
    this.sdkMessages.value = merged;
    this.backgroundTaskMessages.value = this.extractBackgroundTaskMessages(metadata);
    this._hasMoreMessages.value = rows.length >= LIVE_QUERY_MESSAGE_LIMIT;
    this._initialMessageCount.value = rows.length;
    this.messagesLoaded.value = true;
    this._syncCommandsFromSDKMessages(merged);
  }

  private extractBackgroundTaskMessages(metadata?: Record<string, unknown>): ChatMessage[] {
    const raw = metadata?.backgroundTaskMessages;
    if (!Array.isArray(raw)) return [];
    return raw
      .filter((message): message is ChatMessage => typeof message === 'object' && message !== null)
      .slice()
      .sort(
        (a, b) =>
          ((a as ChatMessage & { timestamp?: number }).timestamp || 0) -
          ((b as ChatMessage & { timestamp?: number }).timestamp || 0)
      );
  }

  private _applyMessagesDelta(event: LiveQueryDeltaEvent): void {
    if (event.metadata && 'backgroundTaskMessages' in event.metadata) {
      this.backgroundTaskMessages.value = this.extractBackgroundTaskMessages(event.metadata);
    }

    let next = this.sdkMessages.value.slice();
    let changed = false;

    if (event.removed?.length) {
      const removedIds = new Set(
        (event.removed as Array<{ id?: unknown }>).map((r) => r.id).filter((id) => id != null)
      );
      const beforeLength = next.length;
      next = next.filter((m) => {
        const id = (m as ChatMessage & { id?: unknown }).id;
        return !(id != null && removedIds.has(id));
      });
      changed ||= next.length !== beforeLength;
    }

    if (event.updated?.length) {
      const updatedById = new Map<unknown, ChatMessage>();
      for (const row of event.updated as ChatMessage[]) {
        const id = (row as ChatMessage & { id?: unknown }).id;
        if (id != null) updatedById.set(id, row);
      }
      let orderKeysChanged = false;
      next = next.map((m) => {
        const id = (m as ChatMessage & { id?: unknown }).id;
        if (id != null && updatedById.has(id)) {
          const updated = updatedById.get(id)!;
          if (updated !== m) changed = true;
          if (rowTimestamp(updated) !== rowTimestamp(m) || rowRowid(updated) !== rowRowid(m)) {
            orderKeysChanged = true;
          }
          return updated;
        }
        return m;
      });
      if (orderKeysChanged || (changed && !isSortedByTimestampRowid(next))) {
        next = sortByTimestampRowid(next);
      }
    }

    if (event.added?.length) {
      const existingIds = new Set(
        next.map((m) => (m as ChatMessage & { id?: unknown }).id).filter((id) => id != null)
      );
      const trulyNew: ChatMessage[] = [];
      for (const row of event.added as ChatMessage[]) {
        const id = (row as ChatMessage & { id?: unknown }).id;
        if (id != null && existingIds.has(id)) continue;
        trulyNew.push(row);
      }
      if (trulyNew.length) {
        changed = true;
        next = insertByTimestampRowid(next, trulyNew);
      }
      this._syncCommandsFromSDKMessages(trulyNew);
    }

    if (changed) {
      this.sdkMessages.value = next;
    }
  }

  private reconcileDaemonEpoch(daemonEpoch: string | undefined): void {
    if (daemonEpoch !== undefined && daemonEpoch !== this.lastDaemonEpoch) {
      this.lastAppliedRevision = 0;
      this.lastDaemonEpoch = daemonEpoch;
    }
  }

  private async fetchInitialSessionState(
    hub: Awaited<ReturnType<typeof connectionManager.getHub>>,
    sessionId: string,
    options?: { retainOnError?: boolean }
  ): Promise<boolean> {
    const retainOnError = options?.retainOnError ?? false;
    const generation = this.selectGeneration;
    const ticket = ++this.fetchSeq;
    const contextPushAtStart = this.contextPushVersion;
    const epochAtStart = this.lastDaemonEpoch;
    const revisionAtStart = this.lastAppliedRevision;
    const stateFreshenedSinceStart = (): boolean =>
      this.lastDaemonEpoch !== epochAtStart ||
      this.lastAppliedRevision > revisionAtStart ||
      this.lastCommittedFetchSeq > ticket;
    let result: SessionState;
    let loadKind: SessionLoadErrorKind | null = null;
    try {
      const sessionState = await hub.request<SessionState>('state.session', { sessionId });
      if (sessionState) {
        result = sessionState;
      } else {
        logger.error('Session state RPC returned null for session:', sessionId);
        loadKind = 'not-found';
        result = {
          sessionInfo: null,
          agentState: { status: 'idle' },
          commandsData: { availableCommands: [] },
          error: {
            message: 'This session is no longer available.',
            details: { sessionId, kind: 'not-found' },
            occurredAt: Date.now(),
          },
          timestamp: Date.now(),
        };
      }
    } catch (err) {
      const classified = classifySessionLoadError(err, connectionState.value);
      if (retainOnError && !isHardUnavailable(classified.kind)) {
        logger.warn('Session state refresh failed; retaining last valid state:', err);
        return stateFreshenedSinceStart();
      }
      loadKind = classified.kind;
      logger.error('Failed to fetch initial session state:', err);
      result = {
        sessionInfo: null,
        agentState: { status: 'idle' },
        commandsData: { availableCommands: [] },
        error: {
          message: classified.message,
          details: { kind: classified.kind, cause: err },
          occurredAt: Date.now(),
        },
        timestamp: Date.now(),
      };
    }

    this.reconcileDaemonEpoch(result.daemonEpoch);
    if (
      this.destroyed ||
      this.deleted ||
      this.activeSessionId.value !== sessionId ||
      this.selectGeneration !== generation
    ) {
      return false;
    }
    if (ticket <= this.lastCommittedFetchSeq) {
      return stateFreshenedSinceStart();
    }
    if (result.revision !== undefined && result.revision <= this.lastAppliedRevision) {
      return stateFreshenedSinceStart();
    }
    this.lastCommittedFetchSeq = ticket;
    if (result.revision !== undefined) this.lastAppliedRevision = result.revision;

    this.sessionState.value = result;
    this.loadErrorKind.value = loadKind;

    if (
      result.sessionInfo?.metadata?.lastContextInfo &&
      this.contextPushVersion === contextPushAtStart
    ) {
      this._contextInfo.value = result.sessionInfo.metadata.lastContextInfo;
    }

    const initialCmds = result.commandsData?.availableCommands;
    if (Array.isArray(initialCmds) && initialCmds.length > 0) {
      slashCommandsSignal.value = initialCmds;
    }
    return true;
  }

  private _syncCommandsFromSDKMessages(messages: ChatMessage[]): void {
    for (let index = messages.length - 1; index >= 0; index--) {
      const msg = messages[index];
      const m = msg as unknown as {
        type?: string;
        subtype?: string;
        slash_commands?: string[];
        commands?: SDKSlashCommand[];
      };
      const availableCommands = this._commandsFromSDKMessage(m);
      if (availableCommands.length > 0) {
        slashCommandsSignal.value = availableCommands;
        if (this.sessionState.value) {
          this.sessionState.value = {
            ...this.sessionState.value,
            commandsData: { availableCommands },
          };
        }
        break;
      }
    }
  }

  private _commandsFromSDKMessage(message: {
    type?: string;
    subtype?: string;
    slash_commands?: string[];
    commands?: SDKSlashCommand[];
  }): string[] {
    if (message.type !== 'system') return [];
    if (message.subtype === 'commands_changed' && Array.isArray(message.commands)) {
      return [
        ...new Set([...flattenSDKSlashCommands(message.commands), ...HYPERNEO_BUILT_IN_COMMANDS]),
      ];
    }
    if (
      message.subtype === 'init' &&
      Array.isArray(message.slash_commands) &&
      message.slash_commands.length > 0
    ) {
      return message.slash_commands;
    }
    return [];
  }

  private releaseSessionChannel(sessionId: string | null): void {
    if (!sessionId) return;
    const stillOwned = [...activeStores].some(
      (s) => s !== this && s.activeSessionId.value === sessionId
    );
    if (stillOwned) return;
    const hub = connectionManager.getHubIfConnected();
    hub?.leaveChannel(`session:${sessionId}`);
  }

  private joinSessionChannel(
    hub: Awaited<ReturnType<typeof connectionManager.getHub>>,
    sessionId: string
  ): void {
    const joinPromise = hub.joinChannel(`session:${sessionId}`);
    Promise.resolve(joinPromise).then(() => {
      if (this.destroyed || this.activeSessionId.value !== sessionId) {
        this.releaseSessionChannel(sessionId);
      }
    });
  }

  private async stopSubscriptions(): Promise<void> {
    for (const cleanup of this.cleanupFunctions) {
      try {
        cleanup();
      } catch {}
    }
    this.cleanupFunctions = [];
  }

  async destroy(): Promise<void> {
    if (this.destroyed) return;
    this.destroyed = true;
    this.selectPromise = this.selectPromise.then(() => this.doDestroy());
    await this.selectPromise;
  }

  private async doDestroy(): Promise<void> {
    const oldSessionId = this.activeSessionId.value;
    await this.stopSubscriptions();
    this.releaseSessionChannel(oldSessionId);
    this.activeSessionId.value = null;
    this.isRecovering.value = false;
    this.loadErrorKind.value = null;
    activeStores.delete(this);
  }

  async refresh(): Promise<void> {
    if (this.destroyed) return;
    const sessionId = this.activeSessionId.value;
    if (!sessionId) {
      return;
    }
    const epoch = this.selectGeneration;

    try {
      const hub = await connectionManager.getHub();
      if (this.destroyed || this.selectGeneration !== epoch) return;
      this.joinSessionChannel(hub, sessionId);
      await this.fetchInitialSessionState(hub, sessionId, { retainOnError: true });
    } catch (err) {
      logger.error('Failed to refresh state:', err);
    }
  }

  private beginRecovery(): number {
    const token = ++this.recoverySeq;
    this.isRecovering.value = true;
    return token;
  }

  markRecovering(): void {
    if (this.destroyed || !this.activeSessionId.value) return;
    this.beginRecovery();
  }

  private endRecovery(token: number): void {
    if (this.recoverySeq === token) {
      this.isRecovering.value = false;
    }
  }

  private async performRecovery(
    hub: Awaited<ReturnType<typeof connectionManager.getHub>>,
    sessionId: string,
    subscriptionId: string | null
  ): Promise<void> {
    if (this.destroyed || this.activeSessionId.value !== sessionId) return;
    const hasMessagesSubscription = subscriptionId != null;
    if (hasMessagesSubscription && this.activeMessagesSubscriptionId !== subscriptionId) return;

    const token = this.beginRecovery();
    let channelRejoined = false;
    let messagesResubscribed = !hasMessagesSubscription;
    let stateRefreshed = false;
    try {
      [channelRejoined, messagesResubscribed] = await Promise.all([
        this.rejoinSessionChannelForRecovery(hub, sessionId),
        hasMessagesSubscription
          ? this.resubscribeMessagesLiveQuery(hub, sessionId, subscriptionId)
          : Promise.resolve(true),
      ]);

      try {
        stateRefreshed = await this.fetchInitialSessionState(hub, sessionId, {
          retainOnError: true,
        });
      } catch (err) {
        logger.warn('Session state refresh on recovery failed:', err);
      }
    } finally {
      if (channelRejoined && messagesResubscribed && stateRefreshed) {
        this.endRecovery(token);
      } else {
        logger.warn(
          'Recovery incomplete (channel rejoin, messages re-subscribe, or state refresh); staying in recovery until the next reconnect/resume.'
        );
      }
    }
  }

  private async resubscribeMessagesLiveQuery(
    hub: Awaited<ReturnType<typeof connectionManager.getHub>>,
    sessionId: string,
    subscriptionId: string
  ): Promise<boolean> {
    for (let attempt = 1; attempt <= LIVE_QUERY_RESUBSCRIBE_MAX_ATTEMPTS; attempt++) {
      if (this.destroyed || this.activeSessionId.value !== sessionId) return false;
      if (this.activeMessagesSubscriptionId !== subscriptionId) return false;
      try {
        await hub.request('liveQuery.subscribe', {
          queryName: 'messages.bySession',
          params: [sessionId, LIVE_QUERY_MESSAGE_LIMIT],
          subscriptionId,
        });
        return true;
      } catch (err) {
        logger.warn(
          `Messages LiveQuery re-subscribe attempt ${attempt}/${LIVE_QUERY_RESUBSCRIBE_MAX_ATTEMPTS} failed:`,
          err
        );
        if (attempt < LIVE_QUERY_RESUBSCRIBE_MAX_ATTEMPTS) {
          await new Promise((resolve) =>
            setTimeout(resolve, LIVE_QUERY_RESUBSCRIBE_RETRY_DELAY_MS * attempt)
          );
        }
      }
    }
    return false;
  }

  private async rejoinSessionChannelForRecovery(
    hub: Awaited<ReturnType<typeof connectionManager.getHub>>,
    sessionId: string
  ): Promise<boolean> {
    for (let attempt = 1; attempt <= RECOVERY_REJOIN_MAX_ATTEMPTS; attempt++) {
      if (this.destroyed || this.activeSessionId.value !== sessionId) return false;
      try {
        await hub.request('channel.join', { channel: `session:${sessionId}` }, { timeout: 5000 });
        if (this.destroyed || this.activeSessionId.value !== sessionId) {
          this.releaseSessionChannel(sessionId);
          return false;
        }
        return true;
      } catch (err) {
        logger.warn(
          `Session channel rejoin attempt ${attempt}/${RECOVERY_REJOIN_MAX_ATTEMPTS} failed:`,
          err
        );
        if (attempt < RECOVERY_REJOIN_MAX_ATTEMPTS) {
          await new Promise((resolve) =>
            setTimeout(resolve, RECOVERY_REJOIN_RETRY_DELAY_MS * attempt)
          );
        }
      }
    }
    return false;
  }

  async recover(): Promise<void> {
    if (this.destroyed) return;
    const sessionId = this.activeSessionId.value;
    if (!sessionId) return;
    const subscriptionId = this.activeMessagesSubscriptionId;
    const epoch = this.selectGeneration;
    const hub = connectionManager.getHubIfConnected();
    if (!hub) return;
    if (this.destroyed || this.selectGeneration !== epoch) return;
    await this.performRecovery(hub, sessionId, subscriptionId);
  }

  clearError(): void {
    if (this.sessionState.value?.error) {
      this.sessionState.value = {
        ...this.sessionState.value,
        error: null,
      };
    }
    this.retryAttempts.value = [];
  }

  getErrorDetails(): StructuredError | null {
    const error = this.error.value;
    if (!error?.details) return null;
    return error.details as StructuredError;
  }

  prependMessages(messages: ChatMessage[]): void {
    if (messages.length === 0) return;
    const seenIds = new Set(
      this.sdkMessages.value
        .map((message) => (message as ChatMessage & { id?: unknown }).id)
        .filter((id) => id != null)
    );
    const uniqueMessages = messages.filter((message) => {
      const id = (message as ChatMessage & { id?: unknown }).id;
      return id == null || !seenIds.has(id);
    });
    if (uniqueMessages.length === 0) return;
    this.sdkMessages.value = [...uniqueMessages, ...this.sdkMessages.value];
    this.hasPaginatedOlder = true;
  }

  get messageCount(): number {
    return this.sdkMessages.value.length;
  }

  async getTotalMessageCount(): Promise<number> {
    const sessionId = this.activeSessionId.value;
    if (!sessionId) return 0;

    try {
      const hub = await connectionManager.getHub();
      const result = await hub.request<{ count: number }>('message.count', {
        sessionId,
      });
      return result?.count ?? 0;
    } catch (err) {
      logger.error('Failed to get message count:', err);
      return 0;
    }
  }

  async loadOlderMessages(
    beforeTimestamp: number,
    limit = 100,
    sessionIdOverride?: string,
    beforeRowid?: number
  ): Promise<{ messages: ChatMessage[]; hasMore: boolean }> {
    const sessionId = sessionIdOverride ?? this.activeSessionId.value;
    if (!sessionId) return { messages: [], hasMore: false };

    try {
      const hub = await connectionManager.getHub();
      const result = await hub.request<{
        sdkMessages: ChatMessage[];
        hasMore: boolean;
        backgroundTaskMessages?: ChatMessage[];
      }>('message.sdkMessages', {
        sessionId,
        before: beforeTimestamp,
        limit,
        ...(beforeRowid !== undefined ? { beforeRowid } : {}),
      });

      if (
        result?.backgroundTaskMessages &&
        (!sessionIdOverride || sessionId === this.activeSessionId.value)
      ) {
        this.backgroundTaskMessages.value = result.backgroundTaskMessages;
      }

      const messages = result?.sdkMessages ?? [];
      const hasMore = result?.hasMore ?? false;

      if (!sessionIdOverride || sessionId === this.activeSessionId.value) {
        this._hasMoreMessages.value = hasMore;
      }

      return {
        messages,
        hasMore,
      };
    } catch (err) {
      logger.error('Failed to load older messages:', err);
      throw err;
    }
  }
}

export function applyOptimisticSessionInfo(
  sessionId: string,
  patch: Partial<Session>,
  expectedCurrentTitle?: string
): void {
  for (const store of activeStores) {
    if (store.activeSessionId.value !== sessionId) continue;
    const state = store.sessionState.value;
    if (!state?.sessionInfo) continue;
    if (expectedCurrentTitle !== undefined && state.sessionInfo.title !== expectedCurrentTitle) {
      continue;
    }
    store.sessionState.value = { ...state, sessionInfo: { ...state.sessionInfo, ...patch } };
  }
}

export const sessionStore = new SessionStore();

export async function refreshAllSessionStores(): Promise<void> {
  await Promise.all([...activeStores].map((store) => store.recover().catch(() => {})));
}

export function markAllSessionStoresRecovering(): void {
  for (const store of activeStores) {
    store.markRecovering();
  }
}
