# Milestone 1: Shared Types and Validation

## Goal

Update shared type definitions so `defaultPath` is required on `CreateRoomParams`, add a reusable path validation utility, and verify that the daemon's `workspaceRoot` is already exposed to the frontend via `SystemState`.

## Scope

- `packages/shared/src/types/neo.ts` -- type changes
- `packages/shared/src/` -- new validation utility
- `packages/shared/src/state-types.ts` -- verify `workspaceRoot` in `SystemState`
- Unit tests for the validation utility

---

### Task 1.1: Make defaultPath required in CreateRoomParams and add path validation

**Description**: Update `CreateRoomParams.defaultPath` from optional to required. Add `allowedPaths` as required (derived from `defaultPath` if not explicitly provided by the caller). Create a shared validation utility `validateWorkspacePath(path: string): { valid: boolean; error?: string }` that checks: (a) path is absolute, (b) path is non-empty. The actual filesystem existence check will be done server-side only, but the format validation is shared.

**Subtasks**:
1. In `packages/shared/src/types/neo.ts`, change `CreateRoomParams.defaultPath` from `defaultPath?: string` to `defaultPath: string`.
2. In `packages/shared/src/types/neo.ts`, keep `CreateRoomParams.allowedPaths` as optional (backend will derive from `defaultPath` if not provided).
3. Create `packages/shared/src/validation/workspace-path.ts` with `validateWorkspacePath()` that checks the path is a non-empty absolute path (starts with `/`). Add a doc comment noting this is POSIX-only (Windows is out of scope).
4. Export the validation utility from `packages/shared/src/mod.ts`.
5. Add unit tests in `packages/shared/src/validation/__tests__/workspace-path.test.ts` covering: valid absolute path, empty string, relative path, path with trailing slash (valid).
6. Run `bun run typecheck` to identify all callers that now fail due to the required `defaultPath`. **Fix all type errors in the same PR** by adding placeholder `defaultPath` values to call sites. Scope of fixes: only add the minimum needed to pass typecheck — in test fixtures, use `/tmp/test-workspace`; in frontend `lobby-store.ts`, pass `defaultPath` from the form params. Do NOT implement runtime validation or behavioral changes here (that is Milestone 2). The goal is a CI-green branch, not behavioral enforcement.
7. Run `bun run typecheck && make test-daemon && make test-web` to verify everything passes.

**Acceptance Criteria**:
- `CreateRoomParams.defaultPath` is required (not optional).
- `validateWorkspacePath` is exported from `@hyperneo/shared` and has passing tests.
- `SystemState.workspaceRoot` already exists in `packages/shared/src/state-types.ts` (verified, no change needed).
- All type errors from the change are fixed — CI passes cleanly (typecheck, daemon tests, web tests).

**Dependencies**: None.

**Agent type**: coder

Changes must be on a feature branch with a GitHub PR created via `gh pr create`.
