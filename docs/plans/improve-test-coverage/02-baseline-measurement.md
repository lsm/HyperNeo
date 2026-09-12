# Milestone 02: True Baseline Measurement

## Goal

After milestone 01 is merged and CI has run, capture the true per-package and aggregate coverage numbers. This baseline will determine the exact gap to 80% and guide prioritization of the test-writing milestones (03-08).

## Scope

- Run the full test suite locally (or wait for CI to report to Coveralls).
- Document per-package coverage percentages.
- Identify which packages/files have the most uncovered lines, to confirm the prioritization in milestones 03–08.

---

## Task 2.1: Run full coverage suite and document baseline

**Agent type**: general

**Description**

After milestone 01 is merged and a CI run completes, query Coveralls for the current coverage figures. Cross-reference with local `coverage/lcov.info` reports if needed.

**Subtasks**

1. Wait for milestone 01 PR to merge and CI to complete.
2. Check the Coveralls badge / API at `https://coveralls.io/github/lsm/neokai` for the updated `covered_percent`.
3. Run `bun run coverage` in `packages/web` locally and capture the text summary (statements, branches, functions, lines).
4. Run `./scripts/test-daemon.sh --coverage` locally and capture the per-shard coverage output.
5. Produce a simple table in this document (or a separate markdown) listing per-package coverage percentages and the delta to 80%.

**Acceptance criteria**

- A clear table exists showing current coverage% per package and the gap to 80%.
- The aggregate Coveralls figure after infrastructure changes is documented.
- This data is used to adjust priorities for milestones 03–08 if necessary (e.g., if one package is already at 75%, less effort is needed there).

**Depends on**: Milestone 01 all tasks merged and CI passing.

---

## Task 2.2: Triage and adjust priorities for milestones 03-08

**Agent type**: general

**Description**

Review the baseline numbers and confirm or adjust the file prioritization in milestones 03-08. Some assumptions in the plan (e.g. which files contribute the most uncovered lines) may shift once all files are visible to coverage tools.

**Subtasks**

1. Sort uncovered files by line count across all packages.
2. Verify the largest contributors match the files targeted in milestones 03-08.
3. If any unexpected files show up (e.g. a large file that was previously invisible), add them to the appropriate milestone's task list.
4. Estimate whether the planned test work in milestones 03-08 is sufficient to reach 80% or if additional files need to be covered.
5. Document any adjustments as notes at the top of the affected milestone files.

**Acceptance criteria**

- Milestones 03-08 have been reviewed against the actual baseline data.
- Any high-impact uncovered files not already in the plan have been added to the relevant milestone.
- A rough projection (e.g., "+15% from web component tests, +8% from daemon repo tests...") confirms the 80% target is achievable with the planned scope.

**Depends on**: Task 2.1
