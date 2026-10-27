# Ordinary reminder creation commits on the writer

Run `lane-b-session-schedule-create.ts` through `proof-run.sh` with Bun, then with
`VERIFY_PROOF_RUNTIME=deno` and the cached runtime on PATH. The helper owns a fresh
synthetic daemon, an ephemeral non-8399 port, disposable HOME/data and native DB
workers. GitHub commands use a refusing local stub. There is no provider/model
turn, credential or external HTTP access.

Call the actual `schedule.session.create` operation over WebSocket. Cold and
concurrent requests must return active schedules whose wake job and pending-job
pointer are already committed together. Invalid cadence is refused before admission.
A short held WAL writer must delay the affected create while health stays usable;
its uncommitted fixture value stays invisible outside its connection.

Deny new and cached main SQL for schedule creation and the wake insert/read.
Assertion-only fixture reads temporarily leave measurement. A failed wake insert
must roll back the schedule. Writer failure before commit leaves no pair; losing
the native post-commit reply rejects as outcome unknown, retains exactly one pair
and causes no automatic replay. A later independent create opens a fresh writer.
The baseline must fail on forbidden main SQL; commit it before the production fix.

Record operation receipts, committed pair checks, rollback/failure results, main SQL,
latency, loop lag, RSS, WAL and combined native-worker/request/reply encoding metrics.
These do not isolate SQL, queue and cloning costs. Close owned workers and save JSON
before immediately removing synthetic daemon data. The public create path uses an
explicit async command; the transaction-bound synchronous goal path stays in place
until its whole command is moved. No worker failure may select that legacy path.

Pause, resume, delete, list, startup recovery, firing/outcome callbacks and goal
synchronization are later slices. This proof does not establish their DB ownership,
large-volume performance, deployed-build behavior or browser layout.
