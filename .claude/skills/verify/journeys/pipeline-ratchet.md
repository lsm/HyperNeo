# Pipeline ratchet

The user surface is the CI quality command. Run from the checkout root after
`bun install --frozen-lockfile`, with Bun 1.4.2:

```bash
bun run check:pipeline-ratchet
bun run test:pipeline-ratchet
```

The first prints all four counts and exits zero at the committed baseline. The
second exercises the CLI against disposable repositories and checks that each
count increase, an increased baseline, and a malformed baseline fail. A decrease
requires `bun run check:pipeline-ratchet --update` to lower the baseline.
The task-message route regression runs with `bun run test:system-map` after
dependency installation; the ratchet CLI tests also run before installation in CI.

For a full-source proof, add an untracked source file under `packages/daemon/src`
containing `defineOperation({ name: 'proof.ratchet', execute: () => 1 });`, run
`bun run check:pipeline-ratchet` and confirm the missing count rises and the
command exits one. Remove that file and confirm the command exits zero again.
Use a fresh, uniquely named file and do not commit it.

The reader follows direct local pipeline bindings. Forwarded names and routes it
cannot follow count as unreadable; a literal pipeline found in another lexical
scope does not establish a route. It compares the baseline with `DB_RATCHET_BASE`
(or `origin/dev`) so a source change cannot raise the ceiling by editing JSON.
