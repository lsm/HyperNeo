import superpipe, { type PipelineAPI } from 'superpipe';
import { z } from 'zod';
import type { Database } from '../../../../storage/sqlite-compat.ts';
import { withBusyRetry } from '../../../../storage/busy-retry.ts';
import type { ConnectorOutcome } from '../../../github/connectors/connector.ts';
import { runGhJson } from '../../../github/gh-lookup-helpers.ts';
import { parsePrUrl } from '../../../github/parse-pr-url.ts';
import { spawnProcess, type SpawnFn } from '../../../runtime-spawn/index.ts';
import {
  isRateLimitError,
  RATE_LIMIT_MIN_BACKOFF_MS,
} from '../../../session/rate-limit-detector.ts';
import { codingConnectorPrTarget } from './connector-pr-reader.ts';

const Page = z.object({
  data: z.object({
    repository: z.object({
      pullRequest: z.object({
        url: z.string().url(),
        headRefOid: z.string().regex(/^[a-f0-9]{40}$/i),
        reviewThreads: z.object({
          nodes: z.array(
            z.object({
              id: z.string().min(1),
              isResolved: z.boolean(),
              comments: z.object({ nodes: z.array(z.object({ url: z.string().url() })) }),
            })
          ),
          pageInfo: z.object({ hasNextPage: z.boolean(), endCursor: z.string().nullable() }),
        }),
      }),
    }),
  }),
  errors: z.array(z.unknown()).optional(),
});
type Target = Extract<ReturnType<typeof codingConnectorPrTarget>, { value: unknown }>['value'];
const partial = (): ConnectorOutcome => ({
  ok: false,
  error: 'GitHub review-thread facts unavailable: partial',
});

async function fetchPages(url: string, cwd: string, spawn: SpawnFn): Promise<ConnectorOutcome> {
  const meta = parsePrUrl(url)!;
  const seen = new Set<string>();
  const unresolvedThreadUrls: string[] = [];
  let cursor: string | null = null;
  let headOid: string | null = null;
  for (let page = 0; page < 50; page++) {
    const query = `query($owner:String!,$name:String!,$number:Int!${cursor ? ',$cursor:String!' : ''}){repository(owner:$owner,name:$name){pullRequest(number:$number){url headRefOid reviewThreads(first:100${cursor ? ',after:$cursor' : ''}){nodes{id isResolved comments(first:1){nodes{url}}} pageInfo{hasNextPage endCursor}}}}}`;
    const args = [
      'gh',
      'api',
      'graphql',
      '--hostname',
      meta.host,
      '-f',
      `owner=${meta.owner}`,
      '-f',
      `name=${meta.repo}`,
      '-F',
      `number=${meta.number}`,
      '-f',
      `query=${query}`,
    ];
    if (cursor) args.push('-f', `cursor=${cursor}`);
    const outcome = await runGhJson(args, cwd || '/tmp', spawn, {
      hostHint: meta.host,
      resourceHint: 'graphql',
    });
    if (!outcome.ok) return outcome;
    const errors = z.object({ errors: z.array(z.unknown()) }).safeParse(outcome.data);
    if (errors.success && isRateLimitError(JSON.stringify(errors.data.errors)))
      return {
        ok: false,
        error: 'GitHub review-thread rate limit',
        retryable: true,
        retryAfterMs: RATE_LIMIT_MIN_BACKOFF_MS,
      };
    const parsed = Page.safeParse(outcome.data);
    if (!parsed.success || parsed.data.errors?.length) return partial();
    const pr = parsed.data.data.repository.pullRequest;
    if (pr.url.toLowerCase() !== url || (headOid !== null && headOid !== pr.headRefOid))
      return partial();
    headOid = pr.headRefOid;
    for (const node of pr.reviewThreads.nodes)
      if (!node.isResolved) unresolvedThreadUrls.push(node.comments.nodes[0]?.url ?? node.id);
    const info = pr.reviewThreads.pageInfo;
    if (!info.hasNextPage) return { ok: true, data: { headOid, unresolvedThreadUrls } };
    if (!info.endCursor || seen.has(info.endCursor)) return partial();
    cursor = info.endCursor;
    seen.add(cursor);
  }
  return partial();
}

async function acquire(target: Target, cwd: string, spawn: SpawnFn, now: () => number) {
  const { facts, subject } = target;
  const before = facts.read(subject, now(), Infinity);
  const response = await facts.acquire(subject, null, async () => {
    const result = await fetchPages(subject.url, cwd, spawn);
    const observation = result.ok
      ? {
          value: result.data as { headOid: string; unresolvedThreadUrls: string[] },
          etag: null,
          next: null,
        }
      : {
          reason: result.error.endsWith(': partial')
            ? ('partial' as const)
            : isRateLimitError(result.error)
              ? ('rate_limited' as const)
              : ('failed' as const),
        };
    const recorded = withBusyRetry(() =>
      facts.record(subject, observation, now(), before.observationRevision)
    );
    return Response.json({
      result: recorded
        ? result
        : { ok: false, error: 'GitHub review-thread observation superseded' },
      revision: before.observationRevision + 1,
    });
  });
  const acquired = (await response.json()) as { result: ConnectorOutcome; revision: number };
  const current = facts.read(subject, now(), Infinity);
  return !acquired.result.ok
    ? acquired.result
    : current.observationRevision === acquired.revision && current.page.status === 'known'
      ? { ok: true as const, data: current.page.value }
      : { ok: false as const, error: 'GitHub review-thread observation superseded' };
}

export function createCodingReviewThreadReader(
  getDatabase: () => Database,
  spawn: SpawnFn = spawnProcess,
  now = Date.now
) {
  return (
    superpipe({
      getDatabase,
      spawn,
      now,
      accept: 'application/vnd.hyperneo.pr-review-threads+json',
    })('coding-ledger-review-thread-read') as PipelineAPI
  )
    .input(['url', 'cwd'])
    .pipe(codingConnectorPrTarget, ['getDatabase', 'url', 'accept'], 'result:outcome')
    .pipe(acquire, ['outcome', 'cwd', 'spawn', 'now'], 'outcome')
    .endAsync('outcome') as (url: string, cwd: string) => Promise<ConnectorOutcome>;
}
