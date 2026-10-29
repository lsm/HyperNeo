# GitHub filter RPC writer activation

Run proof-run.sh with lane-c-github-filter-wiring.ts under Bun and cached Deno
(VERIFY_PROOF_RUNTIME=deno). Shared setup owns scrubbed HOME/data, free ephemeral
sockets, evidence and cleanup; never use live daemon/8399, credentials or deployment.

Commit red unit failures and actual WebSocket main-SQL failure first. Start the
real app, stop captured processors and await startup body copying. Enable only
GitHub RPC configuration; seed two watched rows with polling/webhooks off and a
source disabled with polling intent retained. Distinct source/config creation
and baseline update times make early notification observable. Confirm listConfig.

Probe cached/fresh main statements for source UPSERT, watched enabled UPDATE and
config UPSERT (six deliberate failures), then reset the guard count. Actual
setFilterCurrentUser true/false calls must post one typed writer command, preserve
reply shape/source/watched state, return full projected snapshots, and attempt
zero target main writes. Forward the actual source notification; at its boundary
source and saved filter/time must agree with an admitted command's captured time.

Snapshot/cursor/FK failures roll back before notification. A known notification
failure keeps the committed snapshot without replay. Hold a competing WAL writer:
old public config and health remain responsive; notification/reply wait until
commit and retain caller time. Held wait is not a 250 ms latency pass. Withhold one
actual committed reply, complete a later false RPC, then release the older reply:
both notifications observe the newer state, and no stale snapshot is rewritten.
Reject admission and lose an actual successful committed reply: no notification,
fallback or automatic replay. Authorization/parameter errors precede admission.

Measure only this bridge and unchanged constructor; pin the complete175-line
merged writer subtree, policy/shared/app notification roots and explicit downstream
audit limits. Update current extraction proof counts to zero but preserve archived
three-write evidence and direct legacy SQL contracts. Seed one existing RPC test's
real Space FK row and use its real SQLite configuration store, keeping assertions
unchanged. Public readers, other writers,
async plugin/startup closures and the final main-thread guard remain separate.

Save github-filter-wiring.json and metrics; restore hooks, close sockets/lock,
stop processors and clean up the owned app in finally before wrapper data removal.
