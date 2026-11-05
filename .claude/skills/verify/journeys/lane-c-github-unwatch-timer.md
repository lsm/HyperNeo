# Unwatch timer reader activation

Follow shared isolation and resource checks in `../SKILL.md`. Run `proof-run.sh` with
`lane-c-github-unwatch-timer.ts` under Bun. It owns a fresh synthetic daemon, ephemeral
listener, refusing GitHub/HTTP stubs and Space-only polling (optional session-watch
provider absent). The seeded watch has remote webhook ownership disabled, so unwatch never
requires GitHub credentials or a remote deletion. Never use port 8399.

Start the actual extension through its manager and confirm its timer is active
through `space.github.health`. Drive `space.github.unwatchRepo`, trapping the
unscoped timer SELECT on main. The reply must await the registered DB reader;
the removed row and saved empty watched snapshot must retain Space polling
intent. Existing unwatch deletion and snapshot writes stay unchanged on main;
this slice migrates only the timer decision. Health readback runs outside the
SQL trap because its separate readers are not migrated here.

Prove orphan active rows retain the timer. Hold an actual native reader reply,
then enable polling again: acknowledgement waits in the existing effect queue
while `system.health` remains responsive. Release and observe the newer timer.
Stop/restart the extension during another held reply, restoring its manager RPC
handlers, and prove the old reply cannot clear the new lifetime's timer.
Inject one synthetic reader error: unwatch rejects after the known removal and
snapshot, without replay or timer clearing; a later explicit unwatch returns
`removed:false` and can stop the unused timer. Focused RPC tests also cover
notification ordering, no-timer and present-session-provider admission skips.

`lane-c-github-unwatch-measure.cjs` counts the complete selected callback/auth,
timer owner/queue/fields, complete reader/query/mapper modules, import and smoke
registration: 196 lines, zero exclusions. Other unwatch webhook/config effects
are unchanged and not re-audited. No full public/runtime closure, mutation
ownership or atomicity claim. The separate watch timer slice uses its approved
fresh 167 / excluded 97 / known 264 boundary; its other effects remain on main.
Sibling scope pins are refreshed with this explicitly measured caller change.

Keep native JSON, wrapper status and latency/clone/RSS/WAL/loop metrics outside
the disposable data. Held requests are not latency-target passes; SQL/queue
splits are unexposed. Worker failure is a synthetic error, not an OS kill.
No GUI, real GitHub, deployment, background reader or startup/shutdown proof;
#9438 and #8714 remain open.
