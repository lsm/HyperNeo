import type { Database } from '../../../../storage/sqlite-compat.ts';
import { spawnProcess, type SpawnFn } from '../../../runtime-spawn/index.ts';
import { CodingPrLedgerRepository } from './pr-ledger.ts';
import type { NeoWorkPrReader } from './work-prs.ts';

export function createCodingWorkPrReader(
  db: () => Database,
  spawn: SpawnFn = spawnProcess,
  now = Date.now
): NeoWorkPrReader {
  let ledger: CodingPrLedgerRepository | undefined;
  return async (urls) => {
    ledger ??= new CodingPrLedgerRepository(db());
    const facts = await Promise.all(urls.map((url) => ledger!.workFacts.refresh(url, spawn, now)));
    const prs = facts.flatMap((fact) => (fact.view.status === 'known' ? [fact.view.value] : []));
    return prs.length || !urls.length ? prs : null;
  };
}
