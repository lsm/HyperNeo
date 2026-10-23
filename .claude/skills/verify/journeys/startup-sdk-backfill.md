# Serving during SDK history preparation

Read shared setup in `../SKILL.md` and `sdk-message-derived-column-upgrade-journey.md`.
Use a fresh absolute RUN, temporary HOME and a free non-8399 port. No model,
credentials, live database or GUI is needed for the startup proof. From the root:

```bash
RUN=$(mktemp -d /private/tmp/hn-startup-backfill-XXXXXX)
mkdir -p "$RUN/home"
env -i HOME="$RUN/home" PATH="$PATH" NODE_ENV=test \
  HYPERNEO_DATA_DIR="$RUN/data" LOG_LEVEL=info \
  bun .claude/skills/verify/startup-sdk-backfill.ts seed "$RUN" 9389 200000
env -i HOME="$RUN/home" PATH="$PATH" NODE_ENV=test \
  HYPERNEO_DATA_DIR="$RUN/data" LOG_LEVEL=info \
  bun .claude/skills/verify/startup-sdk-backfill.ts verify "$RUN" 9389
```

Seed owns a synthetic current-schema database with 200,000 legacy-shaped message
bodies and a missing v2 projection marker. It records their count and digest.
Verify starts a real daemon child, probes its existing HTTP root for 200 within
five seconds while the backfill is incomplete, and observes persisted progress.
It SIGKILLs only that child, starts again on the same synthetic DB, observes
resume at or beyond the saved cursor and waits for completion. All message bytes,
counts and eligible projections must match. Cleanup stops its exact child even
when an assertion fails. Keep `evidence/startup.json`, seed digest and child logs.

On the old startup path, the first HTTP probe fails while chunk logs and the
persisted cursor demonstrate that the backfill is running before listener bind.
This is a startup/RPC boundary proof; UI rendering needs its separate check.
