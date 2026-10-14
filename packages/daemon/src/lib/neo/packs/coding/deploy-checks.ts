import type { NeoAsk, NeoAskItem } from '@hyperneo/shared/types/neo-snapshot';
import { homedir } from 'node:os';
import { z } from 'zod';
import { runGhJson } from '../../../github/gh-lookup-helpers.ts';
import { githubUrlKey, parsePrUrl } from '../../../github/parse-pr-url.ts';
import { spawnProcess, type SpawnFn } from '../../../runtime-spawn/index.ts';
import type { NeoAskTick } from './issue-checks.ts';

export const CODING_CHECK_DEPLOYED = 'coding.deployed';
const NEO_DEPLOY_READ_MS = 2 * 60_000;
const lastRead = new Map<string, number>();

export type NeoDaemonCommit = { daemon: string; commit: string | null };
export type NeoDeployRead = {
  prs: { url: string; mergeCommit: string | null }[];
  daemons: (NeoDaemonCommit & { contains: string[] })[];
};
export type NeoDeployReader = (urls: readonly string[]) => Promise<NeoDeployRead>;
export type NeoDeployPlan = { item: NeoAskItem; urls: string[] };

export function isNeoDeployItem(item: NeoAskItem): boolean {
  return item.check === CODING_CHECK_DEPLOYED && !item.removed && item.state !== 'met';
}

const prUrls = (urls: readonly string[]) => [
  ...new Map(urls.filter((url) => parsePrUrl(url)).map((url) => [githubUrlKey(url), url])).values(),
];

export function planNeoDeployChecks(ask: NeoAsk, cardPrUrls: readonly string[]): NeoDeployPlan[] {
  return (ask.doneItems ?? []).filter(isNeoDeployItem).map((item) => {
    const watched = prUrls(item.watch ?? []);
    return { item, urls: watched.length ? watched : prUrls(cardPrUrls) };
  });
}

const short = (sha: string) => sha.slice(0, 10);

export function judgeNeoDeployCheck(plan: NeoDeployPlan, read: NeoDeployRead): NeoAskTick | null {
  if (!plan.urls.length || !read.daemons.length) return null;
  const merges = plan.urls.map(
    (url) => read.prs.find((pr) => githubUrlKey(pr.url) === githubUrlKey(url))?.mergeCommit ?? null
  );
  if (merges.some((sha) => !sha)) return null;
  const running = read.daemons.every(
    (daemon) => daemon.commit && merges.every((sha) => daemon.contains.includes(sha!))
  );
  if (!running) return null;
  return {
    id: plan.item.id,
    evidence: `Deployed: ${plan.urls.map((url, index) => `${url} (${short(merges[index]!)})`).join(', ')} runs on ${read.daemons.map((daemon) => `${daemon.daemon} at ${short(daemon.commit!)}`).join(', ')}`,
  };
}

export async function readNeoDeployTicks(
  ask: NeoAsk,
  cardPrUrls: readonly string[],
  readDeploys: NeoDeployReader,
  now: number
): Promise<NeoAskTick[]> {
  const plans = planNeoDeployChecks(ask, cardPrUrls).filter((plan) => plan.urls.length);
  if (!plans.length || now - (lastRead.get(ask.id) ?? -Infinity) < NEO_DEPLOY_READ_MS) return [];
  lastRead.set(ask.id, now);
  const read = await readDeploys(prUrls(plans.flatMap((plan) => plan.urls)));
  return plans.flatMap((plan) => judgeNeoDeployCheck(plan, read) ?? []);
}

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
  spawnImpl: SpawnFn = spawnProcess
): Promise<NeoDeployRead> {
  const prs = [];
  for (const url of urls) prs.push({ url, mergeCommit: await readMergeCommit(url, spawnImpl) });
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
