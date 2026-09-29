import type { NeoWork } from '@hyperneo/shared/types/neo-context';
import { useState } from 'preact/hooks';
import { Button } from '../components/ui/Button.tsx';
import { NeoIcon } from './NeoIcon.tsx';
import { NeoWorkCard } from './NeoWorkCard.tsx';

export function neoWorkTrayLabel(works: NeoWork[]): string {
  const proposed = works.filter((work) => work.status === 'proposed').length;
  const running = works.length - proposed;
  const parts: string[] = [];
  if (proposed) parts.push(proposed === 1 ? '1 needs your call' : `${proposed} need your call`);
  if (running) parts.push(running === 1 ? '1 running' : `${running} running`);
  return parts.join(' · ') || 'In flight';
}

export function NeoWorkTray({
  works,
  busyId,
  disabled,
  onAction,
}: {
  works: NeoWork[];
  busyId: string | null;
  disabled: boolean;
  onAction: (id: string, action: 'start' | 'cancel') => void;
}) {
  const [open, setOpen] = useState(false);
  const [detailId, setDetailId] = useState<string | null>(null);
  if (works.length === 0) return null;
  return (
    <section aria-label="Delegated work" data-testid="neo-work-tray" class="neo-work-tray mt-6">
      <button
        type="button"
        aria-expanded={open}
        aria-controls="neo-work-tray-list"
        onClick={() => {
          setDetailId(null);
          setOpen(!open);
        }}
        class="flex w-full items-center gap-2 rounded-xl border border-line bg-surface px-3 py-2 text-left text-sm text-fg-muted hover:bg-surface-hover focus-visible:outline-accent"
      >
        <span
          aria-hidden="true"
          class="h-1.5 w-1.5 shrink-0 rounded-full bg-accent motion-safe:animate-pulse"
        />
        <span class="min-w-0 flex-1 truncate">{neoWorkTrayLabel(works)}</span>
        <NeoIcon
          name="chevron"
          class={`h-4 w-4 transition-transform ${open ? 'rotate-180' : ''}`}
        />
      </button>
      {open && (
        <div id="neo-work-tray-list" class="neo-work-tray-list mt-2 space-y-2">
          {works.map((work) => (
            <div key={work.id} class="neo-work-tray-row">
              <div class="flex items-center gap-2 rounded-xl border border-line bg-surface px-3 py-2">
                <button
                  type="button"
                  aria-expanded={detailId === work.id}
                  onClick={() => setDetailId(detailId === work.id ? null : work.id)}
                  class="min-w-0 flex-1 text-left focus-visible:outline-accent"
                >
                  <span
                    class={`text-[11px] font-medium ${
                      work.status === 'proposed' ? 'text-warning' : 'text-accent'
                    }`}
                  >
                    {work.status === 'proposed' ? 'Your call' : 'Running'}
                  </span>
                  <span class="mt-0.5 block truncate text-sm">{work.title}</span>
                </button>
                {work.status === 'proposed' ? (
                  <Button
                    size="sm"
                    disabled={disabled || busyId === work.id}
                    onClick={() => onAction(work.id, 'start')}
                  >
                    {busyId === work.id ? 'Starting…' : 'Start'}
                  </Button>
                ) : (
                  <Button
                    size="sm"
                    variant="ghost"
                    disabled={disabled || busyId === work.id}
                    onClick={() => onAction(work.id, 'cancel')}
                  >
                    {busyId === work.id ? 'Stopping…' : 'Stop'}
                  </Button>
                )}
                {work.sessionId && (
                  <a
                    class="shrink-0 text-xs text-accent hover:underline"
                    href={`/session/${encodeURIComponent(work.sessionId)}`}
                    target="_blank"
                    rel="noreferrer"
                  >
                    Inspect ↗
                  </a>
                )}
              </div>
              {detailId === work.id && (
                <NeoWorkCard
                  work={work}
                  busy={busyId === work.id}
                  disabled={disabled}
                  onAction={onAction}
                />
              )}
            </div>
          ))}
        </div>
      )}
    </section>
  );
}
