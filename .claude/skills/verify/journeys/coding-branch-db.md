# Coding branch observations through the DB gateway

Run from the worktree root using a new synthetic directory:

```sh
RUN=$(mktemp -d /private/tmp/coding-branch-db-XXXXXX)
mkdir -p "$RUN/home"
env -i PATH="$PATH" HOME="$RUN/home" NODE_ENV=test \
  HYPERNEO_DATA_DIR="$RUN/data" LOG_LEVEL=error \
  bun .claude/skills/verify/coding-branch-db.ts verify "$RUN"
```

The helper owns an ephemeral non-8399 daemon, two synthetic Git checkouts and a
fake gh that accepts only branch PR-list commands. Real `work.find`,
`work.status`, `neo.snapshot` RPCs and the existing driver-refresh job exercise
the default branch reader. Concurrent demand for one repository/branch must
collect once; another checkout and a daemon restart must reuse committed
coverage. The comparison remains one initial lookup, two direct legacy lookups,
and zero lookups after reopening.

The main connection is instrumented only during live reads and jobs. No branch
snapshot, canonicalization or observation SQL may run there. Read-only fixture
assertions are outside that window. The `before` mode on the regression-only
branch-facts source requires target SQL on main. Each run retains
`evidence/coding-branch-db.json` and the exact synthetic gh invocations.

In fixed mode a separate collector is held at its fake upstream response.
A competing observation commits through the actual writer first. Releasing the
late response must preserve the winning URLs and observation revision one.
A separate process then holds a synthetic WAL writer lock for 1.2 seconds while
another collector waits and a real `system.health` RPC answers. Health must stay
under 250 ms and main-loop lag under one second. The affected write misses its
250 ms target while the lock is held; the report records that limitation.

Repeat with Deno 2.9.4 in a new isolated environment from `packages/daemon`,
using `deno run -A ../../.claude/skills/verify/coding-branch-db.ts verify "$RUN"`.
The fake gh still uses the installed Bun runtime. No provider, model, browser,
existing data, credentials or real GitHub is used. Owned daemon instances,
sockets and lock processes close in finally. Branch-reader contracts additionally
cover aliases, partial/empty/failed coverage, retry-after, bounded contention,
coalescing and stale observations. Other coding observation families and watch
policy reads remain separate slices.

RPC timings are retained separately: initial `work.find` discovery can still
exceed 250 ms even when warm status/snapshot reads and main-loop responsiveness
pass. This slice does not claim the discovery latency is fixed. Persistent-busy
contracts require exactly three writer attempts, one upstream read and an
explicit failure, followed by a successful later retry.
