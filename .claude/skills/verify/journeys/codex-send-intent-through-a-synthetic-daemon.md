## Codex send intent through a synthetic daemon

```bash
RUN=$(mktemp -d /private/tmp/hn-send-proof-XXXXXX)
env -i HOME="$RUN/home" PATH="$RUN/bin:$PATH" NODE_ENV=test HYPERNEO_DATA_DIR="$RUN/data" \
  LOG_LEVEL=warn bun .claude/skills/verify/codex-send-intent.ts verify 9377 "$RUN"
```

The helper requires its synthetic `bin` at the front of PATH **before Bun starts**.
Its `open` and `ps` shims record launch arguments and report a controlled Desktop
process state; they never open a GUI or inspect the host's processes. The real
new-thread control opens `new-handoff-control` and starts through its owner.

For auto/steer delivery to an unloaded existing thread with running Desktop, the open shim registers
ownership only after the supported deep link is requested. `work.send` must return
the Desktop steer receipt and must never call app-server resume/start. A refused
open, a protocol refusal, and missing/stale IPC while Desktop is running must
return `not_delivered`, without any app-server request. With the process flag
absent and the socket missing/stale, app-server delivery remains prompt. Only
three opens are expected: new-thread control, successful existing handoff and
refused existing handoff. Evidence is in `evidence/desktop-open.jsonl`.

Explicit queue is a separate path: while Desktop is running, the journey observes
`thread/queue/add` and its queue ID without a resume/start request. It is not
covered by the auto/steer ownership gate.

The no-Desktop idle auto path resumes before starting a turn. The fixture emits its
matching `turn/completed`; retain the subsequent `thread/unsubscribe` request and
routing log. Unit contracts also check completion before the start reply and an
unrelated thread's completion. An unsubscribe receipt starts the official idle
grace; it is not proof of immediate unload. A real thread can remain loaded for
up to 30 minutes without subscribers/activity.

The helper starts an isolated daemon and synthetic Codex Desktop IPC/app-server
Unix sockets under its fresh HOME. It uses real WebSocket `operation.invoke`
with the production Codex adapter. `work.adapters` must advertise steer for
Codex and omit it for HyperNeo; the subsequent explicit steer must return the
active turn receipt. The real `operations.describe` door must scope
strict steer guidance to Codex and direct HyperNeo/Space targets to auto. With Desktop absent, app-server has a steerable turn: default auto and explicit
steer must return `steeredIntoTurnId` without queueing. Explicit queue must return
`queuedSubmissionId`. Idle explicit steer must return `not_delivered` without
queueing; idle auto starts a turn with `startedTurnId` and `delivered: true`.
The idle fixture returns a completed latest turn (as Desktop does), with saved
history but no loaded app-server runtime. It rejects `turn/start` with -32600
`thread not found: synthetic` until `thread/resume` loads the runtime.
The production path must resume with `excludeTurns: true` before starting;
the send still returns the confirmed turn ID. Other resume failures return
`not_delivered` with their cause and make no start or queue request. When Desktop is absent and resume returns exactly `thread synthetic already
has an active writer`, auto reuses the existing queue path without starting
another writer. The synthetic owner consumes the queued input and writes its reply;
receipt-bound `work.status` must observe that exact input/reply. A subsequent
unconsumed queue request stays `delivered: false` even with an older identical
input in the transcript. Queue acceptance is distinct from consumption and does
not prove Desktop rendering. After deployment, Neo sends one harmless marker to a clearly named disposable
thread prepared with completed history but not loaded in Desktop. Verify the
matching Desktop receipt, input/reply and absence from shared loaded threads.
Ask the human to open it without restarting and confirm no lock banner. Never
use human working or OAP threads.
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

Refusal evidence also covers admission diagnostics: missing and stale socket
paths through the actual RPC retain the transport-failure record. Separate
helper-level controls pass no endpoint or a failing process probe, require
not_delivered without spawning, and observe work.send route with the explicit
desktop_socket_missing / desktop_running_probe_failed reason. These controls
are distinguished from the full RPC path, whose adapter supplies a socket path.
