/**
 * Unit tests for the post_review handler orchestration.
 *
 * The handler posts a GitHub PR review server-side (no shell) with automatic
 * own-PR fallback. These tests cover the pure orchestration logic
 * (`postGitHubReview`) and `isOwnPrRejection` by injecting fake deps — no `gh`
 * is spawned. The real `gh` wiring (`buildGhPostReviewDeps`) is exercised
 * indirectly through the captured payloads.
 */

import { describe, expect, it } from 'bun:test';
import {
  postGitHubReview,
  isOwnPrRejection,
  type PostReviewDeps,
  type ReviewPayload,
} from '../../../../src/lib/space/tools/post-review-handler';
import type { ParsedPrUrl } from '../../../../src/lib/space/runtime/parse-pr-url';

const PR_URL = 'https://github.com/owner/repo/pull/42';
const META: ParsedPrUrl = { host: 'github.com', owner: 'owner', repo: 'repo', number: '42' };
const SHA = 'abc123headsha';
const REVIEW_URL = 'https://github.com/owner/repo/pull/42#pullrequestreview-1';

/** Build fake deps that record every postReview call and respond from a script. */
function makeDeps(responses: Array<{ ok: true; htmlUrl: string } | { ok: false; error: string }>): {
  deps: PostReviewDeps;
  calls: ReviewPayload[];
  headShaCalls: () => number;
} {
  const calls: ReviewPayload[] = [];
  const state = { headShaCalls: 0 };
  let i = 0;
  const deps: PostReviewDeps = {
    resolveHeadSha: async () => {
      state.headShaCalls++;
      return SHA;
    },
    postReview: async (_meta, payload) => {
      calls.push(payload);
      return responses[i++] ?? { ok: false, error: 'no scripted response' };
    },
  };
  return { deps, calls, headShaCalls: () => state.headShaCalls };
}

describe('post_review handler — postGitHubReview', () => {
  it('posts an APPROVE review and returns the html_url with no fallback', async () => {
    const { deps, calls, headShaCalls } = makeDeps([{ ok: true, htmlUrl: REVIEW_URL }]);
    const result = await postGitHubReview(
      { prUrl: PR_URL, event: 'APPROVE', body: '## 🤖 Review by …\n\nLGTM' },
      deps
    );

    expect(result.success).toBe(true);
    expect(result.htmlUrl).toBe(REVIEW_URL);
    expect(result.eventUsed).toBe('APPROVE');
    expect(result.fallbackUsed).toBe(false);
    expect(calls).toHaveLength(1);
    expect(calls[0].event).toBe('APPROVE');
    // commitId was omitted → resolved via resolveHeadSha.
    expect(headShaCalls()).toBe(1);
    expect(calls[0].commit_id).toBe(SHA);
  });

  it('uses the caller-supplied commitId and skips head-sha resolution', async () => {
    const { deps, calls, headShaCalls } = makeDeps([{ ok: true, htmlUrl: REVIEW_URL }]);
    await postGitHubReview(
      { prUrl: PR_URL, event: 'COMMENT', body: 'note', commitId: 'explicit-sha' },
      deps
    );
    expect(headShaCalls()).toBe(0);
    expect(calls[0].commit_id).toBe('explicit-sha');
  });

  it('falls back to COMMENT when an APPROVE is rejected as an own-PR review', async () => {
    const { deps, calls } = makeDeps([
      { ok: false, error: 'HTTP 422: reviewer cannot review their own pull request' },
      { ok: true, htmlUrl: REVIEW_URL },
    ]);
    const result = await postGitHubReview(
      { prUrl: PR_URL, event: 'APPROVE', body: '## 🤖 Review …\n\nShip it' },
      deps
    );

    expect(result.success).toBe(true);
    expect(result.htmlUrl).toBe(REVIEW_URL);
    expect(result.eventUsed).toBe('COMMENT');
    expect(result.fallbackUsed).toBe(true);
    // First attempt APPROVE, retry COMMENT.
    expect(calls.map((c) => c.event)).toEqual(['APPROVE', 'COMMENT']);
    // The COMMENT retry body prepends the recommendation explicitly.
    expect(calls[1].body).toContain('Recommendation: APPROVE.');
    expect(calls[1].body).toContain('Ship it');
  });

  it('falls back to COMMENT for a rejected REQUEST_CHANGES, naming that verdict', async () => {
    const { deps, calls } = makeDeps([
      { ok: false, error: 'validation failed: cannot review your own PR' },
      { ok: true, htmlUrl: REVIEW_URL },
    ]);
    const result = await postGitHubReview(
      { prUrl: PR_URL, event: 'REQUEST_CHANGES', body: 'needs work' },
      deps
    );
    expect(result.eventUsed).toBe('COMMENT');
    expect(result.fallbackUsed).toBe(true);
    expect(calls[1].body).toContain('Recommendation: REQUEST_CHANGES.');
  });

  it('does NOT fall back when the caller already asked for COMMENT', async () => {
    const { deps, calls } = makeDeps([
      { ok: false, error: 'reviewer cannot review their own pull request' },
    ]);
    const result = await postGitHubReview({ prUrl: PR_URL, event: 'COMMENT', body: 'fyi' }, deps);
    expect(result.success).toBe(false);
    expect(calls).toHaveLength(1);
    expect(calls[0].event).toBe('COMMENT');
  });

  it('propagates a non-own-PR failure without retrying', async () => {
    const { deps, calls } = makeDeps([{ ok: false, error: 'HTTP 404: Not Found' }]);
    const result = await postGitHubReview({ prUrl: PR_URL, event: 'APPROVE', body: 'x' }, deps);
    expect(result.success).toBe(false);
    expect(result.error).toContain('404');
    expect(calls).toHaveLength(1);
  });

  it('returns an error when the own-PR COMMENT fallback also fails', async () => {
    const { deps } = makeDeps([
      { ok: false, error: 'reviewer cannot review their own pull request' },
      { ok: false, error: 'HTTP 500: server error' },
    ]);
    const result = await postGitHubReview({ prUrl: PR_URL, event: 'APPROVE', body: 'x' }, deps);
    expect(result.success).toBe(false);
    expect(result.error).toContain('Own-PR fallback to COMMENT also failed');
    expect(result.error).toContain('500');
  });

  it('maps anchored line comments to the GitHub snake_case payload', async () => {
    const { deps, calls } = makeDeps([{ ok: true, htmlUrl: REVIEW_URL }]);
    await postGitHubReview(
      {
        prUrl: PR_URL,
        event: 'REQUEST_CHANGES',
        body: 'see inline',
        comments: [
          { path: 'src/a.ts', line: 10, side: 'RIGHT', body: 'bug here' },
          {
            path: 'src/b.ts',
            line: 20,
            side: 'LEFT',
            body: 'range',
            startLine: 15,
            startSide: 'LEFT',
          },
        ],
      },
      deps
    );
    expect(calls[0].comments).toEqual([
      { path: 'src/a.ts', line: 10, side: 'RIGHT', body: 'bug here' },
      {
        path: 'src/b.ts',
        line: 20,
        side: 'LEFT',
        body: 'range',
        start_line: 15,
        start_side: 'LEFT',
      },
    ]);
  });

  it('errors when head-sha resolution fails and no commitId was given', async () => {
    const deps: PostReviewDeps = {
      resolveHeadSha: async () => null,
      postReview: async () => ({ ok: false, error: 'should not be called' }),
    };
    const result = await postGitHubReview({ prUrl: PR_URL, event: 'APPROVE', body: 'x' }, deps);
    expect(result.success).toBe(false);
    expect(result.error).toContain('head commit SHA');
  });

  it('errors on a malformed PR URL before spawning anything', async () => {
    const { deps } = makeDeps([]);
    const result = await postGitHubReview(
      { prUrl: 'not-a-url', event: 'APPROVE', body: 'x', commitId: SHA },
      deps
    );
    expect(result.success).toBe(false);
    expect(result.error).toContain('Unable to parse GitHub PR URL');
  });
});

describe('post_review handler — isOwnPrRejection', () => {
  it('matches GitHub own-PR rejection messages', () => {
    expect(isOwnPrRejection('reviewer cannot review their own pull request')).toBe(true);
    expect(isOwnPrRejection('HTTP 422: cannot review your own pull request')).toBe(true);
    expect(isOwnPrRejection('Validation Failed: reviewer cannot review')).toBe(true);
  });

  it('does not match unrelated errors', () => {
    expect(isOwnPrRejection('HTTP 404: Not Found')).toBe(false);
    expect(isOwnPrRejection('HTTP 500: Internal Server Error')).toBe(false);
    expect(isOwnPrRejection('')).toBe(false);
  });
});
