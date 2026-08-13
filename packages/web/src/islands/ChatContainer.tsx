/**
 * ChatContainer Component
 *
 * Main chat interface for displaying messages and handling user interaction.
 * Uses sessionStore as single source of truth for all session state.
 *
 * Architecture (Pure WebSocket):
 * - sessionStore: All session state (messages, errors, session info, context, agent state)
 * - Initial data: Fetched via RPC over WebSocket (no REST API)
 * - Updates: Real-time via state channel subscriptions
 * - Pagination: Loaded via RPC over WebSocket
 * - useSessionActions: Session actions (delete, archive, reset, export)
 *
 * NOTE: Stream events removed - the SDK's query() with AsyncGenerator yields
 * complete messages, not incremental tokens. Processing status shown via
 * agent state from state.session channel.
 */

import type {
  AgentProcessingState,
  ChatMessage,
  MessageDeliveryMode,
  MessageImage,
  QuestionDraftResponse,
  ResolvedQuestion,
  SessionFeatures,
} from '@hyperneo/shared';
import {
  DEFAULT_LOBBY_FEATURES,
  DEFAULT_WORKER_FEATURES,
  normalizeThinkingLevel,
} from '@hyperneo/shared';
import type { SDKMessage, SDKSystemMessage } from '@hyperneo/shared/sdk/sdk.d.ts';
import { useSignalEffect } from '@preact/signals';
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'preact/hooks';
import { ArchiveConfirmDialog } from '../components/ArchiveConfirmDialog.tsx';
// Components
import { ChatComposer } from '../components/ChatComposer.tsx';
import { ChatHeader } from '../components/ChatHeader.tsx';
import { ImageDropOverlay } from '../components/ImageDropOverlay.tsx';
import type { ErrorBannerAction } from '../components/ErrorBanner.tsx';
import { ErrorBanner } from '../components/ErrorBanner.tsx';
import { ErrorDialog } from '../components/ErrorDialog.tsx';
import { ScrollToBottomButton } from '../components/ScrollToBottomButton.tsx';
import { SDKMessageRenderer } from '../components/sdk/SDKMessageRenderer.tsx';
import { RateLimitCooldownBanner } from '../components/sdk/RateLimitCooldownBanner.tsx';
import { ToolsModal } from '../components/ToolsModal.tsx';
import {
  UnavailableSessionView,
  type UnavailableAction,
} from '../components/UnavailableSessionView.tsx';
import { Button } from '../components/ui/Button.tsx';
import { ContentContainer } from '../components/ui/ContentContainer.tsx';
import { Modal } from '../components/ui/Modal.tsx';
import { Spinner } from '../components/ui/Spinner.tsx';
import { WorkspaceSelector } from '../components/WorkspaceSelector.tsx';
import { WorktreeChoiceInline } from '../components/WorktreeChoiceInline.tsx';
import { getProviderLabel } from '../hooks/index.ts';
import { useAutoScroll } from '../hooks/useAutoScroll.ts';
import { useChatComposerController } from '../hooks/useChatComposerController.ts';
import { useImageDropZone, type FileDropHandler } from '../hooks';
import { useMessageMaps } from '../hooks/useMessageMaps.ts';
import { useRunningToolUseIds } from '../hooks/useRunningToolUseIds.ts';
// Hooks
import { useModal } from '../hooks/useModal.ts';
import { useScrollToMessage } from '../hooks/useScrollToMessage.ts';
import { useSendMessage } from '../hooks/useSendMessage.ts';
import { useSessionActions } from '../hooks/useSessionActions.ts';
import { updateSession } from '../lib/api-helpers.ts';
import { connectionManager } from '../lib/connection-manager';
import { borderColors } from '../lib/design-tokens';
import { MIN_MESSAGES_BOTTOM_PADDING_PX } from '../lib/layout-metrics.ts';
import {
  clearOverlayHighlightMessageId,
  navigateToSettings,
  replaceOverlayHistory,
} from '../lib/router.ts';
import { sessionStore, type SessionStore } from '../lib/session-store.ts';
import type { SessionLoadErrorKind, SessionUnavailableKind } from '../lib/session-load-error.ts';
import { searchHighlightMessageIdSignal, type SearchMessageLoadTarget } from '../lib/signals.ts';
import { spaceStore } from '../lib/space-store.ts';
import { connectionState } from '../lib/state.ts';
import { toast } from '../lib/toast.ts';
import { cn } from '../lib/utils';
import type { StructuredError } from '../types/error.ts';
import { ErrorCategory } from '../types/error.ts';

export function shouldBlockForPendingQuestion(
  agentState: AgentProcessingState,
  messages: SDKMessage[]
): agentState is Extract<AgentProcessingState, { status: 'waiting_for_input' }> {
  const lastMessage = messages.length > 0 ? messages[messages.length - 1] : null;
  return agentState.status === 'waiting_for_input' && lastMessage?.type !== 'result';
}

/**
 * Decide whether the chat area should render the loading skeleton.
 *
 * The skeleton shows until BOTH the session-state RPC and the first messages
 * LiveQuery snapshot have arrived — unless an error short-circuits to the
 * error UI.
 *
 * Recovery (a connection drop/resume on a session that ALREADY loaded) must
 * NOT relapse into the skeleton: the transcript stays visible and read-only
 * while we rejoin the channel and re-sync. But this bypass applies ONLY when
 * the session had completed its FULL initial load — i.e. BOTH halves
 * (`sessionStateLoaded && messagesLoaded`). A drop that lands after only one
 * half (state loaded but no snapshot yet, OR snapshot arrived but no metadata
 * yet) must keep the skeleton: rendering with a half-loaded session would show
 * missing metadata or an empty transcript for a conversation that is still in
 * flight (and `isInitialLoad` stays true, so no recovery banner either).
 *
 * Exported for unit tests.
 */
export function computeChatLoading(opts: {
  error: string | null;
  isRecovering: boolean;
  sessionStateLoaded: boolean;
  messagesLoaded: boolean;
}): boolean {
  const { error, isRecovering, sessionStateLoaded, messagesLoaded } = opts;
  const fullyLoaded = sessionStateLoaded && messagesLoaded;
  const recoveringWithTranscript = isRecovering && fullyLoaded;
  return !error && (!sessionStateLoaded || !messagesLoaded) && !recoveringWithTranscript;
}

/**
 * The single routing verdict for what the chat area should render (task #873).
 *
 * Extracted as a pure function so the per-error-class routing — including the
 * invariant that an invalid nonempty session id never reaches the empty "No
 * messages yet" placeholder — is unit-testable without a full render harness.
 *
 * Precedence:
 *  1. pending agent overlay (no real session yet)
 *  2. a classified load failure → the unavailable view (confirmed-gone OR a
 *     transient/retryable load error; both are full-screen since there is no
 *     transcript to show)
 *  3. initial-load skeleton (or the timeout backstop)
 *  4. legacy fatal fallback (error + no sessionInfo but no classified kind)
 *  5. ready (the live chat; archived/terminated are surfaced as a banner here,
 *     not as a separate route — their transcript stays readable)
 *
 * Recovery (isRecovering) is intentionally NOT a route: a recovering session
 * keeps its transcript and shows a non-blocking banner, so it resolves to
 * `ready` (or `loading` if it never finished its first load).
 */
export type ChatRoute = 'pending' | 'unavailable' | 'loading' | 'ready';

export interface ChatRouteDecision {
  route: ChatRoute;
  /** Present only when `route === 'unavailable'`. */
  unavailableKind?: SessionUnavailableKind;
}

export function resolveChatRoute(opts: {
  pending: boolean;
  loadErrorKind: SessionLoadErrorKind | null;
  loading: boolean;
  loadTimedOut: boolean;
  legacyFatal: boolean;
}): ChatRouteDecision {
  if (opts.pending) return { route: 'pending' };
  const kind = opts.loadErrorKind;
  if (
    kind === 'not-found' ||
    kind === 'unauthorized' ||
    kind === 'timeout' ||
    kind === 'disconnected' ||
    kind === 'unknown'
  ) {
    return { route: 'unavailable', unavailableKind: kind };
  }
  if (opts.loading) {
    if (opts.loadTimedOut) return { route: 'unavailable', unavailableKind: 'timeout' };
    return { route: 'loading' };
  }
  if (opts.legacyFatal) return { route: 'unavailable', unavailableKind: 'unknown' };
  return { route: 'ready' };
}

export async function sendChatContainerMessage({
  content,
  images,
  deliveryMode,
  onSendOverride,
  sendMessage,
  setLocalError,
  store = sessionStore,
}: {
  content: string;
  images?: MessageImage[];
  deliveryMode: MessageDeliveryMode;
  onSendOverride?: (
    content: string,
    images?: MessageImage[],
    deliveryMode?: MessageDeliveryMode
  ) => Promise<boolean>;
  sendMessage: (
    content: string,
    images?: MessageImage[],
    deliveryMode?: MessageDeliveryMode
  ) => Promise<boolean>;
  setLocalError: (message: string | null) => void;
  /**
   * SessionStore instance whose error state should be cleared on a successful
   * override send. Defaults to the singleton. Overlaid chats pass their own
   * dedicated instance so clearing the error never touches the primary chat.
   */
  store?: SessionStore;
}): Promise<boolean> {
  if (onSendOverride) {
    // Task-agent overlays route through `sendTaskMessage`, which now honors a
    // `deliveryMode` of `'defer'` (persisted as `deferred`, replayed at the
    // next idle boundary) just like the regular session path. Forward the mode
    // through instead of rejecting it.
    try {
      setLocalError(null);
      store.clearError();
      return await onSendOverride(content, images, deliveryMode);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      setLocalError(message);
      return false;
    }
  }

  return await sendMessage(content, images, deliveryMode);
}

interface ChatContainerProps {
  sessionId: string;
  readonly?: boolean;
  /**
   * When provided, the header's left slot renders a back-arrow button that
   * invokes this callback instead of the default mobile-menu button. Used
   * by `AgentOverlayChat` (the agent slide-over) to collapse the wrapper
   * header into a single `ChatHeader` with a back affordance.
   */
  onBack?: () => void;
  /**
   * Optional message UUID to scroll into view + briefly highlight when the
   * container mounts (or when this prop changes). Used by the agent overlay
   * slide-over so opening "this message" from the minimal thread feed lands
   * the user on the exact turn they clicked instead of the session tail.
   *
   * The highlighted row is matched by `data-message-id` on the wrapper div
   * around each `SDKMessageRenderer`. When absent, behavior is unchanged.
   */
  highlightMessageId?: string;
  titleOverride?: string;
  /**
   * When set, renders a "pending agent" state instead of loading from
   * the store. The agent has been declared in the workflow but has not yet
   * spawned a session. The user can type a first message; on send, the daemon
   * activates the agent. Once the live session appears in `taskActivity`, the
   * component calls `replaceOverlayHistory` to seamlessly transition to the
   * normal chat view.
   */
  pendingAgent?: { taskId: string; agentName: string; workflowNodeId?: string | null } | null;
  /** Optional send override used by workflow node-agent overlays. */
  onSendOverride?: (
    content: string,
    images?: MessageImage[],
    deliveryMode?: MessageDeliveryMode
  ) => Promise<boolean>;
  /**
   * SessionStore instance that owns this view's session state and
   * subscriptions. Defaults to the process-wide singleton (correct for the
   * primary chat). A simultaneously-mounted view — e.g. an agent overlay —
   * passes a DEDICATED instance so it never selects, clears, overwrites, or
   * renders the primary chat's session state. See session-store.ts for the
   * full multi-instance ownership rationale.
   */
  store?: SessionStore;
  /**
   * Context for the unavailable-session state's actions (task #873). These are
   * only surfaced when the session can't be shown as a live chat (deleted /
   * archived / unreachable). They let a long-horizon agent view offer
   * "Refresh agent record" (re-fetch the agent — its sessionId may have
   * changed after a reconnect/restart), beyond the always-present "Try again".
   */
  agentLabel?: string;
  onRefreshAgent?: () => void;
}

export default function ChatContainer({
  sessionId,
  readonly = false,
  onBack,
  highlightMessageId,
  titleOverride,
  pendingAgent,
  onSendOverride,
  store = sessionStore,
  agentLabel,
  onRefreshAgent,
}: ChatContainerProps) {
  // ========================================
  // Refs
  // ========================================
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const messagesContainerRef = useRef<HTMLDivElement>(null);
  // Store scroll position info to restore after older messages are loaded
  const scrollPositionRestoreRef = useRef<{
    oldScrollHeight: number;
    oldScrollTop: number;
    shouldRestore: boolean;
  } | null>(null);

  // Ref for tracking resolving questions (sync updates, prevents form disappearance during transition)
  const resolvingQuestionsRef = useRef<Map<string, ResolvedQuestion>>(new Map());
  const pendingMessageVisibilityChecksRef = useRef<Map<string, ReturnType<typeof setTimeout>>>(
    new Map()
  );

  // ========================================
  // Pending Agent State (workflow agent not yet spawned)
  // ========================================
  const [pendingContent, setPendingContent] = useState('');
  const [pendingSubmitting, setPendingSubmitting] = useState(false);
  // Stable per-draft nonce: generated on first send, reused across retries of
  // the SAME draft (so a transient activation failure dedups), cleared on
  // success so a fresh identical-text draft gets its own row.
  const pendingDraftNonceRef = useRef<string | null>(null);
  const [pendingWaitingForSession, setPendingWaitingForSession] = useState(false);
  const [pendingErrorMessage, setPendingErrorMessage] = useState<string | null>(null);
  const pendingTextareaRef = useRef<HTMLTextAreaElement>(null);

  // Watch taskActivity for the live session matching this pending agent.
  // When the overlay was opened from a specific node (workflowNodeId), require
  // the member's nodeExecution.nodeId to match — otherwise an unstarted node B
  // that reuses node A's agent name would hydrate to A's live session before
  // the user even sends.
  const pendingLiveMember = useMemo(() => {
    if (!pendingAgent) return undefined;
    const members = spaceStore.taskActivity.value.get(pendingAgent.taskId) ?? [];
    return members.find(
      (m) =>
        m.kind === 'node_agent' &&
        m.role === pendingAgent.agentName &&
        m.sessionId &&
        // Exclude cancelled AND pending-with-retained-session members (spawn-retry
        // dead session) — handing off to one would hydrate + inject into the
        // failed session instead of letting activation spawn a replacement.
        m.nodeExecution?.status !== 'cancelled' &&
        m.nodeExecution?.status !== 'pending' &&
        (!pendingAgent.workflowNodeId || m.nodeExecution?.nodeId === pendingAgent.workflowNodeId)
    );
  }, [pendingAgent, spaceStore.taskActivity.value]);

  // When a live session appears, hand off to the standard session-mode overlay.
  useEffect(() => {
    if (pendingLiveMember?.sessionId && pendingAgent) {
      replaceOverlayHistory(
        pendingLiveMember.sessionId,
        pendingLiveMember.label || pendingAgent.agentName,
        undefined,
        {
          taskId: pendingAgent.taskId,
          agentName: pendingAgent.agentName,
          sessionId: pendingLiveMember.sessionId,
          ...(pendingLiveMember.nodeExecution?.nodeExecutionId
            ? { nodeExecutionId: pendingLiveMember.nodeExecution.nodeExecutionId }
            : {}),
          // Preserve the node scope so lazy-activation stays correct if the
          // latched execution is later cancelled.
          ...(pendingAgent.workflowNodeId ? { workflowNodeId: pendingAgent.workflowNodeId } : {}),
        }
      );
    }
  }, [pendingLiveMember, pendingAgent]);

  // Autofocus the pending composer on mount
  useEffect(() => {
    if (pendingAgent) {
      pendingTextareaRef.current?.focus();
    }
  }, [pendingAgent]);

  const handlePendingSend = useCallback(async () => {
    if (!pendingAgent) return;
    const trimmed = pendingContent.trim();
    if (!trimmed || pendingSubmitting) return;
    setPendingSubmitting(true);
    setPendingErrorMessage(null);
    try {
      // Per-draft nonce (generated once, reused across retries of the same
      // draft) so the idempotency key dedups transient-failure retries while
      // genuinely-distinct identical-text drafts get separate pending rows.
      const clientMessageId = pendingDraftNonceRef.current ?? crypto.randomUUID();
      pendingDraftNonceRef.current = clientMessageId;
      const result = await spaceStore.activateTaskNodeAgent(
        pendingAgent.taskId,
        pendingAgent.agentName,
        trimmed,
        pendingAgent.workflowNodeId ?? undefined,
        clientMessageId
      );
      setPendingContent('');
      pendingDraftNonceRef.current = null;
      if (result.sessionId) {
        const matchingLiveMember =
          (spaceStore.taskActivity.value.get(pendingAgent.taskId) ?? []).find(
            (m) =>
              m.kind === 'node_agent' &&
              m.role === pendingAgent.agentName &&
              m.sessionId === result.sessionId
          ) ?? null;
        replaceOverlayHistory(result.sessionId, pendingAgent.agentName, undefined, {
          taskId: pendingAgent.taskId,
          agentName: pendingAgent.agentName,
          sessionId: result.sessionId,
          ...(matchingLiveMember?.nodeExecution?.nodeExecutionId
            ? { nodeExecutionId: matchingLiveMember.nodeExecution.nodeExecutionId }
            : {}),
          ...(pendingAgent.workflowNodeId ? { workflowNodeId: pendingAgent.workflowNodeId } : {}),
        });
      } else {
        setPendingWaitingForSession(true);
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      setPendingErrorMessage(`Failed to start ${pendingAgent.agentName}: ${msg}`);
    } finally {
      setPendingSubmitting(false);
    }
  }, [pendingAgent, pendingContent, pendingSubmitting]);

  const handlePendingKeyDown = useCallback(
    (e: KeyboardEvent) => {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        void handlePendingSend();
      }
    },
    [handlePendingSend]
  );

  // ========================================
  // Local State (pagination, autoScroll)
  // ========================================
  const [loadingOlder, setLoadingOlder] = useState(false);
  // Initialize hasMoreMessages from sessionStore (inferred from initial load count)
  // This avoids an expensive COUNT query on every session load
  const [hasMoreMessages, setHasMoreMessages] = useState(store.hasMoreMessages.value);
  const [isInitialLoad, setIsInitialLoad] = useState(true);
  const [loadTimedOut, setLoadTimedOut] = useState(false);
  const [localError, setLocalError] = useState<string | null>(null);
  const [autoScroll, setAutoScroll] = useState(true);
  const [coordinatorMode, setCoordinatorMode] = useState(true);
  const [sandboxEnabled, setSandboxEnabled] = useState(true);
  const [searchTargetMessageId, setSearchTargetMessageId] = useState<string | null>(null);
  const searchLoadTargetRef = useRef<SearchMessageLoadTarget | null>(null);
  const [searchLoadTarget, setSearchLoadTarget] = useState<SearchMessageLoadTarget | null>(null);

  // Track resolved questions to keep showing them in disabled state
  // Map of toolUseId -> resolved question data
  // Initialized from session metadata and synced when session updates
  const [resolvedQuestions, setResolvedQuestions] = useState<Map<string, ResolvedQuestion>>(
    new Map()
  );

  const [rewindModeChoice, setRewindModeChoice] = useState<'files' | 'conversation' | 'both'>(
    'both'
  );

  // Per-message rewind state
  const [rewindTargetUuid, setRewindTargetUuid] = useState<string | null>(null);
  const [isRewinding, setIsRewinding] = useState(false);

  // Worktree choice modal state
  const [showWorktreeChoice, setShowWorktreeChoice] = useState(false);
  const [pendingWorktreeMode, setPendingWorktreeMode] = useState<'worktree' | 'direct'>('worktree');

  // Inline workspace selector state (for sessions created without a workspace)
  const [showWorkspaceSelector, setShowWorkspaceSelector] = useState(false);

  // Reactive State from sessionStore (via useSignalEffect for re-renders)
  // Moved here before callbacks that depend on it
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [backgroundTaskMessages, setBackgroundTaskMessages] = useState<ChatMessage[]>([]);
  const [session, setSession] = useState(store.sessionInfo.value);

  // ========================================
  // Modals
  // ========================================
  const deleteModal = useModal();
  const toolsModal = useModal();
  const errorDialog = useModal();
  const rewindConfirmModal = useModal();

  // ========================================
  // Rewind handler
  // ========================================
  const handleRewindClick = useCallback(
    (uuid: string) => {
      setRewindTargetUuid(uuid);
      setRewindModeChoice('both');
      rewindConfirmModal.open();
    },
    [rewindConfirmModal]
  );

  const handleRewindConfirm = useCallback(async () => {
    if (!rewindTargetUuid) return;
    // Read-only while recovering: a rewind deletes messages (and may restore
    // files) while the message subscription is still being re-established, so
    // the change would not be reflected until recovery completes. The rewind
    // affordance is also hidden during recovery, but guard the confirm path in
    // case a modal was already open when recovery started.
    if (store.isRecovering.value) {
      toast.warning('Please wait — this session is reconnecting.');
      return;
    }

    setIsRewinding(true);
    try {
      const { result } = await import('../lib/api-helpers.ts').then((m) =>
        m.executeRewind(sessionId, rewindTargetUuid, rewindModeChoice)
      );

      if (result.success) {
        toast.success(
          `Rewound successfully: ${result.messagesDeleted || 0} messages removed, ${
            result.filesChanged?.length || 0
          } files restored`
        );
        // Refresh session state to ensure data consistency
        await store.refresh();
      } else {
        toast.error(`Rewind failed: ${result.error || 'Unknown error'}`);
      }
    } catch (err) {
      toast.error(`Rewind failed: ${err instanceof Error ? err.message : 'Unknown error'}`);
    } finally {
      setIsRewinding(false);
      setRewindTargetUuid(null);
      rewindConfirmModal.close();
    }
  }, [rewindTargetUuid, sessionId, rewindModeChoice, rewindConfirmModal]);

  const handleRewindCancel = useCallback(() => {
    setRewindTargetUuid(null);
    rewindConfirmModal.close();
  }, [rewindConfirmModal]);

  // ========================================
  // Reactive State from sessionStore (via useSignalEffect for re-renders)
  // ========================================
  const [contextUsage, setContextUsage] = useState(store.contextInfo.value);
  const [agentState, setAgentState] = useState(store.agentState.value);
  const [storeError, setStoreError] = useState(store.error.value);

  // Sync messages from sessionStore
  useSignalEffect(() => {
    const nextMessages = store.sdkMessages.value;
    const pendingChecks = pendingMessageVisibilityChecksRef.current;
    if (pendingChecks.size > 0) {
      for (const [messageId, timer] of pendingChecks) {
        const isVisible = nextMessages.some((msg) => msg.uuid === messageId);
        if (isVisible) {
          clearTimeout(timer);
          pendingChecks.delete(messageId);
        }
      }
    }
    setMessages(nextMessages);
  });

  useSignalEffect(() => {
    setBackgroundTaskMessages(store.backgroundTaskMessages.value);
  });

  // Sync session info from sessionStore
  useSignalEffect(() => {
    const info = store.sessionInfo.value;
    setSession(info);
    if (info?.config.autoScroll !== undefined) {
      setAutoScroll(info.config.autoScroll);
    }
    if (info?.config.coordinatorMode !== undefined) {
      setCoordinatorMode(info.config.coordinatorMode);
    }
    if (info?.config.sandbox?.enabled !== undefined) {
      setSandboxEnabled(info.config.sandbox.enabled);
    }
  });

  // Get feature flags from session config (for unified session architecture)
  // Falls back to appropriate defaults based on session type
  const features: SessionFeatures = useMemo(() => {
    if (session?.config?.features) {
      return session.config.features;
    }
    // Determine default features based on session ID format
    if (sessionId.startsWith('space:chat:')) {
      // Space agent sessions — no archive/delete (managed by space lifecycle)
      return { ...DEFAULT_WORKER_FEATURES, archive: false };
    }
    if (sessionId.startsWith('lobby:')) {
      return DEFAULT_LOBBY_FEATURES;
    }
    return DEFAULT_WORKER_FEATURES;
  }, [session?.config?.features, sessionId]);

  // Sync context from sessionStore
  useSignalEffect(() => {
    setContextUsage(store.contextInfo.value);
  });

  // Sync agent state from sessionStore
  useSignalEffect(() => {
    setAgentState(store.agentState.value);
  });

  // Sync error from sessionStore
  useSignalEffect(() => {
    setStoreError(store.error.value);
  });

  // Sync the per-session recovery flag. Distinct from `isConnected`
  // (socket-level): true while THIS session is rejoining its channel and
  // re-syncing state/messages after a connection drop/resume. The composer
  // stays disabled and a subtle indicator shows while the transcript remains
  // visible — recovery must not be confused with a fresh load (skeleton) or a
  // genuine failure (error screen).
  const [isRecovering, setIsRecovering] = useState(store.isRecovering.value);
  useSignalEffect(() => {
    setIsRecovering(store.isRecovering.value);
  });

  // Sync the discriminated load-error kind. Set ONLY when the initial
  // state.session fetch fails (or returns a definitive not-found) — never during
  // recovery (transient refreshes retain the transcript) and never for a runtime
  // error inside a live session. Drives routing to the unavailable / load-error
  // view instead of the legacy collapsed "Failed to load session" screen.
  const [loadErrorKind, setLoadErrorKind] = useState<SessionLoadErrorKind | null>(
    store.loadErrorKind.value
  );
  useSignalEffect(() => {
    setLoadErrorKind(store.loadErrorKind.value);
  });

  // Sync hasMoreMessages from sessionStore (inferred from initial load count)
  // This avoids an expensive COUNT query on every session load
  useSignalEffect(() => {
    setHasMoreMessages(store.hasMoreMessages.value);
  });

  // Track initial load state — we are done loading only when BOTH the session
  // state RPC has returned AND the initial messages LiveQuery snapshot has
  // arrived. The two responses are independent, and on slow networks the
  // session RPC can land many seconds before the messages snapshot. Flipping
  // `isInitialLoad` too early is what lets the empty-state placeholder flash
  // for 20+ seconds while messages are still in flight.
  useSignalEffect(() => {
    const sessionStateLoaded = store.sessionState.value !== null;
    const messagesLoaded = store.messagesLoaded.value;
    if (sessionStateLoaded && messagesLoaded) {
      setIsInitialLoad(false);
      setLoadTimedOut(false);
    }
  });

  // Timeout: if session state doesn't load within 30s, show error instead of infinite spinner
  useEffect(() => {
    if (!isInitialLoad) return;
    const timer = setTimeout(() => {
      setLoadTimedOut(true);
    }, 30_000);
    return () => clearTimeout(timer);
  }, [isInitialLoad]);

  // Sync resolved questions from session metadata when session loads/updates
  // Also clears resolvingQuestionsRef for items now confirmed by server
  useEffect(() => {
    if (session?.metadata?.resolvedQuestions) {
      const map = new Map<string, ResolvedQuestion>();
      for (const [toolUseId, resolved] of Object.entries(session.metadata.resolvedQuestions)) {
        map.set(toolUseId, resolved);
      }
      setResolvedQuestions(map);

      // Clear resolvingQuestionsRef for items now confirmed by server
      const refMap = resolvingQuestionsRef.current;
      for (const toolUseId of map.keys()) {
        refMap.delete(toolUseId);
      }
    }
  }, [session?.metadata?.resolvedQuestions]);

  // Show worktree choice modal if session is pending worktree choice
  useEffect(() => {
    if (
      session?.status === 'pending_worktree_choice' &&
      session?.metadata?.worktreeChoice?.status === 'pending'
    ) {
      setShowWorktreeChoice(true);
    } else {
      setShowWorktreeChoice(false);
    }
  }, [session]);

  // Show workspace selector for active worker sessions without a workspace —
  // but only before the conversation starts, so it never covers live messages
  // (e.g. sessions created via the empty-state "create & send" landing).
  useEffect(() => {
    if (
      session?.type === 'worker' &&
      session?.status === 'active' &&
      session?.workspacePath === null &&
      (session?.metadata.messageCount ?? 0) === 0 &&
      !readonly
    ) {
      setShowWorkspaceSelector(true);
    } else {
      setShowWorkspaceSelector(false);
    }
  }, [
    session?.type,
    session?.status,
    session?.workspacePath,
    session?.metadata.messageCount,
    readonly,
  ]);

  // Handler for worktree mode change
  const handleWorktreeModeChange = (mode: 'worktree' | 'direct') => {
    setPendingWorktreeMode(mode);
  };

  // Derived processing state
  const isProcessing = agentState.status === 'processing' || agentState.status === 'queued';
  const isWaitingForInput = shouldBlockForPendingQuestion(agentState, messages as SDKMessage[]);
  const pendingQuestion = isWaitingForInput ? agentState.pendingQuestion : null;

  const {
    currentModel,
    currentModelInfo,
    availableModels,
    modelSwitching,
    modelLoading,
    switchModel,
    currentAction,
    streamingPhase,
    coordinatorSwitching,
    sandboxSwitching,
    handleModelSwitchWithConfirmation,
    handleCoordinatorModeChange,
    handleSandboxModeChange,
  } = useChatComposerController({
    sessionId,
    agentState,
    messages,
    isProcessing,
    coordinatorMode,
    setCoordinatorMode,
    sandboxEnabled,
    setSandboxEnabled,
  });

  const selectSearchMessage = useCallback(
    (messageId: string, loadTarget?: SearchMessageLoadTarget) => {
      const nextLoadTarget = loadTarget ?? null;
      searchLoadTargetRef.current = nextLoadTarget;
      setSearchLoadTarget(nextLoadTarget);
      setSearchTargetMessageId(messageId);
    },
    []
  );

  useSignalEffect(() => {
    const target = searchHighlightMessageIdSignal.value;
    if (target?.sessionId === sessionId && store.activeSessionId.value === sessionId) {
      selectSearchMessage(target.messageId, target.loadTarget);
      searchHighlightMessageIdSignal.value = null;
    }
  });

  // ========================================
  // Session Actions
  // ========================================
  const sessionActions = useSessionActions({
    sessionId,
    session,
    onDeleteModalClose: deleteModal.close,
    onStateReset: useCallback(() => {
      setLocalError(null);
      store.clearError();
    }, []),
  });

  // ========================================
  // Pagination (load older messages via RPC - pure WebSocket)
  // hasMoreMessages is inferred from initial load count in sessionStore
  // This avoids an expensive COUNT query on every session load
  // ========================================
  const loadOlderMessages = useCallback(async () => {
    if (loadingOlder || !hasMoreMessages || messages.length === 0) return;

    try {
      setLoadingOlder(true);

      const container = messagesContainerRef.current;
      if (!container) return;

      // Store current scroll position to restore after messages are prepended
      const oldScrollHeight = container.scrollHeight;
      const oldScrollTop = container.scrollTop;

      const oldestMessage = messages[0] as ChatMessage & { timestamp?: number; rowid?: number };
      const beforeTimestamp = oldestMessage?.timestamp;
      if (!beforeTimestamp) {
        setHasMoreMessages(false);
        return;
      }

      // Load older messages via sessionStore RPC (pure WebSocket). Pass the
      // oldest row's rowid so the (timestamp, rowid) cursor advances through
      // same-millisecond bursts instead of looping on deduped duplicates.
      const { messages: olderMessages, hasMore } = await store.loadOlderMessages(
        beforeTimestamp,
        100,
        undefined,
        oldestMessage?.rowid
      );
      if (olderMessages.length === 0) {
        setHasMoreMessages(false);
        return;
      }

      // Store scroll position info for restoration after DOM updates
      scrollPositionRestoreRef.current = {
        oldScrollHeight,
        oldScrollTop,
        shouldRestore: true,
      };

      // Prepend older messages to sessionStore (will trigger re-render)
      store.prependMessages(olderMessages);
      setHasMoreMessages(hasMore);
    } catch {
      toast.error('Failed to load older messages');
    } finally {
      setLoadingOlder(false);
    }
  }, [loadingOlder, hasMoreMessages, messages]);

  // ========================================
  // Send Message
  // ========================================
  const handleMessageAccepted = useCallback(
    (messageId: string) => {
      const pendingChecks = pendingMessageVisibilityChecksRef.current;
      const existingTimer = pendingChecks.get(messageId);
      if (existingTimer) {
        clearTimeout(existingTimer);
      }
      const timer = setTimeout(() => {
        pendingChecks.delete(messageId);
        const isVisible = store.sdkMessages.value.some((message) => message.uuid === messageId);
        if (!isVisible && store.activeSessionId.value === sessionId) {
          store.refresh().catch(() => {});
        }
      }, 1200);
      pendingChecks.set(messageId, timer);
    },
    [sessionId]
  );
  const { sendMessage } = useSendMessage({
    sessionId,
    session,
    isSending: isProcessing,
    allowQueueWhileProcessing: true,
    onSendStart: useCallback(() => {
      setLocalError(null);
      store.clearError();
    }, []),
    onSendComplete: useCallback(() => {
      // Completion handled by sessionStore state updates
    }, []),
    onError: useCallback((error: string) => {
      setLocalError(error);
    }, []),
    onMessageAccepted: handleMessageAccepted,
  });

  // ========================================
  // Effects
  // ========================================

  // Track whether this is a fresh mount (or remount) so we can force
  // re-selection even when activeSessionId already matches. This prevents
  // a race where the previous instance's cleanup deselects the session
  // after the new instance has already started rendering.
  const isNewMountRef = useRef(true);

  // Select session on mount or when sessionId changes
  // This is needed when ChatContainer is used outside the main navigation flow
  // (e.g., space agent overlays).
  // Skip when in pending-agent mode — no real session exists yet.
  useEffect(() => {
    if (pendingAgent) return;
    // On a fresh mount/remount, always select so we claim ownership even
    // if a previous instance left activeSessionId set to the same value.
    // On re-renders, only select when the sessionId actually changed.
    if (sessionId && (sessionId !== store.activeSessionId.value || isNewMountRef.current)) {
      store.select(sessionId);
    }
    isNewMountRef.current = false;
    // Cleanup: deselect session when component unmounts
    return () => {
      const pendingChecks = pendingMessageVisibilityChecksRef.current;
      for (const timer of pendingChecks.values()) {
        clearTimeout(timer);
      }
      pendingChecks.clear();
      if (store.activeSessionId.value === sessionId) {
        store.select(null);
      }
    };
  }, [sessionId]);

  // Restore scroll position after older messages are loaded and DOM has updated.
  // Uses useLayoutEffect (synchronous, before paint) to restore scroll before any
  // useEffect-based auto-scroll can race and override the position.
  useLayoutEffect(() => {
    if (!scrollPositionRestoreRef.current?.shouldRestore) return;

    const { oldScrollHeight, oldScrollTop } = scrollPositionRestoreRef.current;
    const container = messagesContainerRef.current;

    if (!container) return;

    // Calculate the new scroll position to maintain visual position.
    // The scrollHeight has increased by the height of prepended messages.
    const newScrollTop = oldScrollTop + (container.scrollHeight - oldScrollHeight);
    container.scrollTop = newScrollTop;

    // Clear the restore flag
    scrollPositionRestoreRef.current = null;
  }, [messages.length, loadingOlder]);

  // ========================================
  // Auto-scroll
  // ========================================
  const { showScrollButton, scrollToBottom } = useAutoScroll({
    containerRef: messagesContainerRef,
    endRef: messagesEndRef,
    // Disable tail-following auto-scroll while the caller is asking us to
    // scroll a specific message into view. The highlight id is cleared once
    // that anchor succeeds, so normal tail-following resumes for new rows.
    enabled: autoScroll && !highlightMessageId && !searchTargetMessageId,
    messageCount: messages.length,
    isInitialLoad,
    loadingOlder,
    // Treat each session as a fresh scroll context so a cached navigation
    // that swaps messages in place still snaps to the latest message.
    resetKey: sessionId,
  });

  // ========================================
  // Highlight a specific message (deep-link from minimal thread feed)
  // ========================================
  // `useScrollToMessage` scrolls the matching row to viewport center, applies
  // a temporary amber ring, and re-anchors briefly to handle layout shifts.
  // Note: `enabled: autoScroll && !highlightMessageId` is also passed to
  // `useAutoScroll` above so the initial-load tail-follow can't race the
  // deep-link scroll.
  useEffect(() => {
    if (!searchTargetMessageId || isInitialLoad) return;
    const isLoaded = messages.some(
      (message) =>
        message.uuid === searchTargetMessageId ||
        (message as ChatMessage & { id?: string }).id === searchTargetMessageId
    );
    if (isLoaded) return;

    if (!searchLoadTarget?.before) {
      const timeout = setTimeout(() => {
        setSearchTargetMessageId(null);
        searchLoadTargetRef.current = null;
        setSearchLoadTarget(null);
      }, 750);
      return () => clearTimeout(timeout);
    }

    let cancelled = false;
    const resetSearchTarget = () => {
      setSearchTargetMessageId(null);
      searchLoadTargetRef.current = null;
      setSearchLoadTarget(null);
    };
    const hasTargetMessage = (messageList: ChatMessage[]) =>
      messageList.some(
        (message) =>
          message.uuid === searchTargetMessageId ||
          (message as ChatMessage & { id?: string }).id === searchTargetMessageId
      );
    const applyTargetWindow = async () => {
      setLoadingOlder(true);
      let before = searchLoadTarget.before;
      let beforeRowid = searchLoadTarget.rowid;
      if (!before) return;
      while (!cancelled) {
        const { messages: targetWindow, hasMore } = await store.loadOlderMessages(
          before,
          100,
          searchLoadTarget.sessionId,
          beforeRowid
        );
        if (cancelled) return;
        if (store.activeSessionId.value !== searchLoadTarget.sessionId) {
          resetSearchTarget();
          return;
        }
        if (targetWindow.length === 0) {
          setHasMoreMessages(false);
          resetSearchTarget();
          return;
        }
        store.prependMessages(targetWindow);
        setHasMoreMessages(hasMore);
        if (hasTargetMessage(targetWindow)) {
          searchLoadTargetRef.current = null;
          setSearchLoadTarget(null);
          return;
        }
        if (!hasMore) {
          resetSearchTarget();
          return;
        }
        const oldestMessage = targetWindow[0] as ChatMessage & {
          timestamp?: number;
          rowid?: number;
        };
        // Progress on the composite (timestamp, rowid) cursor: with a rowid
        // cursor the new page can share the cursor's timestamp but carry older
        // rowids — that still counts as forward progress. Only reset when
        // neither axis advanced.
        const ts = oldestMessage.timestamp;
        const rid = oldestMessage.rowid;
        const advanced =
          (ts !== undefined && ts < before) ||
          (ts === before && rid !== undefined && beforeRowid !== undefined && rid < beforeRowid);
        if (!ts || !advanced) {
          resetSearchTarget();
          return;
        }
        before = ts;
        beforeRowid = rid;
      }
    };
    applyTargetWindow()
      .catch(() => {
        if (cancelled) return;
        if (store.activeSessionId.value === searchLoadTarget.sessionId) {
          toast.error('Failed to load search result context');
        }
        resetSearchTarget();
      })
      .finally(() => {
        if (!cancelled) setLoadingOlder(false);
      });
    return () => {
      cancelled = true;
    };
  }, [searchTargetMessageId, searchLoadTarget, isInitialLoad, sessionId]);

  useScrollToMessage({
    containerRef: messagesContainerRef,
    messageId: searchTargetMessageId || highlightMessageId,
    messageCount: messages.length,
    isInitialLoad,
    onAnchored: (messageId) => {
      if (messageId === searchTargetMessageId) {
        setSearchTargetMessageId(null);
        searchLoadTargetRef.current = null;
        setSearchLoadTarget(null);
      }
      if (messageId === highlightMessageId) clearOverlayHighlightMessageId();
    },
  });

  // ========================================
  // Message Maps (for tool results/inputs)
  // ========================================
  const removedOutputs = session?.metadata?.removedOutputs || [];
  const messagesWithBackgroundTasks = useMemo(
    () => [...messages, ...backgroundTaskMessages],
    [messages, backgroundTaskMessages]
  );
  const runningToolUseIds = useRunningToolUseIds(backgroundTaskMessages);
  const maps = useMessageMaps(
    messagesWithBackgroundTasks,
    sessionId,
    removedOutputs,
    runningToolUseIds
  );

  const handleQuestionResolved = useCallback(
    (state: 'submitted' | 'cancelled', responses: QuestionDraftResponse[]) => {
      // Move question to resolved state locally for immediate UI feedback
      // (Server also persists this via question.respond/cancel RPC)
      if (pendingQuestion) {
        const resolved = {
          question: pendingQuestion,
          state,
          responses,
          resolvedAt: Date.now(),
        };
        // Update ref immediately (synchronous)
        resolvingQuestionsRef.current.set(pendingQuestion.toolUseId, resolved);
        // Also schedule update to resolvedQuestions (will be merged with server data)
        setResolvedQuestions((prev) => {
          const next = new Map(prev);
          next.set(pendingQuestion.toolUseId, resolved);
          return next;
        });
      }
    },
    [pendingQuestion]
  );

  // Combined resolved questions map (state + ref)
  // Includes questions synced from server (state) and questions being resolved (ref)
  const allResolvedQuestions = useMemo(() => {
    const combined = new Map<string, ResolvedQuestion>(resolvedQuestions);
    for (const [toolUseId, resolved] of resolvingQuestionsRef.current) {
      combined.set(toolUseId, resolved);
    }
    return combined;
  }, [resolvedQuestions]);

  // ========================================
  // Connection Check
  // ========================================
  const isConnected = connectionState.value === 'connected';

  // ========================================
  // Handlers
  // ========================================
  const handleSendMessage = useCallback(
    async (
      content: string,
      images?: MessageImage[],
      deliveryMode: MessageDeliveryMode = 'immediate'
    ) => {
      // If session is pending worktree choice, set the mode first
      if (session?.status === 'pending_worktree_choice' && showWorktreeChoice) {
        try {
          const hub = connectionManager.getHubIfConnected();
          if (!hub) {
            toast.error('Connection lost.');
            return false;
          }
          await hub.request('session.setWorktreeMode', {
            sessionId,
            mode: pendingWorktreeMode,
          });
          // UI will auto-hide via session status update
        } catch {
          toast.error('Failed to set workspace mode');
          return false; // Don't send message if worktree setup failed
        }
      }

      return await sendChatContainerMessage({
        content,
        images,
        deliveryMode,
        onSendOverride,
        sendMessage,
        setLocalError,
        store,
      });
    },
    [
      sendMessage,
      session,
      showWorktreeChoice,
      pendingWorktreeMode,
      sessionId,
      onSendOverride,
      store,
    ]
  );

  const handleAutoScrollChange = useCallback(
    async (newAutoScroll: boolean) => {
      setAutoScroll(newAutoScroll);
      try {
        await updateSession(sessionId, {
          config: { autoScroll: newAutoScroll },
        });
      } catch {
        setAutoScroll(!newAutoScroll);
        toast.error('Failed to save auto-scroll setting');
      }
    },
    [sessionId]
  );

  // Get retry attempts from session store
  const retryAttempts = store.retryAttempts.value;

  // Build retry status message if there are retry attempts
  const retryStatusMessage = useMemo(() => {
    if (retryAttempts.length === 0) return null;
    const lastRetry = retryAttempts[retryAttempts.length - 1];
    const progress = `${lastRetry.attempt}/${lastRetry.max_retries}`;
    const errorInfo = lastRetry.error_status ? ` (${lastRetry.error_status})` : '';
    return `API retry: attempt ${progress}${errorInfo} - ${lastRetry.error}`;
  }, [retryAttempts]);

  // Combined error (local + store + retry status)
  const error = localError || retryStatusMessage || storeError?.message || null;

  // Build provider-specific action buttons for structured errors
  const errorDetails = storeError?.details as StructuredError | undefined;
  const errorCategory = errorDetails?.category;
  const errorProviderId = errorDetails?.metadata?.providerId as string | undefined;
  const errorActions = useMemo((): ErrorBannerAction[] => {
    if (!errorDetails || !errorCategory) return [];
    const providerLabel = errorProviderId ? getProviderLabel(errorProviderId) : 'Provider';
    if (errorCategory === ErrorCategory.PROVIDER_AUTH_ERROR) {
      return [
        {
          label: `Re-authenticate ${providerLabel}`,
          onClick: () => {
            navigateToSettings('providers');
          },
        },
      ];
    }
    if (errorCategory === ErrorCategory.PROVIDER_UNAVAILABLE) {
      const defaultAnthropicModel = availableModels.find((m) => m.provider === 'anthropic');
      const actions: ErrorBannerAction[] = [];
      if (defaultAnthropicModel) {
        actions.push({
          label: 'Switch to Anthropic',
          onClick: () => switchModel(defaultAnthropicModel),
        });
      }
      return actions;
    }
    return [];
  }, [errorDetails, errorCategory, errorProviderId, availableModels, switchModel]);

  // Derive loading state from store.
  //
  // We must wait for BOTH pieces of the session init to land before the chat
  // area is allowed to render:
  //   1. `sessionState` (metadata + agent state, via `state.session` RPC)
  //   2. `messagesLoaded` (first LiveQuery snapshot for `messages.bySession`)
  //
  // These are independent responses. On slow networks / large conversations
  // the LiveQuery snapshot can take 20+ seconds, long after the metadata RPC
  // has resolved. If we only gated on `sessionState`, the empty-state
  // placeholder ("No messages yet") would flash during that window for any
  // session that actually has messages. Gating on `messagesLoaded` as well
  // keeps the loading skeleton up until the server has confirmed whether the
  // conversation is genuinely empty.
  //
  // Errors short-circuit the loading state so the error UI can render.
  const sessionStateLoaded = store.sessionState.value !== null;
  const messagesLoaded = store.messagesLoaded.value;
  // See computeChatLoading: the skeleton stays until the session has fully
  // loaded, EXCEPT for a recovery of an already-loaded session (transcript
  // stays visible). A disconnect before the first snapshot must NOT bypass the
  // skeleton — otherwise the chat renders "No messages yet" for a conversation
  // whose messages are still in flight.
  const loading = computeChatLoading({
    error,
    isRecovering,
    sessionStateLoaded,
    messagesLoaded,
  });

  // Content-column image drop zone. The composer (MessageInput) registers its
  // file-drop handler upward via registerDropTarget; this column owns the actual
  // drag/drop surface so an image can be dropped anywhere over the chat column.
  // Keep these hooks before conditional render returns so hook order remains stable.
  const dropFilesRef = useRef<FileDropHandler | null>(null);
  const registerDropTarget = useCallback((fn: FileDropHandler | null) => {
    dropFilesRef.current = fn;
  }, []);
  // A terminal session (archived / ended) loads successfully — its transcript
  // stays readable — but the composer must be disabled and a banner shown. This
  // is the soft unavailable state (vs. the full-screen view for not-found /
  // unreachable). Derived from `session.status` so a session that transitions
  // to archived mid-view also disables input.
  const sessionTerminal = session?.status === 'archived' || session?.status === 'ended';
  const composerDisabled =
    isWaitingForInput ||
    !isConnected ||
    isRecovering ||
    sessionTerminal ||
    modelSwitching ||
    coordinatorSwitching ||
    sandboxSwitching;
  const dropEnabled = !readonly && session?.status !== 'archived' && !composerDisabled;
  const { isDragging, dragHandlers } = useImageDropZone((files) => {
    void dropFilesRef.current?.(files);
  }, dropEnabled);

  // Actions for the unavailable / load-error view (task #873). Context-aware:
  // a long-horizon agent view offers "Refresh agent record" (its sessionId may
  // have changed after a reconnect/restart); an overlay offers "Go back"; every
  // case offers "Try again".
  const handleUnavailableRetry = useCallback(() => {
    store.select(sessionId);
  }, [store, sessionId]);
  const unavailableActions = useMemo<UnavailableAction[]>(() => {
    const actions: UnavailableAction[] = [];
    const hardUnavailable = loadErrorKind === 'not-found' || loadErrorKind === 'unauthorized';
    if (onBack) {
      actions.push({
        label: agentLabel ? `Back to ${agentLabel}` : 'Go back',
        onClick: onBack,
        variant: hardUnavailable ? 'primary' : 'secondary',
        testId: 'unavailable-back',
      });
    }
    if (onRefreshAgent) {
      actions.push({ label: 'Refresh', onClick: onRefreshAgent, testId: 'unavailable-refresh' });
    }
    actions.push({
      label: 'Try again',
      onClick: handleUnavailableRetry,
      variant: !hardUnavailable && !onBack ? 'primary' : 'secondary',
      testId: 'unavailable-retry',
    });
    return actions;
  }, [loadErrorKind, onBack, onRefreshAgent, agentLabel, handleUnavailableRetry]);

  // ========================================
  // Pending Agent Render (before loading check)
  // ========================================
  // When pendingAgent is set, show a "not started yet" state with a minimal
  // composer. This replaces the standalone PendingAgentOverlay component.
  if (pendingAgent) {
    return (
      <div
        class="flex-1 flex flex-col bg-app-content overflow-hidden relative"
        data-testid="pending-agent-overlay"
        aria-label={`${pendingAgent.agentName} chat (starting)`}
      >
        {/* Header — mirrors ChatHeader height (h-[52px]) for visual consistency */}
        <div class="px-4 min-h-[52px] flex-shrink-0 bg-app-content flex items-center gap-3">
          {onBack && (
            <button
              type="button"
              onClick={onBack}
              class="inline-flex h-8 w-8 items-center justify-center rounded-md text-gray-400 hover:bg-dark-800 hover:text-gray-200 transition-colors flex-shrink-0"
              aria-label="Back"
            >
              <svg class="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path
                  stroke-linecap="round"
                  stroke-linejoin="round"
                  stroke-width={2}
                  d="M15 19l-7-7 7-7"
                />
              </svg>
            </button>
          )}
          <div class="min-w-0 flex-1">
            <div class="text-sm font-medium text-gray-100 truncate">{pendingAgent.agentName}</div>
            <div class="text-xs text-gray-500 truncate">
              {pendingWaitingForSession ? 'Starting session…' : 'Not started yet'}
            </div>
          </div>
        </div>

        {/* Body */}
        <div class="flex-1 min-h-0 overflow-auto px-4 py-6">
          <div
            class={cn(
              'mx-auto max-w-md text-center text-sm rounded-lg border bg-dark-850/60 px-4 py-6',
              borderColors.ui.default
            )}
            data-testid="pending-agent-overlay-body"
          >
            {pendingWaitingForSession ? (
              <>
                <div class="mb-3 flex items-center justify-center">
                  <div class="w-5 h-5 border-2 border-blue-500 border-t-transparent rounded-full animate-spin" />
                </div>
                <p class="text-gray-200 font-medium mb-1">Starting {pendingAgent.agentName}…</p>
                <p class="text-gray-500">
                  Your message has been queued. The session will open here as soon as the agent is
                  ready.
                </p>
              </>
            ) : (
              <>
                <p class="text-gray-200 font-medium mb-1">
                  {pendingAgent.agentName} hasn't started yet
                </p>
                <p class="text-gray-500">
                  Send a message below to start this agent's session. Your first message will be
                  delivered when the session is ready.
                </p>
              </>
            )}
          </div>
        </div>

        {/* Minimal Composer */}
        <div class={cn('flex-shrink-0 border-t bg-app-content px-3 py-3', borderColors.ui.default)}>
          {pendingErrorMessage && (
            <p class="mb-2 rounded border border-red-500/30 bg-red-500/10 px-2 py-1 text-xs text-red-300">
              {pendingErrorMessage}
            </p>
          )}
          <div class="flex gap-2">
            <textarea
              ref={pendingTextareaRef}
              class="flex-1 min-h-[44px] max-h-40 resize-none rounded-md bg-dark-850 border border-dark-700 text-sm text-gray-100 px-3 py-2 placeholder-gray-500 focus:outline-none focus:border-blue-500"
              placeholder={
                pendingWaitingForSession
                  ? `Send another message to ${pendingAgent.agentName}…`
                  : `Send first message to ${pendingAgent.agentName}…`
              }
              value={pendingContent}
              onInput={(e) => {
                const next = (e.target as HTMLTextAreaElement).value;
                // An edited draft is a NEW logical send — drop the prior nonce
                // so it can't dedup against the old (already-queued) message.
                if (next !== pendingContent) pendingDraftNonceRef.current = null;
                setPendingContent(next);
              }}
              onKeyDown={handlePendingKeyDown}
              disabled={pendingSubmitting || pendingWaitingForSession}
              data-testid="pending-agent-overlay-textarea"
              rows={2}
            />
            <button
              type="button"
              onClick={() => void handlePendingSend()}
              disabled={!pendingContent.trim() || pendingSubmitting}
              class={cn(
                'inline-flex items-center justify-center rounded-md px-3 text-sm font-medium transition-colors flex-shrink-0',
                'bg-blue-600 text-white hover:bg-blue-500',
                'disabled:bg-dark-700 disabled:text-gray-500 disabled:cursor-not-allowed'
              )}
              data-testid="pending-agent-overlay-send"
            >
              {pendingSubmitting ? 'Starting…' : 'Send'}
            </button>
          </div>
        </div>
      </div>
    );
  }

  // ---- Unavailable / load-error routing (task #873) ----
  // A classified load failure short-circuits to ONE accurate, per-cause state,
  // replacing the legacy collapsed "Failed to load session" screen. Both
  // confirmed-gone (not-found / unauthorized) and transient (timeout /
  // disconnected / unknown) kinds render full-screen: there is no transcript
  // for a session that never loaded, so this also guarantees an invalid
  // nonempty session id never reaches the "No messages yet" placeholder.
  // Archived / terminated are NOT load errors — they keep the transcript and
  // are surfaced as a banner inside the main render below.
  const storeHasNoSessionInfo =
    store.sessionState.value !== null && store.sessionState.value?.sessionInfo === null;
  const route = resolveChatRoute({
    pending: false, // pendingAgent is handled by the early return above
    loadErrorKind,
    loading,
    loadTimedOut,
    legacyFatal: !!error && (!session || storeHasNoSessionInfo),
  });

  if (route.route === 'unavailable') {
    const kind: SessionUnavailableKind = route.unavailableKind ?? 'unknown';
    return (
      <UnavailableSessionView
        kind={kind}
        actions={unavailableActions}
        detail={kind === 'unknown' ? (error ?? undefined) : undefined}
      />
    );
  }

  // Initial-load skeleton (no load error). The 30s backstop resolves via
  // resolveChatRoute to an unavailable 'timeout' above, so reaching here means
  // a normal in-progress load.
  if (route.route === 'loading') {
    return (
      // `relative` is required so the absolutely-positioned footer skeleton is
      // anchored to this container, matching the real ChatComposer positioning.
      <div class="flex-1 flex flex-col bg-app-content overflow-hidden relative">
        {/* Skeleton header — h-[52px] matches ChatHeader's fixed height exactly */}
        <div class="flex items-center gap-3 px-4 h-[52px] flex-shrink-0">
          <div class="w-4 h-4 rounded-full bg-dark-700 animate-pulse" />
          <div class="h-4 w-48 rounded bg-dark-700 animate-pulse" />
        </div>
        {/* Skeleton messages area — flex-1 fills all remaining space, matching the
				    real layout where ChatComposer is absolutely positioned (not in flex flow) */}
        <div class="flex-1 flex items-center justify-center">
          <div class="w-6 h-6 border-2 border-blue-500 border-t-transparent rounded-full animate-spin" />
        </div>
        {/* Skeleton footer — absolute bottom-0 matches ChatComposer's
				    `absolute bottom-0 left-0 right-0` so it doesn't participate in the
				    flex layout (prevents the messages area from shifting on load) */}
        <div class="absolute bottom-0 left-0 right-0 pt-4 pb-4 px-4">
          <div class="h-10 rounded-2xl bg-dark-800 animate-pulse" />
        </div>
      </div>
    );
  }

  // route === 'ready' (pending is handled above). Archived / terminated are
  // surfaced as a banner inside this main render so the transcript stays
  // readable; recovery shows its own non-blocking banner.
  return (
    <div
      class="flex-1 flex flex-col bg-app-content overflow-hidden relative"
      data-testid="chat-container"
      {...dragHandlers}
    >
      {isDragging && <ImageDropOverlay />}
      {/* Loading overlay for archive/delete operations.
          z-40 sits above the ChatHeader (z-30) so this blocking overlay
          covers the header and its info panel while a mutation is pending. */}
      {(sessionActions.archiving || sessionActions.deleting) && (
        <div class="absolute inset-0 z-40 flex items-center justify-center bg-dark-900/80 backdrop-blur-sm">
          <div class="text-center">
            <Spinner size="lg" className="mx-auto mb-3" />
            <p class="text-sm text-gray-400">
              {sessionActions.deleting ? 'Deleting session...' : 'Archiving session...'}
            </p>
          </div>
        </div>
      )}

      {/* Error Banner */}
      {error && (
        <ErrorBanner
          error={error}
          hasDetails={!!storeError?.details}
          onViewDetails={errorDialog.open}
          onDismiss={() => {
            setLocalError(null);
            store.clearError();
          }}
          actions={errorActions.length > 0 ? errorActions : undefined}
        />
      )}

      {/* Recovery indicator — non-blocking. The transcript stays visible and
          read-only underneath while this session rejoins its channel and
          re-syncs state/messages after a connection drop or background resume.
          Shown only when there is no error (a real load failure renders its own
          screen) and we are not on the initial load (skeleton handles that). */}
      {isRecovering && !error && !isInitialLoad && (
        <div
          class="flex items-center justify-center gap-2 border-b border-blue-500/20 bg-blue-500/10 px-4 py-1.5 text-xs text-blue-200"
          data-testid="session-recovering-banner"
          role="status"
          aria-live="polite"
        >
          <div class="h-3 w-3 rounded-full border-2 border-blue-400 border-t-transparent animate-spin" />
          Reconnecting — restoring this session…
        </div>
      )}

      {/* Terminal-session banner (archived / ended). The transcript stays
          readable above; the composer is disabled (sessionTerminal). One
          explicit, non-blocking state with the same contextual actions as the
          full-screen unavailable view (Go back / Refresh when provided). */}
      {sessionTerminal && !isInitialLoad && !error && (
        <div
          class="flex items-center justify-between gap-2 border-b border-amber-500/20 bg-amber-500/10 px-4 py-1.5 text-xs text-amber-200"
          data-testid={`session-${session?.status}-banner`}
          role="status"
          aria-live="polite"
        >
          <span>
            {session?.status === 'archived'
              ? 'This session has been archived.'
              : 'This session has ended.'}
          </span>
          {(onBack || onRefreshAgent) && (
            <span class="flex items-center gap-2">
              {onRefreshAgent && (
                <button
                  type="button"
                  class="rounded px-1.5 py-0.5 text-amber-200 hover:bg-amber-500/20"
                  onClick={onRefreshAgent}
                >
                  Refresh
                </button>
              )}
              {onBack && (
                <button
                  type="button"
                  class="rounded px-1.5 py-0.5 text-amber-200 hover:bg-amber-500/20"
                  onClick={onBack}
                >
                  Go back
                </button>
              )}
            </span>
          )}
        </div>
      )}

      {/* Rate Limit Cooldown Banner */}
      {agentState.status === 'rate_limit_cooldown' && session && (
        <RateLimitCooldownBanner
          sessionId={session.id}
          retryCount={agentState.retryCount}
          maxRetries={agentState.maxRetries}
          retryAt={agentState.retryAt}
        />
      )}

      {/* Header */}
      <ChatHeader
        session={session}
        features={features}
        onToolsClick={toolsModal.open}
        onExportClick={sessionActions.handleExportChat}
        onResetClick={sessionActions.handleResetAgent}
        onArchiveClick={sessionActions.handleArchiveClick}
        onDeleteClick={deleteModal.open}
        archiving={sessionActions.archiving}
        resettingAgent={sessionActions.resettingAgent}
        readonly={readonly}
        onBack={onBack}
        titleOverride={titleOverride}
        messages={messages}
        backgroundTaskMessages={backgroundTaskMessages}
        toolInputsMap={maps.toolInputsMap}
      />

      {/* Messages */}
      <div class="flex-1 relative min-h-0">
        <div
          ref={messagesContainerRef}
          data-messages-container
          class="absolute inset-0 overflow-y-scroll overscroll-contain touch-pan-y"
          style={{
            WebkitOverflowScrolling: 'touch',
            paddingBottom: `var(--messages-bottom-padding, ${MIN_MESSAGES_BOTTOM_PADDING_PX}px)`,
            // Mirror paddingBottom so browser-driven scrolls (scrollIntoView,
            // focus/anchor scroll) stop short of the floating composer instead
            // of parking the last message behind it.
            scrollPaddingBottom: `var(--messages-bottom-padding, ${MIN_MESSAGES_BOTTOM_PADDING_PX}px)`,
          }}
        >
          {/* Worktree Choice Inline */}
          {showWorktreeChoice && session?.workspacePath && (
            <WorktreeChoiceInline
              sessionId={sessionId}
              workspacePath={session.workspacePath}
              onModeChange={handleWorktreeModeChange}
            />
          )}

          {/* Loading overlay for rewind operation */}
          {isRewinding && (
            <div class="absolute inset-0 z-50 bg-dark-900/80 backdrop-blur-sm flex items-center justify-center">
              <div class="bg-dark-800 border border-amber-500/30 rounded-xl p-6 flex flex-col items-center gap-4 shadow-2xl">
                <Spinner size="lg" color="border-amber-500" />
                <div class="text-amber-200 text-sm font-medium">Rewinding conversation...</div>
                <div class="text-gray-400 text-xs">This may take a moment</div>
              </div>
            </div>
          )}
          {messages.length === 0 ? (
            showWorkspaceSelector && session ? (
              <WorkspaceSelector
                sessionId={sessionId}
                onConfirm={() => setShowWorkspaceSelector(false)}
                onSkip={() => setShowWorkspaceSelector(false)}
              />
            ) : (
              <div class="min-h-[calc(100%+1px)] flex items-center justify-center px-6">
                <div class="text-center">
                  <div class="text-5xl mb-4">💬</div>
                  <p class="text-lg text-gray-300 mb-2">No messages yet</p>
                  <p class="text-sm text-gray-500">
                    Start a conversation with Claude to see the magic happen
                  </p>
                </div>
              </div>
            )
          ) : (
            <ContentContainer className="space-y-0 min-h-[calc(100%+1px)]">
              {/* Load More Button */}
              {hasMoreMessages && messages.length > 0 && (
                <div class="flex items-center justify-center py-4">
                  <Button
                    variant="secondary"
                    size="sm"
                    onClick={loadOlderMessages}
                    disabled={loadingOlder}
                  >
                    {loadingOlder ? (
                      <>
                        <Spinner size="sm" className="mr-2" />
                        Loading...
                      </>
                    ) : (
                      'Load More Messages'
                    )}
                  </Button>
                </div>
              )}

              {!hasMoreMessages && messages.length > 0 && (
                <div class="flex items-center justify-center py-4">
                  <div class="text-xs text-gray-500">Beginning of conversation</div>
                </div>
              )}

              {/* Messages - QuestionPrompt rendered inline with AskUserQuestion tool blocks */}
              {messages.map((msg, idx) => (
                <div
                  key={msg.uuid || `msg-${idx}`}
                  data-message-id={msg.uuid || (msg as ChatMessage & { id?: string }).id}
                  class="scroll-mt-20"
                >
                  <SDKMessageRenderer
                    message={msg}
                    toolResultsMap={maps.toolResultsMap}
                    toolInputsMap={maps.toolInputsMap}
                    subagentMessagesMap={maps.subagentMessagesMap}
                    taskNotificationsMap={maps.taskNotificationsMap}
                    taskProgressMap={maps.taskProgressMap}
                    foldableToolUseIds={maps.foldableToolUseIds}
                    completedHookUuids={maps.completedHookUuids}
                    runningToolUseIds={
                      msg.uuid ? maps.runningToolUseIdsByMessageUuid.get(msg.uuid) : undefined
                    }
                    replacementStatusMap={maps.replacementStatusMap}
                    sessionInfo={
                      msg.uuid
                        ? (maps.sessionInfoMap.get(msg.uuid) as SDKSystemMessage | undefined)
                        : undefined
                    }
                    sessionId={sessionId}
                    resolvedQuestions={allResolvedQuestions}
                    pendingQuestion={isRecovering ? null : pendingQuestion}
                    onRewind={isRecovering ? undefined : handleRewindClick}
                    rewindingMessageUuid={isRewinding ? rewindTargetUuid : null}
                    onQuestionResolved={handleQuestionResolved}
                    replacementStatus={
                      msg.uuid ? maps.replacementStatusMap.get(msg.uuid) : undefined
                    }
                    isLiveTail={idx === messages.length - 1}
                  />
                </div>
              ))}
            </ContentContainer>
          )}

          <div ref={messagesEndRef} />
        </div>

        {/* Scroll Button - positioned relative to container, not scrollable content */}
        {showScrollButton && (
          <ScrollToBottomButton onClick={() => scrollToBottom(true)} autoScroll={autoScroll} />
        )}
      </div>

      {/* Footer - Floating Status Bar */}
      <ChatComposer
        sessionId={sessionId}
        readonly={readonly}
        sessionStatus={session?.status}
        sessionType={session?.type}
        thinkingLevel={
          session?.config?.thinkingLevel
            ? normalizeThinkingLevel(session.config.thinkingLevel)
            : undefined
        }
        isProcessing={isProcessing}
        currentAction={currentAction}
        streamingPhase={streamingPhase}
        contextUsage={contextUsage ?? undefined}
        features={features}
        currentModel={currentModel}
        currentModelInfo={currentModelInfo}
        availableModels={availableModels}
        modelSwitching={modelSwitching}
        modelLoading={modelLoading}
        autoScroll={autoScroll}
        coordinatorMode={coordinatorMode}
        coordinatorSwitching={coordinatorSwitching}
        sandboxEnabled={sandboxEnabled}
        sandboxSwitching={sandboxSwitching}
        isWaitingForInput={isWaitingForInput}
        isConnected={isConnected}
        isRecovering={isRecovering}
        onModelSwitch={handleModelSwitchWithConfirmation}
        onAutoScrollChange={handleAutoScrollChange}
        onCoordinatorModeChange={handleCoordinatorModeChange}
        onSandboxModeChange={handleSandboxModeChange}
        onSend={handleSendMessage}
        // Task-agent overlays now honor deferred (Queue) delivery through
        // sendTaskMessage, so Queue controls are always available — same as
        // the main chat.
        supportsQueueDelivery
        onOpenTools={toolsModal.open}
        registerDropTarget={registerDropTarget}
        store={store}
      />

      {/* Delete Modal */}
      <Modal isOpen={deleteModal.isOpen} onClose={deleteModal.close} title="Delete Chat" size="sm">
        <div class="space-y-4">
          <p class="text-gray-300 text-sm">
            Are you sure you want to delete this chat session? This action cannot be undone.
          </p>
          <div class="flex gap-3 justify-end">
            <Button
              variant="secondary"
              onClick={deleteModal.close}
              disabled={sessionActions.deleting}
            >
              Cancel
            </Button>
            <Button
              variant="danger"
              onClick={sessionActions.handleDeleteSession}
              loading={sessionActions.deleting}
              data-testid="confirm-delete-session"
            >
              Delete Chat
            </Button>
          </div>
        </div>
      </Modal>

      {/* Archive Confirmation */}
      {sessionActions.archiveConfirmDialog?.show &&
        sessionActions.archiveConfirmDialog.commitStatus && (
          <ArchiveConfirmDialog
            commitStatus={sessionActions.archiveConfirmDialog.commitStatus}
            archiving={sessionActions.archiving}
            onConfirm={sessionActions.handleConfirmArchive}
            onCancel={sessionActions.handleCancelArchive}
          />
        )}

      {/* Tools Modal */}
      <ToolsModal isOpen={toolsModal.isOpen} onClose={toolsModal.close} session={session} />

      {/* Error Dialog */}
      <ErrorDialog
        isOpen={errorDialog.isOpen}
        onClose={errorDialog.close}
        error={store.getErrorDetails()}
        isDev={import.meta.env.DEV === 'true' || import.meta.env.MODE === 'development'}
      />

      {/* Rewind Confirmation Modal */}
      <Modal
        isOpen={rewindConfirmModal.isOpen}
        onClose={handleRewindCancel}
        title="Rewind Conversation"
        size="sm"
      >
        <div class="space-y-4">
          <p class="text-gray-300 text-sm">
            This will rewind the conversation to before this message. Choose what to restore:
          </p>
          <div class="space-y-2">
            <label class="flex items-center gap-2 cursor-pointer">
              <input
                type="radio"
                name="perMessageRewindMode"
                value="both"
                checked={rewindModeChoice === 'both'}
                onChange={() => setRewindModeChoice('both')}
                class="text-amber-500 focus:ring-amber-500"
              />
              <span class="text-sm text-gray-200">Files & Conversation</span>
            </label>
            <label class="flex items-center gap-2 cursor-pointer">
              <input
                type="radio"
                name="perMessageRewindMode"
                value="files"
                checked={rewindModeChoice === 'files'}
                onChange={() => setRewindModeChoice('files')}
                class="text-amber-500 focus:ring-amber-500"
              />
              <span class="text-sm text-gray-200">Files only</span>
            </label>
            <label class="flex items-center gap-2 cursor-pointer">
              <input
                type="radio"
                name="perMessageRewindMode"
                value="conversation"
                checked={rewindModeChoice === 'conversation'}
                onChange={() => setRewindModeChoice('conversation')}
                class="text-amber-500 focus:ring-amber-500"
              />
              <span class="text-sm text-gray-200">Conversation only</span>
            </label>
          </div>
          <p class="text-amber-400 text-xs">This action cannot be undone.</p>
          <div class="flex gap-3 justify-end">
            <Button variant="secondary" onClick={handleRewindCancel} disabled={isRewinding}>
              Cancel
            </Button>
            <Button variant="danger" onClick={handleRewindConfirm} loading={isRewinding}>
              {isRewinding ? 'Rewinding...' : 'Rewind'}
            </Button>
          </div>
        </div>
      </Modal>
    </div>
  );
}
