import { homedir } from 'node:os';
import { z } from 'zod';
import superpipe, { type PipelineAPI } from 'superpipe';
import { Node } from './pr-ledger.ts';
import { runGhJson } from '../../../github/gh-lookup-helpers.ts';
import { Logger } from '../../../logger.ts';
import { spawnProcess } from '../../../runtime-spawn/index.ts';

export type CodingLedgerRead = (repo: string) => Promise<unknown | null>;

const log = new Logger('NeoCodingLedger');

const DONE_FIELDS =
  'number title headRefName headRefOid state isDraft mergeable reviewDecision closedAt createdAt';

const FIELDS = `${DONE_FIELDS}
  files(first: 100) { nodes { path } pageInfo { hasNextPage } }
  reviews(last: 30, states: [APPROVED, CHANGES_REQUESTED]) { nodes { state commit { oid } author { login } } }
  author { login __typename }
  comments(last: 10) { nodes { author { login } createdAt } }
  replies: reviews(last: 10, states: [COMMENTED]) { nodes { author { login } submittedAt } }
  commits(last: 1) { nodes { commit { statusCheckRollup { state } checkSuites(first: 1) { totalCount } } } }`;

export function codingLedgerArgs(repo: string, numbers: readonly number[] = []): string[] {
  const [owner, name] = repo.split('/');
  return [
    'gh',
    'api',
    'graphql',
    '-f',
    `query=query($o: String!, $n: String!) {
      rateLimit { cost remaining resetAt }
      repository(owner: $o, name: $n) {
        nameWithOwner
        ${numbers.map((number) => `p${number}: pullRequest(number: ${number}) { ${FIELDS} }`).join('\n')}
      }
    }`,
    '-f',
    `o=${owner}`,
    '-f',
    `n=${name}`,
  ];
}

const Pull = z.object({
  number: z.number().int().positive(),
  title: z.string(),
  head: z.object({ ref: z.string(), sha: z.string() }),
  updated_at: z.string(),
  created_at: z.string(),
  closed_at: z.string().nullable(),
  merged_at: z.string().nullable().optional(),
  draft: z.boolean(),
  base: z.object({ repo: z.object({ full_name: z.string() }) }),
});
const Budget = z.object({ cost: z.number(), remaining: z.number(), resetAt: z.string() });
const Hydration = z.object({
  data: z.object({
    rateLimit: Budget,
    repository: z.object({ nameWithOwner: z.string() }).catchall(z.unknown()),
  }),
  errors: z.array(z.unknown()).optional(),
});
type CachedFact = { updated: string; at: number; value: z.infer<typeof Node> };
const IDLE_MS = 30 * 60_000;
const HEAD_REFRESH_MS = 5 * 60_000;
const selectHeads = (superpipe({})('coding-ledger-hydration') as PipelineAPI)
  .input(['pulls', 'cached', 'now'])
  .pipe(
    (pulls: z.infer<typeof Pull>[], cached: Map<string, CachedFact>, now: number) =>
      pulls.filter((pr) => {
        const hit = cached.get(`${pr.number}:${pr.head.sha}`);
        const ci = hit?.value.commits.nodes[0]?.commit.statusCheckRollup?.state;
        return (
          !hit ||
          hit.updated !== pr.updated_at ||
          now - hit.at >= HEAD_REFRESH_MS ||
          hit.value.mergeable === 'UNKNOWN' ||
          (ci !== undefined && ci !== 'SUCCESS' && ci !== null)
        );
      }),
    ['pulls', 'cached', 'now'],
    'selected'
  )
  .end('selected');
export function createCodingLedgerReader(
  run: (args: string[], resource: 'core' | 'graphql') => ReturnType<typeof runGhJson> = (
    args,
    resourceHint
  ) => runGhJson(args, homedir(), spawnProcess, { resourceHint })
): CodingLedgerRead {
  const repos = new Map<
    string,
    {
      facts: Map<string, CachedFact>;
      response: unknown;
      idleUntil: number;
      budget: z.infer<typeof Budget> | { cost: number; remaining: null; resetAt: null };
    }
  >();
  return async (repo) => {
    const started = Date.now(),
      cached = repos.get(repo.toLowerCase());
    let budget = cached?.budget;
    if (budget?.resetAt && Date.parse(budget.resetAt) <= started) budget = undefined;
    let cost = 0,
      remaining = budget?.remaining ?? null,
      resetAt = budget?.resetAt ?? null;
    let ok = false;
    try {
      if (cached && budget && started < cached.idleUntil) {
        ok = true;
        return cached.response;
      }
      const lists: z.infer<typeof Pull>[][] = [];
      for (const [state, limit] of [
        ['open', 100],
        ['closed', 50],
      ] as const) {
        const result = await run(
          [
            'gh',
            'api',
            `repos/${repo}/pulls?state=${state}&sort=updated&direction=desc&per_page=${limit}`,
          ],
          'core'
        );
        if (!result.ok)
          return { error: result.error, retryAt: Date.now() + (result.retryAfterMs ?? 0) };
        const list = z.array(Pull).parse(result.data);
        if (state === 'open' && list.length === 100) {
          const tail = await run(
            ['gh', 'api', `repos/${repo}/pulls?state=open&per_page=100&page=2`],
            'core'
          );
          if (!tail.ok || !Array.isArray(tail.data) || tail.data.length)
            return { error: 'Incomplete open PR coverage' };
        }
        lists.push(list);
      }
      const [open, closed] = lists;
      const facts = new Map<string, CachedFact>();
      const selected = selectHeads(open, cached?.facts ?? new Map(), started) as z.infer<
        typeof Pull
      >[];
      let canonical = open[0]?.base.repo.full_name ?? closed[0]?.base.repo.full_name ?? repo;
      budget ??= {
        cost: 0,
        remaining: null,
        resetAt: null,
      };
      if (selected.length) {
        const result = await run(
          codingLedgerArgs(
            repo,
            selected.map((pr) => pr.number)
          ),
          'graphql'
        );
        if (!result.ok)
          return { error: result.error, retryAt: Date.now() + (result.retryAfterMs ?? 0) };
        const hydrated = Hydration.parse(result.data);
        budget = hydrated.data.rateLimit;
        cost += budget.cost;
        remaining = budget.remaining;
        resetAt = budget.resetAt;
        if (hydrated.errors?.length) return result.data;
        canonical = hydrated.data.repository.nameWithOwner;
        for (const pr of selected) {
          const value = Node.parse(hydrated.data.repository[`p${pr.number}`]);
          if (
            value.number !== pr.number ||
            value.headRefOid !== pr.head.sha ||
            value.state !== 'OPEN'
          )
            return { error: 'PR changed during ledger read' };
          facts.set(`${pr.number}:${pr.head.sha}`, { value, updated: pr.updated_at, at: started });
        }
      }
      for (const pr of open) {
        const key = `${pr.number}:${pr.head.sha}`;
        if (!facts.has(key)) facts.set(key, cached!.facts.get(key)!);
      }
      const response = {
        data: {
          rateLimit: { ...budget, cost },
          repository: {
            nameWithOwner: canonical,
            open: {
              pageInfo: { hasNextPage: false },
              nodes: open.map((pr) => facts.get(`${pr.number}:${pr.head.sha}`)!.value),
            },
            done: {
              nodes: closed.map((pr) => ({
                number: pr.number,
                title: pr.title,
                headRefName: pr.head.ref,
                headRefOid: pr.head.sha,
                state: pr.merged_at ? 'MERGED' : 'CLOSED',
                isDraft: pr.draft,
                mergeable: 'UNKNOWN',
                reviewDecision: null,
                closedAt: pr.closed_at,
                createdAt: pr.created_at,
              })),
            },
          },
        },
      };
      repos.set(repo.toLowerCase(), {
        facts,
        response,
        budget,
        idleUntil: open.length ? 0 : started + IDLE_MS,
      });
      ok = true;
      return response;
    } catch (error) {
      return { error: error instanceof Error ? error.message : String(error) };
    } finally {
      log.info('PR ledger sweep GitHub budget', {
        repo,
        elapsedMs: Date.now() - started,
        ok,
        cost,
        remaining,
        resetAt,
      });
    }
  };
}
export const readCodingLedgerRepo = createCodingLedgerReader();
