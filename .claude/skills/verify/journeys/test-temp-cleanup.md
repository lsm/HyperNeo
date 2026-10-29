# Test fixture temporary-directory cleanup

From the worktree root, run:

```sh
cd packages/daemon
bun node_modules/vitest/vitest.mjs run tests/unit/1-core/test-temp-cleanup.test.ts
```

This runs six actual fixture suites in a child with a fresh TMPDIR. It includes
`neo-read-checkout-sync.test.ts`, which drives an isolated daemon over RPC,
advances a synthetic Git remote, and verifies the read checkout changes without
altering human edits. No human daemon or database is used.

The observable result is that none of those suites' named fixture directories
remain after the child exits. Vite's unrelated random-name temporary entry is
excluded from the fixture assertion. The enclosing proof removes only its own
fresh parent directory in finally, including on regression failure.

The test-first baseline left 27 named fixture directories (plus one tool-owned
random entry). The fixed suites leave zero named fixture directories. The shared
helper removes only paths returned by its own mkdtemp calls after all tests and
on normal process exit. It does not scan system temp directories.

Online SDK fixture consumers use the same helper; those complete model journeys
must be exercised by the online CI shards. This proof makes no claim about
SIGKILL, native Desktop ownership, or legacy hn-* directory reclamation.
