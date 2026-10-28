# Activate the public human-device reset on DB workers

Run proof-run.sh with lane-c-human-reset-activation.ts on Bun, then cached native
Deno (VERIFY_PROOF_RUNTIME=deno). The wrapper checks resources, uses an empty
disposable HOME/data directory and ephemeral listeners, scrubs credentials, saves
evidence and removes daemon data. No model turn or HTTP model mock is needed.
Record actual runtimes; local Bun 1.4.3 does not establish native Bun 1.4.2 coverage.

Commit the failing proof first. The real local CLI reset must fail while cached
and new target main SQL is denied, with network callers still refused. Wire the
existing public operation to the already-merged coordinator and use endAsync.
Keep reset and its human-visible notices in the worker's one atomic transaction;
all notifications stay on main after exact committed receipts. Do not replay a
reset after an unknown outcome. Preserve the local-door policy and reply shape.

Measure the full local graph including coordinator, authorization, notification
listeners, socket closure, actual daemon binding and gateway lifetime contract.
Record existing shared gateway binding plumbing separately. Neo authorized the
unchanged 142-line reset/receipt and 277-line core append subtrees as audited
dependencies; pin their source hashes/contracts and include them in the PR body.
No app.ts, service/publication, WorkerLane or shared gateway edits are allowed.

Before mutation, exercise operations.list and operations.describe over the real
WebSocket with no reset admission. Unit contracts also require catalog discovery
to work before database initialization; refused callers must not open it.
Drive real CLI devices reset-human against the isolated daemon, with target SQL
still denied on main. A paired network caller must stay refused. The local CLI
must clear only humans, retain history and reply fields, expire old codes, permit
only one recovery pairing, close the human socket and preserve relay access.
Observe both the direct reset notification and the real publication-change event;
public neo.publication.read must show complete chunked notices without secrets.

Hold another WAL writer and change the active-human set before the reset commits.
The public CLI must await the writer, emit no early notification, leave the phone
connected and keep health responsive. After release it selects the current set.
Fail the second notice: every reset/code/device/notice change rolls back and no
notification fires. Lose a committed reply and refuse reads for over two seconds:
the CLI returns the original unknown-outcome error, then the exact reset notice
event recovers through reads only, with one mutation. A before-post refusal must
not borrow a later successful reset's receipt or emit a second notification.
Concurrent empty resets each retain a notice. Close the gateway during uncertain
recovery and wait beyond a poll tick: no later reads or notifications are allowed.

Focused operation tests deny all SQL on a distinct main connection and pin the
same policy, reply, commit/rollback, no-replay and close contracts. Re-run pairing/
gateway contracts, strict test types, repository checks and cap/hash measurement.
Save flags/counters and timing/bytes/RSS/WAL only; never credentials, device IDs,
codes or CLI output. Stop clients, children, subscriptions, processors and daemon
before the wrapper removes data. Browser layout and deployment smoke are not part
of this synthetic proof; deployment remains with Neo after the release train.
