# Project forget on the DB writer

Run from the repository root with the shared metadata-only wrapper:

```sh
TMPDIR=/private/tmp bash .claude/skills/verify/proof-run.sh /absolute/evidence/project-forget \
  .claude/skills/verify/neo-project-forget-writer.ts verify
```

The helper owns an ephemeral non-8399 daemon and invokes the real
`neo.project.forget` WebSocket RPC. The WebSocket must authenticate using the
isolated run's local credential after the test data-directory checks pass.
Synthetic projects have separate coding repository watches; the forgotten
project also owns a settled ask. A failing
watch-update trigger must roll back the deletion, aliases and ask move. After
removing that trigger, competing forget requests must admit exactly one winner,
retain the unrelated watch, and move the settled ask to the root without changing
its request. Target admission, repository, watch and mutation SQL must be absent
from the main connection. Each completed request is one whole writer command.

A separate process holds a synthetic WAL writer lock for 1.2 seconds during
another forget RPC. Health must remain below 250 ms and main-loop lag below one
second. The affected write still waits for the lock and misses 250 ms; the report
records that limitation. The wrapper retains `project-forget-writer.json` in
the selected evidence directory. The helper closes its socket, lock process and daemon. No
provider, model, GitHub, browser, existing database or credentials are used.

To compare the regression-only checkout, copy the proof helper there and run its `before`
mode in another fresh directory; it requires target SQL on main. The recorded in-place
baseline used the old operation and pack callback with an export-name-only compatibility
shim for the newly registered worker module.

Unit contracts cover refused/protected/unknown projects, worker bindings,
shared/renamed watches, disabled packs, one-winner admission and external
callback failure after commit. Coding watch cleanup remains inside the same
writer transaction; generic external callbacks and notifications run after it.
