import type { NeoConcern, NeoConsultation, NeoWork } from '@hyperneo/shared/types/neo-context';
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
}: {
  concerns: NeoConcern[];
  works?: NeoWork[];
  consultations?: NeoConsultation[];
  selectedId: string | null;
  onOpen: (id: string) => void;
}) {
  const ordered = prioritizedConcerns(concerns, works, consultations);
  const decisionCount = ordered.filter((item) => item.attention === 'decision').length;
  const decisionLabel =
    decisionCount === 1 ? '1 thing needs your call' : `${decisionCount} things need your call`;
  if (!concerns.length) return null;
  return (
    <section aria-label="Your concerns" class="neo-work-concerns">
      <div>
        <h2 class="text-xs font-medium text-fg-muted">
          {concerns.length} {concerns.length === 1 ? 'thing' : 'things'} I’m holding for you
        </h2>
        {decisionCount > 0 && <p class="mt-1 text-xs text-warning">{decisionLabel}</p>}
      </div>
      <div class="mt-3 space-y-2">
        {ordered.map(({ concern, attention }) => (
          <button
            key={concern.id}
            type="button"
            aria-current={concern.id === selectedId ? 'page' : undefined}
            onClick={() => onOpen(concern.id)}
            class="flex w-full items-start gap-3 rounded-xl p-2 text-left transition-colors hover:bg-fill-soft aria-[current=page]:bg-accent/10"
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
    </section>
  );
}
