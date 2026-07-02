# Milestone 4 — Worktree Path Shortening

## Goal

Shorten the worktree base directory path by replacing the full encoded repo path (e.g., `-Users-lsm-focus-dev-neokai`) with a short project key derived from the repo path. The git branch name remains unchanged. Existing worktrees continue to work via the old path; new worktrees use the shorter path.

## Context

Current worktree path format:
```
~/.hyperneo/projects/{full-encoded-repo-path}/worktrees/{safeSessionId}
```
Example:
```
/Users/lsm/.hyperneo/projects/-Users-lsm-focus-dev-neokai/worktrees/planner-04062505-...
```

The long encoded path comes from `WorktreeManager.encodeRepoPath()` in `packages/daemon/src/lib/worktree-manager.ts`. The `getWorktreeBaseDir()` method uses this encoding to produce the base directory.

Proposed short key: last path component of the repo root + first 8 characters of a deterministic hash of the full path. Example: `dev-neokai-a3b2c1d4`. This is human-readable, unique, and deterministic (same repo path always produces the same short key).

The `WorktreeManager` does not store anything in the DB — it operates purely on the filesystem. The path shortening is purely a filesystem naming change.

**Backward compatibility**: The old long path must still be recognized when checking if an existing session's worktree path is valid (`verifyWorktree`). Critically, `verifyWorktree` does **not** recompute the path from the repo root — it uses the `worktree_path` value already stored in the DB for that session record. Old session records store the old long path; `verifyWorktree` reads that stored value and checks it against the filesystem. As long as the directory still exists at the old path, old sessions continue to work with zero changes. New session records will store the new short path. Both formats coexist in the DB indefinitely with no conflict.

## Tasks

---

### Task 4.1 — Implement Project Short Key Generation in WorktreeManager

**Description**: Add a `getProjectShortKey(repoPath: string): string` method to `WorktreeManager` that produces a short, deterministic, human-readable directory name for a given repo path, and update `getWorktreeBaseDir` to use it — with collision detection via a sentinel file to handle the (rare) case where two different repo paths hash to the same short key.

**Subtasks**:
1. In `packages/daemon/src/lib/worktree-manager.ts`, add a **public** method `getProjectShortKey(repoPath: string): string` (not private — must be accessible from unit tests; see subtask 6):
   - Extract the last component of the path: `basename(repoPath)` — e.g., `dev-neokai`
   - Compute an 8-character hex hash of the full normalized path using `Bun.hash()`. **Important**: `Bun.hash()` returns `number | bigint`; use `(BigInt(Bun.hash(normalizedPath)) & 0xFFFFFFFFn).toString(16).padStart(8, '0')` to produce a safe 8-character hex string without BigInt truncation issues (plain `Number(bigint).toString(16)` silently truncates above 2^53).
   - Return `${lastComponent}-${hash8chars}` — e.g., `dev-neokai-a3b2c1d4`
   - Sanitize `lastComponent`: replace characters invalid in directory names with `-` (keep alphanumeric, hyphens, underscores)
2. Update `getWorktreeBaseDir(gitRoot: string)` to resolve the short key with collision detection (see subtask 3). **The method signature stays synchronous** (`private getWorktreeBaseDir(gitRoot: string): string`) — all file I/O in this method must use synchronous Node `fs` APIs (`existsSync`, `mkdirSync`, `readFileSync`, `writeFileSync`) consistent with the existing method body, to avoid cascading `async` changes to `createWorktree` and its callers.
3. Implement collision detection in `getWorktreeBaseDir` using a sentinel file approach:
   - After computing `shortKey`, determine the candidate base dir: `~/.hyperneo/projects/{shortKey}`
   - **On first use** (directory doesn't exist yet): call `mkdirSync(candidateDir, { recursive: true })` and write a `.hyperneo-repo-root` sentinel file inside it containing the full normalized `gitRoot` path (use `writeFileSync`). Then return `candidateDir` as the base dir.
   - **On subsequent use** (directory already exists): read the `.hyperneo-repo-root` sentinel file with `readFileSync` (if present) and compare its contents (trimmed) to the normalized `gitRoot`.
     - If they match (same repo): proceed normally, return the short-key base dir.
     - If they differ (collision — different repo mapped to same short key): use `this.logger.warn(...)` to log the collision (e.g., `this.logger.warn('Short key collision detected for "${shortKey}": expected "${storedPath}", got "${gitRoot}". Falling back to full encoding.')`) and fall back to `encodeRepoPath(gitRoot)` to produce the full-length base dir. **Do NOT use `console.warn`** — `no-console` is an error in `.oxlintrc.json` and `worktree-manager.ts` is not exempt; the file already uses `this.logger` (initialized at line ~24 as `private logger = new Logger('WorktreeManager')`).
   - If the directory exists but has no sentinel file (e.g., created by an older version of HyperNeo): write the sentinel for the current repo path using `writeFileSync` and proceed normally.
4. Keep `encodeRepoPath` — it remains used by `cleanupOrphanedWorktrees` and as the collision fallback
5. Write unit tests for `getProjectShortKey`:
   - Same path always returns the same key (deterministic)
   - Output contains only safe filesystem characters
   - Output is shorter than the full encoded path
   - The 8-char hex hash is derived correctly (no BigInt truncation)
6. Write unit tests for the collision detection logic in `getWorktreeBaseDir`. **Note on testing the collision scenario**: since `getProjectShortKey` is `public`, the test can call it directly or pass two crafted repo paths that produce the same short key. The simplest approach is to pre-create the sentinel file in a temp directory (using `mkdirSync`/`writeFileSync` in the test setup) so that `getWorktreeBaseDir` sees a directory that already belongs to a different repo — no need to find a real hash collision. Test cases:
   - **No collision**: first call for a fresh temp directory creates the sentinel file and returns the short-key path
   - **Same repo, second call**: reads sentinel, confirms match, returns same short-key path
   - **Collision scenario**: pre-create the sentinel dir with path A's content, then call `getWorktreeBaseDir` with path B that hashes to the same `shortKey` — assert it logs a warning via `this.logger.warn` and returns the full `encodeRepoPath` result instead of the short-key path

**Acceptance Criteria**:
- `getProjectShortKey('/Users/alice/code/my-project')` returns a string like `my-project-a3b2c1d4`
- The key is deterministic — calling twice with the same input returns the same result
- New worktrees for a repo are created at `~/.hyperneo/projects/{shortKey}/worktrees/...` after the sentinel file is written
- A `.hyperneo-repo-root` sentinel file is written into each short-key directory on first use, containing the full normalized repo path
- When two different repo paths produce the same short key, the second repo logs a warning and falls back to the full `encodeRepoPath` directory — both repos operate on distinct directories with no data mixing
- Old worktrees (with long paths) continue to work — `verifyWorktree` checks the `worktreePath` stored in DB, so existing records still point to the old path which still exists on disk
- All unit tests pass (including the collision scenario test)

**Depends on**: Milestone 1 complete (can run in parallel with Milestones 2–3)

**Agent type**: coder

**Branch/PR**: Changes must be on a feature branch with a GitHub PR created via `gh pr create` targeting `dev`.

---

### Task 4.2 — Update TEST_WORKTREE_BASE_DIR Handling and Integration Tests

**Description**: The `WorktreeManager` has a `TEST_WORKTREE_BASE_DIR` environment variable override for tests. Ensure test infrastructure continues to work with the new short key. Also run the worktree manager unit tests and fix any failures.

**Subtasks**:
1. Run existing `WorktreeManager` unit tests (`cd packages/daemon && bun test tests/unit/worktree/`) and confirm they still pass after the `getWorktreeBaseDir` change
2. If tests use hardcoded path expectations that include the old encoded format, update them to use the new short key format
3. Add a unit test that verifies `getWorktreeBaseDir` with the new format still respects `TEST_WORKTREE_BASE_DIR` when set
4. Add a unit test that verifies a worktree created with the old long path format is still recognized by `verifyWorktree` (simulate old-format path in the DB record)

**Acceptance Criteria**:
- All worktree unit tests pass
- The `TEST_WORKTREE_BASE_DIR` override still works correctly
- The transition test (old path format still valid in `verifyWorktree`) passes

**Depends on**: Task 4.1

**Agent type**: coder

**Branch/PR**: Changes must be on a feature branch with a GitHub PR created via `gh pr create` targeting `dev`.
