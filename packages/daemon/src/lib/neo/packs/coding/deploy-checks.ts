import type { NeoAsk, NeoAskItem } from '@hyperneo/shared/types/neo-snapshot';
import { homedir } from 'node:os';
import { z } from 'zod';
import { runGhJson } from '../../../github/gh-lookup-helpers.ts';
import type { DaemonBuild } from '../../../remote-daemons/build-operation.ts';
import { spawnProcess, type SpawnFn } from '../../../runtime-spawn/index.ts';
import type { NeoAskTick } from './issue-checks.ts';

const NEO_DEPLOY_READ_MS = 2 * 60_000;
const lastRead = new Map<string, number>();
const mergeShas = new Map<string, string>();
const contained = new Set<string>();

export const NEO_DEPLOY_CHANGE =
  /^https:\/\/github\.com\/([\w.-]+)\/([\w.-]+)\/(?:pull\/(\d+)|commit\/([0-9a-f]{7,40}))\/?$/i;

export type NeoDeployChange = {
  url: string;
  owner: string;
  repo: string;
  pr: number | null;
  sha: string | null;
};

export interface NeoDeployReaders {
  readDaemons: () => Promise<DaemonBuild[]>;
  readChangeCommit: (change: NeoDeployChange) => Promise<string | null>;
  readContains: (change: NeoDeployChange, sha: string, running: string) => Promise<boolean | null>;
}

export function parseNeoDeployChange(url: string): NeoDeployChange | null {
  const match = NEO_DEPLOY_CHANGE.exec(url.trim());
  if (!match) return null;
  return {
    url: url.trim(),
    owner: match[1],
    repo: match[2],
    pr: match[3] ? Number(match[3]) : null,
    sha: match[4]?.toLowerCase() ?? null,
  };
}

export function isNeoDeployItem(item: NeoAskItem): boolean {
  return !!item.deploy && !item.removed && (item.state === 'pending' || item.state === 'reported');
}

export function neoDeployTargets(
  item: Pick<NeoAskItem, 'deploy'>,
  daemons: readonly DaemonBuild[]
): { value: DaemonBuild[] } | { reason: string[] } {
  const named = item.deploy?.daemons ?? [];
  if (!named.length) return { value: [...daemons] };
  const found = named.map(
    (name) =>
      daemons.find((daemon) => daemon.daemonId.toLowerCase() === name.trim().toLowerCase()) ?? name
  );
  const missing = found.filter((entry): entry is string => typeof entry === 'string');
  return missing.length
    ? { reason: missing }
    : { value: found.filter((entry): entry is DaemonBuild => typeof entry !== 'string') };
}

export function judgeNeoDeployTick(
  item: NeoAskItem,
  change: { url: string; sha: string },
  targets: readonly DaemonBuild[],
  contains: ReadonlyMap<string, boolean | null>
): NeoAskTick | null {
  if (!targets.length) return null;
  const running = targets.every(
    (daemon) => daemon.commit && contains.get(daemon.commit.toLowerCase()) === true
  );
  if (!running) return null;
  return {
    id: item.id,
    evidence: `Running ${change.url} (${change.sha.slice(0, 7)}) on ${targets
      .map((daemon) => `${daemon.daemonId} at ${daemon.commit!.slice(0, 7)}`)
      .join(', ')}, read back by the daemon.`,
  };
}

export async function readNeoDeployTicks(
  ask: NeoAsk,
  readers: NeoDeployReaders,
  now: number
): Promise<NeoAskTick[]> {
  const items = (ask.doneItems ?? []).filter(isNeoDeployItem);
  if (!items.length || now - (lastRead.get(ask.id) ?? -Infinity) < NEO_DEPLOY_READ_MS) return [];
  lastRead.set(ask.id, now);
  const daemons = await readers.readDaemons();
  const ticks: NeoAskTick[] = [];
  for (const item of items) {
    const change = parseNeoDeployChange(item.deploy!.change);
    const targets = neoDeployTargets(item, daemons);
    if (!change || !('value' in targets)) continue;
    const sha = await readers.readChangeCommit(change);
    if (!sha) continue;
    const contains = new Map<string, boolean | null>();
    for (const daemon of targets.value) {
      const running = daemon.commit?.toLowerCase();
      if (!running || contains.has(running)) continue;
      contains.set(
        running,
        running.startsWith(sha.toLowerCase()) || (await readers.readContains(change, sha, running))
      );
    }
    const tick = judgeNeoDeployTick(item, { url: change.url, sha }, targets.value, contains);
    if (tick) ticks.push(tick);
  }
  return ticks;
}

const GhPullSchema = z.object({ merged: z.boolean(), merge_commit_sha: z.string().nullable() });
const GhCompareSchema = z.object({ status: z.string() });

export async function readGithubDeployChangeCommit(
  change: NeoDeployChange,
  spawnImpl: SpawnFn = spawnProcess
): Promise<string | null> {
  if (change.sha) return change.sha;
  const key = `${change.owner}/${change.repo}#${change.pr}`.toLowerCase();
  const known = mergeShas.get(key);
  if (known) return known;
  const outcome = await runGhJson(
    ['gh', 'api', `repos/${change.owner}/${change.repo}/pulls/${change.pr}`],
    homedir(),
    spawnImpl,
    { resourceHint: 'core', stripGHRepo: true }
  );
  const parsed = outcome.ok ? GhPullSchema.safeParse(outcome.data) : null;
  const sha = parsed?.success && parsed.data.merged ? parsed.data.merge_commit_sha : null;
  if (sha) mergeShas.set(key, sha);
  return sha;
}

export async function readGithubCommitContains(
  change: NeoDeployChange,
  sha: string,
  running: string,
  spawnImpl: SpawnFn = spawnProcess
): Promise<boolean | null> {
  const key = `${change.owner}/${change.repo}:${sha}...${running}`.toLowerCase();
  if (contained.has(key)) return true;
  const outcome = await runGhJson(
    ['gh', 'api', `repos/${change.owner}/${change.repo}/compare/${sha}...${running}?per_page=1`],
    homedir(),
    spawnImpl,
    { resourceHint: 'core', stripGHRepo: true }
  );
  const parsed = outcome.ok ? GhCompareSchema.safeParse(outcome.data) : null;
  if (!parsed?.success) return null;
  const contains = parsed.data.status === 'ahead' || parsed.data.status === 'identical';
  if (contains) contained.add(key);
  return contains;
}
