import { useEffect, useState } from 'preact/hooks';
import superpipe, { type PipelineAPI } from 'superpipe';
import type { NeoSnapshot } from '@hyperneo/shared/types/neo-snapshot';
import { findNeoProject } from './project-redirects.ts';

type Project = { readonly id: string; readonly title: string };
type Activity = { readonly key: string; readonly text: string };

export function neoActivityItems(
  snapshot: Pick<
    NeoSnapshot,
    'todoAsks' | 'consultations' | 'consultationWaiters' | 'projectRedirects'
  > | null,
  projects: readonly Project[]
): Activity[] {
  const holder = (projectId: string | null) =>
    findNeoProject(projects, snapshot?.projectRedirects, projectId)?.title.trim() ||
    'Your context holder';
  return [
    ...(snapshot?.todoAsks ?? [])
      .filter((entry) => entry.ask.status === 'open')
      .flatMap((entry) =>
        entry.todos
          .filter((todo) => todo.state === 'doing')
          .map((todo) => ({ key: `todo:${todo.id}`, text: `${todo.status} · ${todo.title}` }))
      ),
    ...(snapshot?.consultations ?? [])
      .filter((item) => item.status === 'pending')
      .map((item) => ({
        key: `consultation:${item.id}`,
        text: `Checking context · ${holder(item.projectId)}`,
      })),
    ...(snapshot?.consultationWaiters ?? [])
      .filter((item) => item.status === 'queued')
      .map((item) => ({
        key: `waiter:${item.id}`,
        text: `Waiting for context · ${holder(item.projectId)}`,
      })),
  ];
}

const projectActivity = (superpipe({})('neo-activity') as PipelineAPI)
  .input(['snapshot', 'projects'])
  .pipe(neoActivityItems, ['snapshot', 'projects'], 'items')
  .end('items') as (snapshot: NeoSnapshot | null, projects: readonly Project[]) => Activity[];

export function NeoActivity({
  snapshot,
  projects,
  enabled,
}: {
  snapshot: NeoSnapshot | null;
  projects: readonly Project[];
  enabled: boolean;
}) {
  const [activeKey, setActiveKey] = useState<string | null>(null);
  const items = enabled ? projectActivity(snapshot, projects) : [];
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
