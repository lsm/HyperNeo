# Global extension configuration SQL extraction

Use proof-run.sh with lane-c-extension-global-sql-extract.ts on Bun and cached
Deno (VERIFY_PROOF_RUNTIME=deno). Shared setup supplies fresh HOME/data and an
ephemeral daemon listener, scrubs credentials, retains evidence and removes data.
No model turn, HTTP mock, GitHub access or live daemon/8399 is used.

The helper registers a synthetic extension in the real daemon manager, then uses
the public WebSocket enable/disable and list RPCs. Both states must persist,
the start callback observes committed enablement, and stop retains its existing
ordering. Exact JSON, synthetic secret reference, creation time and lifecycle
status survive. Its historical extraction baseline had two public main-connection
UPSERTs; current setter activation requires zero. Direct scratch-helper calls
still use their supplied connection. Constructor DDL and reads remain unchanged.

Commit the failing helper-availability contract first while the public legacy
characterizations pass. After extraction, verify caller-supplied timestamps and
caller-owned transaction rollback on native SQLite. Unit tests compare legacy
and extracted rows and all seven bindings, optional-field clearing and validation
before clock/prepare. Measure SQL and binding expression equivalence and the
complete owned store/helper graph; keep each under 200 production lines.

Evidence: extension-global-sql-extract.json. The helper closes scratch SQLite,
socket, job processors and daemon in finally before wrapper cleanup. The full
plugin callback closure is not transitively audited; unchanged lifecycle wiring,
worker activation, UI, pinned Bun availability and deployment smoke are not
claimed by this extraction. Deployment remains Neo-owned.
