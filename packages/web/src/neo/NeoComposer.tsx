import './neo-composer.css';
import { useCallback, useLayoutEffect, useRef, useState } from 'preact/hooks';
import { Button } from '../components/ui/Button.tsx';
import { connectionManager } from '../lib/connection-manager.ts';
import { t } from '../lib/i18n/index.ts';
import type { SessionStore } from '../lib/session-store.ts';
import { connectionState } from '../lib/state.ts';
import {
  combineVoiceSubmission,
  submitVoiceSendIntent,
  type VoiceSendOutcome,
} from '../lib/voice/voice-audio-outbox.ts';
import { getVoiceRecord, type VoiceRecordEntry } from '../lib/voice/voice-audio-store.ts';
import { NeoAttachments } from './NeoAttachments.tsx';
import { NeoIcon } from './NeoIcon.tsx';
import { type NeoPreference, NeoPreferences } from './NeoPreferences.tsx';
import { NeoQuoteBar } from './NeoQuoteBar.tsx';
import { NeoVoice, type VoicePhase } from './NeoVoice.tsx';
import { attachmentMessage, NEO_FILE_ACCEPT, useNeoAttachments } from './neo-attachments.ts';
import { type createNeoIntakeClient, type NeoQuote, neoQuoteExcerpt } from './neo-intake.ts';
import { useCoarsePointer } from './useCoarsePointer.ts';
import { VoiceDraftPreview } from '../components/voice/VoiceDraftPreview.tsx';
import type { NeoPreviewReference } from '@hyperneo/shared/types/neo-preview-context';

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
  preference,
  onPreferenceSaved,
  quote,
  onCancelQuote,
  forSession,
  onStop,
  previewContext,
  onCancelPreview,
  previewCandidate,
  onRebindPreview,
  onPreviewCapture,
}: {
  previewContext?: NeoPreviewReference;
  onCancelPreview?: () => void;
  previewCandidate?: NeoPreviewReference;
  onRebindPreview?: () => void;
  onPreviewCapture?: () => void;
  forSession?: boolean;
  onStop?: () => void;
  preference?: NeoPreference;
  quote?: NeoQuote;
  onCancelQuote?: () => void;
  onPreferenceSaved?: () => void;
  store: SessionStore;
  sessionId: string;
  draft: string;
  onDraft: (value: string) => void;
  onError: (message: string) => void;
  onTranscript: (text: string) => void;
  onSend: ReturnType<typeof createNeoIntakeClient>['send'];
}) {
  const idSuffix = forSession ? '-session' : '';
  const [sending, setSending] = useState(false);
  const [focused, setFocused] = useState(false);
  const coarsePointer = useCoarsePointer();
  const [voicePhase, setVoicePhase] = useState<VoicePhase>('idle');
  const [interim, setInterim] = useState('');
  const voiceBusy = voicePhase !== 'idle';
  const recordingVoice = voicePhase === 'recording';
  const listening = recordingVoice || voicePhase === 'working';
  const attachments = useNeoAttachments(sessionId);
  const hasAttachments = attachments.files.length > 0 || attachments.reading > 0;
  const boundPreview = forSession ? undefined : previewContext;
  const currentPreview = useRef(boundPreview);
  currentPreview.current = boundPreview;
  const needsDraft = hasAttachments || !!quote || !!boundPreview;
  const draftContext = t(
    boundPreview
      ? 'composer.previewContext'
      : quote
        ? 'composer.quoteContext'
        : 'composer.attachmentsContext'
  );
  const voiceStatus = recordingVoice
    ? needsDraft
      ? t('composer.recordingDraft', { context: draftContext })
      : t(coarsePointer ? 'composer.recordingTap' : 'composer.recordingClick')
    : voicePhase === 'drafting'
      ? t('composer.transcribing')
      : voicePhase === 'sending' && draft.trim()
        ? t('composer.sendingDraft')
        : null;
  const quoteAuthor = quote?.author === 'You' ? t('chat.you') : 'Neo';
  const thought = useRef<HTMLTextAreaElement>(null);
  useLayoutEffect(() => {
    if (quote) thought.current?.focus();
  }, [quote]);
  const wasVoiceBusy = useRef(false);
  const idleHeight = useRef(0);
  useLayoutEffect(() => {
    const el = thought.current;
    if (el) {
      const line = Number.parseFloat(getComputedStyle(el).lineHeight) || 26;
      el.style.height = 'auto';
      const full = el.scrollHeight;
      const height = Math.min(Math.max(full, line * (focused ? 2 : 1)), line * (focused ? 8 : 1));
      el.style.height = `${height}px`;
      el.style.overflowY = focused && full > line * 8 ? 'auto' : 'hidden';
      idleHeight.current = height;
      if (wasVoiceBusy.current && !coarsePointer) {
        el.focus();
        el.setSelectionRange(el.value.length, el.value.length);
      }
    }
    wasVoiceBusy.current = voiceBusy;
  }, [voiceBusy, coarsePointer, draft, focused]);
  const finishVoice = useRef<((intent: 'draft' | 'send') => void) | null>(null);
  const registerFinishVoice = useCallback((finish: ((intent: 'draft' | 'send') => void) | null) => {
    finishVoice.current = finish;
  }, []);
  const fileInput = useRef<HTMLInputElement>(null);
  const inFlight = useRef(false);
  const sendingText = useRef<string | null>(null);
  const alive = useRef(true);
  const currentSession = useRef(sessionId);
  currentSession.current = sessionId;
  const currentDraft = useRef(draft);
  currentDraft.current = draft;
  const currentQuote = useRef(quote);
  currentQuote.current = quote;
  useLayoutEffect(
    () => () => {
      alive.current = false;
    },
    []
  );
  const connected = connectionState.value === 'connected';
  async function send() {
    if (recordingVoice) {
      if (!needsDraft) {
        finishVoice.current?.('send');
        return;
      }
      finishVoice.current?.('draft');
      onError(
        t(coarsePointer ? 'composer.addedTap' : 'composer.addedClick', { context: draftContext })
      );
      return;
    }
    const submitted = draft;
    const files = attachments.files;
    if (!submitted.trim() && !files.length) return;
    if (voiceBusy) return;
    if (!connected) {
      onError(t('composer.reconnecting'));
      return;
    }
    if (attachments.reading) {
      onError(t('composer.stillReading'));
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
      await onSend({
        sessionId,
        text: content,
        images,
        ...(quote ? { quote } : {}),
        ...(boundPreview ? { previewContext: boundPreview } : {}),
      }).catch(() => undefined);
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
    if (
      record.sendText === undefined &&
      (hasAttachments || quote || (record.intent !== 'send' && boundPreview))
    )
      return { kind: 'unconfirmed' };
    const composed =
      record.sendText ?? combineVoiceSubmission(record.sendDraft ?? draft, transcript);
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
      if (
        outcome.kind === 'accepted' &&
        alive.current &&
        currentSession.current === sessionId &&
        currentDraft.current === draft &&
        draft === record.sendDraft &&
        (!currentPreview.current ||
          (currentPreview.current.artifactId === record.previewContext?.artifactId &&
            currentPreview.current.snapshot === record.previewContext?.snapshot)) &&
        !currentQuote.current
      )
        onDraft('');
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
      onFocusOut={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setFocused(false);
      }}
      class={`neo-composer-input ${focused ? 'is-focused' : 'is-collapsed'} ${voiceBusy ? 'is-recording' : ''} pointer-events-auto relative rounded-3xl border border-line-strong bg-surface-raised/95 p-4 shadow-xl backdrop-blur-xl transition-colors focus-within:border-accent/60`}
    >
      {boundPreview && (
        <div class="mb-2 flex min-w-0 items-center gap-2 text-xs text-fg-muted">
          <span role="status" class="min-w-0 flex-1 break-words">
            {t(
              boundPreview.state === 'available'
                ? 'composer.previewBinding'
                : 'composer.previewUnavailable',
              { file: boundPreview.displayName, snapshot: boundPreview.snapshot.slice(0, 8) }
            )}
          </span>
          <button
            type="button"
            aria-label={t('composer.removePreview')}
            class="shrink-0 rounded-full p-2 hover:bg-fill-soft hover:text-fg"
            onClick={onCancelPreview}
          >
            <NeoIcon name="close" class="!h-3 !w-3" />
          </button>
        </div>
      )}
      {!forSession &&
        previewCandidate &&
        (previewCandidate.artifactId !== boundPreview?.artifactId ||
          previewCandidate.snapshot !== boundPreview?.snapshot) && (
          <button
            type="button"
            class="mb-2 text-xs text-accent hover:underline"
            onClick={onRebindPreview}
          >
            {t('composer.usePreview')}
          </button>
        )}
      {quote && (
        <div
          role="region"
          aria-label={t('composer.replyingToExcerpt', {
            author: quoteAuthor,
            excerpt: neoQuoteExcerpt(quote.text),
          })}
        >
          <NeoQuoteBar
            author={quote.author}
            excerpt={neoQuoteExcerpt(quote.text)}
            labelId={`neo-quote-label${idSuffix}`}
          >
            <button
              type="button"
              aria-label={t('composer.removeReply')}
              title={t('composer.removeReplyTitle')}
              class="p-2 text-fg-muted hover:text-fg focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
              onClick={() => {
                onCancelQuote?.();
                thought.current?.focus();
              }}
            >
              <NeoIcon name="close" class="!h-3 !w-3" />
            </button>
          </NeoQuoteBar>
        </div>
      )}
      {attachments.files.length > 0 && (
        <NeoAttachments files={attachments.files} onRemove={attachments.remove} />
      )}
      {attachments.reading > 0 && (
        <p role="status" class="mb-2 text-xs text-fg-muted">
          {t('composer.reading')}
        </p>
      )}
      <input
        ref={fileInput}
        type="file"
        multiple
        accept={NEO_FILE_ACCEPT}
        aria-label={t('composer.attach')}
        class="hidden"
        onChange={(event) => {
          const files = Array.from(event.currentTarget.files ?? []);
          event.currentTarget.value = '';
          void attachments.add(files, onError);
        }}
      />
      {voiceBusy ? (
        <VoiceDraftPreview
          text={draft}
          start={draft.length}
          end={draft.length}
          transcribing={voicePhase === 'sending' || voicePhase === 'drafting'}
          interim={interim}
          newLine
          hint={listening ? t('composer.listening') : undefined}
          heightPx={idleHeight.current || undefined}
          class="neo-composer-draft text-base leading-relaxed text-fg-muted"
        />
      ) : (
        <textarea
          ref={thought}
          id={`neo-thought${idSuffix}`}
          aria-label={forSession ? t('session.message') : t('composer.message')}
          aria-describedby={quote ? `neo-quote-label${idSuffix}` : undefined}
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
            if (event.key === 'Escape' && quote && !event.isComposing && event.keyCode !== 229) {
              event.preventDefault();
              onCancelQuote?.();
              return;
            }
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
          onFocus={() => setFocused(true)}
          rows={focused ? 2 : 1}
          maxLength={16000}
          placeholder={t(coarsePointer ? 'composer.placeholderTouch' : 'composer.placeholderKeys')}
          class="w-full resize-none bg-transparent text-base leading-relaxed text-fg placeholder:text-fg-faint focus:outline-none"
        />
      )}
      <div class="neo-composer-toolbar mt-2 flex flex-wrap items-center justify-between gap-2">
        <div class="neo-composer-tools min-w-0 items-center gap-1 flex">
          <button
            type="button"
            aria-label={t('composer.attach')}
            title={t('composer.attachTitle')}
            disabled={voiceBusy}
            onClick={() => fileInput.current?.click()}
            class="rounded-full p-2 text-fg-muted hover:bg-fill-soft hover:text-accent"
          >
            <NeoIcon name="plus" />
          </button>
          <div class="neo-composer-preferences">
            <NeoPreferences
              sessionId={sessionId}
              store={store}
              onError={onError}
              preference={preference}
              onSaved={onPreferenceSaved}
              forSession={forSession}
            />
          </div>
        </div>
        <span
          role="status"
          class={`neo-composer-status min-w-0 items-center justify-center gap-2 text-xs text-fg-muted ${
            voiceBusy
              ? voiceStatus
                ? 'order-last flex w-full'
                : 'hidden'
              : store.error.value || store.agentState.value.status === 'waiting_for_input'
                ? 'order-last flex w-full sm:order-none sm:w-auto sm:flex-1'
                : 'hidden'
          }`}
        >
          {voiceBusy
            ? voiceStatus
            : store.error.value
              ? t('chat.notice.needs_you')
              : store.agentState.value.status === 'waiting_for_input'
                ? t('composer.question')
                : null}
        </span>
        <div class="neo-composer-actions flex min-w-0 items-center gap-4 ml-auto">
          <NeoVoice
            door={forSession ? 'session' : undefined}
            previewContext={boundPreview}
            onPreviewCapture={onPreviewCapture}
            sessionId={sessionId}
            connected={connected}
            draftText={draft}
            onTranscript={onTranscript}
            onInterim={setInterim}
            onSendVoice={async (text, recordId) => {
              const record = await getVoiceRecord(recordId);
              if (!record) return { kind: 'unconfirmed' } as const;
              return sendVoice(record, text);
            }}
            onSendHandle={registerFinishVoice}
            onError={onError}
            onPhase={setVoicePhase}
          />
          {onStop && store.isWorking.value && !voiceBusy && (
            <button
              type="button"
              aria-label={t('composer.stop')}
              title={t('composer.stop')}
              onClick={onStop}
              class="inline-flex h-9 w-9 items-center justify-center rounded-full border border-line text-fg-muted hover:border-accent/40 hover:text-fg"
            >
              <NeoIcon name="stop" class="!h-3.5 !w-3.5" />
            </button>
          )}
          <Button
            type="submit"
            size="sm"
            class="h-11 min-w-11 shrink-0"
            aria-label={t(
              recordingVoice && needsDraft
                ? 'composer.stopDraft'
                : recordingVoice
                  ? 'composer.stopSend'
                  : 'composer.send'
            )}
            title={
              recordingVoice && needsDraft
                ? t('composer.stopDraftTitle', { context: draftContext })
                : recordingVoice
                  ? t('composer.stopSendTitle')
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
