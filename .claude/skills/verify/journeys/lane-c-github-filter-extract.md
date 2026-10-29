# Extract GitHub filter persistence SQL

Run proof-run.sh with lane-c-github-filter-extract.ts under Bun and cached Deno
(VERIFY_PROOF_RUNTIME=deno). Shared setup owns fresh HOME/data, ephemeral sockets,
scrubbed credentials, saved evidence and cleanup. No provider, external HTTP,
GitHub access, live daemon/8399 or deployment is used.

Commit red helper-availability contracts while the actual public filter RPC
characterization passes. Seed two synthetic Spaces, with the first source disabled
and polling intent retained. Enable only GitHub RPC configuration; polling and
webhooks remain off. Exercise setFilterCurrentUser false/true on the existing
source and false on an empty Space. listConfig must agree; three target main
UPSERTs remain expected because this is extraction, not worker activation.

Pin exact statement text and bindings, one caller clock, void result, insert
enabled/polling defaults, conflict preservation of enabled/polling/creation time,
Space isolation, statement failure and caller-owned insert/update rollback. The
helper takes caller time and creates no transaction, callback or repository.
Scratch native SQLite repeats void result, supplied time and outer rollback.

Measure the helper/wrapper plus conservative unchanged constructor/read units and
complete read modules. Pin every other repository unit and the unchanged public
extension/config-store/app files. This is not a complete transitive audit of the
GitHub/plugin/Space/startup graph. Command construction and public activation are
separate later rungs, and all current filter/saved-config writes stay main-side.

Save github-filter-extract.json; restore hooks and close scratch DB, socket,
processors and app in finally before wrapper data cleanup. The wrapper status
is authoritative. Deployment smoke remains Neo-owned.
