import { useEffect, useState } from 'preact/hooks';
import superpipe, { type PipelineAPI } from 'superpipe';
import type { NeoSnapshot } from '@hyperneo/shared/types/neo-snapshot';
import type { NeoScene } from './neo-scenes.ts';
import { findNeoProject } from './project-redirects.ts';

type Project = { readonly id: string; readonly title: string };
type Activity = { readonly key: string; readonly text: string };

export function neoActivityItems(
  scenes: readonly NeoScene[],
  projects: readonly Project[],
  redirects?: NeoSnapshot['projectRedirects']
): Activity[] {
  return scenes
    .filter((scene) => scene.group === 'running')
    .map((scene) => {
      const receipt = scene.receipt;
      const title =
        receipt.kind === 'work'
          ? receipt.title.trim() || 'Work'
          : findNeoProject(projects, redirects, receipt.projectId)?.title.trim() ||
            'Your context holder';
      return {
        key: JSON.stringify([scene.ref.kind, scene.ref.id]),
        text: `${scene.label} · ${title}`,
      };
    });
}

const projectActivity = (superpipe({})('neo-activity') as PipelineAPI)
  .input(['scenes', 'projects', 'redirects'])
  .pipe(neoActivityItems, ['scenes', 'projects', 'redirects'], 'items')
  .end('items') as (
  scenes: readonly NeoScene[],
  projects: readonly Project[],
  redirects: NeoSnapshot['projectRedirects']
) => Activity[];

export function NeoActivity({
  scenes,
  projects,
  enabled,
  busy,
  redirects,
}: {
  redirects?: NeoSnapshot['projectRedirects'];
  scenes: readonly NeoScene[];
  projects: readonly Project[];
  enabled: boolean;
  busy?: readonly string[] | null;
}) {
  const [tick, setTick] = useState(0);
  const items = [
    ...(busy?.length ? [{ key: 'neo-busy', text: busy[tick % busy.length] }] : []),
    ...(enabled ? projectActivity(scenes, projects, redirects) : []),
  ];
  const fingerprint = JSON.stringify(items.map((item) => item.key));
  const current = items.length ? items[Math.floor(tick / 2) % items.length] : undefined;
  useEffect(() => {
    setTick(0);
    if (items.length < 2 && (busy?.length ?? 0) < 2) return;
    const timer = window.setInterval(() => {
      if (document.visibilityState === 'hidden') return;
      setTick((previous) => previous + 1);
    }, 3000);
    return () => window.clearInterval(timer);
  }, [fingerprint, busy]);
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
