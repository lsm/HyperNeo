**Neo memory reaches Neo's turn from the human's own words.**

Run `.claude/skills/verify/with-run.sh bash -c 'bash .claude/skills/verify/neo-memory-hook.sh 9341 "$RUN"'`
with a free `VERIFY_MOCK_PORT` (the capturing mock also binds that port plus one).
Build web first, as for every launch.

The script starts an isolated daemon behind `mock-api-capture.ts`, which logs each model
request body to `mock-api.log` and forwards it to the ordinary mock. It checks that a
local-user `memory.save` is refused with `memory_not_authorized` and that a local-user
`memory.search` finds a seeded memory. Memories are seeded with SQL into the run's own DB,
because only Neo may write. It then sends a human Neo message and waits for a `result` row.
PASS means the model request carried `Memories that may apply` with the matching entry and
not the unrelated one. Worker-report skipping is covered by `neo-plan-hook.test.ts`, not by
this script.
