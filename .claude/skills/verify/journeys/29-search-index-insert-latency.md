### Search index insert latency (journey 29)

Index synthetic messages into an isolated daemon that runs its own background
FTS merges, then keep writing while the space tick's expiry UPDATE runs:

```bash
RUN=$(mktemp -d /private/tmp/hn-fts-merge-XXXXXX)
env -i PATH="$PATH" HOME="$RUN/home" HYPERNEO_DATA_DIR="$RUN/data" NODE_ENV=test \
  bun .claude/skills/verify/fts-merge-lag.ts 9349 "$RUN" 500000 256 45
```

Arguments after the run dir: rows (500,000, about the iMac's index), words per
body (64 ≈ the live average, 256 for 4x bodies) and seconds of steady writes. The
helper inserts in 200-row transactions that yield between batches, samples the
event loop every 10 ms, times 20 search queries, then runs the
`space_external_events` expiry UPDATE plus a 20-row index write every 100 ms.

End state: `observed.json` shows `index.worstBatchMs` and both `maxLagMs` below
1,000 ms at 256 words, and the same `searchAfterIndexing.totalMatches` before and
after a change. With `crisismerge` 64 the 256-word worst batch was 1,859 ms (an
FTS5 crisis merge inside the insert); with 16 it was 434 ms.
