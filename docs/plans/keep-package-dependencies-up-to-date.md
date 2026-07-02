# Keep Package Dependencies Up to Date

## Goal

Recurring mission to keep all package dependencies current and pinned to exact versions across the HyperNeo monorepo. Each cycle checks for outdated packages, updates them (Claude Agent SDK separately, everything else together), and verifies nothing is broken.

## Approach

Each cycle runs three tasks in order:

1. **Check and update Claude Agent SDK** (separate PR) -- the SDK has special handling because it may include breaking changes that require code updates and type regeneration via `make sync-sdk-types`.
2. **Check and update all other dependencies** (single PR) -- all non-SDK dependencies across all workspace `package.json` files are updated together.
3. **Audit version pinning** -- ensure no `~` or `^` prefixes remain anywhere.

All PRs target the `dev` branch.

## Packages in Scope

- Root `package.json` -- devDependencies: `@biomejs/biome`, `@testing-library/preact`, `knip`, `oxlint`, `typescript`
- `packages/cli/package.json` -- deps: `hono`, `vite`; devDeps: `@types/bun`, `playwright`, `v8-to-istanbul`
- `packages/daemon/package.json` -- deps: `@anthropic-ai/claude-agent-sdk`, `@github/copilot-sdk`, `croner`, `simple-git`, `zod`; devDeps: `@types/bun`
- `packages/shared/package.json` -- devDeps: `@types/bun`
- `packages/web/package.json` -- deps: `@preact/signals`, `clsx`, `highlight.js`, `marked`, `preact`; devDeps: `@preact/preset-vite`, `@tailwindcss/vite`, `@testing-library/preact`, `@types/bun`, `@vitest/coverage-v8`, `@vitest/ui`, `happy-dom`, `tailwindcss`, `typescript`, `vite`, `vitest`
- `packages/ui/package.json` -- deps: `@floating-ui/dom`, `preact`; devDeps: `@preact/preset-vite`, `@tailwindcss/vite`, `@testing-library/preact`, `@types/bun`, `@vitest/coverage-v8`, `happy-dom`, `tailwindcss`, `vite`, `vitest`
- `packages/e2e/package.json` -- devDeps: `@playwright/test`, `@types/node`, `monocart-reporter`

---

## Task 1: Update Claude Agent SDK

**Type:** coder

**Description:**
Check if `@anthropic-ai/claude-agent-sdk` has a newer version than the currently pinned version. If yes, update it, regenerate SDK types, fix any breaking changes, and run tests.

**Subtasks:**
1. Run `bun install` at the worktree root to install all dependencies.
2. Read the currently pinned version of `@anthropic-ai/claude-agent-sdk` from `packages/daemon/package.json` (do not hardcode -- read the actual value each cycle).
3. Check the latest published version:
   ```bash
   bun npm info @anthropic-ai/claude-agent-sdk version
   ```
4. If no newer version exists, report "SDK is up to date" and stop. The task is complete.
5. If a newer version exists, update `packages/daemon/package.json` to the new exact version (no `^` or `~`).
6. Run `bun install` to update the lockfile.
7. Run `make sync-sdk-types` to regenerate types from the new SDK version.
8. Check for TypeScript compilation errors:
   ```bash
   bun run typecheck
   ```
9. If there are breaking changes (type errors, removed APIs, changed signatures), update the codebase to fix them. Search for usages of changed APIs in `packages/daemon/src/` and `packages/shared/src/`.
10. Run the daemon unit tests to verify nothing is broken:
    ```bash
    make test-daemon
    ```
11. Run the web tests:
    ```bash
    make test-web
    ```
12. Run lint and format checks:
    ```bash
    bun run check
    ```
13. Create a feature branch **from `dev`**, commit, push, and create a PR targeting `dev` via `gh pr create`. PR title should be: `chore(deps): update @anthropic-ai/claude-agent-sdk to <version>`.

**Acceptance Criteria:**
- `@anthropic-ai/claude-agent-sdk` is updated to the latest version with an exact pin (no `^` or `~`).
- `make sync-sdk-types` has been run and generated types are committed.
- All breaking changes are resolved -- `bun run typecheck` passes.
- `make test-daemon` and `make test-web` pass.
- `bun run check` (lint + typecheck + knip) passes.
- Changes are on a feature branch with a GitHub PR created via `gh pr create` targeting `dev`.

**Dependencies:** none

---

## Task 2: Update All Other Dependencies

**Type:** coder

**Description:**
Update all non-SDK dependencies across all workspace `package.json` files to their latest stable versions. All updates go into a single PR.

**Subtasks:**
1. Run `bun install` at the worktree root.
2. Check for outdated packages across the monorepo. For each dependency in each `package.json`, compare the pinned version against the latest published version using `bun npm info <pkg> version`. Example:
   ```bash
   bun npm info preact version
   bun npm info vite version
   bun npm info tailwindcss version
   # ... repeat for each dependency
   ```
   Alternatively, if `bun outdated` is available in the current Bun version, use it per workspace:
   ```bash
   bun outdated
   cd packages/daemon && bun outdated
   cd packages/web && bun outdated
   # ... etc.
   ```
   If `bun outdated` is not available, fall back to the `bun npm info` approach above.
3. If all packages are up to date, report "All dependencies are current" and stop.
4. For each outdated package, update the version in the relevant `package.json` to the latest stable version. Use exact versions only (no `^` or `~`). Do NOT update `@anthropic-ai/claude-agent-sdk` -- that is handled in Task 1. `@github/copilot-sdk` is included in this bulk update (no special handling needed).
   **Caution with major version bumps:** For major version upgrades of core dependencies (`preact`, `vite`, `tailwindcss`, `marked`, `highlight.js`), check the changelog for breaking changes before updating. If migration effort is significant, skip the major bump and note it in the PR description for manual follow-up.
5. When updating shared dependencies that appear in multiple packages (e.g., `preact`, `vite`, `@types/bun`, `tailwindcss`, `vitest`, `typescript`), ensure all packages use the same version.
6. Run `bun install` to update the lockfile.
7. Run typecheck:
   ```bash
   bun run typecheck
   ```
8. Fix any type errors caused by dependency updates.
9. Run all tests:
   ```bash
   make test-daemon
   make test-web
   ```
10. Run lint and format checks:
    ```bash
    bun run check
    ```
11. If any tests fail due to API changes in updated dependencies, fix the code to work with the new versions.
12. Create a feature branch **from `dev`**, commit, push, and create a PR targeting `dev` via `gh pr create`. PR title should be: `chore(deps): update all dependencies`. If any major version bumps were skipped, note them in the PR description.

**Acceptance Criteria:**
- All non-SDK dependencies are updated to latest stable versions with exact pins.
- Shared dependencies (e.g., `preact`, `vite`, `typescript`, `tailwindcss`, `vitest`, `@types/bun`) are consistent across all workspace packages.
- `bun run typecheck` passes.
- `make test-daemon` and `make test-web` pass.
- `bun run check` (lint + typecheck + knip) passes.
- Changes are on a feature branch with a GitHub PR created via `gh pr create` targeting `dev`.

**Dependencies:** none (can run in parallel with Task 1, but should not include SDK changes)

---

## Task 3: Audit and Enforce Exact Version Pins

**Type:** coder

**Description:**
Verify that all dependency versions across every `package.json` in the monorepo are exact (no `~` or `^` prefixes). This task runs after Tasks 1 and 2 to catch any range specifiers that may have been introduced. If violations are found, fix them directly.

**Subtasks:**
1. Run `bun install` at the worktree root.
2. Search all `package.json` files for version strings with `~` or `^` prefixes:
   ```bash
   grep -rn '[\"\x27]\(\^\|~\)[0-9]' packages/*/package.json package.json
   ```
3. If none are found, report "All versions are exact" and stop. The task is complete.
4. If any are found, remove the `~` or `^` prefix from each version string, keeping the version number intact.
5. Run `bun install` to update the lockfile after changes.
6. Run `bun run typecheck` and `bun run check` to verify nothing is broken.
7. Create a feature branch **from `dev`**, commit, push, and create a PR targeting `dev` via `gh pr create`. PR title: `chore(deps): pin all dependency versions to exact`.

**Acceptance Criteria:**
- All `package.json` files across the monorepo use exact version pins (no `~` or `^`).
- If violations were found and fixed, changes are on a feature branch with a GitHub PR created via `gh pr create` targeting `dev`.

**Dependencies:** Task 1, Task 2
