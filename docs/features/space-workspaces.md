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
  `UNIQUE` rules in this table — `UNIQUE(space_id, path)` and the partial unique index on
  `(space_id) WHERE is_primary = 1` — both surface as `UNIQUE constraint failed: ...` with
  only the failing index name to tell them apart, so a bare `/UNIQUE constraint/i` check
  cannot tell a duplicate-path collision from a second-primary attempt. Callers that need
  to distinguish them should pre-check with `getByPath` / `getById` (or inspect the failing
  index name in the SQLite error); the repository itself does not parse the message.

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
