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
 * ## Blocker taxonomy (requirement #6)
 *
 * Each blocker carries a {@link MergeBlockerKind} so callers (the Merger, then
 * the approval authority) can route precisely:
 *   - `pr_not_open`           — PR is closed/merged/not open.
 *   - `stale_approval`        — an approval exists, but on a commit other than
 *                               the current head (the #857 failure mode).
 *   - `missing_github_approved` — no real GitHub `APPROVED` review covers the
 *                               current head (non-own-PR path).
 *   - `missing_internal_recommendation` — a comment review sits on the head but
 *                               carries no "Recommendation: APPROVE" marker and
 *                               no APPROVED review (own-PR fallback absent).
 *   - `unresolved_threads`    — ≥1 review conversation is unresolved.
 *   - `ci_not_passing`        — required check pending/failing, conflict, behind,
 *                               or GitHub recomputing mergeability.
 *   - `branch_protection`     — `reviewDecision: REVIEW_REQUIRED` or
 *                               `mergeStateStatus: BLOCKED`.
 *   - `permissions`           — merge attempt rejected for auth/permissions.
 *   - `head_changed`          — head changed between validation and merge.
 *   - `fetch_failed`          — GitHub state could not be read (fail closed).
 *   - `merge_failed`          — merge attempt failed for an unclassified reason.
 */

/** Body marker an approval authority leaves on an own-PR where GitHub rejects a
 *  self-APPROVED review (it stores APPROVE from the author as COMMENTED). */
export const APPROVAL_RECOMMENDATION_MARKER = /Recommendation:\s*APPROVE/i;

/** A single GitHub review relevant to the merge decision. */
export interface ReviewEntry {
  /** OID of the head commit the review was submitted against (`commit{oid}`). */
  commitOid: string | null;
  /** Review state: APPROVED | CHANGES_REQUESTED | COMMENTED | PENDING | DISIMISSED. */
  state: string;
  /** Review body (used to detect the own-PR "Recommendation: APPROVE" marker). */
  body: string | null;
  /** Login of the reviewer. */
  authorLogin: string | null;
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
  | 'missing_github_approved'
  | 'missing_internal_recommendation'
  | 'unresolved_threads'
  | 'ci_not_passing'
  | 'branch_protection'
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

/** A review counts as an approval/recommendation for coverage purposes. */
function isApprovalish(review: ReviewEntry): boolean {
  if (review.state === 'APPROVED') return true;
  if (
    review.state === 'COMMENTED' &&
    review.body &&
    APPROVAL_RECOMMENDATION_MARKER.test(review.body)
  ) {
    return true;
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
    // No head ⇒ we cannot verify coverage. Fail closed.
    blockers.push({
      kind: 'fetch_failed',
      detail: 'Current headRefOid is unavailable; cannot verify approval coverage.',
    });
  }

  // --- Approval coverage on the CURRENT head (the #857 gate) ---
  if (typeof head === 'string' && head.length > 0) {
    const onHead = snapshot.reviews.filter((r) => r.commitOid === head);
    const realApproved = onHead.some((r) => r.state === 'APPROVED');
    const internalRec = onHead.some(
      (r) => r.state === 'COMMENTED' && !!r.body && APPROVAL_RECOMMENDATION_MARKER.test(r.body)
    );
    const changesRequested = onHead.some((r) => r.state === 'CHANGES_REQUESTED');

    if (!realApproved && !internalRec) {
      const stale = snapshot.reviews.find((r) => isApprovalish(r) && r.commitOid !== head);
      if (changesRequested) {
        blockers.push({
          kind: 'missing_github_approved',
          detail:
            'A CHANGES_REQUESTED review sits on the current head — the head is rejected, not approved.',
        });
      } else if (stale) {
        blockers.push({
          kind: 'stale_approval',
          detail: `The only approval/recommendation covers commit ${stale.commitOid}, not the current head ${head}. Re-approve the current head.`,
        });
      } else if (onHead.some((r) => r.state === 'COMMENTED')) {
        blockers.push({
          kind: 'missing_internal_recommendation',
          detail:
            'A comment review exists on the current head but carries no "Recommendation: APPROVE" marker, and there is no APPROVED review. ' +
            'For an own-PR where GitHub rejects self-approval, post a COMMENTED review with that exact marker on the current head; otherwise post a real APPROVED review.',
        });
      } else {
        blockers.push({
          kind: 'missing_github_approved',
          detail:
            'No APPROVED review (or own-PR "Recommendation: APPROVE" comment) covers the current head.',
        });
      }
    }
  }

  // --- Branch-protection required-review signal (where queryable) ---
  const decision = (snapshot.reviewDecision ?? '').toUpperCase();
  if (decision === 'REVIEW_REQUIRED') {
    blockers.push({
      kind: 'branch_protection',
      detail:
        'GitHub reviewDecision is REVIEW_REQUIRED — branch protection requires additional or different approval (e.g. code-owner, count) for this head.',
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

  // --match-head-commit mismatch (concurrent push): the safe failure mode.
  const headChanged =
    /match-head-commit/.test(text) ||
    (/head/.test(text) && /(did not match|different|changed|unexpected|stale)/.test(text)) ||
    (/head/.test(err) && /(did not match|different|changed|unexpected|stale)/.test(err));
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
