import { useEffect, useState } from 'preact/hooks';
import superpipe, { type PipelineAPI } from 'superpipe';
import type { NeoSnapshot } from '@hyperneo/shared/types/neo-snapshot';
import { neoTodoStatus } from './todo-status.ts';

type Activity = { readonly key: string; readonly text: string };

export function neoActivityItems(snapshot: Pick<NeoSnapshot, 'todoAsks'> | null): Activity[] {
  return (snapshot?.todoAsks ?? [])
    .filter((entry) => entry.ask.status === 'open')
    .flatMap((entry) =>
      entry.todos
        .filter((todo) => todo.state === 'doing')
        .map((todo) => ({
          key: `todo:${todo.id}`,
          text: `${neoTodoStatus(todo)} · ${todo.title}`,
        }))
    );
}

const projectActivity = (superpipe({})('neo-activity') as PipelineAPI)
  .input(['snapshot'])
  .pipe(neoActivityItems, 'snapshot', 'items')
  .end('items') as (snapshot: NeoSnapshot | null) => Activity[];

export function NeoActivity({
  snapshot,
  enabled,
}: {
  snapshot: NeoSnapshot | null;
  enabled: boolean;
}) {
  const [activeKey, setActiveKey] = useState<string | null>(null);
  const items = enabled ? projectActivity(snapshot) : [];
  const fingerprint = JSON.stringify(items.map((item) => item.key));
  const current = items.find((item) => item.key === activeKey) ?? items[0];
  useEffect(() => {
    if (items.length < 2) return;
    const timer = window.setInterval(() => {
      if (document.visibilityState === 'hidden') return;
      setActiveKey((previous) => {
        const index = Math.max(
          0,
          items.findIndex((item) => item.key === previous)
        );
        return items[(index + 1) % items.length].key;
      });
    }, 6000);
    return () => window.clearInterval(timer);
  }, [fingerprint]);
  return (
    <div
      class="neo-activity"
      role="note"
      aria-label="Neo activity"
      aria-live="off"
      hidden={!current}
    >
      <span aria-hidden="true" class="h-1 w-1 shrink-0 rounded-full bg-accent/70" />
      <span class="neo-activity-text" title={current?.text}>
        {current?.text ?? ''}
      </span>
      <span class="neo-activity-count" aria-hidden="true">
        {items.length > 1 && current ? `${items.indexOf(current) + 1}/${items.length}` : ''}
      </span>
    </div>
  );
}
