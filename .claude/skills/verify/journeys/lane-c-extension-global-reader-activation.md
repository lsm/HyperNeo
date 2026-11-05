# Activate the public global extension configuration reader

Use shared isolation/resource setup in `../SKILL.md` with
`lane-c-extension-global-reader-activation.ts` through `proof-run.sh` on Bun. It owns
fresh HOME/data, an ephemeral daemon and refusing GitHub/HTTP stubs. Synthetic extensions
never start providers. Never use the live daemon/8399.

Self-check cached/new main SELECT traps after startup/body-copy and seeding.
First show the merged standalone reader works with that SQL denied; then call
`externalEvents.extensions.list` through a real authenticated WebSocket. Before
wiring, that public RPC fails at its main SELECT. Commit that regression first.
After wiring, keep the trap enabled across every public operation below.

Check exact complete configurations, nested/Unicode JSON, synthetic references,
missing defaults and malformed/non-object JSON. Invalid source ids fail before
reader admission. A competing uncommitted WAL writer leaves public lists seeing
the committed snapshot while health responds. Hold a real reader reply, disable
that source through the public RPC, release the old list and compare a fresh list:
the old reply retains its snapshot and the next list sees the committed change.
Refuse a read admission and separately lose an actual completed reply. Both must
reject the whole list without retry or main fallback; an independent list recovers.

Measure the owned store read/setup units plus the complete unchanged reader,
lookup and JSON modules, the import and append-only smoke registration. The complete measured graph is 141 lines (75 store + 64 modules + 2
import/registration), zero data exclusions. Pin public/framework identities with explicit transitive limits.
Record native result JSON, wrapper exit status, clone bytes, round trips,
health/loop lag, RSS and WAL before cleanup. Queue/SQL timing is unexposed;
worker failures are synthetic error events, not OS kills. GUI, live deployment,
Space reads, constructor DDL and full startup/shutdown ownership are not verified.
Final #8714 remains incomplete.
