### Lag diagnostics name the step (journey 32)

```bash
bun .claude/skills/verify/lag-diagnostics-check.ts "$(mktemp -d /private/tmp/hn-lag-diag-XXXXXX)"
```

The helper runs the daemon's own `startDaemonLagDiagnostics` and the Bun SQLite wrapper with
query observability on a throwaway file, then blocks the event loop three ways: a 1.3 s CPU spin,
a 1.3 s `Atomics.wait` (off-CPU, like a lock or I/O wait) and a transaction that spins 1.3 s.
End state in `lag-diagnostics.json`: three `[Daemon] Event loop blocked` lines; each
`event_loop.lag_activity` record carries `resources` (main-thread CPU ms, off-CPU ms, major page
faults, block writes, voluntary context switches since the previous tick). The spin reads as
~1,300 ms CPU, the wait as ~1,400 ms off-CPU, and the third line ends
`slowest SQL …ms: transaction`. On macOS a blocking wait may not count voluntary switches.

Live, a feed or driver-refresh block names its open phase: `feed:<claude|codex>:<head|read|parse|save>`,
`feed:<kind>:<purge|prune|list|changed>`, and `neo:driver:<card_topic_sweep|todo_refresh|follow_topics|session_watch>`.
A block with high `majorPageFaults` and off-CPU time is paging, not our work.

To load the Claude feed on a synthetic transcript in an isolated daemon:

```bash
RUN=$(mktemp -d /private/tmp/hn-feed-lag-XXXXXX)
env -i PATH="$PATH" HOME="$RUN/home" HYPERNEO_DATA_DIR="$RUN/data" NODE_ENV=test \
  bun .claude/skills/verify/work-feed-lag.ts 9350 "$RUN" 24
```

It writes a 24 MB transcript (text turns plus tool results), runs `work.feed.claude` until every
turn is indexed and samples the event loop. Baseline on dev: one 1.2 s job, max lag 67 ms.
