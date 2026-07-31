/**
 * MessageInput Component
 *
 * iOS 26-style floating message input with auto-resize textarea,
 * command autocomplete, file attachments, and action menu.
 *
 * Refactored to use shared hooks for better separation of concerns.
 */

import type {
  MessageDeliveryMode,
  MessageImage,
  ModelInfo,
  ReferenceMention,
  SessionFeatures,
  SessionType,
} from '@hyperneo/shared';
import type { ComponentChildren } from 'preact';
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'preact/hooks';
import {
  useCommandAutocomplete,
  useFileAttachments,
  useInputDraft,
  useInterrupt,
  useModal,
  useModelSwitcher,
  isVoiceRecordingSupported,
  useReferenceAutocomplete,
  useVoiceRecorder,
  type RegisterFileDropTarget,
} from '../hooks';

import { getMessagesBottomPaddingPx } from '../lib/layout-metrics.ts';
import { connectionManager } from '../lib/connection-manager';
import { globalSettings, isAgentWorking } from '../lib/state.ts';
import { toast } from '../lib/toast.ts';
import { AttachmentPreview } from './AttachmentPreview.tsx';
import { InputActionsMenu } from './InputActionsMenu.tsx';
import { InputTextarea } from './InputTextarea.tsx';
import { QueuePreviewTray, type QueuePreviewMessage } from './QueuePreviewTray.tsx';
import { ContentContainer } from './ui/ContentContainer.tsx';

/**
 * Replace the active @query at the end of `content` with a formatted reference token.
 *
 * Scans for the last word-boundary `@\S*` at the end of the string (matching
 * the same logic as `extractActiveAtQuery` in `useReferenceAutocomplete`), then
 * replaces it with `@ref{type:id} ` (trailing space prevents re-triggering).
 *
 * Returns the updated content, or the original string if no active @query is found.
 */
export function replaceActiveAtQuery(content: string, type: string, id: string): string {
  const replacement = `@ref{${type}:${id}} `;
  // Match the last word-boundary @ and the non-whitespace characters following it.
  // Group 1 captures the leading whitespace (or empty string at start) so we can
  // preserve it in the replacement.
  const match = content.match(/((?:^|\s))@(\S*)$/);
  if (!match) return content;
  const prefix = match[1];
  const matchStart = content.length - match[0].length;
  return content.slice(0, matchStart) + prefix + replacement;
}

// Trailing boundary: never insert a space before whitespace or punctuation
// (e.g. ",", ".", ")") — "world" + "," stays "world,".
const NON_JOINING_BOUNDARY = /[\s\p{P}]/u;
function isNonJoiningBoundary(char: string): boolean {
  return char.length > 0 && NON_JOINING_BOUNDARY.test(char);
}

// Decide whether a leading space should be suppressed before the transcript,
// given the full text preceding the caret. Whitespace and an opening
// bracket/quote suppress it; ASCII straight quotes are treated as opening only
// when preceded by whitespace or start-of-text, so a closing quote or
// possessive ('He said "hi"' / "users'") still gets a space. Other punctuation
// (".", "!", "?", ",") keeps the space — "Hello." + "World" -> "Hello. World".
const ASCII_QUOTE = /['"`]/;
function suppressLeadingSpace(before: string): boolean {
  if (before.length === 0) return false;
  const last = before.slice(-1);
  if (/\s/.test(last)) return true;
  if (/\p{Ps}|\p{Pi}/u.test(last)) return true;
  if (ASCII_QUOTE.test(last)) {
    const prev = before.slice(-2, -1);
    return prev === '' || /\s/.test(prev);
  }
  return false;
}

function getPlaceholderForSessionType(sessionType?: SessionType): string {
  switch (sessionType) {
    case 'worker':
    default:
      return 'Ask or make anything...';
  }
}

interface MessageInputProps {
  sessionId: string;
  sessionType?: SessionType;
  onSend: (
    content: string,
    images?: MessageImage[],
    deliveryMode?: MessageDeliveryMode
  ) => Promise<void | boolean>;
  disabled?: boolean;
  autoScroll?: boolean;
  onAutoScrollChange?: (autoScroll: boolean) => void;
  onOpenTools?: () => void;
  agentMentionCandidates?: Array<{ id: string; name: string }>;
  /** Override the default placeholder derived from sessionType */
  placeholder?: string;
  /** Optional control rendered inside the input, on the left side */
  leadingElement?: ComponentChildren;
  /** Left padding class used when leadingElement is present */
  leadingPaddingClass?: string;
  /** Emits whether the current draft has non-whitespace content */
  onDraftActiveChange?: (hasDraft: boolean) => void;
  /** Whether the backing agent/session is currently processing or queued. */
  isProcessing?: boolean;
  /**
   * Registers this composer's file-drop handler with the parent drop zone
   * (the content column). When provided, the column owns the drag/drop surface
   * and forwards dropped files here. When omitted, no column-level drop zone is
   * active.
   */
  registerDropTarget?: RegisterFileDropTarget;
  /** Coordinator mode toggle (rendered in the + menu) */
  coordinatorMode?: boolean;
  coordinatorSwitching?: boolean;
  onCoordinatorModeChange?: (enabled: boolean) => void;
  /** Sandbox mode toggle (rendered in the + menu) */
  sandboxEnabled?: boolean;
  sandboxSwitching?: boolean;
  onSandboxModeChange?: (enabled: boolean) => void;
  /** Feature flags gating the coordinator/sandbox menu items */
  features?: SessionFeatures;
}

export default function MessageInput({
  sessionId,
  sessionType,
  onSend,
  disabled,
  autoScroll,
  onAutoScrollChange,
  onOpenTools,
  coordinatorMode = false,
  coordinatorSwitching = false,
  onCoordinatorModeChange,
  sandboxEnabled = false,
  sandboxSwitching = false,
  onSandboxModeChange,
  features,
  agentMentionCandidates,
  placeholder: placeholderProp,
  leadingElement,
  leadingPaddingClass,
  onDraftActiveChange,
  isProcessing,
  registerDropTarget,
}: MessageInputProps) {
  // Cache touch device detection — computed once on first render, stable thereafter.
  // Using useRef (not a module constant) so tests can mock matchMedia before render.
  const isTouchDeviceRef = useRef(
    window.matchMedia('(pointer: coarse)').matches ||
      ('ontouchstart' in window && window.innerWidth < 768)
  );

  // Textarea ref for programmatic focus after reference selection
  const textareaInputRef = useRef<HTMLTextAreaElement>(null);

  // Guard against stale onInput events racing with submit/clear
  const submittingRef = useRef(false);

  // Use shared hooks
  const { content, setContent, clear: clearDraft } = useInputDraft(sessionId);
  const {
    currentModel,
    currentModelInfo,
    availableModels,
    switching: modelSwitching,
    loading: modelLoading,
    switchModel,
  } = useModelSwitcher(sessionId);
  const actionsMenu = useModal();
  const {
    attachments,
    fileInputRef,
    handleFileSelect,
    handleFileDrop,
    handleRemove,
    clear: clearAttachments,
    restore: restoreAttachments,
    openFilePicker,
    getImagesForSend,
    handlePaste,
  } = useFileAttachments();
  const { handleInterrupt } = useInterrupt({ sessionId });
  const voiceRecorder = useVoiceRecorder();
  const [isTranscribing, setIsTranscribing] = useState(false);
  const voiceEnabled = globalSettings.value?.voice?.enabled ?? false;
  const voiceControlVisible =
    voiceEnabled || voiceRecorder.isRecording || voiceRecorder.durationLimitHit;
  const voiceSupported = isVoiceRecordingSupported();

  // Register this composer's file-drop handler with the parent drop zone (the
  // content column), which owns the drag/drop surface. The wrapper self-gates on
  // `disabled` so a drop during a transient disabled state is a safe no-op.
  // Cleared on unmount or when the composer becomes unable to receive files.
  useEffect(() => {
    registerDropTarget?.((files) => {
      if (!disabled) void handleFileDrop(files);
    });
    return () => registerDropTarget?.(null);
  }, [disabled, handleFileDrop, registerDropTarget]);

  useEffect(() => {
    onDraftActiveChange?.(content.trim().length > 0);
  }, [content, onDraftActiveChange]);

  // Command autocomplete
  const handleCommandSelect = useCallback(
    (command: string) => {
      setContent('/' + command + ' ');
    },
    [setContent]
  );

  const commandAutocomplete = useCommandAutocomplete({
    content,
    onSelect: handleCommandSelect,
  });

  // Reference autocomplete
  const handleReferenceSelect = useCallback(
    (reference: ReferenceMention) => {
      const updated = replaceActiveAtQuery(content, reference.type, reference.id);
      // No active @query — nothing to replace; skip the setContent call to avoid spurious re-renders
      if (updated === content) return;
      setContent(updated);
      // Restore focus to textarea after selection
      textareaInputRef.current?.focus();
    },
    [content, setContent]
  );

  const referenceAutocomplete = useReferenceAutocomplete({
    content,
    onSelect: handleReferenceSelect,
  });

  // Agent mention autocomplete (for workflow agent @-mentions)
  const [agentMentionQuery, setAgentMentionQuery] = useState<string | null>(null);
  const [agentMentionSelectedIndex, setAgentMentionSelectedIndex] = useState(0);
  const lastCursorRef = useRef(0);

  const filteredAgentMentionCandidates = useMemo(() => {
    if (agentMentionQuery === null || !agentMentionCandidates) return [];
    return agentMentionCandidates.filter((a) =>
      a.name.toLowerCase().startsWith(agentMentionQuery.toLowerCase())
    );
  }, [agentMentionCandidates, agentMentionQuery]);

  const showAgentMentionAutocomplete =
    agentMentionQuery !== null && filteredAgentMentionCandidates.length > 0;

  // Wrap setContent to detect @-mentions
  const handleContentChange = useCallback(
    (value: string) => {
      // Drop stale onInput events that race with submit/clear
      if (submittingRef.current) return;

      // Track cursor position via the textarea ref
      const cursor = textareaInputRef.current?.selectionStart ?? value.length;
      lastCursorRef.current = cursor;
      setContent(value);

      if (agentMentionCandidates && agentMentionCandidates.length > 0) {
        const textBeforeCursor = value.slice(0, cursor);
        const match = textBeforeCursor.match(/@(\w*)$/);
        if (match) {
          setAgentMentionQuery(match[1]);
          setAgentMentionSelectedIndex(0);
        } else {
          setAgentMentionQuery(null);
        }
      }
    },
    [setContent, agentMentionCandidates]
  );

  const handleAgentMentionSelect = useCallback(
    (name: string) => {
      const cursor = textareaInputRef.current?.selectionStart ?? lastCursorRef.current;
      const textBeforeCursor = content.slice(0, cursor);
      const textAfterCursor = content.slice(cursor);
      const match = textBeforeCursor.match(/@(\w*)$/);
      if (!match) return;
      const start = cursor - match[0].length;
      const newValue = content.slice(0, start) + '@' + name + ' ' + textAfterCursor;
      setContent(newValue);
      setAgentMentionQuery(null);
      setAgentMentionSelectedIndex(0);
      setTimeout(() => {
        if (textareaInputRef.current) {
          const newCursor = start + name.length + 2;
          textareaInputRef.current.focus();
          textareaInputRef.current.setSelectionRange(newCursor, newCursor);
        }
      }, 0);
    },
    [content, setContent]
  );

  const handleAgentMentionClose = useCallback(() => {
    setAgentMentionQuery(null);
    setAgentMentionSelectedIndex(0);
  }, []);

  const insertTranscript = useCallback(
    (transcript: string) => {
      const currentContent = textareaInputRef.current?.value ?? content;
      const selectionStart = textareaInputRef.current?.selectionStart ?? lastCursorRef.current;
      const selectionEnd = textareaInputRef.current?.selectionEnd ?? selectionStart;
      const before = currentContent.slice(0, selectionStart);
      const after = currentContent.slice(selectionEnd);
      const needsLeadingSpace =
        before.length > 0 && !suppressLeadingSpace(before) && !/^\s/.test(transcript);
      const needsTrailingSpace =
        after.length > 0 && !isNonJoiningBoundary(after[0]) && !/\s$/.test(transcript);
      const inserted = `${needsLeadingSpace ? ' ' : ''}${transcript}${needsTrailingSpace ? ' ' : ''}`;
      const nextValue = before + inserted + after;
      setContent(nextValue);
      const nextCursor = selectionStart + inserted.length;
      setTimeout(() => {
        textareaInputRef.current?.focus();
        textareaInputRef.current?.setSelectionRange(nextCursor, nextCursor);
      }, 0);
    },
    [content, setContent]
  );

  const handleVoiceClick = useCallback(async () => {
    if (isTranscribing) return;
    if (!voiceSupported) {
      toast.error('Voice input requires HTTPS or localhost browser access');
      return;
    }
    try {
      if (!voiceRecorder.isRecording && !voiceRecorder.durationLimitHit) {
        await voiceRecorder.start();
        return;
      }

      setIsTranscribing(true);
      const recording = await voiceRecorder.stop();
      if (recording.hitDurationLimit) {
        toast.info('Voice recording stopped after 90 seconds');
      }
      const hub = connectionManager.getHubIfConnected();
      if (!hub) throw new Error('Not connected');
      const result = (await hub.request('voice.transcribe', recording, { timeout: 65_000 })) as {
        text?: string;
      };
      if (result.text) insertTranscript(result.text);
    } catch (error) {
      await voiceRecorder.cancel();
      toast.error(error instanceof Error ? error.message : 'Voice transcription failed');
    } finally {
      setIsTranscribing(false);
    }
  }, [insertTranscript, isTranscribing, voiceRecorder, voiceSupported]);

  const agentWorking = isProcessing ?? isAgentWorking.value;
  const [queuedForCurrentTurn, setQueuedForCurrentTurn] = useState<QueuePreviewMessage[]>([]);
  const [queuedForNextTurn, setQueuedForNextTurn] = useState<QueuePreviewMessage[]>([]);

  const syncMessagesContainerPadding = useCallback(() => {
    const scroller = document.querySelector<HTMLElement>('[data-messages-container]');
    const footer = document.querySelector<HTMLElement>('.chat-footer');
    if (!scroller || !footer) return;

    const footerHeightPx = Math.max(footer.getBoundingClientRect().height, footer.scrollHeight);
    const nextPaddingPx = getMessagesBottomPaddingPx(footerHeightPx);
    const nextPaddingValue = `${nextPaddingPx}px`;
    const currentPaddingVar = scroller.style.getPropertyValue('--messages-bottom-padding').trim();
    if (currentPaddingVar !== nextPaddingValue) {
      scroller.style.setProperty('--messages-bottom-padding', nextPaddingValue);
    }
  }, []);

  const extractOutgoingMessage = useCallback(() => {
    const messageContent = content.trim();
    if (!messageContent) {
      return null;
    }
    return {
      content: messageContent,
      images: getImagesForSend(),
    };
  }, [content, getImagesForSend]);

  const refreshQueuedMessages = useCallback(async () => {
    const hub = connectionManager.getHubIfConnected();
    if (!hub) {
      return;
    }

    try {
      const [enqueuedResponse, deferredResponse] = (await Promise.all([
        hub.request('session.messages.byStatus', {
          sessionId,
          status: 'enqueued',
          limit: 100,
        }),
        hub.request('session.messages.byStatus', {
          sessionId,
          status: 'deferred',
          limit: 100,
        }),
      ])) as [{ messages?: QueuePreviewMessage[] }, { messages?: QueuePreviewMessage[] }];
      setQueuedForCurrentTurn(enqueuedResponse.messages ?? []);
      setQueuedForNextTurn(deferredResponse.messages ?? []);
    } catch {
      // Best-effort queue refresh.
    }
  }, [sessionId]);

  const handleRemoveQueuedMessage = useCallback(
    async (queued: QueuePreviewMessage) => {
      const hub = connectionManager.getHubIfConnected();
      if (!hub) {
        return;
      }

      setQueuedForCurrentTurn((messages) =>
        messages.filter((message) => message.dbId !== queued.dbId)
      );
      setQueuedForNextTurn((messages) =>
        messages.filter((message) => message.dbId !== queued.dbId)
      );

      try {
        await hub.request('session.messages.removePending', {
          sessionId,
          messageDbId: queued.dbId,
        });
      } finally {
        await refreshQueuedMessages();
      }
    },
    [refreshQueuedMessages, sessionId]
  );

  const handlePromoteQueuedMessage = useCallback(
    async (queued: QueuePreviewMessage) => {
      const hub = connectionManager.getHubIfConnected();
      if (!hub) {
        return;
      }

      setQueuedForNextTurn((messages) =>
        messages.filter((message) => message.dbId !== queued.dbId)
      );
      setQueuedForCurrentTurn((messages) =>
        messages.some((message) => message.dbId === queued.dbId)
          ? messages
          : [...messages, { ...queued, status: 'enqueued' }]
      );

      try {
        await hub.request('session.messages.promotePending', {
          sessionId,
          messageDbId: queued.dbId,
        });
      } finally {
        await refreshQueuedMessages();
      }
    },
    [refreshQueuedMessages, sessionId]
  );

  const handleDeferQueuedMessage = useCallback(
    async (queued: QueuePreviewMessage) => {
      const hub = connectionManager.getHubIfConnected();
      if (!hub) {
        return;
      }

      setQueuedForCurrentTurn((messages) =>
        messages.filter((message) => message.dbId !== queued.dbId)
      );
      setQueuedForNextTurn((messages) =>
        messages.some((message) => message.dbId === queued.dbId)
          ? messages
          : [...messages, { ...queued, status: 'deferred' }]
      );

      try {
        await hub.request('session.messages.deferPending', {
          sessionId,
          messageDbId: queued.dbId,
        });
      } finally {
        await refreshQueuedMessages();
      }
    },
    [refreshQueuedMessages, sessionId]
  );

  useLayoutEffect(() => {
    syncMessagesContainerPadding();
  }, [syncMessagesContainerPadding]);

  useEffect(() => {
    syncMessagesContainerPadding();
  }, [
    syncMessagesContainerPadding,
    attachments.length,
    queuedForCurrentTurn.length,
    queuedForNextTurn.length,
  ]);

  useEffect(() => {
    void refreshQueuedMessages();
  }, [refreshQueuedMessages]);

  useEffect(() => {
    if (!agentWorking && queuedForCurrentTurn.length === 0 && queuedForNextTurn.length === 0)
      return;
    const timer = setInterval(() => {
      void refreshQueuedMessages();
    }, 700);
    return () => clearInterval(timer);
  }, [agentWorking, queuedForCurrentTurn.length, queuedForNextTurn.length, refreshQueuedMessages]);

  const handleTextareaHeightChange = useCallback(
    (_heightPx: number) => {
      syncMessagesContainerPadding();
    },
    [syncMessagesContainerPadding]
  );

  // Submit handler
  const handleSubmit = useCallback(
    async (deliveryMode: MessageDeliveryMode = 'immediate') => {
      if (disabled) {
        return;
      }
      // Hold submission while a transcription is pending so the composer is not
      // cleared before the dictated text is inserted.
      if (isTranscribing) {
        return;
      }
      const outgoing = extractOutgoingMessage();
      if (!outgoing) return;

      // Save content + attachments before clearing so we can restore them
      // if the send fails. `attachments` contains the AttachmentWithMetadata
      // list (data + media_type + name + size) needed to repopulate the chip
      // row, while `outgoing.images` is the trimmed-down send payload.
      const savedContent = outgoing.content;
      const savedAttachments = attachments;

      // Guard against stale onInput events racing with clear/useLayoutEffect
      submittingRef.current = true;

      // Clear UI optimistically
      clearDraft();
      clearAttachments();

      // Immediately clear textarea DOM — don't wait for batched useLayoutEffect
      if (textareaInputRef.current) {
        textareaInputRef.current.value = '';
      }

      try {
        // Send message with images; a boolean false return signals failure
        const result = await onSend(savedContent, outgoing.images, deliveryMode);

        if (result === false) {
          // Restore the draft and attachments so the user doesn't lose their work
          setContent(savedContent);
          if (savedAttachments.length > 0) {
            restoreAttachments(savedAttachments);
          }
          return;
        }

        if (
          agentWorking ||
          deliveryMode === 'defer' ||
          queuedForCurrentTurn.length > 0 ||
          queuedForNextTurn.length > 0
        ) {
          await refreshQueuedMessages();
        }
      } finally {
        submittingRef.current = false;
      }
    },
    [
      disabled,
      extractOutgoingMessage,
      attachments,
      clearDraft,
      clearAttachments,
      restoreAttachments,
      setContent,
      onSend,
      agentWorking,
      queuedForCurrentTurn.length,
      queuedForNextTurn.length,
      refreshQueuedMessages,
      isTranscribing,
    ]
  );

  // Destructure stable callback refs to avoid recreating handleKeyDown on every render
  // (hooks return new object instances each render, but the functions inside are stable
  // via useCallback, so depending on the functions directly is more efficient)
  const refHandleKeyDown = referenceAutocomplete.handleKeyDown;
  const cmdHandleKeyDown = commandAutocomplete.handleKeyDown;

  // Keyboard handler
  const handleKeyDown = useCallback(
    (e: KeyboardEvent) => {
      // Agent mention autocomplete takes highest precedence when visible
      if (showAgentMentionAutocomplete) {
        if (e.key === 'ArrowDown') {
          e.preventDefault();
          setAgentMentionSelectedIndex((i) =>
            Math.min(i + 1, filteredAgentMentionCandidates.length - 1)
          );
          return;
        }
        if (e.key === 'ArrowUp') {
          e.preventDefault();
          setAgentMentionSelectedIndex((i) => Math.max(i - 1, 0));
          return;
        }
        if (e.key === 'Enter' && !e.shiftKey) {
          e.preventDefault();
          const candidate = filteredAgentMentionCandidates[agentMentionSelectedIndex];
          if (candidate) {
            handleAgentMentionSelect(candidate.name);
          }
          return;
        }
        if (e.key === 'Escape') {
          e.preventDefault();
          handleAgentMentionClose();
          return;
        }
      }

      // Reference autocomplete takes precedence when visible
      if (refHandleKeyDown(e)) {
        return;
      }

      // Then try command autocomplete
      if (cmdHandleKeyDown(e)) {
        return;
      }

      if (e.key === 'Tab' && !e.shiftKey && agentWorking) {
        e.preventDefault();
        void handleSubmit('defer');
        return;
      }

      // Handle Enter key behavior
      if (e.key === 'Enter') {
        if (e.metaKey || e.ctrlKey) {
          e.preventDefault();
          void handleSubmit('immediate');
          return;
        }

        // Desktop: Enter submits, Shift+Enter for newline
        if (!isTouchDeviceRef.current && !e.shiftKey) {
          e.preventDefault();
          void handleSubmit('immediate');
        }
      }
    },
    [
      refHandleKeyDown,
      cmdHandleKeyDown,
      handleSubmit,
      agentWorking,
      showAgentMentionAutocomplete,
      filteredAgentMentionCandidates,
      agentMentionSelectedIndex,
      handleAgentMentionSelect,
      handleAgentMentionClose,
    ]
  );

  // Model switch handler
  const handleModelSwitch = useCallback(
    async (model: ModelInfo) => {
      await switchModel(model);
      actionsMenu.close();
    },
    [switchModel, actionsMenu]
  );

  // Drag and drop handlers
  return (
    <ContentContainer className="pb-2">
      <div class="relative">
        <form
          onSubmit={(e) => {
            e.preventDefault();
            void handleSubmit('immediate');
          }}
        >
          {/* Attachment Preview */}
          {attachments.length > 0 && (
            <div class="mb-3">
              <AttachmentPreview attachments={attachments} onRemove={handleRemove} />
            </div>
          )}

          {(queuedForCurrentTurn.length > 0 || queuedForNextTurn.length > 0) && !disabled && (
            <QueuePreviewTray
              currentTurnMessages={queuedForCurrentTurn}
              nextTurnMessages={queuedForNextTurn}
              className="mb-2 sm:ml-[58px]"
              onDeferMessage={(queued) => {
                void handleDeferQueuedMessage(queued);
              }}
              onPromoteMessage={(queued) => {
                void handlePromoteQueuedMessage(queued);
              }}
              onRemoveMessage={(queued) => {
                void handleRemoveQueuedMessage(queued);
              }}
            />
          )}

          {/* iOS 26 Style: Floating single-line input */}
          <div class="flex items-end gap-3">
            {/* Plus Button with Actions Menu */}
            <InputActionsMenu
              isOpen={actionsMenu.isOpen}
              onToggle={actionsMenu.toggle}
              onClose={actionsMenu.close}
              currentModel={currentModel}
              currentModelInfo={currentModelInfo}
              availableModels={availableModels}
              modelSwitching={modelSwitching}
              modelLoading={modelLoading}
              onModelSwitch={handleModelSwitch}
              autoScroll={autoScroll ?? true}
              onAutoScrollChange={(enabled) => onAutoScrollChange?.(enabled)}
              onOpenTools={() => onOpenTools?.()}
              onAttachFile={openFilePicker}
              coordinatorMode={coordinatorMode}
              coordinatorSwitching={coordinatorSwitching}
              onCoordinatorModeChange={onCoordinatorModeChange}
              sandboxEnabled={sandboxEnabled}
              sandboxSwitching={sandboxSwitching}
              onSandboxModeChange={onSandboxModeChange}
              features={features}
              disabled={disabled}
            />

            {/* Hidden file input */}
            <input
              ref={fileInputRef}
              type="file"
              accept="image/png,image/jpeg,image/gif,image/webp"
              multiple
              onChange={handleFileSelect}
              class="hidden"
            />

            {/* Input Textarea */}
            <InputTextarea
              content={content}
              onContentChange={handleContentChange}
              onKeyDown={handleKeyDown}
              onSubmit={() => {
                void handleSubmit('immediate');
              }}
              disabled={disabled}
              placeholder={placeholderProp ?? getPlaceholderForSessionType(sessionType)}
              showAgentMentionAutocomplete={showAgentMentionAutocomplete}
              agentMentionCandidates={filteredAgentMentionCandidates}
              selectedAgentMentionIndex={agentMentionSelectedIndex}
              onAgentMentionSelect={handleAgentMentionSelect}
              onAgentMentionClose={handleAgentMentionClose}
              showCommandAutocomplete={
                !showAgentMentionAutocomplete &&
                commandAutocomplete.showAutocomplete &&
                !referenceAutocomplete.showAutocomplete
              }
              filteredCommands={commandAutocomplete.filteredCommands}
              selectedCommandIndex={commandAutocomplete.selectedIndex}
              onCommandSelect={commandAutocomplete.handleSelect}
              onCommandClose={commandAutocomplete.close}
              showReferenceAutocomplete={
                !showAgentMentionAutocomplete && referenceAutocomplete.showAutocomplete
              }
              referenceResults={referenceAutocomplete.results}
              selectedReferenceIndex={referenceAutocomplete.selectedIndex}
              onReferenceSelect={referenceAutocomplete.handleSelect}
              onReferenceClose={referenceAutocomplete.close}
              isAgentWorking={agentWorking}
              onQueue={() => {
                void handleSubmit('defer');
              }}
              onStop={handleInterrupt}
              onPaste={disabled ? undefined : handlePaste}
              textareaRef={textareaInputRef}
              transparent={true}
              voiceControl={
                voiceControlVisible ? (
                  <button
                    type="button"
                    onClick={() => {
                      void handleVoiceClick();
                    }}
                    disabled={
                      (disabled && !voiceRecorder.isRecording) || isTranscribing || !voiceSupported
                    }
                    title={
                      voiceSupported
                        ? voiceRecorder.isRecording || voiceRecorder.durationLimitHit
                          ? 'Stop recording and transcribe'
                          : 'Start voice input'
                        : 'Voice input requires HTTPS or localhost'
                    }
                    aria-label={
                      voiceRecorder.isRecording || voiceRecorder.durationLimitHit
                        ? 'Stop recording and transcribe'
                        : 'Start voice input'
                    }
                    class={`w-9 h-9 rounded-full flex items-center justify-center transition-all duration-200 focus-visible:outline-none focus-visible:ring-2 ${
                      voiceRecorder.isRecording || voiceRecorder.durationLimitHit
                        ? 'bg-red-500/90 text-white hover:bg-red-600 focus-visible:ring-red-400/70'
                        : isTranscribing
                          ? 'bg-blue-500/80 text-white cursor-wait focus-visible:ring-blue-400/70'
                          : 'bg-dark-700/70 text-gray-300 hover:bg-dark-600 hover:text-white focus-visible:ring-blue-400/60'
                    } ${disabled ? 'opacity-50 cursor-not-allowed' : 'active:scale-95'}`}
                  >
                    {isTranscribing ? (
                      <span class="w-4 h-4 rounded-full border-2 border-white/40 border-t-white animate-spin" />
                    ) : (
                      <svg class="w-4.5 h-4.5" viewBox="0 0 24 24" fill="currentColor">
                        <path d="M12 14a3 3 0 003-3V6a3 3 0 10-6 0v5a3 3 0 003 3z" />
                        <path d="M17.3 11a.8.8 0 00-1.6 0 3.7 3.7 0 11-7.4 0 .8.8 0 00-1.6 0 5.3 5.3 0 004.5 5.24V19H9a.8.8 0 000 1.6h6a.8.8 0 000-1.6h-2.2v-2.76A5.3 5.3 0 0017.3 11z" />
                      </svg>
                    )}
                  </button>
                ) : undefined
              }
              leadingElement={leadingElement}
              leadingPaddingClass={leadingPaddingClass}
              onHeightChange={handleTextareaHeightChange}
            />
          </div>
        </form>
      </div>
    </ContentContainer>
  );
}
