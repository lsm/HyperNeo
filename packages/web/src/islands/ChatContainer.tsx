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

export type ChatRoute = 'pending' | 'unavailable' | 'loading' | 'ready';

export interface ChatRouteDecision {
  route: ChatRoute;
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
  store?: SessionStore;
}): Promise<boolean> {
  if (onSendOverride) {
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
  onBack?: () => void;
  highlightMessageId?: string;
  titleOverride?: string;
  pendingAgent?: { taskId: string; agentName: string; workflowNodeId?: string | null } | null;
  onSendOverride?: (
    content: string,
    images?: MessageImage[],
    deliveryMode?: MessageDeliveryMode
  ) => Promise<boolean>;
  store?: SessionStore;
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
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const messagesContainerRef = useRef<HTMLDivElement>(null);
  const scrollPositionRestoreRef = useRef<{
    oldScrollHeight: number;
    oldScrollTop: number;
    shouldRestore: boolean;
  } | null>(null);

  const resolvingQuestionsRef = useRef<Map<string, ResolvedQuestion>>(new Map());
  const pendingMessageVisibilityChecksRef = useRef<Map<string, ReturnType<typeof setTimeout>>>(
    new Map()
  );

  const [pendingContent, setPendingContent] = useState('');
  const [pendingSubmitting, setPendingSubmitting] = useState(false);
  const pendingDraftNonceRef = useRef<string | null>(null);
  const [pendingWaitingForSession, setPendingWaitingForSession] = useState(false);
  const [pendingErrorMessage, setPendingErrorMessage] = useState<string | null>(null);
  const pendingTextareaRef = useRef<HTMLTextAreaElement>(null);

  const pendingLiveMember = useMemo(() => {
    if (!pendingAgent) return undefined;
    const members = spaceStore.taskActivity.value.get(pendingAgent.taskId) ?? [];
    return members.find(
      (m) =>
        m.kind === 'node_agent' &&
        m.role === pendingAgent.agentName &&
        m.sessionId &&
        m.nodeExecution?.status !== 'cancelled' &&
        m.nodeExecution?.status !== 'pending' &&
        (!pendingAgent.workflowNodeId || m.nodeExecution?.nodeId === pendingAgent.workflowNodeId)
    );
  }, [pendingAgent, spaceStore.taskActivity.value]);

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
          ...(pendingAgent.workflowNodeId ? { workflowNodeId: pendingAgent.workflowNodeId } : {}),
        }
      );
    }
  }, [pendingLiveMember, pendingAgent]);

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

  const [loadingOlder, setLoadingOlder] = useState(false);
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

  const [resolvedQuestions, setResolvedQuestions] = useState<Map<string, ResolvedQuestion>>(
    new Map()
  );

  const [rewindModeChoice, setRewindModeChoice] = useState<'files' | 'conversation' | 'both'>(
    'both'
  );

  const [rewindTargetUuid, setRewindTargetUuid] = useState<string | null>(null);
  const [isRewinding, setIsRewinding] = useState(false);

  const [showWorktreeChoice, setShowWorktreeChoice] = useState(false);
  const [pendingWorktreeMode, setPendingWorktreeMode] = useState<'worktree' | 'direct'>('worktree');

  const [showWorkspaceSelector, setShowWorkspaceSelector] = useState(false);

  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [backgroundTaskMessages, setBackgroundTaskMessages] = useState<ChatMessage[]>([]);
  const [session, setSession] = useState(store.sessionInfo.value);

  const deleteModal = useModal();
  const toolsModal = useModal();
  const errorDialog = useModal();
  const rewindConfirmModal = useModal();

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

  const [contextUsage, setContextUsage] = useState(store.contextInfo.value);
  const [agentState, setAgentState] = useState(store.agentState.value);
  const [storeError, setStoreError] = useState(store.error.value);

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

  const features: SessionFeatures = useMemo(() => {
    if (session?.config?.features) {
      return session.config.features;
    }
    if (sessionId.startsWith('space:chat:')) {
      return { ...DEFAULT_WORKER_FEATURES, archive: false };
    }
    if (sessionId.startsWith('lobby:')) {
      return DEFAULT_LOBBY_FEATURES;
    }
    return DEFAULT_WORKER_FEATURES;
  }, [session?.config?.features, sessionId]);

  useSignalEffect(() => {
    setContextUsage(store.contextInfo.value);
  });

  useSignalEffect(() => {
    setAgentState(store.agentState.value);
  });

  useSignalEffect(() => {
    setStoreError(store.error.value);
  });

  const [isRecovering, setIsRecovering] = useState(store.isRecovering.value);
  useSignalEffect(() => {
    setIsRecovering(store.isRecovering.value);
  });

  const [loadErrorKind, setLoadErrorKind] = useState<SessionLoadErrorKind | null>(
    store.loadErrorKind.value
  );
  useSignalEffect(() => {
    setLoadErrorKind(store.loadErrorKind.value);
  });

  useSignalEffect(() => {
    setHasMoreMessages(store.hasMoreMessages.value);
  });

  useSignalEffect(() => {
    const sessionStateLoaded = store.sessionState.value !== null;
    const messagesLoaded = store.messagesLoaded.value;
    if (sessionStateLoaded && messagesLoaded) {
      setIsInitialLoad(false);
      setLoadTimedOut(false);
    }
  });

  useEffect(() => {
    if (!isInitialLoad) return;
    const timer = setTimeout(() => {
      setLoadTimedOut(true);
    }, 30_000);
    return () => clearTimeout(timer);
  }, [isInitialLoad]);

  useEffect(() => {
    if (session?.metadata?.resolvedQuestions) {
      const map = new Map<string, ResolvedQuestion>();
      for (const [toolUseId, resolved] of Object.entries(session.metadata.resolvedQuestions)) {
        map.set(toolUseId, resolved);
      }
      setResolvedQuestions(map);

      const refMap = resolvingQuestionsRef.current;
      for (const toolUseId of map.keys()) {
        refMap.delete(toolUseId);
      }
    }
  }, [session?.metadata?.resolvedQuestions]);

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

  const handleWorktreeModeChange = (mode: 'worktree' | 'direct') => {
    setPendingWorktreeMode(mode);
  };

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

  const sessionActions = useSessionActions({
    sessionId,
    session,
    onDeleteModalClose: deleteModal.close,
    onStateReset: useCallback(() => {
      setLocalError(null);
      store.clearError();
    }, []),
  });

  const loadOlderMessages = useCallback(async () => {
    if (loadingOlder || !hasMoreMessages || messages.length === 0) return;

    try {
      setLoadingOlder(true);

      const container = messagesContainerRef.current;
      if (!container) return;

      const oldScrollHeight = container.scrollHeight;
      const oldScrollTop = container.scrollTop;

      const oldestMessage = messages[0] as ChatMessage & { timestamp?: number; rowid?: number };
      const beforeTimestamp = oldestMessage?.timestamp;
      if (!beforeTimestamp) {
        setHasMoreMessages(false);
        return;
      }

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

      scrollPositionRestoreRef.current = {
        oldScrollHeight,
        oldScrollTop,
        shouldRestore: true,
      };

      store.prependMessages(olderMessages);
      setHasMoreMessages(hasMore);
    } catch {
      toast.error('Failed to load older messages');
    } finally {
      setLoadingOlder(false);
    }
  }, [loadingOlder, hasMoreMessages, messages]);

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

  const isNewMountRef = useRef(true);

  useEffect(() => {
    if (pendingAgent) return;
    if (sessionId && (sessionId !== store.activeSessionId.value || isNewMountRef.current)) {
      store.select(sessionId);
    }
    isNewMountRef.current = false;
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

  useLayoutEffect(() => {
    if (!scrollPositionRestoreRef.current?.shouldRestore) return;

    const { oldScrollHeight, oldScrollTop } = scrollPositionRestoreRef.current;
    const container = messagesContainerRef.current;

    if (!container) return;

    const newScrollTop = oldScrollTop + (container.scrollHeight - oldScrollHeight);
    container.scrollTop = newScrollTop;

    scrollPositionRestoreRef.current = null;
  }, [messages.length, loadingOlder]);

  const { showScrollButton, scrollToBottom } = useAutoScroll({
    containerRef: messagesContainerRef,
    endRef: messagesEndRef,
    enabled: autoScroll && !highlightMessageId && !searchTargetMessageId,
    messageCount: messages.length,
    isInitialLoad,
    loadingOlder,
    resetKey: sessionId,
  });

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
      if (pendingQuestion) {
        const resolved = {
          question: pendingQuestion,
          state,
          responses,
          resolvedAt: Date.now(),
        };
        resolvingQuestionsRef.current.set(pendingQuestion.toolUseId, resolved);
        setResolvedQuestions((prev) => {
          const next = new Map(prev);
          next.set(pendingQuestion.toolUseId, resolved);
          return next;
        });
      }
    },
    [pendingQuestion]
  );

  const allResolvedQuestions = useMemo(() => {
    const combined = new Map<string, ResolvedQuestion>(resolvedQuestions);
    for (const [toolUseId, resolved] of resolvingQuestionsRef.current) {
      combined.set(toolUseId, resolved);
    }
    return combined;
  }, [resolvedQuestions]);

  const isConnected = connectionState.value === 'connected';

  const handleSendMessage = useCallback(
    async (
      content: string,
      images?: MessageImage[],
      deliveryMode: MessageDeliveryMode = 'immediate'
    ) => {
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
        } catch {
          toast.error('Failed to set workspace mode');
          return false;
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

  const retryAttempts = store.retryAttempts.value;

  const retryStatusMessage = useMemo(() => {
    if (retryAttempts.length === 0) return null;
    const lastRetry = retryAttempts[retryAttempts.length - 1];
    const progress = `${lastRetry.attempt}/${lastRetry.max_retries}`;
    const errorInfo = lastRetry.error_status ? ` (${lastRetry.error_status})` : '';
    return `API retry: attempt ${progress}${errorInfo} - ${lastRetry.error}`;
  }, [retryAttempts]);

  const error = localError || retryStatusMessage || storeError?.message || null;

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

  const sessionStateLoaded = store.sessionState.value !== null;
  const messagesLoaded = store.messagesLoaded.value;
  const loading = computeChatLoading({
    error,
    isRecovering,
    sessionStateLoaded,
    messagesLoaded,
  });

  const dropFilesRef = useRef<FileDropHandler | null>(null);
  const registerDropTarget = useCallback((fn: FileDropHandler | null) => {
    dropFilesRef.current = fn;
  }, []);
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

  if (pendingAgent) {
    return (
      <div
        class="flex-1 flex flex-col bg-app-content overflow-hidden relative"
        data-testid="pending-agent-overlay"
        aria-label={`${pendingAgent.agentName} chat (starting)`}
      >
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

  const storeHasNoSessionInfo =
    store.sessionState.value !== null && store.sessionState.value?.sessionInfo === null;
  const route = resolveChatRoute({
    pending: false,
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

  if (route.route === 'loading') {
    return (
      <div class="flex-1 flex flex-col bg-app-content overflow-hidden relative">
        <div class="flex items-center gap-3 px-4 h-[52px] flex-shrink-0">
          <div class="w-4 h-4 rounded-full bg-dark-700 animate-pulse" />
          <div class="h-4 w-48 rounded bg-dark-700 animate-pulse" />
        </div>
        <div class="flex-1 flex items-center justify-center">
          <div class="w-6 h-6 border-2 border-blue-500 border-t-transparent rounded-full animate-spin" />
        </div>
        <div class="absolute bottom-0 left-0 right-0 pt-4 pb-4 px-4">
          <div class="h-10 rounded-2xl bg-dark-800 animate-pulse" />
        </div>
      </div>
    );
  }

  return (
    <div
      class="flex-1 flex flex-col bg-app-content overflow-hidden relative"
      data-testid="chat-container"
      {...dragHandlers}
    >
      {isDragging && <ImageDropOverlay />}
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

      {agentState.status === 'rate_limit_cooldown' && session && (
        <RateLimitCooldownBanner
          sessionId={session.id}
          retryCount={agentState.retryCount}
          maxRetries={agentState.maxRetries}
          retryAt={agentState.retryAt}
        />
      )}

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

      <div class="flex-1 relative min-h-0">
        <div
          ref={messagesContainerRef}
          data-messages-container
          class="absolute inset-0 overflow-y-scroll overscroll-contain touch-pan-y"
          style={{
            WebkitOverflowScrolling: 'touch',
            paddingBottom: `var(--messages-bottom-padding, ${MIN_MESSAGES_BOTTOM_PADDING_PX}px)`,
            scrollPaddingBottom: `var(--messages-bottom-padding, ${MIN_MESSAGES_BOTTOM_PADDING_PX}px)`,
          }}
        >
          {showWorktreeChoice && session?.workspacePath && (
            <WorktreeChoiceInline
              sessionId={sessionId}
              workspacePath={session.workspacePath}
              onModeChange={handleWorktreeModeChange}
            />
          )}

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

        {showScrollButton && (
          <ScrollToBottomButton onClick={() => scrollToBottom(true)} autoScroll={autoScroll} />
        )}
      </div>

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
        supportsQueueDelivery
        onOpenTools={toolsModal.open}
        registerDropTarget={registerDropTarget}
        store={store}
      />

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

      {sessionActions.archiveConfirmDialog?.show &&
        sessionActions.archiveConfirmDialog.commitStatus && (
          <ArchiveConfirmDialog
            commitStatus={sessionActions.archiveConfirmDialog.commitStatus}
            archiving={sessionActions.archiving}
            onConfirm={sessionActions.handleConfirmArchive}
            onCancel={sessionActions.handleCancelArchive}
          />
        )}

      <ToolsModal isOpen={toolsModal.isOpen} onClose={toolsModal.close} session={session} />

      <ErrorDialog
        isOpen={errorDialog.isOpen}
        onClose={errorDialog.close}
        error={store.getErrorDetails()}
        isDev={import.meta.env.DEV === 'true' || import.meta.env.MODE === 'development'}
      />

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
