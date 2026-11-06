# Watch timer reader activation

Use the shared isolation/resource setup in `../SKILL.md` with
`lane-c-github-watch-timer.ts` through `proof-run.sh` under Bun. The helper owns a
synthetic daemon on an ephemeral port, a refusing GitHub/HTTP stub and a Space-only
extension with optional session provider absent. Remote webhook ownership is disabled in
the seeded row. Never touch port 8399.

Start the actual extension and verify an active timer through public health.
Call `space.github.watchRepo` to disable polling on its existing watch and trap
the unscoped timer SELECT on main. Verify the watched-row receipt, retained row,
false polling intent and saved snapshot. Existing watch validation/webhook and
mutation/config effects stay main-side unchanged; only the timer decision moves.
Health readback runs outside the timer trap because its own readers are separate.

Retain another active orphan row to prove the unscoped timer selection. Hold an actual
native reader reply while a newer enable commits; health stays responsive and the effect
queue orders acknowledgement. A stop/restart while a reply is held must preserve the
replacement timer; restore RPC handlers removed by manager stop. Compare stored row scalar
values rather than SQL-adapter object prototypes. Inject one reader error: the watch RPC
rejects after its known upsert/snapshot, adds no upsert replay or notification, and
preserves the timer. A later explicit request succeeds independently. Focused tests cover
no-timer/session-provider admission skips and query/mapper interfaces, including malformed
cursor errors.

The historical timer boundary retains its two already-audited data modules.
The current measurement is fresh 162 / excluded 100 / known 262 lines, including
the complete 88-line watch callback. Query module line counts changed in earlier
reviewed extraction slices. Hash and interface pins remain in force.
The config-writer slice separately measures its production diff and complete
caller in github-watch-config-measure.cjs, with no new exclusion grant. Its reader
and atomic-writer bridges update only the watch callback pin here. The timer
proof counts actual native config-write posts when asserting no upsert replay.
This timer measurement makes no full public/runtime transitive-closure claim.

Keep JSON, wrapper status and latency/clone/RSS/WAL/loop metrics before cleanup.
Held requests are not latency-target passes; internal SQL/queue timing is not
exposed. Failure uses a synthetic Worker error rather than OS termination. GUI,
real GitHub/providers, live deployment, background polling and full boot/drain
ownership are unverified. Final #8714 remains incomplete after this slice.
