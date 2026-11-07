import { t } from '../lib/i18n/index.ts';
import { NEO_OTHER_TOPIC, neoTopicColor } from './topic-color.ts';

type Topical = { ask: { topic: string | null } };

export function neoTopicCounts(entries: readonly Topical[]): [string, number][] {
  const counts = new Map<string, number>();
  for (const { ask } of entries)
    if (ask.topic) counts.set(ask.topic, (counts.get(ask.topic) ?? 0) + 1);
  return [...counts].sort(
    ([a, x], [b, y]) => +(a === NEO_OTHER_TOPIC) - +(b === NEO_OTHER_TOPIC) || y - x
  );
}

const chip = 'flex shrink-0 items-center gap-1.5 rounded-full border px-3 py-1 text-xs font-medium';

export function NeoTopicChips({
  entries,
  selected,
  onSelect,
}: {
  entries: readonly Topical[];
  selected: string | null;
  onSelect: (topic: string | null) => void;
}) {
  const topics = neoTopicCounts(entries);
  if (!topics.length) return null;
  const tone = (on: boolean) =>
    on ? 'border-accent bg-accent/10 text-fg' : 'border-line text-fg-muted hover:text-fg';
  return (
    <div class="-mx-1 mt-4 flex gap-2 overflow-x-auto px-1 pb-1" data-topic-chips>
      <button
        type="button"
        aria-pressed={selected === null}
        class={`${chip} ${tone(selected === null)}`}
        onClick={() => onSelect(null)}
      >
        {t('live.allTopics')} {entries.length}
      </button>
      {topics.map(([topic, count]) => (
        <button
          key={topic}
          type="button"
          aria-pressed={selected === topic}
          class={`${chip} ${tone(selected === topic)}`}
          onClick={() => onSelect(selected === topic ? null : topic)}
        >
          <span
            aria-hidden="true"
            class="h-2 w-2 rounded-sm"
            style={{ backgroundColor: neoTopicColor(topic) }}
          />
          {topic} {count}
        </button>
      ))}
    </div>
  );
}
