import { parseGitHubRefUrl } from '../github/parse-pr-url.ts';
import type { NeoProject } from '@hyperneo/shared/types/neo-context';
import { neoProjectPath } from '@hyperneo/shared/types/neo-project-tree';
import {
  extractNeoCardRefs,
  readGithubRefStates,
  type NeoRefState,
  type NeoRefStateReader,
} from './packs/coding/ask-prs.ts';
import type { NeoProjectFact } from './project-route-facts.ts';

export function createNeoSectionRefReader(
  read: NeoRefStateReader = readGithubRefStates,
  now: () => number = Date.now
): NeoRefStateReader {
  const cache = new Map<string, { expiresAt: number; pending: Promise<NeoRefState[]> }>();
  return async (refs) => {
    const states: NeoRefState[] = [];
    for (const ref of refs) {
      const key = `${ref.owner}/${ref.repo}#${ref.number}`.toLowerCase();
      let entry = cache.get(key);
      if (!entry || entry.expiresAt <= now()) {
        cache.delete(key);
        if (cache.size >= 256) cache.delete(cache.keys().next().value!);
        entry = { expiresAt: now() + 30_000, pending: read([ref]) };
        cache.set(key, entry);
      }
      try {
        states.push(...(await entry.pending));
      } catch (error) {
        if (cache.get(key) === entry) cache.delete(key);
        throw error;
      }
    }
    return states;
  };
}

const readSectionRefs = createNeoSectionRefReader();

export async function readNeoSectionFacts(
  text: string,
  facts: readonly NeoProjectFact[],
  projects: readonly NeoProject[],
  read: NeoRefStateReader = readSectionRefs
): Promise<NeoProjectFact[]> {
  const sections = projects.filter((project) => project.epicUrl);
  if (!sections.length) return [...facts];
  const routes = new Map<string, string>();
  const urls = [
    ...text.matchAll(/https?:\/\/github\.com\/[\w.-]+\/[\w.-]+\/(?:issues|pull)\/\d+/g),
  ].flatMap(([url]) => parseGitHubRefUrl(url) ?? []);
  const refs = [
    ...new Map(
      [...urls, ...extractNeoCardRefs(text, null)].map((ref) => [
        `${ref.owner}/${ref.repo}#${ref.number}`.toLowerCase(),
        ref,
      ])
    ).values(),
  ].slice(0, 10);
  for (const ref of refs) {
    const repository = `https://github.com/${ref.owner}/${ref.repo}/issues/`.toLowerCase();
    if (!sections.some((section) => section.epicUrl?.toLowerCase().startsWith(repository)))
      continue;
    const key = `${ref.owner}/${ref.repo}#${ref.number}`.toLowerCase();
    let url = `https://github.com/${ref.owner}/${ref.repo}/issues/${ref.number}`.toLowerCase();
    const seen = new Set<string>();
    while (!seen.has(url)) {
      seen.add(url);
      const section = sections.find((project) => project.epicUrl?.toLowerCase() === url);
      if (section) {
        routes.set(key, section.id);
        break;
      }
      const current = parseGitHubRefUrl(url);
      if (!current) break;
      const [state] = await read([current]);
      if (state?.kind !== 'issue' || !state.parent) break;
      url = state.parent.url.toLowerCase();
    }
  }
  return facts.map((fact) => {
    const ref = parseGitHubRefUrl(fact.reference) ?? extractNeoCardRefs(fact.reference, null)[0];
    const section = ref && routes.get(`${ref.owner}/${ref.repo}#${ref.number}`.toLowerCase());
    return section &&
      fact.projectOnly &&
      fact.projectId &&
      neoProjectPath(projects, section).some((node) => node.id === fact.projectId)
      ? { reference: fact.reference, projectId: section }
      : fact;
  });
}
