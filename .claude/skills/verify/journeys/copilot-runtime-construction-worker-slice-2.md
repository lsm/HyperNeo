## Copilot runtime construction (worker slice 2)

```bash
RUN=$(mktemp -d /private/tmp/hn-copilot-owner-XXXXXX)
mkdir -p "$RUN/home"
env -i HOME="$RUN/home" PATH="$RUN/bin:$(dirname "$(command -v bun)"):/usr/bin:/bin:/usr/sbin" \
  NODE_ENV=test HYPERNEO_DATA_DIR="$RUN/data" \
  bun .claude/skills/verify/copilot-worker.ts 9382 "$RUN"
```

Use a fresh synthetic HOME/data directory and free non-8399 port. This construction
journey does not call the public worker start door. The helper starts the actual
pinned Copilot SDK against a synthetic framed-JSON-RPC executable, then starts an
isolated daemon. A test-only `verify.copilot` WebSocket RPC exercises construction
and per-input evidence while `system.health` confirms daemon responsiveness.
The first input stays incomplete through internal turn-end/assistant-idle events;
final replies bind to consumed input IDs, duplicate authoritative messages do not
duplicate the report, unrelated messages stay out, and session idle settles the
matched replies. Public `work.adapters` now advertises `find/start/send/queue/status/stop`.
An idle before the first input must remain queued. After 270 additional settled
inputs, only the latest 64 settled receipts remain; the runtime stays usable
across dedup retention rollover. A rejected permission followed by idle must stay
`needs_you`; a follow-up submit is rejected before transport and preserves that
blocked status. Unsettled inputs are capped at 64 without losing accepted receipts.
Fresh-event-ID repeats of a user message must preserve its first interaction
binding and any needs_you/failed/stopped status. A normal idle after aborted idle
must keep stopped; only an explicit new submission starts subsequent work.
Terminal abort/error settles pending and consumed receipts alike, without claiming
pending input was consumed or its reply completed. Their capacity must be released;
an ACK arriving after terminal evidence must inherit the stopped/failed outcome.
After retention rollover, a stale user echo during another send must not steal
reply attribution or admission capacity. Up to 512 relevant pre-ACK events wait
for receipt identities, then replay only against acknowledged inputs. Overflow
fails closed. Construction errors retain shutdown failure as their cause.
Dedup retains at most 512 keys, evicting only keys unrelated to unsettled inputs;
if all retained keys protect active evidence, the runtime becomes unreachable
instead of forgetting that evidence and risking duplicate attribution. Snapshot
history is bounded, not durable receipt storage; later wiring must persist reports
before eviction and provide its own durable lookup/restart contract.
`evidence/observed.json` saves actual RPC replies and SDK protocol traffic.

The helper closes its socket, owned SDK runtime and daemon in `finally`. It uses
only synthetic data, a fresh HOME/DB, a mock GitHub CLI and a fixture executable;
no auth/token files, real sessions, real Copilot, model/provider or GUI is used.
This proves construction inside the daemon process through a test-only door,
not public worker operations or production runtime compatibility. The lifecycle
journey covers start/status/stop; the send/queue journey covers owned follow-ups and terminal resume.

Run the focused process tests from `packages/daemon` with
`bunx vitest run tests/unit/1-core/drivers/copilot-worker.test.ts`.
They additionally check permission rejection, error followed by idle, pending or
empty replies, pre-ACK events, immutable snapshots, abort terminal evidence, EOF,
lost ACK without replay, incompatible version/protocol and bounded shutdown.
Shutdown uses the SDK's graceful/force-stop mechanisms; the fixture PID is observed
to disappear, which is not proof of containment for arbitrary descendant tools.
Runtime version is supplied explicitly and checked before session creation. The
fixture reports `fixture-1`/protocol 3 against pinned SDK 1.0.13; it is not a claim
that any untested real CLI/SDK pair is supported. Public wiring pins the SDK metadata runtime version and checks auth/model
admission. Real CLI compatibility and effort support remain unverified.
