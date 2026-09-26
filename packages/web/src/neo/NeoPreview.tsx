import { useEffect, useRef, useState } from 'preact/hooks';
import { Button } from '../components/ui/Button.tsx';
import { previewConcerns } from './preview-concerns.ts';

export function NeoPreview() {
  const [concerns, setConcerns] = useState(previewConcerns);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [decision, setDecision] = useState<string | null>(null);
  const [notice, setNotice] = useState('');
  const heading = useRef<HTMLHeadingElement>(null);
  const selected = concerns.find((concern) => concern.id === selectedId);
  const draftKey = selected?.id ?? 'neo';
  const draft = drafts[draftKey] ?? '';

  useEffect(() => {
    heading.current?.focus();
  }, [selectedId]);

  function openConcern(id: string | null) {
    setSelectedId(id);
    setNotice('');
  }

  function addContext() {
    const text = draft.trim();
    if (!text) return;
    if (selected) {
      setConcerns((items) =>
        items.map((item) =>
          item.id === selected.id ? { ...item, context: [...item.context, text] } : item
        )
      );
      setNotice('Added to this concern in the preview. No work was started.');
    } else {
      const id = crypto.randomUUID();
      setConcerns((items) => [
        ...items,
        {
          id,
          title: text,
          summary:
            'A new thought, held here for now. Live routing is not connected in this preview.',
          context: [text],
          sources: [],
        },
      ]);
      setSelectedId(id);
      setNotice('Held in this preview only. Neo has not delegated any work.');
    }
    setDrafts((items) => ({ ...items, [draftKey]: '' }));
  }

  function chooseTiming(value: string) {
    setDecision(value);
    setConcerns((items) =>
      items.map((item) =>
        item.id === 'launch'
          ? { ...item, context: [...item.context, `Preview decision: ${value}`] }
          : item
      )
    );
    setNotice('Decision recorded in this preview. No schedule or task was changed.');
  }

  return (
    <div class="flex h-dvh flex-col bg-bg text-fg">
      <header class="mx-auto flex w-full max-w-5xl shrink-0 items-center justify-between gap-4 px-5 py-4 sm:px-10">
        <span class="flex items-center gap-3 text-xl font-semibold tracking-tight">
          <span
            aria-hidden="true"
            class="h-3 w-3 rounded-full bg-accent shadow-[0_0_24px_var(--accent)]"
          />
          neo
        </span>
        <a href="/" class="text-sm text-fg-muted underline-offset-4 hover:underline">
          Open HyperNeo ↗
        </a>
      </header>
      <main class="mx-auto min-h-0 w-full max-w-3xl flex-1 overflow-y-auto px-5 pt-3 sm:px-10">
        <p class="mb-5 text-xs leading-relaxed text-fg-muted">
          <span class="mr-2 rounded-full border border-line px-2 py-1">Interaction preview</span>
          Sample situations. No agents are running. Changes reset on reload.
        </p>
        {selected ? (
          <>
            <Button variant="ghost" class="mb-5 -ml-4" onClick={() => openConcern(null)}>
              ← Back to Neo
            </Button>
            <p class="mb-3 text-xs uppercase tracking-[0.2em] text-fg-muted">
              One part of your world · 分身
            </p>
            <h1
              ref={heading}
              tabIndex={-1}
              style={{ outline: 'none' }}
              class="break-words text-3xl font-medium leading-tight tracking-tight outline-none sm:text-4xl"
            >
              {selected.title}
            </h1>
            <p class="mt-5 max-w-xl text-lg leading-relaxed text-fg-muted">{selected.summary}</p>
            <section
              aria-label="Concern context"
              class="my-8 rounded-2xl border border-line bg-surface p-6"
            >
              <h2 class="mb-4 text-sm font-medium">What I’m keeping in mind</h2>
              <ul class="space-y-3">
                {selected.context.map((note, index) => (
                  <li
                    key={`${selected.id}-${index}`}
                    class="flex items-start gap-3 text-sm leading-relaxed"
                  >
                    <span
                      aria-hidden="true"
                      class="mt-2 h-1 w-1 shrink-0 rounded-full bg-fg-faint"
                    />
                    <span class="min-w-0 break-words">{note}</span>
                  </li>
                ))}
              </ul>
              <details class="mt-6 border-t border-line pt-4 text-sm text-fg-muted">
                <summary class="cursor-pointer">Work behind this · sample references</summary>
                <p class="mt-3 leading-relaxed">
                  This 分身 holds context. HyperNeo sessions, tasks and agents do the work.
                </p>
                {selected.sources.length ? (
                  <ul class="mt-3 space-y-2">
                    {selected.sources.map((source) => (
                      <li key={source}>{source}</li>
                    ))}
                  </ul>
                ) : (
                  <p class="mt-3">No work linked yet.</p>
                )}
              </details>
            </section>
          </>
        ) : (
          <>
            <h1
              ref={heading}
              tabIndex={-1}
              style={{ outline: 'none' }}
              class="text-3xl font-medium leading-tight tracking-tight sm:text-4xl"
            >
              {decision ? 'That’s one less loose end.' : 'One thing needs your call.'}
            </h1>
            <p class="mt-3 text-base leading-relaxed text-fg-muted">
              {decision
                ? 'Your other concerns are still here. What’s on your mind?'
                : 'The launch timing. Everything else can stay in the background.'}
            </p>
            <section
              aria-label="Launch decision"
              class="my-6 rounded-2xl border border-line bg-surface p-5 sm:p-6"
            >
              <button
                type="button"
                onClick={() => openConcern('launch')}
                class="mb-3 text-sm text-accent hover:underline focus-visible:outline-2"
              >
                From your launch context ↗
              </button>
              <p class="text-lg leading-relaxed">
                {decision ??
                  'The signup fix needs another day of testing. Keep Friday, or give it until Monday?'}
              </p>
              <p class="mt-3 text-sm leading-relaxed text-fg-muted">
                {decision
                  ? 'This is a simulated decision. In the live experience, Neo would pass it to the work already underway.'
                  : 'I’d give it the weekend. The trade-off is a later launch, but less risk for the first people signing up.'}
              </p>
              <div class="mt-5 flex flex-wrap gap-3">
                {decision ? (
                  <Button variant="ghost" onClick={() => openConcern('launch')}>
                    See the updated context →
                  </Button>
                ) : (
                  <>
                    <Button onClick={() => chooseTiming('Give testing until Monday.')}>
                      Give it until Monday
                    </Button>
                    <Button
                      variant="secondary"
                      onClick={() => chooseTiming('Keep Friday as the target.')}
                    >
                      Keep Friday
                    </Button>
                  </>
                )}
              </div>
            </section>
            <details aria-label="Your concerns" class="mb-5 text-sm">
              <summary class="cursor-pointer text-fg-muted">
                {concerns.length} things I’m holding for you
              </summary>
              <div class="divide-y divide-line">
                {concerns.map((concern) => (
                  <button
                    type="button"
                    key={concern.id}
                    onClick={() => openConcern(concern.id)}
                    class="flex w-full items-center justify-between gap-5 rounded-lg px-1 py-4 text-left hover:bg-fill-soft focus-visible:outline-2 focus-visible:outline-accent"
                  >
                    <span class="min-w-0 break-words text-sm">{concern.title}</span>
                    <span aria-hidden="true" class="shrink-0 text-fg-faint">
                      ↗
                    </span>
                  </button>
                ))}
              </div>
            </details>
          </>
        )}
      </main>
      <footer class="mx-auto w-full max-w-3xl shrink-0 px-5 pb-3 pt-4 sm:px-10">
        <form
          onSubmit={(event) => {
            event.preventDefault();
            addContext();
          }}
          class="rounded-2xl border border-line-strong bg-surface p-4 focus-within:border-accent"
        >
          <label for="neo-thought" class="mb-3 block text-sm font-medium">
            {selected
              ? 'Anything else I should keep in mind?'
              : 'What would you like off your mind?'}
          </label>
          <textarea
            id="neo-thought"
            value={draft}
            onInput={(event) =>
              setDrafts((items) => ({ ...items, [draftKey]: event.currentTarget.value }))
            }
            rows={2}
            maxLength={2000}
            placeholder={
              selected
                ? 'A constraint, a change of plan, a small detail…'
                : 'Start anywhere. You don’t need to organize it first.'
            }
            class="w-full resize-none bg-transparent text-sm leading-relaxed outline-none placeholder:text-fg-faint"
          />
          <div class="mt-3 flex items-center justify-between gap-3">
            <span class="text-xs text-fg-muted">Preview only · stays on this page</span>
            <Button type="submit" size="sm" disabled={!draft.trim()}>
              {selected ? 'Add context' : 'Try an ask'} ↑
            </Button>
          </div>
        </form>
        <p role="status" class="mt-2 min-h-4 text-xs text-fg-muted">
          {notice}
        </p>
      </footer>
    </div>
  );
}
