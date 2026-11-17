# getDatabase CI ratchet

The user surface is the CI quality command, not the daemon. No daemon, provider,
browser or database is needed. Run from the worktree root after shared dependency
setup (`bun install --frozen-lockfile`).

```bash
bun run check:get-database
bun run test:get-database
```

The first command must exit zero and print `getDatabase: N (baseline N)`. The
second runs that same CLI in disposable Git repositories: an added call prints
`getDatabase: 3 > baseline 2` and exits one; test files are not counted; removing
a call fails until the baseline is lowered, and `--update` lowers it; neither
`--update` nor a hand edit can raise it; a missing comparison ref or malformed
baseline fails closed.

For a full-source proof, add a disposable `.ts` file beneath
`packages/daemon/src` containing `getDatabase();`, run
`bun run check:get-database` and observe exit one with a count one above the
baseline. Remove only that file and rerun; observe exit zero. Never commit it.

Counting is lexical: every `getDatabase(` occurrence in non-test `.ts`/`.tsx`
files under `packages/daemon/src`, including method declarations. It is a
regression ratchet toward a single DB writer, not proof of where calls run.
CI compares the baseline with the same ref as the main-thread DB ratchet
(`DB_RATCHET_BASE`).
