import simpleGit from 'simple-git';
import type { Database } from '../../../../storage/sqlite-compat.ts';
import { buildGitHubLookupEnv } from '../../../github/gh-lookup-helpers.ts';
import { spawnProcess, type SpawnFn } from '../../../runtime-spawn/index.ts';
import { CodingPrLedgerRepository, codingRemoteRepo } from './pr-ledger.ts';
import { readCodingBranchPrs } from './branch-prs.ts';

export function createCodingBranchPrReader(
  db: () => Database,
  spawn: SpawnFn = spawnProcess,
  now = Date.now
): (query: Parameters<typeof readCodingBranchPrs>[0]) => Promise<string[]> {
  let ledger: CodingPrLedgerRepository | undefined;
  return (query) =>
    readCodingBranchPrs(query, async (branch) => {
      let repo: string | null;
      try {
        repo = codingRemoteRepo(
          await simpleGit({ baseDir: branch.cwd, timeout: { block: 3000 } })
            .env(buildGitHubLookupEnv())
            .raw(['remote', 'get-url', 'origin'])
        );
      } catch {
        return [];
      }
      if (!repo) return [];
      ledger ??= new CodingPrLedgerRepository(db());
      const facts = await ledger.branchFacts.refresh(repo, branch.branch, spawn, now);
      return facts.membership.status === 'known' ? facts.membership.urls : [];
    });
}
