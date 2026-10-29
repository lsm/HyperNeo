# Extract new GitHub watched-repository INSERT

Run proof-run.sh with lane-c-github-watched-insert-extract.ts under Bun and
cached Deno (VERIFY_PROOF_RUNTIME=deno). Shared setup owns scrubbed HOME/data,
free ephemeral port, evidence and cleanup. No model/HTTP mock or credentials.
Never touch live daemon/8399, deployment or real HOME. Refuse external HTTP/gh,
disable webhook reconciliation, use an injected 60-second poll interval and
close the owned timer before it fires. Finish body copying and stop processors.

Seed two synthetic Spaces with empty watch lists; disable the primary source.
Through watchRepo create the primary with no enabled override (Space fallback
false), enable that existing row (unchanged UPDATE), then create a polling peer
(default Space true). Pin supplied UUID/creation time, initial bound creation
and update times, defaults, caller fallback, existing identity and saved config.
Existing cursor activation marker must equal the INSERT's caller time. Observe
two main INSERTs before/after; public mutations remain on main in this extraction.
Commit helper-availability failures first while legacy and real RPC proofs pass.

Scratch SQLite has only the watched table. INSERT uses its supplied id, resolved
Space flag and time even when params differ; no clock, UUID or initialization.
Pin defaults/nulls, duplicate-id failure without replay, and caller rollback.
Normalize only SQLite row prototypes across Bun/Deno before comparing all values.
Focused tests compare exact legacy/helper SQL/bindings/raw rows before cursor
policy, across source/param flags, null, empty and zero cases. Check single
failed attempts and unchanged peer rows. Full-file hash/interface tests pin the
five stable dependencies, including rollback and supplied-time UPDATE contract.

Run measurement in the unmerged slice branch; after merge use saved evidence.
Neo approved fresh 146, excluded 166, total known 312. The fifth audited stable
module is the complete 64-line UPDATE helper; #9418 tracks all five. Pin full
hashes/contracts and test interfaces. No full public/shared-barrel/runtime
transitive closure claim. Keep UUID/time/Space fallback in the caller, and
UPDATE/cursor/reset/webhook policy unchanged. If review challenges the envelope,
stop/report. Any later additional exclusions require a new table/Neo decision.
Reduced UPSERT, command and public wiring remain separate remeasured slices.

Save github-watched-insert-extract.json. Close scratch DB/socket/processors/app,
restore hooks in finally and remove owned temporary data through the wrapper.
Deployment smoke stays with Neo.
