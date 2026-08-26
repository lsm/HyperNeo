# Space workspaces

A space can register multiple workspace directories in `space_workspaces`; at most one row per
space has `is_primary = 1` (enforced by the partial unique index `idx_space_workspaces_primary`),
and `UNIQUE(space_id, path)` prevents registering the same path twice within one space. At the
repository layer the same path may belong to different spaces; whether that is allowed is
decided above it — registration validation (below) rejects cross-space claims.

`SpaceWorkspaceRepository` (`packages/daemon/src/storage/repositories/space-workspace-repository.ts`)
is a thin data-access layer over that table:

- `create` / `getById` / `listBySpace` (primary first, then oldest) / `getByPath(spaceId, path)` /
  `findOwnerByPath(path)` (across all spaces) / `updateLabel` / `delete(spaceId, id)` / `countBySpace`.
- Constraint violations surface as thrown SQLite errors with no reclassification. The two
  `UNIQUE` rules both raise `UNIQUE constraint failed: ...` and are distinguishable only
  by the column list: a duplicate path fails as
  `UNIQUE constraint failed: space_workspaces.space_id, space_workspaces.path`, a second
  primary as `UNIQUE constraint failed: space_workspaces.space_id` (the partial unique
  index on `(space_id) WHERE is_primary = 1` reports its indexed column, not its name).
  The mapping is not exhaustive: an insert that violates both rules at once — the
  existing primary's path together with `isPrimary: true` — reports only the
  second-primary signature, so the message names one violated constraint, not all of
  them. Callers that need the full conflict set must query for it (`getByPath` plus the
  current primary) after a failure; pre-checks race with concurrent inserts.

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

## Registration validation pipeline (unwired until WS05b)

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
5. **Per-space cap** — at most `MAX_WORKSPACES_PER_SPACE` (8) workspaces per space.

Snapshot contract: `claims` must cover every `spaces.workspace_path` across all spaces
(archived ones included) plus every `space_workspaces` row; `workspaceCountForSpace` is that
space's current `space_workspaces` row count, so the manager decides whether its own primary
counts toward the cap by including it there.
