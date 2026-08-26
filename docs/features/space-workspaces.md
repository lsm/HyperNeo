# Space workspaces

A space can register multiple workspace directories in `space_workspaces`; at most one row per
space has `is_primary = 1` (enforced by the partial unique index `idx_space_workspaces_primary`),
and `UNIQUE(space_id, path)` prevents registering the same path twice within one space. The same
path may legitimately belong to different spaces.

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
