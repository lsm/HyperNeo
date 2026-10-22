import type { NeoAsk } from '@hyperneo/shared/types/neo-snapshot';
import { homedir } from 'node:os';
import { z } from 'zod';
import { runGhJson } from '../../../github/gh-lookup-helpers.ts';
import {
  GITHUB_REF_PATH,
  githubGraphqlArgs,
  parseGitHubRefUrl,
} from '../../../github/parse-pr-url.ts';
import { spawnProcess, type SpawnFn } from '../../../runtime-spawn/index.ts';

export type NeoRef = { owner: string; repo: string; number: number };
export type NeoRefState = {
  title?: string;
  url: string;
  kind: 'pr' | 'issue';
  state: 'OPEN' | 'MERGED' | 'CLOSED';
  at: number | null;
  done: boolean;
  closedBy: string | null;
  base?: string | null;
  merges?: { url: string; base: string | null; at?: number | null }[];
  defaultBase?: string | null;
  duplicate?: true;
  createdAt?: number | null;
  parent?: { url: string; at: number | null } | null;
};
export type NeoRefStateReader = (refs: readonly NeoRef[]) => Promise<NeoRefState[]>;

const REF_URL = new RegExp(`https://${GITHUB_REF_PATH.source}`, 'g');
const REF_NAME = /(?<![\w./-])([\w.-]+)\/([\w.-]+)#(\d+)\b/g;
const REF_BARE = /(?<![\w./#-])#(\d+)\b/g;
const NEO_ASK_REF_MAX = 10;
const NOT_A_REF = /could not resolve to (an issue or pull request|a repository)/i;
const REF_QUERY = `query($o:String!,$n:String!,$p:Int!){repository(owner:$o,name:$n){defaultBranchRef{name} issueOrPullRequest(number:$p){__typename ...on PullRequest{url state mergedAt closedAt baseRefName} ...on Issue{url title state stateReason createdAt closedAt parent{url} timelineItems(last:1,itemTypes:[PARENT_ISSUE_ADDED_EVENT]){nodes{...on ParentIssueAddedEvent{createdAt}}} closedByPullRequestsReferences(first:10,includeClosedPrs:true){nodes{url merged mergedAt baseRefName}}}}}}`;
const GhRefSchema = z.object({
  data: z.object({
    repository: z.object({
      defaultBranchRef: z.object({ name: z.string() }).nullish(),
      issueOrPullRequest: z.discriminatedUnion('__typename', [
        z.object({
          __typename: z.literal('PullRequest'),
          url: z.string(),
          state: z.enum(['OPEN', 'MERGED', 'CLOSED']),
          mergedAt: z.string().nullish(),
          closedAt: z.string().nullish(),
          baseRefName: z.string().nullish(),
        }),
        z.object({
          __typename: z.literal('Issue'),
          title: z.string().optional(),
          url: z.string(),
          state: z.enum(['OPEN', 'CLOSED']),
          stateReason: z.string().nullish(),
          createdAt: z.string().nullish(),
          closedAt: z.string().nullish(),
          parent: z.object({ url: z.string() }).nullish(),
          timelineItems: z
            .object({ nodes: z.array(z.object({ createdAt: z.string().nullish() }).nullable()) })
            .nullish(),
          closedByPullRequestsReferences: z
            .object({
              nodes: z.array(
                z.object({
                  url: z.string(),
                  merged: z.boolean(),
                  mergedAt: z.string().nullish(),
                  baseRefName: z.string().nullish(),
                })
              ),
            })
            .nullish(),
        }),
      ]),
    }),
  }),
});
const settled = new Map<string, NeoRefState>();
const missing = new Map<string, number>();
const NEO_REF_MISSING_MS = 60 * 60_000;

const refKey = (ref: NeoRef) => `${ref.owner}/${ref.repo}#${ref.number}`.toLowerCase();

function neoRefFromUrl(url: string): NeoRef | null {
  return parseGitHubRefUrl(url);
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

export function extractNeoCardRefs(
  text: string,
  repo: Pick<NeoRef, 'owner' | 'repo'> | null
): NeoRef[] {
  const named = [...text.matchAll(REF_NAME)].map(([, owner, name, number]) => ({
    owner,
    repo: name,
    number: Number(number),
  }));
  const bare = repo
    ? [...text.matchAll(REF_BARE)].map(([, number]) => ({ ...repo, number: Number(number) }))
    : [];
  return [...new Map([...named, ...bare].map((ref) => [refKey(ref), ref])).values()].slice(
    0,
    NEO_ASK_REF_MAX
  );
}

async function readGithubRefState(
  ref: NeoRef,
  spawnImpl: SpawnFn,
  fresh: boolean
): Promise<NeoRefState | null> {
  const key = refKey(ref);
  const done = fresh ? undefined : settled.get(key);
  if (done) return done;
  const gone = missing.get(key);
  if (!fresh && gone !== undefined && Date.now() - gone < NEO_REF_MISSING_MS) return null;
  const outcome = await runGhJson(githubGraphqlArgs(REF_QUERY, ref), homedir(), spawnImpl, {
    resourceHint: 'graphql',
  });
  const parsed = outcome.ok ? GhRefSchema.safeParse(outcome.data) : null;
  if (!parsed?.success) {
    if (!fresh && !outcome.ok && NOT_A_REF.test(outcome.error)) missing.set(key, Date.now());
    return null;
  }
  const found = parsed.data.data.repository.issueOrPullRequest;
  const defaultBase = parsed.data.data.repository.defaultBranchRef?.name ?? null;
  const closed = found.state !== 'OPEN';
  const closing =
    found.__typename === 'Issue'
      ? found.closedByPullRequestsReferences?.nodes.find((pr) => pr.merged)
      : undefined;
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
          base: found.baseRefName ?? null,
          defaultBase,
        }
      : {
          url: found.url,
          kind: 'issue',
          ...(found.title ? { title: found.title } : {}),
          state: found.state,
          at: closed ? Date.parse(found.closedAt ?? '') || null : null,
          done: closed && found.stateReason === 'COMPLETED',
          ...(closed && found.stateReason === 'DUPLICATE' ? { duplicate: true as const } : {}),
          closedBy: closing?.url ?? null,
          base: closing?.baseRefName ?? null,
          merges: (found.closedByPullRequestsReferences?.nodes ?? [])
            .filter((pr) => pr.merged)
            .map((pr) => ({
              url: pr.url,
              base: pr.baseRefName ?? null,
              at: Date.parse(pr.mergedAt ?? '') || null,
            })),
          defaultBase,
          createdAt: Date.parse(found.createdAt ?? '') || null,
          parent: found.parent
            ? {
                url: found.parent.url,
                at: Date.parse(found.timelineItems?.nodes.at(-1)?.createdAt ?? '') || null,
              }
            : null,
        };
  if (!fresh && state.kind === 'pr' && state.done) settled.set(key, state);
  return state;
}

export async function readGithubRefStates(
  refs: readonly NeoRef[],
  spawnImpl: SpawnFn = spawnProcess,
  fresh = false
): Promise<NeoRefState[]> {
  const states: NeoRefState[] = [];
  for (const ref of refs) {
    const state = await readGithubRefState(ref, spawnImpl, fresh);
    if (state) states.push(state);
  }
  return states;
}
