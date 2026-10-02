import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'preact/hooks';
import type { PendingUserQuestion } from '@hyperneo/shared';
import type { NeoWork } from '@hyperneo/shared/types/neo-context';
import { connectionState } from '../lib/state.ts';
import ToastContainer from '../islands/ToastContainer.tsx';
import { Button } from '../components/ui/Button.tsx';
import { HyperNeoMark } from '../components/HyperNeoMark.tsx';
import { useNeo } from './useNeo.ts';
import { NeoIcon, concernColor } from './NeoIcon.tsx';
import { NeoConversation } from './NeoConversation.tsx';
import { NeoComposer } from './NeoComposer.tsx';
import { NeoActivity } from './NeoActivity.tsx';
import { NeoWorkCard, sceneOpenSelector } from './NeoWorkCard.tsx';
import { NeoConsultationCard } from './NeoConsultationCard.tsx';
import { NeoWorkQuestionResource } from './NeoWorkQuestionResource.tsx';
import { NeoConcerns } from './NeoConcerns.tsx';
import { publicationConversationId } from './useNeoPublications.ts';
import { useNeoVoiceRecovery } from './useNeoVoiceRecovery.ts';
import { useNeoDraftReloadRecovery } from './useNeoDraftReloadRecovery.ts';
import { useInputDraft } from '../hooks/useInputDraft.ts';
import { createNeoDraftReloadBuffer } from './neo-draft-reload-buffer.ts';
import { useNeoAttachments } from './neo-attachments.ts';
import { projectNeoConcernBoard } from './neo-concern-board.ts';
import { type NeoSceneRef, projectNeoScenes, selectNeoScene } from './neo-scenes.ts';
import './neo.css';

export function NeoLive() {
  const neo = useNeo();
  const attachments = useNeoAttachments(neo.sessionId);
  const [dragging, setDragging] = useState(false);
  const [narrow, setNarrow] = useState(() => !window.matchMedia('(min-width: 1120px)').matches);
  const dragDepth = useRef(0);
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const inputDraft = useInputDraft(neo.sessionId ?? '', 250, true);
  const reloadBuffer = useRef(createNeoDraftReloadBuffer()).current;
  const scroll = useRef<HTMLElement>(null);
  const mainScroll = useRef<HTMLElement>(null);
  const footer = useRef<HTMLElement>(null);
  const shell = useRef<HTMLDivElement>(null);
  const rail = useRef<HTMLDivElement>(null);
  const nearBottom = useRef(true);
  const lastScrollTop = useRef(0);
  const scrollProgress = useRef(1);
  const concerns = neo.snapshot?.concerns ?? [];
  const selected = concerns.find((item) => item.id === neo.selectedId);
  const works = neo.snapshot?.work ?? [];
  const view = neo.viewSnapshot;
  const viewWorks = view?.work ?? [];
  const relevant = viewWorks.filter((work) => !neo.selectedId || work.concernId === neo.selectedId);
  const publicConversation =
    neo.viewPublicConversation?.conversationId || publicationConversationId(neo.sessionId)
      ? neo.viewPublicConversation
      : undefined;
  const sceneScope =
    neo.sessionId === null ? null : JSON.stringify([neo.sessionId, neo.selectedId]);
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
    projectNeoConcernBoard(view, neo.selectedId, null),
    publicConversation && questions.scope === sceneScope ? questions.values : undefined,
    publicConversation && unavailableSessions.scope === sceneScope
      ? unavailableSessions.values
      : undefined
  );
  const sceneGroups = (
    [
      { key: 'attention', label: 'Needs your attention', scenes: scenes?.attention ?? [] },
      { key: 'running', label: 'In progress', scenes: scenes?.running ?? [] },
      { key: 'outcomes', label: 'Recent outcomes', scenes: scenes?.outcomes ?? [] },
    ] as const
  ).map((group) => ({
    ...group,
    scenes: publicConversation
      ? group.scenes
      : group.scenes.filter((scene) => scene.receipt.kind === 'work'),
  }));
  const workCount = sceneGroups.reduce((total, group) => total + group.scenes.length, 0);
  const sceneListLabel = sceneGroups.some((group) =>
    group.scenes.some((scene) => scene.ref.kind === 'consultation')
  )
    ? 'Neo scenes'
    : 'Work scenes';
  const [sceneSelection, setSceneSelection] = useState<{
    scope: string;
    ref: NeoSceneRef;
  } | null>(null);
  const picked =
    sceneSelection && sceneScope === sceneSelection.scope
      ? selectNeoScene(scenes, sceneSelection.ref)
      : null;
  const detail =
    picked && 'value' in picked && (publicConversation || picked.value.receipt.kind === 'work')
      ? picked.value
      : null;
  const detailWork = detail?.receipt.kind === 'work' ? detail.receipt : null;
  const detailConsultation = detail?.receipt.kind === 'consultation' ? detail.receipt : null;
  const detailLive = detail !== null;
  const mobileDetail = !!publicConversation && narrow && !!detail;
  const displayedGroups = sceneGroups.map((group) => ({
    ...group,
    scenes: publicConversation
      ? group.scenes.filter(
          (scene) => scene.ref.kind !== detail?.ref.kind || scene.ref.id !== detail?.ref.id
        )
      : group.scenes,
  }));
  const detailPane = useRef<HTMLElement>(null);
  const mobileReader = useRef<{ scope: string; top: number } | null>(null);
  const focusScene = useRef<{ ref: NeoSceneRef; scope: string } | null>(null);
  useLayoutEffect(() => {
    const saved = mobileReader.current;
    if (detail || !saved) return;
    mobileReader.current = null;
    if (!narrow || saved.scope !== sceneScope || !mainScroll.current) return;
    mainScroll.current.scrollTop = saved.top;
    lastScrollTop.current = mainScroll.current.scrollTop;
    scrollProgress.current =
      mainScroll.current.scrollTop /
      Math.max(1, mainScroll.current.scrollHeight - mainScroll.current.clientHeight);
  }, [detail, narrow, sceneScope]);
  useLayoutEffect(() => {
    if (sceneSelection && (!sceneScope || !detailLive)) setSceneSelection(null);
  }, [sceneSelection, sceneScope, detailLive]);
  useLayoutEffect(() => {
    if (detail) detailPane.current?.querySelector('button')?.focus({ preventScroll: true });
  }, [detail?.ref.kind, detail?.ref.id]);
  useLayoutEffect(() => {
    const target = focusScene.current;
    if (!target) return;
    focusScene.current = null;
    if (!sceneScope || target.scope !== sceneScope) return;
    const selector =
      target.ref.kind === 'work'
        ? sceneOpenSelector(target.ref.id)
        : `[data-consultation-open="${target.ref.id.replace(/["\\]/g, '\\$&')}"]`;
    document.querySelector<HTMLButtonElement>(selector)?.focus({ preventScroll: true });
  });
  const ready =
    !!neo.sessionId &&
    neo.store.messagesLoaded.value &&
    neo.store.activeSessionId.value === neo.sessionId;
  const draftKey = neo.selectedId === null ? 'root' : `concern:${neo.selectedId}`;
  function writeDraft(text: string) {
    setDrafts((items) => ({ ...items, [draftKey]: text }));
    if (currentScope.current === sceneScope) inputDraft.setContent(text);
  }
  useEffect(() => {
    const cached = drafts[draftKey];
    if (!sceneScope || cached === undefined) return;
    if (inputDraft.isSavedDraft(neo.sessionId ?? '', cached))
      setDrafts((items) => ({ ...items, [draftKey]: '' }));
    else inputDraft.setContent(cached);
  }, [sceneScope]);
  useNeoVoiceRecovery(
    neo.sessionId,
    drafts[draftKey] ?? '',
    () => drafts[draftKey] ?? '',
    writeDraft,
    false
  );
  useNeoDraftReloadRecovery(neo.sessionId, reloadBuffer, () => drafts[draftKey] ?? '', writeDraft);
  const messageCount = publicConversation?.entries.length ?? neo.store.sdkMessages.value.length;
  const lastPublicEntry = publicConversation?.entries.at(-1)?.key;
  const conversationReady =
    ready || (!!publicConversation && neo.store.activeSessionId.value === neo.sessionId);
  const connected = connectionState.value === 'connected';

  useLayoutEffect(() => {
    const selectScroll = () => {
      const desktop = window.matchMedia('(min-width: 1120px)').matches;
      setNarrow(!desktop);
      const previous = scroll.current;
      scroll.current =
        publicConversation && workCount > 0 && desktop ? rail.current : mainScroll.current;
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
  }, [!!publicConversation, workCount > 0]);

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

  function recordScroll(element: HTMLElement) {
    if (mobileDetail) return;
    if (element !== scroll.current) return;
    const atBottom = element.scrollHeight - element.scrollTop - element.clientHeight < 160;
    if (element.scrollTop < lastScrollTop.current - 1 || atBottom) nearBottom.current = atBottom;
    lastScrollTop.current = element.scrollTop;
    scrollProgress.current =
      element.scrollTop / Math.max(1, element.scrollHeight - element.clientHeight);
  }

  useLayoutEffect(() => {
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
  }, [neo.sessionId, ready]);

  useLayoutEffect(() => {
    const element = footer.current;
    if (!element) return;
    const resize = new ResizeObserver(() => {
      shell.current?.style.setProperty('--neo-composer-height', `${element.offsetHeight}px`);
      if (nearBottom.current && scroll.current)
        scroll.current.scrollTop = scroll.current.scrollHeight;
    });
    resize.observe(element);
    if (rail.current) resize.observe(rail.current);
    return () => resize.disconnect();
  }, []);

  useEffect(() => {
    if (mobileDetail) return;
    if (nearBottom.current && scroll.current)
      scroll.current.scrollTop = scroll.current.scrollHeight;
    if (scroll.current)
      scrollProgress.current =
        scroll.current.scrollTop /
        Math.max(1, scroll.current.scrollHeight - scroll.current.clientHeight);
  }, [messageCount, lastPublicEntry, neo.sessionId, workCount]);

  function open(id: string | null) {
    nearBottom.current = true;
    lastScrollTop.current = 0;
    void neo.open(id);
  }

  function openPublicAuthor(sessionId: string) {
    if (sessionId === neo.snapshot?.sessionId) return open(null);
    const binding = neo.snapshot?.publicAuthorBindings?.find(
      (item) => item.kind === 'concern' && item.sessionId === sessionId
    );
    if (binding?.concernId && neo.publicAuthors.has(sessionId)) return open(binding.concernId);
    neo.setError('This context holder is not available in Neo.');
  }

  function retryPublicConversation() {
    neo.asks.retry();
    neo.publications.refresh();
  }

  function openScene(ref: NeoSceneRef) {
    if (!sceneScope) return;
    if (publicConversation && narrow) {
      mobileReader.current = { scope: sceneScope, top: mainScroll.current?.scrollTop ?? 0 };
      nearBottom.current = false;
    }
    setSceneSelection({ scope: sceneScope, ref });
  }

  function closeScene() {
    focusScene.current =
      sceneSelection && sceneScope ? { ref: sceneSelection.ref, scope: sceneScope } : null;
    setSceneSelection(null);
  }

  return (
    <div
      ref={shell}
      class={`neo-shell relative flex flex-col overflow-hidden text-fg${publicConversation ? ' neo-public-layout' : ''}${publicConversation && workCount ? ' neo-has-scenes' : ''}${detail ? ' neo-detail-open' : ''}`}
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
      <header class="neo-float-dock" inert={mobileDetail}>
        <button
          type="button"
          onClick={() => open(null)}
          aria-label="Back to Neo"
          class="neo-float-logo"
        >
          <HyperNeoMark />
        </button>
        <div class="neo-float-actions">
          <NeoConcerns
            concerns={concerns}
            works={works}
            consultations={neo.snapshot?.consultations ?? []}
            selectedId={neo.selectedId}
            onOpen={open}
          />
          <a
            href="/"
            target="_blank"
            rel="noreferrer"
            aria-label="Open HyperNeo"
            title="Open HyperNeo"
            class="neo-float-link"
          >
            <NeoIcon name="external" />
          </a>
        </div>
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
          inert={mobileDetail}
          class="neo-chat-rail px-5 pt-5 sm:px-8"
          onScroll={(event) => recordScroll(event.currentTarget)}
        >
          {selected ? (
            <div class="neo-arrive mb-6">
              <Button
                variant="ghost"
                size="sm"
                class="mb-4 -ml-3"
                onClick={() => open(null)}
                icon={<NeoIcon name="back" />}
              >
                Back to Neo
              </Button>
              <div class="flex items-start gap-3">
                <span class={`rounded-xl p-2 ${concernColor(selected.id)}`}>
                  <NeoIcon name="context" />
                </span>
                <div>
                  <p class="mb-2 text-xs text-fg-muted">One part of your world · 分身</p>
                  <h1 class="break-words text-2xl font-medium tracking-tight">{selected.title}</h1>
                </div>
              </div>
              <p class="mt-4 text-sm leading-relaxed text-fg-muted">{selected.summary}</p>
              <details class="mt-4 rounded-xl border border-line bg-surface p-4 text-sm">
                <summary class="cursor-pointer text-fg-muted">What I’m keeping in mind</summary>
                <p class="mt-3 whitespace-pre-wrap break-words leading-relaxed">
                  {selected.context || 'No saved details yet.'}
                </p>
                <p class="mt-3 text-xs text-fg-faint">
                  Tell Neo if anything here needs correcting. This context holder delegates work; it
                  doesn’t execute it.
                </p>
              </details>
            </div>
          ) : (
            <div class="mb-7">
              <h1 class="text-3xl font-medium leading-tight tracking-tight">
                A little less on your mind.
              </h1>
              <p class="mt-3 max-w-lg text-sm leading-relaxed text-fg-muted">
                Tell me what’s going on. I’ll hold the context, connect the right work, and bring
                back what matters.
              </p>
            </div>
          )}
          {!connected && (
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
              <Button variant="ghost" size="sm" onClick={() => void neo.open(neo.selectedId)}>
                Try again
              </Button>
            </div>
          )}
          {conversationReady && neo.sessionId ? (
            <NeoConversation
              store={neo.store}
              sessionId={neo.sessionId}
              works={relevant}
              snapshot={view}
              publicConversation={publicConversation}
              publicAuthors={neo.publicAuthors}
              onOpenPublicAuthor={openPublicAuthor}
              onOpenPublicWork={(id) => openScene({ kind: 'work', id })}
              publicConsultationIds={
                new Set(
                  sceneGroups.flatMap((group) =>
                    group.scenes.flatMap((scene) =>
                      scene.ref.kind === 'consultation' ? [scene.ref.id] : []
                    )
                  )
                )
              }
              onOpenPublicConsultation={(id) => openScene({ kind: 'consultation', id })}
              onRetryPublic={retryPublicConversation}
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
          {!publicConversation &&
            view?.consultations
              ?.filter(
                (item) =>
                  item.status === 'pending' &&
                  (!neo.selectedId || item.concernId === neo.selectedId)
              )
              .map((item) => (
                <p
                  key={item.id}
                  role="status"
                  class="my-4 rounded-xl border border-accent/20 bg-accent/5 px-4 py-3 text-sm text-fg-muted"
                >
                  Checking with{' '}
                  <button
                    type="button"
                    class="text-accent hover:underline"
                    onClick={() => open(item.concernId)}
                  >
                    {concerns.find((concern) => concern.id === item.concernId)?.title ??
                      'your context holder'}
                  </button>
                  …
                  <button
                    type="button"
                    class="ml-3 text-xs text-fg-muted underline disabled:opacity-50"
                    title="Close this request without interrupting the holder or undoing saved context."
                    disabled={!connected || !!neo.busyWork}
                    onClick={() => void neo.act(item.id, 'stop-waiting')}
                  >
                    {neo.busyWork === item.id ? 'Closing…' : 'Stop waiting'}
                  </button>
                </p>
              ))}
          {ready &&
            (!publicConversation || publicConversation.status === 'ready') &&
            messageCount === 0 &&
            !neo.store.isWorking.value && (
              <div class="rounded-2xl border border-dashed border-accent/25 bg-accent/5 p-5 text-sm leading-relaxed text-fg-muted">
                <span class="mb-3 inline-flex text-accent">
                  <NeoIcon name="spark" />
                </span>
                <p>
                  {selected
                    ? 'The context is already here. Pick up where you left off, or tell me what changed.'
                    : 'No setup, no folders to choose. Ask a quick question or tell me about something ongoing.'}
                </p>
                <p class="mt-2 text-xs">
                  {selected
                    ? 'This conversation stays focused on this part of your world.'
                    : 'Only things worth keeping become a 分身.'}{' '}
                  A clear work request can start work. Proposal-only requests wait for the card’s
                  Start work button.
                </p>
              </div>
            )}
        </div>
        {(publicConversation || detail) && (
          <section
            ref={detailPane}
            aria-label={detailWork ? 'Selected work' : 'Selected context check'}
            aria-hidden={!detail || undefined}
            inert={!detail}
            class={`neo-mobile-detail${detail ? ' neo-scene-detail mt-6 space-y-3' : ''}`}
          >
            {detail && (
              <>
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={closeScene}
                  icon={<NeoIcon name="back" />}
                  aria-label="Back to scenes"
                >
                  Back to scenes
                </Button>
                {detailWork && (
                  <NeoWorkCard
                    key={sceneSelection?.ref.id}
                    work={detailWork}
                    busy={neo.busyWork === detailWork.id}
                    disabled={!connected || !!neo.busyWork}
                    onAction={(id, action) => void neo.act(id, action)}
                    questionSlot={publicConversation ? attachQuestion : undefined}
                  />
                )}
                {detailConsultation && (
                  <NeoConsultationCard
                    consultation={detailConsultation}
                    label={`Context check for ${
                      concerns.find((item) => item.id === detailConsultation.concernId)?.title ??
                      'Your context holder'
                    }`}
                    holderName={
                      concerns.find((item) => item.id === detailConsultation.concernId)?.title ??
                      'Your context holder'
                    }
                    busy={neo.busyWork === detailConsultation.id}
                    disabled={!connected || !!neo.busyWork}
                    onOpenHolder={open}
                    onStopWaiting={(id) => void neo.act(id, 'stop-waiting')}
                  />
                )}
              </>
            )}
          </section>
        )}
        <div class="neo-scene-list" role="region" aria-label={sceneListLabel} inert={mobileDetail}>
          {publicConversation &&
            detail &&
            displayedGroups.every((group) => !group.scenes.length) && (
              <p class="text-sm text-fg-muted">No other scenes right now.</p>
            )}
          {(publicConversation || !detail) &&
            displayedGroups.map((group) =>
              group.scenes.length === 0 ? null : (
                <section
                  key={group.key}
                  aria-label={group.label}
                  class="mt-6 space-y-3"
                  data-scene-group={group.key}
                >
                  <h2 class="text-xs font-medium text-fg-muted">
                    {group.label} · {group.scenes.length}
                  </h2>
                  {group.scenes.map((scene) =>
                    scene.receipt.kind === 'work' ? (
                      <NeoWorkCard
                        key={JSON.stringify(scene.ref)}
                        work={scene.receipt}
                        busy={neo.busyWork === scene.ref.id}
                        disabled={!connected || !!neo.busyWork}
                        onAction={(id, action) => void neo.act(id, action)}
                        onOpen={() => openScene(scene.ref)}
                        presentation={
                          publicConversation && group.key !== 'attention' ? 'summary' : 'detail'
                        }
                        questionSlot={publicConversation ? attachQuestion : undefined}
                      />
                    ) : (
                      <NeoConsultationCard
                        key={JSON.stringify(scene.ref)}
                        consultation={scene.receipt}
                        label={`Context check for ${
                          concerns.find((item) => item.id === scene.receipt.concernId)?.title ??
                          'Your context holder'
                        }`}
                        holderName={
                          concerns.find((item) => item.id === scene.receipt.concernId)?.title ??
                          'Your context holder'
                        }
                        busy={neo.busyWork === scene.ref.id}
                        disabled={!connected || !!neo.busyWork}
                        onOpen={() => openScene(scene.ref)}
                        onOpenHolder={open}
                        onStopWaiting={(id) => void neo.act(id, 'stop-waiting')}
                        presentation={group.key === 'attention' ? 'detail' : 'summary'}
                      />
                    )
                  )}
                </section>
              )
            )}
        </div>
      </main>
      <footer
        ref={footer}
        inert={mobileDetail}
        class="neo-composer-dock pointer-events-none absolute inset-x-0 bottom-0 z-10 pb-3 pt-6"
      >
        <div class="neo-composer-rail px-3 sm:px-8">
          <NeoActivity
            key={sceneScope}
            scenes={scenes?.running ?? []}
            concerns={concerns}
            enabled={connected && conversationReady}
          />
          {ready && neo.sessionId && (
            <NeoComposer
              key={neo.sessionId}
              store={neo.store}
              sessionId={neo.sessionId}
              draft={drafts[draftKey] ?? ''}
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
              onTranscript={(text) =>
                writeDraft([drafts[draftKey], text].filter(Boolean).join('\n'))
              }
              onError={neo.setError}
              onSend={(input) => {
                const submitted = drafts[draftKey] ?? '';
                const captured = reloadBuffer.read(neo.sessionId ?? '');
                return inputDraft.holdDraftAdoption(async () => {
                  const receipt = await neo.send(input);
                  if (receipt.ok) {
                    await inputDraft.clearSubmitted(neo.sessionId ?? '', submitted);
                    if (captured?.text === submitted)
                      reloadBuffer.forget(neo.sessionId ?? '', captured.id);
                    setDrafts((items) =>
                      items[draftKey] === submitted ? { ...items, [draftKey]: '' } : items
                    );
                  }
                  return receipt;
                });
              }}
            />
          )}
          <p class="mt-2 text-center text-[10px] text-fg-faint">
            Neo holds the context. HyperNeo does the work. You stay in control.
          </p>
        </div>
      </footer>
      <ToastContainer />
    </div>
  );
}
