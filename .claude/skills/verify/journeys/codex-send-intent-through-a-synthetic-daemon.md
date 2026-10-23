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
strict steer guidance to Codex and direct HyperNeo/Space targets to auto. Desktop is unavailable while app-server has a steerable turn: default auto and explicit
steer must return `steeredIntoTurnId` without queueing. Explicit queue must return
`queuedSubmissionId`. Idle explicit steer must return `not_delivered` without
queueing; idle auto starts a turn with `startedTurnId` and `delivered: true`.
The idle fixture returns a completed latest turn (as Desktop does), with saved
history but no loaded app-server runtime. It rejects `turn/start` with -32600
`thread not found: synthetic` until `thread/resume` loads the runtime.
The production path must resume with `excludeTurns: true` before starting;
the send still returns the confirmed turn ID. Other resume failures return
`not_delivered` with their cause and make no start or queue request. When owner
is unavailable and resume returns exactly `thread synthetic already
has an active writer`, auto reuses the existing queue path without starting
another writer. The synthetic owner consumes the queued input and writes its reply;
receipt-bound `work.status` must observe that exact input/reply. A subsequent
unconsumed queue request stays `delivered: false` even with an older identical
input in the transcript. Queue acceptance is distinct from consumption and does
not prove Desktop rendering. After deployment, Neo sends the authorized legitimate
research-dev input and relays its receipt/reply; verify it read-only using logs or
RPC. Do not send test messages to the human's live threads.
On regression commit `09c226b44`, this fixture reproduces the reported
`thread not found` response through real WebSocket operation.invoke, then
fails the idle success assertion. This prevents a fixture from silently treating
persisted history as a loaded runtime. A Desktop owner rejects
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

For reachable Desktop ownership refusal, use the separate
`codex-desktop-ownership.md` journey. A reachable Desktop refusing ownership is
not an unavailable Desktop and must never trigger a second writer.
