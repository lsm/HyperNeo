# Main-thread DB CI ratchet

The user surface is the CI quality command, not the daemon. No daemon, provider,
browser or database is needed. Run from the worktree root after shared dependency
setup (`bun install --frozen-lockfile`). Set TMPDIR to a writable disposable
directory if the host default is unavailable.

```bash
bun run check:db-main-thread
bun run test:db-main-thread
```

The first command must exit zero and print each current count and ceiling. The
second invokes that same CLI in disposable Git repositories: adding two prepares
prints `prepare: 3 > baseline 1` and exits one; unchanged source passes; increasing
the baseline fails even without new source calls; removing calls permits lowering
it. Equivalent sync entrypoints and invalid comparison refs must also fail.

For a full-source proof, add a disposable `.ts` file beneath
`packages/daemon/src` containing `db.prepare('SELECT 1');`, run
`bun run check:db-main-thread` and observe exit one with a prepare count one above
the ceiling. Remove only that disposable file and rerun; observe exit zero.
Retain the three command outputs as evidence. Never commit the disposable file.

Counting preserves the approved design's lexical occurrence method over daemon
`.ts`/`.tsx` files, including multiline whitespace and multiple calls per line.
`storage/schema/` and the fixed worker entrypoints listed in the script are
excluded; worker helpers and shared repositories remain conservatively counted.
Each method has its own ceiling: prepare, transaction, exec, query, run, plus
`new Database`/`new DatabaseSync`. The initial prepare count is 1,416. The other
APIs cover alternate synchronous SQL entrypoints; lexical exec/query/run counts
also include unrelated receivers, strings and comments. This is a regression
ratchet, not type analysis or proof that remaining calls execute on main.
Aliased/computed method calls and statement execution through previously prepared
handles are not independently identified. Do not claim runtime lag improvement.

Baseline values must be nonnegative integers with exactly the known keys. CI
compares them with the fetched dev tip on PRs, or the previous dev SHA on pushes,
so raising a ceiling cannot hide an increase. A missing comparison ref fails
closed; a resolved tree without a baseline permits initial adoption only.
