import type { NeoSnapshot } from '@hyperneo/shared/types/neo-snapshot';
import superpipe, { type PipelineAPI } from 'superpipe';
import { publicationConversationId, type NeoPublicationState } from './useNeoPublications.ts';

type AuthorSources = { snapshot: NeoSnapshot; publications: NeoPublicationState };
type AuthorLabels = ReadonlyMap<string, string>;

export function admitNeoPublicAuthorSources(
  snapshot: NeoSnapshot | null,
  publications: NeoPublicationState
): { value: AuthorSources } | { reason: AuthorLabels } {
  const id = publicationConversationId(snapshot?.sessionId ?? null);
  return snapshot &&
    id &&
    publications.conversationId === id &&
    publications.items.length <= 500 &&
    publications.items.every((item) => item.conversationId === id)
    ? { value: { snapshot, publications } }
    : { reason: new Map() };
}

export function presentNeoPublicAuthors({ snapshot, publications }: AuthorSources): AuthorLabels {
  const titles = new Map<string, Set<string>>();
  for (const concern of snapshot.concerns) {
    const labels = titles.get(concern.id) ?? new Set<string>();
    labels.add(concern.title);
    titles.set(concern.id, labels);
  }
  const holders = new Map<string, Set<string>>();
  for (const association of [
    ...(snapshot.consultations ?? []),
    ...(snapshot.consultationWaiters ?? []),
  ]) {
    const concerns = holders.get(association.sessionId) ?? new Set<string>();
    concerns.add(association.concernId);
    holders.set(association.sessionId, concerns);
  }
  const workers = new Set(
    snapshot.work.flatMap((work) => (work.sessionId ? [work.sessionId] : []))
  );
  const labels = new Map<string, string>();
  for (const publication of publications.items) {
    const producer = publication.producerInput.sessionId;
    if (producer === snapshot.sessionId) {
      labels.set(producer, 'Neo');
      continue;
    }
    const concerns = holders.get(producer);
    if (workers.has(producer) || concerns?.size !== 1) continue;
    const names = titles.get([...concerns][0]);
    const name = names?.size === 1 ? [...names][0] : null;
    if (name?.trim()) labels.set(producer, name);
  }
  return labels;
}

export const projectNeoPublicAuthors = (superpipe({})('neo-public-author-labels') as PipelineAPI)
  .input(['snapshot', 'publications'])
  .pipe(admitNeoPublicAuthorSources, ['snapshot', 'publications'], 'result:authors')
  .pipe(presentNeoPublicAuthors, 'authors', 'authors')
  .end('authors') as (
  snapshot: NeoSnapshot | null,
  publications: NeoPublicationState
) => AuthorLabels;
