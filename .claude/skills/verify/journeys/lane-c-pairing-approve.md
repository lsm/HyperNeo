# Pairing code approval commits on the DB writer

Run `lane-c-pairing-approve.ts` through `proof-run.sh` with Bun and then with
`VERIFY_PROOF_RUNTIME=deno` and the cached runtime on PATH. Use fresh evidence
folders. The helper owns an isolated daemon on an ephemeral non-8399 port,
synthetic device credentials, disposable HOME/data, native DB workers and a
refusing GitHub stub. No real credential, key file, model or external HTTP is used.

A pending synthetic phone code initially returns HTTP 403. A real WebSocket
`device.pair.approve` call authenticated as the synthetic paired human must return
success only after its approval is committed; the phone then redeems over HTTP.
Deny new and cached main-thread statements for the active-device check and approval
UPDATE. Baseline must fail on forbidden main SQL; commit that proof before the fix.
Fixture writes and assertion-only reads are outside measurement. Code creation,
redemption, device diagnostics and other pairing operations remain later slices.

Two concurrent approvals produce one success and one not-pending refusal. Unpaired
clients, expired codes and a connected but subsequently revoked human cannot approve.
A competing WAL writer delays the approval while health stays responsive and the
uncommitted lock fixture remains invisible outside its connection. A rejecting
trigger rolls approval back. Native worker failure before posting leaves the code
pending; losing the native post-commit reply rejects with unknown outcome, leaves
the approval committed and causes no automatic replay. A later independent approval
recovers the writer. No fallback may execute on the main connection.

Save receipts, refusal/rollback/failure outcomes, main SQL attempts, native command
round-trip bytes/encoding time, RPC and health timings, maximum loop lag, RSS and
WAL size. These do not isolate SQL time from worker queue and cloning costs or prove
large-volume performance, browser layout or deployed-build behavior. Close every
owned transport, processor, daemon and worker; save JSON, then remove all temporary
daemon data with the wrapper on success and failure.
