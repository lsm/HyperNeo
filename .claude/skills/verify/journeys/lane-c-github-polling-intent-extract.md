# Extract GitHub polling intent persistence

Run proof-run.sh with lane-c-github-polling-intent-extract.ts under Bun and cached
Deno (VERIFY_PROOF_RUNTIME=deno). Shared setup owns scrubbed HOME/data, ephemeral
ports, evidence and cleanup; never use live daemon/8399, credentials or deployment.

Commit red helper-availability contracts while actual public polling preference
RPC characterization passes. Start the app, stop processors, finish startup body
copy, and enable only GitHub RPC configuration. Inject a safe 60-second interval
through its existing options callback, with webhook reconciliation off. No watched
rows are seeded; any timer remains idle and is stopped during cleanup. Seed two
synthetic Spaces and an existing disabled source with filtering off.

Drive setPollingEnabled false/true on that source, then false on an empty Space.
Check replies, listConfig, exact source bindings/time, creation time, enabled and
filter flags, default insertion and saved polling intent. Three target main SQL
writes remain expected; this extraction claims no movement off main. Other watched
row, cursor-reset and global capability/timer paths are unchanged and not a new
worker ownership claim.

Pin exact SQL/bindings/void result and one caller clock. Compare legacy/helper
rows, Space isolation, conflict preservation, trigger failure and caller-owned
insert/update rollback. Scratch native SQLite repeats caller time and rollback.
Measure helper/wrapper plus conservative unchanged constructor/read units and
complete read modules; pin all other repository units and unchanged public files.
Full transitive GitHub/plugin/Space/startup closure is not audited. Atomic writer
construction and public wiring require separately measured later slices.

Save github-polling-intent-extract.json. Close scratch DB, socket, processors and
owned app in finally; restore hooks before wrapper data cleanup. Deployment smoke
remains Neo-owned.
