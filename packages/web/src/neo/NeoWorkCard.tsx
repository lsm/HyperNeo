import type { NeoWork } from '@hyperneo/shared/types/neo-context';
import { Button } from '../components/ui/Button.tsx';
import MarkdownRenderer from '../components/chat/MarkdownRenderer.tsx';
import { NeoIcon } from './NeoIcon.tsx';

const labels: Record<NeoWork['status'], string> = {
  proposed: 'Your call',
  queued: 'Handed to HyperNeo',
  reported: 'Response ready',
  failed: 'Needs attention',
  cancelled: 'Stopped',
};

export function NeoWorkCard({
  work,
  busy,
  disabled,
  onAction,
}: {
  work: NeoWork;
  busy: boolean;
  disabled: boolean;
  onAction: (id: string, action: 'start' | 'cancel') => void;
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
      <h3 class="break-words text-base font-medium">{work.title}</h3>
      <details class="mt-3 text-sm text-fg-muted">
        <summary class="cursor-pointer">
          {work.status === 'proposed' ? 'Review the work brief' : 'What was delegated'}
        </summary>
        <p class="mt-3 whitespace-pre-wrap break-words leading-relaxed">{work.instruction}</p>
      </details>
      {work.status === 'proposed' && (
        <p class="mt-3 text-xs leading-relaxed text-fg-muted">
          Starts a real HyperNeo session with its existing tools and permissions, in a temporary
          scratch workspace — no folder of yours is selected.
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
            {busy ? 'Updating…' : active ? 'Stop work' : 'Not now'}
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
        <p class="mt-2 text-xs text-fg-muted">Stopping does not undo changes already made.</p>
      )}
    </article>
  );
}
