import { useEffect, useLayoutEffect, useRef, useState } from 'preact/hooks';
import { connectionState } from '../lib/state.ts';
import ToastContainer from '../islands/ToastContainer.tsx';
import { Button } from '../components/ui/Button.tsx';
import { useNeo } from './useNeo.ts';
import { NeoIcon, concernColor } from './NeoIcon.tsx';
import { NeoConversation } from './NeoConversation.tsx';
import { NeoComposer } from './NeoComposer.tsx';
import { NeoWorkCard } from './NeoWorkCard.tsx';
import { NeoConcerns } from './NeoConcerns.tsx';
import { useNeoAttachments } from './neo-attachments.ts';
import './neo.css';

export function NeoLive() {
  const neo = useNeo();
  const attachments = useNeoAttachments(neo.sessionId);
  const [dragging, setDragging] = useState(false);
  const dragDepth = useRef(0);
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [showHistory, setShowHistory] = useState(false);
  const scroll = useRef<HTMLElement>(null);
  const footer = useRef<HTMLElement>(null);
  const shell = useRef<HTMLDivElement>(null);
  const rail = useRef<HTMLDivElement>(null);
  const nearBottom = useRef(true);
  const lastScrollTop = useRef(0);
  const concerns = neo.snapshot?.concerns ?? [];
  const selected = concerns.find((item) => item.id === neo.selectedId);
  const works = neo.snapshot?.work ?? [];
  const relevant = works.filter((work) => !neo.selectedId || work.concernId === neo.selectedId);
  const current = relevant.filter((work) => work.status === 'proposed' || work.status === 'queued');
  const history = relevant.filter((work) => work.status !== 'proposed' && work.status !== 'queued');
  const ready =
    !!neo.sessionId &&
    neo.store.messagesLoaded.value &&
    neo.store.activeSessionId.value === neo.sessionId;
  const draftKey = neo.selectedId === null ? 'root' : `concern:${neo.selectedId}`;
  const messageCount = neo.store.sdkMessages.value.length;
  const connected = connectionState.value === 'connected';

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
    if (nearBottom.current && scroll.current)
      scroll.current.scrollTop = scroll.current.scrollHeight;
  }, [messageCount, neo.sessionId, current.length]);

  function open(id: string | null) {
    nearBottom.current = true;
    lastScrollTop.current = 0;
    setShowHistory(false);
    void neo.open(id);
  }

  return (
    <div ref={shell} class="neo-shell relative flex h-dvh flex-col overflow-hidden text-fg">
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
      <header class="z-20 flex w-full shrink-0 items-center justify-between gap-4 px-5 py-4 sm:px-8">
        <button
          type="button"
          onClick={() => open(null)}
          aria-label="Back to Neo"
          class="flex items-center gap-3 rounded-lg text-xl font-semibold tracking-tight focus-visible:outline-accent"
        >
          <span class="neo-mark rounded-2xl bg-accent/10 p-2 text-accent">
            <NeoIcon name="spark" />
          </span>
          neo
          <span class="rounded-full bg-success/10 px-2 py-1 text-[10px] font-medium tracking-normal text-success">
            MVP
          </span>
        </button>
        <div class="flex items-center gap-4">
          <NeoConcerns concerns={concerns} selectedId={neo.selectedId} onOpen={open} />
          <a
            href="/"
            target="_blank"
            rel="noreferrer"
            aria-label="Open HyperNeo"
            title="Open HyperNeo"
            class="inline-flex min-h-9 min-w-9 shrink-0 items-center justify-center gap-2 rounded-lg px-2 text-xs text-fg-muted hover:bg-surface-hover hover:text-fg focus-visible:outline-accent"
          >
            <span class="hidden sm:inline">Open HyperNeo</span>
            <NeoIcon name="external" />
          </a>
        </div>
      </header>
      <main
        ref={scroll}
        onClickCapture={(event) => {
          if (
            (event.target as Element).closest('summary, [aria-controls="neo-conversation-details"]')
          )
            nearBottom.current = false;
        }}
        onScroll={() => {
          const element = scroll.current;
          if (element) {
            const atBottom = element.scrollHeight - element.scrollTop - element.clientHeight < 160;
            if (element.scrollTop < lastScrollTop.current - 1 || atBottom)
              nearBottom.current = atBottom;
            lastScrollTop.current = element.scrollTop;
          }
        }}
        class="neo-scroll min-h-0 w-full flex-1 overflow-y-auto"
      >
        <div ref={rail} class="neo-chat-rail px-5 pt-5 sm:px-8">
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
              <p>Conversation could not be loaded.</p>
              <Button variant="ghost" size="sm" onClick={() => void neo.open(neo.selectedId)}>
                Try again
              </Button>
            </div>
          )}
          {ready && neo.sessionId ? (
            <NeoConversation store={neo.store} sessionId={neo.sessionId} />
          ) : (
            !neo.error && (
              <p role="status" class="py-8 text-sm text-fg-muted">
                Opening your conversation…
              </p>
            )
          )}
          {ready && messageCount === 0 && (
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
                Work starts when you approve its card.
              </p>
            </div>
          )}
          {current.length > 0 && (
            <section aria-label="Delegated work" class="mt-6 space-y-3">
              {current.map((work) => (
                <NeoWorkCard
                  key={work.id}
                  work={work}
                  busy={neo.busyWork === work.id}
                  disabled={!connected || !!neo.busyWork}
                  onAction={(id, action) => void neo.act(id, action)}
                />
              ))}
            </section>
          )}
          {history.length > 0 && (
            <section class="mt-6">
              <button
                type="button"
                aria-expanded={showHistory}
                onClick={() => {
                  nearBottom.current = false;
                  setShowHistory(!showHistory);
                }}
                class="text-sm text-fg-muted hover:text-fg"
              >
                {showHistory ? 'Hide' : 'Show'} recent work · {history.length}
              </button>
              {showHistory && (
                <div class="mt-3 space-y-3">
                  {history.map((work) => (
                    <NeoWorkCard
                      key={work.id}
                      work={work}
                      busy={false}
                      disabled={!connected}
                      onAction={(id, action) => void neo.act(id, action)}
                    />
                  ))}
                </div>
              )}
            </section>
          )}
        </div>
      </main>
      <footer
        ref={footer}
        class="neo-composer-dock pointer-events-none absolute inset-x-0 bottom-0 z-10 pb-3 pt-6"
      >
        <div class="neo-composer-rail px-3 sm:px-8">
          {ready && neo.sessionId && (
            <NeoComposer
              key={neo.sessionId}
              store={neo.store}
              sessionId={neo.sessionId}
              draft={drafts[draftKey] ?? ''}
              onDraft={(value) => setDrafts((items) => ({ ...items, [draftKey]: value }))}
              onTranscript={(text) =>
                setDrafts((items) => ({
                  ...items,
                  [draftKey]: [items[draftKey], text].filter(Boolean).join('\n'),
                }))
              }
              onError={neo.setError}
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
