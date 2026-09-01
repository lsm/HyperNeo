# Milestone 2: Establish Coverage Baseline

## Milestone Goal

Run coverage for all packages locally (after infrastructure fixes from Milestone 1 are
merged) and document the actual per-package and per-file coverage percentages. This baseline
tells us exactly how far we are from 80% and which files contribute most to the gap.

## Scope

No source or test files are created in this milestone. The output is a documented baseline
report committed to `docs/plans/coverage-mission/baseline-report.md`.

## Tasks

---

### Task 2.1: Run web coverage and document results

**Agent type:** general

**Description:**
Run the Vitest coverage command for the web package (after Milestone 1 changes are in place)
and record the per-file and summary percentages. Pay particular attention to which files
show 0% after `coverage.include` is enabled — these are the targets for Milestones 3–5.

**Subtasks (ordered):**
1. Ensure Milestone 1 Task 1.1 changes are merged into `dev` (or apply them locally on top
   of dev if running ahead).
2. From `packages/web`, run: `bun run coverage` (which calls `vitest run --reporter dot --coverage`).
3. Capture the text coverage table output. Note: the run may now fail with a threshold error
   (expected — coverage is below 80%). Record the raw numbers regardless.
4. Identify all source files with 0% line coverage. Group them into:
   - `lib/` utility files (pure TypeScript, no rendering)
   - Simple UI components (no signal dependencies)
   - Complex signal-coupled components
   - Hooks
5. Record overall web coverage: lines %, branches %, functions %, statements %.
6. Write findings to `docs/plans/coverage-mission/baseline-report.md`.

**Acceptance criteria:**
- `baseline-report.md` documents overall web coverage percentage (all four metrics).
- File list of 0%-covered web source files is captured.
- The report identifies estimated lines-to-add to reach 80%.

**Depends on:** Milestone 1 Task 1.1 merged

---

### Task 2.2: Run daemon + shared unit coverage and document results

**Agent type:** general

**Description:**
Run the daemon unit test suite with coverage enabled and record the summary. The daemon
coverage is currently split across 8 shards; run locally in full or shard-by-shard.

**Subtasks (ordered):**
1. From the repo root, run: `./scripts/test-daemon.sh 0-shared --coverage` and note the
   coverage output.
2. Repeat for at least two more shards that are most likely to have gaps:
   `./scripts/test-daemon.sh 4-space-storage --coverage` and
   `./scripts/test-daemon.sh 5-space-storage --coverage`.
3. Record the per-shard coverage summary (lines %, branches %, functions %).
4. Identify source files with 0% or very low (<20%) coverage across all shards. Specifically
   confirm coverage for:
   - `src/storage/repositories/skill-repository.ts`
   - `src/storage/repositories/space-worktree-repository.ts`
   - `src/storage/repositories/workspace-history-repository.ts`
   - `src/lib/space/runtime/llm-workflow-selector.ts` (helpers `buildSelectionPrompt`,
     `cleanIdResponse` in particular — the main function may be covered via integration tests)
5. Append daemon findings to `docs/plans/coverage-mission/baseline-report.md`.

**Acceptance criteria:**
- `baseline-report.md` documents daemon overall coverage percentage.
- Specific per-file coverage for the 4 repository/logic files listed above is recorded.
- Files with coverage gaps < 50% are listed with estimated line counts.

**Depends on:** Milestone 1 Task 1.2 merged (for consistent coverage output path)
