import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'preact/hooks';
import type { PendingUserQuestion } from '@hyperneo/shared';
import type { NeoWork } from '@hyperneo/shared/types/neo-context';
import { getBannerLevel } from '../components/ConnectionOverlay.tsx';
import { connectionState, reconnectAttemptCount } from '../lib/state.ts';
import ToastContainer from '../islands/ToastContainer.tsx';
import { Button } from '../components/ui/Button.tsx';
import { ScrollToBottomButton } from '../components/ScrollToBottomButton.tsx';
import { useNeo } from './useNeo.ts';
import { NeoIcon } from './NeoIcon.tsx';
import { neoAwaitingReply } from './processing-activity.ts';
import { restoreNeoImages } from './neo-attachments.ts';
import { NeoConversation } from './NeoConversation.tsx';
import { NeoComposer } from './NeoComposer.tsx';
import { NeoActivity } from './NeoActivity.tsx';
import { NeoWorkCard } from './NeoWorkCard.tsx';
import { NeoWorkQuestionResource } from './NeoWorkQuestionResource.tsx';
import { NeoSessionPane } from './NeoSessionPane.tsx';
import { publicationConversationId } from './useNeoPublications.ts';
import { neoWorkSummaries, neoWorkSummary } from './public-conversation.ts';
import { useNeoVoiceRecovery } from './useNeoVoiceRecovery.ts';
import { useNeoSheetSwipe } from './useNeoSheetSwipe.ts';
import { useNeoDraftReloadRecovery } from './useNeoDraftReloadRecovery.ts';
import { useInputDraft } from '../hooks/useInputDraft.ts';
import { createNeoDraftReloadBuffer } from './neo-draft-reload-buffer.ts';
import { useNeoAttachments } from './neo-attachments.ts';
import { projectNeoConcernBoard } from './neo-concern-board.ts';
import { NeoAskCard } from './NeoAskCard.tsx';
import { groupNeoAsks } from './neo-asks.ts';
import {
  NEO_QUICK_CHOICE_LABEL,
  type NeoScene,
  type NeoSceneGroup,
  type NeoSceneRef,
  projectNeoScenes,
} from './neo-scenes.ts';
import '../../../../docs/branding/hyperneo-visual-identity/brand-tokens.css';
import './neo.css';

export function NeoLive() {
  const neo = useNeo();
  const attachments = useNeoAttachments(neo.sessionId);
  const [dragging, setDragging] = useState(false);
  const [narrow, setNarrow] = useState(() => !window.matchMedia('(min-width: 1120px)').matches);
  const [scenesOpen, setScenesOpen] = useState(false);
  const [chat, setChat] = useState<{ sessionId: string; title: string } | null>(null);
  const closeChat = useCallback(() => setChat(null), []);
  const [awayFromBottom, setAwayFromBottom] = useState(false);
  const [replyProgress, setReplyProgress] = useState<string | null>(null);
  const dragDepth = useRef(0);
  const [draft, setDraft] = useState<string | undefined>(undefined);
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
  const concerns = neo.snapshot?.concerns ?? [];
  const view = neo.snapshot;
  const relevant = view?.work ?? [];
  const drivers = new Map((view?.workDrivers ?? []).map((driver) => [driver.workId, driver]));
  const goals = new Map((view?.workGoals ?? []).map((goal) => [goal.workId, goal]));
  const prs = new Map((view?.workPrs ?? []).map((item) => [item.workId, item]));
  const continues = new Map((view?.workContinues ?? []).map((item) => [item.workId, item]));
  const topics = new Map(
    (view?.publicAuthorBindings ?? []).flatMap((binding) => {
      const title = concerns.find((concern) => concern.id === binding.concernId)?.title.trim();
      return title ? [[binding.sessionId, title] as const] : [];
    })
  );
  const publicConversation =
    neo.viewPublicConversation?.conversationId || publicationConversationId(neo.sessionId)
      ? neo.viewPublicConversation
      : undefined;
  const summaries = neoWorkSummaries(publicConversation?.entries);
  const sceneScope = neo.sessionId;
  const loadedScope = useRef<string | null>(null);
  if (publicConversation?.status === 'ready') loadedScope.current = sceneScope;
  const conversationLoaded =
    loadedScope.current === sceneScope && publicConversation?.status !== 'unavailable';
  useEffect(() => setChat(null), [sceneScope]);
  const currentScope = useRef(sceneScope);
  currentScope.current = sceneScope;
  const [questions, setQuestions] = useState<{
    scope: string | null;
    values: ReadonlyMap<string, PendingUserQuestion>;
  }>({ scope: null, values: new Map() });
  const [unavailableSessions, setUnavailableSessions] = useState<{
    scope: string | null;
    values: ReadonlyMap<string, string>;
  }>({ scope: null, values: new Map() });
  const [slots, setSlots] = useState<{
    scope: string | null;
    values: ReadonlyMap<string, HTMLElement>;
  }>({ scope: null, values: new Map() });
  const recordQuestion = useCallback(
    (work: NeoWork, question: PendingUserQuestion | null) => {
      if (currentScope.current !== sceneScope) return;
      setQuestions((prior) => {
        const values = new Map(prior.scope === sceneScope ? prior.values : []);
        if (question === values.get(work.id) || (!question && !values.has(work.id))) return prior;
        if (question) values.set(work.id, question);
        else if (values.get(work.id)?.inputOrigin?.sessionId === work.sessionId)
          values.delete(work.id);
        return { scope: sceneScope, values };
      });
    },
    [sceneScope]
  );
  const attachQuestion = useCallback(
    (id: string, node: HTMLElement | null, previous: HTMLElement | null) => {
      if (currentScope.current !== sceneScope) return;
      setSlots((prior) => {
        const values = new Map(prior.scope === sceneScope ? prior.values : []);
        if (node === values.get(id) || (!node && values.get(id) !== previous)) return prior;
        if (node) values.set(id, node);
        else values.delete(id);
        return { scope: sceneScope, values };
      });
    },
    [sceneScope]
  );
  const recordUnavailable = useCallback(
    (work: NeoWork, unavailable: boolean) => {
      if (currentScope.current !== sceneScope || !work.sessionId) return;
      setUnavailableSessions((prior) => {
        const values = new Map(prior.scope === sceneScope ? prior.values : []);
        if (unavailable) {
          if (values.get(work.id) === work.sessionId) return prior;
          values.set(work.id, work.sessionId!);
        } else {
          if (values.get(work.id) !== work.sessionId) return prior;
          values.delete(work.id);
        }
        return { scope: sceneScope, values };
      });
    },
    [sceneScope]
  );
  const scenes = projectNeoScenes(
    projectNeoConcernBoard(view, null, null),
    publicConversation && questions.scope === sceneScope ? questions.values : undefined,
    publicConversation && unavailableSessions.scope === sceneScope
      ? unavailableSessions.values
      : undefined,
    drivers,
    prs
  );
  const askGroups = groupNeoAsks(view?.asks, scenes);
  const sceneGroups = [
    { key: 'attention', label: 'Needs your attention' },
    { key: 'running', label: 'In progress' },
    { key: 'outcomes', label: 'Recent outcomes' },
  ].map((group) => {
    const key = group.key as NeoSceneGroup;
    return { ...group, key, asks: askGroups.asks[key], scenes: askGroups.loose[key] };
  });
  const workCount = sceneGroups.reduce(
    (total, group) => total + group.asks.length + group.scenes.length,
    0
  );
  const columns = !!publicConversation && (workCount > 0 || !!chat);
  const sheet = !!publicConversation && narrow;
  useNeoSheetSwipe({
    enabled: sheet && workCount > 0 && !chat,
    open: scenesOpen,
    setOpen: setScenesOpen,
    surface: shell,
    sheet: sceneSheet,
  });
  const attention = sceneGroups.find((group) => group.key === 'attention');
  const attentionCount = (attention?.asks.length ?? 0) + (attention?.scenes.length ?? 0);
  const ready =
    !!neo.sessionId &&
    neo.store.messagesLoaded.value &&
    neo.store.activeSessionId.value === neo.sessionId;
  function renderScene(scene: NeoScene, groupKey: NeoSceneGroup) {
    return scene.receipt.kind === 'work' ? (
      <NeoWorkCard
        key={JSON.stringify(scene.ref)}
        work={scene.receipt}
        driver={drivers.get(scene.ref.id)}
        prs={prs.get(scene.ref.id)}
        goal={goals.get(scene.ref.id)}
        continued={continues.get(scene.ref.id)}
        busy={neo.busyWork === scene.ref.id}
        disabled={!connected || !!neo.busyWork}
        onAction={(id, action) => void neo.act(id, action)}
        onOpen={() => openScene(scene.ref)}
        presentation={publicConversation && groupKey !== 'attention' ? 'summary' : 'detail'}
        questionSlot={publicConversation ? attachQuestion : undefined}
        waiting={questions.scope === sceneScope && questions.values.has(scene.ref.id)}
        summary={neoWorkSummary(summaries, scene.receipt)}
      />
    ) : null;
  }
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
    if (entry) element.scrollTop += entry.getBoundingClientRect().top - anchor.top;
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
        neo.setError('Wait for the conversation to load before attaching files.');
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
    if (rail.current) resize.observe(rail.current);
    return () => resize.disconnect();
  }, []);

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

  function open() {
    nearBottom.current = true;
    lastScrollTop.current = 0;
    void neo.open();
  }

  function retryPublicConversation() {
    neo.asks.retry();
    neo.publications.refresh();
  }

  function openScene(ref: NeoSceneRef) {
    const work = relevant.find((item) => item.id === ref.id);
    if (work?.sessionId) setChat({ sessionId: work.sessionId, title: work.title });
  }

  return (
    <div
      ref={shell}
      class={`neo-shell relative flex flex-col overflow-clip text-fg${publicConversation ? ' neo-public-layout' : ''}${columns ? ' neo-has-scenes' : ''}${chat ? ' neo-has-session' : ''}${sheet && scenesOpen ? ' neo-sheet-open' : ''}`}
    >
      {publicConversation &&
        relevant
          .filter((work) => work.status === 'queued' && work.sessionId)
          .map((work) => (
            <NeoWorkQuestionResource
              key={`${sceneScope}:${work.id}:${work.sessionId}`}
              work={work}
              target={slots.scope === sceneScope ? (slots.values.get(work.id) ?? null) : null}
              onQuestion={(_, question) => recordQuestion(work, question)}
              onUnavailable={(_, unavailable) => recordUnavailable(work, unavailable)}
            />
          ))}
      {dragging && (
        <div
          role="status"
          class="pointer-events-none absolute inset-3 z-50 flex items-center justify-center rounded-3xl border-2 border-dashed border-accent bg-surface/95 p-6 text-center"
        >
          <div>
            <NeoIcon name="plus" class="mx-auto mb-3 text-accent" />
            <p class="text-lg font-medium">Drop photos or files here</p>
            <p class="mt-2 text-sm text-fg-muted">
              Added to this conversation. Review before sending.
            </p>
          </div>
        </div>
      )}
      <header class="neo-float-dock">
        <button
          type="button"
          onClick={() => open()}
          aria-label="Back to Neo"
          class="neo-float-link"
        >
          <svg
            viewBox="0 0 102 176"
            class="h-[30px] w-auto"
            style={{ fill: 'light-dark(var(--hn-color-ink), var(--hn-color-paper))' }}
            aria-hidden="true"
          >
            <rect x="0" y="0" width="42" height="176" rx="6" />
            <rect x="60" y="0" width="42" height="79" rx="6" />
            <rect x="60" y="97" width="42" height="79" rx="6" />
          </svg>
        </button>
        {sheet && workCount > 0 && (
          <button
            type="button"
            aria-label={`Your work${attentionCount ? `, ${attentionCount} need your attention` : ''}`}
            aria-expanded={scenesOpen}
            onClick={() => setScenesOpen(true)}
            class="neo-float-link relative"
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
        onScroll={(event) => recordScroll(event.currentTarget)}
        class="neo-scroll min-h-0 w-full flex-1 overflow-y-auto"
      >
        <div
          ref={rail}
          class="neo-chat-rail px-5 pt-5 sm:px-8"
          onScroll={(event) => recordScroll(event.currentTarget)}
        >
          <div class="mb-7">
            <h1 class="text-3xl font-medium leading-tight tracking-tight">
              A little less on your mind.
            </h1>
            <p class="mt-3 max-w-lg text-sm leading-relaxed text-fg-muted">
              Tell me what’s going on. I’ll hold the context, connect the right work, and bring back
              what matters.
            </p>
          </div>
          {firstConnect && (
            <p role="status" class="mb-4 rounded-xl bg-warning/10 p-3 text-sm text-warning">
              Connecting to HyperNeo…
            </p>
          )}
          {neo.error && (
            <div
              role="alert"
              class="mb-5 rounded-xl border border-danger/30 bg-danger/5 p-4 text-sm"
            >
              <p class="break-words text-danger">{neo.error}</p>
              <Button variant="ghost" size="sm" class="mt-2" onClick={neo.retry}>
                Reconnect
              </Button>
              <a href="/" class="ml-3 text-accent" target="_blank" rel="noreferrer">
                HyperNeo settings ↗
              </a>
            </div>
          )}
          {neo.store.loadErrorKind.value && (
            <div role="alert" class="mb-4 text-sm text-danger">
              <p>
                {publicConversation
                  ? 'Native session controls could not be loaded.'
                  : 'Conversation could not be loaded.'}
              </p>
              <Button variant="ghost" size="sm" onClick={() => void neo.open()}>
                Try again
              </Button>
            </div>
          )}
          {conversationReady && neo.sessionId ? (
            <NeoConversation
              store={neo.store}
              sessionId={neo.sessionId}
              works={relevant}
              topics={topics}
              publicConversation={publicConversation}
              onOpenPublicWork={(id) => openScene({ kind: 'work', id })}
              onRetryPublic={retryPublicConversation}
              onProgress={setReplyProgress}
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
                if (!neo.discardSend(requestId)) return;
                acceptedCleanups.delete(requestId);
                writeDraft(failed.text);
              }}
              onLoadEarlierPublic={() => {
                const element = scroll.current;
                const top = element?.getBoundingClientRect().top ?? 0;
                const entry =
                  element &&
                  publicEntryAt(element, (item) => item.getBoundingClientRect().bottom > top);
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
                Opening your conversation…
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
                <p>
                  No setup, no folders to choose. Ask a quick question or tell me about something
                  ongoing.
                </p>
                <p class="mt-2 text-xs">
                  A clear work request can start work. Proposal-only requests wait for the card’s
                  Start work button.
                </p>
              </div>
            )}
        </div>
        <div
          ref={sceneSheet}
          class={`neo-scene-list${sheet ? ` neo-scene-sheet${scenesOpen ? ' is-open' : ''}` : ''}`}
          role="region"
          aria-label="Work scenes"
          aria-hidden={(sheet && !scenesOpen) || chat ? true : undefined}
          inert={(sheet && !scenesOpen) || !!chat}
        >
          {sheet && (
            <div class="sticky top-0 z-10 -mx-5 mb-2 flex items-center justify-between bg-[var(--neo-background)] px-5 py-3">
              <h2 class="text-sm font-medium">Your work</h2>
              <button
                type="button"
                aria-label="Close work list"
                onClick={() => setScenesOpen(false)}
                class="neo-float-link"
              >
                <NeoIcon name="close" />
              </button>
            </div>
          )}
          {sceneGroups.map((group) =>
            group.asks.length + group.scenes.length === 0 ? null : (
              <section
                key={group.key}
                aria-label={group.label}
                class="mt-6 space-y-3"
                data-scene-group={group.key}
              >
                <h2 class="text-xs font-medium text-fg-muted">
                  {group.label} · {group.asks.length + group.scenes.length}
                </h2>
                {group.asks.map((ask) => (
                  <NeoAskCard key={ask.ask.id} view={ask}>
                    {ask.scenes.map((scene) => renderScene(scene, ask.group))}
                  </NeoAskCard>
                ))}
                {group.scenes.map((scene) => renderScene(scene, group.key))}
              </section>
            )
          )}
        </div>
        {chat && (
          <NeoSessionPane
            key={chat.sessionId}
            sessionId={chat.sessionId}
            title={chat.title}
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
          <NeoActivity
            key={sceneScope}
            scenes={scenes?.running ?? []}
            concerns={concerns}
            enabled={connected && conversationReady}
            reply={
              replyProgress ??
              (connected &&
              publicConversation &&
              conversationLoaded &&
              neo.store.agentState.value.status !== 'waiting_for_input' &&
              !neo.store.error.value &&
              !scenes?.attention.some((scene) => scene.label === NEO_QUICK_CHOICE_LABEL) &&
              neoAwaitingReply(publicConversation.entries)
                ? 'Neo is working on a reply…'
                : null)
            }
          />
          {ready && neo.sessionId && (
            <NeoComposer
              key={neo.sessionId}
              store={neo.store}
              sessionId={neo.sessionId}
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
                setDraft('');
                const cleanup = async () => {
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
    </div>
  );
}
