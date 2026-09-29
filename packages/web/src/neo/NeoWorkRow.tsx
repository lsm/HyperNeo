import type { NeoWork } from '@hyperneo/shared/types/neo-context';
import { NeoIcon } from './NeoIcon.tsx';

const labels: Record<string, string> = {
  proposed: 'Your call',
  queued: 'Handed to HyperNeo',
};

export function NeoWorkRow({
  work,
  busy,
  disabled,
  onAction,
  onJump,
}: {
  work: NeoWork;
  busy: boolean;
  disabled: boolean;
  onAction: (id: string, action: 'start' | 'cancel') => void;
  onJump: () => void;
}) {
  const proposed = work.status === 'proposed';
  return (
    <div
      class="rounded-xl border border-line bg-surface p-2"
      data-testid={`neo-work-row-${work.id}`}
    >
      <div class="flex items-center gap-2">
        <span
          class={`shrink-0 text-[11px] font-medium ${proposed ? 'text-warning' : 'text-accent'}`}
        >
          {labels[work.status] ?? work.status}
        </span>
        <button
          type="button"
          onClick={onJump}
          title="Jump to this work's card at its originating message"
          class="min-w-0 flex-1 truncate text-left text-sm hover:text-accent focus-visible:outline-accent"
        >
          {work.title}
        </button>
      </div>
      {work.instruction && (
        <details class="mt-1 text-xs text-fg-muted">
          <summary class="cursor-pointer">Review the work brief</summary>
          <p class="mt-1 whitespace-pre-wrap break-words leading-relaxed">{work.instruction}</p>
          {work.targetSessionId && (
            <p class="mt-1 break-all text-fg-faint">Existing chat: {work.targetSessionId}</p>
          )}
        </details>
      )}
      <div class="mt-1 flex items-center gap-3 text-xs">
        {proposed ? (
          <>
            <button
              type="button"
              disabled={disabled || busy}
              onClick={() => onAction(work.id, 'start')}
              class="rounded-lg bg-accent px-2 py-0.5 font-medium text-accent-fg disabled:cursor-not-allowed disabled:opacity-50"
            >
              {busy ? 'Starting…' : 'Start'}
            </button>
            <button
              type="button"
              disabled={disabled || busy}
              onClick={() => onAction(work.id, 'cancel')}
              class="text-fg-muted underline-offset-2 hover:underline disabled:opacity-50"
            >
              Not now
            </button>
          </>
        ) : (
          <button
            type="button"
            disabled={disabled || busy}
            onClick={() => onAction(work.id, 'cancel')}
            class="text-danger-soft underline-offset-2 hover:underline disabled:opacity-50"
          >
            {busy ? 'Stopping…' : work.targetSessionId ? 'Stop waiting' : 'Stop work'}
          </button>
        )}
        {work.sessionId && (
          <a
            class="ml-auto inline-flex items-center gap-1 text-fg-muted hover:text-accent"
            href={`/session/${encodeURIComponent(work.sessionId)}`}
            target="_blank"
            rel="noreferrer"
          >
            Inspect
            <NeoIcon name="external" class="h-3.5 w-3.5" />
          </a>
        )}
      </div>
    </div>
  );
}
