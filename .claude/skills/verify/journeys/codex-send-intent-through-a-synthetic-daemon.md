## Codex send intent through a synthetic daemon

```bash
RUN=$(mktemp -d /private/tmp/hn-send-proof-XXXXXX)
env -i HOME="$RUN/home" PATH="$PATH" NODE_ENV=test HYPERNEO_DATA_DIR="$RUN/data" \
  LOG_LEVEL=warn bun .claude/skills/verify/codex-send-intent.ts verify 9377 "$RUN"
```

The helper starts an isolated daemon and synthetic Codex Desktop IPC/app-server
Unix sockets under its fresh HOME. It uses real WebSocket `operation.invoke`
with the production Codex adapter. `work.adapters` must advertise steer for
Codex and omit it for HyperNeo; the subsequent explicit steer must return the
active turn receipt. The real `operations.describe` door must scope
strict steer guidance to Codex and direct HyperNeo/Space targets to auto. Owner discovery rejects with a synthetic
version mismatch while app-server has a steerable turn: default auto and explicit
steer must return `steeredIntoTurnId` without queueing. Explicit queue must return
`queuedSubmissionId`. Idle explicit steer must return `not_delivered` without
queueing; idle auto starts a turn with `startedTurnId` and `delivered: true`.
The idle fixture returns a completed latest turn (as Desktop does), rather
than pretending queue acceptance consumes input. A Desktop owner rejects
steering with `NoActiveTurn`, then accepts version 2 `thread-follower-start-turn`;
its turn ID must survive the operation result schema. Refused owner starts
return `not_delivered` with the reason and never enqueue. An uncertain server steer must never also queue.
A Desktop-owned turn must steer through its owner; explicit Desktop refusal must
return `not_delivered` with its reason. Warning-level routing records, peer calls
and all RPC responses are retained in `evidence/observed.json`. On regression commit `548213b76`, the `verify` command fails at the idle
`delivered: true` assertion: the unchanged adapter returns an unconsumed queue ID.
The older `reproduce` action concerns the separate running-turn steering regression.
No model, provider, credentials, real Codex state or GUI is involved. All owned
servers and the daemon close in finally. Pick a free port other than 8399.
