import type { Database } from '../../../../storage/sqlite-compat.ts';
import { spawnProcess, type SpawnFn } from '../../../runtime-spawn/index.ts';
import { githubUrlKey } from '../../../github/parse-pr-url.ts';
import { CodingPrLedgerRepository } from './pr-ledger.ts';
import { NEO_SETTLED_PR_READ_MS, NEO_WORK_PR_READ_MS, type NeoWorkPrReader } from './work-prs.ts';

export function createCodingWorkPrReader(
  db: () => Database,
  spawn: SpawnFn = spawnProcess,
  now = Date.now
): NeoWorkPrReader {
  let ledger: CodingPrLedgerRepository | undefined;
  return async (urls) => {
    ledger ??= new CodingPrLedgerRepository(db());
    const unique = [...new Map(urls.map((url) => [githubUrlKey(url), url])).values()];
    const prs = await Promise.all(
      unique.map(async (url) => {
        const current = await ledger!.workFacts.readCurrent(url, now(), NEO_SETTLED_PR_READ_MS);
        if (current.view.status === 'known') {
          const maxAgeMs =
            current.view.value.state === 'OPEN' ? NEO_WORK_PR_READ_MS : NEO_SETTLED_PR_READ_MS;
          if (current.view.observedAt !== null && now() - current.view.observedAt < maxAgeMs)
            return current.view.value;
        }
        const fresh = await ledger!.workFacts.refresh(url, spawn, now);
        return fresh.view.status === 'known' ? fresh.view.value : null;
      })
    );
    const read = prs.flatMap((pr) => (pr ? [pr] : []));
    return read.length || !urls.length ? read : null;
  };
}
