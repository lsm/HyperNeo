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
  type VoiceRecording,
} from '../hooks';

import { getMessagesBottomPaddingPx } from '../lib/layout-metrics.ts';
import { connectionManager } from '../lib/connection-manager';
import type { SessionStore } from '../lib/session-store.ts';
import { connectionState, globalSettings, isAgentWorking } from '../lib/state.ts';
import { toast } from '../lib/toast.ts';
import {
  beginInteractiveVoiceSubmit,
  endInteractiveVoiceSubmit,
  isVoiceAudioBusy,
  markVoiceAudioBusy,
  pendingVoiceAudioRecords,
  recordingFromEntry,
  refreshPendingVoiceAudio,
  unmarkVoiceAudioBusy,
} from '../lib/voice/voice-audio-outbox.ts';
import {
  deleteVoiceRecord,
  putVoiceRecord,
  type VoiceRecordEntry,
} from '../lib/voice/voice-audio-store.ts';
import { runVoiceSubmit, type VoiceSubmitResult } from '../lib/voice/voice-submit-pipeline.ts';
import type { VoiceSubmitMode } from '../lib/voice/voice-submit-routing.ts';
import {
  enqueueTranscript,
  isPermanentAppendRefusal,
} from '../lib/voice/voice-transcript-outbox.ts';
import { AttachmentPreview } from './AttachmentPreview.tsx';
import { InputActionsMenu } from './InputActionsMenu.tsx';
import { InputTextarea } from './InputTextarea.tsx';
import { VoiceWaveform } from './voice/VoiceWaveform.tsx';
import { PendingVoiceAudioTray } from './voice/PendingVoiceAudioTray.tsx';
import { QueuePreviewTray, type QueuePreviewMessage } from './QueuePreviewTray.tsx';
import { ContentContainer } from './ui/ContentContainer.tsx';

export function replaceActiveAtQuery(content: string, type: string, id: string): string {
  const replacement = `@ref{${type}:${id}} `;
  const match = content.match(/((?:^|\s))@(\S*)$/);
  if (!match) return content;
  const prefix = match[1];
  const matchStart = content.length - match[0].length;
  return content.slice(0, matchStart) + prefix + replacement;
}

const NON_JOINING_BOUNDARY = /[\s\p{P}]/u;
function isNonJoiningBoundary(char: string): boolean {
  return char.length > 0 && NON_JOINING_BOUNDARY.test(char);
}

const CJK = /[\p{sc=Han}\p{sc=Hiragana}\p{sc=Katakana}\p{sc=Hangul}]/u;
function isCjk(char: string | undefined): boolean {
  return !!char && char.length > 0 && CJK.test(char);
}

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

const COMPOSER_CHAR_LIMIT = 100000;

const QUEUE_FETCH_LIMIT = 1000;
const QUEUE_EVENT_REFRESH_DEBOUNCE_MS = 300;
const QUEUE_FALLBACK_POLL_MS = 5000;

const VOICE_DISCONNECTED_HANDOFF = 'Voice submit handed off to the reconnect outbox';

interface VoicePayloadSnapshot {
  before: string;
  after: string;
  full: string;
  images?: MessageImage[];
  send: MessageInputProps['onSend'];
}

interface VoiceSubmitFollowUp {
  targetSessionId: string;
  mode: VoiceSubmitMode;
  recording: VoiceRecording | null;
  payload: VoicePayloadSnapshot;
  resendOf?: string;
}

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
  placeholder?: string;
  leadingElement?: ComponentChildren;
  leadingPaddingClass?: string;
  onDraftActiveChange?: (hasDraft: boolean) => void;
  isProcessing?: boolean;
  supportsQueueDelivery?: boolean;
  registerDropTarget?: RegisterFileDropTarget;
  coordinatorMode?: boolean;
  coordinatorSwitching?: boolean;
  onCoordinatorModeChange?: (enabled: boolean) => void;
  sandboxEnabled?: boolean;
  sandboxSwitching?: boolean;
  onSandboxModeChange?: (enabled: boolean) => void;
  features?: SessionFeatures;
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
  const isTouchDeviceRef = useRef(
    window.matchMedia('(pointer: coarse)').matches ||
      ('ontouchstart' in window && window.innerWidth < 768)
  );

  const textareaInputRef = useRef<HTMLTextAreaElement>(null);

  const submittingRef = useRef(false);

  const mountedRef = useRef(true);
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  const { content, setContent, clear: clearDraft, holdDraftAdoption } = useInputDraft(sessionId);
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
  const [hasPendingAutoSend, setHasPendingAutoSend] = useState(false);
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
  const voiceTargetReady = sessionId !== '';
  const voiceControlVisible =
    ((voiceEnabled && voiceConfigured) ||
      voiceRecorder.isRecording ||
      voiceRecorder.isStarting ||
      voiceRecorder.durationLimitHit) &&
    voiceTargetReady;
  const voiceSupported = isVoiceRecordingSupported();
  const voiceActive =
    voiceRecorder.isStarting ||
    voiceRecorder.isRecording ||
    isTranscribing ||
    voiceRecorder.durationLimitHit;

  useEffect(() => {
    registerDropTarget?.((files) => {
      if (!disabled) void handleFileDrop(files);
    });
    return () => registerDropTarget?.(null);
  }, [disabled, handleFileDrop, registerDropTarget]);

  useEffect(() => {
    onDraftActiveChange?.(content.trim().length > 0);
  }, [content, onDraftActiveChange]);

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

  const handleReferenceSelect = useCallback(
    (reference: ReferenceMention) => {
      const updated = replaceActiveAtQuery(content, reference.type, reference.id);
      if (updated === content) return;
      setContent(updated);
      textareaInputRef.current?.focus();
    },
    [content, setContent]
  );

  const referenceAutocomplete = useReferenceAutocomplete({
    content,
    onSelect: handleReferenceSelect,
    store,
  });

  const [agentMentionQuery, setAgentMentionQuery] = useState<string | null>(null);
  const [agentMentionSelectedIndex, setAgentMentionSelectedIndex] = useState(0);
  const lastCursorRef = useRef(0);
  const lastSelectionEndRef = useRef(0);

  const filteredAgentMentionCandidates = useMemo(() => {
    if (agentMentionQuery === null || !agentMentionCandidates) return [];
    return agentMentionCandidates.filter((a) =>
      a.name.toLowerCase().startsWith(agentMentionQuery.toLowerCase())
    );
  }, [agentMentionCandidates, agentMentionQuery]);

  const showAgentMentionAutocomplete =
    agentMentionQuery !== null && filteredAgentMentionCandidates.length > 0;

  const handleSelect = useCallback(() => {
    const textarea = textareaInputRef.current;
    if (!textarea) return;
    lastCursorRef.current = textarea.selectionStart ?? textarea.value.length;
    lastSelectionEndRef.current = textarea.selectionEnd ?? lastCursorRef.current;
  }, []);

  const handleContentChange = useCallback(
    (value: string) => {
      if (submittingRef.current) return;

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
      recordingSessionRef.current = sessionId;
      const textarea = textareaInputRef.current;
      if (textarea) {
        lastCursorRef.current = textarea.selectionStart ?? textarea.value.length;
        lastSelectionEndRef.current = textarea.selectionEnd ?? lastCursorRef.current;
      }
      try {
        await voiceRecorder.start({
          start: lastCursorRef.current,
          end: lastSelectionEndRef.current,
        });
      } catch (error) {
        toast.error(error instanceof Error ? error.message : 'Voice input failed to start');
      }
    }
  }, [isTranscribing, voiceRecorder, voiceSupported, sessionId]);

  const pendingAutoSendRef = useRef<{ sessionId: string; mode: VoiceSubmitMode } | null>(null);
  const sessionIdRef = useRef(sessionId);
  sessionIdRef.current = sessionId;
  const recordingSessionRef = useRef<string | null>(null);
  useEffect(() => {
    if (
      (voiceRecorder.isRecording || voiceRecorder.durationLimitHit) &&
      voiceRecorder.recordingSessionId
    ) {
      recordingSessionRef.current = voiceRecorder.recordingSessionId;
      const cursor = voiceRecorder.recordingCursor;
      if (cursor) {
        lastCursorRef.current = cursor.start;
        lastSelectionEndRef.current = cursor.end;
      }
    }
  });

  const deliverUnmountedTranscript = useCallback(
    async (
      targetSessionId: string,
      transcript: string,
      mode: 'stay' | 'send' | 'queue',
      payload: {
        before: string;
        after: string;
        full: string;
        images?: MessageImage[];
        send: MessageInputProps['onSend'];
      }
    ): Promise<{ ok: boolean; message: string }> => {
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
      const stageFallback = async (message: string): Promise<{ ok: boolean; message: string }> => {
        try {
          await stageToDraft();
          return { ok: true, message };
        } catch (error) {
          if (!isPermanentAppendRefusal(error)) {
            const durable = enqueueTranscript(targetSessionId, transcript, outboxId);
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
        return stageFallback('Voice send failed — transcript saved to the session draft');
      }
      if (sent === false) {
        return stageFallback('Voice send failed — transcript saved to the session draft');
      }
      if (payload.full.trim().length > 0) {
        const hub = connectionManager.getHubIfConnected();
        if (hub) {
          try {
            await hub.request('session.clearInputDraftIf', {
              sessionId: targetSessionId,
              expected: payload.full,
            });
          } catch {}
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

  const interpretVoiceSubmit = useCallback(
    async (result: VoiceSubmitResult, followUp: VoiceSubmitFollowUp): Promise<void> => {
      const saveForResend = async (recordId: string): Promise<boolean> => {
        if (!followUp.recording) return false;
        return putVoiceRecord({
          id: recordId,
          sessionId: followUp.targetSessionId,
          audioBase64: followUp.recording.audioBase64,
          mimeType: followUp.recording.mimeType,
          hitDurationLimit: followUp.recording.hitDurationLimit,
          peakLevel: followUp.recording.peakLevel,
          createdAt: Date.now(),
        });
      };
      if (result.kind === 'silent-recording') {
        if (followUp.resendOf === undefined) {
          const saved = await saveForResend(generateUUID());
          toast.error(
            saved
              ? 'No microphone signal detected — recording saved for resend'
              : 'No microphone signal detected — check your mic or input device'
          );
        }
        return;
      }
      if (result.kind === 'transcribe-failed') {
        toast.error(result.message);
        if (result.persisted && !result.dequeued) {
          toast.info('Voice recording saved for resend');
        }
        return;
      }
      const outcome = result.outcome;
      if (outcome.kind === 'insert') {
        insertTranscript(outcome.transcript);
        if (outcome.autoSend) {
          pendingAutoSendRef.current = {
            sessionId: followUp.targetSessionId,
            mode: followUp.mode,
          };
          setHasPendingAutoSend(true);
        }
        if (result.persisted) await deleteVoiceRecord(result.recordId);
        return;
      }
      if (outcome.kind === 'deliver-unmounted') {
        const delivered = await deliverUnmountedTranscript(
          followUp.targetSessionId,
          outcome.transcript,
          outcome.mode,
          followUp.payload
        );
        if (delivered.ok) {
          toast.info(delivered.message);
          if (result.persisted) await deleteVoiceRecord(result.recordId);
        } else if (result.persisted && !result.dequeued) {
          toast.error('Voice transcript could not be delivered — recording saved for resend');
        } else {
          toast.error(delivered.message || 'Voice transcript could not be delivered — it was lost');
        }
        return;
      }
      if (outcome.kind === 'discard-with-reason') {
        if (sessionIdRef.current !== followUp.targetSessionId) {
          const saved = await saveForResend(result.recordId);
          if (outcome.reason) {
            toast.info(
              saved
                ? 'Recording target changed — recording saved for resend'
                : 'Recording target changed — transcript discarded'
            );
          }
        } else if (outcome.reason) {
          toast.info(outcome.reason);
        }
        return;
      }
      toast.info(outcome.reason);
    },
    [insertTranscript, deliverUnmountedTranscript]
  );

  const captureVoicePayload = useCallback((): VoicePayloadSnapshot => {
    const snapshotContent = textareaInputRef.current?.value ?? contentRef.current;
    const snapshotStart = textareaInputRef.current?.selectionStart ?? lastCursorRef.current;
    const snapshotEnd =
      textareaInputRef.current?.selectionEnd ??
      Math.max(snapshotStart, lastSelectionEndRef.current);
    return {
      before: snapshotContent.slice(0, snapshotStart),
      after: snapshotContent.slice(snapshotEnd),
      full: snapshotContent,
      images: getImagesForSend(),
      send: onSend,
    };
  }, [getImagesForSend, onSend]);

  const stopAndTranscribe = useCallback(
    async (mode: VoiceSubmitMode = 'stay') => {
      if (isTranscribing) return;
      if (!voiceRecorder.isRecording && !voiceRecorder.durationLimitHit) return;
      const targetSessionId = recordingSessionRef.current ?? sessionId;
      const payload = captureVoicePayload();
      const recordId = generateUUID();
      setIsTranscribing(true);
      markVoiceAudioBusy(recordId);
      beginInteractiveVoiceSubmit();
      try {
        const stoppedRecording = await voiceRecorder.stop();
        if (stoppedRecording.hitDurationLimit) {
          toast.info('Voice recording stopped at 5 minutes — transcribing…');
        }
        const result = await runVoiceSubmit(
          { sessionId: targetSessionId, mode },
          {
            stopRecording: async () => stoppedRecording,
            generateId: () => recordId,
            delay: (ms) =>
              new Promise<void>((resolve, reject) => {
                const fail = () => {
                  cleanup();
                  reject(new Error(VOICE_DISCONNECTED_HANDOFF));
                };
                const timer = setTimeout(() => {
                  cleanup();
                  resolve();
                }, ms);
                const unsubscribe = connectionState.subscribe((state) => {
                  if (state !== 'connected') fail();
                });
                const cleanup = () => {
                  clearTimeout(timer);
                  unsubscribe();
                };
                if (!connectionManager.getHubIfConnected()) fail();
              }),
            isMounted: () => mountedRef.current,
            currentSessionId: () => sessionIdRef.current,
          }
        );
        await interpretVoiceSubmit(result, {
          targetSessionId,
          mode,
          recording: stoppedRecording,
          payload,
        });
      } catch (error) {
        if (error instanceof Error && error.message === VOICE_DISCONNECTED_HANDOFF) {
          toast.info(
            'Voice recording saved — transcript will be restored to the draft when reconnected'
          );
        } else {
          await voiceRecorder.cancel();
          toast.error(error instanceof Error ? error.message : 'Voice transcription failed');
        }
      } finally {
        endInteractiveVoiceSubmit();
        unmarkVoiceAudioBusy(recordId);
        recordingSessionRef.current = null;
        setIsTranscribing(false);
        void refreshPendingVoiceAudio();
      }
    },
    [captureVoicePayload, interpretVoiceSubmit, isTranscribing, voiceRecorder, sessionId]
  );

  const cancelRecording = useCallback(() => {
    recordingSessionRef.current = null;
    void voiceRecorder.cancel();
  }, [voiceRecorder]);

  const handleVoiceClick = useCallback(() => {
    void startRecording();
  }, [startRecording]);

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

  const [resendingVoiceRecordId, setResendingVoiceRecordId] = useState<string | null>(null);
  const pendingVoiceEntries = pendingVoiceAudioRecords.value.filter(
    (entry) => entry.sessionId === sessionId
  );

  useEffect(() => {
    void refreshPendingVoiceAudio();
  }, []);

  const handleVoiceAudioResend = useCallback(
    async (entry: VoiceRecordEntry) => {
      if (resendingVoiceRecordId !== null || isTranscribing) return;
      if (isVoiceAudioBusy(entry.id)) return;
      const payload = captureVoicePayload();
      const recording = recordingFromEntry(entry);
      setResendingVoiceRecordId(entry.id);
      markVoiceAudioBusy(entry.id);
      beginInteractiveVoiceSubmit();
      try {
        const result = await runVoiceSubmit(
          { sessionId: entry.sessionId, retrySilent: true },
          {
            stopRecording: async () => recording,
            putRecord: async () => true,
            generateId: () => entry.id,
            isMounted: () => mountedRef.current,
            currentSessionId: () => sessionIdRef.current,
          }
        );
        await interpretVoiceSubmit(result, {
          targetSessionId: entry.sessionId,
          mode: 'stay',
          recording,
          payload,
          resendOf: entry.id,
        });
      } catch (error) {
        toast.error(error instanceof Error ? error.message : 'Voice resend failed');
      } finally {
        endInteractiveVoiceSubmit();
        unmarkVoiceAudioBusy(entry.id);
        setResendingVoiceRecordId(null);
        void refreshPendingVoiceAudio();
      }
    },
    [captureVoicePayload, interpretVoiceSubmit, isTranscribing, resendingVoiceRecordId]
  );

  const handleVoiceAudioDelete = useCallback(async (entry: VoiceRecordEntry) => {
    if (isVoiceAudioBusy(entry.id)) return;
    await deleteVoiceRecord(entry.id);
    await refreshPendingVoiceAudio();
  }, []);

  const agentWorking = isProcessing ?? isAgentWorking.value;
  const [queuedForCurrentTurn, setQueuedForCurrentTurn] = useState<QueuePreviewMessage[]>([]);
  const [queuedForNextTurn, setQueuedForNextTurn] = useState<QueuePreviewMessage[]>([]);
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

  const queueRefreshSeqRef = useRef(0);
  const queueRefreshAppliedSeqRef = useRef(0);

  const refreshQueuedMessages = useCallback(async () => {
    const hub = connectionManager.getHubIfConnected();
    if (!hub) {
      return;
    }

    const targetSessionId = sessionId;
    const refreshSeq = queueRefreshSeqRef.current + 1;
    queueRefreshSeqRef.current = refreshSeq;
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
      if (refreshSeq <= queueRefreshAppliedSeqRef.current) {
        return;
      }
      queueRefreshAppliedSeqRef.current = refreshSeq;
      setQueuedForCurrentTurn(enqueuedResponse.messages ?? []);
      setQueuedForNextTurn(deferredResponse.messages ?? []);
      setQueuedCurrentTurnTotal(enqueuedResponse.total);
      setQueuedNextTurnTotal(deferredResponse.total);
    } catch {}
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
    pendingVoiceEntries.length,
  ]);

  useEffect(() => {
    void refreshQueuedMessages();
  }, [refreshQueuedMessages]);

  useEffect(() => {
    setQueuedForCurrentTurn([]);
    setQueuedForNextTurn([]);
    setQueuedCurrentTurnTotal(undefined);
    setQueuedNextTurnTotal(undefined);
  }, [sessionId]);

  useEffect(() => {
    const hub = connectionManager.getHubIfConnected();
    if (!hub) {
      return;
    }
    let refreshTimer: ReturnType<typeof setTimeout> | null = null;
    const unsubscribe = hub.onEvent<{ sessionId?: string }>('messages.statusChanged', (payload) => {
      if (payload?.sessionId !== sessionId) {
        return;
      }
      if (refreshTimer) {
        clearTimeout(refreshTimer);
      }
      refreshTimer = setTimeout(() => {
        refreshTimer = null;
        void refreshQueuedMessages();
      }, QUEUE_EVENT_REFRESH_DEBOUNCE_MS);
    });
    void refreshQueuedMessages();
    return () => {
      unsubscribe();
      if (refreshTimer) {
        clearTimeout(refreshTimer);
      }
    };
  }, [sessionId, refreshQueuedMessages, connectionState.value]);

  useEffect(() => {
    if (!agentWorking && queuedForCurrentTurn.length === 0 && queuedForNextTurn.length === 0)
      return;
    const timer = setInterval(() => {
      if (document.hidden) {
        return;
      }
      void refreshQueuedMessages();
    }, QUEUE_FALLBACK_POLL_MS);
    return () => clearInterval(timer);
  }, [agentWorking, queuedForCurrentTurn.length, queuedForNextTurn.length, refreshQueuedMessages]);

  const handleTextareaHeightChange = useCallback(
    (_heightPx: number) => {
      syncMessagesContainerPadding();
    },
    [syncMessagesContainerPadding]
  );

  const handleSubmit = useCallback(
    async (deliveryMode: MessageDeliveryMode = 'immediate') => {
      if (disabled) {
        return;
      }
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

      const savedContent = outgoing.content;
      const savedAttachments = attachments;

      submittingRef.current = true;

      await holdDraftAdoption(async () => {
        clearDraft();
        clearAttachments();

        if (textareaInputRef.current) {
          textareaInputRef.current.value = '';
        }

        try {
          const result = await onSend(savedContent, outgoing.images, deliveryMode);

          if (result === false) {
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
      });
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
      holdDraftAdoption,
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

  useEffect(() => {
    if (pendingAutoSendRef.current !== null && !voiceActive) {
      const pending = pendingAutoSendRef.current;
      pendingAutoSendRef.current = null;
      setHasPendingAutoSend(false);
      if (pending.sessionId === sessionId)
        void handleSubmit(pending.mode === 'queue' ? 'defer' : 'immediate');
    }
  }, [voiceActive, handleSubmit, content, sessionId]);

  const refHandleKeyDown = referenceAutocomplete.handleKeyDown;
  const cmdHandleKeyDown = commandAutocomplete.handleKeyDown;

  const handleKeyDown = useCallback(
    (e: KeyboardEvent) => {
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

      if (refHandleKeyDown(e)) {
        return;
      }

      if (cmdHandleKeyDown(e)) {
        return;
      }

      if (e.key === 'Tab' && !e.shiftKey && agentWorking && supportsQueueDelivery) {
        e.preventDefault();
        void handleSubmit('defer');
        return;
      }

      if (e.key === 'Enter') {
        if (e.metaKey || e.ctrlKey) {
          e.preventDefault();
          void handleSubmit('immediate');
          return;
        }

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

  const handleModelSwitch = useCallback(
    async (model: ModelInfo) => {
      await switchModel(model);
      actionsMenu.close();
    },
    [switchModel, actionsMenu]
  );

  return (
    <ContentContainer className="pb-2">
      <div class="relative">
        <form
          onSubmit={(e) => {
            e.preventDefault();
            void handleSubmit('immediate');
          }}
        >
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

          {pendingVoiceEntries.length > 0 && !disabled && (
            <PendingVoiceAudioTray
              records={pendingVoiceEntries}
              resendingId={resendingVoiceRecordId}
              isBusy={isVoiceAudioBusy}
              className="mb-2 sm:ml-[58px]"
              onResend={(entry) => {
                void handleVoiceAudioResend(entry);
              }}
              onDelete={(entry) => {
                void handleVoiceAudioDelete(entry);
              }}
            />
          )}

          <div class="flex items-end gap-3">
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

            <input
              ref={fileInputRef}
              type="file"
              accept="image/png,image/jpeg,image/gif,image/webp"
              multiple
              onChange={handleFileSelect}
              class="hidden"
            />

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
                  <>
                    <button
                      type="button"
                      onClick={() => {
                        void stopAndTranscribe();
                      }}
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
