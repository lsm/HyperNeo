# Atomic GitHub Space enable writer construction

Run proof-run.sh with lane-c-github-space-enabled-command.ts under Bun and cached
Deno (VERIFY_PROOF_RUNTIME=deno). Shared setup owns synthetic HOME/data, scrubbed
environment, free ports, saved evidence and owned data cleanup. Give each seeded
Space a unique synthetic workspace directory; the real schema enforces it.

Start the real app, stop captured processors and finish SDK body copying. Enable
only GitHub RPC configuration with polling/webhooks off. Seed two watched rows
through watchRepo and retain their public row contract. Seed distinct source and
saved-config creation times and an unrelated Space with polling configured but
intent false, so repository-constructor replay would be visible. Confirm the
existing listConfig RPC baseline before calling the new typed writer command.

Commit failing tests first: command absent/unregistered, seven command contracts
fail, native worker refuses the new op after the public baseline succeeds. Cache
and freshly prepare each of source UPSERT, watched enabled UPDATE and config
UPSERT; deliberately prove all six main guards throw, then reset their counter.
The actual command must run only on the native DB writer. Both native and inline
gateway already own its IMMEDIATE transaction; never add a transaction/retry in
the command or construct the legacy GitHub repository per call.

Assert the receipt equals the real listConfig RPC, every saved watched field is
projected, shared caller time and existing creation times survive, and unrelated
Space state/backfill intent stays untouched. A snapshot trigger failure, malformed
cursor or missing-Space FK must roll back all source/watched/config effects.
Invalid ids keep the current error. Unit contracts include empty-Space/default
and repeat changed-row counts. Hold a competing WAL writer: the command stays
pending, public config reads the old committed snapshot and system.health stays
responsive, then all new state becomes visible after release. Retain queue wait,
latency, bytes, event-loop lag, RSS and WAL metrics; a deliberately held command
is not a 250 ms latency pass.

Reject admission and drop an actual successful committed reply through the
worker transport. Each attempt posts once with no automatic replay or main-side
fallback; committed reply loss still leaves source and saved snapshot consistent.
Public mutation handlers, capability/timer/notify callbacks and startup remain
unchanged; their later wiring is a separate slice and is not claimed here.
Pin all five helper-module hashes and the existing worker transaction contract.
Save github-space-enabled-command.json; stop sockets/processors, close lock and
clean up app in finally before wrapper removes data. Never touch live daemon,
port 8399, real credentials or deployment; Neo owns deployment smoke.
