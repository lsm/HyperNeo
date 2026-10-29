# Atomic GitHub polling writer construction

Run proof-run.sh with lane-c-github-polling-command.ts under Bun and cached Deno
(VERIFY_PROOF_RUNTIME=deno). Shared setup owns scrubbed HOME/data, free ephemeral
ports, retained evidence and cleanup. No provider/model turn; refuse external
HTTP/gh. Never touch the live daemon, port8399, credentials or deployment.

Start real app, stop processors, finish real SDK body copying. Seed synthetic
Spaces, normal/disabled/webhook-secret rows through watchRepo, distinct source
and saved-config creation times and an unrelated Space with polling but false
intent. Confirm listConfig baseline. Cache and freshly prepare each target SQL
and prove all six main guards throw before measuring; reset counter. Commit red
unit missing-command and native unknown-write-op failures after baseline passes.

Call registered direct DbOp with only serializable spaceId/enabled. The existing
native writer owns one IMMEDIATE transaction; command creates no repositories,
resources or transaction. Enabling skips webhook-enabled rows with a secret;
disabling includes all watched rows. Preserve existing flags, error/default,
cursor cleanup, disabled-row and last poll/webhook semantics. Capture one clock
after per-row UPSERTs for intent and saved snapshot, preserving creation times.
Assert exact sanitized receipt through real listConfig, no secret/cursor leaks,
source/filter preservation and no constructor backfill on unrelated Spaces.

Snapshot rejection rolls back flags/cursors/intent/config. A cursor-write trigger
must undo the earlier flag write; malformed cursor and orphan/invalid Space also
leave no partial state. Only explicit synthetic cursor seeding temporarily pauses
the main-write guard; command and public-reader phases always keep it armed.
Hold another WAL writer: command stays pending while old public config and health
remain responsive, then acknowledge only after complete commit. Save queue wait,
latency/bytes, event-loop lag, RSS/WAL; held latency is not a 250ms fast-path pass.
Reject admission and drop an actual successful worker acknowledgement. Each posts
once without automatic replay/main fallback; committed state stays consistent.
Close scratch lock, sockets/processors/app and restore Worker/DB/fetch hooks in
finally; wrapper retains evidence then removes owned data. Save github-polling-command.json.

Run measurement only on unmerged branch; preserve its saved result after merge.
Fresh199 = command41 + whole UPSERT40/INSERT40/intent14/config20/projection29 +
UUID15. The same five audited stable modules remain excluded166; known365, zero
new exclusions. Pin all five full-file hashes/contracts with interface tests;
#9418 records lifecycle/bump procedure. Existing native/inline transaction and
receipt framework is pinned infrastructure. Full public/shared-barrel/runtime
transitive closure remains unclaimed; later extra exclusions need a Neo table
and decision. Stop/report if review challenges the envelope. Public mutation
activation and capability/timer/notification callbacks follow in a separate PR;
this proof's publicMutationActivated=false means direct command invocation only.
Deployment smoke stays with Neo.
