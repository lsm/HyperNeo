/**
 * Production {@link MergePrDeps} backed by the `gh` CLI.
 *
 * `fetchSnapshot` reuses {@link runGhJson} (the single source of truth for gh
 * access + rate-limit handling) for the `gh pr view --json` scalar/check call
 * and the GraphQL reviews + review-threads queries (each paginated
 * independently). The merge step spawns `gh pr merge --squash --match-head-commit
 * <head>` directly and captures raw stdout/stderr (the merge endpoint does not
 * return JSON).
 *
 * ## GraphQL pagination
 *
 * Reviews and review threads are each paginated with a two-variant query: the
 * first page omits the `$cursor` variable and the `after` arg, subsequent pages
 * declare `$cursor:String!` and pass `after:$cursor`. This mirrors the existing
 * `pr-ready-validator`'s pagination convention. Pagination also fails closed:
 * if GitHub reports `hasNextPage:true` without an `endCursor`, a fetch error is
 * recorded rather than accepting a partial thread/review set.
 *
 * Inject `MergePrDeps` in tests; use {@link buildMergePrDeps} in production.
 */

import { collectWithMaxBuffer, MAX_BUFFER_BYTES } from './gate-script-executor';
import { buildGitHubLookupEnv, DEFAULT_GH_LOOKUP_TIMEOUT_MS, runGhJson } from './gh-lookup-helpers';
import { parsePrUrl } from './parse-pr-url';
import type { MergeOutcome, PrMergeSnapshot, ReviewEntry } from './merge-pr-validator';

/** Dependencies the merge validator needs from the outside world. */
export interface MergePrDeps {
  /** Fetch the full GitHub snapshot the merge decision is computed from. */
  fetchSnapshot(prUrl: string): Promise<PrMergeSnapshot>;
  /** Perform `gh pr merge --squash --match-head-commit <headOid>`. */
  performMerge(prUrl: string, headOid: string): Promise<MergeOutcome>;
}

interface GhViewJson {
  state?: string;
  baseRefName?: string;
  headRefOid?: string;
  headRefName?: string;
  isCrossRepository?: boolean;
  mergeStateStatus?: string;
  reviewDecision?: string;
  author?: { login?: string } | null;
  statusCheckRollup?: Array<Record<string, unknown>>;
}

interface GraphQlPage {
  data?: {
    repository?: {
      pullRequest?: {
        reviews?: {
          nodes?: Array<{
            state?: string;
            body?: string;
            author?: { login?: string } | null;
            commit?: { oid?: string } | null;
            submittedAt?: string;
          }>;
          pageInfo?: { hasNextPage?: boolean; endCursor?: string };
        };
        reviewThreads?: {
          nodes?: Array<{ isResolved?: boolean }>;
          pageInfo?: { hasNextPage?: boolean; endCursor?: string };
        };
      };
    };
  };
  errors?: unknown;
}

const REVIEW_FIELDS = 'state body author{login} commit{oid} submittedAt';
const REVIEWS_QUERY_FIRST =
  'query($owner:String!,$name:String!,$number:Int!){repository(owner:$owner,name:$name){pullRequest(number:$number){' +
  `reviews(first:100){nodes{${REVIEW_FIELDS}} pageInfo{hasNextPage endCursor}}` +
  '}}}';
const REVIEWS_QUERY_PAGE =
  'query($owner:String!,$name:String!,$number:Int!,$cursor:String!){repository(owner:$owner,name:$name){pullRequest(number:$number){' +
  `reviews(first:100,after:$cursor){nodes{${REVIEW_FIELDS}} pageInfo{hasNextPage endCursor}}` +
  '}}}';
const THREADS_QUERY_FIRST =
  'query($owner:String!,$name:String!,$number:Int!){repository(owner:$owner,name:$name){pullRequest(number:$number){' +
  'reviewThreads(first:100){nodes{isResolved} pageInfo{hasNextPage endCursor}}' +
  '}}}';
const THREADS_QUERY_PAGE =
  'query($owner:String!,$name:String!,$number:Int!,$cursor:String!){repository(owner:$owner,name:$name){pullRequest(number:$number){' +
  'reviewThreads(first:100,after:$cursor){nodes{isResolved} pageInfo{hasNextPage endCursor}}' +
  '}}}';

/** Cap pagination per connection so a pathological PR cannot loop forever. */
const MAX_PAGES = 20;

/** Count rollup entries that reported a hard failure (CheckRun or CommitStatus). */
function countFailedChecks(rollup: Array<Record<string, unknown>> | undefined): number {
  if (!Array.isArray(rollup)) return 0;
  const failedConclusions = new Set(['FAILURE', 'TIMED_OUT', 'ACTION_REQUIRED']);
  const failedStates = new Set(['FAILURE', 'ERROR']);
  return rollup.filter((entry) => {
    const conclusion = typeof entry.conclusion === 'string' ? entry.conclusion.toUpperCase() : '';
    const state = typeof entry.state === 'string' ? entry.state.toUpperCase() : '';
    return failedConclusions.has(conclusion) || failedStates.has(state);
  }).length;
}

/**
 * Build production {@link MergePrDeps}. `cwd` must be a valid directory (the
 * Space workspace path is typical); `gh` resolves the repo from the PR URL, so
 * the cwd only needs to exist for the subprocess.
 */
export function buildMergePrDeps(opts: {
  spawn: typeof Bun.spawn;
  cwd: string;
  timeoutMs?: number;
}): MergePrDeps {
  const { spawn, cwd, timeoutMs = DEFAULT_GH_LOOKUP_TIMEOUT_MS } = opts;

  async function fetchSnapshot(prUrl: string): Promise<PrMergeSnapshot> {
    const parsed = parsePrUrl(prUrl);
    const fetchErrors: string[] = [];
    const empty: PrMergeSnapshot = {
      prUrl,
      state: '',
      open: false,
      headRefOid: null,
      prAuthorLogin: null,
      baseRefName: null,
      headRefName: null,
      isCrossRepository: false,
      mergeStateStatus: null,
      reviewDecision: null,
      reviews: [],
      unresolvedThreadCount: 0,
      checkFailureCount: 0,
      fetchErrors,
    };
    if (!parsed) {
      fetchErrors.push(`unparseable PR URL: ${prUrl}`);
      return empty;
    }

    // --- gh pr view: scalars + author + check rollup ---
    const viewArgs = [
      'gh',
      'pr',
      'view',
      prUrl,
      '--json',
      'state,baseRefName,headRefOid,headRefName,isCrossRepository,mergeStateStatus,reviewDecision,author,statusCheckRollup',
    ];
    const viewOutcome = await runGhJson(viewArgs, cwd, spawn, {
      hostHint: parsed.host,
      resourceHint: 'core',
    });
    let view: GhViewJson | null = null;
    if (viewOutcome.ok && viewOutcome.data && typeof viewOutcome.data === 'object') {
      view = viewOutcome.data as GhViewJson;
    } else {
      fetchErrors.push(
        `gh pr view failed: ${!viewOutcome.ok ? viewOutcome.error : 'non-object output'}`
      );
    }

    const runGql = async (
      query: string,
      vars: Record<string, string | number>
    ): Promise<GraphQlPage | null> => {
      const args = ['gh', 'api', 'graphql', '--hostname', parsed.host];
      for (const [k, v] of Object.entries(vars)) {
        if (typeof v === 'number') args.push('-F', `${k}=${v}`);
        else args.push('-f', `${k}=${v}`);
      }
      args.push('-f', `query=${query}`);
      const outcome = await runGhJson(args, cwd, spawn, {
        hostHint: parsed.host,
        resourceHint: 'graphql',
      });
      if (!outcome.ok) {
        fetchErrors.push(`graphql query failed: ${outcome.error}`);
        return null;
      }
      const body = outcome.data as GraphQlPage;
      if (body.errors) {
        fetchErrors.push(`GraphQL errors: ${JSON.stringify(body.errors)}`);
        return null;
      }
      return body;
    };

    // --- Reviews (paginated; first page omits the cursor) ---
    const reviews: ReviewEntry[] = [];
    let reviewCursor: string | null = null;
    let reviewsCapped = false;
    for (let page = 0; page < MAX_PAGES; page += 1) {
      const useCursor = page > 0 && reviewCursor !== null;
      const vars: Record<string, string | number> = {
        owner: parsed.owner,
        name: parsed.repo,
        number: +parsed.number,
      };
      if (useCursor) vars.cursor = reviewCursor as string;
      const body = await runGql(useCursor ? REVIEWS_QUERY_PAGE : REVIEWS_QUERY_FIRST, vars);
      const conn = body?.data?.repository?.pullRequest?.reviews;
      if (!conn) break; // error already recorded by runGql, or no data
      for (const n of conn.nodes ?? []) {
        reviews.push({
          state: n.state ?? '',
          body: n.body ?? null,
          authorLogin: n.author?.login ?? null,
          commitOid: n.commit?.oid ?? null,
          submittedAt: n.submittedAt ?? null,
        });
      }
      if (!conn.pageInfo?.hasNextPage) break;
      const next = conn.pageInfo.endCursor;
      if (!next) {
        fetchErrors.push('reviews pagination incomplete: hasNextPage without endCursor');
        break;
      }
      reviewCursor = next;
      if (page === MAX_PAGES - 1) reviewsCapped = true; // more pages remain at cap
    }
    if (reviewsCapped) {
      fetchErrors.push(`reviews pagination capped at ${MAX_PAGES} pages with more remaining`);
    }

    // --- Review threads (paginated; first page omits the cursor) ---
    let unresolvedThreadCount = 0;
    let threadCursor: string | null = null;
    let threadsTouched = false;
    let threadsCapped = false;
    for (let page = 0; page < MAX_PAGES; page += 1) {
      const useCursor = page > 0 && threadCursor !== null;
      const vars: Record<string, string | number> = {
        owner: parsed.owner,
        name: parsed.repo,
        number: +parsed.number,
      };
      if (useCursor) vars.cursor = threadCursor as string;
      const body = await runGql(useCursor ? THREADS_QUERY_PAGE : THREADS_QUERY_FIRST, vars);
      const conn = body?.data?.repository?.pullRequest?.reviewThreads;
      if (!conn) break;
      threadsTouched = true;
      for (const t of conn.nodes ?? []) {
        if (t.isResolved === false) unresolvedThreadCount += 1;
      }
      if (!conn.pageInfo?.hasNextPage) break;
      const next = conn.pageInfo.endCursor;
      if (!next) {
        fetchErrors.push('review-thread pagination incomplete: hasNextPage without endCursor');
        break;
      }
      threadCursor = next;
      if (page === MAX_PAGES - 1) threadsCapped = true; // more pages remain at cap
    }
    if (threadsCapped) {
      fetchErrors.push(`review-thread pagination capped at ${MAX_PAGES} pages with more remaining`);
    }
    if (!threadsTouched && fetchErrors.length === 0) {
      fetchErrors.push('review-thread query returned no usable data');
    }

    const state = (view?.state ?? '').toUpperCase();
    return {
      prUrl,
      state,
      open: state === 'OPEN',
      headRefOid: view?.headRefOid ?? null,
      prAuthorLogin: view?.author?.login ?? null,
      baseRefName: view?.baseRefName ?? null,
      headRefName: view?.headRefName ?? null,
      isCrossRepository: view?.isCrossRepository === true,
      mergeStateStatus: view?.mergeStateStatus ?? null,
      reviewDecision: view?.reviewDecision ?? null,
      reviews,
      unresolvedThreadCount,
      checkFailureCount: countFailedChecks(view?.statusCheckRollup),
      fetchErrors,
    };
  }

  async function performMerge(prUrl: string, headOid: string): Promise<MergeOutcome> {
    const args = ['gh', 'pr', 'merge', prUrl, '--squash', '--match-head-commit', headOid];
    let proc;
    try {
      proc = spawn(args, {
        cwd,
        env: buildGitHubLookupEnv(),
        stdout: 'pipe',
        stderr: 'pipe',
      });
    } catch (err) {
      return {
        ok: false,
        exitCode: -1,
        stdout: '',
        stderr: '',
        stateAfter: null,
        error: err instanceof Error ? err.message : String(err),
      };
    }

    const killTimer = setTimeout(() => {
      try {
        proc.kill('SIGKILL');
      } catch {
        // ignore
      }
    }, timeoutMs);
    const [stdoutRes, stderrRes, exitCode] = await Promise.all([
      collectWithMaxBuffer(proc.stdout, MAX_BUFFER_BYTES),
      collectWithMaxBuffer(proc.stderr, MAX_BUFFER_BYTES),
      proc.exited,
    ]);
    clearTimeout(killTimer);

    if (exitCode !== 0) {
      return {
        ok: false,
        exitCode,
        stdout: stdoutRes.text,
        stderr: stderrRes.text,
        stateAfter: null,
        error: stderrRes.text.trim() || `gh pr merge exited with code ${exitCode}`,
      };
    }

    // exit 0 — resolve post-merge state (may be MERGED or OPEN/enqueued).
    let stateAfter: string | null = null;
    const stateOutcome = await runGhJson(
      ['gh', 'pr', 'view', prUrl, '--json', 'state'],
      cwd,
      spawn,
      { hostHint: parsePrUrl(prUrl)?.host, resourceHint: 'core' }
    );
    if (stateOutcome.ok && stateOutcome.data && typeof stateOutcome.data === 'object') {
      stateAfter = ((stateOutcome.data as { state?: unknown }).state as string) ?? null;
    }
    return {
      ok: true,
      exitCode: 0,
      stdout: stdoutRes.text,
      stderr: stderrRes.text,
      stateAfter,
    };
  }

  return { fetchSnapshot, performMerge };
}
