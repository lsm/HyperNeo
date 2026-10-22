import simpleGit from 'simple-git';
import type { Database } from '../../../../storage/sqlite-compat.ts';
import { buildGitHubLookupEnv } from '../../../github/gh-lookup-helpers.ts';
import { spawnProcess, type SpawnFn } from '../../../runtime-spawn/index.ts';
import { CodingPrLedgerRepository } from './pr-ledger.ts';
import { readCodingBranchPrs } from './branch-prs.ts';

function branchRemoteRepo(remote: string): string | null {
  const match =
    /^(?:(?:https?|ssh|git):\/\/)?(?:[^/@\s]+@)?([^/:\s]+)[:/]([^/\s]+\/[^/\s]+?)(?:\.git)?\/*$/i.exec(
      remote.trim()
    );
  return match
    ? `${match[1].toLowerCase() === 'github.com' ? '' : `${match[1]}/`}${match[2]}`.toLowerCase()
    : null;
}

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
        const git = simpleGit({ baseDir: branch.cwd, timeout: { block: 3000 } }).env(
          buildGitHubLookupEnv()
        );
        const rank = (name: string) => {
          const index = ['upstream', 'github', 'origin'].indexOf(name.toLowerCase());
          return index < 0 ? 3 : index;
        };
        const remotes = (await git.getRemotes(true))
          .map((remote) => ({
            ...remote,
            repo: branchRemoteRepo(remote.refs.fetch) ?? branchRemoteRepo(remote.refs.push),
          }))
          .filter((remote) => remote.repo)
          .sort((a, b) => rank(a.name) - rank(b.name));
        const configured = await Promise.all(
          remotes.map(async (remote) => ({
            ...remote,
            resolved: (await git.getConfig(`remote.${remote.name}.gh-resolved`)).value,
          }))
        );
        const selected = configured.find((remote) => remote.resolved) ?? configured[0];
        repo =
          selected?.resolved && selected.resolved !== 'base'
            ? (branchRemoteRepo(`https://${selected.resolved}`) ??
              branchRemoteRepo(`https://github.com/${selected.resolved}`))
            : (selected?.repo ?? null);
      } catch {
        return [];
      }
      if (!repo) return [];
      ledger ??= new CodingPrLedgerRepository(db());
      const facts = await ledger.branchFacts.refresh(repo, branch.branch, spawn, now);
      return facts.membership.status === 'known' ? facts.membership.urls : [];
    });
}
