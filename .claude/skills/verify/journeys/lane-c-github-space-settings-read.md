# Constructor-free GitHub Space settings reads

Run proof-run.sh with lane-c-github-space-settings-read.ts under Bun and cached
Deno (VERIFY_PROOF_RUNTIME=deno). Shared setup owns fresh HOME/data, scrubbed
environment, ephemeral listeners, retained evidence and owned data cleanup.

The unchanged lane-c-github-space-enabled-extract.ts journey first drives the
real Space enable/disable/listWatchedRepos/listConfig RPCs, with two synthetic
watched repositories and polling/webhooks disabled. Source/watched/saved config
flags, creation times and shared-command timestamps must remain aligned. Four
target main statement runs remain expected. The imported journey closes its
daemon, socket and processors before the new direct read proof starts.

Then use native SQLite containing only the settings table with query_only ON.
The three extracted helpers must return legacy missing-row defaults, explicit
true/false flags and strict noncanonical/null flags without initialization or
writes. Focused tests also pin every boolean combination, Space isolation,
unchanged stored rows and missing-table errors. Commit the missing-helper red
contracts before extracting the statements. Measure SQL/default/bind AST equality
and hash all other repository units, including constructor/backfill, unchanged.

This rung extracts reads only. Public reads/writes remain on main; no atomic
writer or full transitive GitHub/plugin/startup audit is claimed. The previous
native helper is a behavior fixture, not a new transitive production audit.
Save github-space-settings-read.json and the imported RPC evidence. Deployment
smoke remains with Neo; never touch the live daemon or port 8399.
