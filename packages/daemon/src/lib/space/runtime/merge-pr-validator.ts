/**
 * Deterministic pre-merge validator for post-approval PR merges.
 *
 * ## Why this exists — task #866 (regression of #857 / PR #2383)
 *
 * The PR Merger is an LLM agent that merges via its Bash tool (`gh pr merge`).
 * Previously, the ONLY thing standing between an unreviewed head and a merge
 * was prompt text telling the model "verify the approval covers the current
 * head." On task #857 the model explicitly saw the sole approval covered the
 * old head `5f5be646` while the current head was `e7be0167`, but inferred that
 * `approval_source: human` (a Space *task*-approval provenance marker) overrode
 * the current-head requirement — and merged anyway. Prompt-only safety is
 * reasoning-around-able; this module replaces it with code.
 *
 * ## Two distinct concepts (requirement #2)
 *
 *   - **Space task approval** — provenance (`SpaceApprovalSource`: `'human' |
 *     'auto_policy' | 'agent'`) recording HOW a task reached `approved`. This is
 *     a task-lifecycle fact. It is NEVER an input to this validator.
 *   - **PR-head approval** — a real GitHub review (or the documented own-PR
 *     "Recommendation: APPROVE" comment) whose `commit_id` equals the PR's
 *     current `headRefOid`. This is the only thing that authorizes a merge.
 *
 * The type system enforces the separation: {@link evaluateMergeReadiness} takes a
 * snapshot of GitHub state and nothing else. There is no `approvalSource`,
 * `isAdmin`, or `force` parameter to reason around. A human task approval does
 * NOT override a missing/stale PR-head approval (default policy = NO; see the
 * policy note below).
 *
 * ## Policy on human-approval override (requirement #4)
 *
 * Default and only supported policy: a Space task approval can NEVER substitute
 * for a current-head PR approval. If an override were ever needed it would have
 * to be a SEPARATE, head-bound, auditable action (recorded against a specific
 * commit_oid), never inferred from generic `approval_source: human`. No such
 * override is wired here; the validator structurally cannot be bypassed by a
 * task-approval signal.
 *
 * ## Own-PR "Recommendation: APPROVE" fallback
 *
 * GitHub stores an APPROVE submitted by the PR *author* as COMMENTED (it rejects
 * self-approval). The documented fallback is that the author leaves a COMMENTED
 * review carrying the body marker "Recommendation: APPROVE". Because any
 * commenter could otherwise drop that marker on an ordinary PR, this fallback is
 * honoured ONLY when the marker review's author is the PR author
 * (`review.authorLogin === snapshot.prAuthorLogin`).
 *
 * ## Blocker taxonomy (requirement #6)
 *
 *   - `pr_not_open`             — PR is closed/merged/not open.
 *   - `stale_approval`          — approval exists, but on a commit other than the
 *                                 current head (the #857 failure mode).
 *   - `changes_requested`       — an outstanding CHANGES_REQUESTED on the current
 *                                 head, even if another reviewer approved.
 *   - `missing_github_approved` — no real GitHub APPROVED review covers the head.
 *   - `missing_internal_recommendation` — comment on head without the author-bound
 *                                 "Recommendation: APPROVE" marker.
 *   - `unresolved_threads`      — ≥1 review conversation is unresolved.
 *   - `ci_not_passing`          — required check pending/failing, conflict, behind.
 *   - `branch_protection`       — reviewDecision REVIEW_REQUIRED / BLOCKED.
 *   - `unauthorized`            — caller is not this task's post-approval merger.
 *   - `permissions`             — merge attempt rejected for auth/permissions.
 *   - `head_changed`            — head changed between validation and merge.
 *   - `fetch_failed`            — GitHub state could not be read (fail closed).
 *   - `merge_failed`            — merge attempt failed for an unclassified reason.
 */

/** A single GitHub review relevant to the merge decision. */
export interface ReviewEntry {
  /** OID of the head commit the review was submitted against (`commit{oid}`). */
  commitOid: string | null;
  /** Review state: APPROVED | CHANGES_REQUESTED | COMMENTED | PENDING | DISMISSED. */
  state: string;
  /** Review body (used to detect the own-PR "Recommendation: APPROVE" marker). */
  body: string | null;
  /** Login of the reviewer. */
  authorLogin: string | null;
  /** ISO timestamp the review was submitted (determines latest-per-author). */
  submittedAt: string | null;
}

/** The GitHub state a merge decision is computed from. Fetched by the caller. */
export interface PrMergeSnapshot {
  prUrl: string;
  /** Raw PR state (`OPEN` | `MERGED` | `CLOSED`). */
  state: string;
  /** True when `state === 'OPEN'`. */
  open: boolean;
  /** Current head OID — the exact commit that must be covered by an approval. */
  headRefOid: string | null;
  /** Login of the PR author (binds the own-PR recommendation fallback). */
  prAuthorLogin: string | null;
  /** Base branch name the PR merges into. */
  baseRefName: string | null;
  headRefName: string | null;
  isCrossRepository: boolean;
  /** `CLEAN` | `BLOCKED` | `BEHIND` | `UNSTABLE` | `DIRTY` | `UNKNOWN` | null. */
  mergeStateStatus: string | null;
  /** `APPROVED` | `REVIEW_REQUIRED` | `UNKNOWN` | null (branch-protection signal). */
  reviewDecision: string | null;
  /** Reviews on the PR (any commit). */
  reviews: ReviewEntry[];
  /** Count of unresolved review conversations. */
  unresolvedThreadCount: number;
  /** Number of checks in the rollup reporting failure (non-zero blocks). */
  checkFailureCount: number;
  /** Partial-fetch errors (each forces a `fetch_failed` blocker — fail closed). */
  fetchErrors: string[];
}

/** Outcome of a `gh pr merge` attempt. */
export interface MergeOutcome {
  /** True when `gh pr merge` exited 0. */
  ok: boolean;
  exitCode: number;
  stdout: string;
  stderr: string;
  /** PR state after the attempt (`MERGED` | `OPEN` when enqueued, etc.). */
  stateAfter: string | null;
  /** Normalised error message when `ok` is false. */
  error?: string;
}

/** Discriminated blocker kinds — see module docstring. */
export type MergeBlockerKind =
  | 'pr_not_open'
  | 'stale_approval'
  | 'changes_requested'
  | 'missing_github_approved'
  | 'missing_internal_recommendation'
  | 'unresolved_threads'
  | 'ci_not_passing'
  | 'branch_protection'
  | 'unauthorized'
  | 'permissions'
  | 'head_changed'
  | 'fetch_failed'
  | 'merge_failed';

export interface MergeBlocker {
  kind: MergeBlockerKind;
  /** Human-readable, actionable detail (relayed to the approval authority). */
  detail: string;
}

export interface MergeValidation {
  /** True only when there are zero blockers AND the head is known. */
  ok: boolean;
  /** The head OID that was validated (the merge must bind to exactly this). */
  validatedHeadOid?: string;
  blockers: MergeBlocker[];
  /** The snapshot the decision was computed from (for audit/reporting). */
  snapshot: PrMergeSnapshot;
}

/** Body marker for the own-PR APPROVE fallback (GitHub stores author APPROVE as COMMENTED). */
export const APPROVAL_RECOMMENDATION_MARKER = /Recommendation:\s*APPROVE/i;
/** Body marker for the own-PR REQUEST_CHANGES fallback (stored as COMMENTED by the same path). */
export const REQUEST_CHANGES_RECOMMENDATION_MARKER = /Recommendation:\s*REQUEST_CHANGES/i;

/**
 * Effective approval: a real APPROVED review (any reviewer) OR — only from the PR
 * author — a COMMENTED review carrying the "Recommendation: APPROVE" marker (the
 * own-PR self-approval fallback). Markers from non-authors are ignored.
 */
function effectiveIsApproval(review: ReviewEntry, prAuthor: string | null): boolean {
  if (review.state === 'APPROVED') return true;
  return (
    !!prAuthor &&
    review.authorLogin === prAuthor &&
    review.state === 'COMMENTED' &&
    !!review.body &&
    APPROVAL_RECOMMENDATION_MARKER.test(review.body)
  );
}

/**
 * Effective changes request: a real CHANGES_REQUESTED review (any reviewer) OR —
 * only from the PR author — a COMMENTED "Recommendation: REQUEST_CHANGES" marker.
 */
function effectiveIsChangesRequest(review: ReviewEntry, prAuthor: string | null): boolean {
  if (review.state === 'CHANGES_REQUESTED') return true;
  return (
    !!prAuthor &&
    review.authorLogin === prAuthor &&
    review.state === 'COMMENTED' &&
    !!review.body &&
    REQUEST_CHANGES_RECOMMENDATION_MARKER.test(review.body)
  );
}

/**
 * True when an OUTSTANDING changes request sits among the given reviews: an
 * effective changes request (real state or author REQUEST_CHANGES marker) from an
 * author who has not since submitted an effective approval. Such a request blocks
 * the merge even when another reviewer approved, and catches: the author
 * recommending APPROVE then REQUEST_CHANGES on the same head, AND a changes
 * request left on an earlier commit that a new-head approval did not supersede.
 *
 * Supersession requires BOTH timestamps present and the approval strictly later —
 * missing timestamps cannot prove supersession, so the rejection stays
 * outstanding (fail closed). `prAuthor` (default null) gates marker
 * interpretation.
 */
export function hasOutstandingChangesRequest(
  reviews: ReviewEntry[],
  prAuthor: string | null = null
): boolean {
  for (const req of reviews) {
    if (!effectiveIsChangesRequest(req, prAuthor)) continue;
    const author = req.authorLogin ?? '';
    const superseded = reviews.some(
      (r) =>
        (r.authorLogin ?? '') === author &&
        effectiveIsApproval(r, prAuthor) &&
        typeof req.submittedAt === 'string' &&
        typeof r.submittedAt === 'string' &&
        r.submittedAt > req.submittedAt
    );
    if (!superseded) return true;
  }
  return false;
}

/**
 * PURE merge-readiness evaluation. Given a snapshot of GitHub state, returns the
 * structured validation. No I/O, no `approvalSource`, no overrides — this is the
 * deterministic gate. All regression tests target this function directly.
 *
 * Fail-closed: an unknown head, or any fetch error, blocks the merge.
 */
export function evaluateMergeReadiness(snapshot: PrMergeSnapshot): MergeValidation {
  const blockers: MergeBlocker[] = [];
  const head = snapshot.headRefOid;

  if (snapshot.fetchErrors.length > 0) {
    blockers.push({
      kind: 'fetch_failed',
      detail: `Could not read complete PR state from GitHub: ${snapshot.fetchErrors.join('; ')}. Fail closed — do not merge.`,
    });
  }

  if (!snapshot.open) {
    blockers.push({
      kind: 'pr_not_open',
      detail: `PR is not open (state: ${snapshot.state || 'unknown'}).`,
    });
  }

  if (typeof head !== 'string' || head.length === 0) {
    blockers.push({
      kind: 'fetch_failed',
      detail: 'Current headRefOid is unavailable; cannot verify approval coverage.',
    });
  }

  // --- Approval / rejection coverage on the CURRENT head ---
  if (typeof head === 'string' && head.length > 0) {
    const onHead = snapshot.reviews.filter((r) => r.commitOid === head);
    const prAuthor = snapshot.prAuthorLogin;

    // An outstanding changes request blocks EVEN IF another reviewer approved.
    // Scanned across ALL reviews (not just the current head) so a changes
    // request left on an earlier commit — that a new-head approval did not
    // supersede — still blocks. Marker-aware: an author "Recommendation:
    // REQUEST_CHANGES" counts, and a later same-author approval (state or
    // APPROVE marker, with both timestamps present) supersedes it.
    if (hasOutstandingChangesRequest(snapshot.reviews, prAuthor)) {
      blockers.push({
        kind: 'changes_requested',
        detail:
          'An outstanding CHANGES_REQUESTED review is present (on the current head or an earlier commit, not superseded by the same reviewer). Dismiss or resolve it before merging.',
      });
    } else {
      // Effective approval = real APPROVED (any reviewer) OR the PR author's
      // own-PR "Recommendation: APPROVE" marker (author-bound).
      const hasApproval = onHead.some((r) => effectiveIsApproval(r, prAuthor));

      if (!hasApproval) {
        const stale = snapshot.reviews.find(
          (r) => effectiveIsApproval(r, prAuthor) && r.commitOid !== head
        );
        if (onHead.some((r) => r.state === 'COMMENTED')) {
          blockers.push({
            kind: 'missing_internal_recommendation',
            detail:
              'A comment review exists on the current head but carries no author-bound "Recommendation: APPROVE" marker, and there is no APPROVED review. ' +
              'For an own-PR where GitHub rejects self-approval, the PR author posts a COMMENTED review with that exact marker on the current head; otherwise post a real APPROVED review.',
          });
        } else if (stale) {
          blockers.push({
            kind: 'stale_approval',
            detail: `The only approval covers commit ${stale.commitOid}, not the current head ${head}. Re-approve the current head.`,
          });
        } else {
          blockers.push({
            kind: 'missing_github_approved',
            detail: 'No APPROVED review covers the current head.',
          });
        }
      }
    }
  }

  // --- Review-decision signal (where queryable) ---
  const decision = (snapshot.reviewDecision ?? '').toUpperCase();
  if (decision === 'REVIEW_REQUIRED') {
    blockers.push({
      kind: 'branch_protection',
      detail:
        'GitHub reviewDecision is REVIEW_REQUIRED — branch protection requires additional or different approval (e.g. code-owner, count) for this head.',
    });
  } else if (decision === 'CHANGES_REQUESTED') {
    // Trust GitHub's dismissal-aware computation: an outstanding changes request
    // spans the PR (e.g. left on an earlier commit). Belt-and-suspenders alongside
    // the cross-commit scan above.
    blockers.push({
      kind: 'changes_requested',
      detail:
        'GitHub reviewDecision is CHANGES_REQUESTED — an outstanding changes request remains. Resolve or dismiss it before merging.',
    });
  }

  // --- Unresolved review conversations ---
  if (snapshot.unresolvedThreadCount > 0) {
    blockers.push({
      kind: 'unresolved_threads',
      detail: `${snapshot.unresolvedThreadCount} unresolved review conversation(s). Resolve them before merging.`,
    });
  }

  // --- CI / mergeability via mergeStateStatus + explicit check failures ---
  const ms = (snapshot.mergeStateStatus ?? '').toUpperCase();
  if (ms === 'BLOCKED') {
    blockers.push({
      kind: 'branch_protection',
      detail: 'mergeStateStatus is BLOCKED — a branch-protection / required-check rule is failing.',
    });
  } else if (ms === 'BEHIND') {
    blockers.push({
      kind: 'ci_not_passing',
      detail: 'mergeStateStatus is BEHIND — the head must be rebased onto the base branch.',
    });
  } else if (ms === 'UNSTABLE') {
    blockers.push({
      kind: 'ci_not_passing',
      detail: 'mergeStateStatus is UNSTABLE — a required check is pending or failing.',
    });
  } else if (ms === 'DIRTY') {
    blockers.push({
      kind: 'ci_not_passing',
      detail: 'mergeStateStatus is DIRTY — there is a merge conflict.',
    });
  } else if (ms === 'UNKNOWN') {
    blockers.push({
      kind: 'ci_not_passing',
      detail: 'mergeStateStatus is UNKNOWN — GitHub is recomputing mergeability; re-check shortly.',
    });
  } else if (ms !== 'CLEAN' && ms !== 'HAS_HOOKS') {
    // Fail-closed: an absent/empty/unrecognised mergeStateStatus cannot be
    // treated as mergeable (do not fail open to ok:true). HAS_HOOKS is accepted
    // alongside CLEAN (GitHub Enterprise reports it for mergeable PRs with
    // pre-receive hooks — matching pr-ready-validator's accepted set).
    blockers.push({
      kind: 'ci_not_passing',
      detail: `mergeStateStatus is ${ms || 'empty/absent'} — cannot confirm the PR is mergeable; re-check before merging.`,
    });
  }
  if (snapshot.checkFailureCount > 0) {
    blockers.push({
      kind: 'ci_not_passing',
      detail: `${snapshot.checkFailureCount} check(s) reported failure in the status check rollup.`,
    });
  }

  const ok = blockers.length === 0;
  return {
    ok,
    validatedHeadOid: ok && head ? head : undefined,
    blockers,
    snapshot,
  };
}

/**
 * PURE classification of a failed `gh pr merge` outcome into a blocker. Used
 * after the validator passes but the merge still fails (e.g. a concurrent push
 * moved the head between validation and the merge command).
 */
export function classifyMergeFailure(outcome: MergeOutcome, validatedHead: string): MergeBlocker {
  const text = `${outcome.stderr}\n${outcome.stdout}`.toLowerCase();
  const err = (outcome.error ?? `gh pr merge exited with code ${outcome.exitCode}`).toLowerCase();

  // Concurrent-push / head-mismatch: the safe failure mode. gh does not echo
  // the `--match-head-commit` flag itself; real output is along the lines of
  // "Head branch was modified", "head ref ... did not match", or a 409 "merge
  // conflict" / "was modified". Match those phrasings (validated against the
  // family of messages gh emits for a moved head), not the flag name.
  const modified = /(was|has been|been) modified|pull request .* (was |has been )?(modif|chang)/;
  const headKeyword = /head (branch|ref|sha|commit)/;
  const mismatchWord = /(modif|chang|differ|mismatch|did not match|stale|unexpected)/;
  const headChanged =
    /match[- ]head/.test(text) ||
    modified.test(text) ||
    (headKeyword.test(text) && mismatchWord.test(text)) ||
    (headKeyword.test(err) && mismatchWord.test(err));
  if (headChanged) {
    return {
      kind: 'head_changed',
      detail: `The head changed between validation (${validatedHead}) and the merge — the merge was rejected. Re-verify the current head.`,
    };
  }

  if (/(403|forbidden|permission|not permitted|insufficient|resource not accessible)/.test(text)) {
    return {
      kind: 'permissions',
      detail:
        'Merge rejected for permissions/auth. This is an administrative blocker — escalate, do not self-approve.',
    };
  }

  if (
    /(protected branch|branch protection|required status check|review required|merge method)/.test(
      text
    )
  ) {
    return {
      kind: 'branch_protection',
      detail:
        'GitHub rejected the merge due to branch protection / required checks / required reviews.',
    };
  }

  return {
    kind: 'merge_failed',
    detail:
      outcome.error ?? `gh pr merge exited with code ${outcome.exitCode}: ${outcome.stderr.trim()}`,
  };
}
