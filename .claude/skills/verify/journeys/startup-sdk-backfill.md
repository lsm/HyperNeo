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
Verify starts a real standalone daemon child, probes its existing HTTP root for 200 within
five seconds while the backfill is incomplete, and observes persisted progress.
The existing system.health RPC and global-system snapshot must report running
progress. An old-history request waits while a new session can be created and read.
It SIGKILLs only that child, starts again on the same synthetic DB, observes
resume at or beyond the saved cursor and waits for completion. The old history
then returns messages and health reports complete. All logical message bytes,
counts and eligible projections must match. Cleanup stops its exact child even
when an assertion fails. Keep `evidence/startup.json`, seed digest and child logs.

On the old startup path, the first HTTP probe fails while chunk logs and the
persisted cursor demonstrate that the backfill is running before listener bind.
This checks the existing HTTP/RPC surfaces; no new UI is introduced.

Space worker recovery also waits for projection readiness before deciding whether
to replay persisted input. Run the synthetic legacy-row regression with
`cd packages/daemon && bunx vitest run tests/unit/5-space/runtime/task-agent-manager-rehydration-mcp.test.ts`.
It proves an unprojected enqueued input is retained and replayed after the real
backfill completes, rather than restoring a worker with replay disabled.
