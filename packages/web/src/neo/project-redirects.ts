import type { NeoSnapshot } from '@hyperneo/shared/types/neo-snapshot';

type Redirects = NeoSnapshot['projectRedirects'];

export function resolveNeoProjectId(redirects: Redirects, id: string): string;
export function resolveNeoProjectId(redirects: Redirects, id: string | null): string | null;
export function resolveNeoProjectId(redirects: Redirects, id: string | null): string | null {
  if (id === null || !redirects?.length) return id;
  const next = new Map(redirects.map((redirect) => [redirect.sourceId, redirect.targetId]));
  const seen = new Set<string>();
  let current = id;
  while (next.has(current) && !seen.has(current)) {
    seen.add(current);
    current = next.get(current) ?? current;
  }
  return current;
}

export function findNeoProject<T extends { id: string }>(
  projects: readonly T[],
  redirects: Redirects,
  id: string | null
): T | undefined {
  const resolved = resolveNeoProjectId(redirects, id);
  return resolved === null ? undefined : projects.find((project) => project.id === resolved);
}
