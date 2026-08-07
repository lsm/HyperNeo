/**
 * Regression tests for the deterministic pre-merge validator (task #866).
 *
 * These reproduce the #857 / PR #2383 safety failure and assert the gate cannot
 * be reasoned around. All cases target the pure {@link evaluateMergeReadiness}
 * and {@link classifyMergeFailure} functions — no network, no model.
 */

import { describe, test, expect } from 'bun:test';
import {
  APPROVAL_RECOMMENDATION_MARKER,
  classifyMergeFailure,
  evaluateMergeReadiness,
  hasOutstandingChangesRequest,
  type MergeBlockerKind,
  type PrMergeSnapshot,
  type ReviewEntry,
} from '../../../../src/lib/space/runtime/merge-pr-validator';

const CURRENT_HEAD = 'e7be0167';
const OLD_HEAD = '5f5be646';
const PR_AUTHOR = 'author';

function review(opts: Partial<ReviewEntry> & { commitOid: string | null }): ReviewEntry {
  return { state: 'APPROVED', body: null, authorLogin: 'reviewer', submittedAt: null, ...opts };
}

/** A green, open, head-approved snapshot on `head`. */
function greenSnapshot(head: string, reviews: ReviewEntry[] = []): PrMergeSnapshot {
  return {
    prUrl: 'https://github.com/acme/repo/pull/42',
    state: 'OPEN',
    open: true,
    headRefOid: head,
    prAuthorLogin: PR_AUTHOR,
    baseRefName: 'dev',
    headRefName: 'feature/x',
    isCrossRepository: false,
    mergeStateStatus: 'CLEAN',
    reviewDecision: 'APPROVED',
    reviews,
    unresolvedThreadCount: 0,
    checkFailureCount: 0,
    fetchErrors: [],
  };
}

function kinds(validation: ReturnType<typeof evaluateMergeReadiness>): MergeBlockerKind[] {
  return validation.blockers.map((b) => b.kind);
}

describe('evaluateMergeReadiness — the #857 regression', () => {
  test('prior-head approval + empty CI commit + human Space approval stays BLOCKED', () => {
    // Exactly the #857 shape: the only approval covers the OLD head, the current
    // head is a later empty CI commit. A human approved the *task* — but that
    // provenance is not even an input here, so it cannot help.
    const snap = greenSnapshot(CURRENT_HEAD, [review({ commitOid: OLD_HEAD, state: 'APPROVED' })]);
    const result = evaluateMergeReadiness(snap);
    expect(result.ok).toBe(false);
    expect(result.validatedHeadOid).toBeUndefined();
    expect(kinds(result)).toContain('stale_approval');
    expect(result.blockers[0].detail).toContain(OLD_HEAD);
    expect(result.blockers[0].detail).toContain(CURRENT_HEAD);
  });

  test('current-head APPROVED review passes', () => {
    const snap = greenSnapshot(CURRENT_HEAD, [
      review({ commitOid: CURRENT_HEAD, state: 'APPROVED' }),
    ]);
    const result = evaluateMergeReadiness(snap);
    expect(result.ok).toBe(true);
    expect(result.validatedHeadOid).toBe(CURRENT_HEAD);
    expect(result.blockers).toEqual([]);
  });

  test('a stale approval AND a current-head approval passes (freshness wins)', () => {
    const snap = greenSnapshot(CURRENT_HEAD, [
      review({ commitOid: OLD_HEAD, state: 'APPROVED' }),
      review({ commitOid: CURRENT_HEAD, state: 'APPROVED' }),
    ]);
    const result = evaluateMergeReadiness(snap);
    expect(result.ok).toBe(true);
    expect(result.validatedHeadOid).toBe(CURRENT_HEAD);
  });
});

describe('evaluateMergeReadiness — own-PR recommendation vs real GitHub APPROVED', () => {
  test('own-PR "Recommendation: APPROVE" from the PR AUTHOR on the head is accepted', () => {
    const snap = greenSnapshot(CURRENT_HEAD, [
      review({
        commitOid: CURRENT_HEAD,
        state: 'COMMENTED',
        body: 'lgtm. Recommendation: APPROVE',
        authorLogin: PR_AUTHOR,
      }),
    ]);
    const result = evaluateMergeReadiness(snap);
    expect(result.ok).toBe(true);
    expect(result.validatedHeadOid).toBe(CURRENT_HEAD);
  });

  test('the marker from a NON-author is NOT accepted (fallback is own-PR-only)', () => {
    // Any commenter could drop the marker; only the PR author's own-PR
    // self-approval fallback should count.
    const snap = greenSnapshot(CURRENT_HEAD, [
      review({
        commitOid: CURRENT_HEAD,
        state: 'COMMENTED',
        body: 'Recommendation: APPROVE',
        authorLogin: 'someone-else',
      }),
    ]);
    const result = evaluateMergeReadiness(snap);
    expect(result.ok).toBe(false);
    expect(kinds(result)).toContain('missing_internal_recommendation');
  });

  test('a plain COMMENTED review (no marker) on the head is blocked as missing_internal_recommendation', () => {
    const snap = greenSnapshot(CURRENT_HEAD, [
      review({
        commitOid: CURRENT_HEAD,
        state: 'COMMENTED',
        body: 'looks fine',
        authorLogin: PR_AUTHOR,
      }),
    ]);
    const result = evaluateMergeReadiness(snap);
    expect(result.ok).toBe(false);
    expect(kinds(result)).toContain('missing_internal_recommendation');
  });

  test('no review at all on the head is blocked as missing_github_approved', () => {
    const snap = greenSnapshot(CURRENT_HEAD, []);
    const result = evaluateMergeReadiness(snap);
    expect(result.ok).toBe(false);
    expect(kinds(result)).toContain('missing_github_approved');
    expect(kinds(result)).not.toContain('stale_approval');
  });

  test('the approval marker regex matches only the documented phrase', () => {
    expect(APPROVAL_RECOMMENDATION_MARKER.test('Recommendation: APPROVE')).toBe(true);
    expect(APPROVAL_RECOMMENDATION_MARKER.test('recommendation: approve')).toBe(true);
    expect(APPROVAL_RECOMMENDATION_MARKER.test('Recommendation: APPROVE — merging')).toBe(true);
    // A stray "approve" without the marker phrase is NOT an approval.
    expect(APPROVAL_RECOMMENDATION_MARKER.test('I approve this')).toBe(false);
  });
});

describe('evaluateMergeReadiness — outstanding CHANGES_REQUESTED', () => {
  test('CHANGES_REQUESTED on the head blocks (changes_requested, not approved)', () => {
    const snap = greenSnapshot(CURRENT_HEAD, [
      review({ commitOid: CURRENT_HEAD, state: 'CHANGES_REQUESTED', authorLogin: 'rev1' }),
    ]);
    const result = evaluateMergeReadiness(snap);
    expect(result.ok).toBe(false);
    expect(kinds(result)).toContain('changes_requested');
  });

  test('CHANGES_REQUESTED blocks EVEN WHEN another reviewer approved the same head', () => {
    const snap = greenSnapshot(CURRENT_HEAD, [
      review({
        commitOid: CURRENT_HEAD,
        state: 'APPROVED',
        authorLogin: 'rev1',
        submittedAt: '2026-01-01T00:00:00Z',
      }),
      review({
        commitOid: CURRENT_HEAD,
        state: 'CHANGES_REQUESTED',
        authorLogin: 'rev2',
        submittedAt: '2026-01-02T00:00:00Z',
      }),
    ]);
    const result = evaluateMergeReadiness(snap);
    expect(result.ok).toBe(false);
    expect(kinds(result)).toContain('changes_requested');
  });

  test('a CHANGES_REQUESTED superseded by the SAME author later APPROVED passes', () => {
    const snap = greenSnapshot(CURRENT_HEAD, [
      review({
        commitOid: CURRENT_HEAD,
        state: 'CHANGES_REQUESTED',
        authorLogin: 'rev1',
        submittedAt: '2026-01-01T00:00:00Z',
      }),
      review({
        commitOid: CURRENT_HEAD,
        state: 'APPROVED',
        authorLogin: 'rev1',
        submittedAt: '2026-01-02T00:00:00Z',
      }),
    ]);
    const result = evaluateMergeReadiness(snap);
    expect(result.ok).toBe(true);
  });

  test('hasOutstandingChangesRequest is conservative when submittedAt is missing', () => {
    // Without timestamps we cannot prove the request was superseded → block.
    expect(
      hasOutstandingChangesRequest([
        {
          commitOid: 'h',
          state: 'CHANGES_REQUESTED',
          authorLogin: 'r',
          body: null,
          submittedAt: null,
        },
        { commitOid: 'h', state: 'APPROVED', authorLogin: 'r', body: null, submittedAt: null },
      ])
    ).toBe(true);
  });
});

describe('evaluateMergeReadiness — CI, threads, branch protection, state', () => {
  test('current-head approval but UNSTABLE mergeStateStatus is blocked on CI', () => {
    const snap = greenSnapshot(CURRENT_HEAD, [review({ commitOid: CURRENT_HEAD })]);
    snap.mergeStateStatus = 'UNSTABLE';
    const result = evaluateMergeReadiness(snap);
    expect(result.ok).toBe(false);
    expect(kinds(result)).toContain('ci_not_passing');
  });

  test('explicit check failures block even when mergeStateStatus is CLEAN', () => {
    const snap = greenSnapshot(CURRENT_HEAD, [review({ commitOid: CURRENT_HEAD })]);
    snap.checkFailureCount = 2;
    const result = evaluateMergeReadiness(snap);
    expect(result.ok).toBe(false);
    expect(kinds(result)).toContain('ci_not_passing');
  });

  test('unresolved review conversations block', () => {
    const snap = greenSnapshot(CURRENT_HEAD, [review({ commitOid: CURRENT_HEAD })]);
    snap.unresolvedThreadCount = 3;
    const result = evaluateMergeReadiness(snap);
    expect(result.ok).toBe(false);
    expect(kinds(result)).toContain('unresolved_threads');
  });

  test('reviewDecision REVIEW_REQUIRED blocks on branch_protection', () => {
    const snap = greenSnapshot(CURRENT_HEAD, [review({ commitOid: CURRENT_HEAD })]);
    snap.reviewDecision = 'REVIEW_REQUIRED';
    const result = evaluateMergeReadiness(snap);
    expect(result.ok).toBe(false);
    expect(kinds(result)).toContain('branch_protection');
  });

  test('mergeStateStatus BLOCKED blocks on branch_protection', () => {
    const snap = greenSnapshot(CURRENT_HEAD, [review({ commitOid: CURRENT_HEAD })]);
    snap.mergeStateStatus = 'BLOCKED';
    const result = evaluateMergeReadiness(snap);
    expect(result.ok).toBe(false);
    expect(kinds(result)).toContain('branch_protection');
  });

  test('DIRTY mergeStateStatus blocks on CI (conflict)', () => {
    const snap = greenSnapshot(CURRENT_HEAD, [review({ commitOid: CURRENT_HEAD })]);
    snap.mergeStateStatus = 'DIRTY';
    const result = evaluateMergeReadiness(snap);
    expect(result.ok).toBe(false);
    expect(kinds(result)).toContain('ci_not_passing');
  });

  test('empty/absent mergeStateStatus blocks (fail-closed, not ok:true)', () => {
    const snap = greenSnapshot(CURRENT_HEAD, [review({ commitOid: CURRENT_HEAD })]);
    snap.mergeStateStatus = '';
    const result = evaluateMergeReadiness(snap);
    expect(result.ok).toBe(false);
    expect(kinds(result)).toContain('ci_not_passing');
  });

  test('null mergeStateStatus blocks (fail-closed)', () => {
    const snap = greenSnapshot(CURRENT_HEAD, [review({ commitOid: CURRENT_HEAD })]);
    snap.mergeStateStatus = null;
    const result = evaluateMergeReadiness(snap);
    expect(result.ok).toBe(false);
    expect(kinds(result)).toContain('ci_not_passing');
  });

  test('closed PR blocks on pr_not_open even if otherwise green', () => {
    const snap = greenSnapshot(CURRENT_HEAD, [review({ commitOid: CURRENT_HEAD })]);
    snap.state = 'CLOSED';
    snap.open = false;
    const result = evaluateMergeReadiness(snap);
    expect(result.ok).toBe(false);
    expect(kinds(result)).toContain('pr_not_open');
  });

  test('fetch errors block (fail closed)', () => {
    const snap = greenSnapshot(CURRENT_HEAD, [review({ commitOid: CURRENT_HEAD })]);
    snap.fetchErrors = ['review-threads query timed out'];
    const result = evaluateMergeReadiness(snap);
    expect(result.ok).toBe(false);
    expect(kinds(result)).toContain('fetch_failed');
  });

  test('multiple distinct blockers are all reported', () => {
    const snap = greenSnapshot(CURRENT_HEAD, []);
    snap.mergeStateStatus = 'UNSTABLE';
    snap.unresolvedThreadCount = 1;
    snap.reviewDecision = 'REVIEW_REQUIRED';
    const result = evaluateMergeReadiness(snap);
    expect(result.ok).toBe(false);
    const reported = new Set(kinds(result));
    expect(reported.has('missing_github_approved')).toBe(true);
    expect(reported.has('ci_not_passing')).toBe(true);
    expect(reported.has('unresolved_threads')).toBe(true);
    expect(reported.has('branch_protection')).toBe(true);
  });
});

describe('evaluateMergeReadiness — no admin / human bypass', () => {
  test('there is no input that can bypass the head-coverage requirement', () => {
    // The signature takes ONLY a snapshot. An admin/human task approval is not
    // representable here, so a head with no covering approval is always blocked.
    const snap = greenSnapshot(CURRENT_HEAD, [review({ commitOid: OLD_HEAD })]);
    const result = evaluateMergeReadiness(snap);
    expect(result.ok).toBe(false);
    // Sanity: confirm the type carries no approvalSource/force/isAdmin field.
    expect(snap).not.toHaveProperty('approvalSource');
    expect(snap).not.toHaveProperty('force');
    expect(snap).not.toHaveProperty('isAdmin');
  });
});

describe('classifyMergeFailure — concurrent push + failure routing', () => {
  test('concurrent push (head changed) fails safely as head_changed', () => {
    // The merge was bound to the validated head via --match-head-commit; a push
    // that moved the head makes gh reject it. This must surface as head_changed.
    const outcome = {
      ok: false,
      exitCode: 1,
      stdout: '',
      stderr: 'X Failed to merge: the head ref did not match the expected commit',
      stateAfter: 'OPEN',
    };
    const blocker = classifyMergeFailure(outcome, CURRENT_HEAD);
    expect(blocker.kind).toBe('head_changed');
    expect(blocker.detail).toContain(CURRENT_HEAD);
  });

  test('--match-head-commit mismatch message maps to head_changed', () => {
    const blocker = classifyMergeFailure(
      {
        ok: false,
        exitCode: 1,
        stdout: '',
        stderr: 'match-head-commit mismatch',
        stateAfter: 'OPEN',
      },
      CURRENT_HEAD
    );
    expect(blocker.kind).toBe('head_changed');
  });

  test('realistic gh "Head branch was modified" output maps to head_changed', () => {
    // gh does not echo --match-head-commit; on a moved head it emits a 409-style
    // message. The regex must catch this (not fall through to merge_failed).
    const blocker = classifyMergeFailure(
      {
        ok: false,
        exitCode: 1,
        stdout: '',
        stderr: 'Head branch was modified. Please refresh and try again.',
        stateAfter: 'OPEN',
      },
      CURRENT_HEAD
    );
    expect(blocker.kind).toBe('head_changed');
  });

  test('permission rejection maps to permissions', () => {
    const blocker = classifyMergeFailure(
      {
        ok: false,
        exitCode: 1,
        stdout: '',
        stderr: '403 Forbidden: merge not permitted',
        stateAfter: 'OPEN',
      },
      CURRENT_HEAD
    );
    expect(blocker.kind).toBe('permissions');
  });

  test('branch-protection rejection maps to branch_protection', () => {
    const blocker = classifyMergeFailure(
      {
        ok: false,
        exitCode: 1,
        stdout: '',
        stderr: 'required status check "CI" is failing',
        stateAfter: 'OPEN',
      },
      CURRENT_HEAD
    );
    expect(blocker.kind).toBe('branch_protection');
  });

  test('unclassified failure maps to merge_failed', () => {
    const blocker = classifyMergeFailure(
      { ok: false, exitCode: 2, stdout: '', stderr: 'something unexpected', stateAfter: 'OPEN' },
      CURRENT_HEAD
    );
    expect(blocker.kind).toBe('merge_failed');
  });
});
