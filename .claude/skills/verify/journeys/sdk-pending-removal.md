# Pending input removal stays atomic on the writer

This build-only slice registers an op without routing a live caller. Follow
SKILL.md's isolated environment rules. No model, HTTP mock, daemon, GUI or port
preflight is needed for this direct worker proof. From the worktree root:

```bash
RUN=$(mktemp -d /private/tmp/hn-sdk-withdrawal-XXXXXX)
mkdir -p "$RUN/home"
env -i HOME="$RUN/home" PATH="$PATH" NODE_ENV=test HYPERNEO_DATA_DIR="$RUN/data" \
  bun .claude/skills/verify/sdk-pending-removal.ts "$RUN"
```

The helper creates fresh synthetic databases in dual-write and side-only modes,
then makes main read-only. A real gateway worker deletes a pending SDK row,
tombstones its owned mailbox job and cancels delivery in one commit. Deferring
an enqueued row keeps its exact body. Change replay observes committed rows
before the caller resolves. A tombstone storage fault must roll back SDK
removal, retain both jobs and emit no change. Main must remain read-only.

Only `pass: true` in `evidence/sdk-pending-removal.json` is success. The helper
closes its worker and connection in finally. The observable result is recoverable
pending input after a fault and unchanged readable content when deferred. The
later routing slice must exercise public withdrawal callers and their UI.
