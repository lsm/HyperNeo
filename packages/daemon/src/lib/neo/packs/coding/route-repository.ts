import type { NeoNamedProject, NeoNamedRouteMatch } from '../../named-route-facts.ts';

export function readNeoNamedRepositoryFacts(
  text: string,
  projects: readonly NeoNamedProject[]
): NeoNamedRouteMatch[] {
  return projects.flatMap(({ projectId, repository }) => {
    if (!repository) return [];
    const name = repository.replace(/^github\.com\//i, '').replace(/\.git$/i, '');
    const literal = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const short = name
      .split('/')
      .at(-1)!
      .replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const pattern = new RegExp(
      `(?<![\\w./-])(?:(?:(?:https?://)?github\\.com/|git@github\\.com:)?${literal}(?:\\.git)?/?|${short})(?![\\w/#-]|\\.[\\w])`,
      'gi'
    );
    return [...text.matchAll(pattern)].map((match) => ({
      start: match.index,
      end: match.index + match[0].length,
      fact: { reference: match[0], projectId },
    }));
  });
}
