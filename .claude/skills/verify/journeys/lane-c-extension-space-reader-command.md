# Construct Space extension configuration readers

Use shared isolation/resource setup in `../SKILL.md` with
`lane-c-extension-space-reader-command.ts` through `proof-run.sh` under Bun. It owns fresh
HOME/data, an ephemeral daemon and refusing GitHub/HTTP stubs. Only GitHub RPC
configuration is enabled; polling/webhooks remain disabled. No live daemon/8399, real
credential or model turn is used.

Characterize real `space.github.listConfig` replies first. Then self-check cached
and new main get/list SELECT traps and submit the unregistered data-only reader
job to the actual worker. Commit that failure before construction. Register get
and enabled-list operations, each with one named direct superpipe pipeline using
the unchanged constructor-free queries and existing read lane. Bind the nullable
get result through an object output so a missing row remains exactly null.

Keep target main SELECTs denied during direct reader jobs: complete nested/
Unicode configurations, malformed/non-object JSON, missing nulls/empty lists,
compound-key/source isolation and enabled-Space ordering. A competing uncommitted
WAL writer leaves both readers seeing the committed snapshot while health responds.
Hold actual get and list replies together, disable a Space through the public RPC,
then release: old replies retain their snapshots; fresh reads and public config
see the committed result. Public get/disable/health comparisons run outside the
main SQL trap; this construction does not activate either store method.

Refuse admission and lose an actual completed reply for each operation. Both
errors propagate without main fallback or automatic retry; independent reads
recover. Save JSON, wrapper status, round-trip/clone bytes, loop/health lag, RSS
and WAL before cleanup. SQL/queue timings are unexposed and worker failures are
synthetic error events, not OS kills. No GUI/live deployment, public activation,
constructor DDL or full boot/drain proof is claimed; final #8714 remains open.

Measure the complete new reader plus merged lookup/JSON modules and append-only
registry/smoke lines at 99 lines (39 command + 44 lookup + 9 JSON + 6 registry + 1 smoke), zero data exclusions. Pin public store/caller/app/
framework identities without claiming full transitive runtime closure. Activate
public reads only in the next separately gated slice after this construction merges.
