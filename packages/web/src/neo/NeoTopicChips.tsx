import { t } from '../lib/i18n/index.ts';
import { NEO_OTHER_TOPIC_KEY, type NeoAsk } from '@hyperneo/shared/types/neo-ask';
import { neoTopicColor } from './topic-color.ts';
import { neoTopicLabel } from './topic-label.ts';

type Topical = { ask: Pick<NeoAsk, 'topic' | 'topicSource'> & { topicKey?: string | null } };

export function neoTopicCounts(entries: readonly Topical[]): [string, string, number][] {
  const counts = new Map<string, [string, string, number]>();
  for (const { ask } of entries)
    if (ask.topicKey && ask.topic) {
      const known = counts.get(ask.topicKey);
      counts.set(ask.topicKey, [
        ask.topicKey,
        known?.[1] ?? neoTopicLabel(ask)!,
        (known?.[2] ?? 0) + 1,
      ]);
    }
  return [...counts.values()].sort(
    ([a, , x], [b, , y]) => +(a === NEO_OTHER_TOPIC_KEY) - +(b === NEO_OTHER_TOPIC_KEY) || y - x
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
      {topics.map(([key, topic, count]) => (
        <button
          key={key}
          type="button"
          aria-pressed={selected === key}
          class={`${chip} ${tone(selected === key)}`}
          onClick={() => onSelect(selected === key ? null : key)}
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
