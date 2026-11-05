# Extract Space extension configuration queries

Use shared isolation/resource setup in `../SKILL.md` with
`lane-c-extension-space-read-extract.ts` through `proof-run.sh` on Bun. It owns fresh
HOME/data, an ephemeral daemon and refusing GitHub/HTTP stubs. Only the real GitHub RPC
capability is enabled; polling/webhooks are disabled. No live daemon/8399, real
credentials or model turn is used.

Characterize `space.github.listConfig` through the authenticated WebSocket: exact
nested/Unicode settings, disabled rows, missing nulls and malformed/non-object
JSON fallbacks. Characterize enabled-Space ordering and source isolation directly
through the store (no public enabled-list RPC exists). Count target main get/all
executions; this extraction intentionally retains that ownership.

Commit the failing helper-availability contract after public characterization
passes. Extract the unchanged get/list SQL, row interface and mapper. Direct
scratch-connection queries must retain values, observe caller-owned uncommitted
changes and restore their old values/list after rollback. Unit cases also cover
noncanonical legacy enabled flags on a permissive fixture. Store validation must
reject before any query. Preserve exact SQL bytes, argument/query AST, row mapper,
JSON parser, validation, writers and DDL; measure complete owned modules/read
setup: 168 lines (55 store + 108 complete modules + 4 import + 1 smoke),
zero data exclusions. Caller/framework identity pins
are not a full public/plugin/runtime transitive audit.

Retain JSON, wrapper exit status, RPC latency, RSS and WAL before closing all
scratch/daemon/socket/processor resources. No worker activation or fault handling,
GUI, real provider, live deployment or full startup/drain proof is claimed.
Construction and public reader activation follow as separately gated slices;
final #8714 remains incomplete.
