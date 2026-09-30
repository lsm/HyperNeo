import type { NeoWork } from '@hyperneo/shared/types/neo-context';
import { Button } from '../components/ui/Button.tsx';
import MarkdownRenderer from '../components/chat/MarkdownRenderer.tsx';
import { NeoIcon } from './NeoIcon.tsx';
import { NeoWorkQuestion } from './NeoWorkQuestion.tsx';

const labels: Record<NeoWork['status'], string> = {
  proposed: 'Your call',
  queued: 'Handed to HyperNeo',
  reported: 'Response ready',
  failed: 'Needs attention',
  cancelled: 'Stopped',
};

const interactive =
  'button, a, summary, details, input, textarea, select, [contenteditable=""], [contenteditable="true"], [role="button"]';

export function sceneOpenSelector(id: string): string {
  return `[data-scene-open="${id.replace(/["\\]/g, '\\$&')}"]`;
}

function insideUserSelection(scope: Element): boolean {
  const selection = document.getSelection?.();
  if (!selection || selection.isCollapsed) return false;
  const { anchorNode, focusNode } = selection;
  return (!!anchorNode && scope.contains(anchorNode)) || (!!focusNode && scope.contains(focusNode));
}

export function NeoWorkCard({
  work,
  busy,
  disabled,
  onAction,
  onOpen,
}: {
  work: NeoWork;
  busy: boolean;
  disabled: boolean;
  onAction: (id: string, action: 'start' | 'cancel') => void;
  onOpen?: (id: string) => void;
}) {
  const active = work.status === 'queued';
  const color =
    work.status === 'reported'
      ? 'text-success bg-success/10'
      : work.status === 'failed'
        ? 'text-warning bg-warning/10'
        : 'text-accent bg-accent/10';
  return (
    <article
      aria-label={work.title}
      class="neo-arrive rounded-2xl border border-line bg-surface p-5 shadow-sm"
      onClick={
        onOpen
          ? (event) => {
              const target = event.target as Element | null;
              if (!target || target.closest?.(interactive)) return;
              if (insideUserSelection(event.currentTarget as Element)) return;
              onOpen(work.id);
            }
          : undefined
      }
    >
      <div class="mb-3 flex items-center gap-3">
        <span class={`rounded-xl p-2 ${color}`}>
          <NeoIcon name={work.status === 'reported' ? 'check' : 'work'} />
        </span>
        <span class="text-xs font-medium text-fg-muted">{labels[work.status]}</span>
        {active && (
          <span
            aria-hidden="true"
            class="h-1.5 w-1.5 rounded-full bg-accent motion-safe:animate-pulse"
          />
        )}
      </div>
      <h3 class="break-words text-base font-medium">
        {onOpen ? (
          <button
            type="button"
            onClick={() => onOpen(work.id)}
            data-scene-open={work.id}
            class="text-left hover:text-accent focus-visible:outline-accent"
          >
            {work.title}
          </button>
        ) : (
          work.title
        )}
      </h3>
      <details class="mt-3 text-sm text-fg-muted">
        <summary class="cursor-pointer">
          {work.status === 'proposed' ? 'Review the work brief' : 'What was delegated'}
        </summary>
        <p class="mt-3 whitespace-pre-wrap break-words leading-relaxed">{work.instruction}</p>
        {work.targetSessionId && (
          <p class="mt-2 break-all text-xs">Existing chat: {work.targetSessionId}</p>
        )}
      </details>
      {active && work.sessionId && <NeoWorkQuestion key={work.id} work={work} />}
      {work.status === 'proposed' && (
        <p class="mt-3 text-xs leading-relaxed text-fg-muted">
          {work.targetSessionId
            ? 'Continues in the selected existing HyperNeo chat, keeping its workspace, tools and permissions.'
            : 'Starts a real HyperNeo session with its existing tools and permissions, in a temporary scratch workspace — no folder of yours is selected.'}
        </p>
      )}
      {work.report && (
        <details class="mt-3 text-sm">
          <summary class="cursor-pointer text-fg-muted">Read the execution’s response</summary>
          <div class="mt-3 min-w-0 break-words">
            <MarkdownRenderer content={work.report} />
          </div>
        </details>
      )}
      <div class="mt-4 flex flex-wrap items-center gap-2">
        {work.status === 'proposed' && (
          <Button
            disabled={disabled || busy}
            onClick={() => onAction(work.id, 'start')}
            icon={<NeoIcon name="arrow" />}
          >
            {busy ? 'Starting…' : 'Start work'}
          </Button>
        )}
        {(work.status === 'proposed' || active) && (
          <Button
            variant="ghost"
            disabled={disabled || busy}
            onClick={() => onAction(work.id, 'cancel')}
          >
            {busy
              ? 'Updating…'
              : active
                ? work.targetSessionId
                  ? 'Stop waiting'
                  : 'Stop work'
                : 'Not now'}
          </Button>
        )}
        {work.sessionId && (
          <a
            class="ml-auto text-xs text-accent hover:underline"
            href={`/session/${encodeURIComponent(work.sessionId)}`}
            target="_blank"
            rel="noreferrer"
          >
            Inspect execution ↗
          </a>
        )}
      </div>
      {work.status === 'cancelled' && (
        <p class="mt-2 text-xs text-fg-muted">
          {work.targetSessionId
            ? 'Stopped waiting for this result. The existing chat and its other work continue; changes are not undone.'
            : 'Stopping does not undo changes already made.'}
        </p>
      )}
    </article>
  );
}
