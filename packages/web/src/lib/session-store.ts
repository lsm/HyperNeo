/**
 * SessionStore - Unified session state management with pure WebSocket architecture
 *
 * ARCHITECTURE: Pure WebSocket + LiveQuery
 * - Session-scoped realtime messages: LiveQuery subscription on `messages.bySession`
 *   (snapshot on subscribe, delta on subsequent row changes, automatic resubscribe
 *   on reconnect through connectionManager's hub instance)
 * - Session metadata / agent state / errors: `state.session` channel subscription
 * - Pagination for older messages: RPC (`message.sdkMessages`) — LiveQuery returns
 *   the most recent window; older rows are loaded on demand and prepended client-side.
 *
 * Signals (reactive state):
 * - activeSessionId: Current session ID
 * - sessionState: Unified session state (sessionInfo, agentState, commandsData, contextInfo, error)
 * - sdkMessages: SDK message array (LiveQuery-driven)
 *
 * Computed accessors (derived state):
 * - sessionInfo, agentState, contextInfo, commandsData, error, isCompacting, isWorking
 */

import { signal, computed } from '@preact/signals';
import type {
  Session,
  ContextInfo,
  AgentProcessingState,
  SessionState,
  LiveQuerySnapshotEvent,
  LiveQueryDeltaEvent,
} from '@hyperneo/shared';
import type { ChatMessage } from '@hyperneo/shared';
import { Logger } from '@hyperneo/shared';
import { flattenSDKSlashCommands, type SDKSlashCommand } from '@hyperneo/shared/sdk';
import { connectionManager } from './connection-manager';
import { slashCommandsSignal } from './signals';
import { toast } from './toast';
import type { StructuredError } from '../types/error';

/**
 * Maximum number of top-level messages the LiveQuery window keeps in memory.
 * Matches the default page size used by the `message.sdkMessages` RPC so
 * behaviour matches the previous non-LiveQuery path on first load.
 */
const LIVE_QUERY_MESSAGE_LIMIT = 200;

const logger = new Logger('kai:web:sessionstore');

const HYPERNEO_BUILT_IN_COMMANDS = ['merge-session'];

class SessionStore {
  // ========================================
  // Core Signals
  // ========================================

  /** Current active session ID */
  readonly activeSessionId = signal<string | null>(null);

  /** Unified session state from state.session channel */
  readonly sessionState = signal<SessionState | null>(null);

  /** SDK messages from state.sdkMessages channel */
  readonly sdkMessages = signal<ChatMessage[]>([]);

  /** Background task metadata rows kept separate from transcript pagination. */
  readonly backgroundTaskMessages = signal<ChatMessage[]>([]);

  /**
   * Whether the initial messages snapshot has arrived for the current session.
   *
   * The session metadata RPC (`state.session`) and the messages LiveQuery run
   * on independent request paths. On slow networks or for long conversations
   * the metadata RPC can land many seconds before the messages snapshot. The
   * UI uses this flag together with `sessionState` to decide when the chat is
   * truly ready — rendering the empty-state placeholder before this is `true`
   * would lie to the user about a conversation that still has messages in
   * flight.
   *
   * Reset to `false` on every session switch; set to `true` when the first
   * LiveQuery snapshot applies or when the subscribe fails (so the UI can
   * surface a genuinely-empty conversation or a failure rather than stalling
   * on a loading skeleton forever).
   */
  readonly messagesLoaded = signal<boolean>(false);

  /** API retry attempts (populated from session.retryAttempt events) */
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

  // ========================================
  // Computed Accessors
  // ========================================

  /** Session info (metadata) */
  readonly sessionInfo = computed<Session | null>(
    () => this.sessionState.value?.sessionInfo || null
  );

  /** Agent processing state */
  readonly agentState = computed<AgentProcessingState>(
    () => this.sessionState.value?.agentState || { status: 'idle' }
  );

  /** Context info (token usage) - uses direct signal to avoid race condition */
  readonly contextInfo = computed<ContextInfo | null>(
    () =>
      this._contextInfo.value ||
      this.sessionState.value?.sessionInfo?.metadata?.lastContextInfo ||
      null
  );

  /** Available slash commands */
  readonly commandsData = computed<string[]>(() => {
    const cmds = this.sessionState.value?.commandsData?.availableCommands;
    return Array.isArray(cmds) ? cmds : [];
  });

  /** Session error state */
  readonly error = computed<{
    message: string;
    details?: unknown;
    occurredAt: number;
  } | null>(() => this.sessionState.value?.error || null);

  /** Is currently compacting context */
  readonly isCompacting = computed<boolean>(() => {
    const state = this.agentState.value;
    return state.status === 'processing' && 'isCompacting' in state && state.isCompacting === true;
  });

  /** Is agent currently working (processing or queued) */
  readonly isWorking = computed<boolean>(() => {
    const state = this.agentState.value;
    return state.status === 'processing' || state.status === 'queued';
  });

  /**
   * Whether there are more messages to load (pagination)
   * Set from server response - determined by checking if we got exactly `limit` top-level messages
   */
  readonly hasMoreMessages = computed<boolean>(() => this._hasMoreMessages.value);

  // ========================================
  // Private State
  // ========================================

  /** Promise-chain lock for atomic session switching */
  private selectPromise: Promise<void> = Promise.resolve();

  /** Subscription cleanup functions */
  private cleanupFunctions: Array<() => void> = [];

  /** Track the session switch time to avoid showing stale errors */
  private sessionSwitchTime: number = 0;

  /** Track initial message load count for pagination inference */
  private readonly _initialMessageCount = signal(0);

  /** Track whether there are more messages to load (from server response) */
  private readonly _hasMoreMessages = signal(false);

  /**
   * Direct context info signal - updated independently via context.updated events.
   * This fixes a race condition where context.updated events arriving before
   * sessionState is loaded would be silently dropped.
   */
  private readonly _contextInfo = signal<ContextInfo | null>(null);

  /**
   * Current LiveQuery subscription ID for `messages.bySession`.
   *
   * Tracked so stale events arriving after a session switch (queued in the
   * JS event loop between the unsubscribe and the handler teardown, or
   * received after the server ack but before the client knows about the
   * switch) are discarded rather than applied to the new session's state.
   */
  private activeMessagesSubscriptionId: string | null = null;

  // ========================================
  // Session Selection (with Promise-Chain Lock)
  // ========================================

  /**
   * Select a session with atomic subscription management
   *
   * Uses promise-chain locking to prevent race conditions:
   * - Each select() waits for previous select() to complete
   * - Unsubscribe → Update state → Subscribe happens atomically
   * - Reduces subscription operations from 50+ to 6 per switch
   */
  select(sessionId: string | null): Promise<void> {
    // Chain the new selection onto the previous one
    this.selectPromise = this.selectPromise.then(() => this.doSelect(sessionId));
    return this.selectPromise;
  }

  /**
   * Internal selection logic (called within promise chain)
   */
  private async doSelect(sessionId: string | null): Promise<void> {
    // Skip if already on this session and it loaded successfully (no error, not stuck loading).
    // Allow re-selection when there is an error or when the session is still loading
    // (e.g. timed out) so that the Retry button can restart the load.
    const alreadyLoaded = this.sessionState.value !== null && !this.sessionState.value?.error;
    if (this.activeSessionId.value === sessionId && alreadyLoaded) {
      return;
    }

    const oldSessionId = this.activeSessionId.value;

    // 1. Stop current subscriptions and leave old room
    await this.stopSubscriptions();
    if (oldSessionId) {
      const hub = connectionManager.getHubIfConnected();
      if (hub) {
        hub.leaveChannel(`session:${oldSessionId}`);
      }
    }

    // 2. Clear state
    this.sessionState.value = null;
    this.sdkMessages.value = [];
    this.backgroundTaskMessages.value = [];
    this.retryAttempts.value = []; // Clear retry attempts on session switch
    this._initialMessageCount.value = 0;
    this._hasMoreMessages.value = false;
    this._contextInfo.value = null; // Clear context info on session switch
    // Reset the messages-loaded gate so ChatContainer shows the loading
    // skeleton (not the empty-state placeholder) until the new session's
    // LiveQuery snapshot arrives.
    this.messagesLoaded.value = false;
    // Invalidate any in-flight LiveQuery events for the previous session.
    // Events already queued in the event loop will see this guard and be
    // dropped before touching the fresh sdkMessages signal.
    this.activeMessagesSubscriptionId = null;
    // Record session switch time to only show errors that occur AFTER this point
    // This prevents showing stale errors that were already in the session state
    this.sessionSwitchTime = Date.now();

    // 3. Update active session
    this.activeSessionId.value = sessionId;

    // 4. Start new subscriptions if session selected
    if (sessionId) {
      await this.startSubscriptions(sessionId);
    }
  }

  // ========================================
  // Subscription Management
  // ========================================

  /**
   * Start subscriptions for a session.
   *
   * Subscriptions:
   *   1. `state.session` — session metadata + agent state + commands + error
   *   2. `context.updated` — fast-path context info updates
   *   3. `session.retryAttempt` — SDK retry events
   *   4. LiveQuery `messages.bySession` — realtime SDK message stream
   *      (snapshot on subscribe, deltas on subsequent row changes)
   *
   * ARCHITECTURE: LiveQuery supersedes the previous
   * `state.sdkMessages` RPC + `state.sdkMessages.delta` event pair. The
   * daemon's ReactiveDatabase notifies table-change for every write to
   * `sdk_messages`, which drives the LiveQuery re-evaluation; the client
   * never needs a separate "fetch initial + listen to deltas" coordination.
   */
  private async startSubscriptions(sessionId: string): Promise<void> {
    try {
      const hub = await connectionManager.getHub();

      // Join the session room first - this subscribes to all session-scoped events
      hub.joinChannel(`session:${sessionId}`);

      // 1. Session state subscription (unified: metadata + agent + commands + error)
      const unsubSessionState = hub.onEvent<SessionState>('state.session', (state) => {
        this.sessionState.value = state;

        // Sync contextInfo from metadata to direct signal for fast access.
        // The metadata.lastContextInfo is the persisted source of truth.
        if (state.sessionInfo?.metadata?.lastContextInfo) {
          this._contextInfo.value = state.sessionInfo.metadata.lastContextInfo;
        }

        // Sync slash commands signal (for autocomplete)
        // Guard with Array.isArray: corrupted sessions may have a string stored in DB
        // instead of an array, which would break the filter call in the hook.
        const cmds = state.commandsData?.availableCommands;
        if (Array.isArray(cmds) && cmds.length > 0) {
          slashCommandsSignal.value = cmds;
        }

        // If state.session provided empty commands, restore from system:init SDK message.
        // The daemon fallback broadcasts commandsData: [] which overwrites valid commands.
        // The system:init message in sdkMessages is the authoritative source —
        // same one SDKSystemMessage.tsx uses to show "Slash Commands (N)".
        if (!Array.isArray(cmds) || cmds.length === 0) {
          this._syncCommandsFromSDKMessages(this.sdkMessages.value);
        }

        // Handle error (show toast only for NEW errors that occurred after session was opened)
        // Prevents showing stale errors from previous sessions or from before session switch
        if (state.error && state.error.occurredAt > this.sessionSwitchTime) {
          toast.error(state.error.message);
        }
      });
      this.cleanupFunctions.push(unsubSessionState);

      // 2. Context updates (fast path - bypasses full state.session round-trip)
      const unsubContextUpdated = hub.onEvent<ContextInfo>('context.updated', (contextInfo) => {
        this._contextInfo.value = contextInfo;
      });
      this.cleanupFunctions.push(unsubContextUpdated);

      // 3. API retry attempt events (from SDK retry handling)
      const unsubRetryAttempt = hub.onEvent<{
        sessionId: string;
        attempt: number;
        max_retries: number;
        delay_ms: number;
        error_status: number | null;
        error: string;
      }>('session.retryAttempt', (retryInfo) => {
        // Only handle events for the current session
        if (retryInfo.sessionId !== sessionId) return;
        // Append retry attempt to the list
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

      // 4. Fetch session-scoped state (metadata + agent state + commands) via RPC.
      //    Messages are NOT fetched here — they arrive via the LiveQuery snapshot
      //    below.  We still need the session RPC because session state is
      //    push-based (server decides when to broadcast) and there is no
      //    LiveQuery yet for the `sessions` row.
      await this.fetchInitialSessionState(hub, sessionId);

      // 5. Subscribe to the messages LiveQuery for this session.
      //    Errors here are intentionally non-fatal — session state can still
      //    be useful to display (e.g. to show the error banner), and the
      //    LiveQuery will re-subscribe automatically on reconnect.
      await this.subscribeToMessagesLiveQuery(hub, sessionId);
    } catch (err) {
      logger.error('Failed to start subscriptions:', err);
      toast.error('Failed to connect to daemon');
    }
  }

  /**
   * Subscribe to the `messages.bySession` LiveQuery for a session.
   *
   * On snapshot, replaces `sdkMessages` with the canonical server row set.
   * On delta, applies added/removed/updated rows incrementally.
   *
   * Stale events arriving after a session switch are filtered out by
   * comparing against `activeMessagesSubscriptionId`.
   */
  private async subscribeToMessagesLiveQuery(
    hub: Awaited<ReturnType<typeof connectionManager.getHub>>,
    sessionId: string
  ): Promise<void> {
    const subscriptionId = `messages:${sessionId}:${Date.now()}`;
    this.activeMessagesSubscriptionId = subscriptionId;

    // Snapshot handler
    const unsubSnapshot = hub.onEvent<LiveQuerySnapshotEvent>('liveQuery.snapshot', (event) => {
      if (event.subscriptionId !== subscriptionId) return;
      if (this.activeMessagesSubscriptionId !== subscriptionId) return;
      this._applyMessagesSnapshot(event.rows as ChatMessage[], event.metadata);
    });
    this.cleanupFunctions.push(unsubSnapshot);

    // Delta handler
    const unsubDelta = hub.onEvent<LiveQueryDeltaEvent>('liveQuery.delta', (event) => {
      if (event.subscriptionId !== subscriptionId) return;
      if (this.activeMessagesSubscriptionId !== subscriptionId) return;
      this._applyMessagesDelta(event);
    });
    this.cleanupFunctions.push(unsubDelta);

    // Reconnect handler — re-subscribe with the same subscriptionId on reconnect.
    const unsubReconnect = hub.onConnection((state) => {
      if (state !== 'connected') return;
      if (this.activeMessagesSubscriptionId !== subscriptionId) return;
      hub
        .request('liveQuery.subscribe', {
          queryName: 'messages.bySession',
          params: [sessionId, LIVE_QUERY_MESSAGE_LIMIT],
          subscriptionId,
        })
        .catch((err) => {
          logger.warn('Messages LiveQuery re-subscribe failed:', err);
        });
    });
    this.cleanupFunctions.push(unsubReconnect);

    // Also push a cleanup that tells the server to drop the subscription.
    this.cleanupFunctions.push(() => {
      const activeHub = connectionManager.getHubIfConnected();
      if (activeHub) {
        activeHub.request('liveQuery.unsubscribe', { subscriptionId }).catch(() => {
          /* best-effort — server will clean up on disconnect anyway */
        });
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
      // Release the messages-loaded gate so the UI doesn't stall on the
      // loading skeleton forever when the subscribe fails (e.g. session
      // was deleted between select and subscribe). We fall through to
      // whatever sdkMessages currently holds — either the optimistic
      // empty state or stale rows from a prior subscription.
      if (this.activeMessagesSubscriptionId === subscriptionId) {
        this.messagesLoaded.value = true;
      }
      // Don't rethrow — we still want session state to be usable even if
      // the LiveQuery failed.
    }
  }

  /**
   * Apply a LiveQuery snapshot to the sdkMessages signal.
   *
   * Replaces the canonical messages wholesale. The daemon persists every
   * user message to `sdk_messages` before acking `message.send`, and the
   * LiveQuery delta fires within a single event-loop tick, so no
   * client-side optimistic echo is required to show a freshly-sent message
   * — it appears on the next delta.
   */
  private _applyMessagesSnapshot(rows: ChatMessage[], metadata?: Record<string, unknown>): void {
    const sorted = rows
      .slice()
      .sort(
        (a, b) =>
          ((a as ChatMessage & { timestamp?: number }).timestamp || 0) -
          ((b as ChatMessage & { timestamp?: number }).timestamp || 0)
      );

    this.sdkMessages.value = sorted;
    this.backgroundTaskMessages.value = this.extractBackgroundTaskMessages(metadata);
    this._hasMoreMessages.value = rows.length >= LIVE_QUERY_MESSAGE_LIMIT;
    this._initialMessageCount.value = rows.length;
    // Mark the messages as loaded so the UI can transition from the loading
    // skeleton to either the message list or the empty-state placeholder.
    this.messagesLoaded.value = true;
    this._syncCommandsFromSDKMessages(sorted);
  }

  /**
   * Apply a LiveQuery delta to the sdkMessages signal.
   *
   * - added: appended (deduped by id — the LiveQuery engine diffs rows by `id`)
   * - removed: filtered out by id
   * - updated: replaced in-place by id
   *
   * Messages keyed by `id` (the DB row id we surfaced in `messages.bySession`)
   * give stable diffing even when the SDK message itself lacks a uuid.
   */
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
      next = next.map((m) => {
        const id = (m as ChatMessage & { id?: unknown }).id;
        if (id != null && updatedById.has(id)) {
          const updated = updatedById.get(id)!;
          if (updated !== m) changed = true;
          return updated;
        }
        return m;
      });
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
        next = [...next, ...trulyNew].sort(
          (a, b) =>
            ((a as ChatMessage & { timestamp?: number }).timestamp || 0) -
            ((b as ChatMessage & { timestamp?: number }).timestamp || 0)
        );
      }
      this._syncCommandsFromSDKMessages(trulyNew);
    }

    if (changed) {
      this.sdkMessages.value = next;
    }
  }

  /**
   * Fetch initial session state via RPC.
   *
   * Messages are NOT fetched here — they arrive via the LiveQuery
   * `messages.bySession` snapshot pushed on subscribe. Keeping the message
   * and session fetches separate is what unlocks the reactive message
   * stream: the client no longer has to coordinate a "first RPC then delta"
   * handoff, so there's no window where messages could be dropped.
   */
  private async fetchInitialSessionState(
    hub: Awaited<ReturnType<typeof connectionManager.getHub>>,
    sessionId: string
  ): Promise<void> {
    try {
      const sessionState = await hub.request<SessionState>('state.session', { sessionId });

      if (sessionState) {
        this.sessionState.value = sessionState;

        // Persist contextInfo from metadata to direct signal so it survives page refresh.
        // Without this, _contextInfo stays null until the next context.updated event
        // (which only fires after a new agent turn).
        if (sessionState.sessionInfo?.metadata?.lastContextInfo) {
          this._contextInfo.value = sessionState.sessionInfo.metadata.lastContextInfo;
        }

        const initialCmds = sessionState.commandsData?.availableCommands;
        if (Array.isArray(initialCmds) && initialCmds.length > 0) {
          slashCommandsSignal.value = initialCmds;
        }
      } else {
        // sessionState RPC returned null - set error state so UI shows error instead of infinite loading
        logger.error('Session state RPC returned null for session:', sessionId);
        this.sessionState.value = {
          sessionInfo: null,
          agentState: { status: 'idle' },
          commandsData: { availableCommands: [] },
          error: {
            message: 'Session not found',
            details: { sessionId },
            occurredAt: Date.now(),
          },
          timestamp: Date.now(),
        };
      }
    } catch (err) {
      logger.error('Failed to fetch initial session state:', err);
      // Set error state so UI shows error instead of infinite loading
      this.sessionState.value = {
        sessionInfo: null,
        agentState: { status: 'idle' },
        commandsData: { availableCommands: [] },
        error: {
          message: 'Failed to load session',
          details: err,
          occurredAt: Date.now(),
        },
        timestamp: Date.now(),
      };
    }
  }

  /**
   * Sync slash commands from the system:init SDK message.
   *
   * The system:init message carries the authoritative slash commands list —
   * the same one SDKSystemMessage.tsx renders as "Slash Commands (N)".
   * When state.session events arrive with empty commandsData (e.g. from the
   * daemon fallback broadcast), this restores commands from the SDK message.
   */
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

  /**
   * Stop all current subscriptions
   */
  private async stopSubscriptions(): Promise<void> {
    // Call all cleanup functions
    for (const cleanup of this.cleanupFunctions) {
      try {
        cleanup();
      } catch {
        // Ignore cleanup errors
      }
    }
    this.cleanupFunctions = [];
  }

  // ========================================
  // Refresh (for reconnection)
  // ========================================

  /**
   * Refresh current session state from server
   * FIX: Called after reconnection to sync agent state, context, etc.
   *
   * This ensures the status bar shows the correct agent state (Thinking, Streaming)
   * instead of staying at "Online" after Safari background tab resume.
   */
  async refresh(): Promise<void> {
    const sessionId = this.activeSessionId.value;
    if (!sessionId) {
      return;
    }

    try {
      const hub = await connectionManager.getHub();
      // Refresh session state only; the LiveQuery already re-subscribes on
      // reconnect (via the onConnection handler wired in
      // subscribeToMessagesLiveQuery), so messages do not need a separate
      // refresh path.
      await this.fetchInitialSessionState(hub, sessionId);
    } catch (err) {
      logger.error('Failed to refresh state:', err);
      // Don't throw - subscriptions will still receive updates
    }
  }

  // ========================================
  // Error Handling
  // ========================================

  /**
   * Clear current error
   */
  clearError(): void {
    if (this.sessionState.value?.error) {
      this.sessionState.value = {
        ...this.sessionState.value,
        error: null,
      };
    }
    // Also clear retry attempts when error is dismissed
    this.retryAttempts.value = [];
  }

  /**
   * Get structured error details for error dialog
   */
  getErrorDetails(): StructuredError | null {
    const error = this.error.value;
    if (!error?.details) return null;
    return error.details as StructuredError;
  }

  // ========================================
  // Message Management
  // ========================================

  /**
   * Prepend older messages (for pagination)
   * Used when loading older messages via RPC
   */
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
  }

  /**
   * Get current message count (local)
   */
  get messageCount(): number {
    return this.sdkMessages.value.length;
  }

  /**
   * Get total message count from server via RPC
   * Used for pagination to determine if more messages exist
   */
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

  /**
   * Load older messages for pagination via RPC
   * Returns the messages and whether more exist
   */
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
        // Insertion-order tiebreak so a same-ms burst at the page boundary
        // advances the cursor instead of looping on deduped duplicates.
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

/** Singleton session store instance */
export const sessionStore = new SessionStore();
