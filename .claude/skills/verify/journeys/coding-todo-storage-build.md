# Build coding todo repository storage

Follow SKILL.md's pinned runtime, resource guard and metadata-only wrapper:

```sh
bash .claude/skills/verify/proof-run.sh "$EVIDENCE" .claude/skills/verify/coding-todo-storage-build.ts
```

This is an inactive Build rung. Normal daemon startup must not create
`pack_coding_todos`. Actual `neo.todo.add` MCP calls must retain their current
legacy repository writes, even after explicit candidate preparation. No runtime
producer, repository/refuse hook or watcher switches to the candidate commands.

The core storage seam is an explicit constructor dependency. Default core
readers/writers stay legacy; only candidate commands inject the pack adapter.
Before preparation, both a facts command and an injected reader must fail with
`no such table`, without creating storage. Prepare explicitly before reading.
In the Bun daemon proof, roll back an outer transaction after nested preparation
succeeds: neither its table nor backfilled rows may remain. The legacy row must
survive.
All six injected reader paths must project canonical facts while default readers
and public cards still return legacy values.

Explicitly invoke registered candidate commands through real reader/writer
workers. A late pack insert failure must roll back the core todo and ask timestamp,
with no table notification. Hold a WAL writer lock: the candidate must issue no
receipt or change before commit, while public Work-card and health RPCs answer.
After release, the candidate receipt/projection uses the pack fact; the public
Work card still uses legacy fields. A recorded null must override stale legacy
data in the candidate projection, including after repeat preparation. Ask legacy
hints and distinct sibling repository facts must remain readable.

Run `coding-todo-storage-activation.test.ts` for the inactive seam, failed
insert notification ordering and outer rollback after nested preparation.
Run `coding-todo-storage.test.ts` for atomic preparation, create rollback,
foreign-key cleanup, missing candidate rows and historical fallback facts with
zero or several sibling repositories. Run the existing repository policy journey
and focused core/pack storage tests, followed by `bun run check`.

The helper closes its transport and daemon in finally and writes
`coding-todo-storage-build.json`; the wrapper saves it before deleting its fresh
HOME/data. This proves construction and unchanged public behavior, not runtime
cutover, GUI layout or a live data migration. No real DB is a test fixture.
