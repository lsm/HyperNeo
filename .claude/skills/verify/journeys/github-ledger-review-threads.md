# Ledger review-thread collector (Build)

Use the shared credential-free isolation in `../SKILL.md`:

```bash
RUN=$(mktemp -d /private/tmp/hn-review-threads-XXXXXX)
mkdir -p "$RUN/home"
env -i HOME="$RUN/home" PATH="$PATH" NODE_ENV=test \
  HYPERNEO_DATA_DIR="$RUN/data" LOG_LEVEL=error \
  bun .claude/skills/verify/github-ledger-review-threads.ts "$RUN"
```

The helper owns a real isolated daemon/DB, calls the coding-reader composition,
and refuses external fetch. Fake gh accepts only the synthetic GraphQL family.
Five concurrent consumers must share two pages, returning the unresolved link
and one consistent head. This is a collector contract, not a production API-read
reduction: existing readiness consumers are intentionally not wired in Build.

Stop/restart the owned daemon on the same synthetic DB. Saved facts survive;
a new demand refreshes. Failed, incomplete and cross-head refreshes refuse while
retaining prior JSON/success time. Stderr ending in `: partial` remains a failed
transport observation; only incomplete coverage is partial. Recovery succeeds. Unit contracts also reject
malformed nodes, GraphQL errors, repeated/missing cursors, coverage beyond the
page cap, foreign subjects and superseded observations; rate limits stay retryable.

Pass: `evidence/review-threads.json` has verified/resourcesStopped true and exact
per-phase counts; retain requests.jsonl. All owned daemons stop in finally. No
real keys, auth files, live DB/copy, provider turn, UI or port 8399 is used.
