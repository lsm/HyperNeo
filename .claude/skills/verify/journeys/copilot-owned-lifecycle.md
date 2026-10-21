## Copilot owned lifecycle (worker slice 3)

```bash
RUN=$(mktemp -d /private/tmp/hn-copilot-lifecycle-XXXXXX)
mkdir -p "$RUN/home"
env -i HOME="$RUN/home" PATH="$RUN/bin:$(dirname "$(command -v bun)"):/usr/bin:/bin:/usr/sbin" \
  NODE_ENV=test HYPERNEO_DATA_DIR="$RUN/data" \
  bun .claude/skills/verify/copilot-lifecycle.ts 9384 "$RUN"
```

Use a fresh synthetic HOME/data directory and free non-8399 port. The actual
isolated daemon uses the pinned SDK and synthetic framed-JSON-RPC executable.
Through public `operation.invoke`, `work.adapters` exposes only find/start/status/stop;
start returns a session reference and input receipt; status returns its complete
reply, denied permission remains needs_you, and stop waits for aborted idle before
reporting stopped. All fixture runtime PIDs must disappear on daemon cleanup.
A relative DB path must still give the runtime an absolute ownership directory
beside that DB. After a completed runtime exits, repeated receipt-bound status
and a daemon restart must preserve its already-recorded terminal result. An
unknown model must return `unsupported_model` before create/send. Missing auth
reports the human step `copilot login`; an empty model catalog refuses
start. Disconnect after the first ACK must return unreachable with the session ID,
never queued success. Restarting with only this synthetic DB/ownership directory reports unfinished
work as unreachable and never resends. External sessions are not adopted or stopped.
Evidence: `evidence/observed.json`, including operation replies and fixture protocol
traffic. The helper closes its WebSocket and daemon in `finally`.

Rerun the discovery and construction journeys after changing the lifecycle surface;
they now expect lifecycle capabilities but preserve external read-only boundaries.
Focused `copilot-adapter.test.ts` additionally covers ACK-only abort refusal, lost
first ACK identity, disconnect after ACK, foreign receipts, canonical execution
folders, model/effort and
preparation refusal. Run it serially with the worker and discovery tests using the
daemon Vitest runner. No real Copilot, account session, credentials, provider or
unattended GUI is used. This is protocol/operation proof with synthetic data.

The accepted runtime is exactly CLI 1.0.83, matching installed SDK 1.0.13 package
metadata; the fixture impersonates that version. A real pair has not been run in
this slice. Other versions fail before creating a session. Models require an exact
runtime catalog ID; no default/effort is inferred. Preparation packs, send, queue,
strict steering, durable resume/history and owned find overlay remain unwired.
All tools are unavailable and permission callbacks reject: this slice grants no
coding-tool access. Ownership JSON lives beside the daemon DB, never in Copilot's
own stores; it preserves IDs and read snapshots, not permission grants. A restart
cannot recover a live owner. No claim covers real app visibility, arbitrary child
process containment or a failed OS-level shutdown.

Run `copilot-lifecycle.ts <port> "$RUN"` for all cases, or add `terminal`, `model`,
or `relative` as the final argument for an isolated regression. The default run
changes cwd to its fresh run directory, uses `data/daemon.db`, kills only its own
completed fixture runtime, checks its full recorded reply, and rejects an unknown
model against the nonempty synthetic catalog. Calls for the rejected model must
contain neither session creation nor a send. On the regression commit, each
individual mode fails at its corresponding public operation. Terminal outcome
snapshots do not need a live runtime ping; queued/running/needs_you still do.

For the concurrent stop/status regression, the fixture holds runtime shutdown until
its synthetic `release-shutdown` file appears. While stop is in flight, issue
receipt-bound status and an independent catalog RPC, then release only that
fixture. Both concurrent and later status must report stopped, including after
daemon restart. Status/stop transactions serialize per session; other sessions
remain independent. Cleanup drains in-flight transactions before closing remaining
runtimes. Focused tests also hold shutdown while daemon cleanup starts, then verify
cleanup waits for the owned process. This proves the synthetic race at the public
operation door, without real sessions or GUI automation.
