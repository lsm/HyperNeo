import type { NeoProjectFact } from './project-route-facts.ts';

export interface NeoNamedProject {
  projectId: string;
  title: string;
  repository?: string;
}

export interface NeoNamedRouteMatch {
  start: number;
  end: number;
  fact: NeoProjectFact;
}

export function readNeoNamedProjectFacts(
  text: string,
  projects: readonly NeoNamedProject[]
): NeoNamedRouteMatch[] {
  return projects.flatMap((project) =>
    [...new Set([project.projectId, project.title.trim()].map((name) => name.toLowerCase()))]
      .filter(Boolean)
      .flatMap((name) => {
        const literal = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        const pattern = new RegExp(`(?<![\\w./-])${literal}(?![\\w/-]|\\.[\\w])`, 'gi');
        return [...text.matchAll(pattern)].map((match) => ({
          start: match.index,
          end: match.index + match[0].length,
          fact: { reference: match[0], projectId: project.projectId },
        }));
      })
  );
}

export function selectNeoNamedRouteFacts(matches: readonly NeoNamedRouteMatch[]): NeoProjectFact[] {
  return matches
    .filter(
      (match) =>
        !matches.some(
          (other) =>
            other.start <= match.start &&
            other.end >= match.end &&
            other.end - other.start > match.end - match.start
        )
    )
    .map((match) => match.fact);
}
