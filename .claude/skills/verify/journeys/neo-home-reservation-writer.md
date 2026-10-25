# Neo Home project reservation on the DB writer

Run from a fresh worktree, with no credentials or existing data:

```sh
RUN=$(mktemp -d /private/tmp/neo-home-writer-XXXXXX)
mkdir -p "$RUN/home"
env -i PATH="$PATH" HOME="$RUN/home" NODE_ENV=test \
  HYPERNEO_DATA_DIR="$RUN/data" LOG_LEVEL=warn \
  bun .claude/skills/verify/neo-home-reservation.ts verify "$RUN"
```

The helper owns an ephemeral non-8399 daemon and uses its real WebSocket
`neo.home.init` operation with 40 synthetic projects. Cold setup and two competing
warm calls must return identical stable folders, committed in SQLite and created
on disk. It intercepts the main connection to require zero reservation SELECTs
or UPDATEs and observes one whole writer command per RPC. The gateway return is
checked against committed rows before Home creates directories. A real health
RPC and maximum event-loop lag are recorded. No provider, GitHub, browser,
credentials or existing daemon is used. Cleanup closes the socket and daemon.

Run `before` on the pre-fix Home repository to reproduce main-connection SQL.
Evidence lives in `evidence/home-reservation.json` within each run directory.
The storage contract additionally injects a failing reservation trigger, requires
all paths to roll back, then retries competing reservations with identical paths.
This slice proves only Home reservation; other project commands remain pending.

Fixed mode also holds a synthetic WAL writer lock for 1.2 seconds while issuing
Home init and a concurrent health RPC. Health must stay below 250 ms, loop lag
below one second, and reservation SQL must stay absent from main. The affected
Home RPC waits for the lock and therefore misses its 250 ms target; the report
records that limitation explicitly.
