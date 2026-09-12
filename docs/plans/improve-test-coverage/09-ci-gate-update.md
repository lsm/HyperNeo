# Milestone 09: CI Gate Update

## Goal

Raise the `MIN_COVERAGE` threshold in `.github/workflows/main.yml` from 30 to 80, enforcing the target permanently in CI. This milestone must be the final step — executed only after aggregate coverage is confirmed to be at or above 80%.

## Prerequisites

Before raising the gate:

1. All milestones 01-08 are merged to `dev`.
2. A CI run has completed and Coveralls reports aggregate coverage >= 80%.
3. The Coveralls dashboard at `https://coveralls.io/github/lsm/neokai` shows the current `covered_percent`.

---

## Task 9.1: Verify coverage is at 80% before raising the gate

**Agent type**: general

**Description**

Query the Coveralls API (or dashboard) to confirm the actual coverage is at or above 80% before modifying the CI gate. Raising the gate prematurely would break CI for all PRs.

**Subtasks**

1. Check the Coveralls badge URL: `https://coveralls.io/repos/github/lsm/neokai/badge.svg`
2. Or query the API: `curl https://coveralls.io/github/lsm/neokai.json | jq .covered_percent`
3. If coverage is below 80%, identify which milestones are still pending and do not proceed to task 9.2.
4. If coverage is at or above 80%, document the exact percentage and proceed.

**Acceptance criteria**

- A documented confirmation that Coveralls reports >= 80% aggregate coverage.
- This confirmation is referenced in the PR description for task 9.2.

**Depends on**: All milestones 01-08 merged and CI passing.

---

## Task 9.2: Raise MIN_COVERAGE gate to 80 in CI

**Agent type**: coder

**Description**

Update the coverage gate threshold and adjust the regression guard if needed.

**Files to modify**

- `.github/workflows/main.yml`

**Subtasks**

1. Change line `MIN_COVERAGE=30` to `MIN_COVERAGE=80` in the `coverage-gate` job.
2. Review the `MAX_REGRESSION=-2` setting. With 80% as the baseline, a 2% regression allowance (-2%) is reasonable. Keep it at -2 unless the team wants a tighter guard.
3. Update any inline comments near `MIN_COVERAGE` to reflect the new target.
4. Optionally: add a comment explaining when this was raised and the rationale.

**Example diff:**

```yaml
- MIN_COVERAGE=30
+ MIN_COVERAGE=80
```

5. Commit and create a PR against `dev`.
6. Wait for CI to confirm the gate passes (it will query Coveralls for the current coverage; as long as coverage is at 80%+, the gate will pass).

**Acceptance criteria**

- `MIN_COVERAGE=80` is set in `.github/workflows/main.yml`.
- The CI `coverage-gate` job passes on the `dev` branch after this change.
- No other CI jobs are broken.
- Changes must be on a feature branch with a GitHub PR created via `gh pr create`.

**Depends on**: Task 9.1 (coverage confirmed at 80%+).
