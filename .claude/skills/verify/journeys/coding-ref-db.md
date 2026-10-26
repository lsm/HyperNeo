# Reference observations through the DB gateway

Run from the existing checkout. The runner uses only an already-installed
runtime, refuses to start below 25 GiB free on the data volume, and prints `df`
before every proof:

```sh
python3 .claude/skills/verify/coding-ref-db-run.py bun before
python3 .claude/skills/verify/coding-ref-db-run.py bun verify
python3 .claude/skills/verify/coding-ref-db-run.py deno before --executable "$DENO"
python3 .claude/skills/verify/coding-ref-db-run.py deno verify --executable "$DENO"
```

Set `DENO` to an existing Deno 2.9.4 executable; no runtime or dependency install
is attempted. Deno uses cached modules only. Each proof owns a fresh synthetic
HOME, TMPDIR and DB, an ephemeral non-8399 daemon, and a refusing fake gh.
Evidence JSON and synthetic gh records are copied into a uniquely named folder
under `evidence/coding-ref-db/`. The daemon closes before the runner immediately
removes its complete temporary directory. No model, provider, UI, real GitHub,
credentials or existing database is used.

The real `neo.github.read` WebSocket operation receives five concurrent PR
reads and two concurrent issue reads. Acquisition coalesces to one lookup for
each group. Changed evidence must refresh; failed acquisition must retain old
JSON and successful observation time while returning unreadable. App reopen
must retain the evidence and recover through a fresh acquisition.

Before mode temporarily restores only the two pre-migration reference source
files from the pinned origin/dev revision, then restores the draft in finally.
Do not run it concurrently with checks or another proof. It requires target
reference SQL on main. Verify mode requires zero reference cache, snapshot,
admission and persistence SQL on main. Fixture assertions are outside the
measurement window; identical alias SQL from other fact families is separated
by the calling source frame.

A controlled late collector competes with a newer observation through the real
writer. The newer value must win, advancing observation revision exactly once.
Another process holds a synthetic WAL writer lock for 1.2 seconds while a
collector waits and real `system.health` answers. Health must remain below
250 ms and main-loop lag below one second. The fake upstream deliberately waits
300 ms, so affected read RPCs miss 250 ms; the held writer also misses that
latency target. Evidence records both limitations, not a full latency pass.

The optional `--section` runner flag additionally exercises a shared issue read
and `neo.project.section`. Bun passes this probe. Deno fails identically before
and after migration because NUL-containing workspace aliases are returned
truncated despite their complete stored bytes; see #8792 and the retained
`deno-before` / `deno-verify` diagnostic folders. The common reference proof uses
public issue consumers on both runtimes, and does not claim Deno section support.
