/**
 * MessageInput Component
 *
 * iOS 26-style floating message input with auto-resize textarea,
 * command autocomplete, file attachments, and action menu.
 *
 * Refactored to use shared hooks for better separation of concerns.
 */

import { generateUUID } from '@hyperneo/shared';
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
import {
  enqueueTranscript,
  isPermanentAppendRefusal,
} from '../lib/voice/voice-transcript-outbox.ts';
import type { SessionStore } from '../lib/session-store.ts';
import { globalSettings, isAgentWorking } from '../lib/state.ts';
import { toast } from '../lib/toast.ts';
import { AttachmentPreview } from './AttachmentPreview.tsx';
import { InputActionsMenu } from './InputActionsMenu.tsx';
import { InputTextarea } from './InputTextarea.tsx';
import { VoiceWaveform } from './voice/VoiceWaveform.tsx';
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

// CJK scripts do not separate words/characters with spaces, so a space is never
// added when either side of the boundary is CJK (你好 + 世界 -> 你好世界).
const CJK = /[\p{sc=Han}\p{sc=Hiragana}\p{sc=Katakana}\p{sc=Hangul}]/u;
function isCjk(char: string | undefined): boolean {
  return !!char && char.length > 0 && CJK.test(char);
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

// Matches InputTextarea's default maxChars; transcripts are capped to it so a
// misbehaving backend cannot push the draft past the composer limit.
const COMPOSER_CHAR_LIMIT = 100000;

/**
 * Page size for queue-preview fetches. Generous — a pending queue above this
 * is pathological (the batched flush drains it in one turn) — but if it is
 * ever exceeded, the server also reports `total` so the tray's full-list modal
 * flags the not-loaded remainder instead of silently presenting a truncated
 * list as complete.
 */
const QUEUE_FETCH_LIMIT = 1000;

/**
 * Splice `transcript` between the draft text before/after the caret (or
 * selection — a selection gets replaced), applying the spacing/CJK rules at
 * both boundaries and capping to the composer character limit. Shared by the
 * live mounted insert and the unmounted delivery so both place the transcript
 * identically. `fullyInserted` reports whether the whole transcript fit —
 * never infer that from the result string, which may already contain the same
 * phrase elsewhere in the draft.
 */
function buildTranscriptInsertion(
  before: string,
  after: string,
  transcript: string
): { value: string; fullyInserted: boolean } {
  const needsLeadingSpace =
    before.length > 0 &&
    !suppressLeadingSpace(before) &&
    !/^\s/.test(transcript) &&
    !isCjk(before.slice(-1)) &&
    !isCjk(transcript[0]);
  const needsTrailingSpace =
    after.length > 0 &&
    !isNonJoiningBoundary(after[0]) &&
    !/\s$/.test(transcript) &&
    !isCjk(after[0]) &&
    !isCjk(transcript.slice(-1));
  const inserted = `${needsLeadingSpace ? ' ' : ''}${transcript}${needsTrailingSpace ? ' ' : ''}`;
  const remaining = COMPOSER_CHAR_LIMIT - before.length - after.length;
  const cappedInserted = remaining <= 0 ? '' : inserted.slice(0, remaining);
  return {
    value: before + cappedInserted + after,
    fullyInserted: cappedInserted === inserted,
  };
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
   * Whether the backing send path honors 'defer' (queue for next turn). When
   * false, the Queue controls (typed-text button, voice Queue button) and the
   * Tab-to-queue shortcut are suppressed. Forwarded from ChatComposer; defaults
   * to true (the task-session composers honor defer via `space.task.sendMessage`).
   */
  supportsQueueDelivery?: boolean;
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
  /**
   * SessionStore instance backing this input's chat. Forwarded to the
   * slash-command and reference autocomplete hooks so they read this view's
   * session state/ID instead of the singleton (which would be the primary
   * chat's data when this input lives in an overlaid chat). Defaults to the
   * singleton.
   */
  store?: SessionStore;
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
  supportsQueueDelivery = true,
  registerDropTarget,
  store,
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

  // Tracks whether the composer is mounted, so a pending transcription that
  // completes after the user navigates to another session (which unmounts this
  // keyed composer) does not write into the detached draft.
  const mountedRef = useRef(true);
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  // Use shared hooks
  const { content, setContent, clear: clearDraft } = useInputDraft(sessionId);
  // Always-current draft content. insertTranscript can run long after the render
  // that created it (a transcription RPC may take up to 125s while the textarea
  // is unmounted), so it must splice into the LATEST draft — e.g. one that
  // finished loading from the server mid-transcription — not a stale closure.
  const contentRef = useRef(content);
  contentRef.current = content;
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
  const [isTranscribing, setIsTranscribing] = useState(false);
  // A completed transcription is waiting for its auto-send effect to fire.
  const [hasPendingAutoSend, setHasPendingAutoSend] = useState(false);
  // Mid-transcription OR with a pending auto-send, do NOT auto-adopt an
  // orphaned same-session recording: the in-flight request's error path could
  // cancel an adopted capture, and adoption re-enables the recording guard
  // that would swallow the pending auto-send of the user's original action.
  const voiceRecorder = useVoiceRecorder(sessionId, {
    autoAdopt: !isTranscribing && !hasPendingAutoSend,
  });
  const voiceSettings = globalSettings.value?.voice;
  const voiceEnabled = voiceSettings?.enabled ?? false;
  const voiceConfigured = (() => {
    const ep = voiceSettings?.endpoint?.trim();
    const model = voiceSettings?.model?.trim();
    if (!ep || !model) return false;
    try {
      const url = new URL(ep);
      return url.protocol === 'http:' || url.protocol === 'https:';
    } catch {
      return false;
    }
  })();
  // A recording binds to the composer's sessionId at start: with no session
  // (task agent not yet spawned, pending workflow overlay) an unmounting
  // recording could never be adopted by another composer or routed back to.
  // Offer the mic only once a session exists.
  const voiceTargetReady = sessionId !== '';
  const voiceControlVisible =
    ((voiceEnabled && voiceConfigured) ||
      voiceRecorder.isRecording ||
      voiceRecorder.isStarting ||
      voiceRecorder.durationLimitHit) &&
    voiceTargetReady;
  const voiceSupported = isVoiceRecordingSupported();
  // True throughout the entire voice lifecycle: the RecordingPanel replaces the
  // textarea from the moment the mic is clicked (isStarting) through transcription
  // (isTranscribing) and across the limit transition (durationLimitHit), so the
  // panel never flickers off for a frame between states.
  const voiceActive =
    voiceRecorder.isStarting ||
    voiceRecorder.isRecording ||
    isTranscribing ||
    voiceRecorder.durationLimitHit;

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
    store,
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
    store,
  });

  // Agent mention autocomplete (for workflow agent @-mentions)
  const [agentMentionQuery, setAgentMentionQuery] = useState<string | null>(null);
  const [agentMentionSelectedIndex, setAgentMentionSelectedIndex] = useState(0);
  const lastCursorRef = useRef(0);
  // Selection END tracked separately so a text selection made before recording
  // is replaced by the transcript (not merely inserted at its start) once the
  // textarea is unmounted and live selection is unavailable.
  const lastSelectionEndRef = useRef(0);

  const filteredAgentMentionCandidates = useMemo(() => {
    if (agentMentionQuery === null || !agentMentionCandidates) return [];
    return agentMentionCandidates.filter((a) =>
      a.name.toLowerCase().startsWith(agentMentionQuery.toLowerCase())
    );
  }, [agentMentionCandidates, agentMentionQuery]);

  const showAgentMentionAutocomplete =
    agentMentionQuery !== null && filteredAgentMentionCandidates.length > 0;

  // Wrap setContent to detect @-mentions
  // Continuous caret/selection tracking: the textarea's `select` event fires
  // for every caret move (arrow keys, mouse clicks, drags), keeping the cursor
  // refs current even for changes that never emit an input event. Voice
  // delivery relies on these refs whenever the textarea is (or is about to be)
  // gone — recording, mid-transcription unmount, or an ADOPTED recording whose
  // startRecording() snapshot never ran in this composer.
  const handleSelect = useCallback(() => {
    const textarea = textareaInputRef.current;
    if (!textarea) return;
    lastCursorRef.current = textarea.selectionStart ?? textarea.value.length;
    lastSelectionEndRef.current = textarea.selectionEnd ?? lastCursorRef.current;
  }, []);

  const handleContentChange = useCallback(
    (value: string) => {
      // Drop stale onInput events that race with submit/clear
      if (submittingRef.current) return;

      // Track cursor position via the textarea ref
      const cursor = textareaInputRef.current?.selectionStart ?? value.length;
      lastCursorRef.current = cursor;
      lastSelectionEndRef.current = textareaInputRef.current?.selectionEnd ?? cursor;
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
      const currentContent = textareaInputRef.current?.value ?? contentRef.current;
      const selectionStart = textareaInputRef.current?.selectionStart ?? lastCursorRef.current;
      const selectionEnd =
        textareaInputRef.current?.selectionEnd ??
        Math.max(selectionStart, lastSelectionEndRef.current);
      const before = currentContent.slice(0, selectionStart);
      const after = currentContent.slice(selectionEnd);
      const { value: nextValue } = buildTranscriptInsertion(before, after, transcript);
      setContent(nextValue);
      const nextCursor = selectionStart + (nextValue.length - before.length - after.length);
      setTimeout(() => {
        textareaInputRef.current?.focus();
        textareaInputRef.current?.setSelectionRange(nextCursor, nextCursor);
      }, 0);
    },
    [setContent]
  );

  const startRecording = useCallback(async () => {
    if (isTranscribing) return;
    if (!voiceSupported) {
      toast.error('Voice input requires HTTPS or localhost browser access');
      return;
    }
    if (!voiceRecorder.isRecording && !voiceRecorder.durationLimitHit) {
      // Pin the session this recording belongs to AT START. The inline task
      // composer can re-target sessionId without remounting while recording or
      // transcribing; pinning here (not at Stop/Send click) means a mid-recording
      // retarget is detected at completion and the transcript is discarded
      // rather than delivered to the newly selected agent. An ADOPTED recording
      // (orphaned by this session's previous composer and picked up on mount)
      // re-pins to this composer's session, which adopt() guarantees matches
      // the recording's session — never a stale pin from an earlier recording.
      recordingSessionRef.current = sessionId;
      // The textarea unmounts while recording, so insertTranscript later falls
      // back to the cursor refs — snapshot the live selection now, including
      // caret/selection moves made with the mouse or arrow keys that never fire
      // an input event. Both ends are captured so a selection gets REPLACED.
      const textarea = textareaInputRef.current;
      if (textarea) {
        lastCursorRef.current = textarea.selectionStart ?? textarea.value.length;
        lastSelectionEndRef.current = textarea.selectionEnd ?? lastCursorRef.current;
      }
      try {
        // The caret/selection is persisted WITH the recording: if this
        // composer unmounts mid-recording and another composer for this
        // session adopts it, the original insertion point survives the
        // handoff instead of resetting to 0.
        await voiceRecorder.start({
          start: lastCursorRef.current,
          end: lastSelectionEndRef.current,
        });
      } catch (error) {
        toast.error(error instanceof Error ? error.message : 'Voice input failed to start');
      }
    }
  }, [isTranscribing, voiceRecorder, voiceSupported, sessionId]);

  // Set by a voice Send/Steer/Queue click with the sessionId + delivery mode
  // targeted at click time; consumed by the effect after handleSubmit to
  // auto-submit the draft once the transcript has landed. Pinned because the
  // inline task composer can switch sessionId without remounting while a
  // transcription is in flight — the transcript must never auto-send to a
  // different agent than was targeted.
  const pendingAutoSendRef = useRef<{ sessionId: string; mode: 'send' | 'queue' } | null>(null);
  // Always-current sessionId, so an in-flight transcription (up to 125s) can
  // tell the session it was started for from whatever the composer shows now.
  const sessionIdRef = useRef(sessionId);
  sessionIdRef.current = sessionId;
  // The session the CURRENT recording was started for (null when idle).
  const recordingSessionRef = useRef<string | null>(null);
  // Keep the pinned delivery target synchronized with an ADOPTED recording:
  // this composer never called startRecording for it, so the pin is either
  // null (fresh mount) or stale from an earlier recording. Covers BOTH an
  // active adoption and a limit-hit one (isRecording false, audio buffered).
  // Ownership is relinquished on retarget, so this never overrides the
  // intentional retarget-discard safeguard.
  useEffect(() => {
    if (
      (voiceRecorder.isRecording || voiceRecorder.durationLimitHit) &&
      voiceRecorder.recordingSessionId
    ) {
      recordingSessionRef.current = voiceRecorder.recordingSessionId;
      // Restore the insertion point captured by the recording's STARTER — an
      // adopter's local cursor refs reset to 0 on remount, which would
      // otherwise insert the transcript at the draft's start.
      const cursor = voiceRecorder.recordingCursor;
      if (cursor) {
        lastCursorRef.current = cursor.start;
        lastSelectionEndRef.current = cursor.end;
      }
    }
  });

  // Deliver a transcript whose composer has already unmounted (the user clicked
  // Send/Stop then navigated to another session while the up-to-125s RPC was in
  // flight). Auto-send can't run with no mounted composer, so route by mode:
  //  - send/queue: send straight to the session as a real message. No draft is
  //    involved, so there is nothing for a stale client snapshot to clobber —
  //    this is the reported "I clicked Send then switched sessions" case.
  //  - stay: stage in the `inputDraftVoicePending` field; the daemon merges it
  //    into the draft atomically on the next session.get.
  // Reports success/failure so the toast never claims a delivery that did not
  // happen.
  const deliverUnmountedTranscript = useCallback(
    async (
      targetSessionId: string,
      transcript: string,
      mode: 'stay' | 'send' | 'queue',
      // Snapshot of the composer payload taken at click time (while still
      // mounted): the draft split at the captured caret/selection, images, and
      // the composer's own bound `onSend`. The unmounted delivery can't read
      // the live draft/attachments — it sends what was here when the user
      // clicked, through the SAME send function the mounted path uses (so
      // worktree-choice setup, task-composer routing, and error handling all
      // apply), rather than a bare message.send RPC that would bypass them.
      payload: {
        before: string;
        after: string;
        full: string;
        images?: MessageImage[];
        send: MessageInputProps['onSend'];
      }
    ): Promise<{ ok: boolean; message: string }> => {
      // NOTE: no upfront hub gate here. The captured `payload.send` owns its
      // offline delivery (useSendMessage queues disconnected sends for retry),
      // so a missing hub must not prevent attempting it — only the staging and
      // clearing RPCs below require a connection. The outbox id is minted ONCE
      // per delivery and reused by the initial staging RPC AND any queued
      // retry: if the first append commits but its ack is lost in a disconnect,
      // the replay carries the same id and the daemon's dedup set skips the
      // double-merge instead of appending the transcript a second time.
      const outboxId = generateUUID();
      const stageToDraft = async () => {
        const hub = connectionManager.getHubIfConnected();
        if (!hub) throw new Error('Not connected');
        await hub.request('session.appendVoiceDraft', {
          sessionId: targetSessionId,
          text: transcript,
          dedupId: outboxId,
        });
      };
      // Last-resort preservation: stage the transcript into the pending draft
      // field. Used for 'stay', for a composer too full to splice into, and as
      // the fallback when the send path fails — never destroy the only copy.
      const stageFallback = async (message: string): Promise<{ ok: boolean; message: string }> => {
        try {
          await stageToDraft();
          return { ok: true, message };
        } catch (error) {
          // Enqueue everything EXCEPT a genuinely permanent refusal (the
          // session no longer exists — nothing can ever deliver it). A dead
          // socket, a `Request timeout` whose append may have committed with a
          // lost ack, or a character-limit refusal (room appears once the user
          // sends/clears) are all retryable, and the flush replays them with
          // backoff, deduplicated by the shared outbox id.
          if (!isPermanentAppendRefusal(error)) {
            const durable = enqueueTranscript(targetSessionId, transcript, outboxId);
            // localStorage refused the write: the transcript survives only in
            // this page's memory — delivered on reconnect, but a reload or
            // close loses it. Say so instead of promising durable preservation.
            return {
              ok: true,
              message: durable
                ? 'Voice transcript saved — will be delivered when reconnected'
                : 'Voice transcript kept in this tab — reconnect before closing it',
            };
          }
          return { ok: false, message: '' };
        }
      };
      if (mode === 'stay') {
        return stageFallback('Voice transcript saved to the session draft');
      }
      // Splice the transcript at the captured selection like the mounted path;
      // if the composer was already at its character limit the transcript
      // cannot fit — do not silently send an incomplete payload, retain the
      // transcript in the pending draft field instead. fullyInserted comes
      // from the insertion helper, not a substring search of the draft (which
      // the same phrase elsewhere in the draft would defeat).
      const { value: content, fullyInserted } = buildTranscriptInsertion(
        payload.before,
        payload.after,
        transcript
      );
      if (!fullyInserted) {
        return stageFallback(
          'Composer draft is full — voice transcript saved to the session draft'
        );
      }
      const deliveryMode: MessageDeliveryMode = mode === 'queue' ? 'defer' : 'immediate';
      let sent: void | boolean;
      try {
        sent = await payload.send(content, payload.images, deliveryMode);
      } catch {
        // The send path failed (e.g. a task composer declining while its
        // target agent is still starting). Preserve the only copy of the
        // transcript by staging it into the session draft rather than
        // destroying it.
        return stageFallback('Voice send failed — transcript saved to the session draft');
      }
      if (sent === false) {
        return stageFallback('Voice send failed — transcript saved to the session draft');
      }
      // Consume the click-time draft so reopening the session doesn't show —
      // and re-send — text that was just delivered. Parity with the mounted
      // submit, which clears the composer. The daemon-side clearInputDraftIf
      // compares and clears ATOMICALLY and only when the persisted draft still
      // equals the complete click-time snapshot (selection included) — newer
      // edits saved after the snapshot win. Best-effort: a failure here doesn't
      // undo the send.
      if (payload.full.trim().length > 0) {
        const hub = connectionManager.getHubIfConnected();
        if (hub) {
          try {
            await hub.request('session.clearInputDraftIf', {
              sessionId: targetSessionId,
              expected: payload.full,
            });
          } catch {
            /* ignore — the send already succeeded */
          }
        }
      }
      return {
        ok: true,
        message:
          mode === 'queue' ? 'Voice transcript queued for the next turn' : 'Voice transcript sent',
      };
    },
    []
  );

  const stopAndTranscribe = useCallback(
    // 'stay' leaves the transcript in the composer; 'send' auto-submits it
    // (immediate send, or steer when the agent is working); 'queue' defers it
    // to the next turn.
    async (mode: 'stay' | 'send' | 'queue' = 'stay') => {
      if (isTranscribing) return;
      // Nothing to stop — guard against stray calls so we never flip into a
      // transcribing state with no audio to send.
      if (!voiceRecorder.isRecording && !voiceRecorder.durationLimitHit) return;
      // The recording's owner, pinned at startRecording() time (fall back to the
      // current session for recordings started before this code ran). If the
      // composer has since been re-targeted, the transcript is discarded with a
      // toast instead of landing in — or auto-sending to — another session.
      const targetSessionId = recordingSessionRef.current ?? sessionId;
      // Snapshot the full outgoing payload NOW (mounted, click time), split at
      // the captured caret/selection exactly like insertTranscript would splice
      // it — the textarea is already replaced by the recording panel, so fall
      // back to the cursor refs snapshotted at recording start. If the user
      // navigates away during transcription, the unmounted delivery path can't
      // read the live draft/attachments — it must send what was here when they
      // clicked, matching the mounted path that submits the whole composer.
      const snapshotContent = textareaInputRef.current?.value ?? contentRef.current;
      const snapshotStart = textareaInputRef.current?.selectionStart ?? lastCursorRef.current;
      const snapshotEnd =
        textareaInputRef.current?.selectionEnd ??
        Math.max(snapshotStart, lastSelectionEndRef.current);
      const payloadSnapshot = {
        before: snapshotContent.slice(0, snapshotStart),
        after: snapshotContent.slice(snapshotEnd),
        // Complete click-time content (includes any selected text) — compared
        // against the persisted draft by the atomic post-send clear.
        full: snapshotContent,
        images: getImagesForSend(),
        // The composer's own send function — invoked post-unmount through this
        // closure, it reproduces the FULL mounted send semantics (worktree
        // choice setup, task-composer routing) instead of a bare RPC.
        send: onSend,
      };
      setIsTranscribing(true);
      try {
        const recording = await voiceRecorder.stop();
        if (recording.hitDurationLimit) {
          toast.info('Voice recording stopped at 5 minutes — transcribing…');
        }
        // Silent capture (muted mic, wrong input device, hung permission) —
        // don't ship dead air to the backend; tell the user to check the mic.
        if (recording.peakLevel !== undefined && recording.peakLevel < 0.001) {
          toast.error('No microphone signal detected — check your mic or input device');
          return;
        }
        const hub = connectionManager.getHubIfConnected();
        if (!hub) throw new Error('Not connected');
        const result = (await hub.request('voice.transcribe', recording, { timeout: 125_000 })) as {
          text?: string;
        };
        // Backends return untrimmed text; a whitespace-only string for silence
        // is truthy, so it would skip the no-speech branch, insert a blank, and
        // leave the auto-send path with nothing to send — no feedback at all.
        const transcript = result.text?.trim() ?? '';
        if (sessionIdRef.current !== targetSessionId) {
          if (transcript) toast.info('Recording target changed — transcript discarded');
        } else if (transcript && mountedRef.current) {
          insertTranscript(transcript);
          // Only queue an auto-send when the transcript produced text; the
          // effect below fires it after isTranscribing flips false.
          if (mode !== 'stay') {
            pendingAutoSendRef.current = { sessionId: targetSessionId, mode };
            setHasPendingAutoSend(true);
          }
        } else if (transcript) {
          // Composer unmounted (user navigated away) while this transcription
          // was in flight. Deliver the transcript directly to the target session
          // — send/queue as a real message, stay staged into the pending field
          // (merged into the draft atomically by the daemon on next get) — so it
          // is never silently lost. Await so the toast reflects the outcome.
          const delivered = await deliverUnmountedTranscript(
            targetSessionId,
            transcript,
            mode,
            payloadSnapshot
          );
          if (delivered.ok) toast.info(delivered.message);
          else
            toast.error(
              delivered.message || 'Voice transcript could not be delivered — it was lost'
            );
        } else if (mountedRef.current) {
          // Backend heard nothing it could transcribe — say so instead of
          // silently returning to an empty composer.
          toast.info('No speech detected in that recording');
        }
      } catch (error) {
        await voiceRecorder.cancel();
        toast.error(error instanceof Error ? error.message : 'Voice transcription failed');
      } finally {
        recordingSessionRef.current = null;
        setIsTranscribing(false);
      }
    },
    [
      insertTranscript,
      deliverUnmountedTranscript,
      getImagesForSend,
      isTranscribing,
      onSend,
      voiceRecorder,
      sessionId,
    ]
  );

  // Cancel discards the recording AND its pinned target session.
  const cancelRecording = useCallback(() => {
    recordingSessionRef.current = null;
    void voiceRecorder.cancel();
  }, [voiceRecorder]);

  // Idle mic button lives in the textarea's voiceControl slot and only starts a
  // recording (stop/cancel live in the RecordingPanel).
  const handleVoiceClick = useCallback(() => {
    void startRecording();
  }, [startRecording]);

  // When the 5-minute limit fires the recorder tears down capture but keeps the
  // audio; transcribe it immediately so the UI never sits in a fake "still
  // recording" state with truncated audio (the original silent-truncation bug).
  const stopAndTranscribeRef = useRef(stopAndTranscribe);
  stopAndTranscribeRef.current = stopAndTranscribe;
  const limitHandledRef = useRef(false);
  useEffect(() => {
    if (voiceRecorder.durationLimitHit && !limitHandledRef.current) {
      limitHandledRef.current = true;
      void stopAndTranscribeRef.current();
    } else if (!voiceRecorder.durationLimitHit) {
      limitHandledRef.current = false;
    }
  }, [voiceRecorder.durationLimitHit]);

  const agentWorking = isProcessing ?? isAgentWorking.value;
  const [queuedForCurrentTurn, setQueuedForCurrentTurn] = useState<QueuePreviewMessage[]>([]);
  const [queuedForNextTurn, setQueuedForNextTurn] = useState<QueuePreviewMessage[]>([]);
  // Server-side queue sizes — the loaded arrays are capped by the fetch limit,
  // and the tray's full-list modal uses the totals to flag not-loaded messages.
  const [queuedCurrentTurnTotal, setQueuedCurrentTurnTotal] = useState<number | undefined>();
  const [queuedNextTurnTotal, setQueuedNextTurnTotal] = useState<number | undefined>();

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

    // Capture the targeted session at dispatch time. A previous target's
    // byStatus requests can still be in flight when the composer switches
    // sessions (e.g. to a not-yet-started agent); without this guard their
    // late response repopulates the trays with the wrong session's queue and
    // their actions bind to the now-empty session id. Discard responses whose
    // targeted session is no longer current.
    const targetSessionId = sessionId;
    try {
      const [enqueuedResponse, deferredResponse] = (await Promise.all([
        hub.request('session.messages.byStatus', {
          sessionId: targetSessionId,
          status: 'enqueued',
          limit: QUEUE_FETCH_LIMIT,
        }),
        hub.request('session.messages.byStatus', {
          sessionId: targetSessionId,
          status: 'deferred',
          limit: QUEUE_FETCH_LIMIT,
        }),
      ])) as [
        { messages?: QueuePreviewMessage[]; total?: number },
        { messages?: QueuePreviewMessage[]; total?: number },
      ];
      if (sessionIdRef.current !== targetSessionId) {
        return;
      }
      setQueuedForCurrentTurn(enqueuedResponse.messages ?? []);
      setQueuedForNextTurn(deferredResponse.messages ?? []);
      setQueuedCurrentTurnTotal(enqueuedResponse.total);
      setQueuedNextTurnTotal(deferredResponse.total);
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

  // The queue trays (current-turn / next-turn) are per-session. Reset them the
  // moment the targeted session changes so a stale tray from the previous
  // target never survives — notably when the task composer switches to a
  // not-yet-started target (sessionId='') whose byStatus refresh fails and is
  // swallowed, which would otherwise leave the prior agent's queue visible with
  // its actions bound to the now-empty session id. The refresh effect above
  // repopulates for a live target; this guarantees the stale case clears.
  useEffect(() => {
    setQueuedForCurrentTurn([]);
    setQueuedForNextTurn([]);
    setQueuedCurrentTurnTotal(undefined);
    setQueuedNextTurnTotal(undefined);
  }, [sessionId]);

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
      // Hold submission while a transcription is pending, a recording is in
      // progress, mic startup is pending, or a duration-capped recording is
      // awaiting transcription, so the composer is not cleared before the
      // dictated text is inserted.
      if (
        isTranscribing ||
        voiceRecorder.isRecording ||
        voiceRecorder.isStarting ||
        voiceRecorder.durationLimitHit
      ) {
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
      voiceRecorder.isRecording,
      voiceRecorder.isStarting,
      voiceRecorder.durationLimitHit,
    ]
  );

  // Voice Send/Steer/Queue: stopAndTranscribe('send'|'queue') pins an
  // auto-submit to the targeted session; once transcription finishes
  // (voiceActive flips false) the transcript is in the draft, so submit it —
  // unless the composer has since been re-targeted, in which case the text
  // stays as a draft.
  useEffect(() => {
    if (pendingAutoSendRef.current !== null && !voiceActive) {
      const pending = pendingAutoSendRef.current;
      pendingAutoSendRef.current = null;
      setHasPendingAutoSend(false);
      if (pending.sessionId === sessionId)
        void handleSubmit(pending.mode === 'queue' ? 'defer' : 'immediate');
    }
  }, [voiceActive, handleSubmit, content, sessionId]);

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

      if (e.key === 'Tab' && !e.shiftKey && agentWorking && supportsQueueDelivery) {
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
      supportsQueueDelivery,
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
              currentTurnTotal={queuedCurrentTurnTotal}
              nextTurnTotal={queuedNextTurnTotal}
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

            {/* Input Textarea — the waveform renders inside it via recordingBody while recording */}
            <InputTextarea
              content={content}
              onContentChange={handleContentChange}
              onSelect={handleSelect}
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
              onQueue={
                supportsQueueDelivery
                  ? () => {
                      void handleSubmit('defer');
                    }
                  : undefined
              }
              onStop={handleInterrupt}
              onPaste={disabled ? undefined : handlePaste}
              textareaRef={textareaInputRef}
              transparent={true}
              recordingBody={
                voiceActive ? (
                  <VoiceWaveform
                    getLevel={voiceRecorder.getLevel}
                    isRecording={voiceRecorder.isRecording}
                    isTranscribing={isTranscribing}
                    isStarting={voiceRecorder.isStarting}
                    onCancel={cancelRecording}
                    startedAt={voiceRecorder.recordingStartedAt}
                  />
                ) : undefined
              }
              voiceControl={
                voiceActive ? (
                  // Recording cluster: the mic slot becomes the red Stop, and the
                  // send controls stay exactly what this session state shows in
                  // the idle composer — blue Send when the agent is idle, Queue +
                  // amber Steer while it runs. The X (discard) lives at the left
                  // end of the waveform body, and the agent-stop is never shown
                  // here, so two stop buttons can never coexist.
                  <>
                    <button
                      type="button"
                      onClick={() => {
                        void stopAndTranscribe();
                      }}
                      // Enabled only once capture is actually running — during mic
                      // startup there is nothing to stop, so Stop/Send would be
                      // silent no-ops (Cancel remains the way out).
                      disabled={isTranscribing || !voiceRecorder.isRecording}
                      aria-label="Stop recording and transcribe"
                      title="Stop recording and transcribe"
                      class="grid h-9 w-9 place-items-center rounded-full bg-red-500 shadow-[0_2px_10px_rgba(239,68,68,0.4)] hover:bg-red-600 disabled:cursor-not-allowed disabled:opacity-50"
                    >
                      <svg class="h-3.5 w-3.5" viewBox="0 0 24 24" fill="#fff">
                        <rect x="6" y="6" width="12" height="12" rx="2" />
                      </svg>
                    </button>
                    {agentWorking ? (
                      <>
                        {supportsQueueDelivery && (
                          <button
                            type="button"
                            onClick={() => {
                              void stopAndTranscribe('queue');
                            }}
                            disabled={isTranscribing || !voiceRecorder.isRecording}
                            aria-label="Stop, transcribe and queue"
                            title="Stop, transcribe and queue for next turn"
                            class="grid h-9 w-9 place-items-center rounded-full border border-blue-400/30 bg-blue-500/10 text-blue-200 hover:bg-blue-500/20 hover:text-blue-100 active:scale-95 disabled:cursor-not-allowed disabled:opacity-50"
                          >
                            <svg
                              class="h-4 w-4"
                              fill="none"
                              viewBox="0 0 24 24"
                              stroke="currentColor"
                              stroke-width={2.3}
                            >
                              <path
                                stroke-linecap="round"
                                stroke-linejoin="round"
                                d="M4 7h11a4 4 0 010 8H7m0 0l3-3m-3 3l3 3"
                              />
                            </svg>
                          </button>
                        )}
                        <button
                          type="button"
                          onClick={() => {
                            void stopAndTranscribe('send');
                          }}
                          disabled={isTranscribing || !voiceRecorder.isRecording}
                          aria-label="Stop, transcribe and steer"
                          title="Stop, transcribe and steer the current turn"
                          class="grid h-9 w-9 place-items-center rounded-full bg-amber-400 text-dark-950 hover:bg-amber-300 active:scale-95 disabled:cursor-not-allowed disabled:opacity-50"
                        >
                          <svg
                            class="h-4.5 w-4.5"
                            viewBox="0 0 24 24"
                            fill="none"
                            stroke="currentColor"
                            stroke-width={2.5}
                          >
                            <path
                              stroke-linecap="round"
                              stroke-linejoin="round"
                              d="M5 10l7-7m0 0l7 7m-7-7v18"
                            />
                          </svg>
                        </button>
                      </>
                    ) : (
                      <button
                        type="button"
                        onClick={() => {
                          void stopAndTranscribe('send');
                        }}
                        disabled={isTranscribing || !voiceRecorder.isRecording}
                        aria-label="Stop, transcribe and send"
                        title="Stop, transcribe and send"
                        class="grid h-9 w-9 place-items-center rounded-full bg-blue-500 text-white hover:bg-blue-600 active:scale-95 disabled:cursor-not-allowed disabled:opacity-50"
                      >
                        <svg
                          class="h-4.5 w-4.5"
                          viewBox="0 0 24 24"
                          fill="none"
                          stroke="currentColor"
                          stroke-width={2.5}
                        >
                          <path
                            stroke-linecap="round"
                            stroke-linejoin="round"
                            d="M5 10l7-7m0 0l7 7m-7-7v18"
                          />
                        </svg>
                      </button>
                    )}
                  </>
                ) : voiceControlVisible ? (
                  <button
                    type="button"
                    onClick={() => {
                      void handleVoiceClick();
                    }}
                    // Do NOT disable on `!voiceSupported`: in a non-secure context
                    // (anything but HTTPS / localhost / 127.0.0.1) the recorder
                    // can't start, but we still want the click to reach
                    // handleVoiceClick so it surfaces the explanatory toast
                    // instead of being a silently-disabled no-op. The guard
                    // inside handleVoiceClick handles the unsupported case.
                    disabled={(disabled && !voiceRecorder.isRecording) || isTranscribing}
                    title={
                      voiceSupported
                        ? 'Start voice input'
                        : 'Voice input requires HTTPS or localhost'
                    }
                    aria-label="Start voice input"
                    class={`w-9 h-9 rounded-full flex items-center justify-center transition-all duration-200 focus-visible:outline-none focus-visible:ring-2 ${
                      isTranscribing
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
