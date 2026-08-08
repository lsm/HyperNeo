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
 *
 * ===========================================================================
 * MULTI-INSTANCE OWNERSHIP (simultaneously-mounted chats)
 * ===========================================================================
 * A SessionStore instance owns the state and subscriptions for ONE chat view.
 * The process-wide singleton (`sessionStore`, exported below) backs the primary
 * chat (main content, base Space chat) plus its non-ChatContainer consumers:
 * `App.tsx` navigation, `RightPanel`, and the autocomplete hooks' default.
 *
 * When a second chat mounts simultaneously — e.g. an `AgentOverlayChat`
 * slide-over on top of a base Space chat — it would otherwise `select()` the
 * same singleton, clearing/clobbering the base chat's transcript and
 * deselecting it on unmount. To prevent that, the overlay creates a DEDICATED
 * `SessionStore` instance and threads it down to its `ChatContainer` via the
 * `store` prop. Each instance owns its own signals, subscriptions, and
 * lifecycle; `select()`/unmount on one instance never touches another.
 *
 * Reconnect parity for every instance:
 * - Transport reconnect (WebSocket drop + re-establish): handled inside each
 *   instance's own `onConnection('connected')` handler (LiveQuery re-subscribe
 *   + session-state refresh), so all instances self-recover.
 * - Soft staleness (Safari background-tab resume, no transport event):
 *   `connectionManager.validateConnectionOnResume` calls the module-level
 *   `refreshAllSessionStores()`, which iterates `activeStores` so the overlay
 *   instance is refreshed alongside the singleton.
 *
 * Migration implication for new consumers: read session state from a store
 * instance passed in (prop/arg), defaulting to the singleton — never import and
 * mutate the singleton directly from inside a chat view that might be overlaid.
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

/**
 * Live SessionStore instances.
 *
 * Every constructed instance registers itself here (including the singleton).
 * `refreshAllSessionStores()` iterates this set so connection-manager's
 * soft-staleness reconnect (tab-resume) refreshes every mounted chat — the
 * singleton AND any simultaneously-mounted overlay instance — instead of only
 * the primary chat. `refresh()` no-ops when an instance has no active session,
 * so registering long-lived instances (the singleton) is harmless.
 */
const activeStores = new Set<SessionStore>();

/**
 * Monotonic counter for LiveQuery subscription IDs.
 *
 * IDs must be unique per client connection (the daemon silently replaces a
 * colliding handle — live-query-handlers.ts). `messages:${sessionId}:${Date.now()}`
 * collides when two stores select the SAME session within one millisecond
 * (e.g. base + overlay restored on initial render), which would let either
 * store's cleanup unsubscribe the survivor. The counter guarantees uniqueness
 * across every store and subscribe call in this client.
 */
let messageSubscriptionSeq = 0;

export class SessionStore {
  constructor() {
    // Register so refreshAllSessionStores() (soft-staleness reconnect) covers
    // this instance from the moment it exists — matching the previous
    // unconditional sessionStore.refresh() semantics for the singleton. The
    // doSelect() toggle and destroy() keep membership accurate: an instance
    // with no active session no-ops inside refresh(), so over-registration is
    // harmless. Re-added by doSelect() if an instance is reused after teardown.
    activeStores.add(this);
  }

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

  /**
   * Once true, this instance is torn down: select()/doSelect()/refresh()
   * no-op and destroy() is idempotent, so a queued or in-flight selection
   * can't resurrect an unmounted overlay store or re-register it for
   * reconnect refresh.
   */
  private destroyed = false;

  /**
   * Monotonic selection epoch, bumped on every doSelect (including a reselect
   * of the SAME session via Retry). In-flight state.session fetches capture it
   * at start and discard their result if a newer selection superseded them —
   * the activeSessionId check alone can't distinguish two concurrent fetches
   * for one session (reconnect refresh racing with a same-session Retry).
   */
  private selectGeneration = 0;

  /**
   * Per-fetch versioning (companion to selectGeneration).
   *
   * selectGeneration versions SELECTIONS, not individual in-flight fetches, so
   * two concurrent `state.session` fetches for the SAME session (no intervening
   * select) share one epoch — `refresh()` is fire-and-forget via
   * refreshAllSessionStores and is NOT chained through selectPromise, so it can
   * overlap an in-flight startSubscriptions fetch, and the reconnect fetch can
   * overlap a just-started selection's fetch. Last-resolver-wins would let a
   * slower-resolving older snapshot overwrite a fresher one.
   *
   * `fetchSeq` issues a monotonic ticket at every fetchInitialSessionState
   * entry; `lastCommittedFetchSeq` records the highest ticket whose result was
   * actually committed. A fetch commits only when its ticket is strictly newer
   * than every committed ticket — so the freshest-issued SUCCESSFUL fetch wins
   * regardless of resolve order. Crucially, a `retainOnError` fetch that fails
   * returns BEFORE the commit and never advances lastCommittedFetchSeq, so its
   * failure does not invalidate a concurrent fetch with an older ticket.
   */
  private fetchSeq = 0;
  private lastCommittedFetchSeq = 0;

  /**
   * Server-stamped capture-order revision tracking (fetch-vs-PUSH ordering).
   *
   * fetchSeq orders concurrent FETCHES against each other but cannot see a PUSH,
   * and an arrival-counter cannot tell a NEWER push from an OLDER one: the
   * daemon captures the `state.session` snapshot BEFORE an internal await
   * (`getSlashCommands`) but SENDS it only after, so an older broadcast (captured
   * earlier) can land AFTER a newer refresh RPC — arrival order ≠ newness order.
   *
   * The daemon stamps a monotonic per-session `revision` inside getSessionState
   * BEFORE that await, carried on BOTH the state.session RPC response and the
   * state.session push. We apply any state.session update — push handler OR
   * fetchInitialSessionState commit — only when `incoming.revision >
   * lastAppliedRevision`, which is correct regardless of arrival order in both
   * directions. Reset to 0 on session switch (revisions are per-session).
   *
   * `contextPushVersion` is a SEPARATE arrival-counter for the PARTIAL
   * `context.updated` push (which carries only contextInfo and is forwarded
   * synchronously by the bridge, so arrival order IS newness order for it). It
   * guards only the fetch's `_contextInfo` write, so a partial push never
   * discards a good full-state fetch.
   */
  private lastAppliedRevision = 0;
  /**
   * The daemon-instance boot epoch last seen. When an incoming state.session
   * carries a different epoch, the daemon restarted — its in-memory revision
   * counter reset — so we clear `lastAppliedRevision` to accept the fresh low
   * revisions. See reconcileDaemonEpoch. Daemon-level (not reset on session
   * switch, only on epoch change).
   */
  private lastDaemonEpoch: string | null = null;
  private contextPushVersion = 0;

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
    // A destroyed instance (unmounted overlay) must ignore later selections
    // so a queued select can't resurrect it after teardown.
    if (this.destroyed) {
      return Promise.resolve();
    }
    // Chain the new selection onto the previous one
    this.selectPromise = this.selectPromise.then(() => this.doSelect(sessionId));
    return this.selectPromise;
  }

  /**
   * Internal selection logic (called within promise chain)
   */
  private async doSelect(sessionId: string | null): Promise<void> {
    // Bail if destroyed between being queued and running — prevents an
    // in-flight/queued selection from reactivating a torn-down instance.
    if (this.destroyed) {
      return;
    }
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
    this.releaseSessionChannel(oldSessionId);

    // 2. Clear state
    this.sessionState.value = null;
    this.sdkMessages.value = [];
    this.backgroundTaskMessages.value = [];
    this.retryAttempts.value = []; // Clear retry attempts on session switch
    this._initialMessageCount.value = 0;
    this._hasMoreMessages.value = false;
    this._contextInfo.value = null; // Clear context info on session switch
    // Reset the per-session revision tracker — revisions are per-session on the
    // server, so the previous session's lastAppliedRevision must not gate the
    // new session's (lower-numbered) first state.
    this.lastAppliedRevision = 0;
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
    // Bump the selection epoch so in-flight state.session fetches for the
    // previous (or same-id reselected) session discard their results.
    this.selectGeneration++;
    // Track registry membership alongside the active session so reconnect
    // refresh covers exactly the instances with a live session. Tying this to
    // activeSessionId (rather than construction) means a remounted instance
    // re-registers when it re-selects, surviving StrictMode-like teardown.
    if (sessionId) {
      activeStores.add(this);
    } else {
      activeStores.delete(this);
    }

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
      this.joinSessionChannel(hub, sessionId);

      // 1. Session state subscription (unified: metadata + agent + commands + error)
      const unsubSessionState = hub.onEvent<SessionState>('state.session', (state, context) => {
        // Filter by channel: MessageHub.dispatchToChannelEventHandlers fires
        // EVERY handler registered for a method name regardless of channel,
        // and a single connection joins multiple session channels when chats
        // are simultaneously mounted. Without this guard, a state.session
        // event for session A would also land in session B's store (and
        // vice-versa), overwriting metadata/agent/context/commands/error.
        // The daemon emits these on channel `session:${sessionId}`.
        if (context?.channel !== `session:${sessionId}`) return;
        // A changed daemon epoch (daemon restart) resets the server's in-memory
        // revision counter — clear our gate before the revision check so the
        // fresh low revisions apply.
        this.reconcileDaemonEpoch(state.daemonEpoch);
        // Apply only if newer than the last applied state. The daemon stamps a
        // capture-order revision (before its async gap) on every state.session
        // update, so this is correct regardless of arrival order — an OLDER
        // push that lands late (stalled in the daemon's await) is dropped
        // instead of reverting a newer RPC. Absent revision (older daemon) =>
        // apply unconditionally.
        if (state.revision !== undefined && state.revision <= this.lastAppliedRevision) {
          return;
        }
        if (state.revision !== undefined) this.lastAppliedRevision = state.revision;
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
      // Same channel guard as state.session: the handler fires for every
      // session's context.updated event when multiple chats are mounted.
      const unsubContextUpdated = hub.onEvent<ContextInfo>(
        'context.updated',
        (contextInfo, context) => {
          if (context?.channel !== `session:${sessionId}`) return;
          // A partial context push supersedes ONLY an in-flight fetch's
          // _contextInfo write (not its full-state commit). Bump so the fetch
          // skips reverting this fresher value. See lastAppliedRevision docs.
          this.contextPushVersion++;
          this._contextInfo.value = contextInfo;
        }
      );
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
    const subscriptionId = `messages:${sessionId}:${Date.now()}:${messageSubscriptionSeq++}`;
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
    // This fires on transport-level reconnect (WebSocket drop + re-establish),
    // which is distinct from connection-manager's soft-staleness tab-resume
    // path. We re-subscribe the LiveQuery AND re-fetch session state (agent
    // state / context) so every instance — including simultaneously-mounted
    // overlay instances unknown to connection-manager — self-recovers here.
    const unsubReconnect = hub.onConnection((state) => {
      if (state !== 'connected') return;
      if (this.activeMessagesSubscriptionId !== subscriptionId) return;
      // A transport drop hands the client a new connection/clientId, which
      // wipes server-side channel membership (validateConnectionOnResume only
      // rejoins global+space). Re-join this session's channel first, or the
      // LiveQuery snapshot below is the last update we'd ever receive —
      // subsequent state.session/context.updated pushes would stop arriving.
      this.joinSessionChannel(hub, sessionId);
      hub
        .request('liveQuery.subscribe', {
          queryName: 'messages.bySession',
          params: [sessionId, LIVE_QUERY_MESSAGE_LIMIT],
          subscriptionId,
        })
        .catch((err) => {
          logger.warn('Messages LiveQuery re-subscribe failed:', err);
        });
      this.fetchInitialSessionState(hub, sessionId, { retainOnError: true }).catch((err) => {
        logger.warn('Session state refresh on reconnect failed:', err);
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

  /**
   * Detect a daemon restart via the per-boot `daemonEpoch`. The server's
   * capture-order revision counter is in-memory, so a restart resets it to 1;
   * without this, our `lastAppliedRevision` (e.g. 50) would discard every
   * post-restart snapshot (revision 1..50) and freeze the view. On an epoch
   * change, clear the revision gate so the fresh low revisions apply. Called
   * before the revision check on every state.session update (push + fetch).
   * Absent epoch (older daemon) => no-op, preserving revision gating.
   */
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
  ): Promise<void> {
    const retainOnError = options?.retainOnError ?? false;
    // Capture the selection epoch so a same-session reselect (e.g. a reconnect
    // refresh in flight + a Retry that reselects X) can't let an older
    // response overwrite the newer state — the activeSessionId check alone
    // can't distinguish two concurrent fetches for one session.
    const generation = this.selectGeneration;
    // Issue a per-fetch ticket so two concurrent fetches for the SAME session
    // (same epoch) still order by issue time. See fetchSeq docs.
    const ticket = ++this.fetchSeq;
    // Snapshot the partial-push counter so a context.updated push that lands
    // while this RPC is in flight supersedes only the _contextInfo write below.
    const contextPushAtStart = this.contextPushVersion;
    let result: SessionState;
    try {
      const sessionState = await hub.request<SessionState>('state.session', { sessionId });
      if (sessionState) {
        result = sessionState;
      } else {
        // RPC returned null — the session was deleted or never existed. This
        // is a definitive "not found", not a transient blip, so surface it as
        // an error regardless of caller.
        logger.error('Session state RPC returned null for session:', sessionId);
        result = {
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
      // Reconnect/refresh callers pass retainOnError so a transient RPC
      // failure during reconnect PRESERVES the last valid state (letting the
      // push-based state.session subscription recover it) instead of
      // clobbering a restored transcript with a fatal load error. Initial
      // load still sets the error so ChatContainer shows the load screen.
      if (retainOnError) {
        logger.warn('Session state refresh failed; retaining last valid state:', err);
        return;
      }
      logger.error('Failed to fetch initial session state:', err);
      result = {
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

    // Discard if the active session changed while the request was in flight
    // (e.g., a transport reconnect fired a refresh for B, then the store
    // switched to C). Committing now would overwrite C's metadata/status/
    // context/commands/error while C's messages stay displayed. The generation
    // check also covers a same-session reselect (reconnect refresh + Retry on
    // the same id) — two fetches with the same sessionId but different epochs.
    // The ticket check then orders any concurrent same-session fetches: only
    // the freshest-issued SUCCESSFUL fetch commits, so a slower-resolving older
    // snapshot can't overwrite a fresher one. (A retainOnError failure returns
    // before this point, so it never claims the slot and can't block another.)
    // A changed daemon epoch (daemon restart resets the server's in-memory
    // revision counter) clears the gate first, then the revision check handles
    // the fetch-vs-PUSH race in BOTH directions: a newer push that landed during
    // the RPC (revision higher than this fetch's) leaves lastAppliedRevision
    // ahead of this fetch, discarding it; an OLDER push that landed late does
    // not overtake this fetch's revision, so this fresher fetch applies. Absent
    // revision/epoch (older daemon) => the checks are skipped.
    this.reconcileDaemonEpoch(result.daemonEpoch);
    if (
      this.destroyed ||
      this.activeSessionId.value !== sessionId ||
      this.selectGeneration !== generation ||
      ticket <= this.lastCommittedFetchSeq ||
      (result.revision !== undefined && result.revision <= this.lastAppliedRevision)
    ) {
      return;
    }
    this.lastCommittedFetchSeq = ticket;
    if (result.revision !== undefined) this.lastAppliedRevision = result.revision;

    this.sessionState.value = result;

    // Persist contextInfo from metadata to direct signal so it survives page refresh.
    // Without this, _contextInfo stays null until the next context.updated event
    // (which only fires after a new agent turn). Skip if a PARTIAL context.updated
    // push landed during the RPC — its value is fresher than this snapshot's.
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
   * Leave a session channel only when no OTHER live store still holds it.
   *
   * The server's ChannelManager keys membership per connection (a deduped
   * Set of clientId), not per store. Two simultaneously-mounted chats that
   * happen to select the same session share one membership, so an
   * unconditional leave here would evict the surviving chat. Guard against
   * that by checking `activeStores` first.
   */
  private releaseSessionChannel(sessionId: string | null): void {
    if (!sessionId) return;
    const stillOwned = [...activeStores].some(
      (s) => s !== this && s.activeSessionId.value === sessionId
    );
    if (stillOwned) return;
    const hub = connectionManager.getHubIfConnected();
    hub?.leaveChannel(`session:${sessionId}`);
  }

  /**
   * Join `session:${sessionId}` and release it again if the store moves off
   * that session while the join is still settling.
   *
   * `MessageHub.joinChannel` retries failed joins with exponential backoff and
   * returns a promise that the call sites deliberately do NOT await (awaiting
   * it would gate the subsequent state fetch on up to ~3 retries, regressing
   * reconnect-recovery latency). But a join issued for X can therefore SUCCEED
   * — rejoin — after the store has already switched to Y, leaking a stray X
   * membership until the next reconnect wipes client memberships. Attaching a
   * release-on-supersede keeps the call fire-and-forget while closing that
   * leak: when the join settles, if this store no longer holds `sessionId`
   * (switched away or destroyed), release the membership it just acquired.
   *
   * `Promise.resolve(...)` tolerates a non-promise return (the join may resolve
   * synchronously when already connected); the callback never throws because
   * joinChannel logs internally and never rejects.
   */
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

  /**
   * Tear down this instance: stop subscriptions, leave the session channel
   * (only if no other live store still holds it), deselect, and unregister
   * from `activeStores` so reconnect refresh no longer touches it.
   *
   * Used by simultaneously-mounted chat owners (e.g. `AgentOverlayChat`) when
   * their view unmounts. The primary chat's singleton is never destroyed.
   * Safe to call multiple times.
   *
   * Teardown is chained through `selectPromise` and gated by `destroyed` so
   * that a `select()` whose `doSelect`/`startSubscriptions` is mid-await (or
   * queued) when the parent unmounts cannot resume after teardown, re-register
   * the store, or leak freshly-installed handlers/server subscriptions. The
   * in-flight selection completes first, then `stopSubscriptions` reaps
   * whatever it installed.
   */
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
    activeStores.delete(this);
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
    if (this.destroyed) return;
    const sessionId = this.activeSessionId.value;
    if (!sessionId) {
      return;
    }
    // Capture the selection epoch before awaiting so a session switch (or a
    // same-session reselect via Retry) during the await aborts the rejoin
    // instead of leaving an obsolete channel membership.
    const epoch = this.selectGeneration;

    try {
      const hub = await connectionManager.getHub();
      if (this.destroyed || this.selectGeneration !== epoch) return;
      // Re-join the session channel: a soft resume (Safari pausing the socket
      // without closing it) can expire server-side channel memberships while
      // the client believes it's still connected, and that path does NOT fire
      // the transport onConnection('connected') handler that normally rejoins.
      // Without this, refreshAllSessionStores (called on resume) would leave
      // every chat current for one snapshot then silently stale for
      // state.session/context.updated pushes. joinChannel is idempotent.
      this.joinSessionChannel(hub, sessionId);
      // Refresh session state only; the LiveQuery already re-subscribes on
      // reconnect (via the onConnection handler wired in
      // subscribeToMessagesLiveQuery), so messages do not need a separate
      // refresh path. retainOnError: a transient failure here (e.g. tab
      // resume racing with a flaky socket) must not wipe the last valid
      // state — the push subscription will recover it.
      await this.fetchInitialSessionState(hub, sessionId, { retainOnError: true });
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

/**
 * Refresh every live SessionStore instance's session state.
 *
 * Called by `connectionManager.validateConnectionOnResume` on soft-staleness
 * reconnect (Safari background-tab resume) so ALL mounted chats — the primary
 * singleton-backed chat AND any simultaneously-mounted overlay instance —
 * re-sync agent state/context, not just the primary one. Instances with no
 * active session no-op inside `refresh()`.
 */
export async function refreshAllSessionStores(): Promise<void> {
  await Promise.all([...activeStores].map((store) => store.refresh().catch(() => {})));
}
