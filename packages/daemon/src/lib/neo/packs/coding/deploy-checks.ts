import { homedir } from 'node:os';
import { z } from 'zod';
import { runGhJson } from '../../../github/gh-lookup-helpers.ts';
import { githubUrlKey, parsePrUrl } from '../../../github/parse-pr-url.ts';
import { spawnProcess, type SpawnFn } from '../../../runtime-spawn/index.ts';

import type { NeoDaemonCommit } from '../../daemon-commits.ts';
export type NeoDeployRead = {
  prs: { url: string; mergeCommit: string | null }[];
  daemons: (NeoDaemonCommit & { contains: string[] })[];
};
export type NeoDeployReader = (urls: readonly string[]) => Promise<NeoDeployRead>;
const MergeSchema = z.object({
  state: z.string(),
  mergeCommit: z.object({ oid: z.string() }).nullable(),
});
const CompareSchema = z.object({ status: z.string() });
const merged = new Map<string, string>();
const contained = new Map<string, boolean>();

export async function readMergeCommit(
  url: string,
  spawnImpl: SpawnFn = spawnProcess
): Promise<string | null> {
  const known = merged.get(githubUrlKey(url));
  if (known) return known;
  const outcome = await runGhJson(
    ['gh', 'pr', 'view', url, '--json', 'state,mergeCommit'],
    homedir(),
    spawnImpl
  );
  const parsed = outcome.ok ? MergeSchema.safeParse(outcome.data) : null;
  const sha =
    parsed?.success && parsed.data.state === 'MERGED' ? parsed.data.mergeCommit?.oid : null;
  if (sha) merged.set(githubUrlKey(url), sha);
  return sha ?? null;
}

async function readContains(
  url: string,
  merge: string,
  commit: string,
  spawnImpl: SpawnFn
): Promise<boolean> {
  const key = `${merge}...${commit}`;
  const known = contained.get(key);
  if (known !== undefined) return known;
  const pr = parsePrUrl(url)!;
  const outcome = await runGhJson(
    ['gh', 'api', `repos/${pr.owner}/${pr.repo}/compare/${merge}...${commit}`],
    homedir(),
    spawnImpl
  );
  const parsed = outcome.ok ? CompareSchema.safeParse(outcome.data) : null;
  if (!parsed?.success) return false;
  const found = parsed.data.status === 'ahead' || parsed.data.status === 'identical';
  contained.set(key, found);
  return found;
}

export async function readGithubDeploys(
  urls: readonly string[],
  daemonCommits: () => Promise<NeoDaemonCommit[]>,
  spawnImpl: SpawnFn = spawnProcess,
  readMerge: (url: string) => Promise<string | null> = (url) => readMergeCommit(url, spawnImpl)
): Promise<NeoDeployRead> {
  const prs = [];
  for (const url of urls) prs.push({ url, mergeCommit: await readMerge(url) });
  const daemons = [];
  for (const daemon of await daemonCommits()) {
    const contains: string[] = [];
    for (const pr of prs)
      if (
        daemon.commit &&
        pr.mergeCommit &&
        (await readContains(pr.url, pr.mergeCommit, daemon.commit, spawnImpl))
      )
        contains.push(pr.mergeCommit);
    daemons.push({ ...daemon, contains });
  }
  return { prs, daemons };
}
