import type { ComponentChildren } from 'preact';
import { useState } from 'preact/hooks';
import { Dropdown } from '../components/ui/Dropdown.tsx';
import { IconButton } from '../components/ui/IconButton.tsx';
import { NeoIcon } from './NeoIcon.tsx';
import type { NeoAskOutcome, NeoAskView } from './neo-asks.ts';

const tones = {
  attention: 'text-warning bg-warning/10',
  running: 'text-accent bg-accent/10',
  achieved: 'text-success bg-success/10',
  ended: 'text-fg-muted bg-fill-soft',
};

export function NeoAskCard({
  view,
  children,
  disabled = false,
  onSettle,
}: {
  view: NeoAskView;
  children?: ComponentChildren;
  disabled?: boolean;
  onSettle?: (outcome: NeoAskOutcome) => void;
}) {
  const [open, setOpen] = useState(view.group === 'attention');
  const { ask } = view;
  const tone =
    view.group === 'attention'
      ? 'attention'
      : ask.status === 'achieved'
        ? 'achieved'
        : view.group === 'outcomes'
          ? 'ended'
          : 'running';
  const icon = tone === 'attention' ? 'alert' : tone === 'achieved' ? 'check' : 'work';
  const steps = view.scenes.length;
  return (
    <article
      aria-label={ask.title}
      data-ask={ask.id}
      class="neo-arrive rounded-2xl border border-line bg-surface p-5 shadow-sm"
    >
      <div class="mb-3 flex items-center gap-3">
        <span data-tone={tone} class={`rounded-xl p-2 ${tones[tone]}`}>
          <NeoIcon name={icon} />
        </span>
        <span class="text-xs font-medium text-fg-muted">{view.label}</span>
        {tone === 'running' && (
          <span
            aria-hidden="true"
            class="h-1.5 w-1.5 rounded-full bg-accent motion-safe:animate-pulse"
          />
        )}
        <span class="ml-auto" />
        {view.total > 0 && (
          <span class="text-xs text-fg-muted">
            {view.done} of {view.total} done
          </span>
        )}
        {onSettle && ask.status !== 'achieved' && ask.status !== 'abandoned' && (
          <Dropdown
            position="right"
            items={[
              { label: 'Mark done', onClick: () => onSettle('achieved'), disabled },
              {
                label: 'Drop this ask',
                onClick: () => onSettle('abandoned'),
                danger: true,
                disabled,
              },
            ]}
            trigger={
              <IconButton title="Ask actions" size="sm" class="text-fg-faint">
                <svg class="h-4 w-4" fill="currentColor" viewBox="0 0 24 24" aria-hidden="true">
                  <circle cx="5" cy="12" r="1.75" />
                  <circle cx="12" cy="12" r="1.75" />
                  <circle cx="19" cy="12" r="1.75" />
                </svg>
              </IconButton>
            }
          />
        )}
      </div>
      <h3 class="break-words text-base font-medium">{ask.title}</h3>
      {ask.outcome && (
        <p class="mt-2 line-clamp-3 break-words text-sm text-fg-muted">{ask.outcome}</p>
      )}
      <details class="mt-1 text-sm text-fg-muted">
        <summary class="cursor-pointer select-none">Done when</summary>
        <p class="mt-1 whitespace-pre-wrap break-words">{ask.doneWhen}</p>
      </details>
      {steps > 0 && (
        <div class="mt-3">
          <button
            type="button"
            aria-expanded={open}
            onClick={() => setOpen(!open)}
            class="inline-flex items-center gap-1.5 rounded-lg px-2 py-1 -ml-2 text-xs text-fg-muted hover:bg-fill-soft hover:text-accent"
          >
            <NeoIcon
              name="chevron"
              class={`!h-3.5 !w-3.5 transition-transform${open ? '' : ' rotate-180'}`}
            />
            {open ? 'Hide steps' : `Show steps · ${steps}`}
          </button>
          {open && <div class="mt-3 space-y-3 border-l border-line pl-3">{children}</div>}
        </div>
      )}
    </article>
  );
}
