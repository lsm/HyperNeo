# Build lifetime-owned human-reset notification recovery

The wrapper checks resources, scrubs credentials, uses a disposable HOME/data and
ephemeral ports, saves evidence, then removes data. No provider/model turn or HTTP mock is
needed. Record actual versions; local Bun 1.4.3 does not establish pinned native Bun 1.4.2
coverage. Never touch the live daemon.

Commit the failing construction proof first: the coordinator is absent while
the merged reset/receipt dependency contracts pass. The coordinator is a main-side
resource owner, not a worker command. Only time and a UUID cross to the writer;
notifications and closures stay on main after an exact committed receipt. Preserve
the caller's original unknown-outcome error. Never repeat its reset command.

The dependency manifest pins exact source hashes for the 146-line
reset/receipt subtree and separately audited 283-line core append subtree. Neo
authorized this audited-dependency split. The append manifest includes the later
authorized optional publication session field and its revision retention, plus
the transient versionCreated receipt flag for a newly appended card revision
(publication speech). Card handoffs expand the audited append graph to 332 lines:
the public handoff schema and its filename check are included, and card replies
retain existing handoffs. Reset notices carry no card reply or artifacts, so the
new conflict branch does not apply to them. The
146-line reset/receipt subtree, revised so the reset also cancels open pairing
requests, is pinned by its updated hash. Original measurement
files retain the historical 277-line construction baseline. Keep both interfaces and all hashes in
the contract test and each PR body. Do not change app.ts, service/publication,
WorkerLane or shared gateway plumbing. This construction journey invokes the
coordinator directly; use [reset activation](lane-c-human-reset-activation.md)
for the public CLI and notification path.

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
waits beyond a poll tick to observe no further reads or notifications. Stop the
space runtime before this deliberate gateway close, so its unrelated background
tick cannot access the closed gateway; shutdown warnings are not a passing proof.

Run focused strict types, pairing/gateway tests, repository checks and the measured
local graph/diff cap. Save flags, byte/timing/RSS/WAL metrics and hashes only;
never raw credentials, device IDs, codes or CLI output. Close owned clients,
processors, timers, locks and daemon before the proof wrapper deletes its data.
This construction journey does not exercise public reset events; use the
activation journey. Browser layout and deployment remain unverified.
