import type { SpaceTask } from '@hyperneo/shared';
import { fuzzyScore } from '../../lib/command-registry.ts';
import { navigateToSpace, navigateToSpaceTask } from '../../lib/space-router.ts';
import { workspaceLabel } from '../../lib/workspace-label.ts';
import {
  type ExtensionPaletteItem,
  type ExtensionSearchResult,
  type SpaceWithTaskList,
  webExtension,
} from '../../lib/web-extensions.ts';

const SpaceIcon = () => (
  <svg class="h-4 w-4" viewBox="0 0 20 20" fill="none" stroke="currentColor">
    <path
      d="M5 6.5 10 4l5 2.5-5 2.5zM5 10l5 2.5 5-2.5M5 13.5l5 2.5 5-2.5"
      stroke-width="1.5"
      stroke-linejoin="round"
      stroke-linecap="round"
    />
  </svg>
);

const SpaceTaskIcon = () => (
  <svg class="h-4 w-4" viewBox="0 0 20 20" fill="none" stroke="currentColor">
    <path
      d="M6.5 3.5h7l1 2v11h-9v-11zM7 8h6M7 11h6"
      stroke-width="1.5"
      stroke-linecap="round"
      stroke-linejoin="round"
    />
  </svg>
);

function spaceItems(
  spaces: SpaceWithTaskList[],
  query: string,
  limit: number
): ExtensionPaletteItem[] {
  const trimmed = query.trim();
  const ranked = spaces
    .map((space) => {
      const score = trimmed
        ? Math.max(
            fuzzyScore(space.name, trimmed),
            fuzzyScore(space.description, trimmed),
            fuzzyScore(space.workspacePath, trimmed)
          )
        : 1;
      return { space, score };
    })
    .filter(({ space, score }) => space.status !== 'archived' && score > 0)
    .sort((a, b) => {
      if (trimmed && b.score !== a.score) return b.score - a.score;
      return b.space.updatedAt - a.space.updatedAt;
    })
    .slice(0, limit);

  return ranked.map(({ space }) => ({
    id: `space:${space.id}`,
    group: trimmed ? 'spaces' : 'recent',
    title: space.name,
    subtitle: workspaceLabel(space.workspacePath),
    icon: SpaceIcon,
    open: () => navigateToSpace(space.slug),
  }));
}

function taskItemsFromSpaces(
  spaces: SpaceWithTaskList[],
  query: string,
  limit: number
): ExtensionPaletteItem[] {
  const trimmed = query.trim();
  const ranked: Array<{ task: SpaceTask; spaceName: string; spaceSlug: string; score: number }> =
    [];
  for (const space of spaces) {
    for (const task of space.tasks) {
      const score = trimmed
        ? Math.max(fuzzyScore(task.title, trimmed), fuzzyScore(task.description, trimmed))
        : 1;
      if (score <= 0) continue;
      ranked.push({ task, spaceName: space.name, spaceSlug: space.slug, score });
    }
  }
  ranked.sort((a, b) => {
    if (trimmed && b.score !== a.score) return b.score - a.score;
    return b.task.updatedAt - a.task.updatedAt;
  });
  return ranked.slice(0, limit).map(({ task, spaceName, spaceSlug }) => ({
    id: `space-task:${task.id}`,
    group: trimmed ? 'tasks' : 'recent',
    title: task.title,
    subtitle: `${spaceName} · Task #${task.taskNumber}`,
    icon: SpaceTaskIcon,
    open: () => navigateToSpaceTask(spaceSlug, task.id),
  }));
}

export function spacePaletteItems(query: string): ExtensionPaletteItem[] {
  const spaces = webExtension('space')?.store.spacesWithTasks.value ?? [];
  const limit = query.trim() ? 5 : 3;
  return [...spaceItems(spaces, query, limit), ...taskItemsFromSpaces(spaces, query, limit)];
}

export function warmSpacePalette(): void {
  webExtension('space')
    ?.store.initGlobalList()
    .catch(() => {});
}

export function spacePaletteSource(): unknown {
  return webExtension('space')?.store.spacesWithTasks.value;
}

export function openSpaceSearchResult({ spaceId, taskId }: ExtensionSearchResult): boolean {
  if (!spaceId || !taskId) return false;
  navigateToSpaceTask(spaceId, taskId);
  return true;
}
