import type { NeoConcern } from '@hyperneo/shared/types/neo-context';
import { useRef, useState } from 'preact/hooks';
import { useClickOutside } from '../hooks/useClickOutside.ts';
import { NeoIcon, concernColor } from './NeoIcon.tsx';

export function NeoConcerns({
  concerns,
  selectedId,
  onOpen,
}: {
  concerns: NeoConcern[];
  selectedId: string | null;
  onOpen: (id: string) => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  useClickOutside(ref, () => setExpanded(false), expanded);
  if (!concerns.length) return null;
  return (
    <div ref={ref} class="neo-concerns">
      <button
        ref={trigger}
        type="button"
        class="neo-concerns-trigger relative rounded-xl border border-accent/20 bg-accent/10 p-2 text-accent hover:bg-accent/20"
        aria-label={`Your concerns · ${concerns.length}`}
        aria-expanded={expanded}
        aria-controls="neo-concerns-list"
        onClick={() => setExpanded(!expanded)}
      >
        <NeoIcon name="context" />
        <span class="absolute -right-1 -top-1 rounded-full bg-accent px-1.5 text-[10px] text-accent-fg">
          {concerns.length}
        </span>
      </button>
      <aside
        id="neo-concerns-list"
        aria-label="Your concerns"
        class={`neo-concerns-card ${expanded ? 'is-open' : ''}`}
      >
        <div class="mb-3 flex items-center justify-between gap-2">
          <h2 class="text-xs font-medium text-fg-muted">
            {concerns.length} {concerns.length === 1 ? 'thing' : 'things'} I’m holding for you
          </h2>
          <button
            type="button"
            class="neo-concerns-trigger rounded-lg p-1 text-fg-muted hover:bg-fill-soft"
            aria-label="Close concerns"
            onClick={() => {
              setExpanded(false);
              trigger.current?.focus();
            }}
          >
            <NeoIcon name="close" />
          </button>
        </div>
        <div class="space-y-2">
          {concerns.map((concern) => (
            <button
              key={concern.id}
              type="button"
              aria-current={concern.id === selectedId ? 'page' : undefined}
              onClick={() => {
                setExpanded(false);
                onOpen(concern.id);
              }}
              class="group flex w-full items-start gap-3 rounded-xl p-2 text-left transition-colors hover:bg-fill-soft aria-[current=page]:bg-accent/10"
            >
              <span class={`rounded-lg p-2 ${concernColor(concern.id)}`}>
                <NeoIcon name="context" />
              </span>
              <span class="min-w-0">
                <span class="block break-words text-sm font-medium">{concern.title}</span>
                <span class="mt-1 line-clamp-3 text-xs leading-relaxed text-fg-muted">
                  {concern.summary}
                </span>
              </span>
            </button>
          ))}
        </div>
      </aside>
    </div>
  );
}
