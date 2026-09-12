# Milestone 8: Raise CI Gate to 80%

## Milestone Goal

Update the CI coverage quality gate from the intermediate 70% (set in Milestone 1) to the
final target of 80%, confirming that all packages meet the threshold before making the
change. This is the final milestone and must only be executed after all test-writing
milestones (3–7) have been merged and verified in CI.

## Scope

Files modified:
- `.github/workflows/main.yml` — update `MIN_COVERAGE=70` to `MIN_COVERAGE=80`

Files verified (no modification needed if already set):
- `packages/web/vitest.config.ts` — thresholds at 80% (set in Milestone 1)
- `bunfig.toml` — `coverageThreshold` at 0.80 (set in Milestone 1)

## Pre-Conditions

Before starting this milestone, verify all of the following are true:
1. Milestones 3, 4, 5, 6, and 7 have merged PRs into `dev`.
2. The most recent CI run on `dev` passed the `coverage-gate` job with `MIN_COVERAGE=70`.
3. The Coveralls dashboard for the repo shows overall coverage >= 80%.
4. The web package test run locally passes with the 80% thresholds in `vitest.config.ts`.
5. The daemon unit tests pass with the `coverageThreshold` in `bunfig.toml`.

## Tasks

---

### Task 8.1: Verify coverage meets 80% across all packages

**Agent type:** general

**Description:**
Run coverage locally for each package and confirm the numbers exceed 80% before changing the
CI gate. Document the final per-package numbers in `docs/plans/coverage-mission/baseline-report.md`
as a "post-test" update.

**Subtasks (ordered):**
1. From `packages/web`, run `bun run coverage`. Confirm the output shows all four metrics
   (lines, branches, functions, statements) at >= 80% with no threshold failures.
2. From the repo root, run `./scripts/test-daemon.sh 0-shared --coverage` and record the
   coverage summary.
3. Repeat for at least two shards most representative of overall daemon coverage:
   `./scripts/test-daemon.sh 4-space-storage --coverage` and
   `./scripts/test-daemon.sh 5-space-runtime --coverage`.
4. If any package is below 80%, do NOT proceed — instead, file a follow-up task in the
   test-writing milestones to close the remaining gap.
5. Once all packages are confirmed above 80%, document the final numbers in
   `docs/plans/coverage-mission/baseline-report.md` under a "Final Measurement" section.

**Acceptance criteria:**
- Web coverage is >= 80% for lines, branches, functions, and statements without threshold
  failures.
- Daemon unit coverage is >= 80% for lines across all tested shards.
- `baseline-report.md` has a "Final Measurement" section with the numbers.

**Depends on:** Milestones 3, 4, 5, 6, 7 all merged

---

### Task 8.2: Raise CI gate to 80%

**Agent type:** coder

**Description:**
Update the CI workflow to enforce the 80% coverage gate. This is a single-line change to
`.github/workflows/main.yml`.

**Subtasks (ordered):**
1. Read `.github/workflows/main.yml`, confirm `MIN_COVERAGE=70` is present in the
   `coverage-gate` job (as set in Milestone 1 Task 1.3).
2. Change `MIN_COVERAGE=70` to `MIN_COVERAGE=80`.
3. Remove the inline comment `# Intermediate: will be raised to 80 in Milestone 8` and
   replace with `# Target: 80% project-wide coverage`.
4. Verify no other `MIN_COVERAGE` references exist with stale values.
5. Create a feature branch `raise/coverage-gate-80`, commit, and open a PR to `dev` via
   `gh pr create`.
6. Monitor the CI run on the PR to confirm the `coverage-gate` job passes with 80% minimum.
   If it fails, do not merge — escalate to identify which package missed the threshold.

**Acceptance criteria:**
- `.github/workflows/main.yml` contains `MIN_COVERAGE=80`.
- The CI `coverage-gate` job passes on the PR branch.
- Changes are on a feature branch with a GitHub PR created via `gh pr create`.

**Depends on:** Task 8.1 (verification that coverage meets 80%)
