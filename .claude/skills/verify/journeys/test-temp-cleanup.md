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

## Shared-process Bun runner

The same command also launches two actual `bun test` files in one process,
with both importing the same cached cleanup helper. Each creates its own
`shared-process-*` fixture. Observe that neither fixture remains after Bun exits.
This reproduces the runner used by bare-Bun multi-file online/local testing;
Vitest file isolation alone cannot prove this behavior.

Test-first commit `29f82c7b69` leaves one fixture after both Bun files pass.
Retaining the exit listener alone still fails under Bun 1.4.3, whose test runner
does not emit that callback. Each consumer now calls the factory at file scope
to register its own afterAll, even when the imported module is cached. Both
files then remove their fixtures; the normal-exit fallback stays registered.
The parent proof removes its own fresh run in finally on either outcome.
