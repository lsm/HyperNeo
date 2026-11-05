# Extract GitHub polling intent persistence

Run proof-run.sh with lane-c-github-polling-intent-extract.ts under Bun. Shared setup owns
scrubbed HOME/data, ephemeral ports, evidence and cleanup; never use live daemon/8399,
credentials or deployment.

Commit red helper-availability contracts while actual public polling preference
RPC characterization passes. Start the app, stop processors, finish startup body
copy, and enable only GitHub RPC configuration. Inject a safe 60-second interval
through its existing options callback, with webhook reconciliation off. No watched
rows are seeded; any timer remains idle and is stopped during cleanup. Seed two
synthetic Spaces and an existing disabled source with filtering off.

Drive setPollingEnabled false/true on that source, then false on an empty Space.
Check replies, listConfig, committed source time, creation time, enabled and
filter flags, default insertion and saved polling intent. After public writer
activation, reject any target main SQL write and require zero main statement runs.
Source and saved snapshot share the committed time, bounded by the RPC call.
Exact helper bindings remain pinned by focused helper tests; callback reads and
global capability/timer ownership are outside this proof.

Pin exact SQL/bindings/void result and one caller clock. Compare legacy/helper
rows, Space isolation, conflict preservation, trigger failure and caller-owned
insert/update rollback. Scratch native SQLite repeats caller time and rollback.
Measure helper/wrapper plus conservative unchanged constructor/read units and
complete read modules; pin all other repository units and unchanged public files.
Full transitive GitHub/plugin/Space/startup closure is not audited. Atomic writer
construction and public wiring have their own separately measured proofs.

Save github-polling-intent-extract.json. Close scratch DB, socket, processors and
owned app in finally; restore hooks before wrapper data cleanup. Deployment smoke
remains Neo-owned.
