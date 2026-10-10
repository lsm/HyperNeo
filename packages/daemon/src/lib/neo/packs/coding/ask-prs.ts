import type { NeoAsk } from '@hyperneo/shared/types/neo-snapshot';
import { homedir } from 'node:os';
import { z } from 'zod';
import { runGhJson } from '../../../github/gh-lookup-helpers.ts';
import { spawnProcess, type SpawnFn } from '../../../runtime-spawn/index.ts';
import type { NeoEvidence } from '../../evidence.ts';

export type NeoRef = { owner: string; repo: string; number: number };
export type NeoRefState = {
  url: string;
  kind: 'pr' | 'issue';
  state: 'OPEN' | 'MERGED' | 'CLOSED';
  at: number | null;
  done: boolean;
  closedBy: string | null;
};
export type NeoRefStateReader = (refs: readonly NeoRef[]) => Promise<NeoRefState[]>;

const REF_URL = /https:\/\/github\.com\/([\w.-]+)\/([\w.-]+)\/(?:pull|issues)\/(\d+)/g;
const REF_NAME = /(?<![\w./-])([\w.-]+)\/([\w.-]+)#(\d+)\b/g;
const REF_BARE = /(?<![\w./#-])#(\d+)\b/g;
const NEO_ASK_REF_MAX = 10;
const NOT_A_REF = /could not resolve to (an issue or pull request|a repository)/i;
const REF_QUERY = `query($o:String!,$n:String!,$p:Int!){repository(owner:$o,name:$n){issueOrPullRequest(number:$p){__typename ...on PullRequest{url state mergedAt closedAt} ...on Issue{url state stateReason closedAt closedByPullRequestsReferences(first:5,includeClosedPrs:true){nodes{url merged}}}}}}`;
const GhRefSchema = z.object({
  data: z.object({
    repository: z.object({
      issueOrPullRequest: z.discriminatedUnion('__typename', [
        z.object({
          __typename: z.literal('PullRequest'),
          url: z.string(),
          state: z.enum(['OPEN', 'MERGED', 'CLOSED']),
          mergedAt: z.string().nullish(),
          closedAt: z.string().nullish(),
        }),
        z.object({
          __typename: z.literal('Issue'),
          url: z.string(),
          state: z.enum(['OPEN', 'CLOSED']),
          stateReason: z.string().nullish(),
          closedAt: z.string().nullish(),
          closedByPullRequestsReferences: z
            .object({ nodes: z.array(z.object({ url: z.string(), merged: z.boolean() })) })
            .nullish(),
        }),
      ]),
    }),
  }),
});
const settled = new Map<string, NeoRefState | null>();

const refKey = (ref: NeoRef) => `${ref.owner}/${ref.repo}#${ref.number}`.toLowerCase();

export function neoRefFromUrl(url: string): NeoRef | null {
  const [, owner, repo, number] = /github\.com\/([\w.-]+)\/([\w.-]+)\/(?:pull|issues)\/(\d+)/.exec(
    url
  ) ?? [null];
  return owner && repo && number ? { owner, repo, number: Number(number) } : null;
}

export function extractNeoAskRefs(
  ask: Pick<NeoAsk, 'ask' | 'doneWhen' | 'outcome' | 'evidence' | 'doneItems'>,
  tracked: readonly string[]
): NeoRef[] {
  const text = [
    ask.ask,
    ask.doneWhen,
    ask.outcome,
    ask.evidence,
    ...(ask.doneItems ?? []).flatMap((item) => [item.text, item.evidence]),
  ]
    .filter(Boolean)
    .join('\n');
  const named = [...text.matchAll(REF_URL), ...text.matchAll(REF_NAME)].map(
    ([, owner, repo, number]) => ({ owner, repo, number: Number(number) })
  );
  const cards = tracked.flatMap((url) => neoRefFromUrl(url) ?? []);
  const repos = new Map(
    [...named, ...cards].map((ref) => [`${ref.owner}/${ref.repo}`.toLowerCase(), ref] as const)
  );
  const only = repos.size === 1 ? [...repos.values()][0] : null;
  const bare = only
    ? [...text.matchAll(REF_BARE)].map(([, number]) => ({
        owner: only.owner,
        repo: only.repo,
        number: Number(number),
      }))
    : [];
  const skip = new Set(cards.map(refKey));
  const refs = new Map(
    [...named, ...bare].filter((ref) => !skip.has(refKey(ref))).map((ref) => [refKey(ref), ref])
  );
  return [...refs.values()].slice(0, NEO_ASK_REF_MAX);
}

export function neoAskCardRefs(
  named: readonly NeoRef[],
  running: readonly string[],
  tracked: readonly string[]
): NeoRef[] {
  const refs = new Map(named.map((ref) => [refKey(ref), ref]));
  for (const url of running.filter((item) => !tracked.includes(item))) {
    const ref = neoRefFromUrl(url);
    if (ref && !refs.has(refKey(ref))) refs.set(refKey(ref), ref);
  }
  return [...refs.values()];
}

export function neoAskRefNews(states: readonly NeoRefState[], since: number): NeoEvidence[] {
  return states.flatMap((ref) => {
    if (ref.state === 'OPEN' || ref.at === null || ref.at <= since) return [];
    const summary =
      ref.kind === 'pr'
        ? ref.done
          ? 'merged'
          : 'closed unmerged'
        : ref.done
          ? `closed as completed${ref.closedBy ? ` by ${ref.closedBy}` : ''}`
          : 'closed as not planned';
    return [
      {
        key: ref.url,
        state: ref.done ? ('done' as const) : ('failed' as const),
        summary,
        blockers: [],
      },
    ];
  });
}

async function readGithubRefState(ref: NeoRef, spawnImpl: SpawnFn): Promise<NeoRefState | null> {
  const key = refKey(ref);
  if (settled.has(key)) return settled.get(key) ?? null;
  const outcome = await runGhJson(
    [
      'gh',
      'api',
      'graphql',
      '-f',
      `query=${REF_QUERY}`,
      '-f',
      `o=${ref.owner}`,
      '-f',
      `n=${ref.repo}`,
      '-F',
      `p=${ref.number}`,
    ],
    homedir(),
    spawnImpl,
    { resourceHint: 'graphql' }
  );
  const parsed = outcome.ok ? GhRefSchema.safeParse(outcome.data) : null;
  if (!parsed?.success) {
    if (!outcome.ok && NOT_A_REF.test(outcome.error)) settled.set(key, null);
    return null;
  }
  const found = parsed.data.data.repository.issueOrPullRequest;
  const closed = found.state !== 'OPEN';
  const state: NeoRefState =
    found.__typename === 'PullRequest'
      ? {
          url: found.url,
          kind: 'pr',
          state: found.state,
          at:
            Date.parse((found.state === 'MERGED' ? found.mergedAt : found.closedAt) ?? '') || null,
          done: found.state === 'MERGED',
          closedBy: null,
        }
      : {
          url: found.url,
          kind: 'issue',
          state: found.state,
          at: closed ? Date.parse(found.closedAt ?? '') || null : null,
          done: closed && found.stateReason !== 'NOT_PLANNED',
          closedBy:
            found.closedByPullRequestsReferences?.nodes.find((pr) => pr.merged)?.url ?? null,
        };
  if (state.kind === 'pr' && state.done) settled.set(key, state);
  return state;
}

export async function readGithubRefStates(
  refs: readonly NeoRef[],
  spawnImpl: SpawnFn = spawnProcess
): Promise<NeoRefState[]> {
  const states: NeoRefState[] = [];
  for (const ref of refs) {
    const state = await readGithubRefState(ref, spawnImpl);
    if (state) states.push(state);
  }
  return states;
}
