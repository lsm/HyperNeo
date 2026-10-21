## Recovery expiry responsiveness

Run a fresh isolated daemon without provider keys. The helper seeds 22,287
synthetic recovery records (22,269 consumed / 18 expired), matching the observed
production status counts, with no eligible expiry rows. It probes `system.health`
over the real WebSocket while the maintenance operation runs on the main DB.
The extra Python connection holds a synthetic WAL writer lock for 1.2 seconds.
It never opens the real DB. All helper-owned processes and the daemon close in
`finally`.

```bash
RUN=$(mktemp -d /private/tmp/hn-expiry-proof-XXXXXX)
mkdir -p "$RUN/home"
env -i HOME="$RUN/home" PATH="$(dirname "$(command -v bun)"):/usr/bin:/bin" \
  NODE_ENV=test HYPERNEO_DATA_DIR="$RUN/data" \
  bun .claude/skills/verify/recovery-expiry.ts verify 9335 "$RUN" expiry
```

`evidence/verify.json` must show covering-index checks, no expiry UPDATE during
the empty sweep, a health reply below 250 ms, and event-loop lag below 1 s.
After releasing the lock, it also expires an actual mapping and inbox request,
retaining the entire request and its existing reason. Unit boundary/status/
count/retention/upgrade contracts run only in CI. This proves the focused expiry
path, not the performance of every other writer in the daemon.

On the contract-test commit before the fix, `reproduce` with scope `full-tick`
records the recovery UPDATE blocking over 250 ms and the delayed health reply.
On fixed code, repeat `verify` with scope `full-tick` in another fresh directory:
its saved report can still fail because the following `space_external_events`
expiry performs an unrelated empty UPDATE under the same held writer lock.
Report that remaining failure explicitly; do not treat the focused expiry pass
as whole-tick acceptance. That wider contention fix is a separate item. A
controlled synthetic lock reproduces a possible cause; it does not identify the
writer responsible for an historical production event. No GUI or model turn is
part of this maintenance journey.
