/**
 * post_review handler — posts a GitHub PR review server-side (no shell).
 *
 * The Reviewer has no Bash tool (Option C role separation). It posts reviews
 * and line comments through this handler, which calls the GitHub REST API via
 * the `gh` CLI spawned by the daemon — the same credential path the github
 * connector and `pr_ready` validator use (`runGhJson` / `buildGitHubLookupEnv`).
 *
 * The orchestration logic (payload construction + own-PR fallback) is a pure
 * function of injected deps so it is unit-testable without spawning `gh`. The
 * real `gh` implementations live in `buildGhPostReviewDeps` and are wired by
 * `TaskAgentManager.buildNodeAgentMcpServerForSession` for reviewer sessions.
 *
 * Own-PR fallback: GitHub rejects APPROVE / REQUEST_CHANGES from the PR author
 * (HTTP 422). When that happens the handler retries as a COMMENT review and
 * prepends a `Recommendation: <APPROVE|REQUEST_CHANGES>` line to the body, so
 * the verdict still lands visibly without the caller having to detect own-PRs.
 */

import type { ParsedPrUrl } from '../runtime/parse-pr-url';
import { parsePrUrl } from '../runtime/parse-pr-url';
import { buildGitHubLookupEnv, runGhJson } from '../runtime/gh-lookup-helpers';
import { collectWithMaxBuffer, MAX_BUFFER_BYTES } from '../runtime/gate-script-executor';

/** Review event types accepted by the GitHub reviews API. */
export type ReviewEvent = 'APPROVE' | 'REQUEST_CHANGES' | 'COMMENT';

/** A single anchored line comment posted inline with the review. */
export interface ReviewLineComment {
  path: string;
  line: number;
  side: 'LEFT' | 'RIGHT';
  body: string;
  startLine?: number;
  startSide?: 'LEFT' | 'RIGHT';
}

/** Arguments passed to {@link postGitHubReview}. */
export interface PostReviewArgs {
  prUrl: string;
  event: ReviewEvent;
  body: string;
  commitId?: string;
  comments?: ReviewLineComment[];
}

/** Result of posting a review. */
export interface PostReviewResult {
  success: boolean;
  /** html_url of the posted review (present on success). */
  htmlUrl?: string;
  /** The event that actually landed (differs from the request on own-PR fallback). */
  eventUsed?: ReviewEvent;
  /** True when an APPROVE/REQUEST_CHANGES was retried as COMMENT (own-PR). */
  fallbackUsed?: boolean;
  error?: string;
}

/**
 * The two `gh` operations the orchestrator needs, abstracted for testability.
 * Production wiring: {@link buildGhPostReviewDeps}. Tests pass fakes.
 */
export interface PostReviewDeps {
  /** Resolve the PR head commit SHA (used when `commitId` is omitted). */
  resolveHeadSha(prUrl: string): Promise<string | null>;
  /**
   * POST a review payload to the GitHub reviews API.
   * Returns the review's `html_url` on success or an error string on failure.
   */
  postReview(
    meta: ParsedPrUrl,
    payload: ReviewPayload
  ): Promise<{ ok: true; htmlUrl: string } | { ok: false; error: string }>;
}

/** The GitHub reviews-API payload shape (snake_case, as the API expects). */
export interface ReviewPayload {
  commit_id: string;
  body: string;
  event: ReviewEvent;
  comments: Array<{
    path: string;
    body: string;
    line: number;
    side: 'LEFT' | 'RIGHT';
    start_line?: number;
    start_side?: 'LEFT' | 'RIGHT';
  }>;
}

/**
 * Detect whether a `gh api` failure is GitHub rejecting the caller's own PR
 * review (APPROVE / REQUEST_CHANGES are forbidden from the PR author). GitHub
 * returns HTTP 422 with a "reviewer cannot review their own pull request"
 * message, which `gh` surfaces on stderr.
 */
export function isOwnPrRejection(error: string): boolean {
  return /own pull request|cannot review your own|reviewer cannot review/i.test(error);
}

/**
 * Post a GitHub PR review, with automatic own-PR fallback.
 *
 * Resolution order:
 *   1. Resolve the head commit SHA (caller-supplied or via `resolveHeadSha`).
 *   2. POST the review with the requested event.
 *   3. If the event was APPROVE/REQUEST_CHANGES and GitHub rejected it as an
 *      own-PR review, retry as COMMENT with a `Recommendation:` preamble.
 */
export async function postGitHubReview(
  args: PostReviewArgs,
  deps: PostReviewDeps
): Promise<PostReviewResult> {
  const commitId = args.commitId ?? (await deps.resolveHeadSha(args.prUrl));
  if (!commitId) {
    return {
      success: false,
      error: `Unable to resolve head commit SHA for PR ${args.prUrl} (pass commitId explicitly).`,
    };
  }

  const payload: ReviewPayload = {
    commit_id: commitId,
    body: args.body,
    event: args.event,
    comments: (args.comments ?? []).map((c) => ({
      path: c.path,
      body: c.body,
      line: c.line,
      side: c.side,
      ...(c.startLine !== undefined ? { start_line: c.startLine } : {}),
      ...(c.startSide !== undefined ? { start_side: c.startSide } : {}),
    })),
  };

  // Parse the PR URL here so we fail fast on a malformed URL before spawning.
  // The deps.postReview caller (buildGhPostReviewDeps) also has the meta, but
  // resolving it centrally keeps the orchestrator's error messages consistent.
  const meta = parsePrUrl(args.prUrl);
  if (!meta) {
    return { success: false, error: `Unable to parse GitHub PR URL: ${args.prUrl}` };
  }

  const first = await deps.postReview(meta, payload);
  if (first.ok) {
    return {
      success: true,
      htmlUrl: first.htmlUrl,
      eventUsed: args.event,
      fallbackUsed: false,
    };
  }

  // Own-PR fallback: retry APPROVE / REQUEST_CHANGES as a COMMENT review so the
  // verdict still lands. The body carries the recommendation explicitly.
  if (args.event !== 'COMMENT' && isOwnPrRejection(first.error)) {
    const fallbackBody = `Recommendation: ${args.event}.\n\n${args.body}`;
    const retry = await deps.postReview(meta, { ...payload, event: 'COMMENT', body: fallbackBody });
    if (retry.ok) {
      return {
        success: true,
        htmlUrl: retry.htmlUrl,
        eventUsed: 'COMMENT',
        fallbackUsed: true,
      };
    }
    return {
      success: false,
      error: `Own-PR fallback to COMMENT also failed: ${retry.error}`,
    };
  }

  return { success: false, error: first.error };
}

/** Default per-command timeout for a `gh` POST. */
const DEFAULT_POST_REVIEW_TIMEOUT_MS = 30_000;

/**
 * Build the production {@link PostReviewDeps} backed by the `gh` CLI.
 *
 * `resolveHeadSha` reuses {@link runGhJson} (`gh pr view --json headRefOid`).
 * `postReview` spawns `gh api --method POST …/reviews --input -` with the JSON
 * payload on stdin (the reviews endpoint takes a nested `comments` array, which
 * the `-f` raw-field flags cannot express), then reads `html_url` from stdout.
 */
export function buildGhPostReviewDeps(deps: {
  spawnImpl: typeof Bun.spawn;
  cwd: string;
  timeoutMs?: number;
}): PostReviewDeps {
  const { spawnImpl, cwd, timeoutMs = DEFAULT_POST_REVIEW_TIMEOUT_MS } = deps;

  return {
    async resolveHeadSha(prUrl: string): Promise<string | null> {
      const outcome = await runGhJson(
        ['gh', 'pr', 'view', prUrl, '--json', 'headRefOid'],
        cwd,
        spawnImpl,
        { resourceHint: 'graphql' }
      );
      if (!outcome.ok) return null;
      const sha = (outcome.data as { headRefOid?: unknown })?.headRefOid;
      return typeof sha === 'string' && sha.length > 0 ? sha : null;
    },

    async postReview(meta, payload) {
      const args = [
        'gh',
        'api',
        '--hostname',
        meta.host,
        '--method',
        'POST',
        `-H`,
        'Accept: application/vnd.github+json',
        `repos/${meta.owner}/${meta.repo}/pulls/${meta.number}/reviews`,
        '--input',
        '-',
      ];
      const body = JSON.stringify(payload);

      let proc;
      try {
        proc = spawnImpl(args, {
          cwd,
          env: buildGitHubLookupEnv(),
          stdin: 'pipe',
          stdout: 'pipe',
          stderr: 'pipe',
        });
      } catch (err) {
        return { ok: false, error: err instanceof Error ? err.message : String(err) };
      }

      const killTimer = setTimeout(() => {
        try {
          proc.kill('SIGKILL');
        } catch {
          // ignore
        }
      }, timeoutMs);

      // Feed the JSON body to stdin, then close it so `gh --input -` completes.
      // Bun.spawn with stdin:'pipe' exposes a synchronous FileSink (write/end),
      // not a WritableStream — no await needed.
      try {
        const stdin = proc.stdin;
        if (stdin) {
          stdin.write(body);
          stdin.end();
        }
      } catch {
        // A stdin write failure is non-fatal — gh will exit with a usage error
        // that surfaces as a normal non-zero exit below.
      }

      const [stdoutResult, stderrResult, exitCode] = await Promise.all([
        collectWithMaxBuffer(proc.stdout, MAX_BUFFER_BYTES),
        collectWithMaxBuffer(proc.stderr, MAX_BUFFER_BYTES),
        proc.exited,
      ]);
      clearTimeout(killTimer);

      if (exitCode !== 0) {
        const errorText = stderrResult.text.trim() || `gh exited with code ${exitCode}`;
        return { ok: false, error: errorText };
      }

      const parsed = parseJsonObject(stdoutResult.text);
      if (!parsed || typeof parsed.html_url !== 'string') {
        return { ok: false, error: 'gh produced an unexpected review response (no html_url)' };
      }
      return { ok: true, htmlUrl: parsed.html_url };
    },
  };
}

/** Parse stdout as a JSON object. Returns null when empty or not an object. */
function parseJsonObject(raw: string): { html_url?: unknown } | null {
  const trimmed = raw.trim();
  if (trimmed.length === 0) return null;
  try {
    const value = JSON.parse(trimmed);
    return value && typeof value === 'object' ? (value as { html_url?: unknown }) : null;
  } catch {
    return null;
  }
}
