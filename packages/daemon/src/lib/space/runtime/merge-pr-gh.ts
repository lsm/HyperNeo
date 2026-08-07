/**
 * Production {@link MergePrDeps} backed by the `gh` CLI.
 *
 * `fetchSnapshot` reuses {@link runGhJson} (the single source of truth for gh
 * access + rate-limit handling) for both the `gh pr view --json` scalar/check
 * call and the GraphQL reviews + review-threads query (paginated). The merge
 * step spawns `gh pr merge --squash --match-head-commit <head>` directly and
 * captures raw stdout/stderr (the merge endpoint does not return JSON).
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
  statusCheckRollup?: Array<Record<string, unknown>>;
}

interface GraphQlReviews {
  data?: {
    repository?: {
      pullRequest?: {
        reviews?: {
          nodes?: Array<{
            state?: string;
            body?: string;
            author?: { login?: string } | null;
            commit?: { oid?: string } | null;
          }>;
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

    // --- gh pr view: scalars + check rollup ---
    const viewArgs = [
      'gh',
      'pr',
      'view',
      prUrl,
      '--json',
      'state,baseRefName,headRefOid,headRefName,isCrossRepository,mergeStateStatus,reviewDecision,statusCheckRollup',
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

    // --- GraphQL: reviews + review threads (paginated) ---
    let reviews: ReviewEntry[] = [];
    let unresolvedThreadCount = 0;
    let cursor: string | null = null;
    let threadsOk = false;
    for (let page = 0; page < 20; page += 1) {
      const query =
        'query($owner:String!,$name:String!,$number:Int!,$cursor:String!){' +
        'repository(owner:$owner,name:$name){pullRequest(number:$number){' +
        'reviews(first:100){nodes{state body author{login} commit{oid}}}' +
        'reviewThreads(first:100,after:$cursor){nodes{isResolved} pageInfo{hasNextPage endCursor}}' +
        '}}}';
      const gqlArgs = [
        'gh',
        'api',
        'graphql',
        '--hostname',
        parsed.host,
        '-f',
        `owner=${parsed.owner}`,
        '-f',
        `name=${parsed.repo}`,
        '-F',
        `number=${parsed.number}`,
        '-f',
        `cursor=${cursor ?? ''}`,
        '-f',
        `query=${query}`,
      ];
      const gqlOutcome = await runGhJson(gqlArgs, cwd, spawn, {
        hostHint: parsed.host,
        resourceHint: 'graphql',
      });
      if (!gqlOutcome.ok) {
        fetchErrors.push(`review/thread query failed: ${gqlOutcome.error}`);
        break;
      }
      const body = gqlOutcome.data as GraphQlReviews;
      if (body.errors) {
        fetchErrors.push(`GraphQL errors: ${JSON.stringify(body.errors)}`);
        break;
      }
      const pr = body.data?.repository?.pullRequest;
      if (!pr) {
        fetchErrors.push('GraphQL response missing pullRequest');
        break;
      }
      // Reviews only need to be read once (first page); they're not paginated here.
      if (page === 0 && pr.reviews?.nodes) {
        reviews = pr.reviews.nodes.map((n) => ({
          state: n.state ?? '',
          body: n.body ?? null,
          authorLogin: n.author?.login ?? null,
          commitOid: n.commit?.oid ?? null,
        }));
      }
      const threads = pr.reviewThreads?.nodes ?? [];
      for (const t of threads) {
        if (t.isResolved === false) unresolvedThreadCount += 1;
      }
      threadsOk = true;
      if (!pr.reviewThreads?.pageInfo?.hasNextPage) break;
      cursor = pr.reviewThreads.pageInfo.endCursor ?? null;
      if (!cursor) break;
    }
    if (!threadsOk && fetchErrors.length === 0) {
      fetchErrors.push('review/thread query returned no usable data');
    }

    const state = (view?.state ?? '').toUpperCase();
    return {
      prUrl,
      state,
      open: state === 'OPEN',
      headRefOid: view?.headRefOid ?? null,
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
