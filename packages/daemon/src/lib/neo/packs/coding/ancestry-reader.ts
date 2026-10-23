import type { Database } from '../../../../storage/sqlite-compat.ts';
import { parsePrUrl } from '../../../github/parse-pr-url.ts';
import { type SpawnFn, spawnProcess } from '../../../runtime-spawn/index.ts';
import { CodingPrLedgerRepository } from './pr-ledger.ts';

export function createCodingAncestryReader(
  db: () => Database,
  spawn: SpawnFn = spawnProcess,
  now = Date.now
) {
  let ledger: CodingPrLedgerRepository | undefined;
  return async (url: string, baseOid: string, headOid: string): Promise<boolean> => {
    const pr = parsePrUrl(url.toLowerCase());
    if (!pr) return false;
    const host = pr.host === 'www.github.com' ? 'github.com' : pr.host;
    const repo = `${host === 'github.com' ? '' : `${host}/`}${pr.owner}/${pr.repo}`;
    ledger ??= new CodingPrLedgerRepository(db());
    const fact = await ledger.ancestryFacts.refresh({ repo, baseOid, headOid }, spawn, now);
    return fact.ancestry.status === 'known' && fact.ancestry.contains;
  };
}
