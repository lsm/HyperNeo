# GitHub Space enable and disable RPC writer activation

Run proof-run.sh with lane-c-github-space-enable-wiring.ts under Bun and cached
Deno (VERIFY_PROOF_RUNTIME=deno). Shared setup owns fresh HOME/data, scrubbed
environment, free listeners, saved evidence and synthetic data cleanup. Never
use the live daemon, port 8399, credentials or deployment.

Use the real app, GitHub extension and public WebSocket RPCs. Stop captured
processors and finish SDK body copy before measuring. Inject a safe 60-second
poll interval through the existing options callback, disable webhook reconciliation
and refuse external HTTP/gh. Seed two watched rows and a real Space; initial
source and saved-config creation times differ. Clear the fixture's initial timer
with real stop/start while polling capability is off. This setup is unmeasured.

Capture the real RPC context notification, real global-config setter and real
poll scheduling call, forwarding each to its implementation. Each lifecycle
observation must see the committed source/snapshot at the last delivered writer
receipt time, except when a completed concurrent polling RPC supersedes that
receipt; then verify its newer source and snapshot timestamps independently.
Do not fake the timer, policy methods, worker or SQLite results.

Commit red tests first: authorization remains valid, but ordinary/held/failure
and lost-reply contracts fail; the real enable RPC hits the main SQL guard.
Probe all three target write families with cached/fresh statements, then reset
the six deliberate guard counts. Enable/disable must post exactly one data-only
command, retain their three-field replies and complete projected snapshots, and
attempt zero target main writes. General public reader SELECTs remain separate.

Verify polling-capability -> timer -> source notification order after commit.
At interval zero, enable still persists and notifies without polling re-arm.
Snapshot failure rolls back all flags before callbacks; a known post-commit
capability failure keeps one consistent saved snapshot without notification or
retry. Hold a competing WAL writer: old public config/health remain responsive,
capability/timer/notification/reply wait, and the pre-admission timestamp survives
release. Held wait duration is not a 250 ms latency pass. Reject admission and
drop an actual committed reply: no lifecycle work, fallback or automatic replay.
Hold an actual committed enable reply while a concurrent public setPollingEnabled
RPC disables the last polling rows and global capability. Suspend the target-write
guard only for that separate, still-main-side setter; restore it before delivering
the held reply. Enable must recheck current watched rows, retain the newer saved
snapshot and disabled capability, and neither schedule a timer nor replay its
write. Restore polling through the same public setter before remaining cases.
Disable the RPC capability and confirm authorization rejects before admission.

Pin the complete merged command subtree and unchanged policy/timer/notification
roots, with honest downstream audit limits. Update older native helper journeys
and CI parents to expect zero target main writes; preserve their scratch SQL
contracts and archived evidence. Seed real Space FK rows in four existing
scenario setups; keep their behavioral assertions unchanged. The synchronous post-receipt watched-row recheck, public reads, other
writes, constructor setup and async poll/plugin/startup closures are not proved
fully off main by this slice.

Save github-space-enable-wiring.json and metrics. Close locks, sockets, processors
and app in finally; restore every observation hook before wrapper cleanup.
