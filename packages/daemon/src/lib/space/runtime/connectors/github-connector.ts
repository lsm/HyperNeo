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

import { resolveGithubConfigDir, runGhJson } from '../gh-lookup-helpers';
import { parsePrUrl } from '../parse-pr-url';
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

      /**
       * `github.getReviewEvidence({ prUrl, sinceIso })` →
       * `{ url, ownPr, formalReviewCount, commentEvidenceCount, reviewEvidence, reviewCount }`.
       * Backs `review_posted` (predicate: a formal review OR, for own PRs, a
       * comment/commented-review since `sinceIso`).
       *
       * Composite op (pr view + viewer lookup) mirroring the legacy
       * REVIEW_POSTED bash: it assembles the DOMAIN FACTS (counts + the
       * own-PR boolean) and leaves the POLICY — formal-review-first, own-PR
       * comment fallback — to the L3 predicate in the preset. The one
       * cross-field comparison the predicate language cannot express
       * (prAuthor === viewer) lives here, exactly as `getPrReadiness`
       * composes its two lookups in-connector.
       */
      getReviewEvidence: makeGetReviewEvidenceOp(spawnImpl),
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

function makeGetReviewEvidenceOp(spawnImpl: typeof Bun.spawn): ConnectorOp {
  return async (opParams, ctx): Promise<ConnectorOutcome> => {
    const prUrl = asString(opParams.prUrl);
    if (!prUrl) return { ok: false, error: 'prUrl is required' };
    // The since-workflow-start window is mandatory — without it the gate cannot
    // tell a fresh review from a stale one. Fail loudly (the legacy bash exited 1
    // with the same intent) rather than silently accepting any review.
    const sinceIso = normaliseIso(asString(opParams.sinceIso));
    if (!sinceIso) {
      return {
        ok: false,
        error: 'sinceIso (workflow start) is required — cannot determine review window',
      };
    }

    // Host allow-list: only run review-evidence lookups against github.com or
    // the configured GH_HOST. An attacker-influenced pr_url must not be able to
    // direct the daemon's GitHub credentials (especially GH_ENTERPRISE_TOKEN) at
    // an arbitrary host via the derived `--hostname`. This preserves the check
    // the legacy REVIEW_POSTED hook enforced before its `gh api user` lookup
    // (`PR_HOST != github.com && PR_HOST != ${GH_HOST:-github.com}` → reject) and
    // is stronger: it guards the `gh pr view` call too. A non-URL selector
    // (branch/number) doesn't parse and falls through to gh's default host
    // (GH_HOST/github.com).
    const parsedPrUrl = parsePrUrl(prUrl);
    if (parsedPrUrl) {
      const allowedHost = process.env.GH_HOST || 'github.com';
      if (parsedPrUrl.host !== 'github.com' && parsedPrUrl.host !== allowedHost) {
        return {
          ok: false,
          error: `PR host ${parsedPrUrl.host} is not allowed for GitHub lookups (allowed: github.com${
            allowedHost !== 'github.com' ? `, ${allowedHost}` : ''
          })`,
        };
      }
    }

    const prOutcome = await runGhJson(
      ['gh', 'pr', 'view', prUrl, '--json', 'reviews,comments,author,url'],
      ctx.workspacePath || '/tmp',
      spawnImpl,
      { resourceHint: 'graphql' }
    );
    if (!prOutcome.ok) return prOutcome;

    const prData = (prOutcome.data ?? {}) as {
      url?: string;
      author?: { login?: string };
      reviews?: Array<{ submittedAt?: string; state?: string }>;
      comments?: Array<{ createdAt?: string }>;
    };

    // Best-effort viewer login for the own-PR fallback. A lookup failure is NOT
    // fatal: it just means we cannot prove the viewer owns the PR, so
    // comment-only evidence is rejected and only a formal review counts —
    // matching the legacy REVIEW_POSTED bash, which treats a missing viewer as
    // "not an own PR". Resolve the host from the PR URL (via the canonical url
    // gh returned, falling back to the input) so GitHub Enterprise lookups hit
    // the right host — mirrors getReactions and the old hook bash's `--hostname`.
    let viewerLogin: string | undefined;
    const canonicalUrl = asString(prData.url);
    const viewerMeta = parsePrUrl(prUrl) ?? (canonicalUrl ? parsePrUrl(canonicalUrl) : null);
    const viewerHostArgs = viewerMeta ? ['--hostname', viewerMeta.host] : [];
    const viewerOutcome = await runGhJson(
      ['gh', 'api', ...viewerHostArgs, 'user'],
      ctx.workspacePath || '/tmp',
      spawnImpl,
      { hostHint: viewerMeta?.host, resourceHint: 'core' }
    );
    if (
      viewerOutcome.ok &&
      viewerOutcome.data &&
      typeof viewerOutcome.data === 'object' &&
      !Array.isArray(viewerOutcome.data)
    ) {
      viewerLogin = asString((viewerOutcome.data as { login?: unknown }).login);
    }

    const authorLogin = asString(prData.author?.login);
    const ownPr = Boolean(authorLogin && viewerLogin && authorLogin === viewerLogin);

    // ISO-8601 strings compare lexicographically; normaliseIso strips
    // sub-second fractions so millisecond anchors match GitHub's second-precision
    // submitted_at / created_at. Exclusive `>` matches the legacy bash
    // (`select(.submittedAt > $since)`) — a review at the exact start tick is
    // not "since" the workflow started.
    const isSince = (iso: string | undefined): boolean => {
      const n = normaliseIso(asString(iso));
      return n !== undefined && n > sinceIso;
    };

    const reviews = prData.reviews ?? [];
    // Counts evidence from ANY author (not just the viewer). This matches the
    // gate bash (the task's scoped target) and the task description ("has a
    // formal review... been posted since start?"). The old RUNTIME hook bash
    // additionally filtered by viewer login — a no-op under single-daemon-auth
    // (the agent posts reviews as the daemon account = the viewer) that would
    // have wrongly blocked legitimate reviews in any mixed-account setup, so it
    // is intentionally not replicated. See PR #2367.
    const formalReviewCount = reviews.filter(
      (r) => isSince(r.submittedAt) && (r.state === 'APPROVED' || r.state === 'CHANGES_REQUESTED')
    ).length;
    const commentedReviewCount = reviews.filter(
      (r) => isSince(r.submittedAt) && r.state === 'COMMENTED'
    ).length;
    const prCommentCount = (prData.comments ?? []).filter((c) => isSince(c.createdAt)).length;
    const commentEvidenceCount = commentedReviewCount + prCommentCount;

    // If the viewer lookup failed (e.g. a GitHub rate limit on `gh api user`) and
    // the outcome hinges on the own-PR determination — no formal review, but
    // comment evidence that would pass IF the viewer owns the PR — propagate the
    // failure verbatim (runGhJson already set `retryable`/`retryAfterMs` for rate
    // limits) so the validator surfaces it as a retryable_block instead of
    // swallowing it into a terminal "not satisfied" block. Without this, valid
    // own-PR comment feedback stays rejected for the duration of core-API
    // throttling. When a formal review exists (or there's no comment evidence),
    // the viewer is irrelevant and a failed lookup is safe to ignore.
    if (!viewerOutcome.ok && formalReviewCount === 0 && commentEvidenceCount > 0) {
      return viewerOutcome;
    }

    const hasFormal = formalReviewCount > 0;
    const reviewEvidence = hasFormal
      ? 'formal_review'
      : ownPr && commentEvidenceCount > 0
        ? 'own_pr_comment'
        : null;
    const reviewCount = hasFormal ? formalReviewCount : ownPr ? commentEvidenceCount : 0;

    return {
      ok: true,
      data: {
        url: asString(prData.url) ?? prUrl,
        ownPr,
        formalReviewCount,
        commentEvidenceCount,
        reviewEvidence,
        reviewCount,
      },
    };
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
