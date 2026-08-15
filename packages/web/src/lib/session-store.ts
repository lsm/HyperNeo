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
 *   `refreshAllSessionStores()`, which iterates `activeStores` and runs each
 *   instance's `recover()` — rejoining its session channel, re-establishing its
 *   messages LiveQuery, and refreshing state — so the overlay instance is
 *   recovered alongside the singleton.
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

/**
 * Maximum number of top-level messages the LiveQuery window keeps in memory.
 * Matches the default page size used by the `message.sdkMessages` RPC so
 * behaviour matches the previous non-LiveQuery path on first load.
 */
const LIVE_QUERY_MESSAGE_LIMIT = 200;

/**
 * How many times recovery retries the messages LiveQuery re-subscribe before
 * giving up, and the base backoff between attempts. A failed re-subscribe
 * means the new WebSocket client has no message stream for this session — a
 * send could then persist server-side yet never appear in the transcript — so
 * recovery retries a few times and, on final failure, leaves `isRecovering`
 * true (composer disabled) until a later reconnect/resume succeeds.
 */
const LIVE_QUERY_RESUBSCRIBE_MAX_ATTEMPTS = 3;
const LIVE_QUERY_RESUBSCRIBE_RETRY_DELAY_MS = 500;

/**
 * Recovery retries the session-channel rejoin (`channel.join`) and only reports
 * the session ready once it has actually settled successfully. `joinSessionChannel`
 * is fire-and-forget (it must not gate the initial subscribe/state fetch), so the
 * recovery path re-issues the join itself and treats a persistently-failing join
 * as incomplete recovery — otherwise the composer would enable while the session
 * channel is still unjoined and `state.session`/`context.updated` pushes would be
 * missed.
 */
const RECOVERY_REJOIN_MAX_ATTEMPTS = 3;
const RECOVERY_REJOIN_RETRY_DELAY_MS = 500;

const logger = new Logger('hyperneo:web:sessionstore');

const HYPERNEO_BUILT_IN_COMMANDS = ['merge-session'];

/**
 * Live SessionStore instances.
 *
 * Every constructed instance registers itself here (including the singleton).
 * `refreshAllSessionStores()` iterates this set so connection-manager's
 * soft-staleness reconnect (tab-resume) recovers every mounted chat — the
 * singleton AND any simultaneously-mounted overlay instance — instead of only
 * the primary chat. `recover()` no-ops when an instance has no live session or
 * subscription, so registering long-lived instances (the singleton) is harmless.
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

/** Row-shape accessors shared by snapshot/delta merging (see ChatMessage). */
type MessageRow = ChatMessage & { id?: unknown; timestamp?: number; rowid?: number };
const rowTimestamp = (m: ChatMessage): number => (m as MessageRow).timestamp || 0;
const rowRowid = (m: ChatMessage): number => (m as MessageRow).rowid ?? 0;
const rowId = (m: ChatMessage): unknown => (m as MessageRow).id;

/** Sort by the daemon's `(timestamp, rowid)` transcript cursor. */
function sortByTimestampRowid(messages: ChatMessage[]): ChatMessage[] {
  return [...messages].sort(
    (a, b) => rowTimestamp(a) - rowTimestamp(b) || rowRowid(a) - rowRowid(b)
  );
}

/**
 * Tolerance for comparing pagination-boundary timestamps across the two server
 * paths that feed the transcript. `message.sdkMessages` computes epoch-ms via
 * `new Date(ts).getTime()` while the `messages.bySession` LiveQuery computes it
 * via a SQL `CAST((julianday(ts) - 2440587.5) * 86400000 AS INTEGER)` that can
 * floor to the preceding millisecond — so the same instant can differ by ~1ms
 * across the two paths. Treat timestamps within this band as equal and fall
 * back to the rowid cursor (matching the daemon's `(timestamp, rowid)` order).
 */
const SNAPSHOT_TIMESTAMP_JITTER_MS = 1;

/**
 * Merge a fresh LiveQuery snapshot into the visible transcript.
 *
 * The snapshot is the canonical recent window (the server's most recent rows,
 * ordered by `(timestamp, rowid)`). It refreshes that window in place.
 *
 * A paginated prefix — rows the user explicitly loaded above the window via
 * "Load More" — is preserved ONLY when `preservePrefix` is true (a client-side
 * `hasPaginatedOlder` flag the store sets when older rows are actually
 * prepended). This is more reliable than a row-count heuristic: the daemon's
 * `messages.bySession` query LIMITs only the `top_level` CTE and then UNIONs an
 * unbounded number of subagent rows, so a complete transcript with fewer than
 * `limit` top-level messages can still return `>= limit` total rows — which
 * would wrongly mark a full window and freeze deleted rows on screen. When the
 * user has not paginated, the snapshot is authoritative and replaces wholesale
 * (including the empty case, which clears the transcript).
 *
 * Preserved prefix rows are those older than the snapshot's oldest row by the
 * SAME `(timestamp, rowid)` cursor the daemon paginates by, so a window
 * boundary that cuts through a same-millisecond burst does not drop the older
 * rows the cursor would have loaded.
 *
 * Exported for unit tests.
 */
export function mergeSnapshotIntoTranscript(
  existing: ChatMessage[],
  rows: ChatMessage[],
  preservePrefix: boolean
): ChatMessage[] {
  const sorted = rows.slice().sort((a, b) => rowTimestamp(a) - rowTimestamp(b));
  // An empty snapshot means no messages — clear the transcript (don't preserve
  // stale cached rows). When the user hasn't paginated, the snapshot is the
  // authoritative complete transcript → replace wholesale.
  if (sorted.length === 0 || !preservePrefix) return sorted;
  const oldestTs = rowTimestamp(sorted[0]);
  const oldestRowid = rowRowid(sorted[0]);
  const snapshotIds = new Set(sorted.map(rowId).filter((id) => id != null));
  const prefix = existing.filter((m) => {
    const id = rowId(m);
    if (id != null && snapshotIds.has(id)) return false;
    const ts = rowTimestamp(m);
    if (ts < oldestTs) return true;
    // Same instant within the cross-query conversion jitter (see
    // SNAPSHOT_TIMESTAMP_JITTER_MS) → decide by rowid, matching the daemon's
    // (timestamp, rowid) cursor so a same-ms boundary doesn't drop older rows.
    return ts <= oldestTs + SNAPSHOT_TIMESTAMP_JITTER_MS && rowRowid(m) < oldestRowid;
  });
  return [...prefix, ...sorted];
}

export class SessionStore {
  constructor() {
    // Register so refreshAllSessionStores() (soft-staleness reconnect) covers
    // this instance from the moment it exists — matching the previous
    // unconditional sessionStore.refresh() semantics for the singleton. The
    // doSelect() toggle and destroy() keep membership accurate: an instance
    // with no active session no-ops inside recover(), so over-registration is
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

  /**
   * Whether THIS session is mid-recovery after a connection event.
   *
   * Distinct from the initial-load gate (`messagesLoaded`/`sessionState`) and
   * from a genuine load failure (`error`): a chat that already loaded once and
   * then lost/soft-paused its transport is "recovering" — its transcript stays
   * visible and read-only while we rejoin `session:${sessionId}`, re-establish
   * the messages LiveQuery, and refresh session state. The composer must stay
   * disabled until THIS session is ready again, NOT merely when the socket
   * reports connected (the channel may not be rejoined yet).
   *
   * Managed with a monotonic `recoverySeq` token so duplicate reconnect events
   * and superseded recoveries can't leave the flag stuck true, and a slower
   * earlier recovery can't clear it after a fresher one already did. Reset to
   * false on session switch and destroy.
   */
  readonly isRecovering = signal<boolean>(false);

  /**
   * Discriminated kind of the most recent session-LOAD failure for the current
   * session, or `null` when the load succeeded (or no failure has occurred).
   *
   * Distinct from `isRecovering` (a transient transport drop on a session that
   * ALREADY loaded) and from a runtime `error` (a failure inside a live,
   * loaded session — e.g. a provider auth error mid-turn, which keeps
   * `sessionInfo`). `loadErrorKind` is set ONLY when the initial
   * `state.session` fetch fails (or returns a definitive not-found), so the UI
   * can route to an accurate unavailable / retryable load state instead of the
   * legacy collapsed "Failed to load session".
   *
   * Transient recovery refreshes (`retainOnError`) deliberately do NOT set
   * this — a temporary RPC failure during reconnect must not be mistaken for a
   * confirmed missing/archived session, and must not wipe the cached transcript.
   * Reset to `null` on session switch, on a successful load commit, and destroy.
   *
   * `archived` / `terminated` are NOT load errors — the RPC succeeds and the
   * session row still exists. The UI derives those from `sessionInfo.status`
   * directly (ChatContainer's archived/ended banner), not from this signal.
   */
  readonly loadErrorKind = signal<SessionLoadErrorKind | null>(null);

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
   * Deletion tombstone: set when an out-of-band `session.deleted` event targets
   * the active session. A `state.session` RPC captured BEFORE the deletion could
   * otherwise commit AFTER it (clearing loadErrorKind back to null and reviving
   * the deleted transcript); this flag makes fetchInitialSessionState and the
   * state.session push handler skip their commit while the session is known to
   * be gone. Reset on every doSelect (a retry/refresh re-issues the load, which
   * the server will re-confirm as not-found).
   */
  private deleted = false;

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

  /**
   * Monotonic ticket for recovery attempts (see `isRecovering`).
   *
   * `beginRecovery()` bumps and returns it; `endRecovery(token)` clears the
   * flag only when its token is still the latest. This makes recovery robust to
   * duplicate reconnect events and out-of-order settle: only the freshest
   * recovery clears the flag, and a stale one that settles later is a no-op.
   */
  private recoverySeq = 0;

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

  /**
   * Whether the user has loaded messages older than the LiveQuery window (via
   * "Load More" / search deep-link). A recovery/resume snapshot preserves the
   * paginated prefix ONLY while this is true — a row-count heuristic is
   * unreliable because the daemon's `messages.bySession` query LIMITs only the
   * top-level CTE and UNIONs unbounded subagent rows. Reset on session switch.
   */
  private hasPaginatedOlder = false;

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
    // Skip if already on this session and it loaded successfully (no error, not stuck loading,
    // and not in a load-error state). Allow re-selection when there is an error, when the
    // session is still loading (e.g. timed out), OR when loadErrorKind is set — the latter
    // covers an out-of-band deletion: the cached sessionState is still the pre-deletion
    // success, so without this the unavailable view's "Try again" (and the same-id agent
    // refresh) would no-op against the alreadyLoaded guard.
    const alreadyLoaded =
      this.sessionState.value !== null &&
      !this.sessionState.value?.error &&
      this.loadErrorKind.value === null;
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
    // A fresh selection is not "recovering" — the initial-load gate drives
    // readiness until it lands. Bounds any stuck recovery flag to the prior
    // session's lifetime.
    this.isRecovering.value = false;
    // A fresh selection has no load error yet — the prior session's not-found
    // / timeout must not leak into the new one (e.g. navigating from a deleted
    // session to a live one). Also clear the deletion tombstone: a retry against
    // the same id re-issues the load and lets the server re-confirm not-found.
    this.loadErrorKind.value = null;
    this.deleted = false;
    // No older rows paginated yet for the new session.
    this.hasPaginatedOlder = false;
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

        // A push carrying a live sessionInfo and no error means the session is
        // reachable — clear any stale load-error kind so a push that recovers
        // the session (e.g. the daemon re-broadcasts after a transient timeout)
        // doesn't leave a not-found / timeout stranding the UI on the load-error
        // view. A push that itself carries an error leaves the kind as-is.
        // Skip if the session was deleted out-of-band — a deletion tombstone
        // must not be cleared by a stale pre-deletion push.
        if (state.sessionInfo && !state.error && !this.deleted) {
          this.loadErrorKind.value = null;
        }

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

      // 4. Global `session.deleted` — the daemon publishes this when a session
      //    is hard-deleted (e.g. from another tab/client). The per-session
      //    `state.session` channel never re-broadcasts for a deleted row, so
      //    without this the loaded view stays stale after an out-of-band
      //    deletion. When the active session is deleted, flip to the
      //    not-found unavailable state so the user isn't left interacting with a
      //    ghost. loadErrorKind flips to 'not-found' even though the cached
      //    sessionInfo is still present.
      const unsubDeleted = hub.onEvent<{ sessionId: string }>('session.deleted', (event) => {
        if (event?.sessionId && event.sessionId === sessionId && !this.destroyed) {
          // Tombstone: an in-flight state.session fetch/push captured before
          // the deletion must not revive the session by clearing loadErrorKind.
          this.deleted = true;
          this.loadErrorKind.value = 'not-found';
        }
      });
      this.cleanupFunctions.push(unsubDeleted);

      // 5. Fetch session-scoped state (metadata + agent state + commands) via RPC.
      //    Messages are NOT fetched here — they arrive via the LiveQuery snapshot
      //    below.  We still need the session RPC because session state is
      //    push-based (server decides when to broadcast) and there is no
      //    LiveQuery yet for the `sessions` row.
      await this.fetchInitialSessionState(hub, sessionId);

      // 6. Subscribe to the messages LiveQuery for this session.
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
    let awaitingSnapshot = true;

    // Snapshot handler
    const unsubSnapshot = hub.onEvent<LiveQuerySnapshotEvent>('liveQuery.snapshot', (event) => {
      if (event.subscriptionId !== subscriptionId) return;
      if (this.activeMessagesSubscriptionId !== subscriptionId) return;
      awaitingSnapshot = false;
      this._applyMessagesSnapshot(event.rows as ChatMessage[], event.metadata);
    });
    this.cleanupFunctions.push(unsubSnapshot);

    // Delta handler
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

    // Connection handler — drives per-instance recovery for this session.
    // Fires on transport-level state changes (WebSocket drop + re-establish),
    // which is distinct from connection-manager's soft-staleness tab-resume
    // path (handled by `recover()` via refreshAllSessionStores). Either way the
    // goal is identical: rejoin `session:${sessionId}`, re-establish the
    // messages LiveQuery (a fresh snapshot re-syncs any deltas missed while the
    // socket was paused/dropped), and refresh session state — so every
    // instance, including simultaneously-mounted overlay instances unknown to
    // connection-manager, self-recovers here.
    const unsubReconnect = hub.onConnection((state) => {
      // A drop/pause while this session is active flips the recovering flag
      // immediately so the UI can keep the transcript read-only BEFORE the
      // socket reports connected again.
      if (state === 'disconnected' || state === 'reconnecting') {
        if (this.activeMessagesSubscriptionId === subscriptionId && !this.destroyed) {
          this.beginRecovery();
        }
        return;
      }
      if (state === 'failed') {
        // Reconnect attempts exhausted (WebSocketClientTransport emits 'failed'
        // after maxReconnectAttempts). Recovery is impossible until a manual
        // reconnect, so don't leave isRecovering (and the "Reconnecting…"
        // banner) up forever — the global ConnectionStatus already reports the
        // permanent failure. A manual reconnect re-arms recovery via the
        // 'disconnected' → 'connected' sequence.
        if (this.activeMessagesSubscriptionId === subscriptionId) {
          this.isRecovering.value = false;
        }
        return;
      }
      if (state !== 'connected') return;
      if (this.activeMessagesSubscriptionId !== subscriptionId) return;
      // performRecovery is the shared recovery routine (also used by the
      // soft-resume path). It re-joins the session channel, re-subscribes the
      // messages LiveQuery, and refreshes session state — guarding every step
      // by generation/subscriptionId so a session switched away mid-recovery
      // touches nothing, and managing the isRecovering flag via its token.
      this.performRecovery(hub, sessionId, subscriptionId).catch((err) => {
        logger.warn('Session recovery on reconnect failed:', err);
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
      if (
        this.activeMessagesSubscriptionId === subscriptionId &&
        !(err instanceof MessageHubResponseError && err.message.includes('MESSAGE_TOO_LARGE'))
      ) {
        this.messagesLoaded.value = true;
      }
      // Don't rethrow — we still want session state to be usable even if
      // the LiveQuery failed.
    }
  }

  /**
   * Apply a LiveQuery snapshot to the sdkMessages signal.
   *
   * Delegates to `mergeSnapshotIntoTranscript` (see its docs for the
   * prefix-preservation rules): the snapshot refreshes the recent window in
   * place and, only when it fills the bounded window, preserves the older rows
   * the user paginated in above it.
   */
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
    // Mark the messages as loaded so the UI can transition from the loading
    // skeleton to either the message list or the empty-state placeholder.
    this.messagesLoaded.value = true;
    this._syncCommandsFromSDKMessages(merged);
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
      // Task #862 (review P2): a delivery-status update (e.g. queued → consumed)
      // moves the row's timestamp, so the replaced rows may no longer be in
      // transcript order — re-sort by the daemon's (timestamp, rowid) cursor.
      if (changed) next = sortByTimestampRowid(next);
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
        next = sortByTimestampRowid([...next, ...trulyNew]);
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
  ): Promise<boolean> {
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
    // Snapshot the freshness watermarks so the return value can tell recovery
    // callers whether the session state is now fresh — even when THIS fetch is
    // superseded or fails. A newer update (push, a fresher fetch, or a daemon
    // restart that resets the revision counter and re-applies state) landing
    // during this RPC counts as a successful refresh; only a real failure with
    // nothing newer applied reports not-refreshed.
    const epochAtStart = this.lastDaemonEpoch;
    const revisionAtStart = this.lastAppliedRevision;
    const stateFreshenedSinceStart = (): boolean =>
      // daemon restarted (new epoch reset + re-applied state) — revisions
      // aren't comparable across epochs, so an epoch change is itself proof of
      // a re-sync;
      this.lastDaemonEpoch !== epochAtStart ||
      // a newer state.session push advanced the within-epoch revision; or
      this.lastAppliedRevision > revisionAtStart ||
      // a fetch issued AFTER this one (a strictly higher ticket — e.g. an
      // overlapping store.refresh() that started during recovery) committed
      // fresher state. A pre-recovery fetch (lower ticket) whose server
      // snapshot predates the disconnect does NOT count — its data could be
      // stale even though it committed while this RPC was in flight.
      this.lastCommittedFetchSeq > ticket;
    let result: SessionState;
    // Discriminated load-error kind for THIS fetch (null on success). Captured
    // while building an error `result` and committed alongside it below, so a
    // superseded fetch (generation/ticket/revision guard) never leaks its
    // not-found / timeout into the active session's `loadErrorKind`.
    let loadKind: SessionLoadErrorKind | null = null;
    try {
      const sessionState = await hub.request<SessionState>('state.session', { sessionId });
      if (sessionState) {
        result = sessionState;
      } else {
        // RPC returned null — the session was deleted or never existed. This
        // is a definitive "not found", not a transient blip, so surface it as
        // an error regardless of caller.
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
      // Classify FIRST. A reconnect/resume refresh (retainOnError) must still
      // surface an AUTHORITATIVE "Session not found" / unauthorized reply — the
      // session was deleted (or access revoked) while we were reconnecting, so
      // preserving its cached transcript would leave the user interacting with a
      // ghost and strand recovery in an early-return loop. Only TRANSIENT
      // failures (disconnected / timeout / unknown) are retained.
      const classified = classifySessionLoadError(err, connectionState.value);
      if (retainOnError && !isHardUnavailable(classified.kind)) {
        logger.warn('Session state refresh failed; retaining last valid state:', err);
        // A transient refresh failure must NOT set a hard-unavailable
        // loadErrorKind — that would route a recovering session (transcript
        // still visible) to the unavailable screen. Leave loadErrorKind alone;
        // isRecovering keeps the transcript read-only until the next attempt.
        return stateFreshenedSinceStart();
      }
      // Hard failure (not-found / unauthorized), or any failure on the initial
      // load: commit a distinct, actionable error instead of the legacy
      // collapsed "Failed to load session".
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
      this.deleted ||
      this.activeSessionId.value !== sessionId ||
      this.selectGeneration !== generation
    ) {
      // Recovery is moot (session switched/destroyed/reselected) —
      // performRecovery's own guards abort it too. `deleted` blocks a fetch
      // captured before an out-of-band deletion from reviving the session.
      return false;
    }
    if (ticket <= this.lastCommittedFetchSeq) {
      // A newer same-generation fetch (e.g. an overlapping store.refresh() from
      // the send-visibility fallback) already committed while this RPC was in
      // flight. Don't overwrite the fresher state, but the session state IS
      // fresh via that fetch — report refreshed so recovery doesn't stall.
      return stateFreshenedSinceStart();
    }
    if (result.revision !== undefined && result.revision <= this.lastAppliedRevision) {
      // A newer state.session push landed while this RPC was in flight (or a
      // daemon restart reset the gate and re-applied state). The session state
      // IS fresh via that update — count it as a successful refresh, not a
      // stale-ready gap (revisions aren't comparable across an epoch change,
      // so the epoch/delta signals in stateFreshenedSinceStart cover that).
      return stateFreshenedSinceStart();
    }
    this.lastCommittedFetchSeq = ticket;
    if (result.revision !== undefined) this.lastAppliedRevision = result.revision;

    this.sessionState.value = result;
    // Reflect this fetch's load outcome so the UI routes correctly. A
    // successful load clears any stale kind (e.g. a Retry that lands after the
    // session was restored); a failure sets the classified kind. Committed here
    // — after the supersede guards — so a discarded fetch can't set it.
    this.loadErrorKind.value = loadKind;

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
    return true;
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
    this.isRecovering.value = false;
    this.loadErrorKind.value = null;
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
  // Recovery (connection events)
  // ========================================

  /**
   * Mark this session as mid-recovery. Bumps the recovery token and flips
   * `isRecovering` true. Returns the token to pass to `endRecovery`.
   *
   * Called on transport drop/pause (so the UI reacts immediately) and again at
   * the start of each `performRecovery`.
   */
  private beginRecovery(): number {
    const token = ++this.recoverySeq;
    this.isRecovering.value = true;
    return token;
  }

  /**
   * Synchronously mark this session as recovering (no async work). Used by the
   * soft-resume path so the composer is disabled the instant a tab foregrounds —
   * BEFORE the ≤3s health check + channel joins that precede `recover()`. The
   * `recoverySeq` token this bumps is superseded when `performRecovery` later
   * takes its own token (clearing it on success); the dead-socket sub-case
   * (forceReconnect) clears it via the transport path. No-op for a destroyed
   * store or one with no active session.
   */
  markRecovering(): void {
    if (this.destroyed || !this.activeSessionId.value) return;
    this.beginRecovery();
  }

  /**
   * Clear the recovering flag iff `token` is still the freshest recovery.
   * A stale recovery that settles after a fresher one already cleared the flag
   * is a no-op, so out-of-order / duplicate reconnect events can't resurrect or
   * strand the flag.
   */
  private endRecovery(token: number): void {
    if (this.recoverySeq === token) {
      this.isRecovering.value = false;
    }
  }

  /**
   * Full per-session recovery: rejoin `session:${sessionId}`, re-establish the
   * messages LiveQuery (a fresh snapshot re-syncs any deltas missed while the
   * socket was paused/dropped), and refresh session state.
   *
   * Shared by BOTH connection-event paths so they stay consistent:
   * - Transport reconnect: the `onConnection` handler wired in
   *   `subscribeToMessagesLiveQuery`.
   * - Soft-staleness resume (Safari pausing the socket without closing it):
   *   `connectionManager.validateConnectionOnResume` → `refreshAllSessionStores`
   *   → `recover()`.
   *
   * Every step is guarded by the selection epoch AND the LiveQuery
   * subscriptionId, so a session switched away (or destroyed) mid-recovery
   * touches nothing — not its channel membership, messages, or state. The
   * `isRecovering` flag is managed by token so duplicate reconnect events and
   * superseded recoveries resolve correctly. `retainOnError` preserves the
   * transcript on a transient failure rather than swapping in a fatal load
   * error.
   */
  private async performRecovery(
    hub: Awaited<ReturnType<typeof connectionManager.getHub>>,
    sessionId: string,
    subscriptionId: string | null
  ): Promise<void> {
    // Superseded (session switched or destroyed) before we started — nothing to
    // do, and do not flip isRecovering for a dead session.
    if (this.destroyed || this.activeSessionId.value !== sessionId) return;
    // The LiveQuery re-subscribe applies only when this session has an active
    // subscription. During the initial load (subscriptionId not yet assigned,
    // passed as null from recover()) we still rejoin the channel + refresh
    // state so a Safari-expired membership doesn't strand state.session /
    // context.updated pushes — only the re-subscribe is conditional.
    const hasMessagesSubscription = subscriptionId != null;
    if (hasMessagesSubscription && this.activeMessagesSubscriptionId !== subscriptionId) return;

    const token = this.beginRecovery();
    let channelRejoined = false;
    // No subscription to restore (initial load in flight) → vacuously satisfied.
    let messagesResubscribed = !hasMessagesSubscription;
    let stateRefreshed = false;
    try {
      // A transport drop hands the client a new connection/clientId, which wipes
      // server-side channel membership (validateConnectionOnResume only rejoins
      // global+space). Re-join this session's channel AND (when there is one)
      // re-establish the messages LiveQuery together. The daemon delivers a
      // fresh LiveQuery snapshot on every subscribe, re-syncing rows that
      // arrived while the socket was paused/dropped.
      [channelRejoined, messagesResubscribed] = await Promise.all([
        this.rejoinSessionChannelForRecovery(hub, sessionId),
        hasMessagesSubscription
          ? this.resubscribeMessagesLiveQuery(hub, sessionId, subscriptionId)
          : Promise.resolve(true),
      ]);

      // Refresh session state (agent state / context / commands). retainOnError
      // so a transient RPC failure during reconnect preserves the last valid
      // state (no fatal load error); fetchInitialSessionState reports whether it
      // actually refreshed, and recovery stays active until it does — otherwise
      // the UI could report ready on stale agent state / a pre-pause pending
      // question if no state.session push arrives to recover it.
      try {
        stateRefreshed = await this.fetchInitialSessionState(hub, sessionId, {
          retainOnError: true,
        });
      } catch (err) {
        logger.warn('Session state refresh on recovery failed:', err);
      }
    } finally {
      // Only mark the session ready (clear isRecovering) when the session
      // channel, the messages stream, AND the session state were all restored.
      // If any failed, stay "recovering" (composer disabled) until a later
      // transport reconnect or visibility resume retries via recover() and
      // succeeds — that attempt's beginRecovery takes a fresher token and
      // clears the flag on its own success.
      if (channelRejoined && messagesResubscribed && stateRefreshed) {
        this.endRecovery(token);
      } else {
        logger.warn(
          'Recovery incomplete (channel rejoin, messages re-subscribe, or state refresh); staying in recovery until the next reconnect/resume.'
        );
      }
    }
  }

  /**
   * Re-subscribe the messages LiveQuery during recovery, retrying transient
   * failures. Returns true iff a subscription was (re)established.
   *
   * Bails (returns false) without further attempts once the session is switched
   * away or destroyed, or this subscription was superseded — a stale recovery
   * must not churn the active session's subscription.
   */
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

  /**
   * Re-join `session:${sessionId}` during recovery, retrying transient failures,
   * and return whether the join settled successfully.
   *
   * `joinSessionChannel` (used by the initial subscribe + `refresh()`) is
   * deliberately fire-and-forget so it doesn't gate the state fetch on its retry
   * loop. Recovery needs the opposite: it must not report the session ready until
   * the channel membership is actually restored, or `state.session` /
   * `context.updated` pushes will be missed. So recovery issues its own
   * `channel.join` with a short retry ladder and gates readiness on the result.
   *
   * Bails (returns false) once the session is switched away or destroyed — a
   * stale recovery must not churn the active session's membership. On final
   * failure it does NOT leave the channel: a `channel.join` ACK can be delayed
   * past the client timeout while the server has already restored the
   * membership, and an explicit `channel.leave` here would evict that valid
   * membership. Staying "recovering" (without leaving) lets the next reconnect
   * or resume re-confirm it; the release-on-supersede above still cleans up a
   * membership acquired for a session this store no longer owns.
   */
  private async rejoinSessionChannelForRecovery(
    hub: Awaited<ReturnType<typeof connectionManager.getHub>>,
    sessionId: string
  ): Promise<boolean> {
    for (let attempt = 1; attempt <= RECOVERY_REJOIN_MAX_ATTEMPTS; attempt++) {
      if (this.destroyed || this.activeSessionId.value !== sessionId) return false;
      try {
        await hub.request('channel.join', { channel: `session:${sessionId}` }, { timeout: 5000 });
        // Release-on-supersede: a retrying join can settle after the store moved
        // off this session; drop the stray membership it just acquired.
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
    // Exhausted — do NOT leave the channel (see docblock): the server may
    // already have the membership from a delayed ACK. Stay recovering; the next
    // reconnect/resume re-confirms it.
    return false;
  }

  /**
   * Public recovery entry point — used by `refreshAllSessionStores` on the
   * soft-staleness resume path (visibilitychange / page resume) where no
   * transport `onConnection('connected')` fires because the socket never
   * dropped. Distinct from `refresh()` (state-only, used by rewind and the
   * send-visibility check): recovery ALSO re-establishes the messages
   * LiveQuery and manages the `isRecovering` flag.
   *
   * Runs whenever a session is active, even before the messages LiveQuery is
   * set up (initial load still awaiting `state.session`): a Safari pause can
   * expire the `session:${id}` membership mid-load, so the channel must be
   * rejoined and state refreshed regardless. Only the LiveQuery re-subscribe is
   * conditional on a subscription existing.
   */
  async recover(): Promise<void> {
    if (this.destroyed) return;
    const sessionId = this.activeSessionId.value;
    // No active session → nothing to recover.
    if (!sessionId) return;
    // May be null during the initial load (state.session still pending);
    // performRecovery rejoins the channel + refreshes state regardless and
    // only re-subscribes the LiveQuery when a subscription exists.
    const subscriptionId = this.activeMessagesSubscriptionId;
    const epoch = this.selectGeneration;
    const hub = connectionManager.getHubIfConnected();
    // Not connected — let the transport reconnect path handle recovery when the
    // socket comes back. Avoids a blocking getHub() on the resume fast-path.
    if (!hub) return;
    if (this.destroyed || this.selectGeneration !== epoch) return;
    await this.performRecovery(hub, sessionId, subscriptionId);
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
    // Older rows are now visible above the LiveQuery window — a recovery/resume
    // snapshot must preserve this prefix rather than wholesale-replacing it.
    this.hasPaginatedOlder = true;
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

/**
 * Optimistically patch `sessionInfo` fields for the given session in every
 * live store where it is the active session (singleton chat + overlays).
 *
 * Lets optimistic mutations that already update globalStore/spaceStore (e.g.
 * the inline rename in `useSessionRename`) also reach surfaces that render
 * from `SessionStore.sessionInfo` (active chat header/info panel) instead of
 * waiting for the daemon's broadcast to confirm. Revision gating is left
 * untouched: the next daemon push still applies (its revision is newer) and
 * reconciles this surface with the server-confirmed value.
 *
 * `expectedCurrentTitle` guards rollback-style patches: when set, stores whose
 * title is no longer that value are skipped — a newer title (another client,
 * a subsequent rename) already landed via state.session while the request was
 * pending, and the daemon push that carried it has already been consumed, so
 * stomping it would strand the active view on an obsolete title.
 */
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

/** Singleton session store instance */
export const sessionStore = new SessionStore();

/**
 * Recover every live SessionStore instance after a soft-staleness resume.
 *
 * Called by `connectionManager.validateConnectionOnResume` on Safari
 * background-tab resume (the socket paused without dropping, so no transport
 * `onConnection('connected')` fires). Each instance's `recover()` rejoins its
 * session channel, re-establishes its messages LiveQuery (a fresh snapshot
 * re-syncs deltas missed while paused), and refreshes session state — so ALL
 * mounted chats (the singleton-backed primary AND any simultaneously-mounted
 * overlay) recover consistently, and `isRecovering` tracks each one
 * independently. Instances with no live session/subscription no-op.
 */
export async function refreshAllSessionStores(): Promise<void> {
  await Promise.all([...activeStores].map((store) => store.recover().catch(() => {})));
}

/**
 * Synchronously mark every live SessionStore recovering — called by
 * `connectionManager.validateConnectionOnResume` the instant a tab foregrounds
 * (before the health check + channel joins), so the composer/drop-zone/rewind/
 * question affordances are disabled during the resume-validation window on a
 * possibly-stale connection. `performRecovery` (via `refreshAllSessionStores`)
 * supersedes each mark with its own token and clears it on success; the
 * forceReconnect sub-case clears it via the transport path. Parity with the
 * transport-reconnect path, where the `onConnection('disconnected')` handler
 * marks recovering immediately.
 */
export function markAllSessionStoresRecovering(): void {
  for (const store of activeStores) {
    store.markRecovering();
  }
}
