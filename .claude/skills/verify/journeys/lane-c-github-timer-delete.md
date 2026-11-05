# Retired synchronous timer helper deletion

Use shared isolation, resource checks and cleanup in `../SKILL.md`. Run
`lane-c-github-timer-ownership.cjs` from the repo root to enforce the narrow
ownership contract: watchRepo, unwatchRepo and setPollingEnabled each await the
reader timer helper, and the old synchronous helper is absent. This guard does
not establish daemon-wide SQL ownership or inspect the runtime transitive graph.

Run all three native helpers through `proof-run.sh`, serially under Bun:
`lane-c-github-timer-reader.ts`, `lane-c-github-unwatch-timer.ts` and
`lane-c-github-watch-timer.ts`. Follow their existing journeys. Their real public RPC
replies, watched snapshots/intent, active-timer health, ordering/lifetime fences and
failure recovery must remain unchanged with the target timer SELECT rejected on main. All
data, listeners and credentials are synthetic; never use port 8399 or the live daemon.
Keep evidence before wrapper cleanup.

The production delta deletes only the six-line unused helper. Refresh the
existing sibling scope pins for that exact deletion. Their selected owned graphs
and existing data exclusions remain unchanged. Remove the retired six-line root
from the older writer interface table; that bridge shrinks from 85 to 79 lines.
No new exclusion, registration, public behavior or shared/core change is added.
Other integration SQL, background polling and startup/shutdown ownership still
precede the final #8714 guard; no GUI or live deployment proof is claimed.
