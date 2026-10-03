import { useEffect, useState } from 'preact/hooks';
import superpipe, { type PipelineAPI } from 'superpipe';
import type { NeoScene } from './neo-scenes.ts';

type Concern = { readonly id: string; readonly title: string };
type Activity = { readonly key: string; readonly text: string };

export function neoActivityItems(
  scenes: readonly NeoScene[],
  concerns: readonly Concern[]
): Activity[] {
  return scenes
    .filter((scene) => scene.group === 'running')
    .map((scene) => {
      const receipt = scene.receipt;
      const title =
        receipt.kind === 'work'
          ? receipt.title.trim() || 'Work'
          : concerns.find((concern) => concern.id === receipt.concernId)?.title.trim() ||
            'Your context holder';
      return {
        key: JSON.stringify([scene.ref.kind, scene.ref.id]),
        text: `${scene.label} · ${title}`,
      };
    });
}

const projectActivity = (superpipe({})('neo-activity') as PipelineAPI)
  .input(['scenes', 'concerns'])
  .pipe(neoActivityItems, ['scenes', 'concerns'], 'items')
  .end('items') as (scenes: readonly NeoScene[], concerns: readonly Concern[]) => Activity[];

export function NeoActivity({
  scenes,
  concerns,
  enabled,
  reply,
}: {
  scenes: readonly NeoScene[];
  concerns: readonly Concern[];
  enabled: boolean;
  reply?: string | null;
}) {
  const items = [
    ...(reply ? [{ key: 'neo-reply', text: reply }] : []),
    ...(enabled ? projectActivity(scenes, concerns) : []),
  ];
  const [activeKey, setActiveKey] = useState<string | null>(null);
  const fingerprint = JSON.stringify(items);
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
        {items.length > 1 ? `${items.indexOf(current) + 1}/${items.length}` : ''}
      </span>
    </div>
  );
}
