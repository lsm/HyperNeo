import type { Database } from '../../../../storage/sqlite-compat.ts';
import { parsePrUrl } from '../../../github/parse-pr-url.ts';
import { type SpawnFn, spawnProcess } from '../../../runtime-spawn/index.ts';
import { CodingMergeFactsRepository } from './merge-facts.ts';

export function createCodingMergeReader(
  db: () => Database,
  spawn: SpawnFn = spawnProcess,
  now = Date.now
) {
  let facts: CodingMergeFactsRepository | undefined;
  return async (url: string): Promise<string | null> => {
    const pr = parsePrUrl(url.toLowerCase());
    if (!pr) return null;
    facts ??= new CodingMergeFactsRepository(db());
    const repo = `${pr.host === 'github.com' ? '' : `${pr.host}/`}${pr.owner}/${pr.repo}`;
    const found = await facts.refresh(repo, Number(pr.number), spawn, now);
    return found.merge.status === 'known' && found.merge.value.state === 'MERGED'
      ? found.merge.value.mergeCommit
      : null;
  };
}
