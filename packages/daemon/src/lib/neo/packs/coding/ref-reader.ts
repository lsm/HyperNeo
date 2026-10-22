import type { CodingRefFactsRepository } from './ref-facts.ts';
import type { NeoRefStateReader } from './ask-prs.ts';
import { spawnProcess, type SpawnFn } from '../../../runtime-spawn/index.ts';

export function createCodingRefReader(
  getFacts: () => CodingRefFactsRepository,
  spawn: SpawnFn = spawnProcess,
  now = Date.now
): NeoRefStateReader {
  let facts: CodingRefFactsRepository | undefined;
  return async (refs) => {
    facts ??= getFacts();
    const reads = await Promise.all(
      refs.map(async (ref) => {
        const known = facts!.read(ref, now());
        return known.view.status === 'known' &&
          known.view.value.kind === 'pr' &&
          known.view.value.done
          ? known
          : facts!.refresh(ref, spawn, now);
      })
    );
    return reads.flatMap((fact) => (fact.view.status === 'known' ? [fact.view.value] : []));
  };
}
