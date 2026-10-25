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
    const reads = await Promise.all(refs.map((ref) => facts!.refresh(ref, spawn, now, true)));
    return reads.flatMap((fact) => (fact.view.status === 'known' ? [fact.view.value] : []));
  };
}
