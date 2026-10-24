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
ownership only after the supported deep link is requested. The first ownerless
probe deliberately holds its negative response for10 seconds, reproducing the
native wait seen after #8370. The client bounds each read-only ownership probe
to1 second, logs the initial pending result, then opens and positively confirms Desktop
ownership within the unchanged8-second overall deadline. The fixture makes ownership available400ms after open, holding negative
responses for10s both before and during that asynchronous load. Already-loaded
owners still deliver without opening. This delayed-negative case must deliver within
3 seconds through Desktop, with no shared-server resume/start. `work.send` must return
the Desktop steer receipt and must never call app-server resume/start. A refused
open, a protocol refusal, and missing/stale IPC while Desktop is running must
return `not_delivered`, without any app-server request. With the process flag
absent and the socket missing/stale, app-server delivery remains prompt. Only
four opens are expected: new-thread control, successful existing handoff,
refused existing handoff and a delayed-owner handoff. The delayed owner becomes
available at 11 seconds; admission must return not_delivered within 9 seconds,
before the caller’s 10-second timeout, then make no follower or app-server request
when that late owner appears. The production admission budget is 8 seconds total
including process probing, IPC initialization, open and discovery. Its IPC closes
at the absolute deadline and an outstanding open launcher is killed. New-thread
handoff retains its separate 30-second budget. Evidence is in `evidence/desktop-open.jsonl`.

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
Non-macOS process-probe failures preserve CLI/app-server routing; macOS probe
failures refuse. Unit controls cover both host contracts and prevent a follower
request after an absolute IPC deadline.

Completion ownership uses the installed CLI’s generated notification contract.
For codex-cli 0.163.0-alpha.11.1, `app-server generate-json-schema --out <owned-dir>`
produces `v2/TurnCompletedNotification.json` requiring `threadId` and `turn`, with
`turn.id` required. The reviewed schema’s SHA-256 is
`69413578ec3ecd02691424bdeb9d640c7244b4ca4c5c3ef26f69a2efe7c37db8`.
Generate it under a fresh HOME, without connecting to any server or loading a
thread. [Upstream generation guidance](https://developers.openai.com/codex/app-server/)
explains that this contract is specific to the generating CLI version. A malformed
completion logs only field-presence booleans and tracked-turn count, never its
contents. Unit tests retain that warning and assert a synthetic private marker
is absent. Installed-schema verification does not prove every running server uses
the installed version.

### Required Deno CI gate

The ownership change passed its driver and online suites, but its required Deno
Boot Smoke gate failed at the existing job-claim fixture INSERT with
`database is locked` ([failed job](https://github.com/lsm/HyperNeo/actions/runs/40043116800/job/120718534236)).
The smoke repair is test-only: a controlled 200 ms writer reproduces the same
fixture race, and the claim-seed connection’s 5000 ms busy timeout lets that
fixture wait. The claim/fencing assertions and all production settings remain
unchanged. This is regression coverage for the CI failure blocking this PR,
not an additional job-queue implementation or performance fix.

With Deno 2.9.4 available on PATH, repeat from the worktree root:

```bash
RUN=$(mktemp -d /private/tmp/hn-deno-gate-XXXXXX)
mkdir -p "$RUN/home"
env -i HOME="$RUN/home" PATH="$PATH" NODE_ENV=test DENO_SMOKE_PORT=9387 \
  ./scripts/deno-smoke.sh >"$RUN/deno-smoke.log" 2>&1
```

Use a free non-8399 port. The script creates its own synthetic DB/daemon and
cleans up its holder and daemon. It must pass the existing claim/fencing checks
and graceful SIGTERM shutdown with the contender present. Red/green receipts
are retained under `/Users/lsm/focus/verification/codex-unloaded-owner/` as
`review5-ci-failed.log`, `review5-red.log` and `review5-final-deno.log`.
