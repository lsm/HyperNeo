# Milestone 01: Coverage Infrastructure

## Goal

Fix the structural gaps in coverage tooling so that ALL source files are visible in coverage reports — including files that have zero tests. Without this step, the current ~30% gate is measuring a partial picture; many untested files are simply invisible to coverage tools.

## Scope

- `packages/web/vitest.config.ts` — add `coverage.include`
- `packages/daemon/tests/unit/coverage.test.ts` — new Bun all-files workaround
- `packages/shared/tests/coverage.test.ts` — new Bun all-files workaround
- `packages/cli/tests/coverage.test.ts` — new Bun all-files workaround (small)
- `.github/workflows/main.yml` — add `--coverage` to CLI test step, verify flag-name uniqueness

---

## Task 1.1: Fix Vitest `coverage.include` for web package

**Agent type**: coder

**Description**

The `packages/web/vitest.config.ts` currently has no `coverage.include` glob. In Vitest 4.x, files never imported during a test run are completely invisible to coverage. Adding `coverage.include` forces all source files to be instrumented and show as 0% if untested.

Note: `coverage.all` was removed in Vitest 4.0. The correct option is `coverage.include`.

**Files to modify**

- `packages/web/vitest.config.ts`

**Subtasks**

1. Add `coverage.include: ['src/**/*.{ts,tsx}']` to the `test.coverage` block.
2. Extend `coverage.exclude` to also exclude test files themselves: `'**/*.test.{ts,tsx}'`, `'**/*.spec.{ts,tsx}'`, `'**/vitest.setup.ts'`.
3. Confirm the existing excludes for `src/index.ts` and `**/index.ts` remain in place.
4. Run `bun run coverage` locally (or in CI) and verify the text reporter now shows rows for previously-invisible files.

**Acceptance criteria**

- `packages/web/vitest.config.ts` has a `coverage.include` field.
- Running `bun run coverage` in `packages/web` reports coverage for files that previously had no tests (they will show 0% statements, 0% lines).
- No existing tests are broken by the config change.
- Changes must be on a feature branch with a GitHub PR created via `gh pr create`.

---

## Task 1.2: Add Bun all-files coverage workaround for daemon package

**Agent type**: coder

**Description**

Bun's `bun test --coverage` only instruments files actually imported during the test run. There is no `all:true` or `coverage.include` option. The documented workaround is a dedicated test file that dynamically imports every source file using `Bun.Glob`.

**Files to create**

- `packages/daemon/tests/unit/coverage.test.ts`

**Subtasks**

1. Create `packages/daemon/tests/unit/coverage.test.ts` with the following pattern:

```typescript
import { test } from 'bun:test';

/**
 * All-files coverage shim.
 *
 * Bun does not support coverage.include / coverage.all.
 * This test dynamically imports every source file so that
 * files with zero test coverage show up as 0% (not missing).
 *
 * Excludes:
 *  - *.test.ts and *.d.ts files
 *  - index.ts barrel files (they only re-export)
 *  - storage/schema/migrations.ts (7k+ lines of raw SQL, not unit-testable)
 *  - Files under tests/ directory
 */
test('imports all daemon modules for coverage', async () => {
  const glob = new Bun.Glob('**/*.ts');
  const srcDir = new URL('../../src', import.meta.url).pathname;
  const files = [...glob.scanSync(srcDir)].filter(
    (f) =>
      !f.endsWith('.test.ts') &&
      !f.endsWith('.d.ts') &&
      !f.endsWith('index.ts') &&
      !f.includes('storage/schema/migrations') &&
      !f.includes('storage/schema/m94') // backfill migration script
  );
  await Promise.allSettled(files.map((f) => import(`${srcDir}/${f}`)));
  // allSettled: import errors from files with side-effect dependencies
  // (e.g. files that open DB connections on import) are tolerated.
});
```

2. Decide which test shard this file belongs to. Place it in the `1-core` shard (it has no DB dependency so it fits there).
3. Verify the file doesn't cause test failures by running `./scripts/test-daemon.sh 1-core` locally.

**Acceptance criteria**

- File exists at `packages/daemon/tests/unit/coverage.test.ts` (or a suitable sub-shard path).
- Running the relevant shard with `--coverage` causes previously-invisible source files to appear in the coverage output.
- The test itself passes (it only imports; allSettled means import errors don't fail the test).
- Changes must be on a feature branch with a GitHub PR created via `gh pr create`.

---

## Task 1.3: Add Bun all-files coverage workaround for shared and cli packages

**Agent type**: coder

**Description**

Apply the same Bun coverage workaround to the `shared` and `cli` packages.

**Files to create**

- `packages/shared/tests/coverage.test.ts`
- `packages/cli/tests/coverage.test.ts`

**Subtasks**

1. Create `packages/shared/tests/coverage.test.ts` with a glob targeting `packages/shared/src/**/*.ts`, excluding `.test.ts`, `.d.ts`, and `index.ts` barrels.
2. Create `packages/cli/tests/coverage.test.ts` with a glob targeting `packages/cli/src/**/*.ts`, excluding `.test.ts`, `.d.ts`. CLI has only 6 source files so this is straightforward.
3. For the `cli` glob, be sure to also exclude `packages/cli/main.ts` (the bun entry point that starts the server) since importing it will attempt to bind ports.

**Acceptance criteria**

- Both files exist and contain a test that uses `Bun.Glob` + dynamic `import()`.
- The tests pass when run with `bun test --coverage` in their respective packages.
- Changes must be on a feature branch with a GitHub PR created via `gh pr create`.

---

## Task 1.4: Add `--coverage` flag to CLI test step in CI

**Agent type**: coder

**Description**

The CLI test step in `.github/workflows/main.yml` currently runs `bun test` with no `--coverage` flag, so CLI code is never uploaded to Coveralls. Adding coverage + a Coveralls upload step will include CLI in the aggregate.

**Files to modify**

- `.github/workflows/main.yml`

**Subtasks**

1. In the `test-cli` job, change the run command from:
   ```yaml
   run: bun test
   ```
   to:
   ```yaml
   run: bun test --coverage --coverage-reporter=lcov --coverage-dir=coverage
   ```
2. Add a "Fix coverage paths for monorepo" step (same pattern as the web step):
   ```yaml
   - name: Fix coverage paths for monorepo
     run: sed -i 's|^SF:src/|SF:packages/cli/src/|g' packages/cli/coverage/lcov.info
   ```
3. Add a Coveralls parallel upload step with `flag-name: cli` (unique, not used by any existing upload).
4. Add `test-cli` to the `needs` list of the `coveralls-finalize` job.
5. Verify the `coveralls-finalize` job still has all the flag-names it needs to finalize.

**Acceptance criteria**

- The `test-cli` job in CI produces an `lcov.info` and uploads it to Coveralls with flag `cli`.
- The `coveralls-finalize` job correctly lists `test-cli` as a dependency.
- No existing CI jobs are broken.
- Changes must be on a feature branch with a GitHub PR created via `gh pr create`.

**Depends on**: Task 1.3 (CLI coverage test must exist for `bun test --coverage` to produce meaningful output)
