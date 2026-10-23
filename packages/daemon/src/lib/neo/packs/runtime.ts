import { hostname } from 'node:os';
import type { Database } from '../../../storage/sqlite-compat.ts';
import { BUILD_METADATA } from '../../build-metadata.ts';
import { remoteDaemons } from '../../remote-daemons/registry.ts';
import { readNeoDaemonCommits } from '../daemon-commits.ts';
import { createCodingBranchPrReader } from './coding/branch-reader.ts';
import { type NeoDeployReader, readGithubDeploys } from './coding/deploy-checks.ts';
import { createCodingPack } from './coding/pack.ts';
import { CodingPrEventRepository } from './coding/pr-events.ts';
import { CodingPrLedgerRepository } from './coding/pr-ledger.ts';
import { CodingPrSweepRepository } from './coding/pr-sweep.ts';
import { createCodingQueryReader } from './coding/query-reader.ts';
import { createCodingRefReader } from './coding/ref-reader.ts';
import { createCodingWorkPrReader } from './coding/work-reader.ts';
import { createLifeAdminPack } from './life-admin/pack.ts';

export function createNeoCodingReaders(db: () => Database) {
  const readDeploys: NeoDeployReader = (urls) =>
    readGithubDeploys(urls, () =>
      readNeoDaemonCommits({ name: hostname(), commit: BUILD_METADATA.commit }, remoteDaemons)
    );
  return {
    readPrs: createCodingWorkPrReader(db),
    readBranchPrs: createCodingBranchPrReader(db),
    readRefStates: createCodingRefReader(() => new CodingPrLedgerRepository(db()).refFacts),
    listGithub: createCodingQueryReader(db),
    readDeploys,
  };
}

export function createNeoBuiltinPacks(
  db: Database,
  deps: Omit<Parameters<typeof createCodingPack>[0], 'prLedger' | 'prSweep' | 'prEvents'>
) {
  return [
    createCodingPack({
      ...deps,
      prLedger: new CodingPrLedgerRepository(db),
      prSweep: new CodingPrSweepRepository(db),
      prEvents: new CodingPrEventRepository(db),
    }),
    createLifeAdminPack(),
  ];
}
