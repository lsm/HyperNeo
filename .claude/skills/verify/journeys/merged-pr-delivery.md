# A merged observation survives a lost owner handoff

Use shared isolation in `../SKILL.md`; no provider/model/GUI is needed.

```sh
RUN=$(mktemp -d /private/tmp/hn-merged-delivery-XXXXXX)
mkdir -p "$RUN/home"
env -i HOME="$RUN/home" PATH="$RUN/bin:$PATH" NODE_ENV=test \
  HYPERNEO_DATA_DIR="$RUN/data" LOG_LEVEL=error \
  bun .claude/skills/verify/merged-pr-delivery.ts "$RUN"
```

The helper owns an ephemeral test daemon with GitHub/Claude stubs and rejects
all external fetches. It seeds synthetic merged/closed observations through the
real ledger gateway, then discards the transition return and restarts the daemon.
The pending intents must persist. It discovers their owner only after restart,
then rejects actual mailbox writes with a synthetic trigger. A second restart
must still retain both intents. Removing that rejection and running overlapping
production coding-pack sweeps must enqueue exactly two owner mailbox messages,
even when both subsequent GitHub refreshes throw,
clear only the accepted intents, and fill `told_at`. A third restart and equal
GitHub reads must leave exactly those two messages. The old terminal row seeded
before feature activation must never create a notice.

Inspect `evidence/merged-pr-delivery.json` for pending, rejected, accepted and
restarted ledger/mailbox states. Jobs are deferred before restart; this proves
actual durable owner-mailbox acceptance, not provider consumption or native
Claude Desktop delivery. No real DB reads/copies or live daemon/8399 access are
part of the helper. All owned resources close in finally.

Unit regressions also cover intent-write rollback, legacy schema upgrade,
persisted activation boundaries, owner discovery, rejected handoff retry and
serialized overlapping delivery. The existing `coding-signoff-scope` journey
must still produce its three owner lifecycle notices without repeated-read
duplicates, preserving #8544 behavior.

A terminal observation already present before this fix has no trustworthy
lifecycle acknowledgement history. The upgrade deliberately does not replay
that historical backlog. External adapters without keyed idempotent sends can
still duplicate a handoff if the process dies after remote acceptance but before
its local acknowledgement; the durable intent prevents silent loss in that gap.
