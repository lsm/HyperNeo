import type { NeoConcern, NeoConsultation, NeoWork } from '@hyperneo/shared/types/neo-context';
import { NeoWorkRow } from './NeoWorkRow.tsx';
import { useRef, useState } from 'preact/hooks';
import { useClickOutside } from '../hooks/useClickOutside.ts';
import { NeoIcon, concernColor } from './NeoIcon.tsx';

type Attention = 'decision' | 'working' | 'checking' | null;

export function prioritizedConcerns(
  concerns: NeoConcern[],
  works: NeoWork[],
  consultations: NeoConsultation[]
): { concern: NeoConcern; attention: Attention }[] {
  const active = new Map<
    string,
    { attention: Exclude<Attention, null>; rank: number; at: number }
  >();
  const add = (id: string, attention: Exclude<Attention, null>, rank: number, at: number) => {
    const previous = active.get(id);
    if (!previous || rank > previous.rank || (rank === previous.rank && at > previous.at))
      active.set(id, { attention, rank, at });
  };
  for (const work of works) {
    if (!work.concernId) continue;
    if (work.status === 'proposed') add(work.concernId, 'decision', 3, work.updatedAt);
    if (work.status === 'queued') add(work.concernId, 'working', 2, work.updatedAt);
  }
  for (const consultation of consultations) {
    if (consultation.status === 'pending')
      add(consultation.concernId, 'checking', 1, consultation.createdAt);
  }
  return concerns
    .map((concern) => ({ concern, state: active.get(concern.id) }))
    .sort(
      (left, right) =>
        (right.state?.rank ?? 0) - (left.state?.rank ?? 0) ||
        Math.max(right.concern.updatedAt, right.state?.at ?? 0) -
          Math.max(left.concern.updatedAt, left.state?.at ?? 0) ||
        left.concern.id.localeCompare(right.concern.id)
    )
    .map(({ concern, state }) => ({ concern, attention: state?.attention ?? null }));
}

export function NeoConcerns({
  concerns,
  works = [],
  consultations = [],
  selectedId,
  onOpen,
  workBusy = null,
  workDisabled = false,
  onWorkAction = () => {},
  onJumpToWork = () => {},
}: {
  concerns: NeoConcern[];
  works?: NeoWork[];
  consultations?: NeoConsultation[];
  selectedId: string | null;
  onOpen: (id: string) => void;
  workBusy?: string | null;
  workDisabled?: boolean;
  onWorkAction?: (id: string, action: 'start' | 'cancel') => void;
  onJumpToWork?: (id: string) => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  useClickOutside(ref, () => setExpanded(false), expanded);
  const ordered = prioritizedConcerns(concerns, works, consultations);
  const openWork = works.filter((work) => work.status === 'proposed' || work.status === 'queued');
  const decisionCount =
    ordered.filter((item) => item.attention === 'decision').length +
    works.filter((work) => work.status === 'proposed' && !work.concernId).length;
  const decisionLabel =
    decisionCount === 1 ? '1 thing needs your call' : `${decisionCount} things need your call`;
  if (!concerns.length && openWork.length === 0) return null;
  return (
    <div ref={ref} class="neo-concerns">
      <button
        ref={trigger}
        type="button"
        class="neo-concerns-trigger relative rounded-xl border border-accent/20 bg-accent/10 p-2 text-accent hover:bg-accent/20"
        aria-label={
          concerns.length
            ? `Your concerns · ${concerns.length}${decisionCount ? ` · ${decisionLabel}` : ''}`
            : `Work in flight · ${openWork.length}`
        }
        aria-expanded={expanded}
        aria-controls="neo-concerns-list"
        onClick={() => setExpanded(!expanded)}
      >
        <NeoIcon name="context" />
        {decisionCount > 0 && (
          <span
            aria-hidden="true"
            class="absolute -left-1 -top-1 h-2.5 w-2.5 rounded-full bg-warning"
          />
        )}
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
          <div>
            <h2 class="text-xs font-medium text-fg-muted">
              {concerns.length} {concerns.length === 1 ? 'thing' : 'things'} I’m holding for you
            </h2>
            {decisionCount > 0 && <p class="mt-1 text-xs text-warning">{decisionLabel}</p>}
          </div>
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
        {openWork.length > 0 && (
          <div class="mb-3">
            <p class="mb-2 text-[11px] font-medium uppercase tracking-wide text-fg-faint">
              Work · {openWork.length}
            </p>
            <div class="space-y-2" data-testid="neo-work-surface">
              {openWork.map((work) => (
                <NeoWorkRow
                  key={work.id}
                  work={work}
                  busy={workBusy === work.id}
                  disabled={workDisabled}
                  onAction={onWorkAction}
                  onJump={() => onJumpToWork(work.id)}
                />
              ))}
            </div>
          </div>
        )}
        <div class="space-y-2">
          {ordered.map(({ concern, attention }) => (
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
                {attention && (
                  <span
                    class={`mt-1 block text-[11px] font-medium ${attention === 'decision' ? 'text-warning' : 'text-accent'}`}
                  >
                    {attention === 'decision'
                      ? 'Your call'
                      : attention === 'working'
                        ? 'Work underway'
                        : 'Checking context'}
                  </span>
                )}
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
