# Message delivery parking runs on the writer with its claim fence

Use a fresh synthetic daemon, no provider, HTTP mock or GUI:

```sh
RUN=$(mktemp -d /private/tmp/hn-delivery-parking-XXXXXX)
mkdir -p "$RUN/home"
env -i HOME="$RUN/home" PATH="$PATH" NODE_ENV=test \
  HYPERNEO_DATA_DIR="$RUN/data" LOG_LEVEL=warn \
  bun .claude/skills/verify/lane-b-delivery-parking.ts "$RUN" > "$RUN/daemon.log" 2>&1
```

The helper owns an ephemeral daemon and creates a manual session through real
RPC. Its real processing-state manager persists a cooldown. Seed one ordinary
SDK user row through the existing SDK writer and a due delivery job, then let
the daemon's unmodified registered delivery processor claim and park it. The
main connection rejects the parking UPDATE from the real handler stack.

Expect pending at the cooldown deadline, one park, zero retry spend, cleared
lease timestamps and a retained claim token. The public `message.status` RPC
must still report `queued`, and health must answer before/after. Evidence is
`evidence/delivery-parking.json`. The pre-fix daemon fails with one forbidden
main parking write. Resources close in finally; once evidence JSON is saved and cleanup finishes, the helper
removes its temporary data, home and workspace directories. Deno smoke runs the same proof.

Unit tests retain all three parking routes, pause before the writer transaction
to replace the claim and require `stale_attempt` without mutating the new owner,
refuse a null token, and reject writer failure without an inline fallback. The
writer returns only a boolean, so an existing job content snapshot is not cloned
back to main merely to test success. This slice does not port claim/content
reads, other requeue/reclaim/cancel paths, shutdown, or establish contention and
clone/RSS/loop-lag targets. No provider turn is needed or attempted.
