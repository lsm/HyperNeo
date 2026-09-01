# Milestone 1: Fix Coverage Infrastructure

## Milestone Goal

Fix all coverage configuration issues that cause inaccurate measurement before adding any
new tests. The most critical issue is that Vitest 4 removed `coverage.all` — without adding
`coverage.include`, approximately 50 untested web source files are completely invisible to
the coverage reporter. The CI gate must also be raised to an intermediate value (70%) now
that the true state will be visible.

## Scope

Files modified:
- `packages/web/vitest.config.ts` — add `coverage.include`, thresholds, and remove any
  deprecated v4 options
- `bunfig.toml` — add `[test] coverageThreshold` and `coverageDir`
- `.github/workflows/main.yml` — update `MIN_COVERAGE=30` to `MIN_COVERAGE=70` as an
  intermediate step (will become 80 in Milestone 8)

## Tasks

---

### Task 1.1: Fix Vitest 4 coverage configuration

**Agent type:** coder

**Description:**
Update `packages/web/vitest.config.ts` to comply with Vitest 4.x requirements. The key
change is adding `coverage.include` so untested source files appear in reports. Without this
the 80% gate can never be accurately measured, and partially-covered files may show as 100%
because only the imported portions are tracked.

**Subtasks (ordered):**
1. Read `packages/web/vitest.config.ts` to confirm current state.
2. Add `include: ['src/**/*.{ts,tsx}']` inside the `coverage` block — this is required in
   Vitest 4 to make uncovered files visible.
3. Add `thresholds` object inside the `coverage` block:
   ```ts
   thresholds: {
     lines: 80,
     functions: 80,
     branches: 80,
     statements: 80,
   },
   ```
4. Scan the existing config for any removed Vitest 4 options (`coverage.all`,
   `coverage.experimentalAstAwareRemapping`, `coverage.ignoreEmptyLines`,
   `coverage.extensions`) and remove any that are present.
5. Verify the file is valid TypeScript (run `bun run typecheck` from repo root or
   `bunx tsc --noEmit` from `packages/web`).
6. Create a feature branch named `fix/coverage-infrastructure`, commit the change, and open
   a PR to `dev` via `gh pr create`.

**Acceptance criteria:**
- `packages/web/vitest.config.ts` contains `coverage.include: ['src/**/*.{ts,tsx}']`.
- `coverage.thresholds` block is present with all four metrics set to 80.
- No deprecated Vitest 4 coverage keys are present.
- `bun run typecheck` passes without new errors.
- Changes are on a feature branch with a GitHub PR created via `gh pr create`.

**Depends on:** nothing (first task)

---

### Task 1.2: Add Bun coverage thresholds and coverage directory to bunfig.toml

**Agent type:** coder

**Description:**
Add Bun-native coverage configuration to `bunfig.toml`. Bun does not support coverage
thresholds via CLI flags — they must be specified in `bunfig.toml` under `[test]`. Also add
`coverageDir` so the output path is consistent across local runs and CI shards.

**Subtasks (ordered):**
1. Read `bunfig.toml` to confirm current state.
2. Add the following to the `[test]` section (or create it if absent):
   ```toml
   coverageReporter = ["text", "lcov"]
   coverageDir = "coverage"
   coverageThreshold = { lines = 0.80, functions = 0.80, branches = 0.80 }
   ```
   Note: the existing `exclude` array in `[test]` must be preserved.
3. Verify there are no syntax errors by running `bun test --help` (which parses `bunfig.toml`
   on startup) or `bun run test:unit` with no actual test files matched.
4. If the threshold causes existing passing tests to break coverage checks, that is expected
   — the thresholds will only be enforced after coverage is above 80%. Comment a note in the
   toml explaining this.
5. Commit the change to the same feature branch as Task 1.1 (or a separate branch if 1.1 has
   already been merged), push, and open/update the PR.

**Acceptance criteria:**
- `bunfig.toml` `[test]` section contains `coverageThreshold`, `coverageDir`, and
  `coverageReporter`.
- `bun --version` still runs successfully (config parses).
- Changes are on a feature branch with a GitHub PR created via `gh pr create`.

**Depends on:** nothing (can run in parallel with Task 1.1)

---

### Task 1.3: Update CI coverage gate to 70% (intermediate step)

**Agent type:** coder

**Description:**
Raise the CI coverage gate from `MIN_COVERAGE=30` to `MIN_COVERAGE=70` in
`.github/workflows/main.yml`. This is an intermediate step — once all new tests are written
(Milestones 3–7) and confirmed passing in CI, Milestone 8 will raise it to 80%. Setting 70
now prevents the gate from being trivially satisfied after we expose previously-hidden
uncovered files via `coverage.include`.

**Subtasks (ordered):**
1. Read `.github/workflows/main.yml`, locate the `coverage-gate` job, and find the
   `MIN_COVERAGE=30` line.
2. Change `MIN_COVERAGE=30` to `MIN_COVERAGE=70`.
3. Add an inline comment on the same line: `# Intermediate: will be raised to 80 in Milestone 8`.
4. Verify no other occurrences of `MIN_COVERAGE` exist in the file (use grep to confirm).
5. Commit to the infrastructure branch and open/update the PR.

**Acceptance criteria:**
- `.github/workflows/main.yml` contains `MIN_COVERAGE=70` (not 30).
- No other `MIN_COVERAGE` references remain at the old value.
- Changes are on a feature branch with a GitHub PR created via `gh pr create`.

**Depends on:** nothing (can run in parallel with Tasks 1.1 and 1.2)
