import type { ChatMessage } from '@hyperneo/shared';
import { useEffect, useLayoutEffect, useRef, useState } from 'preact/hooks';
import { QuestionPrompt } from '../components/QuestionPrompt.tsx';
import { setupFocusTrap } from '../components/ui/Modal.tsx';
import { t } from '../lib/i18n/index.ts';
import { SessionStore } from '../lib/session-store.ts';
import { NeoBusyRow } from './NeoBusyRow.tsx';
import { NeoIcon } from './NeoIcon.tsx';
import { NeoMessage } from './NeoMessage.tsx';
import { NeoSessionStepsLine, NeoThinkingRow, NeoToolRow } from './NeoSessionSteps.tsx';
import {
  type SessionEntry,
  type SessionItem,
  sessionEntries,
  sessionEntryBlocks,
  sessionItems,
} from './session-transcript.ts';

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
  const opener = useRef(document.activeElement as HTMLElement | null);
  const [store] = useState(() => new SessionStore());
  useEffect(() => {
    void store.select(sessionId);
    return () => {
      store.destroy().catch(() => {});
    };
  }, [store, sessionId]);
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
  const running = store.isWorking.value;
  const entries = sessionEntries(sessionItems(store.sdkMessages.value), running);
  const state = store.agentState.value;
  const question = state.status === 'waiting_for_input' ? state.pendingQuestion : null;
  const last = entries[entries.length - 1];
  const showsRunningSteps = last?.type === 'steps' && last.steps.running;
  const error = store.error.value?.message;
  const content = useRef<HTMLDivElement>(null);
  const pinned = useRef(true);
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
        <h2 class="min-w-0 truncate text-sm font-medium text-fg">{title}</h2>
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
          {!store.messagesLoaded.value && !error && (
            <p class="pt-8 text-center text-sm text-fg-muted">{t('session.opening')}</p>
          )}
          {sessionEntryBlocks(entries).map((block) => (
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
    </aside>
  );
}
