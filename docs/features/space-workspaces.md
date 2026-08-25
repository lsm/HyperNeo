# Space workspaces

A space can register multiple workspace directories in `space_workspaces`; at most one row per
space has `is_primary = 1` (enforced by the partial unique index `idx_space_workspaces_primary`),
and `UNIQUE(space_id, path)` prevents registering the same path twice within one space. The same
path may legitimately belong to different spaces.

`SpaceWorkspaceRepository` (`packages/daemon/src/storage/repositories/space-workspace-repository.ts`)
is a thin data-access layer over that table:

- `create` / `getById` / `listBySpace` (primary first, then oldest) / `getByPath(spaceId, path)` /
  `findOwnerByPath(path)` (across all spaces) / `updateLabel` / `delete(spaceId, id)` / `countBySpace`.
- Constraint violations surface as thrown SQLite errors — callers distinguish duplicate-path
  collisions from other failures with an `/UNIQUE constraint/i` check on the error message.
  A second primary row for the same space trips the partial index and also throws.

## Canonical path comparison

The repository performs **exact string equality** on `path` — it stores and compares whatever it
is given and applies no normalization of its own. Canonicalization is the manager layer's job
(validation policy lives there too): callers must resolve paths to their canonical form
(absolute, symlinks resolved, no trailing separator) **before** calling the repository.

Consequences of that contract:

- `/tmp/repo` and `/tmp/repo/` are distinct keys; only one can be registered per space, and
  `findOwnerByPath` will not match both.
- `getByPath` never leaks across spaces: it always takes `(spaceId, path)`.
- When several spaces registered the same canonical path, `findOwnerByPath` returns the primary
  row of one of them deterministically (primary rows win, then earliest `created_at`, then
  lexicographically smallest `id`, so the winner is stable even when rows share a millisecond
  timestamp).
