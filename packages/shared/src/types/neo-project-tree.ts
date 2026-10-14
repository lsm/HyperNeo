import type { NeoProject } from './neo-context.ts';

export type NeoProjectNode = Pick<NeoProject, 'id' | 'parentId'>;

export function neoProjectPath<T extends NeoProjectNode>(projects: readonly T[], id: string): T[] {
  const byId = new Map(projects.map((project) => [project.id, project]));
  const path: T[] = [];
  const seen = new Set<string>();
  let node = byId.get(id);
  while (node) {
    if (seen.has(node.id)) return [];
    seen.add(node.id);
    path.unshift(node);
    if (!node.parentId) return path;
    node = byId.get(node.parentId);
    if (!node) return [];
  }
  return path;
}

export function neoProjectMoveReason(
  projects: readonly NeoProjectNode[],
  id: string,
  parentId: string | null
): string | null {
  if (!projects.some((project) => project.id === id)) return 'unknown_project';
  if (id === 'inbox' || parentId === 'inbox') return 'inbox_cannot_nest';
  if (parentId === null) return null;
  const path = neoProjectPath(projects, parentId);
  if (!path.length) return 'unknown_or_invalid_parent';
  return path.some((project) => project.id === id) ? 'project_cycle' : null;
}
