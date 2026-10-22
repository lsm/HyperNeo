import type { ChatMessage } from '@hyperneo/shared';
import { useEffect, useLayoutEffect, useRef, useState } from 'preact/hooks';
import { QuestionPrompt } from '../components/QuestionPrompt.tsx';
import { setupFocusTrap } from '../components/ui/Modal.tsx';
import { t } from '../lib/i18n/index.ts';
import { useInputDraft } from '../hooks/useInputDraft.ts';
import { useInterrupt } from '../hooks/useInterrupt.ts';
import { connectionManager } from '../lib/connection-manager.ts';
import { SessionStore } from '../lib/session-store.ts';
import type { MessageImage } from '@hyperneo/shared';
import { NeoComposer } from './NeoComposer.tsx';
import { restoreNeoImages } from './neo-attachments.ts';
import { NeoBusyRow } from './NeoBusyRow.tsx';
import { NeoIcon } from './NeoIcon.tsx';
import { NeoMessage } from './NeoMessage.tsx';
import { NeoSessionStepsLine, NeoThinkingRow, NeoToolRow } from './NeoSessionSteps.tsx';
import {
  type SessionEntry,
  type SessionItem,
  projectSessionTranscript,
} from './session-transcript.ts';

async function sendToSession(sessionId: string, content: string, images?: readonly MessageImage[]) {
  const hub = connectionManager.getHubIfConnected();
  if (!hub) throw new Error(t('composer.reconnecting'));
  const result = await hub.request<{ messageId?: string }>('message.send', {
    sessionId,
    content,
    ...(images?.length ? { images } : {}),
  });
  return result?.messageId ?? '';
}

function SessionItemView({ item }: { item: SessionItem }) {
  const { kind } = item;
  if (kind.type === 'tool') return <NeoToolRow {...kind} />;
  if (kind.type === 'thinking') return <NeoThinkingRow text={kind.text} />;
  const message = {
    type: kind.type,
    uuid: item.id,
    timestamp: item.date,
    message: { role: kind.type, content: item.images },
  } as unknown as ChatMessage;
  return (
    <NeoMessage
      message={message}
      text={kind.text}
      author={kind.type === 'user' ? t('chat.you') : t('session.assistant')}
    />
  );
}

function SessionEntryView({ entry }: { entry: SessionEntry }) {
  if (entry.type === 'item') return <SessionItemView item={entry.item} />;
  return (
    <NeoSessionStepsLine
      steps={entry.steps}
      renderStep={(item) => <SessionItemView item={item} />}
    />
  );
}

export function NeoSessionPane({
  sessionId,
  title,
  overlay,
  onClose,
}: {
  sessionId: string;
  title: string;
  overlay: boolean;
  onClose: () => void;
}) {
  const pane = useRef<HTMLElement>(null);
  const scroller = useRef<HTMLDivElement>(null);
  const content = useRef<HTMLDivElement>(null);
  const pinned = useRef(true);
  const opener = useRef(document.activeElement as HTMLElement | null);
  const [store] = useState(() => new SessionStore());
  useEffect(() => {
    void store.select(sessionId);
  }, [store, sessionId]);
  useEffect(
    () => () => {
      store.destroy().catch(() => {});
    },
    [store]
  );
  useEffect(() => {
    pane.current?.focus();
    const target = opener.current;
    return () => {
      setTimeout(() => target?.focus?.(), 0);
    };
  }, []);
  useEffect(() => {
    if (!overlay || !pane.current) return;
    const release = setupFocusTrap(pane.current);
    if (!pane.current.contains(document.activeElement)) pane.current.focus();
    return release;
  }, [overlay]);
  const inputDraft = useInputDraft(sessionId, 250, true);
  const { handleInterrupt } = useInterrupt({ sessionId });
  const [notice, setNotice] = useState('');
  const running = store.isWorking.value;
  const messages = store.sdkMessages.value;
  const blocks = projectSessionTranscript(messages, running, sessionId.startsWith('neo:'));
  const [loadingOlder, setLoadingOlder] = useState(false);
  const [slow, setSlow] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const [olderFailed, setOlderFailed] = useState(false);
  const loaded = store.messagesLoaded.value;
  useEffect(() => {
    setSlow(false);
    if (loaded) return;
    const timer = window.setTimeout(() => setSlow(true), 15_000);
    return () => window.clearTimeout(timer);
  }, [loaded, attempt]);
  async function loadOlder() {
    const oldest = messages[0] as { timestamp?: number; rowid?: number } | undefined;
    if (loadingOlder || typeof oldest?.timestamp !== 'number') return;
    setLoadingOlder(true);
    const el = scroller.current;
    const fromBottom = el ? el.scrollHeight - el.scrollTop : 0;
    pinned.current = false;
    setOlderFailed(false);
    try {
      const older = await store.loadOlderMessages(oldest.timestamp, 100, sessionId, oldest.rowid);
      if (older.messages.length) store.prependMessages(older.messages);
      requestAnimationFrame(() => {
        if (el) el.scrollTop = el.scrollHeight - fromBottom;
      });
    } catch {
      setOlderFailed(true);
    } finally {
      setLoadingOlder(false);
    }
  }
  const state = store.agentState.value;
  const question = state.status === 'waiting_for_input' ? state.pendingQuestion : null;
  const last = blocks.at(-1)?.at(-1);
  const showsRunningSteps = last?.type === 'steps' && last.steps.running;
  const error = notice || store.error.value?.message;
  useLayoutEffect(() => {
    const el = scroller.current;
    if (el) el.scrollTop = el.scrollHeight;
    pinned.current = true;
  }, [last?.id, question?.toolUseId]);
  useEffect(() => {
    const el = scroller.current;
    if (!el || !content.current || typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(() => {
      if (pinned.current) el.scrollTop = el.scrollHeight;
    });
    observer.observe(content.current);
    return () => observer.disconnect();
  }, []);
  return (
    <aside
      ref={pane}
      tabIndex={-1}
      role={overlay ? 'dialog' : undefined}
      aria-modal={overlay ? true : undefined}
      class="neo-session-pane flex flex-col outline-none"
      aria-label={t('session.chat', { title })}
    >
      <header class="flex shrink-0 items-center gap-3 border-b border-line px-3 py-2">
        <button
          type="button"
          onClick={onClose}
          aria-label={t('session.back')}
          class="inline-flex h-10 w-10 shrink-0 items-center justify-center rounded-full text-fg hover:bg-fill-soft"
        >
          <NeoIcon name="back" />
        </button>
        <h2 class="min-w-0 truncate text-sm font-medium text-fg">
          {store.sessionState.value?.worker?.label ?? title}
        </h2>
      </header>
      <div
        ref={scroller}
        class="min-h-0 flex-1 overflow-y-auto"
        onScroll={(event) => {
          const el = event.currentTarget;
          pinned.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
        }}
      >
        <div
          ref={content}
          class="mx-auto flex min-h-full w-full max-w-3xl flex-col justify-end gap-5 p-5"
        >
          {!loaded && !error && !store.loadErrorKind.value && !slow && (
            <p class="pt-8 text-center text-sm text-fg-muted">{t('session.opening')}</p>
          )}
          {loaded && store.hasMoreMessages.value && (
            <button
              type="button"
              disabled={loadingOlder}
              onClick={() => void loadOlder()}
              class="self-center rounded-full border border-line px-3 py-1.5 text-xs text-fg-muted hover:text-fg disabled:opacity-60"
            >
              {t(olderFailed ? 'session.loadEarlierFailed' : 'session.loadEarlier')}
            </button>
          )}
          {!loaded && (store.loadErrorKind.value || slow) && (
            <div role="alert" class="flex flex-col items-center gap-2 text-sm text-fg-muted">
              <p>{t('session.loadFailed')}</p>
              <button
                type="button"
                onClick={() => {
                  setAttempt(attempt + 1);
                  void store.select(null).then(() => store.select(sessionId));
                }}
                class="rounded-full border border-line px-3 py-1.5 text-xs text-accent hover:border-accent/40"
              >
                {t('chat.retry')}
              </button>
            </div>
          )}
          {blocks.map((block) => (
            <div key={block[0].id} class="flex flex-col gap-1.5">
              {block.map((entry) => (
                <SessionEntryView key={entry.id} entry={entry} />
              ))}
            </div>
          ))}
          {question && (
            <div class="rounded-2xl border border-accent/40 bg-surface p-4">
              <QuestionPrompt
                skin="neo"
                key={`${sessionId}:${question.toolUseId}`}
                sessionId={sessionId}
                pendingQuestion={question}
                onResolved={() => void store.refresh()}
              />
            </div>
          )}
          {running && !showsRunningSteps && <NeoBusyRow words={[t('session.working')]} />}
          {error && (
            <p role="alert" class="text-sm text-danger">
              {error}
            </p>
          )}
        </div>
      </div>
      <footer class="mx-auto w-full max-w-3xl shrink-0 px-3 pt-2 pb-3">
        <NeoComposer
          store={store}
          sessionId={sessionId}
          forSession
          draft={inputDraft.content}
          onDraft={inputDraft.setContent}
          onError={setNotice}
          onTranscript={(text) =>
            inputDraft.setContent([inputDraft.content, text].filter(Boolean).join('\n'))
          }
          onStop={() => void handleInterrupt()}
          onSend={({ text, images }) =>
            inputDraft.holdDraftAdoption(async () => {
              const submitted = inputDraft.content;
              inputDraft.setContent('');
              try {
                const messageId = await sendToSession(sessionId, text, images);
                await inputDraft.clearSubmitted(sessionId, submitted);
                return { ok: true as const, requestId: messageId, messageId, created: true };
              } catch (cause) {
                const reason = cause instanceof Error ? cause.message : String(cause);
                const kept = restoreNeoImages(sessionId, images ?? []);
                setNotice(kept ? reason : `${reason} ${t('session.attachmentsLost')}`);
                if (!inputDraft.content) inputDraft.setContent(text);
                return { ok: false as const, reason };
              }
            })
          }
        />
      </footer>
    </aside>
  );
}
