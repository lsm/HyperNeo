# Project forget on the DB writer

Run from the repository root with fresh synthetic directories:

```sh
RUN=$(mktemp -d /private/tmp/neo-forget-writer-XXXXXX)
mkdir -p "$RUN/home"
env -i PATH="$PATH" HOME="$RUN/home" NODE_ENV=test \
  HYPERNEO_DATA_DIR="$RUN/data" LOG_LEVEL=warn \
  bun .claude/skills/verify/neo-project-forget-writer.ts verify "$RUN"
```

The helper owns an ephemeral non-8399 daemon and invokes the real
`neo.project.forget` WebSocket RPC. Synthetic projects have separate coding
repository watches; the forgotten project also owns a settled ask. A failing
watch-update trigger must roll back the deletion, aliases and ask move. After
removing that trigger, competing forget requests must admit exactly one winner,
retain the unrelated watch, and move the settled ask to the root without changing
its request. Target admission, repository, watch and mutation SQL must be absent
from the main connection. Each completed request is one whole writer command.

A separate process holds a synthetic WAL writer lock for 1.2 seconds during
another forget RPC. Health must remain below 250 ms and main-loop lag below one
second. The affected write still waits for the lock and misses 250 ms; the report
records that limitation. Evidence is `evidence/project-forget-writer.json` within
the run directory. The helper closes its socket, lock process and daemon. No
provider, model, GitHub, browser, existing database or credentials are used.

For Deno 2.9.4, run from `packages/daemon` in a new isolated environment, replacing
the Bun invocation with
`deno run -A ../../.claude/skills/verify/neo-project-forget-writer.ts verify "$RUN"`.
To compare the regression-only checkout, copy the proof helper there and run its
`before` mode in another fresh directory; it requires target SQL on main.
The recorded in-place baseline used the old operation and pack callback with an
export-name-only compatibility shim for the newly registered worker module.

Unit contracts cover refused/protected/unknown projects, worker bindings,
shared/renamed watches, disabled packs, one-winner admission and external
callback failure after commit. Coding watch cleanup remains inside the same
writer transaction; generic external callbacks and notifications run after it.
