# Migration baseline fixtures

`v0.41.0.sql` was generated from the unmodified `v0.41.0` tag,
commit `a43943b6ebf1607800d989adb30f90d6e91d029d`, using Bun 1.4.3.
The tag's final numbered migration is 238. The dump contains all schema
objects and migration markers from a fresh database made with that code;
it contains no user data. Marker timestamps are fixed at 1.

To reproduce, extract that commit into a disposable directory and run
`bun install --frozen-lockfile` there. From the repository root, run:

```sh
bun packages/daemon/tests/unit/4-space-storage/storage/migrations/fixtures/schema-baseline/capture-schema.ts /absolute/path/to/tag-checkout /absolute/path/to/v0.41.0.sql
```

The capture runs migrations, creates tables, and configures FTS in the same
order as DatabaseCore startup, using only an in-memory database. SQLite
recreates implicit indexes and FTS shadow tables when the dump is loaded.
Explicit indexes and triggers are retained verbatim. Seeded application
rows are intentionally omitted; migration markers identify which upgrades
must run against the schema.

The equivalence test compares SQL tokens, including constraints and trigger
bodies, plus table_xinfo (including generated columns), foreign keys, and
index_list/index_xinfo (including implicit indexes). Its SQL tokenizer
ignores comments, whitespace and optional double quotes around simple
identifiers. It preserves string literals and does not mask schema drift.

`dev-383.sql` was captured before changing startup behavior, from unmodified
dev commit `1dd2fd64277b0f39d48943ef1b10a165af412fbd`, using Bun 1.4.3 and
the same capture command. Its last numbered migration is 383. It includes
the schema-parity prerequisite from #7200 and the test-fixture prerequisite
from #7202. This immutable legacy reference lets the test compare fresh
creation by the code under test, legacy creation on current dev, and the
v0.41.0 schema upgraded by the code under test. All three must match again
after a second startup.

The production `storage/schema/baseline-v041.json` is a serialized SQL catalogue
from this same `v0.41.0.sql` fixture: load the fixture into an in-memory SQLite
database, select `sql` from `sqlite_schema` with the capture ordering above,
and omit the `migration_markers` table (the runner creates it) and FTS shadow
tables (SQLite creates them). Serialize one complete SQL statement per JSON
array element, preserving its original whitespace. The baseline test checks
this exact catalogue against the fixture and compares the full schema at the
first post-baseline migration, before migration 239 runs. There are 230 schema
statements; no user rows or migration-marker inserts are embedded in the asset.
The baseline initializer separately preserves the fresh GitHub extension default;
other singleton defaults are still supplied by `createTables` as before.
