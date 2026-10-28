# Build lifetime-owned human-reset notification recovery

Run proof-run.sh with lane-c-human-reset-coordinator.ts on Bun and cached native
Deno (VERIFY_PROOF_RUNTIME=deno). The wrapper checks resources, scrubs credentials,
uses a disposable HOME/data and ephemeral ports, saves evidence, then removes data.
No provider/model turn or HTTP mock is needed. Record actual versions; local Bun
1.4.3 does not establish pinned native Bun 1.4.2 coverage. Never touch the live daemon.

Commit the failing construction proof first: the coordinator is absent while
the merged reset/receipt dependency contracts pass. The coordinator is a main-side
resource owner, not a worker command. Only time and a UUID cross to the writer;
notifications and closures stay on main after an exact committed receipt. Preserve
the caller's original unknown-outcome error. Never repeat its reset command.

The dependency manifest pins exact source hashes for the unchanged 142-line
reset/receipt subtree and separately audited 277-line core append subtree. Neo
authorized this audited-dependency split. Keep both interfaces and all hashes in
the contract test and each PR body. Do not change app.ts, service/publication,
WorkerLane or shared gateway plumbing. Public reset operation wiring follows
in its own measured PR; construction must not claim that path moved off main.

Self-check cached/new main SQL denial, then run registered reset/read commands in
a fresh daemon. Verify real CLI history and public neo.publication.read. Exercise
the coordinator with a successful write, then lose its committed reply and refuse
receipt reads for longer than two seconds. The caller must receive its original
error promptly; after the reader recovers, one notification must match the exact
reset and public notice, with one write only. No receipt means no notification;
a null read does not prove an uncertain queued write can never commit later.
Keep read-only recovery owned by the gateway lifetime until a receipt or close.

Unit tests hold a receipt read across a poll tick while another reset fails:
recovery stays single-flight and eventually processes both distinct requests.
Also pin listener-failure recovery, admission refusal, and closing while a receipt
is in flight. Close must stop retries and suppress late notifications and new
writes. Native proof closes the gateway during a persistent reader outage and
waits beyond a poll tick to observe no further reads or notifications.

Run focused strict types, pairing/gateway tests, repository checks and the measured
local graph/diff cap. Save flags, byte/timing/RSS/WAL metrics and hashes only;
never raw credentials, device IDs, codes or CLI output. Close owned clients,
processors, timers, locks and daemon before the proof wrapper deletes its data.
Public reset event wiring, browser layout and deployment remain unverified.
