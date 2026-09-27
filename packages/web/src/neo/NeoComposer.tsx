import { useEffect, useRef, useState } from 'preact/hooks';
import type { SessionStore } from '../lib/session-store.ts';
import { connectionState } from '../lib/state.ts';
import { useSendMessage } from '../hooks/useSendMessage.ts';
import { useInterrupt } from '../hooks/useInterrupt.ts';
import { Button } from '../components/ui/Button.tsx';
import { NeoIcon } from './NeoIcon.tsx';
import { NeoPreferences } from './NeoPreferences.tsx';
import { NeoVoice } from './NeoVoice.tsx';
import { NEO_FILE_ACCEPT, attachmentMessage, useNeoAttachments } from './neo-attachments.ts';
import { NeoAttachments } from './NeoAttachments.tsx';

export function NeoComposer({
  store,
  sessionId,
  draft,
  onDraft,
  onError,
  onTranscript,
}: {
  store: SessionStore;
  sessionId: string;
  draft: string;
  onDraft: (value: string) => void;
  onError: (message: string) => void;
  onTranscript: (text: string) => void;
}) {
  const [sending, setSending] = useState(false);
  const [voiceBusy, setVoiceBusy] = useState(false);
  const attachments = useNeoAttachments(sessionId);
  const fileInput = useRef<HTMLInputElement>(null);
  const inFlight = useRef(false);
  const currentDraft = useRef(draft);
  currentDraft.current = draft;
  const { sendMessage, clearSendTimeout } = useSendMessage({
    sessionId,
    session: store.sessionInfo.value,
    isSending: sending,
    onSendStart: () => setSending(true),
    onSendComplete: () => setSending(false),
    onError,
  });
  const { handleInterrupt, interrupting } = useInterrupt({ sessionId });
  useEffect(() => () => clearSendTimeout(), [clearSendTimeout]);
  const working = store.isWorking.value;
  const connected = connectionState.value === 'connected';
  async function send() {
    const submitted = draft;
    const files = attachments.files;
    if (
      (!submitted.trim() && !files.length) ||
      inFlight.current ||
      sending ||
      !connected ||
      voiceBusy ||
      attachments.reading
    )
      return;
    inFlight.current = true;
    setSending(true);
    try {
      const images = files.flatMap((file) => (file.kind === 'image' ? [file.image] : []));
      const content = attachmentMessage(submitted, files);
      const accepted = await (images.length ? sendMessage(content, images) : sendMessage(content));
      if (accepted) {
        attachments.remove(files.map((file) => file.id));
        if (currentDraft.current === submitted) onDraft('');
      }
    } finally {
      inFlight.current = false;
      setSending(false);
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
          if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) {
            event.preventDefault();
            void send();
          }
        }}
        rows={2}
        maxLength={16000}
        placeholder="Start anywhere. You don’t need to organize it first."
        class="w-full resize-none bg-transparent text-sm leading-relaxed text-fg placeholder:text-fg-faint focus:outline-none"
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
          class={`min-w-0 items-center justify-center gap-2 text-xs text-fg-muted sm:flex sm:flex-1 ${working || !connected || store.agentState.value.status === 'waiting_for_input' ? 'order-last flex w-full sm:order-none sm:w-auto' : 'hidden'}`}
        >
          {working && (
            <span
              aria-hidden="true"
              class="h-1.5 w-1.5 rounded-full bg-accent motion-safe:animate-pulse"
            />
          )}
          {!connected
            ? 'Reconnecting… your draft stays here.'
            : store.agentState.value.status === 'waiting_for_input'
              ? 'A quick question for you above.'
              : working
                ? 'Neo is thinking…'
                : 'Enter to send · Shift + Enter for a new line'}
        </span>
        <div class="ml-auto flex shrink-0 gap-2">
          <NeoVoice
            sessionId={sessionId}
            connected={connected}
            onTranscript={onTranscript}
            onError={onError}
            onBusy={setVoiceBusy}
          />
          {working && (
            <Button
              variant="ghost"
              size="sm"
              disabled={!connected || interrupting}
              onClick={() => void handleInterrupt()}
              aria-label="Stop Neo"
            >
              <NeoIcon name="pause" />
            </Button>
          )}
          <Button
            type="submit"
            size="sm"
            disabled={
              !connected ||
              sending ||
              (!draft.trim() && !attachments.files.length) ||
              voiceBusy ||
              attachments.reading > 0
            }
            aria-label="Send message"
          >
            <NeoIcon name="up" />
          </Button>
        </div>
      </div>
    </form>
  );
}
