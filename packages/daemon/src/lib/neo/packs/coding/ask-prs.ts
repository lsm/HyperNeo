import type { NeoAsk } from '@hyperneo/shared/types/neo-snapshot';
import { homedir } from 'node:os';
import { z } from 'zod';
import { runGhJson } from '../../../github/gh-lookup-helpers.ts';
import { spawnProcess, type SpawnFn } from '../../../runtime-spawn/index.ts';
import type { NeoEvidence } from '../../evidence.ts';

export type NeoPrState = { url: string; state: 'OPEN' | 'MERGED' | 'CLOSED'; at: number | null };
export type NeoPrStateReader = (urls: readonly string[]) => Promise<NeoPrState[]>;

const PR_URL = /https:\/\/github\.com\/([\w.-]+)\/([\w.-]+)\/pull\/(\d+)/g;
const PR_REF = /(?<![\w./-])([\w.-]+)\/([\w.-]+)#(\d+)\b/g;
const NEO_ASK_PR_MAX = 10;
const NOT_A_PR = /could not resolve to a (pullrequest|repository)/i;
const GhPrStateSchema = z.object({
  url: z.string(),
  state: z.enum(['OPEN', 'MERGED', 'CLOSED']),
  mergedAt: z.string().nullish(),
  closedAt: z.string().nullish(),
});
const settled = new Map<string, NeoPrState | null>();

export function extractNeoAskPrUrls(
  ask: Pick<NeoAsk, 'ask' | 'doneWhen' | 'outcome' | 'evidence' | 'doneItems'>,
  tracked: ReadonlySet<string>
): string[] {
  const text = [
    ask.ask,
    ask.doneWhen,
    ask.outcome,
    ask.evidence,
    ...(ask.doneItems ?? []).flatMap((item) => [item.text, item.evidence]),
  ]
    .filter(Boolean)
    .join('\n');
  const urls = [...text.matchAll(PR_URL), ...text.matchAll(PR_REF)].map(
    ([, owner, repo, number]) => `https://github.com/${owner}/${repo}/pull/${number}`
  );
  return [...new Set(urls)].filter((url) => !tracked.has(url)).slice(0, NEO_ASK_PR_MAX);
}

export function neoAskPrNews(states: readonly NeoPrState[], since: number): NeoEvidence[] {
  return states.flatMap((pr) =>
    pr.state === 'OPEN' || pr.at === null || pr.at <= since
      ? []
      : [
          {
            key: pr.url,
            state: pr.state === 'MERGED' ? ('done' as const) : ('failed' as const),
            summary: pr.state === 'MERGED' ? 'merged' : 'closed unmerged',
            blockers: [],
          },
        ]
  );
}

async function readGithubPrState(url: string, spawnImpl: SpawnFn): Promise<NeoPrState | null> {
  if (settled.has(url)) return settled.get(url) ?? null;
  const outcome = await runGhJson(
    ['gh', 'pr', 'view', url, '--json', 'url,state,mergedAt,closedAt'],
    homedir(),
    spawnImpl,
    { resourceHint: 'graphql' }
  );
  const parsed = outcome.ok ? GhPrStateSchema.safeParse(outcome.data) : null;
  if (!parsed?.success) {
    if (!outcome.ok && NOT_A_PR.test(outcome.error)) settled.set(url, null);
    return null;
  }
  const { state, mergedAt, closedAt } = parsed.data;
  const at = state === 'MERGED' ? mergedAt : state === 'CLOSED' ? closedAt : null;
  const pr = { url, state, at: at ? Date.parse(at) : null };
  if (state !== 'OPEN') settled.set(url, pr);
  return pr;
}

export async function readGithubPrStates(
  urls: readonly string[],
  spawnImpl: SpawnFn = spawnProcess
): Promise<NeoPrState[]> {
  const states: NeoPrState[] = [];
  for (const url of urls) {
    const pr = await readGithubPrState(url, spawnImpl);
    if (pr) states.push(pr);
  }
  return states;
}
