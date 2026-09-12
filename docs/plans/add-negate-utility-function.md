# Plan: Add negate Utility Function

## Goal Summary

Add a `negate(n: number): number` pure utility function to the `@neokai/shared` package. The function returns `-n` (arithmetic negation). No root-level `src/` directory exists in this monorepo; the correct file location is `packages/shared/src/negate.ts`, which mirrors how all other pure utility functions are structured in the `shared` package.

## Approach

1. Create `packages/shared/src/negate.ts` with the exported `negate` function.
2. Add the barrel re-export to `packages/shared/src/mod.ts` (the `shared` package's single entry point).
3. Create `packages/shared/tests/negate.test.ts` using `bun:test`, consistent with the test file present for every other utility in the package (e.g., `tests/utils.test.ts`).
4. Verify the implementation passes `bun test` and Biome/Oxlint checks.

All changes live in a single coder agent session — the scope is trivial.

## Tasks

---

### Task 1: Implement negate utility function with tests

**Agent type:** coder

**Description:**
Create the `negate` function file, update the barrel export, and add a test file — all within the `packages/shared` package. Changes must be on a feature branch with a GitHub PR created via `gh pr create`.

**Subtasks (ordered):**

1. Create a new branch from `dev`, e.g. `feat/negate-utility`.

2. Create `packages/shared/src/negate.ts` with the following content, following the codebase's conventions (tabs for indentation, single quotes, semicolons, 100-char line width, JSDoc comment):
   ```ts
   /**
    * Returns the arithmetic negation of the given number.
    */
   export function negate(n: number): number {
   	return -n;
   }
   ```

3. Add the barrel re-export to `packages/shared/src/mod.ts`. Append (or insert in alphabetical order near similar utility exports):
   ```ts
   export * from './negate.ts';
   ```
   The instructions explicitly permit modifying the barrel when one exists — `mod.ts` is the package entry point and is exactly that kind of file.

4. Create `packages/shared/tests/negate.test.ts` using `bun:test`, consistent with `tests/utils.test.ts`. Include at minimum:
   - Positive number input returns negative value.
   - Negative number input returns positive value.
   - Zero returns zero.
   - Float inputs are handled correctly.
   - `negate(negate(n)) === n` round-trip.

   Example structure:
   ```ts
   import { describe, test, expect } from 'bun:test';
   import { negate } from '../src/negate.ts';

   describe('negate', () => {
   	test('negates a positive number', () => {
   		expect(negate(5)).toBe(-5);
   	});

   	test('negates a negative number', () => {
   		expect(negate(-3)).toBe(3);
   	});

   	test('returns zero for zero input', () => {
   		expect(negate(0)).toBe(-0);
   	});

   	test('handles float inputs', () => {
   		expect(negate(1.5)).toBe(-1.5);
   	});

   	test('double negation is identity', () => {
   		expect(negate(negate(7))).toBe(7);
   	});
   });
   ```

5. Run `bun test packages/shared/tests/negate.test.ts` (or equivalent) from the repo root to confirm all tests pass.

6. Run Biome format/lint on the new files: `bunx biome check packages/shared/src/negate.ts packages/shared/tests/negate.test.ts` — fix any issues.

7. Commit the three changed/created files (`src/negate.ts`, `src/mod.ts`, `tests/negate.test.ts`) and open a PR targeting `dev`.

**Acceptance criteria:**
- `packages/shared/src/negate.ts` exists and exports `negate(n: number): number` that returns `-n`.
- `packages/shared/src/mod.ts` includes `export * from './negate.ts'` so consumers of `@neokai/shared` can import `negate` from the package entry point.
- `packages/shared/tests/negate.test.ts` exists with at least the five test cases listed above, all passing under `bun test`.
- No other files outside `packages/shared/` are modified.
- Biome format/lint passes on the new and modified files (no unformatted output, no lint warnings).
- A GitHub PR is open against `dev` containing only these changes.

**Depends on:** none
