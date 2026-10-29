# Constructor-free GitHub watched repository reads

Run proof-run.sh with lane-c-github-watched-repos-read.ts under Bun and cached
Deno (VERIFY_PROOF_RUNTIME=deno). Shared setup owns synthetic HOME/data, scrubbed
environment, free listeners, retained evidence and owned data cleanup.

The unchanged settings-read journey imports the original real daemon Space
RPC proof: enable/disable/listWatchedRepos/listConfig with two synthetic watched
repos, polling/webhooks off, settings and timestamps aligned. The activated enable/disable path now expects zero target
main writes. Those helpers close all sockets, processors, app and scratch
DBs before this proof starts its own native query-only SQLite contract.

With only the watched table, verify the complete mapped row, Space isolation,
owner/repo ordering, all-Space and empty-filter behavior, missing Space result
and malformed cursor error. A malformed cursor must still throw even where the
saved settings snapshot would omit the cursor. Never construct a repository in
these helpers, suppress parse failures, change SELECT order or add writes.

Commit missing-helper failures first while legacy characterization and real RPC
behavior pass. Focused tests also pin strict flag/null/default fields and other
existing read surfaces sharing the mapper. Measurement pins normalized complete
SELECT/map ASTs, unchanged constructor/backfill, other methods and type contracts.
The full transitive graph of all mapper consumers and GitHub/plugin/startup is
outside this extraction. No public off-main or atomic command claim is made.
Save github-watched-repos-read.json and imported fixture evidence. Deployment
smoke stays with Neo. Never touch live daemon/8399 or real credentials.

The enable/disable RPC now consumes the atomic writer receipt. Archived evidence
retains its original commit-time counts. Current public RPC expectations require
zero target main writes; direct scratch-helper SQL/binding/rollback contracts
remain unchanged, and other public write/read families are not covered here.
