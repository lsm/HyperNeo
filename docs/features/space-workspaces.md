# Space workspaces

A space can own several git repositories. The registry is the `space_workspaces` table
(migration 217, `packages/daemon/src/storage/schema/m217-space-workspaces.ts`): at most one row
per space has `is_primary = 1` (partial unique index `idx_space_workspaces_primary`), and
`UNIQUE(space_id, path)` prevents registering the same path twice within one space. The
pre-existing `spaces.workspace_path` column is kept as the primary workspace: migration 217
backfills one primary row per space from it, all runtime code still reads it as the default
workspace, and it is immutable after creation (`UpdateSpaceParams` has no `workspacePath`
field and there is no set-primary API — the primary is set only by space creation and the
backfill).

Migrations 218 and 219 add nullable `workspace_path` columns to `space_goals` and
`space_tasks` — the per-goal and per-task pins described below.

`SpaceWorkspaceRepository` (`packages/daemon/src/storage/repositories/space-workspace-repository.ts`)
is a thin data-access layer over that table:

- `create` / `createUnclaimed` / `getById` / `listBySpace` (primary first, then oldest) /
  `getByPath(spaceId, path)` / `findOwnerByPath(path)` (across all spaces) / `updateLabel` /
  `delete(spaceId, id)` / `countBySpace`.
- `createUnclaimed` is an `INSERT ... SELECT ... WHERE NOT EXISTS (SELECT 1 FROM
  space_workspaces WHERE path = ?)` — it enforces **global path uniqueness across all
  spaces** in SQL and returns `null` on a lost race instead of throwing. The manager uses it
  so a concurrent registration of the same repo in another space cannot slip through the
  pre-checks.
- Constraint violations surface as thrown SQLite errors with no reclassification. The two
  `UNIQUE` rules both raise `UNIQUE constraint failed: ...` and are distinguishable only
  by the column list: a duplicate path fails as
  `UNIQUE constraint failed: space_workspaces.space_id, space_workspaces.path`, a second
  primary as `UNIQUE constraint failed: space_workspaces.space_id` (the partial unique
  index on `(space_id) WHERE is_primary = 1` reports its indexed column, not its name).
  The mapping is not exhaustive: an insert that violates both rules at once — the
  existing primary's path together with `isPrimary: true` — reports only the
  second-primary signature, so the message names one violated constraint, not all
  of them. Callers that need the full conflict set must query for it (`getByPath` plus the
  current primary) after a failure; pre-checks race with concurrent inserts.
- Every mutation notifies reactive DB (`space_workspaces`, scoped by `space_id`), so
  workspace lists update live in the web UI.

## Canonical path comparison

The repository performs **exact string equality** on `path` — it stores and compares whatever it
is given and applies no normalization of its own. Canonicalization is the manager layer's job
(validation policy lives there too): callers must resolve paths to their canonical form
(absolute, symlinks resolved, no trailing separator) **before** calling the repository.

Consequences of that contract:

- `/tmp/repo` and `/tmp/repo/` are distinct keys: both spellings can be registered in the
  same space at this layer, and `getByPath` / `findOwnerByPath` match only the exact
  string given. Collapsing spelling variants of one directory is the caller's
  canonicalization job, not the database's.
- `getByPath` never leaks across spaces: it always takes `(spaceId, path)`.
- When several spaces registered the same canonical path, `findOwnerByPath` returns the primary
  row of one of them deterministically (primary rows win, then earliest `created_at`, then
  lexicographically smallest `id`, so the winner is stable even when rows share a millisecond
  timestamp).

## Registration validation

`validateWorkspaceRegistration`
(`packages/daemon/src/lib/space/workspaces/workspace-validation-pipeline.ts`) is one direct
superpipe pipeline (ADR 0004) of pure validation gates. It takes the candidate (`spaceId`,
raw path), an IO adapter (default `nodeWorkspaceValidationIo`), and a registry snapshot, and
returns a typed verdict instead of throwing. Gates run in order; the first failure wins:

1. **Canonicalization** — `fs.realpath` plus an accessible-directory check. All later gates
   compare canonical paths only.
2. **Git repository root** — hard failure here, unlike the non-fatal warn at space creation.
   The path itself must be a repo root (`git rev-parse --show-toplevel` resolves to it); a
   subdirectory inside a repository and a bare repository are rejected.
3. **Cross-space exclusivity** — a canonical path claimed by any other space (its primary
   path or any `space_workspaces` row, archived spaces included) is rejected. A path this
   same space already holds is reported as a duplicate of its own.
4. **Same-space nesting** — rejected in both directions: a candidate strictly inside another
   workspace of the same space, or strictly containing one. Every workspace must itself be a
   git root, so nesting means one registered repo lives inside another's tree and ownership
   of edits and checkpoints becomes ambiguous. Nesting across different spaces is
   deliberately allowed: exclusivity is enforced per exact path above, not per disk subtree.
5. **Per-space cap** — at most `MAX_WORKSPACES_PER_SPACE` (8) workspaces per space. The
   snapshot counts distinct paths for the space, so the primary counts toward the cap —
   which is why the web create dialog allows at most 7 additional workspaces.

Snapshot contract: `claims` must cover every `spaces.workspace_path` across all spaces
(archived ones included) plus every `space_workspaces` row; `workspaceCountForSpace` is that
space's current distinct-path count. `buildRegistrySnapshot`
(`packages/daemon/src/lib/space/managers/space-workspace-manager.ts`) builds it, treating
`spaces.workspace_path` as an implicit `space_primary_path` claim when a space has no
primary row.

## SpaceWorkspaceManager

`packages/daemon/src/lib/space/managers/space-workspace-manager.ts` wires the gates into
operation; `SpaceManager` exposes them as a thin facade.

- **`registerWorkspace(spaceId, rawPath, label?)`** — runs the validation pipeline, throws
  `WorkspaceRegistrationError` (carrying the typed rejection) on any failure, then inserts
  inside an immediate transaction that **re-runs the registry gates** on a fresh snapshot
  and writes via `createUnclaimed`; a lost race is reclassified as a duplicate or
  cross-space claim. Labels are optional display names; an empty label renders as the path
  basename.
- **`removeWorkspace(spaceId, workspaceId)`** — refuses (throws `WorkspaceRemovalBlockedError`)
  when the row is the primary, or when non-archived sessions, tasks, or goals still reference
  the path; otherwise deletes. The counts come from
  `SessionRepository.countActiveSessionsByWorkspacePath` (matching `workspace_path` or
  `main_repo_path`),
  `SpaceTaskRepository.countNonArchivedByWorkspacePath`, and
  `SpaceGoalRepository.countNonArchivedByWorkspacePath`.
- **`listWorkspaces(spaceId)`** / **`updateWorkspaceLabel(spaceId, workspaceId, label)`** —
  read and label maintenance. `updateWorkspaceLabel` returns `false` for an unknown id
  (the RPC handler converts that to a throw).
- **`resolveRegisteredWorkspacePath(spaceId, rawPath)`** — canonicalizes a path and requires
  it to be a claim of this exact space; this is the write-time admission check used by task
  and goal pinning (`resolveWorkspacePath` injected into `SpaceTaskManager`,
  `SpaceGoalService`, `SpaceRuntime`, and the task-agent manager).
- **`resolveWorkspaceSelection(spaceId, selection)`** — resolves an agent-supplied workspace
  reference: a non-`/` string first matches workspace **labels** (exactly one match required;
  an ambiguous label throws with a "use the path instead" hint), a `/`-prefixed string
  resolves as a registered path. Unknown references list the registered workspaces in the
  error. Used by the `create_standalone_task` agent tool's optional `workspace` argument.

### Space creation

`createSpace` accepts `additionalWorkspaces: { path, label? }[]` alongside the primary path.
The asymmetry is deliberate:

- the **primary** path must exist and be a directory; a non-git path is only a warning
  (`workspace path is not a git repository: ...`), preserving pre-registry behavior;
- every **additional** workspace runs the full registration validation above — including the
  hard git-root requirement — against a rolling snapshot, and any failure rolls back the
  whole creation (space row and already-inserted workspace rows). The space row and its
  primary workspace row are written atomically first, with the same cross-space exclusivity
  pre-checks (`A space already exists for workspace path: ...` /
  `Workspace path is already claimed by space ...`).

## A repository belongs to one space

Exclusivity is per canonical path across the whole daemon database, not per space:

- every `spaces.workspace_path` (archived spaces included) and every `space_workspaces` row
  is a claim; registration rejects a path claimed by any other space;
- the transactional insert (`createUnclaimed`) enforces the same rule in SQL, so two
  concurrent registrations of one repo in different spaces cannot both succeed;
- space creation claims the primary path the same way before any row is written.

The consequence: one repo cannot be shared by two spaces; a repo needed in two spaces must
be registered in only one of them.

## Task binding: one task, one repo

`space_tasks.workspace_path` is nullable. **`NULL` means "unpinned"** — at spawn time the
task resolves to the space primary — never a literal duplicate of it: pinning the primary
path is collapsed back to `NULL` at write time, so the column only ever stores an override.

- **Create/update** (`spaceTask.create`, `spaceTask.update`, and the internal creators) run
  `SpaceTaskManager.resolveWorkspacePathParam`: `undefined` leaves the column untouched,
  `null` / `''` explicitly unpins, any other value is canonicalized and must be registered
  to this space (`Workspace path is not registered to space: ...`), then collapsed to `NULL`
  if it equals the primary.
- **Changing the pin later** is refused while it would take effect mid-flight: an active or
  started agent session (`taskAgentSessionId` / `postApprovalSessionId` set, or status
  `in_progress` / `rate_limited` / `usage_limited`) or an existing worktree for the task
  both block the change. Because tasks get their own worktree at spawn, in practice the pin
  is fixed once a task has started.
- **At spawn**, one task works in exactly one repo: `createTaskWorktree`
  (`packages/daemon/src/lib/space/managers/space-worktree-manager.ts`, itself one direct
  superpipe pipeline) receives the repo root explicitly — `resolveTaskWorkspace(space, task)`
  — creates one worktree per task under
  `~/.hyperneo/projects/<repo>-<hash8>/worktrees/<slug>` with branch `space/<slug>`, and
  **fails closed**: a worktree-creation error aborts the spawn rather than falling back to
  the shared space workspace (`Task worktree creation failed ... refusing to spawn a node
  agent in the shared space workspace`). Crashed creations are recovered idempotently via a
  `hyperneo-claim` marker written into the worktree's private git dir.

### Goal pinning and inheritance

`space_goals.workspace_path` pins a goal to one repo, with the same write-time gate
(`SpaceGoalService.resolveGoalWorkspacePath`: validate, collapse primary to `NULL`).
`create_goal` / `update_goal` (RPC and agent tool) accept the pin.

Tasks created **by** a goal inherit its pin by copy-at-create — no live goal lookup at
spawn: immediate/triggered goal runs (`goal-service.ts`) and scheduled check-ins
(`task-schedule-fire.handler.ts`) both write `workspacePath: goal.workspacePath ?? null`
onto the new task row. An explicit `workspacePath` passed to task creation overrides the
inheritance, and re-pinning the goal does not retro-propagate to tasks that already exist.

The full resolution ladder, evaluated in this order:

1. the task's own worktree record (the `space_worktrees` row for the task, or the
   in-memory cache during a live daemon);
2. `space_tasks.workspace_path` (explicit pin or goal-inherited copy);
3. `spaces.workspacePath` (the primary);
4. (rehydration and self-heal paths only) the session row's stored `workspacePath`.

## The `resolveTaskWorkspace` seam

`resolveTaskWorkspace(space, task)` in
`packages/daemon/src/lib/space/runtime/spawn-slot-resolution.ts` **is** rule 2–3 of that
ladder: the task's explicit pin (blank values treated as absent, otherwise preserved
verbatim) or the space primary. It never throws — registration admission happened at write
time — and all task→repo resolution flows through it. Call sites include
the spawn flow (via the task-agent manager, which also decides worktree creation through
`resolveSpawnWorkspace`), live-session workspace re-sync, post-approval sub-sessions, the
workflow-run RPC handlers, and the run-artifact sync job. Do not hand-roll a
`space.workspacePath` fallback next to it; extend or call the seam instead.

Restart safety (#2519): worktrees are persisted on their own `space_worktrees` rows with the
git-side `hyperneo-claim` marker and `.hyperneo-repo-root` / `.hyperneo-repo-cwd` sentinels
beside the worktrees directory, so rehydration after a daemon restart re-binds sessions to
the persisted worktree (it never creates one) and re-syncs the session's stored workspace
path when it drifted.

## Sessions in a space: one session, one repo

A session created inside a space must sit in a workspace registered to that space —
`isWorkspaceRegisteredToSpace` (a union query over `space_workspaces` and
`spaces.workspace_path`) guards session creation and `setWorkspace` transactionally
(`Workspace <path> is not registered to space <spaceId>; session creation blocked`). The
guard validates the **base repo root**, not the worktree path, so a session created in
worktree mode is admitted against the registered repo it was forked from. Sessions without
a workspace path (e.g. the placeholder created before a worktree-mode choice) skip the
guard, and node-agent sub-sessions inside task worktrees are exempt by construction: task
worktrees are deliberately **not** registered workspaces.

## RPC and web surface

- RPCs: `space.workspace.list` / `space.workspace.add` / `space.workspace.remove` /
  `space.workspace.updateLabel` (`packages/daemon/src/lib/rpc-handlers/space-handlers.ts`);
  `space.create` takes `additionalWorkspaces`; `spaceTask.create` / `spaceTask.update` and
  `spaceGoal.create` / `spaceGoal.update` take `workspacePath`.
- **SpaceCreateDialog** — optional "Additional Workspaces" rows (path + label, folder
  picker, at most 7) submitted with the create; an invalid extra path rejects the whole
  creation atomically.
- **SpaceSettings** — per-space workspace list with primary badge, inline label editing,
  add and remove (remove hidden for the primary; blocked removals surface the guard
  errors).
- **Task creation** — a workspace dropdown (primary marked, defaulted to primary) sends
  `workspacePath` with the create; task rows and goal detail show a repo badge for
  non-primary pins (the primary gets no badge).
- **Session creation** — when a space has more than one workspace, a picker modal offers
  each registered workspace (with a worktree / direct mode toggle); a single-workspace
  space goes straight to creation.

## Per-workspace `.mcp.json` imports

Each registered workspace may carry an `.mcp.json`; the daemon imports its `mcpServers` into
the global MCP registry as `source: 'imported'` rows, namespaced
`<workspace-label>:<server-name>` (bare `<server-name>` for unlabeled workspaces,
`...:2`, `...:3` on collisions; names claimed by user/builtin rows are skipped). The sweep
runs at daemon startup, on the global `workspace.add` history RPC, and on the
`mcp.imports.refresh` RPC (the web MCP settings' "Refresh imports" button). A malformed
`.mcp.json` pins — previously imported rows are preserved rather than pruned — and only a
removed/missing file prunes. Note `space.workspace.add` itself does not trigger a scan: a
newly registered workspace's `.mcp.json` is picked up by the next startup sweep or an
explicit refresh.

## Known limitations

- **One frozen PR per workflow run, unchanged by multi-workspace.** The reviewed PR URL is
  frozen into the run the first time a `pr_ready`-class hook allows a `send_message`; once
  the task is approved, any handoff that supplies a PR URL must supply the frozen one, and
  merge-reason handoffs must carry it. A run still produces and merges exactly one PR even
  when its tasks pin different repos — cross-repo delivery is the follow-up RFC (#2538),
  not shipped behavior.
- **Artifacts follow the task's worktree.** Commit sets, file diffs, and gate evidence are
  read from the resolving task's worktree (ladder above) and cached per worktree path; a
  run with multiple tasks warns and shows the first task's artifacts unless a `taskId` is
  passed.
- **The primary cannot change.** No set-primary API exists; the primary is fixed at space
  creation. Repointing a space means a new space.
- **Archived spaces keep claiming their paths.** A repo registered to an archived space is
  still not registrable elsewhere until the space (or its workspace rows) is removed.
- **No repo sharing between spaces** (see above), and no cross-space nesting exclusion —
  nesting is only rejected within one space.
