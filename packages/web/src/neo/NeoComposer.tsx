import { useCallback, useLayoutEffect, useRef, useState } from 'preact/hooks';
import { useCoarsePointer } from './useCoarsePointer.ts';
import type { SessionStore } from '../lib/session-store.ts';
import { connectionManager } from '../lib/connection-manager.ts';
import { connectionState } from '../lib/state.ts';
import { Button } from '../components/ui/Button.tsx';
import { NeoIcon } from './NeoIcon.tsx';
import { NeoPreferences } from './NeoPreferences.tsx';
import { NeoVoice, type VoicePhase } from './NeoVoice.tsx';
import { NEO_FILE_ACCEPT, attachmentMessage, useNeoAttachments } from './neo-attachments.ts';
import { NeoAttachments } from './NeoAttachments.tsx';
import { getVoiceRecord, type VoiceRecordEntry } from '../lib/voice/voice-audio-store.ts';
import {
  combineVoiceSubmission,
  submitVoiceSendIntent,
  type VoiceSendOutcome,
} from '../lib/voice/voice-audio-outbox.ts';
import type { createNeoIntakeClient } from './neo-intake.ts';

export function neoEnterSends(
  keyboard: { shiftKey: boolean; metaKey: boolean; ctrlKey: boolean },
  coarsePointer: boolean
): boolean {
  const modifierSend = keyboard.metaKey || keyboard.ctrlKey;
  return coarsePointer ? modifierSend : !keyboard.shiftKey || modifierSend;
}

export function NeoComposer({
  store,
  sessionId,
  draft,
  onDraft,
  onError,
  onTranscript,
  onSend,
}: {
  store: SessionStore;
  sessionId: string;
  draft: string;
  onDraft: (value: string) => void;
  onError: (message: string) => void;
  onTranscript: (text: string) => void;
  onSend: ReturnType<typeof createNeoIntakeClient>['send'];
}) {
  const [sending, setSending] = useState(false);
  const coarsePointer = useCoarsePointer();
  const [voicePhase, setVoicePhase] = useState<VoicePhase>('idle');
  const voiceBusy = voicePhase !== 'idle';
  const recordingVoice = voicePhase === 'recording';
  const sendFromVoice = useRef<(() => void) | null>(null);
  const registerSendFromVoice = useCallback((send: (() => void) | null) => {
    sendFromVoice.current = send;
  }, []);
  const attachments = useNeoAttachments(sessionId);
  const fileInput = useRef<HTMLInputElement>(null);
  const inFlight = useRef(false);
  const sendingText = useRef<string | null>(null);
  const alive = useRef(true);
  const currentSession = useRef(sessionId);
  currentSession.current = sessionId;
  const currentDraft = useRef(draft);
  currentDraft.current = draft;
  useLayoutEffect(
    () => () => {
      alive.current = false;
    },
    []
  );
  const connected = connectionState.value === 'connected';
  async function send() {
    if (recordingVoice) {
      sendFromVoice.current?.();
      return;
    }
    const submitted = draft;
    const files = attachments.files;
    if (!submitted.trim() && !files.length) return;
    if (voiceBusy) return;
    if (!connected) {
      onError('Reconnecting… your message is still here. Send again once connected.');
      return;
    }
    if (attachments.reading) {
      onError('Still reading your attachment. Send again in a moment.');
      return;
    }
    if (sendingText.current === submitted) return;
    sendingText.current = submitted;
    inFlight.current = true;
    setSending(true);
    onError('');
    const current = () => alive.current && currentSession.current === sessionId;
    try {
      const images = files.flatMap((file) => (file.kind === 'image' ? [file.image] : []));
      const content = attachmentMessage(submitted, files);
      attachments.remove(files.map((file) => file.id));
      await onSend({ sessionId, text: content, images }).catch(() => undefined);
    } finally {
      if (sendingText.current === submitted) {
        sendingText.current = null;
        inFlight.current = false;
        if (current()) setSending(false);
      }
    }
  }
  async function sendVoice(
    record: VoiceRecordEntry,
    transcript: string
  ): Promise<VoiceSendOutcome> {
    if (record.sendText === undefined && (attachments.files.length > 0 || attachments.reading > 0))
      return { kind: 'unconfirmed' };
    const composed = record.sendText ?? combineVoiceSubmission(draft, transcript);
    if (!composed.trim() || inFlight.current || sending || !connected)
      return { kind: 'unconfirmed' };
    inFlight.current = true;
    setSending(true);
    onError('');
    const hub = connectionManager.getHubIfConnected();
    if (!hub) {
      inFlight.current = false;
      setSending(false);
      return { kind: 'unconfirmed' };
    }
    try {
      const outcome = await submitVoiceSendIntent(hub, record, composed);
      if (outcome.kind === 'accepted' && currentDraft.current === draft) onDraft('');
      else if (outcome.kind === 'refused' && alive.current) onError(outcome.reason);
      return outcome;
    } catch {
      return { kind: 'unconfirmed' };
    } finally {
      inFlight.current = false;
      if (alive.current) setSending(false);
    }
  }
  return (
    <form
      onSubmit={(event) => {
        event.preventDefault();
        void send();
      }}
      class="pointer-events-auto relative rounded-3xl border border-line-strong bg-surface-raised/95 p-4 shadow-xl backdrop-blur-xl transition-colors focus-within:border-accent/60"
    >
      {attachments.files.length > 0 && (
        <NeoAttachments files={attachments.files} onRemove={attachments.remove} />
      )}
      {attachments.reading > 0 && (
        <p role="status" class="mb-2 text-xs text-fg-muted">
          Reading attachments…
        </p>
      )}
      <input
        ref={fileInput}
        type="file"
        multiple
        accept={NEO_FILE_ACCEPT}
        aria-label="Attach photos or files"
        class="hidden"
        onChange={(event) => {
          const files = Array.from(event.currentTarget.files ?? []);
          event.currentTarget.value = '';
          void attachments.add(files, onError);
        }}
      />
      <textarea
        id="neo-thought"
        aria-label="Message Neo"
        disabled={voiceBusy}
        value={draft}
        onInput={(event) => onDraft(event.currentTarget.value)}
        onPaste={(event) => {
          const files = Array.from(event.clipboardData?.files ?? []);
          if (files.length) {
            event.preventDefault();
            void attachments.add(files, onError);
          }
        }}
        onKeyDown={(event) => {
          if (event.key !== 'Enter' || event.isComposing || event.keyCode === 229) return;
          if (
            neoEnterSends(
              { shiftKey: event.shiftKey, metaKey: event.metaKey, ctrlKey: event.ctrlKey },
              coarsePointer
            )
          ) {
            event.preventDefault();
            void send();
          }
        }}
        rows={2}
        maxLength={16000}
        placeholder={
          coarsePointer
            ? 'Return adds a line · Tap the arrow to send'
            : 'Enter to send · Shift + Enter for a new line'
        }
        class="w-full resize-none bg-transparent text-base leading-relaxed text-fg placeholder:text-fg-faint focus:outline-none"
      />
      <div class="mt-2 flex flex-wrap items-center justify-between gap-2">
        <div class="flex min-w-0 items-center gap-1">
          <button
            type="button"
            aria-label="Attach photos or files"
            title="Attach photos or text files"
            onClick={() => fileInput.current?.click()}
            class="rounded-full p-2 text-fg-muted hover:bg-fill-soft hover:text-accent"
          >
            <NeoIcon name="plus" />
          </button>
          <NeoPreferences sessionId={sessionId} store={store} onError={onError} />
        </div>
        <span
          role="status"
          class={`min-w-0 items-center justify-center gap-2 text-xs text-fg-muted ${
            recordingVoice || store.agentState.value.status === 'waiting_for_input'
              ? 'order-last flex w-full sm:order-none sm:w-auto sm:flex-1'
              : 'hidden'
          }`}
        >
          {recordingVoice
            ? coarsePointer
              ? 'Recording · Tap the arrow to stop and send'
              : 'Recording · Click the arrow to stop and send'
            : store.agentState.value.status === 'waiting_for_input'
              ? 'A quick question for you above.'
              : null}
        </span>
        <div class="ml-auto flex shrink-0 gap-2">
          <NeoVoice
            sessionId={sessionId}
            connected={connected}
            draftText={draft}
            onTranscript={onTranscript}
            onSendVoice={async (text, recordId) => {
              const record = await getVoiceRecord(recordId);
              if (!record) return { kind: 'unconfirmed' } as const;
              return sendVoice(record, text);
            }}
            onSendHandle={registerSendFromVoice}
            onError={onError}
            onPhase={setVoicePhase}
          />
          <Button
            type="submit"
            size="sm"
            aria-label={recordingVoice ? 'Stop recording and send the message' : 'Send message'}
            title={
              recordingVoice && attachments.files.length > 0
                ? 'Send or remove your attachments first, or use Stop to keep this as a draft'
                : recordingVoice
                  ? 'Stop recording and send it now'
                  : undefined
            }
          >
            <NeoIcon name="up" />
          </Button>
        </div>
      </div>
    </form>
  );
}
