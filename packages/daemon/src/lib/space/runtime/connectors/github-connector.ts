/**
 * github connector (L2, epic #2299 / P1 #2301; promoted from the #2300 spike).
 *
 * A `Connector` (see `connector.ts`) whose ops cover the coding capabilities:
 * PR readiness (`getPrReadiness`), PR merged state (`getPr`), and PR reactions
 * (`getReactions`). Each op is a thin wrapper over `gh` via the shared
 * `runGhJson`; the L3 validator + predicate evaluate the returned `data`
 * without knowing what a PR is. Domain knowledge lives HERE (L2), not in the
 * validator or predicate (L3).
 *
 * Registered in production by `registerProductionConnectors()` (see
 * `production.ts`). The `auth` surface is what lets the hook executor inject
 * GitHub credentials into sandboxed script hooks generically (no hardcoded
 * `GITHUB_LOOKUP_ENV_KEYS` in the executor).
 */

import { parsePrUrl } from '../parse-pr-url';
import { resolveGithubConfigDir, runGhJson } from '../gh-lookup-helpers';
import type { Connector, ConnectorContext, ConnectorOp, ConnectorOutcome } from './connector';

const GITHUB_CONNECTOR_ID = 'github';

/**
 * Env keys the github connector admits into a SANDBOXED script-hook env. This
 * is the exact surface the legacy `GITHUB_LOOKUP_ENV_KEYS` in the hook executor
 * injected — preserved verbatim so script-hook behavior is identical whether
 * the connectors layer is on or off.
 */
const GITHUB_SANDBOX_ENV_KEYS: readonly string[] = [
  'GH_TOKEN',
  'GITHUB_TOKEN',
  'GH_ENTERPRISE_TOKEN',
  'GITHUB_ENTERPRISE_TOKEN',
  'GH_HOST',
  'GH_CONFIG_DIR',
];

export function createGithubConnector(
  spawnImpl: typeof Bun.spawn = ((...args: Parameters<typeof Bun.spawn>) =>
    Bun.spawn(...args)) as typeof Bun.spawn
): Connector {
  return {
    id: GITHUB_CONNECTOR_ID,
    auth: {
      envKeys: GITHUB_SANDBOX_ENV_KEYS,
      resolveExtraEnv: () => ({ GH_CONFIG_DIR: resolveGithubConfigDir() }),
    },
    ops: {
      /**
       * `github.getPr({ prUrl })` → `{ url, state, mergeable, mergeStateStatus }`.
       * Backs `pr_merged` (predicate on `state`).
       */
      getPr: makeGetPrOp(spawnImpl),

      /**
       * `github.getPrReadiness({ prUrl })` →
       * `{ url, state, mergeable, mergeStateStatus, unresolvedThreadUrls }`.
       * Composite op (pr view + paginated review threads) backing `pr_ready`.
       *
       * This is the key finding for pr_ready: a handoff gate spans two github
       * lookups (PR metadata AND review threads), so it needs ONE composite op
       * on the connector rather than two predicate evaluations. That keeps the
       * L3 validator as single-(connector, op, predicate) while the connector
       * — the legitimate home of domain logic — composes the lookups.
       */
      getPrReadiness: makeGetPrReadinessOp(spawnImpl),

      /**
       * `github.getReactions({ prUrl })` →
       * `{ reactions: [{ login, content, createdAt }] }`. Backs
       * `codex_review_bot` (predicate: exists a codex-bot +1 since freshness).
       */
      getReactions: makeGetReactionsOp(spawnImpl),
    },
  };
}

function asString(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function makeGetPrOp(spawnImpl: typeof Bun.spawn): ConnectorOp {
  return async (opParams, ctx): Promise<ConnectorOutcome> => {
    const prUrl = asString(opParams.prUrl);
    if (!prUrl) return { ok: false, error: 'prUrl is required' };
    return runGhJson(
      ['gh', 'pr', 'view', prUrl, '--json', 'url,state,mergeable,mergeStateStatus'],
      ctx.workspacePath || '/tmp',
      spawnImpl,
      { resourceHint: 'graphql' }
    );
  };
}

function makeGetPrReadinessOp(spawnImpl: typeof Bun.spawn): ConnectorOp {
  return async (opParams, ctx): Promise<ConnectorOutcome> => {
    const prUrl = asString(opParams.prUrl);
    if (!prUrl) return { ok: false, error: 'prUrl is required' };

    const prOutcome = await runGhJson(
      ['gh', 'pr', 'view', prUrl, '--json', 'url,state,mergeable,mergeStateStatus'],
      ctx.workspacePath || '/tmp',
      spawnImpl,
      { resourceHint: 'graphql' }
    );
    if (!prOutcome.ok) return prOutcome;

    // Resolve canonical owner/repo/number for the review-threads query. The
    // input may be a noncanonical selector (branch, number, URL with suffix)
    // that `gh pr view` accepts but parsePrUrl rejects — so prefer the input
    // URL, then fall back to the canonical URL gh returned in `prOutcome.url`.
    // If neither parses, FAIL CLOSED: fabricating an empty unresolved-thread
    // list would let a handoff through on a PR that may have unresolved threads
    // (the production validator resolves the canonical URL too).
    const canonicalUrl = asString((prOutcome.data as Record<string, unknown>)?.url);
    const meta = parsePrUrl(prUrl) ?? (canonicalUrl ? parsePrUrl(canonicalUrl) : null);
    if (!meta) {
      return {
        ok: false,
        error: `unable to parse PR URL for review-threads lookup: ${canonicalUrl ?? prUrl}`,
      };
    }

    const threadsOutcome = await fetchUnresolvedReviewThreads(meta, ctx, spawnImpl);
    if (!threadsOutcome.ok) return threadsOutcome;

    const unresolvedThreadUrls = (threadsOutcome.data as { unresolvedThreadUrls: string[] })
      .unresolvedThreadUrls;
    return {
      ok: true,
      data: {
        ...(prOutcome.data as Record<string, unknown>),
        unresolvedThreadUrls,
      },
    };
  };
}

function makeGetReactionsOp(spawnImpl: typeof Bun.spawn): ConnectorOp {
  return async (opParams, ctx): Promise<ConnectorOutcome> => {
    const prUrl = asString(opParams.prUrl);
    if (!prUrl) return { ok: false, error: 'prUrl is required' };
    const meta = parsePrUrl(prUrl);
    if (!meta) return { ok: false, error: `unable to parse GitHub PR URL: ${prUrl}` };

    // NOTE: the production codex script uses `--paginate` and merges the
    // concatenated JSON arrays with `jq -s add`. This op fetches a single
    // page (100 reactions) so stdout is one clean JSON array; multi-page merge
    // is deferred (not part of the abstraction honesty test).
    const outcome = await runGhJson(
      [
        'gh',
        'api',
        '--hostname',
        meta.host,
        `repos/${meta.owner}/${meta.repo}/issues/${meta.number}/reactions?per_page=100`,
        '-H',
        'Accept: application/vnd.github+json',
      ],
      ctx.workspacePath || '/tmp',
      spawnImpl,
      { hostHint: meta.host, resourceHint: 'core' }
    );
    if (!outcome.ok) return outcome;

    const raw = outcome.data;
    // `--paginate` returns a concatenation of JSON arrays (not a single array).
    // Normalise both the single-array and concatenated cases into one list.
    const list = normaliseReactionsPayload(raw);
    // Optional freshness filter: when `sinceIso` is supplied, drop reactions
    // created before it. This lets the codex preset treat "fresh +1" as a
    // STATIC predicate over a pre-filtered list — the freshness anchor
    // (cycle_start_at) is resolved from context by the param resolver, so the
    // predicate itself stays constant. ISO-8601 strings compare correctly
    // lexicographically; sub-second fractions are normalised away to match
    // GitHub's second-precision `created_at`.
    const sinceIso = normaliseIso(asString(opParams.sinceIso));
    const reactions = list
      .map((r) => {
        const node = r as Record<string, unknown>;
        const user = node.user as Record<string, unknown> | undefined;
        return {
          login: asString(user?.login) ?? '',
          content: asString(node.content) ?? '',
          createdAt: normaliseIso(asString(node.created_at)) ?? '',
        };
      })
      .filter((r) => !sinceIso || (r.createdAt.length > 0 && r.createdAt >= sinceIso));
    return { ok: true, data: { reactions } };
  };
}

/** Strip sub-second fractions from an ISO timestamp so second-precision
 *  `created_at` values compare cleanly against a millisecond anchor. Assumes
 *  UTC ('Z') offsets — sufficient for the mocked data the codex preset tests
 *  use. */
function normaliseIso(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const dot = value.indexOf('.');
  return dot >= 0 ? `${value.slice(0, dot)}Z` : value;
}

function normaliseReactionsPayload(raw: unknown): unknown[] {
  if (Array.isArray(raw)) return raw;
  if (Array.isArray((raw as Record<string, unknown> | null)?.items)) {
    return (raw as { items: unknown[] }).items;
  }
  return [];
}

interface ReviewThreadsPage {
  nodes: Array<{ id?: string; isResolved: boolean; comments: { nodes: Array<{ url: string }> } }>;
  pageInfo: { hasNextPage: boolean; endCursor: string | null };
}

/** Returns a ConnectorOutcome whose ok-branch data is `{ unresolvedThreadUrls }`. */
async function fetchUnresolvedReviewThreads(
  meta: { host: string; owner: string; repo: string; number: string },
  ctx: ConnectorContext,
  spawnImpl: typeof Bun.spawn
): Promise<ConnectorOutcome> {
  const urls: string[] = [];
  let cursor: string | null = null;

  for (let page = 0; page < 50; page++) {
    const query = cursor
      ? 'query($owner:String!,$name:String!,$number:Int!,$cursor:String!){repository(owner:$owner,name:$name){pullRequest(number:$number){reviewThreads(first:100,after:$cursor){nodes{id isResolved comments(first:1){nodes{url}}} pageInfo{hasNextPage endCursor}}}}}'
      : 'query($owner:String!,$name:String!,$number:Int!){repository(owner:$owner,name:$name){pullRequest(number:$number){reviewThreads(first:100){nodes{id isResolved comments(first:1){nodes{url}}} pageInfo{hasNextPage endCursor}}}}}';
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
    ];
    // Bind `$cursor` on paginated requests — the cursor query declares it as a
    // required variable, so omitting `-f cursor=` makes GitHub reject page 2
    // (matching the production validator at pr-ready-validator.ts:356-367).
    if (cursor) args.push('-f', `cursor=${cursor}`);
    args.push('-f', `query=${query}`);
    const outcome = await runGhJson(args, ctx.workspacePath || '/tmp', spawnImpl, {
      hostHint: meta.host,
      resourceHint: 'graphql',
    });
    if (!outcome.ok) return outcome;

    const threads = (
      outcome.data as {
        data?: { repository?: { pullRequest?: { reviewThreads?: ReviewThreadsPage } } };
      }
    )?.data?.repository?.pullRequest?.reviewThreads;
    if (!threads) {
      return { ok: false, error: 'Incomplete GraphQL response — reviewThreads missing' };
    }
    for (const node of threads.nodes) {
      if (!node.isResolved) {
        urls.push(node.comments.nodes[0]?.url ?? node.id ?? '<unknown>');
      }
    }
    if (!threads.pageInfo.hasNextPage) break;
    cursor = threads.pageInfo.endCursor;
    if (!cursor) {
      return { ok: false, error: 'Incomplete pagination: hasNextPage true but endCursor missing' };
    }
  }

  return { ok: true, data: { unresolvedThreadUrls: urls } };
}

export { GITHUB_CONNECTOR_ID };
