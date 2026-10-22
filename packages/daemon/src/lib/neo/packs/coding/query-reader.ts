import type { Database } from '../../../../storage/sqlite-compat.ts';
import { spawnProcess, type SpawnFn } from '../../../runtime-spawn/index.ts';
import type { NeoGithubLister } from './github-query.ts';
import { CodingPrLedgerRepository } from './pr-ledger.ts';

export function createCodingQueryReader(
  db: () => Database,
  spawn: SpawnFn = spawnProcess,
  now = Date.now
): NeoGithubLister {
  let ledger: CodingPrLedgerRepository | undefined;
  return async (_args, coverage) => {
    ledger ??= new CodingPrLedgerRepository(db());
    const fact = await ledger.queryFacts.refresh(coverage, spawn, now);
    return {
      data: fact.view.status === 'known' ? fact.view.value : null,
      at: new Date(fact.view.observedAt ?? now()).toISOString(),
      coverage: fact.coverage.query,
    };
  };
}
