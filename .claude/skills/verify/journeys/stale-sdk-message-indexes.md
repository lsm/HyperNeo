# Stale SDK indexes cannot break mailbox saves

Use shared isolation in `../SKILL.md`. No model or HTTP mock is needed.

```bash
RUN=$(mktemp -d /private/tmp/hyperneo-stale-sdk-XXXXXX)
mkdir -p "$RUN/home"
env -i HOME="$RUN/home" PATH="$PATH" NODE_ENV=test \
  HYPERNEO_DATA_DIR="$RUN/data" LOG_LEVEL=error \
  bun .claude/skills/verify/stale-sdk-message-indexes.ts "$RUN"
```

The helper owns an actual ephemeral-port daemon and a fresh synthetic DB. It
creates a session through RPC, leaves migration 173 marked, removes only the
synthetic 449 marker, and installs both old indexes as an upgrade fixture.
An actual save must fail with `malformed JSON`. `baseline` stops there; on the
pre-fix commit the normal journey fails after restart because both indexes remain.

After restart, synchronous migration 449 must have a new marker and both indexes
must be absent. The old 173 marker is unchanged. A new `message.send` through RPC
must save. A synthetic trigger then rejects primary saves while allowing the
existing failed-row materializer to persist. Submit one mailbox entry with the
existing one-attempt policy; no production retry policy is changed.

The actual `messages.bySession` live-query snapshot must show the failed input.
A dead-letter log must include the target session id and forced error even at
`verbose:false`. `failure-baseline` removes only the synthetic indexes after
restart to isolate the pre-fix logging failure; it confirms the failed message
already exists but the dead-letter log is suppressed. The fix reuses that failed
message path rather than adding a second one. Another restart must not recreate
the indexes. Separate migration tests prevent legacy 113/131 from recreating them.

Pass: `evidence/indexes.json` has `verified: true`, the legacy save error, both
markers, empty `after`, a newly saved message, `failed.send_status: failed`, the
live-query snapshot and session-labelled failure logs. Save this evidence and
logs before removing the run. No live DB, tts access, credentials, provider turn,
GUI or port 8399 is used. All owned resources close in finally.
