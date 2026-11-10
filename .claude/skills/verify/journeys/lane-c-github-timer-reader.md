# Public polling timer reader activation

Use shared setup in `../SKILL.md` and run `proof-run.sh` with
`lane-c-github-timer-reader.ts` under Bun. The fixture configures the optional
session-watch provider as absent, starts the real registered extension through its
manager/context and verifies an active timer through the real `space.github.health` RPC.
This exercises Space-only polling; the normal app's present session provider intentionally
keeps its timer. All HOME/data, ports, credentials and GitHub/HTTP stubs are synthetic and
owned. Never use port 8399.

Drive `space.github.setPollingEnabled` and reject its unscoped timer SELECT on
main. Public health readback runs separately with that trap disabled: its own
reader family is not migrated here. Verify the mutation awaits the registered
reader before acknowledgement/notification. No timer and a present session
provider skip admission. An active orphan row retains the timer, preserving the
existing unscoped active-row selection. Reader failure preserves the known write and timer,
propagates to the caller, emits no callback notification and adds no replay.

Hold an actual timer-reader reply, then commit a newer polling enable. Its
capability acknowledgement waits on the existing effect queue. Health remains
responsive; releasing the older reply leaves the newer timer active. Also stop
and restart the extension while a reply is held. Manager stop unregisters RPC
handlers, so restore them on `app.messageHub` before starting the new lifetime.
The captured-handle check must
preserve the new lifetime's timer. No SQLite transaction spans these waits.

Count complete read/query/mapper modules, new timer method, existing queue and
resource fields, complete selected public handler and auth gate, import and
smoke registration: 199 lines, no exclusions. The original synchronous helper
is deleted under the separate #9657 ownership-guard slice; the separately measured 196-line unwatch slice reuses
the reader helper. Watch uses the approved 167/97/264 boundary in its own
journey; its validation/webhook/config subtree remains unchanged; do not claim #9438 or #8714 complete. No caller
bridge exception or full public/runtime closure claim is made. Refresh existing
capability/writer audit contracts only for this explicitly measured sibling
activation, keeping their original owned subtrees unchanged.

Retain `github-timer-reader.json`, latency/clone/RSS/WAL/loop metrics and wrapper
status before cleanup. Deliberately held requests are not latency-target passes;
separate queue/SQL/clone durations are unexposed. Failure uses a synthetic Worker
error event, not an OS process kill. GUI, real GitHub, deployment, background poll
reader migration and full startup/shutdown ownership remain unverified.
