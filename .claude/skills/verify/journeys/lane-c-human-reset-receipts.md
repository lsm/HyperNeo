# Build exact human-reset receipt recovery

Run proof-run.sh with lane-c-human-reset-receipts.ts on Bun and the cached native
Deno, selecting VERIFY_PROOF_RUNTIME=deno for Deno. The wrapper checks resources,
uses disposable HOME/data and ephemeral ports, refuses GitHub/external HTTP,
saves evidence and removes daemon data. No provider turn or HTTP model is needed.
Record runtime versions; Bun 1.4.3 does not establish pinned Bun 1.4.2 coverage.

This construction keeps reset(now) and adds an optional request UUID. A read-only
command returns that reset's receipt only when a matching recovery notice exists.
The public reset operation is unchanged until a separate wiring slice. Reset and
all human-visible notice chunks must remain one atomic transaction. Never replay
a reset whose commit outcome is unknown; recovery retries are reads only.

Commit the failing unit/native proof first. The baseline reader is unregistered,
and the baseline writer ignores a supplied UUID. Then self-check cached/new main
SQL denial and execute the registered commands through fresh native workers.
Recover the exact UUID and public notice after a lost committed reply and a
transient read failure, with exactly one mutation. Hold another WAL writer: reads
must retain old committed receipts and omit the pending reset, while health still
responds. Same-time concurrent resets must retain separate receipts. Before-post
refusal and second-notice rollback must yield no receipt. The legacy one-argument
command must still work. Real CLI devices/public neo.publication.read must show
retained history and chunked notices without credentials. Existing connection
observation is not proof of the future direct public-reset notification wiring.

Unit cases additionally pin duplicate-ID rollback, both producer-origin fields,
missing notices, and the original notice conversation after the current one
changes. Run the focused strict test checker and measure the full local changed
call graph and production diff at 200 lines or fewer. Record the already-audited
core append contract separately, without editing core publication/service files.
Keep the SQL ratchet baseline unchanged. Save flags and timings/bytes/RSS/WAL,
never device IDs, codes, credentials or raw CLI output. Close clients, processors,
locks and daemon before the wrapper saves evidence and removes its temporary data.
Public mutation wiring, browser layout and deployment are not verified here.
