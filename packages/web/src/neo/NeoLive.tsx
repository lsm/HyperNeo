import { workerIdentity } from '@hyperneo/shared/types/worker-identity';
import { NeoGoals } from './NeoGoals.tsx';
import { SessionSchedules } from '../components/SessionSchedules.tsx';
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'preact/hooks';
import { getBannerLevel } from '../components/ConnectionOverlay.tsx';
import { ScrollToBottomButton } from '../components/ScrollToBottomButton.tsx';
import { Button } from '../components/ui/Button.tsx';
import { useInputDraft } from '../hooks/useInputDraft.ts';
import ToastContainer from '../islands/ToastContainer.tsx';
import { blurComposerOnTap } from '../lib/blur-composer-on-tap.ts';
import { connectionManager } from '../lib/connection-manager.ts';
import { connectionState, reconnectAttemptCount } from '../lib/state.ts';
import { readNeoAskImages } from './conversation-ask-client.ts';
import { NeoActivity } from './NeoActivity.tsx';
import { NeoAskTodos } from './NeoAskTodos.tsx';
import { NeoComposer } from './NeoComposer.tsx';
import { NeoConversation } from './NeoConversation.tsx';
import { NeoDrawer } from './NeoDrawer.tsx';
import { NeoIcon } from './NeoIcon.tsx';
import { publicAskText } from './NeoPublicConversation.tsx';
import { NeoSessionPane } from './NeoSessionPane.tsx';
import {
  type NeoAskGroup,
  type NeoDoneTodosPage,
  neoAskEntriesInOrder,
  neoAskEntryGroup,
} from './neo-asks.ts';
import { invokeOperation } from '../lib/operations.ts';
import { restoreNeoImages, useNeoAttachments } from './neo-attachments.ts';
import { createNeoDraftReloadBuffer } from './neo-draft-reload-buffer.ts';
import { neoAwaitingReply, neoBusyWords } from './processing-activity.ts';
import { useNeo } from './useNeo.ts';
import { useNeoDraftReloadRecovery } from './useNeoDraftReloadRecovery.ts';
import { publicationConversationId } from './useNeoPublications.ts';
import { useNeoSheetSwipe } from './useNeoSheetSwipe.ts';
import { useNeoVoiceRecovery } from './useNeoVoiceRecovery.ts';
import '../../../../docs/branding/hyperneo-visual-identity/brand-tokens.css';
import './neo.css';
import type { NeoQuote } from './neo-intake.ts';
import { t } from '../lib/i18n/index.ts';
import { ArtifactPreviewPanel } from '../components/artifacts/ArtifactPreviewPanel.tsx';
import { neoQuestionText } from './todo-status.ts';

export function NeoLive() {
  const neo = useNeo();
  const attachments = useNeoAttachments(neo.sessionId);
  const [dragging, setDragging] = useState(false);
  const [narrow, setNarrow] = useState(() => !window.matchMedia('(min-width: 1120px)').matches);
  const [scenesOpen, setScenesOpen] = useState(false);
  const [chat, setChat] = useState<{ sessionId: string } | null>(null);
  const closeChat = useCallback(() => setChat(null), []);
  const [awayFromBottom, setAwayFromBottom] = useState(false);
  const dragDepth = useRef(0);
  const [draft, setDraft] = useState<string | undefined>(undefined);
  const [quoted, setQuoted] = useState<{
    scope: string;
    quote: NeoQuote;
  } | null>(null);
  const quote = quoted?.scope === neo.sessionId ? quoted.quote : undefined;
  useEffect(() => setQuoted(null), [neo.sessionId]);
  const inputDraft = useInputDraft(neo.sessionId ?? '', 250, true);
  const reloadBuffer = useRef(createNeoDraftReloadBuffer()).current;
  const acceptedCleanups = useRef(new Map<string, () => Promise<void>>()).current;
  const scroll = useRef<HTMLElement>(null);
  const mainScroll = useRef<HTMLElement>(null);
  const footer = useRef<HTMLElement>(null);
  const shell = useRef<HTMLDivElement>(null);
  const rail = useRef<HTMLDivElement>(null);
  const sceneSheet = useRef<HTMLDivElement>(null);
  const nearBottom = useRef(true);
  const lastScrollTop = useRef(0);
  const scrollProgress = useRef(1);
  const view = neo.snapshot;
  const publicConversation =
    neo.viewPublicConversation?.conversationId || publicationConversationId(neo.sessionId)
      ? neo.viewPublicConversation
      : undefined;
  const sceneScope = neo.sessionId;
  const loadedScope = useRef<string | null>(null);
  if (publicConversation?.status === 'ready') loadedScope.current = sceneScope;
  const conversationLoaded =
    loadedScope.current === sceneScope && publicConversation?.status !== 'unavailable';
  useEffect(() => setChat(null), [sceneScope]);
  const currentScope = useRef(sceneScope);
  currentScope.current = sceneScope;
  const replyLabels = new Map(
    (view?.todoAsks ?? []).flatMap((entry) => [
      ...entry.questions.map(
        (question) =>
          [
            `question:${question.id}`,
            { label: neoQuestionText(question), askId: entry.ask.id },
          ] as const
      ),
      ...entry.todos.map(
        (todo) => [`todo:${todo.id}`, { label: todo.title, askId: entry.ask.id }] as const
      ),
    ])
  );
  const sceneGroups = [
    { key: 'attention', label: t('live.group.attention') },
    { key: 'running', label: t('live.group.running') },
    { key: 'outcomes', label: t('live.group.outcomes') },
  ].map((group) => {
    const key = group.key as NeoAskGroup;
    return {
      ...group,
      key,
      entries: neoAskEntriesInOrder(
        (view?.todoAsks ?? []).filter((entry) => neoAskEntryGroup(entry) === key)
      ),
    };
  });
  const workCount = sceneGroups.reduce((total, group) => total + group.entries.length, 0);
  const columns = !!publicConversation;
  const sheet = !!publicConversation && narrow;
  useNeoSheetSwipe({
    enabled: sheet && !chat,
    open: scenesOpen,
    setOpen: setScenesOpen,
    surface: shell,
    sheet: sceneSheet,
  });
  const attention = sceneGroups.find((group) => group.key === 'attention');
  const attentionCount = attention?.entries.length ?? 0;
  const ready =
    !!neo.sessionId &&
    neo.store.messagesLoaded.value &&
    neo.store.activeSessionId.value === neo.sessionId;
  const liveDraft = useRef(draft);
  liveDraft.current = draft;
  const liveSession = useRef(neo.sessionId);
  liveSession.current = neo.sessionId;
  function writeDraft(text: string) {
    setDraft(text);
    if (currentScope.current === sceneScope) inputDraft.setContent(text);
  }
  useEffect(() => {
    if (sceneScope === null || draft === undefined) return;
    if (inputDraft.isSavedDraft(neo.sessionId ?? '', draft)) setDraft('');
    else inputDraft.setContent(draft);
  }, [sceneScope]);
  useNeoVoiceRecovery(neo.sessionId, draft ?? '', () => draft ?? '', writeDraft, false);
  useNeoDraftReloadRecovery(neo.sessionId, reloadBuffer, () => draft ?? '', writeDraft);
  const messageCount = publicConversation?.entries.length ?? neo.store.sdkMessages.value.length;
  const lastPublicEntry = publicConversation?.entries.at(-1)?.key;
  const conversationReady =
    ready || (!!publicConversation && neo.store.activeSessionId.value === neo.sessionId);
  const connected = connectionState.value === 'connected';
  const firstConnect =
    !connected && getBannerLevel(connectionState.value, reconnectAttemptCount.value) === 'hidden';

  useLayoutEffect(() => {
    const selectScroll = () => {
      const desktop = window.matchMedia('(min-width: 1120px)').matches;
      setNarrow(!desktop);
      const previous = scroll.current;
      scroll.current = columns && desktop ? rail.current : mainScroll.current;
      if (nearBottom.current && scroll.current)
        scroll.current.scrollTop = scroll.current.scrollHeight;
      else if (scroll.current && scroll.current !== previous)
        scroll.current.scrollTop =
          scrollProgress.current *
          Math.max(0, scroll.current.scrollHeight - scroll.current.clientHeight);
      lastScrollTop.current = scroll.current?.scrollTop ?? 0;
    };
    selectScroll();
    window.addEventListener('resize', selectScroll);
    return () => window.removeEventListener('resize', selectScroll);
  }, [columns]);

  const earlierAnchor = useRef<{ key: string; top: number } | null>(null);
  const publicEntryAt = (element: HTMLElement, test: (entry: Element) => boolean) =>
    [...element.querySelectorAll('[data-public-entry]')].find(test);
  useLayoutEffect(() => {
    const element = scroll.current;
    const anchor = earlierAnchor.current;
    if (!anchor || !element) return;
    const entry = publicEntryAt(
      element,
      (item) => item.getAttribute('data-public-entry') === anchor.key
    );
    const visibleEntry = entry?.closest('details[data-public-entry]:not([open])') ?? entry;
    if (visibleEntry) element.scrollTop += visibleEntry.getBoundingClientRect().top - anchor.top;
    lastScrollTop.current = element.scrollTop;
    if (publicConversation?.status === 'loading') return;
    earlierAnchor.current = null;
    element.style.overflowAnchor = '';
  }, [publicConversation?.entries.length, publicConversation?.status]);

  const isAtBottom = (element: HTMLElement) =>
    element.scrollHeight - element.scrollTop - element.clientHeight < 160;

  function recordScroll(element: HTMLElement) {
    if (element !== scroll.current) return;
    const atBottom = isAtBottom(element);
    if (element.scrollTop < lastScrollTop.current - 1 || atBottom) nearBottom.current = atBottom;
    setAwayFromBottom(!atBottom);
    lastScrollTop.current = element.scrollTop;
    scrollProgress.current =
      element.scrollTop / Math.max(1, element.scrollHeight - element.clientHeight);
  }

  useLayoutEffect(() => {
    if (chat) {
      dragDepth.current = 0;
      setDragging(false);
      const block = (event: DragEvent) => {
        if (event.dataTransfer?.types.includes('Files')) event.preventDefault();
      };
      window.addEventListener('dragover', block);
      window.addEventListener('drop', block);
      return () => {
        window.removeEventListener('dragover', block);
        window.removeEventListener('drop', block);
      };
    }
    const enter = (event: DragEvent) => {
      if (!event.dataTransfer?.types.includes('Files')) return;
      event.preventDefault();
      dragDepth.current += 1;
      setDragging(true);
    };
    const over = (event: DragEvent) => {
      if (!event.dataTransfer?.types.includes('Files')) return;
      event.preventDefault();
      event.dataTransfer.dropEffect = 'copy';
    };
    const leave = (event: DragEvent) => {
      if (!event.dataTransfer?.types.includes('Files')) return;
      dragDepth.current = Math.max(0, dragDepth.current - 1);
      if (!dragDepth.current) setDragging(false);
    };
    const drop = (event: DragEvent) => {
      const files = Array.from(event.dataTransfer?.files ?? []);
      if (!files.length) return;
      event.preventDefault();
      dragDepth.current = 0;
      setDragging(false);
      if (!ready) {
        neo.setError(t('live.attachWait'));
        return;
      }
      void attachments.add(files, neo.setError);
    };
    window.addEventListener('dragenter', enter);
    window.addEventListener('dragover', over);
    window.addEventListener('dragleave', leave);
    window.addEventListener('drop', drop);
    return () => {
      window.removeEventListener('dragenter', enter);
      window.removeEventListener('dragover', over);
      window.removeEventListener('dragleave', leave);
      window.removeEventListener('drop', drop);
    };
  }, [neo.sessionId, ready, !!chat]);

  useLayoutEffect(() => {
    const element = footer.current;
    if (!element) return;
    const resize = new ResizeObserver(() => {
      shell.current?.style.setProperty('--neo-composer-height', `${element.offsetHeight}px`);
      if (nearBottom.current && scroll.current)
        scroll.current.scrollTop = scroll.current.scrollHeight;
      if (scroll.current) setAwayFromBottom(!isAtBottom(scroll.current));
    });
    resize.observe(element);
    const railElement = rail.current;
    const observeRail = () => {
      if (!railElement) return;
      resize.observe(railElement);
      for (const child of railElement.children) resize.observe(child);
    };
    observeRail();
    const added = new MutationObserver(observeRail);
    if (railElement) added.observe(railElement, { childList: true });
    return () => {
      resize.disconnect();
      added.disconnect();
    };
  }, [columns]);

  useEffect(() => {
    if (nearBottom.current && scroll.current)
      scroll.current.scrollTop = scroll.current.scrollHeight;
    if (scroll.current)
      scrollProgress.current =
        scroll.current.scrollTop /
        Math.max(1, scroll.current.scrollHeight - scroll.current.clientHeight);
  }, [messageCount, lastPublicEntry, neo.sessionId, workCount]);

  function scrollToBottom() {
    const element = scroll.current;
    if (!element) return;
    nearBottom.current = true;
    element.scrollTo({ top: element.scrollHeight, behavior: 'smooth' });
  }

  const [drawerOpen, setDrawerOpen] = useState(false);
  const closeDrawer = useCallback(() => setDrawerOpen(false), []);

  function open() {
    nearBottom.current = true;
    lastScrollTop.current = 0;
    void neo.open();
  }

  function retryPublicConversation() {
    neo.asks.retry();
    neo.publications.refresh();
  }

  return (
    <div
      ref={shell}
      class={`neo-shell relative flex flex-col overflow-clip text-fg${publicConversation ? ' neo-public-layout' : ''}${columns ? ' neo-has-scenes' : ''}${chat ? ' neo-has-session' : ''}${sheet && scenesOpen ? ' neo-sheet-open' : ''}`}
    >
      {dragging && (
        <div
          role="status"
          class="pointer-events-none absolute inset-3 z-50 flex items-center justify-center rounded-3xl border-2 border-dashed border-accent bg-surface/95 p-6 text-center"
        >
          <div>
            <NeoIcon name="plus" class="mx-auto mb-3 text-accent" />
            <p class="text-lg font-medium">{t('live.drop.title')}</p>
            <p class="mt-2 text-sm text-fg-muted">{t('live.drop.hint')}</p>
          </div>
        </div>
      )}
      <NeoDrawer
        open={drawerOpen}
        onClose={closeDrawer}
        connection={connectionState.value}
        onReconnect={() => void connectionManager.reconnect()}
        onRefresh={open}
      />
      <header class="neo-float-dock">
        <button
          type="button"
          onClick={() => setDrawerOpen(true)}
          aria-label={t('live.menu')}
          aria-expanded={drawerOpen}
          aria-haspopup="dialog"
          class="neo-glass-button"
        >
          <svg
            viewBox="0 0 102 176"
            class="h-[30px] w-auto"
            style={{
              fill: 'light-dark(var(--hn-color-ink), var(--hn-color-paper))',
            }}
            aria-hidden="true"
          >
            <rect x="0" y="0" width="42" height="176" rx="6" />
            <rect x="60" y="0" width="42" height="79" rx="6" />
            <rect x="60" y="97" width="42" height="79" rx="6" />
          </svg>
        </button>
        {sheet && (
          <button
            type="button"
            aria-label={
              attentionCount ? t('live.workAttention', { count: attentionCount }) : t('live.work')
            }
            aria-expanded={scenesOpen}
            onClick={() => setScenesOpen(true)}
            class="neo-glass-button relative"
          >
            <NeoIcon name="context" />
            {attentionCount > 0 && (
              <span class="absolute -right-1.5 -top-1.5 min-w-5 rounded-full bg-accent px-1.5 text-center text-[11px] font-medium leading-5 text-accent-fg">
                {attentionCount}
              </span>
            )}
          </button>
        )}
      </header>
      <main
        ref={mainScroll}
        onClickCapture={(event) => {
          if (
            (event.target as Element).closest('summary, [aria-controls="neo-conversation-details"]')
          )
            nearBottom.current = false;
        }}
        onClick={blurComposerOnTap}
        onScroll={(event) => recordScroll(event.currentTarget)}
        class="neo-scroll min-h-0 w-full flex-1 overflow-y-auto"
      >
        <div
          ref={rail}
          class="neo-chat-rail px-5 pt-5 sm:px-8"
          onScroll={(event) => recordScroll(event.currentTarget)}
        >
          <div class="mb-7">
            <h1 class="text-3xl font-medium leading-tight tracking-tight">{t('live.heading')}</h1>
            <p class="mt-3 max-w-lg text-sm leading-relaxed text-fg-muted">{t('live.intro')}</p>
          </div>
          <SessionSchedules sessionId={neo.sessionId} />
          {firstConnect && (
            <p role="status" class="mb-4 rounded-xl bg-warning/10 p-3 text-sm text-warning">
              {t('live.connecting')}
            </p>
          )}
          {neo.error && (
            <div
              role="alert"
              class="mb-5 rounded-xl border border-danger/30 bg-danger/5 p-4 text-sm"
            >
              <p class="break-words text-danger">{neo.error}</p>
              <Button variant="ghost" size="sm" class="mt-2" onClick={neo.retry}>
                {t('live.reconnect')}
              </Button>
              <a href="/" class="ml-3 text-accent" target="_blank" rel="noreferrer">
                {t('live.settingsLink')}
              </a>
            </div>
          )}
          {neo.store.loadErrorKind.value && (
            <div role="alert" class="mb-4 text-sm text-danger">
              <p>{publicConversation ? t('live.controlsFailed') : t('live.conversationFailed')}</p>
              <Button variant="ghost" size="sm" onClick={() => void neo.open()}>
                {t('live.tryAgain')}
              </Button>
            </div>
          )}
          {conversationReady && neo.sessionId ? (
            <NeoConversation
              onQuote={ready ? (quote) => setQuoted({ scope: neo.sessionId!, quote }) : undefined}
              store={neo.store}
              sessionId={neo.sessionId}
              replyLabels={replyLabels}
              publicConversation={publicConversation}
              onOpenWork={(anchor) => {
                setChat(null);
                setScenesOpen(true);
                requestAnimationFrame(() => {
                  const owner = (view?.todoAsks ?? []).find(
                    ({ ask, todos, questions }) =>
                      anchor === `neo-ref-ask-${ask.id}` ||
                      todos.some((todo) => anchor === `neo-ref-todo-${todo.id}`) ||
                      questions.some((question) => anchor === `neo-ref-question-${question.id}`)
                  );
                  const card = owner && document.getElementById(`neo-ref-ask-${owner.ask.id}`);
                  if (!document.getElementById(anchor))
                    card?.querySelector<HTMLButtonElement>('[data-ask-details-toggle]')?.click();
                  requestAnimationFrame(() =>
                    (document.getElementById(anchor) ?? card)?.scrollIntoView({ block: 'center' })
                  );
                });
              }}
              onRetryPublic={retryPublicConversation}
              busy={neoBusyWords(
                neo.snapshot?.working ?? [],
                !!(
                  connected &&
                  publicConversation &&
                  conversationLoaded &&
                  neo.store.agentState.value.status !== 'waiting_for_input' &&
                  !neo.store.error.value &&
                  !view?.todoAsks?.some((entry) =>
                    entry.questions.some((question) => question.state === 'open')
                  ) &&
                  neoAwaitingReply(publicConversation.entries)
                )
              )}
              pendingAsks={neo.pendingAsks}
              onRetryAsk={(requestId) =>
                void neo
                  .retrySend(requestId)
                  ?.then(async (receipt) => {
                    if (!receipt.ok) return;
                    const cleanup = acceptedCleanups.get(requestId);
                    acceptedCleanups.delete(requestId);
                    await cleanup?.();
                  })
                  .catch(() => undefined)
              }
              onEditAsk={(requestId) => {
                const failed = neo.pendingAsks.find((ask) => ask.requestId === requestId);
                if (!failed || !restoreNeoImages(failed.sessionId, failed.images)) {
                  if (failed)
                    neo.setError(
                      'Remove some attachments first: a message can carry up to 6 files, 8 MB in all.'
                    );
                  return;
                }
                const restored = neo.discardSend(requestId);
                if (!restored) return;
                acceptedCleanups.delete(requestId);
                writeDraft(restored.text);
                setQuoted(
                  restored.quote ? { scope: restored.sessionId, quote: restored.quote } : null
                );
              }}
              mute={{
                muted: new Set(view?.mutedSessions ?? []),
                onMute: (key, muted) => void neo.muteSession(key, muted),
              }}
              onEditUndelivered={async (ask) => {
                const sessionId = neo.sessionId;
                if (!sessionId) return false;
                const images = await readNeoAskImages(ask, () => connectionManager.getHub());
                if (liveSession.current !== sessionId) return false;
                if (!images) {
                  neo.setError(t('live.photosFailed'));
                  return false;
                }
                if (!restoreNeoImages(sessionId, images)) {
                  neo.setError(
                    'Remove some attachments first: a message can carry up to 6 files, 8 MB in all.'
                  );
                  return false;
                }
                const text = publicAskText(ask.content);
                writeDraft([liveDraft.current?.trim(), text].filter(Boolean).join('\n\n'));
              }}
              onLoadEarlierPublic={() => {
                const element = scroll.current;
                const top = element?.getBoundingClientRect().top ?? 0;
                const entry =
                  element &&
                  publicEntryAt(
                    element,
                    (item) =>
                      !item.parentElement?.closest('details:not([open])') &&
                      item.getBoundingClientRect().bottom > top
                  );
                if (element && entry) {
                  earlierAnchor.current = {
                    key: entry.getAttribute('data-public-entry') ?? '',
                    top: entry.getBoundingClientRect().top,
                  };
                  element.style.overflowAnchor = 'none';
                }
                neo.asks.loadEarlier();
                neo.publications.loadEarlier();
              }}
            />
          ) : (
            !neo.error && (
              <p role="status" class="py-8 text-sm text-fg-muted">
                {t('live.opening')}
              </p>
            )
          )}
          {ready &&
            (!publicConversation || publicConversation.status === 'ready') &&
            messageCount === 0 &&
            !neo.store.isWorking.value && (
              <div class="rounded-2xl border border-dashed border-accent/25 bg-accent/5 p-5 text-sm leading-relaxed text-fg-muted">
                <span class="mb-3 inline-flex text-accent">
                  <NeoIcon name="spark" />
                </span>
                <p>{t('live.empty')}</p>
                <p class="mt-2 text-xs">{t('live.emptyHint')}</p>
              </div>
            )}
        </div>
        <div
          ref={sceneSheet}
          class={`neo-scene-list${sheet ? ` neo-scene-sheet${scenesOpen ? ' is-open' : ''}` : ''}`}
          role="region"
          aria-label={t('live.scenes')}
          aria-hidden={(sheet && !scenesOpen) || chat ? true : undefined}
          inert={(sheet && !scenesOpen) || !!chat}
        >
          {sheet && (
            <div class="sticky top-0 z-10 -mx-5 mb-2 flex items-center justify-between bg-[var(--neo-background)] px-5 py-3">
              <h2 class="text-sm font-medium">{t('live.work')}</h2>
              <button
                type="button"
                aria-label={t('live.closeWork')}
                onClick={() => setScenesOpen(false)}
                class="neo-float-link"
              >
                <NeoIcon name="close" />
              </button>
            </div>
          )}
          <NeoGoals sessionId={neo.sessionId} />
          {publicConversation && workCount === 0 && (
            <p role="status" class="mt-6 text-sm text-fg-muted">
              {t('live.noWork')}
            </p>
          )}
          {sceneGroups.map((group) =>
            group.entries.length === 0 ? null : (
              <section
                key={group.key}
                aria-label={group.label}
                class="mt-6 space-y-3"
                data-scene-group={group.key}
              >
                <h2 class="text-xs font-medium text-fg-muted">
                  {group.label} · {group.entries.length}
                </h2>
                {group.entries.map((entry) => (
                  <NeoAskTodos
                    key={entry.ask.id}
                    entry={entry}
                    disabled={!connected || !!neo.busyWork}
                    onAnswer={(questionId, answer) => void neo.answerQuestion(questionId, answer)}
                    onReply={
                      ready
                        ? (question) => {
                            setQuoted({
                              scope: neo.sessionId!,
                              quote: {
                                author: 'Neo',
                                text: neoQuestionText(question),
                                anchor: `neo-ref-question-${question.id}`,
                                replyTo: { kind: 'question', id: question.id },
                              },
                            });
                            setScenesOpen(false);
                            scrollToBottom();
                            const input = footer.current?.querySelector('textarea');
                            input?.scrollIntoView({ block: 'nearest' });
                            input?.focus({ preventScroll: true });
                          }
                        : undefined
                    }
                    onSettle={(status) => neo.settleAsk(entry.ask.id, status)}
                    onLoadDone={(askId, offset) =>
                      connectionManager.getHub().then((hub) =>
                        invokeOperation<NeoDoneTodosPage>(hub, 'neo.ask.doneTodos', {
                          askId,
                          offset,
                        })
                      )
                    }
                    onOpen={(link) =>
                      link.startsWith('/session/')
                        ? setChat({ sessionId: link.slice('/session/'.length) })
                        : window.open(link, '_blank', 'noopener')
                    }
                  />
                ))}
              </section>
            )
          )}
        </div>
        {chat && (
          <NeoSessionPane
            key={chat.sessionId}
            sessionId={chat.sessionId}
            title={workerIdentity({ adapter: 'hyperneo', id: chat.sessionId }, null).label}
            overlay={narrow || !publicConversation}
            onClose={closeChat}
          />
        )}
      </main>
      <footer
        ref={footer}
        class="neo-composer-dock pointer-events-none absolute inset-x-0 bottom-0 z-10 pb-3 pt-6"
      >
        <div class="neo-composer-rail relative px-3 sm:px-8">
          {awayFromBottom && (
            <ScrollToBottomButton
              onClick={scrollToBottom}
              bottomClass="bottom-full mb-2 pointer-events-auto"
            />
          )}
          {ready && neo.sessionId && (
            <NeoComposer
              activity={
                <NeoActivity
                  key={sceneScope}
                  snapshot={view ?? null}
                  enabled={connected && conversationReady}
                />
              }
              quote={quote}
              onCancelQuote={() => setQuoted(null)}
              key={neo.sessionId}
              store={neo.store}
              sessionId={neo.sessionId}
              preference={neo.snapshot?.preferences}
              onPreferenceSaved={() => void neo.refresh()}
              draft={draft ?? ''}
              onDraft={(text) => {
                if (
                  !reloadBuffer.remember(
                    neo.sessionId ?? '',
                    text,
                    inputDraft.readSavedDraft(neo.sessionId ?? '')
                  )
                )
                  neo.setError(
                    'This edit could not be backed up for reload. Keep this page open until it is saved.'
                  );
                writeDraft(text);
              }}
              onTranscript={(text) => writeDraft([draft, text].filter(Boolean).join('\n'))}
              onError={neo.setError}
              onSend={(input) => {
                const submitted = draft ?? '';
                const sessionId = neo.sessionId ?? '';
                const captured = reloadBuffer.read(sessionId);
                const submittedQuote = quoted;
                setDraft('');
                const cleanup = async () => {
                  if (input.quote)
                    setQuoted((current) => (current === submittedQuote ? null : current));
                  await inputDraft.clearSubmitted(sessionId, submitted);
                  if (captured?.text === submitted) reloadBuffer.forget(sessionId, captured.id);
                };
                return inputDraft.holdDraftAdoption(async () => {
                  const flight = neo.send(input);
                  const requestId = neo.sendRequestId(input);
                  if (requestId) acceptedCleanups.set(requestId, cleanup);
                  const receipt = await flight;
                  if (receipt.ok) {
                    if (requestId) acceptedCleanups.delete(requestId);
                    await cleanup();
                  }
                  return receipt;
                });
              }}
            />
          )}
        </div>
      </footer>
      <ToastContainer />
      <ArtifactPreviewPanel />
    </div>
  );
}
